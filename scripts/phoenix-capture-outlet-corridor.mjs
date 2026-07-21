/* ─── PHOENIX Outlet Corridor (Screen 18) visual evidence capture ─────────────
   Drives a CLEAN, isolated headless browser (playwright-core against the
   installed Chrome/Edge) over the dev-only visual QA harness and captures the
   Screen-18 outlet corridor across locale, direction, theme, viewport, scoped
   persona, tab and interaction state.

   CONNECTS DIRECTLY TO 127.0.0.1. Never through an editor/preview proxy: a
   proxy in this repo has served a STALE transform from a different checkout,
   which is exactly the failure this script is built to make impossible.

   Every context is disposable: no shared user profile, service workers blocked,
   HTTP cache disabled via CDP, and a fresh context per cell.

   THIS SCRIPT FAILS LOUDLY. Each check below aborts the run with a non-zero
   exit rather than emitting a screenshot that merely looks fine:

     · any uncaught page error                     (pageerror)
     · any console error                           (console[type=error])
     · a stale/fallback bundle (no QA marker, or the requested persona is not
       the one the harness actually rendered)
     · Screen 18 not reached through the REAL sidebar / mobile drawer
     · the mobile drawer still open after navigating
     · horizontal page overflow                    (scrollWidth > clientWidth)
     · a tab/nav touch target under 44x44
     · a legacy create-then-reopen availability form reachable from Screen 18
     · an outlet appearing outside the persona's migration-062 assignment

   Prerequisites — the harness is gated on DEV *and* an explicit opt-in flag.
   Start the server FROM THIS WORKTREE:

     VITE_ENABLE_VISUAL_QA=true npm run dev -- --host 127.0.0.1 --port 5191 \
       --strictPort --force

   Output → docs/phoenix/visual-evidence/outlet-corridor/.
   Usage: node scripts/phoenix-capture-outlet-corridor.mjs [baseURL]
   ─────────────────────────────────────────────────────────────────────────── */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:5191';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'phoenix', 'visual-evidence', 'outlet-corridor');
mkdirSync(OUT, { recursive: true });

const ORG_A = 'qa-org-a1';

/**
 * The exact migration-062 reachability contract the harness fixtures encode.
 * `reach` is the COMPLETE set of outlet names this persona may ever see; any
 * outlet outside it in the rendered screen is a scope leak and fails the run.
 */
const PERSONAS = {
  super_admin: { org: ORG_A, scoped: true, reach: ['QA · Emergency Outlet', 'QA · Pediatrics Outlet'] },
  warehouse_officer_assigned: { org: null, scoped: true, reach: ['QA · Emergency Outlet', 'QA · Pediatrics Outlet'] },
  outlet_officer_assigned: { org: null, scoped: true, reach: ['QA · Emergency Outlet'] },
  warehouse_officer: { org: null, scoped: false, reach: [] },
  outlet_officer: { org: null, scoped: false, reach: [] },
  central_warehouse_manager: { org: null, scoped: false, reach: [] },
};

/** Every outlet name in the fixture catalog — used to detect a scope leak. */
const ALL_OUTLETS = [
  'QA · Emergency Outlet',
  'QA · Pediatrics Outlet',
  'overflow probe',
];

const TABS = ['incoming', 'stock', 'returns', 'history', 'status'];
const TAB_LABEL = {
  incoming: { en: 'Incoming Supplies', ar: 'التوريدات الواردة' },
  stock: { en: 'Stock & Batches', ar: 'المخزون والدفعات' },
  returns: { en: 'Returns', ar: 'المرتجعات' },
  history: { en: 'Movement History', ar: 'سجل الحركة' },
  status: { en: 'Movement status', ar: 'حالة الحركة' },
};
const SCREEN_TITLE = { en: 'Outlet Operations', ar: 'عمليات المنفذ' };
const NAV_LABEL = SCREEN_TITLE;
const EMPTY_SCOPE = { en: 'No outlets in your scope', ar: 'لا توجد منافذ ضمن نطاقك' };

