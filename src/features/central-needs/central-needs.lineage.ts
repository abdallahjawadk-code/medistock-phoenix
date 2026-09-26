/**
 * C5 (M217 companion) — the client side of quantity lineage.
 *
 * Presentation rules only. The server decides every one of these again — the
 * `designated_quantity_not_canonical` lexeme check, the shared lineage helper
 * and the override chronology — so nothing here is an authority. What this
 * module guarantees is that the UI never PROPOSES or SENDS something the
 * contract says it must not:
 *
 *   §13  the override chain arrives complete and in server order, or not at
 *        all (`OverrideReadState`);
 *   §14  a source record's head is the FIRST row of its exact `sourceRecordId`
 *        in that server order — never a client re-sort, never a key built from
 *        header text;
 *   §15  a quantity is suggested only from the two safe evidence shapes, typed
 *        quantities use the server's exact decimal grammar untrimmed, and only
 *        a JSON-number override can stand in for a numeric quantity; the
 *        numeric preview's "exact" verdict compares values, not spellings.
 */
import type { FieldOverride } from './central-needs.service';

/**
 * §13 — whether the revision's override chain was read completely. Anything
 * but `ready` withholds every override-dependent write (need-line saves and
 * override creation) while the rest of the screen stays readable.
 */
export type OverrideReadState =
  | { phase: 'ready'; overrides: FieldOverride[] }
  | { phase: 'unavailable'; code: string };

/** §10/§15 — the server's exact decimal grammar: no sign, exponent, grouping, whitespace, `.5`, `5.` or `007`. */
export const SERVER_DECIMAL = /^(?:0|[1-9][0-9]*)(?:[.][0-9]+)?$/;

/** §15 rule B — a whole number written as text, exactly. */
export const CANONICAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;

/** §10 — the longest quantity lexeme the server accepts. */
export const MAX_QUANTITY_LEXEME_LENGTH = 256;

/** A typed quantity exactly as the server will read it — untrimmed, never normalized here. */
export function isCanonicalQuantity(text: string): boolean {
  return text.length <= MAX_QUANTITY_LEXEME_LENGTH && SERVER_DECIMAL.test(text);
}

/**
 * §15 — the ONLY automatic quantity suggestions:
 *   A. a `number` cell holding a finite JS number >= 0 whose `String()` is a
 *      canonical decimal of at most 256 characters;
 *   B. a `string` cell of at most 256 characters that is exactly a canonical
 *      whole number.
 * Anything else — a text decimal, a sign, an exponent, a padded value, a
 * formula error, a cell with no `valueType` — suggests nothing.
 */
export function prefillQuantity(sourceValues: Record<string, unknown>): string | null {
  const value = sourceValues.value;
  if (sourceValues.valueType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    const text = String(value);
    return isCanonicalQuantity(text) ? text : null;
  }
  if (sourceValues.valueType === 'string') {
    if (typeof value !== 'string' || value.length > MAX_QUANTITY_LEXEME_LENGTH) return null;
    return CANONICAL_INTEGER.test(value) ? value : null;
  }
  return null;
}

/** §15 — only a JSON-number override (finite, >= 0) can serve as a numeric quantity override. Text never does. */
export function isNumericOverride(o: FieldOverride): boolean {
  return typeof o.finalValue === 'number' && Number.isFinite(o.finalValue) && o.finalValue >= 0;
}

/**
 * A numeric override's exact decimal, when the server grammar accepts it. It
 * prefers `final_value::text`, because `finalValue` went through JSON.parse and
 * a large exact decimal is already rounded there.
 */
export function numericOverrideLexeme(o: FieldOverride): string | null {
  if (!isNumericOverride(o)) return null;
  const text = typeof o.finalValueText === 'string' ? o.finalValueText : String(o.finalValue);
  return isCanonicalQuantity(text) ? text : null;
}

