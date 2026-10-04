/** @vitest-environment jsdom */
/**
 * CN-UI-S1 HC1.1 — through the REAL `CentralNeedsScreen` (Simple, its default).
 *
 *   HC1.1-A  every M217 quantity-lineage reason is classified: the expert ones
 *            offer the contextual escape to the stage that resolves them, the
 *            Simple-resolvable ones offer NONE — and the Simple remedy for those
 *            is shown to be REAL (the canonical need-line panel actually does it),
 *            not assumed (H1_1_01 … H1_1_09).
 *   HC1.1-B/C the expert escape against in-memory Stored Workbook mapping work and
 *            a beneficiary-region write in flight (H1_1_23 … H1_1_30), over the
 *            REAL trusted stored source, viewer, grid and mapping state.
 *
 * Mocked: `useApp`, the service boundary (read/write functions, recorded), the
 * organization/warehouse reads and the transport of the stored source (fetch,
 * the entry-row query, the Worker thread). The Supabase client throws on any
 * OTHER direct call, and every attempt is recorded.
 */
import '@testing-library/jest-dom/vitest';
import { createHash } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as XLSX from 'xlsx';
import { T } from '@/shared/i18n/strings';
import type {
  BeneficiaryColumnSummary, FieldOverride, ImportBatch, ImportSession, NeedLine, NeedLineSourceLink,
  PlanRevision, RecordDisposition, ReviewReadiness, RevisionStatus, SourceRecord,
} from '../central-needs.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';

interface EntryRow {
  id: string; batch_id: string; entry_ordinal: number; archive_entry_path: string | null; entry_sha256: string; import_session_id: string;
}
const { directBackend, entriesDb } = vi.hoisted(() => ({
  directBackend: [] as string[],
  entriesDb: { rows: [] as EntryRow[] },
}));

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
  listScopeColumnMappings: vi.fn(),
  listSourceRecords: vi.fn(),
  listDispositions: vi.fn(),
  searchCentralItems: vi.fn(),
  setNeedLine: vi.fn(),
  deleteNeedLine: vi.fn(),
  setRecordDisposition: vi.fn(),
  setBeneficiaryColumns: vi.fn(),
  setBeneficiaryRegions: vi.fn(),
  recordFieldOverride: vi.fn(),
  submitRevision: vi.fn(),
  approveRevision: vi.fn(),
  rejectRevision: vi.fn(),
  openPlanRevision: vi.fn(),
  openCorrectionRevision: vi.fn(),
};

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('@/shared/supabase/client', () => {
  const entriesQuery = (table: string) => {
    if (table !== 'central_needs_import_batch_entries') {
      directBackend.push(`from:${table}`);
      throw new Error('no direct table read may run');
    }
    let batchFilter = '';
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (column: string, value: unknown) => { if (column === 'batch_id') batchFilter = String(value); return chain; },
      order: () => chain,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: entriesDb.rows.filter((r) => r.batch_id === batchFilter), error: null }).then(resolve, reject),
    };
    return chain;
  };
  return {
    supabase: {
      auth: { getSession: async () => ({ data: { session: { access_token: 'hc11-test-token' } } }) },
      from: entriesQuery,
      rpc: (name: string) => { directBackend.push(`rpc:${name}`); throw new Error('no direct RPC may run'); },
    },
  };
});
vi.mock('@/shared/supabase/services/organizations.service', () => ({ getOrganizations: async () => ORGS }));
vi.mock('@/shared/supabase/services/warehouses.service', () => ({ getWarehouses: async () => [] }));
vi.mock('../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../central-needs.service')>('../central-needs.service');
  const forwarded = Object.fromEntries(Object.entries(svc).map(([name, fn]) => [name, (...a: unknown[]) => fn(...a)]));
  return {
    ...actual,
    ...forwarded,
    searchBatchEntries: vi.fn(async () => []),
    searchSourceFiles: vi.fn(async () => []),
  };
});

const workerScope: {
  onmessage: ((event: { data: unknown }) => unknown) | null;
  postMessage: (data: unknown) => void;
  location: Location;
} = {
  onmessage: null,
  postMessage: () => { throw new Error('the worker replied with no Worker listening'); },
  location: globalThis.location,
};
class InProcessWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private terminated = false;
  postMessage(data: { type: string }) {
    workerScope.postMessage = (reply) => { if (!this.terminated) this.onmessage?.({ data: reply } as MessageEvent); };
    void workerScope.onmessage?.({ data });
  }
  terminate() { this.terminated = true; }
}
function stubWorkerRealm() {
  vi.stubGlobal('Worker', InProcessWorker);
  vi.stubGlobal('self', workerScope);
  vi.stubGlobal('Blob', NodeBlob);
}
stubWorkerRealm();
await import('../import/worker');
const { CentralNeedsScreen } = await import('../CentralNeedsScreen');
const { RUNNING_PARSER_IDENTITY } = await import('../regions/beneficiaryRegions');

// The real viewer and Worker parse a workbook per test; under a loaded full-suite run the default 5 s bound is too tight.
vi.setConfig({ testTimeout: 30_000 });

const ORGS = [
  { id: BENE, name: 'Beneficiary Hospital', name_ar: 'مستشفى المنتفع', code: 'b1', status: 'active', organizationKind: 'care_institution' },
] as unknown as OrgRow[];

