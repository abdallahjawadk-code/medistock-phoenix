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
}

interface WarehouseRow {
  id: string; name: string; name_ar: string; warehouse_kind: WarehouseKind;
  status: string; is_main: boolean; code: string | null; organization_id: string;
}

function mapWarehouse(r: WarehouseRow): NetworkWarehouse {
  return {
    id: r.id, name: r.name, name_ar: r.name_ar, warehouseKind: r.warehouse_kind,
    status: r.status, isMain: r.is_main, code: r.code, organizationId: r.organization_id,
  };
}

/** All warehouses the caller may see (super_admin: every org). RLS-scoped. */
export async function getAllWarehouses(): Promise<NetworkWarehouse[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('warehouses')
    .select('id, name, name_ar, warehouse_kind, status, is_main, code, organization_id')
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
