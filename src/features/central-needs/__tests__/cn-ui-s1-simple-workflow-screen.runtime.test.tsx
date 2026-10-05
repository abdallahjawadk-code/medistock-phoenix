/** @vitest-environment jsdom */
/**
 * CN-UI-S1 — SIMPLE COMPLETE WORKFLOW CONVERGENCE, proven against the REAL
 * `CentralNeedsScreen` (Simple, its default) with only the service boundary,
 * the two organization/warehouse reads and `useApp` mocked. The Supabase
 * client itself throws on any direct call: every effect below must travel
 * through the canonical service functions.
 *
 *   S1-01  multiple completed sessions: Simple's context offers the screen's
 *          Work Session selector; switching re-reads that session's rows and
 *          writes nothing.
 *   S1-02  the canonical busy/dirty guard: a material decision in flight
 *          disables the switch; a typed reason or a need-line draft asks
 *          before it is dropped; a refusal keeps the session.
 *   S1-03  the SAME region-aware need-line panel works inside Simple …
 *   S1-04  … failing closed when the region layer is unreadable (no M213
 *          fallback), and
 *   S1-05/06  with no ACTIVE region, writing the M213 beneficiary with the
 *          unchanged CN-UI-R1 payload, once.
 *   S1-08  submit only on the server's ready, through the screen's handler,
 *          then the canonical re-read lands on the submitted outcome.
 *   S1-09  approve / reject only for an approver of a submitted revision;
 *          anyone else reads the waiting sentence.
 *   S1-10  a refused lifecycle action re-reads the registry, never retries.
 *   S1-17  a draft is never discarded silently — and a panel that left the
 *          tree leaves no stale "dirty" behind.
 *   S1-18  `initialMode="advanced"` still opens the six-stage workspace, its
 *          need-lines stage placing the same panel.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type {
  BeneficiaryColumnSummary, FieldOverride, ImportBatch, ImportSession, NeedLine, NeedLineSourceLink,
  PlanRevision, RecordDisposition, ReviewReadiness, RevisionStatus, SourceRecord,
} from '../central-needs.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';

const ORG = 'org-1';
const REV = 'rev-1';
const BENE = '00000000-0000-0000-0000-0000000000b1';
const ITEM = '00000000-0000-0000-0000-0000000000a1';
const ROW_5 = 'sheet:0:row:5';
const ROW_9 = 'sheet:0:row:9';

const appState = {
  lang: 'en' as 'ar' | 'en', dir: 'ltr' as 'rtl' | 'ltr', activeOrgId: ORG as string | null,
  profile: { organization_id: ORG } as { organization_id: string | null } | null,
  myPermissions: new Set<string>(),
};

const svc = {
  listPlanRevisions: vi.fn(),
  listImportSessions: vi.fn(),
  listImportBatches: vi.fn(),
  listOverrides: vi.fn(),
  fetchReviewReadiness: vi.fn(),
  listNeedLineLineage: vi.fn(),
  listBeneficiaryColumns: vi.fn(),
  listBeneficiaryRegions: vi.fn(),
  listSourceRecords: vi.fn(),
  listDispositions: vi.fn(),
  searchCentralItems: vi.fn(),
  setNeedLine: vi.fn(),
  deleteNeedLine: vi.fn(),
  setRecordDisposition: vi.fn(),
  setBeneficiaryColumns: vi.fn(),
  recordFieldOverride: vi.fn(),
  submitRevision: vi.fn(),
  approveRevision: vi.fn(),
  rejectRevision: vi.fn(),
  openPlanRevision: vi.fn(),
  openCorrectionRevision: vi.fn(),
};

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
/** Every direct backend touch the screen's tree attempts (it must travel through the mocked service instead). */
const directBackend: string[] = [];
vi.mock('@/shared/supabase/client', () => ({
  supabase: {
    rpc: (name: string) => { directBackend.push(`rpc:${name}`); throw new Error('no direct RPC may run'); },
    from: (name: string) => { directBackend.push(`from:${name}`); throw new Error('no direct table read may run'); },
  },
}));
vi.mock('@/shared/supabase/services/organizations.service', () => ({ getOrganizations: async () => ORGS }));
vi.mock('@/shared/supabase/services/warehouses.service', () => ({ getWarehouses: async () => [] }));
vi.mock('../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../central-needs.service')>('../central-needs.service');
  const forwarded = Object.fromEntries(Object.entries(svc).map(([name, fn]) => [name, (...a: unknown[]) => fn(...a)]));
  return {
    ...actual,
    ...forwarded,
    searchBatchEntries: vi.fn(async () => []),
    // PRE3 Run 4: the material card's suggestion now needs the exact-candidate check to PROVE its set
    // complete; here the stubbed search rows stand for such a proven set (the proof is tested in
    // pre3-suggestion-uniqueness.runtime.test.tsx and material-resolver-exact-candidates.test.ts).
    findExactCentralItemMatches: async (text: string) => ({ matches: (await svc.searchCentralItems(text, 10)) ?? [], complete: true }),
    searchSourceFiles: vi.fn(async () => []),
  };
});

const { CentralNeedsScreen } = await import('../CentralNeedsScreen');
const { centralNeedsErrorFromPostgrest } = await import('../central-needs.service');

const ORGS = [
  { id: BENE, name: 'Beneficiary Hospital', name_ar: 'مستشفى المنتفع', code: 'b1', status: 'active', organizationKind: 'care_institution' },
] as unknown as OrgRow[];

const session = (id: string, startedAt: string): ImportSession => ({
  id, planRevisionId: REV, sourceFileId: `f-${id}`, status: 'completed', previewDigest: 'd', authoritativeDigest: 'd',
  parserIdentity: null, startedAt, completedAt: startedAt, notes: null,
});
const SESSIONS = [session('s1', '2026-01-01T00:00:00.000Z'), session('s2', '2026-01-02T00:00:00.000Z')];

const envelope = (value: unknown) => ({ value, valueType: typeof value === 'number' ? 'number' : 'string', isFormula: false, formula: null });
const RECORDS: Record<string, SourceRecord[]> = {
  s1: [{
    id: 'rec-5', importSessionId: 's1', recordOrdinal: 1, targetEntity: ROW_5, fieldName: 'qty',
    sourceValues: envelope(12), sourceProvenance: { sheetIndex: 0, coordinate: { row: 5, col: 2, a1: 'C6' } },
  }],
  s2: [{
    id: 'rec-9', importSessionId: 's2', recordOrdinal: 1, targetEntity: ROW_9, fieldName: 'Item',
    sourceValues: envelope('Amoxicillin'), sourceProvenance: { sheetIndex: 0, coordinate: { row: 9, col: 1, a1: 'B10' } },
  }],
};
const MAPPED_ROW_5: RecordDisposition = {
  id: 'd-5', importSessionId: 's1', targetEntity: ROW_5, decision: 'mapped', centralItemId: ITEM,
  decisionReason: null, decidedAt: '2026-01-01T00:00:00.000Z',
};
/** (213) Column 2 of session s1 is confirmed for BENE — the M213 grain, with no ACTIVE region over it. */
const M213_COLUMN: BeneficiaryColumnSummary = {
  importSessionId: 's1', originalFilename: 'need-2026.xlsx', archiveEntryPath: null, sheetIndex: 0, sheetName: null,
  columnIndex: 2, sourceFieldName: null, numericValueCount: 1, zeroValueCount: 0, nonzeroNumericCount: 1,
  mappingId: 'bc-2', decision: 'beneficiary', beneficiaryOrganizationId: BENE, mappingReason: 'confirmed',
  mappedAt: '2026-01-01T00:00:00.000Z', mappedRowNumericCount: 1, reviewRequired: false,
};

