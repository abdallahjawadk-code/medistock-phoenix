/**
 * R1-A5 / S3 — strict whole-number parsing for direct-supply quantities.
 *
 * `parseInt` truncates ("12.5" -> 12, "1e3" -> 1) and `|| 0` turns garbage into a
 * valid zero. Neither is acceptable for a quantity that reaches a stock-affecting
 * RPC. This parser accepts ONLY canonical ASCII whole numbers within the safe
 * integer range and returns NaN for everything else, so every existing
 * `Number.isFinite(n)` guard keeps working and invalid text can never be mistaken
 * for a number.
 *
 * Deliberately not accepted: whitespace, sign, leading zeros, decimals,
 * exponents, separators, non-ASCII (e.g. Arabic-Indic) digits. A non-ASCII digit
 * is rejected rather than silently converted, because this workflow has no
 * echo/confirmation step.
 */
const CANONICAL_WHOLE = /^(0|[1-9][0-9]*)$/;

export function parseStrictWholeQuantity(text: string): number {
  if (typeof text !== 'string' || !CANONICAL_WHOLE.test(text)) return Number.NaN;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : Number.NaN;
}
