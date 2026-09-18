/**
 * E1 Excel-First — the pure viewer model.
 *
 * These are presentation facts derived from parser evidence: A1 labels,
 * merge geometry, the grid extent, what a cell shows, and how much of a sheet
 * is ever mounted. Each test also guards one evidence invariant the model
 * must never break (no fabricated cells, no copied merge values, zero never
 * shown as blank, bounded rendering).
 */
import { describe, expect, it } from 'vitest';
import type { CellEvidence, FileParseResult, ArchiveParseResult, SheetEvidence } from '../../import/contract';
import {
  GRID_MAX_RENDERED_CELLS,
  GRID_MAX_WINDOW_COLS,
  GRID_MAX_WINDOW_ROWS,
  GRID_ROW_HEIGHT,
  MERGE_INSPECT_SCAN_LIMIT,
  MERGE_PROCESS_LIMIT,
  a1Address,
  buildSheetGridModel,
  cellDisplayText,
  columnLetters,
  computeGridWindow,
  hiddenValuesInMerge,
  initialSheetIndex,
  initialWorkbookIndex,
  listViewerWorkbooks,
  moveSelection,
  parseA1Cell,
  parseA1Range,
  rawValueText,
  scrollToReveal,
  sheetGridExtent,
} from '../excelViewerModel';

function cell(a1: string, over: Partial<CellEvidence> = {}): CellEvidence {
  const p = parseA1Cell(a1)!;
  return {
    coordinate: { row: p.row, col: p.col, a1 },
    presence: 'value',
    valueType: 'string',
    rawValue: a1,
    isFormula: false,
    hasComment: false,
    ...over,
  };
}

function sheetOf(cells: CellEvidence[], over: Partial<SheetEvidence> = {}): SheetEvidence {
  return {
    index: 0,
    name: 'Sheet1',
    hidden: 'visible',
    usedRange: { startRow: 0, endRow: 4, startCol: 0, endCol: 3 },
    nonEmptyCellCount: cells.filter((c) => c.presence === 'value').length,
    cells,
    mergedRanges: [],
    duplicateHeaderGroups: [],
    ...over,
  };
}

describe('A1 coordinates are stable spreadsheet coordinates', () => {
  it('maps column indices to letters exactly as Excel does', () => {
    const cases: Array<[number, string]> = [
      [0, 'A'], [1, 'B'], [25, 'Z'], [26, 'AA'], [27, 'AB'], [51, 'AZ'], [52, 'BA'],
      [255, 'IV'], [701, 'ZZ'], [702, 'AAA'], [16383, 'XFD'],
    ];
    for (const [col, letters] of cases) expect(columnLetters(col), String(col)).toBe(letters);
  });

  it('rejects impossible column indices instead of inventing a label', () => {
    expect(() => columnLetters(-1)).toThrow(RangeError);
    expect(() => columnLetters(16384)).toThrow(RangeError);
    expect(() => columnLetters(1.5)).toThrow(RangeError);
  });

  it('builds the contract\'s own A1 examples', () => {
    expect(a1Address(0, 0)).toBe('A1');
    expect(a1Address(36, 27)).toBe('AB37');
  });

  it('round-trips every address and refuses malformed text', () => {
    for (let row = 0; row < 40; row += 7) {
      for (let col = 0; col < 800; col += 37) {
        expect(parseA1Cell(a1Address(row, col))).toEqual({ row, col });
      }
    }
    for (const bad of ['', 'a1', 'A0', 'A01', '$A$1', 'XFE1', 'A1048577', '1A', 'A1 ', 'AAAA1']) {
      expect(parseA1Cell(bad), bad).toBeNull();
    }
  });

  it('decodes merged ranges verbatim and normalises their corners', () => {
    expect(parseA1Range('A1:C3')).toEqual({ range: 'A1:C3', startRow: 0, endRow: 2, startCol: 0, endCol: 2 });
    expect(parseA1Range('C3:A1')).toEqual({ range: 'C3:A1', startRow: 0, endRow: 2, startCol: 0, endCol: 2 });
    expect(parseA1Range('B2')).toEqual({ range: 'B2', startRow: 1, endRow: 1, startCol: 1, endCol: 1 });
    for (const bad of ['A1:', ':B2', 'A1:B2:C3', 'A1-B2', '']) expect(parseA1Range(bad), bad).toBeNull();
  });
});

