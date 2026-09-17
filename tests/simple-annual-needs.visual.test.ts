/** @vitest-environment node */
/**
 * SIMPLE ANNUAL NEEDS — real-Chromium visual acceptance of the DEFAULT entry.
 *
 * Owner task "Simple UX Visual Activation & Convergence": the first stable
 * paint of الاحتياج السنوي must be the Simple workspace, the Advanced
 * six-stage workspace must stay reachable (and returnable) as the secondary
 * entry, and all six Simple states must render, bilingual and responsive,
 * from REAL product code against deterministic fixtures.
 *
 * Runs through the repository's sanctioned QA harness (`?qa=1&…`, see
 * src/features/qa/qaConfig.ts) — network-free and SELECT-only, so nothing
 * here can reach a database. `cn=<variant>` selects the fixture overlay that
 * makes each Simple step reachable (qaCentralNeedsOverlay in qaData.ts). The
 * one write this suite triggers (the upload action) is refused by the
 * harness, and the refusal is photographed as the error-hierarchy evidence.
 *
 * Screenshots land in SIMPLE_UX_EVIDENCE_DIR (default artifacts/…) and are
 * the runtime evidence a human then reviews — a passing assertion here is
 * necessary, never sufficient, for the visual gate.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';

const ROOT = join(__dirname, '..');
const EVIDENCE = resolve(process.env.SIMPLE_UX_EVIDENCE_DIR ?? join(ROOT, 'artifacts', 'simple-annual-needs-visual'));
const ARCHIVE_FIXTURE = join(ROOT, 'src/features/central-needs/import/__tests__/fixtures/synthetic-archive.zip');

let browser: Browser;
let server: ViteDevServer;
let baseUrl = '';

function chromiumExecutable(): string {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter((value): value is string => Boolean(value));
  const executable = candidates.find(existsSync);
  if (!executable) throw new Error('A system Chromium/Edge executable is required.');
  return executable;
}

type Variant = 'default' | 'fresh' | 'draft' | 'closed' | 'analyzing' | 'institution' | 'material' | 'reviewed' | 'ready';

interface OpenOptions {
  lang?: 'ar' | 'en';
  theme?: 'light' | 'dark';
  variant?: Variant;
  viewport?: { width: number; height: number };
  mode?: 'simple' | 'advanced';
}

const DESKTOP = { width: 1440, height: 900 };

async function open({ lang = 'ar', theme = 'light', variant = 'default', viewport = DESKTOP, mode = 'simple' }: OpenOptions = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.route('**/*.supabase.co/**', route => route.abort('blockedbyclient'));
  const params = new URLSearchParams({ qa: '1', persona: 'super_admin', lang, theme, scene: 'central-needs', org: 'qa-org-a1', cn: variant });
  if (mode === 'advanced') params.set('mode', 'advanced');
  await page.goto(`${baseUrl}?${params}`, { waitUntil: 'networkidle' });
  await page.locator('div.cn2b').first().waitFor({ state: 'visible', timeout: 30000 });
  return { context, page };
}

const simple = (page: Page) => page.locator('[data-testid="cn2b-simple-workspace"]');
const stepOf = (page: Page) => simple(page).getAttribute('data-step');
const rpcCount = (page: Page) => page.evaluate(() => (window as unknown as { __phoenixQaRpcCalls: unknown[] }).__phoenixQaRpcCalls.length);

async function overflow(page: Page) {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

/** Every visible control of the Simple page must sit inside the viewport's inline extent. */
async function clippedControls(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bad: string[] = [];
    const root = document.querySelector('[data-testid="cn2b-simple-workspace"]');
    if (!root) return ['no simple workspace'];
    for (const el of root.querySelectorAll<HTMLElement>('button, input, label, h1, h2, p, li, dd, dt')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < -1 || r.right > vw + 1) bad.push(`${el.tagName}:${(el.textContent ?? '').trim().slice(0, 30)} ${Math.round(r.left)}..${Math.round(r.right)} > ${vw}`);
    }
    return bad;
  });
}

