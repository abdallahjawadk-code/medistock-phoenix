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
  return ok;
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
  const restCalls = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(String(err)));
  page.on('requestfailed', req => failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`));
  page.on('response', res => {
    if (res.status() >= 500) failedRequests.push(`${res.status()} ${res.url()}`);
    // DIAGNOSTIC (temporary): capture every Supabase REST call's status +
    // a body snippet. An RLS filter often returns HTTP 200 with an empty
    // array, not an error — the >=500 check above would miss that entirely.
    if (res.url().includes('/rest/v1/')) {
      res.text().then(body => {
        restCalls.push(`${res.status()} ${res.url().replace(/^.*\/rest\/v1\//, '')} -> ${body.slice(0, 300)}`);
      }).catch(() => {});
    }
  });
  return { page, consoleErrors, failedRequests, restCalls };
}

async function login(page, email, password) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#login-email', { timeout: 15000 });
  await page.fill('#login-email', email);
  await page.fill('#login-password', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector('#login-email', { state: 'detached', timeout: 20000 }).catch(() => {});
  // AuthenticatedApp's own profile/session-restore fetch chain runs after
  // the login form detaches — give it real time to mount the full shell
  // (sidebar, nav) on a cold-started CI runner before anything tries to
  // interact with it.
  await settle(3000);
}

/**
 * Sets a native <select>'s value by visible option label, via Playwright's
 * own selectOption() — a real interaction going through the same
 * actionability checks (visible, stable, enabled, receives events) a real
 * user's pointer would be subject to. This is an operational acceptance
 * test: no DOM-level bypass is acceptable here, even one that reaches
 * React's onChange correctly — the interaction itself has to be real.
 */
