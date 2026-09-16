/** @vitest-environment node */
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';

const ROOT = join(__dirname, '..');
const EVIDENCE = resolve(process.env.PACKAGE_B_EVIDENCE_DIR ?? join(ROOT, 'artifacts', 'ux3r-package-b-local'));
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

async function open(lang: 'ar' | 'en', viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.route('**/*.supabase.co/**', route => route.abort('blockedbyclient'));
  const params = new URLSearchParams({ qa: '1', persona: 'super_admin', lang, scene: 'central-needs', org: 'qa-org-a1' });
  await page.goto(`${baseUrl}?${params}`, { waitUntil: 'networkidle' });
  // `.cn2b` is also carried by the pre-existing Need Lines PhoenixCard, so the
  // screen root is addressed exactly — matching the acceptance suite's idiom.
  await page.locator('div.cn2b').first().waitFor({ state: 'visible', timeout: 30000 });
  return { context, page };
}

async function noOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

async function selectStage(page: Page, id: string, mobile = false) {
  if (mobile) {
    const toggle = page.locator('.cn2b-workflow__mobile-toggle');
    if (await toggle.isVisible()) await toggle.click();
  }
  await page.locator(`.cn2b-stagelink[data-stage="${id}"]`).click();
  await expect.poll(() => page.locator('section.cn2b-stage:not([hidden])').count()).toBe(1);
  await expect.poll(() => page.locator(`section.cn2b-stage[data-stage="${id}"]:not([hidden])`).count()).toBe(1);
}

beforeAll(async () => {
  mkdirSync(EVIDENCE, { recursive: true });
  server = await createServer({
    root: ROOT,
    // Own optimizer cache. Vite deletes and rebuilds `node_modules/.vite/deps`
    // whenever a server starts with a different optimizer config, and this one
    // pre-bundles `xlsx`; sharing the default cache with the plain browser
    // suites made each side serve "504 Outdated Optimize Dep" to the other.
    cacheDir: join(ROOT, 'node_modules', '.vite-ux3r-package-b-visual'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    optimizeDeps: { include: ['xlsx'] },
    define: {
      'import.meta.env.VITE_ENABLE_VISUAL_QA': JSON.stringify('true'),
      'import.meta.env.VITE_PHOENIX_SUPABASE_URL': JSON.stringify('https://package-b.invalid'),
      'import.meta.env.VITE_PHOENIX_SUPABASE_ANON_KEY': JSON.stringify('package-b-local-fixture'),
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

describe('UX-3R Package B visual evidence', () => {
  it('keeps six mounted stages but exposes only one active workspace', async () => {
    const { context, page } = await open('ar', { width: 1366, height: 768 });
    try {
      expect(await page.locator('section.cn2b-stage').count()).toBe(6);
      expect(await page.locator('section.cn2b-stage:not([hidden])').count()).toBe(1);
      expect(await noOverflow(page)).toBe(true);
      for (const stage of ['plan', 'source', 'review', 'beneficiaries', 'need-lines', 'readiness']) {
        await selectStage(page, stage);
        await page.screenshot({ path: join(EVIDENCE, `desktop-ar-${stage}.png`), fullPage: true });
      }
    } finally {
      await context.close();
    }
  }, 120000);

  for (const width of [320, 360, 390, 430]) {
    it(`has no document horizontal overflow at ${width}px RTL`, async () => {
      const { context, page } = await open('ar', { width, height: 844 });
      try {
        expect(await page.locator('.cn2b-workflow__mobile-toggle').isVisible()).toBe(true);
        await selectStage(page, 'need-lines', true);
        expect(await noOverflow(page)).toBe(true);
        await page.screenshot({ path: join(EVIDENCE, `mobile-ar-${width}-need-lines.png`), fullPage: true });
      } finally {
        await context.close();
      }
    }, 90000);
  }

  it('keeps LTR navigation and one-active-stage semantics', async () => {
    const { context, page } = await open('en', { width: 1366, height: 768 });
    try {
      await selectStage(page, 'readiness');
      expect(await page.locator('div.cn2b').first().evaluate(el => getComputedStyle(el).direction)).toBe('ltr');
      expect(await noOverflow(page)).toBe(true);
      await page.screenshot({ path: join(EVIDENCE, 'desktop-en-readiness.png'), fullPage: true });
    } finally {
      await context.close();
    }
  }, 90000);
});
