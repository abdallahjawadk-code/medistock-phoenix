/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type {
  BeneficiaryColumnSummary, FieldOverride, ImportBatch, ImportSession, NeedLine, NeedLineSourceLink,
  PlanRevision, RecordDisposition, ReviewReadiness, RevisionStatus, SourceRecord,
} from '../central-needs.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';

/**
 * C5 (M217 companion) — the REAL `CentralNeedsScreen` wiring of §13/§14/§17,
 * with only the service boundary and `useApp` mocked. The component suites
 * prove each panel calls its callback; this suite proves the SCREEN turns
 * those callbacks into the contract's behaviour (UI-F4):
 *
 *   §14  an override recorded in the review stage re-reads the chain at once;
 *        need-line saves are withheld while it is re-read; the pin that
 *        relied on the superseded head is then cleared visibly (UI-F4).
 *   §14  a `source_quantity_override_binding_invalid` refusal marks the chain
 *        NOT loaded at once and re-reads it on its own — so it recovers even
 *        when the rest of the revision reload fails, and a failed re-read
 *        keeps it unavailable (UI-F1); the "reload the overrides" control
 *        re-reads only the chain (UI-F5).
 *   §17  routing and editability follow the FRESHEST known status, including
 *        the one the readiness read returns; an edit refused with
 *        `plan_revision_not_editable` re-reads the registry and the revision
 *        (UI-F3).
 *   §14  a confirmed action whose follow-up re-read fails is not reported as a
 *        failed action; an unknown outcome is re-read, never assumed (UI-F2).
 */

const ORG = 'org-1';
const REV = 'rev-1';
const SESSION_ID = 's1';
const ROW = 'sheet:0:row:1';
const ITEM = '00000000-0000-0000-0000-0000000000a1';
const HOSPITAL = '00000000-0000-0000-0000-0000000000b1';

const appState = {
  lang: 'en' as 'ar' | 'en', dir: 'ltr' as 'rtl' | 'ltr', activeOrgId: ORG as string | null,
  profile: { organization_id: ORG } as { organization_id: string | null } | null,
  myPermissions: new Set(['central_needs.import', 'central_needs.edit', 'central_needs.approve']),
};

const listBeneficiaryColumns = vi.fn();
const listImportSessions = vi.fn();
const listImportBatches = vi.fn();
const listOverrides = vi.fn();
const fetchReviewReadiness = vi.fn();
const listNeedLineLineage = vi.fn();
const listSourceRecords = vi.fn();
const listDispositions = vi.fn();
const listPlanRevisions = vi.fn();
const approveRevision = vi.fn();
const listBeneficiaryRegions = vi.fn();
const setNeedLine = vi.fn();
const recordFieldOverride = vi.fn();

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('@/shared/supabase/services/organizations.service', () => ({ getOrganizations: async () => ORGS }));
vi.mock('@/shared/supabase/services/warehouses.service', () => ({ getWarehouses: async () => [] }));
vi.mock('../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../central-needs.service')>('../central-needs.service');
  return {
    ...actual,
    listPlanRevisions: (...a: unknown[]) => listPlanRevisions(...(a as [string])),
    listImportSessions: (...a: unknown[]) => listImportSessions(...(a as [string])),
    listImportBatches: (...a: unknown[]) => listImportBatches(...(a as [string])),
    listOverrides: (...a: unknown[]) => listOverrides(...(a as [string])),
    fetchReviewReadiness: (...a: unknown[]) => fetchReviewReadiness(...(a as [string])),
    listNeedLineLineage: (...a: unknown[]) => listNeedLineLineage(...(a as [string])),
    listBeneficiaryColumns: (...a: unknown[]) => listBeneficiaryColumns(...(a as [string])),
    listSourceRecords: (...a: unknown[]) => listSourceRecords(...(a as [string])),
    listDispositions: (...a: unknown[]) => listDispositions(...(a as [string])),
    listBeneficiaryRegions: (...a: unknown[]) => listBeneficiaryRegions(...a),
    approveRevision: (...a: unknown[]) => approveRevision(...a),
    setNeedLine: (...a: unknown[]) => setNeedLine(...a),
    recordFieldOverride: (...a: unknown[]) => recordFieldOverride(...a),
    setBeneficiaryColumns: vi.fn(async () => ({ confirmed: [] })),
    searchCentralItems: vi.fn(async () => []),
    setRecordDisposition: vi.fn(),
    searchBatchEntries: vi.fn(async () => []),
    searchSourceFiles: vi.fn(async () => []),
  };
});

