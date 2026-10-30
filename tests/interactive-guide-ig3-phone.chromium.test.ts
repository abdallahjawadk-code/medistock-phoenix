import { afterAll, beforeAll, expect, it } from 'vitest';
import { createShellBrowser, expectRetirement, selectInventoryWarehouse } from './helpers/pharma-shell-browser';

// Operational tabs survive retirement of their guided tours. Tests exercise
// the real panels and actual phone drawer, not tour overlays or surrogate data.
let rig: Awaited<ReturnType<typeof createShellBrowser>>;
beforeAll(async () => { rig = await createShellBrowser('phone-panels'); }, 120_000);
afterAll(async () => { await rig?.close(); }, 60_000);
const labels = {
  ar: ['رصيد المخزن', 'سجل الحركات', 'واردات تجهيز الدائرة', 'تجهيز المنافذ', 'استلام مرتجعات المنافذ', 'استثناءات مرتجعات المنافذ', 'تصحيحات بانتظار الاعتماد'],
  en: ['Warehouse stock', 'Movement ledger', 'Incoming dept. supplies', 'Dispatch to outlets', 'Receive outlet returns', 'Return exceptions', 'Corrections awaiting approval'],
} as const;
for (const lang of ['ar', 'en'] as const) {
  for (const label of labels[lang]) {
    it(`real phone panel remains accessible without Help — ${lang} ${label}`, async () => {
      const { context, page, foreign, errors } = await rig.open({ width: 375, height: 812, lang, scene: 'inventory' });
      try {
        await selectInventoryWarehouse(page);
        const tab = page.getByRole('tab', { name: label, exact: true });
        await tab.click();
        await expect.poll(() => tab.getAttribute('aria-selected')).toBe('true');
        await expectRetirement(page);
        const drawer = page.locator('.premium-drawer-trigger');
        await drawer.click(); await page.locator('#phoenix-mobile-drawer').waitFor({ state: 'visible' });
        await expectRetirement(page); await page.keyboard.press('Escape');
        await expect.poll(() => page.locator('#phoenix-mobile-drawer').count()).toBe(0);
        expect(await tab.getAttribute('aria-selected')).toBe('true');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]); expect(foreign).toEqual([]);
      } finally { await context.close(); }
    }, 60_000);
  }
}
