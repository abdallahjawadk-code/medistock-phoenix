/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * INTERACTIVE-GUIDE-IG2 — WHOSE ANSWER IS THIS?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS SUITE EXISTS FOR
 *
 * Quarantine disposal is decided per WAREHOUSE, asynchronously. `useAsync` —
 * the loader behind that decision — deliberately keeps the PREVIOUS result
 * while the next one loads, and turns `loading` back on from an effect. So on
 * the render that first carries a new warehouse:
 *
 *     the warehouse prop  = B          (already updated)
 *     loading             = false      (the effect has not run yet)
 *     data                = A's answer (still in hand)
 *
 * The first version of IG-2 published `state: 'ready'` unconditionally from
 * QuarantinePanel, out of the single boolean it is handed. That published A's
 * "yes" filed under B — the guide would have offered release and destroy steps
 * for a warehouse whose permission check had not started.
 *
 * WHAT IS EXERCISED HERE, AND WHAT IS NOT
 *
 * Everything below runs the REAL pieces: the real `useQuarantinePermission`
 * over the real `useAsync`, the real `GuideSurfaceProvider`, the real
 * `useScopedGuideCapabilities`, and the real `permittedTours` filter. Only the
 * RBAC transport is replaced, at its own seam, so the test can hold warehouse
 * B's answer in flight and then refuse or fail it on demand — which is the
 * whole point.
 *
 * The screen's own call site is asserted separately, structurally, at the end.
 *
 * A SECOND, INDEPENDENT SHAPE OF THE SAME BUG. The scope key first covered only
 * the resource (organization + warehouse / outlet). A reproduction showed that
 * was not the whole subject: two DIFFERENT profiles asked about the identical
 * resource produce the identical key, so switching WHO is asking, with the
 * resource held constant, was invisible to a comparison that only looked at
 * the resource. `quarantinePermissionScopeKey` / `suspensionPermissionScopeKey`
 * now fold the asking profile's id in as well, and the "never attributed to
 * the previous identity" describe block below proves it the same way the
 * warehouse block does — hold the new identity's own check in flight and
 * confirm the former identity's settled answer never surfaces as theirs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const hasScopedPermission = vi.fn();
vi.mock('@/shared/authz/rbac.service', () => ({
  supabaseRbacTransport: {
    hasScopedPermission: (...args: unknown[]) => hasScopedPermission(...args),
    hasWarehouseAssignment: () => Promise.resolve({ ok: true, allowed: false }),
    hasPointAssignment: () => Promise.resolve({ ok: true, allowed: false }),
  },
}));

let appState = {
  lang: 'ar' as 'ar' | 'en',
  dir: 'rtl' as 'rtl' | 'ltr',
  theme: 'light' as const,
  role: 'central_warehouse_manager',
  activeOrgId: 'org-1' as string | null,
  myPermissions: new Set<string>(),
  profile: { id: 'p1', full_name: 'T', role: 'central_warehouse_manager', organization_id: 'org-1' },
  session: { user: { id: 'u1' } } as { user: { id: string } } | null,
  authStatus: 'authenticated',
  toggleLang: () => undefined,
  toggleTheme: () => undefined,
};
vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('@/shared/ui/PhoenixIcon', () => ({
  PhoenixIcon: ({ name }: { name: string }) => <span aria-hidden="true" data-icon={name} />,
}));

import { GUIDE_CAPABILITIES, GUIDE_REGISTRY } from '../guide.registry';
import { permittedTours } from '../guide.permissions';
import {
  GuideSurfaceProvider,
  useGuideSurface,
  useGuideSurfaceContext,
  useScopedGuideCapabilities,
} from '../guide.surface';
import {
  quarantinePermissionScopeKey,
  useQuarantinePermission,
} from '@/features/inventory/useQuarantinePermission';

/** A hand-held promise for one warehouse's permission check. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Answer = { ok: boolean; allowed: boolean };
const pending = new Map<string, ReturnType<typeof deferred<Answer>>>();
/** Forces a re-render of IdentityHarness after `appState.profile` is mutated. */
let identityNotify: (() => void) | null = null;

/** Hold the check for `warehouseId` until the test decides its outcome. */
function hold(warehouseId: string) {
  const d = deferred<Answer>();
  pending.set(warehouseId, d);
  return d;
}

/**
 * Hold the check for one PROFILE, independent of warehouse. Prefixed so it can
 * never collide with a warehouse id above — 'wh-A'/'wh-B' vs 'profile:p2'.
 */
