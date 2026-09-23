/**
 * C3 — Parser / Header / Unit Closure, contract 1.2.0.
 *
 * Everything here is measured against the frozen C3 contract
 * (D:\phoenix-evidence\C3-Parser-Header-Unit-Discovery\
 *  12-C3-PARSER-HEADER-UNIT-CONTRACT-v1.md):
 *
 *   HEADER  a header cell supplies `fieldName` ONLY when it is present,
 *           string-valued and carries at least one VISIBLE character. Every
 *           other case — missing, blank, whitespace-only, invisible-only,
 *           numeric, boolean, date, error — takes `col:{n}`. A usable header is
 *           returned byte-verbatim: never trimmed, case folded, normalized,
 *           bidi-stripped or whitespace-collapsed. ONE predicate governs
 *           fieldName, duplicateHeaderGroups and columnHeaderEvidence alike.
 *   CSV     a CSV cell keeps its exact source text, so leading zeros survive
 *           and no CSV text becomes a formula.
 *   VALUES  missing / blank / numeric zero stay three distinct things.
 *
 * The invisible-header and error/date-header cases are the defects C3 closed;
 * they are written here as the behavioural proof, not as a regression net
 * around something that already worked.
 */
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseWorkbookBytes } from '../parser-core';
import { CN2A_CONTRACT_VERSION } from '../contract';

const NOW = () => '2026-01-01T00:00:00.000Z';

/** A sheet built cell-by-cell, so a case can place an exact SheetJS cell type. */
function sheetOf(cells: Record<string, XLSX.CellObject>, merges?: string[]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  let maxR = 0;
  let maxC = 0;
  for (const [addr, cell] of Object.entries(cells)) {
    (ws as Record<string, unknown>)[addr] = cell;
    const d = XLSX.utils.decode_cell(addr);
    maxR = Math.max(maxR, d.r);
    maxC = Math.max(maxC, d.c);
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  if (merges) ws['!merges'] = merges.map((m) => XLSX.utils.decode_range(m));
  return ws;
}

function bytesOf(ws: XLSX.WorkSheet, bookType: XLSX.BookType = 'xlsx'): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType }));
}

async function parseSheet(cells: Record<string, XLSX.CellObject>, merges?: string[], bookType: XLSX.BookType = 'xlsx') {
  const result = await parseWorkbookBytes(bytesOf(sheetOf(cells, merges), bookType), `c3.${bookType}`, { runtime: 'node', now: NOW });
  expect(result.outcome).toBe('accepted');
  return result;
}

async function parseCsv(text: string) {
  const result = await parseWorkbookBytes(new TextEncoder().encode(text), 'c3.csv', { runtime: 'node', now: NOW });
  expect(result.outcome).toBe('accepted');
  return result;
}

const str = (v: string): XLSX.CellObject => ({ t: 's', v });
const num = (v: number): XLSX.CellObject => ({ t: 'n', v });
/**
 * An EXPLICIT blank: a cell object that exists and carries no value. It is
 * anchored by a comment because that is both how the writer preserves a stub
 * and exactly how the real corpus produces one (CN-0C found a single
 * comment-only blank at kirkh/madina `ورقة1!I1`).
 */
const blankStub = (): XLSX.CellObject => ({ t: 'z', c: [{ a: 'c3', t: 'explicit blank' } as XLSX.Comment] } as XLSX.CellObject);

/** The record emitted for a coordinate, i.e. what would become a source-record row. */
const at = (result: Awaited<ReturnType<typeof parseSheet>>, a1: string) =>
  result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === a1);

/** The header evidence attached to a physical column's anchor record. */
const anchorEvidence = (result: Awaited<ReturnType<typeof parseSheet>>, col: number) =>
  result.sourceRecords.find(
    (r) => r.sourceProvenance.coordinate.col === col && r.sourceProvenance.columnHeaderEvidence !== undefined,
  )?.sourceProvenance.columnHeaderEvidence;