// ---- the stored source ---------------------------------------------------------
const ENDPOINT = '/api/central-needs/source-download';
const SIGNED_URL = 'https://storage.example.invalid/storage/v1/object/sign/central-needs-sources/opaque?token=signed';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const exactBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
function workbookBytes(): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['National Code', 'Material', 'مستشفى الأمل', 'مستوصف النور'],
      ['0012345', 'Paracetamol', 3, null],
      ['0067890', 'Ibuprofen', null, 5],
    ]),
    'Sheet1',
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['other', 1]]), 'Other');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}
const BYTES = workbookBytes();
const BATCH: ImportBatch = {
  id: 'batch-1', planRevisionId: REV, containerKind: 'file', containerFilename: 'needs.xlsx',
  containerSha256: sha256(BYTES), acceptedEntryCount: 1, excludedEntryCount: 0, registeredAt: '2026-09-21T00:00:00.000Z',
};
const fetchStub = vi.fn();
function stubNetwork() {
  fetchStub.mockReset().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === ENDPOINT) {
      const { batchId } = JSON.parse(String(init?.body)) as { batchId: string };
      return new Response(JSON.stringify({
        ok: true, url: `${SIGNED_URL}&b=${batchId}`, expiresInSeconds: 60, containerKind: 'file',
        containerSha256: sha256(BYTES), originalFilename: 'needs.xlsx',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith(SIGNED_URL)) return new Response(exactBuffer(BYTES), { status: 200 });
    throw new Error(`HC1.1 made an unexpected network call: ${url}`);
  });
  vi.stubGlobal('fetch', fetchStub);
}

// ---- the mocked server's own state ---------------------------------------------
const session = (id: string, startedAt: string): ImportSession => ({
  id, planRevisionId: REV, sourceFileId: `f-${id}`, status: 'completed', previewDigest: 'd', authoritativeDigest: 'd',
  // s1's parser identity is this build's own: the G3 guarantee that lets the region layer write.
  parserIdentity: id === 's1' ? { ...RUNNING_PARSER_IDENTITY, runtime: 'node' } : null,
  startedAt, completedAt: startedAt, notes: null,
});
const SESSIONS = [session('s1', '2026-01-01T00:00:00.000Z'), session('s2', '2026-01-02T00:00:00.000Z')];
const envelope = (value: unknown) => ({ value, valueType: typeof value === 'number' ? 'number' : 'string', isFormula: false, formula: null });
const recordsFor = (qty: unknown): Record<string, SourceRecord[]> => ({
  s1: [{
    id: 'rec-5', importSessionId: 's1', recordOrdinal: 1, targetEntity: ROW_5, fieldName: 'qty',
    sourceValues: envelope(qty), sourceProvenance: { sheetIndex: 0, coordinate: { row: 5, col: 2, a1: 'C6' } },
  }],
  s2: [{
    id: 'rec-9', importSessionId: 's2', recordOrdinal: 1, targetEntity: ROW_9, fieldName: 'Item',
    sourceValues: envelope('Amoxicillin'), sourceProvenance: { sheetIndex: 0, coordinate: { row: 9, col: 1, a1: 'B10' } },
  }],
});
const MAPPED_ROW_5: RecordDisposition = {
  id: 'd-5', importSessionId: 's1', targetEntity: ROW_5, decision: 'mapped', centralItemId: ITEM,
  decisionReason: null, decidedAt: '2026-01-01T00:00:00.000Z',
};
const M213_COLUMN: BeneficiaryColumnSummary = {
  importSessionId: 's1', originalFilename: 'need-2026.xlsx', archiveEntryPath: null, sheetIndex: 0, sheetName: null,
  columnIndex: 2, sourceFieldName: null, numericValueCount: 1, zeroValueCount: 0, nonzeroNumericCount: 1,
  mappingId: 'bc-2', decision: 'beneficiary', beneficiaryOrganizationId: BENE, mappingReason: 'confirmed',
  mappedAt: '2026-01-01T00:00:00.000Z', mappedRowNumericCount: 1, reviewRequired: false,
};

const status: RevisionStatus = 'draft';
let blockersOverride: ReviewReadiness['blockers'] | null = null;
let records = recordsFor(12);
let lineage: { needLines: NeedLine[]; sources: NeedLineSourceLink[] } = { needLines: [], sources: [] };
let overrides: FieldOverride[] = [];
const revision = (): PlanRevision => ({ id: REV, planId: 'plan-1', organizationId: ORG, planYear: 2026, revisionNumber: 1, status });
const readinessNow = (): ReviewReadiness => ({
  planRevisionId: REV, status, ready: false,
  blockers: blockersOverride ?? [{ blocker: 'mapped_target_entity_without_need_line', detail: `session=s1 target_entity=${ROW_5}` }],
});

