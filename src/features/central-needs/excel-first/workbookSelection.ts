/**
 * E2-A — the Selection Contract.
 *
 * What a HUMAN physically selected in a trusted source workbook, as plain,
 * serializable data. PHYSICAL SELECTION IS NOT BUSINESS SEMANTICS: this file
 * knows batch, batch entry, import session, workbook, sheet, row, column, A1
 * coordinate and rectangle — and nothing about what the selected evidence
 * means. No selection here names a role for a column, a range or a cell, and
 * nothing here reads cell text, header text, file names or sheet names to
 * decide anything; the sheet name is carried only as a label of the physical
 * sheet the human looked at.
 *
 * SOURCE IDENTITY IS SEPARATE FROM GEOMETRY. `source` is the trusted
 * ImportBatchEntry identity that `sourceIdentityBridge.ts` proved for the
 * displayed workbook; the rest is geometry in the parser's own 0-based
 * coordinates (`A1Coordinate`), with `sheetIndex` = `SheetEvidence.index` —
 * so a column selection is compatible with M213's physical column identity
 * `(importSessionId, sheetIndex, columnIndex)`.
 *
 * FAIL CLOSED. Every builder validates its input and returns `null` rather
 * than a selection it cannot vouch for. Nothing here touches React, a
 * service, the network or any storage.
 */
import { a1Address, type GridPoint } from './excelViewerModel';

/** Excel's own ceilings (column XFD, row 1048576), as 0-based indices. */
const MAX_COLUMN_INDEX = 16_383;
const MAX_ROW_INDEX = 1_048_575;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The trusted identity of ONE displayed workbook: exactly one ImportBatchEntry. */
export interface WorkbookSourceIdentity {
  batchId: string;
  entryId: string;
  /** 1-based, as registered by finalize-import. */
  entryOrdinal: number;
  /** Lowercase hex SHA-256 of the entry's exact bytes. */
  entrySha256: string;
  importSessionId: string;
  /** Index of this workbook in the viewer's workbook list (`listViewerWorkbooks`). */
  workbookIndex: number;
}

/** The physical sheet a selection lies on. */
export interface SelectionSheet {
  /** `SheetEvidence.index` — the 0-based native tab position, hidden sheets included. */
  sheetIndex: number;
  /** Carried verbatim as a label; never used to decide anything. */
  sheetName: string;
}

interface SelectionBase extends SelectionSheet {
  source: WorkbookSourceIdentity;
}

export interface CellSelection extends SelectionBase {
  kind: 'cell';
  rowIndex: number;
  columnIndex: number;
  a1: string;
  /**
   * When the grid presents this coordinate as the anchor of a merged region:
   * that region's range, verbatim from `SheetEvidence.mergedRanges`. The
   * selected coordinate is still the anchor — no covered cell is implied.
   */
  mergedRange: string | null;
}

export interface ColumnSelection extends SelectionBase {
  kind: 'column';
  columnIndex: number;
}

export interface RangeSelection extends SelectionBase {
  kind: 'range';
  /** Normalized: startRow <= endRow, startColumn <= endColumn (inclusive). */
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
  a1Range: string;
}

export type WorkbookSelection = CellSelection | ColumnSelection | RangeSelection;

// ---------------------------------------------------------------------------
// Validation (fail closed)
// ---------------------------------------------------------------------------

const isIndex = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

export function isValidSourceIdentity(source: WorkbookSourceIdentity | null | undefined): source is WorkbookSourceIdentity {
  return !!source
    && isNonEmptyString(source.batchId)
    && isNonEmptyString(source.entryId)
    && typeof source.entryOrdinal === 'number' && Number.isInteger(source.entryOrdinal) && source.entryOrdinal >= 1
    && typeof source.entrySha256 === 'string' && SHA256_HEX.test(source.entrySha256)
    && isNonEmptyString(source.importSessionId)
    && isIndex(source.workbookIndex, Number.MAX_SAFE_INTEGER);
}

function validSheet(sheet: SelectionSheet | null | undefined): sheet is SelectionSheet {
  return !!sheet && isIndex(sheet.sheetIndex, Number.MAX_SAFE_INTEGER) && typeof sheet.sheetName === 'string';
}

