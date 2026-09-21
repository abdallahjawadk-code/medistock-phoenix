/** @vitest-environment jsdom */
/**
 * E2-B.9 — the Sheet Mapping Profile over the REAL trusted stored source.
 *
 * REAL, unmodified: StoredWorkbookPanel (its `onSelectionChange` bridge),
 * ExcelWorkbookViewer, ExcelSheetGrid, sourceIdentityBridge,
 * `requestSourceDownload`, `listBatchEntries`, the preview hook, the production
 * `import/worker.ts` and the CN-2A cores; the E2-B reducer, hook and panel; the
 * workspace.
 *
 * STUBBED, transport only (exactly as the E2-A suite): `fetch`, the Supabase
 * auth read, the query transport for `central_needs_import_batch_entries`, and
 * the Worker thread. Every other Supabase surface is a tripwire.
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
        if (prop === 'auth') return { getSession: async () => ({ data: { session: { access_token: 'e2b-test-token' } } }) };
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
  backendAccess.length = 0;
  entryReads.length = 0;
  entriesDb.rows = [];
  entriesDb.error = null;
});

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const exactBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/**
 * The headers deliberately contradict any "sensible" guess: column B's header
 * literally says National Code, column A says Material. E2-B must not care.
 */
function workbookBytes(label: string): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['Material', 'National Code', 'الكمية'], ['0012345', label, 3], ['0067890', 'Y', 4]]),
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

const STANDALONE = workbookBytes('X-001');
const FILE_BATCH: ImportBatch = {
  id: 'batch-file', planRevisionId: 'rev-1', containerKind: 'file', containerFilename: 'National Code.xlsx',
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
    throw new Error(`E2-B made an unexpected network call: ${url}`);
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

const storedPanel = () => screen.getByTestId('cn2b-stored-workbook-panel');
const mappingPanel = () => screen.getByTestId('cn2b-map-panel');
const assignButton = (role: 'national_code' | 'material') => screen.getByTestId(`cn2b-map-assign-${role}`);
const roleColumnOf = (role: 'national_code' | 'material') =>
  screen.getByTestId(`cn2b-map-role-${role}`).getAttribute('data-column-index');
const gridCell = (a1: string) => document.querySelector<HTMLElement>(`[role="gridcell"][data-a1="${a1}"]`);
const columnButton = (index: number) => within(screen.getByTestId('cn2b-xl-grid')).getAllByTestId('cn2b-xl-colbutton')[index];

async function viewerSettled(expected: 'trusted' | 'unproven') {
  await waitFor(() => expect(screen.getByTestId('cn2b-xl-viewer')).toBeInTheDocument(), { timeout: 10_000 });
  await waitFor(() => expect(storedPanel().getAttribute('data-source-identity')).toBe(expected));
}

async function openMapping(batches: ImportBatch[], rows: EntryRow[], lang: 'ar' | 'en' = 'en') {
  entriesDb.rows = rows;
  const fetchStub = stubNetwork();
  const view = render(<StoredWorkbookMapping lang={lang} batches={batches} />);
  fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
  return { ...view, fetchStub };
}

describe('E2-B.9 — explicit human assignment on the trusted stored source', () => {
  it('column header → National Code; another column → Material — regardless of what the headers say', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    expect(mappingPanel()).toHaveAttribute('data-mapping-state', 'unavailable');
    expect(assignButton('national_code')).toBeDisabled();

    // Column A's header says "Material"; the human declares it National Code. Nothing objects.
    fireEvent.click(columnButton(0));
    expect(mappingPanel()).toHaveAttribute('data-mapping-state', 'ready');
    expect(screen.getByTestId('cn2b-map-selected')).toHaveTextContent('Column A');
    fireEvent.click(assignButton('national_code'));
    expect(roleColumnOf('national_code')).toBe('0');

    fireEvent.click(columnButton(2));
    fireEvent.click(assignButton('material'));
    expect(roleColumnOf('material')).toBe('2');
    expect(roleColumnOf('national_code')).toBe('0');
    // Column B ("National Code" header) was never touched by anything but the human.
    expect(screen.getByTestId('cn2b-map-roles')).not.toHaveTextContent('Column B');
  });

  it('the same column cannot hold both roles', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    fireEvent.click(columnButton(1));
    fireEvent.click(assignButton('national_code'));
    fireEvent.click(assignButton('material'));
    expect(screen.getByRole('alert')).toHaveTextContent('Column B is already the National Code column.');
    expect(roleColumnOf('national_code')).toBe('1');
    expect(roleColumnOf('material')).toBe('');
  });

  it('clear and reassign', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    fireEvent.click(columnButton(1));
    fireEvent.click(assignButton('national_code'));
    fireEvent.click(screen.getByTestId('cn2b-map-clear-national_code'));
    expect(roleColumnOf('national_code')).toBe('');
    fireEvent.click(assignButton('material'));
    expect(roleColumnOf('material')).toBe('1');
    fireEvent.click(columnButton(0));
    fireEvent.click(assignButton('national_code'));
    expect(roleColumnOf('national_code')).toBe('0');
  });

  it('a cell or a range selection cannot assign', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    fireEvent.click(gridCell('B2')!);
    expect(screen.getByTestId('cn2b-map-selected')).toHaveTextContent('Cell B2');
    expect(assignButton('national_code')).toBeDisabled();
    expect(assignButton('material')).toBeDisabled();
    fireEvent.click(gridCell('A1')!);
    fireEvent.click(gridCell('B3')!, { shiftKey: true });
    expect(screen.getByTestId('cn2b-map-selected')).toHaveTextContent('Range A1:B3');
    expect(assignButton('national_code')).toBeDisabled();
    expect(screen.getByTestId('cn2b-map-column-required')).toBeInTheDocument();
  });

  it('keyboard: Ctrl+Space on the active cell selects its column, which can then be assigned', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    fireEvent.click(gridCell('C2')!);
    fireEvent.keyDown(screen.getByTestId('cn2b-xl-grid'), { key: ' ', code: 'Space', ctrlKey: true });
    expect(screen.getByTestId('cn2b-map-selected')).toHaveTextContent('Column C');
    expect(assignButton('material')).toBeEnabled();
    fireEvent.click(assignButton('material'));
    expect(roleColumnOf('material')).toBe('2');
  });
});