/** Buttons the human is expected to press must offer a real hit height. */
async function smallTargets(page: Page) {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="cn2b-simple-workspace"] button.phoenix-button')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.height < 40) bad.push(`${(el.textContent ?? '').trim().slice(0, 30)} h=${Math.round(r.height)}`);
    }
    return bad;
  });
}

/**
 * The app shell's <main> is the scroll owner (not the document), so a
 * 'fullPage' capture only ever shows one viewport. A step taller than the
 * viewport is therefore photographed twice: from the top, and from the end.
 */
async function shot(page: Page, name: string) {
  const main = page.locator('#phoenix-main');
  const scrollable = await main.evaluate((el) => el.scrollHeight - el.clientHeight > 8).catch(() => false);
  if (scrollable) await main.evaluate((el) => { el.scrollTop = 0; });
  await page.screenshot({ path: join(EVIDENCE, name), fullPage: true });
  if (scrollable) {
    await main.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.screenshot({ path: join(EVIDENCE, name.replace(/.png$/, '-end.png')), fullPage: true });
    await main.evaluate((el) => { el.scrollTop = 0; });
  }
}

/** Responsive acceptance for whatever Simple step is on screen. */
async function assertFits(page: Page) {
  expect(await overflow(page)).toBe(0);
  expect(await clippedControls(page)).toEqual([]);
  expect(await smallTargets(page)).toEqual([]);
}

/** Moves from the summary into the item-by-item review, the way a human does. */
async function passSummary(page: Page) {
  await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('summary');
  await page.locator('[data-testid="cn2b-simple-review-start"]').click();
}

