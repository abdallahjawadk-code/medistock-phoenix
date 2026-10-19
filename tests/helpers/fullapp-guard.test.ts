import { describe, expect, it } from 'vitest';
import { assertNonProduction, backendHostsIn, decide, READ_RPCS } from './fullapp-guard';
import contract from './fullapp-environments.json';

const REF_NP = 'abcdefghij0123456789', REF_PROD = 'zyxwvutsrq9876543210';
const entry = { ref: REF_NP, appOrigin: 'https://staging.example.test', approvedBy: 'Director', approvedOn: '2026-10-18' };
const ok = { confirmed: 'yes', baseUrl: 'https://staging.example.test', declaredRef: REF_NP, declaredOrigin: '', contract: [entry], prodRefs: [REF_PROD], prodAppHosts: ['app.example.com'], observedBackendHosts: [`${REF_NP}.supabase.co`] };

describe('full-app guard - environment identity (reviewed contract, not variables/bundle/denylist)', () => {
  it('the shipped contract is EMPTY: no environment is authorized until reviewed', () => {
    expect((contract as { authorized: unknown[] }).authorized).toEqual([]);
    expect(assertNonProduction({ ...ok, contract: (contract as { authorized: never[] }).authorized }).join()).toMatch(/not in the reviewed environment contract/);
  });
  it('accepts only an environment present in the reviewed contract', () => { expect(assertNonProduction(ok)).toEqual([]); });
  it('variables, a clean bundle and an empty production list cannot authorize', () => {
    expect(assertNonProduction({ ...ok, contract: [], prodRefs: [], observedBackendHosts: [] }).join()).toMatch(/reviewed environment contract/);
    expect(assertNonProduction({ ...ok, contract: [{ ...entry, appOrigin: 'https://other.example.test' }] }).join()).toMatch(/reviewed environment contract/);
    expect(assertNonProduction({ ...ok, contract: [{ ...entry, ref: REF_PROD }] }).join()).toMatch(/reviewed environment contract/);
    expect(assertNonProduction({ ...ok, contract: [{ ...entry, approvedBy: '' }] }).join()).toMatch(/no approver/);
  });
  it('an incomplete production list is only a veto; a bundle that mentions another backend is a consistency failure', () => {
    expect(assertNonProduction({ ...ok, prodRefs: [REF_NP] }).join()).toMatch(/production list/);
    expect(assertNonProduction({ ...ok, observedBackendHosts: [`${REF_PROD}.supabase.co`] }).join()).toMatch(/bundle consistency/);
  });
  it('refuses: no confirmation, bad ref, production app host, plain http, nothing declared, hosted origin', () => {
    expect(assertNonProduction({ ...ok, confirmed: '' }).join()).toMatch(/confirmation/);
    expect(assertNonProduction({ ...ok, declaredRef: 'short' }).join()).toMatch(/malformed/);
    expect(assertNonProduction({ ...ok, prodAppHosts: ['staging.example.test'] }).join()).toMatch(/production host/);
    expect(assertNonProduction({ ...ok, baseUrl: 'http://staging.example.test' }).join()).toMatch(/origin must be https/);
    expect(assertNonProduction({ ...ok, declaredRef: '', declaredOrigin: '' }).join()).toMatch(/neither/);
    expect(assertNonProduction({ ...ok, declaredRef: '', declaredOrigin: `https://${REF_NP}.supabase.co` }).join()).toMatch(/by project ref/);
  });
  it('a self-hosted origin needs its own contract entry', () => {
    const local = { ...ok, baseUrl: 'http://127.0.0.1:5173', declaredRef: '', declaredOrigin: 'http://127.0.0.1:54321', observedBackendHosts: [],
      contract: [{ origin: 'http://127.0.0.1:54321', appOrigin: 'http://127.0.0.1:5173', loopback: true, approvedBy: 'Director', approvedOn: '2026-10-18' }] };
    expect(assertNonProduction(local)).toEqual([]);
    expect(assertNonProduction({ ...local, contract: [] }).join()).toMatch(/reviewed environment contract/);
  });
  it('finds backend hosts in bundle text', () => { expect(backendHostsIn([`x="https://${REF_NP}.supabase.co/rest"`, 'none'])).toEqual([`${REF_NP}.supabase.co`]); });
});

