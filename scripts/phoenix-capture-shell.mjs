/* ─── PHOENIX shell visual evidence capture ───────────────────────────────────
   Drives a headless Chromium (Playwright) against the running dev server and
   captures the app SHELL — sidebar, topbar, mobile bottom nav and mobile
   drawer — across AR/EN × dark/light × desktop/mobile.

   The shell needs an authenticated session, so this drives the DEV-only visual
   QA harness (?qa=1) instead, which renders the real PhoenixAppShell against
   fixture personas. That harness is gated on `import.meta.env.DEV` AND
   `VITE_ENABLE_VISUAL_QA=true`, and is tree-shaken out of production builds —
   see src/features/qa/qaConfig.ts and tests/qa-harness-production-safety.test.ts.

   Output → docs/phoenix/visual-evidence/shell/.

   Usage: node scripts/phoenix-capture-shell.mjs [baseURL]  (default http://localhost:5175)
   ─────────────────────────────────────────────────────────────────────────── */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:5175';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'phoenix', 'visual-evidence', 'shell');
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const LANGS = ['ar', 'en'];
const THEMES = ['dark', 'light'];

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// Prefer the system Chrome (hardware GL); fall back to bundled SwiftShader.
async function launch() {
  try {
    return await chromium.launch({ headless: true, channel: 'chrome', args: ['--ignore-gpu-blocklist'] });
  } catch {
    return await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
    });
  }
}

// Freeze animation/backdrop compositing for the capture only — the perpetual
// rAF and heavy blur otherwise starve the screenshot raster. Layout and colour
// are unaffected.
const CAPTURE_CSS =
  '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;' +
  'animation:none!important;transition:none!important;}';

const browser = await launch();
let shots = 0;

for (const vp of VIEWPORTS) {
  for (const lang of LANGS) {
    for (const theme of THEMES) {
      const page = await browser.newPage({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
      });
      await page.emulateMedia({ reducedMotion: 'reduce' });

      const url = `${BASE}/?qa=1&persona=super_admin&lang=${lang}&theme=${theme}&scene=shell`;
      await page.goto(url, { waitUntil: 'networkidle' });
      // The shell is up once a nav item has rendered (desktop sidebar or the
      // mobile bottom bar, depending on viewport).
      await page
        .waitForSelector('.premium-nav-item, .premium-bottom-nav-item', { timeout: 15000 })
        .catch(() => {});
      await page.addStyleTag({ content: CAPTURE_CSS }).catch(() => {});
      await settle(900);

      const shot = async (label) => {
        const p = join(OUT, `shell-${label}-${lang}-${theme}-${vp.name}.png`);
        await page.screenshot({ path: p, animations: 'disabled', timeout: 20000 });
        console.log('shot', p.replace(ROOT, '.'));
        shots += 1;
      };

      await shot('full');

      if (vp.name === 'mobile') {
        // Open the drawer from the topbar menu button so the mobile navigation
        // surface is captured in its opened state too.
        await page.click('.premium-drawer-trigger').catch(() => {});
        await settle(600);
        if (await page.locator('.premium-mobile-drawer').count()) {
          await shot('drawer');
        } else {
          console.warn(`WARN drawer did not open for ${lang}/${theme}/${vp.name}`);
        }
      }

      await page.close();
    }
  }
}

await browser.close();

if (shots === 0) {
  console.error('\nERROR: no screenshots were captured.');
  process.exit(1);
}
console.log(`\nCaptured ${shots} shell screenshots → ${OUT.replace(ROOT, '.')}`);