/** An override's value as display text; `null` is the explicit blank. */
export function overrideValueText(o: FieldOverride): string | null {
  const v = o.finalValue;
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && typeof o.finalValueText === 'string') return o.finalValueText;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * §14 — the head of each source record: the FIRST row of its exact
 * `sourceRecordId` in the server's `created_at DESC, id DESC` order. The chain
 * is never re-sorted here and never keyed by row or header text, which the
 * corpus duplicates across sessions and columns.
 */
export function overrideHeads(overrides: readonly FieldOverride[]): ReadonlyMap<string, FieldOverride> {
  const heads = new Map<string, FieldOverride>();
  for (const o of overrides) {
    if (!heads.has(o.sourceRecordId)) heads.set(o.sourceRecordId, o);
  }
  return heads;
}

/** A JSON number's text: optional sign, digits, optional fraction, optional exponent. */
const JSON_NUMBER_TEXT = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * The canonical plain decimal of a decimal or JSON-number TEXT: the exponent
 * (if any) applied by moving the decimal point over the digit string, then
 * leading integer zeros and trailing fraction zeros dropped. Pure string
 * arithmetic, so the value is never routed through another float. `null` when
 * the text is not a number, or its exponent is too large to expand honestly.
 *
 *   '1e-7'   -> '0.0000001'        '1e+21' -> '1000000000000000000000'
 *   '1.50'   -> '1.5'              '0.0'   -> '0'
 */
export function canonicalDecimalText(text: string): string | null {
  const m = JSON_NUMBER_TEXT.exec(text);
  if (!m) return null;
  const [, sign, whole, frac = '', expText = '0'] = m;
  const exponent = Number(expText);
  // A finite double never needs more than ~330 places either way; anything
  // beyond that is not a value this preview could have produced.
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400) return null;
  const digits = whole + frac;
  const point = whole.length + exponent;
  let intPart: string;
  let fracPart: string;
  if (point <= 0) {
    intPart = '0';
    fracPart = '0'.repeat(-point) + digits;
  } else if (point >= digits.length) {
    intPart = digits + '0'.repeat(point - digits.length);
    fracPart = '';
  } else {
    intPart = digits.slice(0, point);
    fracPart = digits.slice(point);
  }
  intPart = intPart.replace(/^0+(?=\d)/, '');
  fracPart = fracPart.replace(/0+$/, '');
  const body = fracPart === '' ? intPart : `${intPart}.${fracPart}`;
  return sign === '-' && body !== '0' ? `-${body}` : body;
}

/**
 * §15 — a NUMERIC override is created only from a canonical decimal, and what
 * is shown for confirmation is the JSON number that will actually be sent:
 * `JSON.stringify(Number(raw))`. A value JavaScript cannot hold exactly shows
 * its rounding there, before anything is written.
 *
 * `exact` compares the two NUMERICALLY, as canonical plain decimals — never as
 * raw text. JSON.stringify prints some exact values in exponent form (`1e-7`
 * for 0.0000001, `1e+21` for 10^21); jsonb stores such a number as exactly the
 * typed decimal, so it must not be flagged as "not exact". Scale-insensitive,
 * like the server's own comparison: '1.50' is sent as 1.5 and is exact.
 */
export function numericOverridePreview(raw: string):
  | { ok: true; value: number; json: string; exact: boolean }
  | { ok: false; reason: 'number_required' | 'override_number_not_canonical' } {
  if (raw === '') return { ok: false, reason: 'number_required' };
  if (!isCanonicalQuantity(raw)) return { ok: false, reason: 'override_number_not_canonical' };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { ok: false, reason: 'override_number_not_canonical' };
  const json = JSON.stringify(value);
  const sent = canonicalDecimalText(json);
  const typed = canonicalDecimalText(raw);
  // Fail closed: anything that cannot be compared is reported as not exact.
  return { ok: true, value, json, exact: sent !== null && typed !== null && sent === typed };
}
