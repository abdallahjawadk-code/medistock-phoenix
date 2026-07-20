/**
 * PHARMA-OCR-A — dosage strength and pack-size parsing.
 *
 * Concentration is a field where a wrong reading is a patient-safety issue, so
 * every function here refuses ambiguity: an unrecognised strength returns null
 * and the operator types it, rather than the parser producing a plausible
 * number that nobody double-checks.
 */
import { normalizeDigits, normalizeNumericSeparators, normalizeWhitespace } from './normalize';

export type MassUnit = 'mcg' | 'mg' | 'g';
export type VolumeUnit = 'ml' | 'l';
export type ActivityUnit = 'iu';
export type StrengthUnit = MassUnit | VolumeUnit | ActivityUnit | '%';

/** Canonical unit spellings, including the Arabic forms seen on local packaging. */
const UNIT_ALIASES: ReadonlyArray<readonly [RegExp, StrengthUnit]> = [
  [/^(mcg|µg|ug|microgram(s)?|ميكروغرام|مايكروغرام|ميكروجرام)$/i, 'mcg'],
  [/^(mg|milligram(s)?|ملغم|ملغ|مليغرام|مجم)$/i, 'mg'],
  [/^(g|gm|gram(s)?|غم|جم|غرام)$/i, 'g'],
  [/^(ml|millilit(er|re)(s)?|مل|ملل|مليلتر)$/i, 'ml'],
  [/^(l|lit(er|re)(s)?|لتر)$/i, 'l'],
  [/^(iu|i\.u\.|international unit(s)?|وحدة دولية|وحده دوليه)$/i, 'iu'],
  [/^(%|percent|بالمئة|بالمائة)$/i, '%'],
];

export function canonicalUnit(raw: string): StrengthUnit | null {
  const token = normalizeWhitespace(raw);
  for (const [pattern, unit] of UNIT_ALIASES) {
    if (pattern.test(token)) return unit;
  }
  // Retry with internal periods stripped so "I.U." and "mg." reach the same
  // aliases as "IU" and "mg" without needing a dotted variant for each entry.
  const undotted = token.replace(/\./g, '');
  if (undotted === token) return null;
  for (const [pattern, unit] of UNIT_ALIASES) {
    if (pattern.test(undotted)) return unit;
  }
  return null;
}

export interface Strength {
  value: number;
  unit: StrengthUnit;
}

/**
 * A concentration, which may be a simple strength (500 mg) or a ratio
 * (125 mg / 5 ml). `perVolume` is null for the simple form.
 */
export interface Concentration {
  numerator: Strength;
  perVolume: Strength | null;
  /** Exactly as it appeared after digit normalization — provenance for review. */
  raw: string;
  /** Canonical redisplay, e.g. "125 mg/5 ml". */
  formatted: string;
}

const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
const UNIT_CHARS = String.raw`[A-Za-z%µ؀-ۿ.]+`;

/**
 * Match "125 mg/5 ml", "125mg per 5ml", "125 ملغم / 5 مل", and the simple
 * "500 mg" / "5 %" forms. Anchored per-candidate rather than scanning greedily,
 * so a stray number elsewhere on the label cannot be captured as a strength.
 */
const RATIO_PATTERN = new RegExp(
  String.raw`(${NUMBER})\s*(${UNIT_CHARS})\s*(?:/|per|في|لكل)\s*(${NUMBER})?\s*(${UNIT_CHARS})`,
  'iu',
);
const SIMPLE_PATTERN = new RegExp(String.raw`(${NUMBER})\s*(${UNIT_CHARS})`, 'iu');

const toNumber = (raw: string): number | null => {
  const value = Number(normalizeNumericSeparators(normalizeDigits(raw)).replace(',', '.'));
  return Number.isFinite(value) ? value : null;
};

const formatStrength = (strength: Strength): string =>
  strength.unit === '%' ? `${strength.value}%` : `${strength.value} ${strength.unit}`;

export function formatConcentration(concentration: Concentration): string {
  const head = formatStrength(concentration.numerator);
  if (!concentration.perVolume) return head;
  const { value, unit } = concentration.perVolume;
  // "mg/ml" reads better than "mg/1 ml" when the denominator is unity.
  return value === 1 ? `${head}/${unit}` : `${head}/${value} ${unit}`;
}

/**
 * Extract a concentration from free text. Returns null when no strength is
 * confidently identifiable — never a partial or defaulted value.
 */