beforeEach(() => {
  vi.clearAllMocks();
  stubWorkerRealm();
  stubNetwork();
  appState.lang = 'en';
  appState.dir = 'ltr';
  appState.myPermissions = new Set(['central_needs.view', 'central_needs.import', 'central_needs.edit', 'central_needs.approve']);
  blockersOverride = null;
  records = recordsFor(12);
  lineage = { needLines: [], sources: [] };
  overrides = [];
  directBackend.length = 0;
  entriesDb.rows = [{
    id: 'entry-batch-1', batch_id: 'batch-1', entry_ordinal: 1, archive_entry_path: null, entry_sha256: sha256(BYTES), import_session_id: 's1',
  }];
  svc.listPlanRevisions.mockImplementation(async () => [revision()]);
  svc.listImportSessions.mockResolvedValue(SESSIONS);
  svc.listImportBatches.mockResolvedValue([BATCH]);
  svc.listOverrides.mockImplementation(async () => overrides);
  svc.fetchReviewReadiness.mockImplementation(async () => readinessNow());
  svc.listNeedLineLineage.mockImplementation(async () => ({ needLines: [...lineage.needLines], sources: [...lineage.sources] }));
  svc.listBeneficiaryColumns.mockResolvedValue([M213_COLUMN]);
  svc.listBeneficiaryRegions.mockResolvedValue([]);
  svc.listScopeColumnMappings.mockResolvedValue([]);
  svc.listSourceRecords.mockImplementation(async (id: string) => records[id] ?? []);
  svc.listDispositions.mockImplementation(async (id: string) => (id === 's1' ? [{ ...MAPPED_ROW_5 }] : []));
  svc.searchCentralItems.mockResolvedValue([]);
  svc.setNeedLine.mockResolvedValue({ needLineId: 'nl-new', created: true, sourceLinkCount: 1, addedLinkCount: 1, approvedQuantity: '12' });
  svc.setBeneficiaryRegions.mockResolvedValue({ operationBatchId: 'b', activeVersions: [], changes: [], convertedColumns: [] });
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ---- helpers -------------------------------------------------------------------
const stepOf = () => screen.getByTestId('cn2b-simple-workspace').getAttribute('data-step');
const needLines = () => screen.getByTestId('cn2b-simple-need-lines');
const candidateFor = (fieldName: string) =>
  within(needLines()).getByText(new RegExp(`· ${fieldName}$`)).closest('[data-testid="cn2b-nl-candidate"]') as HTMLElement;
const escapeBlock = () => screen.queryByTestId('cn2b-simple-expert-escape');
const expertButton = () => screen.getByTestId('cn2b-simple-expert-open');
const stages = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('section.cn2b-stage')];
const visibleStages = (container: HTMLElement) => stages(container).filter((s) => !s.hasAttribute('hidden')).map((s) => s.getAttribute('data-stage'));
const stageOf = (container: HTMLElement, id: string) => container.querySelector(`section.cn2b-stage[data-stage="${id}"]`) as HTMLElement;
const modeOf = (container: HTMLElement) => container.querySelector('div.cn2b')?.getAttribute('data-mode');
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });

const READ_FNS = [
  'listPlanRevisions', 'listImportSessions', 'listImportBatches', 'listOverrides', 'fetchReviewReadiness', 'listNeedLineLineage',
  'listBeneficiaryColumns', 'listBeneficiaryRegions', 'listScopeColumnMappings', 'listSourceRecords', 'listDispositions',
] as const;
/** How many times every service READ has run — a presentation-only switch must not move any of them. */
const readCounts = () => READ_FNS.map((name) => svc[name].mock.calls.length);
const WRITE_FNS = [
  'setNeedLine', 'deleteNeedLine', 'setRecordDisposition', 'setBeneficiaryColumns', 'setBeneficiaryRegions', 'recordFieldOverride',
  'submitRevision', 'approveRevision', 'rejectRevision', 'openPlanRevision', 'openCorrectionRevision',
] as const;
const NO_BUSINESS_WRITE = () => { for (const w of WRITE_FNS) expect(svc[w], w).not.toHaveBeenCalled(); };

async function openSimpleAt(step: string) {
  const view = render(<CentralNeedsScreen />);
  await waitFor(() => expect(stepOf()).toBe(step));
  return view;
}

const lineageDetail = (reason: string | null) =>
  `session=s1 source_record=rec-5 need_line=nl-1${reason === null ? '' : ` reason=${reason}`}`;
const LINEAGE_BLOCKER = (reason: string | null) => ({ blocker: 'need_line_quantity_lineage_unsafe', detail: lineageDetail(reason) });
const NUMERIC_BLOCKER = LINEAGE_BLOCKER('source_quantity_requires_explicit_numeric_override');

