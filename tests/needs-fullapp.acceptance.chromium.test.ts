/**
 * R1 FULL-APPLICATION acceptance (limited) - REAL application shell, REAL Supabase Auth, REAL permissions, REAL PRE3-A resolver.
 *
 * NOT RUN BY DEFAULT. Never uses the rig, the PostgREST shim, the QA harness or any assumed credential. It runs only when
 *   (1) the environment is listed in the REVIEWED contract tests/helpers/fullapp-environments.json (empty today - a variable alone can never
 *       authorize a run), AND
 *   (2) the operator supplies it explicitly through environment variables (values are never printed or written):
 *   R1_FA_BASE_URL  R1_FA_NONPROD_CONFIRMED=yes  R1_FA_NONPROD_PROJECT_REF (or R1_FA_NONPROD_SUPABASE_ORIGIN for a self-hosted stack)
 *   R1_FA_PROD_PROJECT_REFS (veto list)  R1_FA_PROD_APP_HOSTS (veto list, optional)
 *   R1_FA_AUTH_EMAIL/_PASSWORD (Pharmacy-Department user with the manual key)   R1_FA_UNAUTH_EMAIL/_PASSWORD (must NOT see the tab)
 *   R1_FA_MATERIAL_QUERY  R1_FA_EXPECTED_MATERIAL
 * Safety order: a FRESH BrowserContext gets a deny-by-default network lock (service workers blocked, WebSockets refused, only the documented
 * read contract and the two sign-in calls are allowed, decided BEFORE a request is sent) before any navigation; the environment contract is
 * checked BEFORE any credential is typed; any recorded violation fails the test. The read inventory cannot be extended from the environment.
 * Missing/unsafe environment => skipped = NOT RUN (never PASS).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { assertNonProduction, backendHostsIn, declaredBackendOrigin, type EnvEntry } from './helpers/fullapp-guard';
import { newLockedContext, type LockedContext } from './helpers/fullapp-lock';

const env = (k: string) => (process.env[k] ?? '').trim();
const list = (k: string) => env(k).split(',').map((s) => s.trim()).filter(Boolean);
const contract = (): EnvEntry[] => (JSON.parse(readFileSync(join(__dirname, 'helpers', 'fullapp-environments.json'), 'utf8')) as { authorized: EnvEntry[] }).authorized;
const repoProdRefs = (): string[] => {
  const refs: string[] = [];
  for (const f of ['.env.example', '.env', '.env.local', '.env.production']) {
    const p = join(__dirname, '..', f);
    if (!existsSync(p)) continue;
    const t = readFileSync(p, 'utf8');
    for (const m of t.matchAll(/([a-z0-9]{20})\.supabase\.co/g)) refs.push(m[1]);
    for (const m of t.matchAll(/PROJECT_REF\s*=\s*([a-z0-9]{20})/g)) refs.push(m[1]);
  }
  return refs;
};
const inputs = () => ({
  confirmed: env('R1_FA_NONPROD_CONFIRMED'), baseUrl: env('R1_FA_BASE_URL'), declaredRef: env('R1_FA_NONPROD_PROJECT_REF'),
  declaredOrigin: env('R1_FA_NONPROD_SUPABASE_ORIGIN'), contract: contract(), prodRefs: [...list('R1_FA_PROD_PROJECT_REFS'), ...repoProdRefs()],
  prodAppHosts: list('R1_FA_PROD_APP_HOSTS'), observedBackendHosts: [] as string[],
});
const chrome = [env('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'), env('CHROME_PATH'), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
  .filter(Boolean).find(existsSync) ?? null;
const SUPPLIED = !!env('R1_FA_BASE_URL') && !!env('R1_FA_AUTH_EMAIL') && !!env('R1_FA_AUTH_PASSWORD') && !!env('R1_FA_UNAUTH_EMAIL')
  && !!env('R1_FA_UNAUTH_PASSWORD') && !!env('R1_FA_MATERIAL_QUERY') && !!env('R1_FA_EXPECTED_MATERIAL');
// static gate: without a contract entry the suite is NOT RUN, whatever the variables say
const READY = SUPPLIED && !!chrome && assertNonProduction(inputs()).length === 0;
const run = READY ? describe : describe.skip;
const SHOTS = env('R1_SCREEN_DIR') || 'D:/MediStock-Recovery/R1-FULL-IMPLEMENTATION-EVIDENCE/fullapp-screens';
const TAB = /Needs & allocation|الاحتياجات والتحصيص/;
const cfg = () => ({ backendOrigin: declaredBackendOrigin(env('R1_FA_NONPROD_PROJECT_REF'), env('R1_FA_NONPROD_SUPABASE_ORIGIN')), appOrigin: new URL(env('R1_FA_BASE_URL')).origin });

let browser: Browser;
beforeAll(async () => { if (READY) browser = await chromium.launch({ executablePath: chrome!, args: ['--disable-gpu'] }); }, 120000);
afterAll(async () => { await browser?.close(); });

/** Bundle consistency check (NOT proof): runs inside the locked context, before any credential. */
async function consistency(lock: LockedContext): Promise<void> {
  const page = await lock.context.newPage();
  const bodies: string[] = [];
  page.on('response', async (r) => { try { if (/javascript|html/.test(r.headers()['content-type'] ?? '')) bodies.push(await r.text()); } catch { /* ignore */ } });
  await page.goto(env('R1_FA_BASE_URL'), { waitUntil: 'networkidle' });
  await page.close();
  const v = assertNonProduction({ ...inputs(), observedBackendHosts: backendHostsIn(bodies) });
  if (v.length) throw new Error(`NOT RUN - environment not proven: ${v.join('; ')}`);
}
async function signIn(page: Page, email: string, password: string) {
  await page.goto(env('R1_FA_BASE_URL'), { waitUntil: 'domcontentloaded' });
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#login-email'), undefined, { timeout: 60000 });
}
async function openInventory(page: Page) {
  await page.getByRole('button', { name: /Inventory|المخزون/ }).first().click({ timeout: 30000 });
  await page.getByRole('tab').first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(2500);                                   // let the server-side capability check settle
}
const noViolations = (lock: LockedContext) => expect(lock.violations().map((l) => `${l.method} ${new URL(l.url).pathname} :: ${l.decision.reason}`)).toEqual([]);

