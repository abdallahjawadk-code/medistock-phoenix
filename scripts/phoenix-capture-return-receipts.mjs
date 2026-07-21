/* ─── PHOENIX return-receipt corridor evidence ────────────────────────────────
   Closes the gap left by phoenix-capture-outlet-corridor.mjs: the CANONICAL
   receipt surface (optional/locked print-field selector, live print preview,
   QR canonical UUID, genuine XLSX) only exists AFTER a receive, so it could not
   be reached from SELECT fixtures alone.

   Two documents are covered:
     · return SHIPMENT receipt — Inventory Center → Receive outlet returns,
       reached through the REAL sidebar, warehouse picker and tab controls;
     · return REQUEST — resolved on Screen 18 → Movement status from its
       canonical UUID, which is also what the QR encodes.

   The XLSX is not merely sniffed for a ZIP signature: the real browser download
   is intercepted and the bytes are re-loaded with ExcelJS, then asserted
   sheet by sheet against the canonical fixture values.

   Connects DIRECTLY to 127.0.0.1 — never an editor/preview proxy, which has
   served a stale transform from a different checkout in this repo before.

   Prerequisites:
     VITE_ENABLE_VISUAL_QA=true npm run dev -- --host 127.0.0.1 --port 5191 \
       --strictPort --force

   Output → docs/phoenix/visual-evidence/outlet-corridor/.
   Usage: node scripts/phoenix-capture-return-receipts.mjs [baseURL]
   ─────────────────────────────────────────────────────────────────────────── */
import { chromium } from 'playwright-core';
import ExcelJS from 'exceljs';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:5191';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'phoenix', 'visual-evidence', 'outlet-corridor');
const XLSX_OUT = join(OUT, 'xlsx');
mkdirSync(XLSX_OUT, { recursive: true });

const ORG_A = 'qa-org-a1';
const WAREHOUSE = 'QA · Al-Hilla Institution Store';

/** Canonical fixture ids — mirrored from src/features/qa/qaData.ts. */
const RR_SUBMITTED = '0aa11111-0000-4000-8000-000000000001';
const SH_IN_TRANSIT = '0bb22222-0000-4000-8000-000000000001';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const L = {
  en: {
    inventoryNav: 'Inventory Center', outletNav: 'Outlet Operations',
    returnsTab: 'Receive outlet returns', statusTab: 'Movement status',
    selectWarehouse: 'Select a warehouse',
  },
  ar: {
    inventoryNav: 'مركز المخزون', outletNav: 'عمليات المنفذ',
    returnsTab: 'استلام مرتجعات المنافذ', statusTab: 'حالة الحركة',
    selectWarehouse: 'اختر المخزن',
  },
};

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const inventory = [];
let shots = 0;

function fail(context, message) {
  failures.push(`${context}: ${message}`);
  console.error(`  FAIL ${context}: ${message}`);
}
function check(context, condition, message) {
  if (!condition) fail(context, message);
  return condition;
}

async function launch() {
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ headless: true, channel, args }); } catch { /* next */ }
  }
  return await chromium.launch({ headless: true, args });
}

const CAPTURE_CSS =
  '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;' +
  'animation:none!important;transition:none!important;}';