describe('C3 — header predicate: only a visible string header names a field', () => {
  it('T1 a truly missing header cell falls back to col:N and offers no evidence', async () => {
    const r = await parseSheet({ A2: num(5) });
    expect(at(r, 'A2')?.fieldName).toBe('col:0');
    expect(anchorEvidence(r, 0)).toEqual([]);
  });

  it('T2 an explicit blank header (a t:z stub) falls back to col:N', async () => {
    const r = await parseSheet({ A1: blankStub(), A2: num(5) });
    expect(at(r, 'A2')?.fieldName).toBe('col:0');
    expect(anchorEvidence(r, 0)).toEqual([]);
  });

  it('T3 ASCII whitespace-only and empty-string headers fall back to col:N', async () => {
    const r = await parseSheet({ A1: str('   '), B1: str(''), C1: str('\t\n'), A2: num(1), B2: num(2), C2: num(3) });
    expect(at(r, 'A2')?.fieldName).toBe('col:0');
    expect(at(r, 'B2')?.fieldName).toBe('col:1');
    expect(at(r, 'C2')?.fieldName).toBe('col:2');
  });

  it('T4 an NBSP-only header falls back to col:N', async () => {
    const r = await parseSheet({ A1: str('\u00A0'), A2: num(1) });
    expect(at(r, 'A2')?.fieldName).toBe('col:0');
    expect(anchorEvidence(r, 0)).toEqual([]);
  });

  it('T5 a zero-width-space-only header falls back to col:N (1.2.0: was the ZWSP itself)', async () => {
    const r = await parseSheet({ A1: str('\u200B'), A2: num(1) });
    expect(at(r, 'A2')?.fieldName).toBe('col:0');
    expect(anchorEvidence(r, 0)).toEqual([]);
  });

  it('T6 RLM-only and LRM-only headers fall back to col:N', async () => {
    const r = await parseSheet({ A1: str('\u200F'), B1: str('\u200E'), A2: num(1), B2: num(2) });
    expect(at(r, 'A2')?.fieldName).toBe('col:0');
    expect(at(r, 'B2')?.fieldName).toBe('col:1');
  });

  it('T7 a word-joiner-only header, and other default-ignorable-only headers, fall back to col:N', async () => {
    const r = await parseSheet({
      A1: str('\u2060'), B1: str('\uFEFF'), C1: str('\u00AD'), D1: str('\u061C'), E1: str(' \u200B '),
      A2: num(1), B2: num(2), C2: num(3), D2: num(4), E2: num(5),
    });
    expect(at(r, 'A2')?.fieldName).toBe('col:0');
    expect(at(r, 'B2')?.fieldName).toBe('col:1');
    expect(at(r, 'C2')?.fieldName).toBe('col:2');
    expect(at(r, 'D2')?.fieldName).toBe('col:3');
    expect(at(r, 'E2')?.fieldName).toBe('col:4');
    // Nothing invisible reaches persistence as a field name.
    expect(r.sourceRecords.every((x) => /[^\s]/.test(x.fieldName))).toBe(true);
  });

  it('T8 a visible Arabic header is preserved byte-for-byte, bidi marks and all', async () => {
    const header = '\u200Fاسم المادة';
    const r = await parseSheet({ A1: str(header), A2: str('باراسيتامول') });
    expect(at(r, 'A2')?.fieldName).toBe(header);
    expect(anchorEvidence(r, 0)?.[0].rawText).toBe(header);
  });

  it('T9 a visible English header keeps its own spacing and case', async () => {
    const r = await parseSheet({ A1: str(' Drug Name '), A2: str('x') });
    expect(at(r, 'A2')?.fieldName).toBe(' Drug Name ');
  });

  it('T10 a mixed Arabic/English header is preserved unchanged', async () => {
    const r = await parseSheet({ A1: str('Qty الكمية'), A2: num(7) });
    expect(at(r, 'A2')?.fieldName).toBe('Qty الكمية');
  });

  it('T11 duplicate visible labels keep each physical column identity', async () => {
    const r = await parseSheet({ A1: str('Qty'), B1: str('Qty'), A2: num(1), B2: num(2) });
    expect(at(r, 'A2')?.fieldName).toBe('Qty');
    expect(at(r, 'B2')?.fieldName).toBe('Qty');
    expect(at(r, 'A2')?.sourceProvenance.coordinate.col).toBe(0);
    expect(at(r, 'B2')?.sourceProvenance.coordinate.col).toBe(1);
    expect(r.workbook!.sheets[0].duplicateHeaderGroups).toEqual([{ headerText: 'Qty', headerRow: 0, columns: [0, 1] }]);
    expect(r.diagnostics.filter((d) => d.code === 'DUPLICATE_HEADER_TEXT')).toHaveLength(1);
  });

  it('T12 merged-header provenance is preserved, and never forward-filled into the covered column', async () => {
    const r = await parseSheet(
      { A1: str('Item'), B1: str('Institutions'), B2: str('Hospital A'), C2: str('Hospital B'), A3: str('Drug'), B3: num(10), C3: num(0) },
      ['B1:C1'],
    );
    expect(anchorEvidence(r, 1)?.some((e) => e.mergedRange === 'B1:C1')).toBe(true);
    // The merge does NOT donate its text to column C.
    expect(at(r, 'C3')?.fieldName).toBe('col:2');
    expect(r.workbook!.sheets[0].mergedRanges).toContain('B1:C1');
  });

  it('T13 an unresolved multi-row header keeps every candidate instead of guessing one', async () => {
    const r = await parseSheet({
      A1: str('Name'), B1: str('Code'), C2: str('UNIT'), D2: str('Qty'),
      A3: str('Drug'), B3: str('04-F00-025'), C3: str('vial'), D3: num(7),
    });
    // C's own header text sits one row down: it stays evidence, never a fieldName.
    expect(at(r, 'C3')?.fieldName).toBe('col:2');
    expect(anchorEvidence(r, 2)?.map((e) => e.rawText)).toEqual(['UNIT']);
    // B is headed on row 0 and keeps that text, with row 1 offering no candidate.
    expect(at(r, 'B3')?.fieldName).toBe('Code');
    expect(anchorEvidence(r, 1)?.map((e) => e.rawText)).toEqual(['Code']);
  });

  it('T14 a numeric header, and T-boolean, fall back to col:N', async () => {
    const r = await parseSheet({ A1: num(2026), B1: { t: 'b', v: true } as XLSX.CellObject, A2: num(1), B2: num(2) });
    expect(at(r, 'A2')?.fieldName).toBe('col:0');
    expect(at(r, 'B2')?.fieldName).toBe('col:1');
    expect(r.workbook!.sheets[0].duplicateHeaderGroups).toEqual([]);
  });

  it('T15 a date header falls back to col:N and never becomes a serialized date string', async () => {
    const r = await parseSheet({ A1: { t: 'd', v: new Date(Date.UTC(2026, 0, 1)) } as XLSX.CellObject, A2: num(1) });
    expect(at(r, 'A2')?.fieldName).toBe('col:0');
    expect(anchorEvidence(r, 0)).toEqual([]);
  });

  it('T16 an error header falls back to col:N and never becomes "#REF!"', async () => {
    const r = await parseSheet({ A1: { t: 'e', v: 0x17, w: '#REF!' } as XLSX.CellObject, A2: num(1) });
    expect(at(r, 'A2')?.fieldName).toBe('col:0');
    expect(anchorEvidence(r, 0)).toEqual([]);
    // The error itself is still preserved as cell evidence, uncoerced.
    const headerCell = r.workbook!.sheets[0].cells.find((c) => c.coordinate.a1 === 'A1');
    expect(headerCell).toMatchObject({ valueType: 'error', rawValue: '#REF!' });
  });

  it('T17 a formula-backed header uses its cached STRING result, and the formula is never evaluated', async () => {
    const r = await parseSheet({ A1: { t: 's', v: 'Unit Price', f: 'CONCATENATE("Unit"," Price")' } as XLSX.CellObject, A2: num(3) });
    expect(at(r, 'A2')?.fieldName).toBe('Unit Price');
    const headerCell = r.workbook!.sheets[0].cells.find((c) => c.coordinate.a1 === 'A1');
    expect(headerCell?.isFormula).toBe(true);
    expect(headerCell?.formula).toBe('CONCATENATE("Unit"," Price")');
    expect(headerCell?.rawValue).toBe('Unit Price');
  });

  it('the duplicate-header rule and the fieldName rule are the SAME rule', async () => {
    // Two invisible-only headers would once have grouped as duplicates in one
    // path while naming fields in another. Now neither happens.
    const r = await parseSheet({ A1: str('\u200B'), B1: str('\u200B'), A2: num(1), B2: num(2) });
    expect(r.workbook!.sheets[0].duplicateHeaderGroups).toEqual([]);
    expect(r.diagnostics.filter((d) => d.code === 'DUPLICATE_HEADER_TEXT')).toHaveLength(0);
    expect(at(r, 'A2')?.fieldName).toBe('col:0');
    expect(at(r, 'B2')?.fieldName).toBe('col:1');
  });
});

