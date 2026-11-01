/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
import { MonthlyProposalPanel } from '../MonthlyProposalPanel';
import type { MonthlyPolicyReference } from '../monthly-proposal-reference';
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const context = { ownerOrgId: id(1), planningYear: 2026, annualItemId: id(2), fieldVersionId: id(3), canonicalItemId: id(4), unit: 'box', beneficiaryOrganizationId: id(5) };
const policy = (): MonthlyPolicyReference => ({ policyId: id(6), version: 1, fingerprint: 'a'.repeat(64), status: 'approved',
  context, unitStep: '0.25', eligibleMonths: [2, 4, 6], fixedMonths: [{ month: 1, quantity: '2.5', status: 'approved', ledgerReference: 'Synthetic approved allocation' }],
  basis: { beneficiaryOrganizationId: id(5), documentReference: 'Synthetic policy decision', documentSha256: 'b'.repeat(64), periodReference: 'Synthetic eligible periods',
    priorAllocationStatus: 'snapshot_verified', ledgerSnapshotSha256: 'c'.repeat(64), approvedById: id(7), approvedByName: 'Synthetic reviewer', approvedAt: '2026-01-01T10:00:00.000Z' } });
afterEach(cleanup);
describe('real monthly proposal panel; read-only current reference', () => {
  it.each(['ar', 'en'] as const)('shows missing policy without inventing step, periods or effective quotas: %s', async lang => {
    render(<MonthlyProposalPanel lang={lang} context={context} annualQuantity="10.25" readReference={async () => null} />);
    expect(await screen.findByText(lang === 'ar' ? 'بانتظار تحديد سياسة التوزيع' : 'Awaiting distribution policy')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull(); expect(screen.queryByRole('button', { name: /اعتماد|Approve/ })).toBeNull();
  });
  it('keeps the annual input blank and recalculates each quantity change without another reference request', async () => {
    const read = vi.fn(async () => policy());
    const { rerender } = render(<MonthlyProposalPanel lang="en" context={context} annualQuantity="" readReference={read} />);
    expect(await screen.findByText('Enter the annual quantity to see the proposal.')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    rerender(<MonthlyProposalPanel lang="en" context={context} annualQuantity="10.25" readReference={read} />);
    const table = await screen.findByRole('table', { name: 'Monthly distribution proposal' });
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    expect(within(table).getByText('2.75')).toBeVisible(); expect(within(table).getByText('10.25')).toBeVisible();
    rerender(<MonthlyProposalPanel lang="en" context={context} annualQuantity="10.5" readReference={read} />);
    expect(within(table).getByText('10.5')).toBeVisible(); expect(read).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Fixed approved allocation')).toBeVisible(); expect(screen.getByText('Synthetic policy decision')).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('holds an amount below approved quantities without displaying an invalid proposal', async () => {
    render(<MonthlyProposalPanel lang="en" context={context} annualQuantity="1" readReference={async () => policy()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The annual quantity is below fixed approved allocations.');
    expect(screen.queryByRole('table')).toBeNull();
  });
  it('discards an old beneficiary response and never flashes its allocation quantities', async () => {
    let finish!: (value: MonthlyPolicyReference) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(null);
    const { rerender } = render(<MonthlyProposalPanel lang="en" context={context} annualQuantity="10.25" readReference={read} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    rerender(<MonthlyProposalPanel lang="en" context={{ ...context, beneficiaryOrganizationId: id(9) }} annualQuantity="10.25" readReference={read} />);
    await screen.findByText('Awaiting distribution policy'); finish(policy());
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull());
  });
  it('keeps permission or transport failure distinct from missing policy and offers explicit read retry', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('r2_permission_denied')).mockResolvedValueOnce(policy());
    render(<MonthlyProposalPanel lang="en" context={context} annualQuantity="10.25" readReference={read} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The distribution policy could not be read. Check your access or retry.');
    expect(screen.queryByText('Awaiting distribution policy')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload distribution policy' }));
    expect(await screen.findByRole('table')).toBeVisible(); expect(read).toHaveBeenCalledTimes(2);
  });
});
