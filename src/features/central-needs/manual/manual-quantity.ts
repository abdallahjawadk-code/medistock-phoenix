/**
 * R1-A4 — manual annual-need quantity text.
 *
 * The server stores the quantity as the exact text the human typed and NEVER normalizes it
 * (ADR §4.11). The client therefore validates the same canonical grammar and refuses anything else
 * with a precise reason; it never coerces, rounds, trims or converts digits behind the user's back.
 *
 * Grammar (identical to the database CHECK): `0`, or a positive integer without leading zeros,
 * optionally followed by `.` and digits that do not end in `0`. ASCII only, at most 256 characters.
 * Not accepted: sign, whitespace, exponent, grouping separators, a trailing dot, trailing zeros,
 * Arabic-Indic / Extended Arabic-Indic digits and the Arabic decimal/thousands separators.
 */
const CANONICAL = /^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$/;
const NON_ASCII_DIGITS = /[٠-٩۰-۹٫٬]/;
const MAX_LENGTH = 256;

export type ManualQuantityReason = 'empty' | 'non_ascii_digits' | 'too_long' | 'not_canonical';
export type ManualQuantityCheck = { ok: true; text: string } | { ok: false; reason: ManualQuantityReason };

export function checkManualQuantityText(text: unknown): ManualQuantityCheck {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, reason: 'empty' };
  if (NON_ASCII_DIGITS.test(text)) return { ok: false, reason: 'non_ascii_digits' };
  if (text.length > MAX_LENGTH) return { ok: false, reason: 'too_long' };
  if (!CANONICAL.test(text)) return { ok: false, reason: 'not_canonical' };
  return { ok: true, text };
}

/**
 * A DISPLAY-ONLY proposal for text typed with Arabic-Indic digits: the ASCII form the user may choose to
 * accept by retyping it. It is never submitted automatically and is only offered when the converted text
 * is itself canonical.
 */
export function proposeAsciiDigits(text: string): string | null {
  if (!NON_ASCII_DIGITS.test(text)) return null;
  const mapped = text
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.');
  return CANONICAL.test(mapped) && mapped.length <= MAX_LENGTH ? mapped : null;
}
