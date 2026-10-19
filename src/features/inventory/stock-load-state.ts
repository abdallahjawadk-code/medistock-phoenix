/**
 * R1-A5 / S1 and S2 — honest stock-read state and honest reconciliation.
 *
 * S1. `useAsync` keeps the previous result while the next load runs and keeps it
 *     when the next load FAILS. A warehouse switch (or a failed reload) therefore
 *     left warehouse A's stock rows on screen as if they were warehouse B's.
 *     `scopeStockLoad` only ever exposes rows that were loaded FOR the active
 *     warehouse, and never exposes rows when the latest load failed.
 *
 * S2. The source-balances panel compared the sum of its own rows with the sum of
 *     its own rows ("physical = sourceSum"), so it could never report drift.
 *     `reconcileSourceBalances` compares against an INDEPENDENT physical total
 *     (the canonical warehouse-stock read) and answers `unknown` when that total
 *     is not available — it never answers `reconciled` without evidence.
 */
export interface StockLoadInput<T> {
  data: { warehouseId: string; rows: T[] } | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export interface ScopedStockState<T> {
  data: T[] | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function scopeStockLoad<T>(activeWarehouseId: string, load: StockLoadInput<T>): ScopedStockState<T> {
  if (load.error) {
    return { data: null, loading: false, error: load.error, reload: load.reload };
  }
  const owned = load.data !== null && load.data.warehouseId === activeWarehouseId;
  if (owned && !load.loading) {
    return { data: load.data!.rows, loading: false, error: null, reload: load.reload };
  }
  // A result that belongs to another warehouse, or a load still in flight, is
  // "loading" — never "the current warehouse's rows".
  return { data: null, loading: true, error: null, reload: load.reload };
}

export type ReconciliationState = 'reconciled' | 'drift' | 'unknown';

export function reconcileSourceBalances(
  sourceBalanceSum: number,
  independentPhysicalTotal: number | null | undefined,
): ReconciliationState {
  if (!Number.isFinite(sourceBalanceSum)) return 'unknown';
  if (typeof independentPhysicalTotal !== 'number' || !Number.isFinite(independentPhysicalTotal)) return 'unknown';
  return sourceBalanceSum === independentPhysicalTotal ? 'reconciled' : 'drift';
}
