import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

/** Exact owning-warehouse preflight for Migration 185's outlet recall selector. */
export function useOutletRecallPermission(
  orgId: string | null,
  warehouseId: string | null,
): AsyncState<boolean> {
  const { profile } = useApp();

  return useAsync(async () => {
    if (!orgId || !warehouseId || !profile?.id) return false;
    if (profile.role === 'super_admin') return true;
    const result = await supabaseRbacTransport.hasScopedPermission({
      profileId: profile.id,
      permissionKey: 'outlet_stock.recall',
      organizationId: orgId,
      warehouseId,
      distributionPointId: null,
    });
    return result.ok && result.allowed;
  }, [orgId, warehouseId, profile?.id, profile?.role]);
}
