/** @vitest-environment jsdom */
/**
 * E2-C.13 — Multi-Institution Mapping over the REAL trusted stored source.
 *
 * REAL, unmodified: StoredWorkbookPanel (its `onSelectionChange` bridge),
 * ExcelWorkbookViewer, ExcelSheetGrid, sourceIdentityBridge,
 * `requestSourceDownload`, `listBatchEntries`, the preview hook, the production
 * `import/worker.ts` and the CN-2A cores; the E2-B and E2-C reducers, hooks and
 * panels; the workspace.
 *
 * STUBBED, transport only (exactly as the E2-A and E2-B suites): `fetch`, the
 * Supabase auth read, the query transport for
 * `central_needs_import_batch_entries`, and the Worker thread. Every other
 * Supabase surface is a tripwire.
 */
import '@testing-library/jest-dom/vitest';
import { createHash } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as XLSX from 'xlsx';
import type { ImportBatch, PlanRevision } from '../../central-needs.service';

interface EntryRow {
  id: string;
  batch_id: string;
  entry_ordinal: number;
  archive_entry_path: string | null;
  entry_sha256: string;
  import_session_id: string;
}

const { backendAccess, entryReads, entriesDb } = vi.hoisted(() => ({
  backendAccess: [] as string[],
  entryReads: [] as string[],
  entriesDb: { rows: [] as EntryRow[], error: null as { message: string } | null },
}));

vi.mock('@/shared/supabase/client', () => {
  const entriesQuery = (table: string) => {
    if (table !== 'central_needs_import_batch_entries') {
      backendAccess.push(`from:${table}`);
      return undefined;
    }
    let batchFilter = '';
    const chain: Record<string, unknown> = {
      select: (columns: string) => { entryReads.push(`select ${columns}`); return guarded; },
      eq: (column: string, value: unknown) => {
        entryReads.push(`eq ${column}=${String(value)}`);
        if (column === 'batch_id') batchFilter = String(value);
        return guarded;
      },
      order: (column: string) => { entryReads.push(`order ${column}`); return guarded; },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(entriesDb.error
          ? { data: null, error: entriesDb.error }
          : { data: entriesDb.rows.filter((r) => r.batch_id === batchFilter), error: null }).then(resolve, reject),
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
        if (prop === 'auth') return { getSession: async () => ({ data: { session: { access_token: 'e2c-test-token' } } }) };
        if (prop === 'from') return entriesQuery;
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        backendAccess.push(String(prop));
        return undefined;
      },
    }),
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
  terminate() {
    this.terminated = true;
  }
}

function stubWorkerRealm() {
  vi.stubGlobal('Worker', InProcessWorker);
  vi.stubGlobal('self', workerScope);
  vi.stubGlobal('Blob', NodeBlob);
}

stubWorkerRealm();
await import('../../import/worker');
const { StoredWorkbookMapping } = await import('../StoredWorkbookMapping');
const { CentralNeedsSimpleWorkspace } = await import('../CentralNeedsSimpleWorkspace');

const ENDPOINT = '/api/central-needs/source-download';
const SIGNED_URL = 'https://storage.example.invalid/storage/v1/object/sign/central-needs-sources/opaque?token=signed';

beforeEach(() => {
  stubWorkerRealm();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  backendAccess.length = 0;
  entryReads.length = 0;
  entriesDb.rows = [];
  entriesDb.error = null;
});

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const exactBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** The trusted institutions — and the plan owner, which is NOT one of them. */
const PLAN_OWNER = 'org-plan-owner';
const CARE_INSTITUTIONS = [
  { id: 'org-a', name: 'Al Amal Hospital', name_ar: 'مستشفى الأمل', code: 'HOSP-A', status: 'active', city: '', contact_email: '', organizationKind: 'care_institution' as const, institutionClass: 'hospital' as const },
  { id: 'org-b', name: 'Al Noor Clinic', name_ar: 'مستوصف النور', code: 'CLIN-B', status: 'active', city: '', contact_email: '', organizationKind: 'care_institution' as const, institutionClass: 'hospital' as const },
  { id: 'org-c', name: 'Al Shifa Centre', name_ar: 'مركز الشفاء', code: 'CTR-C', status: 'active', city: '', contact_email: '', organizationKind: 'care_institution' as const, institutionClass: 'hospital' as const },
];

