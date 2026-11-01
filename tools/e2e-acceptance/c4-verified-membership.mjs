/** C4 SQL contract acceptance only: synthetic C2/Node evidence, real Auth and
 * separate service-seal / original employee-commit identities. No hosted SQL. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import * as XLSX from 'xlsx';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

const seed = JSON.parse(readFileSync(process.argv[2] || 'e2e-seed.json', 'utf8'));
const api = new URL(seed.supabaseUrl), database = new URL(seed.databaseUrl);
assert(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
assert.equal(api.protocol, 'http:'); assert.equal(api.hostname, '127.0.0.1'); assert.equal(api.port, '54321');
assert(['postgres:', 'postgresql:'].includes(database.protocol)); assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '54322'); assert.equal(database.username, 'postgres'); assert.equal(database.pathname, '/postgres');
assert.equal(database.search, ''); assert.equal(database.hash, '');
assert(seed.centralNeeds.editor.email.endsWith('@phoenix.local'));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const prerequisite = JSON.parse(readFileSync('docs/phoenix/e2e-acceptance/c3-read-worker.json', 'utf8'));
assert.equal(prerequisite.passed, true); assert.equal(prerequisite.commit, head);
const candidate = readFileSync(resolve('supabase/candidates/P3C4_verified_membership_NOT_APPLIED.sql'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const candidateSha256 = '0e6112b48e26ce35681970a1765f333efb1bab33f1ab679ec8194c55840130a7';
assert.equal(sha(candidate), candidateSha256);
const anonKey = process.env.SUPABASE_ANON_KEY; assert(anonKey);
const serviceKey = readFileSync('/tmp/sb-service-role-key.txt', 'utf8').trim(); assert(serviceKey);
process.env.PHOENIX_SUPABASE_URL = api.href; process.env.PHOENIX_SUPABASE_ANON_KEY = anonKey;
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const editor = createClient(api.href, anonKey, options), outsider = createClient(api.href, anonKey, options);
const service = createClient(api.href, serviceKey, options), anonymous = createClient(api.href, anonKey, options);
const db = new pg.Client({ connectionString: database.href, connectionTimeoutMillis: 5000 });
const output = resolve('docs/phoenix/e2e-acceptance');
const report = { phase: 'C4 inert SQL and trusted HTTP; employee review UI unavailable', commit: head, sourceHead: prerequisite.sourceHead,
  environment: 'hardened disposable local Supabase; synthetic workbook; real Auth/PostgREST', candidateSha256,
  checks: [], errors: [], productionSqlApplied: false, hostedCompatibility: prerequisite.hostedCompatibility };
const check = (name, passed) => { report.checks.push({ name, passed: Boolean(passed) }); console.log(`${passed ? 'PASS' : 'FAIL'} C4 ${name}`); };
const scope = { ownerOrgId: seed.centralNeeds.owningOrganization, planningYear: 2099 };
const actor = seed.centralNeeds.editor.id;
let stage = 'target_proof';
let server;
const rpc = async (client, name, args) => client.rpc(`phoenix_c4_${name}`, args);
const scopeArgs = { p_organization_id: scope.ownerOrgId, p_planning_year: scope.planningYear };
const counts = async () => (await db.query(`SELECT
  (SELECT count(*) FROM public.central_items)::int canonical,
  (SELECT count(*) FROM public.central_needs_annual_items)::int members,
  (SELECT count(*) FROM public.central_needs_annual_versions)::int versions,
  (SELECT count(*) FROM public.central_needs_annual_occurrences)::int occurrences,
  (SELECT count(*) FROM public.central_needs_annual_receipts)::int receipts,
  (SELECT count(*) FROM public.audit_logs)::int audit,
  (SELECT count(*) FROM phoenix_c4.commits)::int commits,
  (SELECT count(*) FROM phoenix_c4.proofs)::int proofs,
  (SELECT count(*) FROM public.central_needs_need_lines)::int needs,
  (SELECT count(*) FROM public.warehouse_stock_movements)::int stock,
  (SELECT count(*) FROM public.outlet_stock_movements)::int outlet`)).rows[0];
try {
  await db.connect();
  assert.equal((await db.query(`SELECT id FROM public.profiles WHERE id=$1 AND organization_id=$2 AND status='active'`, [actor, scope.ownerOrgId])).rowCount, 1);
  assert.equal((await db.query("SELECT to_regnamespace('phoenix_c4') existing")).rows[0].existing, null);
  assert.equal((await db.query('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()')).rowCount, 0);
  stage = 'install_candidate';
  try { await db.query(candidate.toString('utf8')); } catch (error) { await db.query('ROLLBACK'); throw error; }
  // Restore the synthetic editor view explicitly revoked by the preceding C3 negative proof.
  for (const key of ['view', 'edit']) await db.query(`INSERT INTO public.profile_permission_overrides(profile_id,permission_key,allowed)
    VALUES($1,$2,true) ON CONFLICT(profile_id,permission_key) DO UPDATE SET allowed=true`, [actor, `central_needs.${key}`]);
  const signed = await editor.auth.signInWithPassword({ email: seed.centralNeeds.editor.email, password: seed.password });
  assert(!signed.error && signed.data.user?.id === actor && signed.data.session);
  await db.query("NOTIFY pgrst, 'reload schema'");
  let response;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    response = await rpc(editor, 'catalog_contract', scopeArgs);
    if (response.error?.code !== 'PGRST202') break;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  assert(!response.error); check('real employee Auth sees an installed but inactive C4 contract', response.data.enabled === false);
  stage = 'actual_worker_evidence';
  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP, 'c4-actual-worker-'));
  const bridge = join(scratch, 'bridge.mjs'), worker = join(scratch, 'worker.mjs');
  const shared = { bundle: true, platform: 'node', target: 'node22', format: 'esm', logLevel: 'silent',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } };
  await build({ ...shared, stdin: { contents: `export {authenticate} from './api/_lib/supabase.ts';
    export {readAuthorizedAnnualC3Original} from './api/_cn2b-core/annual-c3-authorized-source.ts';
    export {runC3IsolatedWorker} from './api/_cn2b-core/annual-c3-worker-boundary.ts';
    export {callerHasCentralNeedsAuthority} from './api/_lib/supabase.ts';
    export {createC4MembershipHandler} from './api/_c4-core/http.ts';`, resolveDir: process.cwd() }, outfile: bridge });
  await build({ ...shared, entryPoints: ['api/_c3-core/worker-entry.ts'], outfile: worker });
  const { authenticate, readAuthorizedAnnualC3Original, runC3IsolatedWorker, callerHasCentralNeedsAuthority, createC4MembershipHandler } = await import(pathToFileURL(bridge).href);
  const caller = await authenticate(new Request('http://127.0.0.1/c4-test', { headers: { authorization: `Bearer ${signed.data.session.access_token}` } }));
  assert.equal(caller?.userId, actor);
  const code = `00-${randomUUID()}`, name = 'Synthetic C4 actual Auth identity';
  const canonical = (await db.query(`INSERT INTO public.central_items(name,name_ar,unit,national_code,status)
    VALUES($1,'مادة اصطناعية','box',$2,'active') RETURNING id`, [name, code])).rows[0].id;
  const preview = await caller.client.rpc('phoenix_central_needs_preview_annual_canonical', { ...scopeArgs, p_central_item_id: canonical });
  assert(!preview.error && preview.data.eligible);
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Name', 'Code', 'Unit', 'Quantity'], [name, code, 'box', 987654],
  ]), 'Identity');
  const bytes = Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  const stored = await caller.client.rpc('phoenix_central_needs_store_annual_original', { ...scopeArgs,
    p_filename: 'synthetic-c4-auth-source.xlsx', p_sha256: sha(bytes), p_byte_size: bytes.length, p_base64: bytes.toString('base64'),
    p_idempotency_key: `c4-source-${randomUUID()}`, p_expected_actor_id: caller.userId });
  assert(!stored.error && stored.data.original.originalId);
  const source = await readAuthorizedAnnualC3Original(caller, scope, stored.data.original.originalId);
  const manifest = { workbookSheets: [{ index: 0, name: 'Identity' }], template: { id: 'synthetic-c4-auth', version: 1,
    reviewReference: 'synthetic actual Auth review', parserContractVersion: '1.2.0', classificationCells: [],
    blocks: [{ blockId: 'identity', sheetIndex: 0, headerRow: 0, firstRow: 1, lastRow: 9999, classification: null,
      mappingReference: 'synthetic-only', columns: { scientificName: { column: 0, expectedHeaderText: 'Name' },
        nationalCode: { column: 1, expectedHeaderText: 'Code' }, unit: { column: 2, expectedHeaderText: 'Unit' } } }] } };
  const page = await runC3IsolatedWorker(pathToFileURL(worker), { source,
    template: { manifest, expectedSha256: sha(JSON.stringify(manifest)) }, pageSize: 50, cursor: null });
  assert.equal(page.preparationStatus, 'prepared'); assert(!JSON.stringify(page).includes('987654'));
  const evidence = { scope: page.scope, original: { ...page.original, firstFilename: source.original.firstFilename },
    template: page.template, coreTemplate: page.coreTemplate, parser: page.parser, registrySha256: page.registrySha256,
    classifications: page.classifications, rows: page.rows, workerSha256: sha(readFileSync(worker)) };
  const args = { ...scopeArgs, p_actor_id: caller.userId, p_request_id: randomUUID(), p_canonical_id: canonical,
    p_expected_canonical_fingerprint: preview.data.canonicalFingerprint, p_evidence: evidence, p_reason: 'Explicit synthetic identity review' };
  response = await rpc(service, 'seal', args); check('installation does not activate preparation', response.error?.message?.includes('c4_not_enabled'));
  await db.query("INSERT INTO phoenix_c4.activation_events(enabled,reason) VALUES(true,'Explicit disposable Auth acceptance only')");
  stage = 'separate_identities';
  check('employee cannot call the service-only seal', Boolean((await rpc(caller.client, 'seal', args)).error));
  response = await rpc(service, 'seal', args); assert(!response.error); const proof = response.data;
  check('separate service identity prepares a bounded proof after actual C2 and worker verification', Boolean(proof.proofId));
  const commitArgs = { ...scopeArgs, p_request_id: args.p_request_id, p_proof_id: proof.proofId, p_expected_proof_sha256: proof.proofSha256 };
  check('service cannot commit as the employee', Boolean((await rpc(service, 'commit', commitArgs)).error));
  check('anonymous cannot commit a sealed proof', Boolean((await rpc(anonymous, 'commit', commitArgs)).error));
  const foreign = await outsider.auth.signInWithPassword({ email: seed.users.institutionAdminA.email, password: seed.password });
  assert(!foreign.error && foreign.data.session);
  check('another institution JWT cannot commit the proof', Boolean((await rpc(outsider, 'commit', commitArgs)).error));
  const before = await counts();
  const handler = createC4MembershipHandler({ registrations: [manifest], workerEntry: pathToFileURL(worker),
    authenticate, authorized: callerHasCentralNeedsAuthority, read: readAuthorizedAnnualC3Original,
    run: runC3IsolatedWorker, service: () => service, workerSha256: async () => sha(readFileSync(worker)) });
  server = createServer(async (req, res) => {
    try {
      const response = await handler(new Request('http://127.0.0.1/central-needs/commit-verified-membership', {
        method: req.method, headers: Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value ?? ''])),
        body: Readable.toWeb(req), duplex: 'half' }));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/central-needs/commit-verified-membership`;
  const httpInput = { scope, requestId: args.p_request_id, originalId: source.original.originalId,
    expectedOriginalSha256: source.original.sha256, templateId: manifest.template.id, templateVersion: 1,
    expectedTemplateSha256: sha(JSON.stringify(manifest)), cursor: null, pageSize: 50,
    occurrenceKeys: page.rows.map(row => row.occurrenceKey), canonicalItemId: canonical,
    expectedCanonicalFingerprint: preview.data.canonicalFingerprint, reason: args.p_reason };
  const send = (token, body = httpInput) => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  check('anonymous HTTP cannot prepare or commit', (await send(null)).status === 401);
  check('foreign institution HTTP is refused before preparing evidence', (await send(foreign.data.session.access_token)).status === 403);
  check('HTTP rejects browser quantities and stale source identity without effects',
    (await send(signed.data.session.access_token, { ...httpInput, annualQuantity: 987654 })).status === 400
    && (await send(signed.data.session.access_token, { ...httpInput, expectedOriginalSha256: 'f'.repeat(64) })).status === 409
    && JSON.stringify(await counts()) === JSON.stringify(before));
  stage = 'employee_commit';
  const httpResponse = await send(signed.data.session.access_token); const body = await httpResponse.json();
  assert.equal(httpResponse.status, 200); assert.equal(body.ok, true);
  check('actual HTTP reruns C2 and the compiled worker before committing with the employee JWT', httpResponse.headers.get('cache-control') === 'no-store');
  const saved = body.result, after = await counts();
  check('original employee JWT commits one membership and preserves the old source attestation', saved.idempotentReplay === false
    && saved.sourceAttestation === 'client_attested' && saved.c4Verification.reviewedById === actor
    && saved.c4Verification.attestation === 'server_verified_c2_extraction_v1'
    && after.members === before.members + 1 && after.versions === before.versions + 1 && after.commits === before.commits + 1);
  response = await rpc(caller.client, 'commit', commitArgs);
  check('repeated delivery does not duplicate effects', !response.error && response.data.idempotentReplay === true
    && JSON.stringify(await counts()) === JSON.stringify(after));
  response = await rpc(caller.client, 'receipt', { ...scopeArgs, p_request_id: args.p_request_id });
  check('readback resolves a lost response and requires fresh selection', !response.error && response.data.status === 'committed'
    && response.data.result.selectable === false && response.data.result.idempotentReplay === true);
  await db.query("UPDATE public.profile_permission_overrides SET allowed=false WHERE profile_id=$1 AND permission_key='central_needs.edit'", [actor]);
  check('the same employee JWT observes current edit revocation', Boolean((await rpc(caller.client, 'commit', commitArgs)).error)
    && JSON.stringify(await counts()) === JSON.stringify(after));
  check('HTTP observes the same JWT revocation without new effects', (await send(signed.data.session.access_token)).status === 403
    && JSON.stringify(await counts()) === JSON.stringify(after));
  check('no canonical, need quantity or stock change; all capability seals stay closed', after.canonical === before.canonical
    && after.needs === before.needs && after.stock === before.stock && after.outlet === before.outlet
    && (await db.query('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()')).rowCount === 0
    && (await db.query('SELECT * FROM phoenix_c4.capability_breaches_v1()')).rowCount === 0
    && (await db.query('SELECT * FROM phoenix_r2.capability_breaches()')).rowCount === 0);
} catch {
  report.errors.push(`c4_disposable_integration_failed_at_${stage}`); check('integration completed', false);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await editor.auth.signOut(); await outsider.auth.signOut(); await db.end();
  report.passed = report.checks.length === 17 && report.checks.every(c => c.passed) && report.errors.length === 0;
  mkdirSync(output, { recursive: true }); writeFileSync(join(output, 'c4-verified-membership.json'), JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