describe('what a grid cell shows — never a business value, never zero-as-blank', () => {
  it('renders raw values as plain text, booleans in Excel\'s own words', () => {
    expect(rawValueText(null)).toBe('');
    expect(rawValueText(0)).toBe('0');
    expect(rawValueText(true)).toBe('TRUE');
    expect(rawValueText(false)).toBe('FALSE');
    expect(rawValueText('نص')).toBe('نص');
  });

  it('keeps missing, explicit blank and numeric zero distinct', () => {
    const blank = cell('B1', { presence: 'blank', valueType: undefined, rawValue: null });
    const zero = cell('C1', { valueType: 'number', rawValue: 0 });
    expect(cellDisplayText(undefined)).toBe('');
    expect(cellDisplayText(blank)).toBe('');
    expect(cellDisplayText(zero)).toBe('0');
  });

  it('never lets a zero-hiding number format make a numeric zero look blank', () => {
    const zeroHidden = cell('C1', { valueType: 'number', rawValue: 0, formattedText: '' });
    const zeroSpaces = cell('C2', { valueType: 'number', rawValue: 0, formattedText: '   ' });
    expect(cellDisplayText(zeroHidden)).toBe('0');
    expect(cellDisplayText(zeroSpaces)).toBe('0');
  });

  it('shows the workbook\'s visible formatting, while the raw value stays untouched', () => {
    const percent = cell('D1', { valueType: 'number', rawValue: 0.5, formattedText: '50%' });
    expect(cellDisplayText(percent)).toBe('50%');
    expect(percent.rawValue).toBe(0.5);
  });

  it('shows an error cell as its own error code', () => {
    const err = cell('E1', { valueType: 'error', rawValue: '#DIV/0!', errorCode: '#DIV/0!', isFormula: true, formula: '1/0' });
    expect(cellDisplayText(err)).toBe('#DIV/0!');
  });
});