export function parseConcentration(input: string): Concentration | null {
  const text = normalizeWhitespace(normalizeDigits(input));
  if (!text) return null;

  const ratio = RATIO_PATTERN.exec(text);
  if (ratio) {
    const numeratorValue = toNumber(ratio[1]);
    const numeratorUnit = canonicalUnit(ratio[2]);
    const denominatorUnit = canonicalUnit(ratio[4]);
    // An unrecognised unit on either side means we did not understand the
    // expression; returning the numerator alone would silently drop the "per".
    if (numeratorValue !== null && numeratorUnit && denominatorUnit) {
      const denominatorValue = ratio[3] ? toNumber(ratio[3]) : 1;
      if (denominatorValue !== null) {
        const parsed: Concentration = {
          numerator: { value: numeratorValue, unit: numeratorUnit },
          perVolume: { value: denominatorValue, unit: denominatorUnit },
          raw: ratio[0],
          formatted: '',
        };
        parsed.formatted = formatConcentration(parsed);
        return parsed;
      }
    }
  }

  const simple = SIMPLE_PATTERN.exec(text);
  if (simple) {
    const value = toNumber(simple[1]);
    const unit = canonicalUnit(simple[2]);
    if (value !== null && unit) {
      const parsed: Concentration = {
        numerator: { value, unit },
        perVolume: null,
        raw: simple[0],
        formatted: '',
      };
      parsed.formatted = formatConcentration(parsed);
      return parsed;
    }
  }

  return null;
}

/**
 * Script-neutral word boundary. JavaScript's `\b` is defined on ASCII word
 * characters even under /u, so `\bأقراص\b` never matches — both sides of the
 * Arabic run look like non-word characters and no boundary is produced. These
 * lookarounds work identically for Latin and Arabic.
 */
const boundedAlternatives = (alternatives: string): RegExp =>
  new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${alternatives})(?![\p{L}\p{N}])`, 'iu');

/** Dosage forms, bilingual. Order matters: longer/more specific first. */
const DOSAGE_FORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [boundedAlternatives('film[- ]?coated tablets?|أقراص ملبسة'), 'Film-coated tablet'],
  [boundedAlternatives('effervescent tablets?|أقراص فوارة'), 'Effervescent tablet'],
  [boundedAlternatives('tablets?|tabs?|أقراص|قرص|حبوب'), 'Tablet'],
  [boundedAlternatives('capsules?|caps?|كبسولات|كبسولة'), 'Capsule'],
  [boundedAlternatives('oral suspension|معلق فموي|شراب معلق'), 'Oral suspension'],
  [boundedAlternatives('syrups?|شراب'), 'Syrup'],
  [boundedAlternatives('injections?|ampoules?|amp|حقن|أمبولة|إبر'), 'Injection'],
  [boundedAlternatives('vials?|فايل|قنينة'), 'Vial'],
  [boundedAlternatives('infusions?|محلول وريدي'), 'Infusion'],
  [boundedAlternatives('creams?|كريم'), 'Cream'],
  [boundedAlternatives('ointments?|مرهم'), 'Ointment'],
  [boundedAlternatives('gels?|جل|هلام'), 'Gel'],
  [boundedAlternatives('eye drops?|قطرة عين|قطرات عين'), 'Eye drops'],
  [boundedAlternatives('ear drops?|قطرة أذن'), 'Ear drops'],
  [boundedAlternatives('drops?|قطرة|نقط'), 'Drops'],
  [boundedAlternatives('suppositor(?:y|ies)|تحاميل|لبوس'), 'Suppository'],
  [boundedAlternatives('inhalers?|بخاخ|مستنشق'), 'Inhaler'],
  [boundedAlternatives('sachets?|أكياس|كيس'), 'Sachet'],
  [boundedAlternatives('powders?|مسحوق|بودرة'), 'Powder'],
];

export function parseDosageForm(input: string): string | null {
  const text = normalizeWhitespace(input);
  for (const [pattern, canonical] of DOSAGE_FORMS) {
    if (pattern.test(text)) return canonical;
  }
  return null;
}

export interface PackSize {
  count: number;
  /** The per-item descriptor when stated, e.g. "tablets" in "20 tablets". */
  unitText: string | null;
  raw: string;
}

/**
 * "Box of 20 tablets", "20's", "علبة 20 قرص", "30 caps".
 * Requires an explicit countable context — a bare number is never a pack size.
 */
export function parsePackSize(input: string): PackSize | null {
  const text = normalizeWhitespace(normalizeDigits(input));

  const explicit = new RegExp(
    String.raw`(?:box\s+of|pack\s+of|علبة|عبوة)\s*(\d+)\s*(${UNIT_CHARS})?`,
    'iu',
  ).exec(text);
  if (explicit) {
    const count = Number(explicit[1]);
    if (Number.isFinite(count) && count > 0) {
      return { count, unitText: explicit[2] ?? null, raw: explicit[0] };
    }
  }

  const trailing = new RegExp(
    String.raw`\b(\d+)\s*(tablets?|tabs?|capsules?|caps?|ampoules?|vials?|sachets?|أقراص|كبسولات|أمبولات|أكياس)\b`,
    'iu',
  ).exec(text);
  if (trailing) {
    const count = Number(trailing[1]);
    if (Number.isFinite(count) && count > 0) {
      return { count, unitText: trailing[2], raw: trailing[0] };
    }
  }

  return null;
}
