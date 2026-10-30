import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createShellBrowser, expectRetirement, selectInventoryWarehouse } from './helpers/pharma-shell-browser';

// Owner retired guide tours; retain the original real-panel scope/refusal
// assertions independently of any guide. No mutation is submitted here.
let rig: Awaited<ReturnType<typeof createShellBrowser>>;
beforeAll(async () => { rig = await createShellBrowser('inventory-permissions'); }, 120_000);
afterAll(async () => { await rig?.close(); }, 60_000);
const QUARANTINE = '[data-guide-id="guide.inventory.quarantine.tab"]';
const SUSPENSIONS = '[data-guide-id="guide.inventory.suspension.tab"]';

for (const width of [390, 1440]) {
  describe(`real Inventory Center authorization without Help, ${width}px`, () => {
    it('read-only operator sees quarantine stock and no release or destruction action', async () => {
      const { context, page, foreign, errors } = await rig.open({ width, lang: 'ar', scene: 'inventory', persona: 'health_center_manager_assigned' });
      try {
        await selectInventoryWarehouse(page); await page.locator(QUARANTINE).click();
        await page.getByText('Paracetamol', { exact: true }).first().waitFor({ state: 'visible' });
        expect(await page.locator('button:has-text("إفراج"),button:has-text("إتلاف")').count()).toBe(0);
        await expectRetirement(page); expect(foreign).toEqual([]); expect(errors).toEqual([]);
      } finally { await context.close(); }
    }, 60_000);
    it('switching warehouses removes a quarantine action granted only at the first warehouse', async () => {
      const { context, page, foreign, errors } = await rig.open({ width, lang: 'ar', scene: 'inventory', persona: 'warehouse_officer_assigned' });
      try {
        await selectInventoryWarehouse(page); await page.locator(QUARANTINE).waitFor({ state: 'visible' });
        await selectInventoryWarehouse(page, 'qa-wh-inst-a-empty');
        await expect.poll(() => page.locator(QUARANTINE).count()).toBe(0);
        await expectRetirement(page); expect(foreign).toEqual([]); expect(errors).toEqual([]);
      } finally { await context.close(); }
    }, 60_000);
    it('organization-wide create claim does not confer lift authority', async () => {
      const { context, page, foreign, errors } = await rig.open({ width, lang: 'ar', scene: 'inventory', persona: 'institution_admin' });
      try {
        await selectInventoryWarehouse(page); await page.locator(SUSPENSIONS).click();
        await page.getByRole('button', { name: 'إيقاف عن الصرف', exact: true }).first().waitFor({ state: 'visible' });
        expect(await page.getByRole('button', { name: 'رفع إيقاف الصرف', exact: true }).count()).toBe(0);
        await expectRetirement(page); expect(foreign).toEqual([]); expect(errors).toEqual([]);
      } finally { await context.close(); }
    }, 60_000);
    it('outlet assignment permits reaching the form but an ungranted exact scope remains refused', async () => {
      const { context, page, foreign, errors } = await rig.open({ width, lang: 'ar', scene: 'inventory', persona: 'outlet_officer_assigned' });
      try {
        await selectInventoryWarehouse(page); await page.locator(SUSPENSIONS).click();
        await page.getByRole('button', { name: 'رفع إيقاف الصرف', exact: true }).first().waitFor({ state: 'visible' });
        await page.getByRole('button', { name: 'إيقاف عن الصرف', exact: true }).first().click();
        await page.getByLabel('اختر المنفذ', { exact: true }).selectOption({ label: 'QA · منفذ الطوارئ' });
        await page.getByText('لا تملك صلاحية إيقاف مواد عن الصرف').waitFor({ state: 'visible' });
        await expectRetirement(page); expect(foreign).toEqual([]); expect(errors).toEqual([]);
      } finally { await context.close(); }
    }, 60_000);
    it('unassigned operator reaches no warehouse or operational panel', async () => {
      const { context, page, foreign, errors } = await rig.open({ width, lang: 'ar', scene: 'inventory', persona: 'warehouse_officer' });
      try {
        await page.getByText('لا تملك صلاحية على أي مخزن').waitFor({ state: 'visible' });
        expect(await page.locator('.nexus-it-context-bar select').count()).toBe(0);
        await expectRetirement(page); expect(foreign).toEqual([]); expect(errors).toEqual([]);
      } finally { await context.close(); }
    }, 60_000);
  });
}
it('exact-scoped operator reaches the form; fixture resolver cannot manufacture a material or enable submission', async () => {
  const { context, page, foreign, errors } = await rig.open({ width: 1440, lang: 'ar', scene: 'inventory', persona: 'central_warehouse_manager' });
  try {
    await selectInventoryWarehouse(page); await page.locator(SUSPENSIONS).click();
    await page.getByRole('button', { name: 'إيقاف عن الصرف', exact: true }).first().click();
    const select = page.getByLabel('اختر المنفذ', { exact: true });
    await select.selectOption({ label: 'QA · منفذ الأطفال' });
    // The existing QA query adapter lacks AbortSignal support used by the
    // resolver. Preserve that boundary: do not patch production services or
    // fabricate a selected material just to obtain an enabled button here.
    await page.getByRole('searchbox', { name: 'إيقاف عن الصرف', exact: true }).fill('Amoxicillin');
    await page.getByTestId('material-resolver-empty').waitFor({ state: 'visible' });
    expect(await page.getByTestId('material-resolver').locator('[role="option"]').count()).toBe(0);
    expect(await page.getByRole('button', { name: 'إيقاف عن الصرف', exact: true }).last().isEnabled()).toBe(false);
    expect(await page.getByText('لا تملك صلاحية إيقاف مواد عن الصرف').count()).toBe(0);
    await expectRetirement(page); expect(foreign).toEqual([]); expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 60_000);
