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
  REGION_WHOLE_COLUMN_ROW_END,
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
  m213: readonly ScopeColumnMapping[],
): { columnIndex: number; versionId: string } | null {
  for (const m of m213) {
    const hit = active.find((v) => v.importSessionId === m.importSessionId && v.sheetIndex === m.sheetIndex && spansColumn(v, m.columnIndex));
    if (hit) return { columnIndex: m.columnIndex, versionId: hit.versionId };
  }
  return null;
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