function holdProfile(profileId: string) {
  const d = deferred<Answer>();
  pending.set(`profile:${profileId}`, d);
  return d;
}

/**
 * The screen's OWN publishing expression, mounted over the real hook.
 *
 * `InventoryCenterScreen` is not rendered here: it pulls the whole inventory
 * feature graph (OCR, dispatch, corrections) into a test whose subject is one
 * asynchronous answer. What IS the subject — the hook, its AsyncState, the
 * scope tag, the publisher and the filter — is real and complete, and the
 * assertion at the bottom of this file proves the screen calls it this way.
 */
function QuarantinePublisher({ warehouseId }: { warehouseId: string }) {
  const perm = useQuarantinePermission(appState.activeOrgId, warehouseId || null);
  useGuideSurface(3, 'quarantine');
  useScopedGuideCapabilities(
    'inventory.quarantine.action',
    {
      'inventory.quarantine.view': perm.data === true,
      'inventory.quarantine.dispose': perm.data === true,
    },
    perm.loading ? 'loading' : (perm.error ? 'error' : 'ready'),
    quarantinePermissionScopeKey(appState.activeOrgId, warehouseId || null, appState.profile.id),
    perm.dataScopeKey,
  );
  return <div data-testid="perm">{String(perm.data)}|{perm.loading ? 'loading' : 'settled'}</div>;
}

/** Reads exactly what the guide would decide, through the real filter. */
function Observer() {
  const { capabilities, capabilityState, surface } = useGuideSurfaceContext();
  const tours = permittedTours(GUIDE_REGISTRY.tours, {
    role: appState.role,
    permissions: appState.myPermissions,
    capabilities,
    // Presence is a separate axis and is deliberately satisfied here: this
    // suite is about authorization attribution, not about what is on screen.
    presence: {
      'inventory.quarantine.region': true,
      'inventory.quarantine.row': true,
      'inventory.quarantine.rowActions': true,
    },
    surface,
  }, 'desktop');
  const quarantine = tours.find(t => t.tour.id === 'guide.tour.quarantine');
  return (
    <div
      data-testid="observer"
      data-state={capabilityState}
      data-dispose={String(capabilities[GUIDE_CAPABILITIES.quarantineDispose] === true)}
      data-tour={quarantine ? 'offered' : 'absent'}
      data-steps={(quarantine?.steps ?? []).map(s => s.id).join(',')}
    />
  );
}

function Harness({ initial }: { initial: string }) {
  const [warehouseId, setWarehouseId] = useState(initial);
  const value = useMemo(() => ({ warehouseId, setWarehouseId }), [warehouseId]);
  return (
    <GuideSurfaceProvider>
      <button type="button" onClick={() => value.setWarehouseId('wh-B')}>to-B</button>
      <QuarantinePublisher warehouseId={warehouseId} />
      <Observer />
    </GuideSurfaceProvider>
  );
}

const observer = () => screen.getByTestId('observer');

beforeEach(() => {
  pending.clear();
  hasScopedPermission.mockReset();
  hasScopedPermission.mockImplementation((input: { profileId: string; warehouseId: string }) => {
    const byProfile = pending.get(`profile:${input.profileId}`);
    if (byProfile) return byProfile.promise;
    const held = pending.get(input.warehouseId);
    if (held) return held.promise;
    return Promise.resolve({ ok: true, allowed: false });
  });
  appState = {
    ...appState,
    activeOrgId: 'org-1',
    // Reset explicitly rather than carrying forward whatever a PRIOR test in
    // this file left `profile` as — the identity describe block below swaps
    // it mid-test, and every OTHER test's assumptions are keyed on 'p1'.
    profile: { id: 'p1', full_name: 'T', role: 'central_warehouse_manager', organization_id: 'org-1' },
  };
});

afterEach(() => {
  cleanup();
  identityNotify = null;
  vi.restoreAllMocks();
});

/* ════════════════════════════════════════════════════════════════════════ */

