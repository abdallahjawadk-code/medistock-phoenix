import { supabase, supabaseConfigured } from '@/shared/supabase/client';

/**
 * PHASE-B-NETWORK-UI-A — thin client over the migration 074/075/076 write
 * contracts and their read tables. This file NEVER computes stock, never uses a
 * privileged service key, and never writes a table directly: every mutation goes through a
 * SECURITY DEFINER RPC that re-checks authority server-side, and every read is an
 * RLS-protected SELECT. The UI's permission gates are convenience only.
 */

export type WarehouseKind = 'central' | 'institution';
export type ScopeKind = 'warehouse' | 'distribution_point';

/** Result envelope. `error` carries the RPC's raised code token (e.g. 'NOT_AUTHORIZED_WAREHOUSE_MANAGE'). */
export interface RpcResult<T = Record<string, unknown>> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Normalize a Supabase RPC error into a stable code token. The migrations RAISE
 * 'CODE: human message' — we surface the CODE so the UI can map it to a
 * localized, actionable message (not_authorized / cross_org / invalid / conflict).
 */
function rpcErrorCode(message: string | undefined): string {
  if (!message) return 'unknown_error';
  const head = message.split(':', 1)[0]?.trim() ?? message;
  // Codes are UPPER_SNAKE tokens; anything else is an unexpected DB error.
  return /^[A-Z0-9_]+$/.test(head) ? head : 'unknown_error';
}

async function callRpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
  if (!supabaseConfigured) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, error: rpcErrorCode(error.message) };
  const payload = (data ?? {}) as { ok?: boolean } & T;
  // The RPCs return jsonb { ok: true, ... }; treat a missing ok as success only
  // when there was no error above.
  return { ok: payload.ok !== false, data: payload as T };
}

// ─── Warehouses (074) ────────────────────────────────────────────────────────

export interface NetworkWarehouse {
  id: string;
  name: string;
  name_ar: string;
  warehouseKind: WarehouseKind;
  status: string;
  isMain: boolean;
  code: string | null;
  organizationId: string;
  facilityId: string | null;
}

interface WarehouseRow {
  id: string; name: string; name_ar: string; warehouse_kind: WarehouseKind;
  status: string; is_main: boolean; code: string | null; organization_id: string; facility_id: string | null;
}

function mapWarehouse(r: WarehouseRow): NetworkWarehouse {
  return {
    id: r.id, name: r.name, name_ar: r.name_ar, warehouseKind: r.warehouse_kind,
    status: r.status, isMain: r.is_main, code: r.code, organizationId: r.organization_id,
    facilityId: r.facility_id ?? null,
  };
}

/** All warehouses the caller may see (super_admin: every org). RLS-scoped. */
export async function getAllWarehouses(): Promise<NetworkWarehouse[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('warehouses')
    .select('id, name, name_ar, warehouse_kind, status, is_main, code, organization_id, facility_id')
    .neq('status', 'archived')
    .order('warehouse_kind', { ascending: true })
    .order('name_ar', { ascending: true });
  if (error) throw error;
  return (data as WarehouseRow[] | null ?? []).map(mapWarehouse);
}

export function createWarehouse(input: {
  organizationId: string; name: string; nameAr: string;
  warehouseKind: WarehouseKind; code?: string | null; isMain?: boolean;
}): Promise<RpcResult> {
  return callRpc('phoenix_create_warehouse', {
    p_organization_id: input.organizationId,
    p_name: input.name,
    p_name_ar: input.nameAr,
    p_warehouse_kind: input.warehouseKind,
    p_code: input.code ?? null,
    p_is_main: input.isMain ?? false,
  });
}

/**
 * R1.1 / Migration 181 — the atomic writer for a HEALTH-CENTRE depot.
 *
 * `createWarehouse` above takes no facility, so under the R1.1 topology
 * invariants it cannot produce a valid centre depot: the row would have to be
 * created facility-less first, and an active facility-less health-sector
 * warehouse is by definition the sector main. This RPC creates the depot bound
 * to its centre in one statement — institution kind, never main, active — so
 * there is no intermediate illegal state and no "remember to assign the
 * facility afterwards" step left to the operator.
 */
export function createHealthCenterWarehouse(input: {
  organizationId: string; facilityId: string; name: string; nameAr: string; code?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_create_health_center_warehouse', {
    p_organization_id: input.organizationId,
    p_facility_id: input.facilityId,
    p_name: input.name,
    p_name_ar: input.nameAr,
    p_code: input.code ?? null,
  });
}

