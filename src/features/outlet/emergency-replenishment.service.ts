import { supabase, supabaseConfigured } from '@/shared/supabase/client';
import {
  isClinicalLocationKind,
  isFacilityClass,
  isInstitutionClass,
  type ClinicalLocationKind,
  type InstitutionClass,
} from '@/shared/lib/institution-hierarchy';
import {
  isReplenishmentDestinationPointType,
  type ReplenishmentDestinationPointType,
} from '@/shared/lib/emergency-replenishment';

/**
 * STAGE-E-E7-2 — thin client over the Stage-E emergency-outlet corridor:
 * Migration 164's replenishment routes, Migration 166's one-shot initial
 * provisioning, Migration 168's atomic routine replenishment, and Migration
 * 169's reversal.
 *
 * Every mutation is a single canonical SECURITY DEFINER RPC call. This file
 * NEVER writes outlet_stock, never computes a balance, and never performs a
 * "dispense + manual add" compensation — the whole point of 168/169 is that
 * the debit and the credit are one atomic, idempotent, provenance-exact
 * server-side transaction.
 *
 * Eligibility (which destination may be fed from which source) is enforced by
 * the database, which owns the full rule set:
 *
 *   hospital           + rescue_cart    → requires clinical_location_kind='emergency'
 *                                         (rescue_cart_requires_hospital,
 *                                          rescue_cart_requires_emergency_context)
 *   hospital / spec.   + crash_cabinet  → requires 'non_emergency'
 *                                         (crash_cabinet_requires_non_emergency_context)
 *   health_sector      + crash_cabinet  → requires 'emergency'
 *                                         (health_center_crash_cabinet_requires_emergency)
 *   health_sector      + rescue_cart    → always refused
 *                                         (health_center_rescue_cart_forbidden)
 *
 * `outletContextEligibility()` below mirrors that table for UI affordance only
 * — so an operator is not offered a combination the server will certainly
 * reject. It is deliberately a mirror, never a replacement: the RPC re-derives
 * every one of these from `_phoenix_outlet_facility_context_v1` server-side.
 */

export interface RpcResult<T = Record<string, unknown>> {
  ok: boolean;
  data?: T;
  error?: string;
}

function rpcErrorCode(message: string | undefined): string {
  if (!message) return 'unknown_error';
  const head = message.split(':', 1)[0]?.trim() ?? message;
  return /^[A-Za-z0-9_]+$/.test(head) ? head : 'unknown_error';
}

async function callRpc<T = Record<string, unknown>>(
  fn: string,
  args: Record<string, unknown>,
): Promise<RpcResult<T>> {
  if (!supabaseConfigured) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, error: rpcErrorCode(error.message) };
  const payload = (data ?? {}) as { ok?: boolean } & T;
  return { ok: payload.ok !== false, data: payload as T };
}

// ─── Replenishment routes (164 table + RPC) ──────────────────────────────────

export interface ReplenishmentRoute {
  id: string;
  organizationId: string;
  sourcePointId: string;
  destinationPointId: string;
  sourcePointType: string;
  destinationPointType: ReplenishmentDestinationPointType | null;
  isActive: boolean;
  notes: string | null;
}

interface RouteRow {
  id: string; organization_id: string; source_point_id: string;
  destination_point_id: string; source_point_type: string;
  destination_point_type: string; is_active: boolean; notes: string | null;
}

const ROUTE_COLUMNS =
  'id, organization_id, source_point_id, destination_point_id, ' +
  'source_point_type, destination_point_type, is_active, notes';

function mapRoute(r: RouteRow): ReplenishmentRoute {
  return {
    id: r.id,
    organizationId: r.organization_id,
    sourcePointId: r.source_point_id,
    destinationPointId: r.destination_point_id,
    sourcePointType: r.source_point_type,
    destinationPointType: isReplenishmentDestinationPointType(r.destination_point_type)
      ? r.destination_point_type
      : null,
    isActive: r.is_active,
    notes: r.notes,
  };
}

