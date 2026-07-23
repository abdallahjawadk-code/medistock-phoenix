import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

/**
 * FEFO-REASONED-OVERRIDE (097/102) — the exact, per-warehouse decision for
 * whether this profile may override a non-earliest-expiry batch pick.
 *
 * `phoenix_add_dispatch_line_fefo_guarded` / `phoenix_send_warehouse_transfer_
 * line_fefo_guarded` both check the SCOPED permission `inventory.
 * fefo_override` on the source warehouse. This hook asks the identical
 * question so the override affordance is offered to exactly the actors the
 * RPC would let through — never merely because a role NAME looks right.
 *
 * UI preflight ONLY: both RPCs repeat this authorization server-side before
 * any custody moves.
 */
export function useFefoOverridePermission(
  orgId: string | null,
  warehouseId: string | null,
): AsyncState<boolean> {
  const { profile } = useApp();

  return useAsync(async () => {
    if (!orgId || !warehouseId || !profile?.id) return false;
    if (profile.role === 'super_admin') return true;

    const result = await supabaseRbacTransport.hasScopedPermission({
      profileId: profile.id,
      permissionKey: 'inventory.fefo_override',
      organizationId: orgId,
      warehouseId,
      distributionPointId: null,
    });
    return result.ok && result.allowed;
  }, [orgId, warehouseId, profile?.id, profile?.role]);
}
