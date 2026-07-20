/* ─── PHOENIX login visual evidence capture ───────────────────────────────────
   Drives a headless Chromium (Playwright) against the running dev server and
   captures the Login surface across AR/EN × light/dark × desktop/mobile.

   DETERMINISTIC per cell: the app's lang/theme are in-memory state that resets
   to AR+dark on every load (see AppContext) — they are NOT persisted. So each
   cell opens a FRESH page, reads the live <html> lang / data-theme, and clicks
   the language/theme toggles only as needed to reach that exact cell. This
   avoids the old sequential-toggle bug that produced duplicate light/dark shots.

   Output → docs/phoenix/visual-evidence/login/.
   Usage: node scripts/phoenix-capture.mjs [baseURL]   (default http://localhost:5180)
   ─────────────────────────────────────────────────────────────────────────── */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:5180';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'phoenix', 'visual-evidence', 'login');
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const LANGS = ['ar', 'en'];
const THEMES = ['dark', 'light'];

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  try {
    return await chromium.launch({ headless: true, channel: 'chrome', args: ['--ignore-gpu-blocklist'] });
  } catch {
    return await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
    });
  }
}
const browser = await launch();

const CAPTURE_CSS =
  '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;' +
  'animation:none!important;transition:none!important;}';

const readState = (page) => page.evaluate(() => ({
  lang: document.documentElement.getAttribute('lang'),
  theme: document.documentElement.getAttribute('data-theme'),
}));

let shots = 0;
const failures = [];

for (const vp of VIEWPORTS) {
  for (const lang of LANGS) {
    for (const theme of THEMES) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.waitForSelector('form.nexus-login__card', { timeout: 15000 }).catch(() => {});

      // Drive to the target cell from the live state (fresh page = AR+dark).
      let state = await readState(page);
      if (state.lang !== lang) {
        await page.click('button.nexus-control--language').catch(() => {});
        await settle(500);
      }
      state = await readState(page);
      if (state.theme !== theme) {
        await page.click('button.nexus-control[aria-label*="theme"]').catch(() => {});
        await settle(500);
      }

      // Verify we actually reached the target — never silently emit a wrong cell.
      state = await readState(page);
      if (state.lang !== lang || state.theme !== theme) {
        failures.push(`${lang}-${theme}-${vp.name}: got lang=${state.lang} theme=${state.theme}`);
      }

      await page.addStyleTag({ content: CAPTURE_CSS }).catch(() => {});
      await settle(1400);

      const p = join(OUT, `login-${lang}-${theme}-${vp.name}.png`);
      await page.screenshot({ path: p, animations: 'disabled', timeout: 15000 });
      console.log('shot', p.replace(ROOT, '.'), `(lang=${state.lang} theme=${state.theme})`);
      shots += 1;
      await page.close();
    }
  }
}

await browser.close();

if (failures.length) {
  console.error('\nERROR: some cells did not reach their target state:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log(`\nDONE — ${shots} login screenshots (deterministic AR/EN × dark/light × desktop/mobile).`);