const { CentralNeedsScreen } = await import('../CentralNeedsScreen');
const { centralNeedsErrorFromPostgrest } = await import('../central-needs.service');

const ORGS = [
  { id: HOSPITAL, name: 'Beneficiary Hospital', name_ar: 'مستشفى', code: 'h', status: 'active', organizationKind: 'care_institution' },
] as unknown as OrgRow[];

const revisionOf = (status: RevisionStatus): PlanRevision => ({ id: REV, planId: 'plan-1', organizationId: ORG, planYear: 2026, revisionNumber: 1, status });
const SESSION: ImportSession = {
  id: SESSION_ID, planRevisionId: REV, sourceFileId: 'f1', status: 'completed', previewDigest: 'd', authoritativeDigest: 'd',
  parserIdentity: null, startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', notes: null,
};
/** A text cell: only a pinned NUMERIC override can stand for its quantity. */
const RECORD: SourceRecord = {
  id: 'rec-1', importSessionId: SESSION_ID, recordOrdinal: 1, targetEntity: ROW, fieldName: 'Hospital A',
  sourceValues: { value: '12 boxes', valueType: 'string', isFormula: false, formula: null },
  sourceProvenance: { sheetIndex: 0, sheetName: 'Needs', coordinate: { col: 5, a1: 'F2' } },
};
const DISPOSITION: RecordDisposition = {
  id: 'd1', importSessionId: SESSION_ID, targetEntity: ROW, decision: 'mapped', centralItemId: ITEM, decisionReason: null, decidedAt: '2026-01-01T00:00:00.000Z',
};
const COLUMN: BeneficiaryColumnSummary = {
  importSessionId: SESSION_ID, originalFilename: 'n.xlsx', archiveEntryPath: null, sheetIndex: 0, sheetName: 'S', columnIndex: 5,
  sourceFieldName: 'Hospital A', numericValueCount: 1, zeroValueCount: 0, nonzeroNumericCount: 1, mappingId: 'm1',
  decision: 'beneficiary', beneficiaryOrganizationId: HOSPITAL, mappingReason: 'ok', mappedAt: '2026-01-02T00:00:00.000Z',
  mappedRowNumericCount: 1, reviewRequired: false,
};
const override = (id: string, finalValue: number): FieldOverride => ({
  id, sourceRecordId: 'rec-1', targetEntity: ROW, fieldName: 'Hospital A', previousValue: '12 boxes', finalValue,
  finalValueText: String(finalValue), overrideReason: `why ${id}`, overrideNote: null, createdAt: '2026-09-26T10:00:00+00:00',
});
const OLD_HEAD = override('ovr-old', 12);
const NEW_HEAD = override('ovr-new', 15);

const readinessOf = (status: RevisionStatus): ReviewReadiness => ({ planRevisionId: REV, status, ready: true, blockers: [] });

function load(status: RevisionStatus = 'draft') {
  listPlanRevisions.mockResolvedValue([revisionOf(status)]);
  listImportSessions.mockResolvedValue([SESSION]);
  listImportBatches.mockResolvedValue([] as ImportBatch[]);
  listOverrides.mockResolvedValue([OLD_HEAD]);
  fetchReviewReadiness.mockResolvedValue(readinessOf(status));
  listNeedLineLineage.mockResolvedValue({ needLines: [] as NeedLine[], sources: [] as NeedLineSourceLink[] });
  listBeneficiaryColumns.mockResolvedValue([COLUMN]);
  listSourceRecords.mockResolvedValue([RECORD]);
  listDispositions.mockResolvedValue([DISPOSITION]);
  listBeneficiaryRegions.mockResolvedValue([]);
}