export function updateWarehouse(input: {
  warehouseId: string; name?: string; nameAr?: string; code?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_update_warehouse', {
    p_warehouse_id: input.warehouseId,
    p_name: input.name ?? null,
    p_name_ar: input.nameAr ?? null,
    p_code: input.code ?? null,
  });
}

export function setWarehouseActive(warehouseId: string, active: boolean, reason?: string): Promise<RpcResult> {
  return callRpc('phoenix_set_warehouse_active', {
    p_warehouse_id: warehouseId, p_active: active, p_reason: reason ?? null,
  });
}

// ─── Supply routes (075) ─────────────────────────────────────────────────────

export interface SupplyRoute {
  id: string;
  sourceWarehouseId: string;
  targetWarehouseId: string;
  priority: number;
  isActive: boolean;
  notes: string | null;
}

interface SupplyRouteRow {
  id: string; source_warehouse_id: string; target_warehouse_id: string;
  priority: number; is_active: boolean; notes: string | null;
}

export async function getSupplyRoutes(): Promise<SupplyRoute[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('warehouse_supply_routes')
    .select('id, source_warehouse_id, target_warehouse_id, priority, is_active, notes')
    .order('target_warehouse_id', { ascending: true })
    .order('priority', { ascending: true });
  if (error) throw error;
  return (data as SupplyRouteRow[] | null ?? []).map(r => ({
    id: r.id, sourceWarehouseId: r.source_warehouse_id, targetWarehouseId: r.target_warehouse_id,
    priority: r.priority, isActive: r.is_active, notes: r.notes,
  }));
}

export function createSupplyRoute(input: {
  sourceWarehouseId: string; targetWarehouseId: string; priority?: number; notes?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_create_supply_route', {
    p_source_warehouse_id: input.sourceWarehouseId,
    p_target_warehouse_id: input.targetWarehouseId,
    p_priority: input.priority ?? 1,
    p_notes: input.notes ?? null,
  });
}

export function updateSupplyRoute(input: {
  routeId: string; priority?: number; notes?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_update_supply_route', {
    p_route_id: input.routeId,
    p_priority: input.priority ?? null,
    p_notes: input.notes ?? null,
  });
}

export function setSupplyRouteActive(routeId: string, active: boolean, reason?: string): Promise<RpcResult> {
  return callRpc('phoenix_set_supply_route_active', {
    p_route_id: routeId, p_active: active, p_reason: reason ?? null,
  });
}

// ─── Direct central→institution supply (077) ─────────────────────────────────
// The route-free path: a pharmacy-department (central) warehouse officer opens a
// request straight to a chosen institution warehouse. No warehouse_supply_route
// is created or consulted — the server validates the endpoints on every call.
// The legacy route helpers above remain for backward compatibility only.

export function createDirectTransferRequest(input: {
  sourceWarehouseId: string;
  destinationOrganizationId: string;
  destinationWarehouseId: string;
  requestNumber: string;
  notes?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_create_direct_warehouse_transfer_request', {
    p_source_warehouse_id: input.sourceWarehouseId,
    p_destination_organization_id: input.destinationOrganizationId,
    p_destination_warehouse_id: input.destinationWarehouseId,
    p_request_number: input.requestNumber,
    p_notes: input.notes ?? null,
  });
}

export function addTransferRequestLine(input: {
  transferRequestId: string; scientificName: string; requestedQuantity: number;
  centralItemId?: string | null; concentration?: string | null; dosageForm?: string | null;
  unit?: string | null; notes?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_add_warehouse_transfer_request_line', {
    p_transfer_request_id: input.transferRequestId,
    p_scientific_name: input.scientificName,
    p_requested_quantity: input.requestedQuantity,
    p_central_item_id: input.centralItemId ?? null,
    p_concentration: input.concentration ?? null,
    p_dosage_form: input.dosageForm ?? null,
    p_unit: input.unit ?? null,
    p_notes: input.notes ?? null,
  });
}

export function submitTransferRequest(transferRequestId: string): Promise<RpcResult> {
  return callRpc('phoenix_submit_warehouse_transfer_request', {
    p_transfer_request_id: transferRequestId,
  });
}

export function cancelTransferRequest(transferRequestId: string, reason: string): Promise<RpcResult> {
  return callRpc('phoenix_cancel_warehouse_transfer_request', {
    p_transfer_request_id: transferRequestId, p_cancellation_reason: reason,
  });
}

export function reviewTransferRequest(
  transferRequestId: string,
  decisions: Array<{ line_id: string; approved_quantity: number }>,
): Promise<RpcResult> {
  return callRpc('phoenix_review_warehouse_transfer_request', {
    p_transfer_request_id: transferRequestId,
    p_decisions: decisions,
  });
}

