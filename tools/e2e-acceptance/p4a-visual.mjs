/** Real authenticated P4-A evidence. Uses only the disposable E2E stack. */
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const base = new URL(process.argv[2] || 'http://127.0.0.1:4173');
const seed = JSON.parse(readFileSync(process.argv[3] || 'e2e-seed.json', 'utf8'));
const local = value => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname);
if (!local(base.href) || !local(seed.supabaseUrl) || !local(seed.databaseUrl)) {
  throw new Error('P4-A acceptance requires the disposable loopback-only app, Auth and database');
}
// Complete this disposable actor's own warehouse scope. Its role/default
// permissions and the independent cross-organization fixture stay unchanged.
const fixtureDb = new pg.Client({ connectionString: seed.databaseUrl });
await fixtureDb.connect();
try {
  const owner = await fixtureDb.query(`SELECT p.id FROM public.profiles p
    JOIN public.warehouses w ON w.organization_id=p.organization_id
    WHERE p.id=$1 AND p.role='institution_admin' AND p.organization_id=$2 AND w.id=$3`,
  [seed.users.institutionAdminA.id, seed.orgA, seed.stageE.whA]);
  if (owner.rowCount !== 1) throw new Error('P4-A synthetic warehouse ownership mismatch');
  await fixtureDb.query(`INSERT INTO public.profile_scope_assignments
    (profile_id,organization_id,scope_type,warehouse_id,is_active)
    VALUES ($1,$2,'warehouse',$3,true) ON CONFLICT DO NOTHING`,
  [seed.users.institutionAdminA.id, seed.orgA, seed.stageE.whA]);
} finally { await fixtureDb.end(); }
const out = resolve('docs/phoenix/e2e-acceptance/p4a');
mkdirSync(out, { recursive: true });
const report = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceHead: process.env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request?.head?.sha ?? process.env.GITHUB_SHA
    : execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  recordedAt: new Date().toISOString(), base: base.href,
  database: 'disposable local Supabase; synthetic fixtures; real Auth/RLS',
  referenceParity: 'HOLD: framed concept references require separate human visual review',
  checks: [], matrix: [], annualMatrix: [], errors: [],
};
const check = (name, passed, detail = null) => {
  report.checks.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'} P4-A ${name}`);
};
function contrast(foreground, background) {
  const luminance = color => {
    if (!/^rgba?\(/.test(color)) return null;
    const channels = color.match(/[\d.]+/g).map(Number);
    if (channels.length === 4 && channels[3] !== 1) return null;
    const linear = channels.slice(0, 3).map(v => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const fg = luminance(foreground), bg = luminance(background);
  return fg === null || bg === null ? null : (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}
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
  await page.waitForFunction(() => !document.querySelector('#phoenix-main .nexus-loading, #phoenix-main [data-rac3-state="loading"]'), null, { timeout: 20000 });
  await page.evaluate(async () => {
    const animations = document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().iterations));
    await Promise.all(animations.map(a => a.finished.catch(() => {})));
    await document.fonts.ready;
  });
  // KPI counters use requestAnimationFrame rather than CSS animations. Capture
  // their settled values, never a transient count-up presented as current stock.
  let previous = null;
  let stable = 0;
  for (let sample = 0; sample < 50; sample += 1) {
    const values = await page.locator('.rac3-kpi__value').allTextContents();
    if (values.length === 0) return;
    const current = JSON.stringify(values);
    stable = current === previous ? stable + 1 : 0;
    if (stable >= 3) return;
    previous = current;
    await page.waitForTimeout(120);
  }
  throw new Error('Statistics counters did not settle before evidence capture');
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
  await settleView(page);
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
        const heading = top.querySelector('h1');
        return {
          dir: shell.dir, lang: document.documentElement.lang,
          overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
          topbar: getComputedStyle(top).backgroundColor,
          panelToken: getComputedStyle(shell).getPropertyValue('--p4-panel').trim(),
          headingFont: getComputedStyle(top.querySelector('h1')).fontFamily,
          headingWidth: heading.getBoundingClientRect().width,
          headingHeight: heading.getBoundingClientRect().height,
          headingLineHeight: parseFloat(getComputedStyle(heading).lineHeight),
          sidebarWidth: sidebar?.getBoundingClientRect().width ?? null,
          activeBackground: active ? getComputedStyle(active).backgroundColor : null,
          controlSizes: controls.map(el => ({ label: el.getAttribute('aria-label'), width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height,
            foreground: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor,
            transitionProperty: getComputedStyle(el).transitionProperty, transitionDuration: getComputedStyle(el).transitionDuration })),
        };
      });
      check(`${id} direction`, measured.dir === (lang === 'ar' ? 'rtl' : 'ltr'));
      check(`${id} document overflow`, measured.overflow <= 1, measured.overflow);
      check(`${id} PRISM topbar palette`, measured.topbar === (theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(12, 32, 55)'), measured.topbar);
      check(`${id} heading font`, measured.headingFont.includes(lang === 'ar' ? 'Changa' : 'Sora'), measured.headingFont);
      check(`${id} readable title`, measured.headingWidth >= 96 && measured.headingHeight <= measured.headingLineHeight * 2 + 1, { width: measured.headingWidth, height: measured.headingHeight });
      check(`${id} touch controls`, measured.controlSizes.every(s => s.width >= 43.5 && s.height >= 43.5), measured.controlSizes);
      const controlContrast = measured.controlSizes.map(s => ({ label: s.label, ratio: contrast(s.foreground, s.background) }));
      check(`${id} settled control contrast`, controlContrast.every(c => c.ratio !== null && c.ratio >= 4.5), controlContrast);
      check(`${id} theme controls avoid unreadable color transitions`, measured.controlSizes.every(s =>
        s.transitionDuration.split(',').every(d => parseFloat(d) === 0)
        || !s.transitionProperty.split(',').some(p => ['all', 'background', 'background-color', 'color'].includes(p.trim()))));
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
      await page.locator('.nexus-it-context-bar select').selectOption(seed.stageE.whA);
      await page.getByRole('tab', { name: lang === 'ar' ? 'رصيد المخزن' : 'Warehouse stock', exact: true }).click();
      await settleView(page);
      await page.locator('.nexus-it-stock-list').getByText('E2E Initial Provisioning Material', { exact: true }).waitFor();
      await page.screenshot({ path: resolve(out, `${id}-materials.png`), fullPage: true });
      check(`${id} real warehouse material workspace`, true);
      await navigate(page, lang === 'ar' ? 'الإحصائيات' : 'Statistics', width < 768);
      report.matrix.push({ id, ...measured });
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1366, height: 900 });
  const transition = await page.locator('.premium-sidebar .premium-nav-item').first().evaluate(el => getComputedStyle(el).transitionDuration);
  check('Reduced motion removes rail transitions', transition.split(',').every(v => parseFloat(v) === 0), transition);
  await context.close();
  for (const [tier, user] of [['platform-admin', seed.users.fixtureAdmin], ['L3', seed.users.outletOfficerA]]) {
    const s = await login(user);
    check(`${tier} real UI sign-in`, true);
    await s.page.screenshot({ path: resolve(out, `${tier}-landing.png`), fullPage: true });
    if (tier === 'L3') check('L3 institution administration hidden', await s.page.locator('nav').getByRole('button', { name: /^(Institutions|إدارة المؤسسات)$/ }).count() === 0);
    await s.context.close();
  }
  const annual = await login(seed.centralNeeds.editor);
  check('L1 pharmacy-department annual-needs editor real UI sign-in', true);
  if (await annual.page.locator('.prism-shell').getAttribute('data-pharma-screen') !== '23') {
    await navigate(annual.page, 'الاحتياج السنوي', false);
  }
  await annual.page.locator('[data-pharma-screen="23"]').waitFor();
  for (const width of [1366, 1024, 390, 320]) {
    await annual.page.setViewportSize({ width, height: 900 });
    for (const lang of ['ar', 'en']) for (const theme of ['light', 'dark']) {
      await appearance(annual.page, lang, theme);
      await settleView(annual.page);
      const id = `${width}-${lang}-${theme}`;
      await annual.page.screenshot({ path: resolve(out, `${id}-annual-needs.png`), fullPage: true });
      const state = await annual.page.locator('#phoenix-main').evaluate(el => ({
        headings: [...el.querySelectorAll('h1,h2,h3')].map(h => h.textContent),
        formControls: el.querySelectorAll('input,select,textarea').length,
        documentOverflow: document.documentElement.scrollWidth - innerWidth,
      }));
      check(`${id} real annual-needs route and viewport`, state.headings.length > 0 && state.documentOverflow <= 1, state);
      report.annualMatrix.push({ id, ...state });
    }
  }
  await annual.context.close();
  check('No runtime/network/server errors', report.errors.length === 0, report.errors);
} catch (e) {
  check('capture completed', false, e.message);
} finally {
  await browser.close();
  report.passed = report.checks.every(c => c.passed) && report.matrix.length === 16 && report.annualMatrix.length === 16;
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`P4-A matrix ${report.matrix.length}/16; ${report.checks.filter(c => !c.passed).length} failed checks; reference parity remains HOLD`);
  if (!report.passed) process.exitCode = 1;
}
