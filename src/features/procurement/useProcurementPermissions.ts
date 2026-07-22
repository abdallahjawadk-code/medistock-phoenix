import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

/**
 * INSTITUTION-LOCAL-PROCUREMENT-087 — exact per-warehouse decisions for the
 * five scoped local_procurement.* keys.
 *
 * UI preflight ONLY: every RPC repeats the same authorization server-side
 * before touching anything, so a stale or over-permissive answer here can
 * never become a write grant. Fail-closed on any transport error.
 */
export interface ProcurementPermissions {
  canView: boolean;
  canManage: boolean;
  canApprove: boolean;
  canReceive: boolean;
  canReturn: boolean;
}

const DENIED: ProcurementPermissions = {
  canView: false, canManage: false, canApprove: false, canReceive: false, canReturn: false,
};

export function useProcurementPermissions(
  orgId: string | null,
  warehouseId: string | null,
): AsyncState<ProcurementPermissions> {
  const { profile } = useApp();

  return useAsync(async () => {
    if (!orgId || !warehouseId || !profile?.id) return DENIED;
    if (profile.role === 'super_admin') {
      return { canView: true, canManage: true, canApprove: true, canReceive: true, canReturn: true };
    }

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

    const [canView, canManage, canApprove, canReceive, canReturn] = await Promise.all([
      ask('local_procurement.view'),
      ask('local_procurement.manage'),
      ask('local_procurement.approve'),
      ask('local_procurement.receive'),
      ask('local_procurement.return'),
    ]);
    return { canView, canManage, canApprove, canReceive, canReturn };
  }, [orgId, warehouseId, profile?.id, profile?.role]);
}
