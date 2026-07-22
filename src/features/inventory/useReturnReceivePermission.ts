import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

/**
 * OUTLET-CORRIDOR-071 — the exact, per-warehouse decision for receiving OUTLET
 * RETURNS into an institution warehouse.
 *
 * `phoenix_receive_outlet_return_shipment_line` (migration 071) checks the
 * SCOPED permission `outlet_stock.return_receive` on the shipment's DESTINATION
 * warehouse (never on the caller). This hook asks the same question, scoped to
 * the same warehouse, so the Returns tab is shown to exactly the actors the RPC
 * would let through — and no one else, by role name or otherwise.
 *
 * UI preflight ONLY: the RPC repeats this authorization server-side before any
 * custody moves, so a stale or over-permissive answer here can never become a
 * receipt. Resolved one warehouse at a time to avoid an N+1 permission scan.
 */
export function useReturnReceivePermission(
  orgId: string | null,
  warehouseId: string | null,
): AsyncState<boolean> {
  const { profile } = useApp();

  return useAsync(async () => {
    if (!orgId || !warehouseId || !profile?.id) return false;
    if (profile.role === 'super_admin') return true;

    const result = await supabaseRbacTransport.hasScopedPermission({
      profileId: profile.id,
      permissionKey: 'outlet_stock.return_receive',
      organizationId: orgId,
      warehouseId,
      distributionPointId: null,
    });
    return result.ok && result.allowed;
  }, [orgId, warehouseId, profile?.id, profile?.role]);
}