/**
 * `mobile` emulates touch/mobile UA. `drawer` is a SEPARATE question: the shell
 * swaps the sidebar for the drawer at `window.innerWidth < 768`
 * (PhoenixAppShell), so a 768px tablet is a touch device that still navigates
 * through the desktop sidebar. Conflating the two looks for a drawer that the
 * shell is correct not to render.
 */
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false, drawer: false },
  { name: 'tablet', width: 768, height: 1024, mobile: true, drawer: false },
  { name: 'mobile', width: 390, height: 844, mobile: true, drawer: true },
];

/** Markers of the retired create-then-reopen availability form (E6 subject). */
const LEGACY_FORM_MARKERS = [
  'upsertAvailability',
  'data-testid="availability-editor"',
  'data-testid="manual-stock-form"',
];

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const inventory = [];
let shots = 0;

function fail(context, message) {
  failures.push(`${context}: ${message}`);
  console.error(`  FAIL ${context}: ${message}`);
}

// ── browser ──────────────────────────────────────────────────────────────────

/** A clean, isolated browser process — no profile, no extension, no reuse. */
async function launch() {
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ headless: true, channel, args });
    } catch { /* try the next installed channel */ }
  }
  return await chromium.launch({ headless: true, args });
}

const CAPTURE_CSS =
  '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;' +
  'animation:none!important;transition:none!important;}';

function url({ persona, lang, theme, scene = 'shell' }) {
  const org = PERSONAS[persona]?.org;
  return `${BASE}/?qa=1&persona=${persona}${org ? `&org=${org}` : ''}` +
    `&lang=${lang}&theme=${theme}&scene=${scene}`;
}

/**
 * Open a disposable context+page wired to the failure collectors, with the HTTP
 * cache disabled and service workers blocked so a cell can never be served a
 * previously-cached bundle.
 */
async function open(browser, { persona, lang, theme, vp, scene, label }) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();

  const cdp = await context.newCDPSession(page).catch(() => null);
  if (cdp) await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});

  page.on('pageerror', (error) => fail(label, `page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/favicon|Download the React DevTools/i.test(text)) return;
    fail(label, `console error: ${text}`);
  });

  await page.goto(url({ persona, lang, theme, scene }), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('[data-qa-marker="PHOENIX_VISUAL_QA_HARNESS_ONLY"]', { timeout: 20000 });

  // Freshness: the harness banner must report the persona/lang/theme we asked
  // for. A stale or fallback bundle cannot satisfy this for a NEW persona id.
  const banner = await page.locator('[role="note"]').first().innerText().catch(() => '');
  if (!banner.includes(persona)) {
    fail(label, `stale/fallback bundle: banner "${banner.trim()}" does not report persona ${persona}`);
  }

  const state = await page.evaluate(() => ({
    lang: document.documentElement.getAttribute('lang'),
    theme: document.documentElement.getAttribute('data-theme'),
    dir: document.documentElement.getAttribute('dir'),
  }));
  if (state.lang !== lang || state.theme !== theme) {
    fail(label, `entered lang=${state.lang} theme=${state.theme}, wanted ${lang}/${theme}`);
  }
  const wantDir = lang === 'ar' ? 'rtl' : 'ltr';
  if (state.dir !== wantDir) fail(label, `dir=${state.dir}, wanted ${wantDir}`);

  await page.addStyleTag({ content: CAPTURE_CSS }).catch(() => {});
  return { context, page };
}

// ── assertions ───────────────────────────────────────────────────────────────

async function assertNoOverflow(page, label) {
  const over = await page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth - d.clientWidth;
  });
  if (over > 1) fail(label, `horizontal overflow: scrollWidth exceeds clientWidth by ${over}px`);
}

/** Every interactive control on the corridor must meet the 44x44 touch floor. */
async function assertTouchTargets(page, label) {
  const small = await page.evaluate(() => {
    const out = [];
    const sel = '[role="tab"], nav button.premium-nav-item, .premium-drawer-nav button';
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // not rendered
      if (r.height < 44 || r.width < 44) {
        out.push(`${(el.textContent || '').trim().slice(0, 24)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out;
  });
  for (const s of small) fail(label, `touch target under 44x44: ${s}`);
}

/**
 * The topbar must name the screen the operator is actually on. Screen 18 had no
 * SCREEN_TITLE_KEYS entry and silently fell back to "Status Center", so this is
 * asserted rather than merely eyeballed.
 */
