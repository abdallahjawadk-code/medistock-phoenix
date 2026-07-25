import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * SECURITY-ARCH-HARDENING-A — security response-headers contract.
 *
 * Vercel serves this SPA; the only place platform response headers are
 * declared is vercel.json. These headers are load-bearing security controls
 * (clickjacking, MIME-sniffing, transport security, powerful-feature scope,
 * and the Content-Security-Policy that constrains script/connect origins). If
 * one is silently dropped or weakened in a future edit, there is no runtime
 * error — the app keeps working while its defenses quietly regress. This test
 * pins the invariant so such a change fails in CI instead.
 *
 * It asserts presence + the security-relevant shape only; it deliberately does
 * NOT hard-code the full CSP string (which legitimately evolves as origins
 * change), so it will not block benign CSP maintenance.
 */

const VERCEL = join(__dirname, '../vercel.json');

function headerMap(): Record<string, string> {
  const cfg = JSON.parse(readFileSync(VERCEL, 'utf8'));
  const rule = (cfg.headers ?? []).find((h: { source: string }) => h.source === '/(.*)');
  const map: Record<string, string> = {};
  for (const h of rule?.headers ?? []) map[h.key.toLowerCase()] = h.value;
  return map;
}

describe('Vercel security headers contract', () => {
  const h = headerMap();

  it('applies headers to every route', () => {
    const cfg = JSON.parse(readFileSync(VERCEL, 'utf8'));
    expect((cfg.headers ?? []).some((r: { source: string }) => r.source === '/(.*)')).toBe(true);
  });

  it('denies framing (clickjacking)', () => {
    expect(h['x-frame-options']).toBe('DENY');
  });

  it('blocks MIME-type sniffing', () => {
    expect(h['x-content-type-options']).toBe('nosniff');
  });

  it('sets a privacy-preserving Referrer-Policy', () => {
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('scopes powerful browser features via Permissions-Policy', () => {
    expect(h['permissions-policy']).toBeDefined();
    // Sensitive features that must never be silently opened up to third parties.
    expect(h['permissions-policy']).toMatch(/geolocation=\(\)/);
    expect(h['permissions-policy']).toMatch(/microphone=\(\)/);
    expect(h['permissions-policy']).toMatch(/payment=\(\)/);
  });

  it('enforces HTTPS with HSTS (max-age >= 1 year)', () => {
    const hsts = h['strict-transport-security'];
    expect(hsts, 'Strict-Transport-Security header is required').toBeDefined();
    const maxAge = Number(/max-age=(\d+)/.exec(hsts ?? '')?.[1] ?? '0');
    expect(maxAge).toBeGreaterThanOrEqual(31536000);
  });

  it('ships a Content-Security-Policy that keeps scripts and framing locked down', () => {
    const csp = h['content-security-policy'];
    expect(csp, 'Content-Security-Policy header is required').toBeDefined();
    expect(csp).toContain("default-src 'self'");
    // Scripts must not allow inline/eval — no 'unsafe-inline' / 'unsafe-eval' in script-src.
    const scriptSrc = /script-src([^;]*)/.exec(csp ?? '')?.[1] ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
  });
});
