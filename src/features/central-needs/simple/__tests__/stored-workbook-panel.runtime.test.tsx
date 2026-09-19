/** @vitest-environment jsdom */
/**
 * E1.1 — reopening the registered original source, end to end on the client.
 *
 * REAL, unmodified: StoredWorkbookPanel; `requestSourceDownload` and its
 * `authorizedFetch` (so the one business call is the EXISTING
 * POST /api/central-needs/source-download); `useCentralNeedsPreview`; the
 * production worker module `import/worker.ts` and the CN-2A parser and archive
 * cores it runs (including `browserInflate`); the unchanged ExcelWorkbookViewer.
 *
 * STUBBED, transport only:
 *   * the network — `fetch` answers the endpoint with the server's descriptor
 *     shape (api/_cn2b-core/source-download.ts) and the signed URL with the
 *     stored bytes; any other URL throws;
 *   * the Supabase auth session read `authorizedFetch` needs for its bearer
 *     token — every OTHER property of the Supabase client is a tripwire;
 *   * the Worker THREAD — `InProcessWorker` hands each message to the real
 *     worker.ts handler in-process, inside a worker-realm scope (`self` with
 *     its `location`, and the WHATWG Blob with `.stream()` that browserInflate
 *     uses and jsdom's Blob lacks).
 *
 * Observed, not assumed: parse() requests (the real hook, wrapped only to
 * record them), Worker construction and messages, parser-core/archive-core
 * invocations and the exact bytes they received.
 */
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as XLSX from 'xlsx';
import type { ImportBatch } from '../../central-needs.service';

const { backendAccess, authReads, entryReads, parseRequested, workerLog } = vi.hoisted(() => ({
  backendAccess: [] as string[],
  authReads: { count: 0 },
  /** E2-A: the one read the panel may add — this batch's own entries, SELECT only. */
  entryReads: [] as string[],
  parseRequested: vi.fn(),
  workerLog: { constructed: [] as string[], messages: [] as string[] },
}));

vi.mock('@/shared/supabase/client', () => {
  /**
   * E2-A: `listBatchEntries` is a read-only query. Only that exact chain on that
   * exact table answers (with no rows, so selection stays off here — E1.1 is
   * about viewing); any other table, verb or property is recorded as a
   * backend access, exactly as before.
   */
  const entriesQuery = (table: string) => {
    if (table !== 'central_needs_import_batch_entries') {
      backendAccess.push(`from:${table}`);
      return undefined;
    }
    const chain: Record<string, unknown> = {
      select: (columns: string) => { entryReads.push(`select ${columns}`); return guarded; },
      eq: (column: string, value: unknown) => { entryReads.push(`eq ${column}=${String(value)}`); return guarded; },
      order: (column: string) => { entryReads.push(`order ${column}`); return guarded; },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve, reject),
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
        if (prop === 'auth') {
          return {
            getSession: async () => {
              authReads.count += 1;
              return { data: { session: { access_token: 'e11-test-token' } } };
            },
          };
        }
        if (prop === 'from') return entriesQuery;
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        backendAccess.push(String(prop));
        return undefined;
      },
    }),
  };
});

vi.mock('../../import/parser-core', async () => {
  const actual = await vi.importActual<typeof import('../../import/parser-core')>('../../import/parser-core');
  return { ...actual, parseWorkbookBytes: vi.fn(actual.parseWorkbookBytes) };
});

vi.mock('../../import/archive-core', async () => {
  const actual = await vi.importActual<typeof import('../../import/archive-core')>('../../import/archive-core');
  return { ...actual, parseArchiveBytes: vi.fn(actual.parseArchiveBytes) };
});

vi.mock('../../useCentralNeedsPreview', async () => {
  const actual = await vi.importActual<typeof import('../../useCentralNeedsPreview')>('../../useCentralNeedsPreview');
  const { useCallback } = await import('react');
  /** The REAL hook, observed: every parse() the panel requests is recorded, then delegated unchanged. */
  function useObservedPreview() {
    const preview = actual.useCentralNeedsPreview();
    const { parse } = preview;
    const observedParse = useCallback((file: File) => {
      parseRequested(file);
      return parse(file);
    }, [parse]);
    return { ...preview, parse: observedParse };
  }
  return { ...actual, useCentralNeedsPreview: useObservedPreview };
});

