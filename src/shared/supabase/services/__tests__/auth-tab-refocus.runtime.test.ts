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

const sessionFor = (id: string) => ({ user: { id } }) as unknown as Session;
const SESSION_A = sessionFor('user-A');
const SESSION_B = sessionFor('user-B');

function emit(event: AuthChangeEvent, session: Session | null) {
  if (!authHandler) throw new Error('auth handler not subscribed');
  authHandler(event, session);
}

describe('auth tab-refocus continuity', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authHandler = null;
  });

  it('forwards the first identity event, then coalesces passive same-user TOKEN_REFRESHED/SIGNED_IN events', () => {
    const cb = vi.fn();
    onAuthChange(cb);

    emit('INITIAL_SESSION', SESSION_A);
    emit('TOKEN_REFRESHED', SESSION_A);
    emit('SIGNED_IN', SESSION_A);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('INITIAL_SESSION', SESSION_A);
  });

  it('still forwards a different-user SIGNED_IN event', () => {
    const cb = vi.fn();
    onAuthChange(cb);

    emit('INITIAL_SESSION', SESSION_A);
    emit('SIGNED_IN', SESSION_B);

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith('SIGNED_IN', SESSION_B);
  });

  it('forwards sign-out and a later sign-in even when it is the same user as before', () => {
    const cb = vi.fn();
    onAuthChange(cb);

    emit('INITIAL_SESSION', SESSION_A);
    emit('SIGNED_OUT', null);
    emit('SIGNED_IN', SESSION_A);

    expect(cb).toHaveBeenCalledTimes(3);
    expect(cb).toHaveBeenNthCalledWith(2, 'SIGNED_OUT', null);
    expect(cb).toHaveBeenNthCalledWith(3, 'SIGNED_IN', SESSION_A);
  });

  it('does not suppress meaningful same-user USER_UPDATED or PASSWORD_RECOVERY events', () => {
    const cb = vi.fn();
    onAuthChange(cb);

    emit('INITIAL_SESSION', SESSION_A);
    emit('USER_UPDATED', SESSION_A);
    emit('PASSWORD_RECOVERY', SESSION_A);

    expect(cb).toHaveBeenCalledTimes(3);
    expect(cb).toHaveBeenNthCalledWith(2, 'USER_UPDATED', SESSION_A);
    expect(cb).toHaveBeenNthCalledWith(3, 'PASSWORD_RECOVERY', SESSION_A);
  });

  it('unsubscribes the underlying Supabase subscription', () => {
    const stop = onAuthChange(vi.fn());

    stop();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