describe('IG-2 — warehouse A’s answer is never attributed to warehouse B', () => {
  it('holds the tour back while B is pending, then keeps it away when B refuses', async () => {
    // ── Warehouse A allows the action. ──────────────────────────────────
    const a = hold('wh-A');
    render(<Harness initial="wh-A" />);
    await waitFor(() => expect(observer()).toHaveAttribute('data-state', 'loading'));
    expect(observer()).toHaveAttribute('data-tour', 'absent');

    a.resolve({ ok: true, allowed: true });
    await waitFor(() => expect(observer()).toHaveAttribute('data-state', 'ready'));
    expect(observer()).toHaveAttribute('data-dispose', 'true');
    expect(observer()).toHaveAttribute('data-tour', 'offered');
    expect(observer().getAttribute('data-steps')).toContain('quarantine.release');

    // ── The context moves to warehouse B; B's check is still pending. ────
    const b = hold('wh-B');
    fireEvent.click(screen.getByText('to-B'));

    // THE DEFECT: at this instant `useAsync` still holds A's `true` and has
    // not yet flipped `loading`. Nothing may be granted from it.
    expect(observer()).toHaveAttribute('data-dispose', 'false');
    expect(observer()).toHaveAttribute('data-tour', 'absent');

    // ...and it stays that way for as long as B is in flight.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(observer()).toHaveAttribute('data-dispose', 'false');
    expect(observer()).toHaveAttribute('data-tour', 'absent');

    // ── B refuses. ──────────────────────────────────────────────────────
    b.resolve({ ok: true, allowed: false });
    await waitFor(() => expect(screen.getByTestId('perm')).toHaveTextContent('false|settled'));
    expect(observer()).toHaveAttribute('data-dispose', 'false');
    expect(observer()).toHaveAttribute('data-tour', 'absent');
  });

  it('keeps the tour away when B’s check FAILS rather than refusing', async () => {
    const a = hold('wh-A');
    render(<Harness initial="wh-A" />);
    a.resolve({ ok: true, allowed: true });
    await waitFor(() => expect(observer()).toHaveAttribute('data-tour', 'offered'));

    const b = hold('wh-B');
    fireEvent.click(screen.getByText('to-B'));
    expect(observer()).toHaveAttribute('data-tour', 'absent');

    b.reject(new Error('scoped permission read failed'));
    await waitFor(() => expect(observer()).toHaveAttribute('data-state', 'error'));
    // An error is not a grant, and it is not silently downgraded to A's answer.
    expect(observer()).toHaveAttribute('data-dispose', 'false');
    expect(observer()).toHaveAttribute('data-tour', 'absent');
  });

  it('grants again only once B’s OWN answer is a yes', async () => {
    const a = hold('wh-A');
    render(<Harness initial="wh-A" />);
    a.resolve({ ok: true, allowed: true });
    await waitFor(() => expect(observer()).toHaveAttribute('data-tour', 'offered'));

    const b = hold('wh-B');
    fireEvent.click(screen.getByText('to-B'));
    expect(observer()).toHaveAttribute('data-tour', 'absent');

    b.resolve({ ok: true, allowed: true });
    await waitFor(() => expect(observer()).toHaveAttribute('data-tour', 'offered'));
    expect(observer()).toHaveAttribute('data-dispose', 'true');
  });

  it('asks the transport for the NEW warehouse, never re-reading the old answer', async () => {
    const a = hold('wh-A');
    render(<Harness initial="wh-A" />);
    a.resolve({ ok: true, allowed: true });
    await waitFor(() => expect(observer()).toHaveAttribute('data-tour', 'offered'));

    hold('wh-B');
    fireEvent.click(screen.getByText('to-B'));
    await waitFor(() => expect(hasScopedPermission).toHaveBeenCalledTimes(2));
    expect(hasScopedPermission.mock.calls[1][0]).toMatchObject({
      permissionKey: 'warehouse_transfer.return_request',
      warehouseId: 'wh-B',
      distributionPointId: null,
    });
  });
});