/**
 * The production worker's global scope, emulated: `self.onmessage` in,
 * `self.postMessage` out, and `self.location` — which a WorkerGlobalScope has
 * too, and which Vite's dev transform of `new URL('./import/worker.ts',
 * import.meta.url)` in the hook resolves the worker URL against.
 */
const workerScope: {
  onmessage: ((event: { data: unknown }) => unknown) | null;
  postMessage: (data: unknown) => void;
  location: Location;
} = {
  onmessage: null,
  postMessage: () => { throw new Error('the worker replied with no Worker listening'); },
  location: globalThis.location,
};

/** The Worker THREAD, replaced by an in-process hand-off to the real worker.ts handler. */
class InProcessWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private terminated = false;

  constructor(url: URL | string) {
    workerLog.constructed.push(String(url));
  }

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
// Importing the production worker module registers its real handler on the emulated scope.
await import('../../import/worker');
const { StoredWorkbookPanel } = await import('../StoredWorkbookPanel');
const { parseWorkbookBytes } = await import('../../import/parser-core');
const { parseArchiveBytes } = await import('../../import/archive-core');
const { browserInflate } = await import('../../import/browser-inflate');
const { t } = await import('@/shared/i18n/strings');

const ENDPOINT = '/api/central-needs/source-download';
const SIGNED_URL = 'https://storage.example.invalid/storage/v1/object/sign/central-needs-sources/opaque?token=signed';
const ZIP_FIXTURE = join(__dirname, '../../import/__tests__/fixtures/synthetic-archive.zip');
/** The production worker entry the hook constructs (Vite serves it with a `?worker_file` query). */
const WORKER_URL = /\/src\/features\/central-needs\/import\/worker\.ts(\?|$)/;

beforeEach(() => {
  stubWorkerRealm();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  backendAccess.length = 0;
  authReads.count = 0;
  entryReads.length = 0;
  parseRequested.mockClear();
  workerLog.constructed.length = 0;
  workerLog.messages.length = 0;
  vi.mocked(parseWorkbookBytes).mockClear();
  vi.mocked(parseArchiveBytes).mockClear();
  delete (window as unknown as Record<string, unknown>).__e11_xss;
});

const sha256 = (bytes: Uint8Array | ArrayBuffer): string =>
  createHash('sha256').update(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).digest('hex');

const exactBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const gridCell = (a1: string) => document.querySelector<HTMLElement>(`[role="gridcell"][data-a1="${a1}"]`);

const batchOf = (over: Partial<ImportBatch> = {}): ImportBatch => ({
  id: 'batch-1',
  planRevisionId: 'rev-1',
  containerKind: 'file',
  containerFilename: 'احتياج 2027.xlsx',
  containerSha256: '0'.repeat(64),
  acceptedEntryCount: 1,
  excludedEntryCount: 0,
  registeredAt: '2026-09-19T00:00:00.000Z',
  ...over,
});

/** The server's 200 reply (api/_cn2b-core/source-download.ts) for a batch row. */
const descriptorFor = (b: ImportBatch, over: Record<string, unknown> = {}) => ({
  ok: true,
  url: SIGNED_URL,
  expiresInSeconds: 60,
  containerKind: b.containerKind,
  containerSha256: b.containerSha256,
  originalFilename: b.containerFilename,
  ...over,
});

interface NetworkPlan {
  endpoint: { status?: number; body: Record<string, unknown> };
  object?: { status?: number; bytes: ArrayBuffer; hold?: Promise<void> };
}