/** Ships one line of a DIRECT request. `requestId` is a fresh idempotency token. */
/**
 * Always calls the FEFO-GUARDED variant (150) — `fefoOverride`/`overrideReason`
 * default to the non-override case (false/null), reproducing the base RPC's
 * exact behavior byte-for-byte when omitted. 150's own gate re-checks
 * `inventory.fefo_override` server-side on every call regardless of this UI;
 * see useFefoOverridePermission.ts.
 */
export function sendDirectTransferLine(input: {
  requestId: string; transferRequestId: string; warehouseStockId: string;
  quantity: number; transferNumber: string; transferRequestLineId?: string | null;
  documentNumber?: string | null; notes?: string | null;
  fefoOverride?: boolean; overrideReason?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_send_direct_warehouse_transfer_line_fefo_guarded', {
    p_request_id: input.requestId,
    p_transfer_request_id: input.transferRequestId,
    p_warehouse_stock_id: input.warehouseStockId,
    p_quantity: input.quantity,
    p_transfer_number: input.transferNumber,
    p_transfer_request_line_id: input.transferRequestLineId ?? null,
    p_document_number: input.documentNumber ?? null,
    p_notes: input.notes ?? null,
    p_fefo_override: input.fefoOverride ?? false,
    p_override_reason: input.overrideReason ?? null,
  });
}

// ─── Scope assignments (076) ─────────────────────────────────────────────────

export interface ScopeAssignment {
  id: string;
  profileId: string;
  organizationId: string;
  scopeType: ScopeKind;
  warehouseId: string | null;
  distributionPointId: string | null;
  isActive: boolean;
}

interface ScopeAssignmentRow {
  id: string; profile_id: string; organization_id: string; scope_type: ScopeKind;
  warehouse_id: string | null; distribution_point_id: string | null; is_active: boolean;
}

/** Active scope assignments the caller may see (RLS-scoped). */
export async function getScopeAssignments(orgId?: string | null): Promise<ScopeAssignment[]> {
  if (!supabaseConfigured) return [];
  let q = supabase
    .from('profile_scope_assignments')
    .select('id, profile_id, organization_id, scope_type, warehouse_id, distribution_point_id, is_active')
    .eq('is_active', true);
  if (orgId) q = q.eq('organization_id', orgId);
  const { data, error } = await q;
  if (error) throw error;
  return (data as ScopeAssignmentRow[] | null ?? []).map(r => ({
    id: r.id, profileId: r.profile_id, organizationId: r.organization_id, scopeType: r.scope_type,
    warehouseId: r.warehouse_id, distributionPointId: r.distribution_point_id, isActive: r.is_active,
  }));
}

export function assignProfileScope(input: {
  profileId: string; scopeType: ScopeKind; targetId: string;
}): Promise<RpcResult> {
  return callRpc('phoenix_assign_profile_scope', {
    p_profile_id: input.profileId,
    p_scope_type: input.scopeType,
    p_target_id: input.targetId,
  });
}

export function revokeProfileScope(assignmentId: string, reason: string): Promise<RpcResult> {
  return callRpc('phoenix_revoke_profile_scope', {
    p_assignment_id: assignmentId, p_reason: reason,
  });
}

// ─── Direct forward lifecycle — build / review / send / receive (068 + 077) ───
// The operational surface behind the Direct Supply tab. Every write is a
// SECURITY DEFINER RPC that re-checks source/destination scope server-side; every
// read is an RLS-scoped SELECT. Legacy warehouse_supply_routes is never consulted.

export interface TransferRequest {
  id: string; routeId: string | null; direct: boolean;
  sourceWarehouseId: string; sourceOrganizationId: string;
  destinationWarehouseId: string; destinationOrganizationId: string;
  requestNumber: string; status: string; notes: string | null; createdAt: string;
}
interface TransferRequestRow {
  id: string; route_id: string | null;
  source_warehouse_id: string; source_organization_id: string;
  destination_warehouse_id: string; destination_organization_id: string;
  request_number: string; status: string; notes: string | null; created_at: string;
}
function mapTransferRequest(r: TransferRequestRow): TransferRequest {
  return {
    id: r.id, routeId: r.route_id, direct: r.route_id === null,
    sourceWarehouseId: r.source_warehouse_id, sourceOrganizationId: r.source_organization_id,
    destinationWarehouseId: r.destination_warehouse_id, destinationOrganizationId: r.destination_organization_id,
    requestNumber: r.request_number, status: r.status, notes: r.notes, createdAt: r.created_at,
  };
}

