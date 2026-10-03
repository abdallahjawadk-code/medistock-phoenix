/** @vitest-environment jsdom */
/**
 * CN-UI-S1 HC1.1-B/C — the stored-workbook mapping surface reports its own
 * busy / dirty / failed upward, over the REAL trusted stored source in the REAL
 * Simple workspace (H1_1_10 … H1_1_22).
 *
 * REAL, unmodified: CentralNeedsSimpleWorkspace, StoredWorkbookMapping,
 * StoredWorkbookPanel, the viewer and grid, E2-A identity, E2-B / E2-C / E2-D
 * mapping state, BeneficiaryRegionLayer, the production `import/worker.ts`,
 * Web Crypto. STUBBED, transport only (as the E2 suites): `fetch`, the Supabase
 * auth read, the entry-row query, the Worker thread, and the three region
 * service reads/writes the layer calls.
 *
 * What counts as work is named field by field by `storedWorkbookHasLocalWork`;
 * what does NOT count is as important — a workbook that is merely open, a sheet
 * or cell that is merely selected, and server-saved regions.
 */
import '@testing-library/jest-dom/vitest';
import { createHash } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as XLSX from 'xlsx';
import type { BeneficiaryRegionVersion, ImportBatch, ImportSession, PlanRevision } from '../../central-needs.service';
import type { SheetMappingState } from '../../mapping/sheetMappingProfile';
import type { InstitutionMappingState } from '../../mapping/institutionMapping';
import { EMPTY_INSTITUTION_DRAFT } from '../../mapping/institutionMapping';

interface EntryRow {
  id: string;
  batch_id: string;
  entry_ordinal: number;
  archive_entry_path: string | null;
  entry_sha256: string;
  import_session_id: string;
}

const { backendAccess, entriesDb } = vi.hoisted(() => ({
  backendAccess: [] as string[],
  entriesDb: { rows: [] as EntryRow[] },
}));

vi.mock('@/shared/supabase/client', () => {
  const entriesQuery = (table: string) => {
    if (table !== 'central_needs_import_batch_entries') {
      backendAccess.push(`from:${table}`);
      return undefined;
    }
    let batchFilter = '';
    const chain: Record<string, unknown> = {
      select: () => guarded,
      eq: (column: string, value: unknown) => { if (column === 'batch_id') batchFilter = String(value); return guarded; },
      order: () => guarded,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: entriesDb.rows.filter((r) => r.batch_id === batchFilter), error: null }).then(resolve, reject),
    };
    const guarded: unknown = new Proxy(chain, {
      get: (target, prop) => {
        if (typeof prop === 'string' && prop in target) return target[prop];
        backendAccess.push(`${table}.${String(prop)}`);
        return undefined;
      },
    });
    return guarded;
  };
  return {
    supabase: new Proxy({}, {
      get: (_target, prop) => {
        if (prop === 'auth') return { getSession: async () => ({ data: { session: { access_token: 'hc11-test-token' } } }) };
        if (prop === 'from') return entriesQuery;
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        backendAccess.push(String(prop));
        return undefined;
      },
    }),
  };
});

