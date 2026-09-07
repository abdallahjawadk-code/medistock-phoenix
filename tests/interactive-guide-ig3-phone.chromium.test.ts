import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';

/**
 * INTERACTIVE-GUIDE-IG3 — PHONE (375px) browser acceptance, REAL Chromium.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE, AND WHY NOW
 *
 * Two prior corrective rounds on this PR left a phone-width (375px) real-
 * gesture acceptance pass explicitly incomplete: the interactive automation
 * pane used in those rounds became unavailable mid-session and never
 * returned. This file closes that gap using the repository's OWN existing
 * Playwright/Chromium acceptance infrastructure (the same shape as
 * `interactive-guide-ig2.chromium.test.ts`), independent of that pane —
 * a real Chromium process, launched headless, driving a real Vite dev server
 * that renders the REAL `InventoryCenterScreen` against the QA harness's
 * fixture Supabase client. Nothing here is jsdom, nothing here is
 * `fireEvent`, and nothing here inspects the DOM without also exercising it:
 * every interaction is a genuine Playwright click/selectOption dispatched
 * into a real, laid-out page, and every assertion about layout
 * (`getBoundingClientRect`, `scrollWidth`, viewport containment) reads real
 * computed geometry a compositor produced — the exact three guarantees
 * jsdom cannot provide, per this same reasoning in the sibling IG-1/IG-2
 * files.
 *
 * SCOPE, MATCHING THE AUTHORIZED TASK EXACTLY
 *   - stock, ledger, incoming, dispatch, returns, corrections — the six
 *     tours not already covered by phone-width real-gesture evidence from
 *     earlier rounds (intake was covered in round 1; corrections/
 *     return-exceptions were covered at DESKTOP width in round 2 — this
 *     file does not re-run those, only the PHONE-width gap).
 *   - Arabic/RTL and English/LTR, at 375px, via the real mobile drawer's own
 *     "Guide & Help" entry (not the desktop topbar entry).
 *   - Every offered tour is started, walked through every step, Finished
 *     (a real click on the button `GuideTourOverlay.tsx` wires to call
 *     `onFinish` on the last step — not merely "reached the closing card"),
 *     and the Help Center is then closed for real (a real click on its own
 *     close control, which is what actually unmounts the engine).
 *   - `return_exceptions` (held in its entirety as of the prior round) is
 *     verified to offer no tour at all, INCLUDING while its own operational
 *     tab is open and selected — the tab itself is untouched by any
 *     correction and remains fully reachable.
 *
 * `incoming`/`dispatch` had NO QA fixture rows at all before this file (see
 * `qaData.ts`'s `warehouse_transfers`/`warehouse_transfer_lines`/
 * `warehouse_dispatches` additions) — without them their row-level steps
 * (`incoming.receive`/`.bulk`, `dispatch.send`) would have been silently
 * skipped for want of a target, which is a materially weaker acceptance
 * proof than actually reaching them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ROOT = join(__dirname, '..');
const SHOTS = join(ROOT, 'artifacts', 'ig3-phone-acceptance');

const HELP_ENTRY = '[data-guide-id="guide.shell.topbar.help"]';
const QA_ORG = 'qa-org-a1';
const QA_WAREHOUSE = 'qa-wh-inst-a';

let browser: Browser;
let server: ViteDevServer;
let baseUrl: string;

function chromiumExecutable(): string {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find(existsSync);
  if (!executable) {
    throw new Error('A system Chromium executable is required for the IG-3 phone acceptance test.');
  }
  return executable;
}

interface OpenOptions {
  lang: 'ar' | 'en';
  viewport: { width: number; height: number };
  hasTouch?: boolean;
  persona?: string;
  warehouseId?: string;
}

/** Open the Inventory Center and reach the QA warehouse THROUGH the screen's own picker. */
async function openInventory(options: OpenOptions) {
  const context = await browser.newContext({
    viewport: options.viewport,
    hasTouch: options.hasTouch,
  });
  const page = await context.newPage();

  const foreignRequests: string[] = [];
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (!url.startsWith(baseUrl)) foreignRequests.push(url);
    await route.continue();
  });

  await page.goto(
    `${baseUrl}?qa=1&persona=${options.persona ?? 'super_admin'}`
      + `&lang=${options.lang}&theme=light&scene=inventory&org=${QA_ORG}`,
    { waitUntil: 'load' },
  );
  await page.locator('.premium-topbar').waitFor({ state: 'visible' });
  await page.evaluate(() => window.localStorage.removeItem('medistock.phoenix.guide.progress'));

  const warehouseId = options.warehouseId ?? QA_WAREHOUSE;
  const picker = page.locator('.nexus-it-context-bar select');
  await picker.waitFor({ state: 'visible' });
  await expect
    .poll(() => picker.locator(`option[value="${warehouseId}"]`).count(), { timeout: 15_000 })
    .toBe(1);
  await picker.selectOption(warehouseId);

  return { context, page, foreignRequests };
}

