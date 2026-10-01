/**
 * C4 — the client's pure rules for PERSISTED beneficiary regions.
 *
 * The server is the authority (M216): it validates, fences, stores and
 * refuses. Everything here only decides what the screen OFFERS and what it
 * sends, and it can only ADD obstacles to the E2-C drafts — never remove one.
 *
 *   * Persisted ACTIVE versions are a SEPARATE layer keyed by `versionId`. They
 *     are never turned into E2-C `im-N` drafts, and E2-C drafts are never
 *     turned into anything but explicit `add` changes the human confirms.
 *   * A whole E2-C column becomes the full-height rectangle
 *     [0..1,048,575] × [c..c] — explicit integers, never "unbounded".
 *   * Nothing is ever copied or inferred from an M213 row: a conversion sends
 *     the row's four fence values verbatim and the human's own regions.
 *
 * Pure: no React, no service call, no network, no storage.
 */
import {
  REGION_MAX_COLUMN_INDEX,
  REGION_WHOLE_COLUMN_ROW_END,
  type BeneficiaryColumnDecision,
  type BeneficiaryRegionChange,
  type BeneficiaryRegionVersion,
  type RenderedParserIdentity,
  type ScopeColumnMapping,
} from '../central-needs.service';
import type { InstitutionMapping, NeedSource } from '../mapping/institutionMapping';
import { CN2A_CONTRACT_VERSION, SHEETJS_TARBALL_SHA256, SHEETJS_VERSION } from '../import/contract.ts';

/**
 * The parser THIS build runs — the one that renders every grid the stored
 * workbook viewer shows. G3 compares it with the session's recorded identity.
 */
export const RUNNING_PARSER_IDENTITY: RenderedParserIdentity = Object.freeze({
  contractVersion: CN2A_CONTRACT_VERSION,
  sheetjsVersion: SHEETJS_VERSION,
  sheetjsTarballSha256: SHEETJS_TARBALL_SHA256,
});

export interface RegionBounds {
  rowStart: number;
  rowEnd: number;
  columnStart: number;
  columnEnd: number;
}

/** The persisted rectangle of an E2-C Need source. A whole column is full height. */
export function boundsOfNeed(need: NeedSource): RegionBounds {
  return need.kind === 'column'
    ? { rowStart: 0, rowEnd: REGION_WHOLE_COLUMN_ROW_END, columnStart: need.columnIndex, columnEnd: need.columnIndex }
    : { rowStart: need.startRow, rowEnd: need.endRow, columnStart: need.startColumn, columnEnd: need.endColumn };
}

/** Inclusive rectangle intersection — exactly the server's and E2-C's test. */
export const boundsIntersect = (a: RegionBounds, b: RegionBounds): boolean =>
  a.rowStart <= b.rowEnd && b.rowStart <= a.rowEnd && a.columnStart <= b.columnEnd && b.columnStart <= a.columnEnd;

export const spansColumn = (b: RegionBounds, columnIndex: number): boolean =>
  b.columnStart <= columnIndex && columnIndex <= b.columnEnd;

export const sameBounds = (a: RegionBounds, b: RegionBounds): boolean =>
  a.rowStart === b.rowStart && a.rowEnd === b.rowEnd && a.columnStart === b.columnStart && a.columnEnd === b.columnEnd;

/**
 * X1: a column is REGION-GOVERNED when at least one ACTIVE version of the same
 * session and sheet spans it, whatever that version's decision.
 */
export function regionGovernsColumn(
  active: readonly BeneficiaryRegionVersion[],
  importSessionId: string,
  sheetIndex: number,
  columnIndex: number,
): boolean {
  return active.some((v) => v.importSessionId === importSessionId && v.sheetIndex === sheetIndex && spansColumn(v, columnIndex));
}

/**
 * A loaded (session, sheet) whose ACTIVE versions span a column that ALSO has
 * an M213 row is not a state the server can commit on any lock-taking path.
 * Seeing it means the read is torn or a privileged bypass raced: the layer is
 * shown as unavailable and every write is disabled.
 */
export function loadedLayerConflict(
  active: readonly BeneficiaryRegionVersion[],
  m213: readonly Pick<ScopeColumnMapping, 'importSessionId' | 'sheetIndex' | 'columnIndex'>[],
): { columnIndex: number; versionId: string } | null {
  for (const m of m213) {
    const hit = active.find((v) => v.importSessionId === m.importSessionId && v.sheetIndex === m.sheetIndex && spansColumn(v, m.columnIndex));
    if (hit) return { columnIndex: m.columnIndex, versionId: hit.versionId };
  }
  return null;
}