describe('IG-2 — a change of IDENTITY is never attributed to the previous identity', () => {
  /**
   * SAME organization, SAME warehouse, DIFFERENT profile. A reproduction
   * (kept here as the regression) showed the ORIGINAL scope key — resource
   * only — could not tell the two apart: it renders identically for both
   * profiles, so nothing about it changes when the operator does.
   *
   * `useAsync` starts a fresh check the moment `profile?.id` changes (it is
   * one of the hook's own deps), but while that check is still in flight the
   * PREVIOUS profile's settled `data` is still sitting in state — the same
   * shape of staleness the warehouse block above exists for, just keyed on
   * identity instead of on a warehouse id. Concretely: profile 1 is granted,
   * switch to profile 2 (org and warehouse held constant) while profile 2's
   * own check is pending — profile 1's `true` must not be presented as
   * profile 2's answer, and the guide must not act on it.
   */
  function IdentityHarness() {
    const [, force] = useState(0);
    identityNotify = () => force(n => n + 1);
    return (
      <GuideSurfaceProvider>
        <button type="button" onClick={() => { appState = { ...appState, profile: { ...appState.profile, id: 'user-2' } }; identityNotify?.(); }}>
          to-user-2
        </button>
        <QuarantinePublisher warehouseId="wh-A" />
        <Observer />
      </GuideSurfaceProvider>
    );
  }

  it('holds the tour back while the new identity’s own check is pending, and never grants from the old one', async () => {
    // ── user-1 (the default 'p1' from beforeEach) is granted. ────────────
    const u1 = hold('wh-A');
    render(<IdentityHarness />);
    await waitFor(() => expect(observer()).toHaveAttribute('data-state', 'loading'));
    u1.resolve({ ok: true, allowed: true });
    await waitFor(() => expect(observer()).toHaveAttribute('data-tour', 'offered'));
    expect(observer()).toHaveAttribute('data-dispose', 'true');

    // ── SWITCH IDENTITY. Same org, same warehouse. user-2's check pends. ──
    const u2 = holdProfile('user-2');
    fireEvent.click(screen.getByText('to-user-2'));

    // THE CLAIM: user-1's grant must not be presented as user-2's, at any
    // point before user-2's OWN check settles.
    expect(observer()).toHaveAttribute('data-dispose', 'false');
    expect(observer()).toHaveAttribute('data-tour', 'absent');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(observer()).toHaveAttribute('data-dispose', 'false');
    expect(observer()).toHaveAttribute('data-tour', 'absent');

    // ── user-2 is denied. ─────────────────────────────────────────────────
    u2.resolve({ ok: true, allowed: false });
    await waitFor(() => expect(screen.getByTestId('perm')).toHaveTextContent('false|settled'));
    expect(observer()).toHaveAttribute('data-dispose', 'false');
    expect(observer()).toHaveAttribute('data-tour', 'absent');
  });

  it('asks the transport for the NEW profile, tagged with the SAME resource', async () => {
    const u1 = hold('wh-A');
    render(<IdentityHarness />);
    u1.resolve({ ok: true, allowed: true });
    await waitFor(() => expect(observer()).toHaveAttribute('data-tour', 'offered'));

    holdProfile('user-2');
    fireEvent.click(screen.getByText('to-user-2'));
    await waitFor(() => expect(hasScopedPermission).toHaveBeenCalledTimes(2));
    expect(hasScopedPermission.mock.calls[1][0]).toMatchObject({
      profileId: 'user-2',
      organizationId: 'org-1',
      warehouseId: 'wh-A',
    });
  });

  it('the scope key itself distinguishes two profiles asking about the identical resource', () => {
    expect(quarantinePermissionScopeKey('org-1', 'wh-A', 'p1'))
      .not.toBe(quarantinePermissionScopeKey('org-1', 'wh-A', 'user-2'));
  });
});

