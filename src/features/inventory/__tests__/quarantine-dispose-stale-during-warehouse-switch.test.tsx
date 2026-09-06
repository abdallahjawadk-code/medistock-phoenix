/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * RESOLVED — via fix/quarantine-panel-stale-warehouse-race (merged into this
 * branch from master), NOT by any change made in this IG-2 PR itself.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE ORIGINALLY DOCUMENTED, AND WHY THAT FRAMING WAS WRONG
 *
 * This file originally recorded `canDisposeQuarantine`'s staleness as an
 * "independent product defect — not fixed by this PR", reasoning that it was
 * a UI-discoverability issue only: a stale button could be SEEN and CLICKED,
 * but the server-side RPCs re-derive authorization from the quarantine row's
 * own `warehouse_id` column and would refuse an unauthorized actor regardless
 * (verified below, unchanged, from the actual migration SQL).
 *
 * That undersold the actual risk. Server-side authorization integrity and
 * intended-warehouse integrity are two INDEPENDENT properties, and proving
 * the first does not establish the second: independent testing of
 * `QuarantinePanel` (fix/quarantine-panel-stale-warehouse-race) reproduced,
 * on the REAL components with controlled promise timing, an operator being
 * able to reach and click a confirm button gated on exactly this stale
 * value — a real client-side defect regardless of the server always
 * re-checking correctly, not merely a cosmetic one. That work also
 * corrected an EARLIER, separate over-claim from the same investigation
 * (that `QuarantinePanel`'s own `rows` are always fresh because the
 * warehouse id prop is live) — see that PR's own history for the full
 * account; it is not restated here since this file's subject is
 * specifically the `canDisposeQuarantine` expression, not the panel's rows.
 *
 * WHAT IS ACTUALLY TRUE NOW
 *
 * `canDisposeQuarantine = quarantinePerm.data ?? false` in
 * InventoryCenterScreen.tsx is UNCHANGED and remains exactly as stale as
 * documented below — every duration test in the first describe block below
 * still passes, unmodified, against the current code. That staleness is now
 * KNOWN-SAFE rather than merely unaddressed: `canDisposeQuarantine` feeds
 * ONLY `canViewQuarantine` (tab visibility — a stale `true` shows a tab one
 * render early or a stale error hides nothing since the read affordance can
 * still carry it; a stale `false` never removes a genuinely earned tab,
 * since view access is a strict OR with `hasInventoryReadAffordance`). The
 * disposal ACTIONS — the actual release/destroy confirm buttons — are gated
 * on a SEPARATE, stricter derivation, `canDisposeQuarantineConfirmed =
 * quarantinePerm.confirmed && quarantinePerm.data === true`, added by that
 * fix and proven immune to exactly this staleness (second describe block
 * below, added in this reconciliation).
 *
 * `confirmed` (also added by that fix) is `quarantinePerm.dataScopeKey`
 * matching the scope key freshly computed for the CURRENT (org, warehouse,
 * profile) — the identical comparison `useScopedGuideCapabilities` already
 * performs for the guide's own purposes (see
 * guide-ig2-scope-attribution.runtime.test.tsx), now reused for the
 * disposal-action gate too. It is a pure per-render comparison, not state
 * that itself needs invalidating, so it carries no "one commit late"
 * exposure of its own.
 * ═════════════════════════════════════════════════════════════════════════
 */

const hasScopedPermission = vi.fn();
vi.mock('@/shared/authz/rbac.service', () => ({
  supabaseRbacTransport: { hasScopedPermission: (...args: unknown[]) => hasScopedPermission(...args) },
}));

let appState = {
  profile: { id: 'p1', role: 'warehouse_officer', organization_id: 'org-1' },
};
vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));

import { useQuarantinePermission } from '@/features/inventory/useQuarantinePermission';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const pending = new Map<string, ReturnType<typeof deferred<{ ok: boolean; allowed: boolean }>>>();
function hold(warehouseId: string) {
  const d = deferred<{ ok: boolean; allowed: boolean }>();
  pending.set(warehouseId, d);
  return d;
}

/**
 * The EXACT tab-visibility expression, lifted verbatim from
 * InventoryCenterScreen.tsx. Still stale by construction — that is the
 * whole point of this harness — and, as established above, that is fine:
 * nothing here ever reaches a disposal action.
 */
function CurrentBehaviour({ warehouseId }: { warehouseId: string }) {
  const quarantinePerm = useQuarantinePermission('org-1', warehouseId || null);
  const canDisposeQuarantine = quarantinePerm.data ?? false;
  return (
    <div
      data-testid="behaviour"
      data-can-dispose={String(canDisposeQuarantine)}
      data-loading={String(quarantinePerm.loading)}
      data-error={String(quarantinePerm.error)}
    />
  );
}

