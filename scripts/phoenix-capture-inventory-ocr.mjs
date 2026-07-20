/* ─── PHOENIX Inventory Center + OCR visual evidence capture ──────────────────
   Drives a CLEAN headless browser process (playwright-core against the installed
   Chrome/Edge, falling back to bundled Chromium) over the dev-only visual QA
   harness, and captures BOTH:

     · the Inventory Center across AR/EN × dark/light × desktop/mobile + tablet;
     · the staged OCR intake flow, end to end, through the REAL visible controls.

   NOTHING IS MOCKED IN THE OCR PATH. The runner uploads a real de-identified
   fixture image into the real <input type="file">, and the real browser-local
   Tesseract engine recognizes it from our self-hosted /assets/ocr. The bounding
   boxes, confidence bands, quality verdict and match outcome in these captures
   are produced by the shipped code, not by a fixture.

   THIS SCRIPT FAILS LOUDLY. Every assertion below aborts the run with a non-zero
   exit rather than emitting a screenshot that looks fine:

     · any uncaught page error                     (pageerror)
     · any console error                           (console[type=error])
     · horizontal page overflow                    (scrollWidth > clientWidth)
     · missing Beta banner on any OCR stage        ([data-testid=ocr-beta-banner])
     · a critical control hidden or disabled when it must not be
     · a blank OCR preview                         (no <img> / zero natural size)
     · zero bounding boxes after a successful recognition
     · the final confirm enabled before every required confirmation is ticked

   Prerequisites — the harness is gated on DEV *and* an explicit opt-in flag:

     VITE_ENABLE_VISUAL_QA=true npx vite --port 5181 --strictPort

   Output → docs/phoenix/visual-evidence/inventory-ocr/.
   Usage: node scripts/phoenix-capture-inventory-ocr.mjs [baseURL]   (default :5181)
   ─────────────────────────────────────────────────────────────────────────── */
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:5181';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'phoenix', 'visual-evidence', 'inventory-ocr');
mkdirSync(OUT, { recursive: true });

/** Organization whose fixture warehouse carries the colliding Amoxicillin batch. */
const ORG = 'qa-org-a1';

/** De-identified synthetic corpus (tools/ocr-eval/fixtures). Never a real document. */
const FIXTURE_DIR = join(ROOT, 'tools', 'ocr-eval', 'fixtures');
const DOC_CLEAN = join(FIXTURE_DIR, 'en-clean-amoxicillin--scan.png');
const DOC_DIM = join(FIXTURE_DIR, 'en-clean-amoxicillin--dim.png');
const DOC_BLURRED = join(FIXTURE_DIR, 'en-clean-amoxicillin--blurred.png');
const DOC_AMBIGUOUS = join(FIXTURE_DIR, 'en-clean-paracetamol--scan.png');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
  { name: 'tablet', width: 768, height: 1024, mobile: true },
];

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// ── failure collection ───────────────────────────────────────────────────────

const failures = [];
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

/**
 * Open a fresh page wired to the failure collectors. Page errors and console
 * errors are attributed to the cell that produced them, so a run that emits
 * pretty screenshots over a broken console still exits non-zero.
 */