describe('E2-B.10 — reset rules: no draft survives a change of context', () => {
  it('changing sheet resets the mapping, and returning does not resurrect it', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    fireEvent.click(columnButton(0));
    fireEvent.click(assignButton('national_code'));
    expect(roleColumnOf('national_code')).toBe('0');

    fireEvent.click(screen.getByRole('tab', { name: /مخفية/ }));
    expect(mappingPanel()).toHaveAttribute('data-mapping-state', 'unavailable');
    expect(roleColumnOf('national_code')).toBe('');
    fireEvent.click(columnButton(0));
    expect(screen.getByTestId('cn2b-map-sheet')).toHaveTextContent('مخفية');
    expect(roleColumnOf('national_code')).toBe('');

    fireEvent.click(screen.getByRole('tab', { name: /Sheet1/ }));
    fireEvent.click(columnButton(0));
    expect(screen.getByTestId('cn2b-map-sheet')).toHaveTextContent('Sheet1');
    expect(roleColumnOf('national_code')).toBe('');
  });

  it('changing the ZIP workbook resets the mapping', async () => {
    await openMapping([ZIP_BATCH], ZIP_ROWS);
    await viewerSettled('trusted');
    fireEvent.click(columnButton(0));
    fireEvent.click(assignButton('national_code'));
    expect(roleColumnOf('national_code')).toBe('0');
    fireEvent.change(screen.getByTestId('cn2b-xl-workbook-select'), { target: { value: '1' } });
    expect(mappingPanel()).toHaveAttribute('data-mapping-state', 'unavailable');
    fireEvent.click(columnButton(0));
    expect(roleColumnOf('national_code')).toBe('');
  });

  it('changing the batch resets the mapping', async () => {
    await openMapping([FILE_BATCH, ZIP_BATCH], [...FILE_ROWS, ...ZIP_ROWS]);
    await viewerSettled('trusted');
    fireEvent.click(columnButton(0));
    fireEvent.click(assignButton('material'));
    expect(roleColumnOf('material')).toBe('0');
    fireEvent.change(screen.getByTestId('cn2b-stored-workbook-select'), { target: { value: 'batch-file' } });
    expect(mappingPanel()).toHaveAttribute('data-mapping-state', 'unavailable');
    expect(roleColumnOf('material')).toBe('');
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
    await viewerSettled('trusted');
    fireEvent.click(columnButton(0));
    expect(roleColumnOf('material')).toBe('');
  });

  it('closing and reopening the viewer does not resurrect the draft', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    fireEvent.click(columnButton(1));
    fireEvent.click(assignButton('national_code'));
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-close'));
    expect(mappingPanel()).toHaveAttribute('data-mapping-state', 'unavailable');
    expect(roleColumnOf('national_code')).toBe('');
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
    await viewerSettled('trusted');
    fireEvent.click(columnButton(1));
    expect(roleColumnOf('national_code')).toBe('');
  });

  it('a revision switch remounts the whole stored-source surface: nothing of E2-B survives', async () => {
    entriesDb.rows = [...FILE_ROWS, { ...FILE_ROWS[0], id: 'entry-rev2', batch_id: 'batch-rev2', import_session_id: 'session-rev2' }];
    stubNetwork();
    const revision = (id: string): PlanRevision => ({
      id, planId: 'p', organizationId: 'o', planYear: 2027, revisionNumber: id === 'rev-1' ? 1 : 2, status: 'draft',
    });
    const workspace = (id: string, batches: ImportBatch[]) => (
      <CentralNeedsSimpleWorkspace
        lang="en" planYear={2027} onPlanYearChange={() => {}} revisionsLoading={false}
        revision={revision(id)} isDraft revisionDataReady canImport canEdit busy={false} activity={null}
        onOpenRevision={() => {}} preview={{ phase: 'idle' }} pendingFile={null} onPickFile={() => {}} onVerify={() => {}}
        error={null} notice={null} readiness={null} batches={batches} beneficiaryColumns={[]} careInstitutions={[]}
        records={[]} dispositions={[]} activeSessionId={null} onChanged={() => {}} onSwitchToAdvanced={() => {}}
      />
    );
    const view = render(workspace('rev-1', [FILE_BATCH]));
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
    await viewerSettled('trusted');
    fireEvent.click(columnButton(0));
    fireEvent.click(assignButton('national_code'));
    expect(roleColumnOf('national_code')).toBe('0');
    const panelBefore = mappingPanel();

    view.rerender(workspace('rev-2', [{ ...FILE_BATCH, id: 'batch-rev2', planRevisionId: 'rev-2' }]));
    expect(mappingPanel()).not.toBe(panelBefore);
    expect(mappingPanel()).toHaveAttribute('data-mapping-state', 'unavailable');
    expect(roleColumnOf('national_code')).toBe('');
    expect(screen.queryByTestId('cn2b-xl-viewer')).toBeNull();
  });
});