// ---- the mocked server's own state ------------------------------------------
let status: RevisionStatus = 'draft';
let ready = false;
/** CN-UI-S1 HC1: when set, the server's readiness lists exactly these blockers (and is not ready). */
let blockersOverride: ReviewReadiness['blockers'] | null = null;
const dispositionsBySession: Record<string, RecordDisposition[]> = { s1: [], s2: [] };

const revision = (): PlanRevision => ({ id: REV, planId: 'plan-1', organizationId: ORG, planYear: 2026, revisionNumber: 1, status });
const readinessNow = (): ReviewReadiness => ({
  planRevisionId: REV, status, ready: blockersOverride === null && ready,
  blockers: blockersOverride ?? (ready ? [] : [{ blocker: 'mapped_target_entity_without_need_line', detail: `session=s1 target_entity=${ROW_5}` }]),
});

beforeEach(() => {
  vi.clearAllMocks();
  appState.lang = 'en';
  appState.dir = 'ltr';
  appState.myPermissions = new Set(['central_needs.view', 'central_needs.import', 'central_needs.edit', 'central_needs.approve']);
  status = 'draft';
  ready = false;
  blockersOverride = null;
  directBackend.length = 0;
  dispositionsBySession.s1 = [MAPPED_ROW_5];
  dispositionsBySession.s2 = [];
  svc.listPlanRevisions.mockImplementation(async () => [revision()]);
  svc.listImportSessions.mockResolvedValue(SESSIONS);
  svc.listImportBatches.mockResolvedValue([] as ImportBatch[]);
  svc.listOverrides.mockResolvedValue([] as FieldOverride[]);
  svc.fetchReviewReadiness.mockImplementation(async () => readinessNow());
  svc.listNeedLineLineage.mockResolvedValue({ needLines: [] as NeedLine[], sources: [] as NeedLineSourceLink[] });
  svc.listBeneficiaryColumns.mockResolvedValue([M213_COLUMN]);
  svc.listBeneficiaryRegions.mockResolvedValue([]);
  svc.listSourceRecords.mockImplementation(async (id: string) => RECORDS[id] ?? []);
  svc.listDispositions.mockImplementation(async (id: string) => (dispositionsBySession[id] ?? []).map((d) => ({ ...d })));
  svc.searchCentralItems.mockResolvedValue([]);
  svc.setNeedLine.mockResolvedValue({ needLineId: 'nl-1', created: true, sourceLinkCount: 1, addedLinkCount: 1, approvedQuantity: '12' });
  svc.submitRevision.mockImplementation(async () => { status = 'submitted'; });
  svc.approveRevision.mockImplementation(async () => { status = 'approved'; });
  svc.rejectRevision.mockImplementation(async () => { status = 'rejected'; });
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ---- helpers -------------------------------------------------------------------
const stepOf = () => screen.getByTestId('cn2b-simple-workspace').getAttribute('data-step');
const picker = () => within(screen.getByTestId('cn2b-simple-context')).getByRole('combobox') as HTMLSelectElement;
const needLines = () => screen.getByTestId('cn2b-simple-need-lines');
const candidateFor = (fieldName: string) =>
  within(needLines()).getByText(new RegExp(`· ${fieldName}$`)).closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement;
const NO_BUSINESS_WRITE = () => {
  for (const w of ['setNeedLine', 'deleteNeedLine', 'setRecordDisposition', 'setBeneficiaryColumns', 'recordFieldOverride',
    'submitRevision', 'approveRevision', 'rejectRevision', 'openPlanRevision', 'openCorrectionRevision'] as const) {
    expect(svc[w], w).not.toHaveBeenCalled();
  }
};

async function openSimpleAt(step: string) {
  const view = render(<CentralNeedsScreen />);
  await waitFor(() => expect(stepOf()).toBe(step));
  return view;
}

// ==============================================================================
describe('CN-UI-S1 · the need lines are built in Simple, in the SAME canonical panel', () => {
  it('S1-03/05/06 — with no ACTIVE region the M213 beneficiary is written with the unchanged CN-UI-R1 payload, once, then re-read', async () => {
    await openSimpleAt('need-lines');
    expect(within(screen.getByTestId('cn2b-simple-pending')).getByTestId('cn2b-simple-readiness-messages')).toBeInTheDocument();
    // The chip names the M213 beneficiary once the panel's organization read answers.
    await waitFor(() => expect(within(candidateFor('qty')).getByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('Beneficiary Hospital'));
    const lineageReads = svc.listNeedLineLineage.mock.calls.length;

    fireEvent.click(within(candidateFor('qty')).getByRole('checkbox'));
    fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'reviewed request' } });
    fireEvent.change(within(needLines()).getByTestId('cn2b-nl-unit-select'), { target: { value: 'box' } });
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_save.en }));
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));

    await waitFor(() => expect(svc.setNeedLine).toHaveBeenCalledTimes(1));
    expect(svc.setNeedLine).toHaveBeenCalledWith({
      planRevisionId: REV,
      beneficiaryOrganizationId: BENE,
      centralItemId: ITEM,
      approvedQuantity: '12',
      mappingReason: 'reviewed request',
      quantitySources: [{ sourceRecordId: 'rec-5', designatedQuantity: '12', appliedOverrideId: null }],
      expectedSourceRecordIds: [],
      approvedUnit: 'box',
      unitConversionState: 'canonical',
      targetWarehouseId: null,
      sourceUnitText: null,
    });
    // The panel's own onChanged — the screen's canonical revision re-read.
    await waitFor(() => expect(svc.listNeedLineLineage.mock.calls.length).toBeGreaterThan(lineageReads));
    expect(svc.listNeedLineLineage).toHaveBeenLastCalledWith(REV);
  });

  it('S1-04 — an unreadable region layer fails closed inside Simple: no M213 fallback, nothing reaches setNeedLine', async () => {
    svc.listBeneficiaryRegions.mockRejectedValue(new Error('regions read failed'));
    await openSimpleAt('need-lines');
    const banner = await within(needLines()).findByTestId('cn2b-nl-regions-unavailable');
    expect(banner).toHaveAttribute('data-code', 'beneficiary_regions_read_inconsistent');
    expect(within(candidateFor('qty')).queryByTestId('cn2b-nl-candidate-beneficiary')).toBeNull();
    for (const box of within(needLines()).queryAllByRole('checkbox')) fireEvent.click(box);
    const save = within(needLines()).queryByRole('button', { name: T.cn2b_nl_save.en });
    if (save) { expect(save).toBeDisabled(); fireEvent.click(save); }
    expect(svc.setNeedLine).not.toHaveBeenCalled();
  });
});

