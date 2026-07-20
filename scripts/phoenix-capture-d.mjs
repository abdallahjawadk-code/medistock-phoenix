/* ─── PHOENIX Phase D visual evidence capture ─────────────────────────────────
   Drives a headless Chromium (Playwright) against the DEV-only visual QA harness
   (?qa=1) and captures the three post-auth Phase D surfaces — the cinematic
   welcome, the dashboard, and the digital twin — across AR/EN × dark/light ×
   desktop/mobile. Theme/lang are URL-driven (deterministic per cell).

   The harness is gated on import.meta.env.DEV AND VITE_ENABLE_VISUAL_QA=true and
   is tree-shaken from production — see src/features/qa/qaConfig.ts and
   tests/qa-harness-production-safety.test.ts. Run the dev server with that flag:

     VITE_ENABLE_VISUAL_QA=true npx vite --port 5175 --strictPort

   Output → docs/phoenix/visual-evidence/{welcome,dashboard,twin}/.

   Usage: node scripts/phoenix-capture-d.mjs [baseURL]   (default http://localhost:5175)
   ─────────────────────────────────────────────────────────────────────────── */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:5175';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SCENES = [
  { id: 'welcome', selector: '.nexus-welcome__credits' },
  { id: 'dashboard', selector: '.nexus-dash-hero' },
  { id: 'twin', selector: '.nexus-topology' },
];
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

// Freeze animation/backdrop compositing for the capture only — the perpetual
// rAF and heavy blur otherwise starve the screenshot raster. Layout/colour are
// unaffected; the WebGL surfaces fall back to their 2D path under headless GL.
const CAPTURE_CSS =
  '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;' +
  'animation:none!important;transition:none!important;}';

const browser = await launch();
let shots = 0;

for (const scene of SCENES) {
  const OUT = join(ROOT, 'docs', 'phoenix', 'visual-evidence', scene.id);
  mkdirSync(OUT, { recursive: true });

  for (const vp of VIEWPORTS) {
    for (const lang of LANGS) {
      for (const theme of THEMES) {
        const page = await browser.newPage({
          viewport: { width: vp.width, height: vp.height },
          deviceScaleFactor: 1,
        });
        await page.emulateMedia({ reducedMotion: 'reduce' });

        const url = `${BASE}/?qa=1&persona=super_admin&lang=${lang}&theme=${theme}&scene=${scene.id}`;
        await page.goto(url, { waitUntil: 'networkidle' });
        await page.waitForSelector(scene.selector, { timeout: 15000 }).catch(() => {});
        await page.addStyleTag({ content: CAPTURE_CSS }).catch(() => {});
        await settle(900);

        const p = join(OUT, `${scene.id}-${lang}-${theme}-${vp.name}.png`);
        await page.screenshot({ path: p, animations: 'disabled', timeout: 20000 });
        console.log('shot', p.replace(ROOT, '.'));
        shots += 1;

        await page.close();
      }
    }
  }
}

await browser.close();

if (shots === 0) {
  console.error('\nERROR: no screenshots were captured.');
  process.exit(1);
}
console.log(`\nCaptured ${shots} Phase D screenshots.`);
