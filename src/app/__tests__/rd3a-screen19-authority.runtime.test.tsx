/** @vitest-environment jsdom */
/**
 * RD-3A — Screen 19 is gated by the AUTHORITY-VERIFIED kind of the active
 * organization, through the REAL AppProvider and the REAL AuthenticatedApp.
 *
 * Contract under test: the screen gates read `screenOrganizationKind`. It equals
 * `activeOrganizationKind` only for the caller's freshly verified primary
 * organization, or for a super_admin's verified selected organization. A delegated
 * or unverified organization, a superseded re-check, a missing or failed read, an
 * inactive or revoked profile, and any pending answer all deny. The public
 * `activeOrganizationKind` stays unchanged for every other consumer.
 *
 * Ordering is controlled with deferred promises, never with sleeps.
 */
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import type { Profile, ProfileLoad, SessionLoad } from '@/shared/supabase/services/auth.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';
import type { OrganizationKind } from '@/shared/lib/institution-hierarchy';
import type { AuthorizationService } from '@/shared/authz/authorization';

/**
 * Recorders shared with the mocked shell and the Screen 19 stand-in (hoisted so the
 * vi.mock factories can reach them). `frames` holds one entry per committed shell
 * render: the screen content mounted at that commit (`screen-N`, `loading-state`, or
 * `none`), which the shell prop alone cannot show.
 */
const h = vi.hoisted(() => ({
  frames: [] as string[],
  /** Screen 19 stand-in: mounts, unmounts and the id minted at mount (a DirectEntryPanel requestId analogue). */
  mounts19: 0,
  unmounts19: 0,
  requestIds: [] as number[],
}));

const getSessionResult = vi.fn<() => Promise<SessionLoad>>();
const getMyProfileResult = vi.fn<() => Promise<ProfileLoad>>();
const signIn = vi.fn<(email: string, password: string) => Promise<{ ok: boolean }>>();
const signOut = vi.fn<() => Promise<void>>();
const onAuthChange = vi.fn<(cb: unknown) => () => void>();
const getOrganization = vi.fn<(id: string) => Promise<OrgRow | null>>();
const getEffectivePermissions =
  vi.fn<(id: string) => Promise<{ permissions: Record<string, boolean> | null }>>();

vi.mock('@/shared/supabase/client', () => ({ supabaseConfigured: true, supabase: {} }));

vi.mock('@/shared/supabase/services/auth.service', () => ({
  getSessionResult: () => getSessionResult(),
  getMyProfileResult: () => getMyProfileResult(),
  onAuthChange: (cb: unknown) => onAuthChange(cb),
  signIn: (email: string, password: string) => signIn(email, password),
  signOut: () => signOut(),
  requestPasswordReset: vi.fn(),
  updatePassword: vi.fn(),
}));

vi.mock('@/shared/supabase/services/users.service', () => ({
  getEffectivePermissions: (id: string) => getEffectivePermissions(id),
}));

vi.mock('@/shared/supabase/services/organizations.service', () => ({
  getOrganization: (id: string) => getOrganization(id),
}));

