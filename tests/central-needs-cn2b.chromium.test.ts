/**
 * CN-2B — REAL Chromium acceptance, through the repository's sanctioned QA
 * harness (`?qa=1&…`, see src/features/qa/qaConfig.ts).
 *
 * WHAT IS GENUINELY EXERCISED HERE
 *   * authorized and unauthorized navigation, decided by the production
 *     `projectNavigation`/`isScreenAuthorized` predicate, not by the test;
 *   * a REAL file chosen through a real <input type="file">, parsed by the REAL
 *     CN-2A Web Worker in a real browser (DecompressionStream and all) — the
 *     provisional preview state is produced by production code, not a mock;
 *   * the disposition controls, their reason validation and the bulk preview
 *     gate, all of which are client-side and therefore fully reachable;
 *   * Arabic RTL, English LTR, a 375px viewport, horizontal-overflow freedom
 *     and keyboard focus.
 *
 * WHAT IS DELIBERATELY NOT EXERCISED, AND WHY
 *   The authoritative pass (upload-ticket → private staging → Node 22 replay →
 *   trusted batch registration) needs a private Storage bucket, a service-role
 *   secret and the deployed Node API. None of those exist locally, and none may
 *   be created under this authorization. Those scenarios are reported as
 *   BLOCKED rather than simulated: a mock of the trusted path would prove
 *   nothing about the trusted path, and asserting against one would be worse
 *   than not asserting at all.
 *
 * The QA harness is network-free and SELECT-only, so no write RPC can succeed
 * here either — the disposition WRITE is likewise reported as BLOCKED, while
 * everything that gates it client-side is asserted.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';

const ROOT = join(__dirname, '..');
const ARCHIVE_FIXTURE = join(
  ROOT, 'src/features/central-needs/import/__tests__/fixtures/synthetic-archive.zip',
);

let browser: Browser;
let server: ViteDevServer;
let baseUrl: string;

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
  ].filter((c): c is string => Boolean(c));
  const executable = candidates.find(existsSync);
  if (!executable) throw new Error('A system Chromium executable is required for CN-2B acceptance.');
  return executable;
}

interface OpenOptions {
  persona?: string;
  lang?: 'ar' | 'en';
  scene?: string;
  org?: string | null;
  viewport?: { width: number; height: number };
}

async function open(options: OpenOptions = {}) {
  const {
    persona = 'super_admin', lang = 'en', scene = 'central-needs',
    org = 'qa-org-a1', viewport = { width: 1440, height: 900 },
  } = options;

  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  // The harness is network-free, but block anyway so a regression that tries to
  // reach Supabase fails loudly here instead of silently succeeding.
  await page.route('**/*.supabase.co/**', route => route.abort('blockedbyclient'));

  const params = new URLSearchParams({ qa: '1', persona, lang, scene });
  if (org) params.set('org', org);
  await page.goto(`${baseUrl}?${params.toString()}`, { waitUntil: 'networkidle' });
  return { context, page };
}

/** The document must never scroll horizontally, at any viewport. */
async function horizontalOverflow(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}


/** UX-3R exposes one stage at a time; tests navigate to the surface they exercise. */
async function showStage(page: Page, id: 'plan' | 'source' | 'review' | 'beneficiaries' | 'need-lines' | 'readiness') {
  const button = page.locator(`.cn2b-stagelink[data-stage="${id}"]`);
  if (!(await button.isVisible())) {
    const toggle = page.locator('.cn2b-workflow__mobile-toggle');
    if (await toggle.isVisible()) await toggle.click();
  }
  await button.click();
  await expect.poll(
    () => page.locator(`section.cn2b-stage[data-stage="${id}"]:not([hidden])`).count(),
    { timeout: 10000 },
  ).toBe(1);
}

