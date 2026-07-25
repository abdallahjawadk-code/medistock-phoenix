import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

/**
 * MOVEMENT-DISPENSE-CONTEXT (134) — the exact, per-outlet decision for
 * recording dispense beneficiary context (patient/crash_cart/internal_order).
 *
 * phoenix_record_movement_dispense_context checks the SCOPED permission
 * `movement_context.record` on the dispense movement's own distribution
 * point (never on the caller generally). This hook asks the same question
 * so the "Record context" action is shown to exactly the actors the RPC
 * would let through — outlet_officer only, by default (134's role grants).
 *
 * UI preflight ONLY: the RPC repeats this authorization server-side before
 * any row is written, so a stale or over-permissive answer here can never
 * become a write.
 */
export function useMovementContextRecordPermission(
  orgId: string | null,
  distributionPointId: string | null,
): AsyncState<boolean> {
  const { profile } = useApp();

  return useAsync(async () => {
    if (!orgId || !distributionPointId || !profile?.id) return false;
    if (profile.role === 'super_admin') return true;

    const result = await supabaseRbacTransport.hasScopedPermission({
      profileId: profile.id,
      permissionKey: 'movement_context.record',
      organizationId: orgId,
      warehouseId: null,
      distributionPointId,
    });
    return result.ok && result.allowed;
  }, [orgId, distributionPointId, profile?.id, profile?.role]);
}