/**
 * Header cells deliberately tempt a guess: C1 is org-a's exact Arabic name, D1
 * is org-b's code, E1 is org-c's literal id. Row 2 holds a blank Need cell and
 * a zero, and National Codes with leading zeroes. E2-C must use none of it.
 */
function workbookBytes(label: string): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['National Code', 'Material', 'مستشفى الأمل', 'CLIN-B', 'org-c'],
      ['0012345', label, 3, null, 0],
      ['0067890', 'Ibuprofen', null, 5, 7],
    ]),
    'Sheet1',
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['hidden', 1, 2]]), 'مخفية');
  wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

function storedZip(files: Array<{ path: string; bytes: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.path);
    const crc = crc32(file.bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(12, 0x5021, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, file.bytes.length, true);
    local.setUint32(22, file.bytes.length, true);
    local.setUint16(26, name.length, true);
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 20, true);
    head.setUint16(14, 0x5021, true);
    head.setUint32(16, crc, true);
    head.setUint32(20, file.bytes.length, true);
    head.setUint32(24, file.bytes.length, true);
    head.setUint16(28, name.length, true);
    head.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, file.bytes);
    central.push(new Uint8Array(head.buffer), name);
    offset += 30 + name.length + file.bytes.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
}

const STANDALONE = workbookBytes('Paracetamol');
const FILE_BATCH: ImportBatch = {
  id: 'batch-file', planRevisionId: 'rev-1', containerKind: 'file', containerFilename: 'مستشفى الأمل.xlsx',
  containerSha256: sha256(STANDALONE), acceptedEntryCount: 1, excludedEntryCount: 0, registeredAt: '2026-09-21T00:00:00.000Z',
};
const FILE_ROWS: EntryRow[] = [{
  id: 'entry-file', batch_id: 'batch-file', entry_ordinal: 1, archive_entry_path: null,
  entry_sha256: sha256(STANDALONE), import_session_id: 'session-file',
}];
const ZIP_MEMBERS = [
  { path: 'needs/workbook-1.xlsx', bytes: workbookBytes('A-1') },
  { path: 'needs/workbook-2.xlsx', bytes: workbookBytes('B-1') },
];
const ZIP = storedZip(ZIP_MEMBERS);
const ZIP_BATCH: ImportBatch = {
  id: 'batch-zip', planRevisionId: 'rev-1', containerKind: 'zip', containerFilename: 'احتياج 2027.zip',
  containerSha256: sha256(ZIP), acceptedEntryCount: 2, excludedEntryCount: 0, registeredAt: '2026-09-21T01:00:00.000Z',
};
const ZIP_ROWS: EntryRow[] = ZIP_MEMBERS.map((m, i) => ({
  id: `entry-${i + 1}`, batch_id: 'batch-zip', entry_ordinal: i + 1, archive_entry_path: m.path,
  entry_sha256: sha256(m.bytes), import_session_id: `session-${i + 1}`,
}));

