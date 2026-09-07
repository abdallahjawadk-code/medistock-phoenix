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
import { SCOPED_PERMISSION_KEY_SET, scopedPermissionDef, type ScopeTarget } from '@/shared/authz/scoped-permissions';
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
    /**
     * IG-2 ROUND 3 — a SECOND warehouse assignment for the SAME persona, so
     * both warehouses are genuinely selectable in the real Inventory Center
     * picker. `QA_EXTRA_GRANTS` below grants `warehouse_transfer.return_request`
     * at `qa-wh-inst-a` ONLY — never at this one — which is what lets the
     * allowed→denied scope transition be driven through the REAL picker for
     * one persona, rather than only at the hook level.
     *
     * This is not a contradiction with 099/105: migration-062 "is assigned to
     * work at this warehouse" and migration-099/105's own
     * `warehouse_transfer.return_request` are two DIFFERENT questions —
     * exactly the read/action split R1.5-E's own read affordance already
     * establishes elsewhere in this screen. Being assigned to a warehouse
     * says where you work; it never implies quarantine-disposal authority
     * there.
     */
    {
      id: 'qa-psa-wh-a-empty',
      scopeType: 'warehouse',
      organizationId: ORG_A,
      warehouseId: 'qa-wh-inst-a-empty',
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
    /**
     * IG-2 ROUND 3 — reachability ONLY, discovered the same way as
     * institution_admin's row above: `InventoryCenterScreen` requires a
     * manageable WAREHOUSE before it renders any tab at all, even the
     * organization-scoped Suspension tab that needs no warehouse of its own.
     * Without this row an outlet-only assignment could never reach the screen
     * to prove its outlet-scoped suspension grant against. Existing
     * Screen-18 (Outlet Operations) behaviour, which reads
     * `manageableOutlets` alone, is unaffected — this only adds a warehouse
     * entry to THIS profile's topology rows.
     */
    {
      id: 'qa-psa-outlet-officer-wh-a',
      scopeType: 'warehouse',
      organizationId: ORG_A,
      warehouseId: 'qa-wh-inst-a',
      distributionPointId: null,
      facilityId: null,
    },
  ],
  /**
   * IG-2 ROUND 3 — reachability ONLY. `health_center_manager`'s own read
   * affordance (`useInventoryReadAffordance`, R1.5-E) is a ROLE predicate and
   * needs no assignment row at all; this row exists solely so the persona can
   * select a warehouse in the picker at all. It carries no
   * `warehouse_transfer.return_request` grant anywhere (see QA_EXTRA_GRANTS),
   * which is the exact "read-only, no admin steps" case §1 asks for.
   */
  'qa-health_center_manager_assigned': [
    {
      id: 'qa-psa-hcm-wh-a',
      scopeType: 'warehouse',
      organizationId: ORG_A,
      warehouseId: 'qa-wh-inst-a',
      distributionPointId: null,
      facilityId: null,
    },
  ],
  /**
   * IG-2 ROUND 3 — reachability ONLY, discovered by driving this persona
   * through the real screen: `InventoryCenterScreen` calls
   * `useInventoryScopes(activeOrgId)` with no `canManageOrganization` flag, so
   * `manageableWarehouses` is scope-filtered for EVERY non-super_admin persona
   * regardless of role — and the whole tab strip (suspension included, even
   * though that tab needs no warehouse of its own) renders nothing at all
   * until at least one warehouse is manageable. Without this row the org-wide
   * suspension persona could never reach ANY tab to prove its grant against.
   * The grant itself stays warehouse-independent — see QA_EXTRA_GRANTS below.
   */
  'qa-institution_admin': [
    {
      id: 'qa-psa-inst-admin-wh-a',
      scopeType: 'warehouse',
      organizationId: ORG_A,
      warehouseId: 'qa-wh-inst-a',
      distributionPointId: null,
      facilityId: null,
    },
  ],
  /**
   * IG-2 ROUND 3 -- `central_warehouse_manager` gets a warehouse row (screen
   * reachability, same reason as every row above) AND an outlet row at
   * `qa-outlet-2` -- distinct from `qa-outlet-1` above, so the two
   * outlet-scoped personas are never confused with one another. The outlet
   * row feeds `manageableOutlets`, which is what `canSuspendAnywhere` reads
   * for its "is the create surface reachable at all" answer -- see
   * QA_EXTRA_GRANTS below for why this profile is deliberately given NO
   * org-wide `.create` claim, so the reachability and the exact-scope
   * authorization stay visibly two different questions.
   */
  'qa-central_warehouse_manager': [
    {
      id: 'qa-psa-cwm-wh-a',
      scopeType: 'warehouse',
      organizationId: ORG_A,
      warehouseId: 'qa-wh-inst-a',
      distributionPointId: null,
      facilityId: null,
    },
    {
      id: 'qa-psa-cwm-pt-2',
      scopeType: 'distribution_point',
      organizationId: ORG_A,
      warehouseId: null,
      distributionPointId: 'qa-outlet-2',
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

/**
 * IG-2 ROUND 3 -- the keys `useQuarantinePermission` /
 * `useMaterialDispensingSuspensionPermission` ask (migrations 099/105/203),
 * simulated for the harness's DEV/TEST fixture transport ONLY.
 *
 * WHY THIS IS A SEPARATE CATALOG FROM scoped-permissions.ts, NOT AN ADDITION
 * TO IT. `SCOPED_PERMISSION_KEY_SET` transcribes migration 062 section B's TEN
 * keys verbatim -- it is reference data for a DIFFERENT layer (the shadow/pilot
 * `AuthorizationService` in authorization.ts) and nothing in the PRODUCT reads
 * it to decide these two hooks' keys: `supabaseRbacTransport.hasScopedPermission`
 * sends `warehouse_transfer.return_request` / `material_dispensing_suspension.*`
 * straight to `phoenix_profile_has_scoped_permission` with no client-side
 * allowlist gate of any kind (see rbac.service.ts -- `callBooleanRpc` performs
 * no key validation before calling the RPC). So their ABSENCE from
 * `scoped-permissions.ts` is a documentation gap in a catalog nothing consults
 * for them, not evidence the product needs a key added anywhere. Extending
 * `SCOPED_PERMISSION_KEY_SET` itself would be the wrong fix for a second
 * reason too: `createQaRbacTransport().hasScopedPermission` below GATES on
 * that exact set for the ORIGINAL ten keys, and folding these three keys into
 * it would make them answerable through the migration-062 GENERIC
 * organization-target fallback (062 rule 8) -- which is not these keys' rule
 * at all: quarantine's is warehouse-only, suspension's is
 * organization-OR-outlet.
 *
 * `targets` mirrors `ScopedPermissionKeyDef.targets`'s own meaning, read
 * straight from how the two hooks actually call `hasScopedPermission` (see
 * their own source): quarantine only ever sends a warehouse target with
 * `distributionPointId: null`; suspension sends EITHER organization-only
 * (both targets null) or an outlet target, never a warehouse.
 */
const QA_EXTRA_SCOPED_PERMISSION_KEYS: Readonly<Record<string, { targets: readonly ScopeTarget[] }>> = {
  'warehouse_transfer.return_request':      { targets: ['warehouse'] },
  'material_dispensing_suspension.view':    { targets: ['organization', 'distribution_point'] },
  'material_dispensing_suspension.create':  { targets: ['organization', 'distribution_point'] },
  'material_dispensing_suspension.lift':    { targets: ['organization', 'distribution_point'] },
};

/**
 * One EXPLICIT grant: this profile holds exactly this key, for exactly this
 * scope tuple. Deliberately an EXACT-MATCH table rather than an "existence of
 * any assignment" check like {@link QA_SCOPE_ASSIGNMENTS}'s `covers()`:
 * `material_dispensing_suspension.view` / `.create` / `.lift` are asked and
 * answered INDEPENDENTLY of one another for the identical scope (see
 * `useMaterialDispensingSuspensionPermission`'s own `Promise.all` of three
 * separate `hasScopedPermission` calls), so a single shared "has an
 * assignment here" boolean cannot express "view yes, create no" for the same
 * outlet. Exact-match also means a grant for one outlet never covers a
 * different one, and a grant for (org, null, null) never covers (org, null,
 * outlet) or vice versa -- nothing here can widen past the scope it names.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. It does not restate migrations
 * 099/105/203's exact default role-to-key matrix -- this repository's test
 * code has no visibility into that SQL, and guessing it wrong would be worse
 * than not guessing. Each row below exists to demonstrate ONE property the
 * review asked to see proven (a specific action-scope grant, an org-wide
 * claim, per-key independence) using the SAME assignment-gated mechanism the
 * original ten keys already use, not to reproduce a specific role's real
 * production entitlement set. Test descriptions say so explicitly wherever a
 * persona's grant is read as evidence.
 */
interface QaExtraGrant {
  permissionKey: string;
  organizationId: string;
  warehouseId: string | null;
  distributionPointId: string | null;
}

const QA_EXTRA_GRANTS: Readonly<Record<string, readonly QaExtraGrant[]>> = {
  /**
   * "Authorized for an action within a specific, defined scope": granted
   * `warehouse_transfer.return_request` at `qa-wh-inst-a` -- the warehouse
   * 105's own widened read policy names this role for -- and at NO other
   * warehouse, including `qa-wh-inst-a-empty`, which this same persona is
   * separately ASSIGNED to (migration 062) but not scoped-permission-granted
   * at. That split is what makes the allowed-to-denied transition observable
   * through the real picker without switching persona.
   */
  'qa-warehouse_officer_assigned': [
    {
      permissionKey: 'warehouse_transfer.return_request',
      organizationId: ORG_A, warehouseId: 'qa-wh-inst-a', distributionPointId: null,
    },
  ],
  /**
   * "Not assigned to the warehouse or outlet": deliberately NO row here.
   * `qa-warehouse_officer` (unassigned, no QA_SCOPE_ASSIGNMENTS row at all)
   * and `qa-outlet_officer` (likewise) are the negative controls -- asking
   * about ANY warehouse/outlet for either profile falls through to `ok(false)`
   * below with no grant ever matching.
   */
  /**
   * Per-key independence, case 1: VIEW and LIFT granted, CREATE withheld.
   *
   * `.view` and `.lift` are asked ORG-WIDE ONLY, at both the screen's tab
   * gate and the panel's own preflight -- neither is ever asked with an
   * outlet target anywhere in this codebase (only `.create` gets a SECOND,
   * outlet-specific re-ask, inside `SuspendForm`, once a scope is chosen). So
   * an "outlet-scoped view" grant would test a question the product never
   * asks; this scope tuple is the one that is actually read. Proves the
   * three keys are read independently rather than travelling as one bundle --
   * not a claim that this exact combination is 203's real default for this
   * role.
   */
  'qa-outlet_officer_assigned': [
    {
      permissionKey: 'material_dispensing_suspension.view',
      organizationId: ORG_A, warehouseId: null, distributionPointId: null,
    },
    {
      permissionKey: 'material_dispensing_suspension.lift',
      organizationId: ORG_A, warehouseId: null, distributionPointId: null,
    },
  ],
  /**
   * Per-key independence, case 2: an ORG-WIDE (NULL,NULL) claim -- the shape
   * `MaterialDispensingSuspensionPanel`'s own doc comment names as the
   * institution_admin case -- granting VIEW and CREATE but not LIFT. Combined
   * with case 1 above (view+lift, no create), between the two personas all
   * three keys have been independently true and independently false.
   */
  'qa-institution_admin': [
    {
      permissionKey: 'material_dispensing_suspension.view',
      organizationId: ORG_A, warehouseId: null, distributionPointId: null,
    },
    {
      permissionKey: 'material_dispensing_suspension.create',
      organizationId: ORG_A, warehouseId: null, distributionPointId: null,
    },
  ],
  /**
   * REACHABILITY vs. EXACT-SCOPE AUTHORIZATION, held genuinely apart.
   *
   * This profile holds NO org-wide `.create` claim, so `canSuspendOrgWide` (=
   * `GUIDE_CAPABILITIES.suspensionCreateOrgWide`) is false for it. It DOES
   * hold an outlet ASSIGNMENT at `qa-outlet-2` (see QA_SCOPE_ASSIGNMENTS
   * above), which is a migration-062 fact about where this profile works --
   * not a grant of anything -- yet it is what makes `manageableOutlets`
   * non-empty and therefore `canSuspendAnywhere` (=
   * `GUIDE_CAPABILITIES.suspensionCreate`) TRUE: the create button renders.
   *
   * The `.create` row below is the SEPARATE, genuine authorization for that
   * SAME exact outlet, so that actually choosing it in the composer succeeds
   * rather than merely opening the door and refusing behind it -- this
   * persona is "authorized for an action within a specific, defined scope"
   * in the sense §1 asks for, for the SUSPENSION domain (the QUARANTINE
   * domain's equivalent is `qa-warehouse_officer_assigned`, above).
   */
  'qa-central_warehouse_manager': [
    {
      permissionKey: 'material_dispensing_suspension.view',
      organizationId: ORG_A, warehouseId: null, distributionPointId: null,
    },
    {
      permissionKey: 'material_dispensing_suspension.create',
      organizationId: ORG_A, warehouseId: null, distributionPointId: 'qa-outlet-2',
    },
  ],
  /**
   * "Read-only, no admin steps": no row. `hasInventoryReadAffordance` grants
   * this persona the QUARANTINE tab through its role alone (R1.5-E); nothing
   * here ever grants it `warehouse_transfer.return_request` at any warehouse.
   */
  'qa-health_center_manager_assigned': [],
};

/**
 * Answer ONE of the keys above, or return `null` to mean "not one of ours --
 * fall through to whatever else this transport already does with `key`".
 *
 * Exact-match against {@link QA_EXTRA_GRANTS}: every field of the asked scope
 * must equal every field of a declared grant. There is no "assignment implies
 * grant" step here -- unlike the original ten keys' `covers()`, an outlet or
 * warehouse ASSIGNMENT (migration 062) is not itself evidence for any of
 * these three keys, which is the exact split `qa-warehouse_officer_assigned`
 * above exists to demonstrate.
 */
export function qaAnswerExtraScopedPermission(args: {
  profileId: string;
  permissionKey: string;
  organizationId: string | null;
  warehouseId: string | null;
  distributionPointId: string | null;
}): boolean | null {
  if (!(args.permissionKey in QA_EXTRA_SCOPED_PERMISSION_KEYS)) return null;
  const grants = QA_EXTRA_GRANTS[args.profileId] ?? [];
  return grants.some(g =>
    g.permissionKey === args.permissionKey
    && g.organizationId === args.organizationId
    && g.warehouseId === args.warehouseId
    && g.distributionPointId === args.distributionPointId);
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
