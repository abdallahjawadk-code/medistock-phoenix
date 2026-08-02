import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';

const ROOT = join(__dirname, '..');
const PASSWORD_VALUE = 'local-browser-only';

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
  ].filter((candidate): candidate is string => Boolean(candidate));

  const executable = candidates.find(existsSync);
  if (!executable) {
    throw new Error('A system Chromium executable is required for the password-selection regression test.');
  }
  return executable;
}

async function nextBrowserFrame(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
}

async function createLoginPage(options: { viewport: { width: number; height: number }; hasTouch?: boolean }) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const authRequests: string[] = [];

  await page.route('**/auth/v1/**', async route => {
    authRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#login-password').waitFor({ state: 'visible' });

  return { context, page, authRequests };
}

async function setSelection(page: Page, direction: 'forward' | 'backward' | 'none') {
  const input = page.locator('#login-password');
  await input.fill(PASSWORD_VALUE);
  await input.focus();
  return input.evaluate((element, selectionDirection) => {
    element.setSelectionRange(2, 7, selectionDirection);
    return element.selectionDirection ?? 'none';
  }, direction);
}

async function expectSelection(
  page: Page,
  expectedType: 'password' | 'text',
  direction: 'forward' | 'backward' | 'none',
  expectedFocus: 'input' | 'toggle',
) {
  await nextBrowserFrame(page);
  const state = await page.locator('#login-password').evaluate(element => ({
    type: element.type,
    value: element.value,
    start: element.selectionStart,
    end: element.selectionEnd,
    direction: element.selectionDirection,
    activeClass: document.activeElement?.className ?? '',
    inputFocused: document.activeElement === element,
  }));

  expect(state.type).toBe(expectedType);
  expect(state.value).toBe(PASSWORD_VALUE);
  expect(state.start).toBe(2);
  expect(state.end).toBe(7);
  expect(state.direction).toBe(direction);
  if (expectedFocus === 'input') expect(state.inputFocused).toBe(true);
  else expect(state.activeClass).toContain('nexus-login__password-toggle');
}

async function closeContext(context: BrowserContext) {
  await context.close();
}

beforeAll(async () => {
  server = await createServer({
    root: ROOT,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  baseUrl = server.resolvedUrls?.local[0] ?? '';
  if (!baseUrl) throw new Error('Vite did not expose a local test URL.');

  browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable() });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
}, 60_000);

describe('password reveal preserves real Chromium selection', () => {
  it('preserves forward selection and input focus for desktop mouse show and hide', async () => {
    const { context, page, authRequests } = await createLoginPage({ viewport: { width: 1440, height: 900 } });
    try {
      const direction = await setSelection(page, 'forward');
      await page.locator('.nexus-login__password-toggle').click();
      await expectSelection(page, 'text', direction, 'input');

      await page.locator('.nexus-login__password-toggle').click();
      await expectSelection(page, 'password', direction, 'input');
      expect(authRequests).toEqual([]);
    } finally {
      await closeContext(context);
    }
  }, 30_000);

  it('preserves backward selection and button focus for desktop Enter and Space toggles', async () => {
    const { context, page, authRequests } = await createLoginPage({ viewport: { width: 1366, height: 768 } });
    try {
      const direction = await setSelection(page, 'backward');
      const toggle = page.locator('.nexus-login__password-toggle');
      await toggle.focus();
      await toggle.press('Enter');
      await expectSelection(page, 'text', direction, 'toggle');

      await toggle.press('Space');
      await expectSelection(page, 'password', direction, 'toggle');
      expect(authRequests).toEqual([]);
    } finally {
      await closeContext(context);
    }
  }, 30_000);

  it('preserves selection and input focus for mobile touch show and hide', async () => {
    const { context, page, authRequests } = await createLoginPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    try {
      const direction = await setSelection(page, 'none');
      await page.locator('.nexus-login__password-toggle').tap();
      await expectSelection(page, 'text', direction, 'input');

      await page.locator('.nexus-login__password-toggle').tap();
      await expectSelection(page, 'password', direction, 'input');
      expect(authRequests).toEqual([]);
    } finally {
      await closeContext(context);
    }
  }, 30_000);
});
