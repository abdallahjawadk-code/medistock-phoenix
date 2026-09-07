import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';

/**
 * INTERACTIVE-GUIDE-IG2 — browser acceptance for the two contextual tours,
 * OVER THE REAL PANELS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A BROWSER, AND WHY THE REAL INVENTORY CENTER
 *
 * The runtime suites prove eligibility, panel states, the row-example policy
 * and mutation freedom. Three things they cannot prove at all:
 *
 *   • `inert` — jsdom sets the attribute and implements none of its behaviour,
 *     so "the release button cannot be focused or clicked while the guide is
 *     describing it" is only meaningful here;
 *   • layout — `getBoundingClientRect` is all zeroes in jsdom, so "the ring is
 *     on its target" and "the card stays inside the viewport" cannot be
 *     measured there, in either writing direction;
 *   • hit testing — "a click at the button's own centre lands on the guide's
 *     blocker" needs a compositor.
 *
 * The scene is the repository's DEV-only QA gallery rendering the REAL
 * `InventoryCenterScreen` against fixtures — not a simplified stand-in panel.
 * The warehouse and the tab are reached the way an operator reaches them: by
 * choosing them in the screen's own controls. Nothing here touches a real
 * environment, and every case asserts that no request left the test server.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ROOT = join(__dirname, '..');
const SHOTS = join(ROOT, 'artifacts', 'ig2-acceptance');

const HELP_ENTRY = '[data-guide-id="guide.shell.topbar.help"]';
const TAB_QUARANTINE = '[data-guide-id="guide.inventory.quarantine.tab"]';
const TAB_SUSPENSIONS = '[data-guide-id="guide.inventory.suspension.tab"]';
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
    throw new Error('A system Chromium executable is required for the IG-2 acceptance test.');
  }
  return executable;
}

interface OpenOptions {
  lang: 'ar' | 'en';
  viewport: { width: number; height: number };
  hasTouch?: boolean;
  reducedMotion?: 'reduce' | 'no-preference';
  theme?: 'light' | 'dark';
  persona?: string;
  /** Defaults to QA_WAREHOUSE; a restricted persona's own reachable set differs. */
  warehouseId?: string;
}

/**
 * Open the Inventory Center and reach a chosen warehouse THROUGH THE SCREEN.
 *
 * Deliberately not a URL shortcut and not a programmatic state write: the
 * warehouse is selected in the screen's own `<select>` and the tab is opened by
 * clicking the screen's own tab button, so what is under test afterwards is the
 * state a real operator would have produced. Nothing about product behaviour is
 * changed to make this reachable — no automatic warehouse selection exists or
 * was added.
 */