async function assertTopbarTitle(page, label, lang) {
  const heading = await page.locator('.nexus-topbar-heading').first().innerText().catch(() => '');
  if (!heading.includes(SCREEN_TITLE[lang])) {
    fail(label, `topbar reads "${heading.trim()}", expected the Screen 18 title "${SCREEN_TITLE[lang]}"`);
  }
}

/** No retired create-then-reopen availability writer may be reachable here. */
async function assertNoLegacyForm(page, label) {
  const html = await page.content();
  for (const marker of LEGACY_FORM_MARKERS) {
    if (html.includes(marker)) fail(label, `legacy availability form marker present: ${marker}`);
  }
}

/** The screen must never name an outlet outside this persona's assignment. */
async function assertScope(page, label, persona) {
  const { reach } = PERSONAS[persona];
  const text = await page.locator('main').innerText().catch(() => '');
  for (const name of ALL_OUTLETS) {
    const present = text.includes(name);
    const allowed = reach.some((r) => name.includes(r) || r.includes(name));
    if (present && !allowed) fail(label, `scope leak: "${name}" visible outside assignment`);
  }
}

async function shoot(page, name) {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  shots += 1;
  inventory.push(name);
  return file;
}

// ── navigation ───────────────────────────────────────────────────────────────

/**
 * Reach Screen 18 the way an operator does: the desktop sidebar, or the mobile
 * drawer opened from the topbar. A direct `scene=outlet` URL is used ONLY for
 * state variants, never as the reachability proof.
 */
async function navigateToScreen18(page, { lang, vp, label }) {
  const navLabel = NAV_LABEL[lang];

  if (vp.drawer) {
    const trigger = page.locator('.premium-drawer-trigger').first();
    if (await trigger.count() === 0) {
      fail(label, 'mobile drawer trigger not found in topbar');
      return false;
    }
    await trigger.click();
    await settle(400);
    const item = page.locator('.premium-drawer-nav button', { hasText: navLabel }).first();
    if (await item.count() === 0) {
      fail(label, `drawer nav item "${navLabel}" not found`);
      return false;
    }
    await item.click();
    await settle(900);
    // The drawer must close itself after navigating.
    if (await page.locator('.premium-drawer-nav').isVisible().catch(() => false)) {
      fail(label, 'mobile drawer still open after navigating');
    }
  } else {
    const item = page.locator('nav button.premium-nav-item', { hasText: navLabel }).first();
    if (await item.count() === 0) {
      fail(label, `sidebar nav item "${navLabel}" not found`);
      return false;
    }
    await item.click();
    await settle(900);
    const current = await item.getAttribute('aria-current');
    if (current !== 'page') fail(label, `sidebar item not marked current after navigation (aria-current=${current})`);
  }

  await settle(1200);
  const title = await page.locator('h2').first().innerText().catch(() => '');
  if (!title.includes(SCREEN_TITLE[lang])) {
    fail(label, `Screen 18 title not shown after navigation (saw "${title}")`);
    return false;
  }
  return true;
}

/** Select a tab through its real control and confirm it became selected. */
async function openTab(page, tab, lang, label) {
  const btn = page.locator('[role="tab"]', { hasText: TAB_LABEL[tab][lang] }).first();
  if (await btn.count() === 0) { fail(label, `tab "${tab}" not present`); return false; }
  await btn.click();
  await settle(900);
  const selected = await btn.getAttribute('aria-selected');
  if (selected !== 'true') { fail(label, `tab "${tab}" not selected after click`); return false; }
  return true;
}

// ── cells ────────────────────────────────────────────────────────────────────

/** A: reachability + locale/direction/theme/viewport grid, via REAL nav. */
async function captureGrid(browser) {
  for (const lang of ['en', 'ar']) {
    for (const theme of ['dark', 'light']) {
      for (const vp of VIEWPORTS) {
        const persona = 'warehouse_officer_assigned';
        const label = `grid ${lang}-${theme}-${vp.name}`;
        const { context, page } = await open(browser, { persona, lang, theme, vp, scene: 'shell', label });
        console.log(`· ${label}`);
        if (await navigateToScreen18(page, { lang, vp, label })) {
          await assertTopbarTitle(page, label, lang);
          await assertNoOverflow(page, label);
          await assertTouchTargets(page, label);
          await assertNoLegacyForm(page, label);
          await assertScope(page, label, persona);
          await shoot(page, `outlet-${lang}-${theme}-${vp.name}`);
        }
        await context.close();
      }
    }
  }
}

