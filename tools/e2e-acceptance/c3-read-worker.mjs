/** Actual C2/Auth/Node-worker integration, after the disposable R2 prerequisite.
 * Synthetic source only. No catalog, need quantity, allocation or stock writer. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import * as XLSX from 'xlsx';

const seed = JSON.parse(readFileSync(process.argv[2] || 'e2e-seed.json', 'utf8'));
const api = new URL(seed.supabaseUrl), database = new URL(seed.databaseUrl);
assert(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
assert.equal(api.protocol, 'http:'); assert.equal(api.hostname, '127.0.0.1'); assert.equal(api.port, '54321');
assert(['postgres:', 'postgresql:'].includes(database.protocol)); assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '54322'); assert.equal(database.username, 'postgres'); assert.equal(database.pathname, '/postgres');
assert.equal(database.search, ''); assert.equal(database.hash, '');
assert(seed.centralNeeds.editor.email.endsWith('@phoenix.local'));
const prerequisite = JSON.parse(readFileSync('docs/phoenix/e2e-acceptance/r2a-authority.json', 'utf8'));
assert.equal(prerequisite.passed, true);
assert.equal(prerequisite.commit, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
const anonKey = process.env.SUPABASE_ANON_KEY; assert(anonKey);
process.env.PHOENIX_SUPABASE_URL = api.href;
process.env.PHOENIX_SUPABASE_ANON_KEY = anonKey;
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const editor = createClient(api.href, anonKey, options), outsider = createClient(api.href, anonKey, options);
const db = new pg.Client({ connectionString: database.href, connectionTimeoutMillis: 5000 });
const output = resolve('docs/phoenix/e2e-acceptance');
const scratch = mkdtempSync(join(process.env.RUNNER_TEMP, 'c3-actual-worker-'));
const report = { phase: 'C3 read-only caller and actual worker integration; HTTP/hosted activation unimplemented',
  commit: prerequisite.commit, sourceHead: prerequisite.sourceHead, environment: 'hardened disposable local Supabase; synthetic workbook',
  checks: [], errors: [], productionSqlApplied: false, hostedCompatibility: prerequisite.platformProfile.productionCompatibility };
let stage = 'verify_target';
const check = (name, passed) => { report.checks.push({ name, passed: Boolean(passed) }); console.log(`${passed ? 'PASS' : 'FAIL'} C3 ${name}`); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const businessCounts = async () => (await db.query(`SELECT
 (SELECT count(*)::int FROM public.central_needs_need_lines) needs,
 (SELECT count(*)::int FROM public.warehouse_stock_movements) stock_movements,
 (SELECT count(*)::int FROM public.central_needs_annual_items) annual_items,
 (SELECT count(*)::int FROM public.central_needs_annual_versions) annual_versions,
 (SELECT count(*)::int FROM public.audit_logs) audit_events`)).rows[0];
try {
  await db.connect();
  const { rows } = await db.query(`SELECT p.id FROM public.profiles p JOIN auth.users u ON u.id=p.id
    WHERE p.id=$1 AND p.organization_id=$2 AND p.status='active' AND u.email=$3`,
  [seed.centralNeeds.editor.id, seed.centralNeeds.owningOrganization, seed.centralNeeds.editor.email]);
  assert.equal(rows.length, 1); check('synthetic loopback target and accepted prerequisite verified', true);
  stage = 'build_actual_modules';
  const bridge = join(scratch, 'bridge.mjs'), worker = join(scratch, 'worker.mjs');
  const shared = { bundle: true, platform: 'node', target: 'node22', format: 'esm', logLevel: 'silent',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } };
  await build({ ...shared, stdin: { contents: `export {authenticate} from './api/_lib/supabase.ts';
    export {readAuthorizedAnnualC3Original} from './api/_cn2b-core/annual-c3-authorized-source.ts';
    export {runC3IsolatedWorker} from './api/_cn2b-core/annual-c3-worker-boundary.ts';`, resolveDir: process.cwd() }, outfile: bridge });
  await build({ ...shared, entryPoints: ['api/_c3-core/worker-entry.ts'], outfile: worker });
  const { authenticate, readAuthorizedAnnualC3Original, runC3IsolatedWorker } = await import(pathToFileURL(bridge).href);
  stage = 'authenticate_editor';
  const signed = await editor.auth.signInWithPassword({ email: seed.centralNeeds.editor.email, password: seed.password });
  assert(!signed.error && signed.data.user?.id === seed.centralNeeds.editor.id && signed.data.session);
  const caller = await authenticate(new Request('http://127.0.0.1/c3-test', {
    headers: { authorization: `Bearer ${signed.data.session.access_token}` },
  }));
  assert.equal(caller?.userId, seed.centralNeeds.editor.id); check('real server authenticate verifies the employee JWT', true);
  const scope = { ownerOrgId: seed.centralNeeds.owningOrganization, planningYear: 2099 };
  stage = 'open_synthetic_year';
  const opened = await caller.client.rpc('phoenix_central_needs_open_catalog_year', {
    p_organization_id: scope.ownerOrgId, p_planning_year: scope.planningYear, p_idempotency_key: 'c3-synthetic-open-year',
  }); assert(!opened.error);
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Name', 'Code', 'Unit', 'Quantity'], ['Synthetic Alpha', '0007', 'Box', 987654], ['Synthetic Beta', '0008', 'Box', 987654],
  ]), 'Identity');
  const bytes = Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  stage = 'store_synthetic_source';
  const stored = await caller.client.rpc('phoenix_central_needs_store_annual_original', {
    p_organization_id: scope.ownerOrgId, p_planning_year: scope.planningYear, p_filename: 'synthetic-c3-source.xlsx',
    p_sha256: sha(bytes), p_byte_size: bytes.length, p_base64: bytes.toString('base64'),
    p_idempotency_key: 'c3-synthetic-source-capture', p_expected_actor_id: caller.userId,
  }); assert(!stored.error && stored.data?.original?.originalId);
  check('synthetic bytes are retained by the actual caller-scoped C2 RPC', true);
  const baseline = await businessCounts();
  const originalId = stored.data.original.originalId;
  stage = 'read_retained_source';
  const source = await readAuthorizedAnnualC3Original(caller, scope, originalId);
  assert.equal(sha(source.bytes), sha(bytes));
  const manifest = { workbookSheets: [{ index: 0, name: 'Identity' }], template: { id: 'synthetic-ci-only', version: 1,
    reviewReference: 'synthetic-integration-review', parserContractVersion: '1.2.0', classificationCells: [],
    blocks: [{ blockId: 'identity', sheetIndex: 0, headerRow: 0, firstRow: 1, lastRow: 9999, classification: null,
      mappingReference: 'synthetic-only', columns: { scientificName: { column: 0, expectedHeaderText: 'Name' },
        nationalCode: { column: 1, expectedHeaderText: 'Code' }, unit: { column: 2, expectedHeaderText: 'Unit' } } }] } };
  const input = { source, template: { manifest, expectedSha256: sha(JSON.stringify(manifest)) }, pageSize: 1, cursor: null };
  stage = 'run_actual_worker';
  const page = await runC3IsolatedWorker(pathToFileURL(worker), input);
  const second = await runC3IsolatedWorker(pathToFileURL(worker), { ...input, cursor: page.nextCursor });
  check('actual compiled worker preserves zero-prefixed code and bounded distinct pages', page.rows[0].fields.nationalCode.text === '0007'
    && second.rows[0].fields.nationalCode.text === '0008' && page.rows.length === 1 && second.rows.length === 1
    && page.totalRows === 2 && second.nextCursor === null && !JSON.stringify([page, second]).includes('987654'));
  check('anonymous requests cannot create an authenticated caller', await authenticate(new Request('http://127.0.0.1/c3-test')) === null);
  stage = 'verify_foreign_actor';
  const other = await outsider.auth.signInWithPassword({ email: seed.users.institutionAdminA.email, password: seed.password });
  assert(!other.error && other.data.session);
  const foreign = await authenticate(new Request('http://127.0.0.1/c3-test', { headers: { authorization: `Bearer ${other.data.session.access_token}` } }));
  assert.equal(foreign?.userId, seed.users.institutionAdminA.id);
  let denied = false; try { await readAuthorizedAnnualC3Original(foreign, scope, originalId); } catch { denied = true; }
  check('another institution JWT cannot read the retained original', denied);
  stage = 'verify_read_only_effects';
  check('reading and parsing leave catalog membership, quantities, stock and audit unchanged',
    JSON.stringify(await businessCounts()) === JSON.stringify(baseline));
  stage = 'verify_current_revocation';
  await db.query(`INSERT INTO public.profile_permission_overrides(profile_id,permission_key,allowed)
    VALUES($1,'central_needs.view',false) ON CONFLICT(profile_id,permission_key) DO UPDATE SET allowed=false`, [caller.userId]);
  denied = false; try { await readAuthorizedAnnualC3Original(caller, scope, originalId); } catch { denied = true; }
  check('the same JWT observes current annual-view revocation', denied);
} catch {
  report.errors.push(`c3_disposable_integration_failed_at_${stage}`); check('integration completed', false);
} finally {
  await editor.auth.signOut(); await outsider.auth.signOut(); await db.end();
  report.passed = report.checks.length === 8 && report.checks.every(c => c.passed) && report.errors.length === 0;
  mkdirSync(output, { recursive: true }); writeFileSync(join(output, 'c3-read-worker.json'), JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