function stubNetwork() {
  const byBatch: Record<string, { batch: ImportBatch; bytes: Uint8Array }> = {
    'batch-file': { batch: FILE_BATCH, bytes: STANDALONE },
    'batch-zip': { batch: ZIP_BATCH, bytes: ZIP },
    'batch-rev2': { batch: { ...FILE_BATCH, id: 'batch-rev2', planRevisionId: 'rev-2' }, bytes: STANDALONE },
  };
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === ENDPOINT) {
      const { batchId } = JSON.parse(String(init?.body)) as { batchId: string };
      const { batch } = byBatch[batchId];
      return new Response(JSON.stringify({
        ok: true, url: `${SIGNED_URL}&b=${batchId}`, expiresInSeconds: 60, containerKind: batch.containerKind,
        containerSha256: batch.containerSha256, originalFilename: batch.containerFilename,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const batchId = new URL(url).searchParams.get('b');
    if (url.startsWith(SIGNED_URL) && batchId && byBatch[batchId]) {
      return new Response(exactBuffer(byBatch[batchId].bytes), { status: 200 });
    }
    throw new Error(`E2-C made an unexpected network call: ${url}`);
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

const storedPanel = () => screen.getByTestId('cn2b-stored-workbook-panel');
const instPanel = () => screen.getByTestId('cn2b-instmap-panel');
const inInst = (id: string) => within(instPanel()).getByTestId(id);
const picker = () => inInst('cn2b-instmap-beneficiary') as HTMLSelectElement;
const items = () => within(instPanel()).queryAllByTestId('cn2b-instmap-item');
const gridCell = (a1: string) => document.querySelector<HTMLElement>(`[role="gridcell"][data-a1="${a1}"]`);
const columnButton = (index: number) => within(screen.getByTestId('cn2b-xl-grid')).getAllByTestId('cn2b-xl-colbutton')[index];

async function viewerSettled(expected: 'trusted' | 'unproven') {
  await waitFor(() => expect(screen.getByTestId('cn2b-xl-viewer')).toBeInTheDocument(), { timeout: 10_000 });
  await waitFor(() => expect(storedPanel().getAttribute('data-source-identity')).toBe(expected));
}

async function openMapping(batches: ImportBatch[], rows: EntryRow[], lang: 'ar' | 'en' = 'en') {
  entriesDb.rows = rows;
  const fetchStub = stubNetwork();
  const view = render(<StoredWorkbookMapping lang={lang} batches={batches} careInstitutions={CARE_INSTITUTIONS} />);
  fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
  return { ...view, fetchStub };
}

/** Name cell by clicking it, Need column by its letter, then the explicit choice and Add. */
function mapColumn(nameCell: string, columnIndex: number, orgId: string) {
  fireEvent.click(gridCell(nameCell)!);
  fireEvent.click(inInst('cn2b-instmap-capture-anchor'));
  fireEvent.click(columnButton(columnIndex));
  fireEvent.click(inInst('cn2b-instmap-capture-need'));
  fireEvent.change(picker(), { target: { value: orgId } });
  fireEvent.click(inInst('cn2b-instmap-commit'));
}

describe('E2-C.13 — explicit multi-institution mapping on the trusted stored source', () => {
  it('a header equal to an institution\'s name, code or id pre-selects nothing, and no cell text reaches E2-C', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    expect(instPanel()).toHaveAttribute('data-instmap-state', 'unavailable');
    for (const [nameCell, col] of [['C1', 2], ['D1', 3], ['E1', 4]] as const) {
      expect(gridCell(nameCell)).toBeInTheDocument();
      fireEvent.click(gridCell(nameCell)!);
      fireEvent.click(inInst('cn2b-instmap-capture-anchor'));
      fireEvent.click(columnButton(col));
      fireEvent.click(inInst('cn2b-instmap-capture-need'));
      expect(picker().value).toBe('');
      expect(inInst('cn2b-instmap-commit')).toBeDisabled();
    }
    expect(items()).toHaveLength(0);
    // The workbook's own text is shown by the viewer only — never inside the E2-C panel.
    for (const workbookText of ['مستشفى الأمل', 'Paracetamol', 'Ibuprofen', '0012345']) {
      expect(instPanel()).not.toHaveTextContent(workbookText);
    }
  });

  it('two institutions on one sheet, next to E2-B\'s National Code and Material columns', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    fireEvent.click(columnButton(0));
    fireEvent.click(screen.getByTestId('cn2b-map-assign-national_code'));
    fireEvent.click(columnButton(1));
    fireEvent.click(screen.getByTestId('cn2b-map-assign-material'));

    mapColumn('C1', 2, 'org-a');
    mapColumn('D1', 3, 'org-b');
    expect(items().map((i) => [i.getAttribute('data-beneficiary-id'), i.getAttribute('data-valid')])).toEqual([
      ['org-a', 'true'], ['org-b', 'true'],
    ]);
    expect(within(items()[0]).getByTestId('cn2b-instmap-item-anchor')).toHaveTextContent('Cell C1');
    expect(within(items()[1]).getByTestId('cn2b-instmap-item-need')).toHaveTextContent('Column D');

    // The National Code column cannot become a third institution's Need source.
    fireEvent.click(gridCell('E1')!);
    fireEvent.click(inInst('cn2b-instmap-capture-anchor'));
    fireEvent.click(columnButton(0));
    fireEvent.click(inInst('cn2b-instmap-capture-need'));
    fireEvent.change(picker(), { target: { value: 'org-c' } });
    fireEvent.click(inInst('cn2b-instmap-commit'));
    expect(screen.getByRole('alert')).toHaveTextContent('The Need source includes the National Code column. Nothing was changed.');
    expect(items()).toHaveLength(2);
    expect(screen.getByTestId('cn2b-map-role-national_code')).toHaveAttribute('data-column-index', '0');
  });

  it('a rectangular Need range by Shift+click keeps all four coordinates; a whole column by Ctrl+Space', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    fireEvent.click(gridCell('C1')!);
    fireEvent.click(inInst('cn2b-instmap-capture-anchor'));
    fireEvent.click(gridCell('C2')!);
    fireEvent.click(gridCell('E3')!, { shiftKey: true });
    expect(inInst('cn2b-instmap-capture-need')).toHaveAccessibleName('Use range C2:E3 for the Need quantities');
    fireEvent.click(inInst('cn2b-instmap-capture-need'));
    expect(inInst('cn2b-instmap-draft-need')).toHaveTextContent('Range C2:E3');
    fireEvent.change(picker(), { target: { value: 'org-a' } });
    fireEvent.click(inInst('cn2b-instmap-commit'));
    expect(within(items()[0]).getByTestId('cn2b-instmap-item-need')).toHaveTextContent('Range C2:E3');

    fireEvent.click(gridCell('D2')!);
    fireEvent.keyDown(screen.getByTestId('cn2b-xl-grid'), { key: ' ', code: 'Space', ctrlKey: true });
    expect(inInst('cn2b-instmap-capture-need')).toHaveAccessibleName('Use column D for the Need quantities');
  });

  it('the same institution with two independent Need columns is accepted; the exact duplicate is refused', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    mapColumn('C1', 2, 'org-a');
    mapColumn('D1', 3, 'org-a');
    expect(items().map((i) => [i.getAttribute('data-beneficiary-id'), i.getAttribute('data-valid')])).toEqual([
      ['org-a', 'true'], ['org-a', 'true'],
    ]);
    mapColumn('C1', 2, 'org-a');
    expect(screen.getByRole('alert')).toHaveTextContent('This exact mapping already exists. Nothing was changed.');
    expect(items()).toHaveLength(2);
  });
});

