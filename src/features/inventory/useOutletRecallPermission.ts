import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

/**
 * Migration 185 preserves the historical owning-warehouse selector in the
 * actor's primary organization. Migration 187 deliberately switches only a
 * delegated cross-organization recall to the exact outlet selector, so a
 * warehouse grant without child inheritance cannot authorize an outlet recall.
 */
export function useOutletRecallPermission(
  orgId: string | null,
  warehouseId: string | null,
  distributionPointId: string | null,
): AsyncState<boolean> {
  const { profile } = useApp();

  return useAsync(async () => {
    if (!orgId || !profile?.id) return false;
    if (profile.role === 'super_admin') return true;
    const isDelegatedOrganization = profile.organization_id !== orgId;
    if (isDelegatedOrganization ? !distributionPointId : !warehouseId) return false;
    const result = await supabaseRbacTransport.hasScopedPermission({
      profileId: profile.id,
      permissionKey: 'outlet_stock.recall',
      organizationId: orgId,
      warehouseId: isDelegatedOrganization ? null : warehouseId,
      distributionPointId: isDelegatedOrganization ? distributionPointId : null,
    });
    return result.ok && result.allowed;
  }, [orgId, warehouseId, distributionPointId, profile?.id, profile?.organization_id, profile?.role]);
}
