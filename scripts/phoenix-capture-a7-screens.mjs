/* ─── PHASE A7 operational-screen visual evidence capture ─────────────────────
   One-off capture for the A7 visual convergence acceptance pass. Drives the
   DEV-only visual QA harness (?qa=1) across a representative subset of the
   mandated matrix — not the full 13-cell grid, to keep runtime reasonable —
   for the screens the harness already wires to real fixture-backed components.

   Output → docs/phoenix/visual-evidence/a7/.
   Usage: node scripts/phoenix-capture-a7-screens.mjs [baseURL]
   ─────────────────────────────────────────────────────────────────────────── */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:5190';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'phoenix', 'visual-evidence', 'a7');
mkdirSync(OUT, { recursive: true });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

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

const CAPTURE_CSS =
  '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;' +
  'animation:none!important;transition:none!important;}';

// scene -> [cells]. Each cell: { lang, theme, vp }.
const DESKTOP = { name: 'desktop', width: 1440, height: 900 };
const MOBILE = { name: 'mobile', width: 390, height: 844 };

const CELLS = [
  { scene: 'dashboard', lang: 'ar', theme: 'light', vp: DESKTOP },
  { scene: 'dashboard', lang: 'en', theme: 'light', vp: DESKTOP },
  { scene: 'dashboard', lang: 'ar', theme: 'dark', vp: DESKTOP },
  { scene: 'dashboard', lang: 'ar', theme: 'light', vp: MOBILE },
  { scene: 'inventory', lang: 'ar', theme: 'light', vp: DESKTOP },
  { scene: 'inventory', lang: 'en', theme: 'light', vp: DESKTOP },
  { scene: 'inventory', lang: 'ar', theme: 'light', vp: MOBILE },
  { scene: 'institutions', lang: 'ar', theme: 'light', vp: DESKTOP },
  { scene: 'institutions', lang: 'en', theme: 'dark', vp: DESKTOP },
  { scene: 'outlet', lang: 'ar', theme: 'light', vp: DESKTOP },
  { scene: 'outlet', lang: 'ar', theme: 'light', vp: MOBILE },
  { scene: 'twin', lang: 'ar', theme: 'light', vp: DESKTOP },
  { scene: 'status', lang: 'ar', theme: 'light', vp: DESKTOP },
  { scene: 'reports', lang: 'ar', theme: 'light', vp: DESKTOP },
  { scene: 'welcome', lang: 'ar', theme: 'dark', vp: DESKTOP },
  { scene: 'procurement', lang: 'ar', theme: 'light', vp: DESKTOP },
];

const browser = await launch();
let shots = 0;
const failures = [];

for (const cell of CELLS) {
  const { scene, lang, theme, vp } = cell;
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const url = `${BASE}/?qa=1&persona=super_admin&lang=${lang}&theme=${theme}&scene=${scene}`;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('.premium-nav-item, .premium-bottom-nav-item, .nexus-welcome', { timeout: 15000 }).catch(() => {});
    await page.addStyleTag({ content: CAPTURE_CSS }).catch(() => {});
    await settle(700);
    const p = join(OUT, `${scene}-${lang}-${theme}-${vp.name}.png`);
    await page.screenshot({ path: p, animations: 'disabled', timeout: 20000 });
    console.log('shot', p.replace(ROOT, '.'));
    shots += 1;
  } catch (e) {
    failures.push(`${scene}/${lang}/${theme}/${vp.name}: ${e.message}`);
    console.error('FAILED', scene, lang, theme, vp.name, e.message);
  } finally {
    await page.close();
  }
}

await browser.close();

console.log(`\nCaptured ${shots}/${CELLS.length} screenshots -> ${OUT.replace(ROOT, '.')}`);
if (failures.length) {
  console.error('\nFailures:\n' + failures.join('\n'));
}
