/**
 * CN-2A B2 — column-anchor structural header evidence.
 *
 * Verifies `computeColumnHeaderEvidence()` / the `columnHeaderEvidence`
 * attachment in `buildSourceRecords()` against the exact algorithm proven in
 * the CN2A-COLUMN-ANCHOR-AUDIT-20260917 evidence bundle (`ANCHOR-ALGORITHM.md`,
 * `01-structural-analysis.mjs`): a 2-row header window, cross-column
 * corroboration to tell a genuine second header row apart from an ordinary
 * data/divider row, and merge-based resolution of multi-row candidates.
 *
 * CN-2A stays a generic structural-evidence parser throughout — nothing here
 * asserts beneficiary/material/unit/conversion meaning for any header text.
 */
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseWorkbookBytes } from '../parser-core';
import { CN2A_CONTRACT_VERSION } from '../contract';

const NOW = () => '2026-01-01T00:00:00.000Z';

function toBytes(wb: XLSX.WorkBook): Uint8Array {
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

describe('CN-2A B2 — column-anchor structural header evidence', () => {
  it('1. attaches evidence only to the first-emitted record for a column; later records carry none', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Name', 'Qty'],
      ['A', 1],
      ['B', 2],
      ['C', 3],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });
    expect(result.outcome).toBe('accepted');

    const byA1 = (a1: string) => result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === a1)!;
    const anchor = byA1('A2');
    expect(hasOwn(anchor.sourceProvenance, 'columnHeaderEvidence')).toBe(true);
    expect(anchor.sourceProvenance.columnHeaderEvidence).toEqual([
      { coordinate: { row: 0, col: 0, a1: 'A1' }, rawText: 'Name' },
    ]);
    expect(hasOwn(byA1('A3').sourceProvenance, 'columnHeaderEvidence')).toBe(false);
    expect(hasOwn(byA1('A4').sourceProvenance, 'columnHeaderEvidence')).toBe(false);
  });

  it('2. a column with exactly one data record: that record is the anchor', async () => {
    const ws = XLSX.utils.aoa_to_sheet([['Code'], ['X1']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });
    expect(result.sourceRecords).toHaveLength(1);
    expect(result.sourceRecords[0].sourceProvenance.columnHeaderEvidence).toEqual([
      { coordinate: { row: 0, col: 0, a1: 'A1' }, rawText: 'Code' },
    ]);
  });

  it('3. a column with many records: only the first of many carries evidence', async () => {
    const rows: (string | number)[][] = [['Name']];
    for (let i = 0; i < 25; i += 1) rows.push([`item-${i}`]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });
    expect(result.sourceRecords).toHaveLength(25);
    const withEvidence = result.sourceRecords.filter((r) => hasOwn(r.sourceProvenance, 'columnHeaderEvidence'));
    expect(withEvidence).toHaveLength(1);
    expect(withEvidence[0].sourceProvenance.coordinate.a1).toBe('A2');
  });

  it('4. a column with zero header-window text gets an explicit empty array on its anchor, never a fabricated guess', async () => {
    // Column B (col 1) is entirely numeric in rows 0-1 -- no string content
    // anywhere in the header window, so it has no header candidate at all.
    const ws = XLSX.utils.aoa_to_sheet([
      ['Name', 5],
      ['A', 10],
      ['B', 20],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });
    // Row 0 is the header row and is excluded from data records, so column
    // B's first-emitted record is B2, its anchor.
    const anchorB = result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === 'B2')!;
    expect(anchorB.sourceProvenance.columnHeaderEvidence).toEqual([]);
  });

  it('5. cross-column corroboration excludes an ordinary data row from being mistaken for a second header row', async () => {
    // Column A's own text appears on row 0 (header) AND row 1 (a data value
    // that happens to be a string) -- row 1 is NOT any other column's own
    // earliest header row, so it must never be treated as a second candidate.
    const ws = XLSX.utils.aoa_to_sheet([
      ['Item', 'Qty'],
      ['Paracetamol', 10],
      ['Amoxicillin', 20],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });
    const anchorA = result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === 'A2')!;
    expect(anchorA.sourceProvenance.columnHeaderEvidence).toEqual([
      { coordinate: { row: 0, col: 0, a1: 'A1' }, rawText: 'Item' },
    ]);
  });

  it('6. genuine ambiguity (two header-window rows for one column, no merge explains it) preserves both candidates', async () => {
    const ws: XLSX.WorkSheet = {};
    ws.A1 = { t: 's', v: 'Category' };
    ws.A2 = { t: 's', v: 'SubHeader' }; // second candidate row for column A
    ws.B2 = { t: 's', v: 'OtherColHeader' }; // corroborates row 1 as a real header row
    ws.A3 = { t: 's', v: 'data' };
    ws.B3 = { t: 's', v: 'data' };
    ws['!ref'] = 'A1:B3';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });
    // Row 0 is the header row and is excluded from data records, so column
    // 0's first-emitted record is A2 (row 1), its anchor.
    const anchorA = result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === 'A2')!;
    expect(anchorA.sourceProvenance.columnHeaderEvidence).toEqual([
      { coordinate: { row: 0, col: 0, a1: 'A1' }, rawText: 'Category' },
      { coordinate: { row: 1, col: 0, a1: 'A2' }, rawText: 'SubHeader' },
    ]);
    // Neither candidate carries a mergedRange -- no real merge explains this one.
    for (const e of anchorA.sourceProvenance.columnHeaderEvidence!) expect(hasOwn(e, 'mergedRange')).toBe(false);
  });

  it('7. a real multi-column merge explains a multi-row candidate and stamps mergedRange only on the merged entry', async () => {
    const ws: XLSX.WorkSheet = {};
    ws.A1 = { t: 's', v: 'Category' }; // merged A1:B1 -- value lives only on the top-left cell
    ws.A2 = { t: 's', v: 'SubA' };
    ws.B2 = { t: 's', v: 'SubB' };
    ws.A3 = { t: 's', v: 'data' };
    ws.B3 = { t: 's', v: 'data' };
    ws['!ref'] = 'A1:B3';
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });

    // Row 0 is the header row and is excluded from data records, so each
    // column's first-emitted record is its row-1 cell, its anchor.
    const anchorA = result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === 'A2')!;
    expect(anchorA.sourceProvenance.columnHeaderEvidence).toEqual([
      { coordinate: { row: 0, col: 0, a1: 'A1' }, rawText: 'Category', mergedRange: 'A1:B1' },
      { coordinate: { row: 1, col: 0, a1: 'A2' }, rawText: 'SubA' },
    ]);

    const anchorB = result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === 'B2')!;
    // Column B's own only header-window text is at row 1 (outside the merge's row band) -- single candidate, no merge tag.
    expect(anchorB.sourceProvenance.columnHeaderEvidence).toEqual([
      { coordinate: { row: 1, col: 1, a1: 'B2' }, rawText: 'SubB' },
    ]);
  });

  it('8. disjoint header regions: each column resolves its own header row independently', async () => {
    const ws: XLSX.WorkSheet = {};
    ws.C1 = { t: 's', v: 'P' };
    ws.D1 = { t: 's', v: 'Q' };
    ws.A2 = { t: 's', v: 'X' };
    ws.B2 = { t: 's', v: 'Y' };
    ws.C2 = { t: 'n', v: 100 };
    ws.D2 = { t: 'n', v: 200 };
    ws.A3 = { t: 'n', v: 10 };
    ws.B3 = { t: 'n', v: 20 };
    ws['!ref'] = 'A1:D3';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });

    const anchorA = result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === 'A2')!;
    expect(anchorA.sourceProvenance.columnHeaderEvidence).toEqual([
      { coordinate: { row: 1, col: 0, a1: 'A2' }, rawText: 'X' },
    ]);
    const anchorC = result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === 'C2')!;
    expect(anchorC.sourceProvenance.columnHeaderEvidence).toEqual([
      { coordinate: { row: 0, col: 2, a1: 'C1' }, rawText: 'P' },
    ]);
  });

  it('9. a stale-range missing upper header: the anchor is the first record whose own column evidence is one row down', async () => {
    // Row 0 has zero populated cells anywhere (a stale declared !ref, exactly
    // the real-corpus quirk this case documents); the real single-row header
    // for column A sits at row 1 instead.
    const ws: XLSX.WorkSheet = {};
    ws.A2 = { t: 's', v: 'Unit' };
    ws.B2 = { t: 'n', v: 42 };
    ws.A3 = { t: 'n', v: 1 };
    ws.B3 = { t: 'n', v: 2 };
    ws['!ref'] = 'A1:B3';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });
    const anchorA = result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === 'A2')!;
    expect(anchorA.sourceProvenance.columnHeaderEvidence).toEqual([
      { coordinate: { row: 1, col: 0, a1: 'A2' }, rawText: 'Unit' },
    ]);
  });

  it('10. repeated header text across two disjoint columns anchors each independently, never merged', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['NATIONAL CODE', 'Item', 'NATIONAL CODE', 'Note'],
      ['C1', 'A', 'C2', 'N1'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });
    const anchorCol0 = result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === 'A2')!;
    const anchorCol2 = result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === 'C2')!;
    expect(anchorCol0.sourceProvenance.columnHeaderEvidence).toEqual([
      { coordinate: { row: 0, col: 0, a1: 'A1' }, rawText: 'NATIONAL CODE' },
    ]);
    expect(anchorCol2.sourceProvenance.columnHeaderEvidence).toEqual([
      { coordinate: { row: 0, col: 2, a1: 'C1' }, rawText: 'NATIONAL CODE' },
    ]);
  });

  it('11. anchor selection is value-agnostic: a formula cell and a numeric zero anchor exactly like any other cell', async () => {
    const ws: XLSX.WorkSheet = {};
    ws.A1 = { t: 's', v: 'Qty' };
    ws.A2 = { t: 'n', v: 5, f: 'B2*0.5' };
    ws.A3 = { t: 'n', v: 0 };
    ws['!ref'] = 'A1:A3';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });
    const formulaAnchor = result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === 'A2')!;
    expect(formulaAnchor.sourceProvenance.columnHeaderEvidence).toEqual([
      { coordinate: { row: 0, col: 0, a1: 'A1' }, rawText: 'Qty' },
    ]);
    const zeroRecord = result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === 'A3')!;
    expect(hasOwn(zeroRecord.sourceProvenance, 'columnHeaderEvidence')).toBe(false);
    expect((zeroRecord.sourceValues as { value: unknown }).value).toBe(0);
  });

  it('12. a hidden sheet is anchored identically to a visible one', async () => {
    const ws = XLSX.utils.aoa_to_sheet([['Name'], ['A']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    wb.Workbook = { Sheets: [{ Hidden: 1 }] };
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });
    expect(result.workbook!.sheets[0].hidden).toBe('hidden');
    expect(result.sourceRecords[0].sourceProvenance.columnHeaderEvidence).toEqual([
      { coordinate: { row: 0, col: 0, a1: 'A1' }, rawText: 'Name' },
    ]);
  });

  it('13. an empty sheet produces zero records and zero anchors, never an error', async () => {
    const ws: XLSX.WorkSheet = { '!ref': 'A1:A1' };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });
    expect(result.outcome).toBe('accepted');
    const sheetRecords = result.sourceRecords.filter((r) => r.sourceProvenance.sheetIndex === 0);
    expect(sheetRecords).toHaveLength(0);
  });

  it('14. the same column index on two different sheets anchors independently, never cross-contaminated', async () => {
    const ws1 = XLSX.utils.aoa_to_sheet([['Alpha'], ['a1']]);
    const ws2 = XLSX.utils.aoa_to_sheet([['Beta'], ['b1']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, 'Sheet1');
    XLSX.utils.book_append_sheet(wb, ws2, 'Sheet2');
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });
    const anchorSheet0 = result.sourceRecords.find((r) => r.sourceProvenance.sheetIndex === 0)!;
    const anchorSheet1 = result.sourceRecords.find((r) => r.sourceProvenance.sheetIndex === 1)!;
    expect(anchorSheet0.sourceProvenance.columnHeaderEvidence).toEqual([
      { coordinate: { row: 0, col: 0, a1: 'A1' }, rawText: 'Alpha' },
    ]);
    expect(anchorSheet1.sourceProvenance.columnHeaderEvidence).toEqual([
      { coordinate: { row: 0, col: 0, a1: 'A1' }, rawText: 'Beta' },
    ]);
  });

  it('15. rawText is byte-verbatim: never trimmed, case-folded, or reformatted', async () => {
    const ws = XLSX.utils.aoa_to_sheet([['  MiXeD Case Header  '], ['x']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });
    expect(result.sourceRecords[0].sourceProvenance.columnHeaderEvidence).toEqual([
      { coordinate: { row: 0, col: 0, a1: 'A1' }, rawText: '  MiXeD Case Header  ' },
    ]);
  });

  it('16. produces byte-identical columnHeaderEvidence across two parses of the same bytes (determinism)', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Item', 'Item', 'Qty'],
      ['Paracetamol', 'x', 10],
    ]);
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const bytes = toBytes(wb);
    const a = await parseWorkbookBytes(bytes, 'w.xlsx', { runtime: 'node', now: NOW });
    const b = await parseWorkbookBytes(bytes, 'w.xlsx', { runtime: 'node', now: NOW });
    expect(JSON.stringify(a.sourceRecords)).toBe(JSON.stringify(b.sourceRecords));
  });

  // B2 shipped as 1.1.0; C3's header/CSV semantics moved the same contract to
  // 1.2.0. The pin moves with it deliberately — the version is compared
  // verbatim by the parity gate, so it must never drift silently.
  it('17. the contract version reports 1.2.0, carrying the additive B2 evidence forward', async () => {
    const ws = XLSX.utils.aoa_to_sheet([['Name'], ['A']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });
    expect(CN2A_CONTRACT_VERSION).toBe('1.2.0');
    expect(result.identity.contractVersion).toBe('1.2.0');
  });

  it('18. B2 is purely additive: fieldName, targetEntity, sourceValues, and record cardinality/order are unchanged', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Item', 'Qty'],
      ['Paracetamol', 10],
      ['Amoxicillin', 0],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const result = await parseWorkbookBytes(toBytes(wb), 'w.xlsx', { runtime: 'node', now: NOW });
    expect(result.sourceRecords.map((r) => [r.targetEntity, r.fieldName, (r.sourceValues as { value: unknown }).value])).toEqual([
      ['sheet:0:row:1', 'Item', 'Paracetamol'],
      ['sheet:0:row:1', 'Qty', 10],
      ['sheet:0:row:2', 'Item', 'Amoxicillin'],
      ['sheet:0:row:2', 'Qty', 0],
    ]);
  });
});