describe('E2-B.11 — fail closed on an unproven source', () => {
  it('a source identity refusal leaves the workbook readable and E2-B unavailable', async () => {
    await openMapping([FILE_BATCH], [{ ...FILE_ROWS[0], entry_sha256: 'f'.repeat(64) }]);
    await viewerSettled('unproven');
    expect(storedPanel()).toHaveAttribute('data-source-identity-reason', 'sha_mismatch');
    expect(gridCell('B1')).toHaveTextContent('National Code');
    expect(within(screen.getByTestId('cn2b-xl-grid')).queryAllByTestId('cn2b-xl-colbutton')).toHaveLength(0);
    fireEvent.click(gridCell('A1')!);
    fireEvent.keyDown(screen.getByTestId('cn2b-xl-grid'), { key: ' ', code: 'Space', ctrlKey: true });
    expect(mappingPanel()).toHaveAttribute('data-mapping-state', 'unavailable');
    expect(assignButton('national_code')).toBeDisabled();
    expect(assignButton('material')).toBeDisabled();
  });

  it('a failed entry read also leaves E2-B unavailable', async () => {
    entriesDb.error = { message: 'permission denied for table central_needs_import_batch_entries' };
    await openMapping([FILE_BATCH], FILE_ROWS);
    await viewerSettled('unproven');
    expect(mappingPanel()).toHaveAttribute('data-mapping-state', 'unavailable');
    expect(assignButton('material')).toBeDisabled();
  });
});

describe('E2-B.12 — memory only, no write surface, both directions', () => {
  it('assigning and clearing persists nothing and calls no new backend surface', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const hrefBefore = window.location.href;
    const { fetchStub } = await openMapping([FILE_BATCH], FILE_ROWS);
    await viewerSettled('trusted');
    fireEvent.click(columnButton(0));
    fireEvent.click(assignButton('national_code'));
    fireEvent.click(columnButton(2));
    fireEvent.click(assignButton('material'));
    fireEvent.click(screen.getByTestId('cn2b-map-clear-material'));
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-close'));
    act(() => undefined);

    expect(setItem).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(window.location.href).toBe(hrefBefore);
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

  it('Arabic: the mapping panel is right-to-left with Arabic copy', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS, 'ar');
    await viewerSettled('trusted');
    fireEvent.click(columnButton(0));
    expect(mappingPanel()).toHaveAttribute('dir', 'rtl');
    expect(assignButton('national_code')).toHaveAccessibleName('استخدام العمود A للرمز الوطني');
    fireEvent.click(assignButton('national_code'));
    expect(screen.getByTestId('cn2b-map-role-national_code')).toHaveTextContent('العمود A');
  });

  it('English: the mapping panel is left-to-right with English copy', async () => {
    await openMapping([FILE_BATCH], FILE_ROWS, 'en');
    await viewerSettled('trusted');
    expect(mappingPanel()).toHaveAttribute('dir', 'ltr');
    expect(within(mappingPanel()).getByRole('heading', { name: 'Sheet mapping profile' })).toBeInTheDocument();
  });
});