/** A detached copy, so no caller can mutate a selection through a shared reference. */
function copySource(source: WorkbookSourceIdentity): WorkbookSourceIdentity {
  return {
    batchId: source.batchId,
    entryId: source.entryId,
    entryOrdinal: source.entryOrdinal,
    entrySha256: source.entrySha256,
    importSessionId: source.importSessionId,
    workbookIndex: source.workbookIndex,
  };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function buildCellSelection(
  source: WorkbookSourceIdentity | null,
  sheet: SelectionSheet | null,
  rowIndex: number,
  columnIndex: number,
  mergedRange: string | null = null,
): CellSelection | null {
  if (!isValidSourceIdentity(source) || !validSheet(sheet)) return null;
  if (!isIndex(rowIndex, MAX_ROW_INDEX) || !isIndex(columnIndex, MAX_COLUMN_INDEX)) return null;
  if (mergedRange !== null && !isNonEmptyString(mergedRange)) return null;
  return {
    kind: 'cell',
    source: copySource(source),
    sheetIndex: sheet.sheetIndex,
    sheetName: sheet.sheetName,
    rowIndex,
    columnIndex,
    a1: a1Address(rowIndex, columnIndex),
    mergedRange,
  };
}

export function buildColumnSelection(
  source: WorkbookSourceIdentity | null,
  sheet: SelectionSheet | null,
  columnIndex: number,
): ColumnSelection | null {
  if (!isValidSourceIdentity(source) || !validSheet(sheet)) return null;
  if (!isIndex(columnIndex, MAX_COLUMN_INDEX)) return null;
  return {
    kind: 'column',
    source: copySource(source),
    sheetIndex: sheet.sheetIndex,
    sheetName: sheet.sheetName,
    columnIndex,
  };
}

/** A rectangle between two corners, in either order; normalized so start <= end. */
export function buildRangeSelection(
  source: WorkbookSourceIdentity | null,
  sheet: SelectionSheet | null,
  from: GridPoint,
  to: GridPoint,
): RangeSelection | null {
  if (!isValidSourceIdentity(source) || !validSheet(sheet)) return null;
  if (!from || !to) return null;
  if (!isIndex(from.row, MAX_ROW_INDEX) || !isIndex(to.row, MAX_ROW_INDEX)) return null;
  if (!isIndex(from.col, MAX_COLUMN_INDEX) || !isIndex(to.col, MAX_COLUMN_INDEX)) return null;
  const startRow = Math.min(from.row, to.row);
  const endRow = Math.max(from.row, to.row);
  const startColumn = Math.min(from.col, to.col);
  const endColumn = Math.max(from.col, to.col);
  return {
    kind: 'range',
    source: copySource(source),
    sheetIndex: sheet.sheetIndex,
    sheetName: sheet.sheetName,
    startRow,
    endRow,
    startColumn,
    endColumn,
    a1Range: `${a1Address(startRow, startColumn)}:${a1Address(endRow, endColumn)}`,
  };
}

/** A deterministic identity for a selection (builders emit fields in a fixed order). */
export function selectionKey(selection: WorkbookSelection): string {
  return JSON.stringify(selection);
}

/**
 * The M213-compatible physical column identity of a cell or column selection:
 * `(importSessionId, sheetIndex, columnIndex)`. It identifies a physical
 * column; it says nothing about what that column contains.
 */
export function physicalColumnIdentity(selection: CellSelection | ColumnSelection): {
  importSessionId: string;
  sheetIndex: number;
  columnIndex: number;
} {
  return {
    importSessionId: selection.source.importSessionId,
    sheetIndex: selection.sheetIndex,
    columnIndex: selection.columnIndex,
  };
}

// ---------------------------------------------------------------------------
// From the grid's gesture state to a selection (pure)
// ---------------------------------------------------------------------------

/**
 * What the human's gestures describe, relative to the grid's ACTIVE cell:
 *   cell   — the active cell itself;
 *   column — one physical column (header click, Ctrl+Space);
 *   range  — the rectangle from `anchor` to the active cell (Shift+click, Shift+Arrow).
 */
export type GridSelectionShape =
  | { kind: 'cell' }
  | { kind: 'column'; col: number }
  | { kind: 'range'; anchor: GridPoint };

/** The displayed merged region at a coordinate, if any (`SheetGridModel.mergeAt`). */
export type MergeLookup = (row: number, col: number) => {
  range: string;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
} | undefined;

export interface SelectionRect {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

/**
 * The rectangle a range gesture covers. A corner that lands on a displayed
 * merged region contributes that whole region, so clicking a merged block
 * always means the same rectangle, whichever of its coordinates the pointer hit.
 */
export function rangeBounds(anchor: GridPoint, active: GridPoint, mergeAt: MergeLookup): SelectionRect {
  const a = mergeAt(anchor.row, anchor.col);
  const b = mergeAt(active.row, active.col);
  return {
    startRow: Math.min(a ? a.startRow : anchor.row, b ? b.startRow : active.row),
    endRow: Math.max(a ? a.endRow : anchor.row, b ? b.endRow : active.row),
    startCol: Math.min(a ? a.startCol : anchor.col, b ? b.startCol : active.col),
    endCol: Math.max(a ? a.endCol : anchor.col, b ? b.endCol : active.col),
  };
}

/** The cells the grid highlights for a shape (presentation geometry only). */
export function shapeRect(
  active: GridPoint | null,
  shape: GridSelectionShape,
  mergeAt: MergeLookup,
  rows: { first: number; last: number },
): SelectionRect | null {
  if (shape.kind === 'column') return { startRow: rows.first, endRow: rows.last, startCol: shape.col, endCol: shape.col };
  if (!active) return null;
  if (shape.kind === 'range') return rangeBounds(shape.anchor, active, mergeAt);
  const region = mergeAt(active.row, active.col);
  return region
    ? { startRow: region.startRow, endRow: region.endRow, startCol: region.startCol, endCol: region.endCol }
    : { startRow: active.row, endRow: active.row, startCol: active.col, endCol: active.col };
}

/**
 * The trusted selection for the grid's current gesture state, or null when
 * there is no trusted source identity, no sheet or nothing selected.
 */
export function toWorkbookSelection(
  source: WorkbookSourceIdentity | null,
  sheet: { index: number; name: string } | null | undefined,
  active: GridPoint | null,
  shape: GridSelectionShape,
  mergeAt: MergeLookup,
): WorkbookSelection | null {
  if (!source || !sheet) return null;
  const onSheet: SelectionSheet = { sheetIndex: sheet.index, sheetName: sheet.name };
  if (shape.kind === 'column') return buildColumnSelection(source, onSheet, shape.col);
  if (!active) return null;
  if (shape.kind === 'range') {
    const rect = rangeBounds(shape.anchor, active, mergeAt);
    return buildRangeSelection(source, onSheet, { row: rect.startRow, col: rect.startCol }, { row: rect.endRow, col: rect.endCol });
  }
  const region = mergeAt(active.row, active.col);
  return region
    ? buildCellSelection(source, onSheet, region.startRow, region.startCol, region.range)
    : buildCellSelection(source, onSheet, active.row, active.col, null);
}
