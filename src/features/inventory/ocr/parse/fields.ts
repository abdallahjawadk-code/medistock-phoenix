import type { OcrDocumentResult, OcrLine, OcrBox } from '../types';
import { normalizeForDisplay, normalizeDigits, parseNumber, applyValidatedCorrection } from './normalize';
import { parseConcentration, parseDosageForm, parsePackSize, type Concentration } from './units';
import { parseDate, isAmbiguous, EXPIRY_LABELS, MANUFACTURING_LABELS, type DateParseResult } from './dates';

/**
 * PHARMA-OCR-A — deterministic pharmaceutical field extraction.
 *
 * Sits above raw OCR and below catalog matching. Given words+boxes, it produces
 * labelled CANDIDATES with provenance: which text produced the value, which
 * label vouched for it, and where on the image it lives.
 *
 * It never invents a value. Every candidate carries the exact source text, and
 * a field with no evidence is simply absent rather than defaulted — the review
 * UI shows an empty field the operator must fill, which is honest, instead of a
 * plausible-looking guess nobody questions.
 */

export type PharmaFieldName =
  | 'scientificName'
  | 'tradeName'
  | 'concentration'
  | 'dosageForm'
  | 'unit'
  | 'nationalCode'
  | 'batchNumber'
  | 'manufacturingDate'
  | 'expiryDate'
  | 'quantity'
  | 'packSize'
  | 'unitPrice'
  | 'currency'
  | 'supplyType'
  | 'sourceDocumentNumber'
  | 'supplier'
  | 'notes';

export interface FieldCandidate {
  field: PharmaFieldName;
  /** Normalized value offered to the operator. */
  value: string;
  /** Untouched OCR text this came from — always retained as provenance. */
  sourceText: string;
  /** The label token that vouched for this value, when one was found. */
  matchedLabel: string | null;
  /** Union box of the value tokens, for image highlighting. */
  box: OcrBox;
  /** Mean raw OCR confidence (0–100) of the contributing words. */
  ocrConfidence: number;
  /** True when applyValidatedCorrection changed the text under validator proof. */
  corrected: boolean;
  /** Set when the parser could not resolve between readings. */
  ambiguousAlternatives?: string[];
}

export interface ExtractionResult {
  candidates: FieldCandidate[];
  /** Lines that matched no field, offered to the operator as free-text notes. */
  unmatchedLines: string[];
}

const unionBox = (boxes: OcrBox[]): OcrBox => ({
  x0: Math.min(...boxes.map(b => b.x0)),
  y0: Math.min(...boxes.map(b => b.y0)),
  x1: Math.max(...boxes.map(b => b.x1)),
  y1: Math.max(...boxes.map(b => b.y1)),
});

const FALLBACK_BOX: OcrBox = { x0: 0, y0: 0, x1: 0, y1: 0 };

/** Label vocabularies. Matched case-insensitively after digit normalization. */
const LABELS: Record<string, readonly string[]> = {
  batchNumber: [
    'lot', 'lot no', 'lot no.', 'lot number', 'batch', 'batch no', 'batch no.', 'batch number', 'b.no', 'bn',
    'تشغيلة', 'رقم التشغيلة', 'لوط', 'رقم اللوط', 'دفعة', 'رقم الدفعة', 'تشغيله',
  ],
  nationalCode: [
    'national code', 'nat code', 'reg no', 'reg. no', 'registration no', 'registration number',
    'drug code', 'product code', 'code',
    'الرمز الوطني', 'رقم التسجيل', 'رمز الدواء', 'الكود', 'رمز المنتج',
  ],
  quantity: [
    'qty', 'qty.', 'quantity', 'received', 'received qty', 'count',
    'الكمية', 'العدد', 'الكميه', 'كمية',
  ],
  unitPrice: [
    'price', 'unit price', 'unit cost', 'rate',
    'السعر', 'سعر الوحدة', 'سعر', 'الكلفة',
  ],
  sourceDocumentNumber: [
    'invoice', 'invoice no', 'invoice no.', 'invoice number', 'document no', 'doc no', 'bill no', 'grn',
    'رقم الفاتورة', 'الفاتورة', 'رقم المستند', 'المستند', 'وصل',
  ],
  supplier: [
    'supplier', 'vendor', 'manufacturer', 'mfr', 'made by', 'distributed by',
    'المجهز', 'المورد', 'الشركة', 'الشركة المصنعة', 'المصنع',
  ],
  supplyType: [
    'supply type', 'source of supply', 'procurement',
    'نوع التجهيز', 'جهة التجهيز', 'نوع التوريد',
  ],
  tradeName: ['trade name', 'brand', 'brand name', 'الاسم التجاري', 'العلامة التجارية'],
  scientificName: [
    'generic name', 'scientific name', 'inn', 'active ingredient', 'composition',
    'الاسم العلمي', 'المادة الفعالة', 'التركيب',
  ],
};

