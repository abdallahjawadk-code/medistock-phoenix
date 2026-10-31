import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { sha256Hex } from '../../import/parser-core';
import { CN2A_CONTRACT_VERSION, SHEETJS_VERSION, SHEETJS_TARBALL_SHA256 } from '../../import/contract';
import { annualC3TemplateSha256, type C3TemplateManifest } from '../annual-c3-replay';
import { handleAnnualC3WorkerTask } from '../annual-c3-worker-task';

const scope = { ownerOrgId: '11111111-1111-4111-8111-111111111111', planningYear: 2026 };
const originalId = '22222222-2222-4222-8222-222222222222';
const employeeId = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
type Format = 'xls' | 'xlsx' | 'csv';

function workbookBytes(format: Format): Uint8Array {
  if (format === 'csv') {
    return new TextEncoder().encode(
      'Scientific Name,National Code\nParacetamol,001-02\nAmoxicillin,009-03\n',
    );
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Scientific Name', 'National Code'],
    ['Paracetamol', '001-02'],
    ['Amoxicillin', '009-03'],
  ]), 'Sheet1');
  return new Uint8Array(XLSX.write(wb, {
    type: 'array', bookType: format === 'xls' ? 'biff8' : 'xlsx',
  }));
}
async function request(format: Format) {
  const bytes = workbookBytes(format);
  const sha256 = await sha256Hex(bytes);
  const manifest: C3TemplateManifest = {
    templateId: 'reviewed-synthetic', version: '1.0.0',
    reviewReference: 'SYNTHETIC_REVIEW_01',
    parserContractVersion: CN2A_CONTRACT_VERSION,
    sheetjsVersion: SHEETJS_VERSION,
    sheetjsTarballSha256: SHEETJS_TARBALL_SHA256,
    allowedFormats: [format],
    blocks: [{
      blockId: 'block-1', sheetIndex: 0, headerRow: 0,
      firstRow: 1, lastRow: 2, mappingReference: 'REVIEWED_BLOCK_01',
      classification: null,
      columns: {
        scientificName: { column: 0, expectedHeaderText: 'Scientific Name' },
        nationalCode: { column: 1, expectedHeaderText: 'National Code' },
      },
    }],
  };
  return {
    type: 'c3-worker-request', requestId, scope, originalScope: scope,
    original: {
      originalId, sha256, byteSize: bytes.byteLength,
      firstFilename: 'synthetic.' + format,
      createdBy: employeeId, createdByName: 'Synthetic Employee', createdByRole: 'employee',
      createdAt: '2026-10-31T12:00:00Z', attestation: 'server_received_original',
    },
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    reviewedTemplate: { manifest, expectedSha256: await annualC3TemplateSha256(manifest) },
    pageSize: 25, cursor: null,
  };
}
describe('C3 worker task — replays pinned parser without publishing an endpoint', () => {
  for (const format of ['xls', 'xlsx', 'csv'] as const) {
    it('preserves original source coordinates and does not guess units for ' + format, async () => {
      const msg = await request(format);
      const result = await handleAnnualC3WorkerTask(msg);
      expect(result?.type).toBe('c3-worker-result');
      if (!result || result.type !== 'c3-worker-result') throw new Error('expected source evidence');
      expect(result.page.scope).toEqual(scope);
      expect(result.page.original.originalId).toBe(originalId);
      expect(result.page.status).toBe('source_evidence_only_review_required');
      expect(result.page.rows).toHaveLength(2);
      expect(result.page.rows[0].fields.nationalCode).toMatchObject({
        state: 'value', text: '001-02', witness: { cell: { coordinate: { a1: 'B2' } } },
      });
      expect(result.page.rows[0].fields.unit).toEqual({
        state: 'missing', reason: 'unmapped', witness: null,
      });
    });
  }
  it('rejects a changed byte without disclosing its name or contents', async () => {
    const msg = await request('xls');
    const changed = msg.bytes.slice(0);
    new Uint8Array(changed)[20] ^= 1;
    const result = await handleAnnualC3WorkerTask({ ...msg, bytes: changed });
    expect(result).toEqual({ type: 'c3-worker-error', requestId, code: 'rejected' });
    expect(JSON.stringify(result)).not.toContain('synthetic.xls');
  });
  it('rejects a wrong year and an unreviewed template digest', async () => {
    const msg = await request('xlsx');
    expect(await handleAnnualC3WorkerTask({
      ...msg, originalScope: { ...scope, planningYear: 2027 },
    })).toEqual({ type: 'c3-worker-error', requestId, code: 'rejected' });
    expect(await handleAnnualC3WorkerTask({
      ...msg, reviewedTemplate: { ...msg.reviewedTemplate, expectedSha256: '0'.repeat(64) },
    })).toEqual({ type: 'c3-worker-error', requestId, code: 'rejected' });
  });
  it('rejects oversized data and unsupported page sizes before parsing', async () => {
    const msg = await request('csv');
    expect(await handleAnnualC3WorkerTask({
      ...msg, bytes: new ArrayBuffer(3_145_729),
    })).toEqual({ type: 'c3-worker-error', requestId, code: 'rejected' });
    expect(await handleAnnualC3WorkerTask({
      ...msg, pageSize: 51,
    })).toEqual({ type: 'c3-worker-error', requestId, code: 'rejected' });
  });
  it('does not echo malformed request identifiers or arbitrary messages', async () => {
    const msg = await request('csv');
    expect(await handleAnnualC3WorkerTask({ ...msg, requestId: 'secret-token' })).toBeNull();
    expect(await handleAnnualC3WorkerTask({ type: 'unknown' })).toBeNull();
  });
});
