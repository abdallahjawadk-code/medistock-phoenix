/**
 * STATUS-CANONICAL-UNKNOWN-NOT-STOCKED-A
 *
 * Migration 066 expanded item_availability.condition with two non-quantity
 * states — `unknown` and `not_stocked`. Before this change computeEffectiveStatus
 * only knew the six quantity/expiry statuses, so:
 *   - `not_stocked` / `unknown` fell through to normalizeStatusType() -> null ->
 *     'available', and
 *   - a zero-quantity row of either was then relabelled 'missing' by the
 *     `qty <= 0` rule.
 *
 * The approved model is explicit:
 *   - `missing` is ONLY an expected material whose on_hand is 0.
 *   - `not_stocked` must never become `missing`.
 *   - `unknown` must never become `available` or `missing`.
 *
 * These are pure behavioural assertions (no source scanning), so they are
 * line-ending independent and run identically on every platform/CI.
 */
import { describe, it, expect } from 'vitest';
import { computeEffectiveStatus, getStatusSeverity } from '../canonical';

// Fixed clock so expiry math is deterministic regardless of the machine TZ/date.
const TODAY = new Date(2026, 6, 18); // 2026-07-18

describe('not_stocked is never coerced to missing/available', () => {
  it('not_stocked with quantity 0 stays not_stocked (NOT missing)', () => {
    const r = computeEffectiveStatus({ rawCondition: 'not_stocked', quantity: 0, expiryDate: null, today: TODAY });
    expect(r.effectiveStatus).toBe('not_stocked');
    expect(r.effectiveStatus).not.toBe('missing');
  });

  it('not_stocked with a positive quantity still stays not_stocked (NOT available)', () => {
    const r = computeEffectiveStatus({ rawCondition: 'not_stocked', quantity: 12, expiryDate: null, today: TODAY });
    expect(r.effectiveStatus).toBe('not_stocked');
    expect(r.effectiveStatus).not.toBe('available');
  });

  it('not_stocked with a past expiry date is not reclassified as expired', () => {
    const r = computeEffectiveStatus({ rawCondition: 'not_stocked', quantity: 0, expiryDate: '2020-01-01', today: TODAY });
    expect(r.effectiveStatus).toBe('not_stocked');
  });

  it('not_stocked severity is informational, never critical', () => {
    const r = computeEffectiveStatus({ rawCondition: 'not_stocked', quantity: 0, expiryDate: null, today: TODAY });
    expect(r.severity).toBe('info');
    expect(getStatusSeverity('not_stocked')).toBe('info');
  });
});

describe('unknown is never coerced to available/missing', () => {
  it('unknown with quantity 0 stays unknown (NOT missing)', () => {
    const r = computeEffectiveStatus({ rawCondition: 'unknown', quantity: 0, expiryDate: null, today: TODAY });
    expect(r.effectiveStatus).toBe('unknown');
    expect(r.effectiveStatus).not.toBe('missing');
  });

  it('unknown with a null quantity stays unknown (NOT available)', () => {
    const r = computeEffectiveStatus({ rawCondition: 'unknown', quantity: null, expiryDate: null, today: TODAY });
    expect(r.effectiveStatus).toBe('unknown');
    expect(r.effectiveStatus).not.toBe('available');
  });

  it('unknown with a positive quantity stays unknown', () => {
    const r = computeEffectiveStatus({ rawCondition: 'unknown', quantity: 7, expiryDate: null, today: TODAY });
    expect(r.effectiveStatus).toBe('unknown');
  });

  it('unknown severity is informational', () => {
    expect(getStatusSeverity('unknown')).toBe('info');
  });
});

describe('the six quantity/expiry statuses are unchanged by this phase', () => {
  it('missing is still derived for an EXPECTED material at on_hand 0 (condition available, qty 0)', () => {
    const r = computeEffectiveStatus({ rawCondition: 'available', quantity: 0, expiryDate: null, today: TODAY });
    expect(r.effectiveStatus).toBe('missing');
  });

  it('an explicit missing condition still reads missing', () => {
    const r = computeEffectiveStatus({ rawCondition: 'missing', quantity: 0, expiryDate: null, today: TODAY });
    expect(r.effectiveStatus).toBe('missing');
  });

  it('available with stock and no expiry stays available', () => {
    const r = computeEffectiveStatus({ rawCondition: 'available', quantity: 25, expiryDate: null, today: TODAY });
    expect(r.effectiveStatus).toBe('available');
  });

  it('a past expiry date still wins as expired for a stocked item', () => {
    const r = computeEffectiveStatus({ rawCondition: 'available', quantity: 25, expiryDate: '2020-01-01', today: TODAY });
    expect(r.effectiveStatus).toBe('expired');
  });

  it('normalizedCondition mirrors the effective non-quantity state for not_stocked/unknown', () => {
    expect(computeEffectiveStatus({ rawCondition: 'not_stocked', quantity: 0, expiryDate: null, today: TODAY }).normalizedCondition).toBe('not_stocked');
    expect(computeEffectiveStatus({ rawCondition: 'unknown', quantity: 0, expiryDate: null, today: TODAY }).normalizedCondition).toBe('unknown');
  });
});