/** Routes the only two URLs E1.1 may reach; anything else fails the test. */
function stubNetwork(plan: NetworkPlan) {
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === ENDPOINT) {
      return new Response(JSON.stringify(plan.endpoint.body), {
        status: plan.endpoint.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === SIGNED_URL && plan.object) {
      const { hold } = plan.object;
      if (hold) {
        await new Promise<void>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
          void hold.then(resolve);
        });
      }
      return new Response(plan.object.bytes, { status: plan.object.status ?? 200 });
    }
    throw new Error(`E1.1 made an unexpected network call: ${url}`);
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

/**
 * A small real workbook: Arabic text, a number, an HTML-looking string and a
 * formula whose SAVED result (5) differs from its evaluation (2).
 */
function workbookBytes(): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet([
    ['الرمز', 'المادة', 'الكمية'],
    ['X-001', 'باراسيتامول 500 mg', 120],
  ]);
  ws.A3 = { t: 's', v: '<img src=x onerror="window.__e11_xss = 1">' };
  ws.B3 = { t: 'n', v: 5, f: '1+1' };
  ws['!ref'] = 'A1:C3';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'المجرد');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

function openPanel(batches: ImportBatch[]) {
  const view = render(<StoredWorkbookPanel lang="ar" batches={batches} />);
  fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
  return view;
}

function expectNothingParsed() {
  expect(parseRequested).not.toHaveBeenCalled();
  expect(workerLog.constructed).toEqual([]);
  expect(vi.mocked(parseWorkbookBytes)).not.toHaveBeenCalled();
  expect(vi.mocked(parseArchiveBytes)).not.toHaveBeenCalled();
  expect(screen.queryByTestId('cn2b-xl-viewer')).toBeNull();
  expect(screen.queryByTestId('cn2b-stored-workbook-integrity-ok')).toBeNull();
}

describe('E1.1 — A · correct bytes reopen through the existing endpoint, SHA-256 first, then ONE parse', () => {
  it('verifies SHA-256 before the single parse and shows the stored workbook in the unchanged viewer', async () => {
    const stored = workbookBytes();
    const b = batchOf({ containerSha256: sha256(stored) });
    const fetchStub = stubNetwork({ endpoint: { body: descriptorFor(b) }, object: { bytes: exactBuffer(stored) } });
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');

    openPanel([b]);
    await waitFor(() => expect(screen.getByTestId('cn2b-xl-viewer')).toBeInTheDocument(), { timeout: 10_000 });

    // Exactly one parse, of exactly the verified bytes, through the production worker.
    expect(parseRequested).toHaveBeenCalledTimes(1);
    const parsedFile = parseRequested.mock.calls[0][0] as File;
    expect(parsedFile.name).toBe(b.containerFilename);
    expect(sha256(await parsedFile.arrayBuffer())).toBe(b.containerSha256);
    expect(workerLog.constructed).toHaveLength(1);
    expect(workerLog.constructed[0]).toMatch(WORKER_URL);
    expect(workerLog.messages).toEqual(['parseWorkbook']);
    expect(vi.mocked(parseWorkbookBytes)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(parseArchiveBytes)).not.toHaveBeenCalled();
    const [coreBytes, coreName, coreOptions] = vi.mocked(parseWorkbookBytes).mock.calls[0];
    expect(sha256(coreBytes)).toBe(b.containerSha256);
    expect(coreName).toBe(b.containerFilename);
    expect(coreOptions).toMatchObject({ runtime: 'browser_worker' });

    // SHA-256 of the downloaded bytes was computed BEFORE the parse was requested. (The
    // parser core later fingerprints its input again — its own, pre-existing step.)
    const parseAt = parseRequested.mock.invocationCallOrder[0];
    expect(digest.mock.invocationCallOrder.filter((order) => order < parseAt)).toHaveLength(1);
    expect(digest.mock.calls[0][0]).toBe('SHA-256');
    expect(sha256(digest.mock.calls[0][1] as ArrayBuffer)).toBe(b.containerSha256);
    digest.mockRestore();

    // The one business call is the existing endpoint; then one GET of the signed URL.
    expect(fetchStub).toHaveBeenCalledTimes(2);
    const [endpointCall, objectCall] = fetchStub.mock.calls;
    expect(endpointCall[0]).toBe(ENDPOINT);
    expect(endpointCall[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(endpointCall[1]?.body))).toEqual({ batchId: b.id });
    expect(objectCall[0]).toBe(SIGNED_URL);
    expect(objectCall[1]).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(authReads.count).toBe(1);
    expect(backendAccess).toEqual([]);

    // The unchanged, read-only viewer: text as text, the saved formula result, nothing executed.
    expect(screen.getByTestId('cn2b-stored-workbook-integrity-ok')).toBeInTheDocument();
    expect(screen.getByTestId('cn2b-xl-filename')).toHaveTextContent(b.containerFilename);
    expect(screen.getByTestId('cn2b-xl-readonly')).toBeInTheDocument();
    expect(gridCell('A1')).toHaveTextContent('الرمز');
    expect(gridCell('C2')).toHaveTextContent('120');
    expect(gridCell('A3')).toHaveTextContent('<img src=x onerror="window.__e11_xss = 1">');
    expect(gridCell('B3')).toHaveTextContent('5');
    expect(gridCell('B3')).not.toHaveTextContent('2');
    expect(gridCell('B3')).toHaveAttribute('data-formula', 'true');
    expect((window as unknown as Record<string, unknown>).__e11_xss).toBeUndefined();
    expect(screen.queryByTestId('cn2b-stored-workbook-error')).toBeNull();
  });
});

