import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

/**
 * OUTLET-RETURN-EXCEPTION-RESOLUTION-157 — the exact, per-warehouse decision
 * for resolving a stuck exception_pending outlet-return shipment line.
 *
 * `phoenix_resolve_outlet_return_exception` (migration 157) checks the
 * SCOPED permission `outlet_stock.resolve_return_exception` on the shipment's
 * DESTINATION warehouse (never on the caller) — a distinct key from
 * `outlet_stock.return_receive`, same reasoning 098 used to split
 * `outlet_stock.approve_correction` out from `.count`/`.receive`. This hook
 * asks the same question, scoped to the same warehouse, so the Exceptions
 * tab is shown to exactly the actors the RPC would let through.
 *
 * UI preflight ONLY: the RPC repeats this authorization server-side before
 * any resolution is recorded, so a stale or over-permissive answer here can
 * never become a resolution. Resolved one warehouse at a time to avoid an
 * N+1 permission scan.
 */
export function useOutletReturnExceptionResolvePermission(
  orgId: string | null,
  warehouseId: string | null,
): AsyncState<boolean> {
  const { profile } = useApp();

  return useAsync(async () => {
    if (!orgId || !warehouseId || !profile?.id) return false;
    if (profile.role === 'super_admin') return true;

    const result = await supabaseRbacTransport.hasScopedPermission({
      profileId: profile.id,
      permissionKey: 'outlet_stock.resolve_return_exception',
      organizationId: orgId,
      warehouseId,
      distributionPointId: null,
    });
    return result.ok && result.allowed;
  }, [orgId, warehouseId, profile?.id, profile?.role]);
}
