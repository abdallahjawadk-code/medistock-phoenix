/**
 * STAGE-F-172 — patient-dispensing FEFO advisory.
 *
 * The advisory is deliberately NOT phoenix_inventory_fefo_batches (150).
 * Transfer FEFO inner-joins dispatch provenance because you may only move
 * onward what you can prove you received; dispensing to a patient has never
 * required that, and Stage E proved provenance-less outlet stock is legally
 * dispensable. These tests pin both halves of that distinction.
 *
 * Pure function, so the whole matrix runs without a database.
 */
import { describe, expect, it } from 'vitest';
import {
  patientFefoCandidates, patientFefoRecommendation, isSamePatientFefoMaterial,
  type PatientFefoLot, type PatientFefoIdentity,
} from '../dispense-context.service';

const MAT: PatientFefoIdentity = {
  scientificName: 'Amoxicillin',
  nationalCode: 'NC-1',
  concentration: '500 mg',
  dosageForm: 'capsule',
  unit: 'box',
};

const lot = (over: Partial<PatientFefoLot> & { id: string }): PatientFefoLot => ({
  ...MAT,
  batchNumber: 'B',
  expiryDate: '2030-01-01',
  availableQuantity: 10,
  ...over,
});

// A fixed "today" so expiry cases never depend on the wall clock.
const ASOF = new Date('2026-06-15T00:00:00Z');

describe('patient FEFO — ordering', () => {
  it('recommends the earliest expiry first', () => {
    const lots = [
      lot({ id: 'late', expiryDate: '2027-01-01' }),
      lot({ id: 'early', expiryDate: '2026-09-01' }),
      lot({ id: 'mid', expiryDate: '2026-12-01' }),
    ];
    expect(patientFefoCandidates(lots, MAT, ASOF).map(l => l.id))
      .toEqual(['early', 'mid', 'late']);
    expect(patientFefoRecommendation(lots, MAT, ASOF)?.id).toBe('early');
  });

  it('is deterministic for identical expiries — batch, then id', () => {
    const lots = [
      lot({ id: 'zzz', batchNumber: 'B-2' }),
      lot({ id: 'aaa', batchNumber: 'B-2' }),
      lot({ id: 'mmm', batchNumber: 'B-1' }),
    ];
    const once = patientFefoCandidates(lots, MAT, ASOF).map(l => l.id);
    // B-1 sorts before B-2; within B-2, id breaks the tie.
    expect(once).toEqual(['mmm', 'aaa', 'zzz']);
    // Same dataset, shuffled input, same answer — a recommendation must be
    // stable or an operator cannot trust it.
    const again = patientFefoCandidates([...lots].reverse(), MAT, ASOF).map(l => l.id);
    expect(again).toEqual(once);
  });

  it('sorts a NULL expiry LAST — undated stock is not "expiring soonest"', () => {
    const lots = [
      lot({ id: 'undated', expiryDate: null }),
      lot({ id: 'dated', expiryDate: '2029-01-01' }),
    ];
    expect(patientFefoCandidates(lots, MAT, ASOF).map(l => l.id))
      .toEqual(['dated', 'undated']);
  });
});

describe('patient FEFO — exclusions', () => {
  it('excludes non-positive available quantity', () => {
    const lots = [
      lot({ id: 'empty', availableQuantity: 0, expiryDate: '2026-07-01' }),
      lot({ id: 'negative', availableQuantity: -3, expiryDate: '2026-07-02' }),
      lot({ id: 'ok', expiryDate: '2026-08-01' }),
    ];
    expect(patientFefoCandidates(lots, MAT, ASOF).map(l => l.id)).toEqual(['ok']);
  });

  it('excludes stock already past its expiry date', () => {
    const lots = [
      lot({ id: 'expired', expiryDate: '2026-06-14' }),   // yesterday
      lot({ id: 'today', expiryDate: '2026-06-15' }),     // still valid today
    ];
    expect(patientFefoCandidates(lots, MAT, ASOF).map(l => l.id)).toEqual(['today']);
  });

  it('never treats a NULL expiry as expired', () => {
    const lots = [lot({ id: 'undated', expiryDate: null })];
    expect(patientFefoCandidates(lots, MAT, ASOF).map(l => l.id)).toEqual(['undated']);
  });

  it('excludes a different exact material even when the name matches', () => {
    const lots = [
      lot({ id: 'same' }),
      lot({ id: 'other-strength', concentration: '250 mg' }),
      lot({ id: 'other-code', nationalCode: 'NC-2' }),
      lot({ id: 'other-form', dosageForm: 'syrup' }),
      lot({ id: 'other-unit', unit: 'bottle' }),
    ];
    expect(patientFefoCandidates(lots, MAT, ASOF).map(l => l.id)).toEqual(['same']);
  });

  it('matches identity case- and whitespace-insensitively but never fuzzily', () => {
    expect(isSamePatientFefoMaterial(MAT, { ...MAT, scientificName: '  amoxicillin ' })).toBe(true);
    expect(isSamePatientFefoMaterial(MAT, { ...MAT, scientificName: 'amoxicillin sodium' })).toBe(false);
    // A NULL code and an empty code are the same absence; a real code is not.
    expect(isSamePatientFefoMaterial(
      { ...MAT, nationalCode: null }, { ...MAT, nationalCode: '' })).toBe(true);
    expect(isSamePatientFefoMaterial(
      { ...MAT, nationalCode: null }, { ...MAT, nationalCode: 'NC-9' })).toBe(false);
  });
});

describe('patient FEFO — provenance neutrality (the whole point)', () => {
  it('includes stock regardless of provenance, because the advisory cannot see it', () => {
    // PatientFefoLot has NO provenance field at all — there is nothing to
    // filter on. This is structural, not incidental: a provenance-less row
    // and a dispatch-backed row are indistinguishable here, so the advisory
    // can never hide the former the way transfer FEFO deliberately does.
    const provenanceless = lot({ id: 'seeded', expiryDate: '2026-07-01' });
    const dispatchBacked = lot({ id: 'received', expiryDate: '2026-08-01' });
    const out = patientFefoCandidates([dispatchBacked, provenanceless], MAT, ASOF);
    expect(out.map(l => l.id)).toEqual(['seeded', 'received']);
    expect(Object.keys(provenanceless)).not.toContain('dispatchLineId');
  });

  it('recommends nothing rather than something illegal when the outlet is empty', () => {
    expect(patientFefoRecommendation([], MAT, ASOF)).toBeNull();
    expect(patientFefoRecommendation([lot({ id: 'x', availableQuantity: 0 })], MAT, ASOF)).toBeNull();
  });
});

describe('patient FEFO — it is advisory, never authority', () => {
  it('returns rows only; it holds, reserves and mutates nothing', () => {
    const lots = [lot({ id: 'a' }), lot({ id: 'b', expiryDate: '2026-07-01' })];
    const snapshot = JSON.parse(JSON.stringify(lots));
    const out = patientFefoCandidates(lots, MAT, ASOF);
    // Input untouched: no reservation, no decrement, no marking.
    expect(lots).toEqual(snapshot);
    expect(out.every(r => typeof r.id === 'string')).toBe(true);
    // A stale recommendation is therefore only a suggestion — the canonical
    // RPC re-locks and re-checks the row, which the rig suite proves.
  });
});
