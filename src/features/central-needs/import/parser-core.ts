/**
 * CN-2A — shared pure parsing core.
 *
 * This is "the one shared pure parsing core" the contract refers to: it is
 * imported identically by both the Node 22 replay adapter (`node-replay.ts`)
 * and the browser Web Worker adapter (`worker.ts`). It performs no I/O of its
 * own (callers supply bytes; nothing here reads a file or makes a network
 * call), no database access, no formula evaluation, and no HTML generation.
 *
 * SheetJS types are used ONLY inside this file — no other module in this
 * feature imports `xlsx` directly, so the contract stays parser-neutral.
 */

import * as XLSX from 'xlsx';
import {
  type A1Coordinate,
  type CellEvidence,
  type CellPresence,
  type CellValueType,
  type Diagnostic,
  type DiagnosticCode,
  type DuplicateHeaderGroup,
  type FamilyDetection,
  type FileParseResult,
  type InputFingerprint,
  type ParserIdentity,
  type ParserLimits,
  type ParserRuntime,
  type SheetEvidence,
  type SheetVisibility,
  type SourceProvenance,
  type SourceValueRecordDraft,
  type UsedRange,
  type WorkbookEvidence,
  type WorkbookFileFormat,
  type WorkbookTotals,
  CN2A_CONTRACT_VERSION,
  DEFAULT_PARSER_LIMITS,
  SHEETJS_TARBALL_SHA256,
  SHEETJS_VERSION,
  emptyWorkbookTotals,
} from './contract.ts';

// ---------------------------------------------------------------------------
// Magic-byte detection (never trust the file extension alone)
// ---------------------------------------------------------------------------

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_MAGICS = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
];

function matchesMagic(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Detected purely from bytes. 'csv' is a residual guess: the probe must
 * decode as STRICT, well-formed UTF-8 (not merely "no NUL byte" — a NUL-free
 * binary blob such as a renamed PNG/JPEG is not text and must not be treated
 * as a CSV candidate). SheetJS is still the final arbiter for the actual
 * CSV grammar; this only rules out non-text binary garbage before we bother
 * calling into it. Documented scope limit: a legacy non-UTF-8-encoded CSV
 * (e.g. Windows-1256) is rejected here as bad-magic rather than accepted —
 * this corpus's real files are all BIFF8 XLS, never CSV, so this boundary
 * was not exercised against real data and is a conscious, narrower-than-
 * maximal starting scope rather than a silently-assumed one.
 */
export function detectMagicFormat(bytes: Uint8Array): WorkbookFileFormat | 'unknown' {
  if (matchesMagic(bytes, CFB_MAGIC)) return 'xls';
  if (ZIP_MAGICS.some((m) => matchesMagic(bytes, m))) return 'xlsx';
  const probe = bytes.subarray(0, Math.min(bytes.length, 4096));
  try {
    strictUtf8Decoder.decode(probe);
  } catch {
    return 'unknown';
  }
  return 'csv';
}

// ---------------------------------------------------------------------------
// Fingerprinting (isomorphic — Web Crypto is a global in both Node 22 and browsers/Workers)
// ---------------------------------------------------------------------------

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Error-code mapping (fallback for when SheetJS omits `w` on an error cell)
// ---------------------------------------------------------------------------

const BIFF_ERROR_CODES: Record<number, string> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
  0x2b: '#GETTING_DATA',
};

function resolveErrorCode(cell: XLSX.CellObject): string {
  if (typeof cell.w === 'string' && cell.w.startsWith('#')) return cell.w;
  if (typeof cell.v === 'number' && BIFF_ERROR_CODES[cell.v]) return BIFF_ERROR_CODES[cell.v];
  return '#UNKNOWN_ERROR!';
}

// ---------------------------------------------------------------------------
// Cell extraction
// ---------------------------------------------------------------------------

