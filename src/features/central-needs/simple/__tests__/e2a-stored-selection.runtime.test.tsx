/** @vitest-environment jsdom */
/**
 * E2-A.5 / E2-A.6 — trusted physical selection in the E1.1 persistent source viewer.
 *
 * REAL, unmodified: StoredWorkbookPanel; `requestSourceDownload` and
 * `listBatchEntries` (the only new data call — a SELECT); the preview hook,
 * the production `import/worker.ts`, the CN-2A cores; the viewer; the bridge.
 *
 * STUBBED, transport only (as in the E1.1 suite): `fetch` (endpoint JSON and
 * signed-URL bytes), the Supabase auth read, the Supabase query transport for
 * exactly `central_needs_import_batch_entries` (rows chosen per test — the
 * way RLS would return them), and the Worker thread (in-process hand-off to
 * the real worker.ts handler). Every other Supabase surface is a tripwire.
 */
import '@testing-library/jest-dom/vitest';
import { createHash } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as XLSX from 'xlsx';
import type { ImportBatch } from '../../central-needs.service';
import type { WorkbookSelection } from '../../excel-first/workbookSelection';
import type { PreviewState } from '../../useCentralNeedsPreview';

interface EntryRow {
  id: string;
  batch_id: string;
  entry_ordinal: number;
  archive_entry_path: string | null;
  entry_sha256: string;
  import_session_id: string;
}

const { backendAccess, entryReads, entriesDb, workerLog } = vi.hoisted(() => ({
  backendAccess: [] as string[],
  entryReads: [] as string[],
  /** What RLS returns for the batch-entry SELECT in the current test. */
  entriesDb: { rows: [] as EntryRow[], error: null as { message: string } | null },
  workerLog: { messages: [] as string[] },
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
        if (prop === 'auth') return { getSession: async () => ({ data: { session: { access_token: 'e2a-test-token' } } }) };
        if (prop === 'from') return entriesQuery;
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        backendAccess.push(String(prop));
        return undefined;
      },
    }),
  };
});

/** The production worker's global scope, emulated (see the E1.1 suite). */
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
    workerLog.messages.push(data.type);
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
const { StoredWorkbookPanel } = await import('../StoredWorkbookPanel');
const { CentralNeedsSimpleWorkspace } = await import('../CentralNeedsSimpleWorkspace');
const { parseWorkbookBytes } = await import('../../import/parser-core');

const ENDPOINT = '/api/central-needs/source-download';
const SIGNED_URL = 'https://storage.example.invalid/storage/v1/object/sign/central-needs-sources/opaque?token=signed';

beforeEach(() => {
  stubWorkerRealm();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  backendAccess.length = 0;
  entryReads.length = 0;
  entriesDb.rows = [];
  entriesDb.error = null;
  workerLog.messages.length = 0;
});

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const exactBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const gridCell = (a1: string) => document.querySelector<HTMLElement>(`[role="gridcell"][data-a1="${a1}"]`);
const panel = () => screen.getByTestId('cn2b-stored-workbook-panel');

function workbookBytes(label: string): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['الرمز', 'القيمة'], [label, 1], ['Y', 2]]), 'Sheet1');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['hidden', 1]]), 'مخفية');
  wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

/** A deterministic ZIP with STORED entries (method 0), built from first principles. */
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

const STANDALONE = workbookBytes('X-001');
const FILE_BATCH: ImportBatch = {
  id: 'batch-file', planRevisionId: 'rev-1', containerKind: 'file', containerFilename: 'احتياج 2027.xlsx',
  containerSha256: sha256(STANDALONE), acceptedEntryCount: 1, excludedEntryCount: 0, registeredAt: '2026-09-19T00:00:00.000Z',
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
  containerSha256: sha256(ZIP), acceptedEntryCount: 2, excludedEntryCount: 0, registeredAt: '2026-09-19T01:00:00.000Z',
};
/** Exactly what finalize-import registers: ordinal = i + 1, the member's SHA-256 and path. */
const ZIP_ROWS: EntryRow[] = ZIP_MEMBERS.map((m, i) => ({
  id: `entry-${i + 1}`, batch_id: 'batch-zip', entry_ordinal: i + 1, archive_entry_path: m.path,
  entry_sha256: sha256(m.bytes), import_session_id: `session-${i + 1}`,
}));