// ==============================================================================
// HC1.1-A — every M217 reason, through the real screen
// ==============================================================================
describe('HC1.1-A · every M217 lineage reason through the REAL screen (H1_1_01 … H1_1_09)', () => {
  const EXPERT: Array<{ id: string; reason: string | null; stage: 'source' | 'review' | 'readiness'; why: string }> = [
    // HC1.2: no in-app control replaces the evidence of a completed import, so invalid IMMUTABLE evidence is a DIAGNOSTIC escape to READINESS.
    { id: 'H1_1_01', reason: 'source_cell_value_contract_invalid', stage: 'readiness', why: 'source_evidence_invalid' },
    { id: 'H1_1_02', reason: 'source_quantity_requires_explicit_numeric_override', stage: 'review', why: 'numeric_override' },
    { id: 'H1_1_04', reason: 'source_quantity_override_value_invalid', stage: 'review', why: 'numeric_override' },
    { id: 'H1_1_06', reason: 'a_future_reason_this_build_has_never_seen', stage: 'readiness', why: 'unknown_lineage_reason' },
    { id: 'H1_1_07', reason: null, stage: 'readiness', why: 'unknown_lineage_reason' },
  ];

  for (const c of EXPERT) {
    it(`${c.id} — ${c.reason ?? 'a missing reason token'} offers the contextual escape and opens exactly the ${c.stage.toUpperCase()} stage, with nothing else painted first`, async () => {
      blockersOverride = [LINEAGE_BLOCKER(c.reason)];
      const { container } = await openSimpleAt('need-lines');
      const block = escapeBlock() as HTMLElement;
      expect(block).toHaveAttribute('data-reason', c.why);
      expect(block).toHaveAttribute('data-stage', c.stage);
      expect(block.closest('.cn2b-simple-card')).toBe(screen.getByTestId('cn2b-simple-pending'));
      expect(screen.getAllByTestId('cn2b-simple-expert-open')).toHaveLength(1);
      const reads = readCounts();

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
      expect(visibleStages(container)).toEqual([c.stage]);
      expect(flips).toEqual([]);
      expect(readCounts()).toEqual(reads);
      NO_BUSINESS_WRITE();
      expect(directBackend.filter((c2) => /set_|delete_|record_|submit|approve|reject|abandon|finalize|upload/.test(c2))).toEqual([]);
    });
  }

  it('H1_1_06/07 — the READINESS stage shows exactly what the server returned for an unknown / missing reason (diagnostic reading, no promise)', async () => {
    blockersOverride = [LINEAGE_BLOCKER('a_future_reason_this_build_has_never_seen')];
    const { container } = await openSimpleAt('need-lines');
    expect(escapeBlock()).toHaveTextContent(T.cn2b_simple_expert_title_unknown.en);
    expect(escapeBlock()).toHaveTextContent(T.cn2b_simple_expert_body_unknown_lineage.en.replace('__STAGE__', T.cn2b_stage_readiness.en));
    fireEvent.click(expertButton());
    await settle();
    expect(visibleStages(container)).toEqual(['readiness']);
    expect(within(stageOf(container, 'readiness')).getAllByText(/need_line_quantity_lineage_unsafe|a_future_reason_this_build_has_never_seen/).length).toBeGreaterThan(0);
  });

  it('H1_1_01 (HC1.2) — the escape for invalid immutable evidence is a diagnosis: it says the evidence cannot be repaired here and promises no replacement, re-import or repair anywhere', async () => {
    blockersOverride = [LINEAGE_BLOCKER('source_cell_value_contract_invalid')];
    await openSimpleAt('need-lines');
    const block = escapeBlock() as HTMLElement;
    expect(block).toHaveTextContent(T.cn2b_simple_expert_title_unknown.en);
    expect(block).toHaveTextContent(T.cn2b_simple_expert_body_source_evidence_invalid.en.replace('__STAGE__', T.cn2b_stage_readiness.en));
    expect(block.textContent).toMatch(/cannot be repaired in this workflow/);
    expect(block.textContent).not.toMatch(/re-import|replacement|automatically|will be repaired|Source stage/i);
  });

  for (const [id, reason] of [['H1_1_03', 'source_quantity_override_binding_invalid'], ['H1_1_05', 'source_quantity_override_mismatch']] as const) {
    it(`${id} — ${reason} is SIMPLE-resolvable (binding_invalid: with a proven numeric current head): the readiness says what to do and there is NO escape`, async () => {
      blockersOverride = [LINEAGE_BLOCKER(reason)];
      // HC1.2: the cell's CURRENT head (the first row of rec-5 in server order) is a numeric override.
      overrides = [{
        id: 'ov-head', sourceRecordId: 'rec-5', targetEntity: ROW_5, fieldName: 'qty', previousValue: '12 boxes', finalValue: 12, finalValueText: '12',
        overrideReason: 'confirmed', overrideNote: null, createdAt: '2026-09-26T10:00:00+00:00',
      }];
      await openSimpleAt('need-lines');
      expect(screen.getByTestId('cn2b-simple-readiness-messages')).toHaveTextContent(T[`cn2b_simple_blocker_lineage_${reason}`].en);
      expect(escapeBlock()).toBeNull();
      expect(screen.queryByTestId('cn2b-simple-expert-open')).toBeNull();
    });
  }
});

