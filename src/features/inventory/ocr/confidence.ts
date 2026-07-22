import type { FieldCandidate, PharmaFieldName } from './parse/fields';

/**
 * PHARMA-OCR-A — field-level confidence from separable evidence.
 *
 * Raw engine confidence alone is a poor guide: Tesseract is often serenely
 * confident about a cleanly-rendered wrong reading. So each field's verdict
 * combines five independent signals, and the UI shows WHICH signals fired
 * rather than a single opaque number.
 *
 * We publish a three-way band, not a percentage. A "97%" label implies a
 * calibrated probability we have not measured and cannot honestly claim; the
 * raw component values are available for display, but the headline is a band.
 */

export type ConfidenceBand = 'high' | 'needs_review' | 'uncertain';

export interface ConfidenceEvidence {
  /** Engine confidence normalized to 0–1. */
  ocr: number;
  /** 1 when an explicit label vouched for the value, else 0. */
  labelProximity: number;
  /** 1 when the value satisfies its field's format validator. */
  formatValid: number;
  /**
   * 1 when the catalog agreed, 0 when it disagreed, null when not applicable
   * (field is not catalog-backed) — null is excluded from the average rather
   * than counted as a failure.
   */
  catalogAgreement: number | null;
  /** 1 when consistent with sibling fields, 0 on a detected contradiction. */
  crossField: number | null;
}

export interface FieldConfidence {
  field: PharmaFieldName;
  band: ConfidenceBand;
  evidence: ConfidenceEvidence;
  /** Signals that pulled the verdict down, named for the review UI. */
  reasons: string[];
}

/**
 * Fields that ALWAYS require an explicit human tick before intake, regardless
 * of how strong the evidence is. These are the values where a silent error
 * becomes a dispensing or accounting incident rather than a cosmetic one.
 */
export const REQUIRED_CONFIRMATION_FIELDS: readonly PharmaFieldName[] = [
  'scientificName',
  'nationalCode',
  'batchNumber',
  'expiryDate',
  'quantity',
  'unitPrice',
];

/** Weights are equal by default — no component is privileged without evidence. */
const BAND_THRESHOLDS = { high: 0.85, needsReview: 0.6 } as const;

export function scoreToBand(score: number): ConfidenceBand {
  if (score >= BAND_THRESHOLDS.high) return 'high';
  if (score >= BAND_THRESHOLDS.needsReview) return 'needs_review';
  return 'uncertain';
}

/** Mean of the applicable (non-null) components. */
export function combineEvidence(evidence: ConfidenceEvidence): number {
  const parts = [
    evidence.ocr,
    evidence.labelProximity,
    evidence.formatValid,
    evidence.catalogAgreement,
    evidence.crossField,
  ].filter((value): value is number => value !== null);
  if (parts.length === 0) return 0;
  return parts.reduce((sum, value) => sum + value, 0) / parts.length;
}

export interface ConfidenceInput {
  candidate: FieldCandidate;
  formatValid: boolean;
  catalogAgreement: boolean | null;
  crossFieldConsistent: boolean | null;
}

export function assessFieldConfidence(input: ConfidenceInput): FieldConfidence {
  const { candidate } = input;

  const evidence: ConfidenceEvidence = {
    ocr: Math.max(0, Math.min(1, candidate.ocrConfidence / 100)),
    labelProximity: candidate.matchedLabel ? 1 : 0,
    formatValid: input.formatValid ? 1 : 0,
    catalogAgreement: input.catalogAgreement === null ? null : input.catalogAgreement ? 1 : 0,
    crossField: input.crossFieldConsistent === null ? null : input.crossFieldConsistent ? 1 : 0,
  };

  const reasons: string[] = [];
  if (evidence.ocr < 0.7) reasons.push('low_ocr_confidence');
  if (!candidate.matchedLabel) reasons.push('no_label_nearby');
  if (!input.formatValid) reasons.push('format_invalid');
  if (input.catalogAgreement === false) reasons.push('catalog_disagrees');
  if (input.crossFieldConsistent === false) reasons.push('cross_field_conflict');
  if (candidate.corrected) reasons.push('ocr_corrected');
  if (candidate.ambiguousAlternatives?.length) reasons.push('ambiguous_reading');

  let band = scoreToBand(combineEvidence(evidence));

  // Hard demotions: an ambiguous or format-invalid reading is never "high",
  // however well the other signals score.
  if (candidate.ambiguousAlternatives?.length && band === 'high') band = 'needs_review';
  if (!input.formatValid && band === 'high') band = 'needs_review';
  if (input.catalogAgreement === false) band = 'uncertain';

  return { field: candidate.field, band, evidence, reasons };
}

/** Fields sort low-confidence first so review effort lands where it is needed. */
const BAND_ORDER: Record<ConfidenceBand, number> = { uncertain: 0, needs_review: 1, high: 2 };

export function orderForReview(fields: readonly FieldConfidence[]): FieldConfidence[] {
  return [...fields].sort((a, b) => {
    const bandDelta = BAND_ORDER[a.band] - BAND_ORDER[b.band];
    if (bandDelta !== 0) return bandDelta;
    // Within a band, required-confirmation fields come first.
    const aRequired = REQUIRED_CONFIRMATION_FIELDS.includes(a.field) ? 0 : 1;
    const bRequired = REQUIRED_CONFIRMATION_FIELDS.includes(b.field) ? 0 : 1;
    return aRequired - bRequired;
  });
}

/**
 * Cross-field consistency rules. Each returns null when the check does not
 * apply (missing inputs), so "not checkable" never masquerades as "consistent".
 */
export function checkExpiryAfterManufacturing(
  expiryIso: string | null,
  manufacturingIso: string | null,
): boolean | null {
  if (!expiryIso || !manufacturingIso) return null;
  return expiryIso > manufacturingIso;
}

export function checkQuantityAgainstPackSize(
  quantity: number | null,
  packSize: number | null,
): boolean | null {
  if (quantity === null || packSize === null || packSize <= 0) return null;
  // A quantity that is an exact multiple of the pack size corroborates both
  // readings. A non-multiple is not proof of error, so it only weakens, and the
  // caller surfaces it as a soft cross-field signal.
  return quantity % packSize === 0;
}
