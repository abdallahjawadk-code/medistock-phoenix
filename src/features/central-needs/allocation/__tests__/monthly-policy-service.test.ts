import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc } }));
import { getMonthlyPolicyReference } from '../monthly-policy.service';
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const context = { ownerOrgId: id(1), planningYear: 2026, annualItemId: id(2), fieldVersionId: id(3), canonicalItemId: id(4), unit: 'box', beneficiaryOrganizationId: id(5) };
beforeEach(() => rpc.mockReset());
describe('monthly reference transport authority and scope', () => {
  it('uses the employee RPC with identity context only, without a quantity or inferred periods', async () => {
    rpc.mockResolvedValue({ data: { status: 'awaiting_policy', context, reason: 'missing' }, error: null });
    expect(await getMonthlyPolicyReference(context)).toBeNull();
    expect(rpc).toHaveBeenCalledWith('phoenix_monthly_policy_reference', { p_organization_id: id(1), p_planning_year: 2026,
      p_annual_item_id: id(2), p_field_version_id: id(3), p_canonical_id: id(4), p_beneficiary_id: id(5) });
  });
  it('treats only exact missing-contract discovery as awaiting policy', async () => {
    rpc.mockResolvedValue({ error: { code: 'PGRST202', message: 'Could not find phoenix_monthly_policy_reference in the schema cache' }, data: null });
    expect(await getMonthlyPolicyReference(context)).toBeNull();
    rpc.mockResolvedValue({ error: { code: 'PGRST202', message: 'Could not find another_function' }, data: null });
    await expect(getMonthlyPolicyReference(context)).rejects.toThrow();
  });
  it.each(['42501', 'PGRST301', '08006'])('preserves permission/session/network failures: %s', async code => {
    rpc.mockResolvedValue({ error: { code, message: 'r2_permission_denied' }, data: null });
    await expect(getMonthlyPolicyReference(context)).rejects.toThrow();
  });
  it.each([
    { status: 'awaiting_policy', context: { ...context, beneficiaryOrganizationId: id(9) }, reason: 'missing' },
    { status: 'awaiting_policy', context: { ...context, unit: 'vial' }, reason: 'missing' },
    { status: 'awaiting_policy', context, reason: 'unknown' },
    { status: 'ready', context, effectiveAllocation: true, draftJournalImplemented: false, reference: null },
    { status: 'ready', context, effectiveAllocation: false, draftJournalImplemented: true, reference: null },
  ])('refuses malformed, foreign or unsupported replies %#', async data => {
    rpc.mockResolvedValue({ data, error: null }); await expect(getMonthlyPolicyReference(context)).rejects.toThrow('monthly_reference_invalid');
  });
});
