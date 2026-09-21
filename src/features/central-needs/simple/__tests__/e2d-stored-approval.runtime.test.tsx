/** @vitest-environment jsdom */
/**
 * E2-D.9 — the Mapping Approval Gate over the REAL trusted stored source, in the
 * REAL Simple workspace.
 *
 * REAL, unmodified: CentralNeedsSimpleWorkspace, StoredWorkbookMapping,
 * StoredWorkbookPanel (its `onSelectionChange` bridge), the viewer and grid,
 * sourceIdentityBridge, `requestSourceDownload`, `listBatchEntries`, the preview
 * hook, the production `import/worker.ts`; E2-B, E2-C and E2-D; Web Crypto.
 *
 * STUBBED, transport only (as the E2-A/B/C suites): `fetch`, the Supabase auth
 * read, the entry-row query, and the Worker thread. Every other Supabase surface
 * is a tripwire — so any submit/approve/readiness call would be caught.
 */
import '@testing-library/jest-dom/vitest';
import { createHash } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
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
      select: (columns: string) => { entryReads.push(`select ${columns}`); return guarded; },
      eq: (column: string, value: unknown) => {
        entryReads.push(`eq ${column}=${String(value)}`);
        if (column === 'batch_id') batchFilter = String(value);
        return guarded;
      },
      order: (column: string) => { entryReads.push(`order ${column}`); return guarded; },
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
        if (prop === 'auth') return { getSession: async () => ({ data: { session: { access_token: 'e2d-test-token' } } }) };
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
    throw new Error(`E2-D made an unexpected network call: ${url}`);
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

const revision = (id: string): PlanRevision => ({
  id, planId: 'p', organizationId: PLAN_OWNER, planYear: 2027, revisionNumber: id === 'rev-1' ? 1 : 2, status: 'draft',
});
const workspace = (lang: 'ar' | 'en', id: string) => (
  <CentralNeedsSimpleWorkspace
    lang={lang} planYear={2027} onPlanYearChange={() => {}} revisionsLoading={false}
    revision={revision(id)} isDraft revisionDataReady canImport canEdit busy={false} activity={null}
    onOpenRevision={() => {}} preview={{ phase: 'idle' }} pendingFile={null} onPickFile={() => {}} onVerify={() => {}}
    error={null} notice={null} readiness={null} batches={[batchFor(`batch-${id}`, id)]} beneficiaryColumns={[]} careInstitutions={CARE_INSTITUTIONS}
    records={[]} dispositions={[]} activeSessionId={null} onChanged={() => {}} onSwitchToAdvanced={() => {}}
  />
);

const gate = () => screen.getByTestId('cn2b-approve-panel');
const inGate = (id: string) => within(gate()).getByTestId(id);
const inInst = (id: string) => within(screen.getByTestId('cn2b-instmap-panel')).getByTestId(id);
const gridCell = (a1: string) => document.querySelector<HTMLElement>(`[role="gridcell"][data-a1="${a1}"]`);
const columnButton = (index: number) => within(screen.getByTestId('cn2b-xl-grid')).getAllByTestId('cn2b-xl-colbutton')[index];

async function openWorkspace(lang: 'ar' | 'en' = 'en') {
  entriesDb.rows = [rowFor('batch-rev-1', 'session-1'), rowFor('batch-rev-2', 'session-2')];
  const fetchStub = stubNetwork();
  const view = render(workspace(lang, 'rev-1'));
  fireEvent.click(screen.getByTestId('cn2b-stored-workbook-open'));
  await waitFor(() => expect(screen.getByTestId('cn2b-xl-viewer')).toBeInTheDocument(), { timeout: 10_000 });
  await waitFor(() => expect(screen.getByTestId('cn2b-stored-workbook-panel').getAttribute('data-source-identity')).toBe('trusted'));
  return { ...view, fetchStub };
}