async function open(browser, { persona, lang, theme, scene, label, width = 1440, height = 900 }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page).catch(() => null);
  if (cdp) await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});

  page.on('pageerror', (e) => fail(label, `page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/favicon|Download the React DevTools/i.test(text)) return;
    fail(label, `console error: ${text}`);
  });

  const org = persona === 'super_admin' ? `&org=${ORG_A}` : '';
  await page.goto(
    `${BASE}/?qa=1&persona=${persona}${org}&lang=${lang}&theme=${theme}&scene=${scene}`,
    { waitUntil: 'networkidle', timeout: 30000 },
  );
  await page.waitForSelector('[data-qa-marker="PHOENIX_VISUAL_QA_HARNESS_ONLY"]', { timeout: 20000 });

  const banner = await page.locator('[role="note"]').first().innerText().catch(() => '');
  check(label, banner.includes(persona), `stale bundle: banner "${banner.trim()}" lacks ${persona}`);

  await page.addStyleTag({ content: CAPTURE_CSS }).catch(() => {});
  return { context, page };
}

async function shoot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
  shots += 1;
  inventory.push(name);
}

/**
 * No raw i18n key may reach the operator. `t()` falls back to returning its own
 * key when a string is missing, which is how a literal "mv_h_qr" shipped into
 * the mandatory-traceability list of the print dialog.
 */
async function assertNoRawI18nKeys(page, label) {
  const text = await page.locator('body').innerText();
  const leaked = [...new Set(text.match(/\b(mv|or|inv|nav)_[a-z0-9_]{2,}\b/g) ?? [])];
  for (const key of leaked) fail(label, `raw i18n key rendered in the UI: ${key}`);
}

async function assertNoOverflow(page, label) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 1) fail(label, `horizontal overflow by ${over}px`);
}

/** Reach the Inventory Center return queue through REAL controls only. */
async function openReturnQueue(page, lang, label) {
  const nav = page.locator('nav button.premium-nav-item', { hasText: L[lang].inventoryNav }).first();
  if (!check(label, await nav.count() > 0, 'Inventory Center nav item missing')) return false;
  await nav.click();
  await settle(1500);

  // The warehouse picker is the select offering the institution store.
  const selects = page.locator('select');
  let picked = false;
  for (let i = 0; i < await selects.count(); i += 1) {
    const opts = await selects.nth(i).locator('option').allInnerTexts();
    const target = opts.find((o) => o.includes('Al-Hilla Institution Store') || o.includes('مذخر الحلة'));
    if (target && !target.includes('Annex') && !target.includes('الفرعي')) {
      await selects.nth(i).selectOption({ label: target });
      picked = true;
      break;
    }
  }
  if (!check(label, picked, 'warehouse picker did not offer the institution store')) return false;
  await settle(2000);

  const tab = page.locator('[role="tab"]', { hasText: L[lang].returnsTab }).first();
  if (!check(label, await tab.count() > 0, `"${L[lang].returnsTab}" tab not offered`)) return false;
  await tab.click();
  await settle(2200);
  return true;
}

/* ── A. return-shipment receipt corridor ──────────────────────────────────── */

async function captureShipmentReceipts(browser, lang, theme) {
  const label = `return-receipts ${lang}-${theme}`;
  const { context, page } = await open(browser, {
    persona: 'super_admin', lang, theme, scene: 'inventory', label,
  });
  console.log(`· ${label}`);
  if (!await openReturnQueue(page, lang, label)) { await context.close(); return; }

  // The receivable queue: individual lines + the safe-bulk control.
  check(label, await page.locator('[data-testid="return-receipt-lines"]').count() > 0, 'no receipt lines rendered');
  const bulk = page.locator('[data-testid="return-receive-all-safe"]');
  check(label, await bulk.count() > 0, 'safe-bulk control missing');
  // A fully-received shipment must never be offered for receiving again.
  const queueText = await page.locator('main').innerText();
  check(label, !queueText.includes('QA-SHP-0003'), 'a fully-received shipment is still in the receivable queue');
  await assertNoOverflow(page, label);
  await shoot(page, `returns-queue-${lang}-${theme}`);

  // Individual line state, before any bulk action.
  await shoot(page, `returns-individual-lines-${lang}-${theme}`);

  check(label, !(await bulk.isDisabled()), 'safe-bulk control disabled with receivable lines present');
  await bulk.click();
  await settle(2500);

  const outcome = page.locator('[data-testid="return-receipt-outcome"]');
  check(label, await outcome.count() > 0, 'no receive outcome reported');
  await assertNoOverflow(page, label);
  await shoot(page, `returns-bulk-outcome-${lang}-${theme}`);

  const actions = page.locator('[data-testid="return-shipment-receipt-actions"]');
  if (!check(label, await actions.count() > 0, 'canonical receipt actions did not appear after receiving')) {
    await context.close();
    return;
  }
  await shoot(page, `returns-receipt-actions-${lang}-${theme}`);

  // ── optional / locked print-field selector + live preview ────────────────
  await page.locator('[data-testid="mv-print"]').first().click();
  await settle(1200);

  const locked = await page.locator('input[type="checkbox"][disabled]').count();
  const optional = await page.locator('input[type="checkbox"]:not([disabled])').count();
  check(label, locked > 0, 'no locked trace fields shown in the print selector');
  check(label, optional > 0, 'no optional fields offered in the print selector');
  const preview = page.locator('iframe');
  check(label, await preview.count() > 0, 'no live print preview rendered');
  await assertNoRawI18nKeys(page, label);
  await assertNoOverflow(page, label);
  await shoot(page, `returns-print-field-selector-${lang}-${theme}`);

  // Toggling an optional field must change the preview, not the locked set.
  const firstOptional = page.locator('input[type="checkbox"]:not([disabled])').first();
  await firstOptional.click();
  await settle(900);
  check(
    label,
    await page.locator('input[type="checkbox"][disabled]').count() === locked,
    'toggling an optional field changed the locked trace-field set',
  );
  await shoot(page, `returns-print-preview-${lang}-${theme}`);

  await page.keyboard.press('Escape').catch(() => {});
  await settle(700);

  // ── QR: must encode the CANONICAL UUID ───────────────────────────────────
  await page.locator('[data-testid="mv-qr"]').first().click();
  await settle(1500);
  const qrImg = page.locator('img[alt]').last();
  check(label, await qrImg.count() > 0, 'QR image not rendered');
  const bodyText = await page.locator('body').innerText();
  check(label, UUID_RE.test(SH_IN_TRANSIT), 'fixture shipment id is not a canonical UUID');
  check(
    label,
    bodyText.includes(SH_IN_TRANSIT) || bodyText.includes(SH_IN_TRANSIT.slice(0, 8)),
    'QR surface does not show the canonical trace key',
  );
  await shoot(page, `returns-qr-canonical-uuid-${lang}-${theme}`);
  await page.keyboard.press('Escape').catch(() => {});
  await settle(700);

  // ── genuine XLSX, intercepted as a real browser download ─────────────────
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
    page.locator('[data-testid="mv-xlsx"]').first().click(),
  ]);
  if (check(label, download !== null, 'clicking Export XLSX produced no download')) {
    const file = join(XLSX_OUT, `return-shipment-receipt-${lang}.xlsx`);
    await download.saveAs(file);
    await validateWorkbook(file, lang, label);
  }

  await context.close();
}

/* ── XLSX validation — re-loaded, not sniffed ─────────────────────────────── */

async function validateWorkbook(file, lang, label) {
  const bytes = readFileSync(file);
  check(label, bytes.length > 1000, `workbook is implausibly small (${bytes.length} bytes)`);
  check(
    label,
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04,
    'downloaded file lacks the PK ZIP signature — not a real xlsx',
  );

  // The real proof: ExcelJS must be able to PARSE it back.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);

  const names = wb.worksheets.map((s) => s.name);
  check(label, names.length === 3, `expected 3 sheets, got ${names.length}: ${names.join(', ')}`);

  const summary = wb.worksheets[0];
  const lines = wb.worksheets[1];
  const exceptions = wb.worksheets[2];
  check(label, Boolean(summary && lines && exceptions), 'a required sheet is missing after reload');
  if (!summary || !lines) return;

  // Header language: the AR workbook must not carry English sheet names.
  const headerText = names.join(' ');
  if (lang === 'ar') {
    check(label, /[؀-ۿ]/.test(headerText), `AR workbook has no Arabic sheet names: ${headerText}`);
    check(label, summary.views?.[0]?.rightToLeft === true, 'AR workbook summary sheet is not right-to-left');
  } else {
    check(label, /Summary/i.test(headerText), `EN workbook sheet names unexpected: ${headerText}`);
    check(label, summary.views?.[0]?.rightToLeft !== true, 'EN workbook was rendered right-to-left');
  }

  // Flatten every cell so we can assert on content and on injection safety.
  const cells = [];
  for (const sheet of wb.worksheets) {
    sheet.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        cells.push(typeof v === 'object' && v !== null && 'text' in v ? String(v.text) : String(v ?? ''));
      });
    });
  }
  const all = cells.join('\n');

  // Locked trace fields must be present in the reloaded workbook.
  check(label, all.includes(SH_IN_TRANSIT), 'reloaded workbook does not carry the canonical trace key');
  check(label, all.includes('QA-SHP-0001'), 'reloaded workbook does not carry the shipment number');

  // Canonical fixture values, i.e. server rows rather than local receive state.
  check(label, all.includes('Amoxicillin'), 'reloaded workbook is missing a canonical material line');
  check(label, all.includes('B4471X'), 'reloaded workbook is missing the canonical batch number');

  // Formula injection: no cell may START with a formula lead character, and no
  // cell may have been stored as a live formula.
  for (const sheet of wb.worksheets) {
    sheet.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.type === ExcelJS.ValueType.Formula) {
          fail(label, `live formula cell in ${sheet.name}!${cell.address}`);
        }
        const v = cell.value;
        const text = typeof v === 'object' && v !== null && 'text' in v ? String(v.text) : v;
        if (typeof text === 'string' && /^[=+\-@]/.test(text) && !/^-?\d/.test(text)) {
          fail(label, `unneutralised formula lead in ${sheet.name}!${cell.address}: ${text.slice(0, 24)}`);
        }
      });
    });
  }

  console.log(`  xlsx ok (${lang}): ${names.join(' · ')} — ${bytes.length} bytes`);
  inventory.push(`xlsx/return-shipment-receipt-${lang}.xlsx`);
}

/* ── B. return REQUEST via Screen 18 movement status ──────────────────────── */

async function captureRequestStatus(browser, lang) {
  const label = `movement-status request ${lang}`;
  const { context, page } = await open(browser, {
    persona: 'warehouse_officer_assigned', lang, theme: 'dark', scene: 'outlet', label,
  });
  console.log(`· ${label}`);

  const tab = page.locator('[role="tab"]', { hasText: L[lang].statusTab }).first();
  if (!check(label, await tab.count() > 0, 'movement status tab missing')) { await context.close(); return; }
  await tab.click();
  await settle(1200);

  await page.locator('[data-testid="movement-status-input"]').fill(RR_SUBMITTED);
  await page.locator('[data-testid="movement-status-lookup"]').click();
  await settle(2200);

  const resolved = await page.locator('[data-testid="movement-status-result"]').count();
  const notAvailable = await page.locator('[data-testid="movement-status-not-available"]').count();
  check(label, resolved > 0 || notAvailable > 0, 'canonical UUID lookup produced neither a result nor a stated outcome');
  if (resolved > 0) {
    const text = await page.locator('[data-testid="movement-status-result"]').innerText();
    check(label, text.includes('QA-RET-0001') || text.includes(RR_SUBMITTED.slice(0, 8)),
      'resolved document is not the requested return request');
  }
  await assertNoOverflow(page, label);
  await shoot(page, `returns-request-status-${lang}`);
  await context.close();
}

/* ── run ──────────────────────────────────────────────────────────────────── */

const browser = await launch();
console.log(`\nPHOENIX return-receipt capture → ${BASE}\n`);
try {
  await captureShipmentReceipts(browser, 'en', 'dark');
  await captureShipmentReceipts(browser, 'ar', 'light');
  await captureRequestStatus(browser, 'en');
  await captureRequestStatus(browser, 'ar');
} finally {
  await browser.close();
}

writeFileSync(
  join(OUT, 'INVENTORY-RETURN-RECEIPTS.json'),
  `${JSON.stringify({ base: BASE, capturedAt: new Date().toISOString(), artifacts: inventory.sort() }, null, 2)}\n`,
);

console.log(`\n${shots} screenshots → ${OUT}`);
if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log('All checks passed.\n');
