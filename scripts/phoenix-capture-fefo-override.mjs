/* ─── FEFO-OVERRIDE-DIALOG-CAPTURE — closing the last Phase-3 screen gap ──────
   Drives the DEV-only visual-QA harness (?qa=1) to actually OPEN
   FefoOverrideDialog through real UI interaction (warehouse select → Dispatch
   tab → New request → outlet → Material selection → pick the NON-earliest
   Amoxicillin batch) and captures BOTH permission personas:

     - warehouse_officer_assigned : NO inventory.fefo_override → denied state
     - super_admin                : WITH inventory.fefo_override (bypass) →
                                     reason-required state

   Output → docs/phoenix/visual-evidence/phase3-nine-screens/ (additive to the
   existing Phase-3 nine-screen evidence set — same folder, same naming
   convention: <screen>-<label>-<lang>-<theme>-<viewport>.png).

   Usage: node scripts/phoenix-capture-fefo-override.mjs [baseURL]
   ─────────────────────────────────────────────────────────────────────────── */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:5183';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'phoenix', 'visual-evidence', 'phase3-nine-screens');
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

const PHONE = { name: 'phone', width: 390, height: 844 };
const DESKTOP = { name: 'desktop', width: 1440, height: 900 };
const SCREEN = 'inventory-dispatch-fefo-override';

const browser = await launch();
const inventory = [];
let shots = 0;
let failures = 0;
const assertions = [];

function assert(name, cond, detail) {
  assertions.push({ name, pass: Boolean(cond), detail: detail ?? null });
  if (!cond) { failures += 1; console.error('ASSERT FAILED:', name, detail ?? ''); }
}

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

async function shot(page, label, vp, lang, theme) {
  const file = `${SCREEN}-${label}-${lang}-${theme}-${vp.name}.png`;
  const p = join(OUT, file);
  await page.addStyleTag({ content: CAPTURE_CSS }).catch(() => {});
  await settle(300);
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

  // Same footer/bottom-nav overlap check as the 9-screen pass — the DIALOG is
  // a fixed overlay, so this proves it neither clips nor sits under the mobile
  // bottom nav even at the true scrolled-to-end state.
  await page.evaluate(() => {
    const scroller = document.getElementById('phoenix-main') || document.scrollingElement;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });
  await settle(150);
  const footerCheck = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"] .premium-dialog-panel');
    if (!dlg) return { present: false };
    const r = dlg.getBoundingClientRect();
    const bottomNav = document.querySelector('.premium-bottom-nav, [data-bottom-nav]');
    const bn = bottomNav ? bottomNav.getBoundingClientRect() : null;
    const overlapsBottomNav = bn ? !(r.bottom <= bn.top || r.top >= bn.bottom) : false;
    const withinViewport = r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
    return { present: true, top: r.top, bottom: r.bottom, overlapsBottomNav, withinViewport, bottomNavRect: bn };
  });

  const entry = { screen: SCREEN, label, lang, theme, viewport: vp.name, file, overflow, footerCheck };
  console.log('shot', file, JSON.stringify(overflow), JSON.stringify(footerCheck));
  return entry;
}

/** Drives the harness to the material-selection step of a fresh outlet-dispatch
 *  composer for the given persona, then picks the NEWER (non-earliest)
 *  Amoxicillin batch (B4471X) so FefoOverrideDialog genuinely opens. */
async function openFefoDialog(page, persona, lang, theme) {
  const url = `${BASE}/?qa=1&persona=${persona}&lang=${lang}&theme=${theme}&scene=inventory&org=qa-org-a1`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('[data-qa-marker]', { timeout: 15000 }).catch(() => {});

  await page.evaluate(() => {
    const sel = Array.from(document.querySelectorAll('select'))
      .find((s) => Array.from(s.options).some((o) => /Al-Hilla Institution Store|مذخر الحلة(?!.*فرعي)/.test(o.textContent)));
    if (sel) { sel.value = 'qa-wh-inst-a'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await settle(300);

  await page.evaluate(() => {
    const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((t) => /Dispatch to outlets|تجهيز المنافذ/.test(t.textContent));
    tab?.click();
  });
  await settle(300);

  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /New request|طلب جديد/.test(x.textContent));
    b?.click();
  });
  await settle(300);

  await page.evaluate(() => {
    const sel = Array.from(document.querySelectorAll('select'))
      .find((s) => Array.from(s.options).some((o) => /Emergency Outlet|منفذ الطوارئ/.test(o.textContent)));
    if (sel) { sel.value = 'qa-outlet-1'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    const b = Array.from(document.querySelectorAll('button')).find((x) => /^(Material selection|اختيار المواد)$/.test(x.textContent.trim()));
    b?.click();
  });
  await settle(400);

  // Fill the FIRST "Add" row's quantity (the B4471X / 2028-01-31 batch — the
  // later-expiry, non-compliant pick) using a native-setter dispatch so
  // React's controlled-input state actually updates.
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) => /^(Add|إضافة)$/.test(b.textContent.trim()));
    const input = buttons[0]?.parentElement?.querySelector('input');
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '5');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(150);
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) => /^(Add|إضافة)$/.test(b.textContent.trim()));
    buttons[0]?.click();
  });
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 }).catch(() => {});
  await settle(300);
}