/** B: every tab, in both directions, on desktop and mobile. */
async function captureTabs(browser) {
  const cells = [
    { lang: 'en', theme: 'dark', vp: VIEWPORTS[0] },
    { lang: 'ar', theme: 'light', vp: VIEWPORTS[2] },
  ];
  for (const cell of cells) {
    for (const tab of TABS) {
      const persona = 'warehouse_officer_assigned';
      const label = `tab ${tab} ${cell.lang}-${cell.theme}-${cell.vp.name}`;
      const { context, page } = await open(browser, {
        persona, lang: cell.lang, theme: cell.theme, vp: cell.vp, scene: 'outlet', label,
      });
      console.log(`· ${label}`);
      if (await openTab(page, tab, cell.lang, label)) {
        await assertTopbarTitle(page, label, cell.lang);
        await assertNoOverflow(page, label);
        await assertTouchTargets(page, label);
        await assertNoLegacyForm(page, label);
        await assertScope(page, label, persona);
        await shoot(page, `outlet-tab-${tab}-${cell.lang}-${cell.theme}-${cell.vp.name}`);
      }
      await context.close();
    }
  }
}

/** C: scoped-permission personas — assigned, unassigned twin, and control. */
async function capturePersonas(browser) {
  for (const persona of Object.keys(PERSONAS)) {
    const spec = PERSONAS[persona];
    const label = `persona ${persona}`;
    const { context, page } = await open(browser, {
      persona, lang: 'en', theme: 'dark', vp: VIEWPORTS[0], scene: 'outlet', label,
    });
    console.log(`· ${label}`);
    await settle(1200);

    const tabCount = await page.locator('[role="tab"]').count();
    const emptyShown = await page.getByText(EMPTY_SCOPE.en).count();

    if (spec.scoped) {
      if (tabCount !== TABS.length) fail(label, `expected ${TABS.length} tabs for a scoped persona, saw ${tabCount}`);
      if (emptyShown > 0) fail(label, 'scoped persona rendered the empty-scope state');
    } else {
      // The denied/empty control: the SAME role without an assignment row.
      if (tabCount !== 0) fail(label, `unassigned persona reached ${tabCount} tabs — assignment gate leaked`);
      if (emptyShown === 0) fail(label, 'unassigned persona did not render the empty-scope state');
    }

    await assertNoOverflow(page, label);
    await assertNoLegacyForm(page, label);
    await assertScope(page, label, persona);
    await shoot(page, `outlet-persona-${persona}`);
    await context.close();
  }
}

/** D: Current Movement Status — empty, invalid, not-available and offline. */
async function captureMovementStatus(browser) {
  const persona = 'warehouse_officer_assigned';
  const vp = VIEWPORTS[0];

  for (const lang of ['en', 'ar']) {
    const label = `movement-status ${lang}`;
    const { context, page } = await open(browser, {
      persona, lang, theme: 'dark', vp, scene: 'outlet', label,
    });
    console.log(`· ${label}`);
    if (!await openTab(page, 'status', lang, label)) { await context.close(); continue; }

    // Idle: lookup disabled until an identifier is entered.
    const lookup = page.locator('[data-testid="movement-status-lookup"]');
    if (!await lookup.isDisabled()) fail(label, 'lookup enabled with an empty identifier');
    await shoot(page, `outlet-status-idle-${lang}`);

    // Not-available / invalid-input path through the REAL control.
    await page.locator('[data-testid="movement-status-input"]').fill('not-a-canonical-uuid');
    await lookup.click();
    await settle(1500);
    const shown = await page.locator(
      '[data-testid="movement-status-not-available"], [data-testid="movement-status-error"]',
    ).count();
    if (shown === 0) fail(label, 'no not-available/error state after an invalid lookup');
    await assertNoOverflow(page, label);
    await shoot(page, `outlet-status-not-available-${lang}`);
    await context.close();
  }

  // Offline banner, driven by the real navigator.onLine signal.
  const label = 'movement-status offline';
  const { context, page } = await open(browser, {
    persona, lang: 'en', theme: 'dark', vp, scene: 'outlet', label,
  });
  console.log(`· ${label}`);
  // CurrentMovementStatus reads navigator.onLine during render and does not
  // subscribe to online/offline events, so the offline state must be in place
  // BEFORE the tab mounts. Going offline first and opening the tab afterwards
  // is the real sequence an operator hits (connectivity drops, then they look).
  await context.setOffline(true);
  if (await openTab(page, 'status', 'en', label)) {
    if (await page.locator('[data-testid="movement-status-offline"]').count() === 0) {
      fail(label, 'offline banner not shown while offline');
    }
    await assertNoOverflow(page, label);
    await shoot(page, 'outlet-status-offline-en');
  }
  await context.setOffline(false);
  await context.close();
}