describe('C3 — CSV is exact source text', () => {
  it('T18/T19/T20 CSV keeps 000123, 001 and 0 as strings', async () => {
    const r = await parseCsv('National Code,Qty\n000123,0\n001,\n0,5\n');
    expect(at(r, 'A2')?.sourceValues).toMatchObject({ value: '000123', valueType: 'string' });
    expect(at(r, 'A3')?.sourceValues).toMatchObject({ value: '001', valueType: 'string' });
    expect(at(r, 'A4')?.sourceValues).toMatchObject({ value: '0', valueType: 'string' });
    expect(at(r, 'A2')?.fieldName).toBe('National Code');
  });

  it('T21 CSV TRUE stays the source string, never a boolean', async () => {
    const r = await parseCsv('Flag\nTRUE\n');
    expect(at(r, 'A2')?.sourceValues).toMatchObject({ value: 'TRUE', valueType: 'string' });
  });

  it('T22 CSV =1+1 stays source text and is never a formula cell', async () => {
    const r = await parseCsv('Expr\n=1+1\n');
    const rec = at(r, 'A2');
    expect(rec?.sourceValues).toMatchObject({ value: '=1+1', valueType: 'string', isFormula: false, formula: null });
    const cell = r.workbook!.sheets[0].cells.find((c) => c.coordinate.a1 === 'A2');
    expect(cell?.isFormula).toBe(false);
    expect(cell?.formula).toBeUndefined();
  });

  it('a CSV code with letters and a leading zero survives verbatim', async () => {
    const r = await parseCsv('National Code\n04-F00-025\n');
    expect(at(r, 'A2')?.sourceValues).toMatchObject({ value: '04-F00-025', valueType: 'string' });
  });

  it('XLS/XLSX typing is NOT changed by the CSV rule: a number stays a number', async () => {
    const r = await parseSheet({ A1: str('Qty'), A2: num(12.5), A3: num(0) });
    expect(at(r, 'A2')?.sourceValues).toMatchObject({ value: 12.5, valueType: 'number' });
    expect(at(r, 'A3')?.sourceValues).toMatchObject({ value: 0, valueType: 'number' });
  });
});