export async function listReplenishmentRoutes(
  organizationId: string,
): Promise<ReplenishmentRoute[]> {
  if (!supabaseConfigured || !organizationId) return [];
  const { data, error } = await supabase
    .from('outlet_replenishment_routes')
    .select(ROUTE_COLUMNS)
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as unknown as RouteRow[] | null ?? []).map(mapRoute);
}

export interface UpsertRouteResult {
  ok: boolean;
  route_id: string;
  is_active: boolean;
}

/**
 * Creates (routeId omitted) or updates (routeId supplied) a route. The
 * database enforces that the source is a pharmacy, the destination is an
 * emergency outlet, both belong to the same organization, and that at most one
 * ACTIVE route feeds any given destination — none of which is re-implemented
 * here as a substitute.
 */
export async function upsertReplenishmentRoute(input: {
  routeId?: string | null;
  sourcePointId: string;
  destinationPointId: string;
  isActive?: boolean;
  notes?: string | null;
}): Promise<RpcResult<UpsertRouteResult>> {
  return callRpc<UpsertRouteResult>('phoenix_upsert_outlet_replenishment_route', {
    p_route_id:             input.routeId ?? null,
    p_source_point_id:      input.sourcePointId,
    p_destination_point_id: input.destinationPointId,
    p_is_active:            input.isActive ?? true,
    p_notes:                input.notes ?? null,
  });
}

// ─── Initial provisioning (166 RPC) ──────────────────────────────────────────

export interface InitialProvisioningResult {
  ok: boolean;
  dispatch_id: string;
  status: string;
  is_initial_provisioning: boolean;
}

/**
 * Opens the ONE initial-provisioning dispatch an emergency outlet may ever
 * have. Migration 166 models this as a historical lifecycle invariant, not a
 * quantity gate: a partial unique index plus
 * `initial_provisioning_consumed_at` means the slot is spent once a positive
 * accepted quantity lands, and a later drop to zero stock never reopens it.
 *
 * Callers must therefore NEVER decide eligibility from the outlet's current
 * balance. Ask the server; it answers `initial_provisioning_already_consumed`
 * when the lifecycle is closed.
 */
export async function createInitialProvisioningDispatch(input: {
  warehouseId: string;
  destinationDistributionPointId: string;
  dispatchNumber: string;
  documentNumber?: string | null;
  defaultCurrency?: string | null;
  notes?: string | null;
}): Promise<RpcResult<InitialProvisioningResult>> {
  return callRpc<InitialProvisioningResult>('phoenix_create_initial_provisioning_dispatch', {
    p_warehouse_id: input.warehouseId,
    p_destination_distribution_point_id: input.destinationDistributionPointId,
    p_dispatch_number: input.dispatchNumber,
    p_document_number: input.documentNumber ?? null,
    p_default_currency: input.defaultCurrency ?? null,
    p_notes: input.notes ?? null,
  });
}

/**
 * Whether this outlet has already consumed its one initial-provisioning slot.
 * Read straight off Migration 166's own columns — never inferred from stock.
 */
export async function getInitialProvisioningState(
  destinationDistributionPointId: string,
): Promise<{ consumed: boolean; openDispatchId: string | null }> {
  if (!supabaseConfigured || !destinationDistributionPointId) {
    return { consumed: false, openDispatchId: null };
  }
  const { data, error } = await supabase
    .from('warehouse_dispatches')
    .select('id, status, initial_provisioning_consumed_at')
    .eq('destination_distribution_point_id', destinationDistributionPointId)
    .eq('is_initial_provisioning', true);
  if (error) throw error;

  const rows = (data ?? []) as {
    id: string; status: string; initial_provisioning_consumed_at: string | null;
  }[];
  const consumed = rows.some(r => r.initial_provisioning_consumed_at !== null);
  const open = rows.find(r => r.initial_provisioning_consumed_at === null
    && r.status !== 'cancelled');
  return { consumed, openDispatchId: open?.id ?? null };
}

// ─── Routine replenishment (168 RPC) ─────────────────────────────────────────

export interface ReplenishResult {
  ok: boolean;
  idempotent_replay: boolean;
  request_id: string;
  route_id: string;
  source_outlet_stock_id: string;
  destination_outlet_stock_id: string;
}