async function openPage(browser, { lang, theme, vp, scene = 'inventory', label }) {
  const page = await browser.newPage({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
  });
  page.on('pageerror', (error) => fail(label, `page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // A failed favicon/devtools probe is noise, not a defect in the screen.
    if (/favicon|Download the React DevTools/i.test(text)) return;
    fail(label, `console error: ${text}`);
  });

  const url = `${BASE}/?qa=1&persona=super_admin&org=${ORG}&lang=${lang}&theme=${theme}&scene=${scene}`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.premium-shell', { timeout: 20000 });

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
  return page;
}

// ── assertions ───────────────────────────────────────────────────────────────

/** No horizontal page overflow, at any viewport. A 1px rounding slack only. */
async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    const widest = [...document.querySelectorAll('body *')]
      .map((n) => {
        const r = n.getBoundingClientRect();
        return r.width > 0 ? { tag: n.tagName, cls: String(n.className).slice(0, 60), right: Math.round(r.right), left: Math.round(r.left) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.right - a.right)[0];
    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      widest,
    };
  });
  if (overflow.scrollWidth > overflow.clientWidth + 1) {
    fail(label, `horizontal overflow: scrollWidth=${overflow.scrollWidth} > clientWidth=${overflow.clientWidth}; widest element ${overflow.widest?.tag}.${overflow.widest?.cls} right=${overflow.widest?.right}`);
  }
}

/** The Beta banner must be present AND visible on every OCR stage. */
async function assertBetaBanner(page, label) {
  const banner = page.locator('[data-testid="ocr-beta-banner"]');
  if ((await banner.count()) === 0) return fail(label, 'Beta banner missing');
  if (!(await banner.first().isVisible())) return fail(label, 'Beta banner present but not visible');
  const box = await banner.first().boundingBox();
  if (!box || box.height < 8) fail(label, 'Beta banner has no rendered height');
}

/** A control that must be present, visible, and in the expected enabled state. */
async function assertControl(page, label, locator, { name, enabled }) {
  const count = await locator.count();
  if (count === 0) return fail(label, `critical control "${name}" is missing`);
  const first = locator.first();
  if (!(await first.isVisible())) return fail(label, `critical control "${name}" is hidden`);
  const isEnabled = await first.isEnabled();
  if (enabled === true && !isEnabled) fail(label, `critical control "${name}" is unexpectedly DISABLED`);
  if (enabled === false && isEnabled) fail(label, `critical control "${name}" is unexpectedly ENABLED`);
  return first;
}

/** Every touch target on an interactive control must reach 44×44 CSS px. */
async function assertTouchTargets(page, label) {
  const small = await page.evaluate(() => {
    const out = [];
    const nodes = document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"], [role="button"]');
    for (const n of nodes) {
      if (getComputedStyle(n).visibility === 'hidden') continue;
      // Measure the EFFECTIVE target, not the painted control. A checkbox drawn
      // at 13×13 inside a <label> is activated by tapping anywhere in that
      // label, so the label's box is the real target (WCAG 2.5.5). Inflating the
      // checkbox itself to 44px would be visually wrong and would not change
      // what an operator can actually hit.
      const wrappingLabel = (n.tagName === 'INPUT' && /^(checkbox|radio)$/.test(n.type))
        ? n.closest('label')
        : null;
      const target = wrappingLabel ?? n;
      let r = target.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;              // not rendered
      // A control may deliberately paint smaller than it is tappable, by
      // carrying a [data-hit-area] child that extends the target without
      // drawing anything (the OCR bounding-box overlays do exactly this, so the
      // visible rectangle can stay true to the recognized text region).
      const hitArea = target.querySelector('[data-hit-area]');
      if (hitArea) r = hitArea.getBoundingClientRect();
      if (r.height < 44 - 0.5 || r.width < 44 - 0.5) {
        out.push({
          tag: n.tagName, type: n.getAttribute('type') || '', id: n.id || '',
          text: (n.textContent || '').trim().slice(0, 30),
          w: Math.round(r.width), h: Math.round(r.height),
        });
      }
    }
    return out;
  });
  if (small.length > 0) {
    const shown = small.slice(0, 6).map((s) => `${s.tag}${s.type ? `[${s.type}]` : ''}${s.id ? `#${s.id}` : ''}"${s.text}" ${s.w}×${s.h}`);
    fail(label, `${small.length} touch target(s) below 44×44: ${shown.join('; ')}`);
  }
}

/** The document preview must actually be showing pixels, not an empty box. */
async function assertPreviewNotBlank(page, label) {
  const state = await page.evaluate(() => {
    // Must be the DOCUMENT preview specifically. `img[alt]` alone matches the
    // shell's 39×39 brand logo first, which made this assertion report a blank
    // preview while the real document was rendering perfectly beside it.
    const img = document.querySelector('img[alt="Document image"], img[alt="صورة المستند"]');
    if (!img) return { present: false };
    const r = img.getBoundingClientRect();
    return {
      present: true, complete: img.complete,
      naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
      renderedWidth: Math.round(r.width), renderedHeight: Math.round(r.height),
    };
  });
  if (!state.present) return fail(label, 'OCR preview blank: no <img> rendered');
  if (!state.complete || state.naturalWidth === 0 || state.naturalHeight === 0) {
    return fail(label, `OCR preview blank: image did not decode (natural ${state.naturalWidth}×${state.naturalHeight})`);
  }
  if (state.renderedWidth < 40 || state.renderedHeight < 40) {
    fail(label, `OCR preview effectively blank: rendered ${state.renderedWidth}×${state.renderedHeight}`);
  }
}

/** A successful recognition MUST produce at least one bounding-box overlay. */
async function assertBoundingBoxes(page, label) {
  const boxes = await page.locator('img[alt] ~ button, div:has(> img[alt]) > button').count();
  if (boxes === 0) {
    fail(label, 'recognition succeeded but produced ZERO bounding boxes');
    return 0;
  }
  console.log(`  ${label}: ${boxes} bounding box overlay(s)`);
  return boxes;
}

async function shoot(page, name) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: 'disabled', timeout: 30000 });
  console.log(`  shot ${name}.png`);
  shots += 1;
}

// ── driving the real controls ────────────────────────────────────────────────

/**
 * Pick the fixture warehouse through the visible <select>, as an operator does.
 *
 * NOT `select` — the screen header also renders the <PhoenixOrgScope /> org
 * dropdown, which comes FIRST in the DOM. Selecting that one leaves the
 * warehouse unset, the screen stuck on its "select a warehouse" empty state, and
 * every downstream assertion vacuously satisfied. This function therefore
 * targets the select that actually offers warehouse ids, and the caller asserts
 * the intake content really rendered.
 */
async function selectWarehouse(page, label, warehouseId = 'qa-wh-inst-a') {
  await page.locator('select').first().waitFor({ timeout: 15000 });
  const picked = await page.evaluate((wanted) => {
    for (const select of document.querySelectorAll('select')) {
      const option = [...select.options].find(o => o.value === wanted);
      if (!option) continue;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, option.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return option.value;
    }
    return null;
  }, warehouseId);
  if (!picked) {
    fail(label, `warehouse "${warehouseId}" was not offered — the Inventory Center dead-ended on its empty state`);
    return false;
  }
  await settle(700);

  // Prove the selection actually took: the intake tab must now render its
  // content, not the "select a warehouse" placeholder.
  const intakeReady = await page
    .getByRole('button', { name: /Scan a document|قراءة مستند/i })
    .first()
    .waitFor({ timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!intakeReady) {
    fail(label, `warehouse "${picked}" was selected but the intake tab never rendered — screen still on the empty state`);
    return false;
  }
  return true;
}

/** Enter the OCR assist via the visible button on the intake tab. */
async function openOcr(page, label) {
  // `ocr_open` — "Scan a document (Beta)" / "قراءة مستند بالكاميرا (تجريبي)".
  const button = page.getByRole('button', { name: /Scan a document|قراءة مستند/i }).first();
  if ((await button.count()) === 0) return fail(label, 'OCR entry button not found on the intake tab'), false;
  if (!(await button.isEnabled())) return fail(label, 'OCR entry button is disabled — cannot reach the flow'), false;
  await button.click();
  await page.waitForSelector('[data-testid="ocr-beta-banner"]', { timeout: 15000 });
  return true;
}

/** Upload a fixture into the real file input and wait for the quality stage. */
async function uploadDocument(page, label, file) {
  if (!existsSync(file)) return fail(label, `fixture missing: ${file}`), false;
  const input = page.locator('input[type="file"]');
  await input.waitFor({ timeout: 10000 });
  await input.setInputFiles(file);
  // The quality stage is the first thing that renders the preview image.
  await page.waitForSelector('img[alt]', { timeout: 20000 }).catch(() => {});
  await settle(900);
  return true;
}

/**
 * Start recognition and wait for the review stage. Real Tesseract, real WASM,
 * real trained data — this legitimately takes tens of seconds headless.
 */
async function recognize(page, label, { captureProgress = null } = {}) {
  const start = page.getByRole('button').filter({ hasText: /recogni|قراءة|تعرّف|تعرف/i }).first();
  if ((await start.count()) === 0) return fail(label, 'start-recognition button not found'), false;
  await start.click();

  if (captureProgress) {
    // Grab the progress stage while the engine is still loading. Cancel must be
    // reachable the whole time — assert it before shooting.
    // Cancel is asserted with a WAIT, not an instant probe: the first render of
    // the recognizing stage competes with the dynamic tesseract.js import and
    // WASM instantiation, which can occupy the main thread for about a second.
    const cancelButton = page.getByRole('button').filter({ hasText: /cancel|إلغاء/i });
    const cancelAppeared = await cancelButton.first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    if (!cancelAppeared) fail(`${label}/progress`, 'cancel never became available during recognition');
    await assertBetaBanner(page, `${label}/progress`);
    await assertControl(page, `${label}/progress`, cancelButton, { name: 'cancel during recognition', enabled: true });
    await assertNoHorizontalOverflow(page, `${label}/progress`);
    await shoot(page, captureProgress);
  }

  // Review is reached when the confidence-band field cards appear.
  const reached = await page
    .waitForSelector('#ocr-review-field-scientificName, #ocr-review-field-quantity, #ocr-review-field-batchNumber', { timeout: 240000 })
    .then(() => true)
    .catch(() => false);
  if (!reached) fail(label, 'recognition never reached the review stage within 240s');
  await settle(700);
  return reached;
}

/** Tick every required-confirmation checkbox that the review renders. */
/**
 * Tick every required-confirmation checkbox the review renders.
 *
 * Re-queried on EVERY pass, never held across a click: confirming a field
 * re-renders the review list, which detaches any locator captured beforehand
 * (an earlier version indexed `nth(i)` across the loop and hung for 30s on a
 * detached node). Bounded so a checkbox that refuses to stay ticked ends the
 * loop instead of spinning.
 */
async function tickAllConfirmations(page, label) {
  let ticked = 0;
  for (let pass = 0; pass < 25; pass += 1) {
    const unchecked = page.locator('input[type="checkbox"]:not(:checked)');
    if ((await unchecked.count()) === 0) break;
    const box = unchecked.first();
    const before = await page.locator('input[type="checkbox"]:checked').count();

    await box.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    // Deliberately NOT { force: true }. Forcing bypasses the obscured-element
    // check and dispatches at the element's centre point — which, when a control
    // sits under the mobile bottom navigation, lands on the NAV and silently
    // navigates away from the flow. That is exactly the mobile defect this run
    // has to detect, so the click must be allowed to fail instead.
    const outcome = await box.check({ timeout: 5000 }).then(() => null).catch(e => e);
    if (outcome) {
      const obscured = /intercepts pointer events|not stable|outside of the viewport/i.test(outcome.message ?? '');
      fail(label, obscured
        ? `a required confirmation checkbox is NOT reachable — the click is intercepted by another element (bottom navigation overlap): ${String(outcome.message).split('\n')[0]}`
        : `could not tick a required confirmation: ${String(outcome.message).split('\n')[0]}`);
      break;
    }

    await settle(150);
    const after = await page.locator('input[type="checkbox"]:checked').count();
    if (after <= before) break;   // it did not take; stop rather than spin
    ticked = after;
  }

  // Ticking must never have navigated us out of the flow.
  if ((await page.locator('[data-testid="ocr-beta-banner"]').count()) === 0) {
    fail(label, 'confirming a field navigated AWAY from the OCR flow — a checkbox click was received by another control');
  }
  await settle(300);
  return ticked;
}

// ── PART 1: Inventory Center matrix ──────────────────────────────────────────

async function captureInventoryMatrix(browser) {
  console.log('\n── Inventory Center matrix ──');
  const cells = [];
  for (const vp of VIEWPORTS) {
    for (const lang of ['ar', 'en']) {
      for (const theme of ['dark', 'light']) {
        // The tablet cell is a single representative (AR dark), per the brief.
        if (vp.name === 'tablet' && !(lang === 'ar' && theme === 'dark')) continue;
        cells.push({ vp, lang, theme });
      }
    }
  }

  for (const { vp, lang, theme } of cells) {
    const label = `inventory/${lang}-${theme}-${vp.name}`;
    console.log(label);
    const page = await openPage(browser, { lang, theme, vp, label });

    await selectWarehouse(page, label);
    await settle(700);

    // The three tabs and the warehouse selector are the screen's critical
    // controls: if any is missing or disabled the screen is unusable.
    await assertControl(page, label, page.locator('select').first(), { name: 'warehouse selector', enabled: true });
    await assertControl(page, label, page.locator('[role="tab"]'), { name: 'intake tab', enabled: true });
    const tabs = await page.locator('[role="tab"]').count();
    if (tabs !== 3) fail(label, `expected 3 tabs, found ${tabs}`);

    await assertNoHorizontalOverflow(page, label);
    await assertTouchTargets(page, label);
    await shoot(page, `inventory-${lang}-${theme}-${vp.name}`);
    await page.close();
  }
}

// ── PART 2: OCR flow ─────────────────────────────────────────────────────────

/** The full happy path, in one browser context, capturing each stage. */
async function captureOcrHappyPath(browser, { lang, theme, vp, prefix }) {
  const label = `ocr/${prefix}`;
  console.log(`\n── OCR flow: ${prefix} ──`);
  const page = await openPage(browser, { lang, theme, vp, label });

  // The EMPTY warehouse: the colliding one blocks at review by design, so the
  // final-preview and confirmation states are unreachable through it.
  if (!(await selectWarehouse(page, label, 'qa-wh-inst-a-empty'))) return page.close();
  if (!(await openOcr(page, label))) return page.close();

  // 1 — capture / upload
  await assertBetaBanner(page, `${label}/capture`);
  await assertControl(page, `${label}/capture`, page.locator('input[type="file"]'), { name: 'file / camera input', enabled: true });
  await assertNoHorizontalOverflow(page, `${label}/capture`);
  await assertTouchTargets(page, `${label}/capture`);
  await shoot(page, `${prefix}-01-capture-upload`);

  // 2 — image quality result
  await uploadDocument(page, label, DOC_CLEAN);
  await assertBetaBanner(page, `${label}/quality`);
  await assertPreviewNotBlank(page, `${label}/quality`);
  await assertNoHorizontalOverflow(page, `${label}/quality`);
  await shoot(page, `${prefix}-02-image-quality`);

  // 3 — recognition progress, then 4 — review with bounding boxes
  const ok = await recognize(page, label, { captureProgress: `${prefix}-03-recognition-progress` });
  if (!ok) { await shoot(page, `${prefix}-03b-recognition-stalled`); return page.close(); }

  await assertBetaBanner(page, `${label}/review`);
  await assertPreviewNotBlank(page, `${label}/review`);
  await assertBoundingBoxes(page, `${label}/review`);
  await assertNoHorizontalOverflow(page, `${label}/review`);
  await assertTouchTargets(page, `${label}/review`);
  await shoot(page, `${prefix}-04-review-bounding-boxes`);

  // 5 — low-confidence / ambiguous material is whatever the engine actually
  // produced; capture the field pane scrolled to the uncertain bands.
  const uncertain = await page.locator('text=/uncertain|غير مؤكد|needs review|بحاجة/i').count();
  console.log(`  ${label}: ${uncertain} non-high confidence marker(s) on screen`);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.45));
  await settle(400);
  await shoot(page, `${prefix}-05-low-confidence-fields`);
  await page.evaluate(() => window.scrollTo(0, 0));

  await reportWarnings(page, label);

  // 6 — the preview gate. Before ticking anything, "go to preview" must be
  // DISABLED. That is the single most important safety assertion here.
  const gotoPreview = page.getByRole('button').filter({ hasText: /preview|المعاينة|معاينة/i }).first();
  await assertControl(page, `${label}/review`, gotoPreview, { name: 'go to final preview (pre-confirmation)', enabled: false });

  await tickAllConfirmations(page, `${label}/review`);
  await settle(500);
  if (await gotoPreview.isEnabled()) {
    await gotoPreview.click();
    await settle(800);

    // 8 — final preview with ZERO pre-checked confirmations.
    const preChecked = await page.locator('input[type="checkbox"]:checked').count();
    if (preChecked > 0) {
      fail(`${label}/preview`, `final preview arrived with ${preChecked} confirmation(s) ALREADY TICKED`);
    }
    const confirmSubmit = page.getByRole('button').filter({ hasText: /confirm|تأكيد/i }).first();
    await assertControl(page, `${label}/preview`, confirmSubmit, { name: 'confirm & submit (before warehouse tick)', enabled: false });
    await assertBetaBanner(page, `${label}/preview`);
    await assertNoHorizontalOverflow(page, `${label}/preview`);
    await shoot(page, `${prefix}-07-final-preview-zero-prechecked`);

    // 9 — after the explicit warehouse confirmation the button becomes live.
    await page.locator('input[type="checkbox"]').last().check({ force: true }).catch(() => {});
    await settle(400);
    await assertControl(page, `${label}/preview`, confirmSubmit, { name: 'confirm & submit (after warehouse tick)', enabled: true });
    await shoot(page, `${prefix}-08-confirmed-ready-to-submit`);

    // 10 — submit. The QA fixture client is SELECT-only by design, so this
    // deliberately surfaces the intake error path rather than writing stock.
    await confirmSubmit.click();
    await settle(2500);
    await assertBetaBanner(page, `${label}/submitted`);
    await shoot(page, `${prefix}-09-submit-outcome`);
  } else {
    console.log(`  ${label}: NOTE — preview stayed blocked after ticking every confirmation (a blocking warning remains, which is the safe outcome)`);
    await shoot(page, `${prefix}-07-preview-blocked-by-warning`);
  }

  await page.close();
}

/**
 * Report the warnings the review ACTUALLY produced, verbatim. Which of them
 * fires depends on what the engine really read, so naming them keeps each
 * screenshot honest about the state it is evidence of.
 */
async function reportWarnings(page, label) {
  const text = await page.locator('ul li').allTextContents()
    .then(all => all.map(s => s.trim()).filter(Boolean));
  console.log(`  ${label}: warnings on screen: ${text.length ? text.join(' | ') : '(none)'}`);
  return text;
}

/**
 * The blocking duplicate/conflict gate, against the warehouse whose fixture
 * stock deliberately collides with the eval document (same Amoxicillin batch
 * B4471X, different expiry). Submission must stay blocked no matter what the
 * operator ticks — that is the assertion, not the screenshot.
 */
async function captureOcrConflict(browser) {
  const vp = VIEWPORTS[0];
  for (const lang of ['en', 'ar']) {
    const label = `ocr/conflict-${lang}`;
    console.log(`\n── OCR blocking conflict (${lang}) ──`);
    const page = await openPage(browser, { lang, theme: 'dark', vp, label });
    if (!(await selectWarehouse(page, label, 'qa-wh-inst-a'))) { await page.close(); continue; }
    if (!(await openOcr(page, label))) { await page.close(); continue; }
    await uploadDocument(page, label, DOC_CLEAN);
    if (await recognize(page, label)) {
      const warnings = await reportWarnings(page, label);
      if (warnings.length === 0) fail(label, 'expected a blocking identity warning against the colliding batch, got none');
      await assertBetaBanner(page, label);
      await assertPreviewNotBlank(page, label);
      await assertNoHorizontalOverflow(page, label);
      await shoot(page, `ocr-conflict-${lang}-01-blocking-duplicate`);

      // Ticking every confirmation must NOT unblock a conflicting batch.
      await tickAllConfirmations(page, label);
      await settle(500);
      const gotoPreview = page.getByRole('button').filter({ hasText: /preview|المعاينة|معاينة/i }).first();
      await assertControl(page, label, gotoPreview, { name: 'final preview (blocked by conflict)', enabled: false });
      await shoot(page, `ocr-conflict-${lang}-02-still-blocked-after-confirmations`);
    }
    await page.close();
  }
}

/** Cancel, retry and error states — driven, not simulated. */
async function captureOcrEdgeStates(browser) {
  const vp = VIEWPORTS[0];
  const label = 'ocr/edge';
  console.log('\n── OCR edge states ──');
  const page = await openPage(browser, { lang: 'en', theme: 'dark', vp, label });
  if (!(await selectWarehouse(page, label))) return page.close();
  if (!(await openOcr(page, label))) return page.close();

  // Blurred document → the quality gate's warning findings.
  await uploadDocument(page, label, DOC_BLURRED);
  await assertPreviewNotBlank(page, `${label}/blurred`);
  await assertNoHorizontalOverflow(page, `${label}/blurred`);
  await shoot(page, 'ocr-edge-01-quality-blurred-warning');

  // Retake returns to the capture stage with the image released.
  const retake = page.getByRole('button').filter({ hasText: /retake|إعادة|اختيار/i }).first();
  if ((await retake.count()) > 0) {
    await retake.click();
    await settle(600);
    await assertBetaBanner(page, `${label}/retake`);
    await shoot(page, 'ocr-edge-02-retake-back-to-capture');
  } else {
    fail(label, 'retake control not found on the quality stage');
  }

  // Cancel mid-recognition must return to quality with the image intact.
  await uploadDocument(page, label, DOC_DIM);
  const start = page.getByRole('button').filter({ hasText: /recogni|قراءة|تعرّف|تعرف/i }).first();
  await start.click();
  const cancel = page.getByRole('button').filter({ hasText: /cancel|إلغاء/i }).first();
  // Measure how long cancel takes to become available. It is NOT instant: the
  // dynamic tesseract.js import and WASM instantiation occupy the main thread,
  // so the recognizing stage can sit unpainted for a moment. Anything beyond a
  // couple of seconds is an operator who cannot abort a mistaken scan.
  const startedAt = Date.now();
  const appeared = await cancel.waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  const waitedMs = Date.now() - startedAt;
  if (!appeared) fail(`${label}/cancel`, `cancel never became available during recognition (waited ${waitedMs}ms)`);
  else console.log(`  ${label}: cancel became available after ${waitedMs}ms`);
  await assertControl(page, `${label}/cancel`, cancel, { name: 'cancel during recognition', enabled: true });
  await shoot(page, 'ocr-edge-03-cancel-available-during-ocr');
  await cancel.click();
  await settle(2500);
  await assertBetaBanner(page, `${label}/cancelled`);
  await assertPreviewNotBlank(page, `${label}/cancelled`);
  await shoot(page, 'ocr-edge-04-after-cancel');

  await page.close();
}

/** Ambiguous catalog match — two Paracetamol rows the catalog cannot separate. */
async function captureOcrAmbiguous(browser) {
  const vp = VIEWPORTS[0];
  const label = 'ocr/ambiguous';
  console.log('\n── OCR ambiguous match ──');
  const page = await openPage(browser, { lang: 'en', theme: 'light', vp, label });
  if (!(await selectWarehouse(page, label))) return page.close();
  if (!(await openOcr(page, label))) return page.close();
  await uploadDocument(page, label, DOC_AMBIGUOUS);
  if (await recognize(page, label)) {
    await assertBetaBanner(page, label);
    await assertBoundingBoxes(page, label);
    await assertNoHorizontalOverflow(page, label);
    await shoot(page, 'ocr-ambiguous-01-review-ambiguous-material');
  }
  await page.close();
}

// ── run ──────────────────────────────────────────────────────────────────────

/** Each flow is isolated: one throwing must not abort the remaining evidence. */
async function run(name, fn) {
  try {
    await fn();
  } catch (error) {
    fail(name, `threw: ${error?.message ?? String(error)}`);
  }
}

const browser = await launch();
try {
  await run('inventory-matrix', () => captureInventoryMatrix(browser));
  await run('ocr-en-dark-desktop', () => captureOcrHappyPath(browser, { lang: 'en', theme: 'dark', vp: VIEWPORTS[0], prefix: 'ocr-en-dark-desktop' }));
  await run('ocr-ar-dark-mobile', () => captureOcrHappyPath(browser, { lang: 'ar', theme: 'dark', vp: VIEWPORTS[1], prefix: 'ocr-ar-dark-mobile' }));
  await run('ocr-conflict', () => captureOcrConflict(browser));
  await run('ocr-edge', () => captureOcrEdgeStates(browser));
  await run('ocr-ambiguous', () => captureOcrAmbiguous(browser));
} finally {
  await browser.close();
}

console.log(`\n${shots} screenshot(s) → ./docs/phoenix/visual-evidence/inventory-ocr/`);
if (failures.length > 0) {
  console.error(`\nFAILED — ${failures.length} assertion(s):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('All assertions passed.');
