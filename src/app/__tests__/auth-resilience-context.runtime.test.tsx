/** @vitest-environment jsdom */
/**
 * PHASE-B1-AUTH-RESILIENCE — C1/C2 at the AppContext level.
 *
 * C1: a failed initial session read must become a STATED failure, never an
 *     endless `bootstrap_pending` and never a silent "no session".
 * C2: a failed or absent profile read must become a stated failure that also
 *     drops the previous profile's org scope and permissions.
 *
 * These mount the real AppProvider against a mocked auth service, so the state
 * machine itself is under test — not a source-string approximation of it.
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

vi.mock('@/shared/supabase/client', () => ({
  supabaseConfigured: true,
  supabase: {},
}));

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

const SESSION = { user: { id: 'user-1' } } as unknown as Session;
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

function Probe() {
  const app = useApp();
  return (
    <div>
      <span data-testid="status">{app.authStatus}</span>
      <span data-testid="org">{app.activeOrgId ?? 'null'}</span>
      <span data-testid="perms">{app.myPermissions.size}</span>
      <span data-testid="profile">{app.profile?.id ?? 'null'}</span>
      <button onClick={() => void app.retryAuthBootstrap()}>retry-boot</button>
      <button onClick={() => void app.retryProfileLoad()}>retry-profile</button>
      <button onClick={() => void app.signOut()}>sign-out</button>
    </div>
  );
}

function mount() {
  return render(<AppProvider><Probe /></AppProvider>);
}

const status = () => screen.getByTestId('status').textContent;

beforeEach(() => {
  vi.clearAllMocks();
  onAuthChange.mockReturnValue(() => undefined);
  signOut.mockResolvedValue(undefined);
  signIn.mockResolvedValue({ ok: true });
  getEffectivePermissions.mockResolvedValue({ permissions: { 'reports.view': true } });
});
afterEach(cleanup);

// ── C1 — auth bootstrap failure ──────────────────────────────────────────────

describe('C1 — a failed session read never becomes a permanent spinner', () => {
  it('a rejected session read settles into bootstrap_failed, not bootstrap_pending', async () => {
    getSessionResult.mockRejectedValue(new Error('network down'));
    mount();
    await waitFor(() => expect(status()).toBe('bootstrap_failed'));
    expect(status()).not.toBe('bootstrap_pending');
  });

  it('a reported failure (no rejection) is also bootstrap_failed and never no_session', async () => {
    getSessionResult.mockResolvedValue({ status: 'failed' });
    mount();
    await waitFor(() => expect(status()).toBe('bootstrap_failed'));
    // The whole point: a failure must not be presented as "nobody is signed in".
    expect(status()).not.toBe('no_session');
  });

  it('retry re-attempts exactly once per click and recovers on success', async () => {
    getSessionResult.mockRejectedValueOnce(new Error('network down'));
    mount();
    await waitFor(() => expect(status()).toBe('bootstrap_failed'));
    expect(getSessionResult).toHaveBeenCalledTimes(1);

    getSessionResult.mockResolvedValue({ status: 'ok', session: null });
    await act(async () => { screen.getByText('retry-boot').click(); });

    await waitFor(() => expect(status()).toBe('no_session'));
    expect(getSessionResult).toHaveBeenCalledTimes(2);
  });

  it('a still-failing retry stays failed and issues no extra attempts of its own', async () => {
    getSessionResult.mockResolvedValue({ status: 'failed' });
    mount();
    await waitFor(() => expect(status()).toBe('bootstrap_failed'));

    await act(async () => { screen.getByText('retry-boot').click(); });
    await waitFor(() => expect(status()).toBe('bootstrap_failed'));

    // One boot + one manual retry. No self-scheduled retry loop.
    expect(getSessionResult).toHaveBeenCalledTimes(2);
  });

  it('a bootstrap failure never signs anybody in or out by itself', async () => {
    getSessionResult.mockRejectedValue(new Error('network down'));
    mount();
    await waitFor(() => expect(status()).toBe('bootstrap_failed'));

    await act(async () => { screen.getByText('retry-boot').click(); });
    await waitFor(() => expect(getSessionResult).toHaveBeenCalledTimes(2));

    expect(signIn).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });
});

// ── C2 — profile failure ─────────────────────────────────────────────────────

describe('C2 — an unreadable profile never becomes a permanent spinner', () => {
  it('a failed profile read settles into profile_failed', async () => {
    getSessionResult.mockResolvedValue({ status: 'ok', session: SESSION });
    getMyProfileResult.mockResolvedValue({ status: 'failed' });
    mount();
    await waitFor(() => expect(status()).toBe('profile_failed'));
  });

  it('an absent profile row settles into profile_missing (distinct from failed)', async () => {
    getSessionResult.mockResolvedValue({ status: 'ok', session: SESSION });
    getMyProfileResult.mockResolvedValue({ status: 'missing' });
    mount();
    await waitFor(() => expect(status()).toBe('profile_missing'));
  });

  it('a rejected profile read is caught and reported, not left pending', async () => {
    getSessionResult.mockResolvedValue({ status: 'ok', session: SESSION });
    getMyProfileResult.mockRejectedValue(new Error('boom'));
    mount();
    await waitFor(() => expect(status()).toBe('profile_failed'));
  });

  it('a failed reload drops the PREVIOUS profile org scope, permissions and profile', async () => {
    getSessionResult.mockResolvedValue({ status: 'ok', session: SESSION });
    getMyProfileResult.mockResolvedValue({ status: 'ok', profile: PROFILE });
    mount();

    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(screen.getByTestId('org')).toHaveTextContent('org-A');
    expect(screen.getByTestId('perms')).toHaveTextContent('1');

    getMyProfileResult.mockResolvedValue({ status: 'failed' });
    await act(async () => { screen.getByText('retry-profile').click(); });

    await waitFor(() => expect(status()).toBe('profile_failed'));
    // No previous-user residue may survive into the failure state.
    expect(screen.getByTestId('org')).toHaveTextContent('null');
    expect(screen.getByTestId('perms')).toHaveTextContent('0');
    expect(screen.getByTestId('profile')).toHaveTextContent('null');
  });

  it('retry recovers the profile without a re-login', async () => {
    getSessionResult.mockResolvedValue({ status: 'ok', session: SESSION });
    getMyProfileResult.mockResolvedValue({ status: 'failed' });
    mount();
    await waitFor(() => expect(status()).toBe('profile_failed'));

    getMyProfileResult.mockResolvedValue({ status: 'ok', profile: PROFILE });
    await act(async () => { screen.getByText('retry-profile').click(); });

    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(screen.getByTestId('org')).toHaveTextContent('org-A');
    expect(signIn).not.toHaveBeenCalled();
  });

  it('sign-out works from the failure state and clears it', async () => {
    getSessionResult.mockResolvedValue({ status: 'ok', session: SESSION });
    getMyProfileResult.mockResolvedValue({ status: 'failed' });
    mount();
    await waitFor(() => expect(status()).toBe('profile_failed'));

    await act(async () => { screen.getByText('sign-out').click(); });

    await waitFor(() => expect(status()).toBe('no_session'));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('org')).toHaveTextContent('null');
    expect(screen.getByTestId('perms')).toHaveTextContent('0');
  });
});

// ── The unchanged successful path ────────────────────────────────────────────

describe('the successful path is unchanged', () => {
  it('session + profile reach authenticated with org pinned and permissions loaded', async () => {
    getSessionResult.mockResolvedValue({ status: 'ok', session: SESSION });
    getMyProfileResult.mockResolvedValue({ status: 'ok', profile: PROFILE });
    mount();

    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(screen.getByTestId('profile')).toHaveTextContent('user-1');
    expect(screen.getByTestId('org')).toHaveTextContent('org-A');
    expect(screen.getByTestId('perms')).toHaveTextContent('1');
  });

  it('super_admin is still NOT pinned to an org (global scope preserved)', async () => {
    getSessionResult.mockResolvedValue({ status: 'ok', session: SESSION });
    getMyProfileResult.mockResolvedValue({
      status: 'ok',
      profile: { ...PROFILE, role: 'super_admin' },
    });
    mount();

    await waitFor(() => expect(status()).toBe('authenticated'));
    expect(screen.getByTestId('org')).toHaveTextContent('null');
  });

  it('no session still resolves to no_session and still subscribes to auth changes', async () => {
    getSessionResult.mockResolvedValue({ status: 'ok', session: null });
    mount();

    await waitFor(() => expect(status()).toBe('no_session'));
    expect(onAuthChange).toHaveBeenCalledTimes(1);
    expect(getMyProfileResult).not.toHaveBeenCalled();
  });
});