// The shell is a stand-in: it renders its children and two navigation controls (forge-19, go-3) and
// records the committed content of every render.
vi.mock('@/shared/ui/PhoenixAppShell', () => ({
  PhoenixAppShell: ({ currentScreen, onNavigate, children }: {
    currentScreen: number; onNavigate: (screen: number) => void; children: ReactNode;
  }) => {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      const ids = Array.from(ref.current?.querySelectorAll('[data-testid]') ?? [])
        .map(node => node.getAttribute('data-testid') ?? '')
        .filter(id => /^(screen-\d+|loading-state)$/.test(id));
      h.frames.push(ids.join('+') || 'none');
    });
    return (
      <div ref={ref} data-testid="app-shell" data-screen={currentScreen}>
        <button type="button" onClick={() => onNavigate(19)}>forge-19</button>
        <button type="button" onClick={() => onNavigate(3)}>go-3</button>
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
// The welcome step is not under test: complete it as soon as it mounts.
vi.mock('@/features/auth/PhoenixWelcomeExperience', () => ({
  PhoenixWelcomeExperience: ({ onComplete }: { onComplete: () => void }) => {
    useEffect(() => { onComplete(); }, [onComplete]);
    return null;
  },
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
// A stand-in for Screen 19 that keeps local state minted at mount, as DirectEntryPanel mints its
// idempotency `requestId` (DirectEntryPanel.tsx:42). It lets RT-E show what a remount costs
// without mounting the real panels (which need many services). It is a characterization aid,
// not a replacement for the real panel.
vi.mock('@/features/procurement/LocalProcurementScreen', () => ({
  LocalProcurementScreen: () => {
    const [requestId] = useState(() => {
      h.requestIds.push(h.requestIds.length + 1);
      return h.requestIds.length;
    });
    useEffect(() => {
      h.mounts19 += 1;
      return () => { h.unmounts19 += 1; };
    }, []);
    return <div data-testid="screen-19" data-request-id={requestId} />;
  },
}));
vi.mock('@/features/reports/DecisionIntelligenceReportsScreen', () => ({
  DecisionIntelligenceReportsScreen: () => <div data-testid="screen-21" />,
}));
vi.mock('@/features/command-center/CommandCenterScreen', () => ({
  CommandCenterScreen: () => <div data-testid="screen-22" />,
}));
vi.mock('@/features/central-needs/AnnualNeedsEntryScreen', () => ({
  AnnualNeedsEntryScreen: () => <div data-testid="screen-23" />,
}));

import { AppProvider, useApp } from '../AppContext';
import { AuthenticatedApp } from '../AuthenticatedApp';
import { clearRememberedScreen, rememberScreen } from '../screen-continuity';
import { AUTH_PROFILE_DEADLINE_MS } from '@/shared/lib/deadline';

type AuthCallback = (event: AuthChangeEvent, session: Session | null) => Promise<void> | void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const ORG_CARE_A = 'org-care-a';
const ORG_CARE_B = 'org-care-b';
const ORG_PDA = 'org-pda';
const USER = 'user-1';
const SUPER = 'super-1';

const KIND_OF: Record<string, OrganizationKind> = {
  [ORG_CARE_A]: 'care_institution',
  [ORG_CARE_B]: 'care_institution',
  [ORG_PDA]: 'pharmacy_department_authority',
};

function orgRow(id: string, organizationKind: OrganizationKind | null = KIND_OF[id] ?? null): OrgRow {
  return {
    id, name: id, name_ar: id, code: id, status: 'active', city: '', contact_email: '',
    organizationKind,
    institutionClass: organizationKind === 'care_institution' ? 'hospital' : null,
  };
}

function profileFor(id: string, over: Partial<Profile> = {}): Profile {
  return {
    id,
    organization_id: ORG_CARE_A,
    full_name: `Operator ${id}`,
    role: 'warehouse_officer',
    status: 'active',
    username: null,
    login_mode: 'email',
    contact_email: null,
    must_change_password: false,
    whatsapp_phone: null,
    ...over,
  };
}

const sessionFor = (id: string) => ({ user: { id } }) as unknown as Session;

let authCallback: AuthCallback = () => undefined;

interface Seen {
  profile: string | null; org: string | null;
  /** The signed-in profile's role and OWN organization, so the invariant below needs no literal org. */
  role: string | null; profileOrg: string | null; status: string;
  kind: OrganizationKind | null; screenKind: OrganizationKind | null; screenPending: boolean;
}
let renders: Seen[] = [];
/** The provider's authorization service and the exact objects it last published (RT-D). */
let authzSeen: AuthorizationService | null = null;
const published: { profile: unknown; permissions: unknown }[] = [];

function Probe() {
  const app = useApp();
  authzSeen = app.authz;
  published.push({ profile: app.profile, permissions: app.myPermissions });
  renders.push({
    profile: app.profile?.id ?? null,
    org: app.activeOrgId,
    role: app.profile?.role ?? null,
    profileOrg: app.profile?.organization_id ?? null,
    status: app.authStatus,
    kind: app.activeOrganizationKind,
    screenKind: app.screenOrganizationKind ?? null,
    screenPending: app.screenOrganizationKindPending ?? false,
  });
  return (
    <div>
      <span data-testid="status">{app.authStatus}</span>
      <span data-testid="org">{app.activeOrgId ?? 'null'}</span>
      <span data-testid="kind">{app.activeOrganizationKind ?? 'null'}</span>
      <span data-testid="screen-kind">{app.screenOrganizationKind ?? 'null'}</span>
      <span data-testid="screen-pending">{String(app.screenOrganizationKindPending ?? false)}</span>
      <button onClick={() => app.setActiveOrgId(ORG_CARE_A)}>org-care-a</button>
      <button onClick={() => app.setActiveOrgId(ORG_CARE_B)}>org-care-b</button>
      <button onClick={() => app.setActiveOrgId(ORG_PDA)}>org-pda</button>
      <button onClick={() => app.setActiveOrgId(null)}>org-all</button>
    </div>
  );
}

const mount = () => render(
  <AppProvider>
    <Probe />
    <AuthenticatedApp />
  </AppProvider>,
);
const val = (id: string) => screen.getByTestId(id).textContent;
const screenKind = () => val('screen-kind');
const screenPending = () => val('screen-pending');

/**
 * The mounted Screen N stubs. The Probe's own `screen-kind` / `screen-pending` spans also start
 * with "screen-", so a prefix selector would first-match them and make every "not screen-19"
 * assertion vacuous. Only `screen-<digits>` counts here.
 */
function mountedScreens(): string[] {
  return Array.from(document.querySelectorAll('[data-testid]'))
    .map(node => node.getAttribute('data-testid') ?? '')
    .filter(id => /^screen-\d+$/.test(id));
}
const loadingShown = () => screen.queryByTestId('loading-state') !== null;

async function click(name: string) {
  await act(async () => { screen.getByRole('button', { name }).click(); });
}

async function emitAuthEvent(event: AuthChangeEvent, session: Session | null) {
  await act(async () => { void authCallback(event, session); });
}

/** Sign in through the real bootstrap and wait for the shell to be authenticated. */
async function signInAs(profile: Profile) {
  getSessionResult.mockResolvedValue({ status: 'ok', session: sessionFor(profile.id) });
  getMyProfileResult.mockResolvedValue({ status: 'ok', profile });
  mount();
  await waitFor(() => expect(val('status')).toBe('authenticated'));
}

/**
 * The screen gate never admits an organization the caller has not verified. A non-super caller
 * is verified only for its OWN organization (so a non-null screen kind needs the active org to
 * equal the profile's own); a super_admin is verified for the organization it selected.
 */
function expectNoUnverifiedScreenKindEverRendered() {
  expect(renders.length).toBeGreaterThan(0);
  for (const r of renders) {
    if (r.screenKind === null) continue;
    if (r.role === 'super_admin') {
      expect(r.screenKind, JSON.stringify(r)).toBe(KIND_OF[r.org as string]);
    } else {
      expect(r.org, JSON.stringify(r)).toBe(r.profileOrg);
      expect(r.screenKind, JSON.stringify(r)).toBe(KIND_OF[r.org as string]);
    }
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  renders = [];
  published.length = 0;
  authzSeen = null;
  h.frames = [];
  clearRememberedScreen(USER);
  clearRememberedScreen('user-2');
  h.mounts19 = 0;
  h.unmounts19 = 0;
  h.requestIds = [];
  window.sessionStorage.clear();
  window.history.replaceState(null, '');
  onAuthChange.mockImplementation((cb) => {
    authCallback = cb as AuthCallback;
    return () => undefined;
  });
  signOut.mockResolvedValue(undefined);
  signIn.mockResolvedValue({ ok: true });
  getEffectivePermissions.mockResolvedValue({ permissions: { 'reports.view': true } });
  getOrganization.mockImplementation(async (id: string) => orgRow(id));
});

afterEach(() => {
  expectNoUnverifiedScreenKindEverRendered();
  cleanup();
  vi.useRealTimers();
});

describe('RD-3A · the home organization is the only organization a non-super caller can open Screen 19 in', () => {
  it('home care + active home care: eligible under the existing rules, and Screen 19 mounts after re-check', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    expect(screenPending()).toBe('false');

    await click('forge-19');
    await waitFor(() => expect(screen.getByTestId('screen-19')).toBeInTheDocument());
  });

  it('home care + active delegated PDA: DENIED, while the public activeOrganizationKind still reports the PDA', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));

    await click('org-pda');
    await waitFor(() => expect(val('kind')).toBe('pharmacy_department_authority'));
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(screenKind()).toBe('null');

    await click('forge-19');
    await waitFor(() => expect(screen.queryByTestId('screen-19')).toBeNull());
  });

  it('home care + active foreign care without authorized kind access: DENIED even though its kind is care', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));

    await click('org-care-b');
    await waitFor(() => expect(val('kind')).toBe('care_institution'));
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(screenKind()).toBe('null');
    expect(val('org')).toBe(ORG_CARE_B);
  });

  it('returning to the home care organization restores eligibility after a fresh re-check', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('org-pda');
    await waitFor(() => expect(screenKind()).toBe('null'));

    await click('org-care-a');
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    expect(screenPending()).toBe('false');
  });
});

