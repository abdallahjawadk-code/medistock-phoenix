/** @vitest-environment jsdom */
/**
 * E1.1 — the registered original source stays reachable from Simple Mode, and
 * it is an AUXILIARY surface, never a second task card.
 *
 * Two levels, both with the REAL StoredWorkbookPanel (wrapped only to log its
 * mount/unmount lifecycle):
 *   * the REAL CentralNeedsScreen, service boundary mocked, for the product
 *     flows — upload → verify → pendingFile cleared → preview.reset(), and a
 *     fresh mount (refresh / login) with preview idle and a registered batch;
 *   * CentralNeedsSimpleWorkspace directly, for every Simple step, the
 *     ONE-task-card invariant and revision-scoped remounting.
 *
 * The preview Worker is replaced by one that replies with a REAL parse result
 * of a real workbook; the real worker/parser path of reopening itself is
 * proven in stored-workbook-panel.runtime.test.tsx.
 */
import '@testing-library/jest-dom/vitest';
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as XLSX from 'xlsx';
import type {
  BeneficiaryColumnSummary, FieldOverride, ImportBatch, ImportSession, NeedLine, NeedLineSourceLink,
  PlanRevision, RecordDisposition, ReviewReadiness, SourceRecord,
} from '../../central-needs.service';
import type { FileParseResult } from '../../import/contract';
import type { PreviewState } from '../../useCentralNeedsPreview';

const { svc, writes, panelLifecycle, backendAccess, workerMessages } = vi.hoisted(() => ({
  svc: {
    listPlanRevisions: vi.fn(),
    listImportSessions: vi.fn(),
    listImportBatches: vi.fn(),
    listOverrides: vi.fn(),
    fetchReviewReadiness: vi.fn(),
    listNeedLineLineage: vi.fn(),
    listBeneficiaryColumns: vi.fn(),
    listSourceRecords: vi.fn(),
    listDispositions: vi.fn(),
    requestUploadTicket: vi.fn(),
    uploadToStaging: vi.fn(),
    finalizeImport: vi.fn(),
    requestSourceDownload: vi.fn(),
    /** E2-A: the read-only batch-entry query the panel makes after a verified parse. */
    listBatchEntries: vi.fn(),
    getOrganizations: vi.fn(),
  },
  writes: {
    setBeneficiaryColumns: vi.fn(),
    setRecordDisposition: vi.fn(),
    recordFieldOverride: vi.fn(),
  },
  panelLifecycle: [] as string[],
  backendAccess: [] as string[],
  workerMessages: [] as string[],
}));

interface AppState {
  lang: 'ar' | 'en';
  dir: 'rtl' | 'ltr';
  activeOrgId: string | null;
  profile: { organization_id: string | null } | null;
  myPermissions: Set<string>;
}

const ORG = 'org-1';
const appState: AppState = {
  lang: 'ar', dir: 'rtl', activeOrgId: ORG,
  profile: { organization_id: ORG },
  myPermissions: new Set(['central_needs.import', 'central_needs.edit', 'central_needs.approve']),
};

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('@/shared/supabase/services/organizations.service', () => ({ getOrganizations: () => svc.getOrganizations() }));
vi.mock('@/shared/supabase/services/warehouses.service', () => ({ getWarehouses: async () => [] }));
vi.mock('@/shared/supabase/client', () => ({
  supabase: new Proxy({}, {
    get: (_target, prop) => {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      backendAccess.push(String(prop));
      return undefined;
    },
  }),
}));
vi.mock('../../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../../central-needs.service')>('../../central-needs.service');
  return {
    ...actual,
    ...svc,
    ...writes,
    searchCentralItems: vi.fn(async () => []),
    searchBatchEntries: vi.fn(async () => []),
    searchSourceFiles: vi.fn(async () => []),
  };
});
vi.mock('../StoredWorkbookPanel', async () => {
  const actual = await vi.importActual<typeof import('../StoredWorkbookPanel')>('../StoredWorkbookPanel');
  const { useEffect, useRef } = await import('react');
  /** The REAL panel, observed: each instance logs its mount and unmount with its first batch id. */
  function ObservedStoredWorkbookPanel(props: Parameters<typeof actual.StoredWorkbookPanel>[0]) {
    const identity = useRef(props.batches[0]?.id ?? '');
    useEffect(() => {
      const id = identity.current;
      panelLifecycle.push(`mount:${id}`);
      return () => { panelLifecycle.push(`unmount:${id}`); };
    }, []);
    return <actual.StoredWorkbookPanel {...props} />;
  }
  return { StoredWorkbookPanel: ObservedStoredWorkbookPanel };
});

