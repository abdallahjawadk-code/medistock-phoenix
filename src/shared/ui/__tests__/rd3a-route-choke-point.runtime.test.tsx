/** @vitest-environment jsdom */
/**
 * RD-3A (CI-1) — the route choke point, behaviourally.
 *
 * RT-A  Every screen id that reaches AuthenticatedApp (forged `onNavigate`, restore,
 *       Back) goes through the canonical `isScreenAuthorized` decision, with the
 *       actor's own role and the AUTHORITY-VERIFIED organization kind. A refused id
 *       is replaced by `roleLandingScreen(role)` and never mounted. A facility-scoped
 *       role can occupy only {3, 6, 15, 18}. Screen 19 opens only for a verified
 *       `care_institution`; a canonical kind beside an absent, null or unrecognised
 *       verified kind, and a verified PDA kind, never open it.
 * RT-C  Screen 21, the role landing and the screen registry do not depend on the
 *       organization kind or on the RD-3A authority state.
 * SO-1  The route never reads the canonical `activeOrganizationKind`.
 *
 * These tests complement the text-only pins of the call shape in
 * r1-1-p-nav-projection.test.ts and ub-facility-scope-activation.test.ts (which are kept,
 * re-pinned to the verified alias) with proof of which value flows in and what is rendered.
 * Every row publishes RAW state straight to a mocked useApp(), so the expectations never
 * depend on a hand-mirrored copy of AppContext's rule; the real provider is proven in
 * rd3a-screen19-authority.runtime.test.tsx.
 */
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { useLayoutEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { AppState } from '@/app/AppContext';
import type { OrganizationKind } from '@/shared/lib/institution-hierarchy';
import { PERMISSION_KEY_SET } from '@/shared/lib/permissions';
import { clearRememberedScreen, rememberScreen } from '@/app/screen-continuity';

const h = vi.hoisted(() => ({
  procurementRenders: 0,
  navigate: (_screen: number): void => undefined,
  /** One entry per committed shell render: the screen content mounted at that commit. */
  frames: [] as string[],
}));

let state: Partial<AppState> = {};

vi.mock('@/app/AppContext', () => ({
  useApp: () => state,
}));

vi.mock('@/shared/ui/PhoenixAppShell', () => ({
  // Renders its children because WHICH screen mounts is the point here. `h.navigate`
  // stands in for any navigation surface, a deep link or a forged call to onNavigate,
  // and the layout effect records the committed content of every render (a screen, the
  // loading state, or nothing), which the shell prop alone cannot show.
  PhoenixAppShell: ({ currentScreen, onNavigate, children }: {
    currentScreen: number; onNavigate: (screen: number) => void; children: ReactNode;
  }) => {
    h.navigate = onNavigate;
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      const ids = Array.from(ref.current?.querySelectorAll('[data-testid]') ?? [])
        .map(node => node.getAttribute('data-testid') ?? '')
        .filter(id => /^(screen-\d+|loading-state)$/.test(id));
      h.frames.push(ids.join('+') || 'none');
    });
    return (
      <div ref={ref} data-testid="app-shell" data-screen={currentScreen}>
        {children}
      </div>
    );
  },
}));
vi.mock('@/shared/ui/PhoenixLoadingState', () => ({
  PhoenixLoadingState: () => <div data-testid="loading-state" />,
}));
vi.mock('@/shared/authz/ScreenAuthzGuard', () => ({
  ScreenAuthzGuard: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/features/auth/LoginScreen', () => ({ LoginScreen: () => <div data-testid="login-screen" /> }));
vi.mock('@/features/auth/PhoenixWelcomeExperience', () => ({
  PhoenixWelcomeExperience: () => <div data-testid="welcome-screen" />,
}));
vi.mock('@/features/auth/ResetPasswordScreen', () => ({
  ResetPasswordScreen: () => <div data-testid="reset-screen" />,
}));
vi.mock('@/features/inventory/InventoryCenterScreen', () => ({
  InventoryCenterScreen: () => <div data-testid="screen-3" />,
}));
vi.mock('@/features/registry/RegistryScreen', () => ({ RegistryScreen: () => <div data-testid="screen-4" /> }));
vi.mock('@/features/mesh/MeshScreen', () => ({ MeshScreen: () => <div data-testid="screen-5" /> }));
vi.mock('@/features/qr/QrScreen', () => ({ QrScreen: () => <div data-testid="screen-6" /> }));
vi.mock('@/features/health/HealthScreen', () => ({ HealthScreen: () => <div data-testid="screen-7" /> }));
vi.mock('@/features/health/IntakeFrozenScreen', () => ({
  IntakeFrozenScreen: () => <div data-testid="screen-8" />,
}));
vi.mock('@/features/mesh/MobileCommandScreen', () => ({
  MobileCommandScreen: () => <div data-testid="screen-10" />,
}));
vi.mock('@/features/institutions/InstitutionScreen', () => ({
  InstitutionScreen: () => <div data-testid="screen-11" />,
}));
vi.mock('@/features/alerts/InterInstitutionAlertsScreen', () => ({
  InterInstitutionAlertsScreen: () => <div data-testid="screen-13" />,
}));
vi.mock('@/features/users/UserManagementScreen', () => ({
  UserManagementScreen: () => <div data-testid="screen-14" />,
}));
vi.mock('@/features/account/MyAccountScreen', () => ({ MyAccountScreen: () => <div data-testid="screen-15" /> }));
vi.mock('@/features/status/StatusEditorScreen', () => ({
  StatusEditorScreen: () => <div data-testid="screen-16" />,
}));
vi.mock('@/features/network/NetworkManagementScreen', () => ({
  NetworkManagementScreen: () => <div data-testid="screen-17" />,
}));
vi.mock('@/features/outlet/OutletOperationsScreen', () => ({
  OutletOperationsScreen: () => <div data-testid="screen-18" />,
}));
vi.mock('@/features/procurement/LocalProcurementScreen', () => ({
  LocalProcurementScreen: () => {
    h.procurementRenders += 1;
    return <div data-testid="screen-19" />;
  },
}));
// The reports shell stub exposes the props the router passes, so RT-C can prove the
// registry (initialTab per retired id, live onNavigate) and not merely that "a screen" mounted.
vi.mock('@/features/reports/DecisionIntelligenceReportsScreen', () => ({
  DecisionIntelligenceReportsScreen: ({ onNavigate, onOpenSuggestionDocument, initialTab }: {
    onNavigate?: (screen: number) => void;
    onOpenSuggestionDocument?: unknown;
    initialTab?: string;
  }) => (
    <div
      data-testid="screen-21"
      data-initial-tab={initialTab ?? ''}
      data-on-navigate={typeof onNavigate}
      data-on-document={typeof onOpenSuggestionDocument}
    >
      <button type="button" onClick={() => onNavigate?.(3)}>rt-nav-3</button>
    </div>
  ),
}));
vi.mock('@/features/command-center/CommandCenterScreen', () => ({
  CommandCenterScreen: () => <div data-testid="screen-22" />,
}));
vi.mock('@/features/central-needs/CentralNeedsScreen', () => ({
  CentralNeedsScreen: () => <div data-testid="screen-23" />,
}));

import { AuthenticatedApp } from '@/app/AuthenticatedApp';

const CARE: OrganizationKind = 'care_institution';
const PDA: OrganizationKind = 'pharmacy_department_authority';
const USER = 'user-1';
const ORG = 'org-care-a';

const retryAuthBootstrap = vi.fn(async () => undefined);
const retryProfileLoad = vi.fn(async () => undefined);

/** Every permission the catalog knows, so a refusal can never be explained by a missing key. */
const EVERY_PERMISSION = [...PERMISSION_KEY_SET];

interface Row {
  role: string;
  permissions?: string[];
  /** activeOrganizationKind. Omit for null. */
  canonical?: OrganizationKind | null;
  canonicalPending?: boolean;
  /**
   * screenOrganizationKind. `undefined` leaves the field ABSENT, which the route must read
   * as unknown (denied). Anything else, including `null`, is published as given.
   */
  verified?: OrganizationKind | null | 'unknown_kind';
  verifiedPending?: boolean;
}

/**
 * Raw published state. The profile and permission OBJECTS stay referentially stable while the role
 * and permissions do not change, as AppProvider keeps them: the AuthenticatedApp effect depends on
 * both objects, so re-creating them on every publish would re-run it for the wrong reason and could
 * mask a missing dependency.
 */
let identityKey = '';
let identity: { profile: AppState['profile']; permissions: Set<string>; signOut: () => Promise<void> } | null = null;

function publish(row: Row) {
  const key = `${row.role}|${(row.permissions ?? []).join(',')}`;
  if (identity === null || key !== identityKey) {
    identityKey = key;
    identity = {
      profile: { id: USER, role: row.role, organization_id: ORG } as unknown as AppState['profile'],
      permissions: new Set(row.permissions ?? []),
      signOut: vi.fn(async () => undefined),
    };
  }
  state = {
    lang: 'en',
    authReady: true,
    authStatus: 'authenticated',
    session: { user: { id: USER } } as unknown as AppState['session'],
    profile: identity.profile,
    role: row.role as AppState['role'],
    passwordRecovery: false,
    signOut: identity.signOut,
    retryAuthBootstrap,
    retryProfileLoad,
    myPermissions: identity.permissions,
    activeOrgId: ORG,
    activeOrganizationKind: row.canonical ?? null,
    activeOrganizationKindPending: row.canonicalPending ?? false,
    ...(row.verified === undefined ? {} : { screenOrganizationKind: row.verified as OrganizationKind | null }),
    ...(row.verifiedPending === undefined ? {} : { screenOrganizationKindPending: row.verifiedPending }),
  };
}

const app = () => <AuthenticatedApp />;
const SCREEN_ID = /^screen-\d+$/;

/** Mounted screen stubs only (the loading state and the shell are not screens). */
function mounted(): string[] {
  return Array.from(document.querySelectorAll('[data-testid]'))
    .map(node => node.getAttribute('data-testid') ?? '')
    .filter(id => SCREEN_ID.test(id));
}
const shellScreen = () => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-screen') ?? null;
const loading = () => screen.queryByTestId('loading-state') !== null;
const go = (id: number) => { act(() => { h.navigate(id); }); };
/** Every committed content id (a frame can hold several ids, joined with "+"). */
const frameIds = () => h.frames.flatMap(frame => frame.split('+'));

function storedScreen(): number | null {
  const raw = window.sessionStorage.getItem(`medistock-phoenix-screen:${USER}`);
  return raw === null ? null : (JSON.parse(raw) as { screen: number }).screen;
}

beforeEach(() => {
  clearRememberedScreen(USER);
  window.sessionStorage.clear();
  window.history.replaceState(null, '');
  // The welcome sequence is not under test.
  window.sessionStorage.setItem(`medistock-phoenix-welcome:${USER}`, 'complete');
  h.procurementRenders = 0;
  h.frames = [];
  h.navigate = () => undefined;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ALL_IDS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 99];
const FACILITY_SAFE = [3, 6, 15, 18];

// ── RT-A — the route choke point ────────────────────────────────────────────

describe('RT-A · a facility-scoped role is confined to {3, 6, 15, 18} whatever it holds', () => {
  it('every other forged id lands on the facility landing 18 and is never mounted, even with a verified care kind and every permission', () => {
    publish({
      role: 'health_center_manager', permissions: EVERY_PERMISSION,
      canonical: CARE, verified: CARE, verifiedPending: false,
    });
    render(app());
    // The first render is already the facility landing, never the reports surface.
    expect(shellScreen()).toBe('18');
    expect(mounted()).toEqual(['screen-18']);

    for (const id of ALL_IDS) {
      go(id);
      const expected = FACILITY_SAFE.includes(id) ? id : 18;
      expect(shellScreen(), `forged ${id}`).toBe(String(expected));
      expect(mounted(), `forged ${id}`).toEqual([`screen-${expected}`]);
    }
    // Screen 19 was never rendered for the facility role, and nothing was remembered for it: after an
    // allowed id (6) the refused ids 19 and 21 leave 6 remembered, which also proves remembering works.
    go(6);
    go(19);
    go(21);
    expect(shellScreen()).toBe('18');
    expect(h.procurementRenders).toBe(0);
    expect(storedScreen()).toBe(6);
    expect(h.frames.length).toBeGreaterThan(0);
    expect(frameIds()).toContain('screen-18');
    expect(frameIds()).not.toContain('screen-19');
    expect(frameIds()).not.toContain('screen-21');
  });
});

describe('RT-A · Screen 19 follows the VERIFIED kind and nothing else', () => {
  interface Case { name: string; row: Row; opens: boolean }
  const CASES: Case[] = [
    { name: 'verified care opens 19 (positive control: the verified kind reaches the gate)', opens: true,
      row: { role: 'institution_admin', canonical: CARE, verified: CARE, verifiedPending: false } },
    { name: 'warehouse_officer + verified care opens 19', opens: true,
      row: { role: 'warehouse_officer', canonical: CARE, verified: CARE, verifiedPending: false } },
    { name: 'super_admin + verified care opens 19', opens: true,
      row: { role: 'super_admin', permissions: ['users.view'], canonical: CARE, verified: CARE, verifiedPending: false } },
    { name: 'canonical care beside a settled NULL verified kind refuses 19 (unverified organization)', opens: false,
      row: { role: 'institution_admin', canonical: CARE, verified: null, verifiedPending: false } },
    { name: 'canonical care with the verified fields ABSENT refuses 19', opens: false,
      row: { role: 'institution_admin', canonical: CARE } },
    { name: 'canonical care beside an unrecognised verified kind refuses 19', opens: false,
      row: { role: 'institution_admin', canonical: CARE, verified: 'unknown_kind', verifiedPending: false } },
    { name: 'verified PDA refuses 19', opens: false,
      row: { role: 'institution_admin', canonical: PDA, verified: PDA, verifiedPending: false } },
    { name: 'super_admin + verified PDA refuses 19 (a non-null verified kind is not eligibility)', opens: false,
      row: { role: 'super_admin', permissions: ['users.view'], canonical: PDA, verified: PDA, verifiedPending: false } },
    { name: 'super_admin with no organization kind ("all organizations") refuses 19', opens: false,
      row: { role: 'super_admin', permissions: ['users.view'], canonical: null, verified: null, verifiedPending: false } },
    { name: 'unknown everywhere refuses 19', opens: false,
      row: { role: 'institution_admin', canonical: null, verified: null, verifiedPending: false } },
  ];

  for (const c of CASES) {
    it(c.name, () => {
      publish(c.row);
      render(app());
      const rendersBefore = h.procurementRenders;
      // Start from Screen 3, so a refused 19 visibly moves 3 -> landing: a swallowed navigation
      // cannot pass as a refusal.
      go(3);
      expect(shellScreen()).toBe('3');
      go(19);
      if (c.opens) {
        expect(shellScreen()).toBe('19');
        expect(mounted()).toEqual(['screen-19']);
        expect(h.procurementRenders).toBeGreaterThan(rendersBefore);
        expect(loading()).toBe(false);
        expect(storedScreen()).toBe(19);
      } else {
        // Refused: the role landing renders, Screen 19 never mounts, nothing is remembered for it
        // (the last remembered screen is still 3, which also proves remembering works here).
        expect(shellScreen()).toBe('21');
        expect(mounted()).toEqual(['screen-21']);
        expect(h.procurementRenders).toBe(0);
        expect(storedScreen()).toBe(3);
        expect(h.frames.length).toBeGreaterThan(0);
        expect(frameIds()).toContain('screen-3');
        expect(frameIds()).not.toContain('screen-19');
      }
    });
  }
});

describe('RT-A · a pending verified kind WAITS for Screen 19 and never delays another screen', () => {
  it('forged 19 while pending: loading, no 19, no landing flash; then care opens it and PDA lands', () => {
    publish({ role: 'institution_admin', canonical: null, canonicalPending: true, verified: null, verifiedPending: true });
    const view = render(app());
    go(19);
    expect(loading()).toBe(true);
    expect(mounted()).toEqual([]);
    expect(h.procurementRenders).toBe(0);
    // While the kind was unknown the only committed content was the landing (rendered before the
    // forged navigation) and then the loading state: Screen 19 was never committed.
    expect(h.frames.length).toBeGreaterThan(0);
    expect(frameIds().every(id => id === 'screen-21' || id === 'loading-state')).toBe(true);
    expect(h.frames[h.frames.length - 1]).toBe('loading-state');

    publish({ role: 'institution_admin', canonical: CARE, verified: CARE, verifiedPending: false });
    view.rerender(app());
    expect(loading()).toBe(false);
    expect(mounted()).toEqual(['screen-19']);
  });

  it('the route waits on the VERIFIED pending flag even when the canonical kind has already settled to care', () => {
    publish({ role: 'institution_admin', canonical: CARE, canonicalPending: false, verified: null, verifiedPending: true });
    const view = render(app());
    go(19);
    expect(loading()).toBe(true);
    expect(mounted()).toEqual([]);
    expect(h.procurementRenders).toBe(0);

    publish({ role: 'institution_admin', canonical: CARE, verified: null, verifiedPending: false });
    view.rerender(app());
    expect(loading()).toBe(false);
    expect(mounted()).toEqual(['screen-21']);
    expect(h.procurementRenders).toBe(0);
  });

  it('a pending CANONICAL kind does not make the route wait when the verified pair is settled care', () => {
    publish({ role: 'institution_admin', canonical: null, canonicalPending: true, verified: CARE, verifiedPending: false });
    render(app());
    go(19);
    expect(loading()).toBe(false);
    expect(mounted()).toEqual(['screen-19']);
  });

  it('forged 19 while pending, then a verified PDA settles: the landing, and 19 is never rendered', () => {
    publish({ role: 'institution_admin', canonical: null, canonicalPending: true, verified: null, verifiedPending: true });
    const view = render(app());
    go(19);
    expect(loading()).toBe(true);

    publish({ role: 'institution_admin', canonical: PDA, verified: PDA, verifiedPending: false });
    view.rerender(app());
    expect(mounted()).toEqual(['screen-21']);
    expect(h.procurementRenders).toBe(0);
    expect(h.frames.length).toBeGreaterThan(0);
    expect(frameIds()).toContain('loading-state');
    expect(frameIds()).not.toContain('screen-19');
  });

  it('every non-19 screen still renders at once while the kind is pending', () => {
    publish({ role: 'institution_admin', canonical: null, canonicalPending: true, verified: null, verifiedPending: true });
    render(app());
    go(3);
    expect(loading()).toBe(false);
    expect(mounted()).toEqual(['screen-3']);
    go(21);
    expect(loading()).toBe(false);
    expect(mounted()).toEqual(['screen-21']);
  });
});

describe('RT-A · first frame: a restored Screen 19 follows the verified kind, not the canonical one', () => {
  it('a stored 19 with a verified care kind restores straight to 19 with no landing flash (contract-violating canonical null on purpose)', () => {
    // activeOrganizationKind is deliberately null here while the verified kind is care. The real
    // provider can never publish that pair, so this row exists to prove WHICH field the restoration
    // call reads: a route that restored from the canonical kind would flash the landing first.
    rememberScreen(USER, 19, 'replace');
    publish({ role: 'institution_admin', canonical: null, verified: CARE, verifiedPending: false });
    render(app());
    expect(h.frames.length).toBeGreaterThan(0);
    expect(new Set(frameIds())).toEqual(new Set(['screen-19']));
    expect(mounted()).toEqual(['screen-19']);
  });

  it('a stored 19 with canonical care beside a null verified kind never mounts 19 and lands on the landing', () => {
    rememberScreen(USER, 19, 'replace');
    publish({ role: 'institution_admin', canonical: CARE, verified: null, verifiedPending: false });
    render(app());
    expect(h.frames.length).toBeGreaterThan(0);
    expect(frameIds()).toContain('screen-21');
    expect(frameIds()).not.toContain('screen-19');
    expect(mounted()).toEqual(['screen-21']);
    expect(h.procurementRenders).toBe(0);
    expect(storedScreen()).toBe(21);
  });

  it('Back/Forward onto a stored 19 follows the verified kind: refused beside canonical care + null, opened for verified care', () => {
    // Refused: canonical care, authority-verified kind null.
    rememberScreen(USER, 3, 'replace');
    rememberScreen(USER, 19, 'push');
    const entry19 = window.history.state;
    publish({ role: 'institution_admin', canonical: CARE, verified: null, verifiedPending: false });
    const refused = render(app());
    act(() => { window.dispatchEvent(new PopStateEvent('popstate', { state: entry19 })); });
    expect(shellScreen()).toBe('21');
    expect(mounted()).toEqual(['screen-21']);
    expect(h.procurementRenders).toBe(0);
    expect(frameIds()).not.toContain('screen-19');
    refused.unmount();

    // Opened: the same history entry for a verified care kind (positive control for the popstate path).
    h.frames = [];
    publish({ role: 'institution_admin', canonical: CARE, verified: CARE, verifiedPending: false });
    render(app());
    act(() => { window.dispatchEvent(new PopStateEvent('popstate', { state: entry19 })); });
    expect(shellScreen()).toBe('19');
    expect(mounted()).toEqual(['screen-19']);
    expect(h.procurementRenders).toBeGreaterThan(0);
  });
});

// ── RT-C — Screen 21, the role landing and the screen registry ──────────────

describe('RT-C · Screen 21 does not depend on the organization kind or the authority state', () => {
  const STATES: Array<[string, Partial<Row>]> = [
    ['verified care', { canonical: CARE, verified: CARE, verifiedPending: false }],
    ['canonical care beside a null verified kind', { canonical: CARE, verified: null, verifiedPending: false }],
    ['verified PDA', { canonical: PDA, verified: PDA, verifiedPending: false }],
    ['unknown kind', { canonical: null, verified: null, verifiedPending: false }],
    ['pending kind', { canonical: null, canonicalPending: true, verified: null, verifiedPending: true }],
    ['verified fields absent', { canonical: CARE }],
  ];

  for (const role of ['super_admin', 'institution_admin', 'central_warehouse_manager', 'warehouse_officer', 'outlet_officer']) {
    it(`${role}: forged 21 opens it at once in every authority state, without waiting`, () => {
      for (const [name, partial] of STATES) {
        // Every iteration starts clean: nothing remembered from the previous state.
        clearRememberedScreen(USER);
        window.history.replaceState(null, '');
        publish({ role, ...partial });
        const view = render(app());
        // From Screen 3, so reaching 21 is a real navigation and not the landing already shown.
        go(3);
        expect(shellScreen(), name).toBe('3');
        go(21);
        expect(shellScreen(), name).toBe('21');
        expect(mounted(), name).toEqual(['screen-21']);
        expect(loading(), name).toBe(false);
        expect(h.procurementRenders, name).toBe(0);
        view.unmount();
        h.frames = [];
      }
    });
  }

  it('health_center_manager never reaches Screen 21 in any authority state (it lands on 18)', () => {
    for (const [name, partial] of STATES) {
      clearRememberedScreen(USER);
      window.history.replaceState(null, '');
      publish({ role: 'health_center_manager', permissions: EVERY_PERMISSION, ...partial });
      const view = render(app());
      go(3);
      expect(shellScreen(), name).toBe('3');
      go(21);
      expect(shellScreen(), name).toBe('18');
      expect(mounted(), name).toEqual(['screen-18']);
      expect(h.frames.length, name).toBeGreaterThan(0);
      expect(frameIds(), name).toContain('screen-3');
      expect(frameIds(), name).not.toContain('screen-21');
      view.unmount();
      h.frames = [];
    }
  });

  it('the first screen for each role is its role-safe landing (nothing stored, verified care)', () => {
    const expectations: Array<[string, string[], string]> = [
      ['super_admin', [], '21'],
      ['institution_admin', [], '21'],
      ['central_warehouse_manager', [], '21'],
      ['warehouse_officer', [], '21'],
      ['outlet_officer', [], '18'],
      ['health_center_manager', [], '18'],
      ['an_unrecognised_role_string', [], '18'],
      // The Command Center preference applies to the RESTORE landing for a dashboard.view holder.
      ['institution_admin', ['dashboard.view'], '22'],
    ];
    for (const [role, permissions, expected] of expectations) {
      publish({ role, permissions, canonical: CARE, verified: CARE, verifiedPending: false });
      const view = render(app());
      expect(shellScreen(), `${role} ${permissions.join(',')}`).toBe(expected);
      expect(mounted(), `${role} ${permissions.join(',')}`).toEqual([`screen-${expected}`]);
      view.unmount();
      clearRememberedScreen(USER);
      window.history.replaceState(null, '');
      h.frames = [];
    }
  });

  it('the REFUSAL landing stays roleLandingScreen (21) for a dashboard.view holder, while the restore landing is 22', () => {
    publish({ role: 'institution_admin', permissions: ['dashboard.view'], canonical: PDA, verified: PDA, verifiedPending: false });
    render(app());
    expect(shellScreen()).toBe('22');
    go(19);
    // Refused: the route renders roleLandingScreen (21), not the Command Center preference.
    expect(shellScreen()).toBe('21');
    expect(mounted()).toEqual(['screen-21']);
    expect(h.procurementRenders).toBe(0);
  });
});

describe('RT-C · the screen registry maps every id to the same screen', () => {
  const ADMIN = { role: 'super_admin', permissions: EVERY_PERMISSION, canonical: CARE, verified: CARE, verifiedPending: false } as const;

  it('direct screens (3,4,5,6,7,8,10,11,13,14,15,16,17,18,22,23) mount exactly their own screen for an authorized actor', () => {
    publish({ ...ADMIN });
    render(app());
    for (const id of [3, 4, 5, 6, 7, 8, 10, 11, 13, 14, 15, 16, 17, 18, 22, 23]) {
      go(id);
      expect(shellScreen(), `id ${id}`).toBe(String(id));
      expect(mounted(), `id ${id}`).toEqual([`screen-${id}`]);
    }
  });

  it('retired and unknown ids fall to the reports shell with the same initial tab as before', () => {
    publish({ ...ADMIN });
    render(app());
    const expectations: Array<[number, string]> = [[9, 'overview'], [12, 'materials'], [20, 'monthly'], [21, ''], [99, '']];
    for (const [id, tab] of expectations) {
      go(id);
      expect(shellScreen(), `id ${id}`).toBe(String(id));
      expect(mounted(), `id ${id}`).toEqual(['screen-21']);
      const shell = document.querySelector('[data-testid="screen-21"]');
      expect(shell?.getAttribute('data-initial-tab'), `id ${id}`).toBe(tab);
      expect(shell?.getAttribute('data-on-navigate'), `id ${id}`).toBe('function');
      expect(shell?.getAttribute('data-on-document'), `id ${id}`).toBe('function');
    }
  });

  it('the reports shell receives the LIVE navigation: a click on it moves the shell to Screen 3', () => {
    publish({ ...ADMIN });
    render(app());
    go(21);
    expect(shellScreen()).toBe('21');
    act(() => { screen.getByRole('button', { name: 'rt-nav-3' }).click(); });
    expect(shellScreen()).toBe('3');
    expect(mounted()).toEqual(['screen-3']);
  });

  it('capability-gated ids still need their capability (11, 14, 17, 22, 23), and a refusal lands on 21', () => {
    // Screen 11: only super_admin and institution_admin.
    publish({ role: 'warehouse_officer', canonical: CARE, verified: CARE, verifiedPending: false });
    const first = render(app());
    go(3);
    expect(shellScreen()).toBe('3');
    go(11);
    expect(shellScreen()).toBe('21');
    first.unmount();
    // Screen 14: users.view.
    publish({ role: 'institution_admin', canonical: CARE, verified: CARE, verifiedPending: false });
    const second = render(app());
    go(3);
    expect(shellScreen()).toBe('3');
    go(14);
    expect(shellScreen()).toBe('21');
    second.unmount();
    publish({ role: 'institution_admin', permissions: ['users.view'], canonical: CARE, verified: CARE, verifiedPending: false });
    const third = render(app());
    go(14);
    expect(shellScreen()).toBe('14');
    expect(mounted()).toEqual(['screen-14']);
    third.unmount();
    // Screen 23: central_warehouse_manager with central_needs.view.
    publish({ role: 'central_warehouse_manager', canonical: CARE, verified: CARE, verifiedPending: false });
    const fourth = render(app());
    go(3);
    expect(shellScreen()).toBe('3');
    go(23);
    expect(shellScreen()).toBe('21');
    fourth.unmount();
    publish({ role: 'central_warehouse_manager', permissions: ['central_needs.view'], canonical: CARE, verified: CARE, verifiedPending: false });
    render(app());
    go(23);
    expect(shellScreen()).toBe('23');
  });
});

// ── SO-1 — the route never reads the canonical organization kind ────────────

describe('SO-1 · AuthenticatedApp never reads the canonical organization kind', () => {
  it('has no activeOrganizationKind (or ...Pending) outside comments', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/AuthenticatedApp.tsx'), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
    expect(code).not.toMatch(/\bactiveOrganizationKind(Pending)?\b/);
    // The route consumes the verified pair; the legitimate 'care_institution' literals are
    // wait-probes that decide WAITING, never admission, and are not asserted here.
    expect(code).toMatch(/\bscreenOrganizationKind\b/);
    expect(code).toMatch(/\bscreenOrganizationKindPending\b/);
  });
});