describe('full-app guard - deny-by-default request policy', () => {
  const B = `${REF_NP}.supabase.co`, A = 'staging.example.test', cfg = { backendOrigin: `https://${B}`, appOrigin: `https://${A}`, backendHost: B, appHost: A }, u = (p: string) => `https://${B}${p}`;
  const d = (m: string, url: string) => decide(m, url, cfg);
  it('allows only documented reads, the two sign-in calls, and static app assets', () => {
    for (const fn of READ_RPCS) expect(d('POST', u(`/rest/v1/rpc/${fn}`)).allow, fn).toBe(true);
    expect(d('GET', u('/rest/v1/central_items?or=(x)')).allow).toBe(true);
    expect(d('POST', u('/auth/v1/token?grant_type=password')).allow).toBe(true);
    expect(d('POST', u('/auth/v1/token?grant_type=refresh_token')).allow).toBe(true);
    expect(d('GET', u('/auth/v1/user')).allow).toBe(true);
    expect(d('GET', `https://${A}/assets/index.js`).allow).toBe(true);
  });
  it('refuses writer RPCs, unknown RPCs, undocumented tables, non-GET table access', () => {
    expect(d('POST', u('/rest/v1/rpc/phoenix_central_needs_open_manual_plan_revision')).severity).toBe('violation');
    expect(d('POST', u('/rest/v1/rpc/some_new_function')).severity).toBe('violation');
    expect(d('GET', u('/rest/v1/rpc/phoenix_central_needs_my_capabilities')).allow).toBe(false);
    expect(d('GET', u('/rest/v1/warehouse_stock')).allow).toBe(false);
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) expect(d(m, u('/rest/v1/central_items')).allow, m).toBe(false);
  });
  it('restricts /auth/v1/: not every POST is safe', () => {
    for (const p of ['/auth/v1/signup', '/auth/v1/recover', '/auth/v1/otp', '/auth/v1/logout', '/auth/v1/admin/users', '/auth/v1/token?grant_type=id_token', '/auth/v1/token']) expect(d('POST', u(p)).allow, p).toBe(false);
    expect(d('PUT', u('/auth/v1/user')).allow).toBe(false);
  });
  it('refuses Storage, functions, realtime, websockets, the app /api routes, other backends', () => {
    expect(d('POST', u('/storage/v1/object/x/y')).allow).toBe(false);
    expect(d('GET', u('/storage/v1/object/x/y')).allow).toBe(false);
    expect(d('POST', u('/functions/v1/f')).allow).toBe(false);
    expect(d('GET', 'wss://' + B + '/realtime/v1/websocket').severity).toBe('violation');
    expect(d('POST', `https://${A}/api/cn2b-import`).allow).toBe(false);
    expect(d('GET', `https://${A}/api/anything`).allow).toBe(false);
    expect(d('POST', `https://${REF_PROD}.supabase.co/rest/v1/rpc/phoenix_central_needs_my_capabilities`).severity).toBe('violation');
    expect(d('GET', `https://${REF_PROD}.supabase.co/rest/v1/central_items`).allow).toBe(false);
  });
  it('there is no environment-variable escape hatch for the read inventory', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('./fullapp-guard.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/EXTRA_READ/);
  });
});

