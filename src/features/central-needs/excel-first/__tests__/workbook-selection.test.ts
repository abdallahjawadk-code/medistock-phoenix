/**
 * E2-A.1 — the Selection Contract, pure.
 *
 * Physical selection only: every selection carries the exact trusted source
 * identity it was given and geometry in the parser's own 0-based coordinates,
 * and nothing else — no role, no meaning, no label of what the evidence is.
 * Invalid input fails closed (null), never a "best effort" selection.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCellSelection,
  buildColumnSelection,
  buildRangeSelection,
  isValidSourceIdentity,
  physicalColumnIdentity,
  rangeBounds,
  selectionKey,
  shapeRect,
  toWorkbookSelection,
  type MergeLookup,
  type WorkbookSourceIdentity,
} from '../workbookSelection';

const SOURCE: WorkbookSourceIdentity = {
  batchId: 'batch-1',
  entryId: 'entry-1',
  entryOrdinal: 1,
  entrySha256: 'a'.repeat(64),
  importSessionId: 'session-1',
  workbookIndex: 0,
};
const SHEET = { sheetIndex: 2, sheetName: 'مخفية' };
const NO_MERGES: MergeLookup = () => undefined;

const CELL_KEYS = ['a1', 'columnIndex', 'kind', 'mergedRange', 'rowIndex', 'sheetIndex', 'sheetName', 'source'];
const COLUMN_KEYS = ['columnIndex', 'kind', 'sheetIndex', 'sheetName', 'source'];
const RANGE_KEYS = ['a1Range', 'endColumn', 'endRow', 'kind', 'sheetIndex', 'sheetName', 'source', 'startColumn', 'startRow'];
const SOURCE_KEYS = ['batchId', 'entryId', 'entryOrdinal', 'entrySha256', 'importSessionId', 'workbookIndex'];

describe('E2-A.1 — cell selection', () => {
  it('carries the exact source identity, sheet, 0-based row/column and A1 — and nothing else', () => {
    const cell = buildCellSelection(SOURCE, SHEET, 1, 2);
    expect(cell).toEqual({
      kind: 'cell', source: SOURCE, sheetIndex: 2, sheetName: 'مخفية', rowIndex: 1, columnIndex: 2, a1: 'C2', mergedRange: null,
    });
    expect(Object.keys(cell!).sort()).toEqual(CELL_KEYS);
    expect(Object.keys(cell!.source).sort()).toEqual(SOURCE_KEYS);
  });

  it('computes A1 exactly, including multi-letter columns and Excel\'s last cell', () => {
    expect(buildCellSelection(SOURCE, SHEET, 0, 0)?.a1).toBe('A1');
    expect(buildCellSelection(SOURCE, SHEET, 9, 25)?.a1).toBe('Z10');
    expect(buildCellSelection(SOURCE, SHEET, 0, 26)?.a1).toBe('AA1');
    expect(buildCellSelection(SOURCE, SHEET, 99, 27)?.a1).toBe('AB100');
    expect(buildCellSelection(SOURCE, SHEET, 1_048_575, 16_383)?.a1).toBe('XFD1048576');
  });

  it('records a merged anchor by its verbatim range, still at the anchor coordinate', () => {
    expect(buildCellSelection(SOURCE, SHEET, 4, 0, 'A5:C5')).toMatchObject({ a1: 'A5', rowIndex: 4, columnIndex: 0, mergedRange: 'A5:C5' });
  });

  it('holds a detached copy of the identity: mutating the input never changes a selection', () => {
    const source = { ...SOURCE };
    const cell = buildCellSelection(source, SHEET, 0, 0)!;
    source.importSessionId = 'tampered';
    expect(cell.source.importSessionId).toBe('session-1');
    expect(cell.source).not.toBe(source);
  });
});

describe('E2-A.1 — column selection', () => {
  it('is one physical column of one sheet, with no role attached', () => {
    const column = buildColumnSelection(SOURCE, SHEET, 3);
    expect(column).toEqual({ kind: 'column', source: SOURCE, sheetIndex: 2, sheetName: 'مخفية', columnIndex: 3 });
    expect(Object.keys(column!).sort()).toEqual(COLUMN_KEYS);
  });

  it('exposes the M213 physical column identity (importSessionId, sheetIndex, columnIndex) — nothing more', () => {
    const column = buildColumnSelection(SOURCE, SHEET, 3)!;
    expect(physicalColumnIdentity(column)).toEqual({ importSessionId: 'session-1', sheetIndex: 2, columnIndex: 3 });
    expect(physicalColumnIdentity(buildCellSelection(SOURCE, SHEET, 7, 3)!)).toEqual({ importSessionId: 'session-1', sheetIndex: 2, columnIndex: 3 });
  });
});

describe('E2-A.1 — range selection', () => {
  it('a forward range keeps its corners', () => {
    const range = buildRangeSelection(SOURCE, SHEET, { row: 1, col: 1 }, { row: 3, col: 3 });
    expect(range).toEqual({
      kind: 'range', source: SOURCE, sheetIndex: 2, sheetName: 'مخفية',
      startRow: 1, endRow: 3, startColumn: 1, endColumn: 3, a1Range: 'B2:D4',
    });
    expect(Object.keys(range!).sort()).toEqual(RANGE_KEYS);
  });

  it('a reverse range (and each mixed direction) normalizes to the same rectangle', () => {
    const expected = buildRangeSelection(SOURCE, SHEET, { row: 1, col: 1 }, { row: 3, col: 3 });
    expect(buildRangeSelection(SOURCE, SHEET, { row: 3, col: 3 }, { row: 1, col: 1 })).toEqual(expected);
    expect(buildRangeSelection(SOURCE, SHEET, { row: 3, col: 1 }, { row: 1, col: 3 })).toEqual(expected);
    expect(buildRangeSelection(SOURCE, SHEET, { row: 1, col: 3 }, { row: 3, col: 1 })).toEqual(expected);
  });
});

describe('E2-A.1 — invalid input fails closed', () => {
  it.each([
    ['negative row', () => buildCellSelection(SOURCE, SHEET, -1, 0)],
    ['negative column', () => buildCellSelection(SOURCE, SHEET, 0, -1)],
    ['fractional row', () => buildCellSelection(SOURCE, SHEET, 1.5, 0)],
    ['NaN column', () => buildCellSelection(SOURCE, SHEET, 0, Number.NaN)],
    ['row beyond Excel', () => buildCellSelection(SOURCE, SHEET, 1_048_576, 0)],
    ['column beyond XFD', () => buildColumnSelection(SOURCE, SHEET, 16_384)],
    ['range corner out of bounds', () => buildRangeSelection(SOURCE, SHEET, { row: 0, col: 0 }, { row: -1, col: 2 })],
    ['negative sheet index', () => buildCellSelection(SOURCE, { sheetIndex: -1, sheetName: 'x' }, 0, 0)],
    ['empty merged range', () => buildCellSelection(SOURCE, SHEET, 0, 0, '')],
    ['no source', () => buildColumnSelection(null, SHEET, 0)],
    ['no sheet', () => buildColumnSelection(SOURCE, null, 0)],
  ])('%s → null', (_label, build) => {
    expect(build()).toBeNull();
  });

  it.each([
    ['empty batch id', { batchId: '' }],
    ['empty entry id', { entryId: ' ' }],
    ['ordinal 0', { entryOrdinal: 0 }],
    ['fractional ordinal', { entryOrdinal: 1.5 }],
    ['non-hex SHA', { entrySha256: 'z'.repeat(64) }],
    ['short SHA', { entrySha256: 'a'.repeat(63) }],
    ['upper-case SHA (identities are normalized lowercase)', { entrySha256: 'A'.repeat(64) }],
    ['empty import session', { importSessionId: '' }],
    ['negative workbook index', { workbookIndex: -1 }],
  ])('an invalid source identity (%s) → no selection at all', (_label, over) => {
    const source = { ...SOURCE, ...over } as WorkbookSourceIdentity;
    expect(isValidSourceIdentity(source)).toBe(false);
    expect(buildCellSelection(source, SHEET, 0, 0)).toBeNull();
    expect(buildColumnSelection(source, SHEET, 0)).toBeNull();
    expect(buildRangeSelection(source, SHEET, { row: 0, col: 0 }, { row: 1, col: 1 })).toBeNull();
  });
});

describe('E2-A.1 — plain serializable data', () => {
  it('round-trips through JSON unchanged and holds no function, class or React state', () => {
    for (const selection of [
      buildCellSelection(SOURCE, SHEET, 1, 2, 'C2:D3'),
      buildColumnSelection(SOURCE, SHEET, 3),
      buildRangeSelection(SOURCE, SHEET, { row: 5, col: 4 }, { row: 0, col: 0 }),
    ]) {
      expect(JSON.parse(JSON.stringify(selection))).toEqual(selection);
      expect(Object.getPrototypeOf(selection)).toBe(Object.prototype);
      expect(Object.values(selection!).some((v) => typeof v === 'function')).toBe(false);
    }
  });

  it('selectionKey is deterministic and distinguishes different selections', () => {
    expect(selectionKey(buildCellSelection(SOURCE, SHEET, 1, 2)!)).toBe(selectionKey(buildCellSelection({ ...SOURCE }, { ...SHEET }, 1, 2)!));
    expect(selectionKey(buildCellSelection(SOURCE, SHEET, 1, 2)!)).not.toBe(selectionKey(buildCellSelection(SOURCE, SHEET, 2, 1)!));
    expect(selectionKey(buildColumnSelection(SOURCE, SHEET, 2)!))
      .not.toBe(selectionKey(buildColumnSelection({ ...SOURCE, importSessionId: 'session-2' }, SHEET, 2)!));
  });
});

describe('E2-A.1 — from grid gestures to a selection (merges resolved deterministically)', () => {
  const merge = { range: 'A5:C5', startRow: 4, endRow: 4, startCol: 0, endCol: 2 };
  const mergeAt: MergeLookup = (row, col) => (row === 4 && col >= 0 && col <= 2 ? merge : undefined);
  const sheet = { index: 0, name: 'المجرد' };

  it('a merged block resolves to its anchor, labelled with its range — no covered cell is selected', () => {
    expect(toWorkbookSelection(SOURCE, sheet, { row: 4, col: 0 }, { kind: 'cell' }, mergeAt))
      .toMatchObject({ kind: 'cell', a1: 'A5', rowIndex: 4, columnIndex: 0, mergedRange: 'A5:C5' });
  });

  it('a range whose corner is a merged block covers the whole block, whichever corner is the anchor', () => {
    const down = toWorkbookSelection(SOURCE, sheet, { row: 4, col: 0 }, { kind: 'range', anchor: { row: 1, col: 0 } }, mergeAt);
    const up = toWorkbookSelection(SOURCE, sheet, { row: 1, col: 0 }, { kind: 'range', anchor: { row: 4, col: 0 } }, mergeAt);
    expect(down).toMatchObject({ kind: 'range', startRow: 1, endRow: 4, startColumn: 0, endColumn: 2, a1Range: 'A2:C5' });
    expect(up).toEqual(down);
    expect(rangeBounds({ row: 1, col: 0 }, { row: 4, col: 1 }, mergeAt)).toEqual({ startRow: 1, endRow: 4, startCol: 0, endCol: 2 });
  });

  it('a column is the column, wherever the active cell is', () => {
    expect(toWorkbookSelection(SOURCE, sheet, { row: 9, col: 9 }, { kind: 'column', col: 1 }, NO_MERGES))
      .toEqual(buildColumnSelection(SOURCE, { sheetIndex: 0, sheetName: 'المجرد' }, 1));
    expect(shapeRect(null, { kind: 'column', col: 1 }, NO_MERGES, { first: 0, last: 9 }))
      .toEqual({ startRow: 0, endRow: 9, startCol: 1, endCol: 1 });
  });

  it('without a trusted identity, a sheet or an active cell there is no selection', () => {
    expect(toWorkbookSelection(null, sheet, { row: 0, col: 0 }, { kind: 'cell' }, NO_MERGES)).toBeNull();
    expect(toWorkbookSelection(SOURCE, undefined, { row: 0, col: 0 }, { kind: 'cell' }, NO_MERGES)).toBeNull();
    expect(toWorkbookSelection(SOURCE, sheet, null, { kind: 'cell' }, NO_MERGES)).toBeNull();
    expect(toWorkbookSelection(SOURCE, sheet, null, { kind: 'range', anchor: { row: 0, col: 0 } }, NO_MERGES)).toBeNull();
  });
});