describe('the sheet grid model derives presentation only and fabricates no evidence', () => {
  it('has nothing to draw for a sheet with no used range and no cells', () => {
    expect(sheetGridExtent(sheetOf([], { usedRange: null }))).toBeNull();
    expect(buildSheetGridModel(sheetOf([], { usedRange: null })).extent).toBeNull();
  });

  it('starts at A1 like Excel, and only offsets an implausibly distant used range', () => {
    expect(sheetGridExtent(sheetOf([], { usedRange: { startRow: 2, endRow: 3, startCol: 2, endCol: 3 } })))
      .toEqual({ originRow: 0, originCol: 0, rowCount: 4, colCount: 4 });
    expect(sheetGridExtent(sheetOf([], { usedRange: { startRow: 5000, endRow: 5009, startCol: 0, endCol: 1 } })))
      .toEqual({ originRow: 5000, originCol: 0, rowCount: 10, colCount: 2 });
  });

  it('returns the parser\'s own evidence object for a coordinate, and undefined where it emitted none', () => {
    const a1 = cell('A1');
    const model = buildSheetGridModel(sheetOf([a1]));
    expect(model.cellAt(0, 0)).toBe(a1);
    expect(model.cellAt(0, 1)).toBeUndefined();
    expect(model.sheet.cells).toHaveLength(1);
  });

  it('decodes merges, keeps undecodable ones for disclosure, and never copies the anchor value', () => {
    const anchor = cell('A1', { rawValue: 'مصرف الدم' });
    const sheet = sheetOf([anchor], { mergedRanges: ['A1:C1', 'not-a-range'] });
    const before = structuredClone(sheet);
    const model = buildSheetGridModel(sheet);
    expect(model.merges.map((m) => m.range)).toEqual(['A1:C1']);
    expect(model.unparsedMergedRanges).toEqual(['not-a-range']);
    expect(model.mergeAt(0, 2)?.range).toBe('A1:C1');
    // Covered coordinates remain absent: nothing was copied into B1 or C1.
    expect(model.cellAt(0, 1)).toBeUndefined();
    expect(model.cellAt(0, 2)).toBeUndefined();
    expect(sheet).toEqual(before);
  });

  it('discloses values Excel hides inside a merge, excluding the anchor and blank stubs', () => {
    const sheet = sheetOf([
      cell('A1', { rawValue: 'anchor' }),
      cell('B1', { rawValue: 'hidden-in-merge' }),
      cell('C1', { presence: 'blank', valueType: undefined, rawValue: null }),
    ], { mergedRanges: ['A1:C1'] });
    const model = buildSheetGridModel(sheet);
    const hidden = hiddenValuesInMerge(model, model.merges[0]);
    expect(hidden.total).toBe(1);
    expect(hidden.cells.map((c) => c.coordinate.a1)).toEqual(['B1']);
  });

  it('bounds and deduplicates hostile duplicate merges deterministically', () => {
    const mergedRanges = Array.from({ length: MERGE_PROCESS_LIMIT }, () => 'A1:B2');
    const model = buildSheetGridModel(sheetOf([cell('A1')], {
      usedRange: { startRow: 0, endRow: 99, startCol: 0, endCol: 29 },
      mergedRanges,
    }));
    expect(model.merges.map((m) => m.range)).toEqual(['A1:B2']);
    expect(model.mergeSafety).toMatchObject({
      sourceMergeCount: MERGE_PROCESS_LIMIT,
      processedMergeCount: MERGE_PROCESS_LIMIT,
      renderableMergeCount: 1,
      duplicateMergeCount: MERGE_PROCESS_LIMIT - 1,
      overlappingMergeCount: 0,
      unprocessedMergeCount: 0,
      limited: true,
    });
    expect(model.mergesInWindow({ firstRow: 0, lastRow: 20, firstCol: 0, lastCol: 10 })).toHaveLength(1);
  });

  it('keeps the first merge and suppresses later overlapping geometry in source order', () => {
    const mergedRanges = Array.from({ length: MERGE_PROCESS_LIMIT }, (_, i) => `A1:A${i + 1}`);
    const model = buildSheetGridModel(sheetOf([cell('A1')], {
      usedRange: { startRow: 0, endRow: 9_999, startCol: 0, endCol: 1 },
      mergedRanges,
    }));
    expect(model.merges.map((m) => m.range)).toEqual(['A1:A1']);
    expect(model.mergeSafety.overlappingMergeCount).toBe(MERGE_PROCESS_LIMIT - 1);
    expect(model.mergeSafety.duplicateMergeCount).toBe(0);
    expect(model.mergeAt(9_999, 0)).toBeUndefined();
    expect(model.mergeAt(0, 0)?.range).toBe('A1:A1');
  });

  it('stops merge intake at the hard ceiling and discloses the unprocessed tail', () => {
    const mergedRanges = Array.from({ length: MERGE_PROCESS_LIMIT + 7 }, (_, i) => `A${i + 1}:B${i + 1}`);
    const model = buildSheetGridModel(sheetOf([cell('A1')], {
      usedRange: { startRow: 0, endRow: MERGE_PROCESS_LIMIT + 6, startCol: 0, endCol: 1 },
      mergedRanges,
    }));
    expect(model.mergeSafety.processedMergeCount).toBe(MERGE_PROCESS_LIMIT);
    expect(model.mergeSafety.unprocessedMergeCount).toBe(7);
    expect(model.mergeSafety.renderableMergeCount).toBe(MERGE_PROCESS_LIMIT);
    expect(model.mergeSafety.safetySuppressedMergeCount).toBe(7);
    expect(model.mergeSafety.limited).toBe(true);
  });

  it('bounds hidden-value inspection and never invents an exact total when truncated', () => {
    const cells = Array.from({ length: MERGE_INSPECT_SCAN_LIMIT + 50 }, (_, i) =>
      cell(`A${i + 1}`, { rawValue: i }));
    const model = buildSheetGridModel(sheetOf(cells, {
      usedRange: { startRow: 0, endRow: cells.length - 1, startCol: 0, endCol: 0 },
      mergedRanges: [`A1:A${cells.length}`],
    }));
    const hidden = hiddenValuesInMerge(model, model.merges[0]);
    expect(hidden.scanComplete).toBe(false);
    expect(hidden.scannedEvidenceCount).toBe(MERGE_INSPECT_SCAN_LIMIT);
    expect(hidden.total).toBeNull();
    expect(hidden.cells).toHaveLength(10);
    expect(hidden.cells[0].coordinate.a1).toBe('A2');
  });
});