/** Transfer requests visible to the caller (RLS-scoped). `directOnly` hides legacy routed rows. */
export async function getTransferRequests(directOnly = true): Promise<TransferRequest[]> {
  if (!supabaseConfigured) return [];
  let q = supabase
    .from('warehouse_transfer_requests')
    .select('id, route_id, source_warehouse_id, source_organization_id, destination_warehouse_id, destination_organization_id, request_number, status, notes, created_at')
    .order('created_at', { ascending: false });
  if (directOnly) q = q.is('route_id', null);
  const { data, error } = await q;
  if (error) throw error;
  return (data as TransferRequestRow[] | null ?? []).map(mapTransferRequest);
}

export interface TransferRequestLine {
  id: string; transferRequestId: string; scientificName: string;
  concentration: string | null; dosageForm: string | null; unit: string | null;
  requestedQuantity: number; approvedQuantity: number | null; fulfilledQuantity: number;
  status: string; notes: string | null;
}
interface TransferRequestLineRow {
  id: string; transfer_request_id: string; scientific_name: string;
  concentration: string | null; dosage_form: string | null; unit: string | null;
  requested_quantity: number; approved_quantity: number | null; fulfilled_quantity: number;
  status: string; notes: string | null;
}
export async function getTransferRequestLines(transferRequestId: string): Promise<TransferRequestLine[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('warehouse_transfer_request_lines')
    .select('id, transfer_request_id, scientific_name, concentration, dosage_form, unit, requested_quantity, approved_quantity, fulfilled_quantity, status, notes')
    .eq('transfer_request_id', transferRequestId)
    .order('scientific_name', { ascending: true });
  if (error) throw error;
  return (data as TransferRequestLineRow[] | null ?? []).map(r => ({
    id: r.id, transferRequestId: r.transfer_request_id, scientificName: r.scientific_name,
    concentration: r.concentration, dosageForm: r.dosage_form, unit: r.unit,
    requestedQuantity: r.requested_quantity, approvedQuantity: r.approved_quantity,
    fulfilledQuantity: r.fulfilled_quantity, status: r.status, notes: r.notes,
  }));
}

export function updateTransferRequestLine(input: {
  transferRequestLineId: string; requestedQuantity: number; notes?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_update_warehouse_transfer_request_line', {
    p_transfer_request_line_id: input.transferRequestLineId,
    p_requested_quantity: input.requestedQuantity,
    p_notes: input.notes ?? null,
  });
}

export function deleteTransferRequestLine(transferRequestLineId: string): Promise<RpcResult> {
  return callRpc('phoenix_delete_warehouse_transfer_request_line', {
    p_transfer_request_line_id: transferRequestLineId,
  });
}

/** Batches physically present in a warehouse (RLS-scoped) — the send picker. */
export interface WarehouseStockBatch {
  id: string; warehouseId: string; scientificName: string;
  batchNumber: string | null; expiryDate: string | null;
  onHandQuantity: number; reservedQuantity: number; availableQuantity: number;
  nationalCode: string | null;
}
interface WarehouseStockRow {
  id: string; warehouse_id: string; scientific_name: string;
  batch_number: string | null; expiry_date: string | null;
  on_hand_quantity: number; reserved_quantity: number; available_quantity: number;
  national_code: string | null;
}
export async function getWarehouseStock(warehouseId: string): Promise<WarehouseStockBatch[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('warehouse_stock')
    .select('id, warehouse_id, scientific_name, batch_number, expiry_date, on_hand_quantity, reserved_quantity, available_quantity, national_code')
    .eq('warehouse_id', warehouseId)
    .gt('on_hand_quantity', 0)
    .order('expiry_date', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data as WarehouseStockRow[] | null ?? []).map(r => ({
    id: r.id, warehouseId: r.warehouse_id, scientificName: r.scientific_name,
    batchNumber: r.batch_number, expiryDate: r.expiry_date,
    onHandQuantity: r.on_hand_quantity, reservedQuantity: r.reserved_quantity,
    availableQuantity: r.available_quantity, nationalCode: r.national_code,
  }));
}