describe('C3 — National Code and the blank/zero separation', () => {
  it('T23 an XLS/XLSX leading-zero string is preserved exactly', async () => {
    for (const bookType of ['xlsx', 'biff8'] as XLSX.BookType[]) {
      const r = await parseSheet({ A1: str('National Code'), A2: str('000123'), A3: str('001'), A4: str('0') }, undefined, bookType);
      expect(at(r, 'A2')?.sourceValues).toMatchObject({ value: '000123', valueType: 'string' });
      expect(at(r, 'A3')?.sourceValues).toMatchObject({ value: '001', valueType: 'string' });
      expect(at(r, 'A4')?.sourceValues).toMatchObject({ value: '0', valueType: 'string' });
    }
  });

  it('T24 a blank National Code stays blank evidence and never becomes numeric zero', async () => {
    const r = await parseSheet({ A1: str('National Code'), A2: blankStub(), A3: str(''), A4: str('000123') });
    // A2 is an explicit blank: no record at all, and certainly not a 0.
    expect(at(r, 'A2')).toBeUndefined();
    const blankCell = r.workbook!.sheets[0].cells.find((c) => c.coordinate.a1 === 'A2');
    expect(blankCell?.presence).toBe('blank');
    expect(blankCell?.rawValue).toBeNull();
    // An empty string is a VALUE whose text is empty — still not a zero.
    expect(at(r, 'A3')?.sourceValues).toMatchObject({ value: '', valueType: 'string' });
  });

  it('T25/T26 numeric zero, blank and missing stay three distinct things', async () => {
    const r = await parseSheet({ A1: str('Qty'), A2: num(0), A3: blankStub(), A5: num(4) });
    expect(at(r, 'A2')?.sourceValues).toMatchObject({ value: 0, valueType: 'number' });
    expect(at(r, 'A3')).toBeUndefined();
    expect(at(r, 'A4')).toBeUndefined();

    const cells = r.workbook!.sheets[0].cells;
    expect(cells.find((c) => c.coordinate.a1 === 'A2')).toMatchObject({ presence: 'value', valueType: 'number', rawValue: 0 });
    expect(cells.find((c) => c.coordinate.a1 === 'A3')).toMatchObject({ presence: 'blank', rawValue: null });
    // MISSING is the absence of a cell object entirely — not a blank.
    expect(cells.find((c) => c.coordinate.a1 === 'A4')).toBeUndefined();
    expect(r.workbook!.totals.numericZeroCellCount).toBe(1);
    expect(r.workbook!.totals.explicitBlankCellCount).toBe(1);
  });

  it('a text "0" is never silently turned into the number 0', async () => {
    const r = await parseSheet({ A1: str('Qty'), A2: str('0') });
    expect(at(r, 'A2')?.sourceValues).toMatchObject({ value: '0', valueType: 'string' });
  });
});