describe('CN-UI-S1 · work sessions in Simple — the screen\'s ONE selector and guard', () => {
  it('S1-01 — both completed sessions are offered; switching re-reads that session\'s rows and writes nothing', async () => {
    await openSimpleAt('need-lines');
    const options = within(picker()).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['s1', 's2']);
    expect(picker().value).toBe('s1');

    fireEvent.change(picker(), { target: { value: 's2' } });
    await waitFor(() => expect(stepOf()).toBe('review-material'));
    expect(svc.listSourceRecords).toHaveBeenLastCalledWith('s2');
    expect(svc.listDispositions).toHaveBeenLastCalledWith('s2');
    expect(screen.getByTestId('cn2b-simple-material-card')).toHaveTextContent('Amoxicillin');
    expect(picker().value).toBe('s2');
    NO_BUSINESS_WRITE();
  });

  it('S1-02/17 — a typed reason asks before it is dropped; declining keeps the session and its draft', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await openSimpleAt('need-lines');
    fireEvent.change(picker(), { target: { value: 's2' } });
    await waitFor(() => expect(stepOf()).toBe('review-material'));
    expect(confirm).not.toHaveBeenCalled(); // nothing was dirty

    const card = screen.getByTestId('cn2b-simple-material-card');
    fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_not_a_material.en }));
    fireEvent.change(within(card).getByLabelText(T.cn2b_beneficiary_column_reason_required.en), { target: { value: 'footer row' } });
    const reads = svc.listSourceRecords.mock.calls.length;

    fireEvent.change(picker(), { target: { value: 's1' } });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(T.cn2b_work_session_change_confirm.en);
    expect(picker().value).toBe('s2');
    expect(within(screen.getByTestId('cn2b-simple-material-card')).getByLabelText(T.cn2b_beneficiary_column_reason_required.en)).toHaveValue('footer row');
    expect(svc.listSourceRecords.mock.calls.length).toBe(reads);
    NO_BUSINESS_WRITE();
  });

  it('S1-02 — a material decision in flight disables the switch until the server answers', async () => {
    let release!: () => void;
    svc.setRecordDisposition.mockImplementation(() => new Promise((resolve) => {
      release = () => { dispositionsBySession.s2 = [{ ...MAPPED_ROW_5, id: 'd-9', importSessionId: 's2', targetEntity: ROW_9, decision: 'not_applicable', centralItemId: null, decisionReason: 'footer row' }]; resolve({ mappingId: 'd-9', idempotentReplay: false }); };
    }));
    await openSimpleAt('need-lines');
    fireEvent.change(picker(), { target: { value: 's2' } });
    await waitFor(() => expect(stepOf()).toBe('review-material'));
    const card = screen.getByTestId('cn2b-simple-material-card');
    fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_not_a_material.en }));
    fireEvent.change(within(card).getByLabelText(T.cn2b_beneficiary_column_reason_required.en), { target: { value: 'footer row' } });
    fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_confirm_not_a_material.en }));

    await waitFor(() => expect(picker()).toBeDisabled());
    expect(svc.setRecordDisposition).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    // The decision is re-read; the queue empties; the card leaves and releases the guard.
    await waitFor(() => expect(stepOf()).toBe('need-lines'));
    expect(picker()).not.toBeDisabled();
  });

  it('S1-17 — a need-line draft asks before a switch drops it, and once dropped leaves no stale "dirty" behind', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openSimpleAt('need-lines');
    await within(candidateFor('qty')).findByTestId('cn2b-nl-candidate-beneficiary');
    fireEvent.click(within(candidateFor('qty')).getByRole('checkbox')); // an unsaved designation

    fireEvent.change(picker(), { target: { value: 's2' } });
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(stepOf()).toBe('review-material'));
    expect(screen.queryByTestId('cn2b-simple-need-lines')).toBeNull();

    // Back again: the panel that held the draft has left the tree; nothing is dirty any more.
    fireEvent.change(picker(), { target: { value: 's1' } });
    await waitFor(() => expect(stepOf()).toBe('need-lines'));
    expect(confirm).toHaveBeenCalledTimes(1);
    NO_BUSINESS_WRITE();
  });
});

