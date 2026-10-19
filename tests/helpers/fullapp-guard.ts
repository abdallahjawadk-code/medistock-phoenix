/**
 * Full-application acceptance guards (pure functions; no browser, no environment needed).
 *  - decide(): DENY-BY-DEFAULT network policy evaluated BEFORE a request is sent (installed as BrowserContext interception by fullapp-lock.ts).
 *    Allowed: static GETs from the app origin; the documented READ contract against the single declared backend; the two necessary sign-in
 *    calls. Everything else - any write, any unknown RPC/table, any other /auth/v1/ call, WebSocket, any other backend - is refused.
 *  - assertNonProduction(): the environment must appear in the REVIEWED contract (tests/helpers/fullapp-environments.json). An environment
 *    variable, a bundle scan and a production denylist are NOT proof: the bundle scan is a consistency check and the denylist is only a veto.
 *    The real protection is the network lock: whatever the bundle says, no request leaves for any backend except the declared one.
 */
export const READ_RPCS: ReadonlySet<string> = new Set([
  'phoenix_central_needs_my_capabilities',
  'phoenix_central_needs_my_material_capabilities',
  'phoenix_central_needs_list_manual_need_events',
  'phoenix_central_needs_list_material_requests',
  'phoenix_central_needs_list_material_request_events',
  'phoenix_central_needs_material_request_candidates',
]);
/** Tables the journey and the shared resolver READ (GET only). Extending this list is a code change that must be reviewed. */
export const READ_TABLES: ReadonlySet<string> = new Set(['central_items', 'central_needs_plans', 'central_needs_plan_revisions', 'organizations', 'profiles']);

/** Exact approved origins: scheme + hostname + port (as normalised by URL.origin). Host-only comparison is not accepted anywhere. */
export interface LockConfig { backendOrigin: string; appOrigin: string }
export interface Decision { allow: boolean; severity: 'ok' | 'blocked' | 'violation'; reason: string }
const allow = (reason: string): Decision => ({ allow: true, severity: 'ok', reason });
const block = (reason: string): Decision => ({ allow: false, severity: 'blocked', reason });
const violation = (reason: string): Decision => ({ allow: false, severity: 'violation', reason });
const isRead = (m: string) => m === 'GET' || m === 'HEAD';
const originOf = (o: string) => { try { return new URL(o).origin; } catch { return ''; } };
const BACKEND_PATH = /^\/(rest|auth|storage|functions|realtime)\/v1\//;

export function decide(method: string, url: string, cfg: LockConfig): Decision {
  const m = method.toUpperCase();
  let u: URL;
  try { u = new URL(url); } catch { return violation('unparsable url'); }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return allow('non-network scheme');
  if (u.protocol === 'ws:' || u.protocol === 'wss:') return violation('websocket is not part of the read contract');
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return violation(`scheme ${u.protocol}`);
  const backend = originOf(cfg.backendOrigin), app = originOf(cfg.appOrigin);
  if (!backend || !app) return violation('lock configuration has no exact origins');

  if (u.origin === backend) {
    if (m === 'OPTIONS') return allow('cors preflight');
    if (u.pathname === '/auth/v1/token') {
      const g = u.searchParams.get('grant_type');
      return m === 'POST' && (g === 'password' || g === 'refresh_token') ? allow(`sign-in ${g}`) : violation('auth token request outside password/refresh sign-in');
    }
    if (u.pathname === '/auth/v1/user') return m === 'GET' ? allow('auth user read') : violation('auth user mutation');
    if (u.pathname.startsWith('/auth/v1/')) return violation('auth endpoint outside the sign-in contract');
    const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(u.pathname);
    if (rpc) return m === 'POST' && READ_RPCS.has(rpc[1]) ? allow('documented read rpc') : violation(`rpc ${rpc[1]} is not in the documented read inventory (${m})`);
    const tbl = /^\/rest\/v1\/([a-z0-9_]+)$/.exec(u.pathname);
    if (tbl) return isRead(m) && READ_TABLES.has(tbl[1]) ? allow('documented table read') : violation(`${m} ${tbl[1]} is not a documented read`);
    return violation(`backend path ${u.pathname} is outside the contract`);
  }
  if (u.origin === app) {
    if (u.pathname.startsWith('/api/')) return violation('application API route is outside the read contract');
    return isRead(m) ? allow('static app asset') : violation(`${m} to the app origin`);
  }
  // not an approved origin. Same hostname with another scheme/port is a downgrade/mismatch; any backend-shaped target is an unknown backend.
  if (u.hostname === new URL(backend).hostname || u.hostname === new URL(app).hostname)
    return violation(`origin mismatch: ${u.origin} is not the approved origin (scheme/host/port must match exactly)`);
  if (u.hostname.endsWith('.supabase.co') || BACKEND_PATH.test(u.pathname)) return violation(`unknown backend ${u.origin} (aborted, recorded)`);
  return isRead(m) ? block('third-party static read blocked') : violation(`${m} to an unauthorized origin`);
}

