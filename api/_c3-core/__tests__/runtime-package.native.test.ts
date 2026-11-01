import { execFileSync } from 'node:child_process';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../central-needs/c3-runtime-check.ts';

describe('private worker deployment packaging, no workbook or database', () => {
  beforeAll(() => execFileSync(process.execPath, ['scripts/c3-worker-assets.mjs']), 30000);
  afterEach(() => vi.unstubAllEnvs());
  it('refuses Production and unrelated Preview branches', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'feat/c3-hosted-worker-20261101');
    expect((await GET()).status).toBe(404);
    vi.stubEnv('VERCEL_ENV', 'preview'); vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'master');
    expect((await GET()).status).toBe(404);
  });
  it('loads the generated worker and waits for its actual termination', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'feat/c3-hosted-worker-20261101');
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ loaded: true, terminated: true,
      parserEvaluated: false, businessDataRead: false });
    expect(response.headers.get('cache-control')).toBe('no-store');
  }, 15000);
});
