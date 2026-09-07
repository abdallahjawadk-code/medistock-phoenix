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
 * TWO SEPARATE PROPERTIES, NOT ONE COMPARISON. An earlier version of this
 * hook derived `confirmed` as a single per-render comparison,
 * `dataScopeKey === scopeKey`, reasoning that two freshly-recomputed values
 * compared every render could never go stale relative to each other. That
 * reasoning is correct for a single, one-way scope change — but it silently
 * assumes scope identity strings are never revisited. They are: A → B → A
 * produces the identical `(org, warehouse, profile)` key on the second visit
 * to A as it did on the first, and `dataScopeKey` — which the guide's own
 * contract requires to HONESTLY RETAIN a settled tag while the next request
 * is pending, rather than resetting to null — still reads A's ORIGINAL,
 * already-settled tag while a genuinely NEW check for the second visit to A
 * is in flight (B's own check was left deliberately unresolved). The two
 * strings compare equal, `confirmed` reads true, and a disposal button lights
 * up on an answer that was never checked against the request actually in
 * flight. Source ATTRIBUTION (which scope produced this settled value) and
 * request FRESHNESS (is a decision for the CURRENT check on file) are
 * different questions with different answers in that exact window, and one
 * cannot be reconstructed from the other after the fact.
 *
 * This version keeps them as two independently-tracked properties:
 *
 * - `dataScopeKey` is tagged onto `data` at the moment a request actually
 *   settles, with the key that SPECIFIC request was launched for (captured
 *   in the closure, not re-read from current props later). It is never
 *   touched by a context change alone, so it goes on meaning exactly what it
 *   says — which scope the CURRENT `data` value came from — through however
 *   many later scope changes leave it unrefreshed.
 *
 * - `confirmed` is ordinary request-ownership bookkeeping: a monotonic
 *   `requestIdRef` names every request as it is launched, a response is
 *   applied only if it is still the most recent request, and — critically —
 *   context invalidation happens DURING RENDER (React's own "adjusting state
 *   when a prop changes" pattern), not from an effect. `useEffect` runs after
 *   a render has already committed and a real browser has already painted
 *   it, so invalidating only from an effect leaves exactly one commit where
 *   the previous context's `confirmed=true` is still on screen while every
 *   prop already names the new context. Resetting synchronously during
 *   render — calling `setState` before this render is allowed to commit —
 *   means React re-renders again before committing anything, so the
 *   corrected value is what actually paints. Because this reset fires on
 *   ANY change from the immediately preceding render, it does not matter
 *   that A's key repeats on a second visit: B's key was on file a moment
 *   ago, so returning to A is still observed as a change.
 */
export interface ScopedQuarantinePermission extends AsyncState<boolean> {
  /**
   * The scope the CURRENT `data` value was actually computed for, or null
   * when nothing has ever settled. May legitimately name an older scope than
   * the one on screen right now, for as long as the current scope's own
   * check has not yet settled — see the module doc comment.
   */
  dataScopeKey: string | null;
  /**
   * True only when `data` is a fresh, error-free resolution for the CURRENT
   * (organization, warehouse, profile id, profile role) context — never a
   * value merely carried over from a previous context, and never true on the
   * same render the context changed. False while the current context's own
   * check is pending, false after that check throws, and false again on a
   * revisit to an identity seen before until ITS OWN new check settles.
   */
  confirmed: boolean;
}

/**
 * Opaque, comparison-only identity of a quarantine permission scope.
 *
 * Deliberately narrower than the request-freshness context this hook tracks
 * internally (which also folds in profile ROLE — a role change must
 * invalidate `confirmed` even when the resource and profile id do not
 * change, e.g. a demotion mid-session). This key stays resource+profile only
 * because it is the guide's own public source-attribution contract
 * (`useScopedGuideCapabilities`'s `answerScopeKey`); widening it would be an
 * unrelated, unrequested change to that contract.
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
  const profileId = profile?.id ?? null;
  const profileRole = profile?.role ?? null;

  // Request-freshness context: resource + identity + ROLE. See the module
  // doc comment for why this is wider than the public scope key below.
  const currentKey = `${orgId ?? ''}:${warehouseId ?? ''}:${profileId ?? ''}:${profileRole ?? ''}`;
  // Public, guide-facing source-attribution key — unchanged contract.
  const scopeKey = quarantinePermissionScopeKey(orgId, warehouseId, profileId);

  const [data, setData] = useState<boolean | null>(null);
  const [dataScopeKey, setDataScopeKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [nonce, setNonce] = useState(0);

  // DURING-RENDER reset (not an effect): `renderedForKey` is the freshness
  // context as of the last committed render. A mismatch here is caught and
  // corrected before this render is allowed to commit, so no frame — not
  // even the first one — attributes an old context's confirmation to a new
  // one. `data`/`dataScopeKey` are deliberately NOT reset here: they may
  // honestly keep naming the previous scope while the new one's own check is
  // still in flight.
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
    // Captured now, not re-read later: this is the scope THIS request was
    // launched for, regardless of how many further context changes happen
    // before it settles (a stale response is discarded below regardless).
    const requestScopeKey = scopeKey;
    void (async () => {
      try {
        if (!orgId || !warehouseId || !profileId) {
          if (requestIdRef.current !== requestId) return;
          setData(false);
          setDataScopeKey(requestScopeKey);
          setLoading(false);
          setConfirmed(true);
          return;
        }
        if (profileRole === 'super_admin') {
          if (requestIdRef.current !== requestId) return;
          setData(true);
          setDataScopeKey(requestScopeKey);
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
        setDataScopeKey(requestScopeKey);
        setLoading(false);
        setConfirmed(true);
      } catch (err) {
        if (requestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err.message : 'Unexpected error');
        setLoading(false);
        // confirmed, data and dataScopeKey are untouched: an exception never
        // confirms anything, and never retags stale data as fresh.
      }
    })();
  }, [orgId, warehouseId, profileId, profileRole, scopeKey, nonce]);

  const reload = useCallback(() => setNonce(n => n + 1), []);

  return { data, dataScopeKey, loading, error, reload, confirmed };
}
