/**
 * CN-2A — Parser-neutral import contract (FROZEN).
 *
 * This file is the single source of truth for what the CN-2A parser produces.
 * It is deliberately independent of any specific spreadsheet library: nothing
 * outside this feature folder should ever import a SheetJS type directly.
 *
 * Scope boundary (do not expand without a new contract version):
 *  - This contract describes PARSING output only. It performs no database
 *    persistence, no RPC call, and no mutation of any kind. Everything here
 *    is plain, JSON-serializable data.
 *  - `SourceValueRecordDraft`/`SourceProvenance` are shaped to become, verbatim,
 *    a future `central_needs_source_records` row's `source_values`/
 *    `source_provenance` JSONB payload once CN-1B ships the RPC that persists
 *    them (migration 209). CN-2A never writes to that table.
 *  - The original source value is immutable. A future manual correction is an
 *    explicit override (previous value, final value, reason, actor, timestamp)
 *    persisted to `central_needs_field_overrides` by CN-1B — CN-2A has no
 *    write path and therefore cannot mutate source evidence, silently or
 *    otherwise. `FieldOverrideDraft` below documents the shape a future
 *    override would take; CN-2A does not construct or apply it.
 *
 * Determinism contract:
 *  - `ArchiveParseResult.entries` is ordered by ZIP central-directory order
 *    (post-filtering), which is itself the order the archive's author wrote
 *    entries in — not re-sorted.
 *  - `WorkbookEvidence.sheets` is ordered by the workbook's native sheet index.
 *  - `SheetEvidence.cells` contains only cells whose presence is not `missing`,
 *    ordered row-major: ascending `row`, then ascending `col`.
 *  - `SheetEvidence.mergedRanges` is ordered lexicographically by its A1 string.
 *  - `FileParseResult.diagnostics` / `ArchiveParseResult.diagnostics` are
 *    ordered by emission order during the parse walk (deterministic for a
 *    given input, not sorted by severity).
 *  - Two parses of byte-identical input, on either runtime (Node 22 replay or
 *    the browser Web Worker), MUST produce byte-identical JSON for every field
 *    in this contract except `SourceProvenance.extractedAt` and
 *    `ParserIdentity.runtime` (see "Runtime parity" below).
 *  - `SourceProvenance.columnHeaderEvidence` (B2, 1.1.0) is additive to this
 *    guarantee, not an exception to it: it is derived purely from already-
 *    deterministic `SheetEvidence.cells`/`mergedRanges`, present only on the
 *    anchor record for its physical column, and therefore byte-identical
 *    between runtimes under the same rule as everything else in this list.
 *
 * Runtime parity:
 *  - The workbook-parsing semantics (SheetJS invocation, coordinate/provenance
 *    extraction, family detection, diagnostics) live in one shared pure module
 *    (`parser-core.ts`) with no environment-specific API calls, imported
 *    identically by both the Node 22 replay adapter and the browser Worker
 *    adapter. This is "the one shared pure parsing core" — it is what this
 *    contract's semantic-parity guarantee actually rests on.
 *  - The ZIP-archive *decompression* primitive is the one deliberate exception,
 *    and it is narrow and explicit — the `Inflate` function type in
 *    `zip-reader.ts` is the entire boundary:
 *      Node    (`node-inflate.ts`)   : `zlib.inflateRawSync`, output bounded by
 *                                      zlib's own `maxOutputLength`.
 *      Browser (`browser-inflate.ts`): `DecompressionStream('deflate-raw')`,
 *                                      output bounded by counting emitted bytes
 *                                      and cancelling the reader on breach.
 *    Both raise `InflateOutputLimitExceeded` at the same ceiling, so the
 *    security policy is identical even though the primitive is not. DEFLATE has
 *    exactly one correct output for a given compressed input, so no semantic
 *    drift is possible; everything downstream of "here are the decompressed
 *    bytes of entry N" is the identical shared code path.
 *    This parity is EMPIRICALLY VERIFIED, not merely argued: an actual ZIP
 *    archive containing a workbook was parsed through both runtimes and the
 *    two `ArchiveParseResult` JSON documents hash identically
 *    (SHA-256 c98bd6e6c22b64a985d7db15f85924c53fb1e004f269387c2b3f68de2c5bd76f,
 *    reverified at 1.1.0 — the hash moved for three additive reasons, not
 *    one: the unmasked `identity.contractVersion` (1.0.0 -> 1.1.0),
 *    `sourceProvenance.parserVersion` changing with it, and B2's additive
 *    `columnHeaderEvidence`, itself derived purely from already-
 *    deterministic shared-core data. None of the three breaks parity: the
 *    two runtimes' masked JSON is still byte-for-byte identical)
 *    after masking only `identity.runtime` (archive level and each nested
 *    per-file result) and `sourceProvenance.extractedAt`. Filenames, SHA-256
 *    fingerprints, entry classifications, reconciliation counts, diagnostics
 *    and all workbook content were compared verbatim.
 */

