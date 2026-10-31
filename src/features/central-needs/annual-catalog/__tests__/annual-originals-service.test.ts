import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { mockRpc, mockFrom } = vi.hoisted(() => ({ mockRpc: vi.fn(), mockFrom: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: mockRpc, from: mockFrom } }));
import { AnnualCatalogContractError } from '../annual-catalog-server.contract';
import {
  ANNUAL_ORIGINAL_MAX_BYTES, annualOriginalIntent, decodeAnnualOriginalBytes, encodeAnnualOriginalBytes,
  type AnnualOriginalCaptureInput, type AnnualOriginalWriteResult,
} from '../annual-originals.contract';
import {
  downloadAnnualOriginal, getAnnualOriginalReceipt, getAnnualOriginalsContract, isAnnualOriginalOutcomeUnknown,
  listAnnualOriginalUploads, prepareAnnualOriginalFile, storeAnnualOriginal,
} from '../annual-originals.service';

const id = (n: number) => `c2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SCOPE = { ownerOrgId: id(1), planningYear: 2026 }; const ACTOR = id(2); const ORIGINAL = id(3); const UPLOAD = id(4);
const TIME = '2026-10-31T12:00:00.123456+00:00';
const BYTES = new TextEncoder().encode('national_code,name\n000123,Amoxicillin\n');
const HASH = createHash('sha256').update(BYTES).digest('hex'); const BASE64 = Buffer.from(BYTES).toString('base64');
const ok = (data: unknown) => ({ data, error: null });
const input = (): AnnualOriginalCaptureInput => ({ scope: { ...SCOPE }, actorId: ACTOR, filename: 'أدوية 2026.csv', sha256: HASH,
  byteSize: BYTES.length, idempotencyKey: 'original-intent-001', base64: BASE64 });
function result(): AnnualOriginalWriteResult {
  return { scope: { ...SCOPE }, idempotencyKey: input().idempotencyKey, deduplicated: false, idempotentReplay: false,
    original: { originalId: ORIGINAL, sha256: HASH, byteSize: BYTES.length, firstFilename: input().filename,
      createdBy: ACTOR, createdByName: 'موظف الاختبار', createdByRole: 'org_admin', createdAt: TIME, attestation: 'server_received_original' },
    upload: { uploadId: UPLOAD, originalId: ORIGINAL, filename: input().filename,
      actorId: ACTOR, actorName: 'موظف الاختبار', actorRole: 'org_admin', createdAt: TIME } };
}
const contract = () => ({ version: 1, scope: 'owner_year', maxFileBytes: ANNUAL_ORIGINAL_MAX_BYTES,
  extensions: ['xls', 'xlsx', 'csv'], attestation: 'server_received_original', atomicReceipt: true, intentBoundReplay: true });
function receipt(value: AnnualOriginalWriteResult | null = { ...result(), idempotentReplay: true }) {
  const intent = annualOriginalIntent(input());
  return { scope: { ...SCOPE }, intent: { filename: intent.filename, sha256: intent.sha256,
    byteSize: intent.byteSize, idempotencyKey: intent.idempotencyKey }, result: value };
}
const record = () => ({ original: result().original, upload: result().upload });
beforeEach(() => vi.resetAllMocks());

describe('C2 exact capability and immutable preparation', () => {
  it('accepts only the exact v1 capability, with no legacy upload fallback', async () => {
    mockRpc.mockResolvedValue(ok(contract()));
    expect(await getAnnualOriginalsContract()).toEqual(contract());
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_annual_originals_contract');
    expect(mockFrom).not.toHaveBeenCalled();
  });
  it('returns absence only for the named missing RPC', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Missing public.phoenix_central_needs_annual_originals_contract' } });
    expect(await getAnnualOriginalsContract()).toBeNull();
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Missing another_function' } });
    await expect(getAnnualOriginalsContract()).rejects.toMatchObject({ sqlstate: 'PGRST202' });
  });
  it.each([
    { version: 2 }, { maxFileBytes: ANNUAL_ORIGINAL_MAX_BYTES + 1 }, { extensions: ['xlsx', 'xls', 'csv'] },
    { attestation: 'trusted_cells' }, { atomicReceipt: false }, { intentBoundReplay: false }, { extra: true },
  ])('rejects an incompatible or broadened capability: %j', async (patch) => {
    mockRpc.mockResolvedValue(ok({ ...contract(), ...patch }));
    await expect(getAnnualOriginalsContract()).rejects.toBeInstanceOf(AnnualCatalogContractError);
  });
  it('does not confuse authorization/network failure with capability absence', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied' } });
    await expect(getAnnualOriginalsContract()).rejects.toMatchObject({ sqlstate: '42501' });
    mockRpc.mockRejectedValue(new Error('network disconnected'));
    await expect(getAnnualOriginalsContract()).rejects.toMatchObject({ code: 'central_needs_request_failed' });
  });
  it('preserves exact filename/bytes, independently hashes and freezes the prepared intent', async () => {
    const target = { ...SCOPE };
    const prepared = await prepareAnnualOriginalFile({ scope: target, actorId: ACTOR, idempotencyKey: input().idempotencyKey,
      file: { name: input().filename, size: BYTES.length, arrayBuffer: async () => BYTES.slice().buffer } });
    expect(prepared).toEqual(input()); expect(Object.isFrozen(prepared)).toBe(true); expect(Object.isFrozen(prepared.scope)).toBe(true);
    target.planningYear = 2027; expect(prepared.scope.planningYear).toBe(2026); expect(mockRpc).not.toHaveBeenCalled();
  });
  it('rejects a changed file size before any RPC', async () => {
    await expect(prepareAnnualOriginalFile({ scope: SCOPE, actorId: ACTOR, idempotencyKey: input().idempotencyKey,
      file: { name: input().filename, size: BYTES.length + 1, arrayBuffer: async () => BYTES.slice().buffer } }))
      .rejects.toMatchObject({ code: 'annual_catalog_invalid_input', outcomeUnknown: false });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('C2 byte transport and input limits', () => {
  it.each(['../source.csv', 'dir\\source.csv', ' source.csv', 'source.csv ', '~$source.xlsx', 'source.zip',
    'source\n.csv', 'source\u0085.csv', 'source\u202E.csv', 'source\u2069.csv', 'x'.repeat(252) + '.csv'])('rejects unsafe filename %j locally', async (filename) => {
    await expect(storeAnnualOriginal({ ...input(), filename })).rejects.toMatchObject({ code: 'annual_catalog_invalid_input', outcomeUnknown: false });
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it.each([
    { byteSize: 0 }, { byteSize: ANNUAL_ORIGINAL_MAX_BYTES + 1 }, { byteSize: BYTES.length + 1 },
    { sha256: 'a'.repeat(64) }, { sha256: HASH.toUpperCase() }, { base64: BASE64 + '\n' }, { base64: 'not@base64' },
    { idempotencyKey: 'short' }, { idempotencyKey: ' spaced-key' }, { idempotencyKey: 'broken\nkey' },
  ])('rejects invalid capture before transport: %j', async (patch) => {
    await expect(storeAnnualOriginal({ ...input(), ...patch })).rejects.toMatchObject({ code: 'annual_catalog_invalid_input', outcomeUnknown: false });
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('rejects noncanonical padding bits even when atob would decode the same byte', () => {
    expect(atob('Zh==')).toBe('f');
    expect(() => decodeAnnualOriginalBytes('Zh==', 1, 'input')).toThrow(AnnualCatalogContractError);
    expect(decodeAnnualOriginalBytes('Zg==', 1, 'input')).toEqual(new Uint8Array([102]));
  });
  it('accepts the exact 3 MiB boundary without recursive regex or argument-stack overflow', async () => {
    const bytes = new Uint8Array(ANNUAL_ORIGINAL_MAX_BYTES).fill(0xa5);
    const prepared = await prepareAnnualOriginalFile({ scope: SCOPE, actorId: ACTOR, idempotencyKey: 'max-size-intent',
      file: { name: 'bounded.XLS', size: bytes.length, arrayBuffer: async () => bytes.buffer } });
    expect(prepared.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const decoded = decodeAnnualOriginalBytes(prepared.base64, prepared.byteSize, 'input');
    expect(Buffer.compare(Buffer.from(decoded), Buffer.from(bytes))).toBe(0);
    expect(encodeAnnualOriginalBytes(bytes)).toBe(prepared.base64); expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('C2 confirmed capture, replay and unknown outcomes', () => {
  it('sends only the original-byte command, preserving server actor snapshot and empty extraction boundary', async () => {
    mockRpc.mockResolvedValue(ok(result()));
    expect(await storeAnnualOriginal(input())).toEqual(result());
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_store_annual_original', {
      p_organization_id: SCOPE.ownerOrgId, p_planning_year: 2026, p_filename: input().filename,
      p_sha256: HASH, p_byte_size: BYTES.length, p_base64: BASE64, p_idempotency_key: input().idempotencyKey, p_expected_actor_id: ACTOR,
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });
  it('binds async acknowledgement to a detached intent if caller mutates its object during hashing', async () => {
    mockRpc.mockResolvedValue(ok(result())); const mutable = { ...input(), scope: { ...SCOPE } };
    const pending = storeAnnualOriginal(mutable); mutable.scope.planningYear = 2027; mutable.filename = 'changed.csv'; mutable.base64 = 'AA==';
    expect(await pending).toEqual(result()); expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_planning_year: 2026, p_filename: input().filename, p_base64: BASE64 });
  });
  it('accepts a replay retaining its original first-upload result and no extra RPC', async () => {
    const replay = { ...result(), idempotentReplay: true }; mockRpc.mockResolvedValue(ok(replay));
    expect(await storeAnnualOriginal(input())).toEqual(replay); expect(mockRpc).toHaveBeenCalledTimes(1);
  });
  it('keeps an earlier original name/uploader while a new event records a renamed duplicate', async () => {
    const duplicate = { ...result(), deduplicated: true,
      original: { ...result().original, firstFilename: 'first.xlsx', createdBy: id(8), createdByName: 'الموظف الأول', createdAt: '2026-10-30T12:00:00Z' } };
    mockRpc.mockResolvedValue(ok(duplicate)); expect(await storeAnnualOriginal(input())).toEqual(duplicate);
  });
  it.each([
    (r: AnnualOriginalWriteResult) => ({ ...r, scope: { ...SCOPE, planningYear: 2027 } }),
    (r: AnnualOriginalWriteResult) => ({ ...r, scope: { ...SCOPE, ownerOrgId: id(99) } }),
    (r: AnnualOriginalWriteResult) => ({ ...r, upload: { ...r.upload, actorId: id(99) } }),
    (r: AnnualOriginalWriteResult) => ({ ...r, upload: { ...r.upload, filename: 'different.csv' } }),
    (r: AnnualOriginalWriteResult) => ({ ...r, original: { ...r.original, sha256: 'a'.repeat(64) } }),
    (r: AnnualOriginalWriteResult) => ({ ...r, original: { ...r.original, byteSize: BYTES.length + 1 } }),
    (r: AnnualOriginalWriteResult) => ({ ...r, original: { ...r.original, createdByName: 'fabricated' } }),
    (r: AnnualOriginalWriteResult) => ({ ...r, upload: { ...r.upload, originalId: id(99) } }),
    (r: AnnualOriginalWriteResult) => ({ ...r, idempotencyKey: 'other-intent-key' }),
    (r: AnnualOriginalWriteResult) => ({ ...r, trustedCells: true }),
  ])('treats an inconsistent acknowledgement as unknown, with exactly one write', async (mutate) => {
    mockRpc.mockResolvedValue(ok(mutate(result())));
    await expect(storeAnnualOriginal(input())).rejects.toMatchObject({ code: 'annual_catalog_invalid_response', outcomeUnknown: true });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
  it('classifies a lost response or unclassified server error as unknown without retry', async () => {
    mockRpc.mockRejectedValueOnce(new Error('response lost after commit'));
    const failure = await storeAnnualOriginal(input()).catch((error: unknown) => error);
    expect(isAnnualOriginalOutcomeUnknown(failure)).toBe(true); expect(mockRpc).toHaveBeenCalledTimes(1);
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'unclassified failure' } });
    await expect(storeAnnualOriginal(input())).rejects.toMatchObject({ outcomeUnknown: true });
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });
  it('does not infer rollback from an unexpected exception without an explicit outcome', () => {
    expect(isAnnualOriginalOutcomeUnknown(new Error('unexpected adapter exception'))).toBe(true);
    expect(isAnnualOriginalOutcomeUnknown({ outcomeUnknown: false })).toBe(true);
    expect(isAnnualOriginalOutcomeUnknown(new AnnualCatalogContractError('input', 'preflight'))).toBe(false);
    expect(isAnnualOriginalOutcomeUnknown(new AnnualCatalogContractError('response', 'ack'))).toBe(true);
  });
  it.each(['23514', '23505', '42501', 'P0002', '40P01', '57014'])('preserves a confirmed server refusal %s without pretending it committed', async (code) => {
    mockRpc.mockResolvedValue({ data: null, error: { code, message: 'annual_original_refused', details: 'reason=test' } });
    await expect(storeAnnualOriginal(input())).rejects.toMatchObject({ sqlstate: code, code: 'annual_original_refused', details: 'reason=test', outcomeUnknown: false });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});

describe('C2 intent-bound reconciliation and reading', () => {
  it('reads a committed receipt with the same exact intent and expected actor', async () => {
    mockRpc.mockResolvedValue(ok(receipt()));
    expect(await getAnnualOriginalReceipt(annualOriginalIntent(input()))).toEqual(receipt());
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_get_annual_original_receipt', {
      p_organization_id: SCOPE.ownerOrgId, p_planning_year: 2026, p_filename: input().filename,
      p_sha256: HASH, p_byte_size: BYTES.length, p_idempotency_key: input().idempotencyKey, p_expected_actor_id: ACTOR,
    });
  });
  it('returns an absent receipt without starting another command', async () => {
    mockRpc.mockResolvedValue(ok(receipt(null)));
    expect((await getAnnualOriginalReceipt(annualOriginalIntent(input()))).result).toBeNull(); expect(mockRpc).toHaveBeenCalledTimes(1);
  });
  it('rejects receipt intent or actor substitution and does not turn a denial into absence', async () => {
    mockRpc.mockResolvedValue(ok({ ...receipt(), intent: { ...receipt().intent, filename: 'other.csv' } }));
    await expect(getAnnualOriginalReceipt(input())).rejects.toBeInstanceOf(AnnualCatalogContractError);
    mockRpc.mockResolvedValue(ok(receipt({ ...result(), idempotentReplay: true, upload: { ...result().upload, actorId: id(99) } })));
    await expect(getAnnualOriginalReceipt(input())).rejects.toBeInstanceOf(AnnualCatalogContractError);
    mockRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not_allowed' } });
    await expect(getAnnualOriginalReceipt(input())).rejects.toMatchObject({ sqlstate: '42501' });
  });
  it('never retries confirmed capture when a later refresh fails', async () => {
    mockRpc.mockResolvedValueOnce(ok(result())).mockRejectedValueOnce(new Error('refresh failed'));
    const saved = await storeAnnualOriginal(input());
    await expect(listAnnualOriginalUploads(SCOPE)).rejects.toMatchObject({ code: 'central_needs_request_failed' });
    expect(saved).toEqual(result()); expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
      'phoenix_central_needs_store_annual_original', 'phoenix_central_needs_list_annual_original_uploads',
    ]);
  });
  it('validates ascending microsecond order even when UUIDs decrease', async () => {
    const one = record(); const two = { ...record(), upload: { ...record().upload, uploadId: id(1), createdAt: '2026-10-31T12:00:00.123457+00:00' } };
    const page = { scope: SCOPE, uploads: [one, two], nextAfterUploadId: two.upload.uploadId }; mockRpc.mockResolvedValue(ok(page));
    expect(await listAnnualOriginalUploads(SCOPE, 2)).toEqual(page);
  });
  it.each(['duplicate', 'reverse', 'foreignScope', 'badCursor', 'inconsistentOriginal'])('rejects invalid paginated metadata: %s', async (mode) => {
    const one = record(); const two = { ...record(), upload: { ...record().upload, uploadId: id(5), createdAt: '2026-10-31T12:00:00.123457+00:00' } };
    const page = { scope: { ...SCOPE }, uploads: [one, two], nextAfterUploadId: null as string | null };
    if (mode === 'duplicate') page.uploads[1] = one;
    if (mode === 'reverse') page.uploads.reverse();
    if (mode === 'foreignScope') page.scope.planningYear = 2027;
    if (mode === 'badCursor') page.nextAfterUploadId = id(99);
    if (mode === 'inconsistentOriginal') page.uploads[1].original = { ...two.original, firstFilename: 'changed.csv' };
    mockRpc.mockResolvedValue(ok(page)); await expect(listAnnualOriginalUploads(SCOPE, 2)).rejects.toBeInstanceOf(AnnualCatalogContractError);
  });
  it('validates local page limits and forwards the exact scoped cursor', async () => {
    await expect(listAnnualOriginalUploads(SCOPE, 51)).rejects.toBeInstanceOf(AnnualCatalogContractError); expect(mockRpc).not.toHaveBeenCalled();
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, uploads: [], nextAfterUploadId: null }));
    expect((await listAnnualOriginalUploads(SCOPE, 25, UPLOAD)).uploads).toEqual([]);
    expect(mockRpc.mock.calls[0][1]).toEqual({ p_organization_id: SCOPE.ownerOrgId, p_planning_year: 2026, p_limit: 25, p_after_upload_id: UPLOAD });
  });
  it('returns an opaque download Blob only after byte-for-byte and hash verification', async () => {
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, original: result().original, base64: BASE64 }));
    const downloaded = await downloadAnnualOriginal(SCOPE, ORIGINAL);
    expect(downloaded.blob.type).toBe('application/octet-stream'); expect(new Uint8Array(await downloaded.blob.arrayBuffer())).toEqual(BYTES);
    expect(downloaded.original).toEqual(result().original);
  });
  it.each(['bytes', 'id', 'scope', 'base64'])('refuses corrupted or misbound download: %s', async (mode) => {
    const row = { scope: { ...SCOPE }, original: result().original, base64: BASE64 };
    if (mode === 'bytes') { const changed = BYTES.slice(); changed[0] ^= 1; row.base64 = Buffer.from(changed).toString('base64'); }
    if (mode === 'id') row.original.originalId = id(99);
    if (mode === 'scope') row.scope.planningYear = 2027;
    if (mode === 'base64') row.base64 += '\n';
    mockRpc.mockResolvedValue(ok(row)); await expect(downloadAnnualOriginal(SCOPE, ORIGINAL)).rejects.toBeInstanceOf(AnnualCatalogContractError);
  });
});