describe('C3 — contract identity and the persisted-label boundary', () => {
  it('T31 the parser reports contract version 1.2.0', async () => {
    expect(CN2A_CONTRACT_VERSION).toBe('1.2.0');
    const r = await parseSheet({ A1: str('Item'), A2: str('x') });
    expect(r.identity.contractVersion).toBe('1.2.0');
    expect(r.sourceRecords[0].sourceProvenance.parserVersion.startsWith('1.2.0/')).toBe(true);
  });

  it('M210 persists btrim(fieldName), and the VERBATIM header still survives as evidence', async () => {
    // M210 (`apply_authoritative_replay`) stores btrim(fieldName) — PostgreSQL's
    // default btrim, U+0020 only — and its digests apply the same btrim. The
    // parser deliberately does NOT pre-trim: the untouched text remains in the
    // column's anchor evidence, so the canonicalized label never loses it.
    const pgBtrim = (s: string) => s.replace(/^ +| +$/g, '');
    const r = await parseSheet({ A1: str(' National Code '), A2: str('000123') });
    const rec = at(r, 'A2')!;
    expect(rec.fieldName).toBe(' National Code ');            // parser: verbatim
    expect(pgBtrim(rec.fieldName)).toBe('National Code');      // M210: canonicalized
    expect(anchorEvidence(r, 0)?.[0].rawText).toBe(' National Code '); // evidence: verbatim
  });

  it('T40 continuation rows stay deferred: every physical row is its own targetEntity', async () => {
    const r = await parseSheet(
      { A1: str('Item'), B1: str('Qty'), A2: str('Drug X'), B2: num(10), B3: num(5), A4: str('Drug Y'), B4: num(1) },
      ['A2:A3'],
    );
    const entities = r.sourceRecords.map((x) => x.targetEntity);
    // Row 3 carries only a quantity: it is NOT merged into row 2, and nothing
    // forward-fills "Drug X" into it, even though A2:A3 is a vertical merge.
    expect(new Set(entities)).toEqual(new Set(['sheet:0:row:1', 'sheet:0:row:2', 'sheet:0:row:3']));
    expect(r.sourceRecords.filter((x) => x.targetEntity === 'sheet:0:row:2')).toHaveLength(1);
    expect(at(r, 'B3')?.fieldName).toBe('Qty');
    expect(r.workbook!.sheets[0].mergedRanges).toContain('A2:A3');
  });
});