const listBeneficiaryRegions = vi.fn();
const listScopeColumnMappings = vi.fn();
const setBeneficiaryRegions = vi.fn();
vi.mock('../../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../../central-needs.service')>('../../central-needs.service');
  return {
    ...actual,
    listBeneficiaryRegions: (...a: unknown[]) => listBeneficiaryRegions(...a),
    listScopeColumnMappings: (...a: unknown[]) => listScopeColumnMappings(...a),
    setBeneficiaryRegions: (...a: unknown[]) => setBeneficiaryRegions(...a),
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
    workerScope.postMessage = (reply) => {
      if (!this.terminated) this.onmessage?.({ data: reply } as MessageEvent);
    };
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
await import('../../import/worker');
const { CentralNeedsSimpleWorkspace } = await import('../CentralNeedsSimpleWorkspace');
const { storedWorkbookHasLocalWork } = await import('../StoredWorkbookMapping');
const { RUNNING_PARSER_IDENTITY } = await import('../../regions/beneficiaryRegions');
const { T } = await import('@/shared/i18n/strings');

// The real viewer and Worker parse a workbook per test; under a loaded full-suite run the default 5 s bound is too tight.
vi.setConfig({ testTimeout: 30_000 });

type WorkspaceProps = Parameters<typeof CentralNeedsSimpleWorkspace>[0];
type Activity = { busy: boolean; dirty: boolean; failed: boolean };
const IDLE: Activity = { busy: false, dirty: false, failed: false };
const WORK: Activity = { busy: false, dirty: true, failed: false };

const ENDPOINT = '/api/central-needs/source-download';
const SIGNED_URL = 'https://storage.example.invalid/storage/v1/object/sign/central-needs-sources/opaque?token=signed';
const SESSION_ID = 'session-1';

const activity = vi.fn<(a: Activity) => void>();
const last = (): Activity => activity.mock.calls.at(-1)?.[0] as Activity;
const everReported = (pred: (a: Activity) => boolean) => activity.mock.calls.some(([a]) => pred(a));

beforeEach(() => {
  stubWorkerRealm();
  activity.mockReset();
  listBeneficiaryRegions.mockReset().mockResolvedValue([]);
  listScopeColumnMappings.mockReset().mockResolvedValue([]);
  setBeneficiaryRegions.mockReset().mockResolvedValue({ operationBatchId: 'b', activeVersions: [], changes: [], convertedColumns: [] });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  backendAccess.length = 0;
  entriesDb.rows = [];
});

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const exactBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const PLAN_OWNER = 'org-plan-owner';
const CARE_INSTITUTIONS = [
  { id: 'org-a', name: 'Al Amal Hospital', name_ar: 'مستشفى الأمل', code: 'HOSP-A', status: 'active', city: '', contact_email: '', organizationKind: 'care_institution' as const, institutionClass: 'hospital' as const },
  { id: 'org-b', name: 'Al Noor Clinic', name_ar: 'مستوصف النور', code: 'CLIN-B', status: 'active', city: '', contact_email: '', organizationKind: 'care_institution' as const, institutionClass: 'hospital' as const },
];

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
const batchFor = (id: string, revisionId: string): ImportBatch => ({
  id, planRevisionId: revisionId, containerKind: 'file', containerFilename: 'needs.xlsx',
  containerSha256: sha256(BYTES), acceptedEntryCount: 1, excludedEntryCount: 0, registeredAt: '2026-09-21T00:00:00.000Z',
});
const rowFor = (batchId: string, session: string): EntryRow => ({
  id: `entry-${batchId}`, batch_id: batchId, entry_ordinal: 1, archive_entry_path: null,
  entry_sha256: sha256(BYTES), import_session_id: session,
});

function stubNetwork() {
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
  return fetchStub;
}

const revision = (id: string): PlanRevision => ({
  id, planId: 'p', organizationId: PLAN_OWNER, planYear: 2027, revisionNumber: id === 'rev-1' ? 1 : 2, status: 'draft',
});
const importSession = (): ImportSession => ({
  id: SESSION_ID, planRevisionId: 'rev-1', sourceFileId: 'f', status: 'completed', previewDigest: null,
  authoritativeDigest: null, parserIdentity: { ...RUNNING_PARSER_IDENTITY, runtime: 'node' }, startedAt: 't', completedAt: 't', notes: null,
});
const REGION_PROPS: Partial<WorkspaceProps> = { beneficiaryRegions: { phase: 'ready', versions: [] }, sessions: [importSession()] };
const workspace = (id: string, extra: Partial<WorkspaceProps> = {}) => (
  <CentralNeedsSimpleWorkspace
    lang="en" planYear={2027} onPlanYearChange={() => {}} revisionsLoading={false}
    revision={revision(id)} isDraft revisionDataReady canImport canEdit busy={false} activity={null}
    onOpenRevision={() => {}} preview={{ phase: 'idle' }} pendingFile={null} onPickFile={() => {}} onVerify={() => {}}
    error={null} notice={null} readiness={null} batches={[batchFor(`batch-${id}`, id)]} beneficiaryColumns={[]} careInstitutions={CARE_INSTITUTIONS}
    records={[]} dispositions={[]} activeSessionId={null} onChanged={() => {}}
    onStoredWorkbookActivityChange={activity}
    {...extra}
  />
);

const gate = () => screen.getByTestId('cn2b-approve-panel');
const inGate = (id: string) => within(gate()).getByTestId(id);
const inInst = (id: string) => within(screen.getByTestId('cn2b-instmap-panel')).getByTestId(id);
const gridCell = (a1: string) => document.querySelector<HTMLElement>(`[role="gridcell"][data-a1="${a1}"]`);
const columnButton = (index: number) => within(screen.getByTestId('cn2b-xl-grid')).getAllByTestId('cn2b-xl-colbutton')[index];
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function openWorkspace(extra: Partial<WorkspaceProps> = {}) {
  entriesDb.rows = [rowFor('batch-rev-1', SESSION_ID), rowFor('batch-rev-2', 'session-2')];
  const fetchStub = stubNetwork();
  const view = render(workspace('rev-1', extra));
  fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
  await waitFor(() => expect(screen.getByTestId('cn2b-xl-viewer')).toBeInTheDocument(), { timeout: 10_000 });
  await waitFor(() => expect(screen.getByTestId('cn2b-stored-workbook-panel').getAttribute('data-source-identity')).toBe('trusted'));
  return { ...view, fetchStub };
}

const assignRole = (column: number, role: 'national_code' | 'material') => {
  fireEvent.click(columnButton(column));
  fireEvent.click(screen.getByTestId(`cn2b-map-assign-${role}`));
};
const buildInstitutionDraft = () => {
  fireEvent.click(gridCell('C1') as HTMLElement);
  fireEvent.click(inInst('cn2b-instmap-capture-anchor'));
  fireEvent.click(columnButton(2));
  fireEvent.click(inInst('cn2b-instmap-capture-need'));
  fireEvent.change(inInst('cn2b-instmap-beneficiary'), { target: { value: 'org-a' } });
};
async function mapAndApprove() {
  assignRole(0, 'national_code');
  assignRole(1, 'material');
  buildInstitutionDraft();
  fireEvent.click(inInst('cn2b-instmap-commit'));
  await waitFor(() => expect(gate()).toHaveAttribute('data-approval-status', 'ready'));
  fireEvent.click(inGate('cn2b-approve-action'));
  expect(gate()).toHaveAttribute('data-approved', 'true');
}

// ==============================================================================
describe('HC1.1 — storedWorkbookHasLocalWork: every field of the contract, one by one', () => {
  const source = { batchId: 'b', entryId: 'e', entryOrdinal: 1, entrySha256: 'a'.repeat(64), importSessionId: SESSION_ID, workbookIndex: 0 };
  const profile = (over: Record<string, unknown> = {}): SheetMappingState['profile'] => ({
    source, sheetIndex: 0, sheetName: 'Sheet1', nationalCodeColumn: null, materialColumn: null, ...over,
  } as SheetMappingState['profile']);
  const institutions = (over: Partial<Pick<InstitutionMappingState, 'mappings' | 'draft' | 'resetPending'>> = {}) => ({
    mappings: [], draft: EMPTY_INSTITUTION_DRAFT, resetPending: false, ...over,
  });
  const quiet = {
    sheet: { profile: null as SheetMappingState['profile'] },
    institutions: institutions(),
    approval: { approved: false, stale: false },
    regionDirty: false,
  };
  const work = (over: Partial<typeof quiet>) => storedWorkbookHasLocalWork({ ...quiet, ...over });
  const entry = { id: 'im-1', anchor: { kind: 'cell', rowIndex: 0, columnIndex: 2, mergedRange: null }, need: { kind: 'column', columnIndex: 2 }, beneficiaryOrganizationId: 'org-a' };

  it('nothing at all, and a sheet profile that exists only because a sheet was selected: NOT work (H1_1_10)', () => {
    expect(work({})).toBe(false);
    expect(work({ sheet: { profile: profile() } })).toBe(false);
    expect(work({ institutions: institutions({ draft: { ...EMPTY_INSTITUTION_DRAFT } }) })).toBe(false);
  });

  it('H1_1_11 — a National Code column assigned', () => {
    expect(work({ sheet: { profile: profile({ nationalCodeColumn: { columnIndex: 0 } }) } })).toBe(true);
  });

  it('H1_1_12 — a Material column assigned (column 0 is a real column, not "none")', () => {
    expect(work({ sheet: { profile: profile({ materialColumn: { columnIndex: 1 } }) } })).toBe(true);
    expect(work({ sheet: { profile: profile({ materialColumn: { columnIndex: 0 } }) } })).toBe(true);
  });

  it('H1_1_13 — a committed in-memory institution mapping', () => {
    expect(work({ institutions: institutions({ mappings: [entry] as never }) })).toBe(true);
  });

  it('H1_1_14 — ANY part of an institution draft: the entry being edited, the name cell, the Need source, the beneficiary', () => {
    const draft = (over: Record<string, unknown>) => ({ ...EMPTY_INSTITUTION_DRAFT, ...over }) as InstitutionMappingState['draft'];
    expect(work({ institutions: institutions({ draft: draft({ editingId: 'im-1' }) }) })).toBe(true);
    expect(work({ institutions: institutions({ draft: draft({ anchor: entry.anchor }) }) })).toBe(true);
    expect(work({ institutions: institutions({ draft: draft({ need: entry.need }) }) })).toBe(true);
    expect(work({ institutions: institutions({ draft: draft({ beneficiaryOrganizationId: 'org-a' }) }) })).toBe(true);
  });

  it('H1_1_15 — a pending reset', () => {
    expect(work({ institutions: institutions({ resetPending: true }) })).toBe(true);
  });

  it('H1_1_16 — a local approval, given or since revoked', () => {
    expect(work({ approval: { approved: true, stale: false } })).toBe(true);
    expect(work({ approval: { approved: false, stale: true } })).toBe(true);
  });

  it('H1_1_17/18 — whatever the region layer reports as dirty', () => {
    expect(work({ regionDirty: true })).toBe(true);
  });
});

// ==============================================================================
describe('HC1.1 — what the REAL surface reports as the person works (H1_1_10 … H1_1_16)', () => {
  it('H1_1_10 — viewing the workbook, selecting columns and cells, switching sheets: never dirty, never busy', async () => {
    await openWorkspace();
    expect(last()).toEqual(IDLE);
    fireEvent.click(columnButton(0));
    fireEvent.click(gridCell('B2') as HTMLElement);
    fireEvent.click(gridCell('C1') as HTMLElement);
    fireEvent.click(screen.getByRole('tab', { name: /Other/ }));
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: /Sheet1/ }));
    await settle();
    expect(everReported((a) => a.dirty || a.busy || a.failed)).toBe(false);
    expect(last()).toEqual(IDLE);
  });

  it('H1_1_11 — assigning the National Code column is work; clearing it is not', async () => {
    await openWorkspace();
    assignRole(0, 'national_code');
    expect(last()).toEqual(WORK);
    fireEvent.click(screen.getByTestId('cn2b-map-clear-national_code'));
    expect(last()).toEqual(IDLE);
  });

  it('H1_1_12 — assigning the Material column is work; clearing it is not', async () => {
    await openWorkspace();
    assignRole(1, 'material');
    expect(last()).toEqual(WORK);
    fireEvent.click(screen.getByTestId('cn2b-map-clear-material'));
    expect(last()).toEqual(IDLE);
  });

  it('H1_1_14 — each part of a half-built institution draft is work, and cancelling the draft ends it', async () => {
    await openWorkspace();
    // the name cell only
    fireEvent.click(gridCell('C1') as HTMLElement);
    fireEvent.click(inInst('cn2b-instmap-capture-anchor'));
    expect(last()).toEqual(WORK);
    fireEvent.click(inInst('cn2b-instmap-cancel'));
    expect(last()).toEqual(IDLE);
    // the Need source only
    fireEvent.click(columnButton(2));
    fireEvent.click(inInst('cn2b-instmap-capture-need'));
    expect(last()).toEqual(WORK);
    fireEvent.click(inInst('cn2b-instmap-cancel'));
    expect(last()).toEqual(IDLE);
    // the beneficiary only
    fireEvent.change(inInst('cn2b-instmap-beneficiary'), { target: { value: 'org-a' } });
    expect(last()).toEqual(WORK);
    fireEvent.click(inInst('cn2b-instmap-cancel'));
    expect(last()).toEqual(IDLE);
  });

  it('H1_1_13 — a COMMITTED institution mapping is work on its own: it stays dirty after the roles are cleared, until it is removed', async () => {
    await openWorkspace();
    assignRole(0, 'national_code');
    assignRole(1, 'material');
    buildInstitutionDraft();
    fireEvent.click(inInst('cn2b-instmap-commit'));
    expect(screen.getAllByTestId('cn2b-instmap-item')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('cn2b-map-clear-national_code'));
    fireEvent.click(screen.getByTestId('cn2b-map-clear-material'));
    expect(last()).toEqual(WORK); // only the committed mapping is left
    fireEvent.click(screen.getByTestId(/^cn2b-instmap-remove-/));
    expect(screen.queryAllByTestId('cn2b-instmap-item')).toHaveLength(0);
    expect(last()).toEqual(IDLE);
  });

  it('H1_1_15 — requesting a reset keeps the surface dirty; keeping the mappings does too, and confirming the reset (roles cleared) ends it', async () => {
    await openWorkspace();
    assignRole(0, 'national_code');
    assignRole(1, 'material');
    buildInstitutionDraft();
    fireEvent.click(inInst('cn2b-instmap-commit'));
    fireEvent.click(inInst('cn2b-instmap-reset'));
    expect(inInst('cn2b-instmap-reset-confirm')).toBeInTheDocument();
    expect(last()).toEqual(WORK);
    fireEvent.click(inInst('cn2b-instmap-reset-keep'));
    expect(screen.queryByTestId('cn2b-instmap-reset-confirm')).toBeNull();
    expect(screen.getAllByTestId('cn2b-instmap-item')).toHaveLength(1);
    expect(last()).toEqual(WORK);
    fireEvent.click(inInst('cn2b-instmap-reset'));
    fireEvent.click(inInst('cn2b-instmap-reset-yes'));
    expect(screen.queryAllByTestId('cn2b-instmap-item')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('cn2b-map-clear-national_code'));
    fireEvent.click(screen.getByTestId('cn2b-map-clear-material'));
    expect(last()).toEqual(IDLE);
  });

  it('H1_1_16 — a local approval is work', async () => {
    await openWorkspace();
    await mapAndApprove();
    expect(last()).toEqual(WORK);
    // Everything the approval covers is gone from memory; the approval is what is left to ask about.
    fireEvent.click(inInst('cn2b-instmap-reset'));
    fireEvent.click(inInst('cn2b-instmap-reset-yes'));
    await waitFor(() => expect(gate()).toHaveAttribute('data-approved', 'false'));
    expect(within(gate()).getByTestId('cn2b-approve-stale')).toBeInTheDocument(); // revoked, must be given again
    expect(last()).toEqual(WORK); // the roles are still assigned, and the approval history is not "nothing"
  });

  it('H1_1_16 — a revoked approval is work ON ITS OWN: with the sheet switched, every draft is gone and only the stale approval remains', async () => {
    await openWorkspace();
    await mapAndApprove();
    fireEvent.click(screen.getByRole('tab', { name: /Other/ }));
    await settle();
    await waitFor(() => expect(gate()).toHaveAttribute('data-approved', 'false'));
    expect(within(gate()).getByTestId('cn2b-approve-stale')).toBeInTheDocument();
    // Nothing else is left: no role, no mapping, no draft.
    expect(screen.queryAllByTestId('cn2b-instmap-item')).toHaveLength(0);
    expect(screen.getByTestId('cn2b-map-role-national_code')).toHaveAttribute('data-column-index', '');
    expect(screen.getByTestId('cn2b-map-role-material')).toHaveAttribute('data-column-index', '');
    expect(last()).toEqual(WORK);
  });
});

