/* ─── PHOENIX Local Procurement (Screen 19) visual evidence capture ───────────
   Drives the DEV-only visual QA harness (?qa=1&scene=procurement) against
   fixture data so the migration-087 Local Procurement workspace is captured
   across AR/EN × dark/light × desktop/tablet/mobile, plus its five tabs
   (orders / approvals / receiving / history / suppliers).

   The harness is gated on `import.meta.env.DEV` AND `VITE_ENABLE_VISUAL_QA=true`
   and is tree-shaken out of production builds (src/features/qa/qaConfig.ts,
   tests/qa-harness-production-safety.test.ts). Nothing here writes: every
   procurement mutation resolves to the fixture client's read-only error.

   Output → docs/phoenix/visual-evidence/procurement/.
   Usage: node scripts/phoenix-capture-procurement.mjs [baseURL]  (default http://localhost:5181)
   ─────────────────────────────────────────────────────────────────────────── */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:5181';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'phoenix', 'visual-evidence', 'procurement');
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'mobile', width: 390, height: 844 },
];
const LANGS = ['ar', 'en'];
const THEMES = ['dark', 'light'];
// super_admin with org set is the read-side persona; procurement permissions
// are all-true for super_admin (platform role) and the org param resolves the
// warehouse scope the workspace needs. Fixture supplier/order/receipt rows are
// bound to ORG_A / qa-wh-inst-a.
const ORG = 'qa-org-a1';

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

const browser = await launch();
let shots = 0;
const failures = [];

// Tab labels are language-specific; click by visible text so the capture drives
// the REAL tablist, not a synthetic selector.
const TAB_LABELS = {
  ar: { orders: 'طلبات الشراء', approvals: 'الموافقات', receiving: 'الاستلام', history: 'السجل والوصولات', suppliers: 'الموردون' },
  en: { orders: 'Purchase Orders', approvals: 'Approvals', receiving: 'Receiving', history: 'History & Receipts', suppliers: 'Suppliers' },
};

for (const vp of VIEWPORTS) {
  for (const lang of LANGS) {
    for (const theme of THEMES) {
      const page = await browser.newPage({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
      });
      await page.emulateMedia({ reducedMotion: 'reduce' });

      const url = `${BASE}/?qa=1&persona=super_admin&org=${ORG}&lang=${lang}&theme=${theme}&scene=procurement`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForSelector('[data-testid="lp-orders"], [role="tablist"]', { timeout: 15000 }).catch(() => {});
      await page.addStyleTag({ content: CAPTURE_CSS }).catch(() => {});

      const banner = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '');
      if (!banner.includes('super_admin')) {
        failures.push(`${lang}/${theme}/${vp.name}: harness banner missing super_admin (stale bundle?)`);
      }

      const shot = async (label) => {
        await settle(700);
        const p = join(OUT, `procurement-${label}-${lang}-${theme}-${vp.name}.png`);
        await page.screenshot({ path: p, animations: 'disabled', timeout: 20000 });
        console.log('shot', p.replace(ROOT, '.'));
        shots += 1;
      };

      // Default tab (orders / composer).
      await shot('orders');

      // Drive each remaining tab by its visible label.
      for (const key of ['approvals', 'receiving', 'history', 'suppliers']) {
        const label = TAB_LABELS[lang][key];
        const tab = page.locator(`[role="tab"]`, { hasText: label }).first();
        if (await tab.count()) {
          await tab.click().catch(() => {});
          await settle(500);
          await shot(key);
        }
      }

      await page.close();
    }
  }
}

await browser.close();

for (const f of failures) console.warn('WARN', f);
if (shots === 0) {
  console.error('\nERROR: no screenshots were captured.');
  process.exit(1);
}
console.log(`\nCaptured ${shots} Local Procurement screenshots → ${OUT.replace(ROOT, '.')}`);
