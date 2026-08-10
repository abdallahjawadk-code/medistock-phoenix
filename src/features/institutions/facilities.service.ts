import { supabase, supabaseConfigured } from '@/shared/supabase/client';
import { isFacilityClass, type FacilityClass } from '@/shared/lib/institution-hierarchy';

/**
 * STAGE-E-E7-2 — thin client over Migration 164's subordinate-facility identity
 * contract and Migration 170's warehouse→facility assignment authority.
 *
 * Same discipline as dispatch.service.ts / network.service.ts: this file NEVER
 * writes `organization_facilities` or `warehouses.facility_id` directly. Both
 * mutations go through their canonical SECURITY DEFINER RPCs, which re-check
 * permission and every structural rule server-side:
 *
 *   * phoenix_upsert_organization_facility (164) — the sole facility writer.
 *     Enforces `organization_facilities.manage`, and the composite FK
 *     `of_parent_class_fk` structurally restricts facilities to organizations
 *     whose institution_class is 'health_sector'. A pharmacy_department_
 *     authority (Migration 171: institution_class always NULL) can therefore
 *     never be a facility parent — no client-side rule is required, and none
 *     is invented here.
 *
 *   * phoenix_assign_warehouse_facility (170) — the sole writer of
 *     warehouses.facility_id, behind a hard trigger boundary that refuses
 *     reassignment once the warehouse has operational dependencies.
 *
 * Reads are RLS-scoped SELECTs. Client-side filtering in the UI is a
 * convenience that keeps operators from being offered a DB-illegal path; the
 * database remains the authority in every case.
 */

export interface RpcResult<T = Record<string, unknown>> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Preserves the canonical error identifier raised by the RPC (e.g.
 * `forbidden_organization_facilities_manage`, `warehouse_facility_in_use`) so
 * the UI can map it to a translated message without inventing or hiding it.
 */
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

// ─── Facility read model (164 table, RLS-scoped) ─────────────────────────────

export interface OrganizationFacility {
  id: string;
  organizationId: string;
  facilityClass: FacilityClass | null;
  name: string;
  nameAr: string;
  code: string | null;
  status: string;
  createdAt: string;
}

interface FacilityRow {
  id: string; organization_id: string; facility_class: string;
  name: string; name_ar: string; code: string | null;
  status: string; created_at: string;
}

const FACILITY_COLUMNS =
  'id, organization_id, facility_class, name, name_ar, code, status, created_at';

/**
 * Fail-closed mapping: an unrecognised facility_class becomes null rather than
 * being coerced into one of the two known classes, so a class added by a later
 * migration is never silently mislabelled by this client.
 */
function mapFacility(r: FacilityRow): OrganizationFacility {
  return {
    id: r.id,
    organizationId: r.organization_id,
    facilityClass: isFacilityClass(r.facility_class) ? r.facility_class : null,
    name: r.name,
    nameAr: r.name_ar,
    code: r.code,
    status: r.status,
    createdAt: r.created_at,
  };
}

export async function listOrganizationFacilities(
  organizationId: string,
): Promise<OrganizationFacility[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('organization_facilities')
    .select(FACILITY_COLUMNS)
    .eq('organization_id', organizationId)
    .order('name_ar');
  if (error) throw error;
  return (data ?? []).map(r => mapFacility(r as FacilityRow));
}

// ─── Facility writer (164 RPC — the only authorized path) ────────────────────

export interface UpsertFacilityResult {
  ok: boolean;
  facility_id: string;
  facility_class: string;
  status: string;
}

/**
 * Creates (facilityId omitted) or updates (facilityId supplied) a subordinate
 * facility. `isActive` maps to the RPC's own active/inactive handling; the
 * archived state is deliberately not reachable from here, matching what the
 * canonical contract exposes.
 */
export async function upsertOrganizationFacility(input: {
  facilityId?: string | null;
  organizationId: string;
  facilityClass: FacilityClass;
  name: string;
  nameAr: string;
  code?: string | null;
  isActive?: boolean;
}): Promise<RpcResult<UpsertFacilityResult>> {
  return callRpc<UpsertFacilityResult>('phoenix_upsert_organization_facility', {
    p_facility_id:     input.facilityId ?? null,
    p_organization_id: input.organizationId,
    p_facility_class:  input.facilityClass,
    p_name:            input.name,
    p_name_ar:         input.nameAr,
    p_code:            input.code ?? null,
    p_is_active:       input.isActive ?? true,
  });
}

// ─── Warehouse → facility assignment (170 RPC — the only authorized path) ────

export interface AssignWarehouseFacilityResult {
  ok: boolean;
  warehouse_id: string;
  old_facility_id: string | null;
  new_facility_id: string | null;
}

/**
 * Assigns (or, with a null facilityId, clears) a warehouse's facility link.
 * Migration 170's trigger refuses any change once the warehouse carries
 * operational dependencies — that rejection is surfaced verbatim, never
 * pre-empted by a client-side guess about what the database will allow.
 */
export async function assignWarehouseFacility(input: {
  warehouseId: string;
  facilityId: string | null;
}): Promise<RpcResult<AssignWarehouseFacilityResult>> {
  return callRpc<AssignWarehouseFacilityResult>('phoenix_assign_warehouse_facility', {
    p_warehouse_id: input.warehouseId,
    p_facility_id:  input.facilityId,
  });
}
