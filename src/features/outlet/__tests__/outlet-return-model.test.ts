/**
 * OUTLET-CORRIDOR-071 §2B/§4 — the returnable cap, exercised against the cases
 * the mandate names: repeated partial returns, returns after partial
 * consumption, cumulative returns, and concurrent requests competing for one
 * cap.
 *
 * These are pure-model tests. The server remains the authority — 071 caps at
 * received − returned under a row lock — so what is proven here is that the
 * number the operator SEES matches the number the server will enforce, and in
 * particular that it accounts for reservations the server counter does not yet
 * reflect (returned_quantity increments at SEND, not at add-line).
 */
import { describe, it, expect } from 'vitest';
import {
  RETURN_REASON_CODES, isReturnReasonCode, activeReservation, safeReturnable,
  isReturnable, validateReturnLine, bulkReturnableSources,
  type ReturnableSource, type ExistingReturnLine,
} from '../outlet-return-model';

function src(over: Partial<ReturnableSource> = {}): ReturnableSource {
  return {
    dispatchLineId: 'dl1', scientificName: 'Ceftriaxone', batchNumber: 'CTX-2291',
    expiryDate: '2027-03-31', unit: 'vial',
    receivedQuantity: 100, returnedQuantity: 0, status: 'accepted',
    ...over,
  };
}

function rline(over: Partial<ExistingReturnLine> = {}): ExistingReturnLine {
  return {
    originalDispatchLineId: 'dl1', requestedQuantity: 10,
    approvedQuantity: null, fulfilledQuantity: 0, status: 'pending',
    ...over,
  };
}

describe('§4 only a completed receipt can anchor a return', () => {
  it('offers a lot the outlet accepted', () => {
    expect(safeReturnable(src())).toBe(100);
    expect(isReturnable(src())).toBe(true);
  });

  it('offers a lot accepted WITH a difference, at the accepted quantity', () => {
    expect(safeReturnable(src({ status: 'accepted_with_difference', receivedQuantity: 88 }))).toBe(88);
  });

  it.each(['in_transit', 'sent', 'pending', 'draft', 'cancelled'])(
    'refuses to anchor a return to a %s line', (status) => {
      expect(safeReturnable(src({ status }))).toBe(0);
      expect(isReturnable(src({ status }))).toBe(false);
    },
  );

  it('refuses a line the outlet never actually received', () => {
    expect(safeReturnable(src({ receivedQuantity: null }))).toBe(0);
  });
});

describe('§4 cumulative returns cannot exceed what was accepted', () => {
  it('subtracts completed returns', () => {
    expect(safeReturnable(src({ returnedQuantity: 30 }))).toBe(70);
  });

  it('reaches exactly zero when everything has been returned', () => {
    expect(safeReturnable(src({ returnedQuantity: 100 }))).toBe(0);
    expect(isReturnable(src({ returnedQuantity: 100 }))).toBe(false);
  });

  it('clamps at zero rather than reporting a negative cap', () => {
    // Any genuine inconsistency is the server's to report, not ours to invent.
    expect(safeReturnable(src({ returnedQuantity: 130 }))).toBe(0);
  });

  it('handles repeated partial returns cumulatively', () => {
    expect(safeReturnable(src({ returnedQuantity: 25 }))).toBe(75);
    expect(safeReturnable(src({ returnedQuantity: 25 + 40 }))).toBe(35);
    expect(safeReturnable(src({ returnedQuantity: 25 + 40 + 35 }))).toBe(0);
  });
});

