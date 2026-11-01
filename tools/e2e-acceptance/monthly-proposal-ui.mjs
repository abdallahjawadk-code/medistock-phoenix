/** Actual Screen-3 manual annual entry, synthetic policies only. Never hosted. */
import assert from 'node:assert/strict';
import { verifyNativeHorizontalScroll } from './native-horizontal-scroll.mjs';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright-core';
import pg from 'pg';

const base = new URL(process.argv[2]), seed = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const api = new URL(seed.supabaseUrl), database = new URL(seed.databaseUrl);
assert(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
for (const [url, port] of [[base, '4173'], [api, '54321']]) {
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, port);
  assert.equal(url.pathname, '/'); assert.equal(url.search, ''); assert.equal(url.hash, ''); assert.equal(url.username, ''); assert.equal(url.password, '');
}
assert(['postgres:', 'postgresql:'].includes(database.protocol)); assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '54322'); assert.equal(database.pathname, '/postgres'); assert.equal(database.username, 'postgres');
assert.equal(database.search, ''); assert.equal(database.hash, '');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const prerequisite = JSON.parse(readFileSync('docs/phoenix/e2e-acceptance/monthly-policy-reference.json', 'utf8'));
assert.equal(prerequisite.passed, true); assert.equal(prerequisite.commit, head);
const beneficiaryProof = JSON.parse(readFileSync('docs/phoenix/e2e-acceptance/annual-beneficiaries.json', 'utf8'));
assert(beneficiaryProof.passed && beneficiaryProof.commit === head);
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const admin = createClient(api.href, readFileSync('/tmp/sb-service-role-key.txt', 'utf8').trim(), options);
assert(process.env.SUPABASE_ANON_KEY);
const employee = createClient(api.href, process.env.SUPABASE_ANON_KEY, options);
const db = new pg.Client({ connectionString: database.href, connectionTimeoutMillis: 5000 });
const output = resolve('docs/phoenix/e2e-acceptance/monthly-ui'); mkdirSync(output, { recursive: true });
const report = { commit: head, sourceHead: prerequisite.sourceHead, environment: 'disposable loopback Supabase; synthetic fresh PDA and real maker/checker Auth',
  hostedCompatibility: prerequisite.hostedCompatibility, productionSqlApplied: false, effectiveAllocationsCreated: false,
  matrixCaptureMode: 'two actual viewport positions per combination; no element stitching',
  employeeMonthlyJournalImplemented: false, setupReads: [], rpcFailures: [], checks: [], errors: [] };
const check = (name, passed) => { report.checks.push({ name, passed: Boolean(passed) }); console.log(`${passed ? 'PASS' : 'FAIL'} Monthly UI ${name}`); assert(passed, name); };
const owner = randomUUID(), maker = { id: randomUUID(), email: `monthly-ui-maker-${randomUUID()}@phoenix.local` }, checker = { id: randomUUID(), email: `monthly-ui-checker-${randomUUID()}@phoenix.local` };
const beneficiary = seed.centralNeeds.beneficiaryOrganization, year = 2026;
const rpc = async (name, args) => { const r = await employee.rpc(name, args); assert(!r.error, `Employee RPC refused: ${name}`); return r.data; };
const stock = async () => (await db.query(`SELECT (SELECT count(*) FROM public.warehouse_stock_movements)::int warehouse,
  (SELECT count(*) FROM public.outlet_stock_movements)::int outlet`)).rows[0];
