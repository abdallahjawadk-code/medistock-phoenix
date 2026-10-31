/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AnnualCatalogPicker, type AnnualCatalogPickerApi } from '../AnnualCatalogPicker';
import type { AnnualFieldState } from '../annual-catalog.contract';
import type { AnnualCatalogItemResult, AnnualCatalogPage } from '../annual-catalog-server.contract';

vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: vi.fn(() => { throw new Error('UI must use its injected service'); }) } }));

const scope = { ownerOrgId: 'owner-1', planningYear: 2026 };
const known = (value: string): AnnualFieldState => ({ state: 'known', value, origins: [{ kind: 'canonical', canonicalItemId: 'canonical', decisionReference: 'registered' }] });
function item(id: string, extra: Partial<AnnualCatalogItemResult> = {}): AnnualCatalogItemResult {
  return {
    scope,
    membership: { scope, annualItemId: id, canonicalItemId: `canonical-${id}`, status: 'active', currentFieldVersionId: `v-${id}`, occurrenceKeys: [] },
    fieldVersion: { scope, annualItemId: id, fieldVersionId: `v-${id}`, versionNumber: 1,
      fields: { scientificName: known(`Material ${id}`), nameAr: { state: 'missing', reason: 'canonical_missing' }, nationalCode: known(`00-${id}`),
        barcode: { state: 'missing', reason: 'canonical_missing' }, dosageForm: known('Capsules'), concentration: known('500 mg'), unit: known('box') } },
    canonicalFingerprint: 'fingerprint', canonicalDrift: false, selectable: true, selectionBlockers: [], sourceOccurrenceCount: 0,
    sourceAttestation: 'client_attested', ...extra,
  };
}
const page = (items: AnnualCatalogItemResult[], nextCursor: AnnualCatalogPage['nextCursor'] = null): AnnualCatalogPage => ({ scope, items, nextCursor });
function api(): AnnualCatalogPickerApi {
  return { searchAnnualCatalog: vi.fn(async () => page([item('a')])), getAnnualCatalogItem: vi.fn(async (_scope, id) => item(id)) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(cleanup);

describe('annual catalog picker', () => {
  it('pages within the same year and query, refreshes selection, preserves version references and removes only a temporary choice', async () => {
    const service = api();
    const cursor = { ...scope, query: 'capsule', rank: 1 as const, annualItemId: 'a' };
    vi.mocked(service.searchAnnualCatalog).mockResolvedValueOnce(page([item('a')], cursor)).mockResolvedValueOnce(page([item('b')]));
    const fresh = item('a');
    fresh.fieldVersion = { ...fresh.fieldVersion, fieldVersionId: 'version-refreshed', versionNumber: 2 };
    fresh.membership = { ...fresh.membership, currentFieldVersionId: 'version-refreshed' };
    vi.mocked(service.getAnnualCatalogItem).mockResolvedValueOnce(fresh).mockResolvedValueOnce(item('b'));
    const picked = vi.fn(); const removed = vi.fn();
    function Harness() {
      const [selected, setSelected] = useState<AnnualCatalogItemResult[]>([]);
      return <AnnualCatalogPicker lang="en" scope={scope} contextKey="revision:beneficiary" selected={selected} api={service}
        onPick={(value) => { picked(value); setSelected((values) => [...values, value]); }}
        onRemove={(id) => { removed(id); setSelected((values) => values.filter((value) => value.membership.annualItemId !== id)); }} />;
    }
    render(<Harness />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'capsule' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search this year' }));
    await screen.findByText('Material a');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'new unsent query' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load more materials' }));
    await screen.findByText('Material b');
    expect(service.searchAnnualCatalog).toHaveBeenLastCalledWith(scope, 'capsule', 25, cursor);
    const results = screen.getByRole('list', { name: 'Annual catalog results' });
    fireEvent.click(within(results).getAllByRole('button', { name: 'Select material' })[0]);
    await waitFor(() => expect(picked).toHaveBeenCalledWith(fresh));
    expect(service.getAnnualCatalogItem).toHaveBeenCalledWith(scope, 'a');
    fireEvent.click(within(results).getByRole('button', { name: 'Select material' }));
    await waitFor(() => expect(picked).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Remove selection Material a' }));
    expect(removed).toHaveBeenCalledWith('a');
    expect(screen.getByRole('button', { name: 'Remove selection Material b' })).toBeInTheDocument();
  });

  it('shows the server blocker and never selects an ineligible result', async () => {
    const service = api(); const picked = vi.fn();
    vi.mocked(service.searchAnnualCatalog).mockResolvedValue(page([item('a', { selectable: false, selectionBlockers: ['canonical_drift'] })]));
    render(<AnnualCatalogPicker lang="en" scope={scope} contextKey="r:b" selected={[]} api={service} onPick={picked} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search this year' }));
    expect(await screen.findByText('The registered data changed; review and explicitly refresh the annual version.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select material' })).toBeDisabled();
    expect(service.getAnnualCatalogItem).not.toHaveBeenCalled(); expect(picked).not.toHaveBeenCalled();
  });

  it('rechecks a once-eligible search result and refuses it when the current version is no longer selectable', async () => {
    const service = api(); const picked = vi.fn();
    vi.mocked(service.getAnnualCatalogItem).mockResolvedValue(item('a', { selectable: false, selectionBlockers: ['member_preparing'] }));
    render(<AnnualCatalogPicker lang="en" scope={scope} contextKey="r:b" selected={[]} api={service} onPick={picked} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search this year' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Select material' }));
    expect(await screen.findByText('The material is still being prepared.')).toBeInTheDocument();
    expect(picked).not.toHaveBeenCalled();
  });

  it('discards a late search when the year changes', async () => {
    const service = api(); const pending = deferred<AnnualCatalogPage>();
    vi.mocked(service.searchAnnualCatalog).mockReturnValue(pending.promise);
    const props = { lang: 'en' as const, contextKey: 'r:b', selected: [], api: service, onPick: vi.fn(), onRemove: vi.fn() };
    const view = render(<AnnualCatalogPicker {...props} scope={scope} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search this year' }));
    view.rerender(<AnnualCatalogPicker {...props} scope={{ ...scope, planningYear: 2027 }} />);
    pending.resolve(page([item('a')]));
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.queryByText('Material a')).toBeNull();
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });

  it('discards a late selection when the beneficiary context changes', async () => {
    const service = api(); const pending = deferred<AnnualCatalogItemResult>(); const picked = vi.fn();
    vi.mocked(service.getAnnualCatalogItem).mockReturnValue(pending.promise);
    const props = { lang: 'en' as const, scope, selected: [], api: service, onPick: picked, onRemove: vi.fn() };
    const view = render(<AnnualCatalogPicker {...props} contextKey="revision:beneficiary-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Search this year' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Select material' }));
    view.rerender(<AnnualCatalogPicker {...props} contextKey="revision:beneficiary-b" />);
    pending.resolve(item('a'));
    await waitFor(() => expect(screen.queryByText('Checking the material’s current version…')).toBeNull());
    expect(picked).not.toHaveBeenCalled();
  });

  it('distinguishes a failed annual search from an empty catalog and retries only the annual API', async () => {
    const service = api();
    vi.mocked(service.searchAnnualCatalog).mockRejectedValueOnce(new Error('permission denied')).mockResolvedValueOnce(page([]));
    render(<AnnualCatalogPicker lang="ar" scope={scope} contextKey="r:b" selected={[]} api={service} onPick={vi.fn()} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'بحث في السنة' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('تعذر تحميل فهرس هذه السنة');
    expect(screen.queryByText('لا توجد مواد مطابقة في فهرس هذه السنة.')).toBeNull();
    expect(screen.getByRole('group', { name: 'فهرس مواد السنة' })).toHaveAttribute('dir', 'rtl');
    fireEvent.click(screen.getByRole('button', { name: 'بحث في السنة' }));
    expect(await screen.findByText('لا توجد مواد مطابقة في فهرس هذه السنة.')).toBeInTheDocument();
    expect(service.searchAnnualCatalog).toHaveBeenCalledTimes(2);
  });
});
