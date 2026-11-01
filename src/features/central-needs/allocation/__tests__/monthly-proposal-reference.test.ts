import { describe, expect, it } from 'vitest';
import { decodeMonthlyPolicyReference, proposeFromMonthlyPolicy, reviewMonthlyDraft } from '../monthly-proposal-reference';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const context = { ownerOrgId: id(1), planningYear: 2026, annualItemId: id(2), fieldVersionId: id(3),
  canonicalItemId: id(4), unit: 'box', beneficiaryOrganizationId: id(5) };
const policy = () => ({ policyId: id(6), version: 1, fingerprint: 'a'.repeat(64), status: 'approved',
  context: { ...context, beneficiaryOrganizationId: null as string | null }, unitStep: '0.25', eligibleMonths: [6, 2, 4],
  fixedMonths: [{ month: 1, quantity: '2.5', status: 'approved', ledgerReference: 'synthetic-prior-allocation' }],
  basis: { beneficiaryOrganizationId: context.beneficiaryOrganizationId, documentReference: 'Synthetic approved unit policy', documentSha256: 'b'.repeat(64),
    periodReference: 'Synthetic eligible-period decision', priorAllocationStatus: 'snapshot_verified',
    ledgerSnapshotSha256: 'c'.repeat(64), approvedById: id(7), approvedByName: 'Synthetic reviewer', approvedAt: '2026-01-01T10:00:00.000Z' } });

describe('documented monthly proposal reference; no defaults, approval or persistence', () => {
  it('waits for a documented policy and never guesses a step or periods', () => {
    expect(proposeFromMonthlyPolicy('10', context, null)).toEqual({ status: 'awaiting_policy' });
    expect(proposeFromMonthlyPolicy('', context, null)).toEqual({ status: 'enter_quantity' });
  });
  it('preserves approved months and splits only the remaining annual quantity exactly', () => {
    const result = proposeFromMonthlyPolicy('10.25', context, policy());
    expect(result).toMatchObject({ status: 'ready', annualQuantity: '10.25', fixedTotal: '2.5', remainingToPropose: '7.75',
      rows: [{ month: 1, quantity: '2.5', kind: 'fixed' }, { month: 2, quantity: '2.75', kind: 'suggested' },
        { month: 4, quantity: '2.5', kind: 'suggested' }, { month: 6, quantity: '2.5', kind: 'suggested' }],
      policyFingerprint: 'a'.repeat(64), effectiveAllocation: false });
  });
  it.each([
    { ...context, ownerOrgId: id(9) }, { ...context, planningYear: 2027 }, { ...context, unit: 'vial' },
    { ...context, fieldVersionId: id(9) }, { ...context, canonicalItemId: id(9) },
  ])('holds a stale or foreign policy scope %#', other => {
    expect(proposeFromMonthlyPolicy('10', other, policy())).toMatchObject({ status: 'held', reason: 'invalid_policy' });
  });
  it('requires an exact beneficiary match for a beneficiary-specific policy', () => {
    const p = policy(); p.context.beneficiaryOrganizationId = id(9);
    expect(proposeFromMonthlyPolicy('10', context, p)).toMatchObject({ status: 'held', reason: 'invalid_policy' });
  });
  it.each([true, false])('never reuses a populated or empty ledger snapshot for another beneficiary: populated=%s', populated => {
    const p = policy();
    if (!populated) { p.fixedMonths = []; p.basis.priorAllocationStatus = 'none_verified'; }
    expect(proposeFromMonthlyPolicy('10', { ...context, beneficiaryOrganizationId: id(9) }, p)).toMatchObject({ status: 'held', reason: 'invalid_policy' });
  });
  it.each([undefined, '0', '0.00', '1e-3'])('does not infer or coerce an invalid documented step %s', unitStep => {
    expect(proposeFromMonthlyPolicy('10', context, { ...policy(), unitStep })).toMatchObject({ status: 'held', reason: 'invalid_policy' });
  });
  it('holds overlapping eligible/approved months and an unverified empty historical basis', () => {
    expect(proposeFromMonthlyPolicy('10', context, { ...policy(), eligibleMonths: [1, 2] })).toMatchObject({ status: 'held', reason: 'invalid_policy' });
    const p = policy(); p.fixedMonths = []; p.basis.priorAllocationStatus = 'unknown';
    expect(proposeFromMonthlyPolicy('10', context, p)).toMatchObject({ status: 'held', reason: 'invalid_policy' });
  });
  it('refuses annual below already approved quantities and quantities outside the documented step', () => {
    expect(proposeFromMonthlyPolicy('2', context, policy())).toMatchObject({ status: 'held', reason: 'annual_below_fixed' });
    expect(proposeFromMonthlyPolicy('10.1', context, policy())).toMatchObject({ status: 'held', reason: 'incompatible_step' });
  });
  it('uses explicit high precision without assuming three decimal places', () => {
    const p = policy(); p.unitStep = '0.0000000000000001'; p.fixedMonths = []; p.basis.priorAllocationStatus = 'none_verified';
    expect(proposeFromMonthlyPolicy('0.0000000000000012', context, p)).toMatchObject({ status: 'ready', rows: [
      { month: 2, quantity: '0.0000000000000004' }, { month: 4, quantity: '0.0000000000000004' }, { month: 6, quantity: '0.0000000000000004' } ] });
  });
  it('snapshots the approved reference without changing source policy or quantity text', () => {
    const p = policy(), original = JSON.stringify(p); const decoded = decodeMonthlyPolicyReference(p, context);
    p.eligibleMonths[0] = 12; p.unitStep = '1';
    expect(decoded.unitStep).toBe('0.25'); expect(decoded.eligibleMonths).toEqual([2, 4, 6]);
    expect(original).not.toBe(JSON.stringify(p));
    expect(proposeFromMonthlyPolicy('10.250', context, decoded)).toEqual({ status: 'enter_quantity' });
  });
  it('requires a reason for changed monthly drafts, retains fixed months and proves an exact annual sum', () => {
    const changed = [{ month: 2, quantity: '2.5' }, { month: 4, quantity: '2.75' }, { month: 6, quantity: '2.5' }];
    expect(reviewMonthlyDraft('10.25', context, policy(), changed, '')).toMatchObject({ status: 'held', reason: 'reason_required' });
    expect(reviewMonthlyDraft('10.25', context, policy(), changed, 'Documented timing adjustment')).toMatchObject({ status: 'ready',
      changed: true, requiresEmployeeJournal: true, effectiveAllocation: false, total: '10.25' });
    expect(reviewMonthlyDraft('10.25', context, policy(), [...changed, { month: 1, quantity: '0' }], 'Change')).toMatchObject({ status: 'held', reason: 'invalid_edits' });
    expect(reviewMonthlyDraft('10.25', context, policy(), changed.map(row => ({ ...row, quantity: '1' })), 'Change')).toMatchObject({ status: 'held', reason: 'sum_mismatch' });
  });
  it('refuses malformed runtime edits without throwing or ignoring extra fields', () => {
    expect(reviewMonthlyDraft('10.25', context, policy(), [null as unknown as { month: number; quantity: string }], 'Change'))
      .toMatchObject({ status: 'held', reason: 'invalid_edits' });
  });
});
