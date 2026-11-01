/** Real authenticated P4-A evidence. Uses only the disposable E2E stack. */
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const base = new URL(process.argv[2] || 'http://127.0.0.1:4173');
const seed = JSON.parse(readFileSync(process.argv[3] || 'e2e-seed.json', 'utf8'));
const local = value => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname);
if (!local(base.href) || !local(seed.supabaseUrl) || !local(seed.databaseUrl)) {
  throw new Error('P4-A acceptance requires the disposable loopback-only app, Auth and database');
}
const out = resolve('docs/phoenix/e2e-acceptance/p4a');
mkdirSync(out, { recursive: true });
const report = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  recordedAt: new Date().toISOString(), base: base.href,
  database: 'disposable local Supabase; synthetic fixtures; real Auth/RLS',
  referenceParity: 'HOLD: framed concept references require separate human visual review',
  checks: [], matrix: [], errors: [],
};
const check = (name, passed, detail = null) => {
  report.checks.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'} P4-A ${name}`);
};
let browser;
try { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
catch { browser = await chromium.launch({ headless: true }); }

async function login(user) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', e => report.errors.push({ type: 'pageerror', message: e.message }));
  page.on('requestfailed', r => {
    if (r.failure()?.errorText !== 'net::ERR_ABORTED') report.errors.push({ type: 'network', url: r.url().split('?')[0], error: r.failure()?.errorText });
  });
  page.on('response', r => {
    if (r.status() >= 500) report.errors.push({ type: 'server', status: r.status(), url: r.url().split('?')[0] });
  });
  await page.goto(base.href);
  await page.locator('#login-email').fill(user.email);
  await page.locator('#login-password').fill(seed.password);
  await page.locator('button[type=submit]').click();
  await page.locator('#phoenix-main').waitFor({ timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await settleView(page);
  return { context, page };
}

async function settleView(page) {
  await page.waitForLoadState('networkidle');
  await page.locator('#phoenix-main .nexus-loading, #phoenix-main [data-rac3-state="loading"]').waitFor({ state: 'detached', timeout: 20000 });
  await page.evaluate(async () => {
    const animations = document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().iterations));
    await Promise.all(animations.map(a => a.finished.catch(() => {})));
    await document.fonts.ready;
  });
}

async function appearance(page, lang, theme) {
  if (await page.locator('html').getAttribute('lang') !== lang) {
    await page.locator('.premium-topbar .nexus-control--language').click();
  }
  if (await page.locator('html').getAttribute('data-theme') !== theme) {
    await page.getByRole('button', { name: theme === 'dark' ? /^(Activate dark theme|تفعيل المظهر الداكن)$/ : /^(Activate light theme|تفعيل المظهر الفاتح)$/ }).click();
  }
  await page.waitForFunction(({ lang, theme }) => document.documentElement.lang === lang && document.documentElement.dataset.theme === theme, { lang, theme });
  await page.evaluate(() => document.fonts.ready);
}

async function navigate(page, label, mobile) {
  if (mobile) await page.locator('.premium-drawer-trigger').click();
  const nav = mobile ? page.locator('#phoenix-mobile-drawer nav') : page.locator('.premium-sidebar nav');
  await nav.getByRole('button', { name: label, exact: true }).click();
  if (mobile) await page.locator('#phoenix-mobile-drawer').waitFor({ state: 'detached' });
  await settleView(page);
}

