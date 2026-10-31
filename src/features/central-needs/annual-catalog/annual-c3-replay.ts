/**
 * C3-1a: read-only, server-side annual evidence replay. NOT a public endpoint.
 * A hosting adapter must authenticate and authorize via the caller's JWT,
 * read actual C2 bytes, and isolate/terminate the parser before exposing this.
 * This module NEVER approves legal identities, units, quantities or membership.
 */
import { CN2A_CONTRACT_VERSION, SHEETJS_VERSION, SHEETJS_TARBALL_SHA256,
  type WorkbookFileFormat } from '../import/contract';
import { replayWorkbook } from '../import/node-replay';
import { sha256Hex } from '../import/parser-core';
import { SOURCE_IDENTITY_FIELDS, type AnnualCatalogScope, type AnnualSourceBlock, type AnnualSourceOccurrence } from './annual-catalog.contract';
import { assertAnnualScope, assertSameAnnualScope, annualScopeKey } from './annual-catalog.model';
import { extractAnnualIdentityBlock } from './annual-catalog-source';
import { ANNUAL_ORIGINAL_ATTESTATION, ANNUAL_ORIGINAL_MAX_BYTES, annualOriginalFilename,
  type AnnualOriginal } from './annual-originals.contract';

export const C3_REPLAY_LIMITS = {
  maxFileBytes: ANNUAL_ORIGINAL_MAX_BYTES, maxBlocks: 8, maxRows: 5000,
  defaultPageSize: 25, maxPageSize: 50, maxResponseBytes: 262144, maxCursorChars: 256,
} as const;

/** The manifest is a SERVER-APPROVED review artifact, never a request payload. */
/** Evidence of a category written in the original workbook, not a legal category. */
export interface C3SourceClassificationCell {
  readonly row: number;
  readonly col: number;
  readonly a1: string;
  readonly expectedText: string;
}
export interface C3TemplateBlock extends AnnualSourceBlock {
  /** Required if classification.origin is source; exact physical cell proof. */
  readonly classificationCell?: C3SourceClassificationCell;
}
export interface C3TemplateManifest {
  readonly templateId: string;
  readonly version: string;
  readonly reviewReference: string;
  readonly parserContractVersion: typeof CN2A_CONTRACT_VERSION;
  readonly sheetjsVersion: typeof SHEETJS_VERSION;
  readonly sheetjsTarballSha256: typeof SHEETJS_TARBALL_SHA256;
  readonly allowedFormats: readonly WorkbookFileFormat[];
  readonly blocks: readonly C3TemplateBlock[];
}

export interface C3PinnedTemplate {
  readonly manifest: C3TemplateManifest;
  readonly expectedSha256: string;
}

export interface C3ReplayInput {
  readonly scope: AnnualCatalogScope;
  /** Bound to C2's authenticated download response, not supplied by client. */
  readonly originalScope: AnnualCatalogScope;
  readonly original: AnnualOriginal;
  readonly bytes: Uint8Array;
  readonly reviewedTemplate: C3PinnedTemplate;
  readonly pageSize?: number;
  readonly cursor?: string | null;
}

