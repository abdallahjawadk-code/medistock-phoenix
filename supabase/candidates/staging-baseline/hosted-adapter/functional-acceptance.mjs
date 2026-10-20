/**
 * R1 functional acceptance runner (F3) for the isolated Staging test organization - the public-API half (no database password, no SQL).
 *
 * It signs in as the two test accounts (maker, checker) with supabase-js against the PINNED Staging project and runs the shared journey
 * (functional-journey.mjs). Secrets come ONLY from the environment (the PowerShell window collects the passwords in a hidden prompt):
 *   PHOENIX_STAGING_PUBLISHABLE_KEY  (the project's publishable/anon key - public by design, still never printed)
 *   PHOENIX_ACC_MAKER_EMAIL / PHOENIX_ACC_MAKER_PASSWORD / PHOENIX_ACC_CHECKER_EMAIL / PHOENIX_ACC_CHECKER_PASSWORD
 * Nothing is printed except step ids, PASS/FAIL and short database error codes. It writes ordinary test data through the product's own routines
 * (one plan year per run: a second run needs another --plan-year). Exit code 0 only when every step passed.
 *
 *   node functional-acceptance.mjs --org <uuid> --beneficiary <uuid> --plan-year <yyyy> --confirm S3C-ACCEPT-<ref>-<sysid>-<org>
 */
import { PINNED } from './hosted-adapter.mjs';
import { runJourney } from './functional-journey.mjs';

export const hostedConfirmationS3C = (orgId) => `S3C-ACCEPT-${PINNED.stagingRef}-${PINNED.stagingSystemIdentifier}-${orgId}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const projectUrl = () => `https://${PINNED.stagingRef}.supabase.co`;

/** The Staging transport: real sign-ins, PostgREST RPC calls, no persisted session. Tokens live only inside the supabase-js clients. */
export async function stagingTransport(env, { createClient }) {
  const url = projectUrl(); const key = env.PHOENIX_STAGING_PUBLISHABLE_KEY;
  const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const anon = createClient(url, key, opts);
  const sign = async (who) => {
    const c = createClient(url, key, opts);
    const { error } = await c.auth.signInWithPassword({ email: env[`PHOENIX_ACC_${who}_EMAIL`], password: env[`PHOENIX_ACC_${who}_PASSWORD`] });
    if (error) throw new Error(`sign-in as the ${who.toLowerCase()} account failed (${error.status ?? error.code ?? 'error'})`);   // never echo the message: it may name the account
    return c;
  };
  const clients = { anon, maker: await sign('MAKER'), checker: await sign('CHECKER') };
  return {
    async call(actor, fn, args) { const { data, error } = await clients[actor].rpc(fn, args); return { data, error: error ? { code: error.code, message: error.message } : null }; },
    async items(actor) { const { data, error } = await clients[actor].from('central_items').select('id,name').like('name', 'R1-ACCEPTANCE TEST%').order('name'); return error ? [] : data; },
    async close() { await Promise.all([clients.maker.auth.signOut().catch(() => undefined), clients.checker.auth.signOut().catch(() => undefined)]); },
  };
}

export async function acceptanceMain(arg, env, out = console, deps = {}) {
  const val = (f) => { const i = arg.indexOf(f); return i >= 0 ? arg[i + 1] : undefined; };
  const org = String(val('--org') ?? ''); const ben = String(val('--beneficiary') ?? ''); const year = Number(val('--plan-year'));
  let transport;
  try {
    if (!UUID_RE.test(org) || !UUID_RE.test(ben) || org === ben || !Number.isInteger(year) || year < 2025 || year > 2100) { out.error('STOP-INPUT: --org, --beneficiary (two different uuids) and --plan-year are required'); return 2; }
    if (val('--confirm') !== hostedConfirmationS3C(org)) { out.error('STOP-PHASE-P: the exact S3C --confirm string naming the organization is required; refused before any sign-in'); return 1; }
    for (const k of ['PHOENIX_STAGING_PUBLISHABLE_KEY', 'PHOENIX_ACC_MAKER_EMAIL', 'PHOENIX_ACC_MAKER_PASSWORD', 'PHOENIX_ACC_CHECKER_EMAIL', 'PHOENIX_ACC_CHECKER_PASSWORD']) {
      if (!env[k]) { out.error(`STOP-INPUT: environment variable ${k} is not set`); return 1; }
    }
    if (String(env.PHOENIX_ACC_MAKER_EMAIL).toLowerCase() === String(env.PHOENIX_ACC_CHECKER_EMAIL).toLowerCase()) { out.error('STOP-STAFFING: maker and checker must be two different accounts (D12)'); return 1; }
    const make = deps.makeTransport ?? (async () => stagingTransport(env, { createClient: (await import('@supabase/supabase-js')).createClient }));
    transport = await make(env);
    const res = await runJourney(transport, { orgId: org, beneficiaryId: ben, planYear: year, log: (m) => out.log(m) });
    out.log(`JOURNEY ${res.pass ? 'PASS' : 'FAIL'} (${res.total - res.failed}/${res.total} steps)`);
    return res.pass ? 0 : 1;
  } catch (e) {
    const secrets = ['PHOENIX_STAGING_PUBLISHABLE_KEY', 'PHOENIX_ACC_MAKER_PASSWORD', 'PHOENIX_ACC_CHECKER_PASSWORD', 'PHOENIX_ACC_MAKER_EMAIL', 'PHOENIX_ACC_CHECKER_EMAIL'].map((k) => env[k]).filter(Boolean);
    let m = String(e?.message ?? e); for (const s of secrets) m = m.split(s).join('[redacted]');
    out.error(`ERROR: ${m.slice(0, 200)}`); return 1;
  } finally { await transport?.close?.(); }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) process.exit(await acceptanceMain(process.argv.slice(2), process.env));
