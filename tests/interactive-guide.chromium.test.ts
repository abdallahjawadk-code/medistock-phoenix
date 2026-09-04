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
    `${baseUrl}?qa=1&persona=super_admin&lang=${options.lang}&theme=light&scene=shell`,
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
    define: { 'import.meta.env.VITE_ENABLE_VISUAL_QA': JSON.stringify('true') },
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
      expect(seen).toContain('shell.navigation');
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
      expect(state.step).toBe('shell.navigation');
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
      await advance(page);
      await advance(page);
      expect((await currentStep(page)).step).toBe('shell.language');

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
      await advance(page);
      await advance(page);
      expect((await currentStep(page)).step).toBe('shell.language');

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
  it('switches language mid-tour without leaving the step or duplicating the overlay', async () => {
    const { context, page } = await openShell({ lang: 'ar', viewport: DESKTOP });
    try {
      await openGuide(page);
      await startTour(page);
      await advance(page);
      await advance(page);
      const before = await currentStep(page);
      expect(before.step).toBe('shell.language');
      expect(before.dir).toBe('rtl');
      const beforeLeft = await page.locator('.guide-card').evaluate(n => n.getBoundingClientRect().left);

      /**
       * Driven programmatically ON PURPOSE. A real user gesture on this
       * control is refused while a tour runs — the test above proves exactly
       * that — so this is the only way to reach the application's own language
       * change from inside a step. It exercises the ENGINE's reaction, which
       * is what this case is about.
       */
      await page.evaluate(selector => {
        (document.querySelector(selector) as HTMLElement).click();
      }, LANGUAGE_CONTROL);
      await page.waitForFunction(() => document.documentElement.getAttribute('dir') === 'ltr');

      const after = await currentStep(page);
      expect(after.tour).toBe(before.tour);
      expect(after.step).toBe(before.step);
      expect(after.dir).toBe('ltr');
      expect(await page.locator('[data-guide-tour]').count()).toBe(1);
      expect(await page.locator('.guide-card__title').innerText()).toBe('Application language');
      // The popover followed the direction change rather than staying put.
      const afterLeft = await page.locator('.guide-card').evaluate(n => n.getBoundingClientRect().left);
      expect(Math.abs(afterLeft - beforeLeft)).toBeGreaterThan(40);
      expect((await cardFitsViewport(page)).inside).toBe(true);
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
