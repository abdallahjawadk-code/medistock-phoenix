/** Existing R1 view authority; names-only lookup, never hosted. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const api = new URL(seed.supabaseUrl), database = new URL(seed.databaseUrl);
assert(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
assert.equal(api.href, 'http://127.0.0.1:54321/');
assert(['postgres:', 'postgresql:'].includes(database.protocol)); assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '54322'); assert.equal(database.username, 'postgres'); assert.equal(database.pathname, '/postgres');
assert.equal(database.search, ''); assert.equal(database.hash, '');
const prerequisite = JSON.parse(readFileSync('docs/phoenix/e2e-acceptance/manual-read-adapters.json', 'utf8'));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert(prerequisite.passed && prerequisite.commit === head); assert(process.env.SUPABASE_ANON_KEY);
const candidate = readFileSync('supabase/candidates/R1_beneficiary_catalog_read_NOT_APPLIED.sql');
const candidateSha256 = createHash('sha256').update(candidate).digest('hex'); assert.equal(candidateSha256, '2fd7c4865afe7b02481219793a30bb8703ec0c48b79fa976aaa5ba47f0b1d572');
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const client = () => createClient(api.href, process.env.SUPABASE_ANON_KEY, options);
const employee = client(), outsider = client(), anonymous = client();
const service = createClient(api.href, readFileSync('/tmp/sb-service-role-key.txt', 'utf8').trim(), options);
const db = new pg.Client({ connectionString: database.href, connectionTimeoutMillis: 5000 });
const owner = seed.centralNeeds.owningOrganization, actor = seed.centralNeeds.editor.id, beneficiary = seed.centralNeeds.beneficiaryOrganization;
const report = { commit: head, sourceHead: prerequisite.sourceHead, candidateSha256, productionSqlApplied: false,
  hostedCompatibility: prerequisite.hostedCompatibility, environment: 'disposable loopback; real Auth; names-only annual reader', checks: [], errors: [] };
const check = (name, passed) => { report.checks.push({ name, passed: Boolean(passed) }); console.log(`${passed ? 'PASS' : 'FAIL'} Annual beneficiaries ${name}`); assert(passed, name); };
const read = (caller = employee, after = null, limit = 50, selectedOwner = owner) => caller.rpc('phoenix_manual_beneficiaries_v1', {
  p_organization_id: selectedOwner, p_after_id: after, p_limit: limit,
});
const directory = () => employee.from('organizations').select('id,organization_kind,status,archived_at').in('id', [owner,beneficiary]);
const routines = async () => (await db.query(`SELECT p.oid,pg_get_functiondef(p.oid) definition,p.proacl,p.proowner
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname='public' OR n.nspname LIKE 'phoenix%')
  AND p.prokind IN ('f','p') AND p.proname<>'phoenix_manual_beneficiaries_v1' ORDER BY p.oid`)).rows;
const policies = async () => (await db.query("SELECT * FROM pg_policies WHERE schemaname='public' AND tablename='organizations' ORDER BY policyname")).rows;
const counts = async () => (await db.query(`SELECT
  (SELECT count(*) FROM public.central_needs_plans)::int plans,
  (SELECT count(*) FROM public.central_needs_manual_need_events)::int needs,
  (SELECT count(*) FROM public.central_needs_annual_items)::int materials,
  (SELECT count(*) FROM public.audit_logs)::int audit,
  (SELECT count(*) FROM public.warehouse_stock_movements)::int warehouse,
  (SELECT count(*) FROM public.outlet_stock_movements)::int outlet`)).rows[0];
let stage = 'target';
try {
  await db.connect(); const identity = (await db.query('SELECT current_database() db,current_user actor,inet_server_port() port')).rows[0];
  assert.equal(identity.db, 'postgres'); assert.equal(identity.actor, 'postgres'); assert.equal(identity.port, 5432);
  assert(!(await employee.auth.signInWithPassword({ email: seed.centralNeeds.editor.email, password: seed.password })).error);
  assert(!(await outsider.auth.signInWithPassword({ email: seed.users.institutionAdminA.email, password: seed.password })).error);
  stage = 'reproduce_directory_boundary'; const raw = await directory();
  const expected = (await db.query(`SELECT id,name,coalesce(nullif(name_ar,''),name) "nameAr" FROM public.organizations
    WHERE organization_kind='care_institution' AND status='active' AND archived_at IS NULL ORDER BY id`)).rows;
  check('actual employee directory contains own PDA only while the selected care institution is eligible', !raw.error
    && raw.data.length === 1 && raw.data[0].id === owner && raw.data[0].organization_kind === 'pharmacy_department_authority'
    && expected.some(row => row.id === beneficiary) && expected.length > 1);
  const original = await routines(), oldPolicies = await policies(), before = await counts();
  stage = 'install'; try { await db.query(candidate.toString('utf8')); } catch (error) { await db.query('ROLLBACK'); throw error; }
  let response;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    response = await read(); if (response.error?.code !== 'PGRST202') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  check('employee reads the bounded current owner envelope after schema reload', !response.error && response.data.version === 1 && response.data.ownerOrgId === owner);
  const rows = []; let cursor = null;
  do { response = await read(employee,cursor); assert(!response.error); rows.push(...response.data.rows); cursor = response.data.nextAfterId; } while (cursor !== null && rows.length <= 10000);
  check('only eligible names are exposed, with exact three-field rows and no directory contact metadata', cursor === null
    && JSON.stringify(rows) === JSON.stringify(expected) && rows.every(row => Object.keys(row).sort().join(',') === 'id,name,nameAr'));
  const one = await read(employee,null,1); assert(!one.error);
  const two = await read(employee,one.data.nextAfterId,1); assert(!two.error);
  check('keyset pagination returns the next eligible institution without repeating the first', one.data.rows[0].id === expected[0].id
    && one.data.nextAfterId === expected[0].id && two.data.rows[0].id === expected[1].id);
  check('anonymous cannot execute the reader', Boolean((await read(anonymous)).error));
  check('service identity cannot replace the employee caller', Boolean((await read(service)).error));
  check('another institution cannot enumerate through the owner capability', Boolean((await read(outsider)).error));
  check('invalid row limits are refused', (await read(employee,null,0)).error?.code === '23514' && (await read(employee,null,51)).error?.code === '23514');
  stage = 'revocation';
  await db.query("UPDATE public.profile_permission_overrides SET allowed=false WHERE profile_id=$1 AND permission_key='central_needs.view'", [actor]);
  try { check('same JWT observes current view revocation', Boolean((await read()).error)); }
  finally { await db.query("UPDATE public.profile_permission_overrides SET allowed=true WHERE profile_id=$1 AND permission_key='central_needs.view'", [actor]); }
  const afterDirectory = await directory();
  check('general directory RLS, old routine definitions and all business counts stay unchanged', !afterDirectory.error
    && JSON.stringify(afterDirectory.data) === JSON.stringify(raw.data) && JSON.stringify(await policies()) === JSON.stringify(oldPolicies)
    && JSON.stringify(await routines()) === JSON.stringify(original) && JSON.stringify(await counts()) === JSON.stringify(before));
  check('all accepted capability seals remain satisfied', (await db.query(`SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()
    UNION ALL SELECT * FROM phoenix_r2.capability_breaches() UNION ALL SELECT * FROM phoenix_c4.capability_breaches_v1()
    UNION ALL SELECT * FROM phoenix_monthly.capability_breaches_v1()`)).rowCount === 0);
} catch { report.errors.push(`annual_beneficiaries_failed_at_${stage}`); }
finally {
  await employee.auth.signOut(); await outsider.auth.signOut(); await db.end();
  report.passed = report.checks.length === 11 && report.checks.every(row => row.passed) && report.errors.length === 0;
  writeFileSync('docs/phoenix/e2e-acceptance/annual-beneficiaries.json', JSON.stringify(report, null, 2)); if (!report.passed) process.exitCode = 1;
}