describe('RD-3A · super_admin keeps the organization-kind restriction', () => {
  it('super_admin + selected care institution: allowed under the current rules', async () => {
    await signInAs(profileFor(SUPER, { role: 'super_admin', organization_id: null }));
    await click('org-care-a');
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
  });

  it('super_admin + selected PDA: DENIED at the route, although the verified kind is the PDA', async () => {
    await signInAs(profileFor(SUPER, { role: 'super_admin', organization_id: null }));
    await click('org-pda');
    await waitFor(() => expect(val('kind')).toBe('pharmacy_department_authority'));
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(screenKind()).toBe('pharmacy_department_authority');

    await click('forge-19');
    await waitFor(() => expect(screen.queryByTestId('screen-19')).toBeNull());
  });
});

describe('RD-3A · null, unknown, pending, inactive, failed and revoked authority all deny', () => {
  it('a pending kind read holds the gate as pending, and a settled care answer then admits', async () => {
    const read = deferred<OrgRow | null>();
    getOrganization.mockReturnValueOnce(read.promise);
    await signInAs(profileFor(USER));
    expect(screenKind()).toBe('null');
    expect(screenPending()).toBe('true');

    await act(async () => { read.resolve(orgRow(ORG_CARE_A)); await read.promise; });
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    expect(screenPending()).toBe('false');
  });

  it('an unrecognised kind is denied', async () => {
    getOrganization.mockImplementation(async (id: string) => orgRow(id, null));
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(screenKind()).toBe('null');
  });

  it('an inactive profile is denied: the screen gate is null', async () => {
    getMyProfileResult.mockResolvedValue({ status: 'ok', profile: profileFor(USER, { status: 'suspended' }) });
    getSessionResult.mockResolvedValue({ status: 'ok', session: sessionFor(USER) });
    mount();
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(screenKind()).toBe('null');
  });

  it('a failed re-read on Screen 19 entry is denied', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));

    getMyProfileResult.mockResolvedValueOnce({ status: 'failed' });
    await click('forge-19');
    await waitFor(() => expect(screen.queryByTestId('screen-19')).toBeNull());
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(screenKind()).toBe('null');
  });

  it('a revoked primary organization (server moved the user) is denied on the next entry', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));

    getMyProfileResult.mockResolvedValueOnce({ status: 'ok', profile: profileFor(USER, { organization_id: ORG_CARE_B }) });
    await click('forge-19');
    await waitFor(() => expect(screen.queryByTestId('screen-19')).toBeNull());
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(screenKind()).toBe('null');
  });
});