run('R1 full-application acceptance (reviewed non-production environment only)', { timeout: 240000 }, () => {
  it('authorized Pharmacy-Department user: needs tab present; the REAL PRE3-A catalog read returns the expected material (response + UI); the lock recorded no violation', async () => {
    const lock = await newLockedContext(browser, cfg());             // deny-by-default BEFORE any navigation
    try {
      await consistency(lock);                                       // BEFORE any credential
      const page = await lock.context.newPage();
      await signIn(page, env('R1_FA_AUTH_EMAIL'), env('R1_FA_AUTH_PASSWORD'));
      await openInventory(page);
      const tab = page.getByRole('tab', { name: TAB });
      expect(await tab.count()).toBe(1);
      await tab.click();
      await page.getByTestId('manual-needs-journey').waitFor({ timeout: 30000 });
      await page.getByLabel(/Plan year|سنة الخطة/).fill(String(new Date().getFullYear() + 1));
      await page.getByLabel(/Search a registered material|بحث عن مادة مسجلة/).fill(env('R1_FA_MATERIAL_QUERY'));
      // PRE3-A (shared material resolver) = GET /rest/v1/central_items with an `or=` ilike filter built from the typed query
      const resp = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).origin === cfg().backendOrigin
        && new URL(r.url()).pathname === '/rest/v1/central_items' && (new URL(r.url()).searchParams.get('or') ?? '').toLowerCase().includes(env('R1_FA_MATERIAL_QUERY').toLowerCase()), { timeout: 30000 });
      await page.getByRole('button', { name: /^Search$|^بحث$/ }).click();
      const r = await resp;
      expect(r.status()).toBe(200);
      const rows = (await r.json()) as Array<Record<string, unknown>>;
      expect(Array.isArray(rows)).toBe(true);
      const want = env('R1_FA_EXPECTED_MATERIAL').toLowerCase();
      expect(rows.some((row) => ['name', 'name_ar', 'trade_name'].some((k) => String(row[k] ?? '').toLowerCase().includes(want)))).toBe(true);
      await page.getByRole('listitem').filter({ hasText: new RegExp(env('R1_FA_EXPECTED_MATERIAL').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first().waitFor({ timeout: 15000 });
      noViolations(lock);                                            // nothing outside the read contract was even attempted
      mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, 'fullapp-authorized.png'), fullPage: true });
    } finally { await lock.context.close(); }
  });

  it('unauthorized user: the needs tab is absent on Screen 3; the lock recorded no violation', async () => {
    const lock = await newLockedContext(browser, cfg());
    try {
      await consistency(lock);
      const page = await lock.context.newPage();
      await signIn(page, env('R1_FA_UNAUTH_EMAIL'), env('R1_FA_UNAUTH_PASSWORD'));
      await openInventory(page).catch(() => undefined);              // the user may not reach Screen 3 at all - also a valid refusal
      expect(await page.getByRole('tab', { name: TAB }).count()).toBe(0);
      noViolations(lock);
      mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, 'fullapp-unauthorized.png'), fullPage: true });
    } finally { await lock.context.close(); }
  });
});