describe('§4 un-shipped request lines reserve the cap the server has not counted yet', () => {
  it('counts a pending line as a reservation', () => {
    // returned_quantity increments at SEND, so without this the operator would
    // be shown 100 and could build a second request that cannot ship.
    expect(safeReturnable(src(), [rline({ requestedQuantity: 40 })])).toBe(60);
  });

  it('prefers the APPROVED quantity once a reviewer has set one', () => {
    expect(safeReturnable(src(), [rline({ requestedQuantity: 40, approvedQuantity: 15 })])).toBe(85);
  });

  it('reserves only the UNSHIPPED remainder of a partially fulfilled line', () => {
    const line = rline({ requestedQuantity: 40, fulfilledQuantity: 25, status: 'partially_fulfilled' });
    // The shipped 25 is already inside returned_quantity; only 15 is still held.
    expect(safeReturnable(src({ returnedQuantity: 25 }), [line])).toBe(60);
  });

  it.each(['rejected', 'cancelled', 'fulfilled'])(
    'releases the reservation held by a %s line', (status) => {
      expect(activeReservation([rline({ requestedQuantity: 40, status })], 'dl1')).toBe(0);
      expect(safeReturnable(src(), [rline({ requestedQuantity: 40, status })])).toBe(100);
    },
  );

  it('never lets two concurrent requests both claim the whole cap', () => {
    const first = rline({ requestedQuantity: 100 });
    expect(safeReturnable(src(), [first])).toBe(0);
    expect(validateReturnLine(src(), 1, 'excess', null, [first]).map(i => i.code))
      .toContain('not_returnable');
  });

  it('ignores reservations belonging to a DIFFERENT dispatch line', () => {
    expect(activeReservation([rline({ originalDispatchLineId: 'other', requestedQuantity: 40 })], 'dl1')).toBe(0);
  });

  it('sums several live lines against one lot', () => {
    expect(activeReservation([
      rline({ requestedQuantity: 10 }),
      rline({ requestedQuantity: 15, status: 'approved' }),
      rline({ requestedQuantity: 99, status: 'cancelled' }),
    ], 'dl1')).toBe(25);
  });
});

describe('§2B every return states a reason', () => {
  it('mirrors exactly the nine reason codes migration 071 accepts', () => {
    expect([...RETURN_REASON_CODES]).toEqual([
      'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',
      'recalled', 'quality_issue', 'temperature_excursion', 'other',
    ]);
  });

  it('rejects a code the server would refuse', () => {
    expect(isReturnReasonCode('made_up')).toBe(false);
    expect(validateReturnLine(src(), 10, 'made_up', null).map(i => i.code))
      .toContain('reason_code_invalid');
  });

  it('requires a reason at all', () => {
    expect(validateReturnLine(src(), 10, '', null).map(i => i.code)).toContain('reason_code_required');
  });

  it("requires free text when the reason is 'other'", () => {
    expect(validateReturnLine(src(), 10, 'other', null).map(i => i.code)).toContain('reason_text_required');
    expect(validateReturnLine(src(), 10, 'other', 'carton crushed in transit')).toEqual([]);
  });

  it('accepts a well-formed return', () => {
    expect(validateReturnLine(src(), 10, 'near_expiry', null)).toEqual([]);
  });
});

describe('§2B quantity validation matches the server cap', () => {
  it('refuses more than the safe returnable', () => {
    expect(validateReturnLine(src({ returnedQuantity: 90 }), 11, 'excess', null).map(i => i.code))
      .toContain('quantity_exceeds_safe_returnable');
  });

  it('allows exactly the safe returnable', () => {
    expect(validateReturnLine(src({ returnedQuantity: 90 }), 10, 'excess', null)).toEqual([]);
  });

  it('refuses zero, negative and fractional quantities', () => {
    expect(validateReturnLine(src(), 0, 'excess', null).map(i => i.code)).toContain('quantity_not_positive');
    expect(validateReturnLine(src(), -3, 'excess', null).map(i => i.code)).toContain('quantity_not_positive');
    expect(validateReturnLine(src(), 2.5, 'excess', null).map(i => i.code)).toContain('quantity_not_integer');
  });
});

describe('§2B bulk return is offered only under one chosen reason', () => {
  const lots = [
    src({ dispatchLineId: 'a' }),
    src({ dispatchLineId: 'b', returnedQuantity: 100 }),   // nothing left
    src({ dispatchLineId: 'c', status: 'in_transit' }),    // never received
  ];

  it('includes only lots with headroom and a completed receipt', () => {
    expect(bulkReturnableSources(lots, 'excess').map(s => s.dispatchLineId)).toEqual(['a']);
  });

  it('offers nothing when the chosen reason is itself invalid', () => {
    expect(bulkReturnableSources(lots, 'other', null)).toEqual([]);
    expect(bulkReturnableSources(lots, 'made_up')).toEqual([]);
  });

  it("offers the lots once 'other' carries its explanation", () => {
    expect(bulkReturnableSources(lots, 'other', 'stock rotation').map(s => s.dispatchLineId)).toEqual(['a']);
  });

  it('respects reservations when deciding the bulk set', () => {
    expect(bulkReturnableSources([src({ dispatchLineId: 'a' })], 'excess', null,
      [rline({ originalDispatchLineId: 'a', requestedQuantity: 100 })])).toEqual([]);
  });
});
