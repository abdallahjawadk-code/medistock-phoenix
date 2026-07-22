/* ─── PHOENIX digital-twin visual evidence capture ───────────────────────────
   Drives a headless Chromium (Playwright) against the DEV-only visual QA harness
   (?qa=1) and captures the Digital Twin by NAVIGATING THROUGH THE REAL VISIBLE
   CONTROLS — the sidebar on desktop, the drawer on mobile — never a deep link.

   Per AR/EN × dark/light × desktop/mobile cell:
     1. enter the harness at the shell scene (dense twin fixtures live behind it);
     2. desktop → click the sidebar "Network Management" item;
        mobile  → open the drawer, click the item, verify the drawer closes;
     3. select the 3D tab and wait for .nexus-twin[data-ready="true"] — the real
        GPU-ready signal, not a fixed delay — then capture the cinematic scene;
     4. switch through the visible 2D tab and capture the deterministic SVG map.

   Also: one WebGL-unavailable automatic 2D fallback, one reduced-motion state,
   and a dense-topology 2D proof (the fixtures are deliberately dense).

   The harness is gated on import.meta.env.DEV AND VITE_ENABLE_VISUAL_QA=true and
   is tree-shaken from production (src/features/qa/qaConfig.ts,
   tests/qa-harness-production-safety.test.ts). Run the dev server with the flag:

     VITE_ENABLE_VISUAL_QA=true npx vite --port 5176 --strictPort

   Output → docs/phoenix/visual-evidence/twin/.
   Usage: node scripts/phoenix-capture-twin.mjs [baseURL]  (default :5176)
   ─────────────────────────────────────────────────────────────────────────── */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:5176';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'phoenix', 'visual-evidence', 'twin');
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
];
const LANGS = ['ar', 'en'];
const THEMES = ['dark', 'light'];

// Accessible names of the network nav item, per language (nav_network).
const NAV_NETWORK = { ar: 'إدارة الشبكة', en: 'Network Management' };
// Tab accessible text, per language.
const TAB_3D = { ar: 'ثلاثي الأبعاد', en: '3D' };
const TAB_2D = { ar: 'خريطة ثنائية', en: '2D map' };

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  // Prefer real Chrome (hardware GL); fall back to bundled Chromium with
  // SwiftShader so WebGL is still available headlessly and the 3D scene renders.
  try {
    return await chromium.launch({ headless: true, channel: 'chrome', args: ['--ignore-gpu-blocklist'] });
  } catch {
    return await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
    });
  }
}

// Freeze CSS animation/backdrop compositing only — NOT WebGL. The perpetual rAF
// and heavy blur otherwise starve the screenshot raster. The Three.js scene
// keeps rendering; we gate the shot on data-ready, not on this.
const CAPTURE_CSS =
  '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;' +
  'animation:none!important;transition:none!important;}';

const readState = (page) => page.evaluate(() => ({
  lang: document.documentElement.getAttribute('lang'),
  theme: document.documentElement.getAttribute('data-theme'),
}));

const failures = [];
let shots = 0;

async function shoot(page, name) {
  await page.addStyleTag({ content: CAPTURE_CSS }).catch(() => {});
  const p = join(OUT, `${name}.png`);
  await page.screenshot({ path: p, timeout: 20000 });
  console.log('shot', p.replace(ROOT, '.'));
  shots += 1;
}

// Enter the harness at the shell scene, in the requested lang/theme, at the
// requested viewport. Navigation to the twin is done by the caller through the
// real controls.
async function openShell(browser, { lang, theme, vp, initScript }) {
  const page = await browser.newPage({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
  });
  if (initScript) await page.addInitScript(initScript);
  // lang/theme are URL-driven in the harness → deterministic per cell.
  const url = `${BASE}/?qa=1&persona=super_admin&lang=${lang}&theme=${theme}&scene=shell`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.premium-shell', { timeout: 15000 });
  const state = await readState(page);
  if (state.lang !== lang || state.theme !== theme) {
    failures.push(`${lang}-${theme}-${vp.name}: entered lang=${state.lang} theme=${state.theme}`);
  }
  return page;
}

// Navigate to the Digital Twin using the visible controls, then assert we
// actually landed on it (.nexus-topology present).
async function navigateToTwin(page, { lang, vp }) {
  if (vp.mobile) {
    // Open the drawer via the topbar menu button, click the network item, and
    // verify the drawer (role="dialog") closes afterwards.
    await page.click('button[aria-label="القائمة"], button[aria-label="Menu"]');
    await page.waitForSelector('[role="dialog"]', { timeout: 8000 });
    await page.getByRole('dialog').getByRole('button', { name: NAV_NETWORK[lang], exact: false }).click();
    await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 8000 });
  } else {
    // Click the sidebar item directly.
    await page.locator('aside.premium-sidebar')
      .getByRole('button', { name: NAV_NETWORK[lang], exact: false }).click();
  }
  await page.waitForSelector('.nexus-topology', { timeout: 10000 });
}

