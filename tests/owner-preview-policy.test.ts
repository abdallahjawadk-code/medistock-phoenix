import { describe, expect, it } from 'vitest';
// @ts-expect-error — Node-only owner-preview transport module.
import { IssuedPreviewSessions, backendRoute, previewCookie, secretMatches } from '../tools/owner-preview/policy.mjs';
const user = 'a1800000-0000-4000-8000-000000000001';
const other = 'a1800000-0000-4000-8000-000000000002';
const issued = (now: number, id = user, role = 'authenticated', suffix = 'issued') => {
  const token = [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id, role, aud: 'authenticated', exp: Math.floor(now / 1000) + 3600 })).toString('base64url'), suffix].join('.');
  return { access_token: token, refresh_token: `refresh-${suffix}`, user: { id, email: 'owner-preview@phoenix.invalid' } };
};
describe('owner preview token custody, never a Product authority substitute', () => {
  it('admits only exact access and refresh tokens observed from the actual allowed Auth response', () => {
    const now = Date.now(), registry = new IssuedPreviewSessions({ userId: user, email: 'owner-preview@phoenix.invalid', expiresAt: now + 5400000, now: () => now });
    const response = issued(now); expect(registry.acceptIssued(response)).toBe(true);
    expect(registry.canAccess(response.access_token)).toBe(true); expect(registry.canRefresh(response.refresh_token)).toBe(true);
    expect(registry.canAccess(issued(now, user, 'authenticated', 'forged').access_token)).toBe(false);
  });
  it('rejects service-role and foreign fixture-admin identities even with plausible JWT syntax', () => {
    const now = Date.now(), registry = new IssuedPreviewSessions({ userId: user, email: 'owner-preview@phoenix.invalid', expiresAt: now + 5400000, now: () => now });
    expect(registry.acceptIssued(issued(now, user, 'service_role'))).toBe(false);
    expect(registry.acceptIssued(issued(now, other))).toBe(false);
    expect(registry.canAccess(issued(now, other).access_token)).toBe(false);
  });
  it('expires issued tokens and removes tokens on sign-out', () => {
    let now = Date.now(); const registry = new IssuedPreviewSessions({ userId: user, email: 'owner-preview@phoenix.invalid', expiresAt: now + 5400000, now: () => now });
    const response = issued(now); registry.acceptIssued(response); registry.signOut();
    expect(registry.canAccess(response.access_token)).toBe(false); expect(registry.canRefresh(response.refresh_token)).toBe(false);
    registry.acceptIssued(response); now += 3601000; expect(registry.canAccess(response.access_token)).toBe(false);
  });
  it('bounds token storage without accepting additional unobserved sessions', () => {
    const now = Date.now(), registry = new IssuedPreviewSessions({ userId: user, email: 'owner-preview@phoenix.invalid', expiresAt: now + 5400000, now: () => now });
    for (let n = 0; n < 64; n += 1) expect(registry.acceptIssued(issued(now, user, 'authenticated', `observed-${n}`))).toBe(true);
    expect(registry.acceptIssued(issued(now, user, 'authenticated', 'overflow'))).toBe(false);
  });
});
describe('closed temporary transport surface', () => {
  it.each(['/auth/v1/admin/users', '/auth/v1/signup', '/auth/v1/recover', '/storage/v1/object', '/realtime/v1/websocket'])('does not expose %s', path => {
    expect(backendRoute(new URL(path, 'https://preview.trycloudflare.com'), 'POST')).toBe('denied');
  });
  it('permits only selected real Auth and REST request shapes', () => {
    const url = (path: string) => new URL(path, 'https://preview.trycloudflare.com');
    expect(backendRoute(url('/auth/v1/token?grant_type=password'), 'POST')).toBe('password');
    expect(backendRoute(url('/auth/v1/token?grant_type=refresh_token'), 'POST')).toBe('refresh');
    expect(backendRoute(url('/auth/v1/token?grant_type=password&grant_type=refresh_token'), 'POST')).toBe('denied');
    expect(backendRoute(url('/auth/v1/user'), 'GET')).toBe('user');
    expect(backendRoute(url('/rest/v1/rpc/phoenix_central_needs_manual_capabilities'), 'POST')).toBe('rpc');
    expect(backendRoute(url('/rest/v1/profiles?select=id'), 'GET')).toBe('read');
    expect(backendRoute(url('/rest/v1/profiles'), 'PATCH')).toBe('denied');
  });
  it('uses a separate opaque gate cookie bound to the preview source and compares secrets exactly', () => {
    const secret = 'g'.repeat(48), head = 'a'.repeat(40);
    expect(previewCookie(secret, head)).toMatch(/^[0-9a-f]{64}$/);
    expect(previewCookie(secret, 'b'.repeat(40))).not.toBe(previewCookie(secret, head));
    expect(secretMatches(secret, secret)).toBe(true); expect(secretMatches(secret + 'x', secret)).toBe(false);
  });
});
