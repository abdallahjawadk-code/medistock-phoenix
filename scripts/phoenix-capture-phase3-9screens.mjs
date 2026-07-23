/* ─── PHASE 3 — nine-screen visual audit capture ──────────────────────────────
   Drives the DEV-only visual-QA harness (?qa=1) across the 9 screen areas the
   user named for Phase 3 ("الشاشات الداخلية"):
     1. مواقف / status center           → scene=status   (screen 12)
     2. إدارة المؤسسات والمستخدمين      → scene=institutions (screen 11)
     3. مركز المخزون                    → scene=inventory (screen 3)
     4. عمليات المنفذ                   → scene=outlet    (screen 18)
     5. المشتريات الفرعية               → scene=procurement (screen 19)
     6. الموقف المخزني الشهري           → scene=monthly   (screen 20)
     7. الإشعارات                       → NotificationBell opened over dashboard
     8. طلبات التصحيح وFEFO والحجر      → inventory "quarantine"/"corrections" tabs
     9. التقارير والتتبع                → scene=reports   (screen 9)

   Output → docs/phoenix/visual-evidence/phase3-nine-screens/.
   Usage: node scripts/phoenix-capture-phase3-9screens.mjs [baseURL]
   ─────────────────────────────────────────────────────────────────────────── */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:5183';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'phoenix', 'visual-evidence', 'phase3-nine-screens');
mkdirSync(OUT, { recursive: true });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Selects the FIRST <select> whose OPTION TEXT (not the select's own label)
 * matches `optionPattern`. Both Inventory Center and Outlet Operations render
 * an org-scope <select> BEFORE the warehouse/outlet <select> — matching by
 * option content (not just position) avoids silently selecting the org picker.
 */
async function selectByOptionText(page, optionPattern) {
  const selects = page.locator('select');
  const count = await selects.count();
  for (let i = 0; i < count; i += 1) {
    const opts = await selects.nth(i).locator('option').allTextContents();
    const match = opts.find((o) => optionPattern.test(o));
    if (match) {
      await selects.nth(i).selectOption({ label: match });
      return true;
    }
  }
  return false;
}

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

const PHONE = { name: 'phone', width: 390, height: 844 };
const TABLET = { name: 'tablet', width: 768, height: 1024 };
const DESKTOP = { name: 'desktop', width: 1440, height: 900 };

const browser = await launch();
const inventory = [];
let shots = 0;
let failures = 0;

async function withPage(vp, lang, theme, fn) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  try {
    await fn(page);
  } finally {
    await page.close();
  }
  return consoleErrors;
}

async function shot(page, label, screen, vp, lang, theme) {
  const file = `${screen}-${label}-${lang}-${theme}-${vp.name}.png`;
  const p = join(OUT, file);
  await page.addStyleTag({ content: CAPTURE_CSS }).catch(() => {});
  await settle(500);

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));

  await page.screenshot({ path: p, animations: 'disabled', timeout: 20000 }).catch((e) => {
    failures += 1;
    console.error('SCREENSHOT FAILED', file, e.message);
    return null;
  });
  shots += 1;

  // Footer-in-flow check: scroll the REAL scroll owner to its true end FIRST —
  // a check at scroll=0 is a false negative for any page taller than one
  // viewport, since a position:fixed bottom nav's rect never moves with
  // scroll. Only after scrolling all the way down does "does the fixed nav
  // sit on top of the footer" mean anything. Captured as a second frame
  // (mobile only) so the overlap is visible, not just numeric.
  // Scroll the REAL scroll owner (#phoenix-main, per MOBILE-SCROLL-OWNER-HOTFIX-A)
  // directly to its max scrollTop — scrollIntoView's completion is not
  // synchronous with the following getBoundingClientRect read and produced
  // false-positive overlap readings in an earlier version of this script.
  await page.evaluate(() => {
    const scroller = document.getElementById('phoenix-main') || document.scrollingElement;
    scroller.scrollTop = scroller.scrollHeight;
  });
  await settle(200);
  const footerCheck = await page.evaluate(() => {
    const footer = document.querySelector('[data-masar-seal], .masar-copyright-seal, footer');
    if (!footer) return { present: false };
    const r = footer.getBoundingClientRect();
    const bottomNav = document.querySelector('.premium-bottom-nav, [data-bottom-nav]');
    const bn = bottomNav ? bottomNav.getBoundingClientRect() : null;
    const overlapsBottomNav = bn ? !(r.bottom <= bn.top || r.top >= bn.bottom) : false;
    return { present: true, top: r.top, bottom: r.bottom, overlapsBottomNav, bottomNavRect: bn };
  });
  if (vp.name === 'phone' && footerCheck.present) {
    const scrolledFile = `${screen}-${label}-scrolled-end-${lang}-${theme}-${vp.name}.png`;
    await page.screenshot({ path: join(OUT, scrolledFile), animations: 'disabled', timeout: 20000 }).catch(() => {});
    shots += 1;
  }

  const entry = { screen, label, lang, theme, viewport: vp.name, file, overflow, footerCheck };
  console.log('shot', file, JSON.stringify(overflow), JSON.stringify(footerCheck));
  return entry;
}