/**
 * C3 correction #1 - Unicode White_Space is classified explicitly, not by trim().
 *
 * String.prototype.trim removes the ECMAScript WhiteSpace and LineTerminator
 * sets, which are NOT Unicode White_Space. U+0085 NEXT LINE is the case that
 * bites: Unicode calls it White_Space, ECMAScript does not, so trimming it
 * returns it unchanged. While trim() was the classifier, a header made only of
 * U+0085 counted as visible and became a business field name.
 *
 * Every code point here is written as a NUMBER and built with fromCodePoint, so
 * no literal control character can be mangled by an editor, a diff or a patch.
 */
describe('C3 - Unicode White_Space classification (correction #1)', () => {
  const cp = (...points: number[]) => String.fromCodePoint(...points);
  const NEL = 0x0085;
  /** Unicode 15.1 White_Space, every code point in the set. */
  const WHITE_SPACE = [
    0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  ];

  it('a U+0085-only header falls back to col:N', async () => {
    // Guard the premise, so this case can never silently stop testing anything.
    expect(cp(NEL).trim().length).toBe(1);
    const r = await parseSheet({ A1: str(cp(NEL)), A2: num(1) });
    expect(at(r, 'A2')?.fieldName).toBe('col:0');
    expect(anchorEvidence(r, 0)).toEqual([]);
    expect(r.workbook!.sheets[0].duplicateHeaderGroups).toEqual([]);
  });

  it('a header of MIXED Unicode White_Space only falls back to col:N', async () => {
    const r = await parseSheet({ A1: str(cp(...WHITE_SPACE)), A2: num(1) });
    expect(at(r, 'A2')?.fieldName).toBe('col:0');
    expect(anchorEvidence(r, 0)).toEqual([]);
  });

  it('every Unicode White_Space code point is rejected on its own', async () => {
    for (const point of WHITE_SPACE) {
      const r = await parseSheet({ A1: str(cp(point)), A2: num(1) });
      expect(at(r, 'A2')?.fieldName, 'U+' + point.toString(16)).toBe('col:0');
    }
  });

  it('a header of White_Space PLUS Default_Ignorable only falls back to col:N', async () => {
    const r = await parseSheet({
      A1: str(cp(0x0085, 0x200b, 0x00a0, 0x2060, 0x061c, 0x3000, 0xfeff)),
      B1: str(cp(0x0085, 0x00ad)),
      A2: num(1), B2: num(2),
    });
    expect(at(r, 'A2')?.fieldName).toBe('col:0');
    expect(at(r, 'B2')?.fieldName).toBe('col:1');
  });

  it('U+0085 beside visible text keeps the header, byte-for-byte', async () => {
    // "اسم" built numerically for the same reason.
    const arabic = cp(NEL, 0x0627, 0x0633, 0x0645);
    const english = 'Qty' + cp(NEL);
    const r = await parseSheet({ A1: str(arabic), B1: str(english), A2: str('x'), B2: num(2) });
    expect(at(r, 'A2')?.fieldName).toBe(arabic);
    expect(at(r, 'B2')?.fieldName).toBe(english);
    expect(anchorEvidence(r, 0)?.[0].rawText).toBe(arabic);
    expect(anchorEvidence(r, 1)?.[0].rawText).toBe(english);
  });
});