export interface Transfer {
  id: string; routeId: string | null; direct: boolean; transferRequestId: string | null;
  sourceWarehouseId: string; destinationWarehouseId: string; destinationOrganizationId: string;
  transferNumber: string; status: string; documentNumber: string | null;
}
interface TransferRow {
  id: string; route_id: string | null; transfer_request_id: string | null;
  source_warehouse_id: string; destination_warehouse_id: string; destination_organization_id: string;
  transfer_number: string; status: string; document_number: string | null;
}
/** In-flight / completed transfers into an institution warehouse (RLS-scoped) — the receive queue. */
export async function getTransfers(destinationWarehouseId?: string, directOnly = true): Promise<Transfer[]> {
  if (!supabaseConfigured) return [];
  let q = supabase
    .from('warehouse_transfers')
    .select('id, route_id, transfer_request_id, source_warehouse_id, destination_warehouse_id, destination_organization_id, transfer_number, status, document_number')
    .order('sent_at', { ascending: false });
  if (directOnly) q = q.is('route_id', null);
  if (destinationWarehouseId) q = q.eq('destination_warehouse_id', destinationWarehouseId);
  const { data, error } = await q;
  if (error) throw error;
  return (data as TransferRow[] | null ?? []).map(r => ({
    id: r.id, routeId: r.route_id, direct: r.route_id === null, transferRequestId: r.transfer_request_id,
    sourceWarehouseId: r.source_warehouse_id, destinationWarehouseId: r.destination_warehouse_id,
    destinationOrganizationId: r.destination_organization_id,
    transferNumber: r.transfer_number, status: r.status, documentNumber: r.document_number,
  }));
}

export interface TransferLine {
  id: string; transferId: string; scientificName: string;
  batchNumber: string | null; expiryDate: string | null;
  sentQuantity: number; receivedQuantity: number | null; status: string;
}
interface TransferLineRow {
  id: string; transfer_id: string; scientific_name: string;
  batch_number: string | null; expiry_date: string | null;
  sent_quantity: number; received_quantity: number | null; status: string;
}
function mapTransferLine(r: TransferLineRow): TransferLine {
  return {
    id: r.id, transferId: r.transfer_id, scientificName: r.scientific_name,
    batchNumber: r.batch_number, expiryDate: r.expiry_date,
    sentQuantity: r.sent_quantity, receivedQuantity: r.received_quantity, status: r.status,
  };
}

export async function getTransferLines(transferId: string): Promise<TransferLine[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('warehouse_transfer_lines')
    .select('id, transfer_id, scientific_name, batch_number, expiry_date, sent_quantity, received_quantity, status')
    .eq('transfer_id', transferId)
    .order('scientific_name', { ascending: true });
  if (error) throw error;
  return (data as TransferLineRow[] | null ?? []).map(mapTransferLine);
}

/** Lines for many transfers in ONE query — the return add-line provenance picker. */
export async function getTransferLinesForTransfers(transferIds: string[]): Promise<TransferLine[]> {
  if (!supabaseConfigured || transferIds.length === 0) return [];
  const { data, error } = await supabase
    .from('warehouse_transfer_lines')
    .select('id, transfer_id, scientific_name, batch_number, expiry_date, sent_quantity, received_quantity, status')
    .in('transfer_id', transferIds)
    .order('scientific_name', { ascending: true });
  if (error) throw error;
  return (data as TransferLineRow[] | null ?? []).map(mapTransferLine);
}

/**
 * MOVEMENT-COMPOSER-A — the FULL immutable line record for the institution's
 * incoming-supplies screen and for return provenance.
 *
 * `TransferLine` above is deliberately narrow (it drives a compact list). The
 * incoming screen must show what was actually dispatched — every product,
 * batch, price and provenance column — because the receiving officer checks
 * physical goods against an immutable record, not a summary.
 *
 * Every column below already exists (068, plus 069's additive return columns).
 * Nothing is reconstructed, inferred or defaulted client-side.
 */
export interface IncomingTransferLine {
  id: string;
  transferId: string;
  sourceOrganizationId: string;
  sourceWarehouseStockId: string;
  transferRequestLineId: string | null;
  centralItemId: string | null;
  scientificName: string;
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  unit: string | null;
  nationalCode: string | null;
  hasNoNationalCode: boolean;
  batchNumber: string | null;
  hasNoBatchNumber: boolean;
  internalBatchReference: string | null;
  expiryDate: string | null;
  unitPrice: number | null;
  priceBasis: string | null;
  currency: string | null;
  supplyTypeText: string | null;
  sentQuantity: number;
  receivedQuantity: number | null;
  /** 069 additive columns — the return provenance ledger. */
  returnedQuantity: number;
  returnReceivedQuantity: number;
  status: string;
  differenceReason: string | null;
  receivedAt: string | null;
  resultingWarehouseStockId: string | null;
}

