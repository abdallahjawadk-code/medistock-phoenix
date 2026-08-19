import type { CentralItem } from '@/shared/supabase/services/registry.service';
import type { CatalogMaterial } from './match/catalog-match';

/**
 * PHARMA-OCR-A — adapt the authorized central catalog to the matcher's shape.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * G3.2 — THE "KNOWN LIMITATION" THIS FILE DECLARED WAS OUT OF DATE
 * ─────────────────────────────────────────────────────────────────────────────
 * This module used to state that `central_items` carries only
 * (name, name_ar, unit, barcode), hard-code `concentration`, `dosageForm` and
 * `nationalCode` to null, and conclude that closing the gap "needs new catalog
 * columns, i.e. a migration".
 *
 * Migration 114 had ALREADY added `trade_name`, `concentration` and
 * `dosage_form` to `central_items`, and `registry.service.ts` had been reading
 * them for some time. The comment outlived the schema. Its practical cost was
 * real and recurring: tier 3 (name + concentration + dosage form) could never
 * discriminate, so every multi-strength molecule came back AMBIGUOUS and an
 * operator resolved by hand — on data the database could already have answered
 * with. The discriminators are now passed through.
 *
 * NATIONAL CODE (owner DECISION A, G3.2).
 * `central_items` has no `national_code` column and is not getting one:
 * Migration 114 states the contract explicitly — "`barcode` (already unique,
 * already indexed) continues to serve as the catalog's national-code identity
 * — no duplicate column" — and the owner reaffirmed it for G3.2. `barcode` is
 * therefore mapped to the catalog-level `nationalCode` semantic here, which
 * activates tier 1 (exact national code) against the real catalog for the first
 * time. This is a deliberate, documented mapping of ONE column to ONE semantic,
 * not a claim that a GTIN and a national registration code are interchangeable
 * in general. Should Phoenix ever need to carry BOTH identifiers separately,
 * that is new schema plus a fresh owner decision — and this comment exists so
 * that future change is made knowingly rather than by silent reinterpretation.
 *
 * WHAT DID NOT CHANGE, AND MUST NOT:
 *   OCR ASSISTS DISCOVERY. IT NEVER CREATES CANONICAL IDENTITY.
 *   A `no_match` still never becomes a catalog row. An `ambiguous` outcome is
 *   still surfaced for the operator rather than silently resolved. The fuzzy
 *   thresholds (FUZZY_FLOOR / FUZZY_UNIQUE_FLOOR / AMBIGUITY_MARGIN) are
 *   untouched — this unit improves matching by supplying REAL DISCRIMINATORS,
 *   which is the honest way to reduce ambiguity, never by lowering the bar for
 *   what counts as certain.
 */
export function toCatalogMaterials(items: readonly CentralItem[]): CatalogMaterial[] {
  return items
    .filter(item => item.status === 'active')
    .map(item => ({
      id: item.id,
      scientificName: item.name,
      // 114's real trade_name is used when the row has one. `name_ar` remains
      // the fallback ALTERNATE NAME for rows that predate 114 and carry none,
      // so an Arabic-language document can still match an English-named catalog
      // row. In that fallback case it is never presented as "the trade name".
      tradeName: blankToNull(item.trade_name) ?? blankToNull(item.name_ar),
      // 114 — the discriminators that let tier 3 tell two strengths apart.
      // A genuinely empty column still yields null: the fix is to stop
      // discarding real data, never to invent a value the catalog lacks.
      concentration: blankToNull(item.concentration),
      dosageForm: blankToNull(item.dosage_form),
      unit: blankToNull(item.unit),
      // DECISION A — the catalog's national-code identity is `barcode`.
      nationalCode: blankToNull(item.barcode),
    }));
}

/** '' / whitespace / undefined all collapse to null; a real value passes through. */
function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
