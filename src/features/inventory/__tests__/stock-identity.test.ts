/**
 * R1.5-E11 — ADVERSARIAL CANONICAL LOT IDENTITY.
 *
 * The predicate this file guards replaced a comparison over lower-cased
 * scientific name + batch + expiry. Every test below is built so that those
 * three ALWAYS agree: the only thing that ever varies is a dimension the old
 * comparison could not see. If the old predicate were restored, each rejection
 * case here would fail — which is exactly the regression this suite exists for.
 */
import { describe, expect, it } from 'vitest';
import {
  isExactReleaseCandidate,
  normalizeIdentityField,
  type CanonicalLotIdentity,
} from '../stock-identity';

/** The quarantined row every case is compared against. */
const QUARANTINED: CanonicalLotIdentity = {
  materialIdentityKey: 'mik-amoxicillin-500-cap-box',
  batchNumber: 'B-2201',
  expiryDate: '2027-03-31',
  internalBatchReference: 'IBR-77',
  supplyType: 'purchase',
  purchaseOrigin: 'central',
};

/** A candidate identical to QUARANTINED except for the named override. */
const candidate = (over: Partial<CanonicalLotIdentity> = {}): CanonicalLotIdentity => ({
  ...QUARANTINED,
  ...over,
});

describe('E11 — same scientific name, batch and expiry is NOT enough', () => {
  it('1. rejects a different materialIdentityKey', () => {
    // Same name/batch/expiry by construction; a different canonical material
    // (e.g. a different unit or national code, both folded into the key by 150).
    expect(isExactReleaseCandidate(
      candidate({ materialIdentityKey: 'mik-amoxicillin-500-cap-strip' }),
      QUARANTINED,
    )).toBe(false);
  });

  it('2. rejects a different internalBatchReference', () => {
    expect(isExactReleaseCandidate(candidate({ internalBatchReference: 'IBR-78' }), QUARANTINED)).toBe(false);
  });

  it('3. rejects a different supplyType', () => {
    // Provenance is lot identity under 088: aid stock is not purchase stock.
    expect(isExactReleaseCandidate(
      candidate({ supplyType: 'aid', purchaseOrigin: null }),
      QUARANTINED,
    )).toBe(false);
  });

  it('4. rejects a different purchaseOrigin', () => {
    expect(isExactReleaseCandidate(candidate({ purchaseOrigin: 'supplementary' }), QUARANTINED)).toBe(false);
  });

  it('rejects when several dimensions differ at once', () => {
    expect(isExactReleaseCandidate(
      candidate({ internalBatchReference: 'IBR-99', supplyType: 'kimadia', purchaseOrigin: null }),
      QUARANTINED,
    )).toBe(false);
  });
});

describe('E11 — 5. exact full identity is accepted', () => {
  it('accepts a candidate matching on all six dimensions', () => {
    expect(isExactReleaseCandidate(candidate(), QUARANTINED)).toBe(true);
  });

  it('accepts an all-null-optional lot when both sides are all-null', () => {
    const bare: CanonicalLotIdentity = {
      materialIdentityKey: 'mik-bare',
      batchNumber: null, expiryDate: null,
      internalBatchReference: null, supplyType: null, purchaseOrigin: null,
    };
    expect(isExactReleaseCandidate({ ...bare }, bare)).toBe(true);
  });
});

describe('E11 — 6/7. null, undefined and set values normalize symmetrically', () => {
  it('6. null and undefined compare equal for a textual field', () => {
    const withNull = candidate({ internalBatchReference: null });
    const withUndefined = candidate({ internalBatchReference: undefined });
    expect(isExactReleaseCandidate(withNull, withUndefined)).toBe(true);
    expect(isExactReleaseCandidate(withUndefined, withNull)).toBe(true);
  });

  it('6. the helper collapses null and undefined to the same empty string', () => {
    expect(normalizeIdentityField(null)).toBe('');
    expect(normalizeIdentityField(undefined)).toBe('');
    expect(normalizeIdentityField(null)).toBe(normalizeIdentityField(undefined));
  });

  it('6. the helper does not trim, case-fold or otherwise rewrite a value', () => {
    // The server compares exactly; transforming here would make the client
    // agree with itself and disagree with the database.
    expect(normalizeIdentityField('  B-1 ')).toBe('  B-1 ');
    expect(normalizeIdentityField('Aid')).toBe('Aid');
    expect(normalizeIdentityField('')).toBe('');
  });

  it('7. null does NOT match a non-null value', () => {
    expect(isExactReleaseCandidate(candidate({ internalBatchReference: null }), QUARANTINED)).toBe(false);
    expect(isExactReleaseCandidate(candidate(), candidate({ internalBatchReference: null }))).toBe(false);
  });

  it('7. an empty string is treated as absent, matching COALESCE(x, \'\')', () => {
    expect(isExactReleaseCandidate(
      candidate({ internalBatchReference: '' }),
      candidate({ internalBatchReference: null }),
    )).toBe(true);
  });

  it('7. a null expiry does not match a set expiry, in either direction', () => {
    expect(isExactReleaseCandidate(candidate({ expiryDate: null }), QUARANTINED)).toBe(false);
    expect(isExactReleaseCandidate(QUARANTINED, candidate({ expiryDate: null }))).toBe(false);
  });
});