describe('RD-3A · stale, superseded and passive events', () => {
  it('a rapid switch to PDA discards the superseded care re-check, which can never admit', async () => {
    await signInAs(profileFor(SUPER, { role: 'super_admin', organization_id: null }));
    const stale = deferred<ProfileLoad>();
    getMyProfileResult.mockReturnValueOnce(stale.promise);
    await click('org-care-a');
    await click('org-pda');
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(screenKind()).toBe('pharmacy_department_authority');

    await act(async () => {
      stale.resolve({ status: 'ok', profile: profileFor(SUPER, { role: 'super_admin', organization_id: null }) });
      await stale.promise;
    });
    // The superseded answer for the care selection was discarded: the state
    // still describes the PDA selection, and Screen 19 stays closed.
    expect(val('org')).toBe(ORG_PDA);
    expect(screenKind()).toBe('pharmacy_department_authority');
    expect(screenPending()).toBe('false');
    await click('forge-19');
    await waitFor(() => expect(screen.queryByTestId('screen-19')).toBeNull());
  });

  it('an ordinary passive token refresh neither re-reads the profile nor resets the organization', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    const profileReads = getMyProfileResult.mock.calls.length;

    await emitAuthEvent('TOKEN_REFRESHED', sessionFor(USER));
    expect(getMyProfileResult.mock.calls.length).toBe(profileReads);
    expect(val('org')).toBe(ORG_CARE_A);
    expect(screenKind()).toBe('care_institution');
  });

  it('entering Screen 19 re-checks the caller once and admits only after the re-check settles', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    const before = getMyProfileResult.mock.calls.length;

    await click('forge-19');
    await waitFor(() => expect(screen.getByTestId('screen-19')).toBeInTheDocument());
    expect(getMyProfileResult.mock.calls.length).toBe(before + 1);
  });

  it('a Back entry to Screen 19 is refused when the active organization is not verified', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('forge-19');
    await waitFor(() => expect(screen.getByTestId('screen-19')).toBeInTheDocument());

    await click('org-pda');
    await waitFor(() => expect(screenKind()).toBe('null'));
    await waitFor(() => expect(screen.queryByTestId('screen-19')).toBeNull());

    rememberScreen(USER, 19, 'push');
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    });
    await waitFor(() => expect(screen.queryByTestId('screen-19')).toBeNull());
    expect(screenKind()).toBe('null');
  });

  it('a Back entry to Screen 19 opens only after the re-check settles for the verified home organization', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    rememberScreen(USER, 19, 'push');

    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    });
    await waitFor(() => expect(screen.getByTestId('screen-19')).toBeInTheDocument());
  });

  it('the re-check is bounded: a read that never answers settles as denied at the deadline', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));

    getMyProfileResult.mockReturnValueOnce(new Promise<ProfileLoad>(() => undefined));
    await click('forge-19');
    expect(screenPending()).toBe('true');
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTH_PROFILE_DEADLINE_MS + 1000); });
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(screenKind()).toBe('null');
    expect(screen.queryByTestId('screen-19')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CI-1 additions. RT-B, RT-D, RT-F prove behaviour; RT-E characterizes KNOWN
// RESIDUAL risks. A passing characterization is NOT remediation: it records
// the behaviour that exists today so a later fix has to flip it deliberately.
//
// Director findings: R-2 (an already-active Screen 19 revalidation unmounts the
// form and discards its in-flight idempotency key) is rated HIGH and blocks RD-3A
// final acceptance and PR merge; R-1 (mounted-screen revocation) and ROLE-1
// (permissive normalization of unknown role strings) are OPEN. The R-1, R-2 and
// ROLE-1 tests below, and the USER_UPDATED remount test in RT-F, only characterize
// the behaviour that exists today. None of them fixes anything.
// ═══════════════════════════════════════════════════════════════════════════

const other = (id: string, over: Partial<Profile> = {}) => profileFor(id, over);
const lastRender = () => renders[renders.length - 1];

/** Same session wiring as a real device: user B's session arrives while A is signed in. */
async function switchToUser(profile: Profile) {
  getMyProfileResult.mockResolvedValue({ status: 'ok', profile });
  await emitAuthEvent('SIGNED_IN', sessionFor(profile.id));
  await waitFor(() => {
    expect(val('status')).toBe('authenticated');
    expect(lastRender().profile).toBe(profile.id);
  });
}

/**
 * The welcome sequence renders INSTEAD of the shell on the first authenticated commit and gives the
 * restoration effect time to run, which would hide the first-frame fallback RT-B exists to observe.
 * Mark it complete for these identities so the shell is the first thing committed.
 */
function skipWelcome(...ids: string[]) {
  for (const id of ids) window.sessionStorage.setItem(`medistock-phoenix-welcome:${id}`, 'complete');
}

describe('RT-B · first frame and profile-scoped restoration (the committed content of every render is recorded)', () => {
  it('a stored 19 for the verified home care organization restores straight to 19: only loading and 19 are ever committed, never a landing', async () => {
    skipWelcome(USER);
    rememberScreen(USER, 19, 'replace');
    await signInAs(profileFor(USER));
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));
    expect(h.frames.length).toBeGreaterThan(0);
    for (const frame of h.frames) expect(['loading-state', 'screen-19'], frame).toContain(frame);
    expect(h.frames[h.frames.length - 1]).toBe('screen-19');
  });

  it('after a switch to an unverified organization no later frame is Screen 19: a transient loading, then the landing', async () => {
    skipWelcome(USER);
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));
    const mark = h.frames.length;

    // Hold the re-check open (a real one is a network round trip), so the transient is observable.
    const slow = deferred<ProfileLoad>();
    getMyProfileResult.mockReturnValueOnce(slow.promise);
    await click('org-care-b');
    expect(screenPending()).toBe('true');
    expect(h.frames.slice(mark)[0]).toBe('loading-state');
    expect(h.frames.slice(mark)).not.toContain('screen-19');

    await act(async () => { slow.resolve({ status: 'ok', profile: profileFor(USER) }); await slow.promise; });
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(screenKind()).toBe('null');
    const after = h.frames.slice(mark);
    expect(after.length).toBeGreaterThan(0);
    for (const frame of after) expect(['loading-state', 'screen-21'], frame).toContain(frame);
    expect(after[after.length - 1]).toBe('screen-21');
    expect(mountedScreens()).toEqual(['screen-21']);
  });

  it('a screen that was normalised away for an unverified organization does not come back when the operator returns to the verified home organization', async () => {
    skipWelcome(USER);
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));

    // care A -> 19 -> foreign care B: the screen is refused and the in-memory navigation normalised.
    await click('org-care-b');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-21']));
    expect(screenKind()).toBe('null');

    // Back to the eligible home organization: 19 does not resurrect by itself ...
    await click('org-care-a');
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    expect(screenPending()).toBe('false');
    expect(mountedScreens()).toEqual(['screen-21']);
    expect(h.mounts19).toBe(1);

    // ... and an explicit navigation still opens it (positive control).
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));
    expect(h.mounts19).toBe(2);
  });

  it('outlet_officer with nothing stored: every committed frame is its role landing 18, never the reports landing', async () => {
    skipWelcome(USER);
    await signInAs(profileFor(USER, { role: 'outlet_officer' }));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    expect(h.frames.length).toBeGreaterThan(0);
    for (const frame of h.frames) expect(frame).toBe('screen-18');
  });

  it('a different identity never inherits the previous identity\'s screen: B (switched in directly) lands on its own landing, never A\'s screen 3', async () => {
    skipWelcome(USER, 'user-2');
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('go-3');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-3']));
    const mark = h.frames.length;

    await switchToUser(other('user-2'));
    await waitFor(() => expect(h.frames.length).toBeGreaterThan(mark));
    const after = h.frames.slice(mark);
    expect(after).not.toContain('screen-3');
    for (const frame of after) expect(['loading-state', 'screen-21'], frame).toContain(frame);
    expect(mountedScreens()).toEqual(['screen-21']);
  });

  it('after a SIGNED_OUT auth event and a new sign-in, B still lands on its own landing, never A\'s screen 3 (profile-id scoping; handleLogout itself is not exercised)', async () => {
    skipWelcome(USER, 'user-2');
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('go-3');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-3']));

    await emitAuthEvent('SIGNED_OUT', null);
    await waitFor(() => expect(val('status')).not.toBe('authenticated'));
    const mark = h.frames.length;
    await switchToUser(other('user-2'));
    await waitFor(() => expect(h.frames.length).toBeGreaterThan(mark));
    const after = h.frames.slice(mark);
    expect(after).not.toContain('screen-3');
    expect(mountedScreens()).toEqual(['screen-21']);
  });
});