describe('E2-C.14 — no draft survives a change of source or sheet', () => {
  it('changing sheet discards the institution mappings; returning does not resurrect them', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    mapColumn('C1', 2, 'org-a');
    expect(items()).toHaveLength(1);
    fireEvent.click(screen.getByRole('tab', { name: /مخفية/ }));
    expect(instPanel()).toHaveAttribute('data-instmap-state', 'unavailable');
    expect(items()).toHaveLength(0);
    fireEvent.click(screen.getByRole('tab', { name: /Sheet1/ }));
    fireEvent.click(gridCell('C1')!);
    expect(instPanel()).toHaveAttribute('data-instmap-state', 'ready');
    expect(items()).toHaveLength(0);
  });

  it('changing the ZIP workbook discards the institution mappings', async () => {
    await openMapping([ZIP_BATCH], ZIP_ROWS);
    await viewerSettled('trusted');
    mapColumn('C1', 2, 'org-a');
    fireEvent.change(screen.getByTestId('cn2b-xl-workbook-select'), { target: { value: '1' } });
    expect(instPanel()).toHaveAttribute('data-instmap-state', 'unavailable');
    fireEvent.click(gridCell('C1')!);
    expect(items()).toHaveLength(0);
  });

  it('closing and reopening the viewer does not resurrect the draft', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    mapColumn('C1', 2, 'org-a');
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-close'));
    expect(items()).toHaveLength(0);
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
    await viewerSettled('trusted');
    fireEvent.click(gridCell('C1')!);
    expect(items()).toHaveLength(0);
  });

  it('an unproven source leaves the workbook readable and E2-C unavailable', async () => {
    await openMapping([FILE_BATCH], [{ ...FILE_ROWS[0], entry_sha256: 'f'.repeat(64) }]);
    await viewerSettled('unproven');
    expect(gridCell('C1')).toHaveTextContent('مستشفى الأمل');
    fireEvent.click(gridCell('C1')!);
    expect(instPanel()).toHaveAttribute('data-instmap-state', 'unavailable');
    expect(within(instPanel()).queryByTestId('cn2b-instmap-capture-anchor')).toBeNull();
  });
});