const INCOMING_LINE_COLUMNS =
  'id, transfer_id, source_organization_id, source_warehouse_stock_id, transfer_request_line_id, ' +
  'central_item_id, scientific_name, trade_name, concentration, dosage_form, unit, ' +
  'national_code, has_no_national_code, batch_number, has_no_batch_number, internal_batch_reference, ' +
  'expiry_date, unit_price, price_basis, currency, supply_type_text, ' +
  'sent_quantity, received_quantity, returned_quantity, return_received_quantity, ' +
  'status, difference_reason, received_at, resulting_warehouse_stock_id';

interface IncomingLineRow {
  id: string; transfer_id: string; source_organization_id: string;
  source_warehouse_stock_id: string; transfer_request_line_id: string | null;
  central_item_id: string | null; scientific_name: string; trade_name: string | null;
  concentration: string | null; dosage_form: string | null; unit: string | null;
  national_code: string | null; has_no_national_code: boolean;
  batch_number: string | null; has_no_batch_number: boolean;
  internal_batch_reference: string | null; expiry_date: string | null;
  unit_price: number | null; price_basis: string | null; currency: string | null;
  supply_type_text: string | null; sent_quantity: number; received_quantity: number | null;
  returned_quantity: number; return_received_quantity: number;
  status: string; difference_reason: string | null; received_at: string | null;
  resulting_warehouse_stock_id: string | null;
}

function mapIncomingLine(r: IncomingLineRow): IncomingTransferLine {
  return {
    id: r.id, transferId: r.transfer_id, sourceOrganizationId: r.source_organization_id,
    sourceWarehouseStockId: r.source_warehouse_stock_id,
    transferRequestLineId: r.transfer_request_line_id, centralItemId: r.central_item_id,
    scientificName: r.scientific_name, tradeName: r.trade_name,
    concentration: r.concentration, dosageForm: r.dosage_form, unit: r.unit,
    nationalCode: r.national_code, hasNoNationalCode: r.has_no_national_code,
    batchNumber: r.batch_number, hasNoBatchNumber: r.has_no_batch_number,
    internalBatchReference: r.internal_batch_reference, expiryDate: r.expiry_date,
    unitPrice: r.unit_price, priceBasis: r.price_basis, currency: r.currency,
    supplyTypeText: r.supply_type_text,
    sentQuantity: r.sent_quantity, receivedQuantity: r.received_quantity,
    returnedQuantity: r.returned_quantity, returnReceivedQuantity: r.return_received_quantity,
    status: r.status, differenceReason: r.difference_reason, receivedAt: r.received_at,
    resultingWarehouseStockId: r.resulting_warehouse_stock_id,
  };
}

/**
 * Full lines for MANY transfers in ONE query. Batched deliberately: a
 * per-transfer loop would be an N+1 scan across the whole receive queue.
 */
export async function getIncomingTransferLines(transferIds: string[]): Promise<IncomingTransferLine[]> {
  if (!supabaseConfigured || transferIds.length === 0) return [];
  const { data, error } = await supabase
    .from('warehouse_transfer_lines')
    .select(INCOMING_LINE_COLUMNS)
    .in('transfer_id', transferIds)
    .order('scientific_name', { ascending: true });
  if (error) throw error;
  // The column list is a concatenated const, so supabase-js cannot parse it into
  // a row type and infers GenericStringError[]. The shape is asserted by
  // IncomingLineRow above and by the columns actually existing in 068/069.
  return (data as unknown as IncomingLineRow[] | null ?? []).map(mapIncomingLine);
}

/** Institution receives one in-transit forward line (068, already route-free). */
export function receiveTransferLine(input: {
  requestId: string; transferLineId: string; receivedQuantity: number;
  differenceReason?: string | null; notes?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_receive_warehouse_transfer_line', {
    p_request_id: input.requestId,
    p_transfer_line_id: input.transferLineId,
    p_received_quantity: input.receivedQuantity,
    p_difference_reason: input.differenceReason ?? null,
    p_notes: input.notes ?? null,
  });
}

// ─── Direct return lifecycle — institution → central, route-free (069 + 077) ──

export function requestDirectReturn(input: {
  sourceWarehouseId: string; destinationWarehouseId: string; returnNumber: string; notes?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_request_direct_warehouse_return', {
    p_source_warehouse_id: input.sourceWarehouseId,
    p_destination_warehouse_id: input.destinationWarehouseId,
    p_return_number: input.returnNumber,
    p_notes: input.notes ?? null,
  });
}

export function recallDirectTransfer(input: {
  sourceWarehouseId: string; destinationWarehouseId: string; returnNumber: string; notes?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_recall_direct_warehouse_transfer', {
    p_source_warehouse_id: input.sourceWarehouseId,
    p_destination_warehouse_id: input.destinationWarehouseId,
    p_return_number: input.returnNumber,
    p_notes: input.notes ?? null,
  });
}