async function mapAndApprove() {
  fireEvent.click(columnButton(0));
  fireEvent.click(screen.getByTestId('cn2b-map-assign-national_code'));
  fireEvent.click(columnButton(1));
  fireEvent.click(screen.getByTestId('cn2b-map-assign-material'));
  fireEvent.click(gridCell('C1')!);
  fireEvent.click(inInst('cn2b-instmap-capture-anchor'));
  fireEvent.click(columnButton(2));
  fireEvent.click(inInst('cn2b-instmap-capture-need'));
  fireEvent.change(inInst('cn2b-instmap-beneficiary'), { target: { value: 'org-a' } });
  fireEvent.click(inInst('cn2b-instmap-commit'));
  await waitFor(() => expect(gate()).toHaveAttribute('data-approval-status', 'ready'));
  fireEvent.click(inGate('cn2b-approve-action'));
  expect(gate()).toHaveAttribute('data-approved', 'true');
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('E2-D.9 — local approval on the real stored source, in the real workspace', () => {
  it('the workspace binds the revision id; approving is local, nothing is sent, the plan owner never appears', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { fetchStub } = await openWorkspace();
    await mapAndApprove();
    const evidence = JSON.parse(inGate('cn2b-approve-evidence-json').textContent as string);
    expect(evidence.planRevisionId).toBe('rev-1');
    expect(evidence.source).toMatchObject({ batchId: 'batch-rev-1', importSessionId: 'session-1', entryOrdinal: 1 });
    expect(evidence.institutionMappings.map((m: { beneficiaryOrganizationId: string }) => m.beneficiaryOrganizationId)).toEqual(['org-a']);
    expect(gate().textContent).not.toContain(PLAN_OWNER);
    expect(inGate('cn2b-approve-approved')).toHaveTextContent('the Annual Needs revision was not submitted or approved');
    // No submit/approve/readiness call: the only network use is still E2-A's source read.
    expect(fetchStub.mock.calls.map(([url, init]) => `${init?.method} ${String(url).split('?')[0]}`)).toEqual([
      `POST ${ENDPOINT}`,
      `GET ${SIGNED_URL.split('?')[0]}`,
    ]);
    expect(entryReads.filter((r) => r.startsWith('select'))).toHaveLength(1);
    expect(backendAccess).toEqual([]);
    expect(setItem).not.toHaveBeenCalled();
    // The workspace keeps exactly one Simple task card.
    expect(document.querySelectorAll('.cn2b-simple-card')).toHaveLength(1);
    expect(gate().closest('.cn2b-simple-card')).toBeNull();
  });

  it('clicking another cell of the same trusted sheet keeps the approval; switching sheet ends it', async () => {
    await openWorkspace();
    await mapAndApprove();
    const fingerprint = inGate('cn2b-approve-fingerprint-value').textContent;
    fireEvent.click(gridCell('B3')!);
    fireEvent.click(gridCell('D2')!);
    await settle();
    expect(gate()).toHaveAttribute('data-approved', 'true');
    expect(inGate('cn2b-approve-fingerprint-value')).toHaveTextContent(fingerprint as string);
    fireEvent.click(screen.getByRole('tab', { name: /Other/ }));
    await settle();
    expect(gate()).toHaveAttribute('data-approved', 'false');
    expect(inGate('cn2b-approve-stale')).toBeInTheDocument();
    expect(gate()).toHaveAttribute('data-approval-status', 'blocked');
  });

  it('a revision switch remounts the mapping surface: no approval survives', async () => {
    const view = await openWorkspace();
    await mapAndApprove();
    const before = gate();
    view.rerender(workspace('en', 'rev-2'));
    expect(gate()).not.toBe(before);
    expect(gate()).toHaveAttribute('data-approved', 'false');
    expect(within(gate()).queryByTestId('cn2b-approve-stale')).toBeNull();
    expect(JSON.parse(inGate('cn2b-approve-evidence-json').textContent as string).planRevisionId).toBe('rev-2');
  });

  it('Arabic: the gate is right-to-left and approval is stated as local', async () => {
    await openWorkspace('ar');
    await mapAndApprove();
    expect(gate()).toHaveAttribute('dir', 'rtl');
    expect(inGate('cn2b-approve-approved')).toHaveTextContent('تعيينات الملف معتمدة محليًا');
    expect(inGate('cn2b-approve-disclaimer')).toHaveTextContent('هذا الاعتماد يثبت مراجعة التعيينات فقط ولا يرسل الخطة للاعتماد.');
  });
});