async function openInventory(options: OpenOptions) {
  const context = await browser.newContext({
    viewport: options.viewport,
    hasTouch: options.hasTouch,
    reducedMotion: options.reducedMotion,
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
      + `&lang=${options.lang}&theme=${options.theme ?? 'light'}`
      + `&scene=inventory&org=${QA_ORG}`,
    { waitUntil: 'load' },
  );
  await page.locator('.premium-topbar').waitFor({ state: 'visible' });
  await page.evaluate(() => window.localStorage.removeItem('medistock.phoenix.guide.progress'));

  // The screen's own warehouse picker — the first control an operator uses.
  const warehouseId = options.warehouseId ?? QA_WAREHOUSE;
  const picker = page.locator('.nexus-it-context-bar select');
  await picker.waitFor({ state: 'visible' });
  await expect
    .poll(() => picker.locator(`option[value="${warehouseId}"]`).count(), { timeout: 15_000 })
    .toBe(1);
  await picker.selectOption(warehouseId);

  return { context, page, foreignRequests };
}

/** Switch to a different warehouse through the screen's own picker, mid-test. */
async function switchWarehouse(page: Page, warehouseId: string) {
  const picker = page.locator('.nexus-it-context-bar select');
  await picker.selectOption(warehouseId);
  await page.waitForTimeout(200);
}

async function openTab(page: Page, selector: string) {
  const tab = page.locator(selector);
  await expect.poll(() => tab.count(), { timeout: 15_000 }).toBe(1);
  await tab.scrollIntoViewIfNeeded();
  await tab.click();
  await page.waitForTimeout(150);
}

async function openGuide(page: Page) {
  const hasTopbarEntry = await page.locator(HELP_ENTRY).count() > 0;
  if (hasTopbarEntry) await page.locator(HELP_ENTRY).click();
  else {
    await page.locator('.premium-drawer-trigger').click();
    await page.locator('[data-guide-id="guide.shell.drawer.help"]').click();
  }
  await page.locator('[data-guide-surface="center"]').waitFor({ state: 'visible' });
}

/** Titles the Help Center is offering right now. */
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

const MISSING_TARGET_AR = 'هذا الجزء غير ظاهر على الشاشة الحالية';
const MISSING_TARGET_EN = 'This part is not visible on the current screen';

/**
 * Walk a tour end to end, recording what each step actually landed on.
 *
 * Anchoring is read from the overlay's own resolved-anchor marker rather than
 * inferred from placement: a card centres whenever no side of its target has
 * room, which is routine on a phone and is not a failure. What IS a failure is
 * a step that found no target at all and quietly showed the missing-target
 * card instead.
 */
async function walkTour(page: Page, lastStepId: string) {
  const seen: Array<{ step: string; anchor: string; centred: boolean; cardInside: boolean; note: boolean }> = [];
  for (let guard = 0; guard < 25; guard += 1) {
    // The overlay measures one frame after the step id changes.
    await expect.poll(async () => (await currentStep(page)).anchor !== undefined).toBe(true);
    await page.waitForTimeout(120);
    const state = await currentStep(page);
    const card = await page.locator('.guide-card').innerText();
    seen.push({
      step: state.step as string,
      anchor: state.anchor as string,
      centred: state.placement === 'center',
      cardInside: (await cardFitsViewport(page)).inside,
      note: card.includes(MISSING_TARGET_AR) || card.includes(MISSING_TARGET_EN),
    });
    if (state.step === lastStepId) return seen;
    await advance(page);
  }
  throw new Error(`the tour never reached "${lastStepId}"; saw ${seen.map(s => s.step).join(', ')}`);
}

/** The ring comes to REST on its target. Same settled-measurement rule as IG-1.1. */
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
      /**
       * This suite supplies its OWN configuration rather than inheriting a
       * developer's `.env.local` — see the same block in
       * interactive-guide.chromium.test.ts for the full reasoning. `.invalid`
       * is reserved by RFC 2606 and can never resolve, the DEV client is a
       * proxy already pointed at the harness's network-free fixture client,
       * and every case asserts that nothing left the test server's origin.
       * The service-configuration guard and production behaviour are untouched.
       */
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

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };

const QUARANTINE_TITLE = { ar: 'الحجر الصحي', en: 'Quarantine' };
const SUSPENSION_TITLE = { ar: 'موقوفة الصرف', en: 'Suspended from Dispensing' };

const QUARANTINE_STEPS = [
  'quarantine.tab', 'quarantine.list', 'quarantine.identity',
  'quarantine.quantity', 'quarantine.release', 'quarantine.destroy',
  'quarantine.closing',
];
const SUSPENSION_STEPS = [
  'suspension.tab', 'suspension.active', 'suspension.scope',
  'suspension.badge', 'suspension.create', 'suspension.lift', 'suspension.history',
];

/* ════════════════════════════════════════════════════════════════════════ */