describe('CN-UI-S1 · submit, decision and terminal state in Simple — the screen\'s own lifecycle handlers', () => {
  it('S1-08 — no submit while the server blocks; on its ready, ONE submit, then the canonical re-read lands on the submitted outcome', async () => {
    const view = await openSimpleAt('need-lines');
    expect(screen.queryByRole('button', { name: T.cn2b_submit.en })).toBeNull();
    view.unmount();

    ready = true;
    await openSimpleAt('pending');
    const submit = within(screen.getByTestId('cn2b-simple-submit')).getByRole('button', { name: T.cn2b_submit.en });
    expect(submit).toBeEnabled();
    const registryReads = svc.listPlanRevisions.mock.calls.length;
    fireEvent.click(submit);

    await waitFor(() => expect(screen.getByTestId('cn2b-simple-closed-notice')).toHaveAttribute('data-status', 'submitted'));
    expect(svc.submitRevision).toHaveBeenCalledTimes(1);
    expect(svc.submitRevision).toHaveBeenCalledWith(REV);
    expect(svc.listPlanRevisions.mock.calls.length).toBeGreaterThan(registryReads);
    expect(screen.getByTestId('cn2b-simple-notice')).toHaveTextContent(T.cn2b_notice_submitted.en);
    expect(stepOf()).toBe('pending');
    // Submitted: no edit control anywhere — the need lines read-only, no submit.
    expect(screen.queryByRole('button', { name: T.cn2b_submit.en })).toBeNull();
    expect(within(needLines()).getByTestId('cn2b-nl-readonly')).toBeInTheDocument();
    expect(within(needLines()).queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('S1-08 — a ready draft offers no submit to someone without the edit permission, and says who can', async () => {
    ready = true;
    appState.myPermissions = new Set(['central_needs.view', 'central_needs.import', 'central_needs.approve']);
    await openSimpleAt('pending');
    expect(screen.queryByRole('button', { name: T.cn2b_submit.en })).toBeNull();
    expect(screen.getByTestId('cn2b-simple-submit-unavailable')).toHaveTextContent(T.cn2b_simple_submit_needs_edit.en);
  });

  it('S1-10 — a refused submit is shown, re-reads the registry and the revision, and is NEVER retried', async () => {
    ready = true;
    svc.submitRevision.mockRejectedValue(centralNeedsErrorFromPostgrest({ message: 'plan_revision_not_editable', code: '23514' }));
    await openSimpleAt('pending');
    const registryReads = svc.listPlanRevisions.mock.calls.length;
    fireEvent.click(within(screen.getByTestId('cn2b-simple-submit')).getByRole('button', { name: T.cn2b_submit.en }));
    await waitFor(() => expect(screen.getByTestId('cn2b-simple-error')).toBeInTheDocument());
    await waitFor(() => expect(svc.listPlanRevisions.mock.calls.length).toBeGreaterThan(registryReads));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(svc.submitRevision).toHaveBeenCalledTimes(1);
  });

  it('S1-09 — an approver decides a submitted revision here: approve, or reject with a reason', async () => {
    status = 'submitted';
    ready = true;
    await openSimpleAt('pending');
    const decision = screen.getByTestId('cn2b-simple-decision');
    expect(within(decision).queryByRole('button', { name: T.cn2b_submit.en })).toBeNull();
    fireEvent.click(within(decision).getByRole('button', { name: T.cn2b_approve.en }));
    await waitFor(() => expect(screen.getByTestId('cn2b-simple-closed-notice')).toHaveAttribute('data-status', 'approved'));
    expect(svc.approveRevision).toHaveBeenCalledWith(REV);
    // Approved is terminal: no decision any more, a correction instead.
    expect(screen.queryByTestId('cn2b-simple-decision')).toBeNull();
    expect(screen.getByTestId('cn2b-simple-create-correction')).toBeInTheDocument();
    cleanup();

    status = 'submitted';
    vi.spyOn(window, 'prompt').mockReturnValue('quantities need rework');
    await openSimpleAt('pending');
    fireEvent.click(within(screen.getByTestId('cn2b-simple-decision')).getByRole('button', { name: T.cn2b_reject.en }));
    await waitFor(() => expect(screen.getByTestId('cn2b-simple-closed-notice')).toHaveAttribute('data-status', 'rejected'));
    expect(svc.rejectRevision).toHaveBeenCalledWith(REV, 'quantities need rework');
  });

  it('S1-09 — without the approve permission a submitted revision shows the waiting sentence and no decision control', async () => {
    status = 'submitted';
    ready = true;
    appState.myPermissions = new Set(['central_needs.view', 'central_needs.import', 'central_needs.edit']);
    await openSimpleAt('pending');
    expect(screen.getByTestId('cn2b-simple-closed-notice')).toHaveTextContent(T.cn2b_simple_closed_submitted.en);
    expect(screen.queryByRole('button', { name: T.cn2b_approve.en })).toBeNull();
    expect(screen.queryByRole('button', { name: T.cn2b_reject.en })).toBeNull();
    NO_BUSINESS_WRITE();
  });
});

describe('CN-UI-S1 · rows are attributed to the session they belong to', () => {
  it('S1-01 — no step is ever routed from rows that are not yet the active session\'s (not even for one render)', async () => {
    const seen: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) seen.push((r.target as HTMLElement).getAttribute('data-step') ?? '');
    });
    svc.listSourceRecords.mockImplementation(() => new Promise(() => {})); // the session's rows never arrive
    const { container } = render(<CentralNeedsScreen />);
    observer.observe(container, { subtree: true, attributes: true, attributeFilter: ['data-step'] });
    await waitFor(() => expect(svc.listSourceRecords).toHaveBeenCalledWith('s1'));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    observer.disconnect();
    expect(stepOf()).toBe('analyzing');
    expect(seen.filter((s) => s !== 'analyzing' && s !== 'upload')).toEqual([]);
  });

  it('S1-01/02 — a disposition re-read that answers after a switch never lands on the new session\'s rows', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    svc.setRecordDisposition.mockImplementation(async () => {
      dispositionsBySession.s2 = [{ ...MAPPED_ROW_5, id: 'd-9', importSessionId: 's2', targetEntity: ROW_9 }];
      return { mappingId: 'd-9', idempotentReplay: false };
    });
    await openSimpleAt('need-lines');
    fireEvent.change(picker(), { target: { value: 's2' } });
    await waitFor(() => expect(stepOf()).toBe('review-material'));

    // Hold the re-read that follows the s2 decision.
    let releaseStale!: () => void;
    svc.listDispositions.mockImplementationOnce((id: string) => new Promise((resolve) => {
      releaseStale = () => resolve((dispositionsBySession[id] ?? []).map((d) => ({ ...d })));
    }));
    const card = screen.getByTestId('cn2b-simple-material-card');
    fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_not_a_material.en }));
    fireEvent.change(within(card).getByLabelText(T.cn2b_beneficiary_column_reason_required.en), { target: { value: 'footer row' } });
    fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_confirm_not_a_material.en }));
    await waitFor(() => expect(svc.listDispositions).toHaveBeenLastCalledWith('s2'));
    await waitFor(() => expect(picker()).not.toBeDisabled());

    // Switch back to s1 while that s2 re-read is still in flight; s1's rows load.
    fireEvent.change(picker(), { target: { value: 's1' } });
    await waitFor(() => expect(stepOf()).toBe('need-lines'));
    // The stale s2 answer arrives now: it must not replace s1's dispositions.
    await act(async () => { releaseStale(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(stepOf()).toBe('need-lines');
    expect(screen.queryByTestId('cn2b-simple-material-card')).toBeNull();
  });
});

describe('CN-UI-S1 · a panel that leaves the tree releases its activity', () => {
  it('S1-02/17 — a need-line draft left in Advanced does not haunt Simple: no phantom "discard?" on the next switch', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    // s1 also carries an UNDECIDED row, so Simple lands on material review —
    // a step with NO need-line panel that could re-report its own state.
    const UNDECIDED: SourceRecord = {
      id: 'rec-6', importSessionId: 's1', recordOrdinal: 2, targetEntity: 'sheet:0:row:6', fieldName: 'Item',
      sourceValues: envelope('Gauze'), sourceProvenance: { sheetIndex: 0, coordinate: { row: 6, col: 1, a1: 'B7' } },
    };
    svc.listSourceRecords.mockImplementation(async (id: string) => (id === 's1' ? [...RECORDS.s1, UNDECIDED] : RECORDS[id] ?? []));
    const { container } = render(<CentralNeedsScreen initialMode="advanced" />);
    await waitFor(() => expect(svc.listSourceRecords).toHaveBeenCalledWith('s1'));
    fireEvent.click(container.querySelector('.cn2b-stagelink[data-stage="need-lines"]') as HTMLElement);
    const stage = container.querySelector('section.cn2b-stage[data-stage="need-lines"]') as HTMLElement;
    await waitFor(() => expect(stage).not.toHaveAttribute('hidden'));
    const qty = await within(stage).findByText(/· qty$/);
    await within(qty.closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement).findByTestId('cn2b-nl-candidate-beneficiary');
    fireEvent.click(within(qty.closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement).getByRole('checkbox'));

    // The expert toggle back to Simple unmounts that panel (its draft goes with it).
    fireEvent.click(screen.getByTestId('cn2b-mode-toggle'));
    await waitFor(() => expect(stepOf()).toBe('review-material'));
    expect(screen.queryByTestId('cn2b-simple-need-lines')).toBeNull();
    // Nothing unsaved exists any more, so a switch must not ask (confirm() would refuse it here).
    fireEvent.change(picker(), { target: { value: 's2' } });
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(picker().value).toBe('s2'));
    await waitFor(() => expect(screen.getByTestId('cn2b-simple-material-card')).toHaveTextContent('Amoxicillin'));
    NO_BUSINESS_WRITE();
  });
});

