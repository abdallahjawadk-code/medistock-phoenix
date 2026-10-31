import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { sha256Hex } from '../../import/parser-core';
import { CN2A_CONTRACT_VERSION, SHEETJS_VERSION, SHEETJS_TARBALL_SHA256 } from '../../import/contract';
import { ANNUAL_ORIGINAL_ATTESTATION } from '../annual-originals.contract';
import { annualC3TemplateSha256, replayAnnualC3Evidence, type C3ReplayInput,
  type C3TemplateManifest } from '../annual-c3-replay';

const scope = { ownerOrgId: '11111111-1111-4111-8111-111111111111', planningYear: 2026 };
const otherScope = { ownerOrgId: '11111111-1111-4111-8111-111111111111', planningYear: 2027 };
const uuid = '22222222-2222-4222-8222-222222222222';
const originalFilename = 'synthetic.xlsx';
async function fixture() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Scientific Name', 'National Code', 'وحدة المناعة'],
    ['Paracetamol', '001-02', 0],
    ['Amoxicillin', '009-03', 100],
  ]), 'sheet');
  const bytes = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }));
  const sha = await sha256Hex(bytes);
  const manifest: C3TemplateManifest = {
    templateId: 'reviewed-2026', version: '1.0.0', reviewReference: 'SYNTHETIC_REVIEW_01',
    parserContractVersion: CN2A_CONTRACT_VERSION,
    sheetjsVersion: SHEETJS_VERSION, sheetjsTarballSha256: SHEETJS_TARBALL_SHA256,
    allowedFormats: ['xlsx'],
    blocks: [{
      blockId: 'a', sheetIndex: 0, headerRow: 0, firstRow: 1, lastRow: 2,
      mappingReference: 'REVIEWED_SYNTHETIC_BLOCK',
      classification: { origin: 'proposed', label: 'test', reference: 'REVIEWED_TEST' },
      columns: {
        scientificName: { column: 0, expectedHeaderText: 'Scientific Name' },
        nationalCode: { column: 1, expectedHeaderText: 'National Code' },
      },
    }],
  };
  const base: C3ReplayInput = {
    scope, originalScope: scope,
    original: {
      originalId: uuid, sha256: sha, byteSize: bytes.length, firstFilename: originalFilename,
      createdBy: '33333333-3333-4333-8333-333333333333', createdByName: 'Operator',
      createdByRole: 'employee', createdAt: '2026-10-31T12:00:00Z',
      attestation: ANNUAL_ORIGINAL_ATTESTATION,
    },
    bytes, reviewedTemplate: { manifest, expectedSha256: await annualC3TemplateSha256(manifest) },
  };
  return base;
}
describe('C3 isolated server evidence replay — no legal material or quantity writes', () => {
  it('returns raw coordinates and exact national code, without guessing the department unit', async () => {
    const result = await replayAnnualC3Evidence(await fixture());
    expect(result.status).toBe('source_evidence_only_review_required');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].fields.nationalCode).toMatchObject({
      state: 'value', text: '001-02', witness: { cell: { coordinate: { a1: 'B2' } } },
    });
    expect(result.rows[0].fields.unit).toEqual({ state: 'missing', reason: 'unmapped', witness: null });
    expect(result.rows[0].source.row).toBe(1);
    expect(result.template.version).toBe('1.0.0');
  });
  it('paginates deterministically and refuses foreign year in a replay', async () => {
    const base = await fixture();
    const one = await replayAnnualC3Evidence({ ...base, pageSize: 1 });
    expect(one.nextCursor).not.toBeNull();
    const two = await replayAnnualC3Evidence({ ...base, pageSize: 1, cursor: one.nextCursor });
    expect(two.rows).toHaveLength(1);
    expect(two.rows[0].source.row).toBe(2);
    expect(two.nextCursor).toBeNull();
    await expect(replayAnnualC3Evidence({ ...base, originalScope: otherScope })).rejects.toThrow('annual_catalog_scope_mismatch');
    await expect(replayAnnualC3Evidence({ ...base, scope: otherScope, originalScope: otherScope,
      cursor: one.nextCursor })).rejects.toThrow(/annual_c3_cursor_invalid/);
  });
  it('refuses changed original bytes and changed reviewed-template digest', async () => {
    const base = await fixture();
    const modified = base.bytes.slice(); modified[20] ^= 1;
    await expect(replayAnnualC3Evidence({ ...base, bytes: modified })).rejects.toThrow('annual_c3_sha256_mismatch');
    await expect(replayAnnualC3Evidence({ ...base, reviewedTemplate: {
      ...base.reviewedTemplate, expectedSha256: '0'.repeat(64),
    } })).rejects.toThrow('annual_c3_template_hash_mismatch');
  });
  it('refuses department headings as source unit mappings and unproven classifications', async () => {
    const base = await fixture();
    const block = base.reviewedTemplate.manifest.blocks[0];
    const invalidManifest: C3TemplateManifest = {
      ...base.reviewedTemplate.manifest,
      blocks: [{ ...block, columns: { ...block.columns,
        unit: { column: 2, expectedHeaderText: 'وحدة المناعة' },
      } }],
    };
    await expect(annualC3TemplateSha256(invalidManifest)).rejects.toThrow('annual_c3_department_not_a_unit');
    const unproven: C3TemplateManifest = {
      ...base.reviewedTemplate.manifest,
      blocks: [{ ...block, classification: { origin: 'source', label: 'A', reference: 'assumed' } }],
    };
    await expect(annualC3TemplateSha256(unproven)).rejects.toThrow('annual_c3_source_classification_not_proven');
  });
  it('rejects unsupported page size and mismatched format', async () => {
    const base = await fixture();
    await expect(replayAnnualC3Evidence({ ...base, pageSize: 51 })).rejects.toThrow('annual_c3_page_size_invalid');
    const manifest: C3TemplateManifest = { ...base.reviewedTemplate.manifest, allowedFormats: ['xls'] };
    const expectedSha256 = await annualC3TemplateSha256(manifest);
    await expect(replayAnnualC3Evidence({
      ...base, reviewedTemplate: { manifest, expectedSha256 },
    })).rejects.toThrow('annual_c3_format_mismatch');
  });
});