/** E: Returns tab — composer surface and canonical receipt actions. */
async function captureReturns(browser) {
  const persona = 'warehouse_officer_assigned';
  for (const lang of ['en', 'ar']) {
    const label = `returns ${lang}`;
    const { context, page } = await open(browser, {
      persona, lang, theme: 'dark', vp: VIEWPORTS[0], scene: 'outlet', label,
    });
    console.log(`· ${label}`);
    if (!await openTab(page, 'returns', lang, label)) { await context.close(); continue; }
    await assertNoOverflow(page, label);
    await assertNoLegacyForm(page, label);
    await shoot(page, `outlet-returns-${lang}`);

    // Canonical receipt actions, when this outlet has a return to act on.
    const actions = page.locator('[data-testid="outlet-return-receipt-actions"]');
    if (await actions.count() > 0) {
      await shoot(page, `outlet-returns-receipt-actions-${lang}`);
      const printBtn = page.locator('[data-testid="mv-print"]').first();
      if (await printBtn.count() > 0) {
        await printBtn.click();
        await settle(800);
        await assertNoOverflow(page, label);
        await shoot(page, `outlet-returns-optional-field-selector-${lang}`);
      }
      const qr = page.locator('[data-testid="mv-qr"]').first();
      if (await qr.count() > 0) {
        await page.keyboard.press('Escape').catch(() => {});
        await settle(400);
        await qr.click();
        await settle(900);
        await shoot(page, `outlet-returns-qr-${lang}`);
      }
    } else {
      console.log(`  (no return receipt on this fixture outlet for ${lang})`);
    }
    await context.close();
  }
}

/** F: Incoming Supplies — the receive surface and its safe bulk action. */
async function captureIncoming(browser) {
  const persona = 'warehouse_officer_assigned';
  for (const lang of ['en', 'ar']) {
    const label = `incoming ${lang}`;
    const { context, page } = await open(browser, {
      persona, lang, theme: 'dark', vp: VIEWPORTS[0], scene: 'outlet', label,
    });
    console.log(`· ${label}`);
    if (!await openTab(page, 'incoming', lang, label)) { await context.close(); continue; }
    await assertNoOverflow(page, label);
    await assertNoLegacyForm(page, label);
    await shoot(page, `outlet-incoming-${lang}`);

    const bulk = page.locator('[data-testid="outlet-accept-all-safe"]');
    if (await bulk.count() > 0) await shoot(page, `outlet-incoming-safe-bulk-${lang}`);
    await context.close();
  }
}

// ── run ──────────────────────────────────────────────────────────────────────

const browser = await launch();
console.log(`\nPHOENIX outlet-corridor capture → ${BASE}\n`);

try {
  await captureGrid(browser);
  await captureTabs(browser);
  await capturePersonas(browser);
  await captureMovementStatus(browser);
  await captureReturns(browser);
  await captureIncoming(browser);
} finally {
  await browser.close();
}

writeFileSync(
  join(OUT, 'INVENTORY.json'),
  `${JSON.stringify({ base: BASE, capturedAt: new Date().toISOString(), shots: inventory.sort() }, null, 2)}\n`,
);

console.log(`\n${shots} screenshots → ${OUT}`);
if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log('All checks passed.\n');