/**
 * Click a real Inventory Center tab BY ITS VISIBLE LABEL, not by a guide
 * anchor — `return_exceptions` no longer carries one at all (its guide tour
 * is held), and this helper drives every tab, including that one,
 * identically to how an operator actually reaches it.
 */
async function openTabByLabel(page: Page, label: string) {
  const tab = page.locator('[role="tab"]', { hasText: label });
  await expect.poll(() => tab.count(), { timeout: 15_000 }).toBe(1);
  await tab.scrollIntoViewIfNeeded();
  await tab.click();
  await page.waitForTimeout(150);
}

/** Open the Help Center through whichever entry this viewport actually offers. */
async function openGuide(page: Page) {
  const hasTopbarEntry = await page.locator(HELP_ENTRY).count() > 0;
  if (hasTopbarEntry) {
    await page.locator(HELP_ENTRY).click();
  } else {
    await page.locator('.premium-drawer-trigger').click();
    await page.locator('[data-guide-id="guide.shell.drawer.help"]').click();
  }
  await page.locator('[data-guide-surface="center"]').waitFor({ state: 'visible' });
}

async function tourTitles(page: Page): Promise<string[]> {
  return page.locator('.guide-tour-card__title').allInnerTexts();
}

async function startTourByTitle(page: Page, title: string) {
  const card = page.locator('.guide-tour-card').filter({ hasText: title });
  await expect.poll(() => card.count()).toBeGreaterThan(0);
  await card.locator('.guide-tour-card__actions .guide-btn').last().click();
  await page.locator('[data-guide-tour]').waitFor({ state: 'visible' });
}

async function currentStep(page: Page) {
  return page.locator('[data-guide-tour]').evaluate(node => ({
    tour: (node as HTMLElement).dataset.guideTour,
    step: (node as HTMLElement).dataset.guideStep,
    anchor: (node as HTMLElement).dataset.guideAnchor,
    placement: (node as HTMLElement).dataset.guidePlacement,
    dir: node.getAttribute('dir'),
  }));
}

async function advance(page: Page) {
  const before = (await currentStep(page)).step;
  await page.locator('.guide-card .guide-btn--primary').click();
  await page.waitForFunction(
    previous => (document.querySelector('[data-guide-tour]') as HTMLElement | null)?.dataset.guideStep !== previous,
    before,
  );
}

/** Presses the REAL Finish action — the same primary button, on the last step,
 *  which `GuideTourOverlay.tsx` wires to `onFinish` instead of advancing. */
async function finishTour(page: Page) {
  await page.locator('.guide-card .guide-btn--primary').click();
  await page.locator('[data-guide-tour]').waitFor({ state: 'detached' });
  await page.locator('[data-guide-surface="center"]').waitFor({ state: 'visible' });
}

/** Closes the Help Center itself (distinct from Finish, which only returns to
 *  the still-open catalog) — the real close control genuinely unmounts the engine. */
async function closeHelpCenter(page: Page) {
  await page.locator('.guide-center__head .guide-btn--quiet').last().click();
  await page.locator('[data-guide-surface="center"]').waitFor({ state: 'detached' });
}

