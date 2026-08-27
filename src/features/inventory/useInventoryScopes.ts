import { useMemo } from 'react';
import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';
import type { InventoryScopeKind } from './inventory-intelligence.service';
import { getMyOperationalResourceCatalog } from '@/shared/supabase/services/delegated-access.service';
import {
  getOrganizationScopeTopology,
  type WarehouseStructuralRole,
} from '@/shared/supabase/services/scope-topology.service';

/**
 * One named warehouse/outlet in the active organization.
 *
 * `warehouses` / `outlets` are the readable catalog used to resolve names.
 * `manageable*` is intentionally narrower.
 *
 * G4.2 — WHERE THE NARROWING IS DECIDED CHANGED; THE ANSWER DID NOT.
 * It used to be recomputed here, in the browser: a health-centre manager's
 * effective warehouses were derived from `facilityId !== null` plus the
 * assignment rows, and an outlet's reachability from its parent warehouse.
 * That was a second implementation of Migration 182's helper, and it had to
 * APPROXIMATE the sector-main exclusion because `warehouses.is_main` never
 * reached the client. The database now answers it directly through
 * `phoenix_query_organization_scope_topology`, which delegates verbatim to the
 * canonical `phoenix_profile_has_warehouse_assignment` /
 * `phoenix_profile_has_point_assignment` helpers — so parity is structural
 * rather than merely tested, and there is no client rule left to drift.
 *
 * The threshold RPC remains the final permission check, so a stale scope can
 * never become a write grant.
 */
export interface InventoryScopeOption {
  kind: InventoryScopeKind;
  id: string;
  name: string;
  nameAr: string;
  /** Parent warehouse id for outlets. */
  warehouseId: string | null;
  /** 'central' | 'institution' for a warehouse-kind option; null for an outlet. */
  warehouseKind: 'central' | 'institution' | null;
  /**
   * R1.2: `distribution_points.point_type` for an outlet-kind option; null for
   * a warehouse. Surfaced because the ORDINARY warehouse-dispatch destination
   * list must exclude emergency outlets (Migration 180) — a crash cabinet or
   * rescue cart is supplied from a warehouse only through initial provisioning.
   * The database is the authority for that rule; this field exists so the UI
   * does not offer a destination the server will always refuse.
   */
  pointType: string | null;
  /**
   * `warehouses.facility_id` for a warehouse-kind option. For an outlet this is
   * its OWNING WAREHOUSE's facility — ancestry the database derived (G4.2),
   * not something reconstructed here. The semantic is IDENTICAL on both paths:
   * Migration 191 supplies it for the primary organization, Migration 187's
   * catalog for a delegated one.
   *
   * PRESENTATION ONLY. It is no longer load-bearing for scope: the sector-main
   * exclusion that used to be spelled `facilityId !== null` in this file now
   * lives where it always belonged, in Migration 182's helper, and arrives here
   * already applied as `inEffectiveScope`.
   */
  facilityId: string | null;
  /**
   * The DATABASE's structural role for this warehouse (G4.2 / Migration 191),
   * projecting Migration 181's COMPLETE six-conjunct rule. Never derived here,
   * and never inferred from `facilityId` alone. 'unclassified' for outlets and
   * for any row whose role the caller cannot establish.
   */
  structuralRole: WarehouseStructuralRole;
}

export interface InventoryScopeCatalog {
  /** Organization for which this exact catalog was fetched. */
  organizationId: string | null;
  warehouses: InventoryScopeOption[];
  outlets: InventoryScopeOption[];
  manageableWarehouses: InventoryScopeOption[];
  manageableOutlets: InventoryScopeOption[];
  /** Resolve a readable (kind, id) to its display option. */
  resolve: (kind: InventoryScopeKind, id: string | null) => InventoryScopeOption | null;
  /** True only when this exact scope is in the manageable catalog. */
  canManage: (kind: InventoryScopeKind, id: string | null) => boolean;
}

/** A scope option plus the server's WHERE answer, kept out of the public type. */
interface ScopedOption extends InventoryScopeOption {
  inEffectiveScope: boolean;
}

/**
 * PRESENTATION ORDERING ONLY.
 *
 * Both reads G4.2 replaced — `getWarehouses` and `getPointsByOrg` — ended in
 * `.order('name_ar')`, so the pickers were alphabetical by Arabic name. Migration
 * 191 deliberately has no ORDER BY: an ordering is not a topology fact, so the
 * database does not assert one. Restoring it HERE, at the presentation boundary,
 * is what keeps the pickers stable without letting order decide anything.
 *
 * It runs strictly AFTER the canonical structural role and effective scope have
 * been supplied, and it only permutes: it can never add, drop, re-parent or
 * re-scope a row, so visibility, ancestry, sector-main and permission are all
 * untouched by it.
 *
 * `nameAr` mirrors exactly what the replaced reads sorted on — the Arabic name
 * regardless of UI language — so both membership AND order match pre-G4.2
 * behaviour. The id tiebreak makes equal names deterministic, which a bare
 * `.order('name_ar')` never was.
 */