// ==============================================================================
// The Simple remedy for the two Simple-resolvable reasons is REAL (H1_1_03, H1_1_05)
// ==============================================================================
describe('HC1.1-A · the canonical Simple remedy is actually available and works (H1_1_03, H1_1_05)', () => {
  const override = (id: string, finalValue: unknown, createdAt: string): FieldOverride => ({
    id, sourceRecordId: 'rec-5', targetEntity: ROW_5, fieldName: 'qty', previousValue: '12 boxes', finalValue,
    finalValueText: typeof finalValue === 'number' ? String(finalValue) : JSON.stringify(finalValue),
    overrideReason: `reason for ${id}`, overrideNote: null, createdAt,
  });
  const HEAD = override('ov-head', 12, '2026-09-26T10:00:00+00:00');
  const OLD = override('ov-old', 9, '2026-09-20T10:00:00+00:00');
  const LINE: NeedLine = {
    id: 'nl-1', planRevisionId: REV, organizationId: ORG, beneficiaryOrganizationId: BENE, targetWarehouseId: null, centralItemId: ITEM,
    approvedQuantity: '10', approvedUnit: 'box', unitConversionState: 'canonical', sourceUnitText: null, mappingReason: 'reviewed', updatedAt: '2026-09-27T10:00:00+00:00',
  };
  const link = (appliedOverrideId: string, designatedQuantity: string): NeedLineSourceLink => ({
    needLineId: 'nl-1', sourceRecordId: 'rec-5', designatedQuantity, appliedOverrideId, importSessionId: 's1', targetEntity: ROW_5, fieldName: 'qty',
  });

  /** The server's state after the line is deleted: no line, no claim on the cell, no lineage blocker. */
  function deleteLineOnServer() {
    svc.deleteNeedLine.mockImplementation(async () => {
      lineage = { needLines: [], sources: [] };
      blockersOverride = null;
      return { needLineId: 'nl-1' };
    });
  }

  async function remedy(reasonToken: string) {
    records = recordsFor('12 boxes'); // a cell that is not a plain number: only a pinned numeric override can count
    overrides = [HEAD, OLD]; // server order: newest first, so ov-head is the cell's current head
    blockersOverride = [LINEAGE_BLOCKER(reasonToken)];
    deleteLineOnServer();
    const { container } = await openSimpleAt('need-lines');

    // 1) Simple says what to do and offers no way out.
    expect(escapeBlock()).toBeNull();
    expect(screen.getByTestId('cn2b-simple-readiness-messages')).toHaveTextContent(T[`cn2b_simple_blocker_lineage_${reasonToken}`].en);
    // 2) The need line the server refuses is IN the canonical panel, with its own delete control.
    await waitFor(() => expect(within(needLines()).getAllByTestId('cn2b-nl-line')).toHaveLength(1));
    // 3) Delete it, with a reason — the canonical write.
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_delete.en }));
    fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_delete_reason.en), { target: { value: 'rebuild the line' } });
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_delete_confirm.en }));
    await waitFor(() => expect(svc.deleteNeedLine).toHaveBeenCalledTimes(1));
    expect(svc.deleteNeedLine).toHaveBeenCalledWith({ needLineId: 'nl-1', reason: 'rebuild the line', expectedSourceRecordIds: ['rec-5'] });
    // 4) The cell is free again: designate it, and pin the CURRENT numeric head.
    await waitFor(() => expect(within(needLines()).queryAllByTestId('cn2b-nl-line')).toHaveLength(0));
    await waitFor(() => expect(within(candidateFor('qty')).getByTestId('cn2b-nl-candidate-beneficiary')).toHaveTextContent('Beneficiary Hospital'));
    fireEvent.click(within(candidateFor('qty')).getAllByRole('checkbox')[0]);
    const evidence = within(candidateFor('qty')).getByTestId('cn2b-nl-override-evidence');
    expect(evidence).toHaveAttribute('data-override-id', 'ov-head');
    expect(evidence).toHaveAttribute('data-numeric', 'true');
    fireEvent.click(within(candidateFor('qty')).getByRole('checkbox', { name: T.cn2b_nl_use_override.en }));
    expect(within(candidateFor('qty')).getByLabelText(`${T.cn2b_nl_contribution.en} — qty`)).toHaveValue('12');
    // 5) Save: the same canonical payload, pinned to the current head, the contribution equal to it.
    fireEvent.change(within(needLines()).getByLabelText(T.cn2b_nl_reason.en), { target: { value: 'rebuilt on the current correction' } });
    fireEvent.change(within(needLines()).getByTestId('cn2b-nl-unit-select'), { target: { value: 'box' } });
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_save.en }));
    fireEvent.click(within(needLines()).getByRole('button', { name: T.cn2b_nl_bulk_confirm.en }));
    await waitFor(() => expect(svc.setNeedLine).toHaveBeenCalledTimes(1));
    expect(svc.setNeedLine).toHaveBeenCalledWith(expect.objectContaining({
      planRevisionId: REV, beneficiaryOrganizationId: BENE, centralItemId: ITEM, approvedQuantity: '12',
      quantitySources: [{ sourceRecordId: 'rec-5', designatedQuantity: '12', appliedOverrideId: 'ov-head' }],
    }));
    // The whole remedy happened in Simple: never Advanced, never an override written, never a direct backend call.
    await settle();
    expect(modeOf(container)).toBe('simple');
    expect(escapeBlock()).toBeNull();
    expect(svc.recordFieldOverride).not.toHaveBeenCalled();
    expect(directBackend).toEqual([]);
    expect(svc.deleteNeedLine).toHaveBeenCalledTimes(1);
    expect(svc.setNeedLine).toHaveBeenCalledTimes(1);
  }

  it('H1_1_03 — source_quantity_override_binding_invalid: the line pinned to a stale correction is deleted and re-designated pinned to the CURRENT head, all in Simple', async () => {
    lineage = { needLines: [LINE], sources: [link('ov-old', '9')] };
    await remedy('source_quantity_override_binding_invalid');
  });

  it('H1_1_05 — source_quantity_override_mismatch: the line whose contribution differs from its pinned correction is rebuilt with an EQUAL contribution, all in Simple', async () => {
    lineage = { needLines: [LINE], sources: [link('ov-head', '10')] }; // pinned to the head (12), contributing 10
    await remedy('source_quantity_override_mismatch');
  });

});

