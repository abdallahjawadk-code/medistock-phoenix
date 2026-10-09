/** @vitest-environment node */
/**
 * PDA-PROC-1 — REAL Chromium acceptance of the pharmacy department
 * supplementary-procurement exclusion, through the repository's sanctioned QA
 * harness (`?qa=1&…`, see src/features/qa/qaConfig.ts).
 *
 * WHAT IS GENUINELY EXERCISED HERE
 *   * Screen 19's organization-eligibility gate (LocalProcurementScreen), the
 *     real component against fixture data: a care institution gets the
 *     workspace exactly once; a pharmacy department authority gets the
 *     not-applicable state, no tablist, never the "no warehouse" message, and
 *     the workspace's scope read is never issued for it;
 *   * every navigation surface — desktop sidebar, phone drawer, phone bottom
 *     bar and the Ctrl+K command palette — decided by the production
 *     `projectNavigation`/`isScreenAuthorized` predicate with the active
 *     organization kind, not by the test;
 *   * Arabic RTL and English LTR, desktop and a 375px phone viewport.
 *
 * WHAT IS DELIBERATELY NOT EXERCISED, AND WHY
 *   * The organization kind itself: the harness never signs in, so
 *     buildQaAppState classifies the active organization from a QA-only map
 *     (ORG_A/ORG_B care, QA_PDA_ORG_ID pharmacy department). The real
 *     AppContext read of organizations.organization_kind, its pending state
 *     and its race handling are proved in jsdom
 *     (src/app/__tests__/pda-proc-1-active-organization-kind.runtime.test.tsx).
 *   * Screen 21's supplementary tab: no QA scene renders the unified reports
 *     shell (`reports` is the legacy ReportsScreen), so that gate is proved in
 *     jsdom (src/features/reports/__tests__/pda-proc-1-report-supplementary-
 *     gate.runtime.test.tsx).
 *   * The database refusal (migration 221) is proved by its own dynamic suite.
 *
 * The QA harness is network-free and SELECT-only. Evidence screenshots land in
 * PDA_PROC_1_EVIDENCE_DIR (default artifacts/pda-proc-1/, git-ignored).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { t, type Lang } from '../src/shared/i18n/strings';

const ROOT = join(__dirname, '..');
const EVIDENCE = resolve(process.env.PDA_PROC_1_EVIDENCE_DIR ?? join(ROOT, 'artifacts', 'pda-proc-1'));

/**
 * The QA fixture organizations this suite addresses through `?org=`. Pinned
 * against their source below, so a renamed fixture fails loudly here instead
 * of silently testing an unknown (null-kind) organization.
 */
const ORG_A = 'qa-org-a1';
const QA_PDA_ORG_ID = '0c22a000-0000-4000-8000-0000000000da';

const SIDEBAR_NAV = '[data-guide-id="guide.shell.navigation.rail"]';
const DRAWER_NAV = '[data-guide-id="guide.shell.navigation.drawer"]';
const BOTTOM_NAV = '[data-guide-id="guide.shell.navigation.bottom"]';
const MENU_TRIGGER = '.premium-drawer-trigger';
const MAIN = '#phoenix-main';
const SCOPE_TOPOLOGY_RPC = 'phoenix_query_organization_scope_topology';

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };

let browser: Browser;
let server: ViteDevServer;
let baseUrl = '';

function chromiumExecutable(): string {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find(existsSync);
  if (!executable) throw new Error('A system Chromium/Edge executable is required for PDA-PROC-1 acceptance.');
  return executable;
}

interface OpenOptions {
  scene: 'procurement' | 'shell';
  org: string;
  lang?: Lang;
  viewport?: { width: number; height: number };
}

async function open({ scene, org, lang = 'en', viewport = DESKTOP }: OpenOptions) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  // The harness is network-free, but block anyway so a regression that tries to
  // reach Supabase fails loudly here instead of silently succeeding.
  await page.route('**/*.supabase.co/**', route => route.abort('blockedbyclient'));
  const params = new URLSearchParams({ qa: '1', persona: 'super_admin', lang, theme: 'light', scene, org });
  await page.goto(`${baseUrl}?${params.toString()}`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.locator('.premium-topbar').waitFor({ state: 'visible', timeout: 30000 });
  return { context, page };
}