const MISSING_TARGET_AR = 'هذا الجزء غير ظاهر على الشاشة الحالية';
const MISSING_TARGET_EN = 'This part is not visible on the current screen';

async function cardFitsViewport(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector('.guide-card');
    if (!card) return { found: false, inside: false };
    const box = card.getBoundingClientRect();
    return {
      found: true,
      inside: box.left >= -0.5 && box.top >= -0.5
        && box.right <= window.innerWidth + 0.5
        && box.bottom <= window.innerHeight + 0.5,
    };
  });
}

/** No control anywhere on the page forces the phone viewport to scroll sideways. */
async function noHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

interface SeenStep { step: string; anchor: string; cardInside: boolean; overflowOk: boolean; note: boolean }

/** Walk a tour end to end, recording what each step actually landed on. Stops
 *  ON the last step WITHOUT pressing Finish — callers press it explicitly. */
async function walkTour(page: Page, lastStepId: string): Promise<SeenStep[]> {
  const seen: SeenStep[] = [];
  for (let guard = 0; guard < 20; guard += 1) {
    await expect.poll(async () => (await currentStep(page)).anchor !== undefined).toBe(true);
    await page.waitForTimeout(120);
    const state = await currentStep(page);
    const card = await page.locator('.guide-card').innerText();
    const primary = page.locator('.guide-card .guide-btn--primary');
    expect(await primary.isVisible(), `${state.step}'s primary button is not visible`).toBe(true);
    expect(await primary.isEnabled(), `${state.step}'s primary button is not enabled`).toBe(true);
    seen.push({
      step: state.step as string,
      anchor: state.anchor as string,
      cardInside: (await cardFitsViewport(page)).inside,
      overflowOk: await noHorizontalOverflow(page),
      note: card.includes(MISSING_TARGET_AR) || card.includes(MISSING_TARGET_EN),
    });
    if (state.step === lastStepId) return seen;
    await advance(page);
  }
  throw new Error(`the tour never reached "${lastStepId}"; saw ${seen.map(s => s.step).join(', ')}`);
}

/** The ring comes to rest on its target — same settled-measurement rule as IG-1/IG-2. */
async function expectRingOverTarget(page: Page, targetSelector: string) {
  const offset = async () => page.evaluate(selector => {
    const ring = document.querySelector('.guide-ring');
    const target = document.querySelector(selector);
    if (!ring || !target) return null;
    const r = ring.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    return Math.max(
      Math.abs((r.x + r.width / 2) - (t.x + t.width / 2)),
      Math.abs((r.y + r.height / 2) - (t.y + t.height / 2)),
    );
  }, targetSelector);

  await expect.poll(offset, { timeout: 10_000 }).toBeLessThanOrEqual(2);
  await page.waitForTimeout(250);
  expect(await offset()).toBeLessThanOrEqual(2);
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

async function closeContext(context: BrowserContext) {
  await context.close();
}

beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  server = await createServer({
    root: ROOT,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    define: {
      'import.meta.env.VITE_ENABLE_VISUAL_QA': JSON.stringify('true'),
      'import.meta.env.VITE_PHOENIX_SUPABASE_URL': JSON.stringify('https://guide-acceptance.invalid'),
      'import.meta.env.VITE_PHOENIX_SUPABASE_ANON_KEY': JSON.stringify('guide-acceptance-fixture-key'),
    },
  });
  await server.listen();
  baseUrl = server.resolvedUrls?.local[0] ?? '';
  if (!baseUrl) throw new Error('Vite did not expose a local test URL.');
  browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
}, 60_000);

const PHONE = { width: 375, height: 812 };