// ---------------------------------------------------------------------------
// Identity and fingerprinting
// ---------------------------------------------------------------------------

/**
 * This contract's own semantic version. Bump on any breaking shape change.
 *
 * 1.0.0 -> 1.1.0 (MINOR): B2 column-anchor structural evidence
 * (`SourceProvenance.columnHeaderEvidence`) — purely additive, present only
 * on one deterministic anchor record per physical column, never repeated
 * per record. `fieldName`, `targetEntity`, `sourceValues`, record
 * cardinality/ordering, and every M209/M210/M213 contract this file
 * documents are unchanged. See docs/phoenix/proposals/cn2a-parser-contract.md
 * and the CN2A-COLUMN-ANCHOR-AUDIT and CN2A-B2-PAGINATION
 * evidence bundles for the full design proof this shape is based on.
 */
export const CN2A_CONTRACT_VERSION = '1.1.0';

/** Pinned SheetJS Community Edition identity (never the npm registry's stale 0.18.5). */
export const SHEETJS_VERSION = '0.20.3';
export const SHEETJS_TARBALL_SHA256 =
  '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8';

export type ParserRuntime = 'node' | 'browser_worker';

export interface ParserIdentity {
  contractVersion: string;
  sheetjsVersion: string;
  sheetjsTarballSha256: string;
  runtime: ParserRuntime;
}

