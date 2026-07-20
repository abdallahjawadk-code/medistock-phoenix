/**
 * Reference-lock visual checkpoint capture (dev-only, not shipped).
 * Drives an installed Edge/Chrome via playwright-core to grab clean 1440x900
 * screenshots of the running dev server.
 *   node scripts/phoenix-shot.mjs <url> <out.png> [lang=ar|en] [theme=dark|light] [width] [height]
 * lang=en clicks the login language toggle; theme=light clicks the theme toggle.
 */
import { chromium } from 'playwright-core';

const [, , url, out, lang = 'ar', theme = 'dark', wArg, hArg] = process.argv;
if (!url || !out) { console.error('usage: phoenix-shot.mjs <url> <out.png> [lang] [theme] [w] [h]'); process.exit(2); }
const width = Number(wArg) || 1440;
const height = Number(hArg) || 900;

let browser;
for (const channel of ['msedge', 'chrome', 'chrome-beta', 'msedge-beta']) {
  try { browser = await chromium.launch({ channel, headless: true }); console.log('launched', channel); break; }
  catch (e) { console.log('channel', channel, 'failed:', e.message.split('\n')[0]); }
}
if (!browser) { console.error('no browser channel available'); process.exit(3); }

const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: theme === 'light' ? 'light' : 'dark' });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

if (lang === 'en') {
  const b = page.locator('.nexus-control--language').first();
  if (await b.count()) { await b.click(); await page.waitForTimeout(400); }
}
if (theme === 'light') {
  const b = page.locator('.nexus-login__controls .nexus-control:not(.nexus-control--language)').first();
  if (await b.count()) { await b.click(); await page.waitForTimeout(400); }
}

await page.waitForTimeout(900); // let reveals/transitions settle
await page.screenshot({ path: out });
console.log('wrote', out, `(${width}x${height}, lang=${lang}, theme=${theme})`);
await browser.close();
