/**
 * PHARMA-OCR-A — deterministic parsing layer.
 * Run: npm test -- --run
 *
 * These are real behavioural tests of the domain logic, not source scans. They
 * exist because the parsing layer is where a silent error becomes a wrong
 * expiry or a wrong quantity on a real medicine.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeDigits, normalizeForMatching, normalizeForDisplay,
  parseNumber, applyValidatedCorrection, foldArabic,
} from '../parse/normalize';
import { parseConcentration, parseDosageForm, parsePackSize, canonicalUnit } from '../parse/units';
import { parseDate, isAmbiguous, isPlausibleExpiry } from '../parse/dates';
import { extractPharmaFields, bestCandidatePerField, isPlausibleBatch, isPlausibleNationalCode } from '../parse/fields';
import type { OcrDocumentResult, OcrLine } from '../types';

// ─── Test helpers: build an OcrDocumentResult from plain lines ───────────────

let boxCounter = 0;
function line(text: string, confidence = 90): OcrLine {
  const y = boxCounter++ * 20;
  const words = text.split(/\s+/).filter(Boolean).map((word, index) => ({
    text: word,
    box: { x0: index * 50, y0: y, x1: index * 50 + 45, y1: y + 18 },
    confidence,
    language: null,
  }));
  return {
    text,
    box: { x0: 0, y0: y, x1: Math.max(50, words.length * 50), y1: y + 18 },
    confidence,
    words,
  };
}

function document(lines: OcrLine[]): OcrDocumentResult {
  return {
    text: lines.map(l => l.text).join('\n'),
    lines,
    words: lines.flatMap(l => l.words),
    imageWidth: 1000,
    imageHeight: 1400,
    language: 'ara+eng',
    durationMs: 0,
    providerId: 'test',
  };
}

// ─── Numerals ────────────────────────────────────────────────────────────────

describe('Arabic/English numeral normalization', () => {
  it('converts Arabic-Indic digits to Western', () => {
    expect(normalizeDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
  });

  it('converts Eastern Arabic-Indic (Persian/Urdu) digits', () => {
    expect(normalizeDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
  });

  it('leaves Western digits and surrounding text untouched', () => {
    expect(normalizeDigits('LOT A-123 ٤٥')).toBe('LOT A-123 45');
  });

  it('parses a quantity written in Arabic-Indic digits', () => {
    expect(parseNumber('١٢٠')).toBe(120);
  });

  it('parses the Arabic decimal separator', () => {
    expect(parseNumber('١٢٫٥')).toBe(12.5);
  });

  it('refuses a non-numeric token rather than guessing a partial value', () => {
    expect(parseNumber('12A')).toBeNull();
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('١٢٣ ٤٥٦ ٧')).toBeNull();
  });

  it('strips thousands separators without corrupting the value', () => {
    expect(parseNumber('1,200')).toBe(1200);
  });
});

describe('Arabic orthographic folding is matching-only', () => {
  it('folds hamza, taa marbuta and alef maqsura for comparison', () => {
    expect(foldArabic('أدويـة')).toBe('ادويه');
    expect(normalizeForMatching('أَمُوكسيسيلين')).toBe(normalizeForMatching('اموكسيسيلين'));
  });

  it('display normalization preserves the original letters', () => {
    expect(normalizeForDisplay('أموكسيسيلين')).toContain('أ');
  });
});

// ─── Concentration ───────────────────────────────────────────────────────────

describe('Concentration parsing', () => {
  it('parses a simple strength', () => {
    const parsed = parseConcentration('500 mg');
    expect(parsed?.numerator).toEqual({ value: 500, unit: 'mg' });
    expect(parsed?.perVolume).toBeNull();
    expect(parsed?.formatted).toBe('500 mg');
  });

  it('parses a ratio concentration', () => {
    const parsed = parseConcentration('125 mg/5 ml');
    expect(parsed?.numerator).toEqual({ value: 125, unit: 'mg' });
    expect(parsed?.perVolume).toEqual({ value: 5, unit: 'ml' });
    expect(parsed?.formatted).toBe('125 mg/5 ml');
  });

  it('parses a ratio with an implicit unit denominator', () => {
    const parsed = parseConcentration('40 mg/ml');
    expect(parsed?.perVolume).toEqual({ value: 1, unit: 'ml' });
    expect(parsed?.formatted).toBe('40 mg/ml');
  });

  it('parses an Arabic ratio with Arabic-Indic digits', () => {
    const parsed = parseConcentration('١٢٥ ملغم / ٥ مل');
    expect(parsed?.numerator).toEqual({ value: 125, unit: 'mg' });
    expect(parsed?.perVolume).toEqual({ value: 5, unit: 'ml' });
  });

  it('parses micrograms, IU and percentages', () => {
    expect(parseConcentration('50 mcg')?.numerator.unit).toBe('mcg');
    expect(parseConcentration('1000 IU')?.numerator.unit).toBe('iu');
    expect(parseConcentration('0.9 %')?.numerator).toEqual({ value: 0.9, unit: '%' });
  });

  it('normalizes unit aliases', () => {
    expect(canonicalUnit('µg')).toBe('mcg');
    expect(canonicalUnit('ملغم')).toBe('mg');
    expect(canonicalUnit('I.U.')).toBe('iu');
  });

  it('returns null when the unit is unrecognised, rather than a bare number', () => {
    expect(parseConcentration('500 zzz')).toBeNull();
    expect(parseConcentration('no strength here')).toBeNull();
  });

  it('does not silently drop the "per" when the denominator unit is unknown', () => {
    // '125 mg/5 zzz' must not degrade to a plain '125 mg'.
    const parsed = parseConcentration('125 mg/5 zzz');
    expect(parsed?.perVolume ?? null).toBeNull();
    expect(parsed?.numerator).toEqual({ value: 125, unit: 'mg' });
  });
});

describe('Dosage form and pack size', () => {
  it('recognises bilingual dosage forms', () => {
    expect(parseDosageForm('Amoxicillin 500mg Capsules')).toBe('Capsule');
    expect(parseDosageForm('أقراص ملبسة')).toBe('Film-coated tablet');
    expect(parseDosageForm('شراب معلق')).toBe('Oral suspension');
  });

  it('prefers the more specific form', () => {
    expect(parseDosageForm('film-coated tablets')).toBe('Film-coated tablet');
  });

  it('requires a countable context for pack size — a bare number is never one', () => {
    expect(parsePackSize('20 tablets')?.count).toBe(20);
    expect(parsePackSize('علبة ٣٠ قرص')?.count).toBe(30);
    expect(parsePackSize('20')).toBeNull();
    expect(parsePackSize('Batch 4471')).toBeNull();
  });
});

// ─── Dates ───────────────────────────────────────────────────────────────────

describe('Date parsing', () => {
  it('parses an unambiguous day/month/year', () => {
    const parsed = parseDate('25/06/2027');
    expect(isAmbiguous(parsed)).toBe(false);
    expect((parsed as { iso: string }).iso).toBe('2027-06-25');
  });

  it('reports an ambiguous day/month order instead of guessing', () => {
    const parsed = parseDate('03/04/2027');
    expect(isAmbiguous(parsed)).toBe(true);
    expect((parsed as { candidates: string[] }).candidates).toEqual(['2027-04-03', '2027-03-04']);
  });

  it('resolves a month-only EXPIRY to the last day of the month', () => {
    const parsed = parseDate('06/2027', 'expiry');
    expect((parsed as { iso: string }).iso).toBe('2027-06-30');
    expect((parsed as { dayInferred: boolean }).dayInferred).toBe(true);
  });

  it('resolves a month-only MANUFACTURING date to the first day', () => {
    const parsed = parseDate('06/2027', 'manufacturing');
    expect((parsed as { iso: string }).iso).toBe('2027-06-01');
  });

  it('handles February in a leap year', () => {
    expect((parseDate('02/2028', 'expiry') as { iso: string }).iso).toBe('2028-02-29');
    expect((parseDate('02/2027', 'expiry') as { iso: string }).iso).toBe('2027-02-28');
  });

  it('parses ISO-first dates unambiguously', () => {
    expect((parseDate('2027/06/25') as { iso: string }).iso).toBe('2027-06-25');
  });

  it('parses named months in English and Arabic', () => {
    expect((parseDate('JUN 2027') as { iso: string }).iso).toBe('2027-06-30');
    expect((parseDate('12 يونيو 2027') as { iso: string }).iso).toBe('2027-06-12');
    expect((parseDate('حزيران 2027') as { iso: string }).iso).toBe('2027-06-30');
  });

  it('expands two-digit years within a plausible window', () => {
    expect((parseDate('06/27', 'expiry') as { iso: string }).iso).toBe('2027-06-30');
  });

  it('rejects an impossible date rather than clamping it', () => {
    expect(parseDate('32/13/2027')).toBeNull();
    expect(parseDate('00/00/0000')).toBeNull();
  });

  it('accepts dotted and dashed separators', () => {
    expect((parseDate('25.06.2027') as { iso: string }).iso).toBe('2027-06-25');
    expect((parseDate('25-06-2027') as { iso: string }).iso).toBe('2027-06-25');
  });

  it('flags an implausible expiry far outside the sane window', () => {
    const today = new Date('2026-07-20T00:00:00Z');
    expect(isPlausibleExpiry('2027-06-30', today)).toBe(true);
    expect(isPlausibleExpiry('2099-01-01', today)).toBe(false);
    expect(isPlausibleExpiry('2001-01-01', today)).toBe(false);
  });
});

// ─── Validated correction ────────────────────────────────────────────────────

describe('Confusion-pair correction is validator-gated, never blind', () => {
  it('corrects O→0 only because the validator proves the result', () => {
    // A national code must be digit-only, so '4O71234' FAILS validation and
    // exactly one substitution repairs it. (Note '4O71' would be a perfectly
    // valid BATCH number — letters are legal there — so batch is deliberately
    // not the validator used to demonstrate a correction.)
    const outcome = applyValidatedCorrection('4O71234', isPlausibleNationalCode);
    expect(outcome.value).toBe('4071234');
    expect(outcome.corrected).toBe(true);
    expect(outcome.original).toBe('4O71234');
  });

  it('does not "correct" a letter that is legitimate for the field', () => {
    // Same token, batch validator: letters are valid, so nothing changes.
    const outcome = applyValidatedCorrection('4O71', isPlausibleBatch);
    expect(outcome.value).toBe('4O71');
    expect(outcome.corrected).toBe(false);
  });

  it('leaves an already-valid value completely untouched', () => {
    const outcome = applyValidatedCorrection('B4071', isPlausibleBatch);
    expect(outcome.value).toBe('B4071');
    expect(outcome.corrected).toBe(false);
  });

  it('refuses to choose when two substitutions are equally valid', () => {
    // 'OO' yields two distinct single-edit readings, '0O' and 'O0'. Both
    // satisfy this validator, so there is no principled winner and the machine
    // must hand the decision to the operator rather than pick one.
    const acceptsEither = (candidate: string) => candidate === '0O' || candidate === 'O0';
    const outcome = applyValidatedCorrection('OO', acceptsEither);
    expect(outcome.corrected).toBe(false);
    expect(outcome.value).toBe('OO');
  });

  it('never corrects when nothing can satisfy the validator', () => {
    const outcome = applyValidatedCorrection('!!!', isPlausibleBatch);
    expect(outcome.corrected).toBe(false);
  });

  it('always retains the original as provenance', () => {
    const outcome = applyValidatedCorrection('l23456', isPlausibleNationalCode);
    expect(outcome.original).toBe('l23456');
  });
});

// ─── Field extraction ────────────────────────────────────────────────────────

describe('Field extraction with label proximity', () => {
  it('extracts batch, expiry, quantity and national code from an English document', () => {
    boxCounter = 0;
    const result = extractPharmaFields(document([
      line('Amoxicillin 500 mg Capsules'),
      line('LOT: B4471X'),
      line('EXP: 06/2027'),
      line('Quantity: 240'),
      line('National Code: 1234567'),
      line('Invoice No: INV-2026-0088'),
    ]));

    const best = bestCandidatePerField(result.candidates);
    expect(best.get('batchNumber')?.best.value).toBe('B4471X');
    expect(best.get('expiryDate')?.best.value).toBe('2027-06-30');
    expect(best.get('quantity')?.best.value).toBe('240');
    expect(best.get('nationalCode')?.best.value).toBe('1234567');
    expect(best.get('sourceDocumentNumber')?.best.value).toBe('INV-2026-0088');
    expect(best.get('concentration')?.best.value).toBe('500 mg');
    expect(best.get('dosageForm')?.best.value).toBe('Capsule');
  });

  it('extracts from an Arabic document with Arabic-Indic digits', () => {
    boxCounter = 0;
    const result = extractPharmaFields(document([
      line('أموكسيسيلين ٥٠٠ ملغم كبسولات'),
      line('رقم التشغيلة: ب٤٤٧١'),
      line('تاريخ الانتهاء: ٠٦/٢٠٢٧'),
      line('الكمية: ٢٤٠'),
    ]));

    const best = bestCandidatePerField(result.candidates);
    expect(best.get('expiryDate')?.best.value).toBe('2027-06-30');
    expect(best.get('quantity')?.best.value).toBe('240');
    expect(best.get('dosageForm')?.best.value).toBe('Capsule');
  });

  it('retains a bounding box and source text on every candidate', () => {
    boxCounter = 0;
    const result = extractPharmaFields(document([line('LOT: B4471X')]));
    const candidate = result.candidates.find(c => c.field === 'batchNumber');
    expect(candidate).toBeDefined();
    expect(candidate!.box.x1).toBeGreaterThan(candidate!.box.x0);
    expect(candidate!.sourceText).toBeTruthy();
    expect(candidate!.matchedLabel).toBeTruthy();
  });

  it('surfaces an ambiguous expiry as alternatives rather than a single value', () => {
    boxCounter = 0;
    const result = extractPharmaFields(document([line('EXP: 03/04/2027')]));
    const expiry = result.candidates.find(c => c.field === 'expiryDate');
    expect(expiry?.ambiguousAlternatives).toEqual(['2027-04-03', '2027-03-04']);
  });

  it('does not match a label embedded inside a longer word', () => {
    boxCounter = 0;
    const result = extractPharmaFields(document([line('barcode 9876543210')]));
    expect(result.candidates.find(c => c.field === 'nationalCode')).toBeUndefined();
  });

  it('rejects a non-integer quantity instead of rounding it', () => {
    boxCounter = 0;
    const result = extractPharmaFields(document([line('Quantity: 12.5')]));
    expect(result.candidates.find(c => c.field === 'quantity')).toBeUndefined();
  });

  it('invents nothing — a document with no recognisable fields yields none', () => {
    boxCounter = 0;
    const result = extractPharmaFields(document([line('hello world'), line('lorem ipsum')]));
    const fields = result.candidates.map(c => c.field);
    expect(fields).not.toContain('batchNumber');
    expect(fields).not.toContain('expiryDate');
    expect(fields).not.toContain('quantity');
    expect(result.unmatchedLines.length).toBeGreaterThan(0);
  });

  it('prefers a labelled candidate over an unlabelled one of the same field', () => {
    boxCounter = 0;
    const result = extractPharmaFields(document([
      line('some 500 mg text', 99),
      line('Trade Name: Augmentin', 50),
    ]));
    const best = bestCandidatePerField(result.candidates);
    expect(best.get('tradeName')?.best.matchedLabel).toBeTruthy();
  });
});

describe('Format validators', () => {
  it('accepts realistic batch numbers and rejects implausible ones', () => {
    expect(isPlausibleBatch('B4471X')).toBe(true);
    expect(isPlausibleBatch('4071')).toBe(true);
    expect(isPlausibleBatch('AB/2024-1')).toBe(true);
    expect(isPlausibleBatch('ABCDEF')).toBe(false); // no digit
    expect(isPlausibleBatch('X')).toBe(false);      // too short
  });

  it('rejects a garbled LABEL word offered as a batch value', () => {
    // Measured regression from tools/ocr-eval: "Batch Number PC2291" on a
    // rotated scan yielded "NUM8ER" as the batch. It is alphanumeric and
    // contains a digit, so the shape check alone accepted it.
    expect(isPlausibleBatch('NUM8ER')).toBe(false);
    expect(isPlausibleBatch('C0DE')).toBe(false);
    expect(isPlausibleBatch('1NVOICE')).toBe(false);
    // The rejection is narrow by design: only exact folds onto a known label
    // word are refused, so short real codes are unaffected.
    expect(isPlausibleBatch('B4471X')).toBe(true);
    expect(isPlausibleBatch('MT7741')).toBe(true);
    expect(isPlausibleBatch('QT1')).toBe(true);
  });

  it('normalizes batch case so an OCR lowercase suffix is not a wrong value', () => {
    boxCounter = 0;
    const result = extractPharmaFields(document([line('LOT: b4471x')]));
    expect(result.candidates.find(c => c.field === 'batchNumber')?.value).toBe('B4471X');
  });

  it('offers an unlabelled headline drug name as a low-confidence candidate', () => {
    boxCounter = 0;
    const result = extractPharmaFields(document([line('Amoxicillin 500 mg Capsules')]));
    const name = result.candidates.find(c => c.field === 'scientificName');
    expect(name?.value).toBe('Amoxicillin');
    // No label vouched for it, so it can never reach "high" confidence.
    expect(name?.matchedLabel).toBeNull();
  });

  it('does not smuggle document chrome into the headline name', () => {
    boxCounter = 0;
    const result = extractPharmaFields(document([line('Warehouse Intake Consolidated Report 500 mg')]));
    expect(result.candidates.find(c => c.field === 'scientificName')).toBeUndefined();
  });

  it('requires national codes to be digit-dominant', () => {
    expect(isPlausibleNationalCode('1234567')).toBe(true);
    expect(isPlausibleNationalCode('12-345-67')).toBe(true);
    expect(isPlausibleNationalCode('ABC1234')).toBe(false);
    expect(isPlausibleNationalCode('123')).toBe(false);
  });
});