describe('E1.1 — E · a registered ZIP batch reopens through the SAME archive worker path', () => {
  it('verifies the ZIP, parses it once with the production archive core and reaches the unchanged viewer with its chooser', async () => {
    const zip = new Uint8Array(readFileSync(ZIP_FIXTURE));
    const zipSha = sha256(zip);
    const b = batchOf({ id: 'batch-zip', containerKind: 'zip', containerFilename: 'احتياج 2027.zip', containerSha256: zipSha });
    // The server may spell the digest in upper case; identity is the digest, not its spelling.
    stubNetwork({ endpoint: { body: descriptorFor(b, { containerSha256: zipSha.toUpperCase() }) }, object: { bytes: exactBuffer(zip) } });

    openPanel([b]);
    const select = await waitFor(
      () => screen.getByTestId('cn2b-xl-workbook-select') as HTMLSelectElement,
      { timeout: 10_000 },
    );

    // registered ZIP → requestSourceDownload → bytes → SHA-256 verified → the SAME archive worker path.
    expect(parseRequested).toHaveBeenCalledTimes(1);
    expect((parseRequested.mock.calls[0][0] as File).name).toBe(b.containerFilename);
    expect(workerLog.constructed).toHaveLength(1);
    expect(workerLog.constructed[0]).toMatch(WORKER_URL);
    expect(workerLog.messages).toEqual(['parseArchive']);
    expect(vi.mocked(parseArchiveBytes)).toHaveBeenCalledTimes(1);
    const [archiveBytes, archiveName, archiveOptions] = vi.mocked(parseArchiveBytes).mock.calls[0];
    expect(sha256(archiveBytes)).toBe(zipSha);
    expect(archiveName).toBe(b.containerFilename);
    expect(archiveOptions).toMatchObject({ runtime: 'browser_worker' });
    expect(archiveOptions.inflate).toBe(browserInflate);
    expect(screen.getByTestId('cn2b-stored-workbook-integrity-ok')).toBeInTheDocument();
    expect(screen.queryByTestId('cn2b-stored-workbook-error')).toBeNull();

    // The unchanged viewer's archive contract: the archive's name, and a chooser listing
    // exactly the archive's parsed entries (the fixture holds what it holds — no invented count).
    const actualArchive = await vi.importActual<typeof import('../../import/archive-core')>('../../import/archive-core');
    const { nodeInflate } = await import('../../import/node-inflate');
    const oracle = await actualArchive.parseArchiveBytes(zip, b.containerFilename, { runtime: 'node', inflate: nodeInflate });
    expect(oracle.entries.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('cn2b-xl-filename')).toHaveTextContent(b.containerFilename);
    expect(select.options).toHaveLength(oracle.entries.length);
    oracle.entries.forEach((entry, i) => {
      expect(select.options[i].textContent).toContain(entry.input.archiveEntryPath ?? entry.input.originalFilename);
    });
    const firstReadable = oracle.entries.findIndex((entry) => entry.workbook !== null);
    expect(firstReadable).toBeGreaterThanOrEqual(0);
    expect(select.value).toBe(String(firstReadable));
    const firstCell = oracle.entries[firstReadable].workbook!.sheets[0].cells.find((c) => c.presence === 'value');
    expect(firstCell).toBeDefined();
    expect(gridCell(firstCell!.coordinate.a1)).not.toBeNull();
    expect(backendAccess).toEqual([]);
  });

  it('a ZIP whose downloaded bytes do not match is never handed to the archive worker', async () => {
    const zip = new Uint8Array(readFileSync(ZIP_FIXTURE));
    const tampered = zip.slice();
    tampered[tampered.length - 1] ^= 0xff;
    const b = batchOf({ id: 'batch-zip', containerKind: 'zip', containerFilename: 'احتياج 2027.zip', containerSha256: sha256(zip) });
    stubNetwork({ endpoint: { body: descriptorFor(b) }, object: { bytes: exactBuffer(tampered) } });

    openPanel([b]);
    await waitFor(() => expect(screen.getByTestId('cn2b-stored-workbook-error')).toBeInTheDocument());
    expect(screen.getByTestId('cn2b-stored-workbook-error')).toHaveTextContent(t('cn2b_stored_workbook_integrity_error', 'ar'));
    expectNothingParsed();
  });
});

