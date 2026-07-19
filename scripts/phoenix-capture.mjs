/* ─── PHOENIX visual evidence capture ─────────────────────────────────────────
   Drives a headless Chromium (Playwright) against the running dev server and
   captures the Login surface across AR/EN × light/dark × desktop/mobile, so
   visual QA does NOT depend on the in-app preview pane (which throttles rAF).
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

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// Prefer the system Chrome (hardware GL — far faster compositing than the
// software SwiftShader path, which starves screenshots on heavy backdrop-filter).
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

// Neutralise the expensive blur/animation compositing for the capture only — it
// otherwise blocks the screenshot raster. The WebGL phoenix + layout stay intact.
const CAPTURE_CSS =
  '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;' +
  'animation:none!important;transition:none!important;}';

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
  // Reduced-motion makes the WebGL scene render a single static frame (frameloop
  // 'demand'), so the page is stable enough for a screenshot — the perpetual
  // rAF of the live scene otherwise blocks capture. The phoenix art + a static
  // ember frame are still fully rendered.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  // Wait for the login form and let the WebGL texture load + a few frames render.
  await page.waitForSelector('form.nexus-login__card', { timeout: 15000 }).catch(() => {});
  await page.addStyleTag({ content: CAPTURE_CSS }).catch(() => {});
  await settle(1600);

  const shot = async (label) => {
    const p = join(OUT, `login-${label}-${vp.name}.png`);
    await page.screenshot({ path: p, animations: 'disabled', timeout: 15000 });
    console.log('shot', p.replace(ROOT, '.'));
  };

  // Default state is AR + light.
  await shot('ar-light');

  // → AR dark
  await page.click('button.nexus-control[aria-label*="dark theme"]').catch(() => {});
  await settle(700);
  await shot('ar-dark');

  // → EN dark
  await page.click('button.nexus-control--language').catch(() => {});
  await settle(700);
  await shot('en-dark');

  // → EN light
  await page.click('button.nexus-control[aria-label*="light theme"]').catch(() => {});
  await settle(700);
  await shot('en-light');

  // Report whether a real WebGL context actually rendered.
  const gl = await page.evaluate(() => {
    const c = document.querySelector('.nexus-login__webgl canvas');
    if (!c) return { canvas: false };
    const ctx = c.getContext('webgl2') || c.getContext('webgl');
    return { canvas: true, hasContext: !!ctx, w: c.width, h: c.height };
  });
  console.log(`[${vp.name}] webgl:`, JSON.stringify(gl));
  await page.close();
}

await browser.close();
console.log('DONE');
