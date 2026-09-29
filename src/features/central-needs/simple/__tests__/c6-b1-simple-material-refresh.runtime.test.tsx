/** @vitest-environment jsdom */
/**
 * C6-B1 — a confirmed Simple Mode material decision is followed by a SERVER
 * RE-READ, and only that re-read moves the material queue.
 *
 * The defect (C6 blocker B1): Simple's single `onChanged` re-read the revision
 * (`reloadRevision`) but never the active session's dispositions, and the
 * records/dispositions read is keyed on `activeSessionId` alone — so after a
 * successful decision the same material stayed on screen and "Remaining" never
 * moved. These tests drive the REAL `CentralNeedsScreen` with only the service
 * boundary mocked (the idiom of simple-default-mode.runtime.test.tsx), so they
 * exercise the screen's own wiring, not the workspace's props.
 *
 * The mocked server keeps its own persisted dispositions: a write that
 * succeeds is persisted there, and the screen can only learn of it by reading
 * `listDispositions` again. Nothing here edits a record or a disposition on the
 * client's behalf, and one test proves the queue does NOT move when the
 * server's re-read does not show the decision.
 *
 *   B1-1  success: write → listDispositions(active session) and readiness are
 *         re-read → A leaves the queue, B is shown, Remaining 2 → 1; the next
 *         card starts fresh; then B → the queue is empty and Simple derives
 *         its next step from the fresh state.
 *   B1-2  the queue follows the server, not the click: nothing moves while the
 *         re-read is in flight (the write already persisted), it moves when the
 *         re-read answers; B1-2b: nothing moves if the re-read does not show it.
 *   B1-3  a refused write: no removal, no decrement, the existing refusal path.
 *   B1-4  a failed re-read after a confirmed write is reported as a re-read
 *         problem (state_reread_failed), never as a failed write.
 *   B1-5  a 'mapped' decision also re-reads the revision-wide beneficiary
 *         columns, so newly required institution review is routed to.
 *   B1-6  an institution decision keeps the revision refresh and does not
 *         re-read dispositions.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { t } from '@/shared/i18n/strings';
import type {
  BeneficiaryColumnSummary, CentralItemOption, FieldOverride, ImportBatch, ImportSession, NeedLine, NeedLineSourceLink,
  PlanRevision, RecordDisposition, ReviewReadiness, SourceRecord,
} from '../../central-needs.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';

const ORG = 'org-1';
const REV = 'rev-1';
const SESSION_ID = 's1';
const ROW_A = 'sheet:0:row:1';
const ROW_B = 'sheet:0:row:2';
const ITEM: CentralItemOption = { id: '00000000-0000-0000-0000-0000000000a1', name: 'C6B1 catalog item', unit: 'box' };
const HOSPITAL = '00000000-0000-0000-0000-0000000000b1';
const REASON = 'C6-B1 reviewer: not a material';

const appState = {
  lang: 'en' as 'ar' | 'en', dir: 'ltr' as 'rtl' | 'ltr', activeOrgId: ORG as string | null,
  profile: { organization_id: ORG } as { organization_id: string | null } | null,
  myPermissions: new Set(['central_needs.import', 'central_needs.edit', 'central_needs.approve']),
};

const listPlanRevisions = vi.fn();
const listImportSessions = vi.fn();
const listImportBatches = vi.fn();
const listOverrides = vi.fn();
const fetchReviewReadiness = vi.fn();
const listNeedLineLineage = vi.fn();
const listBeneficiaryColumns = vi.fn();
const listBeneficiaryRegions = vi.fn();
const listSourceRecords = vi.fn();
const listDispositions = vi.fn();
const setRecordDisposition = vi.fn();
const setBeneficiaryColumns = vi.fn();
const searchCentralItems = vi.fn();

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('@/shared/supabase/services/organizations.service', () => ({ getOrganizations: async () => ORGS }));
vi.mock('@/shared/supabase/services/warehouses.service', () => ({ getWarehouses: async () => [] }));
vi.mock('../../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../../central-needs.service')>('../../central-needs.service');
  return {
    ...actual,
    listPlanRevisions: (...a: unknown[]) => listPlanRevisions(...a),
    listImportSessions: (...a: unknown[]) => listImportSessions(...a),
    listImportBatches: (...a: unknown[]) => listImportBatches(...a),
    listOverrides: (...a: unknown[]) => listOverrides(...a),
    fetchReviewReadiness: (...a: unknown[]) => fetchReviewReadiness(...a),
    listNeedLineLineage: (...a: unknown[]) => listNeedLineLineage(...a),
    listBeneficiaryColumns: (...a: unknown[]) => listBeneficiaryColumns(...a),
    listBeneficiaryRegions: (...a: unknown[]) => listBeneficiaryRegions(...a),
    listSourceRecords: (...a: unknown[]) => listSourceRecords(...a),
    listDispositions: (...a: unknown[]) => listDispositions(...a),
    setRecordDisposition: (...a: unknown[]) => setRecordDisposition(...a),
    setBeneficiaryColumns: (...a: unknown[]) => setBeneficiaryColumns(...a),
    searchCentralItems: (...a: unknown[]) => searchCentralItems(...a),
    recordFieldOverride: vi.fn(),
    searchBatchEntries: vi.fn(async () => []),
    searchSourceFiles: vi.fn(async () => []),
  };
});

const { CentralNeedsScreen } = await import('../../CentralNeedsScreen');
const { centralNeedsErrorFromPostgrest } = await import('../../central-needs.service');

const ORGS = [
  { id: HOSPITAL, name: 'C6B1 Hospital', name_ar: 'مستشفى', code: 'c6b1-h', status: 'active', organizationKind: 'care_institution' },
] as unknown as OrgRow[];

const REVISION: PlanRevision = { id: REV, planId: 'plan-1', organizationId: ORG, planYear: 2026, revisionNumber: 1, status: 'draft' };
const SESSION: ImportSession = {
  id: SESSION_ID, planRevisionId: REV, sourceFileId: 'f1', status: 'completed', previewDigest: 'd', authoritativeDigest: 'd',
  parserIdentity: null, startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', notes: null,
};
const record = (id: string, targetEntity: string, row: number, value: string): SourceRecord => ({
  id, importSessionId: SESSION_ID, recordOrdinal: row, targetEntity, fieldName: 'Item',
  sourceValues: { value, valueType: 'string', isFormula: false, formula: null },
  sourceProvenance: { sheetIndex: 0, sheetName: 'Needs', coordinate: { row, col: 1, a1: `B${row + 1}` } },
});
const RECORDS: SourceRecord[] = [record('rec-a', ROW_A, 1, 'ALPHA evidence row'), record('rec-b', ROW_B, 2, 'BETA evidence row')];
/** A column the server reports as needing review once a row is MAPPED (M217 review_required). */
const COLUMN_TO_REVIEW: BeneficiaryColumnSummary = {
  importSessionId: SESSION_ID, originalFilename: 'n.xlsx', archiveEntryPath: null, sheetIndex: 0, sheetName: 'Needs', columnIndex: 5,
  sourceFieldName: 'C6B1 Hospital', numericValueCount: 1, zeroValueCount: 0, nonzeroNumericCount: 1, mappingId: null,
  decision: null, beneficiaryOrganizationId: null, mappingReason: null, mappedAt: null, mappedRowNumericCount: 1, reviewRequired: true,
};

