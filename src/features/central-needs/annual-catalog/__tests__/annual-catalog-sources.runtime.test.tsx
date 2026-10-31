/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AnnualCatalogSources } from '../AnnualCatalogSources';
import { AnnualNeedsWorkspace } from '../AnnualNeedsWorkspace';
import type { AnnualCatalogOccurrencesPage } from '../annual-catalog-server.contract';
import type { AnnualCatalogScope, AnnualSourceOccurrence } from '../annual-catalog.contract';
import type { listAnnualCatalogOccurrences } from '../annual-catalog.service';
import { annualFixture, change, sourceOccurrence, CAPS, ID, SCOPE } from './annual-ui-fixtures';

vi.mock('@/shared/supabase/client', () => ({ supabase: {
  rpc: vi.fn(() => { throw new Error('Unexpected real RPC'); }),
  from: vi.fn(() => { throw new Error('Unexpected direct query'); }),
} }));
afterEach(cleanup);

type Reader = typeof listAnnualCatalogOccurrences;
const page = (occurrences: AnnualSourceOccurrence[], nextAfterOccurrenceId: string | null = null,
  scope: AnnualCatalogScope = SCOPE, annualItemId = ID.annual): AnnualCatalogOccurrencesPage => ({
  scope, annualItemId, occurrences, nextAfterOccurrenceId, attestation: 'client_attested',
});
const props = (reader: Reader) => ({ lang: 'en' as const, contextKey: ID.actor, scope: SCOPE, annualItemId: ID.annual, reader });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('bounded annual source reads', () => {
  it('loads page25 and the exact next cursor once, preserving order until completion', async () => {
    const first = Array.from({ length: 25 }, (_, i) => sourceOccurrence(i + 1));
    const last = sourceOccurrence(26);
    const next = deferred<AnnualCatalogOccurrencesPage>();
    const reader = vi.fn<Reader>().mockResolvedValueOnce(page(first, first[24].occurrenceKey)).mockReturnValueOnce(next.promise);
    render(<AnnualCatalogSources {...props(reader)} />);
    await screen.findByText(first[0].source.filename);
    expect(reader).toHaveBeenNthCalledWith(1, SCOPE, ID.annual, 25, null);
    expect(screen.queryByText('All returned pages loaded')).toBeNull();
    const more = screen.getByRole('button', { name: 'Load more witnesses' });
    fireEvent.click(more); fireEvent.click(more);
    expect(more).toBeDisabled();
    expect(reader).toHaveBeenCalledTimes(2);
    expect(reader).toHaveBeenNthCalledWith(2, SCOPE, ID.annual, 25, first[24].occurrenceKey);
    await act(async () => next.resolve(page([last])));
    await screen.findByText(last.source.filename);
    const list = screen.getByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(26);
    expect(rows[0]).toHaveTextContent(first[0].source.filename);
    expect(rows[25]).toHaveTextContent(last.source.filename);
    expect(screen.queryByRole('button', { name: 'Load more witnesses' })).toBeNull();
    expect(screen.getByRole('region', { name: 'This year’s material sources' })).toHaveTextContent('All returned pages loaded');
  });

  it('shows an empty result only after a successful read', async () => {
    const pending = deferred<AnnualCatalogOccurrencesPage>();
    const reader = vi.fn<Reader>().mockReturnValue(pending.promise);
    render(<AnnualCatalogSources {...props(reader)} />);
    expect(screen.queryByText('No source witnesses are recorded for this material.')).toBeNull();
    await act(async () => pending.resolve(page([])));
    expect(await screen.findByText('No source witnesses are recorded for this material.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps initial failure distinct from zero sources and retries only the read', async () => {
    const reader = vi.fn<Reader>().mockRejectedValueOnce(new Error('transport failed')).mockResolvedValue(page([]));
    render(<AnnualCatalogSources {...props(reader)} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('presence of witnesses for this material is unknown');
    expect(screen.queryByText('No source witnesses are recorded for this material.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry reading sources' }));
    await screen.findByText('No source witnesses are recorded for this material.');
    expect(reader).toHaveBeenNthCalledWith(2, SCOPE, ID.annual, 25, null);
  });

  it('retains earlier witnesses and the cursor when a later page fails', async () => {
    const first = sourceOccurrence(), second = sourceOccurrence(2);
    const reader = vi.fn<Reader>().mockResolvedValueOnce(page([first], first.occurrenceKey))
      .mockRejectedValueOnce(new Error('page failed')).mockResolvedValueOnce(page([second]));
    render(<AnnualCatalogSources {...props(reader)} />);
    await screen.findByText(first.source.filename);
    fireEvent.click(screen.getByRole('button', { name: 'Load more witnesses' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('read is incomplete');
    expect(screen.getByText(first.source.filename)).toBeInTheDocument();
    expect(screen.queryByText('All returned pages loaded')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading more witnesses' }));
    await screen.findByText(second.source.filename);
    expect(reader).toHaveBeenNthCalledWith(3, SCOPE, ID.annual, 25, first.occurrenceKey);
    expect(screen.getAllByText(first.source.filename)).toHaveLength(1);
  });

  it('marks retained data stale after reload failure and restarts from the first cursor', async () => {
    const first = sourceOccurrence(), replacement = sourceOccurrence(2);
    const reader = vi.fn<Reader>().mockResolvedValueOnce(page([first], first.occurrenceKey)).mockRejectedValueOnce(new Error('reload failed'))
      .mockResolvedValueOnce(page([replacement]));
    render(<AnnualCatalogSources {...props(reader)} />);
    await screen.findByText(first.source.filename);
    fireEvent.click(screen.getByRole('button', { name: 'Reload sources' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('may be out of date');
    expect(screen.getByText(first.source.filename)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more witnesses' })).toBeNull();
    expect(screen.queryByText('No source witnesses are recorded for this material.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry reading sources' }));
    await screen.findByText(replacement.source.filename);
    expect(screen.queryByText(first.source.filename)).toBeNull();
    expect(reader).toHaveBeenNthCalledWith(3, SCOPE, ID.annual, 25, null);
  });

  it.each(['actor', 'owner', 'year', 'item'] as const)('ignores a late prior %s response and leaves the new read loading', async (changeKind) => {
    const old = deferred<AnnualCatalogOccurrencesPage>(), fresh = deferred<AnnualCatalogOccurrencesPage>();
    const reader = vi.fn<Reader>().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const before = props(reader);
    const after = { ...before, contextKey: changeKind === 'actor' ? 'new-actor' : before.contextKey,
      scope: { ownerOrgId: changeKind === 'owner' ? '10000000-0000-4000-8000-000000000002' : ID.owner, planningYear: changeKind === 'year' ? 2027 : 2026 },
      annualItemId: changeKind === 'item' ? '40000000-0000-4000-8000-000000000002' : ID.annual };
    const view = render(<AnnualCatalogSources {...before} />);
    view.rerender(<AnnualCatalogSources {...after} />);
    await act(async () => {
      if (changeKind === 'year') old.reject(new Error('late old failure'));
      else old.resolve(page([sourceOccurrence()]));
    });
    expect(screen.queryByText(sourceOccurrence().source.filename)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Loading source witnesses');
    const row = { ...sourceOccurrence(2), scope: after.scope };
    await act(async () => fresh.resolve(page([row], null, after.scope, after.annualItemId)));
    await screen.findByText(row.source.filename);
    expect(reader).toHaveBeenLastCalledWith(after.scope, after.annualItemId, 25, null);
  });

  it('clears already rendered sources synchronously when the context changes', async () => {
    const next = deferred<AnnualCatalogOccurrencesPage>();
    const reader = vi.fn<Reader>().mockResolvedValueOnce(page([sourceOccurrence()])).mockReturnValueOnce(next.promise);
    const view = render(<AnnualCatalogSources {...props(reader)} />);
    await screen.findByText(sourceOccurrence().source.filename);
    view.rerender(<AnnualCatalogSources {...props(reader)} scope={{ ...SCOPE, planningYear: 2027 }} />);
    expect(screen.queryByText(sourceOccurrence().source.filename)).toBeNull();
    await act(async () => next.resolve(page([], null, { ...SCOPE, planningYear: 2027 })));
  });
});

describe('honest source presentation and editor integration', () => {
  it('preserves source text, missing/invalid distinctions, proposed classification and collapsed metadata in Arabic', async () => {
    const row = sourceOccurrence();
    row.classification = { label: 'تصنيف مقترح', origin: 'proposed', reference: 'human-proposal' };
    row.source.filename = 'اسم_ملف_عربي_طويل_لشواهد_المادة_2026.xlsx';
    const name = row.fields.scientificName;
    if (name.state !== 'value') throw new Error('fixture');
    row.fields.dosageForm = { state: 'invalid', reason: 'formula', witness: { ...name.witness, field: 'dosageForm',
      cell: { ...name.witness.cell, valueType: 'number', rawValue: 0, isFormula: true, formula: '1-1' } } };
    row.fields.unit = { state: 'missing', reason: 'blank', witness: { ...name.witness, field: 'unit',
      cell: { coordinate: name.witness.cell.coordinate, presence: 'blank', rawValue: null, isFormula: false, hasComment: false } } };
    const reader = vi.fn<Reader>().mockResolvedValue(page([row]));
    const view = render(<AnnualCatalogSources {...props(reader)} lang="ar" />);
    await screen.findByText(row.source.filename);
    const region = screen.getByRole('region', { name: 'مصادر المادة في هذه السنة' });
    expect(region).toHaveAttribute('dir', 'rtl');
    expect(region).toHaveTextContent('لم يتحقق النظام من مطابقتها للملف الأصلي');
    fireEvent.click(screen.getByText(row.source.filename));
    expect(screen.getByText('تصنيف مقترح، ليس تصنيفًا من المصدر:')).toBeInTheDocument();
    expect(screen.getAllByText('00012-A')).toHaveLength(2);
    expect(screen.getByText('00007-A')).toBeInTheDocument();
    expect(screen.getByText('صيغة؛ لم تُعتمد قيمة هوية')).toBeInTheDocument();
    expect(screen.getByText('خلية موجودة بلا قيمة')).toBeInTheDocument();
    expect(screen.getAllByText('الحقل غير معيّن في المصدر').length).toBeGreaterThan(0);
    expect(screen.getByText('1-1')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(view.container.querySelector('.prism-annual-source-metadata')).not.toHaveAttribute('open');
    expect(view.container.querySelector('a')).toBeNull();
    expect(reader).toHaveBeenCalledTimes(1);
    view.rerender(<AnnualCatalogSources {...props(reader)} lang="en" />);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region', { name: 'This year’s material sources' })).toHaveAttribute('dir', 'ltr');
  });

  it('reloads and pages inside material details without changing unsaved edits or trusted change history', async () => {
    const fixture = annualFixture();
    fixture.state.changes = [change()];
    const first = sourceOccurrence(), second = sourceOccurrence(2);
    vi.mocked(fixture.api.listAnnualCatalogOccurrences).mockResolvedValueOnce(page([first]))
      .mockResolvedValueOnce(page([first], first.occurrenceKey)).mockResolvedValueOnce(page([second]));
    render(<AnnualNeedsWorkspace lang="en" scope={SCOPE} actorId={ID.actor} revision={null} capabilities={CAPS}
      beneficiaries={[]} searchRegisteredMaterials={vi.fn(async () => [])} api={fixture.api} manualApi={fixture.manualApi} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Search this year' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Material details and history' }));
    await screen.findByRole('form', { name: 'Edit this year’s material information' });
    await screen.findByText(first.source.filename);
    await screen.findByText('Employee recorded by server');
    fireEvent.change(screen.getByLabelText('Arabic display name'), { target: { value: 'تعديل غير محفوظ' } });
    fireEvent.change(screen.getByLabelText('Reason for changing material information'), { target: { value: 'Keep this unsubmitted reason' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reload sources' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more witnesses' }));
    await screen.findByText(second.source.filename);
    expect(screen.getByLabelText('Arabic display name')).toHaveValue('تعديل غير محفوظ');
    expect(screen.getByLabelText('Reason for changing material information')).toHaveValue('Keep this unsubmitted reason');
    expect(screen.getByText('Employee recorded by server')).toBeInTheDocument();
    expect(fixture.api.listAnnualCatalogChanges).toHaveBeenCalledTimes(1);
    expect(fixture.api.editAnnualCatalogItem).not.toHaveBeenCalled();
    expect(fixture.api.addAnnualNeedLine).not.toHaveBeenCalled();
    expect(fixture.api.correctAnnualNeedLine).not.toHaveBeenCalled();
    expect(fixture.api.voidAnnualNeedLine).not.toHaveBeenCalled();
    expect(fixture.api.addAnnualCatalogItemForNeeds).not.toHaveBeenCalled();
    const sources = screen.getByRole('region', { name: 'This year’s material sources' });
    expect(sources).not.toHaveTextContent('Employee recorded by server');
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'This year’s material sources' })).toBeNull());
  });
});
