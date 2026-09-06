/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { cleanup, waitFor } from '@testing-library/react';

/**
 * FIRST-COMMIT ATTRIBUTION — does `confirmed` ever read true for the WRONG
 * warehouse, even for a single render, before this hook's own effect has
 * had a chance to react to the switch?
 *
 * This is checked SYNCHRONOUSLY: the assertion runs immediately after the
 * warehouse-changing re-render, with NO `await`/`waitFor` in between — any
 * `act()`-driven effect flush that happens to run before this line returns
 * is exactly the thing being probed, not something this test waits past.
 * `screen`/`waitFor`-based assertions elsewhere in this suite intentionally
 * let the DOM settle before asserting, which is correct for THOSE
 * scenarios but cannot, by construction, observe a one-commit-wide
 * attribution error — hence this separate, synchronous-only test.
 */

const ORG = 'org-1';
const WH_A = 'wh-A';
const WH_B = 'wh-B';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

const pendingPermission = new Map<string, ReturnType<typeof deferred<boolean>>>();
const settledPermission = new Map<string, boolean>();

function holdPermission(warehouseId: string) {
  const d = deferred<boolean>();
  pendingPermission.set(warehouseId, d);
  return d;
}
function settlePermissionImmediately(warehouseId: string, allowed: boolean) {
  pendingPermission.delete(warehouseId);
  settledPermission.set(warehouseId, allowed);
}

const hasScopedPermission = vi.fn((args: { warehouseId: string | null }) => {
  if (args.warehouseId) {
    const held = pendingPermission.get(args.warehouseId);
    if (held) return held.promise.then(allowed => ({ ok: true, allowed }));
    if (settledPermission.has(args.warehouseId)) {
      return Promise.resolve({ ok: true, allowed: settledPermission.get(args.warehouseId)! });
    }
  }
  return Promise.resolve({ ok: true, allowed: false });
});

vi.mock('@/shared/authz/rbac.service', () => ({
  supabaseRbacTransport: {
    hasScopedPermission: (args: unknown) => hasScopedPermission(args as { warehouseId: string | null }),
  },
}));

const appState = {
  profile: { id: 'p1', full_name: 'T', role: 'central_warehouse_manager', organization_id: ORG },
};
vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));

import { useQuarantinePermission } from '@/features/inventory/useQuarantinePermission';

let lastSnapshot: { warehouseId: string; data: boolean | null; confirmed: boolean } | null = null;

function Probe({ warehouseId }: { warehouseId: string }) {
  const state = useQuarantinePermission(ORG, warehouseId);
  // Captured synchronously, in the render body itself, so it reflects
  // exactly what THIS commit's hook call returned — not a value read back
  // later, after any further effects have had a chance to correct it.
  lastSnapshot = { warehouseId, data: state.data, confirmed: state.confirmed };
  return null;
}

beforeEach(() => {
  pendingPermission.clear();
  settledPermission.clear();
  hasScopedPermission.mockClear();
  lastSnapshot = null;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useQuarantinePermission — attribution at the first commit after a warehouse switch', () => {
  it('never reports confirmed:true for B while B’s own request is still pending, not even transiently', async () => {
    // React Testing Library's render()/rerender() wrap every update in
    // act(), which — in this test environment — flushes passive effects
    // SYNCHRONOUSLY before returning. That closes exactly the window this
    // test exists to probe: a real browser defers a useEffect callback
    // until after it has painted the commit that scheduled it, so an
    // act()-flushed assertion cannot tell "fixed by construction" apart
    // from "fixed only because the test harness raced it correctly this
    // time". A raw ReactDOM root, updated OUTSIDE act(), does not get that
    // synchronous flush — its passive effects run on a separate scheduled
    // task, so reading the probe's state immediately after `root.render()`
    // returns reflects the TRUE first commit, before any effect has run.
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root;
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      const msg = String(args[0] ?? '');
      if (msg.includes('not wrapped in act')) return;
      originalError(...args);
    };
    try {
      settlePermissionImmediately(WH_A, true);
      root = createRoot(container);
      flushSync(() => root.render(<Probe warehouseId={WH_A} />));
      await waitFor(() => expect(lastSnapshot).toMatchObject({ warehouseId: WH_A, data: true, confirmed: true }));

      holdPermission(WH_B); // B's request never resolves during this test
      // flushSync forces a SYNCHRONOUS commit (unlike a bare root.render()
      // outside act(), which may not commit before this call returns at
      // all) without forcing passive effects to flush — exactly the "first
      // commit, before this hook's effect has run" moment being probed.
      flushSync(() => root.render(<Probe warehouseId={WH_B} />));

      // No await, no act() — this is the literal first commit the switch
      // produces, before React has had any chance to run this hook's effect.
      expect(lastSnapshot, JSON.stringify(lastSnapshot)).toMatchObject({ warehouseId: WH_B, confirmed: false });
    } finally {
      console.error = originalError;
      root!.unmount();
      container.remove();
    }
  });
});
