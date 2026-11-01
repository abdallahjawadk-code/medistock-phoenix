import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — Node-only CI integration helper is JavaScript.
import { prepareDisposablePlatformReadProfile } from '../disposable-platform-read-profile.mjs';

afterEach(() => vi.unstubAllEnvs());
describe('disposable platform profile target refusal before connecting', () => {
  it('refuses outside an actual CI job', async () => {
    vi.stubEnv('CI', 'false'); vi.stubEnv('GITHUB_ACTIONS', 'false');
    await expect(prepareDisposablePlatformReadProfile('postgresql://postgres@127.0.0.1:54322/postgres', '1')).rejects.toThrow();
  });
  it.each([
    'postgresql://postgres@db.example.invalid:54322/postgres',
    'postgresql://postgres@localhost:54322/postgres',
    'postgresql://postgres@127.0.0.1:5432/postgres',
    'postgresql://postgres@127.0.0.1:54322/other',
    'postgresql://service_role@127.0.0.1:54322/postgres',
    'postgresql://postgres@127.0.0.1:54322/postgres?sslmode=disable',
    'postgresql://postgres@127.0.0.1:54322/postgres#other',
    'https://postgres@127.0.0.1:54322/postgres',
  ])('refuses an unexpected target %s', async target => {
    vi.stubEnv('CI', 'true'); vi.stubEnv('GITHUB_ACTIONS', 'true');
    await expect(prepareDisposablePlatformReadProfile(target, '1')).rejects.toThrow();
  });
});