describe('E11 — 8. expiry is a DATE identity, never a timestamp', () => {
  it('compares the canonical YYYY-MM-DD text as-is', () => {
    expect(isExactReleaseCandidate(candidate({ expiryDate: '2027-03-31' }), QUARANTINED)).toBe(true);
    expect(isExactReleaseCandidate(candidate({ expiryDate: '2027-04-01' }), QUARANTINED)).toBe(false);
  });

  it('performs no timezone or locale transformation', () => {
    // If the predicate parsed dates, a value with an explicit timestamp/offset
    // could be coerced onto the same calendar day and wrongly match. It must
    // not: only the canonical date text is an identity.
    expect(isExactReleaseCandidate(candidate({ expiryDate: '2027-03-31T00:00:00Z' }), QUARANTINED)).toBe(false);
    expect(isExactReleaseCandidate(candidate({ expiryDate: '2027-03-30T23:00:00-01:00' }), QUARANTINED)).toBe(false);
  });

  it('treats a same-day value written differently as a different identity', () => {
    expect(isExactReleaseCandidate(candidate({ expiryDate: '2027-3-31' }), QUARANTINED)).toBe(false);
  });
});

describe('E11 — 9. quarantine_reason never determines stock identity', () => {
  it('is not a field of the identity contract at all', () => {
    // wqs_identity_uniq includes quarantine_reason because one physical lot can
    // be held under two reasons. warehouse_stock_identity_uniq does not — the
    // destination has no such dimension, so requiring it would make every
    // release impossible.
    expect(Object.keys(QUARANTINED)).not.toContain('quarantineReason');
  });

  it('an extra reason property on either side changes nothing', () => {
    const withReason = { ...candidate(), quarantineReason: 'damaged' } as CanonicalLotIdentity;
    const otherReason = { ...QUARANTINED, quarantineReason: 'expired_on_arrival' } as CanonicalLotIdentity;
    expect(isExactReleaseCandidate(withReason, otherReason)).toBe(true);
  });
});

describe('E11 — fail-safe when the canonical key is absent', () => {
  it('refuses when the candidate lacks materialIdentityKey', () => {
    expect(isExactReleaseCandidate(candidate({ materialIdentityKey: null }), QUARANTINED)).toBe(false);
  });

  it('refuses when the quarantined row lacks materialIdentityKey', () => {
    expect(isExactReleaseCandidate(candidate(), candidate({ materialIdentityKey: null }))).toBe(false);
  });

  it('refuses even when BOTH lack it and every other dimension agrees', () => {
    // Two missing keys must never be read as "equally unknown, therefore equal".
    const a = candidate({ materialIdentityKey: null });
    const b = candidate({ materialIdentityKey: null });
    expect(isExactReleaseCandidate(a, b)).toBe(false);
  });

  it('refuses an empty-string key rather than matching two blanks', () => {
    expect(isExactReleaseCandidate(
      candidate({ materialIdentityKey: '' }),
      candidate({ materialIdentityKey: '' }),
    )).toBe(false);
  });
});

describe('E11 — the predicate is symmetric and reflexive', () => {
  it('order of arguments does not change the answer', () => {
    const other = candidate({ supplyType: 'aid', purchaseOrigin: null });
    expect(isExactReleaseCandidate(other, QUARANTINED))
      .toBe(isExactReleaseCandidate(QUARANTINED, other));
    expect(isExactReleaseCandidate(candidate(), QUARANTINED))
      .toBe(isExactReleaseCandidate(QUARANTINED, candidate()));
  });

  it('a row always matches itself', () => {
    expect(isExactReleaseCandidate(QUARANTINED, QUARANTINED)).toBe(true);
  });
});