const { CentralNeedsScreen } = await import('../../CentralNeedsScreen');
const { CentralNeedsSimpleWorkspace } = await import('../CentralNeedsSimpleWorkspace');
const { parseWorkbookBytes } = await import('../../import/parser-core');

const REV = 'rev-1';
const SESSION_ID = 's1';
const ROW = 'sheet:0:row:2';
const SIGNED_URL = 'https://storage.example.invalid/storage/v1/object/sign/central-needs-sources/opaque?token=signed';

const REVISION: PlanRevision = { id: REV, planId: 'plan-1', organizationId: ORG, planYear: 2027, revisionNumber: 1, status: 'draft' };
const SESSION: ImportSession = {
  id: SESSION_ID, planRevisionId: REV, sourceFileId: 'f1', status: 'completed',
  previewDigest: 'digest', authoritativeDigest: 'digest', parserIdentity: null,
  startedAt: '2026-09-19T00:00:00.000Z', completedAt: '2026-09-19T00:00:01.000Z', notes: null,
};
const READINESS = {
  planRevisionId: REV, status: 'draft', ready: false,
  blockers: [{ blocker: 'target_entity_without_disposition', detail: ROW }],
} as unknown as ReviewReadiness;
const RECORD: SourceRecord = {
  id: 'rec-1', importSessionId: SESSION_ID, recordOrdinal: 1, targetEntity: ROW, fieldName: 'المادة',
  sourceValues: { value: 'باراسيتامول 500 mg' }, sourceProvenance: { sheetIndex: 0, coordinate: { col: 2 } },
};
const DISPOSITION: RecordDisposition = {
  id: 'd1', importSessionId: SESSION_ID, targetEntity: ROW,
  decision: 'mapped', centralItemId: 'item-1', decisionReason: null, decidedAt: '2026-09-19T00:00:00.000Z',
};

let workbook: Uint8Array<ArrayBuffer>;
let parsed: FileParseResult;
let BATCH: ImportBatch;

/** The preview Worker, replying with a REAL parse result of the real workbook below. */
class ReplyingWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(message: { requestId: string; filename: string }) {
    workerMessages.push(message.filename);
    queueMicrotask(() => this.onmessage?.({ data: { type: 'result', requestId: message.requestId, result: parsed } } as MessageEvent));
  }
  terminate() {}
}

