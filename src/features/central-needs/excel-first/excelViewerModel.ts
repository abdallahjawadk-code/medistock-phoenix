/**
 * E1 — Excel-First: the pure presentation model behind the read-only
 * original-workbook viewer.
 *
 * ONE PARSE, ONE EVIDENCE MODEL, MANY PRESENTATIONS. Everything here is
 * derived from the CN-2A parser's existing evidence (`../import/contract.ts`)
 * exactly as the browser preview already produced it. Nothing in this file
 * parses a workbook, and it never imports a spreadsheet library: the A1
 * helpers below are a few lines of string arithmetic, so the parser-neutral
 * boundary `contract.ts` documents stays intact.
 *
 * What this model will never do:
 *  - create evidence: a coordinate the parser did not emit stays `undefined`
 *    (MISSING), which is not an explicit blank, which is not a numeric zero;
 *  - copy a merged region's value into the coordinates it covers — the region
 *    is presented once, carrying only its top-left anchor's own evidence;
 *  - mutate the evidence it is handed;
 *  - evaluate a formula, or infer any business meaning from a cell.
 */
import type {
  ArchiveParseResult,
  CellEvidence,
  FileParseResult,
  SheetEvidence,
} from '../import/contract.ts';

// ---------------------------------------------------------------------------
// A1 coordinates (pure string arithmetic — no spreadsheet library)
// ---------------------------------------------------------------------------

/** Excel's own ceilings (column XFD, row 1048576), as 0-based indices. */
const MAX_COLUMN_INDEX = 16_383;
const MAX_ROW_INDEX = 1_048_575;

export interface GridPoint {
  /** 0-based, exactly as `A1Coordinate.row`. */
  row: number;
  /** 0-based, exactly as `A1Coordinate.col`. */
  col: number;
}

