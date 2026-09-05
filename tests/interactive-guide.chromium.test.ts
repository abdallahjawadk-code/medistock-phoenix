import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';

/**
 * INTERACTIVE-GUIDE-IG1 — browser acceptance for the Guide & Help wave.
 *
 * A real engine is not optional for this feature. Three of its guarantees are
 * simply absent from jsdom and would be asserted into a false pass there:
 *
 *   • `inert` — jsdom sets the attribute and implements none of its behaviour,
 *     so "the highlighted control cannot be focused" is only meaningful here;
 *   • layout — `getBoundingClientRect` is all zeroes in jsdom, so "the card
 *     stays inside the viewport" and the RTL/LTR placement flip cannot be
 *     measured there at all;
 *   • hit testing — "a click at the control's own centre lands on the guide's
 *     blocker instead" needs a compositor.
 *
 * The harness is the repository's existing DEV-only QA gallery: it renders the
 * REAL shell against fixtures, with no session, no live data and a fixture
 * client whose every write is refused. Nothing here touches a real
 * environment. Same shape as `password-reveal-selection.chromium.test.ts`.
 */

const ROOT = join(__dirname, '..');
const HELP_ENTRY = '[data-guide-id="guide.shell.topbar.help"]';
const LANGUAGE_CONTROL = '[data-guide-id="guide.shell.topbar.language"]';
/** The guide's OWN application-language control, inside its modal surface. */
const GUIDE_LANGUAGE_CONTROL = '[data-guide-language-control]';
const DRAWER_HELP = '[data-guide-id="guide.shell.drawer.help"]';
const DRAWER_NAV = '[data-guide-id="guide.shell.navigation.drawer"]';
const BOTTOM_NAV = '[data-guide-id="guide.shell.navigation.bottom"]';
const MENU_TRIGGER = '[data-guide-id="guide.shell.topbar.menu"]';
const SIDEBAR_NAV = '[data-guide-id="guide.shell.navigation.rail"]';

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
    throw new Error('A system Chromium executable is required for the interactive-guide acceptance test.');
  }
  return executable;
}

interface OpenOptions {
  lang: 'ar' | 'en';
  viewport: { width: number; height: number };
  hasTouch?: boolean;
  reducedMotion?: 'reduce' | 'no-preference';
  /** Both themes are part of desktop acceptance; defaults to light. */
  theme?: 'light' | 'dark';
  /** A restricted persona proves the entry is not permission-gated. */
  persona?: string;
  /** QA gallery scene; defaults to the shell. `statistics` renders the REAL
   *  «الإحصائيات» screen so its guide steps have their true targets. */
  scene?: string;
}

async function openShell(options: OpenOptions) {
  const context = await browser.newContext({
    viewport: options.viewport,
    hasTouch: options.hasTouch,
    reducedMotion: options.reducedMotion,
  });
  const page = await context.newPage();

  // Nothing in this feature may reach the network. Any request that is not the
  // dev server's own module graph is recorded and asserted against.
  const foreignRequests: string[] = [];
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (!url.startsWith(baseUrl)) foreignRequests.push(url);
    await route.continue();
  });

  await page.goto(
    `${baseUrl}?qa=1&persona=${options.persona ?? 'super_admin'}`
      + `&lang=${options.lang}&theme=${options.theme ?? 'light'}`
      + `&scene=${options.scene ?? 'shell'}`,
    { waitUntil: 'load' },
  );
  await page.locator('.premium-topbar').waitFor({ state: 'visible' });
  await page.evaluate(() => window.localStorage.removeItem('medistock.phoenix.guide.progress'));
  return { context, page, foreignRequests };
}

/**
 * Open the Help Center through whichever entry this viewport actually offers.
 *
 * Which one that is follows the shell's own 767px boundary, not the caller's
 * idea of "mobile" — 200% zoom on a desktop screen produces a 720px CSS
 * viewport, which is the phone layout however large the monitor is. Asking the
 * page rather than assuming is what keeps this helper honest at every size.
 */
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

async function startTour(page: Page) {
  await page.locator('.guide-tour-card__actions .guide-btn').last().click();
  await page.locator('[data-guide-tour]').waitFor({ state: 'visible' });
}

