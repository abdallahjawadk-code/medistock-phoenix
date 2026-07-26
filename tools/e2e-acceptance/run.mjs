#!/usr/bin/env node
/**
 * E2E-AUTHENTICATED-ACCEPTANCE — Phase 2 authenticated browser acceptance.
 *
 * Drives the REAL built app (headless Chromium via Playwright, matching the
 * scripts/phoenix-capture*.mjs convention already used in this repo) against
 * a local Supabase instance seeded by tools/e2e-fixtures/seed.mjs. Never runs
 * against Production — see the same URL guard pattern as the seed script.
 *
 * Exercises, through the real UI, driving the real RPCs (nothing mocked):
 *   - login as outlet_officer / institution_admin / cross-org outlet_officer
 *   - Outlet Operations -> Stock & Batches -> dispense composer
 *   - all three beneficiary types (patient / crash cart / internal order)
 *   - unauthorized-role denial (institution_admin cannot dispense)
 *   - insufficient-stock client-side guard
 *   - Arabic/RTL rendering
 *   - mobile viewport rendering
 *   - console + failed-network-request monitoring throughout every flow
 *
 * Usage: node tools/e2e-acceptance/run.mjs <baseURL> <seedJsonPath>
 * Exit code 0 only if every assertion passed. Never claims PASS otherwise.
 */
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:4173';
const SEED_PATH = process.argv[3] || 'e2e-seed.json';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'docs', 'phoenix', 'e2e-acceptance');
mkdirSync(OUT_DIR, { recursive: true });

// PRODUCTION-SAFETY GUARD: mirrors tools/e2e-fixtures/seed.mjs — this script
// clicks through real authenticated flows and must never run against
// Production.
if (!/127\.0\.0\.1|localhost/.test(BASE) || /eyrzxgfkvqybjdgyphap/.test(BASE)) {
  console.error(`REFUSING TO RUN: baseURL "${BASE}" is not a recognized local address, or references the Production project ref.`);
  process.exit(1);
}

const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
const settle = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail ?? '' });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ' — ' + detail : ''}`);
}

async function launch() {
  try {
    return await chromium.launch({ headless: true, channel: 'chrome' });
  } catch {
    return await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader'] });
  }
}

/** Opens a fresh page with console/network error collection wired up. */
async function freshPage(browser, viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport });
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(String(err)));
  page.on('requestfailed', req => failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`));
  page.on('response', res => { if (res.status() >= 500) failedRequests.push(`${res.status()} ${res.url()}`); });
  return { page, consoleErrors, failedRequests };
}

async function login(page, email, password) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#login-email', { timeout: 15000 });
  await page.fill('#login-email', email);
  await page.fill('#login-password', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector('#login-email', { state: 'detached', timeout: 20000 }).catch(() => {});
  await settle(1500);
}

const NAV_LABEL = { en: 'Outlet Operations', ar: 'عمليات المنفذ' };

/**
 * Reaches Outlet Operations (screen 18) the way an operator does — desktop
 * sidebar click or mobile drawer — mirroring
 * scripts/phoenix-capture-outlet-corridor.mjs's own proven
 * navigateToScreen18() exactly, rather than a keyboard-shortcut guess.
 */
async function openOutletOperations(page, { mobile = false } = {}) {
  if (mobile) {
    const trigger = page.locator('.premium-drawer-trigger').first();
    await trigger.click();
    await settle(400);
    const item = page.locator('.premium-drawer-nav button', { hasText: NAV_LABEL.en }).or(
      page.locator('.premium-drawer-nav button', { hasText: NAV_LABEL.ar }),
    ).first();
    await item.click();
    await settle(900);
  } else {
    const item = page.locator('nav button.premium-nav-item', { hasText: NAV_LABEL.en }).or(
      page.locator('nav button.premium-nav-item', { hasText: NAV_LABEL.ar }),
    ).first();
    await item.click();
    await settle(900);
  }
  await settle(1200);
}

/**
 * Outlet resolution goes through an async scope-fetch chain
 * (useInventoryScopes -> manageableOutlets) that can genuinely take longer
 * than a fixed settle() on a cold-started CI runner (fresh Postgres, fresh
 * PostgREST schema cache). Polls up to `timeoutMs` instead of guessing a
 * fixed delay.
 */
