import { useMemo } from 'react';
import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { useCurrentScopes } from '@/shared/authz/useAuthorization';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';
import {
  getWarehouses,
  getPointsByOrg,
  type Warehouse,
  type DistributionPoint,
} from '@/shared/supabase/services/warehouses.service';
import type { InventoryScopeKind } from './inventory-intelligence.service';
import { getMyOperationalResourceCatalog } from '@/shared/supabase/services/delegated-access.service';

/**
 * One named warehouse/outlet in the active organization.
 *
 * `warehouses` / `outlets` are the RLS-readable catalog used to resolve names.
 * `manageable*` is intentionally narrower: super_admin sees the whole catalog;
 * everyone else sees only ACTIVE scope assignments returned by migration 062.
 * The threshold RPC remains the final permission check, so a stale assignment
 * can never become a write grant.
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
   * R1.1-U: `warehouses.facility_id` for a warehouse-kind option; null for an
   * outlet. Load-bearing for facility scope — the SECTOR MAIN is the health
   * sector's only active warehouse with facility_id IS NULL (Migration 181), so
   * requiring a NON-NULL facility here is exactly what stops a facility-scoped
   * manager inheriting it, mirroring
   * phoenix_profile_has_warehouse_assignment server-side.
   */
  facilityId: string | null;
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

function toWhOption(w: Warehouse): InventoryScopeOption {
  return { kind: 'warehouse', id: w.id, name: w.name, nameAr: w.name_ar, warehouseId: null, warehouseKind: w.warehouseKind, pointType: null, facilityId: w.facilityId };
}

function toOutletOption(p: DistributionPoint): InventoryScopeOption {
  return { kind: 'outlet', id: p.id, name: p.name, nameAr: p.name_ar, warehouseId: p.warehouseId, warehouseKind: null, pointType: p.pointType, facilityId: null };
}

export function useInventoryScopes(
  orgId: string | null,
  /** Exact organization-level inventory.manage_thresholds decision. */
  canManageOrganization = false,
): AsyncState<InventoryScopeCatalog> {
  const { authz, profile } = useApp();
  const assigned = useCurrentScopes(authz);
  const delegatedOrganization = Boolean(orgId && profile?.organization_id && orgId !== profile.organization_id);

  const visible = useAsync(async () => {
    if (!orgId) return { organizationId: null, warehouses: [], outlets: [] };
    if (delegatedOrganization) {
      const rows = (await getMyOperationalResourceCatalog()).filter(row => row.organizationId === orgId);
      const warehouses = [...new Map(rows.filter(row => row.warehouseId && !row.distributionPointId).map(row => [row.warehouseId!, {
        kind: 'warehouse' as const, id: row.warehouseId!, name: row.warehouseName ?? '',
        nameAr: row.warehouseNameAr ?? '', warehouseId: null,
        warehouseKind: row.warehouseKind, pointType: null, facilityId: row.warehouseFacilityId,
      }])).values()];
      const outlets = [...new Map(rows.filter(row => row.distributionPointId).map(row => [row.distributionPointId!, {
        kind: 'outlet' as const, id: row.distributionPointId!, name: row.distributionPointName ?? '',
        nameAr: row.distributionPointNameAr ?? '', warehouseId: row.warehouseId,
        warehouseKind: null, pointType: row.distributionPointType, facilityId: null,
      }])).values()];
      return { organizationId: orgId, warehouses, outlets };
    }
    const [whs, pts] = await Promise.all([getWarehouses(orgId), getPointsByOrg(orgId)]);
    return { organizationId: orgId, warehouses: whs.map(toWhOption), outlets: pts.map(toOutletOption) };
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
    // An exact organization-level grant intentionally covers every scope in
    // that organization even when the profile has no individual assignment
    // rows (for example an institution administrator). The selected scope is
    // still re-checked by migration 062 immediately before the write.
    const managesWholeOrganization = superAdmin || canManageOrganization || delegatedOrganization;
    const relevantAssignments = assigned.scopes.filter(a => a.organizationId === orgId);
    const assignedWarehouses = new Set(
      relevantAssignments.map(a => a.warehouseId).filter((id): id is string => Boolean(id)),
    );
    const assignedPoints = new Set(
      relevantAssignments.map(a => a.distributionPointId).filter((id): id is string => Boolean(id)),
    );
    /**
     * R1.1-U — FACILITY SCOPE.
     *
     * A health-centre manager holds no warehouse or outlet row at all; it holds
     * facilities, and its resources are DERIVED from them. Without this the two
     * sets above are empty and the manager gets a working login with nothing it
     * can operate — valid database scope, unusable UI.
     *
     * The derivation deliberately mirrors Migration 182's helpers rather than
     * inventing a second rule:
     *   warehouse → manageable when it is facility-bound AND its facility is
     *               assigned. `facilityId !== null` is the SECTOR-MAIN
     *               EXCLUSION: the sector main is the only active health-sector
     *               warehouse with facility_id IS NULL (181), so it can never
     *               match, exactly as the server refuses it.
     *   outlet    → manageable when its OWNING warehouse is, so a centre's
     *               pharmacy and crash cabinets follow their depot.
     *
     * Facility identity is preserved: a manager holding A and B derives A's and
     * B's resources and nothing else. Two facilities never widen to the sector.
     */
    const assignedFacilities = new Set(
      relevantAssignments
        .filter(a => a.scopeType === 'facility')
        .map(a => a.facilityId)
        .filter((id): id is string => Boolean(id)),
    );
    const facilityDerivedWarehouses = new Set(
      warehouses
        .filter(w => w.facilityId !== null && assignedFacilities.has(w.facilityId))
        .map(w => w.id),
    );

    const reachableWarehouse = (id: string) =>
      assignedWarehouses.has(id) || facilityDerivedWarehouses.has(id);

    const manageableWarehouses = managesWholeOrganization
      ? warehouses
      : warehouses.filter(w => reachableWarehouse(w.id));
    const manageableOutlets = managesWholeOrganization
      ? outlets
      : outlets.filter(o => assignedPoints.has(o.id) || (o.warehouseId !== null && reachableWarehouse(o.warehouseId)));

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
  }, [visible.data, assigned.scopes, orgId, profile?.role, canManageOrganization, delegatedOrganization]);

  return {
    ...visible,
    data,
    // Fail closed while assignments are unresolved. super_admin needs no
    // assignment rows and may use the readable catalog immediately.
    loading: visible.loading
      || (Boolean(orgId) && data === null)
      || (!delegatedOrganization && !canManageOrganization && profile?.role !== 'super_admin' && assigned.pending),
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