function extractCell(ws: XLSX.WorkSheet, row: number, col: number): CellEvidence | null {
  const addr = XLSX.utils.encode_cell({ r: row, c: col });
  const cell = (ws as Record<string, unknown>)[addr] as XLSX.CellObject | undefined;
  if (!cell) return null;

  const coordinate: A1Coordinate = { row, col, a1: addr };
  const isFormula = typeof cell.f === 'string';
  const hasComment = Array.isArray(cell.c) && cell.c.length > 0;
  const commentText = hasComment ? cell.c!.map((c) => c.t ?? '').join('\n') : undefined;

  if (cell.t === 'z') {
    const presence: CellPresence = 'blank';
    return {
      coordinate,
      presence,
      rawValue: null,
      formula: cell.f,
      isFormula,
      hasComment,
      commentText,
    };
  }

  let valueType: CellValueType;
  let rawValue: string | number | boolean | null;
  let errorCode: string | undefined;

  switch (cell.t) {
    case 'n':
      valueType = 'number';
      rawValue = typeof cell.v === 'number' ? cell.v : Number(cell.v);
      break;
    case 's':
      valueType = 'string';
      rawValue = typeof cell.v === 'string' ? cell.v : String(cell.v ?? '');
      break;
    case 'b':
      valueType = 'boolean';
      rawValue = Boolean(cell.v);
      break;
    case 'd':
      valueType = 'date';
      rawValue = cell.v instanceof Date ? cell.v.toISOString() : String(cell.v ?? '');
      break;
    case 'e':
      valueType = 'error';
      errorCode = resolveErrorCode(cell);
      rawValue = errorCode;
      break;
    default:
      valueType = 'string';
      rawValue = cell.v === undefined || cell.v === null ? null : String(cell.v);
  }

  return {
    coordinate,
    presence: 'value',
    valueType,
    rawValue,
    errorCode,
    formattedText: cell.w,
    formula: cell.f,
    isFormula,
    hasComment,
    commentText,
  };
}

// ---------------------------------------------------------------------------
// Sheet extraction
// ---------------------------------------------------------------------------

function parseUsedRange(ref: string | undefined): UsedRange | null {
  if (!ref) return null;
  const range = XLSX.utils.decode_range(ref);
  return {
    startRow: range.s.r,
    endRow: range.e.r,
    startCol: range.s.c,
    endCol: range.e.c,
  };
}

function extractSheet(
  wb: XLSX.WorkBook,
  index: number,
  limits: ParserLimits,
  diagnostics: Diagnostic[],
): { sheet: SheetEvidence; rejected: boolean } {
  const name = wb.SheetNames[index];
  const ws = wb.Sheets[name];
  const hiddenCode = wb.Workbook?.Sheets?.[index]?.Hidden ?? 0;
  const hidden: SheetVisibility = hiddenCode === 2 ? 'very_hidden' : hiddenCode === 1 ? 'hidden' : 'visible';
  const usedRange = parseUsedRange(ws['!ref']);

  const declaredRows = usedRange ? usedRange.endRow - usedRange.startRow + 1 : 0;
  const declaredCols = usedRange ? usedRange.endCol - usedRange.startCol + 1 : 0;

  if (declaredRows > limits.maxRows || declaredCols > limits.maxCols) {
    diagnostics.push({
      code: 'SHEET_DIMENSION_LIMIT_EXCEEDED',
      severity: 'fatal',
      message: `Sheet "${name}" declares ${declaredRows} rows x ${declaredCols} cols, exceeding the ${limits.maxRows}x${limits.maxCols} limit.`,
      path: name,
    });
    return {
      sheet: {
        index,
        name,
        hidden,
        usedRange,
        nonEmptyCellCount: 0,
        cells: [],
        mergedRanges: [],
        duplicateHeaderGroups: [],
      },
      rejected: true,
    };
  }

  const cells: CellEvidence[] = [];
  const headerByCol = new Map<number, string>();
  const headerGroups = new Map<string, number[]>();
  let nonEmptyCellCount = 0;

  if (usedRange) {
    for (let r = usedRange.startRow; r <= usedRange.endRow; r += 1) {
      for (let c = usedRange.startCol; c <= usedRange.endCol; c += 1) {
        const evidence = extractCell(ws, r, c);
        if (!evidence) continue;
        cells.push(evidence);
        if (evidence.presence === 'value') {
          nonEmptyCellCount += 1;
          if (r === usedRange.startRow && evidence.valueType === 'string' && typeof evidence.rawValue === 'string') {
            headerByCol.set(c, evidence.rawValue);
            const group = headerGroups.get(evidence.rawValue) ?? [];
            group.push(c);
            headerGroups.set(evidence.rawValue, group);
          }
        }
        if (cells.length > limits.maxCellsPerSheet) {
          diagnostics.push({
            code: 'CELL_COUNT_LIMIT_EXCEEDED',
            severity: 'fatal',
            message: `Sheet "${name}" exceeded the ${limits.maxCellsPerSheet}-cell limit while walking its used range.`,
            path: name,
          });
          return {
            sheet: { index, name, hidden, usedRange, nonEmptyCellCount, cells: [], mergedRanges: [], duplicateHeaderGroups: [] },
            rejected: true,
          };
        }
      }
    }
  }

  const mergedRanges = (ws['!merges'] ?? [])
    .map((r) => XLSX.utils.encode_range(r))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const duplicateHeaderGroups: DuplicateHeaderGroup[] = [];
  for (const [headerText, columns] of headerGroups) {
    if (columns.length > 1) {
      duplicateHeaderGroups.push({
        headerText,
        headerRow: usedRange?.startRow ?? 0,
        columns: [...columns].sort((a, b) => a - b),
      });
    }
  }
  duplicateHeaderGroups.sort((a, b) => (a.headerText < b.headerText ? -1 : a.headerText > b.headerText ? 1 : 0));

  if (usedRange && nonEmptyCellCount === 0 && declaredRows * declaredCols > 4) {
    diagnostics.push({
      code: 'STALE_USED_RANGE',
      severity: 'info',
      message: `Sheet "${name}" declares a ${declaredRows}x${declaredCols} used range but contains no populated cells — a documented legacy-XLS DIMENSIONS-record staleness quirk.`,
      path: name,
    });
  }

  return {
    sheet: { index, name, hidden, usedRange, nonEmptyCellCount, cells, mergedRanges, duplicateHeaderGroups },
    rejected: false,
  };
}