/**
 * The ONE canonical routine pharmacy→emergency-outlet replenishment call.
 *
 * `requestId` is the caller-generated idempotency key: replaying the same id
 * returns the original result with `idempotent_replay: true` instead of moving
 * stock twice, so a double submit or a retried network call can never
 * double-debit the source pharmacy.
 */
export async function replenishEmergencyOutlet(input: {
  requestId: string;
  routeId: string;
  sourceOutletStockId: string;
  quantity: number;
  fefoOverrideReason?: string | null;
  notes?: string | null;
}): Promise<RpcResult<ReplenishResult>> {
  return callRpc<ReplenishResult>('phoenix_replenish_emergency_outlet', {
    p_request_id:             input.requestId,
    p_route_id:               input.routeId,
    p_source_outlet_stock_id: input.sourceOutletStockId,
    p_quantity:               input.quantity,
    p_fefo_override_reason:   input.fefoOverrideReason ?? null,
    p_notes:                  input.notes ?? null,
  });
}

// ─── Reversal (169 RPC + its read helper) ────────────────────────────────────

export interface ReversibleBatch {
  originReceiveMovementId: string;
  originSendMovementId: string;
  originReferenceId: string;
  destinationOutletStockId: string;
  sourceOutletStockId: string;
  materialIdentityKey: string;
  scientificName: string;
  batchNumber: string | null;
  expiryDate: string | null;
  originalCreditedQuantity: number;
  returnedQuantity: number;
  remainingReversibleQuantity: number;
  originCreatedAt: string;
}

/**
 * Canonical read model for what may still be reversed at one emergency outlet,
 * with the remaining reversible quantity already capped server-side by what has
 * previously been returned — the client never computes that cap itself.
 */
export async function getReversibleBatches(input: {
  organizationId: string;
  destinationPointId: string;
}): Promise<ReversibleBatch[]> {
  if (!supabaseConfigured || !input.organizationId || !input.destinationPointId) return [];
  const { data, error } = await supabase.rpc(
    'phoenix_outlet_replenishment_reversible_batches',
    {
      p_organization_id:      input.organizationId,
      p_destination_point_id: input.destinationPointId,
    },
  );
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(r => ({
    originReceiveMovementId:     String(r.origin_receive_movement_id),
    originSendMovementId:        String(r.origin_send_movement_id),
    originReferenceId:           String(r.origin_reference_id),
    destinationOutletStockId:    String(r.destination_outlet_stock_id),
    sourceOutletStockId:         String(r.source_outlet_stock_id),
    materialIdentityKey:         String(r.material_identity_key ?? ''),
    scientificName:              String(r.scientific_name ?? ''),
    batchNumber:                 r.batch_number == null ? null : String(r.batch_number),
    expiryDate:                  r.expiry_date == null ? null : String(r.expiry_date),
    originalCreditedQuantity:    Number(r.original_credited_quantity ?? 0),
    returnedQuantity:            Number(r.returned_quantity ?? 0),
    remainingReversibleQuantity: Number(r.remaining_reversible_quantity ?? 0),
    originCreatedAt:             String(r.origin_created_at ?? ''),
  }));
}

export interface ReverseReplenishmentResult {
  ok: boolean;
  idempotent_replay: boolean;
  request_id: string;
  route_id: string;
  destination_outlet_stock_id: string;
  source_outlet_stock_id: string;
}

/**
 * Reverses a previous replenishment back to the pharmacy it actually came
 * from. This is NOT the general outlet→institution-warehouse return corridor
 * (Migration 071, `outlet-return.service.ts`): that one returns stock up to the
 * owning institution's warehouse and is an administrative return; this one
 * un-does one specific replenishment along its own route, capped by that
 * replenishment's own credited quantity. The two are deliberately kept
 * distinct in wording, service surface and UI.
 */
export async function reverseOutletReplenishment(input: {
  requestId: string;
  routeId: string;
  destinationOutletStockId: string;
  quantity: number;
  reason?: string | null;
  notes?: string | null;
}): Promise<RpcResult<ReverseReplenishmentResult>> {
  return callRpc<ReverseReplenishmentResult>('phoenix_reverse_outlet_replenishment', {
    p_request_id:                  input.requestId,
    p_route_id:                    input.routeId,
    p_destination_outlet_stock_id: input.destinationOutletStockId,
    p_quantity:                    input.quantity,
    p_reason:                      input.reason ?? null,
    p_notes:                       input.notes ?? null,
  });
}