/**
 * CN-UI-R1 — M216's safe coordinate extractor, mirrored for the parsed value.
 *
 * THE SERVER RULE (authoritative, unchanged): M216
 * `_phoenix_central_needs_safe_coordinate_v1` counts a persisted coordinate
 * only when it is a jsonb number whose TEXT matches `^[0-9]{1,9}$` (plain
 * decimal digits: no sign, fraction or exponent) and is within the caller's
 * ceiling — sheet 2,147,483,647 (nine digits in effect), row 1,048,575,
 * column 16,383. Anything else locates nothing, and M217 `set_need_line`
 * re-proves every designated source record from its stored jsonb.
 *
 * THIS CHECK is the strictest possible from the JavaScript number that
 * JSON/PostgREST parsing yields: a number, a safe integer, non-negative,
 * never -0, at most 999,999,999 and within the ceiling.
 *
 * E1 — OWNER-APPROVED LEXICAL EXCEPTION (CN-UI-R1-HC1). The original numeric
 * SPELLING cannot be reconstructed client-side: parsing yields one IEEE-754
 * double, so a persisted `5.0` (refused by M216's lexical rule) and a
 * canonical `5` both arrive as the number 5 — as does decimal text beyond
 * double precision (e.g. `5.0000000000000001`). Such a cell can therefore look
 * locatable here; wherever the server reads that coordinate it judges the
 * stored jsonb text by M216 and remains the final authority. E1 covers ONLY
 * what parsing loses — it relaxes no type, integer, sign, -0, digit-count or
 * ceiling rule applied to the parsed value, and no server check. The client
 * stays advisory.
 */
const SAFE_COORDINATE_MAX_DIGITS_VALUE = 999_999_999;
export const SAFE_SHEET_INDEX_CEILING = 2_147_483_647;

export function safeCoordinate(value: unknown, ceiling: number): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) return null;
  if (value > SAFE_COORDINATE_MAX_DIGITS_VALUE || value > ceiling) return null;
  return value;
}

/**
 * A source record's persisted cell, each part safely extracted or `null` (M216
 * `_resolve_region_v1`): sheetIndex, coordinate.row and coordinate.col, each
 * through `safeCoordinate` — so the E1 lexical exception, and nothing more,
 * applies to every part.
 */
export interface SafeCell {
  sheetIndex: number | null;
  row: number | null;
  column: number | null;
}

export function safeCellOf(sourceProvenance: unknown): SafeCell {
  const p = sourceProvenance !== null && typeof sourceProvenance === 'object'
    ? sourceProvenance as Record<string, unknown> : null;
  const coordinate = p !== null && p.coordinate !== null && typeof p.coordinate === 'object'
    ? p.coordinate as Record<string, unknown> : null;
  return {
    sheetIndex: safeCoordinate(p?.sheetIndex, SAFE_SHEET_INDEX_CEILING),
    row: safeCoordinate(coordinate?.row, REGION_WHOLE_COLUMN_ROW_END),
    column: safeCoordinate(coordinate?.col, REGION_MAX_COLUMN_INDEX),
  };
}

/** The M213 facts of one loaded column the need-line beneficiary rule reads — nothing else. */
export interface ColumnDecisionRow {
  importSessionId: string;
  sheetIndex: number;
  columnIndex: number;
  /** `null` = no M213 row for this column. */
  decision: BeneficiaryColumnDecision | null;
  beneficiaryOrganizationId: string | null;
}

/**
 * CN-UI-R1 — whether the loaded region layer may be used to resolve need-line
 * beneficiaries at all. Not read, or read but torn (an ACTIVE version spans a
 * column that also carries an M213 row — the existing conflict rule): nothing
 * is resolved and every need-line write is withheld. There is no M213 fallback:
 * without the layer the client cannot know which columns regions govern.
 */
export type NeedLineRegionEvidence =
  | { usable: true; active: readonly BeneficiaryRegionVersion[] }
  | { usable: false; code: string };

export function needLineRegionEvidence(
  regions: RegionReadState,
  columns: readonly ColumnDecisionRow[],
): NeedLineRegionEvidence {
  if (regions.phase !== 'ready') return { usable: false, code: regions.code };
  if (loadedLayerConflict(regions.versions, columns.filter((c) => c.decision !== null))) {
    return { usable: false, code: 'beneficiary_decision_grain_conflict' };
  }
  return { usable: true, active: regions.versions };
}

/**
 * One cell's beneficiary as the client reads it — advisory; the server
 * re-proves every designated cell at write time.
 *   * `beneficiary` / `non_beneficiary` — decided, at the region or the column grain;
 *   * `unresolved` — an ungoverned column with no M213 decision (unchanged M213 behaviour);
 *   * `blocked` — never designatable, with the server refusal code it would meet.
 */
export type NeedLineBeneficiary =
  | { state: 'beneficiary'; beneficiaryOrganizationId: string; grain: 'region' | 'column' }
  | { state: 'non_beneficiary'; grain: 'region' | 'column' }
  | { state: 'unresolved' }
  | { state: 'blocked'; code: string };

