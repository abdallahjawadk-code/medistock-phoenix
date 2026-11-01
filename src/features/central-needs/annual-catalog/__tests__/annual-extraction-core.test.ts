import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { CN2A_CONTRACT_VERSION } from '../../import/contract';
import { createAnnualExtractionEngine, type AnnualExtractionTemplate } from '../annual-extraction-core';

const scope = { ownerOrgId: '11111111-1111-4111-8111-111111111111', planningYear: 2026 };
const originalId = '22222222-2222-4222-8222-222222222222';
function file(rows: unknown[][]) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Identity');
  const bytes = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }));
  return { origin: 'c2_original' as const, scope, originalId, filename: 'synthetic.xlsx', byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
}
const template: AnnualExtractionTemplate = {
  id: 'synthetic-identity', version: 1, reviewReference: 'synthetic-test-review-only', parserContractVersion: CN2A_CONTRACT_VERSION,
  blocks: [{ blockId: 'identity', sheetIndex: 0, headerRow: 1, firstRow: 2, lastRow: 3,
    columns: { scientificName: { column: 0, expectedHeaderText: 'Name' }, nationalCode: { column: 1, expectedHeaderText: 'Code' }, unit: { column: 2, expectedHeaderText: 'Unit' } },
    mappingReference: 'synthetic-reviewed-mapping', classification: { label: 'Medicines', origin: 'source', reference: 'A1' } }],
  classificationCells: [{ blockId: 'identity', row: 0, column: 0, expectedText: 'Medicines' }],
};
const workbook = () => file([['Medicines'], ['Name', 'Code', 'Unit', 'Institution', 'Quantity'], ['Amoxicillin', '000123', 'Box', 'DO-NOT-EXTRACT-INSTITUTION', 987654], ['Paracetamol', '', 'Tablet']]);
const request = () => ({ scope, original: workbook(), templateId: template.id, templateVersion: 1 });