// ==============================================================================
describe('HC1.1 — releasing the report (H1_1_21)', () => {
  it('H1_1_21 — unmounting a dirty surface releases its activity', async () => {
    const view = await openWorkspace();
    assignRole(0, 'national_code');
    buildInstitutionDraft();
    expect(last()).toEqual(WORK);
    view.unmount();
    expect(last()).toEqual(IDLE);
  });

  it('H1_1_21 — a revision switch remounts the surface: the old report is released and the new instance starts clean', async () => {
    const view = await openWorkspace();
    await mapAndApprove();
    expect(last()).toEqual(WORK);
    view.rerender(workspace('rev-2'));
    expect(gate()).toHaveAttribute('data-approved', 'false');
    expect(last()).toEqual(IDLE);
  });

  it('reports to the callback it was LAST given: a re-render with a new callback moves every later report (and the release) there', async () => {
    const view = await openWorkspace();
    const second = vi.fn<(a: Activity) => void>();
    view.rerender(workspace('rev-1', { onStoredWorkbookActivityChange: second }));
    const before = activity.mock.calls.length;
    assignRole(0, 'national_code');
    expect(second).toHaveBeenLastCalledWith(WORK);
    expect(activity.mock.calls.length).toBe(before); // the first callback heard nothing after the swap
    view.unmount();
    expect(second).toHaveBeenLastCalledWith(IDLE);
    expect(activity.mock.calls.length).toBe(before);
  });

  it('works with no callback at all (older harnesses): nothing throws', async () => {
    entriesDb.rows = [rowFor('batch-rev-1', SESSION_ID)];
    stubNetwork();
    const view = render(workspace('rev-1', { onStoredWorkbookActivityChange: undefined }));
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
    await waitFor(() => expect(screen.getByTestId('cn2b-xl-viewer')).toBeInTheDocument(), { timeout: 10_000 });
    assignRole(0, 'national_code');
    expect(() => view.unmount()).not.toThrow();
  });
});

