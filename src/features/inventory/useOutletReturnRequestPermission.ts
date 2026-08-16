import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

/** Exact point-scoped preflight for the outlet return-request writer. */
export function useOutletReturnRequestPermission(
  orgId: string | null,
  distributionPointId: string | null,
): AsyncState<boolean> {
  const { profile } = useApp();

  return useAsync(async () => {
    if (!orgId || !distributionPointId || !profile?.id) return false;
    if (profile.role === 'super_admin') return true;
    const result = await supabaseRbacTransport.hasScopedPermission({
      profileId: profile.id,
      permissionKey: 'outlet_stock.return_request',
      organizationId: orgId,
      warehouseId: null,
      distributionPointId,
    });
    return result.ok && result.allowed;
  }, [orgId, distributionPointId, profile?.id, profile?.role]);
}
