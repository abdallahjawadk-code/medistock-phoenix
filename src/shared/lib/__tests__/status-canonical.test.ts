/**
 * STATUS-CANONICAL-TYPES-AND-HELPERS-A
 * Pure unit tests for the canonical status foundation.
 * Run: npm test -- --run
 *
 * These tests must stay dependency-free: no Supabase, no network, no browser
 * globals — the module under test is a pure helper layer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  normalizeStatusType,
  addMonthsClamped,
  getExpiryBucket,
  deriveExpiryStatus,
  computeEffectiveStatus,
  getStatusSeverity,
  type RawAvailabilityCondition,
} from '../status/canonical';

// Cross-check against the existing engine to prove date-logic parity.
import { addMonths as engineAddMonths, expiryBucket as engineExpiryBucket } from '@/features/alerts/materialAlertEngine';

const T = (s: string) => new Date(s + 'T00:00:00');

// ============================================================================
// A. normalizeStatusType
// ============================================================================

describe('normalizeStatusType', () => {
  it('(A1) scarce maps to low_stock', () => {
    expect(normalizeStatusType('scarce')).toBe('low_stock');
  });

  it('(A2) low_stock remains low_stock', () => {
    expect(normalizeStatusType('low_stock')).toBe('low_stock');
  });

  it('(A3) all 6 availability conditions map to themselves', () => {
    const six: RawAvailabilityCondition[] = ['available', 'low_stock', 'missing', 'surplus', 'near_expiry', 'expired'];
    for (const c of six) expect(normalizeStatusType(c)).toBe(c);
  });

  it('returns null for unknown input', () => {
    expect(normalizeStatusType('banana')).toBeNull();
    expect(normalizeStatusType(null)).toBeNull();
    expect(normalizeStatusType(undefined)).toBeNull();
  });
});

// ============================================================================
// B. addMonthsClamped
// ============================================================================

describe('addMonthsClamped', () => {
  it('(B4) Jan 31 + 1 month clamps to Feb 28 in a non-leap year', () => {
    const r = addMonthsClamped(T('2025-01-31'), 1);
    expect(r.getFullYear()).toBe(2025);
    expect(r.getMonth()).toBe(1); // Feb
    expect(r.getDate()).toBe(28);
  });

  it('(B5) Jan 31 + 1 month clamps to Feb 29 in a leap year', () => {
    const r = addMonthsClamped(T('2024-01-31'), 1);
    expect(r.getMonth()).toBe(1);
    expect(r.getDate()).toBe(29);
  });

  it('(B6) matches materialAlertEngine.addMonths month-end behavior', () => {
    const cases: Array<[string, number]> = [
      ['2025-01-31', 1], ['2024-01-31', 1], ['2025-03-31', 1],
      ['2025-01-15', 3], ['2025-12-31', 1], ['2025-08-31', 6], ['2025-05-31', 9],
    ];
    for (const [d, m] of cases) {
      const a = addMonthsClamped(T(d), m);
      const b = engineAddMonths(T(d), m);
      expect(a.getTime()).toBe(b.getTime());
    }
  });

  it('handles year rollover and negative months', () => {
    expect(addMonthsClamped(T('2025-12-15'), 1).getFullYear()).toBe(2026);
    const back = addMonthsClamped(T('2025-01-15'), -1);
    expect(back.getFullYear()).toBe(2024);
    expect(back.getMonth()).toBe(11); // Dec
  });
});

// ============================================================================
// C. getExpiryBucket
// ============================================================================

describe('getExpiryBucket', () => {
  const today = T('2026-06-30');

  it('(C7) expired if expiryDate before today', () => {
    expect(getExpiryBucket(today, '2026-06-29')).toBe('expired');
    expect(getExpiryBucket(today, '2020-01-01')).toBe('expired');
  });

  it('(C8) 3/6/9-month buckets work', () => {
    expect(getExpiryBucket(today, '2026-06-30')).toBe('3_months'); // today itself, not expired
    expect(getExpiryBucket(today, '2026-09-30')).toBe('3_months'); // +3m exactly
    expect(getExpiryBucket(today, '2026-10-01')).toBe('6_months'); // just past +3m
    expect(getExpiryBucket(today, '2026-12-30')).toBe('6_months'); // +6m exactly
    expect(getExpiryBucket(today, '2027-01-01')).toBe('9_months'); // just past +6m
    expect(getExpiryBucket(today, '2027-03-30')).toBe('9_months'); // +9m exactly
  });

  it('(C9) beyond 9 months returns null', () => {
    expect(getExpiryBucket(today, '2027-04-01')).toBeNull();
    expect(getExpiryBucket(today, '2030-01-01')).toBeNull();
  });

  it('null for missing/invalid date', () => {
    expect(getExpiryBucket(today, null)).toBeNull();
    expect(getExpiryBucket(today, undefined)).toBeNull();
    expect(getExpiryBucket(today, 'not-a-date')).toBeNull();
  });

  it('matches materialAlertEngine.expiryBucket across a sweep', () => {
    const dates = ['2026-06-29', '2026-06-30', '2026-09-30', '2026-10-01', '2026-12-30', '2027-01-01', '2027-03-30', '2027-04-01', '2030-01-01'];
    for (const d of dates) {
      expect(getExpiryBucket(today, d)).toBe(engineExpiryBucket(today, T(d)));
    }
  });
});

// ============================================================================
// D. deriveExpiryStatus
// ============================================================================

describe('deriveExpiryStatus', () => {
  const today = T('2026-06-30');

  it('(D10) expired when expiry before today', () => {
    expect(deriveExpiryStatus(today, '2026-06-29')).toBe('expired');
  });

  it('(D11) near_expiry for default 3-month window', () => {
    expect(deriveExpiryStatus(today, '2026-09-30')).toBe('near_expiry'); // +3m exactly
    expect(deriveExpiryStatus(today, '2026-07-15')).toBe('near_expiry');
  });

  it('(D12) normal for 6/9-month watch dates under default 3-month window', () => {
    expect(deriveExpiryStatus(today, '2026-12-30')).toBe('normal'); // +6m
    expect(deriveExpiryStatus(today, '2027-03-30')).toBe('normal'); // +9m
    expect(deriveExpiryStatus(today, '2030-01-01')).toBe('normal'); // far future
  });

  it('normal when no expiry date', () => {
    expect(deriveExpiryStatus(today, null)).toBe('normal');
  });

  it('respects a custom near-expiry window', () => {
    expect(deriveExpiryStatus(today, '2026-12-30', { nearExpiryWindowMonths: 6 })).toBe('near_expiry');
  });
});

// ============================================================================
// E. computeEffectiveStatus
// ============================================================================

describe('computeEffectiveStatus', () => {
  const today = T('2026-06-30');
  const base = { quantity: 10 as number | null, expiryDate: null as string | null, today };

  it('(E13) expired overrides available', () => {
    const r = computeEffectiveStatus({ ...base, rawCondition: 'available', expiryDate: '2026-01-01' });
    expect(r.effectiveStatus).toBe('expired');
    expect(r.expiryBucket).toBe('expired');
    expect(r.severity).toBe('critical');
  });

  it('(E14) quantity 0 gives missing', () => {
    const r = computeEffectiveStatus({ ...base, rawCondition: 'available', quantity: 0 });
    expect(r.effectiveStatus).toBe('missing');
  });

  it('quantity negative gives missing', () => {
    expect(computeEffectiveStatus({ ...base, rawCondition: 'available', quantity: -5 }).effectiveStatus).toBe('missing');
  });

  it('(E15) raw missing gives missing', () => {
    const r = computeEffectiveStatus({ ...base, rawCondition: 'missing', quantity: 10 });
    expect(r.effectiveStatus).toBe('missing');
  });

  it('(E16) near_expiry from expiry date within 3 months', () => {
    const r = computeEffectiveStatus({ ...base, rawCondition: 'available', expiryDate: '2026-08-01' });
    expect(r.effectiveStatus).toBe('near_expiry');
    expect(r.derivedExpiryStatus).toBe('near_expiry');
  });

  it('(E17) raw near_expiry gives near_expiry', () => {
    expect(computeEffectiveStatus({ ...base, rawCondition: 'near_expiry' }).effectiveStatus).toBe('near_expiry');
  });

  it('(E18) raw low_stock remains low_stock', () => {
    const r = computeEffectiveStatus({ ...base, rawCondition: 'low_stock' });
    expect(r.effectiveStatus).toBe('low_stock');
    expect(r.severity).toBe('medium');
  });

  it('scarce normalizes and surfaces as low_stock effective status', () => {
    // raw 'scarce' is not a RawAvailabilityCondition, but the normalizer maps it.
    const r = computeEffectiveStatus({ ...base, rawCondition: 'scarce' as RawAvailabilityCondition });
    expect(r.normalizedCondition).toBe('low_stock');
    expect(r.effectiveStatus).toBe('low_stock');
  });

  it('(E19) raw surplus remains surplus', () => {
    const r = computeEffectiveStatus({ ...base, rawCondition: 'surplus' });
    expect(r.effectiveStatus).toBe('surplus');
    expect(r.severity).toBe('low');
  });

  it('(E20) healthy available remains available', () => {
    const r = computeEffectiveStatus({ ...base, rawCondition: 'available', quantity: 50, expiryDate: '2030-01-01' });
    expect(r.effectiveStatus).toBe('available');
    expect(r.severity).toBe('info');
  });

  it('(E21) no auto-low-stock without thresholds (low positive qty stays available)', () => {
    const r = computeEffectiveStatus({ ...base, rawCondition: 'available', quantity: 1, thresholds: { minQuantity: 100 } });
    expect(r.effectiveStatus).toBe('available');
  });

  it('(E22) no auto-surplus without thresholds (high qty stays available)', () => {
    const r = computeEffectiveStatus({ ...base, rawCondition: 'available', quantity: 999999, thresholds: { maxQuantity: 10 } });
    expect(r.effectiveStatus).toBe('available');
  });

  it('expired takes precedence over missing when both apply', () => {
    const r = computeEffectiveStatus({ ...base, rawCondition: 'missing', quantity: 0, expiryDate: '2026-01-01' });
    expect(r.effectiveStatus).toBe('expired');
  });

  it('missing takes precedence over near_expiry', () => {
    const r = computeEffectiveStatus({ ...base, rawCondition: 'available', quantity: 0, expiryDate: '2026-08-01' });
    expect(r.effectiveStatus).toBe('missing');
  });

  it('defaults today to now when omitted (no crash, deterministic shape)', () => {
    const r = computeEffectiveStatus({ rawCondition: 'available', quantity: 5, expiryDate: null });
    expect(r.effectiveStatus).toBe('available');
  });
});

// ============================================================================
// getStatusSeverity baseline
// ============================================================================

describe('getStatusSeverity', () => {
  it('maps each canonical status to its baseline severity', () => {
    expect(getStatusSeverity('expired')).toBe('critical');
    expect(getStatusSeverity('missing')).toBe('critical');
    expect(getStatusSeverity('near_expiry')).toBe('high');
    expect(getStatusSeverity('low_stock')).toBe('medium');
    expect(getStatusSeverity('surplus')).toBe('low');
    expect(getStatusSeverity('available')).toBe('info');
  });
});

// ============================================================================
// F. Regression guards — pure module
// ============================================================================

describe('Regression: canonical module is pure', () => {
  const rawSrc = readFileSync(join(__dirname, '../status/canonical.ts'), 'utf8');
  // Strip block and line comments so purity checks scan executable code only,
  // not prose that legitimately mentions Supabase/window/etc.
  const code = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('(F23) does not import or reference Supabase', () => {
    expect(code).not.toMatch(/supabase/i);
  });

  it('(F24) does not perform network calls', () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/XMLHttpRequest/);
    expect(code).not.toMatch(/axios/);
  });

  it('(F25) does not depend on browser globals', () => {
    expect(code).not.toMatch(/\bwindow\b/);
    expect(code).not.toMatch(/\bdocument\b/);
    expect(code).not.toMatch(/localStorage/);
    expect(code).not.toMatch(/navigator/);
  });

  it('imports nothing (self-contained)', () => {
    expect(code).not.toMatch(/^\s*import\s/m);
  });
});