const LANGS = ['ar', 'en'];
const THEMES = ['dark', 'light'];

// ── 1/2/3/4/5/6/9 — full screens ────────────────────────────────────────────
const FULL_SCREENS = [
  { scene: 'status', viewports: [PHONE, TABLET, DESKTOP] },
  { scene: 'monthly', viewports: [PHONE, TABLET, DESKTOP] },
  { scene: 'reports', viewports: [PHONE, TABLET, DESKTOP] },
  { scene: 'institutions', viewports: [PHONE, DESKTOP] },
  { scene: 'inventory', viewports: [PHONE, DESKTOP] },
  { scene: 'outlet', viewports: [PHONE, DESKTOP] },
  { scene: 'procurement', viewports: [PHONE, DESKTOP] },
];

for (const { scene, viewports } of FULL_SCREENS) {
  for (const vp of viewports) {
    for (const lang of LANGS) {
      for (const theme of THEMES) {
        const errors = await withPage(vp, lang, theme, async (page) => {
          const url = `${BASE}/?qa=1&persona=super_admin&lang=${lang}&theme=${theme}&scene=${scene}&org=qa-org-a1`;
          await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForSelector('[data-qa-marker]', { timeout: 15000 }).catch(() => {});
          // Select a warehouse/outlet for the inventory/outlet scenes so the
          // tab body renders populated instead of the "select a warehouse"
          // empty state. Match by OPTION text, not select position — both
          // screens render an org-scope <select> before the real picker.
          if (scene === 'inventory') {
            await selectByOptionText(page, /Al-Hilla Institution Store|مذخر الحلة(?!.*فرعي)/).catch(() => {});
            await settle(500);
          } else if (scene === 'outlet') {
            await selectByOptionText(page, /Emergency Outlet|منفذ الطوارئ/).catch(() => {});
            await settle(500);
          }
          const entry = await shot(page, 'full', scene, vp, lang, theme);
          if (entry) inventory.push(entry);
        });
        if (errors.length) {
          failures += errors.length;
          console.error(`CONSOLE ERRORS scene=${scene} ${lang}/${theme}/${vp.name}:`, errors);
        }
      }
    }
  }
}

// ── 7 — Notifications bell, opened over the Dashboard scene ────────────────
for (const lang of LANGS) {
  for (const theme of THEMES) {
    const errors = await withPage(DESKTOP, lang, theme, async (page) => {
      const url = `${BASE}/?qa=1&persona=super_admin&lang=${lang}&theme=${theme}&scene=dashboard&org=qa-org-a1`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForSelector('[data-qa-marker]', { timeout: 15000 }).catch(() => {});
      const bell = page.locator('button[aria-label]').filter({ has: page.locator('svg') }).last();
      // Prefer the explicit bell aria-label if the i18n key resolves.
      const byLabel = page.getByRole('button', { name: /notif|إشعار/i });
      if (await byLabel.count()) {
        await byLabel.first().click().catch(() => {});
      } else {
        await bell.click().catch(() => {});
      }
      await settle(500);
      const entry = await shot(page, 'bell-open', 'notifications', DESKTOP, lang, theme);
      if (entry) inventory.push(entry);
    });
    if (errors.length) { failures += errors.length; console.error('CONSOLE ERRORS notifications', lang, theme, errors); }
  }
}

// ── 8 — Correction requests / FEFO / quarantine — Inventory Center tabs ────
for (const lang of LANGS) {
  for (const theme of THEMES) {
    for (const vp of [PHONE, DESKTOP]) {
      for (const tabLabelRe of [/حجر|quarantine/i, /تصحيح|correction/i]) {
        const errors = await withPage(vp, lang, theme, async (page) => {
          const url = `${BASE}/?qa=1&persona=super_admin&lang=${lang}&theme=${theme}&scene=inventory&org=qa-org-a1`;
          await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForSelector('[data-qa-marker]', { timeout: 15000 }).catch(() => {});
          await selectByOptionText(page, /Al-Hilla Institution Store|مذخر الحلة(?!.*فرعي)/).catch(() => {});
          await settle(500);
          const tab = page.getByRole('tab', { name: tabLabelRe });
          if (await tab.count()) {
            await tab.first().click().catch(() => {});
            await settle(400);
            const label = /حجر|quarantine/i.test(tabLabelRe.source) ? 'quarantine-tab' : 'corrections-tab';
            const entry = await shot(page, label, 'inventory-corrections-fefo-quarantine', vp, lang, theme);
            if (entry) inventory.push(entry);
          } else {
            console.warn(`WARN tab not found for pattern ${tabLabelRe} (${lang}/${theme}/${vp.name})`);
          }
        });
        if (errors.length) { failures += errors.length; console.error('CONSOLE ERRORS corrections/quarantine', lang, theme, vp.name, errors); }
      }
    }
  }
}

await browser.close();

writeFileSync(join(OUT, 'INVENTORY.json'), JSON.stringify({ capturedAt: new Date().toISOString(), base: BASE, shots: inventory }, null, 2));

console.log(`\nCaptured ${shots} screenshots, ${failures} failures/console-errors → ${OUT.replace(ROOT, '.')}`);
if (failures > 0) process.exit(1);
