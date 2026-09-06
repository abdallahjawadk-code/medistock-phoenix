/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutEffect } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';

/**
 * REVISIT FRESHNESS vs. SOURCE ATTRIBUTION — a proven gap in a comparison
 * that only checks `dataScopeKey === scopeKey`.
 *
 * `dataScopeKey` is REQUIRED to honestly retain an older settled tag while a
 * newer request for a different scope is still pending (see
 * `guide-ig2-scope-attribution.runtime.test.tsx`) — that is correct and
 * deliberate, not a bug. The gap is what happens on a REVISIT: A → B → A
 * produces the identical `(org, warehouse, profile)` key on the second visit
 * to A as the first, so a stale `dataScopeKey` left over from A's ORIGINAL,
 * already-settled grant reads as an exact match against the CURRENT scope
 * key even while a brand-new, still-pending check for this second visit is
 * in flight (B's own check is deliberately left unresolved throughout, so it
 * cannot be what is retaining the tag). A plain equality comparison cannot
 * tell "settled for an EARLIER visit to this identity" apart from "settled
 * for the CURRENT visit" when the identity string repeats over time — it
 * carries no notion of which specific request produced the value.
 *
 * These three scenarios are run, UNCHANGED, against three implementations
 * of the hook (see the accompanying control-comparison log referenced from
 * the PR description): the rejected PR #187 head (negative control — must
 * fail here), the known-good implementation on master, which predates the
 * guide's `dataScopeKey` addition (positive control — must pass), and the
 * corrected implementation (must pass, proving the regression is closed
 * without regressing the retention behaviour the other suite requires).
 *
 * Deliberately checks only `data` / `confirmed` / `loading` / `error` —
 * fields every one of the three implementations under comparison exposes —
 * so the identical test file runs unmodified against all three.
 */

const ORG = 'org-1';
const WH_A = 'wh-A';
const WH_B = 'wh-B';

interface ControlledCall {
  resolve: (allowed: boolean) => void;
  reject: (err: Error) => void;
}

let callQueue: ControlledCall[] = [];

const hasScopedPermission = vi.fn((_args: unknown) => {
  return new Promise<{ ok: boolean; allowed: boolean }>((resolve, reject) => {
    callQueue.push({
      resolve: (allowed: boolean) => resolve({ ok: true, allowed }),
      reject: (err: Error) => reject(err),
    });
  });
});

vi.mock('@/shared/authz/rbac.service', () => ({
  supabaseRbacTransport: {
    hasScopedPermission: (args: unknown) => hasScopedPermission(args),
  },
}));

const appState = {
  profile: { id: 'p1', full_name: 'T', role: 'central_warehouse_manager' as string, organization_id: ORG },
};
vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));

import { useQuarantinePermission } from '@/features/inventory/useQuarantinePermission';

interface Snapshot {
  data: boolean | null;
  confirmed: boolean;
  loading: boolean;
  error: string | null;
}

let committed: Snapshot[] = [];

function Probe({ orgId, warehouseId }: { orgId: string; warehouseId: string }) {
  const state = useQuarantinePermission(orgId, warehouseId);
  // A layout effect fires only for a render that actually committed — the
  // during-render self-correction the corrected hook performs discards any
  // earlier, uncommitted render of the same pass entirely, so this can
  // never record a value that was never actually painted. A render-body
  // assignment cannot make that distinction.
  useLayoutEffect(() => {
    committed.push({ data: state.data, confirmed: state.confirmed, loading: state.loading, error: state.error });
  });
  return null;
}

function effectiveGrant(s: Snapshot): boolean {
  return s.confirmed && s.data === true;
}

function firstCommitSince(mark: number): Snapshot {
  const slice = committed.slice(mark);
  expect(slice.length).toBeGreaterThan(0);
  return slice[0];
}

function latest(): Snapshot {
  expect(committed.length).toBeGreaterThan(0);
  return committed[committed.length - 1];
}

beforeEach(() => {
  callQueue = [];
  committed = [];
  hasScopedPermission.mockClear();
  appState.profile.role = 'central_warehouse_manager';
});
afterEach(() => {
  cleanup();
});