const CURRENCY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(iqd|د\.?ع|دينار)\b/iu, 'IQD'],
  [/\b(usd|\$|دولار)\b/iu, 'USD'],
  [/\b(eur|€|يورو)\b/iu, 'EUR'],
];

/**
 * Words that are LABELS, never values. MEASURED (tools/ocr-eval): on a rotated
 * scan, "Batch Number PC2291" was read with "Number" garbled to "NUM8ER"; the
 * label matcher consumed "Batch", and "NUM8ER" passed the batch validator
 * (alphanumeric, contains a digit) and was offered as the batch number. A WRONG
 * value the operator might wave through is far worse than a missed one, so any
 * candidate that folds onto a label word is rejected outright.
 *
 * Matching is done on a digit-folded, letter-only projection so OCR confusions
 * (8→B, 0→O, 1→I) cannot smuggle a label past this check.
 */
const LABEL_WORDS = new Set([
  'number', 'numbers', 'no', 'code', 'batch', 'lot', 'date', 'exp', 'expiry',
  'qty', 'quantity', 'price', 'invoice', 'supplier', 'name', 'unit', 'total',
]);

function foldsOntoLabelWord(value: string): boolean {
  const letters = value
    .replace(/8/g, 'b').replace(/0/g, 'o').replace(/1/g, 'i')
    .replace(/5/g, 's').replace(/2/g, 'z').replace(/6/g, 'g')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return letters.length >= 2 && LABEL_WORDS.has(letters);
}

/** Batch numbers are alphanumeric, 3–20 chars, and contain at least one digit. */
export const isPlausibleBatch = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9\-/]{1,18}[A-Za-z0-9]$/.test(value)
  && /\d/.test(value)
  && !foldsOntoLabelWord(value);

/** National codes in this catalog are digit runs, optionally hyphen-grouped. */
export const isPlausibleNationalCode = (value: string): boolean =>
  /^\d[\d-]{3,19}$/.test(value) && (value.match(/\d/g)?.length ?? 0) >= 4;

/**
 * Find a label at the start of a line and return the remainder as the value.
 * Longest label first so "lot number" is not shadowed by "lot".
 */
