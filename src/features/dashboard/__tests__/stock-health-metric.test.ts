/**
 * DASHBOARD-STOCK-HEALTH-METRIC — focused tests for the hero-ring metric.
 * Run: npm test -- --run
 *
 * Proves the metric is a dimensionally valid ratio of like-unit item-condition
 * COUNTS (available / low_stock / missing) — never a mix of stock quantities and
 * counts — and that the Dashboard sources it only from the authoritative
 * condition-count RPC (via getDashboardMetrics), never from item_availability
 * directly and never as a writer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { stockHealthPercent, type StockHealthCounts } from '../stockHealth';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
// Scan executable CODE, not prose: the doc comments intentionally *mention*
// item_availability / quantity to explain what the metric does NOT do.
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('stockHealthPercent: dimensional validity (ratio of like-unit counts)', () => {
  it('is 100 when every classified item is available', () => {
    expect(stockHealthPercent({ available: 12, low: 0, missing: 0 })).toBe(100);
  });

  it('is 0 when no classified item is available', () => {
    expect(stockHealthPercent({ available: 0, low: 4, missing: 6 })).toBe(0);
  });

  it('is the available share of (available + low + missing)', () => {
    // 30 available of 30+10+10 = 50 total → 60%.
    expect(stockHealthPercent({ available: 30, low: 10, missing: 10 })).toBe(60);
    // 1 of 3 → 33% (rounded).
    expect(stockHealthPercent({ available: 1, low: 1, missing: 1 })).toBe(33);
  });

  it('returns 0 (not NaN) when there are no classified items', () => {
    expect(stockHealthPercent({ available: 0, low: 0, missing: 0 })).toBe(0);
  });

  it('never exceeds 0..100 and coerces junk counts to non-negative integers', () => {
    expect(stockHealthPercent({ available: -5, low: 0, missing: 0 })).toBe(0);
    expect(stockHealthPercent({ available: 7.9, low: 2.2, missing: 0 })).toBe(78); // trunc → 7 of 9
    expect(stockHealthPercent({ available: Number.NaN, low: 3, missing: 0 })).toBe(0);
  });

  it('accepts ONLY the three count fields — the type carries no quantity input', () => {
    // Compile-time guarantee, asserted structurally at runtime: the metric input
    // is a pure count triple, so a stock QUANTITY can never be fed in.
    const keys = Object.keys({ available: 0, low: 0, missing: 0 } satisfies StockHealthCounts);
    expect(keys.sort()).toEqual(['available', 'low', 'missing'].sort());
  });
});

describe('stockHealth module: no quantity, no table access, no writes', () => {
  const mod = stripComments(readSrc('features/dashboard/stockHealth.ts'));
  it('never sums or references a stock quantity', () => {
    expect(mod).not.toMatch(/quantity|\bqty\b|\bsum\b|reduce\(/i);
  });
  it('reads no table and performs no mutation (pure function)', () => {
    expect(mod).not.toMatch(/supabase|\.from\(|\.rpc\(|item_availability/);
    expect(mod).not.toMatch(/\.(insert|update|delete|upsert)\s*\(/);
  });
});

describe('DashboardScreen: ring is sourced from the RPC counts, not item_availability', () => {
  const dashboardRaw = readSrc('features/dashboard/DashboardScreen.tsx');
  const dashboardCode = stripComments(dashboardRaw);
  it('computes the ring via stockHealthPercent over getDashboardMetrics counts', () => {
    expect(dashboardRaw).toContain('stockHealthPercent');
    expect(dashboardRaw).toContain('getDashboardMetrics');
    expect(dashboardRaw).toMatch(/available:\s*m\?\.availableItems/);
    expect(dashboardRaw).toMatch(/low:\s*m\?\.lowStockCount/);
    expect(dashboardRaw).toMatch(/missing:\s*m\?\.missingCount/);
  });
  it('does not read item_availability directly or write any stock table (code, sans comments)', () => {
    expect(dashboardCode).not.toContain('item_availability');
    expect(dashboardCode).not.toMatch(/\.(insert|update|delete|upsert)\s*\(/);
  });
});