beforeAll(async () => {
  mkdirSync(EVIDENCE, { recursive: true });
  server = await createServer({
    root: ROOT,
    // Own optimizer cache (same reasoning as ux3r-package-b.visual.test.ts):
    // this server pre-bundles `xlsx` for the real preview worker, and sharing
    // a cache with a differently-configured server makes each side serve
    // "504 Outdated Optimize Dep" to the other.
    cacheDir: join(ROOT, 'node_modules', '.vite-simple-annual-needs-visual'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    optimizeDeps: { include: ['xlsx'] },
    define: {
      'import.meta.env.VITE_ENABLE_VISUAL_QA': JSON.stringify('true'),
      'import.meta.env.VITE_PHOENIX_SUPABASE_URL': JSON.stringify('https://simple-annual-needs.invalid'),
      'import.meta.env.VITE_PHOENIX_SUPABASE_ANON_KEY': JSON.stringify('simple-annual-needs-local-fixture'),
    },
  });
  await server.listen();
  baseUrl = server.resolvedUrls?.local[0] ?? '';
  if (!baseUrl) throw new Error('Vite did not expose a local URL.');
  browser = await chromium.launch({ executablePath: chromiumExecutable() });
}, 180000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('Simple Annual Needs — the default entry', () => {
  it('paints the Simple workspace FIRST, with no Advanced six-stage workspace on the page', async () => {
    const { context, page } = await open();
    try {
      expect(await page.locator('div.cn2b[data-mode="simple"]').count()).toBe(1);
      await expect.poll(() => simple(page).isVisible()).toBe(true);
      // No Advanced shell around it: no stage sections, no workflow rail, no command header.
      expect(await page.locator('section.cn2b-stage').count()).toBe(0);
      expect(await page.locator('.cn2b-workflow').count()).toBe(0);
      expect(await page.locator('header.cn2b-header').count()).toBe(0);
      // The page identity and the six-step indicator are on screen.
      expect(await page.locator('h1.cn2b-simple-title').innerText()).toBe('الاحتياج السنوي');
      expect(await page.locator('.cn2b-simple-stepper__item').count()).toBe(6);
      expect(await page.locator('.cn2b-simple-stepper__item[data-state="current"]').count()).toBe(1);
      expect(await page.locator('div.cn2b').first().evaluate(el => getComputedStyle(el).direction)).toBe('rtl');
      await assertFits(page);
    } finally {
      await context.close();
    }
  }, 90000);

  it('offers Advanced as a secondary option, enters it, and returns to Simple — same state, no reload', async () => {
    const { context, page } = await open();
    try {
      await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('summary');
      const readsBefore = await rpcCount(page);

      const link = page.locator('[data-testid="cn2b-simple-advanced-link"]');
      expect(await link.isVisible()).toBe(true);
      // A quiet control at the END of the page, below the task card — not a toggle above it.
      const linkBox = await link.boundingBox();
      const cardBox = await page.locator('[data-testid="cn2b-simple-summary"]').boundingBox();
      expect(linkBox && cardBox && linkBox.y > cardBox.y + cardBox.height).toBe(true);

      await link.click();
      await page.locator('div.cn2b[data-mode="advanced"]').waitFor({ state: 'visible', timeout: 10000 });
      expect(await page.locator('section.cn2b-stage').count()).toBe(6);
      expect(await page.locator('section.cn2b-stage:not([hidden])').count()).toBe(1);
      expect(await simple(page).count()).toBe(0);
      expect(await overflow(page)).toBe(0);
      await shot(page, '07-advanced-ar-desktop-entered-from-simple.png');

      await page.locator('[data-testid="cn2b-mode-toggle"]').click();
      await page.locator('div.cn2b[data-mode="simple"]').waitFor({ state: 'visible', timeout: 10000 });
      expect(await page.locator('section.cn2b-stage').count()).toBe(0);
      // The SAME analysed dataset is still on screen — its summary is presented
      // again (dataset-keyed acknowledgement), with the same figures.
      await expect.poll(() => stepOf(page), { timeout: 10000 }).toBe('summary');
      expect(await page.locator('[data-testid="cn2b-simple-count-materials"]').innerText()).toBe('1');
      // Switching modes issued no read at all.
      expect(await rpcCount(page)).toBe(readsBefore);
      await assertFits(page);
    } finally {
      await context.close();
    }
  }, 90000);

  it('an explicit initialMode=advanced still opens the six-stage workspace first (expert entry)', async () => {
    const { context, page } = await open({ mode: 'advanced' });
    try {
      expect(await page.locator('div.cn2b[data-mode="advanced"]').count()).toBe(1);
      expect(await page.locator('section.cn2b-stage').count()).toBe(6);
      expect(await simple(page).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 60000);
});

describe('Simple Annual Needs — the six states, Arabic desktop 1440×900', () => {
  it('1 · upload — no revision yet: choose the year and start', async () => {
    const { context, page } = await open({ variant: 'fresh' });
    try {
      await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('upload');
      expect(await page.locator('[data-testid="cn2b-simple-step-count"]').innerText()).toBe('الخطوة 1 من 6');
      expect(await page.locator('[data-testid="cn2b-simple-start"]').isVisible()).toBe(true);
      expect(await page.getByLabel('سنة الخطة').count()).toBe(1);
      await assertFits(page);
      await shot(page, '01a-simple-ar-desktop-upload-choose-year.png');
    } finally {
      await context.close();
    }
  }, 90000);

  it('1 · upload — open draft: the file surface, a REAL archive parsed by the production worker, the explicit upload action', async () => {
    const { context, page } = await open({ variant: 'draft' });
    try {
      await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('upload');
      const dropzone = page.locator('[data-testid="cn2b-simple-dropzone"]');
      expect(await dropzone.isVisible()).toBe(true);
      expect(await page.locator('[data-testid="cn2b-simple-upload-submit"]').count()).toBe(0);
      await assertFits(page);
      await shot(page, '01-simple-ar-desktop-upload.png');

      // A real file through the real <input type="file">: the production
      // Web Worker parses it (PROVISIONAL preview). While it parses the page
      // is on step 2; when it is ready the page returns to step 1 with the
      // file named and the ONE primary action enabled.
      await page.locator('[data-testid="cn2b-simple-file-input"]').setInputFiles(ARCHIVE_FIXTURE);
      const parsing = await page.locator('[data-testid="cn2b-simple-phases"]').isVisible().catch(() => false);
      if (parsing) await shot(page, '02b-simple-ar-desktop-analyzing-reading-file.png');
      await expect.poll(() => page.locator('[data-testid="cn2b-simple-picked-filename"]').count(), { timeout: 30000 }).toBe(1);
      expect(await page.locator('[data-testid="cn2b-simple-picked-filename"]').innerText()).toBe('synthetic-archive.zip');
      const submit = page.locator('[data-testid="cn2b-simple-upload-submit"]');
      await expect.poll(() => submit.isEnabled(), { timeout: 30000 }).toBe(true);
      await assertFits(page);
      await shot(page, '01b-simple-ar-desktop-upload-file-ready.png');

      // The upload action reaches the SAME trusted path Advanced Mode uses.
      // The harness has no session, so that path refuses — and the refusal is
      // rendered as a human-readable alert, not a raw code.
      await submit.click();
      await expect.poll(() => page.locator('[data-testid="cn2b-simple-error"]').count(), { timeout: 15000 }).toBeGreaterThan(0);
      const alertText = await page.locator('[data-testid="cn2b-simple-error"]').first().innerText();
      expect(alertText).not.toMatch(/not_authenticated|cn2b_err_/);
      expect(await page.locator('[role="alert"]').count()).toBeGreaterThan(0);
      await shot(page, '01c-simple-ar-desktop-upload-refused.png');
    } finally {
      await context.close();
    }
  }, 120000);

  it('1 · upload — closed revision: the explicit correction path, never automatic', async () => {
    const { context, page } = await open({ variant: 'closed' });
    try {
      await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('upload');
      const readsBefore = await rpcCount(page);
      expect(await page.locator('[data-testid="cn2b-simple-closed-notice"]').isVisible()).toBe(true);
      expect(await page.locator('[data-testid="cn2b-simple-create-correction"]').isVisible()).toBe(true);
      expect(await page.locator('.cn2b-simple-status[data-status="approved"]').count()).toBe(1);
      // Rendering opened nothing.
      expect(await rpcCount(page)).toBe(readsBefore);
      await assertFits(page);
      await shot(page, '01d-simple-ar-desktop-upload-closed-correction.png');
    } finally {
      await context.close();
    }
  }, 90000);

  it('2 · analyzing — the revision data is still being prepared (a real held read)', async () => {
    const { context, page } = await open({ variant: 'analyzing' });
    try {
      await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('analyzing');
      expect(await page.locator('[data-testid="cn2b-simple-step-count"]').innerText()).toBe('الخطوة 2 من 6');
      expect(await page.locator('[data-testid="cn2b-simple-analyzing"] [role="status"]').count()).toBe(1);
      // No invented figure anywhere on the card.
      expect(await page.locator('[data-testid="cn2b-simple-analyzing"]').innerText()).not.toMatch(/%/);
      await assertFits(page);
      await shot(page, '02-simple-ar-desktop-analyzing.png');
    } finally {
      await context.close();
    }
  }, 90000);

  it('3 · summary — clear counts with their honest scope, and one primary action', async () => {
    const { context, page } = await open({ variant: 'default' });
    try {
      await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('summary');
      expect(await page.locator('[data-testid="cn2b-simple-step-count"]').innerText()).toBe('الخطوة 3 من 6');
      expect(await page.locator('[data-testid="cn2b-simple-count-materials"]').innerText()).toBe('1');
      expect(await page.locator('[data-testid="cn2b-simple-review-remaining"]').innerText()).toContain('2');
      expect(await page.locator('[data-testid="cn2b-simple-review-start"]').isVisible()).toBe(true);
      await assertFits(page);
      await shot(page, '03-simple-ar-desktop-summary.png');
    } finally {
      await context.close();
    }
  }, 90000);

  it('4 · institution review — one decision dominates: evidence vs. system match, confirm/choose/not', async () => {
    const { context, page } = await open({ variant: 'institution' });
    try {
      await passSummary(page);
      await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('review-institution');
      expect(await page.locator('[data-testid="cn2b-simple-step-count"]').innerText()).toBe('الخطوة 4 من 6');
      expect(await page.locator('[data-testid="cn2b-simple-institution-evidence"]').innerText()).toBe('QA · مستشفى الحلة التعليمي');
      expect(await page.locator('[data-testid="cn2b-simple-institution-suggestion"]').innerText()).toBe('QA · مستشفى الحلة التعليمي');
      for (const label of ['صحيح', 'اختيار مؤسسة أخرى', 'ليست مؤسسة']) {
        expect(await page.getByRole('button', { name: label, exact: true }).count(), label).toBe(1);
      }
      expect(await page.locator('[data-testid="cn2b-simple-institution-progress"]').innerText()).toContain('2');
      await assertFits(page);
      await shot(page, '04-simple-ar-desktop-institution.png');

      // Choosing another institution opens the picker inside the same card, in view.
      await page.getByRole('button', { name: 'اختيار مؤسسة أخرى', exact: true }).click();
      expect(await page.locator('[data-testid="cn2b-simple-institution-picker"]').isVisible()).toBe(true);
      await assertFits(page);
      await shot(page, '04b-simple-ar-desktop-institution-picker.png');
    } finally {
      await context.close();
    }
  }, 90000);

  it('5 · material review — workbook evidence, the workbook unit, the suggested item with its system unit as context', async () => {
    const { context, page } = await open({ variant: 'material' });
    try {
      await passSummary(page);
      await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('review-material');
      expect(await page.locator('[data-testid="cn2b-simple-step-count"]').innerText()).toBe('الخطوة 5 من 6');
      expect(await page.locator('[data-testid="cn2b-simple-material-evidence"]').innerText()).toContain('Amoxicillin');
      // The workbook's own unit field is shown as evidence …
      expect(await page.locator('[data-testid="cn2b-simple-material-unit-row"]').innerText()).toContain('علبة');
      // … and the system's unit is shown only as context beside the suggestion.
      await expect.poll(() => page.locator('[data-testid="cn2b-simple-material-suggestion"]').count(), { timeout: 15000 }).toBe(1);
      expect(await page.locator('.cn2b-simple-match__meta').innerText()).toContain('capsule');
      for (const label of ['صحيح', 'اختيار مادة أخرى', 'ليست مادة']) {
        expect(await page.getByRole('button', { name: label, exact: true }).count(), label).toBe(1);
      }
      await assertFits(page);
      await shot(page, '05-simple-ar-desktop-material.png');
    } finally {
      await context.close();
    }
  }, 90000);

  it('5b · material review — no exact match: the row fails closed to "unit needs review" and an explicit choice', async () => {
    const { context, page } = await open({ variant: 'default' });
    try {
      await passSummary(page);
      await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('review-material');
      expect(await page.locator('[data-testid="cn2b-simple-unit-needs-review"]').count()).toBe(1);
      expect(await page.locator('[data-testid="cn2b-simple-material-suggestion"]').count()).toBe(0);
      expect(await page.getByRole('button', { name: 'اختيار المادة', exact: true }).count()).toBe(1);
      await assertFits(page);
      await shot(page, '05b-simple-ar-desktop-material-no-match.png');
    } finally {
      await context.close();
    }
  }, 90000);

  it('6 · outcome — everything reviewed, the SERVER still lists what remains, and the handoff is explicit', async () => {
    const { context, page } = await open({ variant: 'reviewed' });
    try {
      await passSummary(page);
      await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('pending');
      expect(await page.locator('[data-testid="cn2b-simple-step-count"]').innerText()).toBe('الخطوة 6 من 6');
      expect(await page.locator('[data-testid="cn2b-simple-readiness-messages"] li').count()).toBe(1);
      expect(await page.locator('[data-testid="cn2b-simple-continue-advanced"]').isVisible()).toBe(true);
      expect((await page.locator('[data-testid="cn2b-simple-confirm-quantities"]').count())).toBe(1);
      expect(await page.locator('[data-testid="cn2b-simple-confirm-quantities"]').isDisabled()).toBe(true);
      expect(await page.locator('[data-testid="cn2b-simple-pending"]').innerText()).not.toMatch(/كل شيء جاهز/);
      await assertFits(page);
      await shot(page, '06-simple-ar-desktop-final.png');

      // The handoff enters Advanced with the same state.
      const readsBefore = await rpcCount(page);
      await page.locator('[data-testid="cn2b-simple-continue-advanced"]').click();
      await page.locator('div.cn2b[data-mode="advanced"]').waitFor({ state: 'visible', timeout: 10000 });
      expect(await page.locator('section.cn2b-stage').count()).toBe(6);
      expect(await rpcCount(page)).toBe(readsBefore);
    } finally {
      await context.close();
    }
  }, 90000);

  it('6 · outcome — the server says READY: that verdict is reproduced, nothing more', async () => {
    const { context, page } = await open({ variant: 'ready' });
    try {
      await passSummary(page);
      await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('pending');
      expect(await page.locator('[data-testid="cn2b-simple-readiness-clear"]').innerText()).toContain('أكّد الخادم');
      expect(await page.locator('.cn2b-simple-outcome__mark[data-ready="true"]').count()).toBe(1);
      await assertFits(page);
      await shot(page, '06b-simple-ar-desktop-final-server-ready.png');
    } finally {
      await context.close();
    }
  }, 90000);
});

describe('Simple Annual Needs — Arabic mobile', () => {
  const VIEWPORTS = [
    { width: 430, height: 932 },
    { width: 390, height: 844 },
    { width: 360, height: 800 },
    { width: 320, height: 800 },
  ];

  for (const viewport of VIEWPORTS) {
    it(`${viewport.width}×${viewport.height} — upload, institution review and outcome fit without overflow`, async () => {
      // Step 1 (open draft, file surface)
      let ctx = await open({ variant: 'draft', viewport });
      try {
        await expect.poll(() => stepOf(ctx.page), { timeout: 20000 }).toBe('upload');
        await assertFits(ctx.page);
        await shot(ctx.page, `mobile-${viewport.width}-ar-upload.png`);
      } finally {
        await ctx.context.close();
      }
      // Step 3 → 4 (institution review with the picker open)
      ctx = await open({ variant: 'institution', viewport });
      try {
        await expect.poll(() => stepOf(ctx.page), { timeout: 20000 }).toBe('summary');
        await assertFits(ctx.page);
        await shot(ctx.page, `mobile-${viewport.width}-ar-summary.png`);
        await passSummary(ctx.page);
        await expect.poll(() => stepOf(ctx.page), { timeout: 20000 }).toBe('review-institution');
        await assertFits(ctx.page);
        await shot(ctx.page, `mobile-${viewport.width}-ar-institution.png`);
        await ctx.page.getByRole('button', { name: 'اختيار مؤسسة أخرى', exact: true }).click();
        await assertFits(ctx.page);
        await shot(ctx.page, `mobile-${viewport.width}-ar-institution-picker.png`);
      } finally {
        await ctx.context.close();
      }
      // Step 6 (outcome)
      ctx = await open({ variant: 'reviewed', viewport });
      try {
        await passSummary(ctx.page);
        await expect.poll(() => stepOf(ctx.page), { timeout: 20000 }).toBe('pending');
        await assertFits(ctx.page);
        await shot(ctx.page, `mobile-${viewport.width}-ar-final.png`);
      } finally {
        await ctx.context.close();
      }
    }, 240000);
  }

  it('360×800 — analyzing and material review', async () => {
    const viewport = { width: 360, height: 800 };
    let ctx = await open({ variant: 'analyzing', viewport });
    try {
      await expect.poll(() => stepOf(ctx.page), { timeout: 20000 }).toBe('analyzing');
      await assertFits(ctx.page);
      await shot(ctx.page, 'mobile-360-ar-analyzing.png');
    } finally {
      await ctx.context.close();
    }
    ctx = await open({ variant: 'material', viewport });
    try {
      await passSummary(ctx.page);
      await expect.poll(() => stepOf(ctx.page), { timeout: 20000 }).toBe('review-material');
      await expect.poll(() => ctx.page.locator('[data-testid="cn2b-simple-material-suggestion"]').count(), { timeout: 15000 }).toBe(1);
      await assertFits(ctx.page);
      await shot(ctx.page, 'mobile-360-ar-material.png');
    } finally {
      await ctx.context.close();
    }
  }, 120000);
});

describe('Simple Annual Needs — English LTR and dark theme', () => {
  it('English desktop keeps the same hierarchy, LTR', async () => {
    const { context, page } = await open({ lang: 'en', variant: 'institution' });
    try {
      expect(await page.locator('div.cn2b').first().evaluate(el => getComputedStyle(el).direction)).toBe('ltr');
      expect(await page.locator('h1.cn2b-simple-title').innerText()).toBe('Annual Needs');
      await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('summary');
      expect(await page.locator('[data-testid="cn2b-simple-step-count"]').innerText()).toBe('Step 3 of 6');
      await assertFits(page);
      await shot(page, 'simple-en-desktop.png');
      await passSummary(page);
      await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('review-institution');
      expect(await page.getByRole('button', { name: 'Correct', exact: true }).count()).toBe(1);
      await assertFits(page);
      await shot(page, 'simple-en-desktop-institution.png');
    } finally {
      await context.close();
    }
  }, 90000);

  it('dark theme renders every token-driven surface without breaking', async () => {
    const { context, page } = await open({ theme: 'dark', variant: 'material' });
    try {
      await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('summary');
      await assertFits(page);
      await shot(page, 'simple-ar-desktop-dark-summary.png');
      await passSummary(page);
      await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('review-material');
      await expect.poll(() => page.locator('[data-testid="cn2b-simple-material-suggestion"]').count(), { timeout: 15000 }).toBe(1);
      await assertFits(page);
      await shot(page, 'simple-ar-desktop-dark-material.png');
    } finally {
      await context.close();
    }
  }, 90000);
});

describe('Simple Annual Needs — accessibility basics', () => {
  it('has one h1, labelled inputs, named buttons, status/alert semantics and a visible focus ring', async () => {
    const { context, page } = await open({ variant: 'draft' });
    try {
      await expect.poll(() => stepOf(page), { timeout: 20000 }).toBe('upload');
      // The screen contributes exactly one h1 (the app shell owns its own brand heading outside .cn2b).
      expect(await page.locator('div.cn2b h1').count()).toBe(1);
      expect(await page.locator('[data-testid="cn2b-simple-workspace"] h2').count()).toBeGreaterThan(0);
      // Every button carries an accessible name; every input a label.
      const unnamed = await page.evaluate(() => {
        const bad: string[] = [];
        for (const b of document.querySelectorAll<HTMLButtonElement>('[data-testid="cn2b-simple-workspace"] button')) {
          if (!(b.textContent ?? '').trim() && !b.getAttribute('aria-label')) bad.push(b.outerHTML.slice(0, 80));
        }
        for (const i of document.querySelectorAll<HTMLInputElement>('[data-testid="cn2b-simple-workspace"] input')) {
          const labelled = i.getAttribute('aria-label') || (i.id && document.querySelector(`label[for="${i.id}"]`)) || i.closest('label');
          if (!labelled) bad.push(i.outerHTML.slice(0, 80));
        }
        return bad;
      });
      expect(unnamed).toEqual([]);
      // Keyboard: tabbing reaches the file input, whose visible label gains the ring.
      await page.keyboard.press('Tab');
      let focusedIsSimple = false;
      for (let i = 0; i < 40 && !focusedIsSimple; i += 1) {
        focusedIsSimple = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'cn2b-simple-file-input');
        if (!focusedIsSimple) await page.keyboard.press('Tab');
      }
      expect(focusedIsSimple).toBe(true);
      const ring = await page.locator('.cn2b-simple-dropzone__target').evaluate(el => getComputedStyle(el).outlineStyle);
      expect(ring).not.toBe('none');
      await shot(page, 'a11y-ar-desktop-upload-focus-ring.png');
    } finally {
      await context.close();
    }
  }, 90000);
});
