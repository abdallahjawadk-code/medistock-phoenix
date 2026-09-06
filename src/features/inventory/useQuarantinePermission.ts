import { useRef } from 'react';
import { useApp } from '@/app/AppContext';
import { useAsync, type AsyncState } from '@/shared/lib/useAsync';
import { supabaseRbacTransport } from '@/shared/authz/rbac.service';

/**
 * QUARANTINE-DISPOSITION — the exact, per-warehouse decision for viewing and
 * disposing of quarantined stock.
 *
 * `phoenix_release_quarantine_stock` / `phoenix_destroy_quarantine_stock`
 * (migration 099) check the SCOPED permission `warehouse_transfer.
 * return_request` on the quarantine row's OWN warehouse. Migration 105 widened
 * the read-side RLS policy to match this same key (it previously only
 * recognized the CENTRAL-side return_receive/review_return keys, leaving
 * warehouse_officer — the actor who actually receives outlet returns into
 * quarantine — unable to see what they were already authorized to act on).
 * This hook asks the identical question so the tab is shown to exactly the
 * actors the RPCs and RLS would let through.
 *
 * UI preflight ONLY: both RPCs repeat this authorization server-side before
 * any custody moves.
 */
export interface QuarantinePermissionState extends AsyncState<boolean> {
  /**
   * True only once `data` reflects a fresh, error-free resolution for the
   * CURRENT (orgId, warehouseId, profile) triple — never a value merely
   * carried over from a previous warehouse.
   *
   * useAsync does not clear `data` when its deps change, nor on error: if
   * warehouse A resolved `true` and the operator switches to warehouse B,
   * `data` keeps reporting `true` for the whole window where B's own check
   * is pending, denied-with-a-transport-error, or throws — not just while
   * it is cleanly pending. Gating a disposal action on `data` alone lets a
   * confirm button light up for B using authorization that was never
   * actually checked against B. `confirmed` is false for that entire
   * window and only becomes true once THIS hook's own request for the
   * current args has settled with no error.
   */
  confirmed: boolean;
}

export function useQuarantinePermission(
  orgId: string | null,
  warehouseId: string | null,
): QuarantinePermissionState {
  const { profile } = useApp();

  const state = useAsync(async () => {
    if (!orgId || !warehouseId || !profile?.id) return false;
    if (profile.role === 'super_admin') return true;

    const result = await supabaseRbacTransport.hasScopedPermission({
      profileId: profile.id,
      permissionKey: 'warehouse_transfer.return_request',
      organizationId: orgId,
      warehouseId,
      distributionPointId: null,
    });
    return result.ok && result.allowed;
  }, [orgId, warehouseId, profile?.id, profile?.role]);

  const currentKey = `${orgId ?? ''}:${warehouseId ?? ''}:${profile?.id ?? ''}:${profile?.role ?? ''}`;
  const settledKeyRef = useRef<string | null>(null);
  if (!state.loading && !state.error) {
    settledKeyRef.current = currentKey;
  }

  return { ...state, confirmed: !state.loading && !state.error && settledKeyRef.current === currentKey };
}