// ---- the mocked server's own persisted state -------------------------------
let persisted: RecordDisposition[] = [];
let columns: BeneficiaryColumnSummary[] = [];

const readinessNow = (): ReviewReadiness => {
  const undecided = RECORDS.filter((r) => !persisted.some((d) => d.targetEntity === r.targetEntity));
  const blockers = undecided.map((r) => ({ blocker: 'target_entity_without_disposition', detail: `session=${SESSION_ID} target_entity=${r.targetEntity}` }));
  return { planRevisionId: REV, status: 'draft', ready: blockers.length === 0, blockers } as unknown as ReviewReadiness;
};

function serverPersists(input: { importSessionId: string; targetEntity: string; decision: 'mapped' | 'not_applicable'; centralItemId?: string; decisionReason?: string }) {
  persisted = [...persisted.filter((d) => d.targetEntity !== input.targetEntity), {
    id: `d-${input.targetEntity}`, importSessionId: input.importSessionId, targetEntity: input.targetEntity, decision: input.decision,
    centralItemId: input.centralItemId ?? null, decisionReason: input.decisionReason ?? null, decidedAt: '2026-09-27T00:00:00.000Z',
  }];
}

beforeEach(() => {
  vi.clearAllMocks();
  persisted = [];
  columns = [];
  listPlanRevisions.mockResolvedValue([REVISION]);
  listImportSessions.mockResolvedValue([SESSION]);
  listImportBatches.mockResolvedValue([] as ImportBatch[]);
  listOverrides.mockResolvedValue([] as FieldOverride[]);
  fetchReviewReadiness.mockImplementation(async () => readinessNow());
  listNeedLineLineage.mockResolvedValue({ needLines: [] as NeedLine[], sources: [] as NeedLineSourceLink[] });
  listBeneficiaryColumns.mockImplementation(async () => columns.map((c) => ({ ...c })));
  listBeneficiaryRegions.mockResolvedValue([]);
  listSourceRecords.mockResolvedValue(RECORDS);
  listDispositions.mockImplementation(async () => persisted.map((d) => ({ ...d })));
  setRecordDisposition.mockImplementation(async (input: Parameters<typeof serverPersists>[0]) => {
    serverPersists(input);
    return { mappingId: `d-${input.targetEntity}`, idempotentReplay: false };
  });
  setBeneficiaryColumns.mockImplementation(async () => {
    columns = columns.map((c) => ({ ...c, decision: 'beneficiary' as const, beneficiaryOrganizationId: HOSPITAL, reviewRequired: false, mappingId: 'm1' }));
    return { confirmed: [] };
  });
  searchCentralItems.mockResolvedValue([ITEM]);
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
});
afterEach(() => cleanup());

