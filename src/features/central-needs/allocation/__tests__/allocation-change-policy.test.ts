import { describe, expect, it } from 'vitest';
import { assessR2AllocationChange, type R2AllocationChangeInput } from '../conservative-policy';

const input: R2AllocationChangeInput = { annual: '100', allocatedTotal: '50', replacedAllocation: '20',
  chargedExecution: '10', proposedAllocation: '30' };

describe('R2 effective allocation replacement compatibility — no authority or writer', () => {
  it('replaces the old quantity once instead of adding both effective versions', () => {
    expect(assessR2AllocationChange(input)).toEqual({ status: 'compatible', nextAllocatedTotal: '60' });
  });
  it('accepts the annual ceiling exactly and refuses the smallest excess without changing input', () => {
    const original = { ...input, proposedAllocation: '70' };
    expect(assessR2AllocationChange(original)).toEqual({ status: 'compatible', nextAllocatedTotal: '100' });
    expect(assessR2AllocationChange({ ...original, proposedAllocation: '70.0001' })).toEqual({ status: 'conflict', reason: 'annual_ceiling' });
    expect(original.proposedAllocation).toBe('70');
  });
  it('preserves execution protection at the exact decimal boundary', () => {
    expect(assessR2AllocationChange({ ...input, proposedAllocation: '10' })).toEqual({ status: 'compatible', nextAllocatedTotal: '40' });
    expect(assessR2AllocationChange({ ...input, proposedAllocation: '9.9999' })).toEqual({ status: 'conflict', reason: 'below_charged_execution' });
  });
  it('handles a correction that resolves an existing charged-execution overage', () => {
    expect(assessR2AllocationChange({ ...input, replacedAllocation: '5', chargedExecution: '10', proposedAllocation: '12' }))
      .toEqual({ status: 'compatible', nextAllocatedTotal: '57' });
  });
  it('keeps an annual overage conflicting until the proposed effective total actually fits', () => {
    expect(assessR2AllocationChange({ ...input, allocatedTotal: '120', replacedAllocation: '40', proposedAllocation: '30' }))
      .toEqual({ status: 'conflict', reason: 'annual_ceiling' });
    expect(assessR2AllocationChange({ ...input, allocatedTotal: '120', replacedAllocation: '40', proposedAllocation: '20' }))
      .toEqual({ status: 'compatible', nextAllocatedTotal: '100' });
  });
  it('refuses inconsistent effective totals before deriving a fabricated negative subtotal', () => {
    expect(assessR2AllocationChange({ ...input, allocatedTotal: '19' }))
      .toEqual({ status: 'unavailable', reason: 'inconsistent_total' });
  });
  it('checks quantities beyond Number precision with exact decimal replacement', () => {
    const large = { annual: '12345678901234688.0149', allocatedTotal: '12345678901234567.891', replacedAllocation: '0.1',
      chargedExecution: '0.1', proposedAllocation: '120.2239' };
    expect(assessR2AllocationChange(large)).toEqual({ status: 'compatible', nextAllocatedTotal: large.annual });
    expect(assessR2AllocationChange({ ...large, proposedAllocation: '120.22391' })).toEqual({ status: 'conflict', reason: 'annual_ceiling' });
  });
  it.each(Object.keys(input) as (keyof R2AllocationChangeInput)[])('keeps missing %s unavailable', field => {
    expect(assessR2AllocationChange({ ...input, [field]: null })).toEqual({ status: 'unavailable', reason: 'missing_quantity' });
  });
  it.each(['1.0', '-1', '١', 'NaN'])('refuses invalid source quantity %s', proposedAllocation => {
    expect(assessR2AllocationChange({ ...input, proposedAllocation })).toEqual({ status: 'unavailable', reason: 'invalid_quantity' });
  });
  it('retains actual zero quantities without pretending a write or approval took place', () => {
    expect(assessR2AllocationChange({ annual: '0', allocatedTotal: '0', replacedAllocation: '0', chargedExecution: '0', proposedAllocation: '0' }))
      .toEqual({ status: 'compatible', nextAllocatedTotal: '0' });
  });
});
