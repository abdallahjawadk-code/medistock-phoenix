/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
import { VerifiedSourceReview, type VerifiedSourceReviewApi } from '../VerifiedSourceReview';
import { VerifiedSourceError } from '../verified-source.service';
import { decodeSourcePage } from '../verified-source.contract';
import { annualFixture, annualItem, sourceOccurrence, ID, SCOPE } from './annual-ui-fixtures';
const profile = { id: 'synthetic-reviewed', version: 1, sha256: 'b'.repeat(64) };
const original = { originalId: ID.event, sha256: 'a'.repeat(64), byteSize: 100, firstFilename: 'synthetic.xlsx',
  createdBy: ID.actor, createdByName: 'Synthetic employee', createdByRole: 'warehouse_officer', createdAt: '2026-11-01T10:00:00Z', attestation: 'server_received_original' as const };
function fixture(empty = false) {
  const candidate = sourceOccurrence(); candidate.classification = null;
  candidate.source = { ...candidate.source, sourceId: original.originalId, sha256: original.sha256, filename: original.firstFilename,
    parser: { ...candidate.source.parser, runtime: 'node' } };
  candidate.occurrenceKey = JSON.stringify([JSON.stringify([SCOPE.ownerOrgId, SCOPE.planningYear]), original.originalId, original.sha256, 0, candidate.source.blockId, 1]);
  candidate.fields.unit = { state: 'value', text: 'box', witness: { field: 'unit',
    cell: { coordinate: { row: 1, col: 8, a1: 'I2' }, presence: 'value', valueType: 'string', rawValue: 'box', isFormula: false, hasComment: false },
    header: { coordinate: { row: 0, col: 8, a1: 'I1' }, presence: 'value', valueType: 'string', rawValue: 'Unit', isFormula: false, hasComment: false } } };
  const rows = [candidate];
  const page = decodeSourcePage({ ok: true, evidence: { scope: SCOPE, original: { originalId: original.originalId, sha256: original.sha256, byteSize: 100, attestation: original.attestation },
    template: { ...profile, version: '1' }, status: 'source_evidence_only_review_required', preparationStatus: 'prepared', persisted: false,
    coreTemplate: { id: profile.id, version: 1, reviewReference: 'Synthetic', sha256: 'c'.repeat(64) }, parser: candidate.source.parser,
    registrySha256: 'd'.repeat(64), classifications: [], rows, totalRows: 1, nextCursor: null } }, { scope: SCOPE, original, profile, cursor: null, pageSize: 50 });
  const fresh = annualItem();
  const verified = { ...fresh, idempotentReplay: false, c4Verification: { attestation: 'server_verified_c2_extraction_v1' as const, proofId: ID.change, proofSha256: 'e'.repeat(64),
    originalId: original.originalId, originalSha256: original.sha256, registrationSha256: profile.sha256, workerSha256: 'f'.repeat(64),
    reviewedById: ID.actor, reviewedByName: 'Synthetic employee', reviewedAt: '2026-11-01T10:00:00Z' } };
  const base = annualFixture();
  const api = {
    discover: vi.fn<VerifiedSourceReviewApi['discover']>(async () => ({ version: 1 as const, scope: SCOPE, selectionMode: 'explicit_reviewed_profile' as const, readAvailable: !empty,
      commitState: empty ? 'unavailable_registry' as const : 'ready' as const, profiles: empty ? [] : [profile], maxPageRows: 50 as const, maxRequestBytes: 16384 as const })),
    readPage: vi.fn<VerifiedSourceReviewApi['readPage']>(async () => page),
    preview: vi.fn<VerifiedSourceReviewApi['preview']>(async () => { const p = await base.api.previewAnnualCanonical(SCOPE, ID.canonical); return { ...p, canonicalSnapshot: { ...p.canonicalSnapshot,
      dosageForm: null, concentration: null } }; }),
    commit: vi.fn<VerifiedSourceReviewApi['commit']>().mockResolvedValue(verified), receipt: vi.fn<VerifiedSourceReviewApi['receipt']>(async () => ({ status: 'prepared' as const, requestId: ID.request, proofId: ID.change, proofSha256: 'e'.repeat(64) })),
    current: vi.fn<VerifiedSourceReviewApi['current']>(async () => fresh), newRequestId: vi.fn(() => ID.request),
  } satisfies VerifiedSourceReviewApi;
  return { api, fresh, verified, search: vi.fn(async () => [{ id: ID.canonical, name: 'Amoxicillin', nameAr: null, unit: 'box', nationalCode: '00012-A', concentration: null, dosageForm: null }]), onFresh: vi.fn(), onLock: vi.fn(), onClose: vi.fn() };
}
const view = (f: ReturnType<typeof fixture>, lang: 'ar' | 'en' = 'en') => <VerifiedSourceReview lang={lang} scope={SCOPE} actorId={ID.actor} original={original} canWrite
  api={f.api} search={f.search} onFresh={f.onFresh} onScopeLockChange={f.onLock} onClose={f.onClose} />;
