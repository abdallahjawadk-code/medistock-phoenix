import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const unsubscribe = vi.fn();
let authHandler: ((event: AuthChangeEvent, session: Session | null) => void) | null = null;
const onAuthStateChange = vi.fn((cb: (event: AuthChangeEvent, session: Session | null) => void) => {
  authHandler = cb;
  return { data: { subscription: { unsubscribe } } };
});

vi.mock('@/shared/supabase/client', () => ({
  supabaseConfigured: true,
  supabase: {
    auth: {
      onAuthStateChange: (cb: (event: AuthChangeEvent, session: Session | null) => void) =>
        onAuthStateChange(cb),
    },
  },
}));

import { onAuthChange } from '../auth.service';

const tokenSession = (id: string, token: string) =>
  ({ user: { id }, access_token: token }) as unknown as Session;

function emit(event: AuthChangeEvent, session: Session | null) {
  if (!authHandler) throw new Error('auth handler not subscribed');
  authHandler(event, session);
}

/**
 * PR-205 — onAuthChange stays a transparent adapter over Supabase's auth
 * events. Whether a passive same-user refresh needs an identity reload is
 * decided in AppContext, against the profile actually applied (see "PR-205" in
 * src/app/__tests__/auth-session-race.runtime.test.tsx).
 *
 * Filtering here instead kept a second record of "who is signed in" that
 * AppContext's local sign-out cannot reset. When the remote sign-out failed —
 * so Supabase emitted no SIGNED_OUT — the SIGNED_IN of the same user signing in
 * again was swallowed and the app stayed on the login screen; and AppContext
 * kept a session carrying the pre-refresh access token.
 */
describe('auth tab-refocus continuity — onAuthChange forwards every event unchanged', () => {
  beforeEach(() => {
    // Preserve the onAuthStateChange implementation declared above. resetAllMocks()
    // would erase that implementation and make the test fail before exercising
    // Phoenix auth behavior at all.
    vi.clearAllMocks();
    authHandler = null;
  });

  it('forwards passive same-user TOKEN_REFRESHED/SIGNED_IN events with the refreshed session, in order', () => {
    const cb = vi.fn();
    onAuthChange(cb);

    const initial = tokenSession('user-A', 'token-1');
    const refreshed = tokenSession('user-A', 'token-2');
    const refocused = tokenSession('user-A', 'token-2');
    const refreshedAgain = tokenSession('user-A', 'token-3');

    emit('INITIAL_SESSION', initial);
    emit('TOKEN_REFRESHED', refreshed);
    emit('SIGNED_IN', refocused);
    emit('TOKEN_REFRESHED', refreshedAgain);
    emit('SIGNED_OUT', null);

    expect(cb.mock.calls.map(([event]) => event)).toEqual([
      'INITIAL_SESSION', 'TOKEN_REFRESHED', 'SIGNED_IN', 'TOKEN_REFRESHED', 'SIGNED_OUT',
    ]);
    // The exact session objects Supabase delivered — never a stale earlier one.
    expect(cb.mock.calls[1][1]).toBe(refreshed);
    expect(cb.mock.calls[2][1]).toBe(refocused);
    expect(cb.mock.calls[3][1]).toBe(refreshedAgain);
    expect(cb.mock.calls[4][1]).toBeNull();
  });

  it('forwards a same-user SIGNED_IN even when no SIGNED_OUT preceded it (failed remote sign-out)', () => {
    const cb = vi.fn();
    onAuthChange(cb);

    const beforeSignOut = tokenSession('user-A', 'token-1');
    const signedInAgain = tokenSession('user-A', 'token-4');

    emit('INITIAL_SESSION', beforeSignOut);
    emit('SIGNED_IN', beforeSignOut);
    emit('SIGNED_IN', signedInAgain);

    expect(cb).toHaveBeenCalledTimes(3);
    expect(cb).toHaveBeenNthCalledWith(3, 'SIGNED_IN', signedInAgain);
  });

  it('forwards different-user SIGNED_IN, USER_UPDATED and PASSWORD_RECOVERY events', () => {
    const cb = vi.fn();
    onAuthChange(cb);

    const sessionA = tokenSession('user-A', 'token-a');
    const sessionB = tokenSession('user-B', 'token-b');

    emit('INITIAL_SESSION', sessionA);
    emit('SIGNED_IN', sessionB);
    emit('USER_UPDATED', sessionB);
    emit('PASSWORD_RECOVERY', sessionB);

    expect(cb).toHaveBeenCalledTimes(4);
    expect(cb).toHaveBeenNthCalledWith(2, 'SIGNED_IN', sessionB);
    expect(cb).toHaveBeenNthCalledWith(3, 'USER_UPDATED', sessionB);
    expect(cb).toHaveBeenNthCalledWith(4, 'PASSWORD_RECOVERY', sessionB);
  });

  it('opens exactly one Supabase subscription per call and unsubscribes it', () => {
    const stop = onAuthChange(vi.fn());

    expect(onAuthStateChange).toHaveBeenCalledTimes(1);

    stop();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
