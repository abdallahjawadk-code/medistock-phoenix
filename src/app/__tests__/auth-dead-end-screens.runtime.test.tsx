/** @vitest-environment jsdom */
/**
 * PHASE-B1-AUTH-RESILIENCE — what AuthenticatedApp actually RENDERS for each
 * state of the contract.
 *
 * The context test proves the state machine; this one proves the operator is
 * never shown a spinner they cannot leave: every failure state renders a
 * stated message with a retry, the profile states also offer a working sign
 * out, and none of them lets the app shell (or a previous user's screen) mount.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { AppState, AuthStatus } from '../AppContext';

const retryAuthBootstrap = vi.fn(async () => undefined);
const retryProfileLoad = vi.fn(async () => undefined);
const signOut = vi.fn(async () => undefined);

let state: Partial<AppState> = {};

vi.mock('@/app/AppContext', () => ({
  useApp: () => state,
}));

vi.mock('@/shared/ui/PhoenixAppShell', () => ({
  // Children are deliberately NOT rendered: this test is about which top-level
  // branch AuthenticatedApp chooses, not about the screens inside the shell.
  PhoenixAppShell: ({ currentScreen }: { currentScreen: number }) => (
    <div data-testid="app-shell" data-screen={currentScreen} />
  ),
}));
vi.mock('@/features/auth/LoginScreen', () => ({
  LoginScreen: () => <div data-testid="login-screen" />,
}));
vi.mock('@/features/auth/PhoenixWelcomeExperience', () => ({
  PhoenixWelcomeExperience: () => <div data-testid="welcome-screen" />,
}));
vi.mock('@/features/auth/ResetPasswordScreen', () => ({
  ResetPasswordScreen: () => <div data-testid="reset-screen" />,
}));
vi.mock('@/shared/ui/PhoenixLoadingState', () => ({
  PhoenixLoadingState: () => <div data-testid="loading-state" />,
}));

import { AuthenticatedApp } from '../AuthenticatedApp';

const SESSION = { user: { id: 'user-1' } };
const PROFILE = { id: 'user-1', role: 'warehouse_officer', organization_id: 'org-A' };

function setState(authStatus: AuthStatus, over: Partial<AppState> = {}) {
  state = {
    lang: 'ar',
    authReady: authStatus !== 'bootstrap_pending',
    authStatus,
    session: null,
    profile: null,
    role: 'warehouse_officer',
    passwordRecovery: false,
    signOut,
    retryAuthBootstrap,
    retryProfileLoad,
    ...over,
  } as Partial<AppState>;
}

function recoveryPanel() {
  return document.querySelector('[data-phoenix-auth-recovery]');
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  try { window.sessionStorage.clear(); } catch { /* restricted storage */ }
});

// ── C1 at the screen level ───────────────────────────────────────────────────

