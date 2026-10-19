/**
 * R1-A3 — turns an identity candidate into a SUGGESTION for a registered central item.
 *
 * A suggestion is never a decision: the person confirms an active central_item_id (or files a PRE3-C
 * registration request, which is HELD — its contract text is not in the repository). The resolver is the
 * existing RLS-bound one (injected); this module only classifies its answer and strips everything that is
 * not identity (stock lots, on-hand, availability) so none of it can travel with a suggestion.
 */
import type { IdentityCandidate } from './identity-extract';

/** The catalog-identity fields this module reads from the existing resolver's answer. */
export interface ResolverHit {
  source: 'catalog' | 'stock';
  centralItemId: string | null;
  scientificName: string;
  nameAr?: string | null;
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  unit: string | null;
  nationalCode: string | null;
  grade: 'confirmed' | 'strong' | 'probable';
}

export type IdentityResolver = (query: string) => Promise<ReadonlyArray<ResolverHit>>;

export type SuggestionKind = 'exact_unique' | 'ambiguous' | 'conflict' | 'none' | 'lookup_failed';

export interface IdentitySuggestion {
  kind: SuggestionKind;
  /** Identity-only options; never a stock lot, never a quantity. */
  options: Array<{
    centralItemId: string;
    scientificName: string;
    nameAr: string | null;
    tradeName: string | null;
    concentration: string | null;
    dosageForm: string | null;
    unit: string | null;
    nationalCode: string | null;
    grade: ResolverHit['grade'];
    conflicts: Array<'strength' | 'form' | 'unit' | 'code'>;
  }>;
}

const squash = (v: string | null | undefined) => (v ?? '').normalize('NFKC').toLowerCase().replace(/[\s,]+/g, '').replace(/ملغم|ملجم|mgs?/g, 'mg');

/** Two descriptors conflict only when BOTH sides carry a value and the values differ. */
const differs = (a: string | null | undefined, b: string | null | undefined) => {
  const x = squash(a); const y = squash(b);
  return x !== '' && y !== '' && x !== y;
};

export async function suggestForCandidate(c: IdentityCandidate, resolve: IdentityResolver): Promise<IdentitySuggestion> {
  let hits: ReadonlyArray<ResolverHit>;
  try {
    hits = await resolve(c.code ?? c.name);
  } catch {
    // an API failure is NOT "no match"
    return { kind: 'lookup_failed', options: [] };
  }
  const seen = new Set<string>();
  const options: IdentitySuggestion['options'] = [];
  for (const h of hits) {
    if (h.source !== 'catalog' || !h.centralItemId || seen.has(h.centralItemId)) continue;   // stock lots are not identity
    seen.add(h.centralItemId);
    const conflicts: IdentitySuggestion['options'][number]['conflicts'] = [];
    if (differs(c.strength, h.concentration)) conflicts.push('strength');
    if (differs(c.form, h.dosageForm)) conflicts.push('form');
    if (differs(c.unit, h.unit)) conflicts.push('unit');
    if (differs(c.code, h.nationalCode)) conflicts.push('code');
    options.push({
      centralItemId: h.centralItemId, scientificName: h.scientificName, nameAr: h.nameAr ?? null, tradeName: h.tradeName,
      concentration: h.concentration, dosageForm: h.dosageForm, unit: h.unit, nationalCode: h.nationalCode, grade: h.grade, conflicts,
    });
  }
  if (options.length === 0) return { kind: 'none', options };
  if (options.length > 1) return { kind: 'ambiguous', options };
  const only = options[0];
  if (only.conflicts.length > 0) return { kind: 'conflict', options };
  // a unique, conflict-free, CONFIRMED hit may be suggested; anything weaker stays ambiguous for a human
  return only.grade === 'confirmed' ? { kind: 'exact_unique', options } : { kind: 'ambiguous', options };
}
