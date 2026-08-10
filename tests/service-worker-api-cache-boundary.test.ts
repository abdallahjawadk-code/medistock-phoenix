import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Security contract: the PWA shell cache must never intercept a same-origin
 * application API. Phoenix does not currently ship a Vercel /api surface,
 * but keeping this boundary in place prevents a future function response
 * from becoming offline/stale-cached by the app-shell worker.
 */

describe('service worker API cache boundary', () => {
  const sw = readFileSync(join(__dirname, '../public/sw.js'), 'utf8');

  it('returns early for /api and every /api/* path', () => {
    expect(sw).toContain("url.pathname === '/api'");
    expect(sw).toContain("url.pathname.startsWith('/api/')");
    expect(sw).toContain('if (isSupabaseOrApiRequest(url)) return');
  });

  it('retains the existing Supabase live-only boundary', () => {
    expect(sw).toContain("url.hostname.endsWith('.supabase.co')");
    expect(sw).toContain("'/rest/v1'");
    expect(sw).toContain("'/auth/v1'");
    expect(sw).toContain("'/rpc/'");
    expect(sw).toContain("'/storage/v1'");
  });
});