export const byArabicName = (
  a: { nameAr: string; id: string },
  b: { nameAr: string; id: string },
): number => a.nameAr.localeCompare(b.nameAr) || a.id.localeCompare(b.id);

export function useInventoryScopes(
  orgId: string | null,
  /** Exact organization-level inventory.manage_thresholds decision. */
  canManageOrganization = false,
): AsyncState<InventoryScopeCatalog> {
  const { profile } = useApp();
  const delegatedOrganization = Boolean(orgId && profile?.organization_id && orgId !== profile.organization_id);

  const visible = useAsync(async () => {
    if (!orgId) return { organizationId: null, warehouses: [] as ScopedOption[], outlets: [] as ScopedOption[] };

    if (delegatedOrganization) {
      // UNCHANGED BY G4.2. Cross-organization delegated topology has been
      // DB-owned since Migration 187 and is deliberately not duplicated by
      // 191: there was never a client-side delegated reconstruction to remove.
      // Every row this catalog returns is already inside the caller's
      // delegated scope, which is why `inEffectiveScope` is true for all of
      // them — that is 187's answer being carried, not a new decision.
      const rows = (await getMyOperationalResourceCatalog()).filter(row => row.organizationId === orgId);
      const warehouses: ScopedOption[] = [...new Map(rows.filter(row => row.warehouseId && !row.distributionPointId).map(row => [row.warehouseId!, {
        kind: 'warehouse' as const, id: row.warehouseId!, name: row.warehouseName ?? '',
        nameAr: row.warehouseNameAr ?? '', warehouseId: null,
        warehouseKind: row.warehouseKind, pointType: null, facilityId: row.warehouseFacilityId,
        // 187's catalog carries no `is_main`, so no POSITIVE structural claim
        // can be made about a delegated warehouse. Under-claiming is the
        // deliberate choice — see scope-topology.service.ts.
        structuralRole: 'unclassified' as WarehouseStructuralRole,
        inEffectiveScope: true,
      }])).values()];
      const outlets: ScopedOption[] = [...new Map(rows.filter(row => row.distributionPointId).map(row => [row.distributionPointId!, {
        kind: 'outlet' as const, id: row.distributionPointId!, name: row.distributionPointName ?? '',
        nameAr: row.distributionPointNameAr ?? '', warehouseId: row.warehouseId,
        warehouseKind: null, pointType: row.distributionPointType,
        // CONTRACT PARITY with the primary path. Migration 187's catalog already
        // LEFT JOINs the owning warehouse for every outlet branch and returns its
        // `facility_id` as `warehouse_facility_id` — its own comment calls that
        // join "the ancestry for the UI only". So this is the DATABASE's outlet
        // ancestry being carried, exactly as `facilityId` means on the primary
        // path; it is not a second client-side reconstruction, and it is never
        // inferred from a name. Leaving it null here made one field mean two
        // different things depending on which branch produced the row.
        facilityId: row.warehouseFacilityId,
        structuralRole: 'unclassified' as WarehouseStructuralRole,
        inEffectiveScope: true,
      }])).values()];
      return {
        organizationId: orgId,
        warehouses: warehouses.sort(byArabicName),
        outlets: outlets.sort(byArabicName),
      };
    }

    // PRIMARY ORGANIZATION — one canonical read. The RPC is SECURITY INVOKER,
    // so it returns exactly the rows this caller's own RLS already allowed
    // through `getWarehouses` / `getPointsByOrg`: identical visibility, plus
    // the structural role and the scope answer the client used to compute.
    const nodes = await getOrganizationScopeTopology(orgId);
    const warehouses: ScopedOption[] = nodes
      .filter(n => n.nodeKind === 'warehouse' && n.warehouseId !== null && n.warehouseStatus !== 'archived')
      .map(n => ({
        kind: 'warehouse' as const, id: n.warehouseId!,
        name: n.warehouseName ?? '', nameAr: n.warehouseNameAr ?? '',
        warehouseId: null, warehouseKind: n.warehouseKind, pointType: null,
        facilityId: n.facilityId, structuralRole: n.structuralRole,
        inEffectiveScope: n.inEffectiveScope,
      }));
    const outlets: ScopedOption[] = nodes
      .filter(n => n.nodeKind === 'outlet' && n.distributionPointId !== null && n.distributionPointStatus !== 'archived')
      .map(n => ({
        kind: 'outlet' as const, id: n.distributionPointId!,
        name: n.distributionPointName ?? '', nameAr: n.distributionPointNameAr ?? '',
        warehouseId: n.warehouseId, warehouseKind: null,
        pointType: n.distributionPointType, facilityId: n.facilityId,
        // A structural role is a claim about a WAREHOUSE. An outlet never
        // carries one, so it is never a route by which a role could be
        // over-claimed.
        structuralRole: 'unclassified' as WarehouseStructuralRole,
        inEffectiveScope: n.inEffectiveScope,
      }));
    return {
      organizationId: orgId,
      warehouses: warehouses.sort(byArabicName),
      outlets: outlets.sort(byArabicName),
    };
  }, [orgId, delegatedOrganization]);

  const data = useMemo<InventoryScopeCatalog | null>(() => {
    // useAsync may retain the previous result for one render while a new
    // organization loads. Reject that result before deriving any option so a
    // fast organization switch can never reuse the former org's scope UUID.
    if (!visible.data || visible.data.organizationId !== orgId) return null;

    const { warehouses, outlets } = visible.data;
    const readable = new Map<string, InventoryScopeOption>();
    for (const o of [...warehouses, ...outlets]) readable.set(`${o.kind}:${o.id}`, o);

    const superAdmin = profile?.role === 'super_admin';
    // PERMISSION, not scope. An exact organization-level grant intentionally
    // covers every scope in that organization even when the profile holds no
    // individual assignment row (for example an institution administrator).
    // G4.2 keeps this question exactly where it was — migration 062 — because
    // it answers WHAT, while the topology query deliberately answers only
    // WHERE. The selected scope is still re-checked by 062 before any write.
    const managesWholeOrganization = superAdmin || canManageOrganization || delegatedOrganization;

    // SCOPE. Server-decided. No facility derivation, no parent-outlet walk and
    // no sector-main test remains in this file.
    const manageableWarehouses = managesWholeOrganization
      ? warehouses
      : warehouses.filter(w => w.inEffectiveScope);
    const manageableOutlets = managesWholeOrganization
      ? outlets
      : outlets.filter(o => o.inEffectiveScope);

    const manageable = new Set<string>();
    for (const o of [...manageableWarehouses, ...manageableOutlets]) manageable.add(`${o.kind}:${o.id}`);

    return {
      organizationId: orgId,
      warehouses,
      outlets,
      manageableWarehouses,
      manageableOutlets,
      resolve: (kind, id) => (id ? readable.get(`${kind}:${id}`) ?? null : null),
      canManage: (kind, id) => Boolean(id && manageable.has(`${kind}:${id}`)),
    };
  }, [visible.data, orgId, profile?.role, canManageOrganization, delegatedOrganization]);

  return {
    ...visible,
    data,
    // Fail closed while the catalog is unresolved. The separate RBAC
    // assignment fetch is no longer part of this gate: scope now arrives with
    // the catalog itself, in the same round trip, so there is no second
    // pending source that could let a not-yet-loaded scope render as a real
    // (empty) answer.
    //
    // UAT-DEFECT-005 — FAIL CLOSED IS NOT THE SAME AS NEVER SETTLING.
    // `data === null` is true for TWO different reasons: the catalog has not
    // arrived yet, and the catalog read FAILED. Treating both as "still
    // loading" made this hook non-terminating on failure — useAsync had
    // already set loading=false and error=<message>, but this line put
    // loading back to true forever. Every consumer renders its error branch
    // as `!loading && error`, so the two states were mutually exclusive and
    // the failure surfaced as an eternal spinner instead of an actionable
    // error. Excluding the errored case makes the machine converge:
    // loading -> success, or loading -> error, always. It does NOT open the
    // gate — on error `data` is still null, so every `manageable*` list stays
    // empty and no scope becomes selectable.
    loading: visible.loading || (Boolean(orgId) && data === null && visible.error === null),
  };
}

/**
 * Ask migration 062 for the exact manage-thresholds decision independently of
 * the frontend RBAC rollout mode. This is a UI preflight only; the threshold
 * RPC repeats the same server-side authorization before writing.
 *
 * The check is intentionally one selected scope at a time (or one org-default
 * check), avoiding an N+1 permission scan over every warehouse/outlet.
 */
export function useExactThresholdPermission(
  orgId: string | null,
  kind: InventoryScopeKind | null,
  scopeId: string | null,
  enabled: boolean,
): AsyncState<boolean> {
  const { profile } = useApp();

  return useAsync(async () => {
    if (!enabled || !orgId || !profile?.id) return false;
    if (profile.role === 'super_admin') return true;

    const result = await supabaseRbacTransport.hasScopedPermission({
      profileId: profile.id,
      permissionKey: 'inventory.manage_thresholds',
      organizationId: orgId,
      warehouseId: kind === 'warehouse' ? scopeId : null,
      distributionPointId: kind === 'outlet' ? scopeId : null,
    });
    return result.ok && result.allowed;
  }, [enabled, orgId, kind, scopeId, profile?.id, profile?.role]);
}
