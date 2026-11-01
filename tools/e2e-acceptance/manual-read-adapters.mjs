/** Transaction mode regression through real employee Auth/PostgREST. No hosted SQL. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const api = new URL(seed.supabaseUrl), database = new URL(seed.databaseUrl);
assert(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
assert.equal(api.protocol, 'http:'); assert.equal(api.hostname, '127.0.0.1'); assert.equal(api.port, '54321');
assert.equal(api.pathname, '/'); assert.equal(api.search, ''); assert.equal(api.hash, '');
assert.equal(api.username, ''); assert.equal(api.password, '');
assert(['postgres:', 'postgresql:'].includes(database.protocol)); assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '54322'); assert.equal(database.username, 'postgres'); assert.equal(database.pathname, '/postgres');
assert.equal(database.search, ''); assert.equal(database.hash, '');
assert(process.env.SUPABASE_ANON_KEY);
const prerequisite = JSON.parse(readFileSync('docs/phoenix/e2e-acceptance/monthly-policy-reference.json', 'utf8'));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert(prerequisite.passed && prerequisite.commit === head);
const candidate = readFileSync('supabase/candidates/R1_read_transaction_adapters_NOT_APPLIED.sql');
const candidateSha256 = createHash('sha256').update(candidate).digest('hex');
assert.equal(candidateSha256, '5cc3b4c072acfe4cbf09a1d16a10d3f8739b5e286ebfe6aa38078affc122358d');
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const client = () => createClient(api.href, process.env.SUPABASE_ANON_KEY, options);
const employee = client(), outsider = client(), anonymous = client();
const db = new pg.Client({ connectionString: database.href, connectionTimeoutMillis: 5000 });
const report = { commit: head, sourceHead: prerequisite.sourceHead, candidateSha256, productionSqlApplied: false,
  hostedCompatibility: prerequisite.hostedCompatibility, environment: 'disposable loopback; real employee Auth/PostgREST', checks: [], errors: [] };
const check = (name, passed) => { report.checks.push({ name, passed: Boolean(passed) }); console.log(`${passed ? 'PASS' : 'FAIL'} Manual read ${name}`); assert(passed, name); };
const owner = seed.centralNeeds.owningOrganization, actor = seed.centralNeeds.editor.id;
const routines = async () => (await db.query(`SELECT p.oid,pg_get_functiondef(p.oid) definition,p.proacl,p.proowner
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname='public' OR n.nspname LIKE 'phoenix%')
  AND p.prokind IN ('f','p') AND p.proname !~ '^phoenix_manual_read_' ORDER BY p.oid`)).rows;
const counts = async () => (await db.query(`SELECT
  (SELECT count(*) FROM public.central_needs_plans)::int plans,
  (SELECT count(*) FROM public.central_needs_plan_revisions)::int revisions,
  (SELECT count(*) FROM public.central_needs_manual_need_events)::int needs,
  (SELECT count(*) FROM public.central_needs_annual_items)::int materials,
  (SELECT count(*) FROM public.audit_logs)::int audit,
  (SELECT count(*) FROM public.warehouse_stock_movements)::int warehouse,
  (SELECT count(*) FROM public.outlet_stock_movements)::int outlet`)).rows[0];
let stage = 'target';
try {
  await db.connect();
  const identity = (await db.query('SELECT current_database() db,current_user actor,inet_server_port() port')).rows[0];
  assert.equal(identity.db, 'postgres'); assert.equal(identity.actor, 'postgres'); assert.equal(identity.port, 5432);
  assert(!(await employee.auth.signInWithPassword({ email: seed.centralNeeds.editor.email, password: seed.password })).error);
  assert(!(await outsider.auth.signInWithPassword({ email: seed.users.institutionAdminA.email, password: seed.password })).error);
  const plan = (await db.query('SELECT id,plan_year FROM public.central_needs_plans WHERE organization_id=$1 ORDER BY plan_year DESC LIMIT 1', [owner])).rows[0];
  assert(plan);
  const scope = { p_organization_id: owner, p_plan_year: plan.plan_year };
  const reads = [
    ['list_dossiers', 'dossiers', scope], ['annual_summary', 'annual_summary', scope],
    ['dossier_revisions', 'dossier_revisions', { p_plan_id: plan.id }],
  ];
  stage = 'reproduce';
  const old = await Promise.all(reads.map(([name, , args]) => employee.rpc(`phoenix_central_needs_${name}`, args)));
  check('all three legacy STABLE reads reproduce 25006 under actual employee POST RPC', old.every(r => r.error?.code === '25006'));
  const before = await counts(), original = await routines();
  stage = 'install';
  try { await db.query(candidate.toString('utf8')); } catch (error) { await db.query('ROLLBACK'); throw error; }
  let ready;
  for (let n = 0; n < 20; n += 1) {
    ready = await employee.rpc('phoenix_manual_read_dossiers_v1', scope);
    if (ready.error?.code !== 'PGRST202') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  check('new endpoint is visible after schema reload', !ready.error);
  stage = 'employee_reads';
  for (const [, name, args] of reads) {
    const result = await employee.rpc(`phoenix_manual_read_${name}_v1`, args);
    check(`${name} returns its original array shape through caller authority`, !result.error && Array.isArray(result.data)
      && (name !== 'dossier_revisions' || result.data.length > 0 && result.data.every(row => row.plan_id === plan.id)));
  }
  check('another institution cannot read any adapter', (await Promise.all(reads.map(([, name, args]) =>
    outsider.rpc(`phoenix_manual_read_${name}_v1`, args)))).every(r => Boolean(r.error)));
  check('anonymous cannot execute any adapter', (await Promise.all(reads.map(([, name, args]) =>
    anonymous.rpc(`phoenix_manual_read_${name}_v1`, args)))).every(r => Boolean(r.error)));
  stage = 'revocation';
  await db.query("UPDATE public.profile_permission_overrides SET allowed=false WHERE profile_id=$1 AND permission_key='central_needs.view'", [actor]);
  try {
    check('the same employee JWT observes current view revocation on every read', (await Promise.all(reads.map(([, name, args]) =>
      employee.rpc(`phoenix_manual_read_${name}_v1`, args)))).every(r => Boolean(r.error)));
  } finally { await db.query("UPDATE public.profile_permission_overrides SET allowed=true WHERE profile_id=$1 AND permission_key='central_needs.view'", [actor]); }
  check('prior full routine definitions ownership and ACLs are unchanged', JSON.stringify(await routines()) === JSON.stringify(original));
  check('no plan quantity identity audit or stock change', JSON.stringify(await counts()) === JSON.stringify(before));
  check('all independent prior seals remain satisfied', (await db.query(`SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()
    UNION ALL SELECT * FROM phoenix_r2.capability_breaches() UNION ALL SELECT * FROM phoenix_c4.capability_breaches_v1()
    UNION ALL SELECT * FROM phoenix_monthly.capability_breaches_v1()`)).rowCount === 0);
} catch { report.errors.push(`manual_read_failed_at_${stage}`); }
finally {
  await employee.auth.signOut(); await outsider.auth.signOut(); await db.end();
  report.passed = report.checks.length === 11 && report.checks.every(row => row.passed) && report.errors.length === 0;
  writeFileSync('docs/phoenix/e2e-acceptance/manual-read-adapters.json', JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