// ==============================================================================
describe('HC1.1 — the beneficiary-region layer inside the real surface (H1_1_17 … H1_1_20, H1_1_22)', () => {
  const regionLayer = () => screen.getByTestId('cn4-region-layer');
  const regionReady = () => waitFor(() => expect(regionLayer()).toHaveAttribute('data-phase', 'ready'));
  const openWithRegions = async (extra: Partial<WorkspaceProps> = {}) => {
    const view = await openWorkspace({ ...REGION_PROPS, ...extra });
    fireEvent.click(columnButton(2)); // a selection establishes the sheet context the layer reads
    await regionReady();
    return view;
  };
  const version = (): BeneficiaryRegionVersion => ({
    versionId: 'v-1', regionId: 'r-1', versionNo: 2, supersedesVersionId: 'v-0', planRevisionId: 'rev-1',
    importSessionId: SESSION_ID, sheetIndex: 0, rowStart: 1, rowEnd: 20, columnStart: 3, columnEnd: 3,
    decision: 'beneficiary', beneficiaryOrganizationId: 'org-a', decisionReason: 'confirmed', decidedBy: 'u', decidedAt: 't',
  });
  const beginNonBeneficiary = () => fireEvent.click(within(regionLayer()).getByTestId('cn4-region-mark-non-beneficiary'));
  const typeReason = (text: string) => fireEvent.change(within(regionLayer()).getByTestId('cn4-region-reason'), { target: { value: text } });

  it('H1_1_20 — server-saved regions by themselves are not work', async () => {
    listBeneficiaryRegions.mockResolvedValue([version()]);
    await openWithRegions();
    expect(within(regionLayer()).getAllByTestId('cn4-region-version')).toHaveLength(1);
    expect(everReported((a) => a.dirty || a.busy)).toBe(false);
    expect(last()).toEqual(IDLE);
  });

  it('H1_1_18 — a pending region confirmation, and the reason typed for it, are work; cancelling ends it', async () => {
    await openWithRegions();
    beginNonBeneficiary();
    expect(last()).toEqual(WORK);
    typeReason('footer block');
    expect(last()).toEqual(WORK);
    fireEvent.click(within(regionLayer()).getByRole('button', { name: T.cn2b_simple_cancel.en }));
    expect(last()).toEqual(IDLE);
  });

  it('H1_1_17 — a column marked for conversion is work', async () => {
    listScopeColumnMappings.mockResolvedValue([{
      mappingId: 'm-5', importSessionId: SESSION_ID, sheetIndex: 0, columnIndex: 3, decision: 'beneficiary',
      beneficiaryOrganizationId: 'org-b', mappedAt: '2026-09-01T10:00:00.123456+00:00',
    }]);
    await openWithRegions();
    expect(last()).toEqual(IDLE);
    fireEvent.click(within(regionLayer()).getByTestId('cn4-region-convert'));
    expect(last()).toEqual(WORK);
  });

  it('H1_1_19 — a region write in flight makes the whole surface BUSY (and dirty); settling it ends both', async () => {
    let finish!: () => void;
    setBeneficiaryRegions.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ operationBatchId: 'b', activeVersions: [], changes: [], convertedColumns: [] });
    }));
    await openWithRegions();
    beginNonBeneficiary();
    typeReason('footer block');
    fireEvent.click(within(regionLayer()).getByTestId('cn4-region-confirm-send'));
    await waitFor(() => expect(setBeneficiaryRegions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(last()).toEqual({ busy: true, dirty: true, failed: false }));

    await act(async () => { finish(); });
    await waitFor(() => expect(last()).toEqual(IDLE));
    expect(setBeneficiaryRegions).toHaveBeenCalledTimes(1);
  });

  it('a refused region write is reported as failed through the surface', async () => {
    const { CentralNeedsError } = await import('../../central-needs.service');
    setBeneficiaryRegions.mockRejectedValue(new CentralNeedsError('beneficiary_region_overlap'));
    await openWithRegions();
    beginNonBeneficiary();
    typeReason('footer block');
    fireEvent.click(within(regionLayer()).getByTestId('cn4-region-confirm-send'));
    await waitFor(() => expect(last()).toEqual({ busy: false, dirty: true, failed: true }));
  });

  it('region work and mapping work are ONE dirty answer: either keeps it, only both gone clear it', async () => {
    await openWithRegions();
    assignRole(0, 'national_code');
    fireEvent.click(columnButton(2));
    beginNonBeneficiary();
    expect(last()).toEqual(WORK);
    fireEvent.click(within(regionLayer()).getByRole('button', { name: T.cn2b_simple_cancel.en }));
    expect(last()).toEqual(WORK); // the role is still assigned
    fireEvent.click(screen.getByTestId('cn2b-map-clear-national_code'));
    expect(last()).toEqual(IDLE);
  });

  it('H1_1_22 — when ONLY the region layer leaves the tree (the surface stays), its busy and dirty are released', async () => {
    setBeneficiaryRegions.mockImplementation(() => new Promise(() => {}));
    const view = await openWithRegions();
    beginNonBeneficiary();
    typeReason('footer block');
    fireEvent.click(within(regionLayer()).getByTestId('cn4-region-confirm-send'));
    await waitFor(() => expect(last()).toEqual({ busy: true, dirty: true, failed: false }));
    // The region context goes away (an older harness: no regions prop) — the layer unmounts, the mapping surface does not.
    view.rerender(workspace('rev-1', { beneficiaryRegions: undefined, sessions: [importSession()] }));
    expect(screen.queryByTestId('cn4-region-layer')).toBeNull();
    expect(screen.getByTestId('cn2b-stored-workbook-panel')).toBeInTheDocument();
    expect(last()).toEqual(IDLE);
  });
});