// Select the 3D tab and wait for the real GPU-ready signal.
async function select3DAndWaitReady(page, { lang }) {
  await page.getByRole('tab', { name: TAB_3D[lang], exact: true }).click();
  // The scene fades in only when its first frame has rendered.
  await page.waitForSelector('.nexus-twin[data-ready="true"]', { timeout: 20000 });
  // Guard against a blank/invisible canvas: the fiber <canvas> must exist and
  // have non-zero backing-store dimensions.
  const ok = await page.evaluate(() => {
    const c = document.querySelector('.nexus-twin__webgl canvas');
    return !!c && c.width > 0 && c.height > 0;
  });
  if (!ok) throw new Error('3D canvas missing or zero-sized after data-ready');
  await settle(400);
}

async function select2D(page, { lang }) {
  await page.getByRole('tab', { name: TAB_2D[lang], exact: true }).click();
  await page.waitForSelector('.nexus-topology__map', { timeout: 10000 });
  await settle(300);
}

const browser = await launch();

// ── Main matrix: AR/EN × dark/light × desktop/mobile, 3D + 2D each ──────────
for (const vp of VIEWPORTS) {
  for (const lang of LANGS) {
    for (const theme of THEMES) {
      const cell = `${lang}-${theme}-${vp.name}`;
      try {
        const page = await openShell(browser, { lang, theme, vp });
        await navigateToTwin(page, { lang, vp });

        await select3DAndWaitReady(page, { lang });
        await shoot(page, `twin-3d-${cell}`);

        await select2D(page, { lang });
        await shoot(page, `twin-2d-${cell}`);

        await page.close();
      } catch (err) {
        failures.push(`${cell}: ${err.message}`);
      }
    }
  }
}

// ── WebGL-unavailable → automatic 2D fallback (no manual tab switch) ─────────
// Null out every WebGL context so detectWebGL() is false → the stage forces the
// 2D safe view on its own. Proves the automatic fallback, not a user choice.
try {
  const killWebGL = () => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (typeof type === 'string' && /webgl/i.test(type)) return null;
      return orig.call(this, type, ...rest);
    };
  };
  const page = await openShell(browser, {
    lang: 'en', theme: 'dark', vp: VIEWPORTS[0], initScript: killWebGL,
  });
  await navigateToTwin(page, { lang: 'en', vp: VIEWPORTS[0] });
  // The 3D tab is disabled; the stage auto-selects 2D. Confirm the safe map and
  // the SAFE MODE badge, then capture.
  await page.waitForSelector('.nexus-topology__map', { timeout: 10000 });
  const safe = await page.locator('.nexus-topology').getByText('SAFE MODE').count();
  if (safe === 0) failures.push('fallback: SAFE MODE badge not shown when WebGL is unavailable');
  await shoot(page, 'twin-fallback-webgl-unavailable-en-dark-desktop');
  await page.close();
} catch (err) {
  failures.push(`fallback: ${err.message}`);
}

// ── Reduced-motion state (3D renders a static frame, no animation loop) ─────
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => { /* reduced motion is emulated at the page level */ });
  await page.goto(`${BASE}/?qa=1&persona=super_admin&lang=en&theme=dark&scene=shell`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.premium-shell', { timeout: 15000 });
  await navigateToTwin(page, { lang: 'en', vp: VIEWPORTS[0] });
  await select3DAndWaitReady(page, { lang: 'en' });
  await shoot(page, 'twin-reduced-motion-en-dark-desktop');
  await page.close();
} catch (err) {
  failures.push(`reduced-motion: ${err.message}`);
}

// ── Dense-topology 2D proof (no node/label overlap at 1 central + 4 inst + 8 outlets) ──
try {
  const page = await openShell(browser, { lang: 'ar', theme: 'dark', vp: VIEWPORTS[0] });
  await navigateToTwin(page, { lang: 'ar', vp: VIEWPORTS[0] });
  await select2D(page, { lang: 'ar' });
  await shoot(page, 'twin-dense-2d-ar-dark-desktop');
  await page.close();
} catch (err) {
  failures.push(`dense-2d: ${err.message}`);
}

await browser.close();

if (failures.length) {
  console.error(`\nERROR: ${failures.length} capture cell(s) failed:\n  ` + failures.join('\n  '));
  process.exit(1);
}
console.log(`\nDONE — ${shots} digital-twin screenshots via real navigation controls.`);
