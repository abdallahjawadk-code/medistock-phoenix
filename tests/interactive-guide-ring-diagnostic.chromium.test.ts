import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';

/**
 * TEMPORARY, BOUNDED DIAGNOSTIC — not a regression test.
 *
 * Reproduces, on the ACTUAL Linux CI runner (the variable every prior local
 * Windows run of this investigation could not remove), the exact scenario
 * that failed historically: commit e30920d8, CI run 903 attempt 1, job
 * "Security and quality gates" — `tests/interactive-guide.chromium.test.ts`
 * > "teaches both phone navigation surfaces at 375px" > expectRingOverTarget
 * on DRAWER_NAV, measured offset 20 against a 2px bound
 * (https://github.com/abdallahjawadk-code/medistock-phoenix/actions/runs/34014690876/job/101436337752).
 *
 * That failure log has only the FINAL polled value (20), not a timeline —
 * `expect.poll` does not log intermediate samples. This file repeats the
 * identical scenario N times in one job on the same runner class the
 * failure occurred on, recording a full per-sample timeline (offset,
 * animation events, mutation events) for each repeat, to distinguish a real
 * settle-position defect from an assertion observing an unsettled frame.
 *
 * Intended to run ONCE via CI on this PR to gather evidence, then be
 * removed (or replaced by a real regression test) once the evidence is
 * classified — see the PR description's Round 6 section for the outcome.
 */

const ROOT = join(__dirname, '..');
const DRAWER_NAV = '[data-guide-id="guide.shell.navigation.drawer"]';
const REPEATS = 15;

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
  if (!executable) throw new Error('A system Chromium executable is required.');
  return executable;
}

