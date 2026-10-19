/**
 * R1-A3 — the ONE integration point of the Excel identity assist.
 *
 * A future screen reaches the assist only through `runIdentityAssist` (re-exported by ./index.ts). The lower-level
 * extractor is deliberately not exported from the package entry, and a static test fails if any other module imports it.
 * This function adds the product rules on top of the extractor:
 *   * the header row MUST be the one the person confirmed; without it nothing is read and the resolver is never called;
 *   * the resolver is called with the typed code or name only — never with any other cell;
 *   * the answer carries identity suggestions only (no quantity, no stock);
 *   * the number of lookups is bounded.
 */
import { extractIdentityCandidates, type IdentityCandidate, type IdentityExtraction, type SheetCells } from './identity-extract';
import { suggestForCandidate, type IdentityResolver, type IdentitySuggestion } from './identity-suggest';

export const MAX_IDENTITY_LOOKUPS = 200;

export interface IdentityAssistInput {
  sheet: SheetCells;
  sheetIndex: number;
  /** The header row the person confirmed (zero-based). `undefined` = not confirmed yet => the assist refuses to read. */
  confirmedHeaderRow: number | undefined;
  resolve: IdentityResolver;
}

export interface IdentityAssistResult {
  extraction: IdentityExtraction;
  items: Array<{ candidate: IdentityCandidate; suggestion: IdentitySuggestion }>;
  /** True when more candidates exist than the lookup bound; the rest were not looked up. */
  truncated: boolean;
}

export async function runIdentityAssist(input: IdentityAssistInput): Promise<IdentityAssistResult> {
  const extraction = extractIdentityCandidates(
    input.sheet,
    input.sheetIndex,
    { headerRow: input.confirmedHeaderRow as number },     // run-time guard inside the extractor handles `undefined`
  );
  const wanted = extraction.candidates.slice(0, MAX_IDENTITY_LOOKUPS);
  const items: IdentityAssistResult['items'] = [];
  for (const candidate of wanted) {
    items.push({ candidate, suggestion: await suggestForCandidate(candidate, input.resolve) });
  }
  return { extraction, items, truncated: extraction.candidates.length > wanted.length };
}