describe('CN-UI-S1 · Advanced survives as the expert entry', () => {
  it('S1-18 — initialMode="advanced" opens the six stages, the need-lines stage placing the same panel', async () => {
    const { container } = render(<CentralNeedsScreen initialMode="advanced" />);
    await waitFor(() => expect(svc.listSourceRecords).toHaveBeenCalledWith('s1'));
    expect(container.querySelector('div.cn2b')?.getAttribute('data-mode')).toBe('advanced');
    expect(container.querySelectorAll('section.cn2b-stage')).toHaveLength(6);
    expect(screen.queryByTestId('cn2b-simple-workspace')).toBeNull();
    const stage = container.querySelector('section.cn2b-stage[data-stage="need-lines"]') as HTMLElement;
    await waitFor(() => expect(stage.querySelector('[data-testid="cn2b-nl-summary"]')).not.toBeNull());
    expect(container.querySelectorAll('[data-testid="cn2b-nl-summary"]')).toHaveLength(1);
  });
});

// ============================================================================
// CN-UI-S1 HC1 — through the REAL screen: the material draft against the real
// Work Session guard (H1-01F–I), and the contextual expert escape against the
// real busy/dirty guard and the real mode switch (H1-02).
// ============================================================================

const READ_FNS = [
  'listPlanRevisions', 'listImportSessions', 'listImportBatches', 'listOverrides', 'fetchReviewReadiness',
  'listNeedLineLineage', 'listBeneficiaryColumns', 'listBeneficiaryRegions', 'listSourceRecords', 'listDispositions',
] as const;
/** How many times every service READ has run — a presentation-only switch must not move any of them. */
const readCounts = () => READ_FNS.map((name) => svc[name].mock.calls.length);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });

describe('CN-UI-S1 HC1 · the material draft against the REAL Work Session guard (H1-01F–I)', () => {
  const SUGGESTED = { id: ITEM, name: 'Amoxicillin', unit: 'box' };

  /** Session s2's undecided row, its exact-match suggestion loaded, the card still untouched. */
  async function openUntouchedMaterialCardOnS2() {
    svc.searchCentralItems.mockResolvedValue([SUGGESTED]);
    await openSimpleAt('need-lines');
    fireEvent.change(picker(), { target: { value: 's2' } });
    await waitFor(() => expect(stepOf()).toBe('review-material'));
    await waitFor(() => expect(screen.getByTestId('cn2b-simple-material-suggestion')).toHaveTextContent('Amoxicillin'));
    return () => screen.getByTestId('cn2b-simple-material-card');
  }

  /** Each way the person can leave unsent local work on the material card. */
  const DRAFTS: Array<[string, (card: HTMLElement) => void]> = [
    ['the picker opened', (card) => {
      fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_choose_another_material.en }));
    }],
    ['a search typed', (card) => {
      fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_choose_another_material.en }));
      fireEvent.change(within(card).getByLabelText(T.cn2b_simple_search_material.en), { target: { value: 'amox' } });
    }],
    ['the not-applicable surface opened (no text yet)', (card) => {
      fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_not_a_material.en }));
    }],
    ['a reason typed', (card) => {
      fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_not_a_material.en }));
      fireEvent.change(within(card).getByLabelText(T.cn2b_beneficiary_column_reason_required.en), { target: { value: 'footer row' } });
    }],
  ];

  it('an untouched card is not protected: switching the Work Session asks nothing', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await openUntouchedMaterialCardOnS2();
    fireEvent.change(picker(), { target: { value: 's1' } });
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(stepOf()).toBe('need-lines'));
    NO_BUSINESS_WRITE();
  });

  for (const [name, makeDirty] of DRAFTS) {
    it(`H1-01F — ${name}: a Work Session switch invokes the existing confirmation exactly once`, async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const card = await openUntouchedMaterialCardOnS2();
      makeDirty(card());
      expect(confirm).not.toHaveBeenCalled(); // doing the work asks nothing
      fireEvent.change(picker(), { target: { value: 's1' } });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith(T.cn2b_work_session_change_confirm.en);
      NO_BUSINESS_WRITE();
    });
  }

  it('H1-01G — canceling that confirmation leaves the active session and the material state exactly as they were, with no write', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const card = await openUntouchedMaterialCardOnS2();
    fireEvent.click(within(card()).getByRole('button', { name: T.cn2b_simple_choose_another_material.en }));
    fireEvent.change(within(card()).getByLabelText(T.cn2b_simple_search_material.en), { target: { value: 'amox' } });
    const reads = readCounts();

    fireEvent.change(picker(), { target: { value: 's1' } });
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(picker().value).toBe('s2');
    expect(stepOf()).toBe('review-material');
    // The same card instance, its picker still open, its typed search intact.
    expect(within(card()).getByTestId('cn2b-simple-material-picker')).toBeInTheDocument();
    expect(within(card()).getByLabelText(T.cn2b_simple_search_material.en)).toHaveValue('amox');
    expect(readCounts()).toEqual(reads);
    NO_BUSINESS_WRITE();

    // Cancel did not switch the guard off: a SECOND attempt asks again and is declined again, with the draft still intact.
    fireEvent.change(picker(), { target: { value: 's1' } });
    await settle();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenLastCalledWith(T.cn2b_work_session_change_confirm.en);
    expect(picker().value).toBe('s2');
    expect(within(card()).getByTestId('cn2b-simple-material-picker')).toBeInTheDocument();
    expect(within(card()).getByLabelText(T.cn2b_simple_search_material.en)).toHaveValue('amox');
    expect(readCounts()).toEqual(reads);
    NO_BUSINESS_WRITE();
  });

  it('H1-01H — confirming it allows the canonical switch, once, and the dropped draft is not resurrected', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const card = await openUntouchedMaterialCardOnS2();
    fireEvent.click(within(card()).getByRole('button', { name: T.cn2b_simple_not_a_material.en }));
    fireEvent.change(within(card()).getByLabelText(T.cn2b_beneficiary_column_reason_required.en), { target: { value: 'footer row' } });

    fireEvent.change(picker(), { target: { value: 's1' } });
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(stepOf()).toBe('need-lines'));
    expect(svc.listSourceRecords).toHaveBeenLastCalledWith('s1');
    expect(svc.listDispositions).toHaveBeenLastCalledWith('s1');
    expect(picker().value).toBe('s1');
    expect(screen.queryByTestId('cn2b-simple-material-card')).toBeNull();

    // Back on s2 the card starts fresh: nothing of the discarded draft survives, and nothing is asked.
    fireEvent.change(picker(), { target: { value: 's2' } });
    await waitFor(() => expect(stepOf()).toBe('review-material'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('cn2b-simple-material-not-applicable-reason')).toBeNull();
    NO_BUSINESS_WRITE();
  });

  it('H1-01I — an in-flight decision still blocks the switch: no confirmation, no switch, and nothing discarded', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let release!: () => void;
    svc.setRecordDisposition.mockImplementation(() => new Promise((resolve) => {
      release = () => {
        dispositionsBySession.s2 = [{ ...MAPPED_ROW_5, id: 'd-9', importSessionId: 's2', targetEntity: ROW_9 }];
        resolve({ mappingId: 'd-9', idempotentReplay: false });
      };
    }));
    const card = await openUntouchedMaterialCardOnS2();
    fireEvent.click(within(card()).getByRole('button', { name: T.cn2b_simple_correct.en })); // maps the suggestion
    await waitFor(() => expect(picker()).toBeDisabled());
    expect(svc.setRecordDisposition).toHaveBeenCalledTimes(1);
    const reads = readCounts();

    // Even a change that reaches the handler anyway is refused by the guard itself.
    fireEvent.change(picker(), { target: { value: 's1' } });
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(picker().value).toBe('s2');
    expect(stepOf()).toBe('review-material');
    expect(screen.getByTestId('cn2b-simple-material-card')).toBeInTheDocument();
    expect(readCounts()).toEqual(reads);
    expect(svc.setRecordDisposition).toHaveBeenCalledTimes(1);

    await act(async () => { release(); });
    await waitFor(() => expect(stepOf()).toBe('need-lines')); // the server's re-read moved the queue
    expect(picker()).not.toBeDisabled();
  });
});

