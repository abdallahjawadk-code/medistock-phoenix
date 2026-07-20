/**
 * DASHBOARD-STOCK-HEALTH-METRIC — the Dashboard hero ring's "stock health" %.
 *
 * SOURCE OF TRUTH: the authoritative dashboard condition-count RPC
 * `phoenix_get_dashboard_condition_counts` (migration 054), surfaced by
 * getDashboardMetrics() as { availableItems, lowStockCount, missingCount }.
 *
 * UNITS (audited against 054_dashboard_condition_counts_rpcs.sql): all three
 * inputs are COUNTS of `item_availability` rows in a single, mutually-exclusive
 * `condition` bucket — the RPC computes each as `count(*) FILTER (WHERE
 * condition = 'available' | 'low_stock' | 'missing')`. They therefore share one
 * unit (a row count), which is what makes the ratio below dimensionally valid.
 *
 * This function NEVER mixes a stock quantity with a count: it accepts no
 * quantity, sums no quantity, and reads/writes no table. `item_availability` is
 * not used here as a parallel stock source or writer — the counts arrive
 * pre-computed from the RPC, the app's established RLS-safe read path. The
 * inventory/stock ledger remains the sole source of truth for stock quantities;
 * this metric is purely a count-based availability ratio, not a stock figure.
 *
 * DEFINITION: the share of classified items that are Available among the three
 * primary availability states (Available / Low / Missing), as an integer 0–100.
 * Returns 0 when there are no classified items (empty denominator).
 */
export interface StockHealthCounts {
  /** count(*) of item_availability rows with condition = 'available' */
  available: number;
  /** count(*) of item_availability rows with condition = 'low_stock' */
  low: number;
  /** count(*) of item_availability rows with condition = 'missing' */
  missing: number;
}

export function stockHealthPercent({ available, low, missing }: StockHealthCounts): number {
  // Coerce to non-negative integers — these are row counts by definition; a
  // fractional or negative input would be a contract violation, not a quantity.
  const a = Math.max(0, Math.trunc(available) || 0);
  const l = Math.max(0, Math.trunc(low) || 0);
  const m = Math.max(0, Math.trunc(missing) || 0);
  const classified = a + l + m;
  if (classified === 0) return 0;
  return Math.round((a / classified) * 100);
}
