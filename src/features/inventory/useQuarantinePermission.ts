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
export interface ScopedQuarantinePermission extends AsyncState<boolean> {
  /**
   * The scope `data` was actually computed for, or null when there is no
   * settled answer.
   *
   * WHY THE ANSWER HAS TO CARRY ITS OWN SUBJECT. `useAsync` deliberately keeps
   * the PREVIOUS result while the next one loads, so on the first render after
   * the warehouse changes, `data` still holds the FORMER warehouse's answer
   * while every prop already reads the new one. A caller comparing this field
   * against the warehouse it is asking about can tell those two situations
   * apart; a caller looking only at `loading` cannot, because whether a render
   * with `loading === true` is ever observed depends on how React happens to
   * batch the effect against the promise's own microtask.
   *
   * `useInventoryScopes` has always done exactly this — it rejects a catalog
   * whose `organizationId` is not the one being asked about. This is the same
   * rule, for the same reason, spelled for a scalar answer.
   *
   * Nothing about the permission itself changes: `data` is the same boolean it
   * always was, so every existing consumer behaves identically.
   */
  dataScopeKey: string | null;
}

/** Opaque, comparison-only identity of a quarantine permission scope. */
export function quarantinePermissionScopeKey(
  orgId: string | null,
  warehouseId: string | null,
): string {
  return `${orgId ?? '-'}/${warehouseId ?? '-'}`;
}

export function useQuarantinePermission(
  orgId: string | null,
  warehouseId: string | null,
): ScopedQuarantinePermission {
  const { profile } = useApp();
  const scopeKey = quarantinePermissionScopeKey(orgId, warehouseId);

  // The loader closes over the scope of the render whose effect runs it, so
  // the tag travels with the answer rather than being read back afterwards
  // from props that may already have moved on.
  const inner = useAsync<{ scopeKey: string; allowed: boolean }>(async () => {
    if (!orgId || !warehouseId || !profile?.id) return { scopeKey, allowed: false };
    if (profile.role === 'super_admin') return { scopeKey, allowed: true };

    const result = await supabaseRbacTransport.hasScopedPermission({
      profileId: profile.id,
      permissionKey: 'warehouse_transfer.return_request',
      organizationId: orgId,
      warehouseId,
      distributionPointId: null,
    });
    return { scopeKey, allowed: result.ok && result.allowed };
  }, [orgId, warehouseId, profile?.id, profile?.role]);

  return {
    ...inner,
    data: inner.data === null ? null : inner.data.allowed,
    dataScopeKey: inner.data?.scopeKey ?? null,
  };
}
