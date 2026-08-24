/** @vitest-environment jsdom */
/**
 * MAJOR-J RELEASE BLOCKER — Android/PWA cold-start bootstrap deadlock.
 *
 * OBSERVED IN PRODUCTION: on an Android cold launch the app sometimes stays on
 * the full-screen Phoenix loading emblem forever, and only a manual reload
 * recovers it.
 *
 * ROOT CAUSE UNDER TEST. The bootstrap wrapped its network reads in try/catch:
 *
 *     async function readSessionOutcome() {
 *       try { return await getSessionResult(); }
 *       catch { return { status: 'failed' }; }
 *     }
 *
 * try/catch converts a REJECTION into a stated failure. It does nothing for a
 * promise that never settles at all — `await` simply never returns, `.then()`
 * never fires, and `authReady` is never set. A dropped cold-start request on a
 * mobile network is exactly that shape: not an error, just silence. The old
 * comment claiming the promise "can no longer leave the app pending forever"
 * was true only for rejection.
 *
 * These tests drive the REAL AppProvider against never-settling mocks. Time is
 * advanced with fake timers, so nothing here sleeps for a real deadline.
 *
 * Every case asserts the same contract: the app may fail, but it must never
 * keep showing the loading emblem.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';
import type { Profile, ProfileLoad, SessionLoad } from '@/shared/supabase/services/auth.service';

const getSessionResult = vi.fn<() => Promise<SessionLoad>>();
const getMyProfileResult = vi.fn<() => Promise<ProfileLoad>>();
const signIn = vi.fn<(email: string, password: string) => Promise<{ ok: boolean }>>();
const signOut = vi.fn<() => Promise<void>>();
const onAuthChange = vi.fn<(cb: unknown) => () => void>();

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

const getEffectivePermissions =
  vi.fn<(id: string) => Promise<{ permissions: Record<string, boolean> | null }>>();
vi.mock('@/shared/supabase/services/users.service', () => ({
  getEffectivePermissions: (id: string) => getEffectivePermissions(id),
}));

import { AppProvider, useApp } from '../AppContext';
import { AUTH_BOOTSTRAP_DEADLINE_MS, AUTH_PROFILE_DEADLINE_MS } from '@/shared/lib/deadline';

const SESSION = { user: { id: 'user-1' } } as unknown as Session;
const OTHER_SESSION = { user: { id: 'user-2' } } as unknown as Session;
const PROFILE: Profile = {
  id: 'user-1',
  organization_id: 'org-A',
  full_name: 'Test Operator',
  role: 'warehouse_officer',
  status: 'active',
  username: null,
  login_mode: 'email',
  contact_email: null,
  must_change_password: false,
  whatsapp_phone: null,
};

/** A promise that never settles — the shape a dropped mobile request takes. */
const never = <T,>(): Promise<T> => new Promise<T>(() => {});

function Probe() {
  const app = useApp();
  return (
    <div>
      <span data-testid="status">{app.authStatus}</span>
      <span data-testid="ready">{String(app.authReady)}</span>
      <span data-testid="org">{app.activeOrgId ?? 'null'}</span>
      <span data-testid="perms">{app.myPermissions.size}</span>
      <span data-testid="profile">{app.profile?.id ?? 'null'}</span>
    </div>
  );
}

const mount = () => render(<AppProvider><Probe /></AppProvider>);
const status = () => screen.getByTestId('status').textContent;
const ready = () => screen.getByTestId('ready').textContent;

