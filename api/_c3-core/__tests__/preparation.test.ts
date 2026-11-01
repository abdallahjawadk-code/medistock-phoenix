import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedCaller } from '../../_lib/supabase.ts';
import { CN2A_CONTRACT_VERSION } from '../../../src/features/central-needs/import/contract.ts';
import { createAnnualOriginalPreparationService, type RegisteredAnnualLayout } from '../preparation.ts';

const scope = { ownerOrgId: '11111111-1111-4111-8111-111111111111', planningYear: 2026 };
const id = '22222222-2222-4222-8222-222222222222';
function layout(id = 'synthetic'): RegisteredAnnualLayout {
  return { workbookSheets: [{ index: 0, name: 'Identity' }], template: { id, version: 1,
    reviewReference: 'synthetic-reviewed-layout', parserContractVersion: CN2A_CONTRACT_VERSION, classificationCells: [],
    blocks: [{ blockId: 'items', sheetIndex: 0, headerRow: 0, firstRow: 1, lastRow: 9999,
      mappingReference: 'synthetic-source-review', classification: null, columns: {
        scientificName: { column: 0, expectedHeaderText: 'Name' }, nationalCode: { column: 1, expectedHeaderText: 'Code' },
        unit: { column: 2, expectedHeaderText: 'Unit' },
      } }] } };
}
function caller(rows: unknown[][] = [['Name', 'Code', 'Unit'], ['Synthetic medicine', '0007', 'Box']], extraSheet = false) {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Identity');
  if (extraSheet) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Other unreviewed sheet']]), 'Unreviewed');
  const bytes = Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  const data = { scope, base64: bytes.toString('base64'), original: {
    originalId: id, firstFilename: 'arbitrary-filename.xlsx', byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), attestation: 'server_received_original',
    createdBy: scope.ownerOrgId, createdByName: 'Synthetic fixture', createdByRole: 'central_needs_editor', createdAt: '2026-11-01T00:00:00Z',
  } };
  const contract = { version: 1, scope: 'owner_year', maxFileBytes: 3145728, extensions: ['xls', 'xlsx', 'csv'],
    attestation: 'server_received_original', atomicReceipt: true, intentBoundReplay: true };
  const rpc = vi.fn().mockImplementation(async (name: string) => ({ error: null,
    data: name === 'phoenix_central_needs_actor_authorized' ? true
      : name === 'phoenix_central_needs_annual_originals_contract' ? contract : data }));
  return { userId: scope.ownerOrgId, accessToken: 'synthetic-only-token', client: { rpc } } as unknown as AuthenticatedCaller;
}
describe('C3 trusted source preparation with explicit workbook coverage', () => {
  it('replays a unique registered workbook and binds immutable registry identity', async () => {
    const result = await createAnnualOriginalPreparationService([layout()]).prepare(caller(), scope, id);
    expect(result.status).toBe('prepared'); if (result.status !== 'prepared') return;
    expect(result.candidate.sourceOrigin).toBe('c2_original');
    expect(result.candidate.occurrences[0].fields.nationalCode).toMatchObject({ state: 'value', text: '0007' });
    expect(result.registrySha256).toMatch(/^[a-f0-9]{64}$/); expect(result.registrationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.persisted).toBe(false);
  });
  it('holds changed headers and extra source sheets instead of accepting partial coverage or a filename guess', async () => {
    const service = createAnnualOriginalPreparationService([layout()]);
    expect(await service.prepare(caller([['Wrong name', 'Code', 'Unit'], ['X', '7', 'Box']]), scope, id))
      .toEqual({ status: 'held', reason: 'layout_unavailable' });
    expect(await service.prepare(caller(undefined, true), scope, id)).toEqual({ status: 'held', reason: 'layout_unavailable' });
  });
  it('holds multiple matching registrations without choosing the first', async () => {
    const result = await createAnnualOriginalPreparationService([layout('first'), layout('second')]).prepare(caller(), scope, id);
    expect(result).toEqual({ status: 'held', reason: 'layout_ambiguous' });
  });
  it('does not observe later mutation of registered source shape or template', async () => {
    const registered = layout(); const service = createAnnualOriginalPreparationService([registered]);
    registered.workbookSheets[0].name = 'Changed'; registered.template.blocks[0].columns.scientificName!.expectedHeaderText = 'Changed';
    expect((await service.prepare(caller(), scope, id)).status).toBe('prepared');
  });
  it('holds excessive overlapping row slots before constructing candidate evidence', async () => {
    const registered = layout(); registered.template.blocks = Array.from({ length: 32 }, (_, i) => ({
      ...registered.template.blocks[0], blockId: `block-${i}`,
    }));
    const rows = [['Name', 'Code', 'Unit'], ...Array.from({ length: 400 }, () => ['Synthetic', '7', 'Box'])];
    expect(await createAnnualOriginalPreparationService([registered]).prepare(caller(rows), scope, id))
      .toEqual({ status: 'held', reason: 'evidence_limit' });
  });
  it('holds oversized exact evidence instead of truncating its source witnesses', async () => {
    const rows = [['Name', 'Code', 'Unit'], ...Array.from({ length: 500 }, () => ['S'.repeat(3000), '7', 'Box'])];
    expect(await createAnnualOriginalPreparationService([layout()]).prepare(caller(rows), scope, id))
      .toEqual({ status: 'held', reason: 'evidence_limit' });
  });
});
