import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseWorkbookBytes, sha256Hex, detectMagicFormat } from '../parser-core';
import { CN2A_CONTRACT_VERSION, SHEETJS_VERSION, SHEETJS_TARBALL_SHA256 } from '../contract';

function buildSyntheticWorkbook(): Uint8Array {
  const wsData = [
    ['Item', 'Item', 'Qty'],
    ['Paracetamol', 'x', 10],
    ['Amoxicillin', 'y', 0],
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  ws.D2 = { t: 'n', v: 5, f: 'C2*0.5' };
  ws.D3 = { t: 'e', v: 15, w: '#VALUE!', f: 'C3/0' };
  ws.E1 = { t: 'z', c: [{ a: 'test', t: 'a stray comment' } as XLSX.Comment] };
  ws['!ref'] = 'A1:E3';

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

function buildWhitespaceHeaderWorkbook(): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Item', ' ', '  Qty  '],
    ['Paracetamol', 10, 20],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

describe('CN-2A parser core — determinism, provenance, and identity', () => {
  it('stamps the pinned SheetJS/contract identity', async () => {
    const bytes = buildSyntheticWorkbook();
    const result = await parseWorkbookBytes(bytes, 'synthetic.xlsx', { runtime: 'node', now: () => '2026-01-01T00:00:00.000Z' });
    expect(result.identity.contractVersion).toBe(CN2A_CONTRACT_VERSION);
    expect(result.identity.sheetjsVersion).toBe(SHEETJS_VERSION);
    expect(result.identity.sheetjsTarballSha256).toBe(SHEETJS_TARBALL_SHA256);
    expect(result.identity.runtime).toBe('node');
  });

  it('fingerprints the exact input bytes with SHA-256', async () => {
    const bytes = buildSyntheticWorkbook();
    const expected = await sha256Hex(bytes);
    const result = await parseWorkbookBytes(bytes, 'synthetic.xlsx', { runtime: 'node' });
    expect(result.input.sha256).toBe(expected);
    expect(result.input.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts the synthetic workbook and preserves every tricky case byte-faithfully', async () => {
    const bytes = buildSyntheticWorkbook();
    const result = await parseWorkbookBytes(bytes, 'synthetic.xlsx', { runtime: 'node', now: () => '2026-01-01T00:00:00.000Z' });
    expect(result.outcome).toBe('accepted');
    const sheet = result.workbook!.sheets[0];

    // Real zero is a value, never blank.
    const qtyZero = sheet.cells.find((c) => c.coordinate.a1 === 'C3');
    expect(qtyZero?.presence).toBe('value');
    expect(qtyZero?.valueType).toBe('number');
    expect(qtyZero?.rawValue).toBe(0);

    // Formula cell keeps its cached result AND its formula text; never evaluated by us.
    const formulaCell = sheet.cells.find((c) => c.coordinate.a1 === 'D2');
    expect(formulaCell?.isFormula).toBe(true);
    expect(formulaCell?.formula).toBe('C2*0.5');
    expect(formulaCell?.rawValue).toBe(5);

    // #VALUE! stays an error, never coerced to 0/blank.
    const errorCell = sheet.cells.find((c) => c.coordinate.a1 === 'D3');
    expect(errorCell?.valueType).toBe('error');
    expect(errorCell?.errorCode).toBe('#VALUE!');
    expect(errorCell?.rawValue).toBe('#VALUE!');

    // Explicit blank carrying only a comment: presence is 'blank', not 'missing'.
    const commentCell = sheet.cells.find((c) => c.coordinate.a1 === 'E1');
    expect(commentCell?.presence).toBe('blank');
    expect(commentCell?.hasComment).toBe(true);

    // Truly unvisited coordinate (outside written cells but inside !ref) is 'missing', not 'blank'.
    const untouched = sheet.cells.find((c) => c.coordinate.a1 === 'E2');
    expect(untouched).toBeUndefined();

    // Merge preserved and duplicate header detected with 0-based columns.
    expect(sheet.mergedRanges).toEqual(['A1:B1']);
    expect(sheet.duplicateHeaderGroups).toEqual([{ headerText: 'Item', headerRow: 0, columns: [0, 1] }]);

    // Provenance is compatible with M209's generic target_entity/field_name vocabulary.
    const record = result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === 'C2');
    expect(record?.fieldName).toBe('Qty');
    expect(record?.sourceProvenance.fileFingerprintSha256).toBe(result.input.sha256);
    expect(record?.sourceProvenance.extractedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('uses the stable col:n fallback for whitespace-only headers without trimming real header text', async () => {
    const bytes = buildWhitespaceHeaderWorkbook();
    const result = await parseWorkbookBytes(bytes, 'whitespace-header.xlsx', {
      runtime: 'node',
      now: () => '2026-01-01T00:00:00.000Z',
    });
    expect(result.outcome).toBe('accepted');

    const blankHeaderRecord = result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === 'B2');
    const paddedHeaderRecord = result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === 'C2');

    expect(blankHeaderRecord?.fieldName).toBe('col:1');
    expect(paddedHeaderRecord?.fieldName).toBe('  Qty  ');
    expect(result.sourceRecords.every((r) => r.fieldName.trim().length > 0)).toBe(true);
  });

  it('produces byte-identical JSON across two parses of the same bytes (determinism)', async () => {
    const bytes = buildSyntheticWorkbook();
    const a = await parseWorkbookBytes(bytes, 'synthetic.xlsx', { runtime: 'node', now: () => '2026-01-01T00:00:00.000Z' });
    const b = await parseWorkbookBytes(bytes, 'synthetic.xlsx', { runtime: 'node', now: () => '2026-01-01T00:00:00.000Z' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('rejects a bad-magic input before ever calling into SheetJS', async () => {
    // A NUL byte alone is valid UTF-8 (U+0000) and must NOT be the bad-magic
    // marker — plain text is a legitimate CSV candidate by design. This uses
    // a genuinely invalid UTF-8 byte sequence instead (a lone continuation
    // byte, 0x80, with no leading byte) to exercise real binary-garbage
    // rejection; see also adversarial.test.ts's PNG-header case.
    const bytes = new Uint8Array([0x80, 0x81, 0x82, 1, 2, 3]);
    const result = await parseWorkbookBytes(bytes, 'fake.xls', { runtime: 'node' });
    expect(result.outcome).toBe('rejected');
    expect(result.diagnostics[0].code).toBe('BAD_MAGIC');
    expect(result.workbook).toBeNull();
    expect(result.sourceRecords).toEqual([]);
  });

  it('detects magic bytes for xls (CFB) and xlsx (ZIP) correctly', () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
    expect(detectMagicFormat(cfb)).toBe('xls');
    expect(detectMagicFormat(zip)).toBe('xlsx');
  });
});
