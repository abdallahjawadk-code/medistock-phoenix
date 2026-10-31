/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AnnualOriginalFiles, type AnnualOriginalsUiApi } from '../AnnualOriginalFiles';
import { AnnualNeedsWorkspace } from '../AnnualNeedsWorkspace';
import type { AnnualOriginalCaptureInput, AnnualOriginalIntent, AnnualOriginalWriteResult, AnnualOriginalUploadsPage } from '../annual-originals.contract';
import { annualFixture, CAPS, ID, SCOPE } from './annual-ui-fixtures';

vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: vi.fn(() => { throw new Error('Unexpected real RPC'); }) } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const CONTRACT = { version: 1 as const, scope: 'owner_year' as const, maxFileBytes: 3145728 as const,
  extensions: ['xls', 'xlsx', 'csv'] as ['xls', 'xlsx', 'csv'], attestation: 'server_received_original' as const,
  atomicReceipt: true as const, intentBoundReplay: true as const };
const FILE = 'ملف الأدوية 2026.xlsx';
const TIME = '2026-10-31T12:00:00.000001+00:00';
const sha = 'b'.repeat(64);
const uid = (n: number) => `d2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function receipt(input: AnnualOriginalIntent, n = 1): AnnualOriginalWriteResult {
  return { scope: input.scope, idempotencyKey: input.idempotencyKey, deduplicated: false, idempotentReplay: false,
    original: { originalId: uid(n), sha256: input.sha256, byteSize: input.byteSize, firstFilename: input.filename,
      createdBy: input.actorId, createdByName: 'موظف الاستلام التاريخي', createdByRole: 'warehouse_employee', createdAt: TIME, attestation: 'server_received_original' },
    upload: { uploadId: uid(n + 100), originalId: uid(n), filename: input.filename,
      actorId: input.actorId, actorName: 'موظف الاستلام التاريخي', actorRole: 'warehouse_employee', createdAt: TIME } };
}
const intent = (filename = FILE): AnnualOriginalCaptureInput => ({ scope: SCOPE, actorId: ID.actor,
  filename, byteSize: 3, sha256: sha, idempotencyKey: 'original-stable-key', base64: 'YWJj' });
function page(rows: AnnualOriginalWriteResult[] = [], cursor: string | null = null): AnnualOriginalUploadsPage {
  return { scope: SCOPE, uploads: rows.map(({ original, upload }) => ({ original, upload })), nextAfterUploadId: cursor };
}
function fixture() {
  const api = {
    getAnnualOriginalsContract: vi.fn(async () => CONTRACT),
    prepareAnnualOriginalFile: vi.fn<AnnualOriginalsUiApi['prepareAnnualOriginalFile']>(async (input) => ({
      ...intent(input.file.name), scope: input.scope, actorId: input.actorId, idempotencyKey: input.idempotencyKey,
    })),
    storeAnnualOriginal: vi.fn<AnnualOriginalsUiApi['storeAnnualOriginal']>(async (input) => receipt(input)),
    getAnnualOriginalReceipt: vi.fn<AnnualOriginalsUiApi['getAnnualOriginalReceipt']>(async (input) => ({
      scope: input.scope, intent: { filename: input.filename, sha256: input.sha256, byteSize: input.byteSize, idempotencyKey: input.idempotencyKey },
      result: { ...receipt(input), idempotentReplay: true },
    })),
    listAnnualOriginalUploads: vi.fn<AnnualOriginalsUiApi['listAnnualOriginalUploads']>(async () => page()),
    downloadAnnualOriginal: vi.fn<AnnualOriginalsUiApi['downloadAnnualOriginal']>(async () => ({ scope: SCOPE, original: receipt(intent()).original, blob: new Blob(['abc'], { type: 'application/octet-stream' }) })),
    newIdempotencyKey: vi.fn(() => 'original-stable-key'),
  } satisfies AnnualOriginalsUiApi;
  return api;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const props = (api: AnnualOriginalsUiApi) => ({ api, lang: 'en' as const, scope: SCOPE, actorId: ID.actor, canWrite: true });
async function selectFile() {
  fireEvent.change(await screen.findByLabelText('Choose an original file'), { target: { files: [new File(['abc'], FILE)] } });
  return screen.findByRole('button', { name: 'Save original for year 2026' });
}

describe('C2 original files: explicit save and recoverable outcomes', () => {
  it('does not expose upload/download or fake an empty history when capability is absent', async () => {
    const api = fixture(); api.getAnnualOriginalsContract.mockResolvedValue(null as never);
    render(<AnnualOriginalFiles {...props(api)} />);
    await screen.findByText(/Original file storage is not available/);
    expect(screen.queryByLabelText('Choose an original file')).toBeNull();
    expect(screen.queryByText('No file receipts are recorded for this year.')).toBeNull();
    expect(api.listAnnualOriginalUploads).not.toHaveBeenCalled();
    expect(api.storeAnnualOriginal).not.toHaveBeenCalled();
  });

  it('keeps capability errors distinct from absence and retries discovery only', async () => {
    const api = fixture(); api.getAnnualOriginalsContract.mockRejectedValueOnce(new Error('denied'));
    render(<AnnualOriginalFiles {...props(api)} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be checked');
    expect(screen.queryByText(/not available on this server/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByLabelText('Choose an original file');
    expect(api.getAnnualOriginalsContract).toHaveBeenCalledTimes(2);
    expect(api.storeAnnualOriginal).not.toHaveBeenCalled();
  });

  it('selection does not save; double-click writes once; confirmed receipt survives refresh failure', async () => {
    const api = fixture(), write = deferred<AnnualOriginalWriteResult>(), lock = vi.fn();
    api.storeAnnualOriginal.mockReturnValueOnce(write.promise);
    api.listAnnualOriginalUploads.mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error('read failed')).mockResolvedValue(page([receipt(intent())]));
    render(<AnnualOriginalFiles {...props(api)} onScopeLockChange={lock} />);
    const save = await selectFile();
    expect(api.storeAnnualOriginal).not.toHaveBeenCalled();
    fireEvent.click(save); fireEvent.click(save);
    expect(api.storeAnnualOriginal).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(lock).toHaveBeenLastCalledWith(true));
    await act(async () => write.resolve(receipt(intent())));
    await screen.findByText('The original file and its receipt were confirmed saved.');
    expect(await screen.findByRole('alert')).toHaveTextContent('confirmed save receipt remains valid');
    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh history' })[0]);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.storeAnnualOriginal).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('list')).toHaveTextContent('موظف الاستلام التاريخي');
  });

  it('reconciles a lost write response through its exact receipt without resending bytes', async () => {
    const api = fixture(); api.storeAnnualOriginal.mockRejectedValueOnce(new Error('reply lost'));
    render(<AnnualOriginalFiles {...props(api)} />);
    fireEvent.click(await selectFile());
    await screen.findByText(/save outcome is not confirmed/);
    expect(screen.getByLabelText('Choose an original file')).toBeDisabled();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check the save receipt' }));
    await screen.findByText('The original file and its receipt were confirmed saved.');
    expect(api.getAnnualOriginalReceipt).toHaveBeenCalledWith({ scope: SCOPE, actorId: ID.actor, filename: FILE,
      byteSize: 3, sha256: sha, idempotencyKey: 'original-stable-key' });
    expect(Object.keys(api.getAnnualOriginalReceipt.mock.calls[0][0])).not.toContain('base64');
    expect(api.storeAnnualOriginal).toHaveBeenCalledTimes(1);
  });

  it('an absent receipt permits only the identical saved intent and key on explicit retry', async () => {
    const api = fixture(); api.storeAnnualOriginal.mockRejectedValueOnce(new Error('timeout'));
    api.getAnnualOriginalReceipt.mockImplementationOnce(async (input) => ({ scope: input.scope,
      intent: { filename: input.filename, sha256: input.sha256, byteSize: input.byteSize, idempotencyKey: input.idempotencyKey }, result: null }));
    render(<AnnualOriginalFiles {...props(api)} />);
    fireEvent.click(await selectFile());
    fireEvent.click(await screen.findByRole('button', { name: 'Check the save receipt' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry the same file and request' }));
    await screen.findByText('The original file and its receipt were confirmed saved.');
    expect(api.storeAnnualOriginal).toHaveBeenCalledTimes(2);
    expect(api.storeAnnualOriginal.mock.calls[1][0]).toBe(api.storeAnnualOriginal.mock.calls[0][0]);
    expect(api.newIdempotencyKey).toHaveBeenCalledTimes(1);
  });

  it('queues a fresh history read if a successful write arrives during the first read', async () => {
    const api = fixture(), firstRead = deferred<AnnualOriginalUploadsPage>();
    api.listAnnualOriginalUploads.mockReturnValueOnce(firstRead.promise).mockResolvedValue(page([receipt(intent())]));
    render(<AnnualOriginalFiles {...props(api)} />);
    fireEvent.click(await selectFile());
    await screen.findByText('The original file and its receipt were confirmed saved.');
    await act(async () => firstRead.resolve(page()));
    await waitFor(() => expect(api.listAnnualOriginalUploads).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('list')).toHaveTextContent(FILE);
    expect(api.storeAnnualOriginal).toHaveBeenCalledTimes(1);
  });

  it('does not paint a previous year or actor when its delayed read completes', async () => {
    const api = fixture(), oldRead = deferred<AnnualOriginalUploadsPage>();
    api.listAnnualOriginalUploads.mockReturnValueOnce(oldRead.promise).mockResolvedValue(page());
    const view = render(<AnnualOriginalFiles {...props(api)} />);
    await screen.findByLabelText('Choose an original file');
    view.rerender(<AnnualOriginalFiles {...props(api)} actorId={uid(900)} scope={{ ...SCOPE, planningYear: 2027 }} />);
    await screen.findByText('2027');
    await act(async () => oldRead.resolve(page([receipt(intent())])));
    expect(screen.queryByText(FILE)).toBeNull();
    expect(api.listAnnualOriginalUploads).toHaveBeenLastCalledWith({ ...SCOPE, planningYear: 2027 }, 25, null);
  });

  it('retains failed next-page retry and blocks more after a failed first-page refresh', async () => {
    const api = fixture(), first = receipt(intent()), second = receipt(intent('second.csv'), 2);
    api.listAnnualOriginalUploads.mockResolvedValueOnce(page([first], first.upload.uploadId))
      .mockRejectedValueOnce(new Error('next page')).mockResolvedValueOnce(page([second]))
      .mockRejectedValueOnce(new Error('reload')).mockResolvedValueOnce(page([first]));
    render(<AnnualOriginalFiles {...props(api)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more receipts' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('remaining history');
    fireEvent.click(screen.getByRole('button', { name: 'Load more receipts' }));
    await screen.findByRole('button', { name: 'Download original: second.csv' });
    expect(api.listAnnualOriginalUploads).toHaveBeenNthCalledWith(3, SCOPE, 25, first.upload.uploadId);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('displayed data is stale');
    expect(screen.queryByRole('button', { name: 'Load more receipts' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh history' })[0]);
    await waitFor(() => expect(screen.queryByText('second.csv')).toBeNull());
  });

  it('does not send a file that failed preparation', async () => {
    const api = fixture(); api.prepareAnnualOriginalFile.mockRejectedValueOnce(new Error('too large'));
    render(<AnnualOriginalFiles {...props(api)} />);
    fireEvent.change(await screen.findByLabelText('Choose an original file'), { target: { files: [new File(['abc'], FILE)] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be prepared');
    expect(api.storeAnnualOriginal).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Save original for year 2026' })).toBeNull();
  });

  it('refuses overlapping pages without replacing immutable receipt metadata', async () => {
    const api = fixture(), first = receipt(intent());
    const changed = { ...first, upload: { ...first.upload, actorName: 'Unexpected replacement' } };
    api.listAnnualOriginalUploads.mockResolvedValueOnce(page([first], first.upload.uploadId)).mockResolvedValueOnce(page([changed]));
    render(<AnnualOriginalFiles {...props(api)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more receipts' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('remaining history');
    expect(screen.queryByText('Unexpected replacement')).toBeNull();
    expect(screen.getByRole('list')).toHaveTextContent('موظف الاستلام التاريخي');
  });

  it('keeps original download available to readers and does not emit an unverified Blob', async () => {
    const api = fixture(); api.listAnnualOriginalUploads.mockResolvedValue(page([receipt(intent())]));
    api.downloadAnnualOriginal.mockRejectedValueOnce(new Error('hash mismatch'));
    const makeUrl = vi.fn(); vi.stubGlobal('URL', class extends URL { static createObjectURL = makeUrl; });
    render(<AnnualOriginalFiles {...props(api)} canWrite={false} lang="ar" />);
    const region = screen.getByRole('region', { name: 'أصول ملفات السنة' }); expect(region).toHaveAttribute('dir', 'rtl');
    expect(screen.queryByLabelText('اختيار ملف أصلي')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: `تنزيل الأصل: ${FILE}` }));
    await screen.findByRole('alert'); expect(makeUrl).not.toHaveBeenCalled();
    expect(api.downloadAnnualOriginal).toHaveBeenCalledWith(SCOPE, uid(1));
  });

  it('opens independently of beneficiary selection and locks other year actions during an unresolved write', async () => {
    const api = fixture(), annual = annualFixture(); api.storeAnnualOriginal.mockRejectedValueOnce(new Error('unknown'));
    render(<AnnualNeedsWorkspace lang="en" scope={SCOPE} actorId={ID.actor} revision={null} capabilities={CAPS} beneficiaries={[]}
      searchRegisteredMaterials={async () => []} api={annual.api} manualApi={annual.manualApi} originalsApi={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Year files' }));
    fireEvent.click(await selectFile());
    await screen.findByText(/save outcome is not confirmed/);
    expect(screen.getByRole('button', { name: 'Close year files' })).toBeDisabled();
    expect(screen.getByLabelText('Beneficiary institution')).toBeDisabled();
    expect(annual.api.addAnnualNeedLine).not.toHaveBeenCalled();
    expect(annual.api.addAnnualCatalogItemForNeeds).not.toHaveBeenCalled();
    expect(within(screen.getByRole('region', { name: 'Annual original files' })).getByRole('button', { name: 'Check the save receipt' })).toBeEnabled();
  });
});