/** The loaded M213 columns, indexed exactly as the M213 resolution has always keyed them. */
export interface ColumnDecisionIndex {
  beneficiaryByColumn: ReadonlyMap<string, string>;
  nonBeneficiaryColumns: ReadonlySet<string>;
  decidedColumns: ReadonlySet<string>;
}

const columnKey = (importSessionId: string, sheetIndex: number, columnIndex: number) =>
  `${importSessionId}:${sheetIndex}:${columnIndex}`;

export function indexColumnDecisions(columns: readonly ColumnDecisionRow[]): ColumnDecisionIndex {
  const beneficiaryByColumn = new Map<string, string>();
  const nonBeneficiaryColumns = new Set<string>();
  const decidedColumns = new Set<string>();
  for (const c of columns) {
    const key = columnKey(c.importSessionId, c.sheetIndex, c.columnIndex);
    if (c.decision === 'beneficiary' && c.beneficiaryOrganizationId) beneficiaryByColumn.set(key, c.beneficiaryOrganizationId);
    else if (c.decision === 'non_beneficiary') nonBeneficiaryColumns.add(key);
    if (c.decision !== null) decidedColumns.add(key);
  }
  return { beneficiaryByColumn, nonBeneficiaryColumns, decidedColumns };
}

/**
 * CN-UI-R1 — the need-line beneficiary of ONE source record, in the server's
 * order (M217 `set_need_line`, M216 `_resolve_region_v1` and the linked-cell
 * rule). Pure; reads only the record's own persisted provenance:
 *   1. sheet and column must be safely extractable, or nothing resolves;
 *   2. a column no ACTIVE version of the same session and sheet spans keeps
 *      the M213 rule exactly as before;
 *   3. a region-governed column never consults M213 for its beneficiary: an
 *      M213 row there is a grain conflict, and the cell resolves only through
 *      exactly one covering ACTIVE version — `beneficiary` with a non-null
 *      beneficiary. Uncovered, unlocatable row, overlapping, `non_beneficiary`
 *      or a null beneficiary never designate.
 */
export function resolveNeedLineBeneficiary(
  record: { importSessionId: string; sourceProvenance: unknown },
  active: readonly BeneficiaryRegionVersion[],
  columns: ColumnDecisionIndex,
): NeedLineBeneficiary {
  const { sheetIndex, row, column } = safeCellOf(record.sourceProvenance);
  if (sheetIndex === null || column === null) return { state: 'blocked', code: 'beneficiary_column_mapping_required' };
  const key = columnKey(record.importSessionId, sheetIndex, column);

  if (!regionGovernsColumn(active, record.importSessionId, sheetIndex, column)) {
    const beneficiaryOrganizationId = columns.beneficiaryByColumn.get(key);
    if (beneficiaryOrganizationId) return { state: 'beneficiary', beneficiaryOrganizationId, grain: 'column' };
    if (columns.nonBeneficiaryColumns.has(key)) return { state: 'non_beneficiary', grain: 'column' };
    return { state: 'unresolved' };
  }

  if (columns.decidedColumns.has(key)) return { state: 'blocked', code: 'beneficiary_decision_grain_conflict' };
  if (row === null) return { state: 'blocked', code: 'beneficiary_region_required' };
  const covering = active.filter((v) => v.importSessionId === record.importSessionId && v.sheetIndex === sheetIndex
    && v.rowStart <= row && row <= v.rowEnd && spansColumn(v, column));
  if (covering.length === 0) return { state: 'blocked', code: 'beneficiary_region_required' };
  if (covering.length > 1) return { state: 'blocked', code: 'beneficiary_region_overlap' };
  const version = covering[0];
  if (version.decision !== 'beneficiary') return { state: 'non_beneficiary', grain: 'region' };
  if (!version.beneficiaryOrganizationId) return { state: 'blocked', code: 'beneficiary_regions_read_inconsistent' };
  return { state: 'beneficiary', beneficiaryOrganizationId: version.beneficiaryOrganizationId, grain: 'region' };
}

export type DraftObstacleReason = 'REGION_OVERLAP' | 'M213_COLUMN';

export interface DraftObstacle {
  draftId: string;
  reason: DraftObstacleReason;
  /** The ACTIVE version id, or the M213 column index, in the way. */
  conflict: string;
}

/**
 * The E2-C NEED_OVERLAP pre-check extended to persisted truth: an unsaved
 * draft may not intersect any ACTIVE version, nor span an M213-decided column
 * — except a column the human explicitly chose to convert in this same call.
 * E2-C's own rules keep applying to the drafts among themselves.
 */