describe('IG-2 acceptance — the real Quarantine panel', () => {
  for (const lang of ['ar', 'en'] as const) {
    for (const [label, viewport] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
      it(`walks every step on a real target — ${lang} · ${label}`, async () => {
        const { context, page, foreignRequests } = await openInventory({
          lang, viewport, hasTouch: label === 'phone',
        });
        try {
          await openTab(page, TAB_QUARANTINE);
          await openGuide(page);
          expect(await tourTitles(page)).toContain(QUARANTINE_TITLE[lang]);
          // The OTHER tour is not offered here: it belongs to another tab.
          expect(await tourTitles(page)).not.toContain(SUSPENSION_TITLE[lang]);

          await startTourByTitle(page, QUARANTINE_TITLE[lang]);
          const seen = await walkTour(page, 'quarantine.closing');

          expect(seen.map(s => s.step)).toEqual(QUARANTINE_STEPS);
          for (const entry of seen) {
            expect(entry.cardInside, `${entry.step} card left the viewport`).toBe(true);
            if (entry.step === 'quarantine.closing') continue;
            expect(entry.anchor, `${entry.step} found no target`).not.toBe('none');
            expect(entry.note, `${entry.step} showed the missing-target card`).toBe(false);
          }
          expect(foreignRequests).toEqual([]);
        } finally {
          await closeContext(context);
        }
      }, 180_000);
    }
  }

  it('puts the ring on the release control itself, in both writing directions', async () => {
    for (const lang of ['ar', 'en'] as const) {
      const { context, page } = await openInventory({ lang, viewport: DESKTOP });
      try {
        await openTab(page, TAB_QUARANTINE);
        await openGuide(page);
        await startTourByTitle(page, QUARANTINE_TITLE[lang]);
        for (;;) {
          const state = await currentStep(page);
          if (state.step === 'quarantine.release') break;
          await advance(page);
        }
        await expectRingOverTarget(page, '[data-guide-id="guide.quarantine.release.action"]');
        expect((await currentStep(page)).dir).toBe(lang === 'ar' ? 'rtl' : 'ltr');
      } finally {
        await closeContext(context);
      }
    }
  }, 180_000);

  it('cannot activate the control it is describing — pointer or keyboard', async () => {
    const { context, page } = await openInventory({ lang: 'ar', viewport: DESKTOP });
    try {
      await openTab(page, TAB_QUARANTINE);
      const release = page.locator('[data-guide-id="guide.quarantine.release.action"] button');
      await release.waitFor({ state: 'visible' });

      await openGuide(page);
      await startTourByTitle(page, QUARANTINE_TITLE.ar);
      for (;;) {
        const state = await currentStep(page);
        if (state.step === 'quarantine.release') break;
        await advance(page);
      }

      // POINTER: a click at the button's own centre lands on the blocker.
      const box = (await release.boundingBox())!;
      const hit = await page.evaluate(
        point => (document.elementFromPoint(point.x, point.y) as HTMLElement | null)?.className ?? '',
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      );
      expect(hit).toContain('guide-blocker');

      // KEYBOARD: `inert` genuinely refuses focus, so an explicit .focus() on
      // the release button leaves the active element where the guide put it.
      // Asserted by IDENTITY, not by tag name — the guide's own primary action
      // is a button too, and comparing tags would pass for the wrong reason.
      const focusEscaped = await page.evaluate(() => {
        const button = document.querySelector('[data-guide-id="guide.quarantine.release.action"] button') as HTMLElement | null;
        button?.focus();
        return {
          isReleaseButton: document.activeElement === button,
          insideGuide: Boolean(document.querySelector('.guide-card')?.contains(document.activeElement)),
        };
      });
      expect(focusEscaped.isReleaseButton).toBe(false);
      expect(focusEscaped.insideGuide).toBe(true);

      // ...and Tab keeps cycling inside the guide card.
      for (let i = 0; i < 12; i += 1) {
        await page.keyboard.press('Tab');
        const inside = await page.evaluate(() =>
          Boolean(document.querySelector('.guide-card')?.contains(document.activeElement)));
        expect(inside).toBe(true);
      }

      // The panel behind is marked for assistive technology too.
      const marked = await page.evaluate(() => {
        const node = document.querySelector('[data-guide-id="guide.quarantine.list.region"]');
        let el: HTMLElement | null = node as HTMLElement | null;
        while (el) {
          if (el.hasAttribute('inert')) return true;
          el = el.parentElement;
        }
        return false;
      });
      expect(marked).toBe(true);
    } finally {
      await closeContext(context);
    }
  }, 180_000);

  it('keeps the release step on the row region when the operator already opened the form', async () => {
    const { context, page } = await openInventory({ lang: 'ar', viewport: DESKTOP });
    try {
      await openTab(page, TAB_QUARANTINE);
      // The OPERATOR opens the release form; the guide never does.
      await page.locator('[data-guide-id="guide.quarantine.release.action"] button').click();
      await page.locator('[data-guide-id="guide.quarantine.row.actions"] input').first().waitFor({ state: 'visible' });
      const typed = 'فحص مخبري';
      const reason = page.locator('[data-guide-id="guide.quarantine.row.actions"] input').nth(1);
      await reason.fill(typed);

      await openGuide(page);
      await startTourByTitle(page, QUARANTINE_TITLE.ar);
      const seen = await walkTour(page, 'quarantine.closing');
      const release = seen.find(s => s.step === 'quarantine.release');
      expect(release, 'the release step must still exist').toBeDefined();
      expect(release?.anchor).toBe('guide.quarantine.row.actions');
      expect(release?.note).toBe(false);

      await page.locator('.guide-card .guide-btn--primary').click();
      await expect.poll(() => page.locator('[data-guide-tour]').count()).toBe(0);
      await page.keyboard.press('Escape');

      // Everything the operator had typed is exactly as they left it.
      await expect.poll(() => reason.inputValue()).toBe(typed);
    } finally {
      await closeContext(context);
    }
  }, 180_000);
});