describe('CN-UI-S1 HC1 · the contextual expert escape through the REAL screen (H1-02)', () => {
  const NUMERIC_BLOCKER = {
    blocker: 'need_line_quantity_lineage_unsafe',
    detail: 'session=s1 source_record=rec-5 need_line=nl-1 reason=source_quantity_requires_explicit_numeric_override',
  };
  const OPEN_IMPORT_BLOCKER = { blocker: 'import_session_still_open', detail: 'session=s9 status=processing' };
  const UNKNOWN_BLOCKER = { blocker: 'brand_new_server_code_this_build_has_never_seen', detail: null };

  const escapeBlock = () => screen.queryByTestId('cn2b-simple-expert-escape');
  const expertButton = () => screen.getByTestId('cn2b-simple-expert-open');
  const stages = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('section.cn2b-stage')];
  const visibleStages = (container: HTMLElement) => stages(container).filter((s) => !s.hasAttribute('hidden')).map((s) => s.getAttribute('data-stage'));
  const modeOf = (container: HTMLElement) => container.querySelector('div.cn2b')?.getAttribute('data-mode');

  /** Draft a need-line designation (unsent local Simple work) in the shared panel. */
  async function designateQty() {
    await waitFor(() => expect(within(candidateFor('qty')).getByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('Beneficiary Hospital'));
    fireEvent.click(within(candidateFor('qty')).getByRole('checkbox'));
  }

  it('H1-02A/B/H — a normal ready draft, and a blocker Simple resolves, show NO escape through the real screen', async () => {
    ready = true;
    await openSimpleAt('pending');
    expect(escapeBlock()).toBeNull();
    cleanup();

    ready = false;
    blockersOverride = [
      { blocker: 'mapped_target_entity_without_need_line', detail: `session=s1 target_entity=${ROW_5}` },
      { blocker: 'need_line_quantity_lineage_unsafe', detail: 'session=s1 source_record=rec-5 need_line=nl-1 reason=source_quantity_override_binding_invalid' },
    ];
    // HC1.2: binding_invalid is Simple-resolvable only with a proven NUMERIC current head — here rec-5's head is a numeric override.
    svc.listOverrides.mockResolvedValue([{
      id: 'ov-head', sourceRecordId: 'rec-5', targetEntity: ROW_5, fieldName: 'qty', previousValue: null, finalValue: 12, finalValueText: '12',
      overrideReason: 'confirmed', overrideNote: null, createdAt: '2026-09-26T10:00:00+00:00',
    }] as FieldOverride[]);
    await openSimpleAt('need-lines');
    expect(screen.getByTestId('cn2b-simple-readiness-messages')).toBeInTheDocument();
    expect(escapeBlock()).toBeNull();
  });

  it('H1-02C/D/E — the numeric-override escape opens Advanced directly at the DATA REVIEW stage; no other stage is ever painted first', async () => {
    blockersOverride = [NUMERIC_BLOCKER];
    const { container } = await openSimpleAt('need-lines');
    expect(escapeBlock()).toHaveAttribute('data-stage', 'review');
    expect(modeOf(container)).toBe('simple');
    expect(stages(container)).toHaveLength(0);
    const reads = readCounts();

    // Watch every stage section from here on: a transient stage would flip one of these attributes.
    const flips: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && (r.target as Element).matches('section.cn2b-stage')) {
          flips.push(`${(r.target as Element).getAttribute('data-stage')}:${r.attributeName}`);
        }
      }
    });
    observer.observe(container, { subtree: true, attributes: true, attributeFilter: ['hidden', 'data-active'], childList: true });
    fireEvent.click(expertButton());
    await settle();
    observer.disconnect();

    expect(modeOf(container)).toBe('advanced');
    expect(screen.queryByTestId('cn2b-simple-workspace')).toBeNull();
    expect(stages(container)).toHaveLength(6);
    expect(visibleStages(container)).toEqual(['review']);
    expect(container.querySelector('section.cn2b-stage[data-stage="review"]')).toHaveAttribute('data-active', 'true');
    expect(flips).toEqual([]); // the very first Advanced paint already had the target stage
    // Its own canonical surface is there: the stage's heading and the shared Work Session selector.
    const review = container.querySelector('section.cn2b-stage[data-stage="review"]') as HTMLElement;
    expect(within(review).getByRole('heading', { name: T.cn2b_stage_review.en })).toBeInTheDocument();
    expect(review.querySelector('.cn2b-work-session select')).not.toBeNull();
    // Presentation only.
    expect(readCounts()).toEqual(reads);
    NO_BUSINESS_WRITE();
  });

  it('H1-02F — an open import attempt opens the SOURCE stage', async () => {
    blockersOverride = [OPEN_IMPORT_BLOCKER];
    const { container } = await openSimpleAt('need-lines');
    expect(escapeBlock()).toHaveAttribute('data-stage', 'source');
    fireEvent.click(expertButton());
    await settle();
    expect(modeOf(container)).toBe('advanced');
    expect(visibleStages(container)).toEqual(['source']);
    NO_BUSINESS_WRITE();
  });

  it('H1-02G — an unknown blocker opens the READINESS stage for expert diagnosis', async () => {
    blockersOverride = [UNKNOWN_BLOCKER];
    const { container } = await openSimpleAt('need-lines');
    expect(escapeBlock()).toHaveAttribute('data-stage', 'readiness');
    fireEvent.click(expertButton());
    await settle();
    expect(modeOf(container)).toBe('advanced');
    expect(visibleStages(container)).toEqual(['readiness']);
    NO_BUSINESS_WRITE();
  });

  it('H1-02L — with nothing unsaved there is nothing to ask: one click, no confirmation, no alert', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    blockersOverride = [NUMERIC_BLOCKER];
    const { container } = await openSimpleAt('need-lines');
    fireEvent.click(expertButton());
    await settle();
    expect(modeOf(container)).toBe('advanced');
    expect(confirm).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('H1-02J/K — unsaved Simple work asks first, in the escape\'s own words; declining changes NOTHING', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    blockersOverride = [NUMERIC_BLOCKER];
    const { container } = await openSimpleAt('need-lines');
    await designateQty();
    const reads = readCounts();

    fireEvent.click(expertButton());
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(T.cn2b_expert_switch_confirm.en);
    // Not the revision-change copy, and not the Work Session copy: this is neither.
    expect(confirm).not.toHaveBeenCalledWith(T.cn2b_revision_context_change_confirm.en);
    expect(confirm).not.toHaveBeenCalledWith(T.cn2b_work_session_change_confirm.en);
    // Cancel: still Simple, same step, same session, the draft intact, no read, no write.
    expect(modeOf(container)).toBe('simple');
    expect(stepOf()).toBe('need-lines');
    expect(picker().value).toBe('s1');
    expect(within(candidateFor('qty')).getByRole('checkbox')).toBeChecked();
    expect(escapeBlock()).toBeInTheDocument();
    expect(stages(container)).toHaveLength(0);
    expect(readCounts()).toEqual(reads);
    NO_BUSINESS_WRITE();
  });

  it('H1-02L — confirming it changes the presentation ONLY: the target stage, zero new reads, zero business writes, zero direct backend calls', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    blockersOverride = [NUMERIC_BLOCKER];
    const { container } = await openSimpleAt('need-lines');
    await designateQty();
    const reads = readCounts();
    const backendBefore = [...directBackend];

    fireEvent.click(expertButton());
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(modeOf(container)).toBe('advanced');
    expect(visibleStages(container)).toEqual(['review']);
    expect(readCounts()).toEqual(reads);
    NO_BUSINESS_WRITE();
    // Whatever Advanced's own panels may read (e.g. a revision's history) was read by them, never written: no write RPC name.
    expect(directBackend.slice(backendBefore.length).filter((c) => /set_|delete_|record_|submit|approve|reject|open_|abandon|finalize|upload|request_upload/.test(c))).toEqual([]);
    // The panel that held the draft left the tree: it is released, so nothing phantom is left to ask about.
    fireEvent.click(screen.getByTestId('cn2b-mode-toggle'));
    await waitFor(() => expect(stepOf()).toBe('need-lines'));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('H1-02I — a write in flight blocks the switch with its own sentence; nothing is abandoned, nothing is asked, and it works again once idle', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    let finish!: () => void;
    svc.setNeedLine.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ needLineId: 'nl-1', created: true, sourceLinkCount: 1, addedLinkCount: 1, approvedQuantity: '12' });
    }));
    blockersOverride = [NUMERIC_BLOCKER];
    const { container } = await openSimpleAt('need-lines');
    await designateQty();
    fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'reviewed request' } });
    fireEvent.change(within(needLines()).getByTestId('cn2b-nl-unit-select'), { target: { value: 'box' } });
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_save.en }));
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(svc.setNeedLine).toHaveBeenCalledTimes(1));

    fireEvent.click(expertButton());
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(T.cn2b_expert_switch_blocked.en);
    expect(confirm).not.toHaveBeenCalled();
    expect(modeOf(container)).toBe('simple');
    expect(stages(container)).toHaveLength(0);
    expect(svc.setNeedLine).toHaveBeenCalledTimes(1); // never repeated, never abandoned

    await act(async () => { finish(); });
    await waitFor(() => expect(within(needLines()).getByTestId('cn2b-nl-notice')).toBeInTheDocument());
    fireEvent.click(expertButton());
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(modeOf(container)).toBe('advanced');
    expect(visibleStages(container)).toEqual(['review']);
  });

  it('H1-02M — through the real screen the escape is the only way into Advanced: no footer, no generic link, one button', async () => {
    blockersOverride = [NUMERIC_BLOCKER];
    const { container } = await openSimpleAt('need-lines');
    expect(container.querySelector('.cn2b-simple footer')).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-advanced-link')).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-continue-advanced')).toBeNull();
    expect(screen.getAllByTestId('cn2b-simple-expert-open')).toHaveLength(1);
    expect(screen.getByTestId('cn2b-simple-workspace').textContent ?? '').not.toMatch(/Advanced options|خيارات متقدمة/);
  });

  it('H1-02N — initialMode="advanced" still opens the six stages, with no Simple escape; and the way back to Simple shows it again, with no read', async () => {
    blockersOverride = [NUMERIC_BLOCKER];
    const { container } = render(<CentralNeedsScreen initialMode="advanced" />);
    await waitFor(() => expect(svc.listSourceRecords).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(svc.fetchReviewReadiness).toHaveBeenCalled());
    await settle();
    expect(modeOf(container)).toBe('advanced');
    expect(stages(container)).toHaveLength(6);
    expect(escapeBlock()).toBeNull();
    const reads = readCounts();
    fireEvent.click(screen.getByTestId('cn2b-mode-toggle'));
    await waitFor(() => expect(stepOf()).toBe('need-lines'));
    expect(escapeBlock()).toHaveAttribute('data-stage', 'review');
    expect(readCounts()).toEqual(reads);
  });

  it('H1-02O — Arabic: the escape names the stage in Arabic and opens it in an RTL page', async () => {
    appState.lang = 'ar';
    appState.dir = 'rtl';
    blockersOverride = [NUMERIC_BLOCKER];
    const { container } = await openSimpleAt('need-lines');
    const block = escapeBlock() as HTMLElement;
    expect(block).toHaveTextContent(T.cn2b_simple_expert_title.ar);
    expect(within(block).getByRole('button', { name: T.cn2b_simple_expert_open.ar.replace('__STAGE__', T.cn2b_stage_review.ar) })).toBe(expertButton());
    expect(screen.getByTestId('cn2b-simple-workspace')).toHaveAttribute('dir', 'rtl');
    fireEvent.click(expertButton());
    await settle();
    expect(visibleStages(container)).toEqual(['review']);
    expect(container.querySelector('div.cn2b')).toHaveAttribute('dir', 'rtl');
  });
});

