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
import { ORG_A, QA_FIXTURES } from './qaData';

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

/**
 * IG-2 — the harness's answer for `phoenix_query_organization_scope_topology`.
 *
 * WHY THIS HAD TO EXIST. G4.2 moved scope resolution out of the browser and
 * into migration 191: `useInventoryScopes` no longer derives a profile's
 * effective warehouses from `getWarehouses` + assignment rows, it reads them
 * from that one RPC. The harness never registered it, so the RPC fell through
 * to the fixture client's read-only error, `manageableWarehouses` was empty for
 * EVERY persona, and the Inventory Center could never reach a warehouse-selected
 * state — which is why no Quarantine or Suspensions panel was reachable in the
 * QA gallery at all. This restores exactly the parity the harness had before
 * that migration, and nothing else.
 *
 * WHAT IT DOES NOT DO. It invents no authorization. `in_effective_scope` is
 * derived from {@link QA_SCOPE_ASSIGNMENTS} — the same rows
 * {@link createQaRbacTransport} answers from, and the same rows the real
 * `profile_scope_assignments` table would hold — so an unassigned persona still
 * gets an empty scope here, for the same reason the database would give it one.
 * A warehouse assignment reaches that warehouse's outlets, which is the
 * ancestry migration 182's helper applies; a point assignment reaches only that
 * point. `super_admin` is not special-cased here: `useInventoryScopes` decides
 * organization-level coverage itself, from permission, exactly as in production.
 */
export function qaScopeTopologyRows(
  profileId: string,
  organizationId: string,
): Array<Record<string, unknown>> {
  const rows = qaScopeAssignments(profileId).filter(r => r.organizationId === organizationId);
  const assignedWarehouses = new Set(rows.map(r => r.warehouseId).filter(Boolean) as string[]);
  const assignedPoints = new Set(rows.map(r => r.distributionPointId).filter(Boolean) as string[]);

  const warehouses = (QA_FIXTURES.warehouses as Array<Record<string, unknown>> | undefined) ?? [];
  const outlets = (QA_FIXTURES.distribution_points as Array<Record<string, unknown>> | undefined) ?? [];

  const warehouseNodes = warehouses
    .filter(w => w.organization_id === organizationId)
    .map(w => ({
      node_kind: 'warehouse',
      organization_id: organizationId,
      organization_kind: 'institution',
      institution_class: null,
      facility_id: null,
      facility_class: null,
      facility_status: null,
      facility_name: null,
      facility_name_ar: null,
      warehouse_id: w.id,
      warehouse_name: w.name,
      warehouse_name_ar: w.name_ar,
      warehouse_kind: w.warehouseKind,
      warehouse_status: w.status,
      warehouse_is_main: false,
      structural_role: 'institution_store',
      distribution_point_id: null,
      distribution_point_name: null,
      distribution_point_name_ar: null,
      distribution_point_type: null,
      distribution_point_status: null,
      in_effective_scope: assignedWarehouses.has(w.id as string),
    }));

  const outletNodes = outlets
    .filter(o => o.organization_id === organizationId)
    .map(o => ({
      node_kind: 'outlet',
      organization_id: organizationId,
      organization_kind: 'institution',
      institution_class: null,
      facility_id: null,
      facility_class: null,
      facility_status: null,
      facility_name: null,
      facility_name_ar: null,
      warehouse_id: o.warehouse_id,
      warehouse_name: null,
      warehouse_name_ar: null,
      warehouse_kind: null,
      warehouse_status: null,
      warehouse_is_main: null,
      structural_role: 'unclassified',
      distribution_point_id: o.id,
      distribution_point_name: o.name,
      distribution_point_name_ar: o.name_ar,
      distribution_point_type: o.point_type,
      distribution_point_status: o.status,
      in_effective_scope:
        assignedPoints.has(o.id as string)
        || assignedWarehouses.has(o.warehouse_id as string),
    }));

  return [...warehouseNodes, ...outletNodes];
}