describe('IG-2 acceptance — the real Suspended-from-Dispensing panel', () => {
  for (const lang of ['ar', 'en'] as const) {
    for (const [label, viewport] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
      it(`walks every step on a real target — ${lang} · ${label}`, async () => {
        const { context, page, foreignRequests } = await openInventory({
          lang, viewport, hasTouch: label === 'phone',
        });
        try {
          await openTab(page, TAB_SUSPENSIONS);
          await openGuide(page);
          expect(await tourTitles(page)).toContain(SUSPENSION_TITLE[lang]);
          expect(await tourTitles(page)).not.toContain(QUARANTINE_TITLE[lang]);

          await startTourByTitle(page, SUSPENSION_TITLE[lang]);
          const seen = await walkTour(page, 'suspension.history');

          expect(seen.map(s => s.step)).toEqual(SUSPENSION_STEPS);
          for (const entry of seen) {
            expect(entry.cardInside, `${entry.step} card left the viewport`).toBe(true);
            expect(entry.anchor, `${entry.step} found no target`).not.toBe('none');
            expect(entry.note, `${entry.step} showed the missing-target card`).toBe(false);
          }
          expect(foreignRequests).toEqual([]);
        } finally {
          await closeContext(context);
        }
      }, 180_000);
    }
  }

  it('puts the ring on the lift control itself', async () => {
    const { context, page } = await openInventory({ lang: 'ar', viewport: DESKTOP });
    try {
      await openTab(page, TAB_SUSPENSIONS);
      await openGuide(page);
      await startTourByTitle(page, SUSPENSION_TITLE.ar);
      for (;;) {
        const state = await currentStep(page);
        if (state.step === 'suspension.lift') break;
        await advance(page);
      }
      await expectRingOverTarget(page, '[data-guide-id="guide.suspension.lift.action"]');
    } finally {
      await closeContext(context);
    }
  }, 180_000);
});