// ============================================================================
// CN-UI-S1 HC1 — review follow-ups through the REAL screen.
// ============================================================================
describe('CN-UI-S1 HC1 · follow-ups through the REAL screen', () => {
  const NUMERIC = {
    blocker: 'need_line_quantity_lineage_unsafe',
    detail: 'session=s1 source_record=rec-5 need_line=nl-1 reason=source_quantity_requires_explicit_numeric_override',
  };
  const OPEN_IMPORT = { blocker: 'import_session_still_open', detail: 'session=s9 status=pending' };
  const UNKNOWN = { blocker: 'brand_new_server_code_this_build_has_never_seen', detail: null };

  const expertButton = () => screen.getByTestId('cn2b-simple-expert-open');
  const stageOf = (container: HTMLElement, id: string) => container.querySelector(`section.cn2b-stage[data-stage="${id}"]`) as HTMLElement;
  const visibleStages = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>('section.cn2b-stage')].filter((x) => !x.hasAttribute('hidden')).map((x) => x.getAttribute('data-stage'));

  async function designateQty() {
    await waitFor(() => expect(within(candidateFor('qty')).getByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('Beneficiary Hospital'));
    fireEvent.click(within(candidateFor('qty')).getByRole('checkbox'));
  }
  async function saveDesignation() {
    fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'reviewed request' } });
    fireEvent.change(within(needLines()).getByTestId('cn2b-nl-unit-select'), { target: { value: 'box' } });
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_save.en }));
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
  }

  it('H1-01I — busy AND dirty at once: the switch is refused outright, nothing is asked, and the typed reason survives', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    svc.setRecordDisposition.mockImplementation(() => new Promise(() => {}));
    await openSimpleAt('need-lines');
    fireEvent.change(picker(), { target: { value: 's2' } });
    await waitFor(() => expect(stepOf()).toBe('review-material'));
    const card = () => screen.getByTestId('cn2b-simple-material-card');
    fireEvent.click(within(card()).getByRole('button', { name: T.cn2b_simple_not_a_material.en }));
    fireEvent.change(within(card()).getByLabelText(T.cn2b_beneficiary_column_reason_required.en), { target: { value: 'footer row' } });
    fireEvent.click(within(card()).getByRole('button', { name: T.cn2b_simple_confirm_not_a_material.en }));
    await waitFor(() => expect(picker()).toBeDisabled());
    const reads = readCounts();

    fireEvent.change(picker(), { target: { value: 's1' } });
    await settle();
    // Busy is checked BEFORE dirty: the person is not asked to discard something already on its way to the server.
    expect(confirm).not.toHaveBeenCalled();
    expect(picker().value).toBe('s2');
    expect(within(card()).getByLabelText(T.cn2b_beneficiary_column_reason_required.en)).toHaveValue('footer row');
    expect(svc.setRecordDisposition).toHaveBeenCalledTimes(1);
    expect(readCounts()).toEqual(reads);
  });

  it('H1-02I/J — Arabic: the busy sentence and the confirmation both reach an Arabic user in Arabic', async () => {
    appState.lang = 'ar';
    appState.dir = 'rtl';
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    let finish!: () => void;
    svc.setNeedLine.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ needLineId: 'nl-1', created: true, sourceLinkCount: 1, addedLinkCount: 1, approvedQuantity: '12' });
    }));
    blockersOverride = [NUMERIC];
    await openSimpleAt('need-lines');
    await waitFor(() => expect(within(candidateFor('qty')).getByTestId('cn2b-nl-candidate-beneficiary')).toBeInTheDocument());
    fireEvent.click(within(candidateFor('qty')).getByRole('checkbox'));

    fireEvent.click(expertButton()); // dirty -> asks, in Arabic
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(T.cn2b_expert_switch_confirm.ar);

    fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_reason.ar), { target: { value: 'طلب مراجَع' } });
    fireEvent.change(within(needLines()).getByTestId('cn2b-nl-unit-select'), { target: { value: 'box' } });
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_save.ar }));
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_bulk_confirm.ar }));
    await waitFor(() => expect(svc.setNeedLine).toHaveBeenCalledTimes(1));
    fireEvent.click(expertButton()); // busy -> blocked, in Arabic
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(T.cn2b_expert_switch_blocked.ar);
    expect(confirm).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
  });

  it('a draft left in the Advanced data review table does not poison Simple after the round trip: no phantom confirmation, the switch is not blocked', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    blockersOverride = [NUMERIC];
    const { container } = await openSimpleAt('need-lines');
    fireEvent.click(expertButton()); // clean, so no question
    await settle();
    expect(visibleStages(container)).toEqual(['review']);
    // In the data review table the person ticks a row: an unsent selection the table reports as dirty.
    const box = within(stageOf(container, 'review')).getByLabelText(ROW_5) as HTMLInputElement;
    fireEvent.click(box);
    expect(box).toBeChecked();

    fireEvent.click(screen.getByTestId('cn2b-mode-toggle'));
    await waitFor(() => expect(stepOf()).toBe('need-lines'));
    // The table is gone with its draft; nothing it reported is still true.
    fireEvent.change(picker(), { target: { value: 's2' } });
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(stepOf()).toBe('review-material'));
    expect(picker()).not.toBeDisabled();
    NO_BUSINESS_WRITE();
  });

  it('the person\'s own foreground work in Simple is not a "background result" when the escape opens Advanced', async () => {
    blockersOverride = [OPEN_IMPORT]; // recommended stage: source, so Simple's own need-line work is "elsewhere" to Advanced
    const { container } = await openSimpleAt('need-lines');
    await designateQty();
    await saveDesignation();
    await waitFor(() => expect(svc.setNeedLine).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(needLines()).getByTestId('cn2b-nl-notice')).toBeInTheDocument());

    fireEvent.click(expertButton());
    await settle();
    expect(visibleStages(container)).toEqual(['source']);
    expect(container.querySelector('.cn2b-background-result')).toBeNull();
  });

  it('keyboard continuity — the activated button leaves with Simple, so focus lands on the stage it opened', async () => {
    blockersOverride = [NUMERIC];
    const { container } = await openSimpleAt('need-lines');
    const button = expertButton();
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('#cn2b-stage-review')));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('end to end — each escape lands on a stage that really holds its resolver', async () => {
    // numeric correction → the data review table\'s override control
    blockersOverride = [NUMERIC];
    let view = await openSimpleAt('need-lines');
    fireEvent.click(expertButton());
    await settle();
    expect(within(stageOf(view.container, 'review')).getAllByRole('button', { name: T.cn2b_override.en }).length).toBeGreaterThan(0);
    cleanup();

    // an open import attempt (no completed session yet, so the UPLOAD step) → the source stage\'s Abandon control
    svc.listImportSessions.mockResolvedValue([{ ...session('s9', '2026-01-03T00:00:00.000Z'), status: 'pending' } as ImportSession]);
    blockersOverride = [OPEN_IMPORT];
    view = await openSimpleAt('upload');
    expect(screen.getByTestId('cn2b-simple-expert-escape').closest('.cn2b-simple-card')).toBe(screen.getByTestId('cn2b-simple-upload'));
    fireEvent.click(expertButton());
    await settle();
    expect(visibleStages(view.container)).toEqual(['source']);
    expect(within(stageOf(view.container, 'source')).getByRole('button', { name: T.cn2b_abandon.en })).toBeEnabled();
    NO_BUSINESS_WRITE();
    cleanup();

    // an unknown blocker → the readiness stage prints exactly what the server returned
    svc.listImportSessions.mockResolvedValue(SESSIONS);
    blockersOverride = [UNKNOWN];
    view = await openSimpleAt('need-lines');
    fireEvent.click(expertButton());
    await settle();
    expect(within(stageOf(view.container, 'readiness')).getByText(UNKNOWN.blocker)).toBeInTheDocument();
  });
});