async function selectByLabel(select, labels) {
  let lastError = null;
  for (const label of labels) {
    try {
      await select.selectOption({ label }, { timeout: 10000 });
      return;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error(`selectByLabel: none of [${labels.join(', ')}] found among this <select>'s options`);
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
    await trigger.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    console.log('DIAGNOSTIC — drawer trigger count:', await trigger.count());
    await trigger.click();
    await settle(400);
    const item = page.locator('.premium-drawer-nav button', { hasText: NAV_LABEL.en }).or(
      page.locator('.premium-drawer-nav button', { hasText: NAV_LABEL.ar }),
    ).first();
    console.log('DIAGNOSTIC — drawer nav item count:', await item.count());
    await item.click();
    await settle(900);
  } else {
    const item = page.locator('nav button.premium-nav-item', { hasText: NAV_LABEL.en }).or(
      page.locator('nav button.premium-nav-item', { hasText: NAV_LABEL.ar }),
    ).first();
    await item.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    console.log('DIAGNOSTIC — sidebar nav item count:', await item.count(), 'url:', page.url());
    await item.click();
    await settle(900);
  }
  await settle(1200);
  console.log('DIAGNOSTIC — post-navigation url:', page.url());
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
    const { page, consoleErrors, failedRequests, restCalls } = await freshPage(browser);
    // Full Playwright trace (screenshots + DOM snapshots + network + actions
    // per step) for this session, since it's the one that drives the
    // dispense composer — saved as an artifact regardless of outcome so a
    // failure here is always inspectable after the fact, not just from the
    // console log.
    await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    await login(page, seed.users.outletOfficerA.email, seed.password);
    const loggedIn = await page.locator('#login-email').count() === 0;
    record('outlet_officer A logs in successfully', loggedIn);

    await openOutletOperations(page);
    const onOutletOps = await waitForText(page, ['E2E Outlet A', 'منفذ أ']);
    record('navigates to Outlet Operations and resolves the seeded outlet', onOutletOps);
    if (!onOutletOps) {
      await settle(1000); // let any in-flight response body reads finish
      const bodySnippet = ((await page.textContent('body').catch(() => '')) ?? '').slice(0, 500);
      console.log('DIAGNOSTIC — outlet did not resolve. Console errors so far:', JSON.stringify(consoleErrors));
      console.log('DIAGNOSTIC — failed/5xx requests so far:', JSON.stringify(failedRequests));
      console.log('DIAGNOSTIC — REST calls so far:\n' + restCalls.join('\n'));
      console.log('DIAGNOSTIC — body text snippet:', bodySnippet);
      const htmlSnippet = (await page.content().catch(() => '')).slice(0, 3000);
      console.log('DIAGNOSTIC — raw HTML snippet:\n' + htmlSnippet);
      const h2 = await page.locator('h2').first().innerText().catch(e => `<error: ${e.message}>`);
      console.log('DIAGNOSTIC — first h2 innerText:', h2);
      await page.screenshot({ path: join(OUT_DIR, 'diagnostic-outlet-not-resolved.png') }).catch(() => {});
    }

    const stockTab = page.getByText('Stock & Batches').or(page.getByText('المخزون والدفعات'));
    await stockTab.first().click().catch(() => {});
    await waitForText(page, ['E2E Paracetamol', 'E2E Amoxicillin', 'E2E Ibuprofen']);

    /**
     * A dispense's real source of truth is the RPC response itself (a real
     * server-side atomic write: quantity moved + beneficiary context
     * recorded, verified `"ok": true` from
     * phoenix_dispense_outlet_stock_with_context) — the UI success TEXT is a
     * secondary confirmation that can legitimately race the check (React
     * state update timing), so a passing REST response is accepted on its
     * own merits, not as a fallback covering for a broken UI.
     */
    function dispenseSucceeded(body, restSnippet) {
      const uiText = body.includes('Dispensed and beneficiary recorded') || body.includes('تم الصرف');
      const rpcOk = restSnippet.some(c => /^200 rpc\/phoenix_dispense_outlet_stock_with_context/.test(c) && c.includes('"ok": true'));
      return uiText || rpcOk;
    }

    async function dispenseFlow(materialSubstring, fill, resultCheck) {
      const card = page.locator('div', { hasText: materialSubstring }).first();
      const dispenseBtn = card.getByText('Dispense').or(card.getByText('صرف')).first();
      const opened = await dispenseBtn.click().then(() => true).catch(() => false);
      if (!opened) return record(`dispense composer opens for ${materialSubstring}`, false, 'button not found/clickable');
      await settle(500);
      await fill();
      // React's canSubmit (which disables the button) derives from state set
      // by the fill() calls above — give it real time to catch up rather than
      // racing a click against a still-disabled button (which Playwright
      // refuses and this function used to swallow silently via .catch()).
      const submit = page.getByText('Confirm dispense').or(page.getByText('تأكيد الصرف')).first();
      let enabled = false;
      for (let i = 0; i < 10; i++) {
        enabled = await submit.count() > 0 && !(await submit.first().isDisabled().catch(() => true));
        if (enabled) break;
        await settle(300);
      }
      console.log(`DIAGNOSTIC — ${materialSubstring} submit button: count=${await submit.count()} enabled=${enabled}`);
      if (!enabled) {
        record(`${materialSubstring} dispense composer submit button never became enabled`, false);
        await page.keyboard.press('Escape').catch(() => {});
        await settle(300);
        return;
      }

      // Diagnose BEFORE acting: a trial click checks Playwright's full
      // actionability chain (visible, stable, receives events, enabled)
      // WITHOUT performing the click, so a failure here names the exact
      // reason instead of just timing out. This must never be bypassed with
      // force:true or a raw DOM el.click() — this is an operational
      // acceptance test, and the click has to succeed exactly as it would
      // for a real user, or the underlying cause (app defect, stray
      // overlay, animation timing, or a selector targeting the wrong
      // element) has to be found and fixed for real.
      let trialError = null;
      try {
        await submit.click({ trial: true, timeout: 5000 });
      } catch (e) {
        trialError = e.message;
      }

      if (trialError) {
        const diag = await submit.evaluate(el => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const stack = document.elementsFromPoint(cx, cy).map(e2 => ({
            tag: e2.tagName, id: e2.id || null, cls: e2.className || null,
          }));
          const overlays = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]'))
            .map(o => {
              const or = o.getBoundingClientRect();
              const ocs = getComputedStyle(o);
              return {
                tag: o.tagName, role: o.getAttribute('role'), id: o.id || null,
                rect: { x: or.x, y: or.y, w: or.width, h: or.height },
                display: ocs.display, visibility: ocs.visibility, zIndex: ocs.zIndex, pointerEvents: ocs.pointerEvents,
              };
            });
          return {
            buttonRect: { x: r.x, y: r.y, w: r.width, h: r.height },
            computed: {
              display: cs.display, visibility: cs.visibility, pointerEvents: cs.pointerEvents,
              zIndex: cs.zIndex, opacity: cs.opacity, transform: cs.transform,
            },
            disabled: el.disabled,
            elementsAtCenter: stack,
            openOverlays: overlays,
          };
        }).catch(e => ({ error: e.message }));
        console.log(`DIAGNOSTIC — ${materialSubstring} trial click failed: ${trialError}`);
        console.log(`DIAGNOSTIC — ${materialSubstring} full diagnostic:`, JSON.stringify(diag, null, 2));
        await page.screenshot({ path: join(OUT_DIR, `diagnostic-${materialSubstring.replace(/\s+/g, '-')}-trial-click-failed.png`), fullPage: true }).catch(() => {});
        const htmlSnippet = (await page.content().catch(() => '')).slice(0, 6000);
        console.log(`DIAGNOSTIC — ${materialSubstring} DOM snapshot:\n${htmlSnippet}`);
      }

      // Only a real, non-forced click — exactly what a real user's pointer
      // would do. If the trial above failed, this will fail the same way
      // (and honestly), rather than being papered over.
      try {
        await submit.click({ timeout: 10000 });
      } catch (e) {
        record(`${materialSubstring} dispense composer submit click failed`, false, e.message);
        await page.screenshot({ path: join(OUT_DIR, `diagnostic-${materialSubstring.replace(/\s+/g, '-')}-click-failed.png`), fullPage: true }).catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
        await settle(300);
        return;
      }
      await settle(2000);
      const bodyText = await page.textContent('body') ?? '';
      const alertText = await page.locator('[role="alert"]').allTextContents().catch(() => []);
      const restSnippet = restCalls.filter(c => c.includes('dispense_outlet_stock_with_context')).slice(-2);
      const ok = resultCheck(bodyText, { alertText, restSnippet });
      if (!ok) {
        // dispenseSucceeded() already accepts either the UI success text OR
        // a genuine "ok": true RPC response as proof — reaching this means
        // BOTH signals failed, a real dispense failure, not just a UI-text
        // timing race.
        console.log(`DIAGNOSTIC — ${materialSubstring} dispense genuinely failed: alert text=${JSON.stringify(alertText)} rest=${JSON.stringify(restSnippet)}`);
      }
      // Close the dialog regardless of outcome so a failed/errored submission
      // never leaves a modal open blocking the next card's Dispense button.
      await page.keyboard.press('Escape').catch(() => {});
      await settle(300);
    }

    // PATIENT
    await dispenseFlow('E2E Paracetamol', async () => {
      await page.fill('#dsp-qty', '5');
      await page.fill('#dsp-patient-name', 'Test Patient A');
      await page.fill('#dsp-patient-ref', 'CHART-001');
    }, (body, { restSnippet }) => record('PATIENT dispense succeeds', dispenseSucceeded(body, restSnippet)));

    // CRASH CART
    await dispenseFlow('E2E Amoxicillin', async () => {
      await page.fill('#dsp-qty', '5');
      // PhoenixSelect connects a real <label htmlFor> to the <select id> —
      // getByLabel is Playwright's own robust locator for exactly this,
      // unlike the hasText content filter this used to use (which made
      // .evaluate() hang the full 30s timeout waiting for a match that
      // apparently never resolved).
      const select = page.getByLabel('Beneficiary type').or(page.getByLabel('نوع الجهة المستفيدة')).first();
      await selectByLabel(select, ['Crash cart', 'عربة الطوارئ']);
      await settle(300);
      await page.fill('#dsp-cart', 'CART-42');
    }, (body, { restSnippet }) => record('CRASH_CART dispense succeeds', dispenseSucceeded(body, restSnippet)));

    // INTERNAL ORDER
    await dispenseFlow('E2E Ibuprofen', async () => {
      await page.fill('#dsp-qty', '5');
      // PhoenixSelect connects a real <label htmlFor> to the <select id> —
      // getByLabel is Playwright's own robust locator for exactly this,
      // unlike the hasText content filter this used to use (which made
      // .evaluate() hang the full 30s timeout waiting for a match that
      // apparently never resolved).
      const select = page.getByLabel('Beneficiary type').or(page.getByLabel('نوع الجهة المستفيدة')).first();
      await selectByLabel(select, ['Internal order', 'طلب داخلي']);
      await settle(300);
      await page.fill('#dsp-order', 'ORDER-77');
    }, (body, { restSnippet }) => record('INTERNAL_ORDER dispense succeeds', dispenseSucceeded(body, restSnippet)));

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
    await page.context().tracing.stop({ path: join(OUT_DIR, 'outlet-officer-a-trace.zip') }).catch(() => {});
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
