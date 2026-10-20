/**
 * R1-A3 — public surface of the Excel identity assist.
 * The raw extractor (`extractIdentityCandidates`) is intentionally NOT exported here: the only way in is
 * `runIdentityAssist`, which refuses to read a worksheet whose header row the person has not confirmed.
 * `lazySheetCells` adapts the existing parse evidence without reading any cell the extractor does not ask for.
 */
export { runIdentityAssist, MAX_IDENTITY_LOOKUPS } from './identity-assist';
export { lazySheetCells } from './sheet-adapter';
export type { EvidenceSheetLike, EvidenceCellLike } from './sheet-adapter';
export type { IdentityAssistInput, IdentityAssistResult } from './identity-assist';
export type { IdentityCandidate, IdentityExtraction, IdentityWarning, SheetCells, CellValue } from './identity-extract';
export type { IdentityResolver, IdentitySuggestion, ResolverHit, SuggestionKind } from './identity-suggest';
