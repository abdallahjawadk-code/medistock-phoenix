/**
 * R1-A5 — S1 (stale / failed stock read) and S2 (self-referential reconciliation).
 *
 * Dynamic proofs of the two pure state functions plus static source assertions
 * (the repository convention for the screen wiring).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reconcileSourceBalances, scopeStockLoad, type StockLoadInput } from '../stock-load-state';

const ROOT = join(__dirname, '..');
const screen = readFileSync(join(ROOT, 'InventoryCenterScreen.tsx'), 'utf8');
const panel = readFileSync(join(ROOT, 'SourceBalancesPanel.tsx'), 'utf8');

const reload = () => undefined;
const loaded = (warehouseId: string, rows: number[]): StockLoadInput<number> => ({
  data: { warehouseId, rows }, loading: false, error: null, reload,
});

describe('S1 — scopeStockLoad never shows another warehouse\'s rows or a failed load\'s rows', () => {
  it('exposes the rows only for the warehouse they were loaded for', () => {
    const s = scopeStockLoad('B', loaded('B', [1, 2]));
    expect(s).toMatchObject({ data: [1, 2], loading: false, error: null });
  });

  it('after a warehouse switch, warehouse A\'s rows are NOT presented for B (loading, not data)', () => {
    const s = scopeStockLoad('B', loaded('A', [9, 9, 9]));
    expect(s.data).toBeNull();
    expect(s.loading).toBe(true);
  });

  it('while the next load is in flight the previous rows are hidden', () => {
    const s = scopeStockLoad('A', { ...loaded('A', [1]), loading: true });
    expect(s.data).toBeNull();
    expect(s.loading).toBe(true);
  });

  it('a failed load shows an error and NO rows, even when the kept rows belong to the same warehouse', () => {
    const s = scopeStockLoad('A', { ...loaded('A', [1, 2, 3]), error: 'boom' });
    expect(s).toMatchObject({ data: null, loading: false, error: 'boom' });
  });

  it('a failed load for B never falls back to A\'s kept rows', () => {
    const s = scopeStockLoad('B', { ...loaded('A', [1, 2, 3]), error: 'boom' });
    expect(s.data).toBeNull();
    expect(s.error).toBe('boom');
  });

  it('no data at all is loading, not "empty"', () => {
    const s = scopeStockLoad('A', { data: null, loading: true, error: null, reload });
    expect(s).toMatchObject({ data: null, loading: true });
  });
});

describe('S1 — screen wiring', () => {
  it('the stock read is tagged with its warehouse and scoped before use', () => {
    expect(screen).toMatch(/scopeStockLoad</);
    expect(screen).toMatch(/warehouseId:\s*activeWarehouseId,/);
  });

  it('StockList renders an explicit error state with retry, not an empty state', () => {
    const list = screen.slice(screen.indexOf('function StockList('));
    const errAt = list.indexOf('state.error');
    const emptyAt = list.indexOf("t('inv_no_stock'");
    expect(errAt).toBeGreaterThan(-1);
    expect(errAt).toBeLessThan(emptyAt);
    expect(list).toMatch(/inv_stock_read_failed/);
  });
});

describe('S2 — reconcileSourceBalances compares against an independent total', () => {
  it('reconciled only when the independent physical total equals the source sum', () => {
    expect(reconcileSourceBalances(10, 10)).toBe('reconciled');
    expect(reconcileSourceBalances(0, 0)).toBe('reconciled');
  });

  it('drift is reported when they differ (the old self-comparison could never do this)', () => {
    expect(reconcileSourceBalances(10, 9)).toBe('drift');
    expect(reconcileSourceBalances(0, 5)).toBe('drift');
  });

  it.each([[null], [undefined], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'is unknown, never reconciled, without a usable independent total (%s)',
    (independent) => {
      expect(reconcileSourceBalances(10, independent as number | null | undefined)).toBe('unknown');
    },
  );

  it('is unknown when the source sum itself is not a finite number', () => {
    expect(reconcileSourceBalances(Number.NaN, 4)).toBe('unknown');
  });
});

describe('S2 — panel wiring', () => {
  it('no longer compares the panel\'s own sum with itself', () => {
    expect(panel).not.toMatch(/physical\s*===\s*sourceSum/);
    expect(panel).not.toMatch(/const physical = total\('on_hand'\)/);
    expect(panel).toMatch(/reconcileSourceBalances\(sourceSum, physicalOnHand\)/);
  });

  it('has an explicit unknown state and the screen supplies the canonical total', () => {
    expect(panel).toMatch(/sb_reconciliation_unknown/);
    expect(screen).toMatch(/physicalOnHand=\{physicalOnHand\}/);
    expect(screen).toMatch(/STOCK_ROW_CAP/);
  });
});
