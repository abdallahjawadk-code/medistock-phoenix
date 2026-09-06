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
  /**
   * True only when `dataScopeKey` matches the CURRENT (org, warehouse,
   * profile) scope — i.e. `data` is not merely present, it is KNOWN to be the
   * answer for the situation on screen right now, not one carried over from
   * a previous warehouse or profile.
   *
   * This is a pure per-render comparison, never state of its own that itself
   * needs invalidating — `dataScopeKey` is an honest tag on whatever `data`
   * currently holds (it only changes when a loader run for a NEW scope
   * actually completes), and the scope key here is recomputed fresh, this
   * render, from the current props. Two values compared fresh every render
   * cannot go stale relative to each other: there is no commit — not even
   * the very first one after org/warehouse/profile changes — where a
   * mismatch could be missed. Gating a disposal action on `data` alone (the
   * bug this field closes) lets a confirm button light up using
   * authorization that was never actually checked against the warehouse or
   * profile now in view.
   */
  confirmed: boolean;
}

/**
 * Opaque, comparison-only identity of a quarantine permission scope.
 *
 * IDENTITY IS PART OF THE SCOPE, NOT AN ADDENDUM TO IT.
 *
 * The resource half (org + warehouse) was the whole key until a reproduction
 * showed the gap: two different profiles asked about the SAME organization and
 * the SAME warehouse produce the SAME key, so switching who is asking — while
 * the resource stays put — was invisible to every consumer that compares this
 * key for attribution. Concretely: profile 1 is granted, profile 2 is denied;
 * switch from 1 to 2 while 2's own check is still in flight, and `useAsync`
 * hands back profile 1's `true` tagged with a key that still matches, because
 * nothing in it said WHO the answer was for. `useScopedGuideCapabilities`
 * would have attributed a stranger's grant to the operator now on screen.
 *
 * `profileId` closes that: two profiles asking the identical question now
 * produce different keys, so a caller comparing keys can never mistake one
 * profile's settled answer for another's — for the identical reason the
 * warehouse half already existed.
 */
export function quarantinePermissionScopeKey(
  orgId: string | null,
  warehouseId: string | null,
  profileId: string | null,
): string {
  return `${orgId ?? '-'}/${warehouseId ?? '-'}/${profileId ?? '-'}`;
}

export function useQuarantinePermission(
  orgId: string | null,
  warehouseId: string | null,
): ScopedQuarantinePermission {
  const { profile } = useApp();
  const scopeKey = quarantinePermissionScopeKey(orgId, warehouseId, profile?.id ?? null);

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

  const dataScopeKey = inner.data?.scopeKey ?? null;

  return {
    ...inner,
    data: inner.data === null ? null : inner.data.allowed,
    dataScopeKey,
    confirmed: dataScopeKey === scopeKey,
  };
}