export function addDirectReturnLine(input: {
  returnRequestId: string; originalTransferLineId: string; requestedQuantity: number;
  reasonCode: string; reasonText?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_add_direct_warehouse_return_request_line', {
    p_return_request_id: input.returnRequestId,
    p_original_transfer_line_id: input.originalTransferLineId,
    p_requested_quantity: input.requestedQuantity,
    p_reason_code: input.reasonCode,
    p_reason_text: input.reasonText ?? null,
  });
}

export function deleteReturnRequestLine(returnRequestLineId: string): Promise<RpcResult> {
  return callRpc('phoenix_delete_warehouse_return_request_line', {
    p_return_request_line_id: returnRequestLineId,
  });
}

export function submitReturnRequest(returnRequestId: string): Promise<RpcResult> {
  return callRpc('phoenix_submit_warehouse_return_request', { p_return_request_id: returnRequestId });
}

export function cancelReturnRequest(returnRequestId: string, reason: string): Promise<RpcResult> {
  return callRpc('phoenix_cancel_warehouse_return_request', {
    p_return_request_id: returnRequestId, p_cancellation_reason: reason,
  });
}

export function reviewReturnRequest(
  returnRequestId: string,
  decisions: Array<{ line_id: string; approved_quantity: number }>,
): Promise<RpcResult> {
  return callRpc('phoenix_review_warehouse_return_request', {
    p_return_request_id: returnRequestId, p_decisions: decisions,
  });
}

/** Ships one line of a DIRECT return. `requestId` is a fresh idempotency token. */
export function sendDirectReturnLine(input: {
  requestId: string; returnRequestLineId: string; quantity: number;
  shipmentNumber: string; documentNumber?: string | null; notes?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_send_direct_warehouse_return_shipment_line', {
    p_request_id: input.requestId,
    p_return_request_line_id: input.returnRequestLineId,
    p_quantity: input.quantity,
    p_shipment_number: input.shipmentNumber,
    p_document_number: input.documentNumber ?? null,
    p_notes: input.notes ?? null,
  });
}

/** Central receives one in-transit return line (069, already route-free). */
export function receiveReturnShipmentLine(input: {
  requestId: string; shipmentLineId: string; receivedQuantity: number;
  differenceReason?: string | null; notes?: string | null; dispositionDecision?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_receive_warehouse_return_shipment_line', {
    p_request_id: input.requestId,
    p_shipment_line_id: input.shipmentLineId,
    p_received_quantity: input.receivedQuantity,
    p_difference_reason: input.differenceReason ?? null,
    p_notes: input.notes ?? null,
    p_disposition_decision: input.dispositionDecision ?? null,
  });
}

export interface ReturnRequest {
  id: string; routeId: string | null; direct: boolean; requestedBySide: string;
  sourceWarehouseId: string; sourceOrganizationId: string;
  destinationWarehouseId: string; destinationOrganizationId: string;
  returnNumber: string; status: string; notes: string | null; createdAt: string;
}
interface ReturnRequestRow {
  id: string; route_id: string | null; requested_by_side: string;
  source_warehouse_id: string; source_organization_id: string;
  destination_warehouse_id: string; destination_organization_id: string;
  return_number: string; status: string; notes: string | null; created_at: string;
}
export async function getReturnRequests(directOnly = true): Promise<ReturnRequest[]> {
  if (!supabaseConfigured) return [];
  let q = supabase
    .from('warehouse_return_requests')
    .select('id, route_id, requested_by_side, source_warehouse_id, source_organization_id, destination_warehouse_id, destination_organization_id, return_number, status, notes, created_at')
    .order('created_at', { ascending: false });
  if (directOnly) q = q.is('route_id', null);
  const { data, error } = await q;
  if (error) throw error;
  return (data as ReturnRequestRow[] | null ?? []).map(r => ({
    id: r.id, routeId: r.route_id, direct: r.route_id === null, requestedBySide: r.requested_by_side,
    sourceWarehouseId: r.source_warehouse_id, sourceOrganizationId: r.source_organization_id,
    destinationWarehouseId: r.destination_warehouse_id, destinationOrganizationId: r.destination_organization_id,
    returnNumber: r.return_number, status: r.status, notes: r.notes, createdAt: r.created_at,
  }));
}