describe('E1.1 — B · wrong bytes fail closed', () => {
  it('a SHA-256 mismatch shows the integrity error and never parses, starts a worker or renders the viewer', async () => {
    const registered = workbookBytes();
    const served = new TextEncoder().encode('tampered bytes, not the registered workbook');
    const b = batchOf({ containerSha256: sha256(registered) });
    const fetchStub = stubNetwork({ endpoint: { body: descriptorFor(b) }, object: { bytes: exactBuffer(served) } });

    openPanel([b]);
    await waitFor(() => expect(screen.getByTestId('cn2b-stored-workbook-error')).toBeInTheDocument());
    expect(screen.getByTestId('cn2b-stored-workbook-error')).toHaveTextContent(t('cn2b_stored_workbook_integrity_error', 'ar'));
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expectNothingParsed();
    expect(screen.getByTestId('cn2b-stored-workbook-open')).not.toBeDisabled();
  });

  it('without Web Crypto the bytes cannot be verified, so they are not opened', async () => {
    const stored = workbookBytes();
    const b = batchOf({ containerSha256: sha256(stored) });
    stubNetwork({ endpoint: { body: descriptorFor(b) }, object: { bytes: exactBuffer(stored) } });
    vi.stubGlobal('crypto', {});

    openPanel([b]);
    await waitFor(() => expect(screen.getByTestId('cn2b-stored-workbook-error')).toBeInTheDocument());
    expect(screen.getByTestId('cn2b-stored-workbook-error')).toHaveTextContent(t('cn2b_stored_workbook_integrity_unavailable', 'ar'));
    expectNothingParsed();
  });
});

