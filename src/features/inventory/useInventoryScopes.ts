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
}

export interface InventoryScopeCatalog {
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
  return { kind: 'warehouse', id: w.id, name: w.name, nameAr: w.name_ar, warehouseId: null };
}

function toOutletOption(p: DistributionPoint): InventoryScopeOption {
  return { kind: 'outlet', id: p.id, name: p.name, nameAr: p.name_ar, warehouseId: p.warehouseId };
}

export function useInventoryScopes(orgId: string | null): AsyncState<InventoryScopeCatalog> {
  const { authz, profile } = useApp();
  const assigned = useCurrentScopes(authz);

  const visible = useAsync(async () => {
    if (!orgId) return { warehouses: [], outlets: [] };
    const [whs, pts] = await Promise.all([getWarehouses(orgId), getPointsByOrg(orgId)]);
    return { warehouses: whs.map(toWhOption), outlets: pts.map(toOutletOption) };
  }, [orgId]);

  const data = useMemo<InventoryScopeCatalog | null>(() => {
    if (!visible.data) return null;

    const { warehouses, outlets } = visible.data;
    const readable = new Map<string, InventoryScopeOption>();
    for (const o of [...warehouses, ...outlets]) readable.set(`${o.kind}:${o.id}`, o);

    const superAdmin = profile?.role === 'super_admin';
    const relevantAssignments = assigned.scopes.filter(a => a.organizationId === orgId);
    const assignedWarehouses = new Set(
      relevantAssignments.map(a => a.warehouseId).filter((id): id is string => Boolean(id)),
    );
    const assignedPoints = new Set(
      relevantAssignments.map(a => a.distributionPointId).filter((id): id is string => Boolean(id)),
    );

    const manageableWarehouses = superAdmin
      ? warehouses
      : warehouses.filter(w => assignedWarehouses.has(w.id));
    const manageableOutlets = superAdmin
      ? outlets
      : outlets.filter(o => assignedPoints.has(o.id) || (o.warehouseId !== null && assignedWarehouses.has(o.warehouseId)));

    const manageable = new Set<string>();
    for (const o of [...manageableWarehouses, ...manageableOutlets]) manageable.add(`${o.kind}:${o.id}`);

    return {
      warehouses,
      outlets,
      manageableWarehouses,
      manageableOutlets,
      resolve: (kind, id) => (id ? readable.get(`${kind}:${id}`) ?? null : null),
      canManage: (kind, id) => Boolean(id && manageable.has(`${kind}:${id}`)),
    };
  }, [visible.data, assigned.scopes, orgId, profile?.role]);

  return {
    ...visible,
    data,
    // Fail closed while assignments are unresolved. super_admin needs no
    // assignment rows and may use the readable catalog immediately.
    loading: visible.loading || (profile?.role !== 'super_admin' && assigned.pending),
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