async function currentStep(page: Page) {
  return page.locator('[data-guide-tour]').evaluate(node => ({
    tour: (node as HTMLElement).dataset.guideTour,
    step: (node as HTMLElement).dataset.guideStep,
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

/**
 * Walk the tour to a step by its stable id, whatever the filtered length.
 *
 * IG-1.1 made this necessary rather than convenient: the tour's length and
 * order now depend on the viewport, so counting `advance()` calls describes one
 * layout and silently mis-describes the other.
 */
async function goToStep(page: Page, stepId: string) {
  for (let guard = 0; guard < 25; guard += 1) {
    const state = await currentStep(page);
    if (state.step === stepId) return state;
    if (state.step === 'closing') break;
    await advance(page);
  }
  throw new Error(`the tour never reached "${stepId}"`);
}

/** Every step id the filtered tour actually renders, in order. */
async function stepIdsOf(page: Page): Promise<string[]> {
  const seen: string[] = [];
  for (;;) {
    const state = await currentStep(page);
    seen.push(state.step as string);
    if (state.step === 'closing') return seen;
    await advance(page);
  }
}

/**
 * Wait for the step to be ANCHORED to a real target.
 *
 * The test is the highlight ring, not the card's placement. Those are
 * different facts: the ring exists exactly when a target was resolved, while
 * the card centres whenever no side of that target has room for it — which is
 * routine on a 375px phone against a target like the drawer's navigation list
 * (217x535 in an 812px-tall viewport). Asserting on placement would call a
 * correctly highlighted step a failure.
 *
 * Polling because `advance()` returns as soon as the step id changes, one
 * render before the overlay has measured anything.
 */
async function expectAnchored(page: Page, stepId: string) {
  await expect
    .poll(() => page.locator('.guide-ring').count(), { timeout: 10_000 })
    .toBe(1);
  const state = await currentStep(page);
  expect(state.step).toBe(stepId);
  // ...and the missing-target explanation is absent, because nothing is missing.
  const card = await page.locator('.guide-card').innerText();
  expect(card).not.toContain('هذا الجزء غير ظاهر على الشاشة الحالية');
  expect(card).not.toContain('This part is not visible on the current screen');
}

/**
 * The highlight ring ends up ON its target — asserted on the SETTLED position.
 *
 * Two distinct things move here, and conflating them is what made the first
 * version of this assertion flaky in CI while passing locally:
 *
 *   • the drawer slides in over ~200ms, so the target itself is still moving
 *     for the first few frames after its step becomes current, and
 *   • the ring transitions its own geometry over 150ms.
 *
 * The guarantee worth asserting is where the highlight COMES TO REST, so this
 * polls until the offset stops changing rather than sampling once. The
 * threshold is 2px, not the 12px it started at: with the engine re-measuring
 * until the target settles, the measured offset is exactly 0 in both axes, and
 * a loose bound would have hidden the 6px staleness that investigation found.
 */
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
  // ...and it STAYS there; a value caught mid-animation would drift away again.
  await page.waitForTimeout(250);
  expect(await offset()).toBeLessThanOrEqual(2);
}

/** Every rectangle the guide paints must sit inside the viewport. */
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

async function closeContext(context: BrowserContext) {
  await context.close();
}

beforeAll(async () => {
  server = await createServer({
    root: ROOT,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    define: {
      'import.meta.env.VITE_ENABLE_VISUAL_QA': JSON.stringify('true'),
      /**
       * The suite supplies its OWN configuration rather than inheriting a
       * developer's `.env.local`.
       *
       * `supabaseConfigured` is `Boolean(url && key)` (src/shared/supabase/
       * client.ts), and every service short-circuits to `null` when it is
       * false — BEFORE reaching the client at all. Without these two values
       * the Statistics screen rendered its "not configured" empty state and
       * the QA fixture client recorded zero RPC calls, so the step under test
       * had no target. It passed on a machine with a `.env.local` and failed
       * in CI, which had none: the suite was reading configuration it never
       * declared.
       *
       * These are deliberately unusable. `.invalid` is reserved by RFC 2606
       * and can never resolve, so even a mistaken call cannot leave the
       * machine — and in a DEV build the exported client is a proxy that the
       * QA harness has already pointed at its network-free fixture client, so
       * nothing dials out in the first place. Every case here additionally
       * asserts that no request left the test server's origin.
       *
       * The service-configuration guard and production behaviour are
       * untouched: this defines values for THIS server only.
       */
      'import.meta.env.VITE_PHOENIX_SUPABASE_URL': JSON.stringify('https://guide-acceptance.invalid'),
      'import.meta.env.VITE_PHOENIX_SUPABASE_ANON_KEY': JSON.stringify('guide-acceptance-fixture-key'),
    },
  });
  await server.listen();
  baseUrl = server.resolvedUrls?.local[0] ?? '';
  if (!baseUrl) throw new Error('Vite did not expose a local test URL.');

  browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable() });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
}, 60_000);

const DESKTOP = { width: 1440, height: 900 };
const TABLET = { width: 834, height: 1112 };
const PHONE = { width: 375, height: 812 };
const PHONE_WIDE = { width: 412, height: 915 };
/** The three desktop widths owner acceptance is measured at. */
const DESKTOP_WIDTHS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

describe('Guide & Help — entry placement across viewports', () => {
  it('offers the entry in the desktop topbar', async () => {
    const { context, page } = await openShell({ lang: 'ar', viewport: DESKTOP });
    try {
      await expect.poll(() => page.locator(HELP_ENTRY).count()).toBe(1);
      await expect.poll(() => page.locator('[data-guide-id="guide.shell.drawer.help"]').count()).toBe(0);
    } finally {
      await closeContext(context);
    }
  }, 60_000);

  it('keeps the crowded phone topbar intact and offers the entry in the drawer', async () => {
    const { context, page } = await openShell({ lang: 'ar', viewport: PHONE, hasTouch: true });
    try {
      // The measured reason the entry is not in the mobile topbar: the row is
      // already full. If a future change adds it there, the title loses width.
      expect(await page.locator(HELP_ENTRY).count()).toBe(0);
      const topbarFits = await page.evaluate(() => {
        const bar = document.querySelector('.premium-topbar') as HTMLElement;
        const title = bar.querySelector('.nexus-topbar-title') as HTMLElement;
        return {
          barWidth: bar.getBoundingClientRect().width,
          titleWidth: title.getBoundingClientRect().width,
          scrolls: bar.scrollWidth > bar.clientWidth + 1,
        };
      });
      expect(topbarFits.scrolls).toBe(false);
      expect(topbarFits.titleWidth).toBeGreaterThan(80);

      await page.locator('.premium-drawer-trigger').click();
      await expect.poll(() => page.locator('[data-guide-id="guide.shell.drawer.help"]').count()).toBe(1);
    } finally {
      await closeContext(context);
    }
  }, 60_000);
});

/**
 * INTERACTIVE-GUIDE-IG1 — the desktop discoverability regression.
 *
 * Owner acceptance found Guide & Help on mobile and not on desktop. The
 * control was in the DOM the whole time — present, visible, unclipped,
 * hit-testable and gated by nothing — so every assertion this suite made about
 * it passed while the feature was, in the only sense that matters, missing.
 *
 * These cases therefore assert what a person can FIND, not what a selector can
 * reach: that the control renders its own translated name, that the name is on
 * screen and inside the topbar, and that it stays that way across the widths,
 * languages, themes and zoom levels acceptance is measured at.
 */
/**
 * INTERACTIVE-GUIDE-IG1.1 — the three defects owner acceptance found on a real
 * phone, proven against a real engine.
 *
 * jsdom cannot answer any of these: the drawer's arrival is a layout event, the
 * highlight is a measured rectangle, and "no missing-target fallback" is only
 * meaningful once the target has a real box.
 */
describe('IG-1.1 — responsive guide acceptance', () => {
  async function openTour(page: Page) {
    await openGuide(page);
    await startTour(page);
  }

  /* ── A. terminology ──────────────────────────────────────────────────── */

  it.each([['ar', 'الإحصائيات', 'مركز القيادة'], ['en', 'Statistics', 'Command Center']] as const)(
    'names the screen «%s» correctly and never by its internal name',
    async (lang, expected, forbidden) => {
      const { context, page } = await openShell({ lang, viewport: DESKTOP });
      try {
        await openTour(page);
        await goToStep(page, 'dashboard.context');
        expect(await page.locator('.guide-card__title').innerText()).toBe(expected);
        const body = await page.locator('.guide-card__body').innerText();
        expect(body).toContain(expected);
        expect(body).not.toContain(forbidden);
      } finally {
        await closeContext(context);
      }
    }, 120_000);

  it.each([
    ['ar', 'الإحصائيات'],
    ['en', 'Statistics'],
  ] as const)('highlights the REAL «%s» screen header, not just its copy', async (lang, label) => {
    /**
     * The terminology case above proves the WORDS. This proves the step lands
     * on the screen those words describe: the QA gallery's `statistics` scene
     * renders the real RAC-3 Command Center against migration 199's read
     * contract, so `guide.dashboard.context.header` is the screen's own scope
     * band and not a stand-in.
     *
     * It also closes the loop on the rename: the screen titles itself with the
     * same word the guide now uses.
     */
    const { context, page, foreignRequests } = await openShell({
      lang, viewport: DESKTOP, scene: 'statistics',
    });
    try {
      await page.locator('.rac3[data-rac3-state="ready"]').waitFor({ state: 'visible' });
      // The screen calls itself what the guide calls it.
      expect(await page.locator('.rac3-header__title').innerText()).toBe(label);

      /**
       * The payload came from the QA fixture client, not from anywhere else.
       * `rac3-state="ready"` alone could in principle be reached by a real
       * call; this pins WHICH client answered, and that nothing left the test
       * server's origin to do it.
       */
      const rpcCalls = await page.evaluate(
        () => ((window as unknown as { __phoenixQaRpcCalls?: { name: string }[] })
          .__phoenixQaRpcCalls ?? []).map(call => call.name),
      );
      expect(rpcCalls).toContain('phoenix_command_center_read_contract');
      expect(foreignRequests).toEqual([]);

      await openTour(page);
      await goToStep(page, 'dashboard.context');
      await expectAnchored(page, 'dashboard.context');
      expect(await page.locator('.guide-card__title').innerText()).toBe(label);
      await expectRingOverTarget(page, '[data-guide-id="guide.dashboard.context.header"]');

      // ...and the two panels beside it anchor to their real targets too.
      await goToStep(page, 'dashboard.kpis');
      await expectAnchored(page, 'dashboard.kpis');
      await expectRingOverTarget(page, '[data-guide-id="guide.dashboard.overview.kpis"]');

      await goToStep(page, 'dashboard.signals');
      await expectAnchored(page, 'dashboard.signals');
      await expectRingOverTarget(page, '[data-guide-id="guide.dashboard.signals.panel"]');

      // Still nothing off-origin after the whole Statistics block.
      expect(foreignRequests).toEqual([]);
    } finally {
      await closeContext(context);
    }
  }, 150_000);

  /* ── B. the navigation model ─────────────────────────────────────────── */

  for (const viewport of [PHONE, PHONE_WIDE]) {
    it(`teaches both phone navigation surfaces at ${viewport.width}px`, async () => {
      const { context, page } = await openShell({ lang: 'ar', viewport, hasTouch: true });
      try {
        await openTour(page);

        // Quick navigation anchors to the REAL bottom bar.
        await goToStep(page, 'shell.navigation.quick');
        await expectAnchored(page, 'shell.navigation.quick');
        expect(await page.locator(BOTTOM_NAV).count()).toBe(1);
        expect(await page.locator('.guide-card__title').innerText()).toBe('التنقّل السريع');

        // The side-menu step anchors to the REAL menu button, drawer still shut.
        await goToStep(page, 'shell.navigation.menu');
        await expectAnchored(page, 'shell.navigation.menu');
        expect(await page.locator(MENU_TRIGGER).count()).toBe(1);
        expect(await page.locator('#phoenix-mobile-drawer').count()).toBe(0);
        expect(await page.locator('.guide-card__title').innerText()).toBe('القائمة الجانبية');

        // Advancing opens the real drawer and highlights the real list.
        await goToStep(page, 'shell.navigation.all');
        await page.locator('#phoenix-mobile-drawer').waitFor({ state: 'visible' });
        await page.locator(DRAWER_NAV).waitFor({ state: 'visible' });
        await expectAnchored(page, 'shell.navigation.all');
        expect(await page.locator('.guide-ring').count()).toBe(1);
        await expectRingOverTarget(page, DRAWER_NAV);
        expect(await page.locator('.guide-card__title').innerText()).toBe('جميع الشاشات');

        // The desktop step never appears here.
        expect(await page.locator(SIDEBAR_NAV).count()).toBe(0);
      } finally {
        await closeContext(context);
      }
    }, 150_000);
  }

  for (const viewport of [{ width: 1280, height: 720 }, DESKTOP]) {
    it(`teaches the sidebar and no phone surfaces at ${viewport.width}px`, async () => {
      const { context, page } = await openShell({ lang: 'ar', viewport });
      try {
        await openTour(page);
        await goToStep(page, 'shell.navigation.desktop');
        await expectAnchored(page, 'shell.navigation.desktop');
        expect(await page.locator(SIDEBAR_NAV).count()).toBe(1);
        expect(await page.locator('.guide-card__title').innerText()).toBe('التنقّل بين الشاشات');
        // The bottom bar is not rendered at this width, so it is never described.
        expect(await page.locator(BOTTOM_NAV).count()).toBe(0);

        const ids = await stepIdsOf(page);
        expect(ids).not.toContain('shell.navigation.quick');
        expect(ids).not.toContain('shell.navigation.menu');
        expect(ids).not.toContain('shell.navigation.all');
      } finally {
        await closeContext(context);
      }
    }, 150_000);
  }

  it('derives the step count from the viewport rather than a fixed number', async () => {
    const counts: Record<string, number> = {};
    for (const [name, viewport, touch] of [
      ['phone', PHONE, true],
      ['desktop', DESKTOP, false],
    ] as const) {
      const { context, page } = await openShell({ lang: 'en', viewport, hasTouch: touch });
      try {
        await openTour(page);
        const label = await page.locator('.guide-card__position').innerText();
        counts[name] = Number(/of (\d+)/.exec(label)?.[1] ?? '0');
        expect(counts[name]).toBeGreaterThan(0);
      } finally {
        await closeContext(context);
      }
    }
    expect(counts.phone).not.toBe(counts.desktop);
    expect(counts.phone).toBeGreaterThan(counts.desktop);
  }, 150_000);

  /* ── C. Guide & Help has a real target on a phone ────────────────────── */

  it.each([['ar', 'الدليل والمساعدة'], ['en', 'Guide & Help']] as const)(
    'highlights the REAL phone Guide & Help entry in %s, with no fallback',
    async (lang, label) => {
      const { context, page } = await openShell({ lang, viewport: PHONE, hasTouch: true });
      try {
        await openTour(page);
        await goToStep(page, 'help.entry');

        // The drawer is genuinely open and the real entry is visible in it.
        await page.locator('#phoenix-mobile-drawer').waitFor({ state: 'visible' });
        const entry = page.locator(DRAWER_HELP);
        await entry.waitFor({ state: 'visible' });
        expect(await entry.innerText()).toContain(label);

        // Anchored, not centred, and no "not on this screen" explanation.
        await expectAnchored(page, 'help.entry');
        expect(await page.locator('.guide-ring').count()).toBe(1);
        const cardText = await page.locator('.guide-card').innerText();
        expect(cardText).not.toContain('هذا الجزء غير ظاهر على الشاشة الحالية');
        expect(cardText).not.toContain('This part is not visible on the current screen');
        expect(await page.locator('.guide-card__title').innerText()).toBe(label);

        // The ring really is over the entry, once the drawer has stopped moving.
        await expectRingOverTarget(page, DRAWER_HELP);

        // Exactly one entry and one overlay.
        expect(await page.locator(DRAWER_HELP).count()).toBe(1);
        expect(await page.locator(HELP_ENTRY).count()).toBe(0);
        expect(await page.locator('[data-guide-tour]').count()).toBe(1);
      } finally {
        await closeContext(context);
      }
    }, 150_000);

  it('keeps the highlighted phone entry non-activatable behind the blocker', async () => {
    const { context, page } = await openShell({ lang: 'ar', viewport: PHONE, hasTouch: true });
    try {
      await openTour(page);
      await goToStep(page, 'help.entry');
      await page.locator(DRAWER_HELP).waitFor({ state: 'visible' });

      const box = await page.locator(DRAWER_HELP).boundingBox();
      const b = box as { x: number; y: number; width: number; height: number };
      const centre = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      const hit = await page.evaluate(
        point => (document.elementFromPoint(point.x, point.y) as HTMLElement)?.className ?? '',
        centre,
      );
      expect(hit).toContain('guide-blocker');

      const focusReached = await page.evaluate(selector => {
        const element = document.querySelector(selector) as HTMLElement;
        element.focus();
        return document.activeElement === element;
      }, DRAWER_HELP);
      expect(focusReached).toBe(false);
      expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(true);
      // Still one overlay, still the same step.
      expect(await page.locator('[data-guide-tour]').count()).toBe(1);
    } finally {
      await closeContext(context);
    }
  }, 150_000);

  /* ── Drawer lifecycle ────────────────────────────────────────────────── */

  it('gives the drawer back on every exit path', async () => {
    for (const exit of ['back', 'skip', 'escape', 'forward'] as const) {
      const { context, page } = await openShell({ lang: 'ar', viewport: PHONE, hasTouch: true });
      try {
        await openTour(page);
        await goToStep(page, 'shell.navigation.all');
        await page.locator('#phoenix-mobile-drawer').waitFor({ state: 'visible' });

        if (exit === 'back') {
          await page.locator('.guide-card__actions .guide-btn').first().click();
        } else if (exit === 'skip') {
          await page.locator('.guide-btn--quiet').last().click();
        } else if (exit === 'escape') {
          await page.keyboard.press('Escape');
        } else {
          await goToStep(page, 'shell.language');
        }

        await page.locator('#phoenix-mobile-drawer').waitFor({ state: 'detached' });
        expect(await page.locator('#phoenix-mobile-drawer').count(), `exit=${exit}`).toBe(0);
      } finally {
        await closeContext(context);
      }
    }
  }, 240_000);

  it('holds the drawer across CONSECUTIVE drawer steps rather than cycling it', async () => {
    /**
     * The phone's only Guide & Help entry lives in the drawer and closes it on
     * the way in — deliberately, so the drawer's focus trap and the guide's do
     * not fight. A drawer the OPERATOR left open therefore cannot exist by the
     * time a tour starts on a phone, which is why that branch is proven in
     * `guide-responsive-navigation.runtime.test.tsx` instead of here.
     *
     * What IS reachable, and what this asserts, is the adjacent guarantee: two
     * consecutive drawer-backed steps borrow the drawer once. It opens for the
     * screen list, stays open through Guide & Help, and is given back only when
     * the tour moves on.
     */
    const { context, page } = await openShell({ lang: 'ar', viewport: PHONE, hasTouch: true });
    try {
      await openTour(page);
      await goToStep(page, 'shell.navigation.all');
      await page.locator('#phoenix-mobile-drawer').waitFor({ state: 'visible' });

      await goToStep(page, 'help.entry');
      // No close/reopen flicker between the two: still the same open drawer.
      expect(await page.locator('#phoenix-mobile-drawer').count()).toBe(1);
      await page.locator(DRAWER_HELP).waitFor({ state: 'visible' });

      await goToStep(page, 'shell.language');
      await page.locator('#phoenix-mobile-drawer').waitFor({ state: 'detached' });
    } finally {
      await closeContext(context);
    }
  }, 150_000);

  it('switches language on a drawer step without losing the step or the drawer', async () => {
    const { context, page, foreignRequests } = await openShell({
      lang: 'ar', viewport: PHONE, hasTouch: true,
    });
    try {
      await openTour(page);
      await goToStep(page, 'help.entry');
      await page.locator(DRAWER_HELP).waitFor({ state: 'visible' });
      await expectAnchored(page, 'help.entry');
      const before = await currentStep(page);

      await page.locator(GUIDE_LANGUAGE_CONTROL).click();
      await page.waitForFunction(() => document.documentElement.getAttribute('dir') === 'ltr');

      const after = await currentStep(page);
      expect(after.tour).toBe(before.tour);
      expect(after.step).toBe(before.step);
      expect(after.dir).toBe('ltr');
      await expectAnchored(page, 'help.entry');
      // The drawer stayed open, the canonical target is still highlighted.
      expect(await page.locator('#phoenix-mobile-drawer').count()).toBe(1);
      await page.locator(DRAWER_HELP).waitFor({ state: 'visible' });
      expect(await page.locator('[data-guide-tour]').count()).toBe(1);
      expect(await page.locator('.guide-card__title').innerText()).toBe('Guide & Help');
      expect((await cardFitsViewport(page)).inside).toBe(true);
      const focusInside = await page.evaluate(
        () => !!document.activeElement?.closest('.guide-card'),
      );
      expect(focusInside).toBe(true);
      expect(foreignRequests).toEqual([]);
    } finally {
      await closeContext(context);
    }
  }, 150_000);

  it('keeps the card on screen through every phone step, in both languages', async () => {
    for (const lang of ['ar', 'en'] as const) {
      const { context, page } = await openShell({ lang, viewport: PHONE, hasTouch: true });
      try {
        await openTour(page);
        for (;;) {
          const state = await currentStep(page);
          const fit = await cardFitsViewport(page);
          expect(fit.inside, `card left the viewport at ${state.step} (${lang})`).toBe(true);
          const overflows = await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth + 1,
          );
          expect(overflows, `horizontal overflow at ${state.step}`).toBe(false);
          if (state.step === 'closing') break;
          await advance(page);
        }
      } finally {
        await closeContext(context);
      }
    }
  }, 240_000);

  it('runs the phone tour with no service, RPC or network call of its own', async () => {
    const { context, page, foreignRequests } = await openShell({
      lang: 'ar', viewport: PHONE, hasTouch: true,
    });
    try {
      const calls = await page.evaluate(() => {
        const record: string[] = [];
        (window as unknown as { __guideCalls: string[] }).__guideCalls = record;
        const originalFetch = window.fetch;
        window.fetch = ((...args: unknown[]) => {
          record.push('fetch');
          return (originalFetch as unknown as (...a: unknown[]) => Promise<Response>)(...args);
        }) as typeof window.fetch;
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function patched(this: XMLHttpRequest, ...args: unknown[]) {
          record.push('xhr');
          return (originalOpen as unknown as (...a: unknown[]) => void).apply(this, args);
        } as typeof XMLHttpRequest.prototype.open;
        navigator.sendBeacon = (() => { record.push('beacon'); return true; }) as typeof navigator.sendBeacon;
        return record.length;
      });
      expect(calls).toBe(0);

      await openTour(page);
      for (;;) {
        const state = await currentStep(page);
        if (state.step === 'closing') break;
        await advance(page);
      }
      await page.locator('.guide-card .guide-btn--primary').click();
      await page.locator('[data-guide-surface="center"]').waitFor({ state: 'visible' });

      const recorded = await page.evaluate(
        () => (window as unknown as { __guideCalls: string[] }).__guideCalls,
      );
      expect(recorded).toEqual([]);
      expect(foreignRequests).toEqual([]);
    } finally {
      await closeContext(context);
    }
  }, 180_000);

  it('keeps the entry discoverable for a restricted operator while narrowing content', async () => {
    const { context, page } = await openShell({
      lang: 'ar', viewport: PHONE, hasTouch: true, persona: 'outlet_officer',
    });
    try {
      await page.locator('.premium-drawer-trigger').click();
      await page.locator(DRAWER_HELP).waitFor({ state: 'visible' });
      await page.locator(DRAWER_HELP).click();
      await page.locator('[data-guide-surface="center"]').waitFor({ state: 'visible' });
      await startTour(page);

      const ids = await stepIdsOf(page);
      // Both phone navigation surfaces are still taught...
      expect(ids).toContain('shell.navigation.quick');
      expect(ids).toContain('shell.navigation.all');
      // ...and the Statistics steps are absent, by name as well as by id.
      expect(ids.some(id => id.startsWith('dashboard.'))).toBe(false);
    } finally {
      await closeContext(context);
    }
  }, 180_000);
});