/**
 * The EXACT disposal-action expression, lifted verbatim from
 * InventoryCenterScreen.tsx — what `QuarantinePanel`'s `canDispose` prop
 * actually receives now. This is the harness that must NEVER reproduce the
 * staleness the block above documents.
 */
function ConfirmedBehaviour({ warehouseId }: { warehouseId: string }) {
  const quarantinePerm = useQuarantinePermission('org-1', warehouseId || null);
  const canDisposeQuarantineConfirmed = quarantinePerm.confirmed && quarantinePerm.data === true;
  return (
    <div
      data-testid="confirmed-behaviour"
      data-can-dispose={String(canDisposeQuarantineConfirmed)}
      data-loading={String(quarantinePerm.loading)}
      data-error={String(quarantinePerm.error)}
    />
  );
}

beforeEach(() => {
  pending.clear();
  hasScopedPermission.mockReset();
  hasScopedPermission.mockImplementation((input: { warehouseId: string }) => {
    const held = pending.get(input.warehouseId);
    if (held) return held.promise;
    return Promise.resolve({ ok: true, allowed: false });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const behaviour = () => screen.getByTestId('behaviour');
const confirmedBehaviour = () => screen.getByTestId('confirmed-behaviour');

describe('canDisposeQuarantine (tab-visibility signal) stays on warehouse A for the ENTIRE duration B is pending — unchanged, and safe because it never reaches a disposal action', () => {
  it('stays true across an arbitrarily long pending window, not just one render', async () => {
    const a = hold('wh-A');
    const { rerender } = render(<CurrentBehaviour warehouseId="wh-A" />);
    a.resolve({ ok: true, allowed: true });
    await waitFor(() => expect(behaviour()).toHaveAttribute('data-can-dispose', 'true'));

    hold('wh-B');
    rerender(<CurrentBehaviour warehouseId="wh-B" />);

    for (const waitMs of [0, 10, 50, 200]) {
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
      expect(behaviour(), `still pending at +${waitMs}ms`).toHaveAttribute('data-can-dispose', 'true');
      expect(behaviour()).toHaveAttribute('data-loading', 'true');
    }
  });

  it('flips to false the instant B resolves false — but not one moment sooner', async () => {
    const a = hold('wh-A');
    const { rerender } = render(<CurrentBehaviour warehouseId="wh-A" />);
    a.resolve({ ok: true, allowed: true });
    await waitFor(() => expect(behaviour()).toHaveAttribute('data-can-dispose', 'true'));

    const b = hold('wh-B');
    rerender(<CurrentBehaviour warehouseId="wh-B" />);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(behaviour(), 'still stale just before B settles').toHaveAttribute('data-can-dispose', 'true');

    b.resolve({ ok: true, allowed: false });
    await waitFor(() => expect(behaviour()).toHaveAttribute('data-can-dispose', 'false'));
  });

  it('NEVER self-corrects when B’s check FAILS — the stale grant is permanent until a further switch', async () => {
    const a = hold('wh-A');
    const { rerender } = render(<CurrentBehaviour warehouseId="wh-A" />);
    a.resolve({ ok: true, allowed: true });
    await waitFor(() => expect(behaviour()).toHaveAttribute('data-can-dispose', 'true'));

    const b = hold('wh-B');
    rerender(<CurrentBehaviour warehouseId="wh-B" />);
    b.reject(new Error('network down'));

    await new Promise(resolve => setTimeout(resolve, 100));
    expect(behaviour()).toHaveAttribute('data-error');
    expect(behaviour().getAttribute('data-error')).not.toBe('null');
    expect(behaviour(), 'A\'s stale grant outlives B\'s own failure').toHaveAttribute('data-can-dispose', 'true');

    await new Promise(resolve => setTimeout(resolve, 200));
    expect(behaviour()).toHaveAttribute('data-can-dispose', 'true');
  });

  it('the buttons receive canDisposeQuarantineConfirmed, NOT this stale signal — canDisposeQuarantine feeds tab visibility only', () => {
    /**
     * Structural check on the call site, so this documentation cannot
     * silently drift from the code it describes. Confirms the fix's actual
     * wiring, not the pre-fix one this file used to assert.
     */
    const source = readFileSync(join(__dirname, '../InventoryCenterScreen.tsx'), 'utf8');
    expect(source).toMatch(/<QuarantinePanel\s+warehouseId=\{activeWarehouseId\}\s+canDispose=\{canDisposeQuarantineConfirmed\}/);
    expect(source).toMatch(/const canDisposeQuarantine = quarantinePerm\.data \?\? false;/);
    expect(source).toMatch(/const canDisposeQuarantineConfirmed = quarantinePerm\.confirmed && quarantinePerm\.data === true;/);
    expect(source).toMatch(/const canViewQuarantine = canDisposeQuarantine \|\| hasInventoryReadAffordance;/);
  });
});

describe('canDisposeQuarantineConfirmed (disposal-action signal) never reproduces the staleness above', () => {
  it('stays false across an arbitrarily long pending window — never grants from A while B is still in flight', async () => {
    const a = hold('wh-A');
    const { rerender } = render(<ConfirmedBehaviour warehouseId="wh-A" />);
    a.resolve({ ok: true, allowed: true });
    await waitFor(() => expect(confirmedBehaviour()).toHaveAttribute('data-can-dispose', 'true'));

    hold('wh-B');
    rerender(<ConfirmedBehaviour warehouseId="wh-B" />);

    for (const waitMs of [0, 10, 50, 200]) {
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
      expect(confirmedBehaviour(), `still pending at +${waitMs}ms`).toHaveAttribute('data-can-dispose', 'false');
    }
  });

  it('becomes true only once B itself resolves true — never a moment sooner', async () => {
    const a = hold('wh-A');
    const { rerender } = render(<ConfirmedBehaviour warehouseId="wh-A" />);
    a.resolve({ ok: true, allowed: true });
    await waitFor(() => expect(confirmedBehaviour()).toHaveAttribute('data-can-dispose', 'true'));

    const b = hold('wh-B');
    rerender(<ConfirmedBehaviour warehouseId="wh-B" />);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(confirmedBehaviour(), 'must not grant on A\'s stale answer while B is pending').toHaveAttribute('data-can-dispose', 'false');

    b.resolve({ ok: true, allowed: true });
    await waitFor(() => expect(confirmedBehaviour()).toHaveAttribute('data-can-dispose', 'true'));
  });

  it('stays false permanently when B’s check FAILS — the exact case the staleness above could never self-correct from', async () => {
    const a = hold('wh-A');
    const { rerender } = render(<ConfirmedBehaviour warehouseId="wh-A" />);
    a.resolve({ ok: true, allowed: true });
    await waitFor(() => expect(confirmedBehaviour()).toHaveAttribute('data-can-dispose', 'true'));

    const b = hold('wh-B');
    rerender(<ConfirmedBehaviour warehouseId="wh-B" />);
    b.reject(new Error('network down'));

    await new Promise(resolve => setTimeout(resolve, 100));
    expect(confirmedBehaviour()).toHaveAttribute('data-error');
    expect(confirmedBehaviour(), 'A\'s stale grant must not survive B\'s failure here, unlike the raw signal above').toHaveAttribute('data-can-dispose', 'false');

    await new Promise(resolve => setTimeout(resolve, 200));
    expect(confirmedBehaviour()).toHaveAttribute('data-can-dispose', 'false');
  });
});

describe('the server-side protection path (verified from the actual migration SQL, not a comment)', () => {
  it('neither disposition RPC accepts a warehouse id from the client at all', () => {
    const sql = readFileSync(
      join(__dirname, '../../../../supabase/migrations/099_phoenix_notification_wiring_and_quarantine_disposition.sql'),
      'utf8',
    );
    // The two function signatures — neither carries a p_warehouse_id.
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_release_quarantine_stock\(\s*p_request_id\s+uuid,\s*p_quarantine_stock_id\s+uuid,\s*p_quantity\s+integer,\s*p_reason\s+text,\s*p_destination_warehouse_stock_id uuid\s*\)/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_destroy_quarantine_stock\(\s*p_request_id\s+uuid,\s*p_quarantine_stock_id\s+uuid,\s*p_quantity\s+integer,\s*p_reason\s+text\s*\)/);
  });

  it('both RPCs derive the authorization warehouse from the QUARANTINE ROW itself, not from any parameter', () => {
    const sql = readFileSync(
      join(__dirname, '../../../../supabase/migrations/099_phoenix_notification_wiring_and_quarantine_disposition.sql'),
      'utf8',
    );
    // Fetch the row FIRST...
    expect(sql).toMatch(/SELECT \* INTO v_q FROM public\.warehouse_quarantine_stock WHERE id = p_quarantine_stock_id FOR UPDATE;/);
    // ...then check authorization against the ROW's OWN warehouse_id — twice,
    // once per RPC — never against a client-supplied warehouse.
    const checks = sql.match(/phoenix_profile_has_scoped_permission\(\s*v_actor, 'warehouse_transfer\.return_request',\s*v_q\.organization_id, v_q\.warehouse_id, NULL\s*\)/g);
    expect(checks?.length).toBe(2);
  });
});