function splitLabelled(lineText: string, labels: readonly string[]): { label: string; rest: string } | null {
  const normalized = normalizeForDisplay(lineText);
  const haystack = normalized.toLowerCase();
  const ordered = [...labels].sort((a, b) => b.length - a.length);

  for (const label of ordered) {
    const needle = label.toLowerCase();
    const index = haystack.indexOf(needle);
    if (index === -1) continue;
    const after = normalized.slice(index + label.length);
    // Require a separator so "code" does not match inside "barcode".
    const separator = /^\s*[:：#\-–]?\s*/.exec(after);
    if (index > 0 && /[A-Za-z0-9؀-ۿ]/.test(normalized[index - 1])) continue;
    const rest = after.slice(separator?.[0].length ?? 0).trim();
    if (rest) return { label, rest };
  }
  return null;
}

const meanConfidence = (line: OcrLine): number =>
  line.words.length === 0
    ? line.confidence
    : line.words.reduce((sum, w) => sum + w.confidence, 0) / line.words.length;

/**
 * Locate the sub-box of a line covering `value`, so highlighting points at the
 * value rather than the whole line including its label.
 */
function valueBox(line: OcrLine, value: string): OcrBox {
  const wanted = normalizeForDisplay(value).toLowerCase();
  const hits = line.words.filter(word => {
    const text = normalizeForDisplay(word.text).toLowerCase();
    return text.length > 0 && wanted.includes(text);
  });
  return hits.length > 0 ? unionBox(hits.map(w => w.box)) : line.box;
}

function push(
  out: FieldCandidate[],
  field: PharmaFieldName,
  value: string,
  line: OcrLine,
  sourceText: string,
  matchedLabel: string | null,
  extra: Partial<FieldCandidate> = {},
): void {
  if (!value.trim()) return;
  out.push({
    field,
    value: value.trim(),
    sourceText,
    matchedLabel,
    box: valueBox(line, value),
    ocrConfidence: meanConfidence(line),
    corrected: false,
    ...extra,
  });
}

function extractDateField(
  out: FieldCandidate[],
  line: OcrLine,
  labels: readonly string[],
  field: 'expiryDate' | 'manufacturingDate',
): boolean {
  const labelled = splitLabelled(line.text, labels);
  const scope = labelled ? labelled.rest : null;
  if (!scope) return false;

  const parsed: DateParseResult = parseDate(scope, field === 'expiryDate' ? 'expiry' : 'manufacturing');
  if (!parsed) return false;

  if (isAmbiguous(parsed)) {
    push(out, field, parsed.candidates[0], line, parsed.raw, labelled?.label ?? null, {
      ambiguousAlternatives: parsed.candidates,
    });
    return true;
  }
  push(out, field, parsed.iso, line, parsed.raw, labelled?.label ?? null);
  return true;
}

/**
 * Extract every field candidate from an OCR result.
 *
 * Strategy is label-driven first (highest precision), then a narrow set of
 * unlabelled structural patterns for fields whose format is distinctive enough
 * to stand alone (concentration, dosage form, currency). Anything else stays
 * unmatched — better an empty field than a wrong one.
 */
export function extractPharmaFields(document: OcrDocumentResult): ExtractionResult {
  const candidates: FieldCandidate[] = [];
  const unmatchedLines: string[] = [];

  for (const line of document.lines) {
    const text = normalizeForDisplay(line.text);
    if (!text) continue;
    let matchedAnything = false;

    // ── Dates ──
    if (extractDateField(candidates, line, EXPIRY_LABELS, 'expiryDate')) matchedAnything = true;
    if (extractDateField(candidates, line, MANUFACTURING_LABELS, 'manufacturingDate')) matchedAnything = true;

    // ── Batch: correction is allowed here because isPlausibleBatch can prove it ──
    const batch = splitLabelled(text, LABELS.batchNumber);
    if (batch) {
      // Batch/lot codes are case-insensitive identifiers in practice, and OCR
      // routinely reads a printed 'X' as 'x'. Upper-casing is a presentation
      // normalization, not a content change — the untouched reading is still
      // kept as sourceText. (MEASURED: this was a recurring wrong-value class
      // in tools/ocr-eval, and a WRONG batch is worse than a missed one.)
      const token = batch.rest.split(/\s+/)[0].toUpperCase();
      const outcome = applyValidatedCorrection(normalizeDigits(token), isPlausibleBatch);
      if (isPlausibleBatch(outcome.value)) {
        push(candidates, 'batchNumber', outcome.value, line, outcome.original, batch.label, {
          corrected: outcome.corrected,
        });
        matchedAnything = true;
      }
    }

    // ── National code ──
    const national = splitLabelled(text, LABELS.nationalCode);
    if (national) {
      const token = normalizeDigits(national.rest.split(/\s+/)[0]);
      const outcome = applyValidatedCorrection(token, isPlausibleNationalCode);
      if (isPlausibleNationalCode(outcome.value)) {
        push(candidates, 'nationalCode', outcome.value, line, outcome.original, national.label, {
          corrected: outcome.corrected,
        });
        matchedAnything = true;
      }
    }

    // ── Quantity: integer only; a decimal here is a misread, not a quantity ──
    const quantity = splitLabelled(text, LABELS.quantity);
    if (quantity) {
      const parsed = parseNumber(quantity.rest.split(/\s+/)[0]);
      if (parsed !== null && Number.isInteger(parsed) && parsed > 0) {
        push(candidates, 'quantity', String(parsed), line, quantity.rest, quantity.label);
        matchedAnything = true;
      }
    }

    // ── Unit price (may be fractional) ──
    const price = splitLabelled(text, LABELS.unitPrice);
    if (price) {
      const parsed = parseNumber(price.rest.replace(/[^\d.,٠-٩]/g, ' ').trim().split(/\s+/)[0]);
      if (parsed !== null && parsed >= 0) {
        push(candidates, 'unitPrice', String(parsed), line, price.rest, price.label);
        matchedAnything = true;
      }
    }

    // ── Plain labelled text fields ──
    for (const field of ['sourceDocumentNumber', 'supplier', 'supplyType', 'tradeName', 'scientificName'] as const) {
      const hit = splitLabelled(text, LABELS[field]);
      if (hit) {
        push(candidates, field, hit.rest, line, hit.rest, hit.label);
        matchedAnything = true;
      }
    }

    // ── Unlabelled but structurally distinctive ──
    const concentration: Concentration | null = parseConcentration(text);
    if (concentration) {
      push(candidates, 'concentration', concentration.formatted, line, concentration.raw, null);
      matchedAnything = true;

      // MEASURED GAP (tools/ocr-eval): real delivery notes print the drug name
      // as a headline — "Amoxicillin 500 mg Capsules" — not behind a "Generic
      // Name:" label. Label-only extraction therefore missed scientificName on
      // every fixture. The leading text before the strength is a legitimate
      // NAME CANDIDATE; it carries no label, so it scores low and still
      // requires explicit operator confirmation before any intake.
      const headline = text.slice(0, text.indexOf(concentration.raw)).trim();
      const cleaned = headline.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim();
      // Two words at most: a headline like "Delivery Note Amoxicillin" would
      // otherwise smuggle document chrome into the material name.
      const words = cleaned.split(/\s+/).filter(Boolean);
      if (words.length >= 1 && words.length <= 2 && cleaned.length >= 3) {
        push(candidates, 'scientificName', cleaned, line, headline, null);
      }
    }
    const dosageForm = parseDosageForm(text);
    if (dosageForm) {
      push(candidates, 'dosageForm', dosageForm, line, text, null);
      matchedAnything = true;
    }
    const packSize = parsePackSize(text);
    if (packSize) {
      push(candidates, 'packSize', String(packSize.count), line, packSize.raw, null);
      matchedAnything = true;
    }
    for (const [pattern, code] of CURRENCY_PATTERNS) {
      if (pattern.test(text)) {
        push(candidates, 'currency', code, line, text, null);
        matchedAnything = true;
        break;
      }
    }

    if (!matchedAnything) unmatchedLines.push(text);
  }

  return { candidates, unmatchedLines };
}

/**
 * Reduce multiple candidates for one field to the best single suggestion.
 * A labelled candidate always beats an unlabelled one — label proximity is much
 * stronger evidence than raw engine confidence — and ties break on OCR
 * confidence. Losing candidates are returned so the review UI can offer them.
 */
export function bestCandidatePerField(
  candidates: FieldCandidate[],
): Map<PharmaFieldName, { best: FieldCandidate; alternatives: FieldCandidate[] }> {
  const grouped = new Map<PharmaFieldName, FieldCandidate[]>();
  for (const candidate of candidates) {
    const list = grouped.get(candidate.field) ?? [];
    list.push(candidate);
    grouped.set(candidate.field, list);
  }

  const out = new Map<PharmaFieldName, { best: FieldCandidate; alternatives: FieldCandidate[] }>();
  for (const [field, list] of grouped) {
    const ranked = [...list].sort((a, b) => {
      const labelDelta = Number(Boolean(b.matchedLabel)) - Number(Boolean(a.matchedLabel));
      if (labelDelta !== 0) return labelDelta;
      return b.ocrConfidence - a.ocrConfidence;
    });
    out.set(field, { best: ranked[0], alternatives: ranked.slice(1) });
  }
  return out;
}

export { FALLBACK_BOX };
