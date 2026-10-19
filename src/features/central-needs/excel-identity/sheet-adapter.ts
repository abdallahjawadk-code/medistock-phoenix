/**
 * R1-A3 — adapts the EXISTING browser parse evidence (one sheet) to the extractor's cell-grid interface WITHOUT materializing it.
 *
 * The grid is lazy: a cell value is read from the evidence only when the extractor asks for that exact (row, column). Since the
 * extractor asks only for the confirmed header row and the identity columns of each data row, the value of every other cell
 * (a quantity column in particular) is never read from the evidence, never copied and never held in a second structure.
 * Indexing the evidence by coordinate touches coordinates only, not values.
 */
import type { SheetCells, CellValue } from './identity-extract';

/** The part of the parser's `SheetEvidence` / `CellEvidence` this adapter needs (structurally compatible). */
export interface EvidenceCellLike {
  coordinate: { row: number; col: number };
  presence: 'missing' | 'blank' | 'value';
  valueType?: string;
  rawValue: string | number | boolean | null;
}
export interface EvidenceSheetLike {
  usedRange: { endRow: number; endCol: number } | null;
  cells: ReadonlyArray<EvidenceCellLike>;
}

const MAX_GRID_COLS = 64;

export function lazySheetCells(sheet: EvidenceSheetLike): SheetCells {
  const byCoord = new Map<number, EvidenceCellLike>();
  let maxRow = sheet.usedRange ? sheet.usedRange.endRow : -1;
  for (const cell of sheet.cells) {                      // coordinates only - values are NOT read here
    const { row, col } = cell.coordinate;
    if (col >= 0 && col < MAX_GRID_COLS) byCoord.set(row * MAX_GRID_COLS + col, cell);
    if (row > maxRow) maxRow = row;
  }
  const rowCount = maxRow + 1;
  const valueOf = (cell: EvidenceCellLike | undefined): CellValue => {
    if (!cell || cell.presence !== 'value' || cell.valueType === 'error') return null;
    return cell.rawValue;
  };
  const makeRow = (r: number): ReadonlyArray<CellValue> =>
    new Proxy(new Array<CellValue>(MAX_GRID_COLS), {
      // `Array.prototype.slice` (used by the extractor on the header row) consults HasProperty first: every in-bound column exists.
      has(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) return Number(key) < MAX_GRID_COLS;
        return Reflect.has(target, key);
      },
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          const c = Number(key);
          return c < MAX_GRID_COLS ? valueOf(byCoord.get(r * MAX_GRID_COLS + c)) : undefined;
        }
        return Reflect.get(target, key, receiver);
      },
    });
  return new Proxy(new Array<ReadonlyArray<CellValue>>(rowCount), {
    has(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) return Number(key) < rowCount;
      return Reflect.has(target, key);
    },
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        const r = Number(key);
        return r < rowCount ? makeRow(r) : undefined;
      }
      return Reflect.get(target, key, receiver);
    },
  });
}
