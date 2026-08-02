/** @vitest-environment jsdom */
/**
 * PHASE-B1-AUTH-RESILIENCE-RACE — the two producers of auth state must not be
 * able to overwrite each other out of order.
 *
 * onAuthChange and the standalone session read run concurrently, and profile
 * reads outlive the session that asked for them. Ordering is controlled here
 * with deferred promises — never with timers or sleeps — so each test states an
 * exact interleaving and asserts who is allowed to win.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import type { Profile, ProfileLoad, SessionLoad } from '@/shared/supabase/services/auth.service';

const getSessionResult = vi.fn<() => Promise<SessionLoad>>();
const getMyProfileResult = vi.fn<() => Promise<ProfileLoad>>();
const signOut = vi.fn<() => Promise<void>>();
const onAuthChange = vi.fn<(cb: unknown) => () => void>();

vi.mock('@/shared/supabase/client', () => ({ supabaseConfigured: true, supabase: {} }));

vi.mock('@/shared/supabase/services/auth.service', () => ({
  getSessionResult: () => getSessionResult(),
  getMyProfileResult: () => getMyProfileResult(),
  onAuthChange: (cb: unknown) => onAuthChange(cb),
  signIn: vi.fn(),
  signOut: () => signOut(),
  requestPasswordReset: vi.fn(),
  updatePassword: vi.fn(),
}));

const getEffectivePermissions =
  vi.fn<(id: string) => Promise<{ permissions: Record<string, boolean> | null }>>();
vi.mock('@/shared/supabase/services/users.service', () => ({
  getEffectivePermissions: (id: string) => getEffectivePermissions(id),
}));

import { AppProvider, useApp } from '../AppContext';

type AuthCallback = (event: AuthChangeEvent, session: Session | null) => Promise<void> | void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

const sessionFor = (id: string) => ({ user: { id } }) as unknown as Session;

const SESSION_A = sessionFor('user-A');
const SESSION_B = sessionFor('user-B');

function profileFor(id: string, over: Partial<Profile> = {}): Profile {
  return {
    id,
    organization_id: `org-${id}`,
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

const PROFILE_A = profileFor('user-A');
const PROFILE_B = profileFor('user-B');

let authCallback: AuthCallback = () => undefined;

function Probe() {
  const app = useApp();
  return (
    <div>
      <span data-testid="status">{app.authStatus}</span>
      <span data-testid="profile">{app.profile?.id ?? 'null'}</span>
      <span data-testid="org">{app.activeOrgId ?? 'null'}</span>
      <span data-testid="perms">{app.myPermissions.size}</span>
      <span data-testid="session">{app.session?.user.id ?? 'null'}</span>
      <button onClick={() => void app.signOut()}>sign-out</button>
      <button onClick={() => void app.reloadMyPermissions()}>reload-perms</button>
      <button onClick={() => void app.clearRecovery()}>clear-recovery</button>
    </div>
  );
}

const mount = () => render(<AppProvider><Probe /></AppProvider>);
const status = () => screen.getByTestId('status').textContent;
const val = (id: string) => screen.getByTestId(id).textContent;

/**
 * Deliver an auth event exactly as the Supabase subscription would: fire and
 * forget. The handler is NOT awaited — several of these tests deliberately
 * leave its profile read pending, and awaiting the handler would simply hang
 * on the interleaving the test exists to create. `act` flushes everything that
 * is already resolvable; anything still pending is the point.
 */
async function emitAuthEvent(event: AuthChangeEvent, session: Session | null) {
  await act(async () => { void authCallback(event, session); });
}

function expectNoIdentityResidue() {
  expect(val('profile')).toBe('null');
  expect(val('org')).toBe('null');
  expect(val('perms')).toBe('0');
}

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: these tests queue per-call answers with
  // mockResolvedValueOnce, and a leftover queue from the previous test would
  // silently answer this one's first read.
  vi.resetAllMocks();
  onAuthChange.mockImplementation((cb) => {
    authCallback = cb as AuthCallback;
    return () => undefined;
  });
  signOut.mockResolvedValue(undefined);
  getEffectivePermissions.mockResolvedValue({ permissions: { 'reports.view': true } });
});
afterEach(cleanup);

// ── BLOCKER 1 — bootstrap result race ───────────────────────────────────────

