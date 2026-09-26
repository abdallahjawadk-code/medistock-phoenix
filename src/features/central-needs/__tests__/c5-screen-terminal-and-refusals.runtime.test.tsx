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
 * C5 (M217 companion) — the REAL `CentralNeedsScreen`, with only the service
 * boundary and `useApp` mocked.
 *
 *   §17  every non-DRAFT revision opens on the readiness stage by its STATUS,
 *        with its own terminal sentence — including a submitted or approved
 *        revision whose readiness still lists blockers, which stay
 *        informational; a DRAFT still opens on its first actionable stage.
 *   §13  a failed override read makes overrides UNAVAILABLE without taking the
 *        screen down: every stage stays readable, and need-line saves and
 *        override creation are withheld.
 *   §14  lifecycle refusals are decided by businessCode, explained by their
 *        pinned reason and followed by a re-read; nothing is retried, and a
 *        retryable contention only says "try again".
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
    setNeedLine: vi.fn(),
    setBeneficiaryColumns: vi.fn(async () => ({ confirmed: [] })),
    recordFieldOverride: vi.fn(),
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
const RECORD: SourceRecord = {
  id: 'rec-1', importSessionId: SESSION_ID, recordOrdinal: 1, targetEntity: ROW, fieldName: 'Hospital A',
  sourceValues: { value: 100, valueType: 'number', isFormula: false, formula: null }, sourceProvenance: { sheetIndex: 0, coordinate: { col: 5 } },
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
/** Blockers that, on a draft, would route to the Review and Need-lines edit stages. */
const EDIT_BLOCKERS = [
  { blocker: 'target_entity_without_disposition', detail: `session=${SESSION_ID} target_entity=${ROW}` },
  { blocker: 'need_line_quantity_lineage_unsafe', detail: `session=${SESSION_ID} source_record=rec-1 need_line=nl-1 reason=source_quantity_override_mismatch` },
];

function load(status: RevisionStatus, blockers = EDIT_BLOCKERS) {
  listPlanRevisions.mockResolvedValue([revisionOf(status)]);
  listImportSessions.mockResolvedValue([SESSION]);
  listImportBatches.mockResolvedValue([] as ImportBatch[]);
  listOverrides.mockResolvedValue([] as FieldOverride[]);
  fetchReviewReadiness.mockResolvedValue({ planRevisionId: REV, status, ready: blockers.length === 0, blockers } as ReviewReadiness);
  listNeedLineLineage.mockResolvedValue({ needLines: [] as NeedLine[], sources: [] as NeedLineSourceLink[] });
  listBeneficiaryColumns.mockResolvedValue([COLUMN]);
  listSourceRecords.mockResolvedValue([RECORD]);
  listDispositions.mockResolvedValue([DISPOSITION]);
  listBeneficiaryRegions.mockResolvedValue([]);
}

const visibleStages = () => [...document.querySelectorAll<HTMLElement>('section.cn2b-stage')]
  .filter((s) => !s.hasAttribute('hidden')).map((s) => s.dataset.stage);
const navButton = (id: string) => within(screen.getByRole('navigation', { name: T.cn2b_workflow_label.en }))
  .getAllByRole('button').find((b) => b.dataset.stage === id)!;
const stage = (id: string) => document.querySelector<HTMLElement>(`section.cn2b-stage[data-stage="${id}"]`)!;

beforeEach(() => {
  vi.clearAllMocks();
  appState.myPermissions = new Set(['central_needs.import', 'central_needs.edit', 'central_needs.approve']);
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), writable: true, configurable: true });
});
afterEach(() => cleanup());

// ============================================================================
// §17 — terminal routing.
// ============================================================================
describe('C5 §17 — a revision that is no longer a draft opens on its readiness landing', () => {
  it.each(['submitted', 'approved', 'rejected', 'superseded'] as const)(
    '%s WITH blockers: readiness stage, its own terminal sentence, blockers informational, no edit task', async (status) => {
      load(status);
      render(<CentralNeedsScreen initialMode="advanced" />);
      await waitFor(() => expect(visibleStages()).toEqual(['readiness']));
      const landing = within(stage('readiness')).getByTestId('cn2b-terminal-landing');
      expect(landing).toHaveAttribute('data-status', status);
      expect(landing).toHaveTextContent(T[`cn2b_terminal_${status}`].en);
      expect(within(stage('readiness')).getByTestId('cn2b-terminal-blockers-informational'))
        .toHaveTextContent(T.cn2b_terminal_blockers_informational.en);
      // The pinned reason gets its own label.
      expect(stage('readiness')).toHaveTextContent(T.cn2b_blocker_need_line_quantity_lineage_unsafe__source_quantity_override_mismatch.en);
      // Never an edit task: no stage needs action, no submit, no "incomplete" verdict.
      for (const id of ['source', 'review', 'beneficiaries', 'need-lines']) {
        expect(navButton(id).dataset.progress, id).toBe('closed');
      }
      expect(navButton('readiness').dataset.progress).toBe(status);
      expect(screen.queryByRole('button', { name: T.cn2b_submit.en })).toBeNull();
      expect(screen.queryByText(T.cn2b_readiness_blocked.en)).toBeNull();
    });

  it('a DRAFT with the same blockers still opens on its first actionable stage', async () => {
    load('draft');
    render(<CentralNeedsScreen initialMode="advanced" />);
    await waitFor(() => expect(visibleStages()).toEqual(['review']));
    expect(navButton('need-lines').dataset.progress).toBe('needs-action');
    fireEvent.click(navButton('readiness'));
    expect(within(stage('readiness')).queryByTestId('cn2b-terminal-landing')).toBeNull();
    expect(within(stage('readiness')).getByText(T.cn2b_readiness_blocked.en)).toBeInTheDocument();
  });
});