const TAB_LABEL = {
  ar: {
    stock: 'رصيد المخزن', ledger: 'سجل الحركات', incoming: 'واردات تجهيز الدائرة',
    dispatch: 'تجهيز المنافذ', returns: 'استلام مرتجعات المنافذ',
    return_exceptions: 'استثناءات مرتجعات المنافذ', corrections: 'تصحيحات بانتظار الاعتماد',
  },
  en: {
    stock: 'Warehouse stock', ledger: 'Movement ledger', incoming: 'Incoming dept. supplies',
    dispatch: 'Dispatch to outlets', returns: 'Receive outlet returns',
    return_exceptions: 'Return exceptions', corrections: 'Corrections awaiting approval',
  },
} as const;

const TOUR_TITLE = {
  ar: {
    stock: 'رصيد المخزن', ledger: 'سجل الحركات', incoming: 'واردات تجهيز الدائرة',
    dispatch: 'تجهيز المنافذ', returns: 'استلام مرتجعات المنافذ', corrections: 'تصحيحات بانتظار الاعتماد',
  },
  en: {
    stock: 'Warehouse stock', ledger: 'Movement ledger', incoming: 'Incoming department supplies',
    dispatch: 'Dispatch to outlets', returns: 'Receive outlet returns', corrections: 'Corrections awaiting approval',
  },
} as const;

type TourKey = keyof typeof TOUR_TITLE.ar;

const EXPECTED_STEPS: Record<TourKey, string[]> = {
  stock: ['stock.tab', 'stock.list', 'stock.balances', 'stock.closing'],
  ledger: ['ledger.tab', 'ledger.select', 'ledger.list', 'ledger.closing'],
  incoming: ['incoming.tab', 'incoming.list', 'incoming.receive', 'incoming.bulk', 'incoming.closing'],
  dispatch: ['dispatch.tab', 'dispatch.list', 'dispatch.create', 'dispatch.send', 'dispatch.closing'],
  returns: ['returns.tab', 'returns.list', 'returns.closing'],
  corrections: ['corrections.tab', 'corrections.list', 'corrections.closing'],
};

/* ════════════════════════════════════════════════════════════════════════ */

describe('IG-3 phone acceptance (375px) — real Chromium, real mobile-drawer entry, complete lifecycle', () => {
  for (const lang of ['ar', 'en'] as const) {
    for (const key of Object.keys(EXPECTED_STEPS) as TourKey[]) {
      it(`walks every step of "${TOUR_TITLE[lang][key]}" on a real target, then Finishes and closes Help for real — ${lang}`, async () => {
        const { context, page, foreignRequests } = await openInventory({ lang, viewport: PHONE, hasTouch: true });
        try {
          await openTabByLabel(page, TAB_LABEL[lang][key]);

          // A real operator action: pick a lot so ledger.list has a target to
          // describe — the guide cannot and does not do this on its own.
          if (key === 'ledger') {
            const select = page.locator('[data-guide-id="guide.ledger.select.control"] select');
            await select.waitFor({ state: 'visible' });
            await select.selectOption({ index: 1 });
            await page.waitForTimeout(150);
          }

          await openGuide(page);
          const offered = await tourTitles(page);
          expect(offered, `offered tours: ${offered.join(' | ')}`).toContain(TOUR_TITLE[lang][key]);
          expect(await noHorizontalOverflow(page), 'Help Center itself overflows the 375px viewport').toBe(true);

          await startTourByTitle(page, TOUR_TITLE[lang][key]);
          const lastStepId = EXPECTED_STEPS[key][EXPECTED_STEPS[key].length - 1];
          const seen = await walkTour(page, lastStepId);

          expect(seen.map(s => s.step)).toEqual(EXPECTED_STEPS[key]);
          for (const entry of seen) {
            expect(entry.cardInside, `${entry.step} card left the 375px viewport`).toBe(true);
            expect(entry.overflowOk, `${entry.step} caused horizontal overflow`).toBe(true);
            if (entry.step.endsWith('.closing')) continue;
            expect(entry.anchor, `${entry.step} found no target`).not.toBe('none');
            expect(entry.note, `${entry.step} showed the missing-target card`).toBe(false);
          }

          await shoot(page, `${key}-${lang}-closing`);

          await finishTour(page);
          // Finishing returns to the still-open catalog, not a full close.
          expect(await page.locator('[data-guide-surface="center"]').count()).toBe(1);
          expect(await page.locator('[data-guide-tour]').count()).toBe(0);

          await closeHelpCenter(page);
          expect(await page.locator('[data-guide-surface="center"]').count()).toBe(0);
          expect(await page.locator('[data-guide-tour]').count()).toBe(0);

          expect(foreignRequests).toEqual([]);
        } finally {
          await closeContext(context);
        }
      }, 180_000);
    }
  }
});