const LANGS = ['ar', 'en'];
const THEMES = ['dark', 'light'];
const VIEWPORTS = [PHONE, DESKTOP];

for (const vp of VIEWPORTS) {
  for (const lang of LANGS) {
    for (const theme of THEMES) {
      // ── NO-PERMISSION persona (denied) ──────────────────────────────────
      let errors = await withPage(vp, lang, theme, async (page) => {
        await openFefoDialog(page, 'warehouse_officer_assigned', lang, theme);
        const dom = await page.evaluate(() => {
          const dlg = document.querySelector('[role="dialog"]');
          if (!dlg) return null;
          const alts = Array.from(dlg.querySelectorAll('[data-testid="fefo-alternatives"] > div'))
            .map((d) => d.textContent.trim());
          return {
            hasCheckbox: !!dlg.querySelector('input[type="checkbox"]'),
            hasReasonInput: !!dlg.querySelector('#fefo-reason'),
            deniedMessageShown: dlg.textContent.includes('do not have permission') || dlg.textContent.includes('لا تملك'),
            alternativesOrder: alts,
          };
        });
        assert(`denied/${lang}/${theme}/${vp.name}: dialog opened`, dom !== null);
        if (dom) {
          assert(`denied/${lang}/${theme}/${vp.name}: no checkbox rendered`, dom.hasCheckbox === false, dom);
          assert(`denied/${lang}/${theme}/${vp.name}: no reason input rendered`, dom.hasReasonInput === false, dom);
          assert(`denied/${lang}/${theme}/${vp.name}: denial message shown`, dom.deniedMessageShown === true, dom);
          assert(`denied/${lang}/${theme}/${vp.name}: earliest batch listed first`,
            dom.alternativesOrder[0]?.includes('B4470E'), dom.alternativesOrder);
        }
        const entry = await shot(page, 'denied', vp, lang, theme);
        if (entry) inventory.push(entry);
      });
      if (errors.length) { failures += errors.length; console.error('CONSOLE ERRORS denied', lang, theme, vp.name, errors); }

      // ── WITH-PERMISSION persona (super_admin, bypass) — reason-required ─
      errors = await withPage(vp, lang, theme, async (page) => {
        await openFefoDialog(page, 'super_admin', lang, theme);
        // Check the override checkbox WITHOUT typing a reason, to capture the
        // mandatory-reason-validation state.
        await page.evaluate(() => {
          const dlg = document.querySelector('[role="dialog"]');
          const cb = dlg?.querySelector('input[type="checkbox"]');
          cb?.click();
        });
        await settle(200);
        const dom = await page.evaluate(() => {
          const dlg = document.querySelector('[role="dialog"]');
          if (!dlg) return null;
          const alts = Array.from(dlg.querySelectorAll('[data-testid="fefo-alternatives"] > div'))
            .map((d) => d.textContent.trim());
          const confirmBtn = Array.from(dlg.querySelectorAll('button'))
            .find((b) => /Confirm override and add|تأكيد التجاوز/.test(b.textContent));
          return {
            hasCheckbox: !!dlg.querySelector('input[type="checkbox"]'),
            checkboxChecked: dlg.querySelector('input[type="checkbox"]')?.checked,
            hasReasonInput: !!dlg.querySelector('#fefo-reason'),
            confirmDisabled: confirmBtn?.disabled,
            alternativesOrder: alts,
          };
        });
        assert(`allowed/${lang}/${theme}/${vp.name}: dialog opened`, dom !== null);
        if (dom) {
          assert(`allowed/${lang}/${theme}/${vp.name}: checkbox rendered and checked`, dom.hasCheckbox && dom.checkboxChecked, dom);
          assert(`allowed/${lang}/${theme}/${vp.name}: reason input rendered`, dom.hasReasonInput === true, dom);
          assert(`allowed/${lang}/${theme}/${vp.name}: confirm disabled with empty reason`, dom.confirmDisabled === true, dom);
          assert(`allowed/${lang}/${theme}/${vp.name}: earliest batch listed first`,
            dom.alternativesOrder[0]?.includes('B4470E'), dom.alternativesOrder);
        }
        const entry = await shot(page, 'reason-required', vp, lang, theme);
        if (entry) inventory.push(entry);
      });
      if (errors.length) { failures += errors.length; console.error('CONSOLE ERRORS allowed', lang, theme, vp.name, errors); }
    }
  }
}

await browser.close();

// Merge into the EXISTING INVENTORY.json (additive) rather than overwriting
// the prior pass's evidence log.
const inventoryPath = join(OUT, 'INVENTORY.json');
const prior = existsSync(inventoryPath) ? JSON.parse(readFileSync(inventoryPath, 'utf8')) : { shots: [] };
const merged = {
  capturedAt: prior.capturedAt ?? new Date().toISOString(),
  base: prior.base ?? BASE,
  shots: [...prior.shots, ...inventory],
  fefoOverrideCapture: { capturedAt: new Date().toISOString(), base: BASE, assertions },
};
writeFileSync(inventoryPath, JSON.stringify(merged, null, 2));

console.log(`\nCaptured ${shots} screenshots, ${assertions.length} assertions (${assertions.filter(a=>!a.pass).length} failed), ${failures} failures/console-errors → ${OUT.replace(ROOT, '.')}`);
if (failures > 0) process.exit(1);