function deferred<V>() {
  let resolve!: (v: V) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<V>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const visibleStages = () => [...document.querySelectorAll<HTMLElement>('section.cn2b-stage')]
  .filter((s) => !s.hasAttribute('hidden')).map((s) => s.dataset.stage);
const navButton = (id: string) => within(screen.getByRole('navigation', { name: T.cn2b_workflow_label.en }))
  .getAllByRole('button').find((b) => b.dataset.stage === id)!;
const stage = (id: string) => document.querySelector<HTMLElement>(`section.cn2b-stage[data-stage="${id}"]`)!;
const goTo = (id: string) => fireEvent.click(navButton(id));

const lines = () => within(stage('need-lines'));
const candidate = () => lines().getByText(`${ROW} · Hospital A`).closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement;
const pinBox = () => within(candidate()).queryByRole('checkbox', { name: T.cn2b_nl_use_override.en }) as HTMLInputElement | null;
const contribution = () => within(candidate()).getByLabelText(`${T.cn2b_nl_contribution.en} — Hospital A`) as HTMLInputElement;
const saveButton = () => lines().getByRole('button', { name: T.cn2b_nl_save.en });
const saveBlockers = () => [...(lines().queryByTestId('cn2b-nl-save-blockers')?.querySelectorAll('[data-blocker]') ?? [])]
  .map((b) => b.getAttribute('data-blocker'));

/** Designate the cell, pin its CURRENT head, and fill what a save needs. */
async function pinHeadAndPrepare() {
  goTo('need-lines');
  await waitFor(() => expect(lines().getByText(`${ROW} · Hospital A`)).toBeInTheDocument());
  fireEvent.click(within(candidate()).getAllByRole('checkbox')[0]);
  await waitFor(() => expect(pinBox()).not.toBeNull());
  fireEvent.click(pinBox()!);
  expect(contribution().value).toBe('12');
  fireEvent.change(lines().getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'lineage review' } });
  fireEvent.change(lines().getByTestId('cn2b-nl-unit-select'), { target: { value: 'box' } });
  expect(saveButton()).toBeEnabled();
}

async function renderReady(status: RevisionStatus = 'draft') {
  load(status);
  render(<CentralNeedsScreen initialMode="advanced" />);
  await waitFor(() => expect(visibleStages()).toHaveLength(1));
}

beforeEach(() => {
  vi.clearAllMocks();
  appState.myPermissions = new Set(['central_needs.import', 'central_needs.edit', 'central_needs.approve']);
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), writable: true, configurable: true });
  setNeedLine.mockResolvedValue({ needLineId: 'nl-1', created: true, sourceLinkCount: 1, addedLinkCount: 1, approvedQuantity: '12' });
  recordFieldOverride.mockResolvedValue({ overrideId: 'ovr-new' });
});
afterEach(() => cleanup());

