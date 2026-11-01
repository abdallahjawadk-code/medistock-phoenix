/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AnnualCatalogEditor } from '../AnnualCatalogEditor';
import { annualItem, change, ID } from './annual-ui-fixtures';

vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: vi.fn(() => { throw new Error('UI used a real RPC'); }) } }));
afterEach(cleanup);

describe('annual material information editor', () => {
  it('requires a human reason and sends field/version intent without client-supplied employee identity', async () => {
    const save = vi.fn(async () => null);
    render(<AnnualCatalogEditor lang="en" contextKey="r:b" item={annualItem()} changes={[]} canEdit onSave={save} />);
    fireEvent.change(screen.getByLabelText('Arabic display name'), { target: { value: 'اسم مصحح' } });
    expect(screen.getByRole('button', { name: 'Save the new field version' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for changing material information'), { target: { value: 'Correct spelling' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the new field version' }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ expectedFieldVersionId: ID.version,
      expectedCanonicalFingerprint: 'a'.repeat(64), reason: 'Correct spelling', fields: expect.objectContaining({ nameAr: 'اسم مصحح', nationalCode: '00012-A' }) }));
    const input = save.mock.calls[0] as unknown[];
    expect(Object.keys(input[0] as object).sort()).toEqual(['expectedCanonicalFingerprint', 'expectedFieldVersionId', 'fields', 'reason']);
    expect(screen.queryByLabelText(/employee name/i)).toBeNull();
  });

  it('renders the trusted employee snapshot, server time, reason and actual before/after values', () => {
    render(<AnnualCatalogEditor lang="en" contextKey="r:b" item={annualItem()} changes={[change()]} canEdit={false} onSave={vi.fn(async () => null)} />);
    const history = screen.getByRole('region', { name: 'Material information change history' });
    expect(within(history).getByText('Employee recorded by server')).toBeInTheDocument();
    expect(within(history).getByText('Corrected the annual display name')).toBeInTheDocument();
    expect(within(history).getByText('أموكسيسيلين')).toBeInTheDocument(); expect(within(history).getByText('اسم مصحح')).toBeInTheDocument();
    expect(history.querySelector('time')).toHaveAttribute('datetime', '2026-10-31T09:15:00Z');
    expect(screen.queryByRole('button', { name: 'Save the new field version' })).toBeNull();
    expect(screen.getByLabelText('National code')).toBeDisabled();
  });

  it('labels historical missing employee attribution instead of substituting the current actor', () => {
    render(<AnnualCatalogEditor lang="en" contextKey="r:b" item={annualItem()} changes={[{ ...change(), actorName: null, fromTrustedProfile: false }]}
      canEdit={false} onSave={vi.fn(async () => null)} />);
    expect(screen.getByText('The employee name was not recorded for this historical event')).toBeInTheDocument();
    expect(screen.queryByText('Employee recorded by server')).toBeNull();
  });

  it('shows the disputed identity fields and opens the existing registration path with the proposed values', () => {
    const item = annualItem();
    item.membership = { ...item.membership, status: 'preparing', currentFieldVersionId: ID.nextVersion };
    item.fieldVersion = { ...item.fieldVersion, fieldVersionId: ID.nextVersion, versionNumber: 2 };
    item.selectable = false;
    const request = vi.fn();
    render(<AnnualCatalogEditor lang="en" contextKey="r:b" item={item} changes={[{ ...change(), requiresLegalReview: ['nationalCode', 'unit'] }]}
      canEdit onSave={vi.fn(async () => null)} onRequestRegistration={request} />);
    const warning = screen.getByRole('note');
    expect(within(warning).getByText('National code')).toBeInTheDocument(); expect(within(warning).getByText('Unit')).toBeInTheDocument();
    fireEvent.click(within(warning).getByRole('button', { name: 'Open a registration request with these values' }));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ nationalCode: '00012-A', unit: 'box' }));
  });

  it('preserves an unsent edit when a newer version is observed and requires an explicit rebase', () => {
    const props = { lang: 'en' as const, contextKey: 'r:b', changes: [], canEdit: true, onSave: vi.fn(async () => null) };
    const view = render(<AnnualCatalogEditor {...props} item={annualItem()} />);
    fireEvent.change(screen.getByLabelText('Arabic display name'), { target: { value: 'My unsent edit' } });
    fireEvent.change(screen.getByLabelText('Reason for changing material information'), { target: { value: 'My reason' } });
    const newer = annualItem(); newer.fieldVersion = { ...newer.fieldVersion, fieldVersionId: ID.nextVersion, versionNumber: 2 };
    view.rerender(<AnnualCatalogEditor {...props} item={newer} />);
    expect(screen.getByLabelText('Arabic display name')).toHaveValue('My unsent edit');
    expect(screen.getByRole('button', { name: 'Save the new field version' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Replace the input with current values' }));
    expect(screen.getByLabelText('Arabic display name')).toHaveValue('أموكسيسيلين');
    expect(screen.getByLabelText('Reason for changing material information')).toHaveValue('');
  });

  it('keeps an unknown-outcome edit immutable while leaving the exact request reconciliation available', () => {
    const props = { lang: 'en' as const, contextKey: 'r:b', item: annualItem(), changes: [], canEdit: true, onSave: vi.fn(async () => null) };
    const view = render(<AnnualCatalogEditor {...props} />);
    fireEvent.change(screen.getByLabelText('Arabic display name'), { target: { value: 'Pending name' } });
    fireEvent.change(screen.getByLabelText('Reason for changing material information'), { target: { value: 'Pending reason' } });
    view.rerender(<AnnualCatalogEditor {...props} outcomeUnknown />);
    expect(screen.getByLabelText('Arabic display name')).toBeDisabled(); expect(screen.getByLabelText('Reason for changing material information')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reconcile the same edit request' })).toBeEnabled();
  });
});
