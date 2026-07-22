/**
 * OUTLET-RETURN draft model — pure, provenance-keyed, cap-enforcing.
 *
 * The draft never persists anything; these tests pin the rules that make a
 * composed return safe BEFORE it reaches the server: caps from safeReturnable,
 * mandatory provenance and reason, one line per dispatch line, and a retry plan
 * that re-sends only what the server does not already have.
 */
import { describe, it, expect } from 'vitest';
import {
  draftLineFromReturnable,
  validateOutletReturnDraft,
  outletReturnDraftConfirmable,
  revalidateOutletReturnDraft,
  planOutletReturnRetry,
  type OutletReturnableLine,
  type OutletReturnDraftLine,
} from '../outlet-return-draft';
import type { ExistingReturnLine } from '../outlet-return-model';

const source = (over: Partial<OutletReturnableLine> = {}): OutletReturnableLine => ({
  dispatchLineId: 'DL1',
  scientificName: 'Amoxicillin',
  batchNumber: 'B-1',
  expiryDate: '2027-01-01',
  unit: 'box',
  receivedQuantity: 40,
  returnedQuantity: 0,
  status: 'accepted',
  tradeName: null, concentration: null, dosageForm: null, nationalCode: null,
  internalBatchReference: null, dispatchNumber: 'D-100', dispatchSentAt: '2026-06-01',
  ...over,
});

const line = (over: Partial<OutletReturnDraftLine> = {}): OutletReturnDraftLine =>
  ({ ...draftLineFromReturnable(source(), 5, 'damaged', null, 'k1'), ...over });

describe('draftLineFromReturnable', () => {
  it('carries the dispatch line as provenance and the safeReturnable cap', () => {
    const l = draftLineFromReturnable(source({ receivedQuantity: 40, returnedQuantity: 10 }), 5, 'excess', null, 'k1');
    expect(l.originalDispatchLineId).toBe('DL1');
    expect(l.maxQuantity).toBe(30); // 40 - 10
    expect(l.scientificName).toBe('Amoxicillin');
  });

  it('subtracts active reservations from the cap', () => {
    const existing: ExistingReturnLine[] = [{
      originalDispatchLineId: 'DL1', requestedQuantity: 12, approvedQuantity: null,
      fulfilledQuantity: 0, status: 'pending',
    }];
    const l = draftLineFromReturnable(source({ receivedQuantity: 40 }), 5, 'excess', null, 'k1', existing);
    expect(l.maxQuantity).toBe(28); // 40 - 0 - 12
  });
});

describe('validateOutletReturnDraft', () => {
  const sources = [source()];

  it('accepts a valid line', () => {
    expect(validateOutletReturnDraft([line({ quantity: 5, reasonCode: 'damaged' })], sources)).toEqual([]);
  });

  it('rejects a quantity over the cap', () => {
    const issues = validateOutletReturnDraft([line({ quantity: 999 })], sources);
    expect(issues.map(i => i.code)).toContain('quantity_exceeds_safe_returnable');
  });

  it('rejects a non-positive and a non-integer quantity', () => {
    expect(validateOutletReturnDraft([line({ quantity: 0 })], sources).map(i => i.code)).toContain('quantity_not_positive');
    expect(validateOutletReturnDraft([line({ quantity: 1.5 })], sources).map(i => i.code)).toContain('quantity_not_integer');
  });

  it('requires a reason code and a valid one', () => {
    expect(validateOutletReturnDraft([line({ reasonCode: '' })], sources).map(i => i.code)).toContain('reason_code_required');
    expect(validateOutletReturnDraft([line({ reasonCode: 'nonsense' })], sources).map(i => i.code)).toContain('reason_code_invalid');
  });

  it('requires free text when the reason is other', () => {
    expect(validateOutletReturnDraft([line({ reasonCode: 'other', reasonText: null })], sources).map(i => i.code))
      .toContain('reason_text_required');
    expect(validateOutletReturnDraft([line({ reasonCode: 'other', reasonText: 'spilled in transit' })], sources)).toEqual([]);
  });

  it('flags two lines that share one dispatch line', () => {
    const issues = validateOutletReturnDraft(
      [line({ idempotencyKey: 'k1' }), line({ idempotencyKey: 'k2' })],
      sources,
    );
    expect(issues.map(i => i.code)).toContain('duplicate_provenance');
  });

  it('flags a line whose source is no longer returnable', () => {
    const issues = validateOutletReturnDraft([line({ originalDispatchLineId: 'GONE' })], sources);
    expect(issues).toEqual([{ idempotencyKey: 'k1', code: 'source_unavailable' }]);
  });

  it('confirmable is false for an empty draft and true for a valid one', () => {
    expect(outletReturnDraftConfirmable([], sources)).toBe(false);
    expect(outletReturnDraftConfirmable([line()], sources)).toBe(true);
  });
});

describe('revalidateOutletReturnDraft', () => {
  it('lowers a cap that moved under the operator and reports the change', () => {
    const draft = [line({ quantity: 30, maxQuantity: 40 })];
    const fresher = [source({ receivedQuantity: 40, returnedQuantity: 25 })]; // cap now 15
    const { lines, changed } = revalidateOutletReturnDraft(draft, fresher);
    expect(lines[0].maxQuantity).toBe(15);
    expect(changed).toEqual(['k1']);
  });

  it('drops a vanished source to a zero cap', () => {
    const { lines, changed } = revalidateOutletReturnDraft([line({ maxQuantity: 40 })], []);
    expect(lines[0].maxQuantity).toBe(0);
    expect(changed).toEqual(['k1']);
  });
});

describe('planOutletReturnRetry', () => {
  it('re-sends only lines whose provenance the server does not already hold', () => {
    const draft = [
      line({ idempotencyKey: 'k1', originalDispatchLineId: 'DL1' }),
      line({ idempotencyKey: 'k2', originalDispatchLineId: 'DL2' }),
    ];
    const plan = planOutletReturnRetry(draft, ['DL1']);
    expect(plan.alreadyPresent).toEqual(['k1']);
    expect(plan.toSend.map(l => l.idempotencyKey)).toEqual(['k2']);
  });
});
