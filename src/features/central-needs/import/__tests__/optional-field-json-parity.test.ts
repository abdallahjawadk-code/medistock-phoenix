/**
 * CN-2A/CN-2B regression guard — ABSENT OPTIONAL FIELDS MUST BE ABSENT.
 *
 * The defect these tests lock down was found by a real-archive acceptance run
 * and made `finalize-import` unusable for every real workbook:
 *
 *   `extractCell()` assigned its optional fields unconditionally, so a cell
 *   with no comment still carried an OWN PROPERTY `commentText` whose value was
 *   `undefined` (likewise `formula`, `errorCode`, `formattedText`, and
 *   `InputFingerprint.archiveEntryPath` for a standalone workbook).
 *
 *   `JSON.stringify` drops such a key. The browser preview reaches the trusted
 *   server as JSON (hook -> signed staging upload -> JSON.parse), while the Node
 *   authoritative result is compared IN MEMORY, where the key still exists.
 *   `api/_lib/parity.ts` deliberately separates an absent key from a key holding
 *   `undefined`, so step 8 of `finalize-import` answered
 *   `browser_node_parity_mismatch` / `extra_key` on the FIRST cell of the first
 *   sheet — for any input at all.
 *
 * Why the defect survived every earlier parity check: they all compared JSON
 * against JSON, which is symmetric and therefore blind to this entire class of
 * difference. Test B below is deliberately ASYMMETRIC — JSON round-trip versus
 * in-memory — because that asymmetry is what the product path actually performs.
 * It fails on the pre-fix parser and passes on the corrected one.
 *
 * These tests must keep using the product's own `compareParsedResults`, with no
 * normalization of their own: a test that normalized the two sides first would
 * reproduce exactly the blindness that let the defect through.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { parseWorkbookBytes } from '../parser-core';
import { replayArchive } from '../node-replay';
import { compareParsedResults } from '../../../../../api/_lib/parity';
import type { CellEvidence } from '../contract';

/** Plain cells plus one formula cell, one error cell, and one comment-only cell. */
function buildSyntheticWorkbook(): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Item', 'Qty'],
    ['Paracetamol', 10],
    ['Amoxicillin', 0],
  ]);
  ws.D2 = { t: 'n', v: 5, f: 'B2*0.5' };
  ws.D3 = { t: 'e', v: 15, w: '#VALUE!', f: 'B3/0' };
  ws.E1 = { t: 'z', c: [{ a: 'tester', t: 'a stray comment' } as XLSX.Comment] };
  ws['!ref'] = 'A1:E3';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const cellAt = (cells: CellEvidence[], a1: string) => cells.find((c) => c.coordinate.a1 === a1)!;

const OPTIONAL_CELL_FIELDS = ['valueType', 'errorCode', 'formattedText', 'formula', 'commentText'] as const;