describe('IG-2 — read authority and action authority fail independently', () => {
  /**
   * The read affordance is a synchronous decision that owes nothing to the
   * scoped RBAC round trip. A quarantine ACTION check that is pending or that
   * FAILED must not cancel it — the operator can still be told what the list
   * is — while never, in either state, granting the action.
   */
  function TwoSources({ warehouseId, readAffordance }: { warehouseId: string; readAffordance: boolean }) {
    const perm = useQuarantinePermission(appState.activeOrgId, warehouseId || null);
    const scopeKey = quarantinePermissionScopeKey(appState.activeOrgId, warehouseId || null, appState.profile.id);
    useGuideSurface(3, 'quarantine');
    // Source 1 — synchronous, independent.
    useScopedGuideCapabilities(
      'inventory.quarantine.read',
      { 'inventory.quarantine.view': readAffordance },
      'ready', scopeKey, scopeKey,
    );
    // Source 2 — asynchronous, scoped.
    useScopedGuideCapabilities(
      'inventory.quarantine.action',
      {
        'inventory.quarantine.view': perm.data === true,
        'inventory.quarantine.dispose': perm.data === true,
      },
      perm.loading ? 'loading' : (perm.error ? 'error' : 'ready'),
      scopeKey, perm.dataScopeKey,
    );
    return null;
  }

  function Two({ readAffordance }: { readAffordance: boolean }) {
    return (
      <GuideSurfaceProvider>
        <TwoSources warehouseId="wh-A" readAffordance={readAffordance} />
        <Observer />
      </GuideSurfaceProvider>
    );
  }

  it('keeps the view capability when the action check FAILS', async () => {
    const a = hold('wh-A');
    render(<Two readAffordance />);
    a.reject(new Error('boom'));
    await waitFor(() => expect(observer()).toHaveAttribute('data-state', 'error'));
    // The tour is still offered — the reading steps are legitimate.
    expect(observer()).toHaveAttribute('data-tour', 'offered');
    // ...and the action is not.
    expect(observer()).toHaveAttribute('data-dispose', 'false');
    expect(observer().getAttribute('data-steps')).toContain('quarantine.list');
    expect(observer().getAttribute('data-steps')).not.toContain('quarantine.release');
  });

  it('offers nothing at all when there is no read affordance and the action check fails', async () => {
    const a = hold('wh-A');
    render(<Two readAffordance={false} />);
    a.reject(new Error('boom'));
    await waitFor(() => expect(observer()).toHaveAttribute('data-state', 'error'));
    expect(observer()).toHaveAttribute('data-tour', 'absent');
  });

  it('a read affordance alone never grants the action', async () => {
    const a = hold('wh-A');
    render(<Two readAffordance />);
    a.resolve({ ok: true, allowed: false });
    await waitFor(() => expect(observer()).toHaveAttribute('data-state', 'ready'));
    expect(observer()).toHaveAttribute('data-tour', 'offered');
    expect(observer()).toHaveAttribute('data-dispose', 'false');
  });
});

describe('IG-2 — the answer carries the scope it was computed for', () => {
  function Probe({ warehouseId }: { warehouseId: string }) {
    const perm = useQuarantinePermission('org-1', warehouseId);
    return (
      <div
        data-testid="probe"
        data-scope={perm.dataScopeKey ?? '-'}
        data-data={String(perm.data)}
        data-loading={String(perm.loading)}
      />
    );
  }

  it('tags a settled answer with its own warehouse AND profile, and keeps the old tag while the next loads', async () => {
    const a = hold('wh-A');
    const { rerender } = render(<Probe warehouseId="wh-A" />);
    a.resolve({ ok: true, allowed: true });
    await waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveAttribute('data-scope', 'org-1/wh-A/p1'));

    hold('wh-B');
    rerender(<Probe warehouseId="wh-B" />);
    // The retained data is A's, and it SAYS so — which is exactly what lets a
    // caller refuse to attribute it to B.
    expect(screen.getByTestId('probe')).toHaveAttribute('data-data', 'true');
    expect(screen.getByTestId('probe')).toHaveAttribute('data-scope', 'org-1/wh-A/p1');
    expect(quarantinePermissionScopeKey('org-1', 'wh-B', 'p1')).toBe('org-1/wh-B/p1');
  });
});

describe('IG-2 — the Inventory Center publishes it this way', () => {
  /**
   * The runtime proof above is complete for the hook, the publisher and the
   * filter. This is the remaining link: that the screen actually wires them
   * together that way rather than hard-coding a state, which is a property of
   * the call site and is asserted as one. (Same idiom as
   * r1-5-e-read-mutation-parity.test.ts, which reads this file for the same
   * kind of claim.)
   */
  const source = readSource('src/features/inventory/InventoryCenterScreen.tsx');
  const panel = readSource('src/features/inventory/QuarantinePanel.tsx');

  it('publishes the action source from the AsyncState, tagged with its own scope', () => {
    expect(source).toMatch(/useScopedGuideCapabilities\(\s*'inventory\.quarantine\.action'/);
    expect(source).toMatch(/quarantinePerm\.loading \? 'loading' : \(quarantinePerm\.error \? 'error' : 'ready'\)/);
    expect(source).toMatch(/quarantinePerm\.dataScopeKey/);
  });

  it('publishes read authority as a SEPARATE source', () => {
    expect(source).toMatch(/useGuideCapabilities\(\s*'inventory\.quarantine\.read'/);
    expect(source).toMatch(/hasInventoryReadAffordance && activeWarehouseId !== ''/);
  });

  it('no longer lets the panel declare a permission state it cannot know', () => {
    expect(panel).not.toMatch(/useGuideCapabilities/);
    expect(panel).not.toMatch(/'inventory\.quarantine\.view': true/);
  });
});

function readSource(relative: string): string {
  return readFileSync(join(__dirname, '../../../../', relative), 'utf8');
}