describe('Guide & Help — desktop entry is discoverable', () => {
  const AR_LABEL = 'الدليل والمساعدة';
  const EN_LABEL = 'Guide & Help';

  /** What the operator can actually read on the control, and where it sits. */
  async function inspectEntry(page: Page) {
    return page.evaluate(selector => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return null;
      const box = el.getBoundingClientRect();
      const bar = document.querySelector('.premium-topbar') as HTMLElement;
      const barBox = bar.getBoundingClientRect();
      const style = getComputedStyle(el);
      const labelNode = el.querySelector('.nexus-control__label') as HTMLElement | null;
      const labelStyle = labelNode ? getComputedStyle(labelNode) : null;
      const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const hit = document.elementFromPoint(centre.x, centre.y);
      return {
        visibleText: (labelNode && labelStyle?.display !== 'none' ? labelNode.textContent : '')?.trim() ?? '',
        accessibleName: el.getAttribute('aria-label') ?? '',
        tooltip: el.getAttribute('title') ?? '',
        width: Math.round(box.width),
        height: Math.round(box.height),
        insideTopbar: bar.contains(el),
        insideViewport: box.left >= -0.5 && box.top >= -0.5
          && box.right <= window.innerWidth + 0.5
          && box.bottom <= window.innerHeight + 0.5,
        withinBar: box.left >= barBox.left - 0.5 && box.right <= barBox.right + 0.5,
        painted: style.visibility === 'visible' && style.display !== 'none' && Number(style.opacity) > 0.99,
        topmostAtCentre: !!hit && el.contains(hit),
        barScrolls: bar.scrollWidth > bar.clientWidth + 1,
      };
    }, HELP_ENTRY);
  }

  for (const viewport of DESKTOP_WIDTHS) {
    for (const [lang, label] of [['ar', AR_LABEL], ['en', EN_LABEL]] as const) {
      it(`names itself at ${viewport.width}x${viewport.height} in ${lang}`, async () => {
        const { context, page } = await openShell({ lang, viewport });
        try {
          const entry = await inspectEntry(page);
          expect(entry).not.toBeNull();
          const found = entry as NonNullable<typeof entry>;
          // The defect, stated as an assertion: the control must say what it is.
          expect(found.visibleText).toBe(label);
          expect(found.accessibleName).toContain(label);
          expect(found.tooltip).toContain(label);
          // ...in the global topbar action area, fully on screen and on top.
          expect(found.insideTopbar).toBe(true);
          expect(found.insideViewport).toBe(true);
          expect(found.withinBar).toBe(true);
          expect(found.painted).toBe(true);
          expect(found.topmostAtCentre).toBe(true);
          // A labelled control is materially wider than the bare 44px glyph
          // it replaced, and it must not push the topbar into overflow.
          expect(found.width).toBeGreaterThan(60);
          expect(found.height).toBeGreaterThanOrEqual(44);
          expect(found.barScrolls).toBe(false);
        } finally {
          await closeContext(context);
        }
      }, 90_000);
    }
  }

  it('renders in dark theme too', async () => {
    for (const lang of ['ar', 'en'] as const) {
      const { context, page } = await openShell({ lang, viewport: DESKTOP, theme: 'dark' });
      try {
        const entry = await inspectEntry(page);
        expect(entry?.visibleText).toBe(lang === 'ar' ? AR_LABEL : EN_LABEL);
        expect(entry?.painted).toBe(true);
        expect(entry?.topmostAtCentre).toBe(true);
      } finally {
        await closeContext(context);
      }
    }
  }, 90_000);

  it('opens the Help Center when clicked, at every desktop width', async () => {
    for (const viewport of DESKTOP_WIDTHS) {
      const { context, page } = await openShell({ lang: 'en', viewport });
      try {
        await page.locator(HELP_ENTRY).click();
        await page.locator('[data-guide-surface="center"]').waitFor({ state: 'visible' });
        expect(await page.locator('#guide-center-title').innerText()).toBe('Guide & Help');
      } finally {
        await closeContext(context);
      }
    }
  }, 120_000);

  it('renders EXACTLY ONE entry at every breakpoint, desktop and phone', async () => {
    const viewports = [...DESKTOP_WIDTHS, TABLET, PHONE];
    for (const viewport of viewports) {
      const { context, page } = await openShell({
        lang: 'ar', viewport, hasTouch: viewport.width < 768,
      });
      try {
        const topbarEntries = await page.locator(HELP_ENTRY).count();
        // The drawer entry only exists while the drawer is open, so open it
        // wherever the shell offers one and count both surfaces together.
        const hasDrawer = await page.locator('.premium-drawer-trigger').count() > 0;
        if (hasDrawer) {
          await page.locator('.premium-drawer-trigger').click();
          await page.locator('#phoenix-mobile-drawer').waitFor({ state: 'visible' });
        }
        const drawerEntries = await page.locator('[data-guide-id="guide.shell.drawer.help"]').count();
        expect(
          topbarEntries + drawerEntries,
          `${viewport.width}px offered ${topbarEntries} topbar + ${drawerEntries} drawer entries`,
        ).toBe(1);
      } finally {
        await closeContext(context);
      }
    }
  }, 150_000);

  it('leaves the phone entry exactly where it was — in the drawer, named', async () => {
    const { context, page } = await openShell({ lang: 'ar', viewport: PHONE, hasTouch: true });
    try {
      // Still absent from the crowded phone topbar.
      expect(await page.locator(HELP_ENTRY).count()).toBe(0);
      await page.locator('.premium-drawer-trigger').click();
      const drawerEntry = page.locator('[data-guide-id="guide.shell.drawer.help"]');
      await drawerEntry.waitFor({ state: 'visible' });
      expect(await drawerEntry.innerText()).toContain(AR_LABEL);
      await drawerEntry.tap();
      await page.locator('[data-guide-surface="center"]').waitFor({ state: 'visible' });
    } finally {
      await closeContext(context);
    }
  }, 90_000);

  it('is reachable by Tab from the page itself, and opens on Enter', async () => {
    const { context, page } = await openShell({ lang: 'en', viewport: DESKTOP });
    try {
      // Walked to with real Tab presses rather than `.focus()`, because that
      // is what decides whether `:focus-visible` applies — a control an
      // operator can reach but cannot SEE they have reached is the same class
      // of defect this suite exists for.
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      let reached = false;
      for (let i = 0; i < 40 && !reached; i += 1) {
        await page.keyboard.press('Tab');
        reached = await page.evaluate(
          selector => document.activeElement === document.querySelector(selector),
          HELP_ENTRY,
        );
      }
      expect(reached, 'Tab never reached the Guide & Help entry').toBe(true);
      expect(await page.locator(HELP_ENTRY).evaluate(node => node.matches(':focus-visible'))).toBe(true);

      await page.keyboard.press('Enter');
      await page.locator('[data-guide-surface="center"]').waitFor({ state: 'visible' });
    } finally {
      await closeContext(context);
    }
  }, 90_000);

  it('stays visible and unclipped at 200% zoom', async () => {
    /**
     * 200% zoom halves the CSS viewport. At 640px the shell is in its phone
     * layout, where the entry legitimately moves to the drawer; at 960px it is
     * still desktop, and the entry must survive there — which is exactly the
     * band where the label is dropped and the glyph fallback takes over.
     */
    for (const viewport of [{ width: 960, height: 540 }, { width: 720, height: 450 }]) {
      const { context, page } = await openShell({ lang: 'ar', viewport });
      try {
        const isDesktopLayout = viewport.width >= 768;
        if (isDesktopLayout) {
          const entry = await inspectEntry(page);
          expect(entry, `no entry at ${viewport.width}px`).not.toBeNull();
          const found = entry as NonNullable<typeof entry>;
          expect(found.insideViewport).toBe(true);
          expect(found.withinBar).toBe(true);
          expect(found.painted).toBe(true);
          expect(found.barScrolls).toBe(false);
          // The label may be dropped here, but the name and tooltip may not be.
          expect(found.accessibleName).toContain(AR_LABEL);
          expect(found.tooltip).toContain(AR_LABEL);
          expect(found.height).toBeGreaterThanOrEqual(44);
        } else {
          expect(await page.locator(HELP_ENTRY).count()).toBe(0);
          await page.locator('.premium-drawer-trigger').click();
          await page.locator('[data-guide-id="guide.shell.drawer.help"]').waitFor({ state: 'visible' });
        }
      } finally {
        await closeContext(context);
      }
    }
  }, 120_000);

  it('is open to an operator whose permissions hide most of the content', async () => {
    /**
     * Requirement, stated directly: permissions filter the guide's CONTENT,
     * never the way in. `outlet_officer` holds no `dashboard.view`, so the
     * Command Center steps are absent from its tour — and the entry is exactly
     * as present, as named and as clickable as it is for a super admin.
     */
    const { context, page } = await openShell({
      lang: 'en', viewport: DESKTOP, persona: 'outlet_officer',
    });
    try {
      const entry = await inspectEntry(page);
      expect(entry?.visibleText).toBe(EN_LABEL);
      expect(entry?.painted).toBe(true);

      await page.locator(HELP_ENTRY).click();
      await page.locator('[data-guide-surface="center"]').waitFor({ state: 'visible' });
      await startTour(page);

      const seen = await stepIdsOf(page);
      // Content narrowed...
      expect(seen.some(id => id.startsWith('dashboard.'))).toBe(false);
      // ...but the shell steps this operator IS entitled to are all there.
      expect(seen).toContain('shell.navigation.desktop');
      expect(seen).toContain('help.entry');
    } finally {
      await closeContext(context);
    }
  }, 120_000);
});

