/** @vitest-environment jsdom */
/**
 * PDA-PROC-1 — continuity and the route choke point carry the active
 * organization kind.
 *
 * Part 1 drives the real screen-continuity module: a stored, restored or
 * Back-button Screen 19 resolves away for a pharmacy department authority or an
 * unknown kind.
 *
 * Part 2 renders the real AuthenticatedApp against a mocked useApp() and stub
 * screens, and follows an operator through organization switches: Screen 19 is
 * never mounted for a non-care organization, a pending kind read waits instead
 * of flashing the landing, and every non-19 screen still renders at once.
 */
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AppState } from '../AppContext';
import type { OrganizationKind } from '@/shared/lib/institution-hierarchy';
import {
  clearRememberedScreen,
  isScreenRestorable,
  rememberScreen,
  resolveRestoredScreen,
  screenFromPopState,
} from '../screen-continuity';

const h = vi.hoisted(() => ({ procurementRenders: 0 }));

let state: Partial<AppState> = {};

vi.mock('@/app/AppContext', () => ({
  useApp: () => state,
}));

vi.mock('@/shared/ui/PhoenixAppShell', () => ({
  // Renders its children (unlike the dead-end suite) because WHICH screen
  // mounts is the point here. The two buttons stand in for any navigation
  // surface, a deep link or a forged call to onNavigate.
  PhoenixAppShell: ({ currentScreen, onNavigate, children }: {
    currentScreen: number; onNavigate: (screen: number) => void; children: ReactNode;
  }) => (
    <div data-testid="app-shell" data-screen={currentScreen}>
      <button type="button" onClick={() => onNavigate(19)}>forge-19</button>
      <button type="button" onClick={() => onNavigate(3)}>go-3</button>
      {children}
    </div>
  ),
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
vi.mock('@/features/reports/DecisionIntelligenceReportsScreen', () => ({
  DecisionIntelligenceReportsScreen: () => <div data-testid="screen-21" />,
}));
vi.mock('@/features/command-center/CommandCenterScreen', () => ({
  CommandCenterScreen: () => <div data-testid="screen-22" />,
}));
vi.mock('@/features/central-needs/CentralNeedsScreen', () => ({
  CentralNeedsScreen: () => <div data-testid="screen-23" />,
}));

import { AuthenticatedApp } from '../AuthenticatedApp';

const CARE: OrganizationKind = 'care_institution';
const PDA: OrganizationKind = 'pharmacy_department_authority';
const USER = 'user-1';

const signOut = vi.fn(async () => undefined);
const retryAuthBootstrap = vi.fn(async () => undefined);
const retryProfileLoad = vi.fn(async () => undefined);

let base: Partial<AppState> = {};

/** One operator; the profile and permission objects stay stable, as AppContext keeps them. */
function actor(role: string, permissions: string[] = []) {
  base = {
    lang: 'en',
    authReady: true,
    authStatus: 'authenticated',
    session: { user: { id: USER } } as unknown as AppState['session'],
    profile: { id: USER, role, organization_id: 'org-care-a' } as unknown as AppState['profile'],
    role: role as AppState['role'],
    passwordRecovery: false,
    signOut,
    retryAuthBootstrap,
    retryProfileLoad,
    myPermissions: new Set(permissions),
  };
}

/** The organization-kind facts AppContext would publish for the active org. */
function org(kind: OrganizationKind | null, pending = false) {
  state = { ...base, activeOrganizationKind: kind, activeOrganizationKindPending: pending };
}

const app = () => <AuthenticatedApp />;

function shown(): string | null {
  return document.querySelector('[data-testid^="screen-"]')?.getAttribute('data-testid') ?? null;
}
const loading = () => screen.queryByTestId('loading-state') !== null;
function storedScreen(): number | null {
  const raw = window.sessionStorage.getItem(`medistock-phoenix-screen:${USER}`);
  return raw === null ? null : (JSON.parse(raw) as { screen: number }).screen;
}
function historyScreen(): number | null {
  const value = (window.history.state as { medistockPhoenixScreen?: { screen: number } } | null)
    ?.medistockPhoenixScreen;
  return value?.screen ?? null;
}
function popTo(entry: unknown) {
  // The browser has moved to `entry`; then it announces it.
  window.history.replaceState(entry, '');
  act(() => { window.dispatchEvent(new PopStateEvent('popstate', { state: entry })); });
}

beforeEach(() => {
  clearRememberedScreen(USER);
  window.sessionStorage.clear();
  window.history.replaceState(null, '');
  // The welcome sequence is not under test.
  window.sessionStorage.setItem(`medistock-phoenix-welcome:${USER}`, 'complete');
  h.procurementRenders = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Part 1 — the continuity module ──────────────────────────────────────────

describe('PDA-PROC-1 · screen continuity carries the organization kind', () => {
  it('isScreenRestorable(19) is true only for a care institution', () => {
    expect(isScreenRestorable(19, 'institution_admin', new Set(), CARE)).toBe(true);
    expect(isScreenRestorable(19, 'institution_admin', new Set(), PDA)).toBe(false);
    expect(isScreenRestorable(19, 'institution_admin', new Set(), null)).toBe(false);
    expect(isScreenRestorable(19, 'institution_admin', new Set())).toBe(false);
    expect(isScreenRestorable(19, 'super_admin', new Set(['users.view', 'dashboard.view']), PDA)).toBe(false);
    // Other restorable screens do not depend on the kind.
    for (const kind of [CARE, PDA, null]) {
      expect(isScreenRestorable(3, 'warehouse_officer', new Set(), kind)).toBe(true);
      expect(isScreenRestorable(21, 'warehouse_officer', new Set(), kind)).toBe(true);
    }
  });

  it('a stored 19 restores for care but resolves to the landing for PDA or an unknown kind', () => {
    rememberScreen(USER, 19, 'replace');
    expect(resolveRestoredScreen(USER, 'institution_admin', new Set(), CARE)).toBe(19);
    expect(resolveRestoredScreen(USER, 'institution_admin', new Set(), PDA)).toBe(21);
    expect(resolveRestoredScreen(USER, 'institution_admin', new Set(), null)).toBe(21);
    expect(resolveRestoredScreen(USER, 'institution_admin', new Set())).toBe(21);
    // The landing keeps the RAC-3 preference for a dashboard.view holder.
    expect(resolveRestoredScreen(USER, 'institution_admin', new Set(['dashboard.view']), PDA)).toBe(22);
  });

  it('a stored 19 from storage alone (no history entry) resolves the same way', () => {
    rememberScreen(USER, 19, 'storage-only');
    window.history.replaceState(null, '');
    expect(resolveRestoredScreen(USER, 'warehouse_officer', new Set(), CARE)).toBe(19);
    expect(resolveRestoredScreen(USER, 'warehouse_officer', new Set(), PDA)).toBe(21);
  });

  it('a Back/Forward entry for 19 resolves to the landing for PDA or an unknown kind', () => {
    rememberScreen(USER, 19, 'replace');
    const entry = window.history.state;
    expect(screenFromPopState(entry, USER, 'institution_admin', new Set(), CARE)).toBe(19);
    expect(screenFromPopState(entry, USER, 'institution_admin', new Set(), PDA)).toBe(21);
    expect(screenFromPopState(entry, USER, 'institution_admin', new Set(), null)).toBe(21);
    expect(screenFromPopState(entry, USER, 'institution_admin', new Set(['dashboard.view']), PDA)).toBe(22);
  });

  it('mandatory scenario: care -> 19 -> org becomes PDA -> stored and history 19 are both invalid', () => {
    rememberScreen(USER, 21, 'replace');
    rememberScreen(USER, 19, 'push');
    const entry19 = window.history.state;
    // While the care institution is active, 19 is a legitimate restore target.
    expect(resolveRestoredScreen(USER, 'warehouse_officer', new Set(), CARE)).toBe(19);
    // The organization switches to a pharmacy department authority.
    expect(resolveRestoredScreen(USER, 'warehouse_officer', new Set(), PDA)).toBe(21);
    expect(screenFromPopState(entry19, USER, 'warehouse_officer', new Set(), PDA)).toBe(21);
  });
});

// ── Part 2 — AuthenticatedApp ───────────────────────────────────────────────

describe('PDA-PROC-1 · AuthenticatedApp never mounts Screen 19 for a non-care organization', () => {
  it('care -> 19 -> org switches to PDA (pending, then settled): landing, 19 unmounted, storage and history replaced, Back refused', () => {
    actor('institution_admin');
    org(CARE);
    const view = render(app());
    expect(shown()).toBe('screen-21');

    fireEvent.click(screen.getByRole('button', { name: 'forge-19' }));
    expect(shown()).toBe('screen-19');
    expect(storedScreen()).toBe(19);
    expect(historyScreen()).toBe(19);
    const entry19 = window.history.state;
    const rendersOn19 = h.procurementRenders;
    expect(rendersOn19).toBeGreaterThan(0);

    // The org switch is in flight: kind null, pending. Screen 19 is gone at once.
    org(null, true);
    view.rerender(app());
    expect(shown()).toBeNull();
    expect(loading()).toBe(true);
    expect(h.procurementRenders).toBe(rendersOn19);
    // Nothing is rewritten while the kind is unknown.
    expect(storedScreen()).toBe(19);

    // It settles as a pharmacy department authority.
    org(PDA);
    view.rerender(app());
    expect(shown()).toBe('screen-21');
    expect(loading()).toBe(false);
    expect(h.procurementRenders).toBe(rendersOn19);
    expect(storedScreen()).toBe(21);
    expect(historyScreen()).toBe(21);

    // Back to the old 19 entry: refused, the landing stays.
    popTo(entry19);
    expect(shown()).toBe('screen-21');
    expect(storedScreen()).toBe(21);
    expect(h.procurementRenders).toBe(rendersOn19);
  });

  it('a dashboard.view holder stays on the route gate landing after the switch (no second remount), never on 19', () => {
    actor('institution_admin', ['dashboard.view']);
    org(CARE);
    const view = render(app());
    expect(shown()).toBe('screen-22');
    fireEvent.click(screen.getByRole('button', { name: 'forge-19' }));
    expect(shown()).toBe('screen-19');
    const rendersOn19 = h.procurementRenders;

    org(null, true);
    view.rerender(app());
    org(PDA);
    view.rerender(app());
    // The route gate refuses 19 and renders roleLandingScreen (21); the settled
    // normalisation keeps exactly that screen instead of swapping it for the
    // Command Center one commit later (no flash, no remount of the landing).
    expect(shown()).toBe('screen-21');
    // Storage and history keep the continuity landing (the RAC-3 preference),
    // exactly as they already do when a permission change refuses a screen.
    expect(storedScreen()).toBe(22);
    expect(historyScreen()).toBe(22);
    expect(h.procurementRenders).toBe(rendersOn19);
  });

  it('pending + stored 19: a loading state (no 19, no landing flash), then care opens 19', () => {
    rememberScreen(USER, 19, 'replace');
    actor('warehouse_officer');
    org(null, true);
    const view = render(app());
    expect(loading()).toBe(true);
    expect(shown()).toBeNull();
    expect(h.procurementRenders).toBe(0);
    expect(storedScreen()).toBe(19);
    expect(historyScreen()).toBe(19);

    org(CARE);
    view.rerender(app());
    expect(loading()).toBe(false);
    expect(shown()).toBe('screen-19');
    expect(storedScreen()).toBe(19);
  });

  it('pending + stored 19, then PDA: the landing, and Screen 19 never rendered', () => {
    rememberScreen(USER, 19, 'replace');
    actor('warehouse_officer');
    org(null, true);
    const view = render(app());
    expect(loading()).toBe(true);

    org(PDA);
    view.rerender(app());
    expect(shown()).toBe('screen-21');
    expect(h.procurementRenders).toBe(0);
    expect(storedScreen()).toBe(21);
    expect(historyScreen()).toBe(21);
  });

  it('pending + a non-19 restore renders immediately, with no global loading state', () => {
    rememberScreen(USER, 3, 'replace');
    actor('warehouse_officer');
    org(null, true);
    const view = render(app());
    expect(loading()).toBe(false);
    expect(shown()).toBe('screen-3');

    org(PDA);
    view.rerender(app());
    expect(shown()).toBe('screen-3');
    expect(storedScreen()).toBe(3);
  });

  it('pending with nothing stored renders the landing immediately', () => {
    actor('warehouse_officer');
    org(null, true);
    render(app());
    expect(loading()).toBe(false);
    expect(shown()).toBe('screen-21');
  });

  it('F1: care -> 19 -> PDA -> care B stays on the landing; 19 does not come back by itself', () => {
    actor('institution_admin');
    org(CARE);
    const view = render(app());
    fireEvent.click(screen.getByRole('button', { name: 'forge-19' }));
    expect(shown()).toBe('screen-19');
    const rendersOn19 = h.procurementRenders;

    org(null, true);
    view.rerender(app());
    org(PDA);
    view.rerender(app());
    expect(shown()).toBe('screen-21');

    // Switch to another care institution B.
    org(null, true);
    view.rerender(app());
    expect(loading()).toBe(false);
    expect(shown()).toBe('screen-21');
    org(CARE);
    view.rerender(app());
    expect(shown()).toBe('screen-21');
    expect(storedScreen()).toBe(21);
    expect(h.procurementRenders).toBe(rendersOn19);
  });

  it('a forged or direct navigation to 19 is refused for PDA: no mount, nothing remembered', () => {
    actor('institution_admin');
    org(PDA);
    render(app());
    expect(shown()).toBe('screen-21');
    fireEvent.click(screen.getByRole('button', { name: 'forge-19' }));
    expect(shown()).toBe('screen-21');
    expect(h.procurementRenders).toBe(0);
    expect(storedScreen()).not.toBe(19);
    expect(historyScreen()).not.toBe(19);
  });

  it('super_admin is not a bypass: PDA or "all organizations" (no org, kind null) refuses 19', () => {
    const everything = ['users.view', 'users.edit_scope', 'warehouse_transfer.send', 'central_needs.view'];
    for (const kind of [PDA, null] as const) {
      actor('super_admin', everything);
      org(kind);
      const view = render(app());
      fireEvent.click(screen.getByRole('button', { name: 'forge-19' }));
      expect(shown(), String(kind)).toBe('screen-21');
      expect(h.procurementRenders, String(kind)).toBe(0);
      expect(storedScreen(), String(kind)).not.toBe(19);
      view.unmount();
    }
  });

  it('a stored 19 is never restored into for PDA on a fresh load', () => {
    rememberScreen(USER, 19, 'replace');
    actor('institution_admin');
    org(PDA);
    render(app());
    expect(shown()).toBe('screen-21');
    expect(h.procurementRenders).toBe(0);
    expect(storedScreen()).toBe(21);
    expect(historyScreen()).toBe(21);
  });

  it('a Back entry for 19 popped while the kind is pending waits, then opens for care', () => {
    actor('institution_admin');
    org(CARE);
    const view = render(app());
    fireEvent.click(screen.getByRole('button', { name: 'forge-19' }));
    const entry19 = window.history.state;
    fireEvent.click(screen.getByRole('button', { name: 'go-3' }));
    expect(shown()).toBe('screen-3');

    org(null, true);
    view.rerender(app());
    expect(shown()).toBe('screen-3');

    popTo(entry19);
    expect(loading()).toBe(true);
    expect(shown()).toBeNull();

    org(CARE);
    view.rerender(app());
    expect(shown()).toBe('screen-19');
  });

  it('a Back entry for 19 popped while pending resolves to the landing once the kind settles as PDA', () => {
    actor('institution_admin');
    org(CARE);
    const view = render(app());
    fireEvent.click(screen.getByRole('button', { name: 'forge-19' }));
    const entry19 = window.history.state;
    fireEvent.click(screen.getByRole('button', { name: 'go-3' }));
    const rendersOn19 = h.procurementRenders;

    org(null, true);
    view.rerender(app());
    popTo(entry19);
    expect(loading()).toBe(true);

    org(PDA);
    view.rerender(app());
    expect(shown()).toBe('screen-21');
    expect(storedScreen()).toBe(21);
    expect(historyScreen()).toBe(21);
    expect(h.procurementRenders).toBe(rendersOn19);
  });
});
