/**
 * R1 acceptance - REAL Chrome, REAL application code, REAL SQL (disposable rig).
 *
 * Browser: system Chrome through playwright-core (nothing installed). Application: the real manual-needs journey, its real service modules and
 * real Supabase client, served by Vite. Backend: the disposable PostgreSQL 18.4 rig with candidates R1a_01..06 + R1b_01/02 applied and the
 * organization activated, reached through a local PostgREST-style shim (tests/browser/pg-rest-shim.ts) that runs every call as the real
 * `authenticated` role with the test account's identity. Accounts are the rig's synthetic users only.
 *
 * NOT exercised here (stated, not simulated): the full application shell/authentication (no local Supabase Auth), Storage, the shared PRE3-A
 * resolver (its PostgREST filter syntax is not reproduced; three catalog reads are plain SQL on the same rig), PostgreSQL 17.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import * as XLSX from 'xlsx';
import { rigAvailable } from '../tools/pg-rig/rig.mjs';
import { startShim, type Shim } from './browser/pg-rest-shim';
import { buildWithCandidates, grantManualKey, read, U, ORG, ORG_OTHER, ORG_BENE, type Rig } from '../supabase/candidates/__tests__/r1a-fixtures';

const ROOT = join(__dirname, '..');
const SHOTS = process.env.R1_SCREEN_DIR ?? 'D:/MediStock-Recovery/R1-FULL-IMPLEMENTATION-EVIDENCE/browser-screens';
const F = ['R1a_01_manual_source_schema_inert.sql', 'R1a_02_authorization_closure.sql', 'R1a_03_lifecycle_relations_and_sod.sql',
  'R1a_04_manual_routines_inert.sql', 'R1a_05_blockers_digest_d27.sql', 'R1a_06_material_registration_inert.sql'];

function chromeExecutable(): string | null {
  const candidates = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
    .filter((c): c is string => Boolean(c));
  return candidates.find(existsSync) ?? null;
}
const chrome = chromeExecutable();
const run = rigAvailable() && chrome ? describe : describe.skip;


/** Minimal polling web-first assertions over Playwright locators (playwright-core ships no `expect`). */
function ui(l: Locator) {
  const poll = async (what: string, ok: () => Promise<boolean>, timeout = 15000) => {
    const end = Date.now() + timeout; let last: unknown;
    while (Date.now() < end) { try { if (await ok()) return; } catch (e) { last = e; } await new Promise((r) => setTimeout(r, 100)); }
    throw new Error(`UI assertion failed: ${what} (${String(l)})${last ? ' ' + String(last) : ''}`);
  };
  return {
    toBeVisible: (o: { timeout?: number } = {}) => poll('visible', () => l.first().isVisible(), o.timeout),
    toHaveCount: (n: number) => poll(`count ${n}`, async () => (await l.count()) === n),
    toHaveAttribute: (k: string, v: string) => poll(`${k}=${v}`, async () => (await l.first().getAttribute(k)) === v),
    toBeDisabled: () => poll('disabled', () => l.first().isDisabled()),
    toBeEnabled: () => poll('enabled', () => l.first().isEnabled()),
    toBeFocused: () => poll('focused', () => l.first().evaluate((e) => e === document.activeElement)),
    toHaveValue: (v: string) => poll(`value ${v}`, async () => (await l.first().inputValue()) === v),
  };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub: string) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 36000 })}.rig`;
const ACTORS = [
  { id: U.maker, label: 'maker (edit + manual key)' }, { id: U.maker2, label: 'maker2 (edit + manual key)' }, { id: U.checker, label: 'checker (view + approve)' },
  { id: U.checker2, label: 'checker2 (view + approve)' }, { id: U.viewer, label: 'viewer (view only)' }, { id: U.saKeys, label: 'reviewer (super_admin, review key)' },
  { id: U.other, label: 'other-organization manager' }, { id: U.inst, label: 'institution_admin (role not eligible)' },
].map((a) => ({ ...a, jwt: jwt(a.id) }));
const ORGS = [{ id: ORG, label: 'Pharmacy Department (home)' }, { id: ORG_OTHER, label: 'Another PDA' }];

let rig: Rig; let shim: Shim; let server: ViteDevServer; let browser: Browser; let baseUrl = '';
const q = <T = any>(sql: string, p: unknown[] = []): Promise<T[]> => rig.asAdmin((c: any) => c.query(sql, p).then((r: any) => r.rows));

interface Open { actor?: string; org?: string; lang?: 'ar' | 'en'; viewport?: { width: number; height: number } }
async function open(o: Open = {}) {
  const context: BrowserContext = await browser.newContext({ viewport: o.viewport ?? { width: 1280, height: 900 } });
  const page: Page = await context.newPage();
  const requests: string[] = []; const errors: string[] = [];
  page.on('request', (r) => requests.push(`${r.method()} ${r.url()} ${r.postData() ?? ''}`));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript((boot) => { Object.assign(window, { __ACTORS__: boot.actors, __ORGS__: boot.orgs, __SHIM__: boot.shim }); }, { actors: ACTORS, orgs: ORGS, shim: shim.url });
  const p = new URLSearchParams({ actor: o.actor ?? U.maker, org: o.org ?? ORG, lang: o.lang ?? 'en' });
  await page.goto(`${baseUrl}tests/browser/needs-acceptance.html?${p.toString()}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('manual-needs-journey').waitFor({ timeout: 60000 });
  return { context, page, requests, errors };
}
const openYear = async (page: Page, year: string) => {
  await page.getByLabel(/Plan year|سنة الخطة/).fill(year);
  await page.getByRole('button', { name: /Open year|فتح السنة/ }).click();
};
const switchAccount = async (page: Page, actor: string) => {
  await page.getByLabel('Test account').selectOption(actor);
  await page.getByTestId('manual-needs-journey').waitFor();
};
const shot = async (page: Page, name: string) => { try { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); } catch { /* evidence only */ } };
const rpcProbe = (page: Page, fn: string, args: Record<string, unknown>) =>
  page.evaluate(async ([f, a]) => { const r = await window.__supabase.rpc(f as string, a as Record<string, unknown>); return { data: r.data, error: r.error ? { message: r.error.message, code: r.error.code } : null }; }, [fn, args] as const);
