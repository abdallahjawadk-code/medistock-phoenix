/** C3 Node-only computation core. No HTTP, database, browser claims or writes.
 * A trusted future adapter must load both original bytes and template registry;
 * a computed candidate alone is neither an attestation nor legal approval. */
import { createHash } from 'node:crypto';
import { CN2A_CONTRACT_VERSION, type CellEvidence, type ParserIdentity } from '../import/contract';
import { replayWorkbook } from '../import/node-replay';
import { extractAnnualIdentityBlock } from './annual-catalog-source';
import { assertAnnualScope, assertSameAnnualScope } from './annual-catalog.model';
import type { AnnualCatalogScope, AnnualSourceBlock, AnnualSourceOccurrence } from './annual-catalog.contract';

export interface AnnualExtractionTemplate {
  id: string;
  version: number;
  reviewReference: string;
  parserContractVersion: string;
  blocks: AnnualSourceBlock[];
  classificationCells: { blockId: string; row: number; column: number; expectedText: string }[];
}
export interface AnnualExtractionOriginal {
  /** Local corpus candidates can never be represented as C2 receipts. */
  origin: 'c2_original' | 'local_corpus_review';
  scope: AnnualCatalogScope;
  originalId: string;
  filename: string;
  sha256: string;
  byteSize: number;
  bytes: Uint8Array;
}
interface ExtractionInput {
  scope: AnnualCatalogScope;
  original: AnnualExtractionOriginal;
  templateId: string;
  templateVersion: number;
}
export type AnnualExtractionResult = {
  status: 'prepared';
  kind: 'annual_identity_extraction_candidate';
  scope: AnnualCatalogScope;
  originalId: string;
  originalSha256: string;
  sourceOrigin: AnnualExtractionOriginal['origin'];
  originalFilename: string;
  originalByteSize: number;
  parser: ParserIdentity;
  template: { id: string; version: number; reviewReference: string; sha256: string };
  classifications: { blockId: string; sheetIndex: number; cell: CellEvidence }[];
  occurrences: AnnualSourceOccurrence[];
} | {
  status: 'held';
  reason: 'template_unavailable' | 'parse_rejected' | 'template_conflict' | 'classification_conflict';
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= 255 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const sourceText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= 4000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value);
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const key = (id: string, version: number) => JSON.stringify([id, version]);

/** Explicit registration only: callers must not construct this registry from a
 * browser mapping, filename guess, one employee correction or received hash. */