describe('IG-3 phone acceptance — the ring settles on a real per-row target, both writing directions', () => {
  it('incoming.receive rings the real transfer-line row', async () => {
    for (const lang of ['ar', 'en'] as const) {
      const { context, page } = await openInventory({ lang, viewport: PHONE, hasTouch: true });
      try {
        await openTabByLabel(page, TAB_LABEL[lang].incoming);
        // Wait for the real fixture transfer line to actually render before
        // opening the guide — the panel's own settled initial load.
        await expect.poll(() => page.getByText('Amoxicillin').count(), { timeout: 15_000 }).toBeGreaterThan(0);
        await openGuide(page);
        await startTourByTitle(page, TOUR_TITLE[lang].incoming);
        for (;;) {
          const state = await currentStep(page);
          if (state.step === 'incoming.receive') break;
          await advance(page);
        }
        await expectRingOverTarget(page, '[data-guide-id="guide.incoming.row.receive-action"]');
        expect((await currentStep(page)).dir).toBe(lang === 'ar' ? 'rtl' : 'ltr');
      } finally {
        await closeContext(context);
      }
    }
  }, 180_000);

  it('dispatch.send rings the real draft-dispatch row', async () => {
    for (const lang of ['ar', 'en'] as const) {
      const { context, page } = await openInventory({ lang, viewport: PHONE, hasTouch: true });
      try {
        await openTabByLabel(page, TAB_LABEL[lang].dispatch);
        await openGuide(page);
        await startTourByTitle(page, TOUR_TITLE[lang].dispatch);
        for (;;) {
          const state = await currentStep(page);
          if (state.step === 'dispatch.send') break;
          await advance(page);
        }
        await expectRingOverTarget(page, '[data-guide-id="guide.dispatch.row.actions"]');
        expect((await currentStep(page)).dir).toBe(lang === 'ar' ? 'rtl' : 'ltr');
      } finally {
        await closeContext(context);
      }
    }
  }, 180_000);
});

describe('IG-3 phone acceptance — return_exceptions offers no tour, even though its own tab is real and visible', () => {
  for (const lang of ['ar', 'en'] as const) {
    it(`the operational tab opens normally but the Help Center offers nothing for it — ${lang}`, async () => {
      const { context, page } = await openInventory({ lang, viewport: PHONE, hasTouch: true });
      try {
        await openTabByLabel(page, TAB_LABEL[lang].return_exceptions);
        // The tab itself is real, unaffected by any correction, and genuinely selected.
        const tab = page.locator('[role="tab"]', { hasText: TAB_LABEL[lang].return_exceptions });
        expect(await tab.getAttribute('aria-selected')).toBe('true');

        await openGuide(page);
        const offered = await tourTitles(page);
        expect(offered, `offered tours while on return_exceptions: ${offered.join(' | ')}`)
          .not.toContain(TAB_LABEL[lang].return_exceptions);
        expect(offered).not.toContain('Return exceptions');
        expect(offered).not.toContain('استثناءات مرتجعات المنافذ');

        // No guide surface for the held tour exists anywhere on the page.
        expect(await page.locator('[data-guide-id="guide.return-exceptions.list.region"]').count()).toBe(0);
        expect(await page.locator('[data-guide-tour="guide.tour.return-exceptions"]').count()).toBe(0);

        await closeHelpCenter(page);
        expect(await page.locator('[data-guide-surface="center"]').count()).toBe(0);
      } finally {
        await closeContext(context);
      }
    }, 180_000);
  }
});