describe('RT-D · identity and authorization machinery is unchanged by the authority check', () => {
  it('the authorization context mirrors session, profile and permissions; it never defaults a role upward; it is anonymous after sign-out', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    const ctx = authzSeen!.getContext();
    expect(ctx.authenticated).toBe(true);
    expect(ctx.profileId).toBe(USER);
    expect(ctx.role).toBe('warehouse_officer');
    expect(ctx.organizationId).toBe(ORG_CARE_A);
    expect([...ctx.legacyPermissions]).toEqual(['reports.view']);

    await emitAuthEvent('SIGNED_OUT', null);
    await waitFor(() => expect(val('status')).not.toBe('authenticated'));
    const after = authzSeen!.getContext();
    expect(after.authenticated).toBe(false);
    expect(after.profileId).toBeNull();
    expect(after.role).toBeNull();
    expect(after.organizationId).toBeNull();
    expect(after.legacyPermissions.size).toBe(0);
  });

  it('a profile that failed to load leaves the authorization role null: it is not authorized as a viewer', async () => {
    getSessionResult.mockResolvedValue({ status: 'ok', session: sessionFor(USER) });
    getMyProfileResult.mockResolvedValue({ status: 'failed' });
    mount();
    await waitFor(() => expect(val('status')).toBe('profile_failed'));
    const ctx = authzSeen!.getContext();
    // The session IS held, so the context was published (positive control that setContext ran) ...
    expect(ctx.authenticated).toBe(true);
    // ... yet no role is invented for the missing profile.
    expect(ctx.role).toBeNull();
    expect(ctx.profileId).toBeNull();
  });

  it('a re-check never replaces the profile, the permissions or the authorization context, never reloads permissions and never signs out', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    const adoptedProfile = published[published.length - 1].profile;
    const adoptedPermissions = published[published.length - 1].permissions;
    const ctx = authzSeen!.getContext();
    const profileReads = getMyProfileResult.mock.calls.length;
    const permissionReads = getEffectivePermissions.mock.calls.length;
    const mark = renders.length;

    // The re-check answers with a FRESH, field-different object: if the provider adopted it, the
    // published profile reference would change, so "same reference" below is not vacuous.
    getMyProfileResult.mockResolvedValueOnce({ status: 'ok', profile: profileFor(USER, { full_name: 'Renamed' }) });
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));

    expect(getMyProfileResult.mock.calls.length).toBe(profileReads + 1);
    expect(getEffectivePermissions.mock.calls.length).toBe(permissionReads);
    expect(signOut).not.toHaveBeenCalled();
    expect(published[published.length - 1].profile).toBe(adoptedProfile);
    expect(published[published.length - 1].permissions).toBe(adoptedPermissions);
    expect(authzSeen!.getContext()).toBe(ctx);
    for (const r of renders.slice(mark)) expect(r.status, JSON.stringify(r)).toBe('authenticated');
  });

  it('selecting an organization takes effect in the same act, null clears it, and neither touches profile, permissions or the authorization context', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    const adoptedProfile = published[published.length - 1].profile;
    const adoptedPermissions = published[published.length - 1].permissions;
    const ctx = authzSeen!.getContext();

    await click('org-pda');
    expect(val('org')).toBe(ORG_PDA);
    await click('org-all');
    expect(val('org')).toBe('null');
    await click('org-care-a');
    expect(val('org')).toBe(ORG_CARE_A);
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    expect(published[published.length - 1].profile).toBe(adoptedProfile);
    expect(published[published.length - 1].permissions).toBe(adoptedPermissions);
    expect(authzSeen!.getContext()).toBe(ctx);
  });
});

