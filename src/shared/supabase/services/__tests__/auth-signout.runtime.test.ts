import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseSignOut = vi.fn();

vi.mock('@/shared/supabase/client', () => ({
  supabaseConfigured: true,
  supabase: { auth: { signOut: (...args: unknown[]) => supabaseSignOut(...args) } },
}));

import { signOut } from '../auth.service';

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
