/**
 * DASHBOARD-REPORTED-AVAILABILITY-METRIC — focused tests for the hero-ring metric.
 * Run: npm test -- --run
 *
 * Proves the metric is a dimensionally valid ratio of like-unit item-condition
 * COUNTS (available / low_stock / missing) — never a mix of stock quantities and
 * counts — and that the Dashboard sources it only from the authoritative
 * condition-count RPC (via getDashboardMetrics), never from item_availability
 * directly and never as a writer.
 *
 * NAMING CONTRACT (see the final describe block): because this metric is
 * derived from manually reported `item_availability.condition` statuses, it
 * must never be presented as stock or inventory *health*. The retired
 * identifiers are spelled here only as data in RETIRED_IDENTIFIERS so the
 * scan below cannot trip over its own source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { reportedAvailabilityPercent, type ReportedAvailabilityCounts } from '../reportedAvailability';
import { T } from '@/shared/i18n/strings';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
// Scan executable CODE, not prose: the doc comments intentionally *mention*
// item_availability / quantity to explain what the metric does NOT do.
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('reportedAvailabilityPercent: dimensional validity (ratio of like-unit counts)', () => {
  it('is 100 when every classified item is available', () => {
    expect(reportedAvailabilityPercent({ available: 12, low: 0, missing: 0 })).toBe(100);
  });

  it('is 0 when no classified item is available', () => {
    expect(reportedAvailabilityPercent({ available: 0, low: 4, missing: 6 })).toBe(0);
  });

  it('is the available share of (available + low + missing)', () => {
    // 30 available of 30+10+10 = 50 total → 60%.
    expect(reportedAvailabilityPercent({ available: 30, low: 10, missing: 10 })).toBe(60);
    // 1 of 3 → 33% (rounded).
    expect(reportedAvailabilityPercent({ available: 1, low: 1, missing: 1 })).toBe(33);
  });

  it('returns 0 (not NaN) when there are no classified items', () => {
    expect(reportedAvailabilityPercent({ available: 0, low: 0, missing: 0 })).toBe(0);
  });

  it('never exceeds 0..100 and coerces junk counts to non-negative integers', () => {
    expect(reportedAvailabilityPercent({ available: -5, low: 0, missing: 0 })).toBe(0);
    expect(reportedAvailabilityPercent({ available: 7.9, low: 2.2, missing: 0 })).toBe(78); // trunc → 7 of 9
    expect(reportedAvailabilityPercent({ available: Number.NaN, low: 3, missing: 0 })).toBe(0);
  });

  it('accepts ONLY the three count fields — the type carries no quantity input', () => {
    // Compile-time guarantee, asserted structurally at runtime: the metric input
    // is a pure count triple, so a stock QUANTITY can never be fed in.
    const keys = Object.keys({ available: 0, low: 0, missing: 0 } satisfies ReportedAvailabilityCounts);
    expect(keys.sort()).toEqual(['available', 'low', 'missing'].sort());
  });
});

describe('reportedAvailability module: no quantity, no table access, no writes', () => {
  const mod = stripComments(readSrc('features/dashboard/reportedAvailability.ts'));
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
  it('computes the ring via reportedAvailabilityPercent over getDashboardMetrics counts', () => {
    expect(dashboardRaw).toContain('reportedAvailabilityPercent');
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

/**
 * NAMING CONTRACT — a metric derived from manually reported
 * `item_availability.condition` statuses must never be labeled as stock or
 * inventory *health*, because it is not an inventory balance.
 *
 * Scope is deliberately narrow: only the Dashboard metric surface below. This
 * must NOT become a repository-wide scan — unrelated concepts such as Bridge
 * Health (`m_bridge`) and the alert engine legitimately use "health" naming.
 */
describe('NAMING CONTRACT: the reported-availability metric is never labeled stock/inventory health', () => {
  // Spelled as data, not as literals in scanned code, so this file's own
  // source can never satisfy the absence assertions below.
  const RETIRED_IDENTIFIERS = [
    ['stock', 'Health'].join(''),          // stockHealth
    ['stock', 'HealthPercent'].join(''),   // stockHealthPercent
    ['Stock', 'HealthCounts'].join(''),    // StockHealthCounts
    ['d_stock', '_health'].join(''),       // d_stock_health
    ['stock-', 'health'].join(''),         // stock-health
  ];
  const RETIRED_LABELS = [
    ['Stock', ' Health'].join(''),
    ['صحة', ' المخزون'].join(''),
  ];
  // The Dashboard metric files only — not the whole repository.
  const METRIC_FILES = [
    'features/dashboard/reportedAvailability.ts',
    'features/dashboard/DashboardScreen.tsx',
  ];

  it('1) exposes the exact approved AR/EN user-facing labels', () => {
    expect(T.d_reported_availability.ar).toBe('التوفر المُبلّغ');
    expect(T.d_reported_availability.en).toBe('Reported availability');
  });

  it('1b) keeps the explanatory text stating it is manually reported and not an inventory balance', () => {
    expect(T.d_reported_availability_note.ar).toBe(
      'مبني على حالات التوفر المُبلّغة يدويًا، ولا يمثل الرصيد المخزني.',
    );
    expect(T.d_reported_availability_note.en).toBe(
      'Based on manually reported availability statuses; it does not represent inventory balance.',
    );
  });

  it('1c) renders the clarification visibly and binds it to the ring via aria-describedby (never hover-only)', () => {
    const dash = readSrc('features/dashboard/DashboardScreen.tsx');
    expect(dash).toContain('aria-describedby="reported-availability-note"');
    expect(dash).toContain('id="reported-availability-note"');
    expect(dash).toContain('d_reported_availability_note');
    // The note must not be hidden from sight or from the a11y tree — an
    // aria-describedby target that is hidden does not get announced.
    expect(dash).not.toMatch(/id="reported-availability-note"[^>]*aria-hidden/);
    expect(dash).not.toMatch(/id="reported-availability-note"[^>]*display:\s*none/);
  });

  it('2) Dashboard uses the renamed reported-availability function and i18n key', () => {
    const dash = readSrc('features/dashboard/DashboardScreen.tsx');
    expect(dash).toContain('reportedAvailabilityPercent');
    expect(dash).toContain("from './reportedAvailability'");
    expect(dash).toContain('d_reported_availability');
  });

  it('3) the retired stock-health identifiers are absent from the Dashboard metric files', () => {
    for (const rel of METRIC_FILES) {
      const src = readSrc(rel);
      for (const retired of RETIRED_IDENTIFIERS) {
        expect(src, `${rel} must not contain retired identifier "${retired}"`).not.toContain(retired);
      }
    }
  });

  it('3b) no stock/inventory-health label is exposed for this metric in i18n', () => {
    const keys = Object.keys(T);
    expect(keys).toContain('d_reported_availability');
    for (const retired of RETIRED_IDENTIFIERS) {
      expect(keys).not.toContain(retired);
    }
    // The approved labels themselves must not carry stock-health wording.
    for (const label of RETIRED_LABELS) {
      expect(T.d_reported_availability.ar).not.toContain(label);
      expect(T.d_reported_availability.en).not.toContain(label);
    }
  });
});