const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);

beforeAll(async () => {
  rig = await buildWithCandidates(F, 1);
  await rig.asAdmin((c: any) => c.query(read('R1b_01_manual_activation_NOT_APPLIED.sql')));
  await rig.asAdmin((c: any) => c.query(read('R1b_02_material_registration_activation_NOT_APPLIED.sql')));
  await grantManualKey(rig, [U.maker, U.maker2, U.saKeys]);
  await q(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,'central_needs.material_review',true) ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [U.saKeys]);
  await q(`INSERT INTO central_items (name, name_ar, unit, status, concentration, dosage_form) VALUES ('Paracetamol Test','باراسيتامول تجريبي','box','active','500 mg','Tablet')`);
  await q(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1)`, [ORG]);
  shim = await startShim(rig.pool);
  server = await createServer({
    root: ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false },
    optimizeDeps: { entries: ['tests/browser/needs-acceptance.html'], include: ['xlsx', 'react', 'react-dom', 'react-dom/client', '@supabase/supabase-js'] },
    define: {
      'import.meta.env.VITE_ENABLE_VISUAL_QA': JSON.stringify('true'),
      'import.meta.env.VITE_R1_MANUAL_NEEDS_TAB': JSON.stringify('enabled'),
      'import.meta.env.VITE_PHOENIX_SUPABASE_URL': JSON.stringify(shim.url),
      'import.meta.env.VITE_PHOENIX_SUPABASE_ANON_KEY': JSON.stringify('rig-anon-key'),
    },
  });
  await server.listen();
  baseUrl = server.resolvedUrls?.local[0] ?? '';
  browser = await chromium.launch({ executablePath: chrome!, args: ['--disable-gpu', '--disable-dev-shm-usage'] });
}, 600000);
afterAll(async () => { await browser?.close(); await server?.close(); await shim?.close(); await rig?.end(); });

run('R1 acceptance (real Chrome) - annual needs, material registration, independent review, Excel assist', { timeout: 180000 }, () => {
  it('1. annual-needs journey: year -> plan -> material -> quantity (exact text) -> readiness -> submit -> the maker cannot decide -> an independent approver approves -> history', async () => {
    await q(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,'central_needs.approve',true) ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [U.maker]);
    const { context, page, errors } = await open({ actor: U.maker });
    try {
      await openYear(page, '2027');
      await ui(page.getByText('There is no plan for this year yet.')).toBeVisible();
      await page.getByRole('button', { name: 'Start a new plan' }).click();
      await ui(page.getByText('Revision 1 — draft')).toBeVisible();
      // material: the registered catalog item, found by search
      await page.getByLabel('Search a registered material').fill('paracetamol test');
      await page.getByRole('button', { name: 'Search' }).click();
      await page.getByRole('listitem').filter({ hasText: 'Paracetamol Test' }).getByRole('button', { name: 'Use' }).click();
      const form = page.getByRole('form', { name: 'Add line' });
      await form.getByLabel('Beneficiary institution').selectOption({ label: 'R1c Hospital A' });
      await form.getByLabel('Item').selectOption({ label: 'Paracetamol Test' });
      // invalid quantity text: explained, nothing written
      await form.getByLabel('Annual quantity').fill('١٢');
      await form.getByLabel('Reason').fill('planned need');
      await form.getByRole('button', { name: 'Add line' }).click();
      await ui(page.getByText(/Did you mean 12/)).toBeVisible();
      await form.getByLabel('Annual quantity').fill('1.50');
      await form.getByRole('button', { name: 'Add line' }).click();
      await ui(form.getByLabel('Annual quantity')).toHaveAttribute('aria-invalid', 'true');
      expect((await q(`SELECT count(*)::int n FROM central_needs_manual_need_events`))[0].n).toBe(0);
      // valid exact text
      await form.getByLabel('Annual quantity').fill('12.5');
      await form.getByRole('button', { name: 'Add line' }).click();
      await ui(page.getByRole('cell', { name: '12.5', exact: true })).toBeVisible();
      const ev = await q(`SELECT quantity_text, event_kind FROM central_needs_manual_need_events`);
      expect(ev).toEqual([{ quantity_text: '12.5', event_kind: 'add' }]);
      // review + submit (explicit confirmation)
      await page.getByRole('button', { name: 'Check readiness' }).click();
      await ui(page.getByText('The revision is ready to submit.')).toBeVisible();
      await page.getByRole('button', { name: 'Submit for independent review' }).click();
      await page.getByRole('button', { name: 'Confirm submission' }).click();
      await ui(page.getByText('Revision 1 — submitted')).toBeVisible();
      // the maker holds the approve key but is excluded for this revision: no controls, and the server refuses a direct call
      await ui(page.getByText(/Whoever entered or submitted this need cannot decide/)).toBeVisible();
      await ui(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
      const rev = (await q(`SELECT id FROM central_needs_plan_revisions`))[0].id;
      const probe = await rpcProbe(page, 'phoenix_central_needs_approve_revision', { p_plan_revision_id: rev });
      expect(probe.error?.message).toMatch(/separation_of_duties|forbidden_central_needs/);
      expect((await q(`SELECT status FROM central_needs_plan_revisions WHERE id=$1`, [rev]))[0].status).toBe('submitted');
      await shot(page, '01-maker-submitted');
      // an independent approver
      await switchAccount(page, U.checker);
      await openYear(page, '2027');
      await page.getByRole('button', { name: 'Approve' }).click();
      await ui(page.getByText('Revision 1 — approved')).toBeVisible();
      const before = (await bodyText(page)).length;
      await page.getByRole('button', { name: 'Show revision history' }).click();
      await expect.poll(async () => (await bodyText(page)).length).toBeGreaterThan(before);
      expect(await bodyText(page)).toMatch(/approv/i);
      const row = (await q(`SELECT status, approved_by FROM central_needs_plan_revisions WHERE id=$1`, [rev]))[0];
      expect(row).toEqual({ status: 'approved', approved_by: U.checker });
      await shot(page, '02-checker-approved-history');
      expect(errors).toEqual([]);
    } finally {
      await q(`UPDATE profile_permission_overrides SET allowed=false WHERE profile_id=$1 AND permission_key='central_needs.approve'`, [U.maker]);
      await context.close();
    }
  });

  it('2. unauthorized access is refused in the UI AND by the server (view-only, institution_admin, another organization, anonymous)', async () => {
    const A = await open({ actor: U.viewer });
    try {
      await openYear(A.page, '2027');
      await ui(A.page.getByText('Revision 1 — approved')).toBeVisible();
      await ui(A.page.getByRole('button', { name: 'Start a new plan' })).toHaveCount(0);
      await ui(A.page.getByRole('button', { name: 'Open a correction' })).toHaveCount(0);
      expect((await rpcProbe(A.page, 'phoenix_central_needs_open_manual_plan_revision', { p_organization_id: ORG, p_plan_year: 2040 })).error?.message).toMatch(/forbidden_central_needs/);
      await shot(A.page, '03-viewer-read-only');
    } finally { await A.context.close(); }
    const B = await open({ actor: U.inst });
    try {
      await openYear(B.page, '2027');
      await ui(B.page.getByRole('button', { name: 'Start a new plan' })).toHaveCount(0);
      expect((await rpcProbe(B.page, 'phoenix_central_needs_open_manual_plan_revision', { p_organization_id: ORG, p_plan_year: 2040 })).error?.message).toMatch(/forbidden_central_needs/);
    } finally { await B.context.close(); }
    const C = await open({ actor: U.other, org: ORG });                                    // a manager of ANOTHER organization looking at the home one
    try {
      await openYear(C.page, '2027');
      await ui(C.page.getByText('There is no plan for this year yet.')).toBeVisible();   // RLS hides the home organization's plan
      await ui(C.page.getByRole('button', { name: 'Start a new plan' })).toHaveCount(0);
      expect((await rpcProbe(C.page, 'phoenix_central_needs_open_manual_plan_revision', { p_organization_id: ORG, p_plan_year: 2040 })).error?.message).toMatch(/forbidden_central_needs/);
      expect((await rpcProbe(C.page, 'phoenix_central_needs_list_material_requests', { p_organization_id: ORG })).data).toEqual([]);
    } finally { await C.context.close(); }
    const D = await open({ actor: U.maker });
    try {
      const anon = await D.page.evaluate(async (url) => {
        const r = await fetch(`${url}/rest/v1/rpc/phoenix_central_needs_open_manual_plan_revision`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: 'x', authorization: 'Bearer x' },
          body: JSON.stringify({ p_organization_id: '00000000-0000-0000-0000-0000000c3001', p_plan_year: 2041 }) });
        return { status: r.status, body: await r.json() };
      }, shim.url);
      expect(anon.status).toBe(403);
      expect(anon.body.code).toBe('42501');
    } finally { await D.context.close(); }
    expect((await q(`SELECT count(*)::int n FROM central_needs_plans WHERE plan_year IN (2040, 2041)`))[0].n).toBe(0);
  });

  it('3. material registration with INDEPENDENT review: request -> submit -> an independent reviewer approves a new item -> the requester uses it and links it explicitly', async () => {
    const stockBefore = (await q(`SELECT (SELECT count(*) FROM warehouse_stock)::int w, (SELECT count(*) FROM outlet_stock)::int o, (SELECT count(*) FROM central_needs_need_lines)::int l`))[0];
    const M = await open({ actor: U.maker });
    try {
      await openYear(M.page, '2028');
      await M.page.getByRole('button', { name: 'Start a new plan' }).click();
      await ui(M.page.getByText('Revision 1 — draft')).toBeVisible();
      await M.page.getByLabel('Search a registered material').fill('zzz not in catalog');
      await M.page.getByRole('button', { name: 'Search' }).click();
      await M.page.getByRole('button', { name: 'Request registration of a new material' }).click();
      const panel = M.page.getByTestId('material-registration-panel');
      await panel.getByLabel('Scientific name').fill('Zolpidem R1X');
      await panel.getByLabel('Strength').fill('10 mg');
      await panel.getByLabel('Dosage form').fill('Tablet');
      const save = panel.getByRole('button', { name: 'Save request as draft' });
      await ui(save).toBeDisabled();                                                 // the unit has no silent default
      await panel.getByLabel('Unit').selectOption('tablet');
      await save.click();
      await ui(panel.getByRole('button', { name: /Zolpidem R1X — draft/ })).toBeVisible();
      await panel.getByRole('button', { name: 'Submit request' }).click();
      await ui(panel.getByRole('button', { name: /Zolpidem R1X — submitted/ })).toBeVisible();
      await ui(panel.getByRole('button', { name: 'Start review' })).toHaveCount(0);   // never the requester's own review
      const reqId = (await q(`SELECT id FROM central_needs_material_requests WHERE scientific_name='Zolpidem R1X'`))[0].id;
      expect((await rpcProbe(M.page, 'phoenix_central_needs_start_material_review', { p_request_id: reqId, p_expected_version: (await q(`SELECT version FROM central_needs_material_requests WHERE id=$1`, [reqId]))[0].version })).error?.message).toMatch(/forbidden_central_needs/);
      await shot(M.page, '04-registration-submitted');
    } finally { await M.context.close(); }

    const R = await open({ actor: U.saKeys });
    try {
      await openYear(R.page, '2028');
      await ui(R.page.getByText('Revision 1 — draft')).toBeVisible();
      await R.page.getByLabel('Search a registered material').fill('zzz not in catalog');
      await R.page.getByRole('button', { name: 'Search' }).click();
      await R.page.getByRole('button', { name: 'Request registration of a new material' }).click();
      const panel = R.page.getByTestId('material-registration-panel');
      await panel.getByRole('button', { name: 'Start review' }).click();
      await panel.getByRole('button', { name: /Zolpidem R1X — under review/ }).click();
      await panel.getByLabel('Decision note').fill('new registered material');
      await panel.getByRole('button', { name: 'Approve as new' }).click();
      await ui(panel.getByRole('button', { name: /Zolpidem R1X — approved as new/ })).toBeVisible();
      await shot(R.page, '05-registration-approved-by-reviewer');
    } finally { await R.context.close(); }

    const row = (await q(`SELECT r.status, r.requester_id, r.reviewer_id, r.resolved_item_id, i.name, i.status AS item_status FROM central_needs_material_requests r JOIN central_items i ON i.id = r.resolved_item_id WHERE r.scientific_name='Zolpidem R1X'`))[0];
    expect(row).toMatchObject({ status: 'approved_new', requester_id: U.maker, reviewer_id: U.saKeys, name: 'Zolpidem R1X', item_status: 'active' });
    expect(row.requester_id).not.toBe(row.reviewer_id);
    const kinds = (await q(`SELECT event_kind FROM central_needs_material_request_events e JOIN central_needs_material_requests r ON r.id=e.request_id WHERE r.scientific_name='Zolpidem R1X' ORDER BY seq`)).map((x: any) => x.event_kind);
    expect(kinds).toEqual(['draft_created', 'submitted', 'review_started', 'approved_new']);

    const M2 = await open({ actor: U.maker });
    try {
      await openYear(M2.page, '2028');
      await M2.page.getByLabel('Search a registered material').fill('zzz not in catalog');
      await M2.page.getByRole('button', { name: 'Search' }).click();
      await M2.page.getByRole('button', { name: 'Request registration of a new material' }).click();
      const panel = M2.page.getByTestId('material-registration-panel');
      await panel.getByRole('button', { name: 'Use in the needs' }).click();
      const itemSelect = M2.page.getByRole('form', { name: 'Add line' }).getByLabel('Item');
      await ui(itemSelect.locator('option', { hasText: 'Zolpidem R1X' })).toHaveCount(1);
      await panel.getByRole('button', { name: 'Link to the current draft' }).click();
      await expect.poll(async () => (await q(`SELECT count(*)::int n FROM central_needs_material_request_links`))[0].n).toBe(1);
    } finally { await M2.context.close(); }
    // registration, linking and approval touched no stock and wrote no annual-need line
    expect((await q(`SELECT (SELECT count(*) FROM warehouse_stock)::int w, (SELECT count(*) FROM outlet_stock)::int o, (SELECT count(*) FROM central_needs_need_lines)::int l`))[0]).toEqual(stockBefore);
  });

  it('4. Excel identity assist: row numbers only before confirmation, only the header + identity columns after; no workbook quantity is shown, sent or stored; a suggestion becomes a registration request', async () => {
    const SENT = ['987654', '123456', '555555', '4500 units', 'approx 7'];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Medicine name', 'Strength', 'Dosage form', 'Unit', 'Annual quantity', 'Notes'],
      ['Paracetamol Test', '500 mg', 'Tablet', 'box', 987654, '4500 units'],
      ['Unlisted Drug QX', '20 mg', 'Capsule', 'box', 123456, 'N/A'],
      ['Zolpidem R1X', '10 mg', 'Tablet', 'tablet', 555555, 'approx 7'],
    ]), 'Plan');
    const file = join(tmpdir(), `r1-needs-${Date.now()}.xlsx`);
    writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    const { context, page, requests, errors } = await open({ actor: U.maker });
    try {
      await openYear(page, '2028');
      await ui(page.getByText('Revision 1 — draft')).toBeVisible();
      await page.getByLabel('Choose an Excel file').setInputFiles(file);
      const group = page.getByRole('radiogroup', { name: 'Select the header row' });
      await ui(group).toBeVisible({ timeout: 60000 });
      let text = await bodyText(page);
      for (const s of [...SENT, 'Paracetamol Test', 'Unlisted Drug QX', 'Medicine name']) expect(text, `before confirmation: ${s}`).not.toContain(s);   // row numbers only
      await shot(page, '06-excel-row-numbers-only');
      await group.getByRole('radio', { name: 'Row 1' }).check();
      await page.getByRole('button', { name: 'Confirm header row and look up' }).click();
      await ui(page.getByText('Not registered')).toBeVisible({ timeout: 30000 });
      await ui(page.getByText('Matching material').first()).toBeVisible();
      text = await bodyText(page);
      for (const s of SENT) expect(text, `after confirmation: ${s}`).not.toContain(s);
      await shot(page, '07-excel-identity-results');
      // the unregistered material becomes a registration request carrying an identity-only pointer
      await page.getByRole('button', { name: 'Request registration' }).first().click();
      const panel = page.getByTestId('material-registration-panel');
      await ui(panel.getByText('Suggested from the workbook (identity only)')).toBeVisible();
      await ui(panel.getByLabel('Scientific name')).toHaveValue('Unlisted Drug QX');
      await panel.getByRole('button', { name: 'Save request as draft' }).click();
      await expect.poll(async () => (await q(`SELECT count(*)::int n FROM central_needs_material_requests WHERE scientific_name='Unlisted Drug QX'`))[0].n).toBe(1);
      const r = (await q(`SELECT provenance_kind, provenance FROM central_needs_material_requests WHERE scientific_name='Unlisted Drug QX'`))[0];
      expect(r.provenance_kind).toBe('excel_assist');
      expect(Object.keys(r.provenance).sort()).toEqual(['column', 'file_hash', 'row', 'sheet_index']);
      expect(JSON.stringify(r)).not.toMatch(/987654|123456|555555|quantity/i);
      // nothing quantity-shaped travelled over the wire, and no annual-need line was filled from the workbook
      for (const s of SENT) expect(requests.filter((x) => x.includes(s)), `network: ${s}`).toEqual([]);
      expect((await q(`SELECT count(*)::int n FROM central_needs_need_lines`))[0].n).toBe(1);        // only the manual line of scenario 1
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  it('5. switching organization / year / account while answers are still in flight never shows a stale result; late workbook lookups are ignored', async () => {
    // (a) organization switch while the revision list is held
    const A = await open({ actor: U.maker });
    try {
      shim.hold('table:central_needs_plan_revisions', 1500);
      await openYear(A.page, '2027');
      await A.page.getByLabel('Acting organization').selectOption(ORG_OTHER);
      await A.page.waitForTimeout(2200);
      const t = await bodyText(A.page);
      expect(t).not.toContain('Revision 1 — approved');
      expect(t).not.toContain('Step history');
      await ui(A.page.getByTestId('history')).toHaveCount(0);
    } finally { await A.context.close(); }
    // (b) year switch while the first year's plan lookup is held
    const B = await open({ actor: U.maker });
    try {
      shim.hold('table:central_needs_plans', 1500);
      await openYear(B.page, '2027');
      await openYear(B.page, '2099');
      await ui(B.page.getByText('There is no plan for this year yet.')).toBeVisible();
      await B.page.waitForTimeout(2200);
      expect(await bodyText(B.page)).not.toContain('Revision 1 — approved');
      await ui(B.page.getByText('There is no plan for this year yet.')).toBeVisible();
    } finally { await B.context.close(); }
    // (c) account/role switch while the capability answer is held
    const C = await open({ actor: U.maker });
    try {
      shim.hold('phoenix_central_needs_my_capabilities', 1500);
      await openYear(C.page, '2099');
      await switchAccount(C.page, U.viewer);
      await C.page.waitForTimeout(2200);
      await ui(C.page.getByRole('button', { name: 'Start a new plan' })).toHaveCount(0);
      expect(C.page.url()).toContain('needs-acceptance');
    } finally { await C.context.close(); }
    // (d) a workbook lookup still pending when the header row changes
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Medicine name', 'Strength'], ['Paracetamol Test', '500 mg'], ['Zolpidem R1X', '10 mg']]), 'Plan');
    const file = join(tmpdir(), `r1-late-${Date.now()}.xlsx`);
    writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    const D = await open({ actor: U.maker });
    try {
      await openYear(D.page, '2028');
      await D.page.getByLabel('Choose an Excel file').setInputFiles(file);
      const group = D.page.getByRole('radiogroup', { name: 'Select the header row' });
      await ui(group).toBeVisible({ timeout: 60000 });
      shim.hold('test:identity', 2000);
      await group.getByRole('radio', { name: 'Row 1' }).check();
      await D.page.getByRole('button', { name: 'Confirm header row and look up' }).click();
      await group.getByRole('radio', { name: 'Row 2' }).check();                         // the selection changes while the lookup is pending
      await ui(D.page.getByRole('button', { name: 'Confirm header row and look up' })).toBeEnabled();
      await D.page.waitForTimeout(3500);
      await ui(D.page.getByText('Matching material')).toHaveCount(0);
      await ui(D.page.getByText('Not registered')).toHaveCount(0);
    } finally { await D.context.close(); }
    // (e) registration list held, organization switched
    const E = await open({ actor: U.maker });
    try {
      await openYear(E.page, '2028');
      await E.page.getByLabel('Search a registered material').fill('zzz not in catalog');
      await E.page.getByRole('button', { name: 'Search' }).click();
      shim.hold('phoenix_central_needs_list_material_requests', 1500);
      await E.page.getByRole('button', { name: 'Request registration of a new material' }).click();
      await E.page.getByLabel('Acting organization').selectOption(ORG_OTHER);
      await E.page.waitForTimeout(2200);
      expect(await bodyText(E.page)).not.toContain('Zolpidem R1X');
    } finally { await E.context.close(); }
  });

  it('6. Arabic / English, RTL / LTR, 375px layout, keyboard and accessibility', async () => {
    const { context, page, errors } = await open({ actor: U.maker, lang: 'ar' });
    try {
      await ui(page.getByTestId('manual-needs-journey')).toHaveAttribute('dir', 'rtl');
      await page.getByRole('button', { name: 'فتح السنة' }).click();
      await ui(page.getByRole('heading', { name: '٢. المؤسسة والمادة والكمية' })).toBeVisible();
      await ui(page.getByText(/الإصدار 1 — /).first()).toBeVisible();
      await shot(page, '08-arabic-rtl');
      await page.getByTestId('lang-en').click();
      await ui(page.getByTestId('manual-needs-journey')).toHaveAttribute('dir', 'ltr');
      await ui(page.getByRole('heading', { name: '2. Institution, material, quantity' })).toBeVisible();
    } finally { await context.close(); }
    const m = await open({ actor: U.maker, lang: 'ar', viewport: { width: 375, height: 812 } });
    try {
      await m.page.getByRole('button', { name: 'فتح السنة' }).click();
      await ui(m.page.getByRole('heading', { name: '٢. المؤسسة والمادة والكمية' })).toBeVisible();
      const o = await m.page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
      expect(o.s).toBeLessThanOrEqual(o.c);
      await shot(m.page, '09-mobile-375-arabic');
    } finally { await m.context.close(); }
    const k = await open({ actor: U.maker });
    try {
      // keyboard only: reach "Open year" by Tab and activate it with Enter
      await k.page.getByLabel('Plan year').focus();
      await k.page.keyboard.press('Tab');
      await ui(k.page.getByRole('button', { name: 'Open year' })).toBeFocused();
      await k.page.keyboard.press('Enter');
      await ui(k.page.getByText(/Revision \d+ — /).first()).toBeVisible();
      const a11y = await k.page.evaluate(() => {
        const root = document.querySelector('[data-testid="manual-needs-journey"]')!;
        const unnamedButtons = [...root.querySelectorAll('button')].filter((b) => !(b.textContent ?? '').trim() && !b.getAttribute('aria-label')).length;
        const unlabelled = [...root.querySelectorAll('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), select')].filter((i) => !(i as HTMLInputElement).labels?.length && !i.getAttribute('aria-label')).length;
        return { unnamedButtons, unlabelled, live: root.querySelectorAll('[aria-live="polite"]').length, headings: root.querySelectorAll('h2,h3').length };
      });
      expect(a11y.unnamedButtons).toBe(0);
      expect(a11y.unlabelled).toBe(0);
      expect(a11y.live).toBeGreaterThan(0);
      expect(a11y.headings).toBeGreaterThan(3);
      expect(errors).toEqual([]);
    } finally { await k.context.close(); }
  });

  it('7. Screen 3 in the real browser (QA harness fixtures): the needs tab is ABSENT when the server cannot confirm the capability - fail closed, and the harness makes no request to the backend', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.route('**/*.supabase.co/**', (r) => r.abort('blockedbyclient'));
    const before = shim.calls.length;
    try {
      // the build under test has the activation FLAG on; the fixture backend cannot answer `manual_set`, so the gate must stay off
      await page.goto(`${baseUrl}?qa=1&persona=super_admin&lang=en&scene=inventory&org=qa-org-a1`, { waitUntil: 'networkidle' });
      await ui(page.getByRole('tab').first()).toBeVisible({ timeout: 60000 });
      await page.waitForTimeout(1500);
      expect(await page.getByRole('tab', { name: /Needs & allocation|الاحتياجات والتحصيص/ }).count()).toBe(0);
      expect(shim.calls.length).toBe(before);
      await shot(page, '10-screen3-tab-absent-failclosed');
    } finally { await context.close(); }
  });
});
