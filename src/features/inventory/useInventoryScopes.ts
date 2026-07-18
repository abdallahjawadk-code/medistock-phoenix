import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import {
  getWarehouses,
  getPointsByOrg,
  type Warehouse,
  type DistributionPoint,
} from '@/shared/supabase/services/warehouses.service';
import type { InventoryScopeKind } from './inventory-intelligence.service';

/**
 * The warehouses + outlets the caller may see for one organization. Both reads
 * are RLS-protected (warehouses / distribution_points), so this returns ONLY
 * the scopes the backend already permits — the UI never invents a scope, and
 * the upsert RPC remains the final authority on whether a threshold write is
 * allowed for the chosen scope.
 */
export interface InventoryScopeOption {
  kind: InventoryScopeKind;
  id: string;
  name: string;
  nameAr: string;
  /** Parent warehouse id for outlets (null for warehouse-typed outlets). */
  warehouseId: string | null;
}

export interface InventoryScopeCatalog {
  warehouses: InventoryScopeOption[];
  outlets: InventoryScopeOption[];
  /** Resolve a (kind, id) to its display option, or null when unknown/absent. */
  resolve: (kind: InventoryScopeKind, id: string | null) => InventoryScopeOption | null;
}

function toWhOption(w: Warehouse): InventoryScopeOption {
  return { kind: 'warehouse', id: w.id, name: w.name, nameAr: w.name_ar, warehouseId: null };
}
function toOutletOption(p: DistributionPoint): InventoryScopeOption {
  return { kind: 'outlet', id: p.id, name: p.name, nameAr: p.name_ar, warehouseId: p.warehouseId };
}

export function useInventoryScopes(orgId: string | null): AsyncState<InventoryScopeCatalog> {
  return useAsync<InventoryScopeCatalog>(async () => {
    if (!orgId) return { warehouses: [], outlets: [], resolve: () => null };
    const [whs, pts] = await Promise.all([getWarehouses(orgId), getPointsByOrg(orgId)]);
    const warehouses = whs.map(toWhOption);
    const outlets = pts.map(toOutletOption);
    const index = new Map<string, InventoryScopeOption>();
    for (const o of [...warehouses, ...outlets]) index.set(`${o.kind}:${o.id}`, o);
    return {
      warehouses,
      outlets,
      resolve: (kind, id) => (id ? index.get(`${kind}:${id}`) ?? null : null),
    };
  }, [orgId]);
}
