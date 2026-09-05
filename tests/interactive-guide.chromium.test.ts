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
      + `&lang=${options.lang}&theme=${options.theme ?? 'light'}&scene=shell`,
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

      const seen: string[] = [];
      for (;;) {
        const state = await currentStep(page);
        seen.push(state.step as string);
        if (state.step === 'closing') break;
        await advance(page);
      }
      // Content narrowed...
      expect(seen.some(id => id.startsWith('dashboard.'))).toBe(false);
      expect(seen.length).toBeLessThan(9);
      // ...but the shell steps this operator IS entitled to are all there.
      expect(seen).toContain('shell.navigation');
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
      await advance(page);
      await advance(page);
      const before = await currentStep(page);
      expect(before.step).toBe('shell.language');
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
