import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

/**
 * INVENTORY-CENTER-INTAKE-A — exact, per-warehouse decisions for the two
 * scoped permission keys migration 065 actually checks:
 *
 *   warehouse_stock.adjust  — receipts and add/subtract movements
 *   warehouse_stock.correct — set_exact/correction movements
 *
 * These are SCOPED permissions (migration 062), not entries in the flat
 * PERMISSION_KEYS matrix, so they are resolved per warehouse rather than read
 * from `myPermissions`. This hook is a UI preflight ONLY — every RPC repeats
 * the same authorization server-side before touching the ledger, so a stale or
 * over-permissive answer here can never become a write grant.
 *
 * The check is one warehouse at a time, deliberately avoiding an N+1
 * permission scan across the whole warehouse catalog.
 */
export interface WarehouseStockPermissions {
  /** May post receipts and add/subtract movements in this warehouse. */
  canAdjust: boolean;
  /** May post set_exact/correction movements in this warehouse. */
  canCorrect: boolean;
}

const DENIED: WarehouseStockPermissions = { canAdjust: false, canCorrect: false };

export function useWarehouseStockPermissions(
  orgId: string | null,
  warehouseId: string | null,
): AsyncState<WarehouseStockPermissions> {
  const { profile } = useApp();

  return useAsync(async () => {
    if (!orgId || !warehouseId || !profile?.id) return DENIED;
    if (profile.role === 'super_admin') return { canAdjust: true, canCorrect: true };

    const ask = async (permissionKey: string) => {
      const result = await supabaseRbacTransport.hasScopedPermission({
        profileId: profile.id,
        permissionKey,
        organizationId: orgId,
        warehouseId,
        distributionPointId: null,
      });
      return result.ok && result.allowed;
    };

    const [canAdjust, canCorrect] = await Promise.all([
      ask('warehouse_stock.adjust'),
      ask('warehouse_stock.correct'),
    ]);
    return { canAdjust, canCorrect };
  }, [orgId, warehouseId, profile?.id, profile?.role]);
}