// ==============================================================================
// HC1.1-B/C — Stored Workbook work and a region write against the real escape
// ==============================================================================
describe('HC1.1-B/C · the contextual expert escape against REAL Stored Workbook mapping work (H1_1_23 … H1_1_30)', () => {
  const gridCell = (a1: string) => document.querySelector<HTMLElement>(`[role="gridcell"][data-a1="${a1}"]`);
  const columnButton = (index: number) => within(screen.getByTestId('cn2b-xl-grid')).getAllByTestId('cn2b-xl-colbutton')[index];
  const inInst = (id: string) => within(screen.getByTestId('cn2b-instmap-panel')).getByTestId(id);
  const gate = () => screen.getByTestId('cn2b-approve-panel');
  const regionLayer = () => screen.getByTestId('cn4-region-layer');

  async function openWorkbook() {
    const view = await openSimpleAt('need-lines');
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
    await waitFor(() => expect(screen.getByTestId('cn2b-xl-viewer')).toBeInTheDocument(), { timeout: 10_000 });
    await waitFor(() => expect(screen.getByTestId('cn2b-stored-workbook-panel').getAttribute('data-source-identity')).toBe('trusted'));
    return view;
  }
  const assignRole = (column: number, role: 'national_code' | 'material') => {
    fireEvent.click(columnButton(column));
    fireEvent.click(screen.getByTestId(`cn2b-map-assign-${role}`));
  };
  async function mapAndApprove() {
    assignRole(0, 'national_code');
    assignRole(1, 'material');
    fireEvent.click(gridCell('C1') as HTMLElement);
    fireEvent.click(inInst('cn2b-instmap-capture-anchor'));
    fireEvent.click(columnButton(2));
    fireEvent.click(inInst('cn2b-instmap-capture-need'));
    fireEvent.change(inInst('cn2b-instmap-beneficiary'), { target: { value: BENE } });
    fireEvent.click(inInst('cn2b-instmap-commit'));
    await waitFor(() => expect(gate()).toHaveAttribute('data-approval-status', 'ready'));
    fireEvent.click(within(gate()).getByTestId('cn2b-approve-action'));
    expect(gate()).toHaveAttribute('data-approved', 'true');
  }
  const regionReady = () => waitFor(() => expect(regionLayer()).toHaveAttribute('data-phase', 'ready'));
  async function beginRegionDecision(reason = 'footer block') {
    fireEvent.click(columnButton(2));
    await regionReady();
    fireEvent.click(within(regionLayer()).getByTestId('cn4-region-mark-non-beneficiary'));
    fireEvent.change(within(regionLayer()).getByTestId('cn4-region-reason'), { target: { value: reason } });
  }
  const sendRegionDecision = () => fireEvent.click(within(regionLayer()).getByTestId('cn4-region-confirm-send'));

  beforeEach(() => { blockersOverride = [NUMERIC_BLOCKER]; });

  it('H1_1_23 — a workbook that is only VIEWED (columns, cells and sheets selected) asks nothing: one click lands on the stage', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { container } = await openWorkbook();
    fireEvent.click(columnButton(0));
    fireEvent.click(gridCell('B2') as HTMLElement);
    fireEvent.click(screen.getByRole('tab', { name: /Other/ }));
    await settle();
    expect(escapeBlock()).toBeInTheDocument();
    fireEvent.click(expertButton());
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect(modeOf(container)).toBe('advanced');
    expect(visibleStages(container)).toEqual(['review']);
  });

  it('H1_1_23 — and server-saved regions beside it change nothing: still no question', async () => {
    svc.listBeneficiaryRegions.mockResolvedValue([{
      versionId: 'v-1', regionId: 'r-1', versionNo: 2, supersedesVersionId: 'v-0', planRevisionId: REV, importSessionId: 's1', sheetIndex: 0,
      rowStart: 1, rowEnd: 20, columnStart: 3, columnEnd: 3, decision: 'beneficiary', beneficiaryOrganizationId: BENE, decisionReason: 'confirmed', decidedBy: 'u', decidedAt: 't',
    }]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { container } = await openWorkbook();
    fireEvent.click(columnButton(2));
    await regionReady();
    expect(within(regionLayer()).getAllByTestId('cn4-region-version')).toHaveLength(1);
    fireEvent.click(expertButton());
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(modeOf(container)).toBe('advanced');
  });

  it('H1_1_24 — in-memory mapping work asks EXACTLY ONCE, in the escape\'s own words (not the revision or Work Session copy)', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await openWorkbook();
    assignRole(0, 'national_code');
    expect(confirm).not.toHaveBeenCalled(); // doing the work asks nothing
    fireEvent.click(expertButton());
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(T.cn2b_expert_switch_confirm.en);
    expect(confirm).not.toHaveBeenCalledWith(T.cn2b_revision_context_change_confirm.en);
    expect(confirm).not.toHaveBeenCalledWith(T.cn2b_work_session_change_confirm.en);
  });

  it('H1_1_25 — cancelling keeps Simple, the stage and EVERY local draft: roles, mapping, approval, a pending region decision', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { container } = await openWorkbook();
    await mapAndApprove();
    await beginRegionDecision('footer block');
    const roles = screen.getByTestId('cn2b-map-roles').textContent;
    const fingerprint = within(gate()).getByTestId('cn2b-approve-fingerprint-value').textContent;
    const reads = readCounts();
    const fetches = fetchStub.mock.calls.length;
    const backend = [...directBackend];

    fireEvent.click(expertButton());
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(modeOf(container)).toBe('simple');
    expect(stepOf()).toBe('need-lines');
    expect(stages(container)).toHaveLength(0); // no Advanced stage was chosen or painted
    expect(escapeBlock()).toBeInTheDocument();
    // Every draft is exactly as it was.
    expect(screen.getByTestId('cn2b-map-roles').textContent).toBe(roles);
    expect(screen.getAllByTestId('cn2b-instmap-item')).toHaveLength(1);
    expect(gate()).toHaveAttribute('data-approved', 'true');
    expect(within(gate()).getByTestId('cn2b-approve-fingerprint-value').textContent).toBe(fingerprint);
    expect(within(regionLayer()).getByTestId('cn4-region-reason')).toHaveValue('footer block');
    // Nothing was read, sent or fetched by the attempt.
    expect(readCounts()).toEqual(reads);
    expect(fetchStub.mock.calls.length).toBe(fetches);
    expect(directBackend).toEqual(backend);
    NO_BUSINESS_WRITE();

    // Cancel did not switch the guard off: a SECOND attempt asks again.
    fireEvent.click(expertButton());
    await settle();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(modeOf(container)).toBe('simple');
    expect(screen.getAllByTestId('cn2b-instmap-item')).toHaveLength(1);
  });

  it('H1_1_26 — confirming routes to the EXACT stage and changes the presentation only: no business write, no read, no fetch, no direct backend call', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = await openWorkbook();
    await mapAndApprove();
    const reads = readCounts();
    const fetches = fetchStub.mock.calls.length;
    const backend = [...directBackend];

    const flips: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && (r.target as Element).matches('section.cn2b-stage')) flips.push(`${(r.target as Element).getAttribute('data-stage')}:${r.attributeName}`);
      }
    });
    observer.observe(container, { subtree: true, attributes: true, attributeFilter: ['hidden', 'data-active'], childList: true });
    fireEvent.click(expertButton());
    await settle();
    observer.disconnect();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(modeOf(container)).toBe('advanced');
    expect(visibleStages(container)).toEqual(['review']);
    expect(flips).toEqual([]);
    expect(screen.queryByTestId('cn2b-simple-workspace')).toBeNull();
    expect(readCounts()).toEqual(reads);
    expect(fetchStub.mock.calls.length).toBe(fetches);
    expect(directBackend.slice(backend.length).filter((c) => /set_|delete_|record_|submit|approve|reject|open_|abandon|finalize|upload/.test(c))).toEqual([]);
    NO_BUSINESS_WRITE();
  });

  it('H1_1_27 — a region write IN FLIGHT blocks the escape: its own sentence, no confirmation to override it, Simple stays, the write is untouched', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    let finish!: () => void;
    svc.setBeneficiaryRegions.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ operationBatchId: 'b', activeVersions: [], changes: [], convertedColumns: [] });
    }));
    const { container } = await openWorkbook();
    await beginRegionDecision();
    sendRegionDecision();
    await waitFor(() => expect(svc.setBeneficiaryRegions).toHaveBeenCalledTimes(1));
    // `busy` reaches the screen through an effect: the button is still there; its handler now refuses.
    await settle();

    fireEvent.click(expertButton());
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(T.cn2b_expert_switch_blocked.en);
    expect(confirm).not.toHaveBeenCalled(); // no confirmation can override an active write
    expect(modeOf(container)).toBe('simple');
    expect(stages(container)).toHaveLength(0);
    expect(svc.setBeneficiaryRegions).toHaveBeenCalledTimes(1); // never repeated, never abandoned
    // Busy is checked BEFORE dirty, even with mapping work on screen too.
    assignRole(0, 'national_code');
    fireEvent.click(expertButton());
    await settle();
    expect(alert).toHaveBeenCalledTimes(2);
    expect(confirm).not.toHaveBeenCalled();
    expect(modeOf(container)).toBe('simple');

    await act(async () => { finish(); });
  });

  it('H1_1_28 — once the write settles, busy clears and the escape is evaluated afresh (here: only the role is left, so one question)', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    let finish!: () => void;
    svc.setBeneficiaryRegions.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ operationBatchId: 'b', activeVersions: [], changes: [], convertedColumns: [] });
    }));
    const { container } = await openWorkbook();
    await beginRegionDecision();
    sendRegionDecision();
    await waitFor(() => expect(svc.setBeneficiaryRegions).toHaveBeenCalledTimes(1));
    await settle();
    fireEvent.click(expertButton());
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);

    await act(async () => { finish(); });
    await waitFor(() => expect(within(regionLayer()).queryByTestId('cn4-region-confirm')).toBeNull());
    await settle();
    // The region decision is saved and gone: nothing is busy and nothing is dirty — one click, no question.
    fireEvent.click(expertButton());
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(modeOf(container)).toBe('advanced');
    expect(visibleStages(container)).toEqual(['review']);
    expect(svc.setBeneficiaryRegions).toHaveBeenCalledTimes(1);
  });

  it('H1_1_28 — and with a local role still on screen, the settled write leaves exactly the dirty question', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    let finish!: () => void;
    svc.setBeneficiaryRegions.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ operationBatchId: 'b', activeVersions: [], changes: [], convertedColumns: [] });
    }));
    await openWorkbook();
    assignRole(0, 'national_code');
    await beginRegionDecision();
    sendRegionDecision();
    await waitFor(() => expect(svc.setBeneficiaryRegions).toHaveBeenCalledTimes(1));
    await settle();
    fireEvent.click(expertButton());
    expect(alert).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    await waitFor(() => expect(within(regionLayer()).queryByTestId('cn4-region-confirm')).toBeNull());
    await settle();
    fireEvent.click(expertButton());
    expect(alert).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(T.cn2b_expert_switch_confirm.en);
  });

  it('H1_1_29 — Simple → Advanced → Simple → escape again: nothing stale from the Stored Workbook or the region layer poisons the round trip', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { container } = await openWorkbook();
    await mapAndApprove();
    await beginRegionDecision(); // a decision typed but never sent
    fireEvent.click(expertButton());
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1); // mapping + a pending region decision: ONE question
    expect(modeOf(container)).toBe('advanced');

    // Back to Simple: a fresh surface — the workbook is closed, no draft, no approval.
    fireEvent.click(screen.getByTestId('cn2b-mode-toggle'));
    await waitFor(() => expect(stepOf()).toBe('need-lines'));
    expect(screen.queryByTestId('cn2b-xl-viewer')).toBeNull();
    expect(confirm).toHaveBeenCalledTimes(1);
    // Neither dirty nor busy is left behind: one click, no question, no "wait" sentence.
    fireEvent.click(expertButton());
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    expect(modeOf(container)).toBe('advanced');
    expect(visibleStages(container)).toEqual(['review']);
    NO_BUSINESS_WRITE(); // the region decision was never sent: the one question was about unsent work
  });

  it('H1_1_29 — a region write finished before the round trip leaves nothing busy afterwards either', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { container } = await openWorkbook();
    await beginRegionDecision();
    sendRegionDecision();
    await waitFor(() => expect(svc.setBeneficiaryRegions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(regionLayer()).queryByTestId('cn4-region-confirm')).toBeNull());
    await settle();
    fireEvent.click(expertButton());
    await settle();
    expect(modeOf(container)).toBe('advanced');
    fireEvent.click(screen.getByTestId('cn2b-mode-toggle'));
    await waitFor(() => expect(stepOf()).toBe('need-lines'));
    fireEvent.click(expertButton());
    await settle();
    expect(modeOf(container)).toBe('advanced');
    expect(confirm).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect(svc.setBeneficiaryRegions).toHaveBeenCalledTimes(1);
  });

  it('the Work Session switch is NOT touched by Stored Workbook work: no question, no block — and the mapping survives the switch (it belongs to the revision)', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    let finish!: () => void;
    svc.setBeneficiaryRegions.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ operationBatchId: 'b', activeVersions: [], changes: [], convertedColumns: [] });
    }));
    await openWorkbook();
    assignRole(0, 'national_code');
    const picker = () => within(screen.getByTestId('cn2b-simple-context')).getByRole('combobox') as HTMLSelectElement;
    // Mapping work on screen: the picker is enabled and a switch asks nothing.
    expect(picker()).not.toBeDisabled();
    fireEvent.change(picker(), { target: { value: 's2' } });
    await waitFor(() => expect(stepOf()).toBe('review-material'));
    expect(confirm).not.toHaveBeenCalled();
    // The drafts belong to the revision, not to a session: still there after the switch.
    expect(screen.getByTestId('cn2b-map-role-national_code')).toHaveAttribute('data-column-index', '0');

    // A region write in flight does not disable the picker either — only the escape (and the writes themselves) wait for it.
    await beginRegionDecision();
    sendRegionDecision();
    await waitFor(() => expect(svc.setBeneficiaryRegions).toHaveBeenCalledTimes(1));
    await settle();
    expect(picker()).not.toBeDisabled();
    await act(async () => { finish(); });
  });

  it('H1_1_30 — with the Stored Workbook open the escape is STILL the only way into Advanced: no toggle, no footer, no generic link, one button', async () => {
    const { container } = await openWorkbook();
    assignRole(0, 'national_code');
    expect(screen.queryByTestId('cn2b-mode-toggle')).toBeNull();
    expect(container.querySelector('.cn2b-simple footer')).toBeNull();
    for (const id of ['cn2b-simple-advanced-link', 'cn2b-simple-continue-advanced', 'cn2b-simple-handoff']) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.getAllByTestId('cn2b-simple-expert-open')).toHaveLength(1);
    expect(screen.getByTestId('cn2b-simple-workspace').textContent ?? '').not.toMatch(/Advanced options|خيارات متقدمة/);
    // And with no blocker that needs an expert, there is no escape at all — even with mapping work on screen.
    cleanup();
    blockersOverride = null;
    await openWorkbook();
    assignRole(0, 'national_code');
    expect(escapeBlock()).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-expert-open')).toBeNull();
  });

  it('Arabic — the confirmation and the busy sentence reach an Arabic user in Arabic', async () => {
    appState.lang = 'ar';
    appState.dir = 'rtl';
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    svc.setBeneficiaryRegions.mockImplementation(() => new Promise(() => {}));
    await openWorkbook();
    assignRole(0, 'national_code');
    fireEvent.click(expertButton());
    expect(confirm).toHaveBeenCalledWith(T.cn2b_expert_switch_confirm.ar);
    fireEvent.click(columnButton(2));
    await regionReady();
    fireEvent.click(within(regionLayer()).getByTestId('cn4-region-mark-non-beneficiary'));
    fireEvent.change(within(regionLayer()).getByTestId('cn4-region-reason'), { target: { value: 'سبب' } });
    sendRegionDecision();
    await waitFor(() => expect(svc.setBeneficiaryRegions).toHaveBeenCalledTimes(1));
    await settle();
    fireEvent.click(expertButton());
    expect(alert).toHaveBeenCalledWith(T.cn2b_expert_switch_blocked.ar);
  });
});
