/** @vitest-environment jsdom */
/**
 * R1-A2/A4 — the registration panel against the REAL component; only the service boundary is injected.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
const { MaterialRegistrationPanel } = await import('../MaterialRegistrationPanel');
const { CentralNeedsError } = await import('../../central-needs.service');
import type { MaterialCandidate, MaterialCapabilities, MaterialRequest, MaterialRequestStatus } from '../material-registration.service';

const ME = 'user-me'; const OTHER = 'user-other';
const req = (o: Partial<MaterialRequest> & { id: string }): MaterialRequest => ({
  organizationId: 'org-1', requesterId: ME, status: 'draft', version: 1, scientificName: 'Zolpidem', nameAr: null, tradeName: null, strength: '10 mg',
  dosageForm: 'Tablet', unit: 'box', barcode: null, note: null, provenanceKind: 'manual_typed', reviewerId: null, resolvedItemId: null, decisionReason: null, createdAt: 't', ...o,
});
const cand = (o: Partial<MaterialCandidate> & { centralItemId: string }): MaterialCandidate => ({ grade: 'advisory', score: 0.6, name: 'Zolpidem Tartrate', nameAr: null, concentration: '5 mg', dosageForm: 'Tablet', unit: 'box', barcode: null, status: 'active', ...o });

function make(list: MaterialRequest[], caps: Partial<MaterialCapabilities> = {}, candidates: MaterialCandidate[] = []) {
  let current = list;
  const ok = (status: MaterialRequestStatus) => async () => ({ requestId: 'r', status, version: 2, idempotentReplay: false });
  const api = {
    getMaterialCapabilities: vi.fn(async () => ({ canRequest: true, canReview: false, canLink: true, ...caps })),
    listMaterialRequests: vi.fn(async () => current),
    listMaterialRequestEvents: vi.fn(async () => [{ id: 'e1', seq: 1, eventKind: 'draft_created', actorId: ME, statusAfter: 'draft' as const, note: null, createdAt: 't' }]),
    listMaterialRequestCandidates: vi.fn(async () => candidates),
    createMaterialRequestDraft: vi.fn(ok('draft')),
    updateMaterialRequestDraft: vi.fn(ok('draft')),
    submitMaterialRequest: vi.fn(ok('submitted')),
    startMaterialReview: vi.fn(ok('under_review')),
    requestMaterialInfo: vi.fn(ok('needs_info')),
    resolveMaterialExisting: vi.fn(ok('resolved_existing')),
    approveNewMaterial: vi.fn(ok('approved_new')),
    rejectMaterialRequest: vi.fn(ok('rejected')),
    cancelMaterialRequest: vi.fn(ok('cancelled')),
    linkMaterialRequestToDraft: vi.fn(async () => ({ linkId: 'l', centralItemId: 'i', idempotentReplay: false })),
    newMaterialIdempotencyKey: vi.fn(() => `key-${Math.random().toString(36).slice(2)}-xxxxxxxx`),
  };
  return { api, setList: (l: MaterialRequest[]) => { current = l; } };
}
const mount = (api: ReturnType<typeof make>['api'], o: Partial<React.ComponentProps<typeof MaterialRegistrationPanel>> = {}) =>
  render(<MaterialRegistrationPanel lang="en" organizationId="org-1" actorId={ME} planRevisionId="rev-1" prefill={null} onUseItem={() => undefined} api={api} {...o} />);
afterEach(() => cleanup());

describe('requester', () => {
  it('cannot save without a scientific name AND an explicit unit (no silent default unit)', async () => {
    const { api } = make([]);
    mount(api);
    const save = await screen.findByRole('button', { name: 'Save request as draft' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Scientific name'), { target: { value: 'Zolpidem' } });
    expect(save).toBeDisabled();
    expect(screen.getByLabelText('Unit')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'box' } });
    expect(save).not.toBeDisabled();
  });

  it('creates a draft with the typed descriptor, manual provenance and the revision context; list is re-read', async () => {
    const { api, setList } = make([]);
    mount(api);
    fireEvent.change(await screen.findByLabelText('Scientific name'), { target: { value: ' Zolpidem ' } });
    fireEvent.change(screen.getByLabelText('Strength'), { target: { value: '10 mg' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'box' } });
    setList([req({ id: 'r1' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Save request as draft' }));
    await screen.findByRole('button', { name: /Zolpidem — draft/ });
    const args = api.createMaterialRequestDraft.mock.calls[0] as unknown[];
    expect(args[0]).toBe('org-1');
    expect(args[1]).toMatchObject({ scientificName: 'Zolpidem', strength: '10 mg', unit: 'box', tradeName: null });
    expect(args[3]).toEqual({ kind: 'manual_typed' });
    expect(args[4]).toBe('rev-1');
    expect(api.listMaterialRequests).toHaveBeenCalledTimes(2);
  });

  it('a transport failure keeps the SAME idempotency key for the retry; a definitive refusal ends the intent', async () => {
    const { api } = make([]);
    api.createMaterialRequestDraft.mockRejectedValueOnce(new TypeError('net'));
    mount(api);
    fireEvent.change(await screen.findByLabelText('Scientific name'), { target: { value: 'Zolpidem' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'box' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save request as draft' }));
    await screen.findByText(/connection failed/);
    expect(screen.getByLabelText('Scientific name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save request as draft' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile the same operation' }));
    await waitFor(() => expect(api.createMaterialRequestDraft).toHaveBeenCalledTimes(2));
    const calls = api.createMaterialRequestDraft.mock.calls as unknown as unknown[][];
    expect(calls[0][2]).toBe(calls[1][2]);
    expect(api.newMaterialIdempotencyKey).toHaveBeenCalledTimes(1);
  });

  it('freezes the original annual descriptor and key after a normalized transport error, and locks the parent scope', async () => {
    const { api } = make([]); const locked = vi.fn();
    api.createMaterialRequestDraft.mockRejectedValueOnce(new CentralNeedsError('central_needs_request_failed', 'Failed to fetch', { sqlstate: null }));
    const props = { lang: 'en' as const, organizationId: 'org-1', actorId: ME, planRevisionId: null,
      scopeKey: 'org-1:2026', api, onUseItem: vi.fn(), onScopeLockChange: locked };
    const view = render(<MaterialRegistrationPanel {...props} prefill={null} />);
    fireEvent.change(await screen.findByLabelText('Scientific name'), { target: { value: 'Original material' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'box' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save request as draft' }));
    await screen.findByRole('button', { name: 'Reconcile the same operation' });
    expect(locked).toHaveBeenLastCalledWith(true);
    view.rerender(<MaterialRegistrationPanel {...props} prefill={{ descriptor: { scientificName: 'Different material', unit: 'vial' }, pointer: null }} />);
    expect(screen.getByLabelText('Scientific name')).toHaveValue('Original material');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile the same operation' }));
    await waitFor(() => expect(locked).toHaveBeenLastCalledWith(false));
    const calls = api.createMaterialRequestDraft.mock.calls as unknown as unknown[][];
    expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
    expect(calls[1][1]).toMatchObject({ scientificName: 'Original material', unit: 'box' });
    expect(api.newMaterialIdempotencyKey).toHaveBeenCalledTimes(1);
  });

  it('an acknowledged write with a failed follow-up read retries only the read', async () => {
    const { api } = make([]); const locked = vi.fn();
    api.listMaterialRequests.mockResolvedValueOnce([]).mockRejectedValueOnce(new TypeError('read unavailable')).mockResolvedValueOnce([req({ id: 'saved-request' })]);
    mount(api, { onScopeLockChange: locked });
    fireEvent.change(await screen.findByLabelText('Scientific name'), { target: { value: 'Zolpidem' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'box' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save request as draft' }));
    await screen.findByText(/server confirmed the write/i);
    expect(locked).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('button', { name: 'Save request as draft' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Reconcile the same operation' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload requests' }));
    await screen.findByRole('button', { name: /Zolpidem — draft/ });
    expect(api.createMaterialRequestDraft).toHaveBeenCalledTimes(1);
    expect(api.listMaterialRequests).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText('Scientific name')).toHaveValue('');
    expect(locked).toHaveBeenLastCalledWith(false);
  });

  it('a definitive refusal permits a new corrected intent with a new key', async () => {
    const { api } = make([]);
    api.createMaterialRequestDraft.mockRejectedValueOnce(new CentralNeedsError('material_request_descriptor_invalid', undefined, { sqlstate: '23514' }));
    mount(api);
    fireEvent.change(await screen.findByLabelText('Scientific name'), { target: { value: 'Wrong' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'box' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save request as draft' }));
    await screen.findByText('material_request_descriptor_invalid');
    await waitFor(() => expect(screen.getByLabelText('Scientific name')).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('Scientific name'), { target: { value: 'Corrected' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save request as draft' }));
    await waitFor(() => expect(api.createMaterialRequestDraft).toHaveBeenCalledTimes(2));
    const calls = api.createMaterialRequestDraft.mock.calls as unknown as unknown[][];
    expect(calls[0][2]).not.toBe(calls[1][2]);
    expect(calls[1][1]).toMatchObject({ scientificName: 'Corrected' });
  });

  it('submit / withdraw act on the version the person saw; the requester cannot start a review of their own request', async () => {
    const { api } = make([req({ id: 'r1', status: 'draft', version: 3 })], { canReview: true });
    mount(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Submit request' }));
    await waitFor(() => expect(api.submitMaterialRequest).toHaveBeenCalledWith('r1', 3));
    cleanup();
    const mine = make([req({ id: 'r2', status: 'submitted', version: 2 })], { canReview: true });
    mount(mine.api);
    await screen.findByRole('button', { name: /Zolpidem — submitted/ });
    expect(screen.queryByRole('button', { name: 'Start review' })).toBeNull();
    expect(screen.getByText(/cannot review your own request/)).toBeInTheDocument();
  });

  it('a stale refusal refreshes the list, keeps what was typed and says so', async () => {
    const { api } = make([req({ id: 'r1', status: 'draft', version: 1 })]);
    api.submitMaterialRequest.mockRejectedValueOnce(new CentralNeedsError('material_request_stale'));
    mount(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Submit request' }));
    expect((await screen.findAllByText(/changed on the server/i)).length).toBeGreaterThanOrEqual(1);
    expect(api.listMaterialRequests.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('independent reviewer (M3)', () => {
  it('starts a review of SOMEONE ELSE\'s submitted request only', async () => {
    const { api } = make([req({ id: 'r1', requesterId: OTHER, status: 'submitted', version: 4 })], { canReview: true, canRequest: false });
    mount(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Start review' }));
    await waitFor(() => expect(api.startMaterialReview).toHaveBeenCalledWith('r1', 4));
  });

  it('a user without the reviewer capability gets no review controls at all', async () => {
    const { api } = make([req({ id: 'r1', requesterId: OTHER, status: 'submitted' })], { canReview: false });
    mount(api);
    await screen.findByRole('button', { name: /Zolpidem — submitted/ });
    expect(screen.queryByRole('button', { name: 'Start review' })).toBeNull();
  });

  const reviewing = (candidates: MaterialCandidate[]) => make([req({ id: 'r1', requesterId: OTHER, status: 'under_review', version: 5, reviewerId: ME })], { canReview: true, canRequest: false }, candidates);

  it('a STRONG match blocks "approve as new" and offers only the matching item to resolve to', async () => {
    const { api } = reviewing([cand({ centralItemId: 'strong-1', grade: 'strong', score: 1, name: 'Zolpidem', concentration: '10 mg' }), cand({ centralItemId: 'adv-1' })]);
    mount(api);
    fireEvent.click(await screen.findByRole('button', { name: /Zolpidem — under review/ }));
    const approve = await screen.findByRole('button', { name: 'Approve as new' });
    expect(approve).toBeDisabled();
    expect(screen.getByText(/resolve to it instead/)).toBeInTheDocument();
    const resolves = screen.getAllByRole('button', { name: 'Resolve to existing' });
    expect(resolves[0]).not.toBeDisabled();             // the strong one
    expect(resolves[1]).toBeDisabled();                 // the advisory one cannot be chosen while a strong match exists
    fireEvent.click(resolves[0]);
    await waitFor(() => expect(api.resolveMaterialExisting).toHaveBeenCalled());
    expect((api.resolveMaterialExisting.mock.calls[0] as unknown[]).slice(0, 3)).toEqual(['r1', 5, 'strong-1']);
  });

  it('ADVISORY matches need an explicit human confirmation of EACH before approval; the confirmed ids are sent', async () => {
    const { api } = reviewing([cand({ centralItemId: 'adv-1' }), cand({ centralItemId: 'adv-2', name: 'Zolpidem Hemitartrate' })]);
    mount(api);
    fireEvent.click(await screen.findByRole('button', { name: /Zolpidem — under review/ }));
    const approve = await screen.findByRole('button', { name: 'Approve as new' });
    expect(approve).toBeDisabled();
    expect(screen.getByText(/Every similar item must be confirmed/)).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]);
    expect(approve).toBeDisabled();
    fireEvent.click(boxes[1]);
    expect(approve).not.toBeDisabled();
    fireEvent.click(approve);
    await waitFor(() => expect(api.approveNewMaterial).toHaveBeenCalledTimes(1));
    const args = api.approveNewMaterial.mock.calls[0] as unknown[];
    expect(args[0]).toBe('r1'); expect(args[1]).toBe(5);
    expect([...(args[2] as string[])].sort()).toEqual(['adv-1', 'adv-2']);
  });

  it('reject and ask-for-information require a note', async () => {
    const { api } = reviewing([]);
    mount(api);
    fireEvent.click(await screen.findByRole('button', { name: /Zolpidem — under review/ }));
    const reject = await screen.findByRole('button', { name: 'Reject' });
    const ask = screen.getByRole('button', { name: 'Ask for information' });
    expect(reject).toBeDisabled(); expect(ask).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Decision note'), { target: { value: 'not in formulary' } });
    fireEvent.click(reject);
    await waitFor(() => expect(api.rejectMaterialRequest).toHaveBeenCalledWith('r1', 5, 'not in formulary'));
  });

  it('another reviewer\'s request under review shows no decision controls', async () => {
    const { api } = make([req({ id: 'r1', requesterId: OTHER, status: 'under_review', version: 5, reviewerId: 'someone-else' })], { canReview: true }, []);
    mount(api);
    fireEvent.click(await screen.findByRole('button', { name: /Zolpidem — under review/ }));
    await screen.findByText('History');
    expect(screen.queryByRole('button', { name: 'Approve as new' })).toBeNull();
    expect(api.listMaterialRequestCandidates).not.toHaveBeenCalled();
  });
});

describe('candidate completeness (Director correction 2)', () => {
  const manyAdvisory = (n: number) => Array.from({ length: n }, (_, i) => cand({ centralItemId: `adv-${i}`, name: `Similar ${i}` }));
  const reviewing = (c: MaterialCandidate[]) => make([req({ id: 'r1', requesterId: OTHER, status: 'under_review', version: 5, reviewerId: ME })], { canReview: true, canRequest: false }, c);

  it('more than ten similar items: EVERY one is listed with its own confirmation, and approval needs all of them', async () => {
    const { api } = reviewing(manyAdvisory(12));
    mount(api);
    fireEvent.click(await screen.findByRole('button', { name: /Zolpidem — under review/ }));
    const approve = await screen.findByRole('button', { name: 'Approve as new' });
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(12);
    expect(screen.getAllByText(/Advisory similarity/)).toHaveLength(12);
    boxes.slice(0, 11).forEach((b) => fireEvent.click(b));
    expect(approve).toBeDisabled();                                  // 11 of 12 is not a review
    fireEvent.click(boxes[11]);
    expect(approve).not.toBeDisabled();
    fireEvent.click(approve);
    await waitFor(() => expect(api.approveNewMaterial).toHaveBeenCalledTimes(1));
    expect(((api.approveNewMaterial.mock.calls as unknown as unknown[][])[0][2] as string[]).length).toBe(12);
  });

  it('above the safe review limit (50) approval is blocked in the UI too, with the reason; resolve / reject stay available', async () => {
    const { api } = reviewing(manyAdvisory(51));
    mount(api);
    fireEvent.click(await screen.findByRole('button', { name: /Zolpidem — under review/ }));
    const approve = await screen.findByRole('button', { name: 'Approve as new' });
    screen.getAllByRole('checkbox').forEach((b) => fireEvent.click(b));
    expect(approve).toBeDisabled();
    expect(screen.getByText(/exceeds the provisional safe-review limit \(50 — provisional, owner decision pending\)/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Decision note'), { target: { value: 'ambiguous' } });
    expect(screen.getByRole('button', { name: 'Reject' })).not.toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Resolve to existing' }).length).toBeGreaterThan(0);
  });
});

describe('resolution, linkage, scope', () => {
  const resolved = req({ id: 'r1', status: 'approved_new', version: 7, resolvedItemId: 'item-9', reviewerId: OTHER });

  it('a resolved request offers "use in needs" (client-side selection only) and the EXPLICIT link to the current draft', async () => {
    const onUse = vi.fn();
    const { api } = make([resolved]);
    mount(api, { onUseItem: onUse });
    fireEvent.click(await screen.findByRole('button', { name: 'Use in the needs' }));
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-9', name: 'Zolpidem', unit: 'box' }));
    expect(api.linkMaterialRequestToDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Link to the current draft' }));
    await waitFor(() => expect(api.linkMaterialRequestToDraft).toHaveBeenCalledWith('r1', 'rev-1'));
  });

  it('no link control without a draft revision or without the link capability', async () => {
    const a = make([resolved]);
    mount(a.api, { planRevisionId: null });
    await screen.findByRole('button', { name: 'Use in the needs' });
    expect(screen.queryByRole('button', { name: 'Link to the current draft' })).toBeNull();
    cleanup();
    const b = make([resolved], { canLink: false });
    mount(b.api);
    await screen.findByRole('button', { name: 'Use in the needs' });
    expect(screen.queryByRole('button', { name: 'Link to the current draft' })).toBeNull();
  });

  it('a workbook-suggested descriptor prefills the form, marks its source and sends the identity-only pointer', async () => {
    const { api } = make([]);
    const prefill = { descriptor: { scientificName: 'Zolpidem', strength: '10 mg', dosageForm: 'Tablet', unit: undefined }, pointer: { sheet_index: 0, row: 4, column: 1, file_hash: 'a'.repeat(64) } };
    mount(api, { prefill });
    expect(await screen.findByText('Suggested from the workbook (identity only)')).toBeInTheDocument();
    expect(screen.getByLabelText('Scientific name')).toHaveValue('Zolpidem');
    expect(screen.getByLabelText('Unit')).toHaveValue('');                     // an unmapped workbook unit is never guessed
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'tablet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save request as draft' }));
    await waitFor(() => expect(api.createMaterialRequestDraft).toHaveBeenCalled());
    expect((api.createMaterialRequestDraft.mock.calls[0] as unknown[])[3]).toEqual({ kind: 'excel_assist', pointer: prefill.pointer });
  });

  it('a requester without the request capability sees no form; switching organization discards a late answer and resets', async () => {
    const a = make([], { canRequest: false });
    mount(a.api);
    await screen.findByText('No requests.');
    expect(screen.queryByLabelText('Scientific name')).toBeNull();
    cleanup();
    let release!: (v: MaterialRequest[]) => void;
    const slow = make([]);
    slow.api.listMaterialRequests.mockImplementationOnce(() => new Promise<MaterialRequest[]>((r) => { release = r; }));
    const { rerender } = mount(slow.api);
    rerender(<MaterialRegistrationPanel lang="en" organizationId="org-2" actorId={ME} planRevisionId={null} prefill={null} onUseItem={() => undefined} api={slow.api} />);
    release([req({ id: 'stale', scientificName: 'Stale Drug' })]);
    await screen.findByText('No requests.');
    expect(screen.queryByText(/Stale Drug/)).toBeNull();
  });

  it('Arabic renders RTL-safe: descriptor inputs stay LTR, labels are Arabic', async () => {
    const { api } = make([]);
    mount(api, { lang: 'ar' });
    const sci = await screen.findByLabelText('الاسم العلمي');
    expect(sci).toHaveAttribute('dir', 'ltr');
    expect(screen.getByLabelText('الوحدة')).toBeInTheDocument();
  });

  it.each([{ actorId: OTHER, scopeKey: '2026' }, { actorId: ME, scopeKey: '2027' }])(
    'discards a late request list when the actor or annual context changes', async (next) => {
      const { api } = make([]);
      let release!: (value: MaterialRequest[]) => void;
      api.listMaterialRequests.mockImplementationOnce(() => new Promise<MaterialRequest[]>((resolve) => { release = resolve; }));
      const view = mount(api, { scopeKey: '2026' });
      view.rerender(<MaterialRegistrationPanel lang="en" organizationId="org-1" actorId={next.actorId} scopeKey={next.scopeKey}
        planRevisionId="rev-1" prefill={null} onUseItem={() => undefined} api={api} />);
      release([req({ id: 'old-context', scientificName: 'Previous context material' })]);
      await screen.findByText('No requests.');
      expect(screen.queryByText(/Previous context material/)).toBeNull();
      expect(api.getMaterialCapabilities).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps details of the currently expanded request when an earlier details response arrives late', async () => {
    const first = req({ id: 'first', requesterId: OTHER, scientificName: 'First material', status: 'under_review', reviewerId: ME });
    const second = req({ id: 'second', requesterId: OTHER, scientificName: 'Second material', status: 'under_review', reviewerId: ME });
    const { api } = make([first, second], { canReview: true, canRequest: false });
    let release!: (value: MaterialCandidate[]) => void;
    api.listMaterialRequestCandidates.mockImplementationOnce(() => new Promise<MaterialCandidate[]>((resolve) => { release = resolve; }))
      .mockResolvedValueOnce([cand({ centralItemId: 'correct', name: 'Current candidate' })]);
    mount(api);
    fireEvent.click(await screen.findByRole('button', { name: /First material — under review/ }));
    fireEvent.click(screen.getByRole('button', { name: /Second material — under review/ }));
    await screen.findByText(/Current candidate/);
    release([cand({ centralItemId: 'wrong', name: 'Previous candidate' })]);
    await waitFor(() => expect(screen.queryByText(/Previous candidate/)).toBeNull());
    expect(screen.getByText(/Current candidate/)).toBeInTheDocument();
  });
});
