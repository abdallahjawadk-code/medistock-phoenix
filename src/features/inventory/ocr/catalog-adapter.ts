import type { CentralItem } from '@/shared/supabase/services/registry.service';
import type { CatalogMaterial } from './match/catalog-match';

/**
 * PHARMA-OCR-A — adapt the authorized central catalog to the matcher's shape.
 *
 * KNOWN LIMITATION, stated rather than papered over: `central_items` carries
 * only (name, name_ar, unit, barcode). It has NO concentration, dosage-form or
 * national-code column. Consequently:
 *
 *  - Tier 1 (exact national code) is implemented and unit-tested but is INERT
 *    against today's catalog, because `nationalCode` is always null here.
 *    `barcode` is deliberately NOT mapped into it: a barcode (GTIN) and a
 *    national registration code are different identifiers, and conflating them
 *    would produce confident wrong matches.
 *  - Tier 3 (name + concentration + dosage form) cannot discriminate, so two
 *    strengths of the same molecule resolve as AMBIGUOUS and the operator picks
 *    — which is the correct, safe outcome given the missing data.
 *
 * Closing this gap needs new catalog columns, i.e. a migration, which is out of
 * scope for this phase.
 */
export function toCatalogMaterials(items: readonly CentralItem[]): CatalogMaterial[] {
  return items
    .filter(item => item.status === 'active')
    .map(item => ({
      id: item.id,
      scientificName: item.name,
      // central_items has no distinct trade-name column. The Arabic name is
      // placed in this slot purely as an ALTERNATE NAME for fuzzy matching, so
      // an Arabic-language document can match an English-named catalog row. It
      // is never presented to the operator as "the trade name".
      tradeName: item.name_ar || null,
      concentration: null,
      dosageForm: null,
      unit: item.unit ?? null,
      nationalCode: null,
    }));
}