describe('RT-E · KNOWN RESIDUALS (characterization of current behaviour; NOT remediation)', () => {
  it('R-1 (OPEN): a revoked profile does not close a MOUNTED Screen 19 without a trigger; only a real trigger re-checks', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));
    const reads = getMyProfileResult.mock.calls.length;

    // The server now says the profile is suspended.
    getMyProfileResult.mockResolvedValue({ status: 'ok', profile: profileFor(USER, { status: 'suspended' }) });
    // None of these is an authority trigger: a token refresh, a tab-refocus SIGNED_IN for the
    // applied user, and focus / visibility / online browser events.
    await emitAuthEvent('TOKEN_REFRESHED', sessionFor(USER));
    await emitAuthEvent('SIGNED_IN', sessionFor(USER));
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('online'));
    });
    await act(async () => { await Promise.resolve(); });
    expect(getMyProfileResult.mock.calls.length).toBe(reads);
    expect(mountedScreens()).toEqual(['screen-19']);
    expect(screenKind()).toBe('care_institution');
    expect(screenPending()).toBe('false');

    // Positive control: a Back/Forward entry IS a trigger, re-checks, and the denial closes the screen.
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    });
    // Settled denial (not merely a pending re-check, which also shows no screen and a null kind).
    await waitFor(() => expect(screenPending()).toBe('false'));
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-21']));
    expect(getMyProfileResult.mock.calls.length).toBe(reads + 1);
    expect(screenKind()).toBe('null');
  });

  it('R-2 (CI-3 regression, previously an OPEN residual): re-activating the already-active Screen 19 keeps the mounted workspace; the re-check hides it and never remounts it', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));
    expect(h.mounts19).toBe(1);
    expect(h.requestIds).toEqual([1]);
    expect(screen.getByTestId('screen-19').getAttribute('data-request-id')).toBe('1');

    // The Sidebar, Drawer and Palette have no same-screen guard: activating the entry of the screen
    // that is already shown calls onNavigate(19) again. The re-check is held open with a deferred
    // promise, as it is a network round trip in production.
    const slow = deferred<ProfileLoad>();
    getMyProfileResult.mockReturnValueOnce(slow.promise);
    await click('forge-19');
    expect(screenPending()).toBe('true');
    expect(loadingShown()).toBe(true);
    // Still mounted, so its state is kept, but hidden and unreachable until the check settles.
    expect(mountedScreens()).toEqual(['screen-19']);
    expect(screen.getByTestId('screen-19').closest('[hidden]')).not.toBeNull();
    expect(h.unmounts19).toBe(0);

    await act(async () => { slow.resolve({ status: 'ok', profile: profileFor(USER) }); await slow.promise; });
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(loadingShown()).toBe(false);
    expect(screen.getByTestId('screen-19').closest('[hidden]')).toBeNull();
    expect(mountedScreens()).toEqual(['screen-19']);
    expect(h.mounts19).toBe(1);
    expect(h.unmounts19).toBe(0);
    // No second request id was minted for the workspace's state.
    expect(h.requestIds).toEqual([1]);
    expect(screen.getByTestId('screen-19').getAttribute('data-request-id')).toBe('1');
  });

  it('R-2 (CI-3 regression, previously an OPEN residual): a Back/Forward entry that lands on the mounted Screen 19 keeps it mounted and hidden until its re-check settles', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));
    expect(h.mounts19).toBe(1);

    const slow = deferred<ProfileLoad>();
    getMyProfileResult.mockReturnValueOnce(slow.promise);
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    });
    expect(screenPending()).toBe('true');
    expect(mountedScreens()).toEqual(['screen-19']);
    expect(screen.getByTestId('screen-19').closest('[hidden]')).not.toBeNull();
    expect(h.unmounts19).toBe(0);

    await act(async () => { slow.resolve({ status: 'ok', profile: profileFor(USER) }); await slow.promise; });
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(screen.getByTestId('screen-19').closest('[hidden]')).toBeNull();
    expect(mountedScreens()).toEqual(['screen-19']);
    expect(h.mounts19).toBe(1);
    expect(h.requestIds).toEqual([1]);
  });

  it('ROLE-1 (OPEN): the client gate admits Screen 19 for ANY non-facility role string, including an unrecognised one, once the organization is verified care', async () => {
    await signInAs(profileFor(USER, { role: 'an_unrecognised_role' as unknown as Profile['role'] }));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));
  });
});

