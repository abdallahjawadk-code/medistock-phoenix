/** @vitest-environment node */
/**
 * Real ManualNeedsJourney / production CSS browser acceptance with explicit service fixtures.
 * Opt in: MEDISTOCK_PRISM_VISUAL=1 PRISM_CHROMIUM_PATH=/path/to/chromium vitest run tests/prism-needs.visual.test.ts
 * This proves rendering and component behavior only. It does not exercise Auth, RLS, SQL,
 * real RPCs, canonical identity approval, stock, or original need quantities.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';

const ROOT = resolve(__dirname, '..');
const EVIDENCE = resolve(process.env.PRISM_VISUAL_EVIDENCE_DIR ?? join(ROOT, 'artifacts', 'prism-needs-visual'));
const ENABLED = process.env.MEDISTOCK_PRISM_VISUAL === '1';
const JOURNEY = '.prism-workspace[data-testid="manual-needs-journey"]';
const PICKER = '.prism-material-picker';
const WORKSPACE = '.prism-needs-workspace';
const EXACT_QUANTITY = '9007199254740993.125';
const records: Array<Record<string, unknown>> = [];
let browser: Browser;
let server: ViteDevServer;
let baseUrl = '';
let sourceBefore: Record<string, string> = {};
const SOURCE_FILES = [
  'src/main.tsx', 'src/features/central-needs/manual/ManualNeedsJourney.tsx',
  'src/features/central-needs/manual/MaterialPicker.tsx', 'src/features/central-needs/manual/ManualNeedsWorkspace.tsx',
  'src/shared/ui/prism/PrismWorkspace.tsx', 'src/shared/ui/prism/PrismMaterialIdentity.tsx',
  'src/shared/ui/prism/prism-workspace.css', 'src/shared/ui/prism/prism-fonts.css',
  'public/fonts/prism/Changa-variable.ttf', 'public/fonts/prism/Sora-variable.ttf',
  'src/shared/lib/pharma-molecular.css', 'tests/browser/prism-needs.visual.entry.tsx',
  'tests/browser/prism-needs.visual.html', 'tests/prism-needs.visual.test.ts',
];
const sourceHashes = () => Object.fromEntries(SOURCE_FILES.map((path) => [path, createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex')]));

type Lang = 'ar' | 'en';
type Theme = 'light' | 'dark';
const labels = (lang: Lang) => lang === 'ar'
  ? { open: 'فتح السنة', beneficiary: 'المؤسسة المستفيدة', item: 'المادة', reason: 'السبب', add: 'إضافة سطر', search: 'بحث' }
  : { open: 'Open year', beneficiary: 'Beneficiary institution', item: 'Item', reason: 'Reason', add: 'Add line', search: 'Search' };

function cssImports(path: string) {
  return [...readFileSync(path, 'utf8').matchAll(/^import\s+['"]([^'"]+\.css)['"];?/gm)].map((m) => m[1]);
}

it('uses the exact production CSS and font import order in the browser fixture', () => {
  expect(cssImports(join(ROOT, 'tests/browser/prism-needs.visual.entry.tsx'))).toEqual(cssImports(join(ROOT, 'src/main.tsx')));
});

async function openScene({ lang = 'ar', theme = 'light', width = 1366, scenario = 'normal', reducedMotion = false }:
  { lang?: Lang; theme?: Theme; width?: number; scenario?: string; reducedMotion?: boolean } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  const page = await context.newPage();
  const unexpectedNetwork: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(baseUrl) || url.startsWith('data:')) await route.continue();
    else { unexpectedNetwork.push(url); await route.abort('blockedbyclient'); }
  });
  const params = new URLSearchParams({ lang, theme, scenario });
  await page.goto(`${baseUrl}tests/browser/prism-needs.visual.html?${params}`, { waitUntil: 'networkidle' });
  await page.locator(JOURNEY).waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: labels(lang).open, exact: true }).click();
  await page.locator(WORKSPACE).waitFor({ state: 'visible' });
  if (scenario !== 'load-error') await page.locator(`${WORKSPACE}[data-testid="manual-needs-workspace"]`).waitFor({ state: 'visible' });
  if (!['load-error', 'empty'].includes(scenario)) {
    await page.waitForFunction(() => document.querySelector('.prism-saved-lines')?.textContent?.includes('Amoxicillin'));
  }
  await page.evaluate(async (language) => {
    const fonts = language === 'ar'
      ? ['14px "Noto Sans Arabic Variable"', '24px "Changa"', '14px "Sora"']
      : ['14px "Sora"'];
    for (const font of fonts) await document.fonts.load(font, language === 'ar' ? 'احتياج Amoxicillin' : 'Annual Amoxicillin');
    await document.fonts.ready;
  }, lang);
  return { context, page, unexpectedNetwork, pageErrors };
}

async function search(page: Page, value = 'DEMO') {
  const input = page.locator(PICKER).getByRole('searchbox');
  await input.fill(value);
  await input.press('Enter');
}

async function prepareEditor(page: Page, lang: Lang, quantity = '11520.125') {
  await search(page);
  await page.locator('.prism-result-row').filter({ hasText: 'DEMO-001' }).getByRole('button').click();
  await page.locator('.prism-result-row').filter({ hasText: 'DEMO-002' }).getByRole('button').click();
  const workspace = page.locator(WORKSPACE);
  await workspace.getByRole('combobox', { name: labels(lang).beneficiary, exact: true }).selectOption('fixture-beneficiary');
  await workspace.getByRole('combobox', { name: labels(lang).item, exact: true }).selectOption('fixture-amoxicillin');
  await workspace.locator('.prism-quantity-input').fill(quantity);
  await workspace.getByRole('textbox', { name: labels(lang).reason, exact: true }).fill(lang === 'ar' ? 'اختبار العرض فقط' : 'Rendering test only');
}

async function fixtureSnapshot(page: Page) {
  return page.evaluate(() => (window as unknown as { __prismNeedsFixture: { snapshot(): { calls: Array<{ method: string; quantityText?: string; itemId?: string }>; events: Array<{ id: string; quantityText: string }>; eventReadCount: number; pending: boolean } } }).__prismNeedsFixture.snapshot());
}

async function metrics(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.prism-workspace')!;
    const width = document.documentElement.clientWidth;
    const clipped: string[] = [];
    const smallTargets: string[] = [];
    const controls = [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, summary')];
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || !el.checkVisibility()) continue;
      // A real two-dimensional table has an independently keyboard-focusable scroll owner.
      const scroll = el.closest<HTMLElement>('.prism-table-scroll');
      if (!scroll && (r.left < -1 || r.right > width + 1)) clipped.push(`${el.tagName}:${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 45)}:${r.left.toFixed(1)}..${r.right.toFixed(1)}`);
      if (el.tagName === 'BUTTON' && (r.height < 24 || r.width < 24)) smallTargets.push(`${el.textContent?.trim()}:${r.width.toFixed(1)}x${r.height.toFixed(1)}`);
    }
    const loadedFontFaces = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, ''));
    const rootBox = root.getBoundingClientRect();
    const focus = document.activeElement instanceof HTMLElement ? getComputedStyle(document.activeElement) : null;
    const quantity = document.querySelector<HTMLInputElement>('.prism-quantity-input');
    const quantityStyle = quantity ? getComputedStyle(quantity) : null;
    let quantityVisibleText: { value: string; contentWidth: number; measuredTextWidth: number; scrollWidth: number; clientWidth: number; fits: boolean } | null = null;
    if (quantity && quantityStyle) {
      const context = document.createElement('canvas').getContext('2d')!;
      context.font = `${quantityStyle.fontWeight} ${quantityStyle.fontSize} ${quantityStyle.fontFamily}`;
      const contentWidth = quantity.clientWidth - parseFloat(quantityStyle.paddingLeft) - parseFloat(quantityStyle.paddingRight);
      const measuredTextWidth = context.measureText(quantity.value).width + (parseFloat(quantityStyle.letterSpacing) || 0) * Math.max(0, quantity.value.length - 1);
      quantityVisibleText = { value: quantity.value, contentWidth, measuredTextWidth, scrollWidth: quantity.scrollWidth, clientWidth: quantity.clientWidth,
        fits: measuredTextWidth <= contentWidth + 1 && quantity.scrollWidth <= quantity.clientWidth + 1 };
    }
    const latinName = [...root.querySelectorAll<HTMLElement>('.prism-material-identity__name bdi')].find((el) => el.textContent?.includes('Amoxicillin'));
    const latinNameStyle = latinName ? getComputedStyle(latinName) : null;
    let latinMaterialWordLines: number | null = null;
    if (latinName?.firstChild?.nodeType === Node.TEXT_NODE) {
      const offset = latinName.firstChild.textContent?.indexOf('Amoxicillin') ?? -1;
      if (offset >= 0) {
        const range = document.createRange();
        range.setStart(latinName.firstChild, offset); range.setEnd(latinName.firstChild, offset + 'Amoxicillin'.length);
        latinMaterialWordLines = range.getClientRects().length;
      }
    }
    return {
      documentOverflow: Math.max(0, document.documentElement.scrollWidth - width),
      overflowNodes: [...root.querySelectorAll<HTMLElement>('*')].filter((el) => {
        const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.left < -1 || r.right > width + 1);
      }).slice(0, 25).map((el) => ({ tag: el.tagName, className: el.className,
        text: el.textContent?.trim().slice(0, 40), left: el.getBoundingClientRect().left,
        right: el.getBoundingClientRect().right, position: getComputedStyle(el).position,
        offsetParent: el.offsetParent instanceof HTMLElement ? el.offsetParent.className : null })),
      rootFits: rootBox.left >= -1 && rootBox.right <= width + 1,
      clipped, smallTargets, loadedFontFaces: [...new Set(loadedFontFaces)],
      documentLang: document.documentElement.lang, documentDirection: document.documentElement.dir,
      rootLang: root.lang, rootDirection: getComputedStyle(root).direction,
      rootFont: getComputedStyle(root).fontFamily,
      headingFont: getComputedStyle(root.querySelector('h2')!).fontFamily,
      theme: document.documentElement.dataset.theme,
      markers: { pharma: document.documentElement.dataset.pharmaDesign, phase: document.documentElement.dataset.phoenixUiPhase, visual: document.documentElement.dataset.phoenixVisual },
      quantityDirection: quantityStyle?.direction ?? null,
      quantityFont: quantityStyle?.fontFamily ?? null,
      quantityFontSize: quantityStyle?.fontSize ?? null,
      quantityFontWeight: quantityStyle?.fontWeight ?? null,
      quantityVisibleText,
      latinMaterialFont: latinNameStyle?.fontFamily ?? null,
      latinMaterialFontSize: latinNameStyle?.fontSize ?? null,
      latinMaterialDirection: latinNameStyle?.direction ?? null,
      latinMaterialWordLines,
      focusOutline: focus ? { style: focus.outlineStyle, width: focus.outlineWidth, shadow: focus.boxShadow } : null,
      tables: [...root.querySelectorAll<HTMLElement>('.prism-table-scroll')].map((el) => ({ role: el.getAttribute('role'), tabIndex: el.tabIndex, hasHorizontalScroll: el.scrollWidth > el.clientWidth })),
    };
  });
}

async function capture(page: Page, name: string, fullPage = false) {
  if (await page.locator(PICKER).isVisible()) await page.locator(PICKER).screenshot({ path: join(EVIDENCE, `${name}-picker.png`) });
  if (await page.locator(WORKSPACE).isVisible()) await page.locator(WORKSPACE).screenshot({ path: join(EVIDENCE, `${name}-editor.png`) });
  if (fullPage) await page.screenshot({ path: join(EVIDENCE, `${name}-page.png`), fullPage: true });
}

describe.skipIf(!ENABLED)('PRISM actual manual journey browser acceptance', () => {
  beforeAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true });
    sourceBefore = sourceHashes();
    const executable = process.env.PRISM_CHROMIUM_PATH ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    if (!executable || !existsSync(executable)) throw new Error('Set PRISM_CHROMIUM_PATH to an installed Chromium executable.');
    server = await createServer({ root: ROOT, cacheDir: join(EVIDENCE, 'vite-cache'), logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: false,
        // Isolated checkouts can symlink individual installed packages, not node_modules itself.
        // Font URLs resolve to those packages. Allow only the three actual font roots,
        // retaining Vite's default deny rules and the ordinary application boundary.
        fs: { allow: [ROOT, join(EVIDENCE, 'vite-cache'),
          ...['@fontsource-variable/inter', '@fontsource/ibm-plex-sans-arabic', '@fontsource-variable/noto-sans-arabic']
            .map((name) => realpathSync(join(ROOT, 'node_modules', name)))] } },
      optimizeDeps: { entries: ['tests/browser/prism-needs.visual.html'] },
      define: {
        // No real client is constructed. Every exercised service is an explicit component prop.
        'import.meta.env.VITE_PHOENIX_SUPABASE_URL': JSON.stringify(''),
        'import.meta.env.VITE_PHOENIX_SUPABASE_ANON_KEY': JSON.stringify(''),
      },
    });
    await server.listen();
    baseUrl = server.resolvedUrls?.local[0] ?? '';
    if (!baseUrl) throw new Error('No local Vite URL.');
    browser = await chromium.launch({ executablePath: executable, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }, 60000);

  afterAll(async () => {
    const sourceAfter = sourceHashes();
    writeFileSync(join(EVIDENCE, 'browser-evidence.json'), JSON.stringify({
      scope: 'Real product rendering and component behavior with deterministic service fixtures; no real Auth, DB, RLS or server acceptance.',
      browser: browser?.version(), runtime: process.version,
      sourceBefore, sourceAfter, sourcesStableDuringRun: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter), records,
    }, null, 2));
    await browser?.close();
    await server?.close();
  });

  for (const lang of ['ar', 'en'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1366, 1024, 390, 320]) {
    it(`renders ${lang}/${theme}/${width} with picker, editor, fonts and safe inline bounds`, async () => {
      const scene = await openScene({ lang, theme, width });
      try {
        await prepareEditor(scene.page, lang);
        await scene.page.locator(PICKER).getByRole('searchbox').focus();
        await scene.page.keyboard.press('Tab');
        const result = await metrics(scene.page);
        await capture(scene.page, `${lang}-${theme}-${width}`, width === 1366 || width === 390);
        records.push({ test: 'layout', lang, width, ...result, unexpectedNetwork: scene.unexpectedNetwork, pageErrors: scene.pageErrors });
        expect(result.documentOverflow, JSON.stringify(result)).toBe(0);
        expect(result.rootFits).toBe(true);
        expect(result.clipped).toEqual([]);
        expect(result.smallTargets).toEqual([]);
        expect(result.rootDirection).toBe(lang === 'ar' ? 'rtl' : 'ltr');
        expect(result.rootFont).toContain(lang === 'ar' ? 'Noto Sans Arabic Variable' : 'Sora');
        expect(result.headingFont).toContain(lang === 'ar' ? 'Changa' : 'Sora');
        expect(result.quantityDirection).toBe('ltr');
        expect(result.quantityFont).toContain('Sora');
        expect(result.quantityFontSize).toBe('21px');
        expect(result.quantityFontWeight).toBe('650');
        expect(result.quantityVisibleText?.value).toBe('11520.125');
        expect(result.quantityVisibleText?.fits, JSON.stringify(result.quantityVisibleText)).toBe(true);
        expect(result.latinMaterialFont).toContain('Sora');
        expect(result.latinMaterialDirection).toBe('ltr');
        expect(result.latinMaterialWordLines).toBe(1);
        expect(result.documentLang).toBe(lang);
        expect(result.theme).toBe(theme);
        expect(result.markers).toEqual({ pharma: 'molecular', phase: 'a', visual: 'daylight' });
        expect(result.loadedFontFaces).toContain('Sora');
        if (lang === 'ar') { expect(result.loadedFontFaces).toContain('Changa'); expect(result.loadedFontFaces).toContain('Noto Sans Arabic Variable'); }
        expect(result.focusOutline?.style).not.toBe('none');
        expect(parseFloat(result.focusOutline?.width ?? '0')).toBeGreaterThanOrEqual(2);
        expect(scene.unexpectedNetwork).toEqual([]);
        expect(scene.pageErrors).toEqual([]);
      } finally { await scene.context.close(); }
    }, 45000);
  }

  it('preserves selection across keyboard searches and removing it never voids saved lines', async () => {
    const scene = await openScene({ lang: 'en', width: 1024 });
    try {
      await search(scene.page, 'Amoxicillin');
      const use = scene.page.locator('.prism-result-row').getByRole('button');
      await use.focus(); await scene.page.keyboard.press('Enter');
      await search(scene.page, 'Paracetamol');
      await scene.page.locator('.prism-result-row').getByRole('button').focus();
      await scene.page.keyboard.press('Space');
      expect(await scene.page.locator('.prism-selected-row').count()).toBe(2);
      expect(await scene.page.locator('.prism-selected-list').textContent()).toContain('Amoxicillin');
      const before = await fixtureSnapshot(scene.page);
      const remove = scene.page.getByRole('button', { name: 'Remove Amoxicillin 500 mg', exact: true });
      await remove.focus(); await scene.page.keyboard.press('Enter');
      expect(await scene.page.locator('.prism-selected-row').count()).toBe(1);
      expect(await scene.page.locator('.prism-saved-lines').textContent()).toContain('2400.125');
      expect(await scene.page.locator('.prism-saved-lines').textContent()).toContain('Amoxicillin');
      const after = await fixtureSnapshot(scene.page);
      expect(after.events).toEqual(before.events);
      expect(after.calls.filter((c) => c.method === 'voidManualNeedLine')).toEqual([]);
      await capture(scene.page, 'keyboard-selection-remove');
      records.push({ test: 'keyboard-selection-remove', eventCount: after.events.length, forbiddenVoidCalls: 0, unexpectedNetwork: scene.unexpectedNetwork, pageErrors: scene.pageErrors });
      expect(scene.unexpectedNetwork).toEqual([]); expect(scene.pageErrors).toEqual([]);
    } finally { await scene.context.close(); }
  }, 30000);

  for (const scenario of ['empty', 'search-error', 'load-error', 'readonly']) for (const width of [1366, 390]) {
    it(`renders the real ${scenario} state at ${width} without claiming saved or approved results`, async () => {
      const scene = await openScene({ lang: 'ar', theme: 'dark', width, scenario });
      try {
        let emptyTextBounds: { ownerOverflow: number; tableScrollOwners: number; linesVisible: boolean; ownerBounds: { left: number; right: number }; paragraphs: Array<{ text: string; lineCount: number; lineBounds: Array<{ left: number; right: number }> }> } | null = null;
        if (scenario === 'empty' || scenario === 'search-error') await search(scene.page);
        if (scenario === 'empty') {
          await scene.page.locator('.prism-search-state').waitFor({ state: 'visible' });
          expect(await scene.page.locator('.prism-saved-lines').textContent()).toContain('لا توجد أسطر');
          emptyTextBounds = await scene.page.locator('.prism-empty-records').evaluate((owner) => {
            const panel = owner as HTMLElement;
            const bounds = panel.getBoundingClientRect();
            const viewportWidth = document.documentElement.clientWidth;
            const paragraphs = [...panel.querySelectorAll('p')].map((paragraph) => {
              const range = document.createRange();
              range.selectNodeContents(paragraph);
              const lines = [...range.getClientRects()];
              return {
                text: paragraph.textContent?.trim() ?? '', lineCount: lines.length,
                lineBounds: lines.map((line) => ({ left: line.left, right: line.right })),
                visible: lines.length > 0 && lines.every((line) => line.left >= Math.max(0, bounds.left) - 1 && line.right <= Math.min(viewportWidth, bounds.right) + 1),
              };
            });
            return {
              ownerOverflow: Math.max(0, panel.scrollWidth - panel.clientWidth),
              tableScrollOwners: panel.closest('.prism-saved-lines')?.querySelectorAll('.prism-table-scroll').length ?? -1,
              linesVisible: paragraphs.length === 2 && paragraphs.every((paragraph) => paragraph.visible),
              ownerBounds: { left: bounds.left, right: bounds.right },
              paragraphs: paragraphs.map(({ text, lineCount, lineBounds }) => ({ text, lineCount, lineBounds })),
            };
          });
        }
        if (scenario === 'search-error') await scene.page.locator(`${PICKER} [role="alert"]`).waitFor({ state: 'visible' });
        if (scenario === 'load-error') await scene.page.locator(`${WORKSPACE} [role="alert"]`).waitFor({ state: 'visible' });
        if (scenario === 'readonly') { expect(await scene.page.locator('.prism-line-form').count()).toBe(0); expect(await scene.page.locator(PICKER).count()).toBe(0); }
        const result = await metrics(scene.page);
        await capture(scene.page, `state-${scenario}-${width}`, true);
        records.push({ test: 'state', scenario, width, ...result, emptyTextBounds, unexpectedNetwork: scene.unexpectedNetwork, pageErrors: scene.pageErrors });
        expect(result.documentOverflow).toBe(0); expect(result.clipped).toEqual([]);
        if (emptyTextBounds) {
          expect(emptyTextBounds.ownerOverflow).toBe(0);
          expect(emptyTextBounds.tableScrollOwners).toBe(0);
          expect(emptyTextBounds.linesVisible).toBe(true);
        }
        expect(scene.unexpectedNetwork).toEqual([]); expect(scene.pageErrors).toEqual([]);
      } finally { await scene.context.close(); }
    }, 30000);
  }

  it('keeps exact quantity text after a fixture refusal and performs no optimistic save', async () => {
    const scene = await openScene({ lang: 'en', width: 390, scenario: 'write-error' });
    try {
      await prepareEditor(scene.page, 'en', EXACT_QUANTITY);
      await scene.page.locator(WORKSPACE).getByRole('button', { name: 'Add line', exact: true }).click();
      await scene.page.locator(`${WORKSPACE} [role="alert"]`).filter({ hasText: /./ }).first().waitFor({ state: 'visible' });
      expect(await scene.page.locator('.prism-quantity-input').inputValue()).toBe(EXACT_QUANTITY);
      const snapshot = await fixtureSnapshot(scene.page);
      expect(snapshot.calls.filter((c) => c.method === 'addManualNeedLine').map((c) => c.quantityText)).toEqual([EXACT_QUANTITY]);
      expect(snapshot.events).toHaveLength(1);
      expect(snapshot.events[0].quantityText).toBe('2400.125');
      expect(snapshot.eventReadCount).toBeGreaterThanOrEqual(2);
      await capture(scene.page, 'state-write-error-exact-quantity', true);
      records.push({ test: 'exact-quantity-refusal', quantity: EXACT_QUANTITY, eventCount: snapshot.events.length, rereadCount: snapshot.eventReadCount, unexpectedNetwork: scene.unexpectedNetwork });
      expect(scene.unexpectedNetwork).toEqual([]); expect(scene.pageErrors).toEqual([]);
    } finally { await scene.context.close(); }
  }, 30000);

  it('shows pending controls, prevents a duplicate submit and honors reduced motion', async () => {
    const scene = await openScene({ lang: 'ar', theme: 'dark', width: 320, scenario: 'pending', reducedMotion: true });
    try {
      await prepareEditor(scene.page, 'ar', EXACT_QUANTITY);
      const save = scene.page.locator(WORKSPACE).getByRole('button', { name: 'إضافة سطر', exact: true });
      await save.dblclick({ delay: 15 });
      await scene.page.waitForFunction(() => document.querySelector('.prism-line-form')?.getAttribute('aria-busy') === 'true');
      expect(await save.isDisabled()).toBe(true);
      expect(await scene.page.locator('.prism-quantity-input').isDisabled()).toBe(true);
      const snapshot = await fixtureSnapshot(scene.page);
      expect(snapshot.pending).toBe(true);
      expect(snapshot.calls.filter((c) => c.method === 'addManualNeedLine')).toHaveLength(1);
      expect(snapshot.events).toHaveLength(1);
      const motion = await scene.page.evaluate(() => ({ reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        animations: [...document.querySelectorAll('.prism-loading__dot')].map((el) => ({ name: getComputedStyle(el).animationName, duration: getComputedStyle(el).animationDuration })),
        quantityTransition: getComputedStyle(document.querySelector('.prism-quantity-input')!).transitionDuration }));
      await capture(scene.page, 'state-pending-reduced-motion', true);
      records.push({ test: 'pending-reduced-motion', ...motion, ...await metrics(scene.page), writeCount: 1, eventCount: snapshot.events.length });
      expect(motion.reduced).toBe(true);
      expect(motion.animations.every((a) => a.name === 'none' || parseFloat(a.duration) <= 0.01)).toBe(true);
      expect(motion.quantityTransition.split(',').every((d) => parseFloat(d) <= 0.01)).toBe(true);
      await scene.page.evaluate(() => (window as unknown as { __prismNeedsFixture: { rejectPending(): void } }).__prismNeedsFixture.rejectPending());
      await scene.page.waitForFunction(() => document.querySelector('.prism-line-form')?.getAttribute('aria-busy') === 'false');
      expect(await scene.page.locator('.prism-quantity-input').inputValue()).toBe(EXACT_QUANTITY);
      expect(scene.unexpectedNetwork).toEqual([]); expect(scene.pageErrors).toEqual([]);
    } finally { await scene.context.close(); }
  }, 30000);
});