export interface C3ReplayPage {
  readonly scope: AnnualCatalogScope;
  readonly original: { readonly originalId: string; readonly sha256: string;
    readonly byteSize: number; readonly attestation: typeof ANNUAL_ORIGINAL_ATTESTATION };
  readonly parser: { readonly contractVersion: string; readonly sheetjsVersion: string;
    readonly sheetjsTarballSha256: string; readonly runtime: 'node' };
  readonly template: { readonly id: string; readonly version: string;
    readonly sha256: string; readonly reviewReference: string };
  readonly status: 'source_evidence_only_review_required';
  /** Exact original-cell proof for source classifications; never a catalog approval. */
  readonly sourceClassifications: readonly {
    blockId: string; sheetIndex: number; sheetName: string;
    coordinate: { row: number; col: number; a1: string };
    rawText: string;
  }[];
  readonly rows: readonly AnnualSourceOccurrence[];
  readonly totalRows: number;
  readonly nextCursor: string | null;
}
function check(ok: boolean, code: string): asserts ok {
  if (!ok) throw new Error('annual_c3_' + code);
}
function sourceA1(row: number, col: number): string {
  let index = col + 1;
  let name = '';
  while (index > 0) {
    index--;
    name = String.fromCharCode(65 + index % 26) + name;
    index = Math.floor(index / 26);
  }
  return name + String(row + 1);
}
function validUuid(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function validTemplate(manifest: C3TemplateManifest): void {
  check(manifest !== null && typeof manifest === 'object', 'template_invalid');
  check(typeof manifest.templateId === 'string' && /^[a-z0-9][a-z0-9._-]{2,79}$/i.test(manifest.templateId)
    && typeof manifest.version === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.version)
    && typeof manifest.reviewReference === 'string' && manifest.reviewReference.length >= 8
    && manifest.reviewReference.length <= 256 && manifest.reviewReference === manifest.reviewReference.trim(),
    'template_identity_invalid');
  check(manifest.parserContractVersion === CN2A_CONTRACT_VERSION
    && manifest.sheetjsVersion === SHEETJS_VERSION
    && manifest.sheetjsTarballSha256 === SHEETJS_TARBALL_SHA256, 'template_parser_mismatch');
  check(Array.isArray(manifest.allowedFormats) && manifest.allowedFormats.length > 0
    && new Set(manifest.allowedFormats).size === manifest.allowedFormats.length
    && manifest.allowedFormats.every((x) => ['xls', 'xlsx', 'csv'].includes(x)), 'template_formats_invalid');
  check(Array.isArray(manifest.blocks) && manifest.blocks.length > 0
    && manifest.blocks.length <= C3_REPLAY_LIMITS.maxBlocks, 'template_blocks_invalid');
  const ids = new Set<string>();
  let count = 0;
  for (const block of manifest.blocks) {
    check(block !== null && typeof block === 'object' && typeof block.blockId === 'string'
      && !ids.has(block.blockId), 'template_block_invalid');
    ids.add(block.blockId);
    check(Number.isInteger(block.firstRow) && Number.isInteger(block.lastRow)
      && block.firstRow >= 0 && block.lastRow >= block.firstRow, 'template_rows_invalid');
    count += block.lastRow - block.firstRow + 1;
    check(count <= C3_REPLAY_LIMITS.maxRows, 'template_row_limit');
    // A template is permitted to quote a source category ONLY with a reviewed
    // physical coordinate. A free-text label alone is never source evidence.
    const category = block.classification;
    const witness = block.classificationCell;
    if (category?.origin === 'source') {
      check(witness !== undefined && typeof category.label === 'string'
        && category.label.length > 0 && category.label.length <= 4000
        && typeof witness.expectedText === 'string' && witness.expectedText === category.label
        && Number.isInteger(witness.row) && witness.row >= 0 && witness.row < block.firstRow
        && Number.isInteger(witness.col) && witness.col >= 0 && witness.col < 256
        && witness.a1 === sourceA1(witness.row, witness.col),
        'source_classification_not_proven');
    } else {
      check((category === null || category?.origin === 'proposed') && witness === undefined,
        'source_classification_not_proven');
    }
    const unit = block.columns?.unit;
    const label = unit?.expectedHeaderText?.trim().replace(/\s+/g, ' ');
    check(label !== 'وحدة المناعة' && label !== 'وحدة الهرمونات', 'department_not_a_unit');
  }
  // The real 2026 XLS corpus contains parallel material blocks in different
  // physical column lanes on overlapping rows. Keep each witness/block distinct.
  // A shared mapped column on overlapping rows is ambiguous and remains blocked.
  for (let i = 0; i < manifest.blocks.length; i += 1) {
    for (let j = i + 1; j < manifest.blocks.length; j += 1) {
      const a = manifest.blocks[i]; const b = manifest.blocks[j];
      if (a.sheetIndex !== b.sheetIndex || a.lastRow < b.firstRow || b.lastRow < a.firstRow) continue;
      const aColumns = new Set(SOURCE_IDENTITY_FIELDS.flatMap(field => {
        const selected = a.columns[field];
        return selected ? [selected.column] : [];
      }));
      const bColumns = new Set(SOURCE_IDENTITY_FIELDS.flatMap(field => {
        const selected = b.columns[field];
        return selected ? [selected.column] : [];
      }));
      check([...aColumns].every(column => !bColumns.has(column)), 'overlapping_blocks');
    }
  }
}
function makeCursor(binding: string, index: number): string {
  return btoa(JSON.stringify([1, binding, index])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function readCursor(token: string | null | undefined, binding: string): number {
  if (token === null || token === undefined) return 0;
  check(typeof token === 'string' && token.length > 0 && token.length <= C3_REPLAY_LIMITS.maxCursorChars
    && /^[A-Za-z0-9_-]+$/.test(token), 'cursor_invalid');
  try {
    const decoded: unknown = JSON.parse(atob(token.replace(/-/g, '+').replace(/_/g, '/')));
    check(Array.isArray(decoded) && decoded.length === 3 && decoded[0] === 1 && decoded[1] === binding
      && Number.isSafeInteger(decoded[2]) && decoded[2] >= 0, 'cursor_mismatch');
    return decoded[2] as number;
  } catch {
    throw new Error('annual_c3_cursor_invalid');
  }
}

/** Hashes a REVIEWED server manifest; client possession of a hash is not approval. */
export async function annualC3TemplateSha256(manifest: C3TemplateManifest): Promise<string> {
  validTemplate(manifest);
  return sha256Hex(new TextEncoder().encode(JSON.stringify(manifest)));
}

/**
 * Deterministic source review, not legally trusted catalog data.
 * No SQL, database, network, Storage, client attestations or write path.
 * Authentication and worker timeout/memory termination are NOT implemented here.
 */
export async function replayAnnualC3Evidence(input: C3ReplayInput): Promise<C3ReplayPage> {
  assertAnnualScope(input.scope);
  assertSameAnnualScope(input.scope, input.originalScope);
  const original = input.original;
  check(validUuid(original.originalId) && original.attestation === ANNUAL_ORIGINAL_ATTESTATION
    && typeof original.sha256 === 'string' && /^[0-9a-f]{64}$/.test(original.sha256)
    && Number.isSafeInteger(original.byteSize) && original.byteSize >= 1
    && original.byteSize <= C3_REPLAY_LIMITS.maxFileBytes, 'original_invalid');
  const filename = annualOriginalFilename(original.firstFilename);
  check(input.bytes instanceof Uint8Array && input.bytes.byteLength === original.byteSize, 'byte_size_mismatch');
  check(await sha256Hex(input.bytes) === original.sha256, 'sha256_mismatch');
  validTemplate(input.reviewedTemplate.manifest);
  check(typeof input.reviewedTemplate.expectedSha256 === 'string'
    && /^[0-9a-f]{64}$/.test(input.reviewedTemplate.expectedSha256)
    && await annualC3TemplateSha256(input.reviewedTemplate.manifest) === input.reviewedTemplate.expectedSha256,
    'template_hash_mismatch');
  const pageSize = input.pageSize ?? C3_REPLAY_LIMITS.defaultPageSize;
  check(Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= C3_REPLAY_LIMITS.maxPageSize,
    'page_size_invalid');
  const parsed = await replayWorkbook(input.bytes, filename);
  check(parsed.outcome === 'accepted' && parsed.workbook !== null, 'parser_rejected');
  check(parsed.identity.contractVersion === CN2A_CONTRACT_VERSION
    && parsed.identity.sheetjsVersion === SHEETJS_VERSION
    && parsed.identity.sheetjsTarballSha256 === SHEETJS_TARBALL_SHA256
    && parsed.identity.runtime === 'node'
    && parsed.input.sha256 === original.sha256 && parsed.input.byteSize === original.byteSize
    && parsed.input.originalFilename === filename, 'parser_identity_mismatch');
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  check(parsed.workbook.format === extension
    && input.reviewedTemplate.manifest.allowedFormats.includes(parsed.workbook.format), 'format_mismatch');
  const rows: AnnualSourceOccurrence[] = [];
  const sourceClassifications: C3ReplayPage['sourceClassifications'][number][] = [];
  for (const block of input.reviewedTemplate.manifest.blocks) {
    const witness = block.classificationCell;
    if (witness) {
      const sheet = parsed.workbook.sheets.find(s => s.index === block.sheetIndex);
      check(sheet !== undefined, 'classification_sheet_missing');
      const matches = sheet.cells.filter(c => c.coordinate.row === witness.row && c.coordinate.col === witness.col);
      check(matches.length === 1, 'classification_cell_missing');
      const cell = matches[0];
      check(cell.coordinate.a1 === witness.a1 && cell.presence === 'value'
        && cell.valueType === 'string' && cell.isFormula === false
        && cell.rawValue === witness.expectedText,
        'classification_cell_mismatch');
      sourceClassifications.push({ blockId: block.blockId, sheetIndex: sheet.index, sheetName: sheet.name,
        coordinate: { ...cell.coordinate }, rawText: cell.rawValue });
    }
    rows.push(...extractAnnualIdentityBlock({
      scope: input.scope, sourceScope: input.originalScope, sourceId: original.originalId, parsed, block,
    }));
    check(rows.length <= C3_REPLAY_LIMITS.maxRows, 'mapped_row_limit');
  }
  rows.sort((a, b) => a.source.sheetIndex - b.source.sheetIndex || a.source.row - b.source.row
    || (a.source.blockId < b.source.blockId ? -1 : a.source.blockId > b.source.blockId ? 1 : 0));
  const binding = await sha256Hex(new TextEncoder().encode(JSON.stringify([
    annualScopeKey(input.scope), original.originalId, original.sha256, input.reviewedTemplate.expectedSha256,
    CN2A_CONTRACT_VERSION, SHEETJS_VERSION,
  ])));
  const offset = readCursor(input.cursor, binding);
  check(offset <= rows.length, 'cursor_range_invalid');
  const next = offset + pageSize < rows.length ? makeCursor(binding, offset + pageSize) : null;
  const result: C3ReplayPage = {
    scope: { ...input.scope },
    original: { originalId: original.originalId, sha256: original.sha256,
      byteSize: original.byteSize, attestation: ANNUAL_ORIGINAL_ATTESTATION },
    parser: { contractVersion: CN2A_CONTRACT_VERSION, sheetjsVersion: SHEETJS_VERSION,
      sheetjsTarballSha256: SHEETJS_TARBALL_SHA256, runtime: 'node' },
    template: { id: input.reviewedTemplate.manifest.templateId,
      version: input.reviewedTemplate.manifest.version, sha256: input.reviewedTemplate.expectedSha256,
      reviewReference: input.reviewedTemplate.manifest.reviewReference },
    status: 'source_evidence_only_review_required', sourceClassifications,
    rows: rows.slice(offset, offset + pageSize),
    totalRows: rows.length, nextCursor: next,
  };
  check(new TextEncoder().encode(JSON.stringify(result)).byteLength <= C3_REPLAY_LIMITS.maxResponseBytes,
    'response_too_large');
  return result;
}
