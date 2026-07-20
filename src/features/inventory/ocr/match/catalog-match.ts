import { normalizeForMatching } from '../parse/normalize';

/**
 * PHARMA-OCR-A — matching OCR candidates against the authorized material catalog.
 *
 * The governing rule: OCR NEVER creates a material. A failure to match produces
 * `no_match`, which the review UI turns into "select a material manually" — it
 * does not become a new catalog row. Auto-creating materials from a misread
 * label is exactly how a catalog fills with near-duplicate garbage that later
 * splits stock across phantom entries.
 *
 * Ambiguity is surfaced, never resolved silently: if two catalog entries are
 * credible, the operator picks.
 */

export interface CatalogMaterial {
  id: string;
  scientificName: string;
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  unit: string | null;
  nationalCode: string | null;
}

export interface MatchQuery {
  scientificName?: string | null;
  tradeName?: string | null;
  concentration?: string | null;
  dosageForm?: string | null;
  nationalCode?: string | null;
}

export type MatchTier =
  | 'national_code'
  | 'scientific_exact'
  | 'scientific_concentration_form'
  | 'fuzzy';

export interface MatchCandidate {
  material: CatalogMaterial;
  tier: MatchTier;
  /** 0–1. For fuzzy this is similarity; for exact tiers it is 1. */
  score: number;
  /** Fields that agreed, for the "why did it match?" explanation. */
  agreeingFields: string[];
  /** Fields present on both sides that DISAGREED — shown as conflicts. */
  conflictingFields: string[];
}

export type MatchOutcome =
  | { kind: 'no_match' }
  | { kind: 'unique'; candidate: MatchCandidate }
  | { kind: 'ambiguous'; candidates: MatchCandidate[] };

/** Damerau-free Levenshtein, iterative, adequate for short drug names. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/** Normalized similarity in 0–1. */
export function similarity(a: string, b: string): number {
  const left = normalizeForMatching(a);
  const right = normalizeForMatching(b);
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

/** Below this a fuzzy candidate is not worth showing at all. */
export const FUZZY_FLOOR = 0.72;
/** A fuzzy match this strong, with no rival close behind, may stand alone. */
export const FUZZY_UNIQUE_FLOOR = 0.88;
/** Two candidates within this margin are treated as ambiguous. */
export const AMBIGUITY_MARGIN = 0.06;

function compareFields(query: MatchQuery, material: CatalogMaterial) {
  const agreeing: string[] = [];
  const conflicting: string[] = [];

  const check = (name: string, left: string | null | undefined, right: string | null) => {
    if (!left || !right) return; // Absent on either side is not a conflict.
    const same = normalizeForMatching(left) === normalizeForMatching(right);
    (same ? agreeing : conflicting).push(name);
  };

  check('scientificName', query.scientificName, material.scientificName);
  check('tradeName', query.tradeName, material.tradeName);
  check('concentration', query.concentration, material.concentration);
  check('dosageForm', query.dosageForm, material.dosageForm);
  check('nationalCode', query.nationalCode, material.nationalCode);

  return { agreeing, conflicting };
}

/**
 * Rank catalog candidates for one OCR reading.
 *
 * Tier order is strict — a national-code hit is never outranked by a better
 * fuzzy name score, because the code is the authoritative identifier.
 */
export function matchCatalog(query: MatchQuery, catalog: readonly CatalogMaterial[]): MatchOutcome {
  const hasSignal = Boolean(query.nationalCode || query.scientificName || query.tradeName);
  if (!hasSignal || catalog.length === 0) return { kind: 'no_match' };

  // ── Tier 1: exact national code ──
  if (query.nationalCode) {
    const wanted = normalizeForMatching(query.nationalCode);
    const hits = catalog.filter(m => m.nationalCode && normalizeForMatching(m.nationalCode) === wanted);
    if (hits.length === 1) {
      const { agreeing, conflicting } = compareFields(query, hits[0]);
      return {
        kind: 'unique',
        candidate: { material: hits[0], tier: 'national_code', score: 1, agreeingFields: agreeing, conflictingFields: conflicting },
      };
    }
    if (hits.length > 1) {
      // A duplicated national code in the catalog is a data problem the
      // operator must see, not something to silently pick a winner from.
      return {
        kind: 'ambiguous',
        candidates: hits.map(material => {
          const { agreeing, conflicting } = compareFields(query, material);
          return { material, tier: 'national_code' as const, score: 1, agreeingFields: agreeing, conflictingFields: conflicting };
        }),
      };
    }
  }

  // ── Tier 2: exact normalized scientific name ──
  if (query.scientificName) {
    const wanted = normalizeForMatching(query.scientificName);
    const hits = catalog.filter(m => normalizeForMatching(m.scientificName) === wanted);

    if (hits.length === 1) {
      const { agreeing, conflicting } = compareFields(query, hits[0]);
      return {
        kind: 'unique',
        candidate: { material: hits[0], tier: 'scientific_exact', score: 1, agreeingFields: agreeing, conflictingFields: conflicting },
      };
    }

    // ── Tier 3: same name, disambiguated by concentration + dosage form ──
    if (hits.length > 1) {
      const refined = hits.filter(m => {
        const concentrationOk = !query.concentration || !m.concentration
          || normalizeForMatching(query.concentration) === normalizeForMatching(m.concentration);
        const formOk = !query.dosageForm || !m.dosageForm
          || normalizeForMatching(query.dosageForm) === normalizeForMatching(m.dosageForm);
        return concentrationOk && formOk;
      });
      const pool = refined.length > 0 ? refined : hits;
      const candidates = pool.map(material => {
        const { agreeing, conflicting } = compareFields(query, material);
        return {
          material,
          tier: 'scientific_concentration_form' as const,
          score: 1,
          agreeingFields: agreeing,
          conflictingFields: conflicting,
        };
      });
      return candidates.length === 1
        ? { kind: 'unique', candidate: candidates[0] }
        : { kind: 'ambiguous', candidates };
    }
  }

  // ── Tier 4: ranked fuzzy over scientific and trade names ──
  const probe = query.scientificName || query.tradeName || '';
  const scored = catalog
    .map(material => {
      const score = Math.max(
        similarity(probe, material.scientificName),
        material.tradeName ? similarity(probe, material.tradeName) : 0,
      );
      const { agreeing, conflicting } = compareFields(query, material);
      return { material, tier: 'fuzzy' as const, score, agreeingFields: agreeing, conflictingFields: conflicting };
    })
    .filter(candidate => candidate.score >= FUZZY_FLOOR)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: 'no_match' };

  const [top, runnerUp] = scored;
  const clearWinner =
    top.score >= FUZZY_UNIQUE_FLOOR && (!runnerUp || top.score - runnerUp.score > AMBIGUITY_MARGIN);

  // Even a "clear" fuzzy winner still requires explicit operator confirmation
  // downstream — see REQUIRED_CONFIRMATION_FIELDS in confidence.ts.
  return clearWinner
    ? { kind: 'unique', candidate: top }
    : { kind: 'ambiguous', candidates: scored.slice(0, 5) };
}
