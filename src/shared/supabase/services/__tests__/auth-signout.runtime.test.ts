import { AuthSessionMissingError } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseSignOut = vi.fn();
const getUser = vi.fn();
const maybeSingle = vi.fn();
const eq = vi.fn<(column: string, value: string) => { maybeSingle: typeof maybeSingle }>(
  () => ({ maybeSingle }),
);
const select = vi.fn<(columns: string) => { eq: typeof eq }>(() => ({ eq }));
const from = vi.fn<(table: string) => { select: typeof select }>(() => ({ select }));

vi.mock('@/shared/supabase/client', () => ({
  supabaseConfigured: true,
  supabase: {
    auth: {
      signOut: (...args: unknown[]) => supabaseSignOut(...args),
      getUser: () => getUser(),
    },
    from: (table: string) => from(table),
  },
}));

import { getMyProfileResult, signOut } from '../auth.service';

describe('durable Supabase sign-out', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('uses only the global sign-out when it succeeds', async () => {
    supabaseSignOut.mockResolvedValue({ error: null });

    await signOut();

    expect(supabaseSignOut).toHaveBeenCalledTimes(1);
    expect(supabaseSignOut).toHaveBeenCalledWith();
  });

  it('falls back to local sign-out when global sign-out returns an error', async () => {
    supabaseSignOut
      .mockResolvedValueOnce({ error: new Error('global unavailable') })
      .mockResolvedValueOnce({ error: null });

    await signOut();

    expect(supabaseSignOut).toHaveBeenNthCalledWith(1);
    expect(supabaseSignOut).toHaveBeenNthCalledWith(2, { scope: 'local' });
  });

  it('falls back to local sign-out when global sign-out throws', async () => {
    supabaseSignOut
      .mockRejectedValueOnce(new Error('network failed'))
      .mockResolvedValueOnce({ error: null });

    await expect(signOut()).resolves.toBeUndefined();
    expect(supabaseSignOut).toHaveBeenNthCalledWith(2, { scope: 'local' });
  });

  it('reports a failed local fallback to the caller', async () => {
    const localError = new Error('local clear failed');
    supabaseSignOut
      .mockResolvedValueOnce({ error: new Error('global unavailable') })
      .mockResolvedValueOnce({ error: localError });

    await expect(signOut()).rejects.toBe(localError);
    expect(console.error).toHaveBeenCalledWith(
      '[phoenix] local sign-out fallback failed:',
      localError,
    );
  });
});

describe('profile auth-session classification', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    eq.mockReturnValue({ maybeSingle });
    select.mockReturnValue({ eq });
    from.mockReturnValue({ select });
  });

  it('returns a silent session_missing outcome for the official Supabase error', async () => {
    const error = new AuthSessionMissingError();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getUser.mockResolvedValue({ data: { user: null }, error });

    await expect(getMyProfileResult()).resolves.toEqual({ status: 'session_missing', error });
    expect(from).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('classifies a thrown AuthSessionMissingError the same way without an unhandled rejection', async () => {
    const error = new AuthSessionMissingError();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getUser.mockRejectedValue(error);

    await expect(getMyProfileResult()).resolves.toEqual({ status: 'session_missing', error });
    expect(from).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('keeps a transport error failed and logs it exactly once', async () => {
    const error = new Error('transport unavailable');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getUser.mockResolvedValue({ data: { user: null }, error });

    await expect(getMyProfileResult()).resolves.toEqual({ status: 'failed' });
    expect(from).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith('[phoenix] profile load failed:', error);
    errorLog.mockRestore();
  });

  it('preserves the valid-session profile path', async () => {
    const profile = {
      id: 'user-1', organization_id: 'org-1', full_name: 'Operator',
      role: 'warehouse_officer', status: 'active', username: null,
      login_mode: 'email', contact_email: null, must_change_password: false,
      whatsapp_phone: null,
    };
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    maybeSingle.mockResolvedValue({ data: profile, error: null });

    await expect(getMyProfileResult()).resolves.toEqual({ status: 'ok', profile });
    expect(from).toHaveBeenCalledWith('profiles');
    expect(eq).toHaveBeenCalledWith('id', 'user-1');
  });
});
