/**
 * EFFECTIVE-STATUS-DERIVATION-A
 * Pure mapper tests for withEffectiveAvailabilityStatus.
 * Run: npm test -- --run
 *
 * These feed fake DB-shaped rows into the exported mapper — no Supabase client,
 * no network, no live DB. The mapper must be purely additive: every original
 * field is preserved and `condition` stays the raw stored value.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { withEffectiveAvailabilityStatus } from '../availability.service';

const today = new Date('2026-06-30T00:00:00');

// A representative DB-shaped availability row.
function row(overrides: Record<string, unknown>) {
  return {
    id: 'r1',
    quantity: 10,
    condition: 'available',
    batch_number: 'B1',
    expiry_date: null as string | null,
    notes: 'keep me',
    updated_at: '2026-06-01T00:00:00Z',
    scientific_name: 'Paracetamol',
    ...overrides,
  };
}

// ============================================================================
// A. Effective status derivation
// ============================================================================

describe('withEffectiveAvailabilityStatus: effective status derivation', () => {
  it('(A1) available + expired date => effective_status expired', () => {
    const r = withEffectiveAvailabilityStatus(row({ condition: 'available', expiry_date: '2026-06-29' }), today);
    expect(r.effective_status).toBe('expired');
    expect(r.expiry_bucket).toBe('expired');
    expect(r.effective_severity).toBe('critical');
  });

  it('(A2) available + quantity 0 => effective_status missing', () => {
    const r = withEffectiveAvailabilityStatus(row({ condition: 'available', quantity: 0 }), today);
    expect(r.effective_status).toBe('missing');
    expect(r.effective_severity).toBe('critical');
  });

  it('(A3) available + expiry within 3 months => near_expiry + 3_months bucket', () => {
    const r = withEffectiveAvailabilityStatus(row({ condition: 'available', expiry_date: '2026-08-01' }), today);
    expect(r.effective_status).toBe('near_expiry');
    expect(r.expiry_bucket).toBe('3_months');
    expect(r.derived_expiry_status).toBe('near_expiry');
  });

  it('(A4) low_stock stays low_stock (no threshold logic)', () => {
    const r = withEffectiveAvailabilityStatus(row({ condition: 'low_stock', quantity: 9999 }), today);
    expect(r.effective_status).toBe('low_stock');
    expect(r.effective_severity).toBe('medium');
  });

  it('(A5) surplus stays surplus (no threshold logic)', () => {
    const r = withEffectiveAvailabilityStatus(row({ condition: 'surplus', quantity: 9999 }), today);
    expect(r.effective_status).toBe('surplus');
    expect(r.effective_severity).toBe('low');
  });

  it('(A6) healthy row stays available', () => {
    const r = withEffectiveAvailabilityStatus(row({ condition: 'available', quantity: 50, expiry_date: '2030-01-01' }), today);
    expect(r.effective_status).toBe('available');
    expect(r.effective_severity).toBe('info');
  });

  it('scarce-stored value normalizes to low_stock', () => {
    const r = withEffectiveAvailabilityStatus(row({ condition: 'scarce' }), today);
    expect(r.normalized_condition).toBe('low_stock');
    expect(r.effective_status).toBe('low_stock');
  });
});

// ============================================================================
// B. Purely additive — raw condition + original fields preserved
// ============================================================================

describe('withEffectiveAvailabilityStatus: additive & non-destructive', () => {
  it('(A7) existing condition is preserved unchanged when effective differs', () => {
    const r = withEffectiveAvailabilityStatus(row({ condition: 'available', expiry_date: '2026-06-29' }), today);
    expect(r.condition).toBe('available'); // raw stored value untouched
    expect(r.effective_status).toBe('expired'); // derived differs
  });

  it('(A8) raw_condition equals the original condition', () => {
    for (const c of ['available', 'low_stock', 'missing', 'surplus', 'near_expiry', 'expired']) {
      const r = withEffectiveAvailabilityStatus(row({ condition: c }), today);
      expect(r.raw_condition).toBe(c);
    }
  });

  it('(A9) expiry_bucket is present and correct across buckets', () => {
    expect(withEffectiveAvailabilityStatus(row({ expiry_date: '2026-09-30' }), today).expiry_bucket).toBe('3_months');
    expect(withEffectiveAvailabilityStatus(row({ expiry_date: '2026-12-30' }), today).expiry_bucket).toBe('6_months');
    expect(withEffectiveAvailabilityStatus(row({ expiry_date: '2027-03-30' }), today).expiry_bucket).toBe('9_months');
    expect(withEffectiveAvailabilityStatus(row({ expiry_date: '2030-01-01' }), today).expiry_bucket).toBeNull();
    expect(withEffectiveAvailabilityStatus(row({ expiry_date: null }), today).expiry_bucket).toBeNull();
  });

  it('preserves every original field (no mutation, no loss)', () => {
    const original = row({ condition: 'available', quantity: 7, notes: 'do not drop' });
    const snapshot = JSON.parse(JSON.stringify(original));
    const r = withEffectiveAvailabilityStatus(original, today);
    // original object is not mutated
    expect(original).toEqual(snapshot);
    // all original keys survive on the result
    for (const k of Object.keys(snapshot)) {
      expect((r as Record<string, unknown>)[k]).toEqual(snapshot[k]);
    }
  });

  it('adds exactly the six derived fields', () => {
    const r = withEffectiveAvailabilityStatus(row({}), today);
    const added = Object.keys(r).filter(k => !Object.keys(row({})).includes(k));
    expect(added.sort()).toEqual([
      'derived_expiry_status', 'effective_severity', 'effective_status',
      'expiry_bucket', 'normalized_condition', 'raw_condition',
    ]);
  });
});

// ============================================================================
// C. Regression — no write/upsert behavior touched, no live DB
// ============================================================================

describe('Regression: read-layer change is non-destructive', () => {
  const svc = readFileSync(join(__dirname, '../availability.service.ts'), 'utf8');

  it('(A10) upsert still calls the phoenix_upsert_availability RPC unchanged', () => {
    expect(svc).toContain("rpc('phoenix_upsert_availability'");
  });

  it('mapper is applied only to read functions, not to the upsert body', () => {
    const start = svc.indexOf('export async function upsertAvailability');
    const end = svc.indexOf('export async function getLowStockItems');
    const upsertFn = svc.slice(start, end);
    expect(upsertFn).not.toContain('withEffectiveAvailabilityStatus');
  });

  it('all three read functions append effective status', () => {
    for (const fn of ['getAvailabilityByPoint', 'getLowStockItems', 'getAvailabilityByOrg']) {
      const start = svc.indexOf(`function ${fn}`);
      const tail = svc.slice(start, start + 1200);
      expect(tail).toContain('withEffectiveAvailabilityStatus');
    }
  });

  it('does not introduce write/update/upsert/delete in read functions', () => {
    // The mapper and read paths must not call mutation verbs.
    const start = svc.indexOf('export function withEffectiveAvailabilityStatus');
    const end = svc.indexOf('export interface UpsertAvailabilityInput');
    const mapper = svc.slice(start, end);
    expect(mapper).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
  });
});
