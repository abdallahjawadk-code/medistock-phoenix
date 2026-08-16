/**
 * R1.5-E — CANONICAL LOT IDENTITY, CLIENT SIDE.
 *
 * Migration 150 made `material_identity_key` a GENERATED ALWAYS STORED column on
 * warehouse_stock, outlet_stock and warehouse_quarantine_stock, computed by
 * `_phoenix_material_identity_v1(central_item_id, scientific_name,
 * national_code, concentration, dosage_form, unit)`. It is DATABASE DATA.
 *
 * This module therefore NEVER recomputes it. It reads what the database
 * produced and compares. Reconstructing it in TypeScript would fork the
 * canonical definition the moment 150's helper changes, and would silently
 * disagree with the server on exactly the rows that matter.
 *
 * WHY THE OLD PREDICATE WAS UNSAFE
 *   The release picker previously offered any warehouse_stock lot whose
 *   lower-cased scientific name, batch number and expiry matched. That triple is
 *   NOT lot identity. Migration 088 rebuilt `warehouse_stock_identity_uniq` as
 *
 *     (warehouse_id, scientific_name, COALESCE(concentration,''),
 *      COALESCE(dosage_form,''), COALESCE(national_code,''),
 *      COALESCE(batch_number,''), COALESCE(expiry_date, DATE '0001-01-01'),
 *      COALESCE(internal_batch_reference,''), COALESCE(supply_type,''),
 *      COALESCE(purchase_origin,''))
 *
 *   so two rows sharing name/batch/expiry are genuinely DIFFERENT lots when
 *   their provenance or internal batch reference differs. Offering one as the
 *   release destination for the other proposes crediting the wrong physical
 *   stock.
 *
 * WHAT THIS IS NOT
 *   A convenience/safety filter for the picker, nothing more.
 *   `phoenix_release_quarantine_stock` remains the only authority on whether a
 *   release is legal and refuses a mismatched destination outright. Narrowing
 *   the client list cannot grant anything; it only stops the UI proposing a
 *   destination the server will reject.
 */

/**
 * Normalize ONE nullable textual identity field, for COMPARISON ONLY.
 *
 * `null` and `undefined` both collapse to `''`, mirroring the COALESCE(x, '')
 * the canonical unique indexes use. Nothing else happens: no trim, no case
 * folding, no locale work. The server contract compares these values exactly,
 * so any extra transformation here would make the client agree with itself and
 * disagree with the database.
 *
 * Never used to rewrite a payload — only to compare two of them.
 */
export function normalizeIdentityField(value: string | null | undefined): string {
  return value ?? '';
}

/**
 * The canonical lot-identity dimensions a release destination must match.
 *
 * `expiryDate` is a DATE IDENTITY carried as canonical `YYYY-MM-DD` text, never
 * a timestamp. It is compared as text through the same helper, so a null expiry
 * on both sides matches and a null-vs-set expiry does not. No `new Date(...)`,
 * no UTC shift, no locale formatting: parsing 'YYYY-MM-DD' into a Date would
 * reintroduce a timezone the database never had.
 *
 * Deliberately ABSENT — see `isExactReleaseCandidate`:
 *   scientificName / nationalCode / concentration / dosageForm / centralItemId /
 *   unit  — all already folded into materialIdentityKey by 150's helper, so
 *           comparing them again is redundant, and comparing them INSTEAD is
 *           the defect this replaces.
 *   quarantineReason — quarantine state, not warehouse_stock lot identity.
 */
export interface CanonicalLotIdentity {
  materialIdentityKey: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
  internalBatchReference: string | null;
  supplyType: string | null;
  purchaseOrigin: string | null;
}

/**
 * Is `candidate` (a warehouse_stock lot) the EXACT destination identity of
 * `quarantined` (a warehouse_quarantine_stock row)?
 *
 * All six dimensions must agree. Any single difference is a different lot.
 *
 * FAIL-SAFE ON A MISSING CANONICAL KEY. If either side lacks
 * `materialIdentityKey` the answer is `false`, never a fallback comparison over
 * partial material fields. A missing generated column means the row was not
 * read through the canonical projection, and guessing there is precisely how a
 * release gets credited to the wrong lot. Offering no destination is safe; the
 * operator sees "no matching lot" instead of a wrong one.
 *
 * `quarantineReason` is NOT consulted. `wqs_identity_uniq` includes it because
 * one physical lot can sit in quarantine under two different reasons, but
 * `warehouse_stock_identity_uniq` does not — the destination lot has no such
 * dimension, so requiring it would make every release impossible.
 */
export function isExactReleaseCandidate(
  candidate: CanonicalLotIdentity,
  quarantined: CanonicalLotIdentity,
): boolean {
  if (!candidate.materialIdentityKey || !quarantined.materialIdentityKey) return false;
  if (candidate.materialIdentityKey !== quarantined.materialIdentityKey) return false;

  return (
    normalizeIdentityField(candidate.batchNumber)
      === normalizeIdentityField(quarantined.batchNumber)
    && normalizeIdentityField(candidate.expiryDate)
      === normalizeIdentityField(quarantined.expiryDate)
    && normalizeIdentityField(candidate.internalBatchReference)
      === normalizeIdentityField(quarantined.internalBatchReference)
    && normalizeIdentityField(candidate.supplyType)
      === normalizeIdentityField(quarantined.supplyType)
    && normalizeIdentityField(candidate.purchaseOrigin)
      === normalizeIdentityField(quarantined.purchaseOrigin)
  );
}