beforeAll(async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['الرمز', 'المادة', 'الكمية'], ['X-001', 'باراسيتامول 500 mg', 120]]), 'المجرد');
  workbook = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  parsed = await parseWorkbookBytes(workbook, 'need-2027.xlsx', { runtime: 'browser_worker' });
  BATCH = {
    id: 'b1', planRevisionId: REV, containerKind: 'file', containerFilename: 'need-2027.xlsx',
    containerSha256: createHash('sha256').update(workbook).digest('hex'),
    acceptedEntryCount: 1, excludedEntryCount: 0, registeredAt: '2026-09-19T00:00:00.000Z',
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  panelLifecycle.length = 0;
  backendAccess.length = 0;
  workerMessages.length = 0;
  vi.stubGlobal('Worker', ReplyingWorker);
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const taskCards = (root: ParentNode = document) => root.querySelectorAll('.cn2b-simple-card');
const panel = () => screen.getByTestId('cn2b-stored-workbook-panel');
const stepOf = () => screen.getByTestId('cn2b-simple-workspace').getAttribute('data-step');

/** The stored-source control is present, auxiliary, and the page still has exactly ONE task card. */
function expectAuxiliaryPanelBesideOneTaskCard() {
  expect(panel()).toBeInTheDocument();
  expect(panel()).toHaveClass('cn2b-stored-workbook');
  expect(panel()).not.toHaveClass('cn2b-simple-card');
  expect(panel().closest('.cn2b-simple-card')).toBeNull();
  expect(panel().querySelectorAll('.cn2b-simple-card')).toHaveLength(0);
  expect(taskCards()).toHaveLength(1);
  expect(screen.getByTestId('cn2b-stored-workbook-open')).not.toBeDisabled();
}

function expectNoBusinessWrite() {
  expect(writes.setBeneficiaryColumns).not.toHaveBeenCalled();
  expect(writes.setRecordDisposition).not.toHaveBeenCalled();
  expect(writes.recordFieldOverride).not.toHaveBeenCalled();
  expect(backendAccess).toEqual([]);
}

function loadScreen(state: { sessions: ImportSession[]; batches: ImportBatch[] }) {
  svc.listPlanRevisions.mockResolvedValue([REVISION]);
  svc.listImportSessions.mockResolvedValue(state.sessions);
  svc.listImportBatches.mockResolvedValue(state.batches);
  svc.listOverrides.mockResolvedValue([] as FieldOverride[]);
  svc.fetchReviewReadiness.mockResolvedValue(READINESS);
  svc.listNeedLineLineage.mockResolvedValue({ needLines: [] as NeedLine[], sources: [] as NeedLineSourceLink[] });
  svc.listBeneficiaryColumns.mockResolvedValue([] as BeneficiaryColumnSummary[]);
  svc.listSourceRecords.mockResolvedValue([RECORD]);
  svc.listDispositions.mockResolvedValue([] as RecordDisposition[]);
  svc.getOrganizations.mockResolvedValue([]);
  svc.listBatchEntries.mockResolvedValue([]);
}

describe('E1.1 — the real screen: the stored source survives import, reset and refresh', () => {
  it('upload → verify → pendingFile cleared → preview.reset(): the stored-source control is there afterwards', async () => {
    loadScreen({ sessions: [], batches: [] });
    const { container } = render(<CentralNeedsScreen />);
    await waitFor(() => expect(screen.getByTestId('cn2b-simple-file-input')).toBeInTheDocument());
    expect(stepOf()).toBe('upload');
    expect(screen.queryByTestId('cn2b-stored-workbook-panel')).toBeNull();

    // Pick the file: the SAME preview hook parses it, the E1 viewer shows it in the upload card.
    const file = new File([workbook], BATCH.containerFilename, { type: 'application/octet-stream' });
    fireEvent.change(screen.getByTestId('cn2b-simple-file-input'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('cn2b-simple-upload-submit')).not.toBeDisabled());
    expect(screen.getByTestId('cn2b-xl-viewer')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-simple-picked-file')).toBeInTheDocument();

    // Verify: the existing import path, then the screen reloads the revision it registered.
    svc.requestUploadTicket.mockResolvedValue({ uploadId: 'u1', source: { path: 'p', token: 't' }, preview: { path: 'p2', token: 't2' } });
    svc.uploadToStaging.mockResolvedValue(undefined);
    svc.finalizeImport.mockResolvedValue({ batchId: BATCH.id, idempotentReplay: false, acceptedEntryCount: 1, excludedEntryCount: 0, importSessionIds: [SESSION_ID] });
    svc.listImportSessions.mockResolvedValue([SESSION]);
    svc.listImportBatches.mockResolvedValue([BATCH]);
    fireEvent.click(screen.getByTestId('cn2b-simple-upload-submit'));

    await waitFor(() => expect(stepOf()).toBe('summary'));
    expect(svc.finalizeImport).toHaveBeenCalledTimes(1);
    expect(svc.finalizeImport).toHaveBeenCalledWith({ planRevisionId: REV, uploadId: 'u1', containerKind: 'file' });

    // pendingFile cleared and preview reset: no picked file, no preview viewer …
    expect(screen.queryByTestId('cn2b-simple-picked-file')).toBeNull();
    expect(screen.queryByTestId('cn2b-xl-viewer')).toBeNull();
    // … and the registered original is still one click away, beside ONE task card.
    expectAuxiliaryPanelBesideOneTaskCard();
    expect(screen.getByTestId('cn2b-stored-workbook-filename')).toHaveTextContent(BATCH.containerFilename);
    expect(taskCards(container)).toHaveLength(1);
    // Mounting the control downloads nothing.
    expect(svc.requestSourceDownload).not.toHaveBeenCalled();
    expectNoBusinessWrite();
  });

  it('a fresh mount (refresh / login) with preview idle and a registered batch reopens the original workbook', async () => {
    loadScreen({ sessions: [SESSION], batches: [BATCH] });
    svc.requestSourceDownload.mockResolvedValue({
      url: SIGNED_URL, originalFilename: BATCH.containerFilename,
      containerKind: BATCH.containerKind, containerSha256: BATCH.containerSha256,
    });
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== SIGNED_URL) throw new Error(`unexpected network call: ${String(input)}`);
      return new Response(workbook.slice().buffer as ArrayBuffer, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchStub);

    render(<CentralNeedsScreen />);
    await waitFor(() => expect(stepOf()).toBe('summary'));
    expect(screen.queryByTestId('cn2b-simple-picked-file')).toBeNull();
    expectAuxiliaryPanelBesideOneTaskCard();

    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
    await waitFor(() => expect(within(panel()).getByTestId('cn2b-xl-viewer')).toBeInTheDocument());

    expect(svc.requestSourceDownload).toHaveBeenCalledTimes(1);
    expect(svc.requestSourceDownload).toHaveBeenCalledWith(BATCH.id);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(workerMessages).toEqual([BATCH.containerFilename]);
    expect(within(panel()).getByTestId('cn2b-stored-workbook-integrity-ok')).toBeInTheDocument();
    // Opening the viewer adds no task card and changes no step.
    expect(taskCards()).toHaveLength(1);
    expect(stepOf()).toBe('summary');
    expect(svc.finalizeImport).not.toHaveBeenCalled();
    expectNoBusinessWrite();
  });
});

type WorkspaceProps = Parameters<typeof CentralNeedsSimpleWorkspace>[0];
const IDLE: PreviewState = { phase: 'idle' };

const bcol = (over: Partial<BeneficiaryColumnSummary> = {}): BeneficiaryColumnSummary => ({
  importSessionId: SESSION_ID, originalFilename: 'need-2027.xlsx', archiveEntryPath: null,
  sheetIndex: 0, sheetName: 'المجرد', columnIndex: 3, sourceFieldName: 'مستشفى الحلة التعليمي',
  numericValueCount: 1, zeroValueCount: 0, nonzeroNumericCount: 1, mappingId: null, decision: null,
  beneficiaryOrganizationId: null, mappingReason: null, mappedAt: null, mappedRowNumericCount: 1,
  reviewRequired: true, ...over,
});

function propsOf(over: Partial<WorkspaceProps> = {}): WorkspaceProps {
  return {
    lang: 'ar', planYear: 2027, onPlanYearChange: () => {}, revisionsLoading: false,
    revision: REVISION, isDraft: true, revisionDataReady: true, canImport: true, canEdit: true,
    busy: false, activity: null, onOpenRevision: () => {}, preview: IDLE, pendingFile: null,
    onPickFile: () => {}, onVerify: () => {}, error: null, notice: null, readiness: READINESS,
    batches: [BATCH], beneficiaryColumns: [], careInstitutions: [], records: [], dispositions: [],
    activeSessionId: SESSION_ID, onChanged: () => {}, onSwitchToAdvanced: () => {},
    ...over,
  };
}

function renderWorkspace(over: Partial<WorkspaceProps> = {}) {
  const view = render(<CentralNeedsSimpleWorkspace {...propsOf(over)} />);
  return {
    ...view,
    rerenderWith: (next: Partial<WorkspaceProps>) =>
      view.rerender(<CentralNeedsSimpleWorkspace {...propsOf({ ...over, ...next })} />),
  };
}

describe('E1.1 — Simple workspace: persistent, auxiliary, revision-scoped', () => {
  it('shows the control with preview idle and no pending file — and not before a registered batch exists', () => {
    const view = renderWorkspace({ preview: IDLE, pendingFile: null });
    expect(panel()).toBeInTheDocument();

    view.rerenderWith({ batches: [] });
    expect(screen.queryByTestId('cn2b-stored-workbook-panel')).toBeNull();
    view.rerenderWith({ revisionDataReady: false });
    expect(screen.queryByTestId('cn2b-stored-workbook-panel')).toBeNull();
    view.rerenderWith({ revision: null });
    expect(screen.queryByTestId('cn2b-stored-workbook-panel')).toBeNull();
    view.rerenderWith({ batches: undefined });
    expect(screen.queryByTestId('cn2b-stored-workbook-panel')).toBeNull();
  });

  it('summary → analyzing → institution → material → pending: the control stays, beside exactly ONE task card', async () => {
    const view = renderWorkspace({ beneficiaryColumns: [bcol()], records: [RECORD], dispositions: [] });
    expect(stepOf()).toBe('summary');
    expectAuxiliaryPanelBesideOneTaskCard();

    view.rerenderWith({ beneficiaryColumns: [bcol()], records: [RECORD], dispositions: [], busy: true });
    expect(stepOf()).toBe('analyzing');
    expectAuxiliaryPanelBesideOneTaskCard();
    view.rerenderWith({ beneficiaryColumns: [bcol()], records: [RECORD], dispositions: [], busy: false });
    expect(stepOf()).toBe('summary');

    fireEvent.click(screen.getByTestId('cn2b-simple-review-start'));
    expect(stepOf()).toBe('review-institution');
    expect(screen.getByTestId('cn2b-simple-institution-card')).toBeInTheDocument();
    expectAuxiliaryPanelBesideOneTaskCard();

    view.rerenderWith({ beneficiaryColumns: [bcol({ reviewRequired: false })], records: [RECORD], dispositions: [] });
    expect(stepOf()).toBe('review-material');
    await waitFor(() => expect(screen.getByTestId('cn2b-simple-material-card')).toBeInTheDocument());
    expectAuxiliaryPanelBesideOneTaskCard();

    view.rerenderWith({ beneficiaryColumns: [bcol({ reviewRequired: false })], records: [RECORD], dispositions: [DISPOSITION] });
    expect(stepOf()).toBe('pending');
    expect(screen.getByTestId('cn2b-simple-pending')).toBeInTheDocument();
    expectAuxiliaryPanelBesideOneTaskCard();

    // One instance throughout: moving between steps never remounted it.
    expect(panelLifecycle).toEqual([`mount:${BATCH.id}`]);
    expect(svc.requestSourceDownload).not.toHaveBeenCalled();
    expectNoBusinessWrite();
  });

  it('a revision switch destroys the panel instance; a new batch in the SAME revision does not', () => {
    const view = renderWorkspace();
    expect(panelLifecycle).toEqual([`mount:${BATCH.id}`]);

    // Same revision, a newly finalized batch: same instance, the newest batch is the default.
    const newer: ImportBatch = { ...BATCH, id: 'b1-new', containerFilename: 'need-2027-corrected.xlsx', registeredAt: '2026-09-19T01:00:00.000Z' };
    view.rerenderWith({ batches: [BATCH, newer] });
    expect(panelLifecycle).toEqual([`mount:${BATCH.id}`]);
    expect(screen.getByTestId('cn2b-stored-workbook-filename')).toHaveTextContent(newer.containerFilename);

    // Another revision: the old instance (and any transient source state it held) is destroyed.
    const rev2: PlanRevision = { ...REVISION, id: 'rev-2', revisionNumber: 2 };
    const rev2Batch: ImportBatch = { ...BATCH, id: 'b2', planRevisionId: 'rev-2', containerFilename: 'need-2027-rev2.xlsx' };
    view.rerenderWith({ revision: rev2, batches: [rev2Batch] });
    expect(panelLifecycle).toEqual([`mount:${BATCH.id}`, `unmount:${BATCH.id}`, 'mount:b2']);
    expect(screen.getByTestId('cn2b-stored-workbook-filename')).toHaveTextContent(rev2Batch.containerFilename);

    // A revision with no registered source shows no control at all.
    view.rerenderWith({ revision: { ...REVISION, id: 'rev-3' }, batches: [] });
    expect(panelLifecycle).toEqual([`mount:${BATCH.id}`, `unmount:${BATCH.id}`, 'mount:b2', 'unmount:b2']);
    expect(screen.queryByTestId('cn2b-stored-workbook-panel')).toBeNull();
  });
});