export interface InputFingerprint {
  /** Basename only — never a full local filesystem path (privacy/portability). */
  originalFilename: string;
  /** SHA-256 of the exact bytes handed to the parser, lowercase hex. */
  sha256: string;
  byteSize: number;
  /** Set when this file was extracted from a ZIP archive rather than parsed standalone. */
  archiveEntryPath?: string;
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

export interface A1Coordinate {
  /** 0-based row index. */
  row: number;
  /** 0-based column index. */
  col: number;
  /** Conventional 1-based spreadsheet address, e.g. "A1", "AB37". */
  a1: string;
}

export interface UsedRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

// ---------------------------------------------------------------------------
// Cell-level evidence
// ---------------------------------------------------------------------------

/**
 * Three-way presence model (explicit requirement — never collapse these):
 *  - `missing`  — no cell object exists at this coordinate at all (never visited).
 *  - `blank`    — a cell object exists but carries no value (e.g. a SheetJS
 *                 `t:'z'` stub, often present only to anchor a comment).
 *  - `value`    — a cell object exists and carries an actual value, which may
 *                 itself be the number zero (zero is a `value`, never a `blank`).
 */
export type CellPresence = 'missing' | 'blank' | 'value';

export type CellValueType = 'number' | 'string' | 'boolean' | 'date' | 'error';

export interface CellEvidence {
  coordinate: A1Coordinate;
  presence: CellPresence;
  /** Set only when presence === 'value'. */
  valueType?: CellValueType;
  /**
   * The raw value, byte-faithful to the source file. Never coerced: an error
   * cell's rawValue is its error code string (e.g. "#VALUE!"), never 0 or null
   * standing in for the error. A date cell's rawValue is its underlying
   * serial number (SheetJS never auto-converts here) plus formattedText for
   * display only.
   */
  rawValue: string | number | boolean | null;
  /** Present only when valueType === 'error', e.g. "#VALUE!", "#DIV/0!". */
  errorCode?: string;
  /** SheetJS's formatted display text (`cell.w`). Informational only — never authoritative, never used for comparisons. */
  formattedText?: string;
  /** Verbatim formula text when the cell is a formula. This parser NEVER evaluates it. */
  formula?: string;
  isFormula: boolean;
  hasComment: boolean;
  /** Present only when hasComment is true. */
  commentText?: string;
}

// ---------------------------------------------------------------------------
// Sheet-level evidence
// ---------------------------------------------------------------------------

export type SheetVisibility = 'visible' | 'hidden' | 'very_hidden';

export interface DuplicateHeaderGroup {
  /** Byte-verbatim header text — never case-folded or trimmed for grouping. */
  headerText: string;
  headerRow: number;
  /** 0-based column indices sharing this exact header text, ascending. */
  columns: number[];
}

/**
 * CONTINUATION ROWS — status: DEFERRED (explicitly, not silently absent).
 *
 * CN-2A does NOT group continuation rows (a row that continues the previous
 * logical record rather than starting a new one) into a single logical entity.
 * Every row is emitted as its own `targetEntity` (`sheet:{i}:row:{r}`).
 *
 * Why deferred rather than implemented: deciding that row N is a continuation
 * of row N-1 requires knowing which column is the record's key column — that
 * is per-workbook-family business semantics, the same domain-knowledge gap
 * already flagged for business-field mapping in `buildSourceRecords`. Guessing
 * it here would bake an unvalidated rule into frozen evidence.
 *
 * Why deferring is safe: every input needed to derive continuation grouping
 * later is preserved losslessly and coordinate-exactly by this contract —
 * `mergedRanges` (the usual physical marker of a spanned record), the
 * three-way `missing`/`blank`/`value` presence distinction per coordinate
 * (the usual marker of an inherited/empty key cell), and exact row/column
 * indices on every cell. A later package can therefore group continuation
 * rows from stored evidence WITHOUT re-parsing the source workbook, and
 * without CN-2A having mutated or collapsed anything first.
 */
export interface SheetEvidence {
  /** 0-based sheet index within the workbook's native tab order. */
  index: number;
  name: string;
  hidden: SheetVisibility;
  /**
   * The file's own declared `!ref` extent, verbatim. May be wider than the
   * sheet's actual nonempty content (a documented legacy-XLS quirk: a stale
   * BIFF DIMENSIONS record after content was deleted without resaving it).
   * Never used as a substitute for `nonEmptyCellCount`.
   */
  usedRange: UsedRange | null;
  /** Independently counted from populated cells — never derived from usedRange. */
  nonEmptyCellCount: number;
  /** Only cells with presence !== 'missing'. Row-major order (see contract determinism notes above). */
  cells: CellEvidence[];
  /** A1 range strings (e.g. "A1:C1"), lexicographically sorted. */
  mergedRanges: string[];
  duplicateHeaderGroups: DuplicateHeaderGroup[];
}

// ---------------------------------------------------------------------------
// Workbook-level evidence and aggregate totals
// ---------------------------------------------------------------------------

export type WorkbookFileFormat = 'xls' | 'xlsx' | 'csv';

export interface WorkbookTotals {
  sheetCount: number;
  hiddenSheetCount: number;
  hiddenNonEmptySheetCount: number;
  emptySheetCount: number;
  mergedRangeCount: number;
  formulaCellCount: number;
  cachedFormulaNumericZeroCount: number;
  cachedFormulaNumericNonZeroCount: number;
  cachedFormulaErrorCount: number;
  numericZeroCellCount: number;
  commentCount: number;
  explicitBlankCellCount: number;
}

export interface WorkbookEvidence {
  format: WorkbookFileFormat;
  sheets: SheetEvidence[];
  vbaPresent: boolean;
  totals: WorkbookTotals;
}

// ---------------------------------------------------------------------------
// Workbook-family detection
// ---------------------------------------------------------------------------

export type WorkbookFamily =
  | 'individual_institution_annual_needs'
  | 'all_institutions_annual_needs'
  | 'unknown';

export interface FamilyDetection {
  family: WorkbookFamily;
  /** 0..1. A confidence of exactly 1 is never claimed without corroborating evidence entries. */
  confidence: number;
  /** Human-readable reasons, e.g. which header text or sheet-count signal matched. Never empty when family !== 'unknown'. */
  evidence: string[];
}

// ---------------------------------------------------------------------------
// Diagnostics taxonomy (stable — additive only, never renumber/reuse a code)
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = 'info' | 'warning' | 'error' | 'fatal';

export type DiagnosticCode =
  | 'BAD_MAGIC'
  | 'TRUNCATED_CONTAINER'
  | 'CORRUPT_RECORD_STREAM'
  | 'ENCRYPTED_WORKBOOK'
  | 'VBA_PRESENT'
  | 'SHEET_DIMENSION_LIMIT_EXCEEDED'
  | 'CELL_COUNT_LIMIT_EXCEEDED'
  | 'TIMEOUT'
  | 'ZIP_PATH_TRAVERSAL'
  | 'ZIP_ENTRY_COUNT_LIMIT_EXCEEDED'
  | 'ZIP_COMPRESSION_RATIO_LIMIT_EXCEEDED'
  /** DECLARED (central-directory metadata) uncompressed size exceeded a ceiling. Attacker-controlled; a preflight only. */
  | 'ZIP_UNCOMPRESSED_SIZE_LIMIT_EXCEEDED'
  /** ACTUAL inflated output exceeded the ceiling. Enforced during decompression, independent of declared metadata. */
  | 'ZIP_INFLATED_OUTPUT_LIMIT_EXCEEDED'
  /** Actual inflated length disagreed with the declared uncompressed size — the entry lied about its own size. */
  | 'ZIP_INFLATED_SIZE_MISMATCH'
  | 'ZIP_LOCAL_CENTRAL_NAME_MISMATCH'
  | 'ZIP_SYMLINK_ENTRY'
  /** Raw standalone (non-archive) input exceeded the pre-parse byte ceiling; rejected before SheetJS is invoked. */
  | 'INPUT_SIZE_LIMIT_EXCEEDED'
  | 'LOCK_FILE_EXCLUDED'
  | 'DIRECTORY_EXCLUDED'
  | 'UNSUPPORTED_FILE_FORMAT'
  | 'FAMILY_UNRECOGNIZED'
  | 'STALE_USED_RANGE'
  | 'DUPLICATE_HEADER_TEXT'
  | 'RECONCILIATION_MISMATCH';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  /** Archive entry path or filename this diagnostic applies to, when applicable. */
  path?: string;
  coordinate?: A1Coordinate;
}