async function currentStep(page: Page) {
  return page.locator('[data-guide-tour]').evaluate(node => ({
    step: (node as HTMLElement).dataset.guideStep,
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

async function goToStep(page: Page, stepId: string) {
  for (let guard = 0; guard < 25; guard += 1) {
    const state = await currentStep(page);
    if (state.step === stepId) return;
    if (state.step === 'closing') break;
    await advance(page);
  }
  throw new Error(`the tour never reached "${stepId}"`);
}

beforeAll(async () => {
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
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
}, 60_000);

describe('RING-DIAGNOSTIC (temporary) — DRAWER_NAV settle timeline on the CI runner class', () => {
  it(`replays the historically-failing scenario ${REPEATS} times with a full per-sample timeline`, async () => {
    // eslint-disable-next-line no-console
    console.log(`[RING-DIAG] node=${process.version} platform=${process.platform} arch=${process.arch}`);

    for (let rep = 1; rep <= REPEATS; rep += 1) {
      const context = await browser.newContext({
        viewport: { width: 375, height: 812 },
        hasTouch: true,
      });
      const page = await context.newPage();
      try {
        await page.goto(
          `${baseUrl}?qa=1&persona=super_admin&lang=ar&theme=light&scene=shell`,
          { waitUntil: 'load' },
        );
        await page.locator('.premium-topbar').waitFor({ state: 'visible' });
        await page.evaluate(() => window.localStorage.removeItem('medistock.phoenix.guide.progress'));

        // DOM-level instrumentation, independent of the app's own code.
        await page.evaluate(selector => {
          const t0 = performance.now();
          (window as unknown as { __timeline: unknown[] }).__timeline = [];
          const push = (entry: Record<string, unknown>) =>
            (window as unknown as { __timeline: unknown[] }).__timeline.push({ t: Math.round(performance.now() - t0), ...entry });
          for (const type of ['animationstart', 'animationend', 'animationcancel', 'transitionstart', 'transitionend']) {
            document.addEventListener(type, e => {
              const el = e.target as Element;
              const isDrawer = el.classList?.contains('premium-mobile-drawer');
              const isTarget = el.matches?.(selector);
              if (isDrawer || isTarget) {
                push({ ev: type, tag: el.tagName, isDrawer: !!isDrawer, isTarget: !!isTarget, animName: (e as AnimationEvent).animationName ?? (e as TransitionEvent).propertyName });
              }
            }, true);
          }
          const mo = new MutationObserver(muts => {
            for (const m of muts) {
              for (const node of Array.from(m.addedNodes)) {
                if (node.nodeType === 1 && ((node as Element).matches?.(selector) || (node as Element).querySelector?.(selector))) push({ ev: 'mutation-added', tag: (node as Element).tagName });
              }
              for (const node of Array.from(m.removedNodes)) {
                if (node.nodeType === 1 && ((node as Element).matches?.(selector) || (node as Element).querySelector?.(selector))) push({ ev: 'mutation-removed', tag: (node as Element).tagName });
              }
            }
          });
          mo.observe(document.body, { childList: true, subtree: true });
          (window as unknown as { __ringDiagT0: number }).__ringDiagT0 = t0;
        }, DRAWER_NAV);

        await page.locator('.premium-drawer-trigger').click();
        await page.locator('[data-guide-id="guide.shell.drawer.help"]').click();
        await page.locator('[data-guide-surface="center"]').waitFor({ state: 'visible' });
        await page.locator('.guide-tour-card__actions .guide-btn').last().click();
        await page.locator('[data-guide-tour]').waitFor({ state: 'visible' });

        await goToStep(page, 'shell.navigation.all');
        await page.locator('#phoenix-mobile-drawer').waitFor({ state: 'visible' });
        await page.locator(DRAWER_NAV).waitFor({ state: 'visible' });

        // Manual settle poll: every ~1 RAF, up to 3s, recording EVERY sample
        // (expect.poll only ever reports the LAST one) plus whether ring/
        // target rects are even present, and the ring's own step/anchor
        // identity at that instant (guards against a stale target match).
        const samples = await page.evaluate(async selector => {
          const t0 = (window as unknown as { __ringDiagT0: number }).__ringDiagT0 ?? performance.now();
          const out: Array<Record<string, unknown>> = [];
          const deadline = performance.now() + 3000;
          await new Promise<void>(resolve => {
            const tick = () => {
              const ring = document.querySelector('.guide-ring');
              const target = document.querySelector(selector);
              const tour = document.querySelector('[data-guide-tour]') as HTMLElement | null;
              let offset: number | null = null;
              let ringRect = null;
              let targetRect = null;
              if (ring && target) {
                const r = ring.getBoundingClientRect();
                const t = target.getBoundingClientRect();
                ringRect = { x: r.x, y: r.y, w: r.width, h: r.height };
                targetRect = { x: t.x, y: t.y, w: t.width, h: t.height };
                offset = Math.max(
                  Math.abs((r.x + r.width / 2) - (t.x + t.width / 2)),
                  Math.abs((r.y + r.height / 2) - (t.y + t.height / 2)),
                );
              }
              out.push({
                t: Math.round(performance.now() - t0),
                step: tour?.dataset.guideStep ?? null,
                ringPresent: !!ring,
                targetPresent: !!target,
                offset,
                ringRect,
                targetRect,
              });
              if (performance.now() < deadline) requestAnimationFrame(tick);
              else resolve();
            };
            requestAnimationFrame(tick);
          });
          return out;
        }, DRAWER_NAV);

        const timeline = await page.evaluate(() => (window as unknown as { __timeline: unknown[] }).__timeline);
        const finalOffset = samples.length ? samples[samples.length - 1].offset : null;
        const everBelowBound = samples.some(s => typeof s.offset === 'number' && (s.offset as number) <= 2);
        const settledAndStayed = samples.length >= 3
          && samples.slice(-3).every(s => typeof s.offset === 'number' && (s.offset as number) <= 2);

        // eslint-disable-next-line no-console
        console.log(`[RING-DIAG] repeat=${rep}/${REPEATS} finalOffset=${finalOffset} everBelowBound=${everBelowBound} settledAndStayed=${settledAndStayed} sampleCount=${samples.length}`);
        // eslint-disable-next-line no-console
        console.log(`[RING-DIAG] repeat=${rep} events=${JSON.stringify(timeline)}`);
        // eslint-disable-next-line no-console
        console.log(`[RING-DIAG] repeat=${rep} samples=${JSON.stringify(samples)}`);
      } finally {
        await context.close();
      }
    }
  }, 300_000);
});
