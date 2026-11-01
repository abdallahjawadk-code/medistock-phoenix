/** Actual annual workspace source review, synthetic fresh owner; never hosted. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright-core';
import pg from 'pg';
import * as XLSX from 'xlsx';
import { createSourceUiProxy } from './c4-source-ui-proxy.mjs';

const upstream = new URL(process.argv[2]), seed = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const api = new URL(seed.supabaseUrl), database = new URL(seed.databaseUrl);
assert(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
assert.equal(upstream.href, 'http://127.0.0.1:4173/'); assert.equal(api.href, 'http://127.0.0.1:54321/');
assert(['postgres:', 'postgresql:'].includes(database.protocol)); assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '54322'); assert.equal(database.username, 'postgres'); assert.equal(database.pathname, '/postgres');
assert.equal(database.search, ''); assert.equal(database.hash, '');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const prerequisite = JSON.parse(readFileSync('docs/phoenix/e2e-acceptance/manual-read-adapters.json', 'utf8'));
assert(prerequisite.passed && prerequisite.commit === head);
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
assert(process.env.SUPABASE_ANON_KEY);
process.env.PHOENIX_SUPABASE_URL = api.href; process.env.PHOENIX_SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const service = createClient(api.href, readFileSync('/tmp/sb-service-role-key.txt', 'utf8').trim(), options);
const employee = createClient(api.href, process.env.SUPABASE_ANON_KEY, options);
const db = new pg.Client({ connectionString: database.href, connectionTimeoutMillis: 5000 });
const output = resolve('docs/phoenix/e2e-acceptance/c4-source-ui'); mkdirSync(output, { recursive: true });
const report = { commit: head, sourceHead: prerequisite.sourceHead, environment: 'fresh synthetic PDA; actual Auth/C2/Node C3/C4 handlers and browser UI',
  productionSqlApplied: false, hostedCompatibility: prerequisite.hostedCompatibility, realWorkbookUsed: false,
  completed: false, checks: [], errors: [], counters: null };
const check = (name, passed) => { report.checks.push({ name, passed: Boolean(passed) }); console.log(`${passed ? 'PASS' : 'FAIL'} C4 UI ${name}`); assert(passed, name); };
const sha = value => createHash('sha256').update(value).digest('hex');
const owner = randomUUID(), year = 2026, maker = { email: `c4-ui-maker-${randomUUID()}@phoenix.local` };
const scope = { p_organization_id: owner, p_planning_year: year };
const rpc = async (name, args) => { const result = await employee.rpc(name, args); assert(!result.error, `Employee RPC refused: ${name}`); return result.data; };
const counts = async () => (await db.query(`SELECT
  (SELECT count(*) FROM public.central_items)::int canonical,
  (SELECT count(*) FROM public.central_needs_annual_items WHERE organization_id=$1)::int memberships,
  (SELECT count(*) FROM public.central_needs_annual_versions WHERE organization_id=$1)::int versions,
  (SELECT count(*) FROM public.central_needs_manual_need_events WHERE organization_id=$1)::int quantities,
  (SELECT count(*) FROM phoenix_c4.commits)::int commits,
  (SELECT count(*) FROM public.warehouse_stock_movements)::int warehouse,
  (SELECT count(*) FROM public.outlet_stock_movements)::int outlet`, [owner])).rows[0];
let browser, page, proxy, stage = 'target';
try {
  await db.connect();
  const target = (await db.query('SELECT current_database() db,current_user actor,inet_server_port() port')).rows[0];
  assert.equal(target.db, 'postgres'); assert.equal(target.actor, 'postgres'); assert.equal(target.port, 5432);
  stage = 'fresh_fixture';
  await db.query(`INSERT INTO public.organizations(id,name,name_ar,code,organization_kind,status)
    VALUES($1,'Synthetic source review PDA','جهة تجربة مراجعة المصدر',$2,'pharmacy_department_authority','active')`, [owner, `c4-ui-${owner}`]);
  for (const [user, keys] of [[maker, ['view', 'edit', 'manual_need.set']], [{ email: `c4-ui-checker-${randomUUID()}@phoenix.local` }, ['view', 'approve']]]) {
    const result = await service.auth.admin.createUser({ email: user.email, password: seed.password, email_confirm: true });
    assert(!result.error && result.data.user?.id); user.id = result.data.user.id;
    await db.query("UPDATE public.profiles SET organization_id=$2,role='central_warehouse_manager',status='active',full_name='Synthetic source reviewer' WHERE id=$1", [user.id, owner]);
    for (const key of keys) await db.query('INSERT INTO public.profile_permission_overrides(profile_id,permission_key,allowed) VALUES($1,$2,true)', [user.id, `central_needs.${key}`]);
  }
  const cutover = (await db.query('SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1) r', [owner])).rows[0].r;
  check('fresh manual owner has an independent checker without touching historical Excel ownership', cutover.ok === true);
  assert(!(await employee.auth.signInWithPassword({ email: maker.email, password: seed.password })).error);
  await rpc('phoenix_central_needs_open_catalog_year', { ...scope, p_idempotency_key: `c4-ui-year-${randomUUID()}` });
  const name = 'Synthetic source UI material', code = `00-C4-${randomUUID()}`;
  const canonical = (await db.query("INSERT INTO public.central_items(name,name_ar,unit,national_code,status) VALUES($1,'هوية مادة التجربة','box',$2,'active') RETURNING id", [name, code])).rows[0].id;
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Name', 'Code', 'Unit', 'Quantity'], [name, code, 'box', 987654],
  ]), 'Identity');
  const bytes = Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  const filename = 'synthetic-c4-ui.xlsx';
  const stored = await rpc('phoenix_central_needs_store_annual_original', { ...scope, p_filename: filename, p_sha256: sha(bytes), p_byte_size: bytes.length,
    p_base64: bytes.toString('base64'), p_idempotency_key: `c4-ui-source-${randomUUID()}`, p_expected_actor_id: maker.id });
  assert(stored.original.originalId);
  const manifest = { workbookSheets: [{ index: 0, name: 'Identity' }], template: { id: 'synthetic-c4-ui', version: 1,
    reviewReference: 'Synthetic browser review only', parserContractVersion: '1.2.0', classificationCells: [],
    blocks: [{ blockId: 'identity', sheetIndex: 0, headerRow: 0, firstRow: 1, lastRow: 9999, classification: null,
      mappingReference: 'synthetic-only', columns: { scientificName: { column: 0, expectedHeaderText: 'Name' },
        nationalCode: { column: 1, expectedHeaderText: 'Code' }, unit: { column: 2, expectedHeaderText: 'Unit' } } }] } };
  const before = await counts(); check('setup has one original and no annual membership or quantity', before.memberships === 0 && before.quantities === 0);
  proxy = await createSourceUiProxy(upstream, [manifest], service);
  stage = 'browser';
  try { browser = await chromium.launch({ headless: true, channel: 'chrome' }); } catch { browser = await chromium.launch({ headless: true }); }
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } }); page = await context.newPage();
  page.on('pageerror', () => report.errors.push('browser_page_error'));
  await page.goto(proxy.base.href); await page.locator('#login-email').fill(maker.email); await page.locator('#login-password').fill(seed.password);
  await page.locator('button[type=submit]').click(); await page.locator('#phoenix-main').waitFor({ timeout: 30000 });
  const appearance = async (lang, theme) => {
    if (await page.locator('html').getAttribute('lang') !== lang) await page.locator('.premium-topbar .nexus-control--language').click();
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: theme === 'dark' ? /^(Activate dark theme|تفعيل المظهر الداكن)$/ : /^(Activate light theme|تفعيل المظهر الفاتح)$/ }).click();
    await page.waitForFunction(({ lang, theme }) => document.documentElement.lang === lang && document.documentElement.dataset.theme === theme, { lang, theme });
  };
  await appearance('en', 'light');
  await page.locator('.premium-sidebar nav').getByRole('button', { name: 'Inventory Center', exact: true }).click();
  await page.locator('#inventory-tab-needs').waitFor({ timeout: 20000 }); await page.locator('#inventory-tab-needs').click();
  await page.getByLabel('Plan year', { exact: true }).fill(String(year)); await page.getByRole('button', { name: 'Open year', exact: true }).click();
  await page.getByRole('button', { name: 'Year files', exact: true }).click();
  const trigger = page.getByRole('button', { name: `Review material identity: ${filename}`, exact: true });
  await trigger.focus(); await page.keyboard.press('Enter');
  const panel = page.getByTestId('verified-source-review');
  await panel.getByLabel('Reviewed profile', { exact: true }).waitFor();
  check('keyboard opens review with heading focus and explicit empty profile selection', await panel.getByRole('heading').evaluate(el => el === document.activeElement)
    && await panel.getByLabel('Reviewed profile', { exact: true }).inputValue() === '' && proxy.counters.sourceReads === 0);
  await panel.getByLabel('Reviewed profile', { exact: true }).selectOption('0');
  await panel.getByRole('button', { name: 'Read source witnesses', exact: true }).click();
  await panel.getByLabel('Select source row 2', { exact: true }).check();
  check('actual C2 and worker witnesses exclude historical quantity', (await panel.textContent()).includes(code)
    && !(await panel.textContent()).includes('987654') && proxy.counters.workers === 1);
  await panel.getByLabel('Search a registered material', { exact: true }).fill(name);
  await panel.getByRole('button', { name: 'Search', exact: true }).click(); await panel.getByRole('button', { name: 'Use', exact: true }).click();
  const confirm = () => panel.getByRole('button', { name: /^(Confirm annual membership|تأكيد عضوية المادة في فهرس السنة)$/ });
  await panel.getByLabel('Membership review reason', { exact: true }).waitFor();
  check('registered canonical preview still requires a reason', await confirm().isDisabled());
  await panel.getByLabel('Membership review reason', { exact: true }).fill('Reviewed the exact synthetic source identity');
  stage = 'matrix';
  for (const width of [1366, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const lang of ['ar', 'en']) for (const theme of ['light', 'dark']) {
      await appearance(lang, theme); await page.evaluate(() => document.fonts.ready); const label = `${width}-${lang}-${theme}`;
      check(`${label} source witnesses and explicit reviewed canonical`, (await panel.textContent()).includes(code) && await confirm().isEnabled());
      check(`${label} no document overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      check(`${label} review direction and accessible heading`, await panel.getAttribute('dir') === (lang === 'ar' ? 'rtl' : 'ltr') && await panel.getByRole('heading').count() === 1);
      check(`${label} no quantity or approval editor in identity review`, await panel.getByLabel(/^(Annual quantity|الكمية السنوية)$/).count() === 0);
      await panel.screenshot({ path: resolve(output, `${label}.png`) });
    }
  }
  stage = 'lost_acknowledgement';
  await page.setViewportSize({ width: 1366, height: 900 }); await appearance('en', 'light'); await confirm().focus(); await page.keyboard.press('Space');
  const receipt = panel.getByRole('button', { name: 'Check operation receipt', exact: true }); await receipt.waitFor();
  check('unknown successful acknowledgement keeps scope locked with exactly one POST', proxy.counters.commits === 1 && proxy.counters.lostAcknowledgements === 1
    && await panel.getByRole('button', { name: 'Close source review', exact: true }).isDisabled()
    && await page.getByLabel('Plan year', { exact: true }).isDisabled());
  await receipt.focus(); await page.keyboard.press('Enter');
  await panel.getByRole('button', { name: 'Close source review', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[data-testid="verified-source-review"] header button')?.disabled);
  check('committed receipt requires fresh current read and sends no second write', proxy.counters.commits === 1 && proxy.counters.workers === 2
    && await panel.getByRole('button', { name: 'Check operation receipt', exact: true }).count() === 0
    && (await panel.textContent()).includes('Synthetic source reviewer'));
  check('completed review clears stale confirmation', await confirm().count() === 0 && !await panel.getByLabel('Select source row 2', { exact: true }).isChecked());
  await panel.screenshot({ path: resolve(output, 'receipt-recovered-en-light.png') });
  await panel.getByRole('button', { name: 'Close source review', exact: true }).focus(); await page.keyboard.press('Enter');
  check('keyboard close restores the original history trigger focus', await trigger.evaluate(el => el === document.activeElement));
  const after = await counts();
  const employeeSnapshot = (await db.query(`SELECT v.created_by actor_id,c.result#>>'{c4Verification,reviewedByName}' actor_name
    FROM public.central_needs_annual_versions v JOIN phoenix_c4.commits c ON c.field_version_id=v.id
    WHERE v.organization_id=$1`, [owner])).rows;
  check('one trusted identity version with no new canonical annual quantity or stock movement', after.memberships === 1 && after.versions === 1
    && after.commits === before.commits + 1 && after.canonical === before.canonical && after.quantities === 0 && after.warehouse === before.warehouse
    && after.outlet === before.outlet && employeeSnapshot.length === 1 && employeeSnapshot[0].actor_id === maker.id && employeeSnapshot[0].actor_name === 'Synthetic source reviewer');
  check('all accepted capability seals remain closed', (await db.query(`SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()
    UNION ALL SELECT * FROM phoenix_c4.capability_breaches_v1() UNION ALL SELECT * FROM phoenix_r2.capability_breaches()
    UNION ALL SELECT * FROM phoenix_monthly.capability_breaches_v1()`)).rowCount === 0);
  report.completed = true;
} catch {
  report.errors.push(`c4_source_ui_failed_at_${stage}`);
  if (page) { await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
    writeFileSync(resolve(output, 'failure-visible-text.txt'), await page.locator('body').innerText().catch(() => 'unavailable')); }
} finally {
  report.counters = proxy?.counters ?? null;
  if (browser) await browser.close(); if (proxy) await proxy.close(); await employee.auth.signOut(); await db.end();
  report.passed = report.completed && report.checks.every(row => row.passed) && report.errors.length === 0;
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); if (!report.passed) process.exitCode = 1;
}
