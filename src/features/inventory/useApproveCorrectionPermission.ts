import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

/**
 * SECOND-PERSON-CORRECTION-APPROVAL (098 outlet, 101 warehouse) — the exact,
 * ORG-WIDE decision for approving/rejecting a pending correction request.
 *
 * Both phoenix_approve_(outlet|warehouse)_stock_correction check
 * phoenix_status_center_authorized(org, key), which resolves via
 * phoenix_profile_has_permission — a PLAIN, non-resource-scoped check (never
 * warehouse- or outlet-scoped, unlike every other permission in this
 * feature). This hook asks the identical question so the pending-corrections
 * panel is shown to exactly the actors the RPCs would let through — and
 * covers BOTH scopes with one shared org-wide answer, matching the schema
 * (central_warehouse_manager is the sole default holder of both keys).
 *
 * UI preflight ONLY: both RPCs repeat this authorization server-side before
 * any decision is recorded, and separately refuse a proposer approving their
 * own request by profile identity, not permission.
 */
export function useApproveCorrectionPermission(
  orgId: string | null,
  permissionKey: 'outlet_stock.approve_correction' | 'warehouse_stock.approve_correction',
): AsyncState<boolean> {
  const { profile } = useApp();

  return useAsync(async () => {
    if (!orgId || !profile?.id) return false;
    if (profile.role === 'super_admin') return true;

    const result = await supabaseRbacTransport.hasScopedPermission({
      profileId: profile.id,
      permissionKey,
      organizationId: orgId,
      warehouseId: null,
      distributionPointId: null,
    });
    return result.ok && result.allowed;
  }, [orgId, permissionKey, profile?.id, profile?.role]);
}
