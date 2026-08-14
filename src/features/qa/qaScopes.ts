/**
 * VISUAL-QA-HARNESS-A — DEV/TEST-ONLY migration-062 scope-assignment fixtures.
 *
 * Screen 18 (Outlet Operations) scopes its outlets through
 * `useInventoryScopes.manageableOutlets`, which for every non-organization-level
 * profile is driven ONLY by ACTIVE migration-062 `profile_scope_assignments`
 * rows — never by a role name. Without assignment rows the harness could render
 * Screen 18 for `super_admin` alone, so scoped-persona parity was unprovable.
 *
 * These fixtures supply those rows, and nothing else. They are injected through
 * the authorization service's ALREADY-EXISTING seams — `loadScopes` and
 * `transport` on {@link AuthorizationServiceOptions} — so the real resolution
 * logic in `authorization.ts` / `useInventoryScopes.ts` runs unmodified. No
 * authorization, RBAC, RLS, RPC, migration or authentication code is touched,
 * and no decision here is made by inspecting a role:
 *
 *   · `qaLoadScopes` returns the persona's assignment rows, exactly as
 *     `fetchMyScopeAssignments` would return them from the real table.
 *   · {@link createQaRbacTransport} answers the three transport questions from
 *     THOSE SAME rows, so a scope that carries no assignment is denied here for
 *     the same reason the database would deny it.
 *
 * Rows mirror the real `profile_scope_assignments` shape (migration 062): one
 * row per (profile, scope), `scope_type` ∈ {warehouse, distribution_point},
 * with exactly one of warehouse_id / distribution_point_id populated. Only
 * `is_active` rows are represented — the real query filters on it.
 *
 * DEV-ONLY: this module is imported solely by the harness, which
 * `visualQaEnabled` folds to `false` in any production build.
 * `tests/qa-harness-production-safety.test.ts` proves these symbols and ids are
 * absent from `dist/`.
 */
import type { RbacTransport, RbacRpcResult, ScopeAssignment } from '@/shared/authz/rbac.service';
import { SCOPED_PERMISSION_KEY_SET, scopedPermissionDef } from '@/shared/authz/scoped-permissions';
import { ORG_A } from './qaData';

/**
 * ACTIVE assignment rows per profile id (`qa-<persona id>`).
 *
 * Deliberately asymmetric, so the evidence matrix can show scope actually
 * constraining the screen rather than a role unlocking it:
 *
 *   · warehouse_officer_assigned → ONE warehouse (`qa-wh-inst-a`). Screen 18
 *     derives its outlets from the parent warehouse, so this persona reaches
 *     `qa-outlet-1` and `qa-outlet-2` — and never ORG_B's `qa-outlet-3`.
 *   · outlet_officer_assigned → ONE distribution point (`qa-outlet-1`), so this
 *     persona reaches that outlet ALONE, not its sibling `qa-outlet-2`.
 *   · warehouse_officer / outlet_officer carry NO rows at all — the
 *     denied/empty-scope control for the very same roles.
 */
export const QA_SCOPE_ASSIGNMENTS: Readonly<Record<string, readonly ScopeAssignment[]>> = {
  'qa-warehouse_officer_assigned': [
    {
      id: 'qa-psa-wh-a',
      scopeType: 'warehouse',
      organizationId: ORG_A,
      warehouseId: 'qa-wh-inst-a',
      distributionPointId: null,
      facilityId: null,
    },
  ],
  'qa-outlet_officer_assigned': [
    {
      id: 'qa-psa-pt-1',
      scopeType: 'distribution_point',
      organizationId: ORG_A,
      warehouseId: null,
      distributionPointId: 'qa-outlet-1',
      facilityId: null,
    },
  ],
};

/** The rows the real `fetchMyScopeAssignments` would return for this profile. */
export function qaScopeAssignments(profileId: string): ScopeAssignment[] {
  return [...(QA_SCOPE_ASSIGNMENTS[profileId] ?? [])];
}

/** `loadScopes` seam — same signature and semantics as the real loader. */
export async function qaLoadScopes(profileId: string): Promise<ScopeAssignment[]> {
  return qaScopeAssignments(profileId);
}

const ok = (allowed: boolean): RbacRpcResult => ({ ok: true, allowed });

/**
 * A fixture {@link RbacTransport} answering from {@link QA_SCOPE_ASSIGNMENTS}.
 *
 * Every answer is derived from assignment rows — never from `role`. An
 * unassigned profile is denied by the same code path that denies it in
 * production, which is what makes the captured "forbidden action is
 * hidden/disabled" evidence meaningful rather than staged.
 */
export function createQaRbacTransport(): RbacTransport {
  const covers = (
    rows: readonly ScopeAssignment[],
    warehouseId: string | null,
    distributionPointId: string | null,
  ): boolean =>
    rows.some(r =>
      (warehouseId !== null && r.warehouseId === warehouseId) ||
      (distributionPointId !== null && r.distributionPointId === distributionPointId));

  return {
    async hasWarehouseAssignment(profileId, warehouseId) {
      return ok(covers(qaScopeAssignments(profileId), warehouseId, null));
    },

    async hasPointAssignment(profileId, distributionPointId) {
      return ok(covers(qaScopeAssignments(profileId), null, distributionPointId));
    },

    async hasScopedPermission({ profileId, permissionKey, organizationId, warehouseId, distributionPointId }) {
      // An unknown key is not a grant.
      if (!SCOPED_PERMISSION_KEY_SET.has(permissionKey)) return ok(false);

      const rows = qaScopeAssignments(profileId).filter(r => r.organizationId === organizationId);
      if (rows.length === 0) return ok(false);

      const def = scopedPermissionDef(permissionKey);
      // 062 rule 8: a key that targets a warehouse / point, asked with a NULL
      // target, fails closed for an assignment-scoped profile.
      if (warehouseId === null && distributionPointId === null) {
        return ok(def?.targets.includes('organization') === true);
      }

      return ok(covers(rows, warehouseId, distributionPointId));
    },
  };
}
