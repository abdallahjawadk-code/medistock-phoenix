import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

/**
 * DISPENSE-WITH-CONTEXT-136 — the exact, per-outlet decision for DISPENSING.
 *
 * phoenix_dispense_outlet_stock_with_context composes two writers, and BOTH
 * re-check their own scoped permission on the locked row's distribution
 * point: outlet_stock.dispense (067/131) and movement_context.record (134).
 * The composed act therefore needs BOTH, so this hook asks for both and
 * returns true only when both are granted — showing the affordance to
 * someone who would be refused mid-act would be worse than hiding it.
 *
 * UI preflight ONLY: the RPCs repeat both authorizations server-side before
 * any quantity moves, so a stale or over-permissive answer here can never
 * become a write.
 */
export function useOutletDispensePermission(
  orgId: string | null,
  distributionPointId: string | null,
): AsyncState<boolean> {
  const { profile } = useApp();

  return useAsync(async () => {
    if (!orgId || !distributionPointId || !profile?.id) return false;
    if (profile.role === 'super_admin') return true;

    const ask = (permissionKey: string) =>
      supabaseRbacTransport.hasScopedPermission({
        profileId: profile.id,
        permissionKey,
        organizationId: orgId,
        warehouseId: null,
        distributionPointId,
      });

    const [dispense, context] = await Promise.all([
      ask('outlet_stock.dispense'),
      ask('movement_context.record'),
    ]);
    return dispense.ok && dispense.allowed && context.ok && context.allowed;
  }, [orgId, distributionPointId, profile?.id, profile?.role]);
}