// ============================================================================
// UI-F4 — override created → chain re-read → saves withheld → stale pin cleared.
// ============================================================================
describe('C5 §14 — recording an override re-reads the chain, withholds saves meanwhile, and clears the stale pin', { timeout: 30_000 }, () => {
  it('wires the review stage’s new override to the need-lines stage through ONE fresh chain read', async () => {
    await renderReady();
    expect(listOverrides).toHaveBeenCalledTimes(1);
    await pinHeadAndPrepare();

    // The chain re-read after the override is held open, to observe the window.
    const reread = deferred<FieldOverride[]>();
    listOverrides.mockImplementationOnce(() => reread.promise);

    goTo('review');
    const review = within(stage('review'));
    fireEvent.click(review.getByRole('button', { name: T.cn2b_override_replace.en }));
    const editor = review.getByRole('group', { name: T.cn2b_override.en });
    fireEvent.change(within(editor).getByLabelText(T.cn2b_override_kind.en), { target: { value: 'number' } });
    fireEvent.change(within(editor).getByLabelText(T.cn2b_override_value.en), { target: { value: '15' } });
    fireEvent.change(within(editor).getByLabelText(T.cn2b_override_reason.en), { target: { value: 'signed recount' } });
    fireEvent.click(within(editor).getByRole('button', { name: T.cn2b_override_number_preview.en }));
    fireEvent.click(within(editor).getByRole('button', { name: T.cn2b_override_number_confirm.en }));
    await waitFor(() => expect(recordFieldOverride).toHaveBeenCalledTimes(1));

    // The chain is re-read at once...
    await waitFor(() => expect(listOverrides).toHaveBeenCalledTimes(2));
    expect(listOverrides).toHaveBeenLastCalledWith(REV);

    // ...and until it answers, no need line can be saved against the old one.
    goTo('need-lines');
    expect(lines().getByTestId('cn2b-nl-overrides-unavailable')).toHaveTextContent(T.cn2b_nl_overrides_unavailable.en);
    expect(saveButton()).toBeDisabled();
    expect(saveBlockers()).toContain('cn2b_nl_block_overrides_unavailable');
    expect(within(candidate()).getByTestId('cn2b-nl-pin-unverified')).toBeInTheDocument();
    expect(pinBox()).toBeNull(); // nothing is offered as a head meanwhile
    fireEvent.click(saveButton());
    expect(setNeedLine).not.toHaveBeenCalled();

    // The new chain answers: the pin on the superseded head is cleared visibly.
    reread.resolve([NEW_HEAD, OLD_HEAD]);
    await waitFor(() => expect(lines().getByTestId('cn2b-nl-stale-pins-cleared')).toBeInTheDocument());
    expect(lines().queryByTestId('cn2b-nl-overrides-unavailable')).toBeNull();
    expect(within(candidate()).getByTestId('cn2b-nl-stale-pin')).toBeInTheDocument();
    expect(pinBox()).not.toBeChecked();
    expect(contribution().value).toBe('');
    expect(saveButton()).toBeDisabled();
    expect(within(candidate()).getByTestId('cn2b-nl-override-evidence')).toHaveAttribute('data-override-id', 'ovr-new');

    // Only an explicit re-selection of the CURRENT head saves — and it sends that head.
    fireEvent.click(pinBox()!);
    expect(contribution().value).toBe('15');
    fireEvent.click(saveButton());
    fireEvent.click(lines().getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(setNeedLine.mock.calls[0][0].quantitySources).toEqual([
      { sourceRecordId: 'rec-1', designatedQuantity: '15', appliedOverrideId: 'ovr-new' },
    ]);
  });
});

// ============================================================================
// UI-F1 / UI-F5 — a stale-binding refusal re-reads the chain on its own.
// ============================================================================
describe('C5 §14 — a stale-binding refusal marks the chain not loaded at once and re-reads it on its own', { timeout: 30_000 }, () => {
  const bindingInvalid = () => centralNeedsErrorFromPostgrest({
    code: '23514', message: 'need_line_quantity_lineage_unsafe',
    details: `session=${SESSION_ID} source_record=rec-1 need_line=nl-1 reason=source_quantity_override_binding_invalid`,
  });
  /** Pins the head, installs what the server answers AFTER the refusal, then confirms and is refused. */
  async function refuseStaleBinding(afterRefusal: () => void) {
    await renderReady();
    await pinHeadAndPrepare();
    afterRefusal();
    setNeedLine.mockRejectedValueOnce(bindingInvalid());
    fireEvent.click(saveButton());
    fireEvent.click(lines().getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await lines().findByTestId('cn2b-nl-error');
  }

  it('withholds the old head at once, and a FAILED re-read keeps the chain unavailable until the reload control succeeds', async () => {
    const pending = [deferred<FieldOverride[]>(), deferred<FieldOverride[]>()];
    let next = 0;
    let before = 0;
    await refuseStaleBinding(() => {
      before = listOverrides.mock.calls.length;
      listOverrides.mockImplementation(() => pending[Math.min(next++, pending.length - 1)].promise);
    });

    // Not ready from the moment of the refusal: the old head is not offered, nothing saves.
    await waitFor(() => expect(lines().getByTestId('cn2b-nl-overrides-unavailable')).toBeInTheDocument());
    expect(pinBox()).toBeNull();
    expect(saveButton()).toBeDisabled();
    // The chain is re-read (the revision reload and the dedicated chain read).
    await waitFor(() => expect(listOverrides.mock.calls.length).toBeGreaterThanOrEqual(before + 2));

    // Every re-read fails: the chain stays unavailable — the old head never comes back.
    const timeout = centralNeedsErrorFromPostgrest({ code: '57014', message: 'canceling statement due to statement timeout' });
    for (const d of pending) d.reject(timeout);
    await waitFor(() => expect(lines().getByTestId('cn2b-nl-overrides-unavailable')).toHaveTextContent(T.cn2b_err_field_overrides_read_failed.en));
    expect(pinBox()).toBeNull();
    expect(saveButton()).toBeDisabled();

    // UI-F5 — the control re-reads ONLY the chain; the new head then becomes choosable.
    listOverrides.mockReset().mockResolvedValue([NEW_HEAD, OLD_HEAD]);
    const readinessReads = fetchReviewReadiness.mock.calls.length;
    fireEvent.click(lines().getByTestId('cn2b-nl-overrides-reload'));
    await waitFor(() => expect(lines().queryByTestId('cn2b-nl-overrides-unavailable')).toBeNull());
    expect(listOverrides).toHaveBeenCalledTimes(1);
    expect(fetchReviewReadiness.mock.calls.length).toBe(readinessReads);
    expect(within(candidate()).getByTestId('cn2b-nl-override-evidence')).toHaveAttribute('data-override-id', 'ovr-new');
    expect(pinBox()).not.toBeChecked();
  });

  it('recovers the chain even when the rest of the revision reload fails', async () => {
    await renderReady();
    await pinHeadAndPrepare();
    // After the refusal: the chain now has a newer head, but readiness times out.
    listOverrides.mockResolvedValue([NEW_HEAD, OLD_HEAD]);
    fetchReviewReadiness.mockRejectedValue(centralNeedsErrorFromPostgrest({ code: '57014', message: 'canceling statement due to statement timeout' }));
    setNeedLine.mockRejectedValueOnce(bindingInvalid());
    fireEvent.click(saveButton());
    fireEvent.click(lines().getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await lines().findByTestId('cn2b-nl-error');

    // The dedicated chain read does not depend on the other reads: the NEW head is offered, never the old one.
    await waitFor(() => expect(within(candidate()).getByTestId('cn2b-nl-override-evidence')).toHaveAttribute('data-override-id', 'ovr-new'));
    expect(lines().queryByTestId('cn2b-nl-overrides-unavailable')).toBeNull();
    expect(pinBox()).not.toBeChecked();
    expect(within(candidate()).getByTestId('cn2b-nl-stale-pin')).toBeInTheDocument();
    // The failed revision reload is reported as the failed re-read it is (UI-N1) — never with the
    // re-read's own "not applied — try again" copy, which would describe the person's write.
    expect(await screen.findByText(T.cn2b_err_revision_reread_failed.en)).toBeInTheDocument();
    expect(screen.queryByText(T.cn2b_err_retryable_contention.en)).toBeNull();
  });
});

// ============================================================================
// UI-F3 — §17 by the freshest status.
// ============================================================================
describe('C5 §17 — routing and editability follow the freshest known status', { timeout: 30_000 }, () => {
  it('a LAGGING registry "draft" whose readiness says "submitted" still lands on the submitted landing, read-only', async () => {
    load('draft');
    // Someone else submitted the draft; the registry list keeps answering "draft".
    fetchReviewReadiness.mockResolvedValue(readinessOf('submitted'));
    render(<CentralNeedsScreen initialMode="advanced" />);
    await waitFor(() => expect(visibleStages()).toEqual(['readiness']));
    const landing = within(stage('readiness')).getByTestId('cn2b-terminal-landing');
    expect(landing).toHaveAttribute('data-status', 'submitted');
    expect(screen.queryByRole('button', { name: T.cn2b_submit.en })).toBeNull();
    for (const id of ['source', 'review', 'beneficiaries', 'need-lines']) expect(navButton(id).dataset.progress, id).toBe('closed');
    expect(document.querySelector('.cn2b-revstatus')).toHaveAttribute('data-status', 'submitted');
    // No edit surface remains, even though the registry row still says "draft".
    goTo('need-lines');
    expect(lines().getByTestId('cn2b-nl-readonly')).toBeInTheDocument();
    expect(lines().queryByRole('button', { name: T.cn2b_nl_save.en })).toBeNull();
    // The disagreement is reconciled ONCE — a registry that stays behind is never polled in a loop.
    await waitFor(() => expect(listPlanRevisions).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(listPlanRevisions).toHaveBeenCalledTimes(2);
  });

  it('the one reconciling registry read brings the revision list up to the fresher status', async () => {
    load('draft');
    fetchReviewReadiness.mockResolvedValue(readinessOf('submitted'));
    listPlanRevisions.mockResolvedValueOnce([revisionOf('draft')]).mockResolvedValue([revisionOf('submitted')]);
    render(<CentralNeedsScreen initialMode="advanced" />);
    await waitFor(() => expect(visibleStages()).toEqual(['readiness']));
    await waitFor(() => expect(listPlanRevisions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('option', { name: new RegExp(T.cn2b_revstatus_submitted.en), hidden: true }))
      .toBeInTheDocument());
    expect(within(stage('readiness')).getByTestId('cn2b-terminal-landing')).toHaveAttribute('data-status', 'submitted');
  });

  it('an edit refused with plan_revision_not_editable re-reads the registry and the revision, and lands on the terminal page', async () => {
    await renderReady();
    await pinHeadAndPrepare();
    const lists = listPlanRevisions.mock.calls.length;
    const reads = fetchReviewReadiness.mock.calls.length;
    // Someone else submitted the draft meanwhile.
    listPlanRevisions.mockResolvedValue([revisionOf('submitted')]);
    fetchReviewReadiness.mockResolvedValue(readinessOf('submitted'));
    setNeedLine.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({
      code: '23514', message: 'plan_revision_not_editable', details: `revision=${REV} status=submitted`,
    }));
    fireEvent.click(saveButton());
    fireEvent.click(lines().getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));

    await waitFor(() => expect(listPlanRevisions.mock.calls.length).toBeGreaterThan(lists));
    await waitFor(() => expect(fetchReviewReadiness.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(visibleStages()).toEqual(['readiness']));
    expect(within(stage('readiness')).getByTestId('cn2b-terminal-landing')).toHaveAttribute('data-status', 'submitted');
    expect(lines().getByTestId('cn2b-nl-readonly')).toBeInTheDocument();
    expect(setNeedLine).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// UI-F2 — the outcome shown is the one the server confirmed.
// ============================================================================
describe('C5 §14 — a confirmed action is never reported as failed, and an unknown outcome is re-read', { timeout: 30_000 }, () => {
  it('an approval the server confirmed stays "approved" when the re-read after it fails', async () => {
    await renderReady('submitted');
    approveRevision.mockResolvedValueOnce(undefined);
    listPlanRevisions.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({ code: '57014', message: 'canceling statement due to statement timeout' }));
    fireEvent.click(within(stage('readiness')).getByRole('button', { name: T.cn2b_approve.en }));
    expect(await screen.findByText(T.cn2b_notice_approved.en)).toBeInTheDocument();
    expect(await screen.findByText(T.cn2b_err_state_reread_failed.en)).toBeInTheDocument();
    expect(screen.queryByText(T.cn2b_err_retryable_contention.en)).toBeNull();
    expect(approveRevision).toHaveBeenCalledTimes(1);
  });

  it('UI-N1: a need line the server saved is not reported as "not applied" when the revision re-read after it fails', async () => {
    await renderReady();
    await pinHeadAndPrepare();
    fetchReviewReadiness.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({ code: '57014', message: 'canceling statement due to statement timeout' }));
    fireEvent.click(saveButton());
    fireEvent.click(lines().getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(setNeedLine).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(T.cn2b_err_revision_reread_failed.en)).toBeInTheDocument();
    expect(screen.queryByText(T.cn2b_err_retryable_contention.en)).toBeNull();
    expect(screen.queryByText(T.cn2b_err_central_needs_request_failed.en)).toBeNull();
    expect(setNeedLine).toHaveBeenCalledTimes(1);
  });

  it('an approval whose outcome is unknown (transport failure) says so and re-reads the registry and the revision', async () => {
    await renderReady('submitted');
    const lists = listPlanRevisions.mock.calls.length;
    const reads = fetchReviewReadiness.mock.calls.length;
    approveRevision.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({ message: 'TypeError: Failed to fetch' }));
    fireEvent.click(within(stage('readiness')).getByRole('button', { name: T.cn2b_approve.en }));
    expect(await screen.findByText(T.cn2b_err_central_needs_request_failed.en)).toBeInTheDocument();
    await waitFor(() => expect(listPlanRevisions.mock.calls.length).toBeGreaterThan(lists));
    await waitFor(() => expect(fetchReviewReadiness.mock.calls.length).toBeGreaterThan(reads));
    expect(screen.queryByText(T.cn2b_notice_approved.en)).toBeNull();
    expect(approveRevision).toHaveBeenCalledTimes(1);
  });
});