export function createAnnualExtractionEngine(definitions: readonly AnnualExtractionTemplate[]) {
  if (definitions.length > 100) throw new Error('annual_extraction_template_invalid');
  const registry = new Map<string, { definition: AnnualExtractionTemplate; sha256: string }>();
  for (const definition of definitions) {
    if (!text(definition.id) || !text(definition.reviewReference) || !Number.isSafeInteger(definition.version) || definition.version < 1
      || definition.parserContractVersion !== CN2A_CONTRACT_VERSION || !Array.isArray(definition.blocks)
      || definition.blocks.length < 1 || definition.blocks.length > 32 || !Array.isArray(definition.classificationCells)
      || definition.classificationCells.length > definition.blocks.length
      || definition.classificationCells.some(anchor => !definition.blocks.some(block => block.blockId === anchor.blockId)
        || !Number.isSafeInteger(anchor.row) || anchor.row < 0 || !Number.isSafeInteger(anchor.column) || anchor.column < 0
        || !sourceText(anchor.expectedText))
      || new Set(definition.blocks.map(block => block.blockId)).size !== definition.blocks.length) {
      throw new Error('annual_extraction_template_invalid');
    }
    const id = key(definition.id, definition.version);
    if (registry.has(id)) throw new Error('annual_extraction_template_invalid');
    // Capture exact definition bytes and isolate all nested caller references.
    const serialized = JSON.stringify(definition);
    registry.set(id, { definition: JSON.parse(serialized) as AnnualExtractionTemplate, sha256: digest(serialized) });
  }
  return {
    async extract(input: ExtractionInput): Promise<AnnualExtractionResult> {
      assertAnnualScope(input.scope);
      assertSameAnnualScope(input.scope, input.original.scope);
      const original = input.original;
      // Match C2's small-file ceiling; no archive queue or broader transport.
      const validReference = original.origin === 'c2_original'
        ? uuid.test(original.originalId) && uuid.test(original.scope.ownerOrgId)
        : original.origin === 'local_corpus_review' && original.scope.ownerOrgId === 'local-corpus-review'
          && original.originalId === `corpus:${original.sha256}`;
      if (!validReference || !text(original.filename)
        || original.filename !== original.filename.trim() || original.filename.startsWith('~$')
        || /[\/\\\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(original.filename)
        || !/\.(xls|xlsx|csv)$/i.test(original.filename) || !/^[0-9a-f]{64}$/.test(original.sha256)
        || !(original.bytes instanceof Uint8Array) || !Number.isSafeInteger(original.byteSize)
        || original.byteSize < 1 || original.byteSize > 3_145_728 || original.bytes.length !== original.byteSize) {
        throw new Error('annual_extraction_original_mismatch');
      }
      // Snapshot before awaiting the parser; later caller mutation cannot change
      // either the verified bytes or the source scope attached to their output.
      const bytes = new Uint8Array(original.bytes);
      const source = { scope: { ...input.scope }, originalId: original.originalId, filename: original.filename,
        sha256: original.sha256, byteSize: original.byteSize, origin: original.origin };
      if (digest(bytes) !== source.sha256) throw new Error('annual_extraction_original_mismatch');
      const registered = registry.get(key(input.templateId, input.templateVersion));
      if (!registered) return { status: 'held', reason: 'template_unavailable' };
      const template = registered.definition;
      const parsed = await replayWorkbook(bytes, source.filename);
      if (parsed.outcome !== 'accepted' || !parsed.workbook || parsed.input.sha256 !== source.sha256
        || parsed.input.byteSize !== source.byteSize) return { status: 'held', reason: 'parse_rejected' };
      const classifications: Extract<AnnualExtractionResult, { status: 'prepared' }>['classifications'] = [];
      for (const block of template.blocks) {
        const anchors = template.classificationCells.filter(anchor => anchor.blockId === block.blockId);
        if (block.classification?.origin !== 'source') {
          if (anchors.length !== 0) return { status: 'held', reason: 'classification_conflict' };
          continue;
        }
        if (anchors.length !== 1) return { status: 'held', reason: 'classification_conflict' };
        const anchor = anchors[0];
        const sheet = parsed.workbook.sheets.find(sheet => sheet.index === block.sheetIndex);
        const cell = sheet?.cells.find(cell => cell.coordinate.row === anchor.row && cell.coordinate.col === anchor.column);
        if (!cell || cell.presence !== 'value' || cell.isFormula || cell.valueType !== 'string'
          || cell.rawValue !== anchor.expectedText || cell.rawValue !== block.classification.label) {
          return { status: 'held', reason: 'classification_conflict' };
        }
        classifications.push({ blockId: block.blockId, sheetIndex: block.sheetIndex, cell: {
          coordinate: { ...cell.coordinate }, presence: 'value', valueType: 'string', rawValue: cell.rawValue,
          ...(cell.formattedText === undefined ? {} : { formattedText: cell.formattedText }),
          isFormula: false, hasComment: cell.hasComment,
        } });
      }
      const occurrences: AnnualSourceOccurrence[] = [];
      try {
        for (const block of template.blocks) occurrences.push(...extractAnnualIdentityBlock({ scope: source.scope,
          sourceScope: source.scope, sourceId: source.originalId, parsed, block }));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('annual_catalog_')) return { status: 'held', reason: 'template_conflict' };
        throw error;
      }
      return { status: 'prepared', kind: 'annual_identity_extraction_candidate', scope: source.scope,
        originalId: source.originalId, originalSha256: source.sha256, sourceOrigin: source.origin, originalFilename: source.filename,
        originalByteSize: source.byteSize, parser: { ...parsed.identity },
        template: { id: template.id, version: template.version, reviewReference: template.reviewReference, sha256: registered.sha256 },
        classifications, occurrences };
    },
  };
}