export interface ReturnRequestLine {
  id: string; returnRequestId: string; originalTransferLineId: string; scientificName: string;
  batchNumber: string | null; expiryDate: string | null; reasonCode: string;
  requestedQuantity: number; approvedQuantity: number | null; fulfilledQuantity: number; status: string;
}
interface ReturnRequestLineRow {
  id: string; return_request_id: string; original_transfer_line_id: string; scientific_name: string;
  batch_number: string | null; expiry_date: string | null; reason_code: string;
  requested_quantity: number; approved_quantity: number | null; fulfilled_quantity: number; status: string;
}
export async function getReturnRequestLines(returnRequestId: string): Promise<ReturnRequestLine[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('warehouse_return_request_lines')
    .select('id, return_request_id, original_transfer_line_id, scientific_name, batch_number, expiry_date, reason_code, requested_quantity, approved_quantity, fulfilled_quantity, status')
    .eq('return_request_id', returnRequestId)
    .order('scientific_name', { ascending: true });
  if (error) throw error;
  return (data as ReturnRequestLineRow[] | null ?? []).map(r => ({
    id: r.id, returnRequestId: r.return_request_id, originalTransferLineId: r.original_transfer_line_id,
    scientificName: r.scientific_name, batchNumber: r.batch_number, expiryDate: r.expiry_date,
    reasonCode: r.reason_code, requestedQuantity: r.requested_quantity, approvedQuantity: r.approved_quantity,
    fulfilledQuantity: r.fulfilled_quantity, status: r.status,
  }));
}

export interface ReturnShipmentLine {
  id: string; shipmentId: string; scientificName: string;
  batchNumber: string | null; expiryDate: string | null;
  sentQuantity: number; receivedQuantity: number | null; status: string;
  disposition: string | null; custodyState: string | null;
}
interface ReturnShipmentLineRow {
  id: string; shipment_id: string; scientific_name: string;
  batch_number: string | null; expiry_date: string | null;
  sent_quantity: number; received_quantity: number | null; status: string;
  disposition: string | null; custody_state: string | null;
}
export async function getReturnShipmentLines(shipmentId: string): Promise<ReturnShipmentLine[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('warehouse_return_shipment_lines')
    .select('id, shipment_id, scientific_name, batch_number, expiry_date, sent_quantity, received_quantity, status, disposition, custody_state')
    .eq('shipment_id', shipmentId)
    .order('scientific_name', { ascending: true });
  if (error) throw error;
  return (data as ReturnShipmentLineRow[] | null ?? []).map(r => ({
    id: r.id, shipmentId: r.shipment_id, scientificName: r.scientific_name,
    batchNumber: r.batch_number, expiryDate: r.expiry_date,
    sentQuantity: r.sent_quantity, receivedQuantity: r.received_quantity, status: r.status,
    disposition: r.disposition, custodyState: r.custody_state,
  }));
}

export interface ReturnShipment {
  id: string; routeId: string | null; direct: boolean; returnRequestId: string;
  sourceWarehouseId: string; destinationWarehouseId: string;
  shipmentNumber: string; status: string;
}
interface ReturnShipmentRow {
  id: string; route_id: string | null; return_request_id: string;
  source_warehouse_id: string; destination_warehouse_id: string;
  shipment_number: string; status: string;
}
export async function getReturnShipments(destinationWarehouseId?: string, directOnly = true): Promise<ReturnShipment[]> {
  if (!supabaseConfigured) return [];
  let q = supabase
    .from('warehouse_return_shipments')
    .select('id, route_id, return_request_id, source_warehouse_id, destination_warehouse_id, shipment_number, status')
    .order('created_at', { ascending: false });
  if (directOnly) q = q.is('route_id', null);
  if (destinationWarehouseId) q = q.eq('destination_warehouse_id', destinationWarehouseId);
  const { data, error } = await q;
  if (error) throw error;
  return (data as ReturnShipmentRow[] | null ?? []).map(r => ({
    id: r.id, routeId: r.route_id, direct: r.route_id === null, returnRequestId: r.return_request_id,
    sourceWarehouseId: r.source_warehouse_id, destinationWarehouseId: r.destination_warehouse_id,
    shipmentNumber: r.shipment_number, status: r.status,
  }));
}

/** The return reason codes the 069 CHECK constraint allows, for the add-line picker. */
export const RETURN_REASON_CODES = [
  'near_expiry', 'excess', 'shipment_error',
  'expired', 'damaged', 'recalled', 'quality_issue', 'temperature_excursion', 'other',
] as const;

/** Reasons the receiver must classify explicitly at receive (fail-closed in the RPC). */
export const RETURN_DISPOSITION_REASONS = ['near_expiry', 'excess', 'shipment_error'] as const;