// ---------------------------------------------------------------------------
// Totals aggregation
// ---------------------------------------------------------------------------

function computeTotals(sheets: SheetEvidence[]): WorkbookTotals {
  const totals = emptyWorkbookTotals();
  totals.sheetCount = sheets.length;
  for (const sheet of sheets) {
    if (sheet.hidden !== 'visible') {
      totals.hiddenSheetCount += 1;
      if (sheet.nonEmptyCellCount > 0) totals.hiddenNonEmptySheetCount += 1;
    }
    if (sheet.nonEmptyCellCount === 0) totals.emptySheetCount += 1;
    totals.mergedRangeCount += sheet.mergedRanges.length;
    for (const cell of sheet.cells) {
      if (cell.presence === 'blank') totals.explicitBlankCellCount += 1;
      if (cell.hasComment) totals.commentCount += 1;
      if (cell.isFormula) {
        totals.formulaCellCount += 1;
        if (cell.presence === 'value') {
          if (cell.valueType === 'error') totals.cachedFormulaErrorCount += 1;
          else if (cell.valueType === 'number' && cell.rawValue === 0) totals.cachedFormulaNumericZeroCount += 1;
          else if (cell.valueType === 'number') totals.cachedFormulaNumericNonZeroCount += 1;
        }
      }
      if (!cell.isFormula && cell.presence === 'value' && cell.valueType === 'number' && cell.rawValue === 0) {
        totals.numericZeroCellCount += 1;
      }
      if (cell.isFormula && cell.presence === 'value' && cell.valueType === 'number' && cell.rawValue === 0) {
        totals.numericZeroCellCount += 1;
      }
    }
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Family detection (best-effort heuristic — documented, not authoritative)
// ---------------------------------------------------------------------------

const INSTITUTION_HEADER_HINTS = ['institution', 'مؤسسة', 'المؤسسة', 'مستشفى', 'مركز'];
const ALL_INSTITUTIONS_SHEET_COUNT_THRESHOLD = 3;

export function detectFamily(evidence: WorkbookEvidence): FamilyDetection {
  const nonEmptySheets = evidence.sheets.filter((s) => s.nonEmptyCellCount > 0);
  const reasons: string[] = [];

  const headerTexts = nonEmptySheets
    .flatMap((s) => s.cells.filter((c) => c.presence === 'value' && c.coordinate.row === (s.usedRange?.startRow ?? 0)))
    .map((c) => (typeof c.rawValue === 'string' ? c.rawValue.toLowerCase() : ''));

  const hasInstitutionHeader = headerTexts.some((h) => INSTITUTION_HEADER_HINTS.some((hint) => h.includes(hint)));

  if (nonEmptySheets.length >= ALL_INSTITUTIONS_SHEET_COUNT_THRESHOLD) {
    reasons.push(`workbook has ${nonEmptySheets.length} non-empty sheets (>= ${ALL_INSTITUTIONS_SHEET_COUNT_THRESHOLD}), consistent with one sheet per institution`);
    if (hasInstitutionHeader) reasons.push('a header cell matches a known institution-column hint');
    return {
      family: 'all_institutions_annual_needs',
      confidence: hasInstitutionHeader ? 0.75 : 0.55,
      evidence: reasons,
    };
  }

  if (nonEmptySheets.length >= 1 && nonEmptySheets.length < ALL_INSTITUTIONS_SHEET_COUNT_THRESHOLD) {
    reasons.push(`workbook has only ${nonEmptySheets.length} non-empty sheet(s), consistent with a single institution's own submission`);
    return {
      family: 'individual_institution_annual_needs',
      confidence: 0.55,
      evidence: reasons,
    };
  }

  return { family: 'unknown', confidence: 0, evidence: ['no non-empty sheet found'] };
}

// ---------------------------------------------------------------------------
// Source-record draft generation (generic mechanism — see contract.ts notes)
// ---------------------------------------------------------------------------

function buildSourceRecords(
  evidence: WorkbookEvidence,
  input: InputFingerprint,
  parserVersion: string,
  extractedAt: string,
): SourceValueRecordDraft[] {
  const records: SourceValueRecordDraft[] = [];
  for (const sheet of evidence.sheets) {
    if (!sheet.usedRange) continue;
    const headerRow = sheet.usedRange.startRow;
    const headerByCol = new Map<number, string>();
    for (const cell of sheet.cells) {
      if (cell.coordinate.row === headerRow && cell.presence === 'value' && typeof cell.rawValue === 'string') {
        headerByCol.set(cell.coordinate.col, cell.rawValue);
      }
    }
    for (const cell of sheet.cells) {
      if (cell.coordinate.row === headerRow) continue; // header row itself is not a data record
      if (cell.presence !== 'value') continue;
      const fieldName = headerByCol.get(cell.coordinate.col) ?? `col:${cell.coordinate.col}`;
      const targetEntity = `sheet:${sheet.index}:row:${cell.coordinate.row}`;
      const provenance: SourceProvenance = {
        fileFingerprintSha256: input.sha256,
        originalFilename: input.originalFilename,
        parserVersion,
        archiveEntryPath: input.archiveEntryPath,
        sheetIndex: sheet.index,
        sheetName: sheet.name,
        sheetHidden: sheet.hidden,
        coordinate: cell.coordinate,
        extractedAt,
      };
      records.push({
        targetEntity,
        fieldName,
        sourceValues: { value: cell.rawValue, valueType: cell.valueType, isFormula: cell.isFormula, formula: cell.formula ?? null },
        sourceProvenance: provenance,
      });
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ParseOptions {
  runtime: ParserRuntime;
  limits?: ParserLimits;
  /** Injected for determinism in tests; defaults to `new Date().toISOString()`. */
  now?: () => string;
}

function makeIdentity(runtime: ParserRuntime): ParserIdentity {
  return {
    contractVersion: CN2A_CONTRACT_VERSION,
    sheetjsVersion: SHEETJS_VERSION,
    sheetjsTarballSha256: SHEETJS_TARBALL_SHA256,
    runtime,
  };
}

function rejected(identity: ParserIdentity, input: InputFingerprint, diagnostics: Diagnostic[]): FileParseResult {
  return { outcome: 'rejected', identity, input, workbook: null, family: null, diagnostics, sourceRecords: [] };
}

export async function parseWorkbookBytes(
  bytes: Uint8Array,
  originalFilename: string,
  options: ParseOptions,
  archiveEntryPath?: string,
): Promise<FileParseResult> {
  const identity = makeIdentity(options.runtime);
  const limits = options.limits ?? DEFAULT_PARSER_LIMITS;
  const now = options.now ?? (() => new Date().toISOString());
  const sha256 = await sha256Hex(bytes);
  const input: InputFingerprint = { originalFilename, sha256, byteSize: bytes.byteLength, archiveEntryPath };

  // Raw-input ceiling FIRST, before magic sniffing and before SheetJS is
  // handed anything. The row/column/cell ceilings enforced later are
  // post-parse bounds: by the time they run, XLSX.read() has already
  // materialised the entire workbook, so they cannot protect this stage.
  // Archive entries are bounded separately, during decompression, by
  // `maxZipEntryUncompressedBytes` (see zip-reader.ts).
  if (bytes.byteLength > limits.maxStandaloneInputBytes) {
    return rejected(identity, input, [
      {
        code: 'INPUT_SIZE_LIMIT_EXCEEDED',
        severity: 'fatal',
        message: `"${originalFilename}" is ${bytes.byteLength} bytes, exceeding the ${limits.maxStandaloneInputBytes}-byte pre-parse ceiling; rejected before the parser was invoked.`,
      },
    ]);
  }

  const magicFormat = detectMagicFormat(bytes);
  if (magicFormat === 'unknown') {
    return rejected(identity, input, [
      { code: 'BAD_MAGIC', severity: 'fatal', message: `"${originalFilename}" does not match any known XLS/XLSX/CSV magic bytes.` },
    ]);
  }

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(bytes, {
      type: 'array',
      cellFormula: true,
      cellHTML: false,
      cellText: true,
      cellDates: true,
      sheetStubs: true,
      bookVBA: true,
      WTF: false,
      dense: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code: DiagnosticCode = /password/i.test(message)
      ? 'ENCRYPTED_WORKBOOK'
      : /CFB|too small|Corrupted zip/i.test(message)
        ? 'TRUNCATED_CONTAINER'
        : 'CORRUPT_RECORD_STREAM';
    return rejected(identity, input, [{ code, severity: 'fatal', message }]);
  }

  const diagnostics: Diagnostic[] = [];
  const sheets: SheetEvidence[] = [];
  let sheetRejected = false;

  if (wb.SheetNames.length > limits.maxSheets) {
    diagnostics.push({
      code: 'SHEET_DIMENSION_LIMIT_EXCEEDED',
      severity: 'fatal',
      message: `Workbook declares ${wb.SheetNames.length} sheets, exceeding the ${limits.maxSheets}-sheet limit.`,
    });
    return rejected(identity, input, diagnostics);
  }

  for (let i = 0; i < wb.SheetNames.length; i += 1) {
    const { sheet, rejected: sheetWasRejected } = extractSheet(wb, i, limits, diagnostics);
    sheets.push(sheet);
    if (sheetWasRejected) sheetRejected = true;
  }
  if (sheetRejected) return rejected(identity, input, diagnostics);

  const vbaPresent = wb.vbaraw !== undefined && wb.vbaraw !== null;
  if (vbaPresent) {
    diagnostics.push({ code: 'VBA_PRESENT', severity: 'warning', message: 'Workbook contains a VBA project; detection only, no policy enforcement in CN-2A.' });
  }

  const totals = computeTotals(sheets);
  const format: WorkbookFileFormat = magicFormat;
  const evidence: WorkbookEvidence = { format, sheets, vbaPresent, totals };
  const family = detectFamily(evidence);
  if (family.family === 'unknown') {
    diagnostics.push({ code: 'FAMILY_UNRECOGNIZED', severity: 'warning', message: 'Workbook family could not be determined from header/sheet-count heuristics.' });
  }

  for (const sheet of sheets) {
    for (const group of sheet.duplicateHeaderGroups) {
      diagnostics.push({
        code: 'DUPLICATE_HEADER_TEXT',
        severity: 'info',
        message: `Sheet "${sheet.name}" has duplicate header text "${group.headerText}" at columns [${group.columns.join(', ')}].`,
        path: sheet.name,
      });
    }
  }

  const extractedAt = now();
  const sourceRecords = buildSourceRecords(evidence, input, `${CN2A_CONTRACT_VERSION}/${identity.sheetjsVersion}`, extractedAt);

  return { outcome: 'accepted', identity, input, workbook: evidence, family, diagnostics, sourceRecords };
}

export { LOCK_FILE_PREFIX } from './contract.ts';