// ---- helpers ------------------------------------------------------------------
const step = () => screen.getByTestId('cn2b-simple-workspace').getAttribute('data-step');
const card = () => screen.getByTestId('cn2b-simple-material-card');
const remaining = () => screen.getByTestId('cn2b-simple-material-progress').textContent ?? '';
const REMAINING = (n: number) => `${t('cn2b_simple_remaining', 'en')}: ${n}`;
const lastOrder = (fn: ReturnType<typeof vi.fn>) => Math.max(...fn.mock.invocationCallOrder);

async function openMaterialReview() {
  render(<CentralNeedsScreen />);
  await waitFor(() => expect(step()).toBe('summary'));
  await waitFor(() => expect(listDispositions).toHaveBeenCalledWith(SESSION_ID));
  fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
  await waitFor(() => expect(step()).toBe('review-material'));
}

async function markNotAMaterial(reason = REASON) {
  fireEvent.click(within(card()).getAllByRole('button', { name: t('cn2b_simple_not_a_material', 'en') })[0]);
  fireEvent.change(within(card()).getByLabelText(t('cn2b_beneficiary_column_reason_required', 'en')), { target: { value: reason } });
  fireEvent.click(within(card()).getByRole('button', { name: t('cn2b_simple_confirm_not_a_material', 'en') }));
}

async function mapThroughPicker() {
  fireEvent.click(within(card()).getByRole('button', { name: t('cn2b_simple_choose_material', 'en') }));
  fireEvent.change(within(card()).getByLabelText(t('cn2b_simple_search_material', 'en')), { target: { value: 'C6B1' } });
  const option = await within(card()).findByRole('button', { name: new RegExp(ITEM.name) });
  fireEvent.click(option);
}

