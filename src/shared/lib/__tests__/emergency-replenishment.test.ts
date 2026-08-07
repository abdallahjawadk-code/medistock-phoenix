import { describe, it, expect } from 'vitest';
import {
  REPLENISHMENT_SOURCE_POINT_TYPES,
  REPLENISHMENT_DESTINATION_POINT_TYPES,
  REPLENISHMENT_MOVEMENT_TYPES,
  REPLENISHMENT_REFERENCE_TYPES,
  isReplenishmentSourcePointType,
  isReplenishmentDestinationPointType,
  isReplenishmentMovementType,
  isReplenishmentReferenceType,
} from '../emergency-replenishment';
import { MOVEMENT_TYPE_LABEL_KEY } from '../movement-labels';

describe('emergency replenishment corridor vocabulary', () => {
  it('allows only a pharmacy as replenishment source', () => {
    expect([...REPLENISHMENT_SOURCE_POINT_TYPES]).toEqual(['pharmacy']);
  });

  it('allows only rescue cart and crash cabinet as replenishment destinations', () => {
    expect([...REPLENISHMENT_DESTINATION_POINT_TYPES]).toEqual([
      'rescue_cart',
      'crash_cabinet',
    ]);
  });

  it('declares exactly two movement types', () => {
    expect([...REPLENISHMENT_MOVEMENT_TYPES]).toEqual([
      'replenish_send',
      'replenish_receive',
    ]);
  });

  it('declares exactly two reference-type namespaces', () => {
    expect([...REPLENISHMENT_REFERENCE_TYPES]).toEqual([
      'outlet_replenishment',
      'outlet_replenishment_reversal',
    ]);
  });

  it('freezes every vocabulary', () => {
    expect(Object.isFrozen(REPLENISHMENT_SOURCE_POINT_TYPES)).toBe(true);
    expect(Object.isFrozen(REPLENISHMENT_DESTINATION_POINT_TYPES)).toBe(true);
    expect(Object.isFrozen(REPLENISHMENT_MOVEMENT_TYPES)).toBe(true);
    expect(Object.isFrozen(REPLENISHMENT_REFERENCE_TYPES)).toBe(true);
  });
});

describe('a pharmacy is never a replenishment destination', () => {
  // Replenishment is pharmacy -> emergency outlet. A pharmacy destination would
  // be a pharmacy-to-pharmacy transfer, which this corridor does not represent.
  it('excludes pharmacy from the destination vocabulary', () => {
    expect(REPLENISHMENT_DESTINATION_POINT_TYPES as readonly string[])
      .not.toContain('pharmacy');
    expect(isReplenishmentDestinationPointType('pharmacy')).toBe(false);
  });

  it('excludes the emergency outlet types from the source vocabulary', () => {
    expect(isReplenishmentSourcePointType('rescue_cart')).toBe(false);
    expect(isReplenishmentSourcePointType('crash_cabinet')).toBe(false);
  });
});

describe('guards are fail-closed', () => {
  const NOT_VALUES = [
    null,
    undefined,
    '',
    '   ',
    'PHARMACY',
    ' pharmacy ',
    'pharmacies',
    'crash_cart',
    'crash cabinet',
    'dispensing',
    'storage',
    'returns',
    'emergency',
    0,
    true,
    {},
    [],
  ];

  it.each(NOT_VALUES)('isReplenishmentSourcePointType rejects %o', (value) => {
    expect(isReplenishmentSourcePointType(value)).toBe(false);
  });

  it.each(NOT_VALUES)('isReplenishmentDestinationPointType rejects %o', (value) => {
    expect(isReplenishmentDestinationPointType(value)).toBe(false);
  });

  it.each([...NOT_VALUES, 'replenish', 'dispatch_receive', 'dispense'])(
    'isReplenishmentMovementType rejects %o',
    (value) => {
      expect(isReplenishmentMovementType(value)).toBe(false);
    },
  );

  it.each([...NOT_VALUES, 'outlet_request', 'outlet_return_send'])(
    'isReplenishmentReferenceType rejects %o',
    (value) => {
      expect(isReplenishmentReferenceType(value)).toBe(false);
    },
  );

  it('accepts each canonical token exactly', () => {
    for (const v of REPLENISHMENT_SOURCE_POINT_TYPES) {
      expect(isReplenishmentSourcePointType(v)).toBe(true);
    }
    for (const v of REPLENISHMENT_DESTINATION_POINT_TYPES) {
      expect(isReplenishmentDestinationPointType(v)).toBe(true);
    }
    for (const v of REPLENISHMENT_MOVEMENT_TYPES) {
      expect(isReplenishmentMovementType(v)).toBe(true);
    }
    for (const v of REPLENISHMENT_REFERENCE_TYPES) {
      expect(isReplenishmentReferenceType(v)).toBe(true);
    }
  });
});

describe('the corridor is declared but not yet reachable', () => {
  // The two movement types cannot be produced yet: no ledger vocabulary accepts
  // them. Wiring a reporting label for an unreachable movement belongs to the
  // reporting slice, not here. If a later slice adds the labels, this test is
  // the deliberate prompt to revisit it.
  it.each(['replenish_send', 'replenish_receive'])(
    'does not wire a movement label for %s yet',
    (type) => {
      expect(Object.keys(MOVEMENT_TYPE_LABEL_KEY)).not.toContain(type);
    },
  );
});
