import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '@/app/AppContext';
import type { AsyncState } from '@/shared/lib/useAsync';
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
 *
 * DELIBERATELY NOT BUILT ON `useAsync`, and deliberately NOT invalidating
 * `confirmed` from inside a `useEffect` either — both leave a real gap.
 *
 * `useAsync` never clears `data` on a dep change or on error, so it cannot
 * answer "is this fresh" at all.
 *
 * Invalidating inside THIS hook's own `useEffect` (an earlier version of
 * this fix did exactly that) still leaves ONE COMMIT where the wrong
 * attribution is real: React runs effects AFTER a render commits, and
 * `useEffect` specifically defers until after the browser has painted that
 * commit. On the very first render after (org, warehouse, profile) changes,
 * `confirmed`/`data`/`loading`/`error` still hold whatever the PREVIOUS,
 * fully-settled context left them — nothing has reset them yet — so that
 * render commits, and a real browser paints it, with the old context's
 * answer attributed to the new one. The effect then corrects it, but only
 * after that frame was already visible.
 *
 * The fix is React's own documented pattern for this exact situation —
 * "adjusting state when a prop changes" — applied DURING RENDER, not in an
 * effect: `renderedForKey` remembers which key the current derived state
 * belongs to; if it does not match this render's key, the derived fields
 * are reset RIGHT NOW, synchronously, inside the render. Calling setState
 * during render makes React immediately re-render this component again,
 * before committing anything, so the corrected values are what actually
 * commits (and, in a real browser, what actually paints) — there is no
 * frame, not even one, where A's result is attributed to B.
 */
export interface QuarantinePermissionState extends AsyncState<boolean> {
  /**
   * True only once `data` reflects a fresh, error-free resolution for the
   * CURRENT (organizationId, warehouseId, profile id, profile role) tuple —
   * never a value merely carried over from a previous warehouse, and never
   * true on the same commit the tuple changed. False while pending, while
   * denied by a real RBAC transport error, and while an unexpected exception
   * was thrown — an exception never confirms a grant.
   */
  confirmed: boolean;
}

export function useQuarantinePermission(
  orgId: string | null,
  warehouseId: string | null,
): QuarantinePermissionState {
  const { profile } = useApp();
  const profileId = profile?.id ?? null;
  const profileRole = profile?.role ?? null;
  const currentKey = `${orgId ?? ''}:${warehouseId ?? ''}:${profileId ?? ''}:${profileRole ?? ''}`;

  const [data, setData] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [nonce, setNonce] = useState(0);

  // See the module doc comment: this is a DURING-RENDER reset, not an
  // effect. `renderedForKey` is the key the state above was LAST computed
  // for (as of the last committed render); comparing it here, on every
  // render, is what lets a mismatch be caught and corrected before this
  // render is allowed to commit.
  const [renderedForKey, setRenderedForKey] = useState(currentKey);
  if (renderedForKey !== currentKey) {
    setRenderedForKey(currentKey);
    setLoading(true);
    setError(null);
    setConfirmed(false);
  }

  const requestIdRef = useRef(0);
  useEffect(() => {
    const requestId = ++requestIdRef.current;
    void (async () => {
      try {
        if (!orgId || !warehouseId || !profileId) {
          if (requestIdRef.current !== requestId) return;
          setData(false);
          setLoading(false);
          setConfirmed(true);
          return;
        }
        if (profileRole === 'super_admin') {
          if (requestIdRef.current !== requestId) return;
          setData(true);
          setLoading(false);
          setConfirmed(true);
          return;
        }

        const result = await supabaseRbacTransport.hasScopedPermission({
          profileId,
          permissionKey: 'warehouse_transfer.return_request',
          organizationId: orgId,
          warehouseId,
          distributionPointId: null,
        });
        // A later dep change (or an explicit reload()) may have started a
        // newer request before this one resolved. Discard — committing now
        // would overwrite the current context's own, more current answer.
        if (requestIdRef.current !== requestId) return;
        setData(result.ok && result.allowed);
        setLoading(false);
        setConfirmed(true);
      } catch (err) {
        if (requestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err.message : 'Unexpected error');
        setLoading(false);
        // confirmed stays false: an exception never confirms anything.
      }
    })();
  }, [orgId, warehouseId, profileId, profileRole, nonce]);

  const reload = useCallback(() => setNonce(n => n + 1), []);

  return { data, loading, error, reload, confirmed };
}