export function draftObstacles(
  drafts: readonly InstitutionMapping[],
  active: readonly BeneficiaryRegionVersion[],
  m213: readonly ScopeColumnMapping[],
  converting: ReadonlySet<number>,
): DraftObstacle[] {
  const out: DraftObstacle[] = [];
  for (const draft of drafts) {
    const b = boundsOfNeed(draft.need);
    for (const v of active) if (boundsIntersect(v, b)) out.push({ draftId: draft.id, reason: 'REGION_OVERLAP', conflict: v.versionId });
    for (const m of m213) {
      if (!converting.has(m.columnIndex) && spansColumn(b, m.columnIndex)) {
        out.push({ draftId: draft.id, reason: 'M213_COLUMN', conflict: String(m.columnIndex) });
      }
    }
  }
  return out;
}

/** One explicit `add` per committed E2-C draft: its own rectangle and its own chosen beneficiary. Anchors are never sent. */
export function addsFromDrafts(drafts: readonly InstitutionMapping[]): BeneficiaryRegionChange[] {
  return drafts.map((d) => ({ op: 'add', ...boundsOfNeed(d.need), decision: 'beneficiary', beneficiaryOrganizationId: d.beneficiaryOrganizationId }));
}

/** The conversion item for one M213 row: its fence verbatim, nothing else from it. */
export function conversionOf(m: ScopeColumnMapping): BeneficiaryRegionChange {
  return {
    op: 'convert_column',
    columnIndex: m.columnIndex,
    expectedMappingId: m.mappingId,
    previousDecision: m.decision,
    previousBeneficiaryOrganizationId: m.beneficiaryOrganizationId,
    previousMappedAt: m.mappedAt,
  };
}

/** Every converted column needs at least one new rectangle over it in the same call (the server refuses otherwise). */
export function conversionsWithoutRegion(converting: ReadonlySet<number>, changes: readonly BeneficiaryRegionChange[]): number[] {
  const rects = changes.filter((c): c is Extract<BeneficiaryRegionChange, { op: 'add' | 'replace' }> => c.op === 'add' || c.op === 'replace');
  return [...converting].sort((a, b) => a - b).filter((col) => !rects.some((r) => spansColumn(r, col)));
}

const TEXT_FIELDS = ['contractVersion', 'sheetjsVersion', 'sheetjsTarballSha256'] as const;

/**
 * G3 — a region may be written only from a grid rendered by the parser that
 * imported the session (contract version, SheetJS version and tarball hash).
 * Anything unknown or different keeps the layer read-only. This stays a
 * client-side guarantee; the server's witness can only refuse.
 */
export function renderedParserMatchesSession(
  rendered: RenderedParserIdentity | null,
  sessionIdentity: Record<string, unknown> | null,
): boolean {
  if (!rendered || !sessionIdentity) return false;
  return TEXT_FIELDS.every((k) => typeof rendered[k] === 'string' && rendered[k] !== '' && rendered[k] === sessionIdentity[k]);
}

/** The revision-wide ACTIVE regions as the screen loaded them, or why they could not be read. */
export type RegionReadState =
  | { phase: 'ready'; versions: readonly BeneficiaryRegionVersion[] }
  | { phase: 'unavailable'; code: string };

/** The unsaved E2-C Need sources of one sheet, as the workspace shares them. */
export interface UnsavedDraftSources {
  importSessionId: string;
  sheetIndex: number;
  needs: readonly RegionBounds[];
}

/**
 * Simple Mode's one-click M213 whole-column confirm is NOT offered for a column
 * that intersects an ACTIVE version or an unsaved E2-C draft Need source — nor
 * while the region layer could not be read (it cannot then be shown safe).
 */
export function oneClickConfirmSuppressed(
  column: { importSessionId: string; sheetIndex: number; columnIndex: number },
  regions: RegionReadState,
  drafts: UnsavedDraftSources | null,
): boolean {
  if (regions.phase !== 'ready') return true;
  if (regionGovernsColumn(regions.versions, column.importSessionId, column.sheetIndex, column.columnIndex)) return true;
  return !!drafts
    && drafts.importSessionId === column.importSessionId
    && drafts.sheetIndex === column.sheetIndex
    && drafts.needs.some((b) => spansColumn(b, column.columnIndex));
}

function columnLetters(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** A1 label of a stored rectangle, display only ("C:C" for a whole column). */
export function boundsLabel(b: RegionBounds): string {
  const cols = b.columnStart === b.columnEnd ? columnLetters(b.columnStart) : `${columnLetters(b.columnStart)}:${columnLetters(b.columnEnd)}`;
  if (b.rowStart === 0 && b.rowEnd === REGION_WHOLE_COLUMN_ROW_END) {
    return b.columnStart === b.columnEnd ? `${cols}:${cols}` : cols;
  }
  return `${columnLetters(b.columnStart)}${b.rowStart + 1}:${columnLetters(b.columnEnd)}${b.rowEnd + 1}`;
}
