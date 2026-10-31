/** @vitest-environment jsdom */
/**
 * R1-A4 — the whole journey (year -> beneficiary -> material -> quantity -> review -> submit -> independent decision -> history) against the
 * REAL journey, workspace, picker and registration components. Only the service boundaries are injected; supabase itself is a tripwire.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const supabaseRpc = vi.fn(); const supabaseFrom = vi.fn();
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => supabaseRpc(...a), from: (...a: unknown[]) => supabaseFrom(...a) } }));
vi.mock('../../CentralNeedsRevisionHistory', () => ({ CentralNeedsRevisionHistory: (p: { planYear: number; organizationId: string }) => <div data-testid="history" data-year={p.planYear} data-org={p.organizationId} /> }));
const { ManualNeedsJourney } = await import('../ManualNeedsJourney');
const { CentralNeedsError, centralNeedsErrorFromPostgrest } = await import('../../central-needs.service');
import type { JourneyApi, YearRevision } from '../manual-journey.service';
import type { ManualCapabilities } from '../manual-needs.service';

const caps = (o: Partial<ManualCapabilities> = {}): ManualCapabilities => ({ view: true, edit: true, approve: false, manualSet: true, excelImportOpen: true, approveExcludedForRevision: false, ...o });
const rev = (o: Partial<YearRevision> & { id: string }): YearRevision => ({ revisionNumber: 1, status: 'draft', sourceMode: 'manual', createdBy: 'u-maker', ...o });

function make(initial: YearRevision[], c: ManualCapabilities = caps()) {
  const state = { revisions: initial, caps: c };
  const api: JourneyApi = {
    listYearRevisions: vi.fn(async () => state.revisions),
    listBeneficiaries: vi.fn(async () => [{ id: 'b1', name: 'Hospital A', nameAr: 'مستشفى أ' }, { id: 'b2', name: 'Hospital B', nameAr: 'مستشفى ب' }]),
    searchCatalog: vi.fn(async (q: string) => (q.toLowerCase().includes('zol') ? [{ id: 'i-zol', name: 'Zolpidem', nameAr: 'زولبيديم', concentration: '10 mg', dosageForm: 'Tablet', unit: 'box' }] : [])),
    resolveForIdentity: vi.fn(async () => []),
    getCaps: vi.fn(async () => state.caps),
    openPlan: vi.fn(async () => { state.revisions = [rev({ id: 'r-new', revisionNumber: 1 })]; return { planRevisionId: 'r-new' }; }),
    openCorrection: vi.fn(async () => { state.revisions = [rev({ id: 'r-corr', revisionNumber: 2 }), ...state.revisions]; return { planRevisionId: 'r-corr' }; }),
    readiness: vi.fn(async () => ({ planRevisionId: 'r1', status: 'draft' as const, ready: true, blockers: [] })),
    submit: vi.fn(async () => { state.revisions = [{ ...state.revisions[0], status: 'submitted' }, ...state.revisions.slice(1)]; }),
    approve: vi.fn(async () => { state.revisions = [{ ...state.revisions[0], status: 'approved' }, ...state.revisions.slice(1)]; }),
    reject: vi.fn(async () => { state.revisions = [{ ...state.revisions[0], status: 'rejected' }, ...state.revisions.slice(1)]; }),
  };
  const workspaceApi = {
    getManualCapabilities: vi.fn(async () => state.caps),
    listManualNeedEvents: vi.fn(async () => []),
    addManualNeedLine: vi.fn(async () => ({ idempotentReplay: false, eventId: 'e', eventSeq: 1 })),
    correctManualNeedLine: vi.fn(async () => ({ idempotentReplay: false, eventId: 'e', eventSeq: 2 })),
    voidManualNeedLine: vi.fn(async () => ({ idempotentReplay: false, eventId: 'e', eventSeq: 2 })),
    newManualIdempotencyKey: vi.fn(() => 'key-12345678'),
  };
  const registrationApi = {
    getMaterialCapabilities: vi.fn(async () => ({ canRequest: true, canReview: false, canLink: true })),
    listMaterialRequests: vi.fn(async () => []),
    listMaterialRequestEvents: vi.fn(async () => []), listMaterialRequestCandidates: vi.fn(async () => []),
    createMaterialRequestDraft: vi.fn(async () => ({ requestId: 'm1', status: 'draft' as const, version: 1, idempotentReplay: false })),
    updateMaterialRequestDraft: vi.fn(), submitMaterialRequest: vi.fn(), startMaterialReview: vi.fn(), requestMaterialInfo: vi.fn(), resolveMaterialExisting: vi.fn(),
    approveNewMaterial: vi.fn(), rejectMaterialRequest: vi.fn(), cancelMaterialRequest: vi.fn(), linkMaterialRequestToDraft: vi.fn(), newMaterialIdempotencyKey: vi.fn(() => 'rk-12345678'),
  };
  const preview = { state: { phase: 'idle' } as never, parse: vi.fn(), reset: vi.fn() };
  return { api, state, workspaceApi, registrationApi, preview };
}
const mount = (m: ReturnType<typeof make>, o: Partial<React.ComponentProps<typeof ManualNeedsJourney>> = {}) =>
  render(<ManualNeedsJourney lang="en" organizationId="org-1" actorId="u-maker" api={m.api} workspaceApi={m.workspaceApi as never} registrationApi={m.registrationApi as never}
    preview={m.preview} initialYear={2027} {...o} />);
const open = async () => { fireEvent.click(await screen.findByRole('button', { name: 'Open year' })); };

beforeEach(() => { supabaseRpc.mockReset(); supabaseFrom.mockReset(); });
afterEach(() => cleanup());

describe('step 1 — year', () => {
  it('nothing about a plan is shown or requested before the year is opened; an invalid year cannot be opened', async () => {
    const m = make([]);
    mount(m);
    const year = await screen.findByLabelText('Plan year');
    expect(m.api.listYearRevisions).not.toHaveBeenCalled();
    expect(screen.queryByTestId('history')).toBeNull();
    fireEvent.change(year, { target: { value: '19' } });
    expect(screen.getByRole('button', { name: 'Open year' })).toBeDisabled();
    fireEvent.change(year, { target: { value: '2027' } });
    expect(screen.getByRole('button', { name: 'Open year' })).not.toBeDisabled();
  });

  it('no plan yet: the maker starts one (server call), then the journey continues on the new draft; history is shown for the year', async () => {
    const m = make([]);
    mount(m);
    await open();
    expect(await screen.findByText('There is no plan for this year yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start a new plan' }));
    await waitFor(() => expect(m.api.openPlan).toHaveBeenCalledWith('org-1', 2027));
    expect(await screen.findByText('Revision 1 — draft')).toBeInTheDocument();
    expect(screen.getByTestId('history')).toHaveAttribute('data-year', '2027');
    expect(screen.getByRole('heading', { name: '2. Institution, material, quantity' })).toBeInTheDocument();
  });

  it('a user without the manual key is offered no way to start a plan', async () => {
    const m = make([], caps({ manualSet: false }));
    mount(m);
    await open();
    await screen.findByText('There is no plan for this year yet.');
    expect(screen.queryByRole('button', { name: 'Start a new plan' })).toBeNull();
  });

  it('a historical EXCEL revision is shown read-only: no picker, no identity assist, no workspace', async () => {
    const m = make([rev({ id: 'x1', sourceMode: 'excel', status: 'approved' })]);
    mount(m);
    await open();
    expect(await screen.findByText(/historical Excel source and is read-only/)).toBeInTheDocument();
    expect(screen.queryByTestId('manual-needs-workspace')).toBeNull();
    expect(screen.queryByTestId('identity-assist-panel')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
  });

  it('a closed revision offers a governed correction only with a reason, fenced on the exact latest revision', async () => {
    const m = make([rev({ id: 'r-ap', status: 'approved' })]);
    mount(m);
    await open();
    const btn = await screen.findByRole('button', { name: 'Open a correction' });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for the correction'), { target: { value: 'annual update' } });
    fireEvent.click(btn);
    await waitFor(() => expect(m.api.openCorrection).toHaveBeenCalledWith('org-1', 2027, 'r-ap', 'annual update'));
    expect(await screen.findByText('Revision 2 — draft')).toBeInTheDocument();
  });
});

describe('steps 2-4 — lines, review, submit', () => {
  const draft = () => make([rev({ id: 'r1', status: 'draft' })]);

  it('shows the picker, the identity assist and the workspace for a manual DRAFT, all org-level (no warehouse anywhere)', async () => {
    const m = draft();
    mount(m);
    await open();
    expect(await screen.findByTestId('manual-needs-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('identity-assist-panel')).toBeInTheDocument();
    expect(screen.getByLabelText('Search a registered material')).toBeInTheDocument();
    expect(screen.queryByText(/warehouse/i)).toBeNull();
  });

  it('a picked registered material becomes selectable in the line form (beneficiaries come from the care-institution list)', async () => {
    const m = draft();
    mount(m);
    await open();
    await screen.findByTestId('manual-needs-workspace');
    fireEvent.change(screen.getByLabelText('Search a registered material'), { target: { value: 'zol' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use' }));
    const form = await screen.findByRole('form', { name: 'Add line' });
    const itemSelect = within(form).getByLabelText('Item') as HTMLSelectElement;
    expect([...itemSelect.options].map((o) => o.textContent)).toContain('Zolpidem');
    const benef = within(form).getByLabelText('Beneficiary institution') as HTMLSelectElement;
    expect([...benef.options].map((o) => o.textContent)).toEqual(expect.arrayContaining(['Hospital A', 'Hospital B']));
    // the workspace adds the line through ITS routine with the exact quantity text
    fireEvent.change(benef, { target: { value: 'b1' } }); fireEvent.change(itemSelect, { target: { value: 'i-zol' } });
    fireEvent.change(within(form).getByLabelText('Annual quantity'), { target: { value: '12.5' } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'planned' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add line' }));
    await waitFor(() => expect(m.workspaceApi.addManualNeedLine).toHaveBeenCalledTimes(1));
    expect((m.workspaceApi.addManualNeedLine.mock.calls[0] as unknown[])[1]).toBe('12.5');
  });

  it('locks other journey targets during an unresolved line write, clears old readiness, and leaves the same retry usable', async () => {
    const m = draft();
    let failWrite!: (error: unknown) => void;
    m.workspaceApi.addManualNeedLine.mockImplementationOnce(() => new Promise((_resolve, reject) => { failWrite = reject; }));
    mount(m);
    await open();
    await screen.findByTestId('manual-needs-workspace');
    fireEvent.change(screen.getByLabelText('Search a registered material'), { target: { value: 'zol' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use' }));
    const form = screen.getByRole('form', { name: 'Add line' });
    fireEvent.change(within(form).getByLabelText('Beneficiary institution'), { target: { value: 'b1' } });
    fireEvent.change(within(form).getByLabelText('Item'), { target: { value: 'i-zol' } });
    fireEvent.change(within(form).getByLabelText('Annual quantity'), { target: { value: '12.5' } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'planned' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check readiness' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Submit for independent review' }));
    expect(screen.getByRole('button', { name: 'Confirm submission' })).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Add line' }));
    expect(screen.getByRole('button', { name: 'Open year' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Zolpidem' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check readiness' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Confirm submission' })).toBeNull();
    failWrite(centralNeedsErrorFromPostgrest({ message: 'TypeError: Failed to fetch', code: '' }));
    await screen.findByText(/The request outcome is not confirmed/);
    expect(within(form).getByRole('button', { name: 'Add line' })).toBeEnabled();
    expect(within(form).getByLabelText('Annual quantity')).toHaveValue('12.5');
    expect(screen.getByRole('button', { name: 'Remove Zolpidem' })).toBeDisabled();
    fireEvent.click(within(form).getByRole('button', { name: 'Add line' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open year' })).toBeEnabled());
    expect(m.workspaceApi.addManualNeedLine).toHaveBeenCalledTimes(2);
    expect(m.workspaceApi.newManualIdempotencyKey).toHaveBeenCalledTimes(1);
    const calls = m.workspaceApi.addManualNeedLine.mock.calls as unknown as unknown[][];
    expect(calls[1]).toEqual(calls[0]);
    expect(screen.queryByRole('button', { name: 'Submit for independent review' })).toBeNull();
    expect(m.api.submit).not.toHaveBeenCalled();
  });

  it('a search that finds nothing offers the registration request; a FAILED search never says "not registered"', async () => {
    const m = draft();
    mount(m);
    await open();
    await screen.findByTestId('manual-needs-workspace');
    fireEvent.change(screen.getByLabelText('Search a registered material'), { target: { value: 'unknown drug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Request registration of a new material' }));
    expect(await screen.findByTestId('material-registration-panel')).toBeInTheDocument();
    cleanup();
    const bad = draft();
    bad.api.searchCatalog = vi.fn(async () => { throw new Error('503'); });
    mount(bad);
    await open();
    await screen.findByTestId('manual-needs-workspace');
    fireEvent.change(screen.getByLabelText('Search a registered material'), { target: { value: 'zolpidem' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('The search failed. That does not mean the material does not exist.')).toBeInTheDocument();
    expect(screen.queryByText(/No registered material matches/)).toBeNull();
  });

  it('review lists the blockers with their meaning; a ready revision can be submitted only after an explicit confirmation (cancel is free)', async () => {
    const m = draft();
    m.api.readiness = vi.fn()
      .mockResolvedValueOnce({ planRevisionId: 'r1', status: 'draft', ready: false, blockers: [{ blocker: 'manual_revision_has_no_lines', detail: null }] })
      .mockResolvedValue({ planRevisionId: 'r1', status: 'draft', ready: true, blockers: [] });
    mount(m);
    await open();
    expect(screen.queryByRole('button', { name: 'Submit for independent review' })).toBeNull();           // not before readiness
    fireEvent.click(await screen.findByRole('button', { name: 'Check readiness' }));
    expect(await screen.findByText('The revision has no lines.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit for independent review' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check readiness' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Submit for independent review' }));
    expect(m.api.submit).not.toHaveBeenCalled();                                                          // a confirmation step first
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(m.api.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for independent review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm submission' }));
    await waitFor(() => expect(m.api.submit).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Revision 1 — submitted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check readiness' })).toBeNull();                          // the draft-only steps are gone
  });
});

describe('step 5 — the independent decision', () => {
  const submitted = (c: ManualCapabilities) => make([rev({ id: 'r1', status: 'submitted' })], c);

  it('the MAKER (approve key but excluded for this revision) is told so and gets no approve / reject controls', async () => {
    const m = submitted(caps({ approve: true, approveExcludedForRevision: true }));
    mount(m);
    await open();
    expect(await screen.findByText('Your account cannot decide on this revision.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('a user without the approve key sees an explanation and no controls', async () => {
    const m = submitted(caps({ approve: false }));
    mount(m);
    await open();
    expect(await screen.findByText('You do not have the right to decide on this revision.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('an INDEPENDENT approver approves (server call, then re-read to the server state)', async () => {
    const m = submitted(caps({ approve: true, approveExcludedForRevision: false }));
    mount(m, { actorId: 'u-checker' });
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(m.api.approve).toHaveBeenCalledWith('r1'));
    expect(await screen.findByText('Revision 1 — approved')).toBeInTheDocument();
  });

  it('rejection needs a reason', async () => {
    const m = submitted(caps({ approve: true }));
    mount(m);
    await open();
    const reject = await screen.findByRole('button', { name: 'Reject' });
    expect(reject).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for rejection'), { target: { value: 'quantities look wrong' } });
    fireEvent.click(reject);
    await waitFor(() => expect(m.api.reject).toHaveBeenCalledWith('r1', 'quantities look wrong'));
  });

  it('a server separation-of-duties refusal is shown by its own message and nothing changes locally', async () => {
    const m = submitted(caps({ approve: true }));
    m.api.approve = vi.fn(async () => { throw new CentralNeedsError('central_needs_separation_of_duties_violation'); });
    mount(m);
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('You cannot decide on what you entered or submitted yourself.')).toBeInTheDocument();
    expect(screen.getByText('Revision 1 — submitted')).toBeInTheDocument();
  });

  it('a stale revision refusal refreshes the screen and says so', async () => {
    const m = submitted(caps({ approve: true }));
    m.api.approve = vi.fn(async () => { throw new CentralNeedsError('central_needs_revision_stale'); });
    mount(m);
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect((await screen.findAllByText(/state changed on the server/i)).length).toBeGreaterThan(0);
    expect((m.api.listYearRevisions as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('scope, language, network', () => {
  it('switching organization discards a still-in-flight answer and forgets the opened year', async () => {
    let release!: (v: YearRevision[]) => void;
    const m = make([rev({ id: 'r1' })]);
    m.api.listYearRevisions = vi.fn(() => new Promise<YearRevision[]>((r) => { release = r; }));
    const { rerender } = mount(m);
    await open();
    rerender(<ManualNeedsJourney lang="en" organizationId="org-2" actorId="u-maker" api={m.api} workspaceApi={m.workspaceApi as never} registrationApi={m.registrationApi as never} preview={m.preview} initialYear={2027} />);
    release([rev({ id: 'stale', revisionNumber: 9 })]);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Revision 9/)).toBeNull();
    expect(screen.queryByTestId('history')).toBeNull();
  });

  it('Arabic renders RTL with Arabic headings and copy', async () => {
    const m = make([rev({ id: 'r1' })]);
    mount(m, { lang: 'ar' });
    fireEvent.click(await screen.findByRole('button', { name: 'فتح السنة' }));
    const root = await screen.findByTestId('manual-needs-journey');
    expect(root).toHaveAttribute('dir', 'rtl');
    expect(await screen.findByRole('heading', { name: '٢. المؤسسة والمادة والكمية' })).toBeInTheDocument();
    expect(screen.getByTestId('history')).toBeInTheDocument();
  });

  it('the journey itself never touches supabase: every call goes through the injected service boundary', async () => {
    const m = make([rev({ id: 'r1', status: 'submitted' })], caps({ approve: true }));
    mount(m);
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(m.api.approve).toHaveBeenCalled());
    expect(supabaseRpc).not.toHaveBeenCalled();
    expect(supabaseFrom).not.toHaveBeenCalled();
  });
});

describe('separation of duties in the UI - the independent approver is NOT an entrant (and the entrant is not an approver)', () => {
  const approverCaps = caps({ edit: false, manualSet: false, approve: true });
  const entrantCaps = caps({ edit: true, manualSet: true, approve: false });
  const forbiddenEntry = () => {
    expect(screen.queryByRole('button', { name: 'Start a new plan' })).toBeNull();
    expect(screen.queryByLabelText('Search a registered material')).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add line' })).toBeNull();
    expect(screen.queryByText('Optional medicine-identity help from a workbook')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check readiness' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit for independent review' })).toBeNull();
  };
  it('approver on a SUBMITTED plan: can approve/reject; sees no entry control', async () => {
    const m = make([rev({ id: 'r1', status: 'submitted', createdBy: 'u-maker' })], approverCaps);
    mount(m, { actorId: 'u-approver' }); await open();
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    forbiddenEntry();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(m.api.approve).toHaveBeenCalledTimes(1));
  });
  it('approver on a DRAFT plan or with NO plan: read-only - no picker, no workbook assistant, no registration, no add-line, no start', async () => {
    const draft = make([rev({ id: 'r1', status: 'draft' })], approverCaps);
    mount(draft, { actorId: 'u-approver' }); await open();
    await screen.findByText('Revision 1 — draft');
    forbiddenEntry();
    expect(draft.api.openPlan).not.toHaveBeenCalled();
    cleanup();
    const none = make([], approverCaps);
    mount(none, { actorId: 'u-approver' }); await open();
    await screen.findByText('There is no plan for this year yet.');
    forbiddenEntry();
  });
  it('approver on an APPROVED plan: no correction can be opened', async () => {
    const m = make([rev({ id: 'r1', status: 'approved' })], approverCaps);
    mount(m, { actorId: 'u-approver' }); await open();
    await screen.findByText('Revision 1 — approved');
    expect(screen.queryByRole('button', { name: 'Open a correction' })).toBeNull();
  });
  it('entrant (no approve key) on a submitted plan: no Approve / Reject at all', async () => {
    const m = make([rev({ id: 'r1', status: 'submitted' })], entrantCaps);
    mount(m); await open();
    await screen.findByText('Revision 1 — submitted');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });
  it('a holder of BOTH keys who made the revision is still excluded by the server flag (approve_excluded_for_revision) - no decision controls', async () => {
    const m = make([rev({ id: 'r1', status: 'submitted' })], caps({ approve: true, approveExcludedForRevision: true }));
    mount(m); await open();
    await screen.findByText('Revision 1 — submitted');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