describe('E2-C.15 — the workspace: trusted institutions in, plan owner out, revision-scoped memory', () => {
  const revision = (id: string): PlanRevision => ({
    id, planId: 'p', organizationId: PLAN_OWNER, planYear: 2027, revisionNumber: id === 'rev-1' ? 1 : 2, status: 'draft',
  });
  const workspace = (id: string, batches: ImportBatch[]) => (
    <CentralNeedsSimpleWorkspace
      lang="en" planYear={2027} onPlanYearChange={() => {}} revisionsLoading={false}
      revision={revision(id)} isDraft revisionDataReady canImport canEdit busy={false} activity={null}
      onOpenRevision={() => {}} preview={{ phase: 'idle' }} pendingFile={null} onPickFile={() => {}} onVerify={() => {}}
      error={null} notice={null} readiness={null} batches={batches} beneficiaryColumns={[]} careInstitutions={CARE_INSTITUTIONS}
      records={[]} dispositions={[]} activeSessionId={null} onChanged={() => {}} onSwitchToAdvanced={() => {}}
    />
  );

  it('offers exactly the screen\'s care institutions, never the plan owner; a revision switch destroys the draft', async () => {
    entriesDb.rows = [...FILE_ROWS, { ...FILE_ROWS[0], id: 'entry-rev2', batch_id: 'batch-rev2', import_session_id: 'session-rev2' }];
    stubNetwork();
    const view = render(workspace('rev-1', [FILE_BATCH]));
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
    await viewerSettled('trusted');
    fireEvent.click(gridCell('C1')!);
    expect([...picker().options].map((o) => o.value)).toEqual(['', 'org-a', 'org-b', 'org-c']);
    mapColumn('C1', 2, 'org-a');
    expect(items().map((i) => i.getAttribute('data-beneficiary-id'))).toEqual(['org-a']);
    expect(instPanel().innerHTML).not.toContain(PLAN_OWNER);
    const before = instPanel();

    view.rerender(workspace('rev-2', [{ ...FILE_BATCH, id: 'batch-rev2', planRevisionId: 'rev-2' }]));
    expect(instPanel()).not.toBe(before);
    expect(instPanel()).toHaveAttribute('data-instmap-state', 'unavailable');
    expect(items()).toHaveLength(0);
  });
});

describe('E2-C.16 — memory only, no write surface, both directions', () => {
  it('mapping, editing, removing and resetting persist nothing and call no new backend surface', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const hrefBefore = window.location.href;
    const { fetchStub } = await openMapping([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    mapColumn('C1', 2, 'org-a');
    mapColumn('D1', 3, 'org-b');
    fireEvent.click(inInst('cn2b-instmap-edit-im-1'));
    fireEvent.click(columnButton(4));
    fireEvent.click(inInst('cn2b-instmap-capture-need'));
    fireEvent.click(inInst('cn2b-instmap-commit'));
    fireEvent.click(inInst('cn2b-instmap-remove-im-2'));
    fireEvent.click(inInst('cn2b-instmap-reset'));
    fireEvent.click(inInst('cn2b-instmap-reset-yes'));
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-close'));
    act(() => undefined);

    expect(setItem).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(window.location.href).toBe(hrefBefore);
    expect(document.cookie).toBe('');
    expect(backendAccess).toEqual([]);
    expect(fetchStub.mock.calls.map(([url, init]) => `${init?.method} ${String(url).split('?')[0]}`)).toEqual([
      `POST ${ENDPOINT}`,
      `GET ${SIGNED_URL.split('?')[0]}`,
    ]);
    expect(entryReads.filter((r) => r.startsWith('select'))).toHaveLength(1);
  });

  it('Arabic: the institution panel is right-to-left with Arabic copy and Arabic names', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS, 'ar');
    await viewerSettled('trusted');
    fireEvent.click(gridCell('C1')!);
    expect(instPanel()).toHaveAttribute('dir', 'rtl');
    expect(inInst('cn2b-instmap-capture-anchor')).toHaveAccessibleName('استخدام الخلية C1 كخلية اسم المؤسسة');
    mapColumn('C1', 2, 'org-a');
    expect(within(items()[0]).getByTestId('cn2b-instmap-item-name')).toHaveTextContent('مستشفى الأمل');
    expect(within(items()[0]).getByTestId('cn2b-instmap-item-need')).toHaveTextContent('العمود C');
  });

  it('English: the institution panel is left-to-right with English copy', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS, 'en');
    await viewerSettled('trusted');
    expect(instPanel()).toHaveAttribute('dir', 'ltr');
    expect(within(instPanel()).getByRole('heading', { name: 'Institution Need mapping' })).toBeInTheDocument();
  });
});
