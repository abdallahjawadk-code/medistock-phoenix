/** Documented metadata acceptance only. No effective quotas, journal or stock.
 * Owner publication is synthetic/private; employee reads use real Auth. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const seed = JSON.parse(readFileSync(process.argv[2] || 'e2e-seed.json', 'utf8'));
const api = new URL(seed.supabaseUrl), database = new URL(seed.databaseUrl);
assert(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
assert.equal(api.protocol, 'http:'); assert.equal(api.hostname, '127.0.0.1'); assert.equal(api.port, '54321');
assert(['postgres:', 'postgresql:'].includes(database.protocol)); assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '54322'); assert.equal(database.username, 'postgres'); assert.equal(database.pathname, '/postgres');
assert.equal(database.search, ''); assert.equal(database.hash, '');
assert(seed.centralNeeds.editor.email.endsWith('@phoenix.local'));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const prerequisite = JSON.parse(readFileSync('docs/phoenix/e2e-acceptance/c4-verified-membership.json', 'utf8'));
assert.equal(prerequisite.passed, true); assert.equal(prerequisite.commit, head);
const candidate = readFileSync(resolve('supabase/candidates/R2B_monthly_policy_reference_NOT_APPLIED.sql'));
const candidateSha256 = '6fa6b74b0662003609ef8119a1fbb0f60002a456254045d3f6f95f463bece0b4';
assert.equal(createHash('sha256').update(candidate).digest('hex'), candidateSha256);
const anonKey = process.env.SUPABASE_ANON_KEY; assert(anonKey);
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const editor = createClient(api.href, anonKey, options), outsider = createClient(api.href, anonKey, options);
const anonymous = createClient(api.href, anonKey, options);
const db = new pg.Client({ connectionString: database.href, connectionTimeoutMillis: 5000 });
const report = { phase: 'Documented monthly reference only; employee journal/effective allocations unavailable',
  commit: head, sourceHead: prerequisite.sourceHead, candidateSha256, productionSqlApplied: false,
  environment: 'hardened disposable local Supabase; synthetic documented policy; real Auth/PostgREST',
  hostedCompatibility: prerequisite.hostedCompatibility, checks: [], errors: [] };
const check = (name, passed) => { report.checks.push({ name, passed: Boolean(passed) }); console.log(`${passed ? 'PASS' : 'FAIL'} Monthly ${name}`); };
const owner = seed.centralNeeds.owningOrganization, actor = seed.centralNeeds.editor.id, year = 2098;
const beneficiary = seed.centralNeeds.beneficiaryOrganization;
const scopeArgs = { p_organization_id: owner, p_planning_year: year };
const counts = async () => (await db.query(`SELECT
  (SELECT count(*) FROM public.central_items)::int canonical,
  (SELECT count(*) FROM public.central_needs_annual_items)::int members,
  (SELECT count(*) FROM public.central_needs_annual_versions)::int versions,
  (SELECT count(*) FROM public.central_needs_manual_need_events)::int needs,
  (SELECT count(*) FROM public.warehouse_stock_movements)::int stock,
  (SELECT count(*) FROM public.outlet_stock_movements)::int outlet,
  (SELECT count(*) FROM public.audit_logs)::int audit`)).rows[0];
let stage = 'target_proof';
try {
  await db.connect();
  assert.equal((await db.query(`SELECT p.id FROM public.profiles p JOIN auth.users u ON u.id=p.id
    WHERE p.id=$1 AND p.organization_id=$2 AND p.status='active' AND u.email=$3`, [actor, owner, seed.centralNeeds.editor.email])).rowCount, 1);
  assert.equal((await db.query("SELECT to_regnamespace('phoenix_monthly') existing")).rows[0].existing, null);
  check('pinned candidate and same-commit synthetic loopback prerequisite verified', true);
  stage = 'install_candidate';
  try { await db.query(candidate.toString('utf8')); } catch (error) { await db.query('ROLLBACK'); throw error; }
  // Restore only the synthetic authority explicitly revoked by preceding proofs.
  for (const key of ['view', 'edit']) await db.query(`INSERT INTO public.profile_permission_overrides(profile_id,permission_key,allowed)
    VALUES($1,$2,true) ON CONFLICT(profile_id,permission_key) DO UPDATE SET allowed=true`, [actor, `central_needs.${key}`]);
  const signed = await editor.auth.signInWithPassword({ email: seed.centralNeeds.editor.email, password: seed.password });
  assert(!signed.error && signed.data.user?.id === actor);
  const canonical = (await db.query(`INSERT INTO public.central_items(name,name_ar,unit,national_code,status)
    VALUES('Synthetic monthly policy','مادة اصطناعية','box',$1,'active') RETURNING id`, [`MONTHLY-${randomUUID()}`])).rows[0].id;
  assert(!(await editor.rpc('phoenix_central_needs_open_catalog_year', { ...scopeArgs, p_idempotency_key: `monthly-year-${randomUUID()}` })).error);
  const preview = await editor.rpc('phoenix_central_needs_preview_annual_canonical', { ...scopeArgs, p_central_item_id: canonical }); assert(!preview.error);
  const member = await editor.rpc('phoenix_central_needs_add_annual_catalog_item', { ...scopeArgs, p_central_item_id: canonical,
    p_expected_canonical_fingerprint: preview.data.canonicalFingerprint, p_occurrences: [], p_reason: 'Explicit synthetic yearly membership',
    p_idempotency_key: `monthly-member-${randomUUID()}` }); assert(!member.error);
  const args = { ...scopeArgs, p_annual_item_id: member.data.membership.annualItemId, p_field_version_id: member.data.fieldVersion.fieldVersionId,
    p_canonical_id: canonical, p_beneficiary_id: beneficiary };
  const context = { ownerOrgId: owner, planningYear: year, annualItemId: args.p_annual_item_id, fieldVersionId: args.p_field_version_id,
    canonicalItemId: canonical, unit: 'box', beneficiaryOrganizationId: beneficiary };
  const read = (client = editor, selectedArgs = args) => client.rpc('phoenix_monthly_policy_reference', selectedArgs);
  await db.query("NOTIFY pgrst, 'reload schema'"); let response;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    response = await read(); if (response.error?.code !== 'PGRST202') break;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  assert(!response.error); check('real employee Auth sees awaiting policy with no default step or periods', response.data.status === 'awaiting_policy');
  check('anonymous cannot read policy metadata', Boolean((await read(anonymous)).error));
  const foreign = await outsider.auth.signInWithPassword({ email: seed.users.institutionAdminA.email, password: seed.password }); assert(!foreign.error);
  check('another institution JWT cannot read the owner policy', Boolean((await read(outsider)).error));
  check('employee cannot access the private policy table or publisher', Boolean((await editor.schema('phoenix_monthly').from('policy_references').select('id')).error)
    && Boolean((await editor.schema('phoenix_monthly').rpc('publish_reference_v1', {})).error));
  const baseline = await counts(); stage = 'owner_publication';
  const generic = { policyId: randomUUID(), version: 1, fingerprint: 'a'.repeat(64), status: 'approved',
    context: { ...context, beneficiaryOrganizationId: null }, unitStep: '0.25', eligibleMonths: [2, 4, 6],
    fixedMonths: [{ month: 1, quantity: '2.5', status: 'approved', ledgerReference: 'synthetic-approved-month' }],
    basis: { beneficiaryOrganizationId: beneficiary, documentReference: 'Synthetic documented step', documentSha256: 'b'.repeat(64),
      periodReference: 'Synthetic eligible-month decision', priorAllocationStatus: 'snapshot_verified', ledgerSnapshotSha256: 'c'.repeat(64),
      approvedById: actor, approvedByName: 'FORGED INPUT NAME', approvedAt: '2026-01-01T10:00:00.000Z' } };
  const publish = (value, previous = null, active = true) => db.query('SELECT phoenix_monthly.publish_reference_v1($1::jsonb,$2,$3)', [JSON.stringify(value), previous, active]);
  await publish(generic); response = await read(); assert(!response.error && response.data.status === 'ready');
  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP, 'monthly-reference-model-')), model = join(scratch, 'model.mjs');
  await build({ stdin: { contents: `export {decodeMonthlyPolicyReference,proposeFromMonthlyPolicy} from './src/features/central-needs/allocation/monthly-proposal-reference.ts';`, resolveDir: process.cwd() },
    outfile: model, bundle: true, platform: 'node', target: 'node22', format: 'esm', logLevel: 'silent' });
  const { decodeMonthlyPolicyReference, proposeFromMonthlyPolicy } = await import(pathToFileURL(model).href);
  const reference = decodeMonthlyPolicyReference(response.data.reference, context);
  const proposed = proposeFromMonthlyPolicy('10.25', context, reference);
  check('private owner publication reads through real employee Auth and the exact client model', reference.basis.approvedById === actor
    && reference.basis.approvedByName !== 'FORGED INPUT NAME' && proposed.status === 'ready' && proposed.effectiveAllocation === false
    && JSON.stringify(proposed.rows.map(row => row.quantity)) === JSON.stringify(['2.5', '2.75', '2.5', '2.5']));
  response = await read(editor, { ...args, p_beneficiary_id: seed.centralNeeds.secondBeneficiaryOrganization });
  check('another beneficiary does not inherit fixed quantities or verified absence', !response.error && response.data.status === 'awaiting_policy');
  const specific = { ...generic, policyId: randomUUID(), context: { ...context } }; await publish(specific);
  response = await read(); assert(!response.error && response.data.status === 'awaiting_policy' && response.data.reason === 'ambiguous');
  await publish({ ...specific, policyId: randomUUID(), version: 2 }, specific.policyId, false); response = await read();
  check('ambiguity stays held until an explicit owner withdrawal, without first-match selection', !response.error && response.data.status === 'ready');
  stage = 'current_authority';
  await db.query("UPDATE public.profile_permission_overrides SET allowed=false WHERE profile_id=$1 AND permission_key='central_needs.view'", [actor]);
  try { check('the same employee JWT observes current view revocation', Boolean((await read()).error)); }
  finally { await db.query("UPDATE public.profile_permission_overrides SET allowed=true WHERE profile_id=$1 AND permission_key='central_needs.view'", [actor]); }
  const capability = await editor.rpc('phoenix_r2_capabilities', { p_organization_id: owner }); assert(!capability.error);
  check('all prior seals and business counts stay unchanged; no effective writer is activated',
    JSON.stringify(await counts()) === JSON.stringify(baseline) && capability.data.operationalWritesImplemented === false
    && (await db.query('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()')).rowCount === 0
    && (await db.query('SELECT * FROM phoenix_r2.capability_breaches()')).rowCount === 0
    && (await db.query('SELECT * FROM phoenix_c4.capability_breaches_v1()')).rowCount === 0
    && (await db.query('SELECT * FROM phoenix_monthly.capability_breaches_v1()')).rowCount === 0);
} catch {
  report.errors.push(`monthly_reference_acceptance_failed_at_${stage}`); check('integration completed', false);
} finally {
  await editor.auth.signOut(); await outsider.auth.signOut(); await db.end();
  report.passed = report.checks.length === 10 && report.checks.every(item => item.passed) && report.errors.length === 0;
  const output = resolve('docs/phoenix/e2e-acceptance'); mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'monthly-policy-reference.json'), JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
