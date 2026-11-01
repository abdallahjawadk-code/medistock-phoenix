/** Authority foundation only. Runs AFTER the existing browser acceptance in
 * its disposable loopback stack. No allocation/stock/settlement writer. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const seed = JSON.parse(readFileSync(process.argv[2] || 'e2e-seed.json', 'utf8'));
const api = new URL(seed.supabaseUrl), database = new URL(seed.databaseUrl);
assert.equal(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true', true);
assert.equal(api.protocol, 'http:'); assert.equal(api.hostname, '127.0.0.1'); assert.equal(api.port, '54321');
assert(['postgres:', 'postgresql:'].includes(database.protocol));
assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '54322');
assert.equal(database.username, 'postgres'); assert.equal(database.pathname, '/postgres');
assert.equal(database.search, ''); assert.equal(database.hash, '');
assert(seed.centralNeeds.editor.email.endsWith('@phoenix.local'));
const anonKey = process.env.SUPABASE_ANON_KEY; assert(anonKey);
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const editor = createClient(api.href, anonKey, options), outsider = createClient(api.href, anonKey, options);
const anonymous = createClient(api.href, anonKey, options);
const db = new pg.Client({ connectionString: database.href, connectionTimeoutMillis: 5000 });
const sourceHead = process.env.GITHUB_EVENT_PATH
  ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request?.head?.sha ?? process.env.GITHUB_SHA : null;
const report = { phase: 'R2-A authority foundation; operational writers unimplemented',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceHead,
  recordedAt: new Date().toISOString(), environment: 'disposable local Supabase; synthetic fixtures; real Auth/PostgREST',
  candidates: [], checks: [], errors: [], diagnostics: [] };
const check = (name, passed) => { report.checks.push({ name, passed: Boolean(passed) }); console.log(`${passed ? 'PASS' : 'FAIL'} R2-A ${name}`); };
const candidates = {
  'P1_dossier_workbook_reservation_NOT_APPLIED.sql': 'd0f914e47b559fa027e9372beb17dc5cc4fe46affee29b480149b5a3be9440ff',
  'P3A1_annual_catalog_NOT_APPLIED.sql': '1cfab7101634410288702e71bde670d6816ceeaea1dd06a21f510f9cc86e90bf',
  'P3B_annual_needs_audit_NOT_APPLIED.sql': 'a761e97aa8c2c37ed1790d645d55ec26e1945c887f6402f9179d72e6a5d41074',
  'P3C2_annual_originals_NOT_APPLIED.sql': '17cd88fa51492c9b5722c4ae95a31275976360205f82584f46c676b65522f600',
  'R2A_authority_NOT_APPLIED.sql': 'a48040a57082fd2519661c755f87c7d2f32c2e8efc351a120308e65b03c56d71',
};
// Snapshot/pin EVERY candidate before the first database mutation.
const programs = Object.entries(candidates).map(([name, sha256]) => {
  const bytes = readFileSync(resolve('supabase/candidates', name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
  report.candidates.push({ name, sha256 }); return bytes.toString('utf8');
});
const capability = () => editor.rpc('phoenix_r2_capabilities', { p_organization_id: seed.centralNeeds.owningOrganization });
try {
  await db.connect();
  const owner = await db.query(`SELECT p.id FROM public.profiles p JOIN public.organizations o ON o.id=p.organization_id
    JOIN auth.users u ON u.id=p.id WHERE p.id=$1 AND p.organization_id=$2 AND p.status='active'
    AND o.organization_kind='pharmacy_department_authority' AND u.email=$3`,
  [seed.centralNeeds.editor.id, seed.centralNeeds.owningOrganization, seed.centralNeeds.editor.email]);
  assert.equal(owner.rowCount, 1);
  assert.equal((await db.query("SELECT to_regprocedure('public.phoenix_r2_capabilities(uuid)') existing")).rows[0].existing, null);
  const targetIdentity = await db.query(`SELECT current_database() database,current_user actor,session_user session_actor,
    pg_get_userbyid(datdba) database_owner FROM pg_database WHERE datname=current_database()`);
  report.diagnostics.push({ kind: 'disposable_target_identity', identity: targetIdentity.rows[0] });
  report.diagnostics.push({ kind: 'prior_seal_before_candidates', breaches: (await db.query('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()')).rows });
  for (const [index, program] of programs.entries()) {
    try { await db.query(program); }
    catch (error) {
      await db.query('ROLLBACK');
      // Diagnostic-only replay: preserve the same failing verification and
      // rollback; enrich its exception with object/ACL metadata. This is never
      // accepted execution, and no candidate source file or guard is changed.
      if (report.candidates[index].name === 'P3A1_annual_catalog_NOT_APPLIED.sql'
          && error.message?.includes('P3A1_verify_failed: capability seal')) {
        const failingGuard = "RAISE EXCEPTION 'P3A1_verify_failed: capability seal';";
        assert(program.includes(failingGuard));
        const diagnostic = program.replace(failingGuard, "RAISE EXCEPTION 'P3A1_verify_failed: capability seal details %', (SELECT jsonb_agg(breach) FROM phoenix_private.central_needs_capability_breaches_v1() AS t(breach));");
        try { await db.query(diagnostic); throw new Error('Expected diagnostic verification refusal did not occur'); }
        catch (diagnosticError) { report.diagnostics.push({ kind: 'failed_candidate_verification_only', message: diagnosticError.message }); }
        finally { await db.query('ROLLBACK'); }
      }
      throw error;
    }
    assert.equal((await db.query('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()')).rowCount, 0);
  }
  check('pinned candidates apply only after the synthetic local target proof', true);
  const signed = await editor.auth.signInWithPassword({ email: seed.centralNeeds.editor.email, password: seed.password });
  assert(!signed.error && signed.data.user?.id === seed.centralNeeds.editor.id);
  check('editor signs in through real Auth using the anon client', true);
  await db.query("NOTIFY pgrst, 'reload schema'");
  // Schema-cache reload is asynchronous; retry discovery only for the precise
  // missing-function response, never business refusals or write commands.
  let response;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    response = await capability();
    if (response.error?.code !== 'PGRST202') break;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  assert(!response.error);
  check('real PostgREST reports inactive authority and no operational writer', response.data.authorityActivated === false
    && response.data.operationalWritesImplemented === false && response.data.view === false && response.data.create === false);
  const deniedAnon = await anonymous.rpc('phoenix_r2_capabilities', { p_organization_id: seed.centralNeeds.owningOrganization });
  check('anonymous discovery is refused', Boolean(deniedAnon.error));
  const otherSigned = await outsider.auth.signInWithPassword({ email: seed.users.institutionAdminA.email, password: seed.password });
  assert(!otherSigned.error && otherSigned.data.user?.id === seed.users.institutionAdminA.id);
  const deniedOther = await outsider.rpc('phoenix_r2_capabilities', { p_organization_id: seed.centralNeeds.owningOrganization });
  check('cross-owner JWT discovery is refused', deniedOther.error?.code === '42501');
  for (const suffix of ['view', 'create']) await db.query(`INSERT INTO public.profile_permission_overrides(profile_id,permission_key,allowed)
    VALUES($1,$2,true)`, [seed.centralNeeds.editor.id, `central_needs.allocation.${suffix}`]);
  response = await capability(); assert(!response.error);
  check('explicit keys do not activate authority', response.data.view === true && response.data.create === false && response.data.authorityActivated === false);
  await db.query(`INSERT INTO phoenix_r2.activation_events(organization_id,enabled,release_reference)
    VALUES($1,true,'disposable-real-Auth-authority-proof-only')`, [seed.centralNeeds.owningOrganization]);
  response = await capability(); assert(!response.error);
  check('database-owned test activation exposes only granted authority', response.data.create === true && response.data.approve === false
    && response.data.operationalWritesImplemented === false);
  await db.query("UPDATE public.profile_permission_overrides SET allowed=false WHERE profile_id=$1 AND permission_key='central_needs.allocation.create'", [seed.centralNeeds.editor.id]);
  response = await capability(); assert(!response.error);
  check('same JWT observes revoked current permission', response.data.create === false);
  await db.query(`INSERT INTO phoenix_r2.activation_events(organization_id,enabled,release_reference)
    VALUES($1,false,'disposable-real-Auth-authority-proof-deactivation')`, [seed.centralNeeds.owningOrganization]);
  response = await capability(); assert(!response.error);
  check('deactivation is observed without deleting release history', response.data.authorityActivated === false);
  check('R2 and prior capability seals remain closed', (await db.query('SELECT * FROM phoenix_r2.capability_breaches()')).rowCount === 0
    && (await db.query('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()')).rowCount === 0);
} catch (error) {
  report.errors.push(error instanceof Error ? error.message : 'Unexpected authority-proof failure'); check('authority proof completed', false);
} finally {
  await editor.auth.signOut(); await outsider.auth.signOut(); await db.end();
  report.passed = report.checks.length === 10 && report.checks.every(item => item.passed) && report.errors.length === 0;
  const directory = resolve('docs/phoenix/e2e-acceptance'); mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'r2a-authority.json'), JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