/** Advance past a deadline inside act(), flushing the promise jobs it queues. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // shouldAdvanceTime keeps the clock moving on its own, so @testing-library's
  // waitFor (which polls on a timer) still works while advanceTimersByTimeAsync
  // remains available for jumping a 12-second deadline instantly. Plain
  // useFakeTimers() freezes waitFor and every test in this file times out —
  // including the healthy ones, which is how that mistake announces itself.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  onAuthChange.mockReturnValue(() => undefined);
  signOut.mockResolvedValue(undefined);
  signIn.mockResolvedValue({ ok: true });
  getSessionResult.mockResolvedValue({ status: 'ok', session: SESSION });
  getMyProfileResult.mockResolvedValue({ status: 'ok', profile: PROFILE });
  getEffectivePermissions.mockResolvedValue({ permissions: { 'reports.view': true } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ── A — the initial session read never settles ───────────────────────────────

describe('A — a never-settling session read must not hang the cold start', () => {
  it('stays pending while within the deadline, then states bootstrap_failed', async () => {
    getSessionResult.mockReturnValue(never<SessionLoad>());
    mount();

    // Before the deadline the spinner is legitimate — this is a slow network,
    // not yet a failed one. Asserted so the fix cannot be a zero-length timeout.
    await advance(AUTH_BOOTSTRAP_DEADLINE_MS - 1000);
    expect(status()).toBe('bootstrap_pending');
    expect(ready()).toBe('false');

    await advance(2000);
    await waitFor(() => expect(status()).toBe('bootstrap_failed'));
    expect(ready()).toBe('true');
  });

  it('reports UNKNOWN, never no_session — a timeout is not proof nobody is signed in', async () => {
    getSessionResult.mockReturnValue(never<SessionLoad>());
    mount();
    await advance(AUTH_BOOTSTRAP_DEADLINE_MS + 1000);
    await waitFor(() => expect(status()).toBe('bootstrap_failed'));
    expect(status()).not.toBe('no_session');
  });
});

// ── B — the profile read never settles ───────────────────────────────────────

describe('B — a never-settling profile read must not hang the cold start', () => {
  it('states profile_failed instead of loading forever', async () => {
    getMyProfileResult.mockReturnValue(never<ProfileLoad>());
    mount();

    await advance(AUTH_PROFILE_DEADLINE_MS + 1000);
    await waitFor(() => expect(status()).toBe('profile_failed'));
    expect(ready()).toBe('true');
  });

  it('mounts no authenticated identity scope on a profile timeout', async () => {
    getMyProfileResult.mockReturnValue(never<ProfileLoad>());
    mount();
    await advance(AUTH_PROFILE_DEADLINE_MS + 1000);
    await waitFor(() => expect(status()).toBe('profile_failed'));
    // Fail closed: no org scope and no permissions may survive a timeout.
    expect(screen.getByTestId('org')).toHaveTextContent('null');
    expect(screen.getByTestId('perms')).toHaveTextContent('0');
  });
});

// ── C — the permissions read never settles ───────────────────────────────────

describe('C — a never-settling permissions read must not hang the cold start', () => {
  it('states profile_failed rather than granting role defaults on a transport timeout', async () => {
    getEffectivePermissions.mockReturnValue(
      never<{ permissions: Record<string, boolean> | null }>(),
    );
    mount();

    await advance(AUTH_PROFILE_DEADLINE_MS + 1000);
    await waitFor(() => expect(status()).toBe('profile_failed'));
    expect(ready()).toBe('true');
    // A timeout is NOT "migration missing", so it must not become a silent
    // role-default grant.
    expect(screen.getByTestId('perms')).toHaveTextContent('0');
    expect(screen.getByTestId('org')).toHaveTextContent('null');
  });
});

// ── D — a late result must not resurrect stale identity ──────────────────────

describe('D — a result arriving after its deadline is discarded', () => {
  it('a late session result cannot overwrite the stated failure', async () => {
    let release!: (v: SessionLoad) => void;
    getSessionResult.mockReturnValue(new Promise<SessionLoad>((r) => { release = r; }));
    mount();

    await advance(AUTH_BOOTSTRAP_DEADLINE_MS + 1000);
    await waitFor(() => expect(status()).toBe('bootstrap_failed'));

    // The underlying request was never cancelled — Promise.race does not cancel.
    // It now answers, far too late.
    await act(async () => { release({ status: 'ok', session: SESSION }); });
    await advance(100);

    expect(status()).toBe('bootstrap_failed');
    expect(screen.getByTestId('profile')).toHaveTextContent('null');
  });

  it('a late profile result cannot resurrect a previous identity', async () => {
    let release!: (v: ProfileLoad) => void;
    getMyProfileResult.mockReturnValue(new Promise<ProfileLoad>((r) => { release = r; }));
    mount();

    await advance(AUTH_PROFILE_DEADLINE_MS + 1000);
    await waitFor(() => expect(status()).toBe('profile_failed'));

    await act(async () => { release({ status: 'ok', profile: PROFILE }); });
    await advance(100);

    expect(status()).toBe('profile_failed');
    expect(screen.getByTestId('org')).toHaveTextContent('null');
    expect(screen.getByTestId('perms')).toHaveTextContent('0');
  });
});

// ── E — auth events during a pending bounded operation ───────────────────────

describe('E — generation guards still win over a timed-out operation', () => {
  it('a SIGNED_IN arriving during a hung bootstrap is not demoted by the later timeout', async () => {
    getSessionResult.mockReturnValue(never<SessionLoad>());
    // The profile must belong to the SAME user as the event's session: the
    // identity-equality guard fails closed on a mismatch, which is correct and
    // would otherwise mask what this test is actually about.
    getMyProfileResult.mockResolvedValue({
      status: 'ok',
      profile: { ...PROFILE, id: 'user-2' },
    });
    let emit!: (event: string, session: Session | null) => void;
    onAuthChange.mockImplementation((cb) => {
      emit = cb as (e: string, s: Session | null) => void;
      return () => undefined;
    });
    mount();

    // A real auth event lands first and wins: its answer is newer.
    await act(async () => { emit('SIGNED_IN', OTHER_SESSION); });
    await waitFor(() => expect(status()).toBe('authenticated'));

    // The original bootstrap read now times out. It must NOT demote the live
    // session to an error screen.
    await advance(AUTH_BOOTSTRAP_DEADLINE_MS + 1000);
    expect(status()).toBe('authenticated');
    expect(screen.getByTestId('profile')).toHaveTextContent('user-2');
  });

  it('a SIGNED_OUT during a hung profile read keeps the signed-out barrier', async () => {
    getMyProfileResult.mockReturnValue(never<ProfileLoad>());
    let emit!: (event: string, session: Session | null) => void;
    onAuthChange.mockImplementation((cb) => {
      emit = cb as (e: string, s: Session | null) => void;
      return () => undefined;
    });
    mount();

    await act(async () => { emit('SIGNED_OUT', null); });
    await waitFor(() => expect(status()).toBe('no_session'));

    // The hung profile read times out afterwards; a signed-out app must stay
    // signed out rather than flipping to profile_failed.
    await advance(AUTH_PROFILE_DEADLINE_MS + 1000);
    expect(status()).toBe('no_session');
    expect(screen.getByTestId('profile')).toHaveTextContent('null');
  });
});

// ── the happy path is unchanged ──────────────────────────────────────────────

describe('the bounded deadline does not disturb a healthy cold start', () => {
  it('a normal fast bootstrap still reaches ready with its scope and permissions', async () => {
    mount();
    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(screen.getByTestId('org')).toHaveTextContent('org-A');
    expect(screen.getByTestId('perms')).toHaveTextContent('1');
    expect(ready()).toBe('true');
  });

  it('a bootstrap slower than a second but well inside the deadline still succeeds', async () => {
    getSessionResult.mockReturnValue(
      new Promise<SessionLoad>((r) =>
        setTimeout(() => r({ status: 'ok', session: SESSION }), 3000)),
    );
    mount();
    await advance(3500);
    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(screen.getByTestId('org')).toHaveTextContent('org-A');
  });
});