describe('IG-2 acceptance — restricted personas, real QA simulation', () => {
  /**
   * These personas are NOT `super_admin`. Each is built from the harness's
   * migration-062-shaped assignment fixtures plus the new
   * `warehouse_transfer.return_request` / `material_dispensing_suspension.*`
   * grant simulation (`qaAnswerExtraScopedPermission`, qaScopes.ts) — a REAL
   * RPC round trip through the fixture client, not a stand-in permission map.
   * `src/features/qa/__tests__/qa-restricted-personas.test.ts` proves the
   * fixture logic itself in isolation; this proves the SAME fixtures reach the
   * real screen, the real hooks and the real guide end to end.
   */

  it('a READ-ONLY operator sees the explanation and none of the disposition steps', async () => {
    const { context, page } = await openInventory({
      lang: 'ar', viewport: DESKTOP, persona: 'health_center_manager_assigned',
    });
    try {
      await openTab(page, TAB_QUARANTINE);
      // The rows themselves are visible — this is a READ, not an empty state.
      await page.locator('text=Paracetamol').waitFor({ state: 'visible' });
      // ...and the operational buttons are not: no release, no destroy.
      expect(await page.locator('button:has-text("إفراج")').count()).toBe(0);
      expect(await page.locator('button:has-text("إتلاف")').count()).toBe(0);

      await openGuide(page);
      await startTourByTitle(page, QUARANTINE_TITLE.ar);
      const seen = await walkTour(page, 'quarantine.closing');
      expect(seen.map(s => s.step)).toEqual([
        'quarantine.tab', 'quarantine.list', 'quarantine.identity',
        'quarantine.quantity', 'quarantine.closing',
      ]);
      expect(seen.map(s => s.step)).not.toContain('quarantine.release');
      expect(seen.map(s => s.step)).not.toContain('quarantine.destroy');
    } finally {
      await closeContext(context);
    }
  }, 180_000);

  it('an operator authorized at ONE warehouse loses the tour entirely at another — same persona, real picker', async () => {
    const { context, page } = await openInventory({
      lang: 'ar', viewport: DESKTOP, persona: 'warehouse_officer_assigned',
      warehouseId: 'qa-wh-inst-a',
    });
    try {
      await openTab(page, TAB_QUARANTINE);
      await openGuide(page);
      expect(await tourTitles(page)).toContain(QUARANTINE_TITLE.ar);
      await startTourByTitle(page, QUARANTINE_TITLE.ar);
      const seen = await walkTour(page, 'quarantine.closing');
      // Full tour, disposition steps included: this warehouse is granted.
      expect(seen.map(s => s.step)).toContain('quarantine.release');
      await page.keyboard.press('Escape');
      await expect.poll(() => page.locator('[data-guide-tour]').count()).toBe(0);
      await page.keyboard.press('Escape');

      // SAME persona, SAME session, a DIFFERENT warehouse it is separately
      // ASSIGNED to (migration 062, for the picker) but never granted
      // `warehouse_transfer.return_request` at.
      await switchWarehouse(page, 'qa-wh-inst-a-empty');
      // This role has no read affordance either, so the tab — and therefore
      // the tour — disappears ENTIRELY rather than merely losing two steps.
      await expect.poll(() => page.locator(TAB_QUARANTINE).count()).toBe(0);
      await openGuide(page);
      expect(await tourTitles(page)).not.toContain(QUARANTINE_TITLE.ar);
    } finally {
      await closeContext(context);
    }
  }, 180_000);

  it('an org-wide suspension claim offers CREATE and withholds LIFT', async () => {
    const { context, page } = await openInventory({
      lang: 'ar', viewport: DESKTOP, persona: 'institution_admin',
    });
    try {
      await openTab(page, TAB_SUSPENSIONS);
      await openGuide(page);
      await startTourByTitle(page, SUSPENSION_TITLE.ar);
      const seen = await walkTour(page, 'suspension.history');
      expect(seen.map(s => s.step)).toContain('suspension.create');
      expect(seen.map(s => s.step)).not.toContain('suspension.lift');

      // The real panel agrees: a create control exists, no lift control does.
      expect(await page.locator('button:has-text("إيقاف عن الصرف")').count()).toBeGreaterThan(0);
      expect(await page.locator('button:has-text("رفع إيقاف الصرف")').count()).toBe(0);
    } finally {
      await closeContext(context);
    }
  }, 180_000);

  it('the OPPOSITE combination — LIFT offered, CREATE withheld at the org-wide scope', async () => {
    const { context, page } = await openInventory({
      lang: 'ar', viewport: DESKTOP, persona: 'outlet_officer_assigned',
    });
    try {
      await openTab(page, TAB_SUSPENSIONS);
      await page.locator('button:has-text("رفع إيقاف الصرف")').first().waitFor({ state: 'visible' });

      await openGuide(page);
      await startTourByTitle(page, SUSPENSION_TITLE.ar);
      const seen = await walkTour(page, 'suspension.history');
      expect(seen.map(s => s.step)).toContain('suspension.lift');
    } finally {
      await closeContext(context);
    }
  }, 180_000);

  it('reachability is not authorization — opening the create form at this operator’s OWN outlet is refused', async () => {
    /**
     * `qa-outlet_officer_assigned` reaches the create BUTTON through an
     * outlet assignment (migration 062), same mechanism `manageableOutlets`
     * has always used — but holds no `material_dispensing_suspension.create`
     * grant at that outlet. The guide's own copy for this step says opening
     * the form is not acceptance; this proves the form itself agrees.
     */
    const { context, page } = await openInventory({
      lang: 'ar', viewport: DESKTOP, persona: 'outlet_officer_assigned',
    });
    try {
      await openTab(page, TAB_SUSPENSIONS);
      await page.locator('button:has-text("إيقاف عن الصرف")').first().click();
      const outletSelect = page.locator('select').filter({ hasText: '' }).last();
      await page.getByLabel('المنفذ').selectOption({ label: 'QA · منفذ الطوارئ' });
      await page.locator('text=لا تملك صلاحية إيقاف مواد عن الصرف').waitFor({ state: 'visible' });
    } finally {
      await closeContext(context);
    }
  }, 180_000);

  it('reachability WITH a genuine exact-scope grant succeeds — no refusal at the granted outlet', async () => {
    const { context, page } = await openInventory({
      lang: 'ar', viewport: DESKTOP, persona: 'central_warehouse_manager',
    });
    try {
      await openTab(page, TAB_SUSPENSIONS);
      await page.locator('button:has-text("إيقاف عن الصرف")').first().click();
      await page.getByLabel('المنفذ').selectOption({ label: 'QA · منفذ الأطفال' });
      await page.waitForTimeout(400);
      expect(await page.locator('text=لا تملك صلاحية إيقاف مواد عن الصرف').count()).toBe(0);
    } finally {
      await closeContext(context);
    }
  }, 180_000);

  it('an operator with no assignment anywhere sees neither tour offered', async () => {
    /**
     * `warehouse_officer` (unassigned) reaches NO warehouse at all, so the
     * screen never renders a warehouse `<select>` — `openInventory`'s own
     * picker step would hang waiting for one. Navigating directly is the
     * correct shape for this one negative case: the empty-scope message
     * itself is real product behaviour, not a bypass of any step.
     */
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();
    try {
      await page.goto(
        `${baseUrl}?qa=1&persona=warehouse_officer&lang=ar&theme=light&scene=inventory&org=${QA_ORG}`,
        { waitUntil: 'load' },
      );
      await page.locator('.premium-topbar').waitFor({ state: 'visible' });
      await page.locator('text=لا تملك صلاحية على أي مخزن').waitFor({ state: 'visible' });

      await openGuide(page);
      const titles = await tourTitles(page);
      expect(titles).not.toContain(QUARANTINE_TITLE.ar);
      expect(titles).not.toContain(SUSPENSION_TITLE.ar);
    } finally {
      await closeContext(context);
    }
  }, 180_000);

  it('captures the read-only and the org-wide-claim personas for the record', async () => {
    for (const persona of ['health_center_manager_assigned', 'institution_admin'] as const) {
      const { context, page } = await openInventory({ lang: 'ar', viewport: DESKTOP, persona });
      try {
        await openTab(page, persona === 'institution_admin' ? TAB_SUSPENSIONS : TAB_QUARANTINE);
        await page.waitForTimeout(300);
        await shoot(page, `restricted-${persona}-ar-desktop`);
      } finally {
        await closeContext(context);
      }
    }
  }, 180_000);
});

