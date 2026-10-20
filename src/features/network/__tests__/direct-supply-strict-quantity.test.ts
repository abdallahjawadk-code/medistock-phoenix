/**
 * R1-A5 / S3 (DS-QTY) — direct-supply numeric input safety.
 *
 * Contract: a quantity typed into the direct-supply workflow is a whole number
 * written with ASCII digits only. "12.5", "1e3", "abc", "", "-3", " 7 " and
 * values beyond the safe-integer range are INVALID — they must be rejected, never
 * truncated by parseInt and never converted into a valid zero.
 *
 * Static assertions follow the repository convention (no React renderer wired
 * up); the parser itself is exercised dynamically.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseStrictWholeQuantity } from '../strict-quantity';

const operations = readFileSync(join(__dirname, '..', 'DirectSupplyOperations.tsx'), 'utf8');

describe('S3 — parseStrictWholeQuantity', () => {
  it.each([['0', 0], ['1', 1], ['25', 25], ['9007199254740991', 9007199254740991]])(
    'accepts canonical whole number %s',
    (text, expected) => {
      expect(parseStrictWholeQuantity(text)).toBe(expected);
    },
  );

  it.each([
    '', ' ', '12.5', '1e3', '1E3', 'abc', '12abc', '-3', '+3', '007', '1,000', ' 7', '7 ', '٣', '١٢',
    '9007199254740992', '99999999999999999999', 'Infinity', 'NaN', '0x10', '1_0',
  ])('rejects %j (never truncated, never zero)', (text) => {
    expect(Number.isNaN(parseStrictWholeQuantity(text))).toBe(true);
  });

  it('rejects non-string input without throwing', () => {
    expect(Number.isNaN(parseStrictWholeQuantity(undefined as unknown as string))).toBe(true);
    expect(Number.isNaN(parseStrictWholeQuantity(null as unknown as string))).toBe(true);
  });
});

describe('S3 — DirectSupplyOperations has no unsafe integer conversion', () => {
  it('no parseInt on a quantity field remains', () => {
    expect(operations).not.toMatch(/parseInt\(/);
  });

  it('the review form never converts an invalid value to a valid zero', () => {
    expect(operations).not.toMatch(/\|\|\s*0\)/);
    expect(operations).not.toMatch(/\?\?\s*'0'/);
    expect(operations).not.toMatch(/Math\.max\(0,/);
  });

  it('every quantity site uses the strict parser', () => {
    const uses = operations.match(/parseStrictWholeQuantity\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(8);
  });

  it('the review submit is blocked when any line value is invalid', () => {
    expect(operations).toMatch(/hasInvalidDecision/);
  });
});
