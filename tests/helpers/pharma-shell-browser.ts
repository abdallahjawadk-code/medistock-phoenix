import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';

// Real production shell + existing, explicit synthetic QA transport. Never
// supplies a live session or allows a request to a foreign origin.
const ROOT = join(__dirname, '..', '..');
export const RETIRED_UI = '[data-guide-id="guide.shell.topbar.help"], [data-guide-id="guide.shell.drawer.help"], .guide-layer, [data-guide-tour], .premium-bottom-nav';
export interface ShellOptions {
  width: number; lang?: 'ar' | 'en'; height?: number; scene?: string;
  persona?: string; theme?: 'light' | 'dark'; reducedMotion?: 'reduce' | 'no-preference';
}
export async function createShellBrowser(label: string) {
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  try {
    server = await createServer({
      root: ROOT, envFile: false, logLevel: 'error',
      cacheDir: join(ROOT, 'node_modules', '.vite', `pharma-${label}`),
      resolve: { dedupe: ['react', 'react-dom'] },
      server: { host: '127.0.0.1', port: 0, strictPort: false,
        fs: { allow: [ROOT, realpathSync(join(ROOT, 'node_modules'))] } },
      define: {
        'import.meta.env.VITE_ENABLE_VISUAL_QA': JSON.stringify('true'),
        'import.meta.env.VITE_PHOENIX_SUPABASE_URL': JSON.stringify('https://pharma-qa.invalid'),
        'import.meta.env.VITE_PHOENIX_SUPABASE_ANON_KEY': JSON.stringify('pharma-qa-fixture-only'),
      },
    });
    await server.listen();
    const baseUrl = server.resolvedUrls?.local[0];
    if (!baseUrl) throw new Error('No local QA URL');
    const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, process.env.CHROME_PATH,
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].find((p): p is string => Boolean(p && existsSync(p)));
    if (!executablePath) throw new Error('Real Chromium is required for shell acceptance');
    browser = await chromium.launch({ headless: true, executablePath });
    const engine = browser;
    return {
      async open(options: ShellOptions) {
        const context: BrowserContext = await engine.newContext({
          viewport: { width: options.width, height: options.height ?? 900 },
          hasTouch: options.width < 1200, reducedMotion: options.reducedMotion,
        });
        const page: Page = await context.newPage();
        const foreign: string[] = [];
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
        await page.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== new URL(baseUrl).origin) {
            foreign.push(route.request().url()); await route.abort();
          } else await route.continue();
        });
        const q = new URLSearchParams({ qa: '1', persona: options.persona ?? 'super_admin',
          scene: options.scene ?? 'shell', lang: options.lang ?? 'en', theme: options.theme ?? 'light', org: 'qa-org-a1' });
        await page.goto(`${baseUrl}?${q}`, { waitUntil: 'load' });
        await page.locator('.premium-topbar').waitFor({ state: 'visible' });
        // Load the exact face explicitly. A small screen may not yet have any
        // visible 500-weight text and fonts.ready alone does not request it.
        await page.evaluate(() => document.fonts.load('500 16px "IBM Plex Sans Arabic"', 'MediStock الصيدلة'));
        expect(await page.evaluate(() => document.fonts.check('500 16px "IBM Plex Sans Arabic"', 'MediStock الصيدلة'))).toBe(true);
        return { context, page, foreign, errors };
      },
      async close() { await engine.close(); await server?.close(); },
    };
  } catch (error) {
    await browser?.close(); await server?.close(); throw error;
  }
}
export async function expectRetirement(page: Page) {
  expect(await page.locator(RETIRED_UI).count()).toBe(0);
  expect(await page.locator('#phoenix-main').count()).toBe(1);
}
export async function selectInventoryWarehouse(page: Page, warehouse = 'qa-wh-inst-a') {
  const picker = page.locator('.nexus-it-context-bar select');
  await picker.waitFor({ state: 'visible' });
  await expect.poll(() => picker.locator(`option[value="${warehouse}"]`).count()).toBe(1);
  await picker.selectOption(warehouse);
}