describe('C3 original-byte extraction core — synthetic reviewed template', () => {
  it('reparses actual bytes, binds source and template identity, and keeps exact cell/classification evidence', async () => {
    const result = await createAnnualExtractionEngine([template]).extract(request());
    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    expect(result.kind).toBe('annual_identity_extraction_candidate');
    expect(result.scope).toEqual(scope);
    expect(result.originalId).toBe(originalId);
    expect(result.parser.runtime).toBe('node');
    expect(result.template).toMatchObject({ id: template.id, version: 1, reviewReference: template.reviewReference });
    expect(result.template.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.occurrences[0].fields.nationalCode).toMatchObject({ state: 'value', text: '000123', witness: { cell: { coordinate: { a1: 'B3' } } } });
    expect(result.occurrences[1].fields.nationalCode.state).toBe('missing');
    expect(result.classifications[0].cell).toMatchObject({ rawValue: 'Medicines', coordinate: { a1: 'A1' } });
    expect(JSON.stringify(result)).not.toContain('DO-NOT-EXTRACT-INSTITUTION');
    expect(JSON.stringify(result)).not.toContain('987654');
  });
  it('evaluates different held-out bytes with the same mapping without learning identities or units', async () => {
    const heldOut = file([['Medicines'], ['Name', 'Code', 'Unit'], ['Unregistered exact source', 'HELD-001', 'UnreviewedUnit']]);
    const result = await createAnnualExtractionEngine([template]).extract({ ...request(), original: heldOut });
    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    expect(result.occurrences[0].fields.unit).toMatchObject({ state: 'value', text: 'UnreviewedUnit' });
    expect(result).not.toHaveProperty('canonicalItemId');
    expect(result).not.toHaveProperty('approved');
  });
  it.each(['templateId', 'templateVersion'] as const)('holds an unregistered %s without guessing a template', async key => {
    const input = request();
    const result = await createAnnualExtractionEngine([template]).extract({ ...input, [key]: key === 'templateId' ? 'unknown' : 2 });
    expect(result).toEqual({ status: 'held', reason: 'template_unavailable' });
  });
  it.each(['sha256', 'byteSize'] as const)('refuses a changed original %s before extracting cells', async key => {
    const input = request();
    await expect(createAnnualExtractionEngine([template]).extract({ ...input, original: { ...input.original, [key]: key === 'sha256' ? '0'.repeat(64) : input.original.byteSize + 1 } })).rejects.toThrow('annual_extraction_original_mismatch');
  });
  it('refuses bytes associated with another annual scope', async () => {
    const input = request();
    await expect(createAnnualExtractionEngine([template]).extract({ ...input, scope: { ...scope, planningYear: 2027 } }))
      .rejects.toThrow('annual_catalog_scope_mismatch');
  });
  it('keeps local corpus review explicitly separate from a C2 original reference', async () => {
    const input = request();
    const localScope = { ownerOrgId: 'local-corpus-review', planningYear: 2026 };
    const result = await createAnnualExtractionEngine([template]).extract({ ...input, scope: localScope,
      original: { ...input.original, origin: 'local_corpus_review', scope: localScope, originalId: `corpus:${input.original.sha256}` } });
    expect(result).toMatchObject({ status: 'prepared', sourceOrigin: 'local_corpus_review', scope: localScope });
  });
  it('holds changed physical headers rather than discovering another column', async () => {
    const changed = file([['Medicines'], ['Name', 'Another code', 'Unit'], ['Amoxicillin', '000123', 'Box']]);
    expect(await createAnnualExtractionEngine([template]).extract({ ...request(), original: changed })).toEqual({ status: 'held', reason: 'template_conflict' });
  });
  it('does not promote a changed source classification using only a template label', async () => {
    const changed = file([['Other category'], ['Name', 'Code', 'Unit'], ['Amoxicillin', '000123', 'Box']]);
    expect(await createAnnualExtractionEngine([template]).extract({ ...request(), original: changed })).toEqual({ status: 'held', reason: 'classification_conflict' });
  });
  it('refuses a cached formula label as physical source-classification text', async () => {
    const input = request();
    const changed = XLSX.read(input.original.bytes);
    changed.Sheets.Identity.A1.f = '"Medicines"';
    const bytes = new Uint8Array(XLSX.write(changed, { type: 'array', bookType: 'xlsx' }));
    input.original = { ...input.original, bytes, byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    expect(await createAnnualExtractionEngine([template]).extract(input)).toEqual({ status: 'held', reason: 'classification_conflict' });
  });
  it('retains a proposed classification without promoting it to a source fact', async () => {
    const proposed = structuredClone(template);
    proposed.blocks[0].classification!.origin = 'proposed';
    proposed.classificationCells = [];
    const result = await createAnnualExtractionEngine([proposed]).extract(request());
    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    expect(result.classifications).toEqual([]);
    expect(result.occurrences[0].classification?.origin).toBe('proposed');
  });
  it('retains classification comment presence without copying unrelated comment text', async () => {
    const input = request();
    const changed = XLSX.read(input.original.bytes);
    changed.Sheets.Identity.A1.c = [{ a: 'Synthetic author', t: 'UNRELATED-PRIVATE-COMMENT' }];
    const bytes = new Uint8Array(XLSX.write(changed, { type: 'array', bookType: 'xlsx' }));
    input.original = { ...input.original, bytes, byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const result = await createAnnualExtractionEngine([template]).extract(input);
    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    expect(result.classifications[0].cell.hasComment).toBe(true);
    expect(JSON.stringify(result)).not.toContain('UNRELATED-PRIVATE-COMMENT');
  });
  it('isolates in-flight bytes and metadata from later caller mutation', async () => {
    const input = request();
    input.scope = { ...scope };
    input.original.scope = { ...scope };
    const sha256 = input.original.sha256;
    const pending = createAnnualExtractionEngine([template]).extract(input);
    input.original.bytes.fill(0);
    input.original.sha256 = '0'.repeat(64);
    input.original.filename = 'changed.csv';
    input.scope.planningYear = 2027;
    const result = await pending;
    expect(result).toMatchObject({ status: 'prepared', originalSha256: sha256, originalFilename: 'synthetic.xlsx', scope });
  });
  it('snapshots definitions before awaiting parsing so later edits cannot change the reviewed mapping', async () => {
    const mutable = structuredClone(template);
    const engine = createAnnualExtractionEngine([mutable]);
    mutable.blocks[0].columns.nationalCode!.column = 4;
    expect((await engine.extract(request())).status).toBe('prepared');
  });
  it('refuses duplicated template identities and incompatible parser contracts at registration', () => {
    expect(() => createAnnualExtractionEngine([template, template])).toThrow('annual_extraction_template_invalid');
    expect(() => createAnnualExtractionEngine([{ ...template, parserContractVersion: 'wrong' }])).toThrow('annual_extraction_template_invalid');
  });
});