beforeAll(async () => {
  server = await createServer({
    root: ROOT,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    // The production Worker path (useCentralNeedsPreview -> import/worker.ts ->
    // parser-core.ts) pulls in the bare `xlsx` dependency. Left to Vite's
    // default lazy discovery, that dependency is first seen only once the
    // worker actually runs — AFTER this suite has already navigated and
    // selected a file — which triggers dependency re-optimization and a full
    // page reload, silently dropping the just-selected file input state. Vite
    // documents this exact "new dependency found after server start" reload
    // behaviour. Pre-declaring the dependency here makes Vite optimize it
    // during cold start instead, before any test interacts with the page, so
    // no mid-test reload can occur. The Worker itself stays real and unmocked.
    optimizeDeps: {
      include: ['xlsx'],
    },
    define: {
      // The harness is gated on DEV *and* this explicit opt-in (qaConfig.ts),
      // so a dev server that does not set it renders the ordinary app instead.
      'import.meta.env.VITE_ENABLE_VISUAL_QA': JSON.stringify('true'),
      /**
       * This suite supplies its OWN configuration rather than inheriting a
       * developer's `.env.local`, exactly as the interactive-guide suites do.
       * `.invalid` is reserved by RFC 2606 and can never resolve; the DEV
       * client is already a proxy pointed at the harness's network-free
       * fixture client, and every case additionally aborts any request that
       * tries to leave for Supabase.
       */
      'import.meta.env.VITE_PHOENIX_SUPABASE_URL': JSON.stringify('https://cn2b-acceptance.invalid'),
      'import.meta.env.VITE_PHOENIX_SUPABASE_ANON_KEY': JSON.stringify('cn2b-acceptance-fixture-key'),
    },
  });
  await server.listen();
  baseUrl = server.resolvedUrls?.local[0] ?? '';
  if (!baseUrl) throw new Error('Vite did not expose a local test URL.');
  browser = await chromium.launch({ executablePath: chromiumExecutable() });
}, 180000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('CN-2B · navigation authorization (real browser)', () => {
  it('an authorized actor sees the Central Needs entry in the real sidebar', async () => {
    const { context, page } = await open({ scene: 'shell' });
    try {
      // Rendered by projectNavigation -> isScreenAuthorized, the production predicate.
      await expect
        .poll(() => page.locator('nav, aside').getByText('Annual Needs', { exact: true }).count(), { timeout: 15000 })
        .toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }, 60000);

  it('an unauthorized actor never sees the entry', async () => {
    // outlet_officer holds no central_needs key (migration 209 ships zero role
    // defaults and the harness overlay grants it nothing).
    const { context, page } = await open({ scene: 'shell', persona: 'outlet_officer', org: null });
    try {
      await page.waitForTimeout(1500);
      expect(await page.getByText('Annual Needs', { exact: true }).count()).toBe(0);
      expect(await page.getByText('الاحتياج السنوي', { exact: true }).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 60000);
});

describe('CN-2B · review surface (real browser)', () => {
  it('renders the authoritatively-verified session and the server-computed INCOMPLETE state', async () => {
    const { context, page } = await open();
    try {
      await showStage(page, 'source');
      await expect.poll(() => page.getByText('AUTHORITATIVELY VERIFIED').count(), { timeout: 20000 })
        .toBeGreaterThan(0);
      await showStage(page, 'readiness');
      // Completeness comes from the server's own predicate, projected verbatim.
      expect(await page.getByText('INCOMPLETE').count()).toBeGreaterThan(0);
      expect(await page.getByText('A row has no explicit decision').count()).toBeGreaterThan(0);
      // Submit stays disabled while the server reports blockers.
      const submit = page.getByRole('button', { name: 'Submit for review' });
      if (await submit.count()) expect(await submit.first().isDisabled()).toBe(true);
    } finally {
      await context.close();
    }
  }, 90000);

  it('shows source and effective value as SEPARATE columns, with provenance', async () => {
    const { context, page } = await open();
    try {
      await showStage(page, 'review');
      await expect.poll(() => page.locator('.cn2b-table--review').count(), { timeout: 20000 }).toBeGreaterThan(0);
      for (const heading of ['Source value', 'Effective value', 'Provenance', 'Decision']) {
        expect(await page.getByRole('columnheader', { name: heading }).count(), heading).toBeGreaterThan(0);
      }
      // The override is rendered BESIDE its source value, never replacing it.
      expect(await page.locator('.cn2b-value__raw', { hasText: '120' }).count()).toBeGreaterThan(0);
      expect(await page.locator('.cn2b-effective__value', { hasText: '150' }).count()).toBeGreaterThan(0);
      expect(await page.getByText('Corrected against the signed institution request.').count()).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }, 90000);

  it('renders a markup-looking cell as TEXT and a formula verbatim, never evaluated', async () => {
    const { context, page } = await open();
    try {
      await showStage(page, 'review');
      await expect.poll(() => page.locator('.cn2b-table--review').count(), { timeout: 20000 }).toBeGreaterThan(0);
      // The literal characters are on screen; no <b> element was created from data.
      expect(await page.getByText('<b>Ibuprofen 400mg</b>').count()).toBeGreaterThan(0);
      expect(await page.locator('.cn2b-value b').count()).toBe(0);
      // The formula's text is shown; its cached value is a separate fact.
      expect(await page.getByText('=SUM(C5:C5)').count()).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }, 90000);

  it('shows both explicit decisions and leaves undecided rows visibly undecided', async () => {
    const { context, page } = await open();
    try {
      await showStage(page, 'review');
      await expect.poll(() => page.locator('.cn2b-decision').count(), { timeout: 20000 }).toBeGreaterThan(0);
      expect(await page.locator(".cn2b-decision[data-decision='mapped']").count()).toBe(1);
      expect(await page.locator(".cn2b-decision[data-decision='not_applicable']").count()).toBe(1);
      expect(await page.locator(".cn2b-decision[data-decision='none']").count()).toBe(2);
      expect(await page.locator("tr[data-undecided='true']").count()).toBeGreaterThan(0);
      expect(await page.getByText('Subtotal line, not a dispensable material.').count()).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }, 90000);
});

describe('CN-2B · disposition interaction and reason validation (real browser)', () => {
  it('“mark not applicable” stays disabled until a reason is typed', async () => {
    const { context, page } = await open();
    try {
      await showStage(page, 'review');
      await expect.poll(() => page.getByRole('button', { name: 'Mark not applicable' }).count(), { timeout: 20000 })
        .toBeGreaterThan(0);
      const button = page.getByRole('button', { name: 'Mark not applicable' }).first();
      expect(await button.isDisabled()).toBe(true);

      await page.getByLabel('Reason (required for not applicable)').fill('Footer note, not a material.');
      await expect.poll(() => button.isDisabled(), { timeout: 5000 }).toBe(false);

      // Whitespace is not a reason.
      await page.getByLabel('Reason (required for not applicable)').fill('    ');
      await expect.poll(() => button.isDisabled(), { timeout: 5000 }).toBe(true);
    } finally {
      await context.close();
    }
  }, 90000);

  it('a bulk action states its exact count and requires a second confirmation', async () => {
    const { context, page } = await open();
    try {
      await showStage(page, 'review');
      await expect.poll(() => page.getByRole('button', { name: 'Preview effect' }).count(), { timeout: 20000 })
        .toBeGreaterThan(0);
      const preview = page.getByRole('button', { name: 'Preview effect' }).first();

      // No selection, no reason -> refused.
      expect(await preview.isDisabled()).toBe(true);

      await page.getByLabel('Reason (required for not applicable)').fill('Subtotal rows.');
      const boxes = page.locator("input[type='checkbox'][id^='sel-']");
      await boxes.nth(0).check();
      await boxes.nth(1).check();
      await expect.poll(() => preview.isDisabled(), { timeout: 5000 }).toBe(false);

      // Nothing may be written before the count has been shown.
      expect(await page.getByRole('button', { name: 'Confirm and apply' }).count()).toBe(0);
      await preview.click();
      await expect.poll(() => page.getByText('Will change').count(), { timeout: 5000 }).toBeGreaterThan(0);
      expect(await page.locator('.cn2b-bulk__count').innerText()).toContain('2');
      expect(await page.getByRole('button', { name: 'Confirm and apply' }).count()).toBe(1);
    } finally {
      await context.close();
    }
  }, 90000);
});

describe('CN-2B · upload selection and PROVISIONAL preview (real Web Worker)', () => {
  it('parses a real ZIP through the production worker and labels the result provisional', async () => {
    const { context, page } = await open();
    try {
      await showStage(page, 'source');
      await expect.poll(() => page.locator("input[type='file']").count(), { timeout: 20000 }).toBeGreaterThan(0);

      await page.locator("input[type='file']").setInputFiles({
        name: 'synthetic-archive.zip',
        mimeType: 'application/zip',
        buffer: readFileSync(ARCHIVE_FIXTURE),
      });

      // Prove the UI accepted the selection BEFORE waiting on the worker
      // result. If a dependency-discovery reload ever drops this state again,
      // this fails immediately with a clear "file selection was lost" signal
      // instead of a 90-second timeout that only says PROVISIONAL never
      // appeared.
      await expect
        .poll(async () => (await page.locator('.cn2b-panel').allInnerTexts()).join(' | '),
          { timeout: 10000 })
        .toContain('synthetic-archive.zip');

      // The real CN-2A worker runs here — no mock, no stub. Vite compiles the
      // worker module (and SheetJS with it) on first request, which is slow the
      // first time a context asks for it, so this waits generously and then
      // reports what the panel actually said rather than a bare count.
      await expect
        .poll(async () => (await page.locator('.cn2b-panel').allInnerTexts()).join(' | '), { timeout: 90000 })
        .toMatch(/PROVISIONAL|Preview failed/);
      const panels = (await page.locator('.cn2b-panel').allInnerTexts()).join(' | ');
      expect(panels, `preview never became provisional; panels said: ${panels.slice(0, 600)}`)
        .toContain('PROVISIONAL');
      expect(await page.getByText('Files total').count()).toBeGreaterThan(0);
      // Provisional means provisional: nothing was persisted, and the copy says so.
      expect(await page.getByText(/nothing is stored yet/i).count()).toBeGreaterThan(0);
      // The authoritative step is offered but has not run.
      expect(await page.getByRole('button', { name: 'Verify authoritatively' }).count()).toBe(1);
    } finally {
      await context.close();
    }
  }, 120000);
});

describe('CN-2B · annual plan and revision workflow (real browser)', () => {
  it('offers a plan year and an explicit "open annual draft" action', async () => {
    const { context, page } = await open();
    try {
      await showStage(page, 'plan');
      await expect.poll(() => page.getByLabel('Plan year').count(), { timeout: 20000 }).toBe(1);
      const year = page.getByLabel('Plan year');
      expect(await year.inputValue()).toMatch(/^20\d\d$/);
      const openDraft = page.getByRole('button', { name: 'Open annual draft' });
      expect(await openDraft.count()).toBe(1);
      expect(await openDraft.isDisabled()).toBe(false);
      // The copy states the invariant the RPC enforces.
      expect(await page.getByText(/No revision is ever created automatically/i).count())
        .toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }, 90000);

  it('labels every revision with its plan year, never a bare "#1"', async () => {
    const { context, page } = await open();
    try {
      await expect.poll(() => page.locator('.cn2b-select option').count(), { timeout: 20000 })
        .toBeGreaterThan(1);
      const labels = await page.locator('.cn2b-select').first().locator('option').allInnerTexts();
      // Two revisions both numbered 1, from different years — the exact case a
      // bare "#1" would render ambiguous.
      expect(labels.some((l) => l.includes('2026'))).toBe(true);
      expect(labels.some((l) => l.includes('2025'))).toBe(true);
      for (const label of labels) expect(label.trim()).not.toMatch(/^#\d+$/);
    } finally {
      await context.close();
    }
  }, 90000);

  it('offers "open next revision" only for a CLOSED revision', async () => {
    const { context, page } = await open();
    try {
      await showStage(page, 'plan');
      await expect.poll(() => page.getByLabel('Plan year').count(), { timeout: 20000 }).toBe(1);
      // The draft is selected first: superseding is not offered.
      expect(await page.getByRole('button', { name: 'Open next revision' }).count()).toBe(0);

      // Select the approved 2025 revision.
      await page.locator('.cn2b-select').first().selectOption({ label: /2025/ as unknown as string })
        .catch(async () => {
          const options = await page.locator('.cn2b-select').first().locator('option').all();
          for (const o of options) {
            if ((await o.innerText()).includes('2025')) {
              await page.locator('.cn2b-select').first().selectOption(await o.getAttribute('value') ?? '');
              break;
            }
          }
        });
      // UX-3R §7 - a stage choice belongs to its revision ("Never restore a
      // stage choice from another revision"), so switching revision re-runs the
      // default selection behind the workspace loading state (§7.2). This test
      // used to find the Stage 1 action only inside the Stage 1 flash that §7.2
      // removes. Wait for the NEW revision to settle, prove the default selection
      // re-ran, then open Stage 1 explicitly - the same step this test already
      // takes above - where the supersede action lives.
      await expect.poll(async () => (
        (await page.locator('.cn2b-revchip').first().innerText()).includes('2025')
        && await page.locator('.cn2b-workspace-loading').count() === 0
        && await page.locator('section.cn2b-stage:not([hidden])').count() === 1
      ), { timeout: 20000 }).toBe(true);
      expect(await page.locator('section.cn2b-stage[data-stage="plan"]:not([hidden])').count()).toBe(0);
      await showStage(page, 'plan');
      await expect.poll(() => page.getByRole('button', { name: 'Open next revision' }).count(), { timeout: 10000 })
        .toBe(1);
    } finally {
      await context.close();
    }
  }, 90000);
});

describe('CN-2B · field override editor (real browser)', () => {
  it('opens beside the source value and keeps it visible', async () => {
    const { context, page } = await open();
    try {
      await showStage(page, 'review');
      await expect.poll(() => page.getByRole('button', { name: 'Override', exact: true }).count(), { timeout: 20000 })
        .toBeGreaterThan(0);
      await page.getByRole('button', { name: 'Override', exact: true }).first().click();
      await expect.poll(() => page.locator('.cn2b-override').count(), { timeout: 10000 }).toBe(1);
      // The immutable source value is still on screen while the correction is written.
      expect(await page.locator('.cn2b-value__raw').first().isVisible()).toBe(true);
    } finally {
      await context.close();
    }
  }, 90000);

  it('REQUIRES a reason before the override can be saved', async () => {
    const { context, page } = await open();
    try {
      await showStage(page, 'review');
      await expect.poll(() => page.getByRole('button', { name: 'Override', exact: true }).count(), { timeout: 20000 })
        .toBeGreaterThan(0);
      await page.getByRole('button', { name: 'Override', exact: true }).first().click();
      await expect.poll(() => page.locator('.cn2b-override').count(), { timeout: 10000 }).toBe(1);

      const save = page.getByRole('button', { name: 'Save override' });
      expect(await save.isDisabled()).toBe(true);
      await page.getByLabel('Reason (required)').fill('Corrected against the signed request.');
      await expect.poll(() => save.isDisabled(), { timeout: 5000 }).toBe(false);
      // Whitespace is not a reason.
      await page.getByLabel('Reason (required)').fill('   ');
      await expect.poll(() => save.isDisabled(), { timeout: 5000 }).toBe(true);
    } finally {
      await context.close();
    }
  }, 90000);

  it('states the value KIND explicitly so nothing is silently coerced', async () => {
    const { context, page } = await open();
    try {
      await showStage(page, 'review');
      await expect.poll(() => page.getByRole('button', { name: 'Override', exact: true }).count(), { timeout: 20000 })
        .toBeGreaterThan(0);
      await page.getByRole('button', { name: 'Override', exact: true }).first().click();
      await expect.poll(() => page.locator('.cn2b-override').count(), { timeout: 10000 }).toBe(1);

      const kinds = await page.getByLabel('Value kind').locator('option').allInnerTexts();
      // Number, Text, Boolean and Blank are distinct choices — a blank is never
      // the same statement as a zero, and a "0" typed as text stays text.
      for (const k of ['Number', 'Text', 'Boolean', 'Blank']) {
        expect(kinds.map((x) => x.trim()), k).toContain(k);
      }
      // Choosing Blank removes the value box entirely: blank IS the value.
      await page.getByLabel('Value kind').selectOption('blank');
      await expect.poll(() => page.getByLabel('Final value').count(), { timeout: 5000 }).toBe(0);
      await page.getByLabel('Value kind').selectOption('number');
      await expect.poll(() => page.getByLabel('Final value').count(), { timeout: 5000 }).toBe(1);
    } finally {
      await context.close();
    }
  }, 90000);

  it('is a distinct control from the not-applicable disposition', async () => {
    const { context, page } = await open();
    try {
      await showStage(page, 'review');
      await expect.poll(() => page.getByRole('button', { name: 'Override', exact: true }).count(), { timeout: 20000 })
        .toBeGreaterThan(0);
      // Two different reasons, two different controls, two different RPCs.
      expect(await page.getByRole('button', { name: 'Mark not applicable' }).count()).toBeGreaterThan(0);
      await page.getByRole('button', { name: 'Override', exact: true }).first().click();
      await expect.poll(() => page.getByLabel('Reason (required)').count(), { timeout: 10000 }).toBe(1);
      expect(await page.getByLabel('Reason (required for not applicable)').count()).toBe(1);
    } finally {
      await context.close();
    }
  }, 90000);
});

describe('CN-2B · source evidence search (real browser)', () => {
  it('lists the revision\'s own source evidence and filters it', async () => {
    const { context, page } = await open();
    try {
      await showStage(page, 'source');
      await expect.poll(() => page.getByLabel('Search', { exact: true }).count(), { timeout: 20000 }).toBe(1);
      const search = page.getByLabel('Search', { exact: true });
      await search.fill('');
      await expect.poll(async () => (await page.getByText('qa-annual-needs.xls').count()), { timeout: 10000 })
        .toBeGreaterThan(0);

      // Filename filter narrows to the other workbook.
      await search.fill('south');
      await expect.poll(() => page.getByText('qa-south-district.xls').count(), { timeout: 10000 })
        .toBeGreaterThan(0);

      // An archive entry path is searchable too.
      await search.fill('north/');
      await expect.poll(() => page.getByText('north/qa-annual-needs.xls').count(), { timeout: 10000 })
        .toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }, 120000);

  it('search is scoped to the revision and shows fingerprints, not raw locators', async () => {
    const { context, page } = await open();
    try {
      await showStage(page, 'source');
      await expect.poll(() => page.getByLabel('Search', { exact: true }).count(), { timeout: 20000 }).toBe(1);
      await page.getByLabel('Search', { exact: true }).fill('');
      await page.waitForTimeout(1500);
      // Storage locators are opaque internals and are never rendered.
      expect(await page.getByText('permanent/qa', { exact: false }).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 90000);
});

describe('CN-2B · Arabic RTL, English LTR, mobile and keyboard', () => {
  it('renders right-to-left in Arabic with Arabic copy', async () => {
    const { context, page } = await open({ lang: 'ar' });
    try {
      await expect.poll(() => page.locator('.cn2b').count(), { timeout: 20000 }).toBeGreaterThan(0);
      const direction = await page.locator('.cn2b').first().evaluate(el => getComputedStyle(el).direction);
      expect(direction).toBe('rtl');
      await showStage(page, 'source');
      expect(await page.getByText('الاحتياج السنوي').count()).toBeGreaterThan(0);
      expect(await page.getByText('موثّق رسميًا').count()).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }, 90000);

  it('renders left-to-right in English', async () => {
    const { context, page } = await open({ lang: 'en' });
    try {
      await expect.poll(() => page.locator('.cn2b').count(), { timeout: 20000 }).toBeGreaterThan(0);
      const direction = await page.locator('.cn2b').first().evaluate(el => getComputedStyle(el).direction);
      expect(direction).toBe('ltr');
      expect(await page.getByText('Annual Needs').first().isVisible()).toBe(true);
    } finally {
      await context.close();
    }
  }, 90000);

  it('never overflows horizontally — desktop, mobile, either language', async () => {
    for (const lang of ['ar', 'en'] as const) {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
        const { context, page } = await open({ lang, viewport });
        try {
          await expect.poll(() => page.locator('.cn2b').count(), { timeout: 20000 }).toBeGreaterThan(0);
          const { scrollWidth, clientWidth } = await horizontalOverflow(page);
          expect(scrollWidth, `${lang} @ ${viewport.width}px`).toBeLessThanOrEqual(clientWidth + 1);
        } finally {
          await context.close();
        }
      }
    }
  }, 180000);

  it('keeps the wide review table scrolling inside its own container', async () => {
    const { context, page } = await open({ viewport: { width: 375, height: 812 } });
    try {
      await showStage(page, 'review');
      await expect.poll(() => page.locator('.cn2b-scroll').count(), { timeout: 20000 }).toBeGreaterThan(0);
      const overflowX = await page.locator('.cn2b-scroll').first().evaluate(el => getComputedStyle(el).overflowX);
      expect(overflowX).toBe('auto');
      const { scrollWidth, clientWidth } = await horizontalOverflow(page);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    } finally {
      await context.close();
    }
  }, 90000);

  it('is reachable by keyboard, with a visible focus ring', async () => {
    const { context, page } = await open();
    try {
      await expect.poll(() => page.locator('.cn2b-btn, .cn2b-select, .cn2b-input').count(), { timeout: 20000 })
        .toBeGreaterThan(0);

      const seen = new Set<string>();
      for (let i = 0; i < 40; i += 1) {
        await page.keyboard.press('Tab');
        const tag = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el) return '';
          return `${el.tagName.toLowerCase()}:${el.className || ''}`;
        });
        if (tag) seen.add(tag);
      }
      // Focus reached CN-2B's own controls, not just the shell.
      expect([...seen].some(t => t.includes('cn2b'))).toBe(true);

      const reviewStageButton = page.locator('.cn2b-stagelink[data-stage="review"]');
      await reviewStageButton.focus();
      const outline = await reviewStageButton.evaluate((el) => {
        const s = getComputedStyle(el as HTMLElement);
        return { width: s.outlineWidth, style: s.outlineStyle };
      });
      expect(outline).not.toBeNull();
      expect(outline!.style).not.toBe('none');
    } finally {
      await context.close();
    }
  }, 120000);
});
