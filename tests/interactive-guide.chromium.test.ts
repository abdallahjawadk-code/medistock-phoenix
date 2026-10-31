import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createShellBrowser, expectRetirement } from './helpers/pharma-shell-browser';

// Replaces the old guide-tour acceptance after the owner's explicit retirement.
// This checks the actual product shell, never an engine-only test harness.
let rig: Awaited<ReturnType<typeof createShellBrowser>>;
beforeAll(async () => { rig = await createShellBrowser('retirement'); }, 120_000);
afterAll(async () => { await rig?.close(); }, 60_000);

for (const lang of ['ar', 'en'] as const) {
  for (const width of [320, 375, 390, 767, 768, 1024, 1440, 1920]) {
    it(`drawer-only phone / side rail desktop, no help — ${width}px ${lang}`, async () => {
      const { context, page, foreign, errors } = await rig.open({ width, lang });
      try {
        await expectRetirement(page);
        expect(await page.locator('#phoenix-main').evaluate(n => n.getBoundingClientRect().width)).toBeGreaterThan(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width < 768) {
          const menu = page.locator('.premium-drawer-trigger');
          await menu.focus(); await menu.press('Enter');
          await page.locator('#phoenix-mobile-drawer').waitFor({ state: 'visible' });
          await expectRetirement(page);
          const focus = await page.evaluate(() => Boolean(document.activeElement?.closest('#phoenix-mobile-drawer')));
          expect(focus).toBe(true);
          const background = await page.locator('.nexus-app-column').evaluate(n => n.hasAttribute('inert'));
          expect(background).toBe(true);
          await page.keyboard.press('Escape');
          await expect.poll(() => page.locator('#phoenix-mobile-drawer').count()).toBe(0);
          expect(await menu.evaluate(n => n === document.activeElement)).toBe(true);
          expect(await page.locator('.nexus-app-column').evaluate(n => n.hasAttribute('inert'))).toBe(false);
          expect(await page.locator('#phoenix-main').evaluate(n => parseFloat(getComputedStyle(n).paddingBottom))).toBeLessThan(60);
        } else {
          expect(await page.locator('.premium-sidebar').isVisible()).toBe(true);
          expect(await page.locator('.premium-drawer-trigger').count()).toBe(0);
        }
        expect(foreign).toEqual([]); expect(errors).toEqual([]);
      } finally { await context.close(); }
    }, 60_000);
  }
}
for (const width of [390, 1024, 1440]) {
  it(`theme/language remain usable without the retired guide — ${width}px`, async () => {
    const { context, page, errors, foreign } = await rig.open({ width, theme: 'dark', reducedMotion: 'reduce' });
    try {
      await page.getByRole('button', { name: 'Switch to Arabic', exact: true }).click();
      await expect.poll(() => page.locator('.premium-shell').getAttribute('dir')).toBe('rtl');
      await page.getByRole('button', { name: 'تفعيل المظهر الفاتح', exact: true }).click();
      await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('light');
      await expectRetirement(page); expect(errors).toEqual([]); expect(foreign).toEqual([]);
    } finally { await context.close(); }
  }, 60_000);
}
it('all allowed pages remain reachable through the drawer and agree with the desktop rail', async () => {
  const { context, page, errors, foreign } = await rig.open({ width: 390 });
  try {
    await page.locator('.premium-drawer-trigger').click();
    const mobile = await page.locator('.premium-drawer-nav .premium-nav-item').allTextContents();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.premium-sidebar').waitFor({ state: 'visible' });
    const desktop = await page.locator('.premium-sidebar nav .premium-nav-item').allTextContents();
    expect(mobile.map(s => s.trim()).sort()).toEqual(desktop.map(s => s.trim()).sort());
    expect(mobile.length).toBeGreaterThan(5);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.premium-drawer-trigger').click();
    await page.locator('.premium-drawer-nav').getByRole('button', { name: 'Statistics', exact: true }).click();
    await expect.poll(() => page.locator('.premium-topbar h1').innerText()).toBe('Statistics');
    expect(await page.locator('#phoenix-mobile-drawer').count()).toBe(0);
    await expectRetirement(page); expect(errors).toEqual([]); expect(foreign).toEqual([]);
  } finally { await context.close(); }
}, 60_000);
it('navigation and reload create no guide persistence state', async () => {
  const { context, page, errors, foreign } = await rig.open({ width: 390 });
  try {
    await page.locator('.premium-drawer-trigger').click(); await page.keyboard.press('Escape');
    await page.reload(); await page.locator('.premium-topbar').waitFor({ state: 'visible' });
    const keys = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
    expect(keys.filter(k => /guide/i.test(k))).toEqual([]);
    await expectRetirement(page); expect(errors).toEqual([]); expect(foreign).toEqual([]);
  } finally { await context.close(); }
}, 60_000);