describe('E1.1 — C · the server descriptor must match the SELECTED registered batch', () => {
  const stored = workbookBytes();
  const file = batchOf({ containerSha256: sha256(stored) });

  it.each([
    ['originalFilename differs', file, { originalFilename: 'other.xlsx' }],
    ['containerKind differs', file, { containerKind: 'zip' }],
    ['containerSha256 differs', file, { containerSha256: 'f'.repeat(64) }],
    ['containerSha256 is missing', file, { containerSha256: undefined }],
    ['a ZIP batch whose name would route to the single-workbook parser',
      batchOf({ containerKind: 'zip', containerFilename: 'needs.xlsx', containerSha256: sha256(stored) }), {}],
    ['a ZIP batch described by the server as a single file',
      batchOf({ containerKind: 'zip', containerFilename: 'needs.zip', containerSha256: sha256(stored) }), { containerKind: 'file' }],
  ] as const)('%s → refused before any download, nothing parsed', async (_label, b, over) => {
    const fetchStub = stubNetwork({ endpoint: { body: descriptorFor(b, over) }, object: { bytes: exactBuffer(stored) } });

    openPanel([b]);
    await waitFor(() => expect(screen.getByTestId('cn2b-stored-workbook-error')).toBeInTheDocument());
    expect(screen.getByTestId('cn2b-stored-workbook-error')).toHaveTextContent(t('cn2b_stored_workbook_metadata_error', 'ar'));
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0][0]).toBe(ENDPOINT);
    expectNothingParsed();
  });

  it('with several batches, the descriptor is checked against the one the human chose', async () => {
    const older = batchOf({ id: 'batch-old', containerFilename: 'احتياج 2027 - أولي.xlsx', containerSha256: sha256(stored) });
    const newer = batchOf({ id: 'batch-new', containerFilename: 'احتياج 2027 - مصحح.xlsx', containerSha256: 'e'.repeat(64) });
    // The endpoint answers with the NEWER batch's identity for a request about the OLDER one.
    const fetchStub = stubNetwork({ endpoint: { body: descriptorFor(newer) }, object: { bytes: exactBuffer(stored) } });

    render(<StoredWorkbookPanel lang="ar" batches={[older, newer]} />);
    expect((screen.getByTestId('cn2b-stored-workbook-select') as HTMLSelectElement).value).toBe('batch-new');
    fireEvent.change(screen.getByTestId('cn2b-stored-workbook-select'), { target: { value: 'batch-old' } });
    expect(screen.getByTestId('cn2b-stored-workbook-filename')).toHaveTextContent(older.containerFilename);
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));

    await waitFor(() => expect(screen.getByTestId('cn2b-stored-workbook-error')).toBeInTheDocument());
    expect(JSON.parse(String(fetchStub.mock.calls[0][1]?.body))).toEqual({ batchId: 'batch-old' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expectNothingParsed();
  });
});

describe('E1.1 — D · a refused or failed download never reaches the viewer', () => {
  it.each([
    [403, 'forbidden'],
    [404, 'import_batch_not_found'],
    [401, 'not_authenticated'],
  ])('the existing endpoint answering %i %s → no download, no parse, no viewer', async (status, code) => {
    const b = batchOf();
    const fetchStub = stubNetwork({ endpoint: { status, body: { ok: false, error: code } } });

    openPanel([b]);
    await waitFor(() => expect(screen.getByTestId('cn2b-stored-workbook-error')).toBeInTheDocument());
    expect(screen.getByTestId('cn2b-stored-workbook-error')).toHaveTextContent(t('cn2b_stored_workbook_load_error', 'ar'));
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0][0]).toBe(ENDPOINT);
    expectNothingParsed();
  });

  it('a signed-URL GET that Storage refuses is never parsed', async () => {
    const stored = workbookBytes();
    const b = batchOf({ containerSha256: sha256(stored) });
    stubNetwork({ endpoint: { body: descriptorFor(b) }, object: { status: 403, bytes: exactBuffer(stored) } });

    openPanel([b]);
    await waitFor(() => expect(screen.getByTestId('cn2b-stored-workbook-error')).toBeInTheDocument());
    expect(screen.getByTestId('cn2b-stored-workbook-error')).toHaveTextContent(t('cn2b_stored_workbook_load_error', 'ar'));
    expectNothingParsed();
  });
});