// ─── UI affordance mirror of the server's eligibility table ──────────────────

export type EligibilityVerdict =
  | { eligible: true }
  | { eligible: false; reason: string };

/**
 * Mirrors the route-eligibility rules that Migration 164's route RPC and
 * Migration 168's replenishment RPC both enforce, so the UI can decline to
 * offer a pairing the server will certainly reject, and can explain why.
 * Returns the SAME canonical identifiers those RPCs raise, so the message an
 * operator sees is identical whichever side declined.
 *
 * Two shapes exist, and they are mutually exclusive:
 *
 *   SHAPE H — health_sector. Source and destination warehouses must BOTH sit
 *     under a facility, and under the SAME one. The destination is always a
 *     crash cabinet in an emergency location (a health centre never has a
 *     rescue cart; this is the health-centre emergency exception).
 *
 *   SHAPE I — hospital / specialized_center. There is no facility layer here
 *     at all: a facility on either side is itself an error. A rescue cart
 *     requires a hospital and an emergency location; a crash cabinet requires
 *     a non-emergency location.
 *
 * Fail-closed: unknown or absent context is never treated as eligible.
 */
export function outletContextEligibility(input: {
  sourceInstitutionClass: InstitutionClass | string | null | undefined;
  sourceFacilityId?: string | null;
  destinationPointType: ReplenishmentDestinationPointType | string | null | undefined;
  destinationClinicalLocationKind: ClinicalLocationKind | string | null | undefined;
  destinationFacilityId?: string | null;
  destinationFacilityClass?: string | null;
  destinationFacilityStatus?: string | null;
}): EligibilityVerdict {
  const cls = input.sourceInstitutionClass;
  const point = input.destinationPointType;
  const clinical = input.destinationClinicalLocationKind;

  if (!isInstitutionClass(cls)) {
    return { eligible: false, reason: 'organization_institution_class_required' };
  }
  if (!isReplenishmentDestinationPointType(point)) {
    return { eligible: false, reason: 'destination_must_be_emergency_outlet' };
  }
  if (!isClinicalLocationKind(clinical)) {
    return { eligible: false, reason: 'destination_clinical_location_kind_required' };
  }

  if (cls === 'health_sector') {
    // SHAPE H — same-facility routing.
    if (!input.sourceFacilityId || !input.destinationFacilityId) {
      return { eligible: false, reason: 'health_center_route_requires_facility' };
    }
    if (input.sourceFacilityId !== input.destinationFacilityId) {
      return { eligible: false, reason: 'cross_facility_route_forbidden' };
    }
    if (!isFacilityClass(input.destinationFacilityClass)) {
      return { eligible: false, reason: 'invalid_facility_class_for_route' };
    }
    if (input.destinationFacilityStatus !== 'active') {
      return { eligible: false, reason: 'facility_not_active' };
    }
    if (point !== 'crash_cabinet') {
      return { eligible: false, reason: 'health_center_rescue_cart_forbidden' };
    }
    if (clinical !== 'emergency') {
      return { eligible: false, reason: 'health_center_crash_cabinet_requires_emergency' };
    }
    return { eligible: true };
  }

  // SHAPE I — hospital | specialized_center. No facility layer exists here.
  if (input.sourceFacilityId || input.destinationFacilityId) {
    return { eligible: false, reason: 'facility_not_permitted_for_this_institution_class' };
  }
  if (point === 'rescue_cart') {
    if (cls !== 'hospital') {
      return { eligible: false, reason: 'rescue_cart_requires_hospital' };
    }
    if (clinical !== 'emergency') {
      return { eligible: false, reason: 'rescue_cart_requires_emergency_context' };
    }
    return { eligible: true };
  }

  if (clinical !== 'non_emergency') {
    return { eligible: false, reason: 'crash_cabinet_requires_non_emergency_context' };
  }
  return { eligible: true };
}