describe('bounded rendering window', () => {
  const huge = { originRow: 0, originCol: 0, rowCount: 10_000, colCount: 256 };

  it('never mounts more than the hard ceiling, however large the viewport', () => {
    const win = computeGridWindow(huge, { top: 0, left: 0, width: 100_000, height: 100_000 });
    expect(win.lastRow - win.firstRow + 1).toBeLessThanOrEqual(GRID_MAX_WINDOW_ROWS);
    expect(win.lastCol - win.firstCol + 1).toBeLessThanOrEqual(GRID_MAX_WINDOW_COLS);
    expect((win.lastRow - win.firstRow + 1) * (win.lastCol - win.firstCol + 1)).toBeLessThanOrEqual(GRID_MAX_RENDERED_CELLS);
  });

  it('follows the scroll position and clamps at the end of the sheet', () => {
    const mid = computeGridWindow(huge, { top: 5000 * GRID_ROW_HEIGHT, left: 0, width: 900, height: 500 });
    expect(mid.firstRow).toBeLessThanOrEqual(5000);
    expect(mid.lastRow).toBeGreaterThan(5000);
    const end = computeGridWindow(huge, { top: 10_000_000, left: 10_000_000, width: 900, height: 500 });
    expect(end.lastRow).toBe(9_999);
    expect(end.lastCol).toBe(255);
  });

  it('uses a fallback viewport when the container cannot be measured', () => {
    const win = computeGridWindow(huge, { top: 0, left: 0, width: 0, height: 0 });
    expect(win.firstRow).toBe(0);
    expect(win.lastRow).toBeGreaterThan(10);
    expect(win.lastRow - win.firstRow + 1).toBeLessThanOrEqual(GRID_MAX_WINDOW_ROWS);
  });

  it('scrolls just enough to reveal a coordinate', () => {
    const extent = { originRow: 0, originCol: 0, rowCount: 100, colCount: 20 };
    const view = { top: 0, left: 0, width: 600, height: 300 };
    expect(scrollToReveal(extent, { row: 0, col: 0 }, view)).toEqual({ top: 0, left: 0 });
    const below = scrollToReveal(extent, { row: 50, col: 0 }, view);
    expect(below.top).toBeGreaterThan(0);
    expect(scrollToReveal(extent, { row: 0, col: 0 }, { ...view, top: below.top })).toEqual({ top: 0, left: 0 });
  });
});

describe('keyboard movement treats a merged region as one stop', () => {
  const model = buildSheetGridModel(sheetOf([cell('A1')], {
    usedRange: { startRow: 0, endRow: 3, startCol: 0, endCol: 3 },
    mergedRanges: ['B2:C3'],
  }));

  it('starts at the grid origin', () => {
    expect(moveSelection(model, null, 0, 1)).toEqual({ row: 0, col: 0 });
  });

  it('lands on the anchor when stepping into a merge, and leaves from its far edge', () => {
    expect(moveSelection(model, { row: 1, col: 0 }, 0, 1)).toEqual({ row: 1, col: 1 });
    expect(moveSelection(model, { row: 1, col: 1 }, 0, 1)).toEqual({ row: 1, col: 3 });
    expect(moveSelection(model, { row: 1, col: 1 }, 1, 0)).toEqual({ row: 3, col: 1 });
  });

  it('clamps at the sheet edges', () => {
    expect(moveSelection(model, { row: 0, col: 0 }, -1, -1)).toEqual({ row: 0, col: 0 });
    expect(moveSelection(model, { row: 3, col: 3 }, 1, 1)).toEqual({ row: 3, col: 3 });
  });
});

describe('which workbooks a preview offers', () => {
  const file = (name: string, accepted: boolean, hidden: SheetEvidence['hidden'][] = ['visible']): FileParseResult => ({
    outcome: accepted ? 'accepted' : 'rejected',
    identity: { contractVersion: '1.1.0', sheetjsVersion: '0.20.3', sheetjsTarballSha256: 'x', runtime: 'browser_worker' },
    input: { originalFilename: name, sha256: 'a'.repeat(64), byteSize: 1, archiveEntryPath: name },
    workbook: accepted
      ? { format: 'xls', sheets: hidden.map((h, i) => sheetOf([], { index: i, name: `S${i}`, hidden: h })), vbaPresent: false, totals: {} as never }
      : null,
    family: null,
    diagnostics: [],
    sourceRecords: [],
  });

  it('a single workbook is itself; an archive offers its own entries in its own order', () => {
    const one = file('a.xls', true);
    expect(listViewerWorkbooks('file', one)).toEqual([one]);
    const entries = [file('b.xls', false), file('c.xls', true)];
    const archive = { entries } as unknown as ArchiveParseResult;
    expect(listViewerWorkbooks('archive', archive)).toBe(entries);
  });

  it('opens the first readable workbook, on its first visible sheet', () => {
    expect(initialWorkbookIndex([file('b.xls', false), file('c.xls', true)])).toBe(1);
    expect(initialSheetIndex(file('d.xls', true, ['hidden', 'very_hidden', 'visible']))).toBe(2);
    expect(initialSheetIndex(file('e.xls', true, ['hidden']))).toBe(0);
  });
});