describe('C1 — bootstrap failure renders a stated state, not a spinner', () => {
  it('shows the recovery panel with a retry and never the loading spinner', () => {
    setState('bootstrap_failed');
    render(<AuthenticatedApp />);

    expect(recoveryPanel()).not.toBeNull();
    expect(screen.queryByTestId('loading-state')).toBeNull();
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeInTheDocument();
  });

  it('does NOT present a login form (a failure is not "nobody is signed in")', () => {
    setState('bootstrap_failed');
    render(<AuthenticatedApp />);
    expect(screen.queryByTestId('login-screen')).toBeNull();
  });

  it('offers no sign-out before a session is established, and signs nobody out', () => {
    setState('bootstrap_failed');
    render(<AuthenticatedApp />);

    expect(screen.queryByRole('button', { name: 'تسجيل الخروج' })).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('retry is manual: nothing is attempted until the operator clicks', () => {
    setState('bootstrap_failed');
    render(<AuthenticatedApp />);
    expect(retryAuthBootstrap).not.toHaveBeenCalled();

    screen.getByRole('button', { name: 'إعادة المحاولة' }).click();
    expect(retryAuthBootstrap).toHaveBeenCalledTimes(1);
  });

  it('renders a generic bilingual message with no Supabase/network detail', () => {
    setState('bootstrap_failed', { lang: 'en' });
    render(<AuthenticatedApp />);

    const text = recoveryPanel()?.textContent ?? '';
    expect(text).toContain('The application could not start');
    for (const leak of ['supabase', 'fetch', 'JWT', 'token', '401', '500', 'Error:']) {
      expect(text.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });
});

// ── C2 at the screen level ───────────────────────────────────────────────────

describe('C2 — an unreadable profile renders a stated state with a way out', () => {
  for (const authStatus of ['profile_failed', 'profile_missing'] as const) {
    it(`${authStatus}: retry AND a working sign-out, never the endless spinner`, () => {
      setState(authStatus, { session: SESSION } as Partial<AppState>);
      render(<AuthenticatedApp />);

      expect(recoveryPanel()).not.toBeNull();
      expect(screen.queryByTestId('loading-state')).toBeNull();

      screen.getByRole('button', { name: 'إعادة المحاولة' }).click();
      expect(retryProfileLoad).toHaveBeenCalledTimes(1);

      screen.getByRole('button', { name: 'تسجيل الخروج' }).click();
      expect(signOut).toHaveBeenCalledTimes(1);
    });

    it(`${authStatus}: the app shell never mounts, so no previous screen can leak`, () => {
      setState(authStatus, { session: SESSION } as Partial<AppState>);
      render(<AuthenticatedApp />);

      expect(screen.queryByTestId('app-shell')).toBeNull();
      expect(screen.queryByTestId('welcome-screen')).toBeNull();
    });
  }

  it('the failure state is shown before the welcome sequence, not after it', () => {
    // Welcome has NOT been seen for this user, yet the profile failure wins.
    setState('profile_failed', { session: SESSION } as Partial<AppState>);
    render(<AuthenticatedApp />);

    expect(screen.queryByTestId('welcome-screen')).toBeNull();
    expect(recoveryPanel()).not.toBeNull();
  });

  it('profile_loading still shows the spinner (unchanged) and no shell', () => {
    setState('profile_loading', { session: SESSION } as Partial<AppState>);
    // Welcome already seen, so the loading branch is the one under test.
    window.sessionStorage.setItem('medistock-phoenix-welcome:user-1', 'complete');
    render(<AuthenticatedApp />);

    expect(screen.getByTestId('loading-state')).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).toBeNull();
    expect(recoveryPanel()).toBeNull();
  });
});

// ── The unchanged successful path ────────────────────────────────────────────

describe('the successful path is unchanged', () => {
  it('bootstrap_pending still shows the loading state', () => {
    setState('bootstrap_pending');
    render(<AuthenticatedApp />);
    expect(screen.getByTestId('loading-state')).toBeInTheDocument();
  });

  it('no_session still shows the login screen', () => {
    setState('no_session');
    render(<AuthenticatedApp />);
    expect(screen.getByTestId('login-screen')).toBeInTheDocument();
  });

  it('password recovery still takes priority over every other state', () => {
    setState('bootstrap_failed', { passwordRecovery: true });
    render(<AuthenticatedApp />);
    expect(screen.getByTestId('reset-screen')).toBeInTheDocument();
    expect(recoveryPanel()).toBeNull();
  });

  it('welcome still runs once per session before the shell', () => {
    setState('authenticated', { session: SESSION, profile: PROFILE } as Partial<AppState>);
    render(<AuthenticatedApp />);
    expect(screen.getByTestId('welcome-screen')).toBeInTheDocument();
  });

  it('role landing is unchanged: warehouse_officer lands on 21', () => {
    window.sessionStorage.setItem('medistock-phoenix-welcome:user-1', 'complete');
    setState('authenticated', { session: SESSION, profile: PROFILE } as Partial<AppState>);
    render(<AuthenticatedApp />);
    expect(screen.getByTestId('app-shell')).toHaveAttribute('data-screen', '21');
  });

  it('role landing is unchanged: outlet_officer lands on 18', () => {
    window.sessionStorage.setItem('medistock-phoenix-welcome:user-1', 'complete');
    setState('authenticated', {
      session: SESSION,
      profile: { ...PROFILE, role: 'outlet_officer' },
      role: 'outlet_officer',
    } as Partial<AppState>);
    render(<AuthenticatedApp />);
    expect(screen.getByTestId('app-shell')).toHaveAttribute('data-screen', '18');
  });
});