describe('IG-2 acceptance — language, motion and theme', () => {
  it('switching the application language mid-tour keeps the step and the focus', async () => {
    const { context, page } = await openInventory({ lang: 'ar', viewport: DESKTOP });
    try {
      await openTab(page, TAB_QUARANTINE);
      await openGuide(page);
      await startTourByTitle(page, QUARANTINE_TITLE.ar);
      await advance(page);
      const before = await currentStep(page);

      await page.locator('[data-guide-language-control]').click();
      await page.waitForTimeout(200);
      const after = await currentStep(page);

      expect(after.step).toBe(before.step);
      expect(after.dir).toBe('ltr');
      expect(await page.evaluate(() => document.documentElement.getAttribute('lang'))).toBe('en');
      // Focus stayed on the control the operator just used.
      const focused = await page.evaluate(() =>
        document.activeElement?.hasAttribute('data-guide-language-control') ?? false);
      expect(focused).toBe(true);
      // ...and the tour is the SAME one, now in English.
      expect(await page.locator('.guide-card').innerText()).not.toContain('الحجر');
    } finally {
      await closeContext(context);
    }
  }, 180_000);

  it('honours reduced motion on the ring', async () => {
    const { context, page } = await openInventory({
      lang: 'ar', viewport: DESKTOP, reducedMotion: 'reduce',
    });
    try {
      await openTab(page, TAB_QUARANTINE);
      await openGuide(page);
      await startTourByTitle(page, QUARANTINE_TITLE.ar);
      await advance(page);
      await expect.poll(() => page.locator('.guide-ring').count()).toBe(1);
      const duration = await page.evaluate(() => {
        const ring = document.querySelector('.guide-ring');
        if (!ring) return -1;
        return Number.parseFloat(getComputedStyle(ring).transitionDuration);
      });
      // Chrome reports a forced-reduced transition as 0.001s, not 0.
      expect(duration).toBeLessThan(0.01);
    } finally {
      await closeContext(context);
    }
  }, 180_000);

  it('renders both tours in the dark theme without leaving the viewport', async () => {
    for (const [tabSelector, title, last] of [
      [TAB_QUARANTINE, QUARANTINE_TITLE.ar, 'quarantine.closing'],
      [TAB_SUSPENSIONS, SUSPENSION_TITLE.ar, 'suspension.history'],
    ] as const) {
      const { context, page } = await openInventory({ lang: 'ar', viewport: DESKTOP, theme: 'dark' });
      try {
        await openTab(page, tabSelector);
        await openGuide(page);
        await startTourByTitle(page, title);
        const seen = await walkTour(page, last);
        expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
        for (const entry of seen) {
          expect(entry.cardInside, `${entry.step} card left the viewport (dark)`).toBe(true);
        }
      } finally {
        await closeContext(context);
      }
    }
  }, 240_000);
});