// ==============================================================================
describe('C6-B1 — a confirmed Simple material decision re-reads the server, and only that re-read advances the queue', () => {
  it('B1-1 success: dispositions and readiness are re-read after the write; A leaves, B is shown, Remaining 2 → 1; then B empties the queue', async () => {
    await openMaterialReview();
    expect(card()).toHaveTextContent('ALPHA evidence row');
    expect(remaining()).toContain(REMAINING(2));
    const recordReads = listSourceRecords.mock.calls.length;
    const dispositionReads = listDispositions.mock.calls.length;
    const readinessReads = fetchReviewReadiness.mock.calls.length;

    await markNotAMaterial();
    await waitFor(() => expect(card()).toHaveTextContent('BETA evidence row'));

    // 1. the canonical write, exactly once, exactly as intended
    expect(setRecordDisposition).toHaveBeenCalledTimes(1);
    expect(setRecordDisposition).toHaveBeenCalledWith({
      importSessionId: SESSION_ID, targetEntity: ROW_A, decision: 'not_applicable', decisionReason: REASON,
    });
    // 2. the active session's dispositions were read AFTER the successful write
    expect(listDispositions.mock.calls.length).toBeGreaterThan(dispositionReads);
    expect(listDispositions.mock.calls.at(-1)).toEqual([SESSION_ID]);
    expect(lastOrder(listDispositions)).toBeGreaterThan(lastOrder(setRecordDisposition));
    // 3. readiness was re-read after the write, for the revision
    expect(fetchReviewReadiness.mock.calls.length).toBeGreaterThan(readinessReads);
    expect(fetchReviewReadiness.mock.calls.at(-1)).toEqual([REV]);
    expect(lastOrder(fetchReviewReadiness)).toBeGreaterThan(lastOrder(setRecordDisposition));
    // 4–6. A left the queue, B is current, Remaining decreased
    expect(card()).not.toHaveTextContent('ALPHA evidence row');
    expect(remaining()).toContain(REMAINING(1));
    // the next card starts fresh — A's reason form does not carry over to B
    expect(within(card()).queryByLabelText(t('cn2b_beneficiary_column_reason_required', 'en'))).toBeNull();
    // 7. no evidence was re-read or rewritten to manufacture this
    expect(listSourceRecords.mock.calls.length).toBe(recordReads);

    await mapThroughPicker();
    await waitFor(() => expect(step()).toBe('pending'));
    expect(setRecordDisposition).toHaveBeenCalledTimes(2);
    expect(setRecordDisposition).toHaveBeenLastCalledWith({
      importSessionId: SESSION_ID, targetEntity: ROW_B, decision: 'mapped', centralItemId: ITEM.id,
    });
    // the step came from fresh server state: both decisions re-read, readiness now clear
    expect(await listDispositions.mock.results.at(-1)!.value).toEqual([
      expect.objectContaining({ targetEntity: ROW_A, decision: 'not_applicable' }),
      expect.objectContaining({ targetEntity: ROW_B, decision: 'mapped', centralItemId: ITEM.id }),
    ]);
    expect(screen.queryByTestId('cn2b-simple-material-card')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('cn2b-simple-readiness-clear')).toBeInTheDocument());
  });

  it('B1-2 the queue follows the server, not the click: nothing moves while the re-read is in flight; it moves only when the re-read shows the decision', async () => {
    await openMaterialReview();
    const dispositionReads = listDispositions.mock.calls.length;
    let release!: () => void;
    listDispositions.mockImplementationOnce(() => new Promise<RecordDisposition[]>((resolve) => {
      release = () => resolve(persisted.map((d) => ({ ...d })));
    }));
    await markNotAMaterial();
    // The write is confirmed and persisted server-side; the re-read has been issued but has not answered.
    await waitFor(() => expect(listDispositions.mock.calls.length).toBeGreaterThan(dispositionReads));
    expect(persisted.map((d) => d.targetEntity)).toEqual([ROW_A]);
    // Let every client-side update the click could cause render (an optimistic removal would show here).
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(card()).toHaveTextContent('ALPHA evidence row');
    expect(remaining()).toContain(REMAINING(2));
    // Only the server's answer moves the queue.
    await act(async () => { release(); });
    await waitFor(() => expect(card()).toHaveTextContent('BETA evidence row'));
    expect(remaining()).toContain(REMAINING(1));
  });

  it('B1-2b if the server re-read does not show the decision, nothing is removed', async () => {
    setRecordDisposition.mockImplementation(async () => ({ mappingId: 'x', idempotentReplay: false })); // acknowledged, not visible
    await openMaterialReview();
    const dispositionReads = listDispositions.mock.calls.length;
    let release!: () => void;
    listDispositions.mockImplementationOnce(() => new Promise<RecordDisposition[]>((resolve) => { release = () => resolve([]); }));
    await markNotAMaterial();
    await waitFor(() => expect(listDispositions.mock.calls.length).toBeGreaterThan(dispositionReads));
    expect(card()).toHaveTextContent('ALPHA evidence row');
    expect(remaining()).toContain(REMAINING(2));
    await act(async () => { release(); });
    expect(card()).toHaveTextContent('ALPHA evidence row');
    expect(remaining()).toContain(REMAINING(2));
  });

  it('B1-3 a refused write removes nothing, decrements nothing, and goes through the existing refusal path', async () => {
    setRecordDisposition.mockRejectedValue(centralNeedsErrorFromPostgrest({ message: 'plan_revision_not_editable', code: '23514' }));
    await openMaterialReview();
    const dispositionReads = listDispositions.mock.calls.length;
    const registryReads = listPlanRevisions.mock.calls.length;
    await markNotAMaterial();
    await waitFor(() => expect(within(card()).getByRole('alert')).toBeInTheDocument());
    // existing refusal handling: a lifecycle-moved refusal re-reads the registry
    await waitFor(() => expect(listPlanRevisions.mock.calls.length).toBeGreaterThan(registryReads));
    expect(card()).toHaveTextContent('ALPHA evidence row');
    expect(remaining()).toContain(REMAINING(2));
    expect(listDispositions.mock.calls.length).toBe(dispositionReads);
    expect(persisted).toEqual([]);
  });

  it('B1-4 a failed re-read after a CONFIRMED write is reported as a re-read problem, never as a failed write', async () => {
    await openMaterialReview();
    listDispositions.mockRejectedValue(new Error('network down'));
    await markNotAMaterial();
    await waitFor(() => expect(screen.getByTestId('cn2b-simple-error')).toHaveTextContent(t('cn2b_err_state_reread_failed', 'en')));
    expect(setRecordDisposition).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('cn2b-simple-error')).not.toHaveTextContent(t('cn2b_err_disposition_failed', 'en'));
    expect(within(card()).queryByRole('alert')).toBeNull(); // the card's write did not fail
  });

  it("B1-5 a 'mapped' decision also re-reads the revision-wide beneficiary columns, so newly required institution review is routed to", async () => {
    await openMaterialReview();
    const columnReads = listBeneficiaryColumns.mock.calls.length;
    setRecordDisposition.mockImplementation(async (input: Parameters<typeof serverPersists>[0]) => {
      serverPersists(input);
      columns = [COLUMN_TO_REVIEW]; // M217: an undecided numeric column on a now-mapped row requires review
      return { mappingId: 'x', idempotentReplay: false };
    });
    await mapThroughPicker();
    await waitFor(() => expect(step()).toBe('review-institution'));
    expect(listBeneficiaryColumns.mock.calls.length).toBeGreaterThan(columnReads);
    expect(lastOrder(listBeneficiaryColumns)).toBeGreaterThan(lastOrder(setRecordDisposition));
    expect(screen.getByTestId('cn2b-simple-institution-evidence')).toHaveTextContent('C6B1 Hospital');
  });

  it('B1-6 an institution decision keeps the revision refresh and does not re-read dispositions', async () => {
    columns = [COLUMN_TO_REVIEW];
    render(<CentralNeedsScreen />);
    await waitFor(() => expect(step()).toBe('summary'));
    await waitFor(() => expect(listDispositions).toHaveBeenCalledWith(SESSION_ID));
    fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
    await waitFor(() => expect(step()).toBe('review-institution'));
    const dispositionReads = listDispositions.mock.calls.length;
    const sessionReads = listImportSessions.mock.calls.length;
    const columnReads = listBeneficiaryColumns.mock.calls.length;
    fireEvent.click(within(screen.getByTestId('cn2b-simple-institution-card')).getByRole('button', { name: t('cn2b_simple_correct', 'en') }));
    await waitFor(() => expect(step()).toBe('review-material'));
    expect(setBeneficiaryColumns).toHaveBeenCalledTimes(1);
    expect(listImportSessions.mock.calls.length).toBeGreaterThan(sessionReads);
    expect(listBeneficiaryColumns.mock.calls.length).toBeGreaterThan(columnReads);
    expect(listDispositions.mock.calls.length).toBe(dispositionReads);
  });
});