// ---------------------------------------------------------------------------
// M209-compatible source evidence (draft only — CN-2A persists nothing)
// ---------------------------------------------------------------------------

/**
 * B2 — one structural header candidate for a physical column, preserved
 * verbatim. This is CN-2A's entire claim: "this cell's text structurally
 * relates to this physical column." It is never "this means UNIT" or "this
 * means BENEFICIARY" — CN-2A assigns no business/semantic authority to
 * beneficiary identity, material identity, source-unit semantics, canonical
 * units, or quantity conversion. That interpretation belongs to CN-2B/M213,
 * which already treats header text as evidence, never authority (the same
 * boundary `phoenix_central_needs_set_beneficiary_columns` already enforces
 * with human confirmation).
 *
 * More than one entry for the same column means its own header could not be
 * resolved to a single row (e.g. a therapeutic-category divider row
 * coinciding with another column-region's real header row) — ambiguity is
 * preserved as multiple candidates here, never collapsed to a guess.
 */
export interface ColumnHeaderEvidence {
  coordinate: A1Coordinate;
  /** Byte-verbatim header cell text — never trimmed, case-folded, normalized, or reformatted. */
  rawText: string;
  /** Set only when a real multi-column merge in the header band explains this entry. */
  mergedRange?: string;
}

export interface SourceProvenance {
  fileFingerprintSha256: string;
  originalFilename: string;
  parserVersion: string;
  archiveEntryPath?: string;
  sheetIndex: number;
  sheetName: string;
  sheetHidden: SheetVisibility;
  coordinate: A1Coordinate;
  /** ISO 8601 UTC timestamp of the parse run itself — never a business date extracted from the workbook. */
  extractedAt: string;
  /**
   * B2 — present ONLY on the first `SourceValueRecordDraft` emitted for this
   * record's physical column `(sheetIndex, coordinate.col)` within this
   * sheet (the "anchor" record, in existing emission order — proven
   * identical to "lowest row index" for this column under this contract's
   * own row-major determinism guarantee). Every other record sharing that
   * column omits this field entirely — it is never repeated per record,
   * which is the whole reason this is safe to add to a corpus whose real
   * preview payload is already tens of megabytes.
   *
   * An anchor whose column carries no provable header-candidate text at all
   * gets an empty array, `[]` — never a fabricated guess, and never simply
   * omitted, so "no evidence" and "not the anchor" remain distinguishable.
   */
  columnHeaderEvidence?: ColumnHeaderEvidence[];
}