describe('BLOCKER 1 — a stale session read can never overrule a newer auth event', () => {
  it('a successful auth event wins over a session read that fails afterwards', async () => {
    const boot = deferred<SessionLoad>();
    getSessionResult.mockReturnValue(boot.promise);
    getMyProfileResult.mockResolvedValue({ status: 'ok', profile: PROFILE_A });

    mount();

    // The newer truth arrives first: this user IS signed in.
    await emitAuthEvent('SIGNED_IN', SESSION_A);
    await waitFor(() => expect(status()).toBe('authenticated'));

    // The older read now fails. It must be discarded, not believed.
    await act(async () => { boot.resolve({ status: 'failed' }); await boot.promise; });

    expect(status()).toBe('authenticated');
    expect(status()).not.toBe('bootstrap_failed');
    expect(status()).not.toBe('no_session');   // i.e. never the LoginScreen branch
    expect(val('session')).toBe('user-A');
    expect(val('profile')).toBe('user-A');
  });

  it('a stale read reporting "no session" cannot sign the newer session out either', async () => {
    const boot = deferred<SessionLoad>();
    getSessionResult.mockReturnValue(boot.promise);
    getMyProfileResult.mockResolvedValue({ status: 'ok', profile: PROFILE_A });

    mount();
    await emitAuthEvent('SIGNED_IN', SESSION_A);
    await waitFor(() => expect(status()).toBe('authenticated'));

    await act(async () => { boot.resolve({ status: 'ok', session: null }); await boot.promise; });

    expect(status()).toBe('authenticated');
    expect(val('session')).toBe('user-A');
  });

  it('a discarded stale read still settles the boot — no permanent spinner', async () => {
    const boot = deferred<SessionLoad>();
    getSessionResult.mockReturnValue(boot.promise);
    getMyProfileResult.mockResolvedValue({ status: 'missing' });

    mount();
    expect(status()).toBe('bootstrap_pending');

    // An auth event with no session retires the in-flight read...
    await emitAuthEvent('SIGNED_OUT', null);
    // ...and the read then resolves into a generation that no longer exists.
    await act(async () => { boot.resolve({ status: 'failed' }); await boot.promise; });

    await waitFor(() => expect(status()).toBe('no_session'));
    expect(status()).not.toBe('bootstrap_pending');
  });
});

// ── BLOCKER 2 — stale profile / cross-session race ──────────────────────────