function stubNetwork(byBatch: Record<string, { batch: ImportBatch; bytes: Uint8Array }>) {
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
    throw new Error(`E2-A made an unexpected network call: ${url}`);
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

function openTrusted(batches: ImportBatch[], rows: EntryRow[]) {
  entriesDb.rows = rows;
  const fetchStub = stubNetwork({
    'batch-file': { batch: FILE_BATCH, bytes: STANDALONE },
    'batch-zip': { batch: ZIP_BATCH, bytes: ZIP },
  });
  const onSelectionChange = vi.fn<(selection: WorkbookSelection | null) => void>();
  const view = render(<StoredWorkbookPanel lang="ar" batches={batches} onSelectionChange={onSelectionChange} />);
  fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
  const last = () => onSelectionChange.mock.calls.at(-1)?.[0] ?? null;
  return { ...view, fetchStub, onSelectionChange, last };
}

const identityState = () => panel().getAttribute('data-source-identity');

async function viewerSettled(expected: 'trusted' | 'unproven') {
  await waitFor(() => expect(screen.getByTestId('cn2b-xl-viewer')).toBeInTheDocument(), { timeout: 10_000 });
  await waitFor(() => expect(identityState()).toBe(expected));
}

describe('10 · SOURCE IDENTITY — standalone file', () => {
  it('verified bytes + exactly one matching entry → trusted selection with that entry\'s identity', async () => {
    const { last } = openTrusted([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    expect(screen.getByTestId('cn2b-xl-grid')).toHaveAttribute('data-selectable', 'true');
    fireEvent.click(gridCell('B2')!);
    expect(last()).toEqual({
      kind: 'cell',
      source: {
        batchId: 'batch-file', entryId: 'entry-file', entryOrdinal: 1, entrySha256: sha256(STANDALONE),
        importSessionId: 'session-file', workbookIndex: 0,
      },
      sheetIndex: 0, sheetName: 'Sheet1', rowIndex: 1, columnIndex: 1, a1: 'B2', mergedRange: null,
    });
    // The one new data access: a SELECT of this batch's own entries.
    expect(entryReads).toEqual([
      'select id, batch_id, entry_ordinal, archive_entry_path, entry_sha256, import_session_id',
      'eq batch_id=batch-file',
      'order entry_ordinal',
    ]);
    expect(backendAccess).toEqual([]);
  });
});

describe('11 · SOURCE IDENTITY — ZIP, and 6 · workbook switch', () => {
  it('each of the N parsed workbooks maps to its own entry; switching workbook clears and re-identifies', async () => {
    const { last, onSelectionChange } = openTrusted([ZIP_BATCH], ZIP_ROWS);
    await viewerSettled('trusted');
    expect(workerLog.messages).toEqual(['parseArchive']);
    fireEvent.click(gridCell('A2')!);
    expect(last()).toMatchObject({ kind: 'cell', a1: 'A2', source: { entryId: 'entry-1', entryOrdinal: 1, importSessionId: 'session-1', workbookIndex: 0 } });

    fireEvent.change(screen.getByTestId('cn2b-xl-workbook-select'), { target: { value: '1' } });
    expect(last()).toBeNull();
    fireEvent.click(within(screen.getByTestId('cn2b-xl-grid')).getAllByTestId('cn2b-xl-colbutton')[1]);
    expect(last()).toEqual({
      kind: 'column',
      source: {
        batchId: 'batch-zip', entryId: 'entry-2', entryOrdinal: 2, entrySha256: sha256(ZIP_MEMBERS[1].bytes),
        importSessionId: 'session-2', workbookIndex: 1,
      },
      sheetIndex: 0, sheetName: 'Sheet1', columnIndex: 1,
    });
    expect(onSelectionChange.mock.calls.filter(([s]) => s !== null)).toHaveLength(2);
  });
});

describe('12–15 · a mismatch fails closed: the source stays visible, selection stays off', () => {
  it.each([
    ['12 · SHA mismatch', 'sha_mismatch', [FILE_BATCH], [{ ...FILE_ROWS[0], entry_sha256: 'f'.repeat(64) }]],
    ['13 · PATH mismatch', 'path_mismatch', [ZIP_BATCH], ZIP_ROWS.map((r, i) => (i === 1 ? { ...r, archive_entry_path: 'other/workbook-2.xlsx' } : r))],
    ['14 · ORDINAL mismatch', 'ordinal_mismatch', [ZIP_BATCH], ZIP_ROWS.map((r, i) => (i === 1 ? { ...r, entry_ordinal: 3 } : r))],
    ['15 · DUPLICATE / ambiguous', 'duplicate_entry', [ZIP_BATCH], ZIP_ROWS.map((r, i) => (i === 1 ? { ...r, import_session_id: 'session-1' } : r))],
    ['entry missing', 'entry_count_mismatch', [ZIP_BATCH], ZIP_ROWS.slice(0, 1)],
    ['no rows visible under RLS', 'entry_count_mismatch', [FILE_BATCH], []],
  ] as const)('%s → %s', async (_label, reason, batches, rows) => {
    const { onSelectionChange } = openTrusted([...batches], [...rows]);
    await viewerSettled('unproven');
    expect(panel()).toHaveAttribute('data-source-identity-reason', reason);
    // E1.1 viewing is intact …
    expect(screen.getByTestId('cn2b-stored-workbook-integrity-ok')).toBeInTheDocument();
    expect(gridCell('A1')).toHaveTextContent('الرمز');
    // … and E2-A selection is off: no header buttons, no multi-selection, no output.
    const grid = screen.getByTestId('cn2b-xl-grid');
    expect(grid).not.toHaveAttribute('data-selectable');
    expect(within(grid).queryAllByTestId('cn2b-xl-colbutton')).toHaveLength(0);
    fireEvent.click(gridCell('B2')!);
    fireEvent.click(gridCell('A1')!, { shiftKey: true });
    fireEvent.keyDown(grid, { key: ' ', code: 'Space', ctrlKey: true });
    expect(onSelectionChange.mock.calls.every(([s]) => s === null)).toBe(true);
  });

  it('a failed entry read (RLS / network) also leaves the source visible and selection off', async () => {
    entriesDb.error = { message: 'permission denied for table central_needs_import_batch_entries' };
    const { onSelectionChange } = openTrusted([FILE_BATCH], FILE_ROWS);
    await viewerSettled('unproven');
    expect(panel()).toHaveAttribute('data-source-identity-reason', 'entries_unavailable');
    expect(gridCell('A1')).toHaveTextContent('الرمز');
    fireEvent.click(gridCell('B2')!);
    expect(onSelectionChange.mock.calls.every(([s]) => s === null)).toBe(true);
  });
});

describe('16/17 · batch switch, close and remount end the selection', () => {
  it('16 · choosing another batch clears the old selection', async () => {
    const { last } = openTrusted([FILE_BATCH, ZIP_BATCH], [...FILE_ROWS, ...ZIP_ROWS]);
    await viewerSettled('trusted');
    expect(entryReads).toContain('eq batch_id=batch-zip');
    fireEvent.click(gridCell('A2')!);
    expect(last()).toMatchObject({ kind: 'cell', source: { batchId: 'batch-zip' } });
    fireEvent.change(screen.getByTestId('cn2b-stored-workbook-select'), { target: { value: 'batch-file' } });
    expect(last()).toBeNull();
    expect(screen.queryByTestId('cn2b-xl-viewer')).toBeNull();

    // The newly chosen batch is proven afresh, against its own entries.
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
    await viewerSettled('trusted');
    fireEvent.click(gridCell('A2')!);
    expect(last()).toMatchObject({ kind: 'cell', source: { batchId: 'batch-file', importSessionId: 'session-file' } });
  });

  it('closing the viewer clears the selection', async () => {
    const { last } = openTrusted([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    fireEvent.click(gridCell('B2')!);
    expect(last()).not.toBeNull();
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-close'));
    expect(last()).toBeNull();
  });

  it('17 · a revision switch (re-key) or unmount leaves no transient selection behind', async () => {
    const { last, rerender, onSelectionChange } = openTrusted([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    fireEvent.click(gridCell('B2')!);
    expect(last()).not.toBeNull();
    rerender(<StoredWorkbookPanel key="rev-2" lang="ar" batches={[{ ...FILE_BATCH, id: 'batch-rev2', planRevisionId: 'rev-2' }]} onSelectionChange={onSelectionChange} />);
    expect(last()).toBeNull();
    expect(screen.queryByTestId('cn2b-xl-viewer')).toBeNull();
    expect(panel()).not.toHaveAttribute('data-source-identity');
  });

  it('reopening the same batch proves the identity again rather than reusing a stale verdict', async () => {
    openTrusted([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-close'));
    entriesDb.rows = [{ ...FILE_ROWS[0], entry_sha256: 'f'.repeat(64) }];
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
    await viewerSettled('unproven');
    expect(panel()).toHaveAttribute('data-source-identity-reason', 'sha_mismatch');
  });
});

describe('18 · MEMORY ONLY, and no write surface', () => {
  it('selection is never persisted; the only data calls are the source-download read and the entry SELECT', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { fetchStub, last } = openTrusted([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    fireEvent.click(gridCell('A1')!);
    fireEvent.click(gridCell('B3')!, { shiftKey: true });
    expect(last()).toMatchObject({ kind: 'range', a1Range: 'A1:B3' });
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-close'));
    act(() => undefined);

    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    expect(backendAccess).toEqual([]);
    expect(fetchStub.mock.calls.map(([url, init]) => `${init?.method} ${String(url).split('?')[0]}`)).toEqual([
      `POST ${ENDPOINT}`,
      `GET ${SIGNED_URL.split('?')[0]}`,
    ]);
    expect(entryReads.filter((r) => r.startsWith('select'))).toHaveLength(1);
  });
});

describe('E2-A.6 — the provisional upload preview is never an authoritative selection source', () => {
  it('the Simple upload preview renders the E1 viewer without selection, even beside a registered batch', async () => {
    const bytes = workbookBytes('P-1');
    const parsed = await parseWorkbookBytes(bytes, 'pending.xlsx', { runtime: 'browser_worker' });
    const preview: PreviewState = { phase: 'ready', filename: 'pending.xlsx', outcome: { kind: 'file', result: parsed, json: '' } };
    render(
      <CentralNeedsSimpleWorkspace
        lang="ar" planYear={2027} onPlanYearChange={() => {}} revisionsLoading={false}
        revision={{ id: 'rev-1', planId: 'p', organizationId: 'o', planYear: 2027, revisionNumber: 1, status: 'draft' }}
        isDraft revisionDataReady canImport canEdit busy={false} activity={null} onOpenRevision={() => {}}
        preview={preview} pendingFile={new File([exactBuffer(bytes)], 'pending.xlsx')} onPickFile={() => {}} onVerify={() => {}}
        error={null} notice={null} readiness={null} batches={[FILE_BATCH]} beneficiaryColumns={[]} careInstitutions={[]}
        records={[]} dispositions={[]} activeSessionId={null} onChanged={() => {}} onSwitchToAdvanced={() => {}}
      />,
    );
    const upload = screen.getByTestId('cn2b-simple-upload');
    const grid = within(upload).getByTestId('cn2b-xl-grid');
    expect(grid).not.toHaveAttribute('data-selectable');
    expect(within(grid).queryAllByTestId('cn2b-xl-colbutton')).toHaveLength(0);
    // The registered source is offered separately, closed, and has read nothing yet.
    expect(screen.getByTestId('cn2b-stored-workbook-panel')).toBeInTheDocument();
    expect(entryReads).toEqual([]);
  });
});