describe('full-app guard - exact origin (scheme + hostname + port)', () => {
  const B = `${REF_NP}.supabase.co`, A = 'staging.example.test';
  const cfg = { backendOrigin: `https://${B}`, appOrigin: `https://${A}`, backendHost: B, appHost: A };
  const d = (m: string, url: string, c: object = cfg) => decide(m, url, c as never);
  it('HTTP downgrade of the approved backend or app is a violation for token, table, rpc and assets', () => {
    for (const [m, p] of [['POST', '/auth/v1/token?grant_type=password'], ['GET', '/rest/v1/central_items?or=(x)'], ['POST', '/rest/v1/rpc/phoenix_central_needs_my_capabilities'], ['GET', '/auth/v1/user']]) {
      const r = d(m, `http://${B}${p}`);
      expect(r.allow, `${m} http ${p}`).toBe(false); expect(r.severity).toBe('violation');
    }
    expect(d('GET', `http://${A}/assets/index.js`).severity).toBe('violation');
  });
  it('a different port on the approved hostname is a different origin: violation', () => {
    expect(d('POST', `https://${B}:8443/auth/v1/token?grant_type=password`).severity).toBe('violation');
    expect(d('GET', `https://${B}:8443/rest/v1/central_items`).severity).toBe('violation');
    expect(d('GET', `https://${A}:8443/assets/x.js`).severity).toBe('violation');
    expect(d('GET', `https://${B}:443/rest/v1/central_items`).allow).toBe(true);        // explicit default port normalizes to the same origin
  });
  it('an unknown backend is a recorded VIOLATION even for reads (it will be aborted, and still counts)', () => {
    for (const url of [`https://${REF_PROD}.supabase.co/rest/v1/central_items`, 'https://evil.example/rest/v1/central_items', 'https://evil.example/auth/v1/user', 'https://x.example/storage/v1/object/a'])
      expect(d('GET', url).severity, url).toBe('violation');
    expect(d('GET', 'https://fonts.example/f.woff2').severity).toBe('blocked');           // plain third-party static read stays a benign block
  });
  it('an http loopback environment is its own exact origin; its https twin and other ports are violations', () => {
    const L = { backendOrigin: 'http://127.0.0.1:54321', appOrigin: 'http://127.0.0.1:5173' };
    expect(d('GET', 'http://127.0.0.1:54321/rest/v1/central_items', L).allow).toBe(true);
    expect(d('GET', 'https://127.0.0.1:54321/rest/v1/central_items', L).severity).toBe('violation');
    expect(d('GET', 'http://127.0.0.1:54322/rest/v1/central_items', L).severity).toBe('violation');
    expect(d('GET', 'http://localhost:54321/rest/v1/central_items', L).severity).toBe('violation');
  });
  it('HTTPS is required for hosted Supabase and external app origins; HTTP only for a contract entry marked loopback', () => {
    const hosted = { ...ok, baseUrl: 'http://staging.example.test', contract: [{ ...entry, appOrigin: 'http://staging.example.test' }] };
    expect(assertNonProduction(hosted).join()).toMatch(/https/);
    const httpHosted = { ...ok, declaredRef: '', declaredOrigin: `http://${REF_NP}.supabase.co`, contract: [{ origin: `http://${REF_NP}.supabase.co`, appOrigin: 'https://staging.example.test', approvedBy: 'D', approvedOn: 'x' }] };
    expect(assertNonProduction(httpHosted).join()).toMatch(/hosted supabase\.co|https/);
    const loopNoFlag = { ...ok, baseUrl: 'http://127.0.0.1:5173', declaredRef: '', declaredOrigin: 'http://127.0.0.1:54321', observedBackendHosts: [],
      contract: [{ origin: 'http://127.0.0.1:54321', appOrigin: 'http://127.0.0.1:5173', approvedBy: 'D', approvedOn: 'x' }] };
    expect(assertNonProduction(loopNoFlag).join()).toMatch(/loopback/);
    expect(assertNonProduction({ ...loopNoFlag, contract: [{ ...loopNoFlag.contract[0], loopback: true }] })).toEqual([]);
    // an externally hosted app must never be paired with an http backend, even with the loopback flag
    const mixed = { ...loopNoFlag, baseUrl: 'https://staging.example.test', contract: [{ origin: 'http://127.0.0.1:54321', appOrigin: 'https://staging.example.test', loopback: true, approvedBy: 'D', approvedOn: 'x' }] };
    expect(assertNonProduction(mixed).join()).toMatch(/loopback/);
  });
});
