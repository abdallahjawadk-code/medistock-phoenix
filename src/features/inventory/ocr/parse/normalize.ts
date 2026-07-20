/**
 * PHARMA-OCR-A — safe text normalization.
 *
 * The hard rule in this file: normalization may only ever be REVERSIBLE or
 * INFORMATION-PRESERVING. Digit-shape conversion and whitespace collapsing
 * qualify. Guessing that an `O` was meant to be a `0` does not — that is a
 * content change, and it belongs behind a field validator that can prove the
 * substitution is right (see applyValidatedCorrection), never here.
 */

/** Arabic-Indic ٠-٩ and Eastern Arabic-Indic (Persian/Urdu) ۰-۹. */
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/**
 * Convert every Arabic-Indic digit to its Western equivalent. This is a pure
 * script change — the numeric value is identical — so it is always safe.
 */
export function normalizeDigits(input: string): string {
  let out = '';
  for (const char of input) {
    const arabicIndex = ARABIC_INDIC.indexOf(char);
    if (arabicIndex >= 0) { out += String(arabicIndex); continue; }
    const easternIndex = EASTERN_ARABIC_INDIC.indexOf(char);
    if (easternIndex >= 0) { out += String(easternIndex); continue; }
    out += char;
  }
  return out;
}

/** Arabic decimal separator (٫) and thousands mark (٬) → Western equivalents. */
export function normalizeNumericSeparators(input: string): string {
  return input.replace(/٫/g, '.').replace(/٬/g, ',');
}

/**
 * Collapse whitespace variants (including the Arabic tatweel used for
 * justification, and zero-width marks OCR often emits) to single spaces.
 */
export function normalizeWhitespace(input: string): string {
  return input
    .replace(/[ـ]/g, '')
    .replace(/[​-‏‪-‮﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Unify the many dash/quote glyphs OCR produces into ASCII equivalents. */
export function normalizePunctuation(input: string): string {
  return input
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“-‟]/g, '"')
    .replace(/[،]/g, ',')
    .replace(/[؛]/g, ';')
    .replace(/[٭•]/g, '*');
}

/**
 * Arabic orthographic folding for MATCHING ONLY. Never use the result as a
 * display or stored value: it deliberately discards hamza and diacritics, which
 * are meaningful in a real drug name.
 */
export function foldArabic(input: string): string {
  return input
    .replace(/[ً-ْٰ]/g, '')
    // Tatweel is pure justification padding and carries no meaning.
    .replace(/ـ/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ى]/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

/** Full pipeline for text that will be shown to the operator. Preserves content. */
export function normalizeForDisplay(input: string): string {
  return normalizeWhitespace(normalizePunctuation(normalizeNumericSeparators(normalizeDigits(input))));
}

/**
 * Aggressive fold for catalog comparison only — lowercase, Arabic-folded,
 * punctuation and space stripped. Lossy by design; never persisted.
 */
export function normalizeForMatching(input: string): string {
  return foldArabic(normalizeForDisplay(input))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Parse a quantity-like number. Returns null rather than a partial guess when
 * the token is not cleanly numeric — a silently truncated quantity is far worse
 * than an unparsed one the operator must type.
 */
export function parseNumber(raw: string): number | null {
  const normalized = normalizeNumericSeparators(normalizeDigits(raw)).trim();
  // Internal whitespace is NOT treated as a thousands separator. "123 456 7"
  // is far more likely two OCR fragments than the number 1234567, and joining
  // them would fabricate a quantity an order of magnitude wrong.
  if (/\s/.test(normalized)) return null;
  const cleaned = normalized.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Characters OCR genuinely confuses, paired with their likely intent. */
const CONFUSION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['O', '0'], ['o', '0'], ['D', '0'], ['Q', '0'],
  ['I', '1'], ['l', '1'], ['|', '1'],
  ['B', '8'], ['S', '5'], ['Z', '2'], ['G', '6'],
];

/**
 * Try confusion-pair substitutions ONLY where a validator can confirm the
 * result, and report what was changed so the review UI can show it.
 *
 * This is the single sanctioned place where OCR text is altered in content, and
 * it is gated three ways: the original must FAIL validation, a candidate must
 * PASS it, and exactly one candidate may pass. Two plausible readings means the
 * operator decides — the machine does not pick.
 */
export interface CorrectionOutcome {
  value: string;
  corrected: boolean;
  /** Always the untouched OCR text, kept as provenance. */
  original: string;
}

export function applyValidatedCorrection(
  original: string,
  isValid: (candidate: string) => boolean,
  maxSubstitutions = 2,
): CorrectionOutcome {
  if (isValid(original)) return { value: original, corrected: false, original };

  const seen = new Set<string>([original]);
  let frontier = [original];
  const passing = new Set<string>();

  for (let depth = 0; depth < maxSubstitutions; depth += 1) {
    const next: string[] = [];
    for (const candidate of frontier) {
      for (let index = 0; index < candidate.length; index += 1) {
        for (const [from, to] of CONFUSION_PAIRS) {
          if (candidate[index] !== from) continue;
          const mutated = candidate.slice(0, index) + to + candidate.slice(index + 1);
          if (seen.has(mutated)) continue;
          seen.add(mutated);
          next.push(mutated);
          if (isValid(mutated)) passing.add(mutated);
        }
      }
    }
    // Stop at the shallowest depth that produced any valid reading — a 1-edit
    // fix is far more credible than a 2-edit one, and mixing them would let a
    // contrived deeper candidate compete with an obvious shallow one.
    if (passing.size > 0) break;
    frontier = next;
  }

  if (passing.size !== 1) return { value: original, corrected: false, original };
  return { value: [...passing][0], corrected: true, original };
}