describe('RT-G · CI-3 · a pending re-check holds only the workspace it already admitted', () => {
  it('a same-screen re-check that DENIES unmounts the held workspace and lands on the role landing (fail closed)', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));

    const slow = deferred<ProfileLoad>();
    getMyProfileResult.mockReturnValueOnce(slow.promise);
    await click('forge-19');
    expect(mountedScreens()).toEqual(['screen-19']);
    await act(async () => { slow.resolve({ status: 'ok', profile: profileFor(USER, { status: 'suspended' }) }); await slow.promise; });
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(screenKind()).toBe('null');
    expect(mountedScreens()).toEqual(['screen-21']);
    expect(h.mounts19).toBe(1);
    expect(h.unmounts19).toBe(1);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('a FIRST entry into Screen 19 that is still pending is never mounted, not even hidden', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    expect(mountedScreens()).toEqual(['screen-21']);

    const slow = deferred<ProfileLoad>();
    getMyProfileResult.mockReturnValueOnce(slow.promise);
    await click('forge-19');
    expect(screenPending()).toBe('true');
    expect(loadingShown()).toBe(true);
    expect(mountedScreens()).toEqual([]);
    expect(h.mounts19).toBe(0);

    await act(async () => { slow.resolve({ status: 'ok', profile: profileFor(USER) }); await slow.promise; });
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));
    expect(h.mounts19).toBe(1);
  });

  it('an organization change while Screen 19 is mounted never keeps the previous organization\'s workspace', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));

    await click('org-care-b');
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(val('org')).toBe(ORG_CARE_B);
    // A non-super operator is verified only for its own organization, so the foreign one is denied.
    expect(screenKind()).toBe('null');
    expect(mountedScreens()).toEqual(['screen-21']);
    expect(h.unmounts19).toBe(1);
    expect(h.mounts19).toBe(1);
  });

  it('a dialog portalled to the document body is inert while the same-workspace re-check is pending, and live again once it settles', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));

    // Stand-in for a PhoenixDialog portal: it is appended to the body, outside the hidden frame.
    const portalled = document.createElement('div');
    portalled.setAttribute('data-testid', 'portalled-dialog');
    document.body.appendChild(portalled);
    try {
      const slow = deferred<ProfileLoad>();
      getMyProfileResult.mockReturnValueOnce(slow.promise);
      await click('forge-19');
      expect(screenPending()).toBe('true');
      expect(portalled.hasAttribute('inert')).toBe(true);
      // The application's own container is not made inert.
      expect(screen.getByTestId('app-shell').closest('body > *')!.hasAttribute('inert')).toBe(false);

      await act(async () => { slow.resolve({ status: 'ok', profile: profileFor(USER) }); await slow.promise; });
      await waitFor(() => expect(screenPending()).toBe('false'));
      expect(portalled.hasAttribute('inert')).toBe(false);
    } finally {
      portalled.remove();
    }
  });

  it('leaving Screen 19 and coming back while the entry is pending never reuses the workspace that was left', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));
    await click('go-3');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-3']));
    expect(h.unmounts19).toBe(1);

    const slow = deferred<ProfileLoad>();
    getMyProfileResult.mockReturnValueOnce(slow.promise);
    await click('forge-19');
    expect(screenPending()).toBe('true');
    expect(loadingShown()).toBe(true);
    expect(mountedScreens()).toEqual([]);
    expect(h.mounts19).toBe(1);

    await act(async () => { slow.resolve({ status: 'ok', profile: profileFor(USER) }); await slow.promise; });
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));
    expect(h.mounts19).toBe(2);
    expect(h.requestIds).toEqual([1, 2]);
  });

  it('an identity switch never hands the previous operator\'s mounted workspace to the next one', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));

    await switchToUser(other('user-2'));
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(h.unmounts19).toBe(1);
    expect(h.mounts19).toBe(1);

    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));
    expect(h.mounts19).toBe(2);
    expect(h.requestIds).toEqual([1, 2]);
  });
});

