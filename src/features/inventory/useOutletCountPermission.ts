import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

/**
 * CANONICAL-STOCK-CUTOVER — the exact, per-outlet decision for CORRECTING outlet
 * stock (a physical count).
 *
 * phoenix_count_outlet_stock (067) and its guarded wrapper
 * phoenix_count_outlet_stock_guarded (086) check the SCOPED permission
 * `outlet_stock.count` on the LOCKED row's distribution point (never on the
 * caller). This hook asks the same question, scoped to the same outlet, so the
 * Correct action is shown to exactly the actors the RPC would let through.
 *
 * UI preflight ONLY: the RPC repeats this authorization server-side before any
 * quantity moves, so a stale or over-permissive answer here can never become a
 * write. Resolved one outlet at a time to avoid an N+1 permission scan.
 */
export function useOutletCountPermission(
  orgId: string | null,
  distributionPointId: string | null,
): AsyncState<boolean> {
  const { profile } = useApp();

  return useAsync(async () => {
    if (!orgId || !distributionPointId || !profile?.id) return false;
    if (profile.role === 'super_admin') return true;

    const result = await supabaseRbacTransport.hasScopedPermission({
      profileId: profile.id,
      permissionKey: 'outlet_stock.count',
      organizationId: orgId,
      warehouseId: null,
      distributionPointId,
    });
    return result.ok && result.allowed;
  }, [orgId, distributionPointId, profile?.id, profile?.role]);
}