/** 0 → "A", 25 → "Z", 26 → "AA". Never reversed, whatever the page direction. */
export function columnLetters(col: number): string {
  if (!Number.isInteger(col) || col < 0 || col > MAX_COLUMN_INDEX) {
    throw new RangeError(`column index out of range: ${col}`);
  }
  let n = col + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

export function a1Address(row: number, col: number): string {
  return `${columnLetters(col)}${row + 1}`;
}

const A1_CELL = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/;

export function parseA1Cell(text: string): GridPoint | null {
  const match = A1_CELL.exec(text);
  if (!match) return null;
  let col = 0;
  for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  col -= 1;
  const row = Number(match[2]) - 1;
  if (col > MAX_COLUMN_INDEX || row > MAX_ROW_INDEX) return null;
  return { row, col };
}

/** A merged range from `SheetEvidence.mergedRanges`, decoded. `range` is kept verbatim. */
export interface MergedRegion {
  range: string;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export function parseA1Range(text: string): MergedRegion | null {
  const parts = text.split(':');
  if (parts.length < 1 || parts.length > 2) return null;
  const a = parseA1Cell(parts[0]);
  const b = parts.length === 2 ? parseA1Cell(parts[1]) : a;
  if (!a || !b) return null;
  return {
    range: text,
    startRow: Math.min(a.row, b.row),
    endRow: Math.max(a.row, b.row),
    startCol: Math.min(a.col, b.col),
    endCol: Math.max(a.col, b.col),
  };
}

export function regionContains(region: MergedRegion, row: number, col: number): boolean {
  return row >= region.startRow && row <= region.endRow && col >= region.startCol && col <= region.endCol;
}

// ---------------------------------------------------------------------------
// What a cell shows in the grid (presentation only — never a business value)
// ---------------------------------------------------------------------------

/** The raw value as plain text. `null` is the empty string; booleans use Excel's own words. */
export function rawValueText(value: CellEvidence['rawValue']): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

/**
 * The text a grid cell shows. The inspector always shows the raw evidence
 * beside it; this is only what the eye sees in the sheet.
 *
 *  - missing coordinate and explicit blank show nothing (they remain
 *    distinguishable through `data-presence` and the inspector);
 *  - an error cell shows its own error code;
 *  - otherwise the workbook's formatted text, when it has visible content —
 *    this is what Excel itself displays (a date, a percentage);
 *  - otherwise the raw value. A number format that renders zero as nothing
 *    therefore still shows "0": a numeric zero is never made to look blank.
 */
export function cellDisplayText(cell: CellEvidence | undefined): string {
  if (!cell || cell.presence !== 'value') return '';
  if (cell.valueType === 'error') return cell.errorCode ?? rawValueText(cell.rawValue);
  if (typeof cell.formattedText === 'string' && cell.formattedText.trim() !== '') return cell.formattedText;
  return rawValueText(cell.rawValue);
}

// ---------------------------------------------------------------------------
// The sheet as a grid
// ---------------------------------------------------------------------------

/**
 * The rectangle the grid draws, in absolute sheet coordinates. It starts at
 * A1 like Excel does, unless the used range begins implausibly far away — a
 * hostile or oddly-saved file must not turn into a million empty rows.
 */
export interface GridExtent {
  originRow: number;
  originCol: number;
  rowCount: number;
  colCount: number;
}

const ORIGIN_ROW_SLACK = 1_000;
const ORIGIN_COL_SLACK = 100;

export function sheetGridExtent(sheet: SheetEvidence): GridExtent | null {
  let minRow = Infinity;
  let maxRow = -Infinity;
  let minCol = Infinity;
  let maxCol = -Infinity;
  const include = (row: number, col: number) => {
    if (row < minRow) minRow = row;
    if (row > maxRow) maxRow = row;
    if (col < minCol) minCol = col;
    if (col > maxCol) maxCol = col;
  };
  if (sheet.usedRange) {
    include(sheet.usedRange.startRow, sheet.usedRange.startCol);
    include(sheet.usedRange.endRow, sheet.usedRange.endCol);
  }
  // The contract keeps every cell inside the used range; this only guarantees
  // that no emitted cell could ever fall outside what the grid draws.
  for (const cell of sheet.cells) include(cell.coordinate.row, cell.coordinate.col);
  if (maxRow < 0 || maxCol < 0) return null;
  const originRow = minRow > ORIGIN_ROW_SLACK ? minRow : 0;
  const originCol = minCol > ORIGIN_COL_SLACK ? minCol : 0;
  return { originRow, originCol, rowCount: maxRow - originRow + 1, colCount: maxCol - originCol + 1 };
}

/**
 * Viewer-only merge hardening. The source `sheet.mergedRanges` array remains
 * untouched and authoritative evidence; these counters only describe what the
 * bounded presentation model could safely materialise.
 */
export interface MergeSafetySummary {
  sourceMergeCount: number;
  processedMergeCount: number;
  renderableMergeCount: number;
  unprocessedMergeCount: number;
  duplicateMergeCount: number;
  overlappingMergeCount: number;
  unparsedMergeCount: number;
  /**
   * Decodable ranges lying wholly outside the drawn used range: they cover no
   * cell the parser emitted, so there is nothing to draw — but they are
   * counted and disclosed, never dropped silently. Not a safety suppression.
   */
  outOfExtentMergeCount: number;
  safetySuppressedMergeCount: number;
  limited: boolean;
  /**
   * Deterministic count of the primitive steps merge intake took (bucket
   * lookups, bucket-list entries visited, rectangle tests). It makes the
   * intake bound observable independently of machine speed or load.
   */
  intakeWorkUnits: number;
  /** Why intake ended: every range reached, the range-count ceiling, or the work budget. */
  intakeStoppedBy: 'complete' | 'merge-limit' | 'work-budget';
}

export interface SheetGridModel {
  readonly sheet: SheetEvidence;
  /** null for a sheet with nothing to draw (no used range and no cells). */
  readonly extent: GridExtent | null;
  /** Safe, decoded, non-overlapping merges, in source order. */
  readonly merges: readonly MergedRegion[];
  /** Merge strings that could not be decoded inside the bounded intake. */
  readonly unparsedMergedRanges: readonly string[];
  /** Exact presentation-only accounting; source evidence is never mutated. */
  readonly mergeSafety: MergeSafetySummary;
  /** The parser's own evidence at this coordinate, or undefined when it emitted none. */
  cellAt(row: number, col: number): CellEvidence | undefined;
  /** The safe displayed merged region containing this coordinate, if any. */
  mergeAt(row: number, col: number): MergedRegion | undefined;
  /** Safe displayed merges touching this mounted window, in source order. */
  mergesInWindow(window: GridWindow): readonly MergedRegion[];
}

/**
 * Hard viewer ceilings. These do NOT alter parser evidence. They bound only
 * the amount of untrusted merge geometry the presentation layer will index or
 * synchronously inspect. Anything beyond a ceiling is disclosed as limited.
 */
export const MERGE_PROCESS_LIMIT = 10_000;
/**
 * Hard ceiling on merge-intake work (the deterministic `intakeWorkUnits`
 * counter). Geometry can make individual overlap probes costly, so intake
 * also stops — deterministically, between ranges — once this much work has
 * been spent; every range not reached is counted as unprocessed and disclosed.
 * The heaviest legitimate cases measured (10 000 non-overlapping merges) use
 * under 3 000 000 units; the real corpus uses a few thousand.
 */
export const MERGE_INTAKE_WORK_BUDGET = 5_000_000;
export const MERGE_INSPECT_SCAN_LIMIT = 4_096;
export const MERGE_HIDDEN_VALUE_DISPLAY_LIMIT = 10;
const MERGE_BUCKET_ROWS = 32;
const MERGE_BUCKET_COLS = 16;
/** Numeric bucket-key stride: Excel's 16 384 columns / 16 = 1 024 column buckets. */
const BUCKET_KEY_STRIDE = 1_024;

/** Wider than any legal column index, so `row * stride + col` is collision-free. */
const KEY_STRIDE = MAX_COLUMN_INDEX + 1;

export function coordinateKey(row: number, col: number): number {
  return row * KEY_STRIDE + col;
}

interface RectangleLike {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

function rectanglesOverlap(a: RectangleLike, b: RectangleLike): boolean {
  return a.endRow >= b.startRow && a.startRow <= b.endRow
    && a.endCol >= b.startCol && a.startCol <= b.endCol;
}

/** The spatial buckets a rectangle touches, clipped to the drawn extent. */
interface BucketSpan {
  firstRowBucket: number;
  lastRowBucket: number;
  firstColBucket: number;
  lastColBucket: number;
  count: number;
}

function bucketSpanForRect(rect: RectangleLike, extent: GridExtent): BucketSpan | null {
  const lastRow = extent.originRow + extent.rowCount - 1;
  const lastCol = extent.originCol + extent.colCount - 1;
  const startRow = Math.max(rect.startRow, extent.originRow);
  const endRow = Math.min(rect.endRow, lastRow);
  const startCol = Math.max(rect.startCol, extent.originCol);
  const endCol = Math.min(rect.endCol, lastCol);
  if (startRow > endRow || startCol > endCol) return null;
  const firstRowBucket = Math.floor(startRow / MERGE_BUCKET_ROWS);
  const lastRowBucket = Math.floor(endRow / MERGE_BUCKET_ROWS);
  const firstColBucket = Math.floor(startCol / MERGE_BUCKET_COLS);
  const lastColBucket = Math.floor(endCol / MERGE_BUCKET_COLS);
  return {
    firstRowBucket, lastRowBucket, firstColBucket, lastColBucket,
    count: (lastRowBucket - firstRowBucket + 1) * (lastColBucket - firstColBucket + 1),
  };
}

export function buildSheetGridModel(sheet: SheetEvidence): SheetGridModel {
  const byKey = new Map<number, CellEvidence>();
  for (const cell of sheet.cells) byKey.set(coordinateKey(cell.coordinate.row, cell.coordinate.col), cell);

  const extent = sheetGridExtent(sheet);
  const merges: MergedRegion[] = [];
  const unparsedMergedRanges: string[] = [];
  const buckets = new Map<number, number[]>();
  const seenGeometry = new Set<string>();
  let duplicateMergeCount = 0;
  let overlappingMergeCount = 0;
  let outOfExtentMergeCount = 0;
  let workUnits = 0;
  const intakeLimit = Math.min(sheet.mergedRanges.length, MERGE_PROCESS_LIMIT);
  let processedMergeCount = 0;

  /**
   * Indices (ascending = source order) of accepted merges that overlap `rect`.
   * Two strategies, chosen by cost, with identical results:
   *   - the rectangle touches more buckets than there are accepted merges →
   *     test the accepted merges directly (cost = accepted count);
   *   - otherwise → visit only the touched buckets (cost = touched buckets +
   *     their entries; since displayed merges never overlap, each entry is a
   *     distinct cell of a touched bucket, so at most 512 per bucket).
   * Either way a probe costs at most min(touched buckets, accepted merges)
   * lookups plus entries — never a walk over every bucket of a huge range
   * when few merges exist, which is what made hostile intake take seconds.
   */
  const overlappingIndices = (rect: RectangleLike, firstOnly = false): number[] => {
    if (!extent) return [];
    const span = bucketSpanForRect(rect, extent);
    if (!span) return [];
    const out: number[] = [];
    if (span.count > merges.length) {
      for (let index = 0; index < merges.length; index += 1) {
        workUnits += 1;
        if (!rectanglesOverlap(merges[index], rect)) continue;
        out.push(index);
        if (firstOnly) return out;
      }
      return out;
    }
    const seen = new Set<number>();
    for (let rb = span.firstRowBucket; rb <= span.lastRowBucket; rb += 1) {
      for (let cb = span.firstColBucket; cb <= span.lastColBucket; cb += 1) {
        workUnits += 1;
        const list = buckets.get(rb * BUCKET_KEY_STRIDE + cb);
        if (!list) continue;
        for (const index of list) {
          workUnits += 1;
          if (seen.has(index)) continue;
          seen.add(index);
          if (!rectanglesOverlap(merges[index], rect)) continue;
          out.push(index);
          if (firstOnly) return out;
        }
      }
    }
    out.sort((a, b) => a - b);
    return out;
  };

  for (let i = 0; i < intakeLimit; i += 1) {
    // Deterministic stop: the counter depends only on the input, so the same
    // file always stops at the same range. The unreached tail is disclosed.
    if (workUnits >= MERGE_INTAKE_WORK_BUDGET) break;
    processedMergeCount = i + 1;
    workUnits += 1;
    const text = sheet.mergedRanges[i];
    const region = parseA1Range(text);
    if (!region) {
      unparsedMergedRanges.push(text);
      continue;
    }
    if (!extent || !intersectsExtent(region, extent)) {
      outOfExtentMergeCount += 1;
      continue;
    }

    const geometry = `${region.startRow}:${region.startCol}:${region.endRow}:${region.endCol}`;
    if (seenGeometry.has(geometry)) {
      duplicateMergeCount += 1;
      continue;
    }
    seenGeometry.add(geometry);

    // Intake only needs "overlaps anything already displayed?" — stop at the first hit.
    if (overlappingIndices(region, true).length > 0) {
      overlappingMergeCount += 1;
      continue;
    }

    const index = merges.length;
    merges.push(region);
    const span = bucketSpanForRect(region, extent);
    if (!span) continue;
    for (let rb = span.firstRowBucket; rb <= span.lastRowBucket; rb += 1) {
      for (let cb = span.firstColBucket; cb <= span.lastColBucket; cb += 1) {
        workUnits += 1;
        const key = rb * BUCKET_KEY_STRIDE + cb;
        const list = buckets.get(key);
        if (list) list.push(index);
        else buckets.set(key, [index]);
      }
    }
  }

  const unprocessedMergeCount = Math.max(0, sheet.mergedRanges.length - processedMergeCount);
  const safetySuppressedMergeCount = unprocessedMergeCount + duplicateMergeCount
    + overlappingMergeCount + unparsedMergedRanges.length;
  const mergeSafety: MergeSafetySummary = {
    sourceMergeCount: sheet.mergedRanges.length,
    processedMergeCount,
    renderableMergeCount: merges.length,
    unprocessedMergeCount,
    duplicateMergeCount,
    overlappingMergeCount,
    unparsedMergeCount: unparsedMergedRanges.length,
    outOfExtentMergeCount,
    safetySuppressedMergeCount,
    limited: safetySuppressedMergeCount > 0,
    intakeWorkUnits: workUnits,
    intakeStoppedBy: processedMergeCount === sheet.mergedRanges.length
      ? 'complete'
      : processedMergeCount < intakeLimit ? 'work-budget' : 'merge-limit',
  };

  const mergesForRect = (rect: RectangleLike): readonly MergedRegion[] =>
    overlappingIndices(rect).map((index) => merges[index]);

  return {
    sheet,
    extent,
    merges,
    unparsedMergedRanges,
    mergeSafety,
    cellAt: (row, col) => byKey.get(coordinateKey(row, col)),
    mergeAt: (row, col) => mergesForRect({ startRow: row, endRow: row, startCol: col, endCol: col })[0],
    mergesInWindow: (window) => mergesForRect({
      startRow: window.firstRow,
      endRow: window.lastRow,
      startCol: window.firstCol,
      endCol: window.lastCol,
    }),
  };
}

function intersectsExtent(region: MergedRegion, extent: GridExtent): boolean {
  const lastRow = extent.originRow + extent.rowCount - 1;
  const lastCol = extent.originCol + extent.colCount - 1;
  return region.endRow >= extent.originRow && region.startRow <= lastRow
    && region.endCol >= extent.originCol && region.startCol <= lastCol;
}

/**
 * Cells inside a merged region other than its anchor that still carry their
 * own VALUE in the file. Excel does not show them; the viewer discloses them
 * instead of pretending they do not exist. Bounded: at most `limit` returned.
 */
export interface HiddenMergeValues {
  /** First few hidden values, in the parser contract's row-major evidence order. */
  cells: CellEvidence[];
  /** Exact only when `scanComplete`; null means deliberately not estimated. */
  total: number | null;
  scanComplete: boolean;
  scannedEvidenceCount: number;
}

export function hiddenValuesInMerge(
  model: SheetGridModel,
  region: MergedRegion,
  limit = MERGE_HIDDEN_VALUE_DISPLAY_LIMIT,
  scanLimit = MERGE_INSPECT_SCAN_LIMIT,
): HiddenMergeValues {
  const found: CellEvidence[] = [];
  let exactTotal = 0;
  let scannedEvidenceCount = 0;
  const cells = model.sheet.cells;

  // `SheetEvidence.cells` is contractually row-major. Binary-search directly to
  // the first possibly relevant row so a late huge merge never pays for every
  // earlier cell in the worksheet.
  let lo = 0;
  let hi = cells.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (cells[mid].coordinate.row < region.startRow) lo = mid + 1;
    else hi = mid;
  }

  let index = lo;
  for (; index < cells.length && scannedEvidenceCount < scanLimit; index += 1) {
    const cell = cells[index];
    if (cell.coordinate.row > region.endRow) break;
    scannedEvidenceCount += 1;
    if (cell.coordinate.col < region.startCol || cell.coordinate.col > region.endCol) continue;
    if (cell.presence !== 'value') continue;
    if (cell.coordinate.row === region.startRow && cell.coordinate.col === region.startCol) continue;
    exactTotal += 1;
    if (found.length < limit) found.push(cell);
  }

  const scanComplete = index >= cells.length || cells[index]?.coordinate.row > region.endRow;
  return {
    cells: found,
    total: scanComplete ? exactTotal : null,
    scanComplete,
    scannedEvidenceCount,
  };
}

// ---------------------------------------------------------------------------
// Bounded rendering window (manual 2-D virtualization, no dependency)
// ---------------------------------------------------------------------------

export const GRID_ROW_HEIGHT = 28;
export const GRID_COL_WIDTH = 124;
export const GRID_HEADER_HEIGHT = 28;
export const GRID_ROW_HEADER_WIDTH = 56;
const OVERSCAN_ROWS = 6;
const OVERSCAN_COLS = 2;
/** Hard ceilings: no viewport, however large, can mount more than this many cells. */
export const GRID_MAX_WINDOW_ROWS = 100;
export const GRID_MAX_WINDOW_COLS = 30;
export const GRID_MAX_RENDERED_CELLS = GRID_MAX_WINDOW_ROWS * GRID_MAX_WINDOW_COLS;
/** Used when the scroll container cannot be measured (e.g. before layout). */
const FALLBACK_VIEWPORT = { width: 960, height: 480 };

/** Absolute, inclusive sheet indices of what is mounted. */
export interface GridWindow {
  firstRow: number;
  lastRow: number;
  firstCol: number;
  lastCol: number;
}

export interface ScrollState {
  top: number;
  left: number;
  width: number;
  height: number;
}

function axisWindow(offset: number, viewport: number, header: number, size: number, count: number,
  overscan: number, maxWindow: number): [number, number] {
  const firstVisible = Math.min(Math.max(0, Math.floor(Math.max(0, offset) / size)), Math.max(0, count - 1));
  const visible = Math.min(Math.ceil(Math.max(0, viewport - header) / size) + 1, maxWindow - 2 * overscan);
  const first = Math.max(0, firstVisible - overscan);
  const last = Math.min(count - 1, firstVisible + visible + overscan - 1);
  return [first, last];
}

export function computeGridWindow(extent: GridExtent, scroll: ScrollState): GridWindow {
  const width = scroll.width > 0 ? scroll.width : FALLBACK_VIEWPORT.width;
  const height = scroll.height > 0 ? scroll.height : FALLBACK_VIEWPORT.height;
  const [r0, r1] = axisWindow(scroll.top, height, GRID_HEADER_HEIGHT, GRID_ROW_HEIGHT, extent.rowCount,
    OVERSCAN_ROWS, GRID_MAX_WINDOW_ROWS);
  const [c0, c1] = axisWindow(scroll.left, width, GRID_ROW_HEADER_WIDTH, GRID_COL_WIDTH, extent.colCount,
    OVERSCAN_COLS, GRID_MAX_WINDOW_COLS);
  return {
    firstRow: extent.originRow + r0,
    lastRow: extent.originRow + r1,
    firstCol: extent.originCol + c0,
    lastCol: extent.originCol + c1,
  };
}

export function sameWindow(a: GridWindow, b: GridWindow): boolean {
  return a.firstRow === b.firstRow && a.lastRow === b.lastRow && a.firstCol === b.firstCol && a.lastCol === b.lastCol;
}

/** The scroll offsets that bring `point` fully into view, changing as little as possible. */
export function scrollToReveal(extent: GridExtent, point: GridPoint, scroll: ScrollState): { top: number; left: number } {
  const width = scroll.width > 0 ? scroll.width : FALLBACK_VIEWPORT.width;
  const height = scroll.height > 0 ? scroll.height : FALLBACK_VIEWPORT.height;
  const cellTop = (point.row - extent.originRow) * GRID_ROW_HEIGHT;
  const cellLeft = (point.col - extent.originCol) * GRID_COL_WIDTH;
  const bodyHeight = Math.max(GRID_ROW_HEIGHT, height - GRID_HEADER_HEIGHT);
  const bodyWidth = Math.max(GRID_COL_WIDTH, width - GRID_ROW_HEADER_WIDTH);
  let top = scroll.top;
  let left = scroll.left;
  if (cellTop < top) top = cellTop;
  else if (cellTop + GRID_ROW_HEIGHT > top + bodyHeight) top = cellTop + GRID_ROW_HEIGHT - bodyHeight;
  if (cellLeft < left) left = cellLeft;
  else if (cellLeft + GRID_COL_WIDTH > left + bodyWidth) left = cellLeft + GRID_COL_WIDTH - bodyWidth;
  return { top: Math.max(0, top), left: Math.max(0, left) };
}

/**
 * Keyboard movement. A merged region is one stop: stepping out of it leaves
 * from its far edge, and stepping into it lands on its anchor — the only
 * coordinate in the region the grid presents.
 */
export function moveSelection(model: SheetGridModel, from: GridPoint | null, dRow: number, dCol: number): GridPoint | null {
  const extent = model.extent;
  if (!extent) return null;
  const lastRow = extent.originRow + extent.rowCount - 1;
  const lastCol = extent.originCol + extent.colCount - 1;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  if (!from) return snapToAnchor(model, { row: extent.originRow, col: extent.originCol });

  const here = model.mergeAt(from.row, from.col);
  let row = from.row;
  let col = from.col;
  if (dRow > 0) row = (here ? here.endRow : from.row) + dRow;
  else if (dRow < 0) row = (here ? here.startRow : from.row) + dRow;
  if (dCol > 0) col = (here ? here.endCol : from.col) + dCol;
  else if (dCol < 0) col = (here ? here.startCol : from.col) + dCol;
  return snapToAnchor(model, { row: clamp(row, extent.originRow, lastRow), col: clamp(col, extent.originCol, lastCol) });
}

function snapToAnchor(model: SheetGridModel, point: GridPoint): GridPoint {
  const region = model.mergeAt(point.row, point.col);
  return region ? { row: region.startRow, col: region.startCol } : point;
}

// ---------------------------------------------------------------------------
// Which workbooks a preview result offers
// ---------------------------------------------------------------------------

/**
 * A single workbook preview is one file; a ZIP preview already carries one
 * `FileParseResult` per entry (`ArchiveParseResult.entries`), in the
 * archive's own order. Nothing is re-parsed or re-ordered here.
 */
export function listViewerWorkbooks(
  kind: 'file' | 'archive',
  result: FileParseResult | ArchiveParseResult,
): FileParseResult[] {
  if (kind === 'archive' && 'entries' in result) return result.entries;
  if ('workbook' in result) return [result];
  return [];
}

/** The first sheet the workbook itself shows, or the first sheet when every one is hidden. */
export function initialSheetIndex(file: FileParseResult | undefined): number {
  const sheets = file?.workbook?.sheets ?? [];
  const visible = sheets.findIndex((s) => s.hidden === 'visible');
  return visible >= 0 ? visible : 0;
}

/** The first workbook that was actually read, so a ZIP does not open on a rejected entry. */
export function initialWorkbookIndex(files: FileParseResult[]): number {
  const accepted = files.findIndex((f) => f.workbook !== null);
  return accepted >= 0 ? accepted : 0;
}