async function waitForText(page, substrings, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const body = (await page.textContent('body').catch(() => '')) ?? '';
    if (substrings.some(s => body.includes(s))) return true;
    await settle(500);
  }
  return false;
}

async function main() {
  const browser = await launch();
  let allOk = true;

  // ── 1. outlet_officer A: login, dispense all 3 beneficiary types ─────────
  {
    const { page, consoleErrors, failedRequests } = await freshPage(browser);
    await login(page, seed.users.outletOfficerA.email, seed.password);
    const loggedIn = await page.locator('#login-email').count() === 0;
    record('outlet_officer A logs in successfully', loggedIn);

    await openOutletOperations(page);
    const onOutletOps = await waitForText(page, ['E2E Outlet A', 'منفذ أ']);
    record('navigates to Outlet Operations and resolves the seeded outlet', onOutletOps);

    const stockTab = page.getByText('Stock & Batches').or(page.getByText('المخزون والدفعات'));
    await stockTab.first().click().catch(() => {});
    await waitForText(page, ['E2E Paracetamol', 'E2E Amoxicillin', 'E2E Ibuprofen']);

    async function dispenseFlow(materialSubstring, fill, resultCheck) {
      const card = page.locator('div', { hasText: materialSubstring }).first();
      const dispenseBtn = card.getByText('Dispense').or(card.getByText('صرف')).first();
      const opened = await dispenseBtn.click().then(() => true).catch(() => false);
      if (!opened) return record(`dispense composer opens for ${materialSubstring}`, false, 'button not found/clickable');
      await settle(500);
      await fill();
      const submit = page.getByText('Confirm dispense').or(page.getByText('تأكيد الصرف')).first();
      await submit.click().catch(() => {});
      await settle(2000);
      const bodyText = await page.textContent('body') ?? '';
      resultCheck(bodyText);
    }

    // PATIENT
    await dispenseFlow('E2E Paracetamol', async () => {
      await page.fill('#dsp-qty', '5');
      await page.fill('#dsp-patient-name', 'Test Patient A');
      await page.fill('#dsp-patient-ref', 'CHART-001');
    }, (body) => record('PATIENT dispense succeeds', body.includes('Dispensed and beneficiary recorded') || body.includes('تم الصرف')));

    // CRASH CART
    await dispenseFlow('E2E Amoxicillin', async () => {
      await page.fill('#dsp-qty', '5');
      const select = page.locator('select').filter({ hasText: 'Patient' }).first();
      await select.selectOption({ label: 'Crash cart' }).catch(async () => { await select.selectOption({ label: 'عربة الطوارئ' }); });
      await settle(300);
      await page.fill('#dsp-cart', 'CART-42');
    }, (body) => record('CRASH_CART dispense succeeds', body.includes('Dispensed and beneficiary recorded') || body.includes('تم الصرف')));

    // INTERNAL ORDER
    await dispenseFlow('E2E Ibuprofen', async () => {
      await page.fill('#dsp-qty', '5');
      const select = page.locator('select').filter({ hasText: 'Patient' }).first();
      await select.selectOption({ label: 'Internal order' }).catch(async () => { await select.selectOption({ label: 'طلب داخلي' }); });
      await settle(300);
      await page.fill('#dsp-order', 'ORDER-77');
    }, (body) => record('INTERNAL_ORDER dispense succeeds', body.includes('Dispensed and beneficiary recorded') || body.includes('تم الصرف')));

    // INSUFFICIENT STOCK — the low-stock lot has qty=2
    {
      const card = page.locator('div', { hasText: 'E2E Insulin' }).first();
      const dispenseBtn = card.getByText('Dispense').or(card.getByText('صرف')).first();
      await dispenseBtn.click().catch(() => {});
      await settle(500);
      await page.fill('#dsp-qty', '999');
      await page.fill('#dsp-patient-name', 'Overdraw Patient');
      const submitBtn = page.getByText('Confirm dispense').or(page.getByText('تأكيد الصرف')).first();
      const isDisabled = await submitBtn.isDisabled().catch(() => null);
      const bodyText = await page.textContent('body') ?? '';
      const blocked = isDisabled === true || bodyText.includes('exceeds') || bodyText.includes('يتجاوز');
      record('insufficient-stock request is blocked client-side (never reaches the server as a real overdraw)', blocked);
      await page.keyboard.press('Escape').catch(() => {});
    }

    record(`no console errors during outlet_officer A's session`, consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    record(`no failed/5xx network requests during outlet_officer A's session`, failedRequests.length === 0, failedRequests.slice(0, 3).join(' | '));
    if (consoleErrors.length || failedRequests.length) allOk = false;
    await page.close();
  }

  // ── 2. institution_admin A: unauthorized-role denial ──────────────────────
  {
    const { page, consoleErrors } = await freshPage(browser);
    await login(page, seed.users.institutionAdminA.email, seed.password);
    await openOutletOperations(page);
    await waitForText(page, ['E2E Outlet A', 'منفذ أ']);
    const stockTab = page.getByText('Stock & Batches').or(page.getByText('المخزون والدفعات'));
    await stockTab.first().click().catch(() => {});
    await waitForText(page, ['E2E Paracetamol', 'E2E Amoxicillin', 'E2E Ibuprofen']);
    const body = await page.textContent('body') ?? '';
    const hasDispenseButton = body.includes('Dispense') && !body.includes('Confirm dispense');
    // institution_admin holds view_sensitive/export_sensitive, not outlet_stock.dispense — the
    // "Dispense" action button itself must not be offered to this role.
    record('institution_admin (unauthorized role) is NOT offered the Dispense action', !hasDispenseButton, `body mentions Dispense: ${hasDispenseButton}`);
    record('institution_admin session has no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    await page.close();
  }

  // ── 3. outlet_officer B: cross-org denial ─────────────────────────────────
  {
    const { page, consoleErrors } = await freshPage(browser);
    await login(page, seed.users.outletOfficerB.email, seed.password);
    await openOutletOperations(page);
    // outlet_officer B should resolve THEIR OWN org's outlet (E2E Outlet B) —
    // wait for that positive signal (own outlet resolves fine) before
    // asserting the negative (org A's outlet/stock never appear).
    await waitForText(page, ['E2E Outlet B', 'منفذ ب']);
    const body = await page.textContent('body') ?? '';
    const seesOrgAOutlet = body.includes('E2E Outlet A') || body.includes('منفذ أ');
    const seesOrgAStock = body.includes('E2E Paracetamol') || body.includes('E2E Amoxicillin');
    record('outlet_officer B (different org) never sees org A\'s outlet name', !seesOrgAOutlet);
    record('outlet_officer B (different org) never sees org A\'s stock rows', !seesOrgAStock);
    record('cross-org session has no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    await page.close();
  }

  // ── 4. Arabic/RTL rendering ────────────────────────────────────────────────
  {
    const { page } = await freshPage(browser);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('#login-email', { timeout: 15000 }).catch(() => {});
    const htmlDir = await page.evaluate(() => document.documentElement.getAttribute('dir') || getComputedStyle(document.documentElement).direction);
    const htmlLang = await page.evaluate(() => document.documentElement.getAttribute('lang'));
    record('default load is Arabic/RTL (this app\'s documented AR+dark default)', htmlLang === 'ar' && (htmlDir === 'rtl' || htmlDir === null), `lang=${htmlLang} dir=${htmlDir}`);
    await page.screenshot({ path: join(OUT_DIR, 'login-ar-rtl.png') });
    await page.close();
  }

  // ── 5. Mobile viewport — no blank page, no horizontal overflow ────────────
  {
    const { page, consoleErrors } = await freshPage(browser, { width: 390, height: 844 });
    await login(page, seed.users.outletOfficerA.email, seed.password);
    await openOutletOperations(page, { mobile: true });
    await waitForText(page, ['E2E Outlet A', 'منفذ أ']);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    const bodyText = (await page.textContent('body')) ?? '';
    record('mobile viewport: no horizontal overflow', !overflow);
    record('mobile viewport: not a blank page', bodyText.trim().length > 100);
    record('mobile viewport session has no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    await page.screenshot({ path: join(OUT_DIR, 'outlet-ops-mobile.png') });
    await page.close();
  }

  await browser.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} assertions passed.`);
  if (failed.length || !allOk) {
    console.error(`\nFAILED (${failed.length}):`);
    for (const f of failed) console.error(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`);
    process.exit(1);
  }
  console.log('\nDONE — Phase 2 authenticated browser acceptance: all assertions passed.');
}

main().catch(e => { console.error('E2E ACCEPTANCE FAILED:', e); process.exit(1); });