// ============================================================================
// §13 — override read failure is isolated.
// ============================================================================
describe('C5 §13 — a failed override read leaves the screen readable and withholds override-dependent writes', () => {
  it('loads every stage, marks overrides unavailable, and blocks need-line saves and override creation', async () => {
    load('draft', []);
    listOverrides.mockRejectedValue(centralNeedsErrorFromPostgrest({ code: '57014', message: 'canceling statement due to statement timeout' }));
    render(<CentralNeedsScreen initialMode="advanced" />);
    await waitFor(() => expect(visibleStages()).toEqual(['readiness']));
    // The rest of the screen is not held in its loading state.
    expect(screen.queryByText(T.cn2b_err_load_failed.en)).toBeNull();

    fireEvent.click(navButton('review'));
    await waitFor(() => expect(within(stage('review')).getByTestId('cn2b-overrides-unavailable')).toBeInTheDocument());
    expect(within(stage('review')).getByRole('button', { name: T.cn2b_override.en })).toBeDisabled();
    expect(within(stage('review')).getByText(T.cn2b_effective_unknown.en)).toBeInTheDocument();

    fireEvent.click(navButton('need-lines'));
    expect(within(stage('need-lines')).getByTestId('cn2b-nl-overrides-unavailable')).toBeInTheDocument();
    expect(within(stage('need-lines')).getByRole('button', { name: T.cn2b_nl_save.en })).toBeDisabled();
  });
});

// ============================================================================
// §14 — lifecycle refusals.
// ============================================================================
describe('C5 §14 — approval refusals: businessCode decides, reason explains, state is re-read, nothing retries', () => {
  async function approveOnSubmitted() {
    load('submitted', []);
    render(<CentralNeedsScreen initialMode="advanced" />);
    await waitFor(() => expect(visibleStages()).toEqual(['readiness']));
    const readsBefore = fetchReviewReadiness.mock.calls.length;
    const listsBefore = listPlanRevisions.mock.calls.length;
    fireEvent.click(within(stage('readiness')).getByRole('button', { name: T.cn2b_approve.en }));
    return { readsBefore, listsBefore };
  }

  it('an eligibility change shows its reason’s sentence and re-reads the registry and the revision', async () => {
    approveRevision.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({
      code: '23514', message: 'central_needs_approval_eligibility_changed',
      details: `blocker=need_line_beneficiary_ineligible need_line=nl-1 beneficiary=${HOSPITAL} reason=inactive`,
    }));
    const { readsBefore, listsBefore } = await approveOnSubmitted();
    expect(await screen.findByText(T.cn2b_err_central_needs_approval_eligibility_changed__inactive.en)).toBeInTheDocument();
    await waitFor(() => expect(fetchReviewReadiness.mock.calls.length).toBeGreaterThan(readsBefore));
    expect(listPlanRevisions.mock.calls.length).toBeGreaterThan(listsBefore);
    expect(approveRevision).toHaveBeenCalledTimes(1);
  });

  it('a revision that is no longer submitted is re-read, not retried', async () => {
    approveRevision.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({ code: 'P0001', message: 'plan_revision_not_submitted' }));
    const { readsBefore } = await approveOnSubmitted();
    expect(await screen.findByText(T.cn2b_err_plan_revision_not_submitted.en)).toBeInTheDocument();
    await waitFor(() => expect(fetchReviewReadiness.mock.calls.length).toBeGreaterThan(readsBefore));
    expect(approveRevision).toHaveBeenCalledTimes(1);
  });

  it('a missing approval gate is a server invariant failure: explained, never retried', async () => {
    approveRevision.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({
      code: '23514', message: 'central_needs_approval_gate_missing', details: `revision=${REV}`,
    }));
    await approveOnSubmitted();
    expect(await screen.findByText(T.cn2b_err_central_needs_approval_gate_missing.en)).toBeInTheDocument();
    expect(approveRevision).toHaveBeenCalledTimes(1);
  });

  it('a retryable contention says "try again", is not retried, and triggers no re-read', async () => {
    approveRevision.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({ code: '40P01', message: 'deadlock detected' }));
    const { readsBefore, listsBefore } = await approveOnSubmitted();
    expect(await screen.findByText(T.cn2b_err_retryable_contention.en)).toBeInTheDocument();
    expect(approveRevision).toHaveBeenCalledTimes(1);
    expect(fetchReviewReadiness.mock.calls.length).toBe(readsBefore);
    expect(listPlanRevisions.mock.calls.length).toBe(listsBefore);
  });

  it('a frozen action (42501 without a token) is "unavailable", not a raw database message', async () => {
    approveRevision.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({
      code: '42501', message: 'permission denied for function phoenix_central_needs_approve_revision',
    }));
    await approveOnSubmitted();
    expect(await screen.findByText(T.cn2b_err_central_needs_action_unavailable.en)).toBeInTheDocument();
    expect(screen.queryByText(/permission denied/)).toBeNull();
  });
});