describe.each([
  ['Arabic RTL', 'ar' as const, 'rtl'],
  ['English LTR', 'en' as const, 'ltr'],
])('Guide & Help — %s', (_label, lang, expectedDir) => {
  it('runs the orientation tour end to end with the card always on screen', async () => {
    const { context, page, foreignRequests } = await openShell({ lang, viewport: DESKTOP });
    try {
      await openGuide(page);
      await startTour(page);

      const seen: string[] = [];
      for (;;) {
        const state = await currentStep(page);
        expect(state.dir).toBe(expectedDir);
        seen.push(state.step as string);
        const fit = await cardFitsViewport(page);
        expect(fit.found).toBe(true);
        expect(fit.inside, `card left the viewport at ${state.step}`).toBe(true);
        if (state.step === 'closing') break;
        await advance(page);
      }

      expect(seen[0]).toBe('welcome');
      // Desktop teaches the sidebar; the phone-only surfaces are absent here.
      expect(seen).toContain('shell.navigation.desktop');
      expect(seen).not.toContain('shell.navigation.quick');
      expect(new Set(seen).size).toBe(seen.length);

      await page.locator('.guide-card .guide-btn--primary').click();
      await page.locator('[data-guide-surface="center"]').waitFor({ state: 'visible' });

      // Nothing left the origin at any point.
      expect(foreignRequests).toEqual([]);
    } finally {
      await closeContext(context);
    }
  }, 120_000);

  it('anchors a step to its real target and keeps the phone card on screen', async () => {
    const { context, page } = await openShell({ lang, viewport: PHONE, hasTouch: true });
    try {
      await openGuide(page);
      await startTour(page);
      await advance(page);

      const state = await currentStep(page);
      // On a phone the first navigation step is the bottom bar, not a sidebar.
      expect(state.step).toBe('shell.navigation.quick');
      expect(state.dir).toBe(expectedDir);
      const fit = await cardFitsViewport(page);
      expect(fit.inside).toBe(true);
    } finally {
      await closeContext(context);
    }
  }, 120_000);
});