describe('TEST A — A -> B -> A with the new A request left pending', () => {
  it('confirmed=false and the action grant is closed, even though B never resolves', async () => {
    const { rerender } = render(<Probe orgId={ORG} warehouseId={WH_A} />);
    await waitFor(() => expect(hasScopedPermission).toHaveBeenCalledTimes(1));
    callQueue[0].resolve(true);
    await waitFor(() => expect(latest().confirmed).toBe(true));
    expect(latest().data).toBe(true);
    expect(effectiveGrant(latest())).toBe(true);

    // Select B; its own check starts, then is deliberately left pending.
    let mark = committed.length;
    rerender(<Probe orgId={ORG} warehouseId={WH_B} />);
    await waitFor(() => expect(hasScopedPermission).toHaveBeenCalledTimes(2));
    expect(firstCommitSince(mark).confirmed).toBe(false);
    expect(effectiveGrant(firstCommitSince(mark))).toBe(false);
    // callQueue[1] (B) is INTENTIONALLY never resolved for the rest of this test.

    // Return to A before B resolves: a NEW A request must start.
    mark = committed.length;
    rerender(<Probe orgId={ORG} warehouseId={WH_A} />);
    await waitFor(() => expect(hasScopedPermission).toHaveBeenCalledTimes(3));

    // THE REGRESSION: on the merged-master-vs-rejected-head comparison, the
    // rejected head reads confirmed=true here (A's ORIGINAL settled tag
    // matches the revisit's identical scope key) even though THIS request
    // — call #3 — has not settled, and #2 (B) never will.
    const firstA2 = firstCommitSince(mark);
    expect(firstA2.confirmed).toBe(false);
    expect(effectiveGrant(firstA2)).toBe(false);

    // And it must stay false for as long as call #3 is pending — not just
    // on the very first commit.
    expect(latest().confirmed).toBe(false);
    expect(effectiveGrant(latest())).toBe(false);
  });
});

describe('TEST B — the same A -> B -> A sequence, but the new A request errors', () => {
  it('the error is observed, confirmed stays false, and a retained data=true never reopens the gate', async () => {
    const { rerender } = render(<Probe orgId={ORG} warehouseId={WH_A} />);
    await waitFor(() => expect(hasScopedPermission).toHaveBeenCalledTimes(1));
    callQueue[0].resolve(true);
    await waitFor(() => expect(latest().confirmed).toBe(true));

    rerender(<Probe orgId={ORG} warehouseId={WH_B} />);
    await waitFor(() => expect(hasScopedPermission).toHaveBeenCalledTimes(2));
    // callQueue[1] (B) intentionally left pending for the rest of this test.

    rerender(<Probe orgId={ORG} warehouseId={WH_A} />);
    await waitFor(() => expect(hasScopedPermission).toHaveBeenCalledTimes(3));

    callQueue[2].reject(new Error('unexpected RBAC transport failure'));
    await waitFor(() => expect(latest().error).toBe('unexpected RBAC transport failure'));

    // Safety properties: an exception never confirms anything, and a stale
    // data=true retained from A's ORIGINAL grant must not read as a live
    // authorization once the CURRENT request for that identity has failed.
    expect(latest().confirmed).toBe(false);
    expect(effectiveGrant(latest())).toBe(false);
  });
});

describe('TEST C — a role change with no resource change', () => {
  it('confirmed=false through the pending window, and the final decision belongs to the NEW check', async () => {
    appState.profile.role = 'super_admin';
    const { rerender } = render(<Probe orgId={ORG} warehouseId={WH_A} />);
    // super_admin is a synchronous bypass in every implementation under
    // comparison — no RBAC call — but still resolves via a microtask.
    await waitFor(() => expect(latest().confirmed).toBe(true));
    expect(latest().data).toBe(true);
    expect(hasScopedPermission).not.toHaveBeenCalled();

    // Same profile id, organization and warehouse — only the role changes,
    // to one that requires a real scoped check.
    appState.profile.role = 'central_warehouse_manager';
    const mark = committed.length;
    rerender(<Probe orgId={ORG} warehouseId={WH_A} />);
    await waitFor(() => expect(hasScopedPermission).toHaveBeenCalledTimes(1));

    // First commit after the role change: the super_admin grant must not
    // still read as confirmed for a context that no longer holds.
    const firstAfterRoleChange = firstCommitSince(mark);
    expect(firstAfterRoleChange.confirmed).toBe(false);
    expect(effectiveGrant(firstAfterRoleChange)).toBe(false);
    // And it stays false for the whole pending window, not just the first commit.
    expect(latest().confirmed).toBe(false);

    // The new check denies. The final decision must belong to THIS check,
    // not to the super_admin grant it replaced.
    callQueue[0].resolve(false);
    await waitFor(() => expect(latest().confirmed).toBe(true));
    expect(latest().data).toBe(false);
    expect(effectiveGrant(latest())).toBe(false);
  });
});