try {
  const { context, page } = await login(seed.users.institutionAdminA);
  check('L2 real UI sign-in', true);
  for (const width of [1366, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const lang of ['ar', 'en']) for (const theme of ['light', 'dark']) {
      await appearance(page, lang, theme);
      const id = `${width}-${lang}-${theme}`;
      await page.screenshot({ path: resolve(out, `${id}-statistics.png`), fullPage: true });
      const measured = await page.evaluate(() => {
        const shell = document.querySelector('.prism-shell');
        const top = document.querySelector('.premium-topbar');
        const sidebar = document.querySelector('.prism-shell > .premium-sidebar');
        const active = sidebar?.querySelector('[aria-current=page]');
        const controls = [...top.querySelectorAll('button')].filter(el => el.getClientRects().length);
        return {
          dir: shell.dir, lang: document.documentElement.lang,
          overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
          topbar: getComputedStyle(top).backgroundColor,
          panelToken: getComputedStyle(shell).getPropertyValue('--p4-panel').trim(),
          headingFont: getComputedStyle(top.querySelector('h1')).fontFamily,
          sidebarWidth: sidebar?.getBoundingClientRect().width ?? null,
          activeBackground: active ? getComputedStyle(active).backgroundColor : null,
          controlSizes: controls.map(el => ({ label: el.getAttribute('aria-label'), width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })),
        };
      });
      check(`${id} direction`, measured.dir === (lang === 'ar' ? 'rtl' : 'ltr'));
      check(`${id} document overflow`, measured.overflow <= 1, measured.overflow);
      check(`${id} PRISM topbar palette`, measured.topbar === (theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(12, 32, 55)'), measured.topbar);
      check(`${id} heading font`, measured.headingFont.includes(lang === 'ar' ? 'Changa' : 'Sora'), measured.headingFont);
      check(`${id} touch controls`, measured.controlSizes.every(s => s.width >= 43.5 && s.height >= 43.5), measured.controlSizes);
      if (width >= 768) {
        check(`${id} compact reference rail`, Math.abs(measured.sidebarWidth - 88) <= 1, measured.sidebarWidth);
        const beforeLabels = await page.locator('#phoenix-desktop-navigation .premium-nav-item').allTextContents();
        await page.locator('.prism-rail-toggle').click();
        const expandedWidth = await page.locator('.prism-shell > .premium-sidebar').evaluate(el => el.getBoundingClientRect().width);
        check(`${id} expanded labels preserve navigation`, expandedWidth >= 279 && JSON.stringify(beforeLabels) === JSON.stringify(await page.locator('#phoenix-desktop-navigation .premium-nav-item').allTextContents()));
        if (id === '1366-ar-light') await page.screenshot({ path: resolve(out, `${id}-expanded.png`), fullPage: true });
        await page.locator('.prism-rail-toggle').click();
      }
      const search = page.locator('.prism-command-search');
      await search.click();
      const palette = page.getByRole('dialog', { name: lang === 'ar' ? 'لوحة الأوامر' : 'Command Palette', exact: true });
      await palette.waitFor();
      check(`${id} visible search opens canonical palette`, await palette.locator('input').isVisible());
      await page.keyboard.press('Escape');
      await palette.waitFor({ state: 'detached' });
      check(`${id} search restores focus`, await search.evaluate(el => el === document.activeElement));
      if (width < 768) {
        const trigger = page.locator('.premium-drawer-trigger');
        await trigger.click();
        const drawer = page.locator('#phoenix-mobile-drawer');
        await drawer.waitFor();
        await drawer.locator('.premium-mobile-drawer').evaluate(async el => {
          await Promise.all(el.getAnimations().map(a => a.finished.catch(() => {})));
        });
        await page.screenshot({ path: resolve(out, `${id}-drawer.png`), fullPage: true });
        const d = await drawer.evaluate(el => {
          const panel = el.querySelector('.premium-mobile-drawer');
          const r = panel.getBoundingClientRect();
          return { left: r.left, right: r.right, width: innerWidth, focusInside: panel.contains(document.activeElement), inertBackground: document.querySelector('.nexus-app-column').inert };
        });
        check(`${id} drawer bounds/focus/inert`, d.left >= 0 && d.right <= d.width + 1 && d.focusInside && d.inertBackground, d);
        await page.keyboard.press('Escape');
        await drawer.waitFor({ state: 'detached' });
        check(`${id} Escape restores trigger focus`, await trigger.evaluate(el => el === document.activeElement));
        await trigger.click();
        await drawer.getByRole('button', { name: lang === 'ar' ? 'إغلاق' : 'Close', exact: true }).click();
        await drawer.waitFor({ state: 'detached' });
        await trigger.click();
        await drawer.getByRole('button', { name: lang === 'ar' ? 'مركز المخزون' : 'Inventory Center', exact: true }).click();
        await drawer.waitFor({ state: 'detached' });
      } else {
        await navigate(page, lang === 'ar' ? 'مركز المخزون' : 'Inventory Center', false);
      }
      await page.locator('[data-pharma-screen="3"]').waitFor();
      await settleView(page);
      await page.screenshot({ path: resolve(out, `${id}-materials.png`), fullPage: true });
      await navigate(page, lang === 'ar' ? 'الإحصائيات' : 'Statistics', width < 768);
      report.matrix.push({ id, ...measured });
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1366, height: 900 });
  const transition = await page.locator('.premium-sidebar .premium-nav-item').first().evaluate(el => getComputedStyle(el).transitionDuration);
  check('Reduced motion removes rail transitions', transition.split(',').every(v => parseFloat(v) === 0), transition);
  await context.close();
  for (const [tier, user] of [['L1', seed.users.fixtureAdmin], ['L3', seed.users.outletOfficerA]]) {
    const s = await login(user);
    check(`${tier} real UI sign-in`, true);
    await s.page.screenshot({ path: resolve(out, `${tier}-landing.png`), fullPage: true });
    if (tier === 'L3') check('L3 institution administration hidden', await s.page.locator('nav').getByRole('button', { name: /^(Institutions|إدارة المؤسسات)$/ }).count() === 0);
    await s.context.close();
  }
  check('No runtime/network/server errors', report.errors.length === 0, report.errors);
} catch (e) {
  check('capture completed', false, e.message);
} finally {
  await browser.close();
  report.passed = report.checks.every(c => c.passed) && report.matrix.length === 16;
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`P4-A matrix ${report.matrix.length}/16; ${report.checks.filter(c => !c.passed).length} failed checks; reference parity remains HOLD`);
  if (!report.passed) process.exitCode = 1;
}
