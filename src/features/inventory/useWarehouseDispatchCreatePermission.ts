import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

/** Exact warehouse-scoped preflight for initial-provisioning dispatch creation. */
export function useWarehouseDispatchCreatePermission(
  orgId: string | null,
  warehouseId: string | null,
): AsyncState<boolean> {
  const { profile } = useApp();

  return useAsync(async () => {
    if (!orgId || !warehouseId || !profile?.id) return false;
    if (profile.role === 'super_admin') return true;
    const result = await supabaseRbacTransport.hasScopedPermission({
      profileId: profile.id,
      permissionKey: 'warehouse_dispatch.create',
      organizationId: orgId,
      warehouseId,
      distributionPointId: null,
    });
    return result.ok && result.allowed;
  }, [orgId, warehouseId, profile?.id, profile?.role]);
}