describe('Guide & Help — safety in a real engine', () => {
  it('refuses a real click and a real focus on the control it highlights', async () => {
    const { context, page } = await openShell({ lang: 'ar', viewport: DESKTOP });
    try {
      await openGuide(page);
      await startTour(page);
      await goToStep(page, 'shell.language');

      const before = await page.locator(LANGUAGE_CONTROL).innerText();
      const box = await page.locator(LANGUAGE_CONTROL).boundingBox();
      expect(box).not.toBeNull();

      // A genuine pointer event at the control's own centre.
      const target = box as { x: number; y: number; width: number; height: number };
      const centre = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
      const hit = await page.evaluate(
        point => (document.elementFromPoint(point.x, point.y) as HTMLElement)?.className ?? '',
        centre,
      );
      expect(hit).toContain('guide-blocker');
      await page.mouse.click(centre.x, centre.y);
      await page.waitForTimeout(300);
      expect(await page.locator(LANGUAGE_CONTROL).innerText()).toBe(before);
      expect(await page.getAttribute('html', 'dir')).toBe('rtl');

      // And the keyboard cannot reach it: the background really is inert.
      const focusReached = await page.evaluate(selector => {
        const element = document.querySelector(selector) as HTMLElement;
        element.focus();
        return document.activeElement === element;
      }, LANGUAGE_CONTROL);
      expect(focusReached).toBe(false);
      expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(true);
    } finally {
      await closeContext(context);
    }
  }, 120_000);

  it('keeps the card above the topbar, the sidebar and the bottom bar', async () => {
    const { context, page } = await openShell({ lang: 'ar', viewport: DESKTOP });
    try {
      await openGuide(page);
      await startTour(page);
      const stacking = await page.evaluate(() => {
        const card = document.querySelector('.guide-card') as HTMLElement;
        const box = card.getBoundingClientRect();
        const probes = [
          [box.left + 8, box.top + 8],
          [box.right - 8, box.bottom - 8],
          [box.left + box.width / 2, box.top + box.height / 2],
        ] as const;
        return probes.map(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return !!hit && (hit === card || card.contains(hit));
        });
      });
      expect(stacking.every(Boolean)).toBe(true);
    } finally {
      await closeContext(context);
    }
  }, 120_000);

  it('stores nothing identifying, and resumes at the same step after a reload', async () => {
    const { context, page } = await openShell({ lang: 'en', viewport: DESKTOP });
    try {
      await openGuide(page);
      await startTour(page);
      await goToStep(page, 'shell.language');

      const stored = await page.evaluate(() => ({
        keys: Object.keys(window.localStorage),
        progress: window.localStorage.getItem('medistock.phoenix.guide.progress'),
      }));
      expect(stored.keys.sort()).toEqual(['medistock.phoenix.guide.progress']);
      const progress = JSON.parse(stored.progress as string);
      expect(Object.keys(progress).sort())
        .toEqual(['completedTourIds', 'stepId', 'tourId', 'updatedAt', 'v']);
      expect(stored.progress).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );

      await page.reload({ waitUntil: 'load' });
      await page.locator('.premium-topbar').waitFor({ state: 'visible' });
      await page.locator(HELP_ENTRY).click();
      await page.locator('[data-guide-surface="center"]').waitFor({ state: 'visible' });
      await page.locator('.guide-tour-card__actions .guide-btn').first().click();
      await page.locator('[data-guide-tour]').waitFor({ state: 'visible' });
      expect((await currentStep(page)).step).toBe('shell.language');
    } finally {
      await closeContext(context);
    }
  }, 120_000);

  it('resets safely from a corrupt or future persistence schema', async () => {
    const { context, page } = await openShell({ lang: 'en', viewport: DESKTOP });
    try {
      await page.evaluate(() => window.localStorage.setItem(
        'medistock.phoenix.guide.progress',
        JSON.stringify({ v: 4242, tourId: 'x', stepId: 'y', completedTourIds: [], updatedAt: 1 }),
      ));
      await page.reload({ waitUntil: 'load' });
      await page.locator('.premium-topbar').waitFor({ state: 'visible' });
      await page.locator(HELP_ENTRY).click();
      await page.locator('[data-guide-surface="center"]').waitFor({ state: 'visible' });
      // No Resume is offered for state this build cannot understand, and the
      // Help Center still works rather than failing to render.
      const labels = await page.locator('.guide-tour-card__actions .guide-btn').allInnerTexts();
      expect(labels).not.toContain('Resume');
      expect(labels.length).toBeGreaterThan(0);
    } finally {
      await closeContext(context);
    }
  }, 120_000);
});

