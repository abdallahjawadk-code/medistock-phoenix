/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * INDEPENDENT PRODUCT DEFECT — NOT FIXED BY THIS PR.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHERE
 *
 * `src/features/inventory/InventoryCenterScreen.tsx`:
 *
 *     const quarantinePerm = useQuarantinePermission(activeOrgId, activeWarehouseId || null);
 *     const canDisposeQuarantine = quarantinePerm.data ?? false;
 *     ...
 *     <QuarantinePanel warehouseId={activeWarehouseId} canDispose={canDisposeQuarantine} />
 *
 * WHAT
 *
 * `useAsync` (src/shared/lib/useAsync.ts) deliberately KEEPS the previous
 * result while the next one loads — that is its documented contract, used
 * correctly all over this codebase. But `canDisposeQuarantine` here is read
 * straight off `quarantinePerm.data` with no scope check at all: it does not
 * know, and cannot tell from this expression alone, whether the boolean it is
 * holding was computed for the warehouse now selected or for the PREVIOUS one.
 *
 * DURATION — THE PART THIS TEST EXISTS TO PIN DOWN
 *
 * The staleness is not "one render". It lasts for the ENTIRE time warehouse
 * B's own check is in flight — which can be arbitrarily long (a slow network,
 * a slow RPC, or an RPC that never resolves) — and however B's check
 * eventually SETTLES:
 *
 *   • B resolves to `true`  → `canDisposeQuarantine` was already `true`
 *     (right answer, wrong reason: it was true from A the whole time B was
 *     pending too).
 *   • B resolves to `false` → `canDisposeQuarantine` reads `true` (A's value)
 *     for the entire pending window, THEN correctly flips to `false` the
 *     instant B's promise resolves.
 *   • B's check FAILS (network error, RPC exception) → `quarantinePerm.data`
 *     is UNTOUCHED by a rejection (`useAsync` only ever sets `data` from a
 *     resolved value), so `canDisposeQuarantine` reads `true` (A's stale
 *     value) FOREVER — there is no later point at which this specific
 *     expression ever corrects itself, until the operator switches warehouse
 *     again or reloads.
 *
 * So the honest description is: the release/destroy BUTTONS render from A's
 * answer for as long as B's check takes, and — on a failed check — indefinitely.
 *
 * IMPACT, PRECISELY BOUNDED
 *
 * This is a UI DISCOVERABILITY defect, not an authorization hole. Clicking
 * release or destroy while `canDisposeQuarantine` is stale still calls
 * `phoenix_release_quarantine_stock` / `phoenix_destroy_quarantine_stock`
 * with the QUARANTINE ROW's own id — rows are always fetched for whichever
 * warehouse is CURRENTLY selected (`QuarantinePanel`'s own `reload()` uses its
 * live `warehouseId` prop, which is never stale), so the id always names a
 * REAL row genuinely stored at warehouse B. Migration 099
 * (099_phoenix_notification_wiring_and_quarantine_disposition.sql) has both
 * RPCs look the row's warehouse up from the ROW ITSELF —
 *
 *     SELECT * INTO v_q FROM public.warehouse_quarantine_stock
 *       WHERE id = p_quarantine_stock_id FOR UPDATE;
 *     ...
 *     IF NOT public.phoenix_profile_has_scoped_permission(
 *       v_actor, 'warehouse_transfer.return_request',
 *       v_q.organization_id, v_q.warehouse_id, NULL
 *     ) THEN RAISE EXCEPTION 'forbidden_quarantine_release' ...
 *
 * — and NEITHER RPC signature accepts a warehouse id from the client at all
 * (`uuid, uuid, integer, text[, uuid]`: request id, quarantine-stock id,
 * quantity, reason, and — release only — a destination warehouse-stock id).
 * There is no parameter here a stale client flag could steer: the server
 * derives the warehouse from the database row, not from anything this
 * expression computed. A stale button can be SEEN and CLICKED; the RPC still
 * refuses it if the operator is not actually authorized at B. This is
 * verified from the migration's own SQL above, not asserted from a comment.
 *
 * WHY THIS PR DOES NOT FIX IT
 *
 * This is IG-2's GUIDE work. The guide's own reading of this exact answer was
 * the actual subject of round-2 review and IS fixed in this PR — see
 * `useScopedGuideCapabilities` / `dataScopeKey` in guide.surface.tsx and their
 * use in InventoryCenterScreen.tsx, proven by
 * guide-ig2-scope-attribution.runtime.test.tsx. `canDisposeQuarantine` itself
 * is a plain product expression the PANEL'S OWN BUTTONS read, entirely outside
 * the guide's code path, and predates IG-2. Fixing it belongs to a scope-aware
 * rewrite of that one expression, not to a PR whose contract is the guide.
 *
 * LIMITED FIX PLAN (not applied here)
 *
 * Mirror exactly what the guide's own `useScopedGuideCapabilities` already
 * does for the identical hook: attribute `quarantinePerm.data` to the CURRENT
 * warehouse only when `quarantinePerm.dataScopeKey` (added this round) matches
 * the warehouse being asked about, and treat a mismatch or a settled error the
 * same as "no answer yet" — i.e.
 *
 *     const canDisposeQuarantine =
 *       quarantinePerm.dataScopeKey === quarantinePermissionScopeKey(activeOrgId, activeWarehouseId || null, profile?.id ?? null)
 *         ? quarantinePerm.data ?? false
 *         : false;
 *
 * `dataScopeKey` already exists on the hook (this PR added it for the guide),
 * so the fix is a one-line change to `InventoryCenterScreen.tsx` plus a test —
 * deliberately NOT included here, since it is a change to release/destroy
 * button visibility, an operational behaviour outside the guide PR's own
 * authorization.
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
 * The EXACT expression under review, lifted verbatim from
 * InventoryCenterScreen.tsx (see the header comment above for the file/line).
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

describe('canDisposeQuarantine stays on warehouse A for the ENTIRE duration B is pending', () => {
  it('stays true across an arbitrarily long pending window, not just one render', async () => {
    const a = hold('wh-A');
    const { rerender } = render(<CurrentBehaviour warehouseId="wh-A" />);
    a.resolve({ ok: true, allowed: true });
    await waitFor(() => expect(behaviour()).toHaveAttribute('data-can-dispose', 'true'));

    hold('wh-B');
    rerender(<CurrentBehaviour warehouseId="wh-B" />);

    // Not "for one tick" — for as long as B has not settled, checked at
    // several points spread well beyond a single render/microtask.
    //
    // `quarantinePerm.loading` DOES correctly read `true` here — the hook is
    // honest about being in flight. The defect is narrower than "no loading
    // signal exists": `canDisposeQuarantine = quarantinePerm.data ?? false`
    // simply never consults it, so the stale `true` renders identically
    // whether or not a fresher check is running underneath it.
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

    // Give the rejection every chance to propagate; `canDisposeQuarantine`
    // has no path to `false` here because `quarantinePerm.data` is simply
    // never reassigned by a rejected loader.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(behaviour()).toHaveAttribute('data-error');
    expect(behaviour().getAttribute('data-error')).not.toBe('null');
    expect(behaviour(), 'A\'s stale grant outlives B\'s own failure').toHaveAttribute('data-can-dispose', 'true');

    // Confirmed permanent, not merely "not yet": wait again, nothing changes.
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(behaviour()).toHaveAttribute('data-can-dispose', 'true');
  });

  it('the buttons a stale grant renders still operate on WAREHOUSE B’s own real rows, never A’s', () => {
    /**
     * Structural check on the call site, so this documentation cannot silently
     * drift from the code it describes. `QuarantinePanel` receives the LIVE
     * `activeWarehouseId`, never a value derived from `quarantinePerm` —
     * confirming the earlier claim that the ROWS themselves are always
     * current even while `canDispose` (a separate prop) is stale.
     */
    const source = readFileSync(join(__dirname, '../InventoryCenterScreen.tsx'), 'utf8');
    expect(source).toMatch(/<QuarantinePanel\s+warehouseId=\{activeWarehouseId\}\s+canDispose=\{canDisposeQuarantine\}/);
    expect(source).toMatch(/const canDisposeQuarantine = quarantinePerm\.data \?\? false;/);
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
