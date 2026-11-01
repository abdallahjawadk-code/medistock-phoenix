import assert from 'node:assert/strict';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
export function secretMatches(value, expected) {
  return typeof value === 'string' && value.length <= 256 && typeof expected === 'string'
    && timingSafeEqual(Buffer.from(hash(value), 'hex'), Buffer.from(hash(expected), 'hex'));
}
export const previewCookie = (secret, head) => createHmac('sha256', secret).update(`owner-preview:${head}`).digest('hex');

/** Tokens enter only from the pinned local Auth server's response, never client input.
 * This is essential because standard disposable Supabase signing keys are public.
 * Original issued user tokens are forwarded unchanged; no service impersonation. */
export class IssuedPreviewSessions {
  #access = new Map(); #refresh = new Map(); #user; #email; #expires; #now;
  constructor({ userId, email, expiresAt, now = Date.now }) {
    assert(typeof userId === 'string' && typeof email === 'string');
    assert(Number.isFinite(expiresAt) && expiresAt > now() && expiresAt <= now() + 7200000);
    this.#user = userId; this.#email = email.toLowerCase(); this.#expires = expiresAt; this.#now = now;
  }
  acceptIssued(response) {
    if (this.#now() >= this.#expires || typeof response?.access_token !== 'string' || response.access_token.length > 8192
      || typeof response.refresh_token !== 'string' || response.refresh_token.length < 8 || response.refresh_token.length > 1024
      || response.user?.id !== this.#user || typeof response.user?.email !== 'string' || response.user.email.toLowerCase() !== this.#email) return false;
    let claims;
    try {
      const parts = response.access_token.split('.'); if (parts.length !== 3 || parts.some(part => !/^[\w-]+$/.test(part))) return false;
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { return false; }
    const seconds = Math.floor(this.#now() / 1000);
    if (claims.sub !== this.#user || claims.role !== 'authenticated' || claims.aud !== 'authenticated'
      || !Number.isInteger(claims.exp) || claims.exp <= seconds || claims.exp > seconds + 3605) return false;
    for (const [key, expiry] of this.#access) if (expiry <= this.#now()) this.#access.delete(key);
    if (this.#access.size >= 64 && !this.#access.has(hash(response.access_token))) return false;
    if (this.#refresh.size >= 64 && !this.#refresh.has(hash(response.refresh_token))) return false;
    this.#access.set(hash(response.access_token), Math.min(this.#expires, claims.exp * 1000));
    this.#refresh.set(hash(response.refresh_token), this.#expires); return true;
  }
  canAccess(token) { return this.#allowed(this.#access, token); }
  canRefresh(token) { return this.#allowed(this.#refresh, token); }
  #allowed(map, token) {
    return typeof token === 'string' && token.length <= 8192 && this.#now() < this.#expires && (map.get(hash(token)) ?? 0) > this.#now();
  }
  consumeRefresh(token) { if (typeof token === 'string') this.#refresh.delete(hash(token)); }
  signOut() { this.#access.clear(); this.#refresh.clear(); }
}

export function backendRoute(url, method) {
  if (url.pathname === '/auth/v1/token' && method === 'POST' && [...url.searchParams].length === 1) {
    if (url.searchParams.get('grant_type') === 'password') return 'password';
    if (url.searchParams.get('grant_type') === 'refresh_token') return 'refresh';
  }
  if (url.pathname === '/auth/v1/user' && method === 'GET' && !url.search) return 'user';
  if (url.pathname === '/auth/v1/logout' && method === 'POST'
    && (!url.search || ([...url.searchParams].length === 1 && ['global', 'local'].includes(url.searchParams.get('scope'))))) return 'logout';
  if (/^\/rest\/v1\/[A-Za-z_][A-Za-z_0-9]{0,100}$/.test(url.pathname) && ['GET', 'HEAD'].includes(method)) return 'read';
  if (/^\/rest\/v1\/rpc\/[A-Za-z_][A-Za-z_0-9]{0,100}$/.test(url.pathname) && method === 'POST'
    && url.pathname !== '/rest/v1/rpc/phoenix_central_needs_store_annual_original') return 'rpc';
  return 'denied';
}