/**
 * Cold start: the first request makes Vite pre-bundle the dependency graph,
 * which can outlast a per-test budget and, if a dependency is first discovered
 * mid-test, reload the page under the test. Loading the heaviest scene once up
 * front (the care-institution workspace) settles both before any case runs.
 */
async function warmUp() {
  const { context, page } = await open({ scene: 'procurement', org: ORG_A });
  try {
    // Warm-up only: case (a) asserts this for real, so a miss here is not a failure.
    await page.locator(MAIN).getByRole('tablist').waitFor({ state: 'visible', timeout: 60000 }).catch(() => {});
  } finally {
    await context.close();
  }
}

/** The fixture client's RPC log (QaHarness exposes it as window.__phoenixQaRpcCalls). */
async function rpcCalls(page: Page): Promise<Array<{ name: string; args: Record<string, unknown> }>> {
  return page.evaluate(() =>
    (window as unknown as { __phoenixQaRpcCalls: Array<{ name: string; args: Record<string, unknown> }> })
      .__phoenixQaRpcCalls.map(call => ({ name: call.name, args: call.args })));
}

async function horizontalOverflow(page: Page) {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(EVIDENCE, name), fullPage: true });
}

/** A nav button whose accessible name is exactly the Screen 19 label. */
function screen19Entry(page: Page, surface: string, lang: Lang) {
  return page.locator(surface).getByRole('button', { name: t('nav_local_procurement', lang), exact: true });
}

/** Positive control: Screen 21 is offered to super_admin whatever the organization kind. */
function screen21Entry(page: Page, surface: string, lang: Lang) {
  return page.locator(surface).getByRole('button', { name: t('nav_decision_reports', lang), exact: true });
}

async function openPalette(page: Page, lang: Lang) {
  await page.locator(MAIN).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: t('cc_palette_title', lang) });
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  return dialog;
}

async function searchPalette(page: Page, lang: Lang, query: string) {
  const dialog = page.getByRole('dialog', { name: t('cc_palette_title', lang) });
  await dialog.getByRole('textbox').fill(query);
  // The palette matches against a 150 ms debounced query.
  await page.waitForTimeout(400);
  return dialog;
}