describe('Guide & Help — language, motion and zoom', () => {
  /**
   * The live-language contract, exercised the way an operator actually does it.
   *
   * The topbar's language control is deliberately unreachable while a tour runs
   * — that is the blocking layer doing its job, and the safety case above
   * proves it. The guide therefore carries the SAME action inside its own
   * modal surface, and this is a genuine mouse click on that control: no
   * `evaluate`, no programmatic state poke, full Playwright actionability
   * checks, which additionally proves the control is visible, enabled and not
   * covered by the guide's own blocker.
   */
  it('switches language mid-tour by REAL CLICK, without leaving the step', async () => {
    const { context, page, foreignRequests } = await openShell({ lang: 'ar', viewport: DESKTOP });
    try {
      await openGuide(page);
      await startTour(page);
      await goToStep(page, 'shell.language');
      const before = await currentStep(page);
      expect(before.dir).toBe('rtl');
      const beforeLeft = await page.locator('.guide-card').evaluate(n => n.getBoundingClientRect().left);

      const control = page.locator(GUIDE_LANGUAGE_CONTROL);
      expect(await control.count()).toBe(1);
      await expect.poll(() => control.innerText()).toContain('تغيير لغة البرنامج');

      await control.click();
      await page.waitForFunction(() => document.documentElement.getAttribute('dir') === 'ltr');

      const after = await currentStep(page);
      // The tour stayed open on a byte-identical identity.
      expect(after.tour).toBe(before.tour);
      expect(after.step).toBe(before.step);
      // Direction and content both changed.
      expect(after.dir).toBe('ltr');
      expect(await page.getAttribute('html', 'dir')).toBe('ltr');
      expect(await page.locator('.guide-card__title').innerText()).toBe('Application language');
      expect(await control.innerText()).toContain('Change application language');
      // Exactly one overlay and one card — nothing was duplicated.
      expect(await page.locator('[data-guide-tour]').count()).toBe(1);
      expect(await page.locator('.guide-card').count()).toBe(1);
      // The popover followed the direction change rather than staying put.
      const afterLeft = await page.locator('.guide-card').evaluate(n => n.getBoundingClientRect().left);
      expect(Math.abs(afterLeft - beforeLeft)).toBeGreaterThan(40);
      expect((await cardFitsViewport(page)).inside).toBe(true);
      // Focus is still on a real element inside the guide.
      const focus = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        return {
          isBody: active === document.body,
          insideCard: !!active && !!active.closest('.guide-card'),
          isControl: !!active && active.hasAttribute('data-guide-language-control'),
        };
      });
      expect(focus.isBody).toBe(false);
      expect(focus.insideCard).toBe(true);
      expect(focus.isControl).toBe(true);
      // And nothing left the origin.
      expect(foreignRequests).toEqual([]);
    } finally {
      await closeContext(context);
    }
  }, 120_000);

  it('switches back and forth by keyboard alone', async () => {
    const { context, page } = await openShell({ lang: 'ar', viewport: DESKTOP });
    try {
      await openGuide(page);
      await startTour(page);
      const before = await currentStep(page);

      // Reach the control with the keyboard from where a new step opens focus.
      await page.locator(GUIDE_LANGUAGE_CONTROL).focus();
      expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-guide-language-control'))).toBe(true);

      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.documentElement.getAttribute('dir') === 'ltr');
      expect((await currentStep(page)).step).toBe(before.step);

      await page.keyboard.press(' ');
      await page.waitForFunction(() => document.documentElement.getAttribute('dir') === 'rtl');
      const after = await currentStep(page);
      expect(after.tour).toBe(before.tour);
      expect(after.step).toBe(before.step);
      expect(await page.locator('[data-guide-tour]').count()).toBe(1);
    } finally {
      await closeContext(context);
    }
  }, 120_000);

  it('switches language by touch on a phone', async () => {
    const { context, page } = await openShell({ lang: 'ar', viewport: PHONE, hasTouch: true });
    try {
      await openGuide(page);
      await startTour(page);
      const before = await currentStep(page);

      await page.locator(GUIDE_LANGUAGE_CONTROL).tap();
      await page.waitForFunction(() => document.documentElement.getAttribute('dir') === 'ltr');

      const after = await currentStep(page);
      expect(after.tour).toBe(before.tour);
      expect(after.step).toBe(before.step);
      expect(after.dir).toBe('ltr');
      expect(await page.locator('[data-guide-tour]').count()).toBe(1);
      expect((await cardFitsViewport(page)).inside).toBe(true);
    } finally {
      await closeContext(context);
    }
  }, 120_000);

  it('adds no language storage of its own while the guide is open', async () => {
    /**
     * The anti-duplication check in a real browser. Persistence itself belongs
     * to `LanguagePreferenceBridge` and is proven end to end against the real
     * provider in `guide-language-canonical.runtime.test.tsx`; this harness
     * renders the shell through the QA fixture provider, so what matters HERE
     * is the negative: using the guide's control invents no guide-scoped
     * language key anywhere.
     */
    const { context, page } = await openShell({ lang: 'ar', viewport: DESKTOP });
    try {
      await openGuide(page);
      await startTour(page);
      await page.locator(GUIDE_LANGUAGE_CONTROL).click();
      await page.waitForFunction(() => document.documentElement.getAttribute('dir') === 'ltr');

      const keys = await page.evaluate(() => Object.keys(window.localStorage).sort());
      expect(keys.some(key => /guide/i.test(key) && /lang/i.test(key))).toBe(false);
      expect(keys.every(key => key === 'medistock.phoenix.guide.progress')).toBe(true);
    } finally {
      await closeContext(context);
    }
  }, 120_000);

  it('offers the same control on the Help Center surface', async () => {
    const { context, page } = await openShell({ lang: 'ar', viewport: DESKTOP });
    try {
      await openGuide(page);
      expect(await page.locator(`[data-guide-surface="center"] ${GUIDE_LANGUAGE_CONTROL}`).count()).toBe(1);
      await page.locator(GUIDE_LANGUAGE_CONTROL).click();
      await page.waitForFunction(() => document.documentElement.getAttribute('dir') === 'ltr');
      // The Help Center is still open and now reads in English.
      await page.locator('[data-guide-surface="center"]').waitFor({ state: 'visible' });
      expect(await page.locator('#guide-center-title').innerText()).toBe('Guide & Help');
      expect(await page.locator('[data-guide-surface="center"]').count()).toBe(1);
    } finally {
      await closeContext(context);
    }
  }, 120_000);

  it('drops the highlight transition under prefers-reduced-motion', async () => {
    const { context, page } = await openShell({
      lang: 'en', viewport: DESKTOP, reducedMotion: 'reduce',
    });
    try {
      await openGuide(page);
      await startTour(page);
      await advance(page);
      const motion = await page.locator('.guide-ring').evaluate(node => ({
        preferenceSeen: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        inline: (node as HTMLElement).style.transition,
        duration: getComputedStyle(node).transitionDuration,
      }));
      // The preference really is in effect for this context.
      expect(motion.preferenceSeen).toBe(true);
      // The engine's own decision, which is unambiguous.
      expect(motion.inline).toBe('none');
      /**
       * ...and the engine agrees. Chrome does NOT report 0s under a forced
       * reduced-motion preference: it clamps transitions to 0.001s, so an
       * `=== 0` assertion here would fail against correct behaviour. "Below a
       * frame" is the property that actually matters.
       */
      const durations = motion.duration.split(',').map(value => parseFloat(value));
      expect(durations.length).toBeGreaterThan(0);
      expect(durations.every(value => value < 0.01)).toBe(true);
    } finally {
      await closeContext(context);
    }
  }, 120_000);

  it('keeps the card on screen at 200% zoom', async () => {
    // 200% zoom is equivalent to halving the CSS viewport, which is what the
    // guide's placement actually reacts to.
    const { context, page } = await openShell({ lang: 'ar', viewport: { width: 720, height: 450 } });
    try {
      await openGuide(page);
      await startTour(page);
      for (let i = 0; i < 3; i += 1) {
        expect((await cardFitsViewport(page)).inside).toBe(true);
        await advance(page);
      }
      expect((await cardFitsViewport(page)).inside).toBe(true);
    } finally {
      await closeContext(context);
    }
  }, 120_000);

  it('works on a tablet in both directions', async () => {
    for (const lang of ['ar', 'en'] as const) {
      const { context, page } = await openShell({ lang, viewport: TABLET });
      try {
        await openGuide(page);
        await startTour(page);
        await advance(page);
        expect((await cardFitsViewport(page)).inside).toBe(true);
        expect((await currentStep(page)).dir).toBe(lang === 'ar' ? 'rtl' : 'ltr');
      } finally {
        await closeContext(context);
      }
    }
  }, 180_000);
});