/**
 * Shaped to become a future `central_needs_source_records` row's
 * `source_values`/`source_provenance` verbatim (migration 209). CN-2A
 * constructs these in memory only; it never calls Supabase.
 */
export interface SourceValueRecordDraft {
  /** Generic stable logical identifier — matches M209's `target_entity` vocabulary. Not a foreign key at this stage. */
  targetEntity: string;
  fieldName: string;
  /** JSON-serializable. Becomes `source_values` (JSONB NOT NULL). */
  sourceValues: unknown;
  /** Shape-free per M209's own column definition; this is CN-2A's own concrete producer shape. Becomes `source_provenance` (JSONB, nullable). */
  sourceProvenance: SourceProvenance;
}

/**
 * Documents the shape a future manual correction takes once CN-1B ships the
 * override RPC (`central_needs_field_overrides`). CN-2A never constructs one
 * of these — it has no write path and no UI for correction.
 */
export interface FieldOverrideDraft {
  targetEntity: string;
  fieldName: string;
  previousValue: unknown;
  finalValue: unknown;
  overrideReason: string;
  overrideNote?: string;
  overrideReference?: string;
  actorId: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Top-level parse results
// ---------------------------------------------------------------------------

export type ParseOutcome = 'accepted' | 'rejected';

export interface FileParseResult {
  outcome: ParseOutcome;
  identity: ParserIdentity;
  input: InputFingerprint;
  /** null when outcome === 'rejected'. */
  workbook: WorkbookEvidence | null;
  /** null when outcome === 'rejected'. */
  family: FamilyDetection | null;
  diagnostics: Diagnostic[];
  /** Empty when outcome === 'rejected'. */
  sourceRecords: SourceValueRecordDraft[];
}

export type ExclusionReason = 'lock_file' | 'directory';

export interface ExcludedEntry {
  path: string;
  reason: ExclusionReason;
}

export interface ReconciliationSummary {
  filesTotal: number;
  filesAccepted: number;
  filesRejected: number;
  filesExcluded: number;
  /** Sum of every accepted workbook's totals — the level at which CN-0C's golden-corpus reconciliation operates. */
  aggregateTotals: WorkbookTotals;
}

export interface ArchiveParseResult {
  identity: ParserIdentity;
  archive: InputFingerprint;
  /** ZIP central-directory order, post-filtering. */
  entries: FileParseResult[];
  excludedEntries: ExcludedEntry[];
  /** Archive-level diagnostics (traversal, bomb, entry-count limit, etc.) — never per-file. */
  diagnostics: Diagnostic[];
  reconciliation: ReconciliationSummary;
}

export function emptyWorkbookTotals(): WorkbookTotals {
  return {
    sheetCount: 0,
    hiddenSheetCount: 0,
    hiddenNonEmptySheetCount: 0,
    emptySheetCount: 0,
    mergedRangeCount: 0,
    formulaCellCount: 0,
    cachedFormulaNumericZeroCount: 0,
    cachedFormulaNumericNonZeroCount: 0,
    cachedFormulaErrorCount: 0,
    numericZeroCellCount: 0,
    commentCount: 0,
    explicitBlankCellCount: 0,
  };
}

export function addWorkbookTotals(a: WorkbookTotals, b: WorkbookTotals): WorkbookTotals {
  return {
    sheetCount: a.sheetCount + b.sheetCount,
    hiddenSheetCount: a.hiddenSheetCount + b.hiddenSheetCount,
    hiddenNonEmptySheetCount: a.hiddenNonEmptySheetCount + b.hiddenNonEmptySheetCount,
    emptySheetCount: a.emptySheetCount + b.emptySheetCount,
    mergedRangeCount: a.mergedRangeCount + b.mergedRangeCount,
    formulaCellCount: a.formulaCellCount + b.formulaCellCount,
    cachedFormulaNumericZeroCount: a.cachedFormulaNumericZeroCount + b.cachedFormulaNumericZeroCount,
    cachedFormulaNumericNonZeroCount:
      a.cachedFormulaNumericNonZeroCount + b.cachedFormulaNumericNonZeroCount,
    cachedFormulaErrorCount: a.cachedFormulaErrorCount + b.cachedFormulaErrorCount,
    numericZeroCellCount: a.numericZeroCellCount + b.numericZeroCellCount,
    commentCount: a.commentCount + b.commentCount,
    explicitBlankCellCount: a.explicitBlankCellCount + b.explicitBlankCellCount,
  };
}

// ---------------------------------------------------------------------------
// Resource limits (adversarial-hardening contract — see parser-core.ts)
// ---------------------------------------------------------------------------

export interface ParserLimits {
  maxRows: number;
  maxCols: number;
  maxCellsPerSheet: number;
  maxSheets: number;
  parseTimeoutMs: number;
  /**
   * Raw byte ceiling for a STANDALONE (non-archive) workbook handed to
   * `parseWorkbookBytes`. Enforced BEFORE `XLSX.read()` is called, because
   * the row/column/cell ceilings can only be applied after SheetJS has
   * already materialised the whole workbook in memory — they are a
   * post-parse bound and provide no protection against a huge raw input.
   * This is a security/resource policy, not a corpus-derived business rule:
   * the largest real corpus workbook is ~0.5 MB (CN-0C benchmark, §7), so
   * 64 MiB leaves roughly two orders of magnitude of headroom for legitimate
   * growth while still bounding a single parse.
   */
  maxStandaloneInputBytes: number;
  maxZipEntryCount: number;
  /** Ceiling on the SUM of DECLARED uncompressed sizes (preflight on attacker-controlled metadata). */
  maxZipUncompressedBytes: number;
  maxZipCompressionRatio: number;
  /**
   * Ceiling for a single ZIP entry. Enforced TWICE and independently:
   * (a) as a preflight against the central directory's DECLARED size, and
   * (b) as a hard ceiling on the ACTUAL number of inflated bytes, enforced
   *     inside the decompressor itself so a lying declared size cannot buy
   *     an attacker any extra output.
   */
  maxZipEntryUncompressedBytes: number;
}

export const DEFAULT_PARSER_LIMITS: ParserLimits = {
  maxRows: 10_000,
  maxCols: 256,
  maxCellsPerSheet: 2_000_000,
  maxSheets: 200,
  parseTimeoutMs: 10_000,
  maxStandaloneInputBytes: 64 * 1024 * 1024,
  maxZipEntryCount: 5_000,
  maxZipUncompressedBytes: 1_000_000_000,
  maxZipCompressionRatio: 300,
  maxZipEntryUncompressedBytes: 200_000_000,
};

/** Any basename starting with this prefix is an Excel/LibreOffice lock file and is excluded pre-parse, never opened. */
export const LOCK_FILE_PREFIX = '~$';