describe('CN-2A optional fields — absent means absent (never a key holding undefined)', () => {
  // ---- Test A -------------------------------------------------------------
  it('A. omits every optional cell field that has no value, rather than setting it to undefined', async () => {
    const result = await parseWorkbookBytes(buildSyntheticWorkbook(), 'synthetic.xlsx', { runtime: 'node' });
    expect(result.outcome).toBe('accepted');
    const cells = result.workbook!.sheets[0].cells;

    // A plain string cell: no formula, no comment, no error.
    const plain = cellAt(cells, 'A2');
    expect(plain.hasComment).toBe(false);
    expect(plain.isFormula).toBe(false);
    expect(hasOwn(plain, 'commentText')).toBe(false);
    expect(hasOwn(plain, 'formula')).toBe(false);
    expect(hasOwn(plain, 'errorCode')).toBe(false);

    // The comment-only blank cell has a comment but still no formula.
    const commentOnly = cellAt(cells, 'E1');
    expect(commentOnly.presence).toBe('blank');
    expect(hasOwn(commentOnly, 'formula')).toBe(false);

    // Nothing anywhere in the document may be a key whose value is undefined.
    const undefinedKeys: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (v === undefined) undefinedKeys.push(`${path}.${k}`);
        else walk(v, `${path}.${k}`);
      }
    };
    walk(result, '');
    expect(undefinedKeys).toEqual([]);
  });

  it('A2. omits archiveEntryPath entirely for a standalone (non-archive) workbook', async () => {
    const result = await parseWorkbookBytes(buildSyntheticWorkbook(), 'synthetic.xlsx', { runtime: 'node' });
    expect(hasOwn(result.input, 'archiveEntryPath')).toBe(false);
    for (const record of result.sourceRecords) {
      expect(hasOwn(record.sourceProvenance, 'archiveEntryPath')).toBe(false);
    }
  });

  it('A3. B2: columnHeaderEvidence is present only on the first-emitted record per physical column', async () => {
    const result = await parseWorkbookBytes(buildSyntheticWorkbook(), 'synthetic.xlsx', { runtime: 'node' });
    const byCoordinate = (a1: string) =>
      result.sourceRecords.find((r) => r.sourceProvenance.coordinate.a1 === a1)!;

    // Column A (header "Item" at A1): A2 is the anchor, A3 is not.
    const a2 = byCoordinate('A2');
    expect(hasOwn(a2.sourceProvenance, 'columnHeaderEvidence')).toBe(true);
    expect(a2.sourceProvenance.columnHeaderEvidence).toEqual([{ coordinate: { row: 0, col: 0, a1: 'A1' }, rawText: 'Item' }]);
    const a3 = byCoordinate('A3');
    expect(hasOwn(a3.sourceProvenance, 'columnHeaderEvidence')).toBe(false);

    // Column B (header "Qty" at B1): B2 is the anchor, B3 is not.
    const b2 = byCoordinate('B2');
    expect(b2.sourceProvenance.columnHeaderEvidence).toEqual([{ coordinate: { row: 0, col: 1, a1: 'B1' }, rawText: 'Qty' }]);
    expect(hasOwn(byCoordinate('B3').sourceProvenance, 'columnHeaderEvidence')).toBe(false);

    // Column D has no header text anywhere in the window: its anchor (D2) still
    // gets an explicit empty array, never a fabricated guess; D3 has none at all.
    const d2 = byCoordinate('D2');
    expect(hasOwn(d2.sourceProvenance, 'columnHeaderEvidence')).toBe(true);
    expect(d2.sourceProvenance.columnHeaderEvidence).toEqual([]);
    const d3 = byCoordinate('D3');
    expect(hasOwn(d3.sourceProvenance, 'columnHeaderEvidence')).toBe(false);
  });

  // ---- Test B -------------------------------------------------------------
  // THE GUARD. Asymmetric on purpose: JSON round-trip versus in-memory, exactly
  // as finalize-import compares the browser preview against the Node replay.
  it('B. survives a JSON round-trip under the product comparator — standalone workbook', async () => {
    const nodeResult = await parseWorkbookBytes(buildSyntheticWorkbook(), 'synthetic.xlsx', { runtime: 'node' });
    const roundTripped = JSON.parse(JSON.stringify(nodeResult));
    expect(compareParsedResults(roundTripped, nodeResult, 'file')).toEqual({ equal: true });
  });

  it('B2. survives a JSON round-trip under the product comparator — ZIP archive', async () => {
    const zip = new Uint8Array(readFileSync(new URL('./fixtures/synthetic-archive.zip', import.meta.url)));
    const nodeResult = await replayArchive(zip, 'synthetic-archive.zip');
    expect(nodeResult.entries.length).toBeGreaterThan(0);
    // An archived entry DOES carry archiveEntryPath — the key must still be present here.
    expect(hasOwn(nodeResult.entries[0].input, 'archiveEntryPath')).toBe(true);
    const roundTripped = JSON.parse(JSON.stringify(nodeResult));
    expect(compareParsedResults(roundTripped, nodeResult, 'archive')).toEqual({ equal: true });
  });

  // ---- Test C -------------------------------------------------------------
  it('C. preserves every optional value that really exists, unchanged', async () => {
    const result = await parseWorkbookBytes(buildSyntheticWorkbook(), 'synthetic.xlsx', { runtime: 'node' });
    const cells = result.workbook!.sheets[0].cells;

    const formulaCell = cellAt(cells, 'D2');
    expect(hasOwn(formulaCell, 'formula')).toBe(true);
    expect(formulaCell.formula).toBe('B2*0.5');
    expect(formulaCell.isFormula).toBe(true);
    expect(formulaCell.rawValue).toBe(5);

    const errorCell = cellAt(cells, 'D3');
    expect(hasOwn(errorCell, 'errorCode')).toBe(true);
    expect(errorCell.errorCode).toBe('#VALUE!');
    expect(errorCell.valueType).toBe('error');
    expect(errorCell.rawValue).toBe('#VALUE!');
    expect(errorCell.formula).toBe('B3/0');

    const commentCell = cellAt(cells, 'E1');
    expect(commentCell.hasComment).toBe(true);
    expect(hasOwn(commentCell, 'commentText')).toBe(true);
    expect(commentCell.commentText).toBe('a stray comment');

    const headerCell = cellAt(cells, 'A1');
    expect(hasOwn(headerCell, 'formattedText')).toBe(true);
    expect(headerCell.formattedText).toBe('Item');

    // A present optional value must still survive the round-trip it previously broke.
    const roundTripped = JSON.parse(JSON.stringify(result));
    const rtCells: CellEvidence[] = roundTripped.workbook.sheets[0].cells;
    expect(cellAt(rtCells, 'E1').commentText).toBe('a stray comment');
    expect(cellAt(rtCells, 'D2').formula).toBe('B2*0.5');
    expect(cellAt(rtCells, 'D3').errorCode).toBe('#VALUE!');
  });

  it('C2. keeps the optional-field surface exactly as the contract declares it', async () => {
    const result = await parseWorkbookBytes(buildSyntheticWorkbook(), 'synthetic.xlsx', { runtime: 'node' });
    const cells = result.workbook!.sheets[0].cells;
    // Every key that does appear on a cell is either required or a declared optional.
    const allowed = new Set<string>([
      'coordinate', 'presence', 'rawValue', 'isFormula', 'hasComment', ...OPTIONAL_CELL_FIELDS,
    ]);
    for (const cell of cells) {
      for (const key of Object.keys(cell)) expect(allowed.has(key), `${cell.coordinate.a1}.${key}`).toBe(true);
    }
  });
});