describe('E1.1 — transient state: closing, revision switch, nothing persisted', () => {
  it('closing drops the parsed workbook and the verification flag; reopening downloads and verifies again', async () => {
    const stored = workbookBytes();
    const b = batchOf({ containerSha256: sha256(stored) });
    const fetchStub = stubNetwork({ endpoint: { body: descriptorFor(b) }, object: { bytes: exactBuffer(stored) } });

    openPanel([b]);
    await waitFor(() => expect(screen.getByTestId('cn2b-xl-viewer')).toBeInTheDocument(), { timeout: 10_000 });
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-close'));

    expect(screen.queryByTestId('cn2b-xl-viewer')).toBeNull();
    expect(screen.queryByTestId('cn2b-stored-workbook-integrity-ok')).toBeNull();
    expect(screen.queryByTestId('cn2b-stored-workbook-close')).toBeNull();
    expect(screen.getByTestId('cn2b-stored-workbook-open')).not.toBeDisabled();

    // Nothing was kept: a second open asks the endpoint, downloads and verifies again.
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
    await waitFor(() => expect(screen.getByTestId('cn2b-xl-viewer')).toBeInTheDocument(), { timeout: 10_000 });
    expect(fetchStub).toHaveBeenCalledTimes(4);
    expect(parseRequested).toHaveBeenCalledTimes(2);
  });

  it('a revision switch (the workspace re-keys the panel) mid-download aborts the GET and discards the late bytes', async () => {
    const stored = workbookBytes();
    const b = batchOf({ containerSha256: sha256(stored) });
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const fetchStub = stubNetwork({ endpoint: { body: descriptorFor(b) }, object: { bytes: exactBuffer(stored), hold } });

    const view = openPanel([b]);
    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
    const signal = fetchStub.mock.calls[1][1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    view.rerender(<StoredWorkbookPanel key="rev-2" lang="ar" batches={[batchOf({ id: 'batch-2', planRevisionId: 'rev-2', containerFilename: 'rev-2.xlsx' })]} />);
    expect(signal.aborted).toBe(true);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.getByTestId('cn2b-stored-workbook-filename')).toHaveTextContent('rev-2.xlsx');
    expect(screen.queryByTestId('cn2b-stored-workbook-error')).toBeNull();
    expectNothingParsed();
  });

  it('a revision switch after the viewer is open leaves no viewer, no verification flag and no bytes behind', async () => {
    const stored = workbookBytes();
    const b = batchOf({ containerSha256: sha256(stored) });
    stubNetwork({ endpoint: { body: descriptorFor(b) }, object: { bytes: exactBuffer(stored) } });

    const view = render(<StoredWorkbookPanel key="rev-1" lang="ar" batches={[b]} />);
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
    await waitFor(() => expect(screen.getByTestId('cn2b-xl-viewer')).toBeInTheDocument(), { timeout: 10_000 });

    view.rerender(<StoredWorkbookPanel key="rev-2" lang="ar" batches={[batchOf({ id: 'batch-2', planRevisionId: 'rev-2', containerFilename: 'rev-2.xlsx' })]} />);
    expect(screen.queryByTestId('cn2b-xl-viewer')).toBeNull();
    expect(screen.queryByTestId('cn2b-stored-workbook-integrity-ok')).toBeNull();
    expect(screen.getByTestId('cn2b-stored-workbook-filename')).toHaveTextContent('rev-2.xlsx');
  });

  it('opening, viewing and closing writes nothing to browser storage and touches no other backend surface', async () => {
    const stored = workbookBytes();
    const b = batchOf({ containerSha256: sha256(stored) });
    const fetchStub = stubNetwork({ endpoint: { body: descriptorFor(b) }, object: { bytes: exactBuffer(stored) } });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const before = { local: window.localStorage.length, session: window.sessionStorage.length };

    openPanel([b]);
    await waitFor(() => expect(screen.getByTestId('cn2b-xl-viewer')).toBeInTheDocument(), { timeout: 10_000 });
    fireEvent.click(screen.getByTestId('cn2b-stored-workbook-close'));

    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
    expect({ local: window.localStorage.length, session: window.sessionStorage.length }).toEqual(before);
    expect(backendAccess).toEqual([]);
    expect(fetchStub.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual([
      `POST ${ENDPOINT}`,
      `GET ${SIGNED_URL}`,
    ]);
    // E2-A: the only database access is one SELECT of this batch's own entries.
    expect(entryReads).toEqual([
      'select id, batch_id, entry_ordinal, archive_entry_path, entry_sha256, import_session_id',
      `eq batch_id=${b.id}`,
      'order entry_ordinal',
    ]);
  });
});
