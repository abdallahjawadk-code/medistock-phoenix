import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

export interface EmergencyReplenishmentPermissions {
  canReplenish: boolean;
  canReverse: boolean;
}

/**
 * STAGE-E-E7-2 — the per-outlet decision for the emergency-replenishment
 * corridor, using ONLY the permission keys Migration 164 already created:
 * `outlet_stock.replenish` (168) and `outlet_stock.replenish_reverse` (169).
 * E7-2 invents no permission and widens no role.
 *
 * The two are asked separately and returned separately, because they are
 * genuinely separate grants: an operator may be allowed to replenish a cart
 * without being allowed to reverse a completed replenishment, and collapsing
 * them would either hide a permitted action or offer a refused one.
 *
 * The permission is checked against the SOURCE pharmacy, which is the outlet
 * being debited and therefore the scope both RPCs re-check server-side.
 *
 * UI preflight ONLY: both RPCs repeat the authorization before any quantity
 * moves, so a stale or over-permissive answer here can never become a write.
 */
export function useEmergencyReplenishmentPermission(
  orgId: string | null,
  sourceDistributionPointId: string | null,
): AsyncState<EmergencyReplenishmentPermissions> {
  const { profile } = useApp();

  return useAsync(async () => {
    const denied: EmergencyReplenishmentPermissions = { canReplenish: false, canReverse: false };
    if (!orgId || !sourceDistributionPointId || !profile?.id) return denied;
    if (profile.role === 'super_admin') return { canReplenish: true, canReverse: true };

    const ask = (permissionKey: string) =>
      supabaseRbacTransport.hasScopedPermission({
        profileId: profile.id,
        permissionKey,
        organizationId: orgId,
        warehouseId: null,
        distributionPointId: sourceDistributionPointId,
      });

    const [replenish, reverse] = await Promise.all([
      ask('outlet_stock.replenish'),
      ask('outlet_stock.replenish_reverse'),
    ]);
    // Fail closed on a transport error: `ok:false` means the answer is unknown,
    // never "allowed" — same reading as useOutletDispensePermission.
    return {
      canReplenish: replenish.ok && replenish.allowed,
      canReverse: reverse.ok && reverse.allowed,
    };
  }, [orgId, sourceDistributionPointId, profile?.id, profile?.role]);
}