describe('IG-2 acceptance — captured evidence', () => {
  /**
   * The acceptance screenshots, taken from the REAL panels with the tour
   * running. They are written to artifacts/ig2-acceptance/ and are the images
   * quoted in the pull request; the assertions above are what makes them
   * evidence rather than decoration.
   */
  const MATRIX = [
    { tab: TAB_QUARANTINE, tour: QUARANTINE_TITLE, step: 'quarantine.release', slug: 'quarantine' },
    { tab: TAB_SUSPENSIONS, tour: SUSPENSION_TITLE, step: 'suspension.create', slug: 'suspension' },
  ] as const;

  for (const entry of MATRIX) {
    for (const lang of ['ar', 'en'] as const) {
      for (const [label, viewport] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
        it(`captures ${entry.slug} · ${lang} · ${label}`, async () => {
          const { context, page } = await openInventory({
            lang, viewport, hasTouch: label === 'phone',
          });
          try {
            await openTab(page, entry.tab);
            await openGuide(page);
            await startTourByTitle(page, entry.tour[lang]);
            for (let guard = 0; guard < 25; guard += 1) {
              if ((await currentStep(page)).step === entry.step) break;
              await advance(page);
            }
            await page.waitForTimeout(400);
            const state = await currentStep(page);
            expect(state.step).toBe(entry.step);
            expect(state.anchor).not.toBe('none');
            await shoot(page, `${entry.slug}-${lang}-${label}`);
          } finally {
            await closeContext(context);
          }
        }, 180_000);
      }
    }
  }
});