afterEach(cleanup);
async function choose(f: ReturnType<typeof fixture>) {
  await screen.findByLabelText('Reviewed profile');
  fireEvent.change(screen.getByLabelText('Reviewed profile'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Read source witnesses' }));
  fireEvent.click(await screen.findByLabelText('Select source row 2'));
  fireEvent.change(screen.getByLabelText('Search a registered material'), { target: { value: 'Amox' } });
  fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));
  fireEvent.click(await screen.findByRole('button', { name: /^Use$/ }));
  await waitFor(() => expect(f.api.preview).toHaveBeenCalled());
  await screen.findByLabelText('Membership review reason');
  fireEvent.change(screen.getByLabelText('Membership review reason'), { target: { value: 'Reviewed the exact source identity' } });
}
describe('actual source-review component; explicit choices and unknown outcomes', () => {
  it.each(['ar','en'] as const)('shows empty reviewed registry without source bytes or invented profiles: %s', async lang => {
    const f = fixture(true); render(view(f, lang)); expect(await screen.findByText(lang === 'ar' ? 'بانتظار تهيئة القوالب المراجعة' : 'Awaiting reviewed source profiles')).toBeVisible();
    expect(f.api.readPage).not.toHaveBeenCalled(); expect(f.api.commit).not.toHaveBeenCalled();
  });
  it('requires an explicit profile choice even when only one exists', async () => {
    const f = fixture(); render(view(f));
    expect(screen.getByRole('heading', { name: 'Review material identity from original' })).toHaveFocus();
    expect(await screen.findByLabelText('Reviewed profile')).toHaveValue(''); expect(screen.getByRole('button', { name: 'Read source witnesses' })).toBeDisabled();
    expect(f.api.readPage).not.toHaveBeenCalled();
  });
  it('discards the superseded discovery read during StrictMode effect replay', async () => {
    const f = fixture(), empty = await fixture(true).api.discover(SCOPE, ID.actor), ready = await f.api.discover(SCOPE, ID.actor);
    let finish!: (value: typeof ready) => void;
    f.api.discover.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(empty);
    render(<StrictMode>{view(f)}</StrictMode>); await screen.findByText('Awaiting reviewed source profiles');
    await act(async () => { finish(ready); }); expect(screen.queryByLabelText('Reviewed profile')).toBeNull();
  });
  it('commits one explicit choice and reads current before updating the parent', async () => {
    const f = fixture(); render(view(f)); await choose(f); fireEvent.click(screen.getByRole('button', { name: 'Confirm annual membership' }));
    await waitFor(() => expect(f.onFresh).toHaveBeenCalledWith(f.fresh)); expect(f.api.commit).toHaveBeenCalledTimes(1);
    expect(f.api.commit.mock.calls[0][0].request.occurrenceKeys).toHaveLength(1); expect(f.api.current).toHaveBeenCalledWith(SCOPE, ID.annual);
    expect(f.onLock).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('button', { name: 'Confirm annual membership' })).toBeNull();
    expect(screen.getByLabelText('Select source row 2')).not.toBeChecked();
  });
  it('reads receipt first after an unknown result and permits only explicit same-intent retry', async () => {
    const f = fixture(); f.api.commit.mockRejectedValueOnce(new VerifiedSourceError('c4_commit_outcome_unknown', true, ID.request)); render(view(f));
    await choose(f); fireEvent.click(screen.getByRole('button', { name: 'Confirm annual membership' }));
    await screen.findByRole('button', { name: 'Check operation receipt' }); expect(f.api.receipt).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Close source review' })).toBeDisabled(); expect(screen.queryByRole('button', { name: 'Retry the same operation' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check operation receipt' })); await screen.findByRole('button', { name: 'Retry the same operation' });
    expect(f.api.commit).toHaveBeenCalledTimes(1); fireEvent.click(screen.getByRole('button', { name: 'Retry the same operation' }));
    await waitFor(() => expect(f.onFresh).toHaveBeenCalled()); expect(f.api.commit.mock.calls[1][0]).toBe(f.api.commit.mock.calls[0][0]); expect(f.api.newRequestId).toHaveBeenCalledTimes(1);
  });
  it('retries only the current read after an acknowledged save followed by read failure', async () => {
    const f = fixture(); f.api.current.mockRejectedValueOnce(new Error('network')); render(view(f)); await choose(f);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm annual membership' })); await screen.findByRole('button', { name: 'Reload current membership' });
    expect(f.onFresh).not.toHaveBeenCalled(); expect(f.api.commit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reload current membership' })); await waitFor(() => expect(f.onFresh).toHaveBeenCalled()); expect(f.api.commit).toHaveBeenCalledTimes(1);
  });
  it('retains the original uncertain intent when a later retry is refused', async () => {
    const f = fixture(); f.api.commit.mockRejectedValueOnce(new VerifiedSourceError('c4_commit_outcome_unknown', true, ID.request))
      .mockRejectedValueOnce(new VerifiedSourceError('c4_review_conflict', false, ID.request));
    render(view(f)); await choose(f); fireEvent.click(screen.getByRole('button', { name: 'Confirm annual membership' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check operation receipt' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry the same operation' }));
    await waitFor(() => expect(f.api.commit).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Close source review' })).toBeDisabled(); expect(f.api.newRequestId).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Check operation receipt' })).toBeEnabled(); expect(screen.queryByRole('button', { name: 'Retry the same operation' })).toBeNull();
  });
  it('keeps a failed receipt unresolved and never substitutes a write', async () => {
    const f = fixture(); f.api.commit.mockRejectedValueOnce(new VerifiedSourceError('c4_commit_outcome_unknown', true, ID.request));
    f.api.receipt.mockRejectedValueOnce(new Error('denied')); render(view(f)); await choose(f);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm annual membership' })); fireEvent.click(await screen.findByRole('button', { name: 'Check operation receipt' }));
    await waitFor(() => expect(f.api.receipt).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Close source review' })).toBeDisabled(); expect(f.api.commit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Retry the same operation' })).toBeNull();
  });
  it('recovers a committed receipt through a current read without another write', async () => {
    const f = fixture(); f.api.commit.mockRejectedValueOnce(new VerifiedSourceError('c4_commit_outcome_unknown', true, ID.request));
    f.api.receipt.mockResolvedValueOnce({ status: 'committed', requestId: ID.request, result: { ...f.verified, idempotentReplay: true, selectable: false, selectionBlockers: ['receipt_replay_requires_refresh'] } });
    render(view(f)); await choose(f); fireEvent.click(screen.getByRole('button', { name: 'Confirm annual membership' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check operation receipt' })); await waitFor(() => expect(f.onFresh).toHaveBeenCalled()); expect(f.api.commit).toHaveBeenCalledTimes(1);
  });
});
