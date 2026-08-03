import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

/**
 * The exact, per-outlet decision for RECEIVING Route-2 warehouse-dispatch
 * lines at an outlet.
 *
 * phoenix_receive_outlet_dispatch_line (070) checks the SCOPED permission
 * `outlet_stock.receive` on the dispatch's DESTINATION distribution point
 * (never on the caller). This hook asks the same question, scoped to the
 * same outlet, so the Receive affordance is shown to exactly the actors the
 * RPC would let through.
 *
 * UI preflight ONLY: the RPC repeats this authorization server-side before
 * any quantity moves, so a stale or over-permissive answer here can never
 * become a write.
 */
export function useOutletReceivePermission(
  orgId: string | null,
  distributionPointId: string | null,
): AsyncState<boolean> {
  const { profile } = useApp();

  return useAsync(async () => {
    if (!orgId || !distributionPointId || !profile?.id) return false;
    if (profile.role === 'super_admin') return true;

    const result = await supabaseRbacTransport.hasScopedPermission({
      profileId: profile.id,
      permissionKey: 'outlet_stock.receive',
      organizationId: orgId,
      warehouseId: null,
      distributionPointId,
    });
    return result.ok && result.allowed;
  }, [orgId, distributionPointId, profile?.id, profile?.role]);
}
