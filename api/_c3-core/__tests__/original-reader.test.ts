import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import type { AuthenticatedCaller } from '../../_lib/supabase.ts';
import { readAnnualOriginalAsCaller } from '../original-reader.ts';
import { createAnnualExtractionEngine } from '../../../src/features/central-needs/annual-catalog/annual-extraction-core.ts';
import { CN2A_CONTRACT_VERSION } from '../../../src/features/central-needs/import/contract.ts';

const scope = { ownerOrgId: '11111111-1111-4111-8111-111111111111', planningYear: 2026 };
const id = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333';
const bytes = Buffer.from('synthetic bytes for a transport-boundary test');
const response = () => ({ scope: { ...scope }, base64: bytes.toString('base64'), original: {
  originalId: id, firstFilename: 'synthetic.csv', byteSize: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), attestation: 'server_received_original',
  createdBy: actor, createdByName: 'Synthetic fixture', createdByRole: 'central_needs_editor', createdAt: '2026-11-01T00:00:00Z',
} });
const caller = (rpc: ReturnType<typeof vi.fn>) => ({ userId: actor, accessToken: 'synthetic-only-token', client: { rpc } }) as unknown as AuthenticatedCaller;
const contract = { version: 1, scope: 'owner_year', maxFileBytes: 3145728, extensions: ['xls', 'xlsx', 'csv'],
  attestation: 'server_received_original', atomicReceipt: true, intentBoundReplay: true };
const transport = (data: unknown) => vi.fn().mockImplementation(async (name: string) => ({ error: null,
  data: name === 'phoenix_central_needs_actor_authorized' ? true
    : name === 'phoenix_central_needs_annual_originals_contract' ? contract : data }));

describe('C3 caller-scoped C2 original read boundary', () => {
  it('uses only the authenticated caller RPC and rehashes the exact retained bytes', async () => {
    const rpc = transport(response());
    const original = await readAnnualOriginalAsCaller(caller(rpc), scope, id);
    expect(rpc).toHaveBeenCalledWith('phoenix_central_needs_download_annual_original', {
      p_organization_id: scope.ownerOrgId, p_planning_year: 2026, p_original_id: id,
    });
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(original).toMatchObject({ origin: 'c2_original', scope, originalId: id, filename: 'synthetic.csv' });
    expect(Buffer.from(original.bytes)).toEqual(bytes);
    expect(original).not.toHaveProperty('createdByName');
  });
  it.each(['42501', 'PGRST202', 'P0002'])('fails closed on %s without echoing backend messages', async code => {
    const rpc = vi.fn().mockResolvedValue({ data: response(), error: { code, message: 'DO NOT ECHO PRIVATE DETAILS' } });
    await expect(readAnnualOriginalAsCaller(caller(rpc), scope, id)).rejects.toThrow(/^annual_c3_forbidden$/);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each([
    (r: ReturnType<typeof response>) => { r.scope.planningYear = 2027; },
    (r: ReturnType<typeof response>) => { r.scope.ownerOrgId = actor; },
    (r: ReturnType<typeof response>) => { r.original.originalId = actor; },
    (r: ReturnType<typeof response>) => { r.original.sha256 = '0'.repeat(64); },
    (r: ReturnType<typeof response>) => { r.original.byteSize += 1; },
    (r: ReturnType<typeof response>) => { r.original.byteSize = 3_145_729; },
    (r: ReturnType<typeof response>) => { r.original.attestation = 'client_attested'; },
    (r: ReturnType<typeof response>) => { r.original.firstFilename = '../synthetic.csv'; },
    (r: ReturnType<typeof response>) => { r.original.firstFilename = '~$synthetic.xlsx'; },
    (r: ReturnType<typeof response>) => { r.base64 += '\n'; },
    (r: ReturnType<typeof response>) => { r.base64 = '!'.repeat(r.base64.length); },
  ])('refuses malformed or mismatched returned evidence %#', async change => {
    const data = response(); change(data);
    const rpc = transport(data);
    await expect(readAnnualOriginalAsCaller(caller(rpc), scope, id)).rejects.toThrow(/^annual_c3_/);
  });
  it('captures scope before awaiting the caller transport', async () => {
    let deliver!: (value: unknown) => void;
    const deferred = new Promise(resolve => { deliver = resolve; });
    const rpc = transport(null).mockImplementation(async (name: string) => name === 'phoenix_central_needs_download_annual_original'
      ? deferred : { error: null, data: name === 'phoenix_central_needs_actor_authorized' ? true : contract });
    const mutable = { ...scope }; const task = readAnnualOriginalAsCaller(caller(rpc), mutable, id);
    mutable.planningYear = 2027; mutable.ownerOrgId = actor;
    deliver({ data: response(), error: null });
    expect((await task).scope).toEqual(scope);
  });
  it('refuses an invalid input before any transport call', async () => {
    const rpc = vi.fn();
    await expect(readAnnualOriginalAsCaller(caller(rpc), { ...scope, ownerOrgId: 'local-corpus-review' }, id)).rejects.toThrow(/^annual_c3_invalid_uuid$/);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('feeds verified C2 bytes into the real Node parser without accepting client cells or quantities', async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Name', 'Code', 'Unit', 'Quantity'],
      ['Synthetic exact medicine', '0007', 'Box', 987654]]), 'Identity');
    const source = Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    const data = response(); data.base64 = source.toString('base64'); data.original.byteSize = source.length;
    data.original.sha256 = createHash('sha256').update(source).digest('hex'); data.original.firstFilename = 'synthetic.xlsx';
    const original = await readAnnualOriginalAsCaller(caller(transport(data)), scope, id);
    const engine = createAnnualExtractionEngine([{ id: 'synthetic-only', version: 1, reviewReference: 'synthetic-test-review',
      parserContractVersion: CN2A_CONTRACT_VERSION, classificationCells: [], blocks: [{ blockId: 'identity', sheetIndex: 0,
        headerRow: 0, firstRow: 1, lastRow: 1, mappingReference: 'synthetic-map', classification: null, columns: {
          scientificName: { column: 0, expectedHeaderText: 'Name' }, nationalCode: { column: 1, expectedHeaderText: 'Code' },
          unit: { column: 2, expectedHeaderText: 'Unit' },
        } }] }]);
    const result = await engine.extract({ scope, original, templateId: 'synthetic-only', templateVersion: 1 });
    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    expect(result.sourceOrigin).toBe('c2_original'); expect(result.parser.runtime).toBe('node');
    expect(result.occurrences[0].fields.nationalCode).toMatchObject({ state: 'value', text: '0007' });
    expect(JSON.stringify(result)).not.toContain('987654');
  });
});