beforeAll(async () => {
  mkdirSync(EVIDENCE, { recursive: true });
  server = await createServer({
    root: ROOT,
    // Own optimizer cache, distinct from every other browser suite (same
    // reasoning as simple-annual-needs.visual.test.ts): a cache shared with a
    // differently-configured server serves "504 Outdated Optimize Dep".
    cacheDir: join(ROOT, 'node_modules', '.vite-pda-proc-1'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    define: {
      // The harness is gated on DEV *and* this explicit opt-in (qaConfig.ts).
      'import.meta.env.VITE_ENABLE_VISUAL_QA': JSON.stringify('true'),
      // Own configuration, never a developer's `.env.local`. `.invalid` is
      // reserved by RFC 2606 and can never resolve.
      'import.meta.env.VITE_PHOENIX_SUPABASE_URL': JSON.stringify('https://pda-proc-1-acceptance.invalid'),
      'import.meta.env.VITE_PHOENIX_SUPABASE_ANON_KEY': JSON.stringify('pda-proc-1-acceptance-fixture-key'),
    },
  });
  await server.listen();
  baseUrl = server.resolvedUrls?.local[0] ?? '';
  if (!baseUrl) throw new Error('Vite did not expose a local test URL.');
  browser = await chromium.launch({ executablePath: chromiumExecutable() });
  await warmUp();
}, 240000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('PDA-PROC-1 · fixture pins', () => {
  it('the organization ids this suite addresses are the QA fixtures, classified care / pharmacy department', () => {
    const qaData = readFileSync(join(ROOT, 'src/features/qa/qaData.ts'), 'utf8');
    const qaFixtures = readFileSync(join(ROOT, 'src/features/qa/qaFixtures.ts'), 'utf8');
    expect(qaData).toContain(`export const ORG_A = '${ORG_A}';`);
    expect(qaFixtures).toContain(`export const QA_PDA_ORG_ID = '${QA_PDA_ORG_ID}';`);
    expect(qaFixtures).toContain("[ORG_A, 'care_institution'],");
    expect(qaFixtures).toContain("[QA_PDA_ORG_ID, 'pharmacy_department_authority'],");
  });
});

describe('PDA-PROC-1 · Screen 19 workspace gate (real browser)', () => {
  it('(a) super_admin on a care institution: the workspace, its title exactly once, its tablist, no not-applicable state', async () => {
    const { context, page } = await open({ scene: 'procurement', org: ORG_A });
    try {
      const main = page.locator(MAIN);
      await main.getByRole('tablist').waitFor({ state: 'visible', timeout: 30000 });
      expect(await main.getByRole('heading', { name: t('lp_screen_title', 'en'), exact: true }).count()).toBe(1);
      expect(await main.getByRole('tablist').count()).toBe(1);
      expect(await page.getByText(t('lp_org_kind_not_applicable_title', 'en'), { exact: true }).count()).toBe(0);
      expect(await page.getByText(t('lp_no_warehouse_scope', 'en'), { exact: true }).count()).toBe(0);
      // Positive control for (b): the workspace's scope read IS observable here.
      await expect.poll(async () => (await rpcCalls(page))
        .filter(call => call.name === SCOPE_TOPOLOGY_RPC && call.args.p_organization_id === ORG_A).length, { timeout: 10000 })
        .toBeGreaterThan(0);
      await shot(page, 'a-procurement-care-org-en-desktop.png');
    } finally {
      await context.close();
    }
  }, 120000);

  for (const lang of ['en', 'ar'] as const) {
    it(`(b) super_admin on a pharmacy department authority (${lang}): not applicable, no tablist, no warehouse message, no workspace read`, async () => {
      const { context, page } = await open({ scene: 'procurement', org: QA_PDA_ORG_ID, lang });
      try {
        const main = page.locator(MAIN);
        await main.getByText(t('lp_org_kind_not_applicable_title', lang), { exact: true })
          .waitFor({ state: 'visible', timeout: 30000 });
        expect(await main.getByText(t('lp_org_kind_not_applicable_hint', lang), { exact: true }).count()).toBe(1);
        expect(await main.getByRole('heading', { name: t('lp_screen_title', lang), exact: true }).count()).toBe(1);
        // Give a wrongly-mounted workspace every chance to appear before asserting it never did.
        await page.waitForTimeout(1500);
        expect(await main.getByRole('tablist').count()).toBe(0);
        expect(await page.getByText(t('lp_no_warehouse_scope', lang), { exact: true }).count()).toBe(0);
        expect(await page.getByText(t('lp_denied_title', lang), { exact: true }).count()).toBe(0);
        const scopeReads = (await rpcCalls(page)).filter(call => call.name === SCOPE_TOPOLOGY_RPC
          && call.args.p_organization_id === QA_PDA_ORG_ID);
        expect(scopeReads).toEqual([]);
        expect(await main.evaluate(el => getComputedStyle(el.querySelector('[dir]') ?? el).direction))
          .toBe(lang === 'ar' ? 'rtl' : 'ltr');
        await shot(page, `b-procurement-pda-${lang}-desktop.png`);
      } finally {
        await context.close();
      }
    }, 120000);
  }

  it('(b) the not-applicable state fits a 375px phone in Arabic (no horizontal overflow)', async () => {
    const { context, page } = await open({ scene: 'procurement', org: QA_PDA_ORG_ID, lang: 'ar', viewport: PHONE });
    try {
      await page.locator(MAIN).getByText(t('lp_org_kind_not_applicable_title', 'ar'), { exact: true })
        .waitFor({ state: 'visible', timeout: 30000 });
      expect(await page.locator(MAIN).getByRole('tablist').count()).toBe(0);
      expect(await horizontalOverflow(page)).toBe(0);
      await shot(page, 'b-procurement-pda-ar-phone.png');
    } finally {
      await context.close();
    }
  }, 120000);
});

describe('PDA-PROC-1 · navigation surfaces (real browser)', () => {
  for (const lang of ['en', 'ar'] as const) {
    it(`(c) pharmacy department authority (${lang}): no Screen 19 in the desktop sidebar or the command palette`, async () => {
      const { context, page } = await open({ scene: 'shell', org: QA_PDA_ORG_ID, lang });
      try {
        await expect.poll(() => screen21Entry(page, SIDEBAR_NAV, lang).count(), { timeout: 30000 }).toBe(1);
        expect(await screen19Entry(page, SIDEBAR_NAV, lang).count()).toBe(0);
        await shot(page, `c-shell-pda-${lang}-sidebar.png`);

        await openPalette(page, lang);
        let dialog = await searchPalette(page, lang, t('nav_local_procurement', lang));
        expect(await dialog.getByRole('button', { name: t('nav_local_procurement', lang), exact: true }).count()).toBe(0);
        await shot(page, `c-shell-pda-${lang}-palette.png`);
        // Positive control: the same palette, same actor, still finds Screen 21.
        dialog = await searchPalette(page, lang, t('nav_decision_reports', lang));
        await expect.poll(
          () => dialog.getByRole('button', { name: t('nav_decision_reports', lang), exact: true }).count(),
          { timeout: 10000 },
        ).toBe(1);
      } finally {
        await context.close();
      }
    }, 120000);

    it(`(c) pharmacy department authority (${lang}, 375px): no Screen 19 in the phone drawer or the bottom bar`, async () => {
      const { context, page } = await open({ scene: 'shell', org: QA_PDA_ORG_ID, lang, viewport: PHONE });
      try {
        await page.locator(BOTTOM_NAV).waitFor({ state: 'visible', timeout: 30000 });
        expect(await screen19Entry(page, BOTTOM_NAV, lang).count()).toBe(0);
        await page.locator(MENU_TRIGGER).click();
        await page.locator(DRAWER_NAV).waitFor({ state: 'visible', timeout: 10000 });
        expect(await screen21Entry(page, DRAWER_NAV, lang).count()).toBe(1);
        expect(await screen19Entry(page, DRAWER_NAV, lang).count()).toBe(0);
        await shot(page, `c-shell-pda-${lang}-phone-drawer.png`);
      } finally {
        await context.close();
      }
    }, 120000);
  }

  it('(d) care institution: Screen 19 is offered in the sidebar and the command palette', async () => {
    const { context, page } = await open({ scene: 'shell', org: ORG_A });
    try {
      await expect.poll(() => screen19Entry(page, SIDEBAR_NAV, 'en').count(), { timeout: 30000 }).toBe(1);
      await shot(page, 'd-shell-care-org-en-sidebar.png');

      await openPalette(page, 'en');
      const dialog = await searchPalette(page, 'en', t('nav_local_procurement', 'en'));
      await expect.poll(
        () => dialog.getByRole('button', { name: t('nav_local_procurement', 'en'), exact: true }).count(),
        { timeout: 10000 },
      ).toBe(1);
      await shot(page, 'd-shell-care-org-en-palette.png');
    } finally {
      await context.close();
    }
  }, 120000);

  it('(d) care institution (375px): Screen 19 is offered in the phone drawer; the bottom bar never carried it', async () => {
    const { context, page } = await open({ scene: 'shell', org: ORG_A, lang: 'ar', viewport: PHONE });
    try {
      await page.locator(BOTTOM_NAV).waitFor({ state: 'visible', timeout: 30000 });
      // BOTTOM_NAV is a fixed four-slot shortcut strip that has never listed Screen 19.
      expect(await screen19Entry(page, BOTTOM_NAV, 'ar').count()).toBe(0);
      await page.locator(MENU_TRIGGER).click();
      await page.locator(DRAWER_NAV).waitFor({ state: 'visible', timeout: 10000 });
      expect(await screen19Entry(page, DRAWER_NAV, 'ar').count()).toBe(1);
      await shot(page, 'd-shell-care-org-ar-phone-drawer.png');
    } finally {
      await context.close();
    }
  }, 120000);
});