describe('BLOCKER 2 — a profile may only be applied to the session that asked for it', () => {
  it('profile A completing AFTER session B arrived is ignored entirely', async () => {
    const profileA = deferred<ProfileLoad>();
    const profileB = deferred<ProfileLoad>();
    getSessionResult.mockResolvedValue({ status: 'ok', session: SESSION_A });
    getMyProfileResult
      .mockReturnValueOnce(profileA.promise)
      .mockReturnValueOnce(profileB.promise);

    mount();
    // Wait until the boot has actually issued A's profile read, so the
    // interleaving under test is the real one and not a scheduling accident.
    await waitFor(() => expect(getMyProfileResult).toHaveBeenCalledTimes(1));
    // A's profile read is in flight, so nothing is signed in yet.
    expect(status()).not.toBe('authenticated');

    // Session B takes over while A's profile read is still in flight.
    await emitAuthEvent('SIGNED_IN', SESSION_B);
    expect(getMyProfileResult).toHaveBeenCalledTimes(2);
    expect(val('session')).toBe('user-B');

    // A's answer lands late. It belongs to a session we no longer hold.
    await act(async () => { profileA.resolve({ status: 'ok', profile: PROFILE_A }); await profileA.promise; });

    expect(val('profile')).toBe('null');
    expect(status()).not.toBe('authenticated');

    // Only B's own answer may complete the sign-in.
    await act(async () => { profileB.resolve({ status: 'ok', profile: PROFILE_B }); await profileB.promise; });
    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(val('profile')).toBe('user-B');
    expect(val('org')).toBe('org-user-B');
  });

  it('while session B loads, user A is dropped instantly — no profile, org or permissions survive', async () => {
    const profileB = deferred<ProfileLoad>();
    getSessionResult.mockResolvedValue({ status: 'ok', session: SESSION_A });
    getMyProfileResult
      .mockResolvedValueOnce({ status: 'ok', profile: PROFILE_A })
      .mockReturnValueOnce(profileB.promise);

    mount();
    // A is fully signed in first.
    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(val('profile')).toBe('user-A');
    expect(val('org')).toBe('org-user-A');
    expect(val('perms')).toBe('1');

    // B's session arrives; B's profile is still loading.
    await emitAuthEvent('SIGNED_IN', SESSION_B);

    // The app must not be authenticated, and nothing of A may remain.
    expect(status()).toBe('profile_loading');
    expect(status()).not.toBe('authenticated');
    expectNoIdentityResidue();
  });

  it('sign-out during a pending profile read wins — the late answer restores nothing', async () => {
    const pendingRefresh = deferred<ProfileLoad>();
    getSessionResult.mockResolvedValue({ status: 'ok', session: SESSION_A });
    getMyProfileResult
      .mockResolvedValueOnce({ status: 'ok', profile: PROFILE_A })
      .mockReturnValueOnce(pendingRefresh.promise);

    mount();
    await waitFor(() => expect(status()).toBe('authenticated'));

    // A token refresh starts a second profile read for the same user…
    await emitAuthEvent('TOKEN_REFRESHED', SESSION_A);
    expect(status()).toBe('profile_loading');

    // …and the operator signs out while it is still in flight.
    await act(async () => { screen.getByText('sign-out').click(); });
    await waitFor(() => expect(status()).toBe('no_session'));

    await act(async () => {
      pendingRefresh.resolve({ status: 'ok', profile: PROFILE_A });
      await pendingRefresh.promise;
    });

    expect(status()).toBe('no_session');
    expect(val('session')).toBe('null');
    expectNoIdentityResidue();
  });

  it('moving from a non-super_admin to a super_admin clears the pinned org scope', async () => {
    getSessionResult.mockResolvedValue({ status: 'ok', session: SESSION_A });
    getMyProfileResult
      .mockResolvedValueOnce({ status: 'ok', profile: PROFILE_A })
      .mockResolvedValueOnce({
        status: 'ok',
        profile: profileFor('user-B', { role: 'super_admin' }),
      });

    mount();
    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(val('org')).toBe('org-user-A');

    await emitAuthEvent('SIGNED_IN', SESSION_B);
    await waitFor(() => expect(status()).toBe('authenticated'));

    expect(val('profile')).toBe('user-B');
    // Explicitly null — never the previous profile's organization.
    expect(val('org')).toBe('null');
  });

  it('a profile whose id does not match the session is refused, not rendered', async () => {
    getSessionResult.mockResolvedValue({ status: 'ok', session: SESSION_B });
    // The transport returns somebody else's row.
    getMyProfileResult.mockResolvedValue({ status: 'ok', profile: PROFILE_A });

    mount();

    await waitFor(() => expect(status()).toBe('profile_failed'));
    expect(status()).not.toBe('authenticated');
    expectNoIdentityResidue();
  });

  it('authenticated requires status ready, a profile, a session, and matching ids', async () => {
    getSessionResult.mockResolvedValue({ status: 'ok', session: SESSION_B });
    getMyProfileResult.mockResolvedValue({ status: 'ok', profile: PROFILE_B });

    mount();

    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(val('session')).toBe('user-B');
    expect(val('profile')).toBe('user-B');
  });
});

// ── LOGOUT INVALIDATION ORDER ───────────────────────────────────────────────
//
// Signing out must retire the local identity BEFORE the remote call, not after
// it. Every test here holds the remote sign-out pending on purpose: that is the
// window in which the previous behaviour left a full profile, org scope and
// permission set live, and in which a late read could write them back.