let browser, page, stage = 'target_proof';
try {
  await db.connect();
  const identity = (await db.query('SELECT current_database() db,current_user actor,inet_server_port() port')).rows[0];
  assert.equal(identity.db, 'postgres'); assert.equal(identity.actor, 'postgres'); assert.equal(identity.port, 5432);
  stage = 'new_manual_fixture';
  await db.query(`INSERT INTO public.organizations(id,name,name_ar,code,organization_kind,status)
    VALUES($1,'Synthetic monthly UI PDA','جهة تجربة الاقتراح الشهري',$2,'pharmacy_department_authority','active')`, [owner, `monthly-ui-${owner}`]);
  for (const [user, keys] of [[maker, ['view', 'edit', 'manual_need.set', 'allocation.view']], [checker, ['view', 'approve']]]) {
    const result = await admin.auth.admin.createUser({ email: user.email, password: seed.password, email_confirm: true });
    assert(!result.error && result.data.user?.id); user.id = result.data.user.id;
    await db.query("UPDATE public.profiles SET organization_id=$2,role='central_warehouse_manager',status='active',full_name=$3 WHERE id=$1",
      [user.id, owner, user === maker ? 'Synthetic monthly maker' : 'Synthetic independent checker']);
    for (const key of keys) await db.query('INSERT INTO public.profile_permission_overrides(profile_id,permission_key,allowed) VALUES($1,$2,true)', [user.id, `central_needs.${key}`]);
  }
  const cutover = (await db.query('SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1) r', [owner])).rows[0].r;
  check('fresh owner cutover has separate maker/checker and no historical Excel draft', cutover.ok === true && maker.id !== checker.id);
  assert(!(await employee.auth.signInWithPassword({ email: maker.email, password: seed.password })).error);
  const scope = { p_organization_id: owner, p_planning_year: year };
  await rpc('phoenix_central_needs_open_catalog_year', { ...scope, p_idempotency_key: `ui-year-${randomUUID()}` });
  const members = [];
  for (const n of [1, 2]) {
    const name = `Synthetic UI material ${n}`;
    const canonical = (await db.query("INSERT INTO public.central_items(name,name_ar,unit,national_code,status) VALUES($1,$2,'box',$3,'active') RETURNING id",
      [name, `مادة التجربة ${n}`, `UI-MONTHLY-${randomUUID()}`])).rows[0].id;
    const preview = await rpc('phoenix_central_needs_preview_annual_canonical', { ...scope, p_central_item_id: canonical });
    const member = await rpc('phoenix_central_needs_add_annual_catalog_item', { ...scope, p_central_item_id: canonical,
      p_expected_canonical_fingerprint: preview.canonicalFingerprint, p_occurrences: [], p_reason: 'Explicit synthetic UI identity', p_idempotency_key: `ui-member-${randomUUID()}` });
    members.push({ canonical, name, nationalCode: preview.canonicalSnapshot.nationalCode, ...member });
  }
  const first = members[0];
  const context = { ownerOrgId: owner, planningYear: year, annualItemId: first.membership.annualItemId,
    fieldVersionId: first.fieldVersion.fieldVersionId, canonicalItemId: first.canonical, unit: 'box', beneficiaryOrganizationId: beneficiary };
  await db.query('SELECT phoenix_monthly.publish_reference_v1($1::jsonb,NULL,true)', [JSON.stringify({
    policyId: randomUUID(), version: 1, fingerprint: 'a'.repeat(64), status: 'approved', context,
    unitStep: '0.25', eligibleMonths: [2, 4, 6], fixedMonths: [{ month: 1, quantity: '2.5', status: 'approved', ledgerReference: 'Synthetic fixed allocation' }],
    basis: { beneficiaryOrganizationId: beneficiary, documentReference: 'Synthetic reviewed distribution decision', documentSha256: 'b'.repeat(64),
      periodReference: 'Synthetic periods only', priorAllocationStatus: 'snapshot_verified', ledgerSnapshotSha256: 'c'.repeat(64),
      approvedById: maker.id, approvedByName: 'FORGED NAME', approvedAt: '2026-01-01T10:00:00.000Z' },
  })]);
  const initialStock = await stock();
  check('setup has no annual quantities or effective R2 writer', (await db.query('SELECT count(*)::int n FROM public.central_needs_manual_need_events WHERE organization_id=$1', [owner])).rows[0].n === 0
    && (await rpc('phoenix_r2_capabilities', { p_organization_id: owner })).operationalWritesImplemented === false);
  stage = 'real_employee_journey_prerequisites';
  for (const [name, args] of [['annual_needs_contract', {}], ['feature_contract', {}],
    ['phoenix_manual_read_dossiers_v1', { p_organization_id: owner, p_plan_year: year }], ['phoenix_manual_read_annual_summary_v1', { p_organization_id: owner, p_plan_year: year }],
    ['my_capabilities', { p_organization_id: owner, p_plan_revision_id: null }],
    ['phoenix_manual_beneficiaries_v1', { p_organization_id: owner, p_after_id: null, p_limit: 50 }]]) {
    const result = await employee.rpc(name.startsWith('phoenix_') ? name : `phoenix_central_needs_${name}`, args);
    report.setupReads.push({ name, passed: !result.error, code: result.error?.code ?? null, message: result.error?.message?.slice(0, 160) ?? null });
  }
  check('same employee real Auth can read every actual journey prerequisite', report.setupReads.every(row => row.passed));
  stage = 'browser_launch';
  try { browser = await chromium.launch({ headless: true, channel: 'chrome' }); } catch { browser = await chromium.launch({ headless: true }); }
  const session = await browser.newContext({ viewport: { width: 1366, height: 900 } }); page = await session.newPage();
  stage = 'browser_manual_entry';
  page.on('pageerror', () => report.errors.push('browser_page_error'));
  page.on('response', async response => {
    const url = new URL(response.url());
    if (url.origin === api.origin && url.pathname.startsWith('/rest/v1/rpc/') && response.status() >= 400) {
      const failure = await response.json().catch(() => ({}));
      report.rpcFailures.push({ function: url.pathname.split('/').at(-1), status: response.status(),
        code: typeof failure.code === 'string' ? failure.code.slice(0, 40) : null,
        message: typeof failure.message === 'string' ? failure.message.slice(0, 160) : null });
    }
  });
  await page.goto(base.href); await page.locator('#login-email').fill(maker.email); await page.locator('#login-password').fill(seed.password);
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
  await page.getByRole('button', { name: 'Start a new plan', exact: true }).click();
  await page.getByLabel('Annual quantity', { exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Beneficiary institution', exact: true }).selectOption(beneficiary);
  const search = page.getByRole('searchbox', { name: 'Search by material name or national code', exact: true });
  await search.fill(first.nationalCode); await page.getByRole('button', { name: 'Search this year', exact: true }).click();
  const firstResult = page.locator('.prism-annual-result').filter({ hasText: first.name }); await firstResult.waitFor();
  check('national-code search returns the exact annual material identity', await page.locator('.prism-annual-result').count() === 1
    && (await firstResult.innerText()).includes(first.nationalCode));
  await firstResult.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.screenshot({ path: resolve(output, 'national-code-search-en-light.png') });
  await firstResult.getByRole('button', { name: 'Select material', exact: true }).click();
  await search.fill(''); await page.getByRole('button', { name: 'Search this year', exact: true }).click();
  await page.locator('.prism-annual-result').filter({ hasText: members[1].name }).getByRole('button', { name: 'Select material', exact: true }).click();
  await page.getByRole('combobox', { name: 'Item', exact: true }).selectOption(first.canonical);
  const quantity = () => page.getByLabel(/^(Annual quantity|الكمية السنوية)$/);
  const filledIdentity = page.locator('.prism-line-form__identity'); await filledIdentity.getByText(first.nationalCode, { exact: true }).waitFor();
  check('selected annual identity fills name national code and unit without copying a quantity', (await filledIdentity.innerText()).includes(first.name)
    && (await filledIdentity.innerText()).includes('box') && await quantity().inputValue() === '');
  await filledIdentity.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.screenshot({ path: resolve(output, 'autofilled-identity-before-quantity-en-light.png') });
  check('actual quantity field starts blank after beneficiary and multiple material choices', await quantity().inputValue() === '');
  await quantity().fill('10.25');
  const panel = page.getByTestId('monthly-proposal'); await panel.getByRole('table').waitFor();
  check('automatic proposal preserves fixed January and exact annual sum before any annual save',
    await panel.locator('tr[data-month="1"] td').first().textContent() === '2.5'
    && await panel.locator('tr[data-month="2"] td').first().textContent() === '2.75'
    && await panel.locator('tfoot td').first().textContent() === '10.25');
  const center = target => target.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
  const inViewport = target => target.evaluate(el => {
    const box = el.getBoundingClientRect(), header = document.querySelector('.premium-topbar')?.getBoundingClientRect();
    return box.left >= -1 && box.right <= innerWidth + 1 && box.top >= (header?.bottom ?? 0) - 1 && box.bottom <= innerHeight + 1;
  });
  stage = 'real_ui_matrix';
  for (const width of [1366, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const lang of ['ar', 'en']) for (const theme of ['light', 'dark']) {
      await appearance(lang, theme); await page.evaluate(() => document.fonts.ready);
      const name = `${width}-${lang}-${theme}`;
      check(`${name} actual bound proposal and fixed allocation`, await panel.locator('tr[data-month="1"] td').first().textContent() === '2.5'
        && await panel.locator('tr[data-month="2"] td').first().textContent() === '2.75' && await panel.locator('tfoot td').first().textContent() === '10.25');
      check(`${name} no document overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const names = await page.locator('.prism-annual-picker .prism-annual-result .prism-material-identity__name').evaluateAll(elements => elements.map(el => {
        const box = el.getBoundingClientRect(), line = Number.parseFloat(getComputedStyle(el).lineHeight);
        const actions = el.closest('.prism-annual-result').querySelector('.prism-annual-result__actions').getBoundingClientRect();
        return box.width >= 80 && box.height <= line * 3 + 1 && actions.height <= 120;
      }));
      check(`${name} short material names remain readable beside their actions`, names.length === 2 && names.every(Boolean));
      check(`${name} labelled table and keyboard scroll region`, await panel.getByRole('table', { name: lang === 'ar' ? 'اقتراح التحصيص الشهري' : 'Monthly distribution proposal' }).count() === 1
        && await panel.getByRole('region').getAttribute('tabindex') === '0');
      check(`${name} no effective approval control`, await panel.getByRole('button', { name: /اعتماد|Approve/ }).count() === 0);
      const heading = panel.getByRole('heading', { level: 4 }); await center(heading);
      check(`${name} policy heading is visible below the fixed header`, await inViewport(heading));
      await page.screenshot({ path: resolve(output, `${name}-policy.png`) });
      const region = panel.getByRole('region'); await verifyNativeHorizontalScroll(region);
      const total = panel.locator('tfoot td').first(); await center(total);
      check(`${name} exact total is visible and the table region keeps keyboard focus`, await inViewport(total) && await region.evaluate(el => el === document.activeElement));
      await page.screenshot({ path: resolve(output, `${name}-monthly-total.png`) });
    }
  }
  stage = 'missing_policy_and_save'; await appearance('ar', 'light');
  await page.getByRole('combobox', { name: 'المادة', exact: true }).selectOption(members[1].canonical); assert.equal(await quantity().inputValue(), '');
  await quantity().fill('10.25'); await panel.getByText('بانتظار تحديد سياسة التوزيع', { exact: true }).waitFor();
  check('second material without a policy stays waiting without fabricated month rows', await panel.getByRole('table').count() === 0);
  await center(panel.getByRole('heading', { level: 4 })); await page.screenshot({ path: resolve(output, 'missing-policy-ar-light.png') });
  await appearance('en', 'light'); await page.getByRole('combobox', { name: 'Item', exact: true }).selectOption(first.canonical);
  assert.equal(await quantity().inputValue(), ''); await quantity().fill('10.25');
  await page.getByLabel('Reason', { exact: true }).fill('Manual annual quantity entered by employee, proposal is nonbinding');
  await page.getByRole('button', { name: 'Add line', exact: true }).click();
  stage = 'annual_save_readback';
  await page.getByRole('table', { name: 'Recorded need lines', exact: true }).getByRole('cell', { name: '10.25', exact: true }).waitFor();
  const stored = (await db.query(`SELECT e.quantity_text,e.beneficiary_organization_id,e.actor_id,b.annual_item_id,b.field_version_id,b.actor_name
    FROM public.central_needs_manual_need_events e JOIN public.central_needs_annual_need_bindings b ON b.event_id=e.id WHERE e.organization_id=$1`, [owner])).rows;
  check('annual save creates exactly one event and immutable annual identity binding with trusted employee snapshot', stored.length === 1
    && stored[0].quantity_text === '10.25' && stored[0].beneficiary_organization_id === beneficiary && stored[0].actor_id === maker.id
    && stored[0].annual_item_id === first.membership.annualItemId && stored[0].field_version_id === first.fieldVersion.fieldVersionId && stored[0].actor_name === 'Synthetic monthly maker');
  stage = 'annual_reload'; await page.reload(); await page.locator('#phoenix-main').waitFor();
  // Navigation state may reset; explicitly return to the same manual year.
  await appearance('en', 'light');
  if (await page.locator('#inventory-tab-needs').count() === 0) {
    await page.locator('.premium-drawer-trigger').click();
    await page.locator('#phoenix-mobile-drawer nav').getByRole('button', { name: 'Inventory Center', exact: true }).click();
  }
  await page.locator('#inventory-tab-needs').click();
  await page.getByLabel('Plan year', { exact: true }).fill(String(year)); await page.getByRole('button', { name: 'Open year', exact: true }).click();
  await page.getByRole('combobox', { name: 'Beneficiary institution', exact: true }).selectOption(beneficiary);
  await page.getByRole('table', { name: 'Recorded need lines', exact: true }).getByRole('cell', { name: '10.25', exact: true }).waitFor();
  check('reload preserves saved annual quantity without stock changes or effective activation', JSON.stringify(await stock()) === JSON.stringify(initialStock)
    && (await rpc('phoenix_r2_capabilities', { p_organization_id: owner })).operationalWritesImplemented === false);
  check('all prior authority seals remain intact', (await db.query('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()')).rowCount === 0
    && (await db.query('SELECT * FROM phoenix_r2.capability_breaches()')).rowCount === 0 && (await db.query('SELECT * FROM phoenix_monthly.capability_breaches_v1()')).rowCount === 0);
} catch {
  report.errors.push(`monthly_ui_failed_at_${stage}`);
  if (page) { await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => undefined);
    writeFileSync(resolve(output, 'failure-visible-text.txt'), await page.locator('body').innerText().catch(() => 'Unavailable')); }
} finally {
  if (browser) await browser.close(); await employee.auth.signOut(); await db.end();
  report.passed = report.checks.length === 123 && report.checks.every(row => row.passed) && report.errors.length === 0;
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ phase: 'monthly_ui', passed: report.passed, checks: report.checks.length, errors: report.errors }));
  if (!report.passed) process.exitCode = 1;
}