describe('RT-F · decision-table gaps, through the real provider', () => {
  it('super_admin: leaving a care organization for "all organizations" WAITS while the re-check is in flight, then DENIES, and 19 never mounts again', async () => {
    const superProfile = profileFor(SUPER, { role: 'super_admin', organization_id: null });
    await signInAs(superProfile);
    await click('org-care-a');
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));

    const slow = deferred<ProfileLoad>();
    getMyProfileResult.mockReturnValueOnce(slow.promise);
    await click('org-all');
    expect(val('org')).toBe('null');
    expect(screenPending()).toBe('true');
    expect(screenKind()).toBe('null');
    expect(loadingShown()).toBe(true);
    expect(mountedScreens()).toEqual([]);

    await act(async () => { slow.resolve({ status: 'ok', profile: superProfile }); await slow.promise; });
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(screenKind()).toBe('null');
    expect(mountedScreens()).toEqual(['screen-21']);
    await click('forge-19');
    expect(mountedScreens()).toEqual(['screen-21']);
  });

  it('a non-super operator whose HOME organization is a pharmacy department authority is verified for it, and Screen 19 is still refused', async () => {
    await signInAs(profileFor(USER, { organization_id: ORG_PDA }));
    await waitFor(() => expect(screenKind()).toBe('pharmacy_department_authority'));
    expect(val('org')).toBe(ORG_PDA);
    await click('forge-19');
    expect(mountedScreens()).toEqual(['screen-21']);
    expect(h.mounts19).toBe(0);
    expect(screenKind()).toBe('pharmacy_department_authority');
  });

  const FAILURE_MODES: Array<[string, () => void]> = [
    ['a thrown rejection', () => { getMyProfileResult.mockRejectedValueOnce(new Error('network down')); }],
    ['"missing"', () => { getMyProfileResult.mockResolvedValueOnce({ status: 'missing' }); }],
    ['"session_missing"', () => { getMyProfileResult.mockResolvedValueOnce({ status: 'session_missing', error: new Error('no session') }); }],
    ['a different profile id', () => { getMyProfileResult.mockResolvedValueOnce({ status: 'ok', profile: profileFor('someone-else') }); }],
    ['a status that is no longer active', () => { getMyProfileResult.mockResolvedValueOnce({ status: 'ok', profile: profileFor(USER, { status: 'suspended' }) }); }],
    ['a changed role', () => { getMyProfileResult.mockResolvedValueOnce({ status: 'ok', profile: profileFor(USER, { role: 'institution_admin' }) }); }],
  ];
  for (const [name, arrange] of FAILURE_MODES) {
    it(`a re-check that answers with ${name} DENIES Screen 19, adopts nothing and does not sign the operator out`, async () => {
      await signInAs(profileFor(USER));
      await waitFor(() => expect(screenKind()).toBe('care_institution'));
      const adoptedProfile = published[published.length - 1].profile;

      arrange();
      await click('forge-19');
      await waitFor(() => expect(screenPending()).toBe('false'));
      expect(screenKind()).toBe('null');
      expect(mountedScreens()).toEqual(['screen-21']);
      expect(h.mounts19).toBe(0);
      expect(signOut).not.toHaveBeenCalled();
      expect(val('status')).toBe('authenticated');
      expect(published[published.length - 1].profile).toBe(adoptedProfile);
    });
  }

  it('identity A\'s late DENY can never reach identity B: B keeps its own verified Screen 19 access', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    const staleA = deferred<ProfileLoad>();
    getMyProfileResult.mockReturnValueOnce(staleA.promise);
    await click('forge-19');
    expect(screenPending()).toBe('true');

    // B signs in directly while A's re-check is still in flight.
    await switchToUser(other('user-2'));
    await waitFor(() => expect(screenPending()).toBe('false'));
    expect(screenKind()).toBe('care_institution');

    // A's answer lands late. Applied to B it would DENY; it must change nothing.
    await act(async () => { staleA.resolve({ status: 'failed' }); await staleA.promise; });
    expect(screenKind()).toBe('care_institution');
    expect(screenPending()).toBe('false');
    expect(lastRender().profile).toBe('user-2');
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));
  });

  it('identity A\'s late answer after a sign-out restores nothing: no profile, no authorization context, no screen', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    const staleA = deferred<ProfileLoad>();
    getMyProfileResult.mockReturnValueOnce(staleA.promise);
    await click('forge-19');
    expect(screenPending()).toBe('true');

    await emitAuthEvent('SIGNED_OUT', null);
    await waitFor(() => expect(val('status')).not.toBe('authenticated'));
    await act(async () => { staleA.resolve({ status: 'ok', profile: profileFor(USER) }); await staleA.promise; });

    expect(val('status')).toBe('no_session');
    expect(screenKind()).toBe('null');
    expect(screenPending()).toBe('false');
    expect(lastRender().profile).toBeNull();
    expect(authzSeen!.getContext().authenticated).toBe(false);
    // Signed out: the login screen is what is shown, and no screen at all is mounted.
    expect(screen.queryByTestId('login-screen')).not.toBeNull();
    expect(mountedScreens()).toEqual([]);
  });

  it('KNOWN RESIDUAL (characterization, same cause as R-2): USER_UPDATED reloads the profile, a mounted Screen 19 unmounts, and a still-authorized operator gets it back with FRESH component state', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));
    expect(h.mounts19).toBe(1);

    getMyProfileResult.mockResolvedValue({ status: 'ok', profile: profileFor(USER) });
    await emitAuthEvent('USER_UPDATED', sessionFor(USER));
    await waitFor(() => expect(val('status')).toBe('authenticated'));
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));
    expect(h.unmounts19).toBe(1);
    expect(h.mounts19).toBe(2);
    expect(h.requestIds).toEqual([1, 2]);
    expect(screenKind()).toBe('care_institution');
  });

  it('USER_UPDATED resets a selected foreign organization to the profile\'s own: eligibility returns for the home organization only', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('org-care-b');
    await waitFor(() => expect(screenKind()).toBe('null'));
    expect(val('org')).toBe(ORG_CARE_B);

    getMyProfileResult.mockResolvedValue({ status: 'ok', profile: profileFor(USER) });
    await emitAuthEvent('USER_UPDATED', sessionFor(USER));
    await waitFor(() => expect(val('status')).toBe('authenticated'));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    expect(val('org')).toBe(ORG_CARE_A);
    expect(screenPending()).toBe('false');
  });

  it('a tab-refocus SIGNED_IN for the applied user is inert: no profile read, no remount, no change of authority', async () => {
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));
    const reads = getMyProfileResult.mock.calls.length;

    await emitAuthEvent('SIGNED_IN', sessionFor(USER));
    expect(getMyProfileResult.mock.calls.length).toBe(reads);
    expect(h.mounts19).toBe(1);
    expect(mountedScreens()).toEqual(['screen-19']);
    expect(screenKind()).toBe('care_institution');
  });

  it('production-faithful reads: a non-super caller cannot read a foreign organization, so both kinds stay null and Screen 19 is refused', async () => {
    getOrganization.mockImplementation(async (id: string) => (id === ORG_CARE_A ? orgRow(id) : null));
    await signInAs(profileFor(USER));
    await waitFor(() => expect(screenKind()).toBe('care_institution'));

    for (const target of ['org-care-b', 'org-pda']) {
      await click(target);
      await waitFor(() => expect(screenPending()).toBe('false'));
      expect(val('kind')).toBe('null');
      expect(screenKind()).toBe('null');
      await click('forge-19');
      expect(mountedScreens()).toEqual(['screen-21']);
    }
    expect(h.mounts19).toBe(0);
  });

  it('F1d: super_admin with a selected care organization OPENS Screen 19 (the only independently authorized case)', async () => {
    await signInAs(profileFor(SUPER, { role: 'super_admin', organization_id: null }));
    // Any care organization, none of them the super_admin's own (it has none).
    await click('org-care-b');
    await waitFor(() => expect(screenKind()).toBe('care_institution'));
    await click('forge-19');
    await waitFor(() => expect(mountedScreens()).toEqual(['screen-19']));
    expect(h.mounts19).toBe(1);
  });
});
