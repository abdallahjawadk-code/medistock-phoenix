/**
 * CANONICAL-SUPPLY-PROVENANCE-088 — the closed supply-type vocabulary.
 *
 * Every "نوع التجهيز" field is a CLOSED three-value list — never free text:
 *   aid      مساعدات
 *   purchase مشتريات   (always carries an origin: central | supplementary)
 *   kimadia  كيماديا
 *
 * "Donations" is REMOVED from the vocabulary. Legacy free-text values
 * (including donations) are never rewritten in the database; they are mapped
 * for DISPLAY ONLY — donations displays under مساعدات (aid).
 */

export type CanonicalSupplyType = 'aid' | 'purchase' | 'kimadia';
export type PurchaseOrigin = 'central' | 'supplementary';

export const SUPPLY_TYPES: readonly CanonicalSupplyType[] = ['aid', 'purchase', 'kimadia'];

/** i18n label key for a canonical supply type. */
export function supplyTypeLabelKey(type: CanonicalSupplyType): string {
  return type === 'aid' ? 'sc_supply_aid'
    : type === 'kimadia' ? 'sc_supply_kimadia'
    : 'sc_supply_purchases';
}

/** i18n label key for a purchase origin badge. */
export function purchaseOriginLabelKey(origin: PurchaseOrigin): string {
  return origin === 'central' ? 'st_origin_central' : 'st_origin_supplementary';
}

/**
 * Map ANY stored value (canonical token or legacy free text) to its canonical
 * display type. Display-only — never used to rewrite stored data. Legacy
 * donations/donations/تبرع/منح display under 'aid' (مساعدات) by explicit safe
 * mapping. Unmappable values return null (shown under their raw label).
 */
export function displaySupplyType(value?: string | null): CanonicalSupplyType | null {
  if (!value) return null;
  const s = value.trim().toLowerCase();
  if (!s) return null;
  if (s === 'aid' || s === 'purchase' || s === 'kimadia') return s;
  if (s.includes('kimadia') || s.includes('كيماديا') || s.includes('كماديا')) return 'kimadia';
  if (s.includes('purchase') || s.includes('local_procurement') || s.includes('مشتر') || s.includes('شراء')) return 'purchase';
  // Legacy donations map to aid for DISPLAY (vocabulary no longer offers them).
  if (s.includes('donation') || s.includes('هب') || s.includes('تبرع') || s.includes('منح')) return 'aid';
  if (s.includes('aid') || s.includes('مساعد') || s.includes('إغاث') || s.includes('اغاث')) return 'aid';
  return null;
}
