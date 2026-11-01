import { describe, expect, it } from 'vitest';
import { calculateR2Capacity, proposeEqualMonthlyQuantities } from '../conservative-policy';

describe('owner-approved conservative R2 arithmetic', () => {
  it('keeps allocation remainder and fulfillment remainder distinct', () => {
    expect(calculateR2Capacity({ annual: '12000', allocated: '3000', executed: '2200' })).toEqual({
      status: 'ready', remainingToAllocate: '9000', remainingToFulfill: '800', overAllocated: false, overExecuted: false,
    });
  });
  it('preserves overages as signed values instead of hiding them as zero', () => {
    expect(calculateR2Capacity({ annual: '100', allocated: '120', executed: '130' })).toEqual({
      status: 'ready', remainingToAllocate: '-20', remainingToFulfill: '-10', overAllocated: true, overExecuted: true,
    });
  });
  it('preserves quantities beyond Number safe precision and exact decimal subtraction', () => {
    expect(calculateR2Capacity({ annual: '12345678901234688.0149', allocated: '12345678901234567.891', executed: '0.1' })).toMatchObject({
      status: 'ready', remainingToAllocate: '120.1239', remainingToFulfill: '12345678901234567.791',
    });
    expect(calculateR2Capacity({ annual: '0.3', allocated: '0.1', executed: '0' })).toMatchObject({ remainingToAllocate: '0.2' });
  });
  it.each(['annual', 'allocated', 'executed'] as const)('reports missing %s as unavailable', field => {
    expect(calculateR2Capacity({ annual: '100', allocated: '20', executed: '10', [field]: null })).toEqual({ status: 'unavailable', reason: 'missing_quantity' });
  });
  it('distinguishes a real zero from missing data', () => {
    expect(calculateR2Capacity({ annual: '0', allocated: '0', executed: '0' })).toMatchObject({
      status: 'ready', remainingToAllocate: '0', remainingToFulfill: '0', overAllocated: false, overExecuted: false,
    });
  });
  it.each([' 1', '1.0', '١', '1e3', '-1', '01', '9'.repeat(257)])('refuses noncanonical quantity %s', invalid => {
    expect(calculateR2Capacity({ annual: invalid, allocated: '0', executed: '0' })).toEqual({ status: 'unavailable', reason: 'invalid_quantity' });
  });
});

describe('equal proposal in explicitly selected unapproved periods', () => {
  it('preserves the full 100-unit total and places the remainder chronologically', () => {
    const months = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const before = [...months];
    expect(proposeEqualMonthlyQuantities('100', '1', months)).toEqual({ status: 'ready', proposals:
      Array.from({ length: 12 }, (_, i) => ({ month: i + 1, quantity: i < 4 ? '9' : '8' })),
    });
    expect(months).toEqual(before);
  });
  it('distributes exact fractional legal steps without binary floating point', () => {
    expect(proposeEqualMonthlyQuantities('0.7', '0.1', [12, 11])).toEqual({ status: 'ready', proposals: [
      { month: 11, quantity: '0.4' }, { month: 12, quantity: '0.3' },
    ] });
  });
  it('handles a large exact target in legal steps', () => {
    expect(proposeEqualMonthlyQuantities('12345678901234567.891', '0.001', [1, 2])).toEqual({ status: 'ready', proposals: [
      { month: 1, quantity: '6172839450617283.946' }, { month: 2, quantity: '6172839450617283.945' },
    ] });
  });
  it('retains zero as an explicit proposed quantity', () => {
    expect(proposeEqualMonthlyQuantities('0', '1', [11, 12])).toEqual({ status: 'ready', proposals: [{ month: 11, quantity: '0' }, { month: 12, quantity: '0' }] });
  });
  it.each([[], [1, 1], [0], [13], [1.5]].map(months => ({ months })))('refuses invalid selected periods $months', ({ months }) => {
    expect(proposeEqualMonthlyQuantities('100', '1', months)).toEqual({ status: 'unavailable', reason: 'invalid_periods' });
  });
  it.each(['0', '0.0', '-1', '١'])('refuses invalid or zero legal step %s', step => {
    expect(proposeEqualMonthlyQuantities('100', step, [1, 2])).toEqual({ status: 'unavailable', reason: 'invalid_step' });
  });
  it('refuses a target that cannot be expressed in the explicit legal step', () => {
    expect(proposeEqualMonthlyQuantities('1', '0.3', [1, 2])).toEqual({ status: 'unavailable', reason: 'not_multiple_of_step' });
  });
});
