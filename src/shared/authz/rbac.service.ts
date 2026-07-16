/* ─── MEDISTOCK PHOENIX — Scoped RBAC transport (migration 062 section D) ──────
   The ONLY module allowed to name a scoped-RBAC database function. Three RPCs,
   with the exact committed signatures:

     phoenix_profile_has_scoped_permission(uuid, text, uuid, uuid, uuid)
     phoenix_profile_has_warehouse_assignment(uuid, uuid)
     phoenix_profile_has_point_assignment(uuid, uuid)

   All three are STABLE SECURITY DEFINER, granted to `authenticated` and revoked
   from anon/PUBLIC by 062. They return a boolean and nothing else — they cannot
   leak a cross-organization identifier to us even if we asked wrongly.

   The trigger-only functions (phoenix_protect_last_super_admin,
   phoenix_validate_ppo_scope, phoenix_validate_profile_scope_assignment) are
   NEVER referenced here. A static scan proves that for the whole src tree.

   FAIL-CLOSED CONTRACT: every failure path returns { ok: false }. There is no
   branch in this file that turns an error into `allowed: true`. The caller is
   responsible for deciding what a failed check means; it is never a grant.
   ──────────────────────────────────────────────────────────────────────────── */

import { supabase, supabaseConfigured } from '../supabase/client';
import { SCOPED_RBAC_RPCS } from './scoped-permissions';

export type RbacRpcError =
  /** Migration 062 is not applied on this database. */
  | 'MISSING_FUNCTION'
  /** Supabase env vars absent — offline/local build. */
  | 'NOT_CONFIGURED'
  /** Transport threw (offline, DNS, abort). */
  | 'NETWORK_ERROR'
  /** Postgres/PostgREST returned an error we do not recognize. */
  | 'RPC_ERROR';

export type RbacRpcResult =
  | { ok: true; allowed: boolean }
  | { ok: false; error: RbacRpcError };

/** The transport surface the authorization engine depends on (injectable for tests). */
export interface RbacTransport {
  hasScopedPermission(args: {
    profileId: string;
    permissionKey: string;
    organizationId: string | null;
    warehouseId: string | null;
    distributionPointId: string | null;
  }): Promise<RbacRpcResult>;
  hasWarehouseAssignment(profileId: string, warehouseId: string): Promise<RbacRpcResult>;
  hasPointAssignment(profileId: string, distributionPointId: string): Promise<RbacRpcResult>;
}

/** PostgREST reports an unknown function as PGRST202 / 42883. */
function isMissingFunctionError(error: { code?: string; message?: string }): boolean {
  if (error.code === 'PGRST202' || error.code === '42883') return true;
  const m = (error.message ?? '').toLowerCase();
  return m.includes('could not find the function') || m.includes('does not exist');
}

function asBoolean(data: unknown): boolean {
  // The functions RETURN boolean; PostgREST hands it back as a bare JSON bool.
  // Anything else is a contract surprise and must not be read as a grant.
  return data === true;
}

async function callBooleanRpc(fn: string, params: Record<string, unknown>): Promise<RbacRpcResult> {
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED' };
  try {
    const { data, error } = await supabase.rpc(fn, params);
    if (error) {
      return { ok: false, error: isMissingFunctionError(error) ? 'MISSING_FUNCTION' : 'RPC_ERROR' };
    }
    return { ok: true, allowed: asBoolean(data) };
  } catch {
    return { ok: false, error: 'NETWORK_ERROR' };
  }
}

/**
 * The live transport. Parameter names match the SQL argument names exactly —
 * PostgREST resolves overloads by argument NAME, so `p_organization_id` etc. are
 * part of the contract, not a style choice.
 *
 * The three optional targets are always sent (as null when absent) rather than
 * omitted: the SQL defaults them to NULL, and sending them explicitly keeps the
 * five-argument overload unambiguous.
 */
export const supabaseRbacTransport: RbacTransport = {
  hasScopedPermission({ profileId, permissionKey, organizationId, warehouseId, distributionPointId }) {
    return callBooleanRpc(SCOPED_RBAC_RPCS.scopedPermission, {
      p_profile_id:            profileId,
      p_permission_key:        permissionKey,
      p_organization_id:       organizationId,
      p_warehouse_id:          warehouseId,
      p_distribution_point_id: distributionPointId,
    });
  },

  hasWarehouseAssignment(profileId, warehouseId) {
    return callBooleanRpc(SCOPED_RBAC_RPCS.warehouseAssignment, {
      p_profile_id:   profileId,
      p_warehouse_id: warehouseId,
    });
  },

  hasPointAssignment(profileId, distributionPointId) {
    return callBooleanRpc(SCOPED_RBAC_RPCS.pointAssignment, {
      p_profile_id:            profileId,
      p_distribution_point_id: distributionPointId,
    });
  },
};

/* ── Own scope assignments ────────────────────────────────────────────────────
   062's psa_select_scoped lets a profile read its OWN ACTIVE assignments (and
   nothing else — not its revocation history, not anyone else's row). That is
   exactly what currentScopes() surfaces, so this is a plain SELECT rather than a
   new RPC: adding a database function for a read RLS already scopes correctly
   would be inventing a contract 062 deliberately did not write. */

export interface ScopeAssignment {
  id: string;
  scopeType: 'warehouse' | 'distribution_point';
  organizationId: string;
  warehouseId: string | null;
  distributionPointId: string | null;
}

export type ScopeAssignmentsResult =
  | { ok: true; assignments: ScopeAssignment[] }
  | { ok: false; error: RbacRpcError };

export async function fetchMyScopeAssignments(profileId: string): Promise<ScopeAssignmentsResult> {
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED' };
  try {
    const { data, error } = await supabase
      .from('profile_scope_assignments')
      .select('id, scope_type, organization_id, warehouse_id, distribution_point_id')
      .eq('profile_id', profileId)
      .eq('is_active', true);

    if (error) {
      // A missing TABLE surfaces as 42P01 — treat it as "062 not applied here".
      const missing = error.code === '42P01' || isMissingFunctionError(error);
      return { ok: false, error: missing ? 'MISSING_FUNCTION' : 'RPC_ERROR' };
    }

    return {
      ok: true,
      assignments: (data ?? []).map(r => ({
        id:                  r.id as string,
        scopeType:           r.scope_type as ScopeAssignment['scopeType'],
        organizationId:      r.organization_id as string,
        warehouseId:         (r.warehouse_id ?? null) as string | null,
        distributionPointId: (r.distribution_point_id ?? null) as string | null,
      })),
    };
  } catch {
    return { ok: false, error: 'NETWORK_ERROR' };
  }
}