export interface EnvEntry { ref?: string; origin?: string; appOrigin: string; loopback?: boolean; approvedBy: string; approvedOn: string }
export interface NonProdInput {
  confirmed: string;
  baseUrl: string;
  declaredRef: string;
  declaredOrigin: string;
  contract: EnvEntry[];
  prodRefs: string[];                 // VETO only - an incomplete list proves nothing
  prodAppHosts: string[];             // VETO only
  observedBackendHosts: string[];     // CONSISTENCY check only - a bundle scan proves nothing
}
const REF = /^[a-z0-9]{20}$/;
const originOrEmpty = (u: string) => { try { return new URL(u).origin; } catch { return ''; } };
const isLoopbackHost = (h: string) => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(h);

/** Exact backend origin: hosted projects are always https://<ref>.supabase.co; self-hosted stacks are declared by origin. */
export function declaredBackendOrigin(declaredRef: string, declaredOrigin: string): string {
  return declaredRef ? `https://${declaredRef.toLowerCase()}.supabase.co` : originOrEmpty(declaredOrigin);
}

export function assertNonProduction(i: NonProdInput): string[] {
  const v: string[] = [];
  if (i.confirmed !== 'yes') v.push('confirmation variable is not "yes"');
  const app = originOrEmpty(i.baseUrl);
  if (!app) v.push('base URL is not a valid URL');
  const backend = declaredBackendOrigin(i.declaredRef, i.declaredOrigin);
  if (!backend) v.push('neither a non-production project ref nor a backend origin is declared');
  if (i.declaredRef && !REF.test(i.declaredRef.toLowerCase())) v.push('declared project ref is malformed');
  if (!i.declaredRef && backend && new URL(backend).hostname.endsWith('.supabase.co')) v.push('a hosted supabase.co backend must be declared by project ref (https), not origin');
  // the reviewed contract is the authorization; nothing else can create one
  const entry = i.contract.find((e) => originOrEmpty(e.appOrigin) === app && app !== ''
    && ((!!i.declaredRef && !!e.ref && e.ref.toLowerCase() === i.declaredRef.toLowerCase()) || (!i.declaredRef && !!e.origin && originOrEmpty(e.origin) === backend)));
  if (!entry) v.push('this environment is not in the reviewed environment contract (tests/helpers/fullapp-environments.json)');
  else if (!entry.approvedBy || !entry.approvedOn) v.push('the contract entry has no approver/date');
  // transport: https everywhere, except an explicitly authorized isolated loopback environment (BOTH origins loopback, entry.loopback === true)
  for (const [label, o] of [['application', app], ['backend', backend]] as const) {
    if (!o || o.startsWith('https:')) continue;
    const loopbackOk = !!entry?.loopback && isLoopbackHost(new URL(o).hostname);
    if (!loopbackOk) v.push(`${label} origin must be https (http is allowed only for a contract entry marked loopback and only on a loopback host)`);
  }
  if (entry?.loopback && app && backend && !(isLoopbackHost(new URL(app).hostname) && isLoopbackHost(new URL(backend).hostname))) v.push('a loopback entry requires BOTH origins to be loopback');
  // vetoes
  if (i.declaredRef && i.prodRefs.map((r) => r.toLowerCase()).includes(i.declaredRef.toLowerCase())) v.push('declared project ref appears in a production list');
  if (app && i.prodAppHosts.map((h) => h.toLowerCase()).includes(new URL(app).host)) v.push('base URL host is a known production host');
  // consistency (not proof)
  for (const h of new Set(i.observedBackendHosts.map((x) => x.toLowerCase()))) if (backend && `https://${h}` !== backend) v.push(`bundle consistency: the app mentions "${h}", not the declared backend`);
  return v;
}

/** Hosts of hosted-Supabase URLs inside bundle text (consistency check only). */
export function backendHostsIn(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/https:\/\/([a-z0-9]{20})\.supabase\.co/g)) out.add(`${m[1]}.supabase.co`);
  return [...out];
}