describe('LOGOUT — local invalidation happens before the remote sign-out', () => {
  /** Sign in as A and settle, leaving `getMyProfileResult` free for the caller. */
  async function signedInAsA() {
    getSessionResult.mockResolvedValue({ status: 'ok', session: SESSION_A });
    getMyProfileResult.mockResolvedValueOnce({ status: 'ok', profile: PROFILE_A });
    mount();
    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(val('perms')).toBe('1');
  }

  it('a pending profile read cannot survive a sign-out whose remote call is still hanging', async () => {
    const pendingProfile = deferred<ProfileLoad>();
    const remoteSignOut  = deferred<void>();

    await signedInAsA();
    getMyProfileResult.mockReturnValueOnce(pendingProfile.promise);
    signOut.mockReturnValue(remoteSignOut.promise);

    // A refresh starts a profile read that will not settle yet.
    await emitAuthEvent('TOKEN_REFRESHED', SESSION_A);
    expect(status()).toBe('profile_loading');

    // The operator signs out. The network call hangs — and must not matter.
    await act(async () => { screen.getByText('sign-out').click(); });

    expect(val('session')).toBe('null');
    expect(status()).toBe('no_session');
    expectNoIdentityResidue();

    // The earlier read lands while the remote sign-out is STILL pending.
    await act(async () => {
      pendingProfile.resolve({ status: 'ok', profile: PROFILE_A });
      await pendingProfile.promise;
    });

    expect(status()).toBe('no_session');
    expectNoIdentityResidue();

    // The remote call finally completes; nothing comes back.
    await act(async () => { remoteSignOut.resolve(); await remoteSignOut.promise; });
    expect(status()).toBe('no_session');
    expectNoIdentityResidue();
  });

  it('a permission RPC in flight cannot restore permissions after sign-out', async () => {
    const pendingPerms  = deferred<{ permissions: Record<string, boolean> | null }>();
    const remoteSignOut = deferred<void>();

    await signedInAsA();

    // An on-demand refresh whose RPC will not answer yet.
    getEffectivePermissions.mockReturnValueOnce(pendingPerms.promise);
    await act(async () => { screen.getByText('reload-perms').click(); });

    signOut.mockReturnValue(remoteSignOut.promise);
    await act(async () => { screen.getByText('sign-out').click(); });
    expect(val('perms')).toBe('0');

    // The RPC answers generously, after the sign-out. It must be discarded.
    await act(async () => {
      pendingPerms.resolve({ permissions: { 'reports.view': true, 'users.view': true } });
      await pendingPerms.promise;
    });

    expect(val('perms')).toBe('0');
    expect(status()).toBe('no_session');
    expectNoIdentityResidue();

    await act(async () => { remoteSignOut.resolve(); await remoteSignOut.promise; });
    expect(val('perms')).toBe('0');
  });

  it('clearRecovery invalidates locally first and cleans the URL after the remote call', async () => {
    const pendingProfile = deferred<ProfileLoad>();
    const remoteSignOut  = deferred<void>();
    const replaceState   = vi.spyOn(window.history, 'replaceState');

    await signedInAsA();
    getMyProfileResult.mockReturnValueOnce(pendingProfile.promise);
    signOut.mockReturnValue(remoteSignOut.promise);

    await emitAuthEvent('TOKEN_REFRESHED', SESSION_A);
    expect(status()).toBe('profile_loading');

    await act(async () => { screen.getByText('clear-recovery').click(); });

    // Identity is gone immediately — org scope and permissions included.
    expect(val('session')).toBe('null');
    expect(status()).toBe('no_session');
    expectNoIdentityResidue();
    // The URL is cleaned only after the remote call, exactly as before.
    expect(replaceState).not.toHaveBeenCalled();

    await act(async () => {
      pendingProfile.resolve({ status: 'ok', profile: PROFILE_A });
      await pendingProfile.promise;
    });
    expectNoIdentityResidue();

    await act(async () => { remoteSignOut.resolve(); await remoteSignOut.promise; });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(status()).toBe('no_session');
    expectNoIdentityResidue();

    replaceState.mockRestore();
  });

  it("session A's permission refresh is never applied to session B", async () => {
    const pendingPerms = deferred<{ permissions: Record<string, boolean> | null }>();

    await signedInAsA();

    // A asks for a refresh; its RPC hangs.
    getEffectivePermissions.mockReturnValueOnce(pendingPerms.promise);
    await act(async () => { screen.getByText('reload-perms').click(); });

    // B signs in and completes normally with two permissions.
    getMyProfileResult.mockResolvedValueOnce({ status: 'ok', profile: PROFILE_B });
    getEffectivePermissions.mockResolvedValueOnce({
      permissions: { 'reports.view': true, 'users.view': true },
    });
    await emitAuthEvent('SIGNED_IN', SESSION_B);
    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(val('profile')).toBe('user-B');
    expect(val('perms')).toBe('2');

    // A's answer arrives late, with a different set. B must be untouched.
    await act(async () => {
      pendingPerms.resolve({
        permissions: { 'reports.view': true, 'users.view': true, 'users.edit_scope': true },
      });
      await pendingPerms.promise;
    });

    expect(val('perms')).toBe('2');
    expect(val('profile')).toBe('user-B');
  });
});
