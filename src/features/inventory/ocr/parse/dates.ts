/**
 * PHARMA-OCR-A — expiry and manufacturing date parsing.
 *
 * Expiry drives quarantine and dispensing decisions, so this parser is
 * deliberately conservative:
 *
 *  - an ambiguous day/month order (03/04/2027) is reported as AMBIGUOUS, never
 *    silently resolved by locale;
 *  - a month-year expiry (common on blisters) resolves to the LAST day of that
 *    month, which is the regulatory meaning of "EXP 06/2027";
 *  - a month-year manufacturing date resolves to the FIRST day;
 *  - two-digit years are only accepted inside a plausible window.
 */
import { normalizeDigits, normalizeWhitespace } from './normalize';

export type DateKind = 'expiry' | 'manufacturing';

export interface ParsedDate {
  /** ISO 'YYYY-MM-DD'. */
  iso: string;
  /** True when only month+year were present and the day was derived. */
  dayInferred: boolean;
  raw: string;
}

export interface AmbiguousDate {
  ambiguous: true;
  /** Both readings, ISO, so the review UI can offer an explicit choice. */
  candidates: string[];
  raw: string;
}

export type DateParseResult = ParsedDate | AmbiguousDate | null;

export const isAmbiguous = (result: DateParseResult): result is AmbiguousDate =>
  result !== null && 'ambiguous' in result;

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, ينا: 1, يناير: 1, 'كانون الثاني': 1,
  feb: 2, february: 2, فبر: 2, فبراير: 2, شباط: 2,
  mar: 3, march: 3, مار: 3, مارس: 3, آذار: 3, اذار: 3,
  apr: 4, april: 4, أبر: 4, ابريل: 4, أبريل: 4, نيسان: 4,
  may: 5, ماي: 5, مايو: 5, أيار: 5, ايار: 5,
  jun: 6, june: 6, يون: 6, يونيو: 6, حزيران: 6,
  jul: 7, july: 7, يول: 7, يوليو: 7, تموز: 7,
  aug: 8, august: 8, أغس: 8, اغسطس: 8, آب: 8,
  sep: 9, sept: 9, september: 9, سبت: 9, سبتمبر: 9, أيلول: 9, ايلول: 9,
  oct: 10, october: 10, أكت: 10, اكتوبر: 10, 'تشرين الأول': 10,
  nov: 11, november: 11, نوف: 11, نوفمبر: 11, 'تشرين الثاني': 11,
  dec: 12, december: 12, ديس: 12, ديسمبر: 12, 'كانون الأول': 12,
};

/** Labels that introduce an expiry, in both languages and their OCR-mangled forms. */
export const EXPIRY_LABELS = [
  'exp', 'exp.', 'expiry', 'expiry date', 'expires', 'expiration', 'expiration date',
  'use before', 'best before', 'e.d.', 'ed',
  'انتهاء', 'تاريخ الانتهاء', 'تاريخ انتهاء الصلاحية', 'صالح لغاية', 'ينتهي',
  'تنتهي الصلاحية', 'الصلاحية',
] as const;

export const MANUFACTURING_LABELS = [
  'mfg', 'mfg.', 'mfd', 'manufactured', 'manufacturing date', 'date of manufacture', 'prod', 'production date',
  'تاريخ الإنتاج', 'تاريخ الانتاج', 'إنتاج', 'انتاج', 'تصنيع', 'تاريخ التصنيع',
] as const;

/** Two-digit years map into this window; outside it we refuse rather than guess. */
const TWO_DIGIT_BASE_CENTURY = 2000;
const MIN_YEAR = 1990;
const MAX_YEAR = 2099;

const lastDayOfMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

const toIso = (year: number, month: number, day: number): string =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

function expandYear(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (raw.length === 4) return value >= MIN_YEAR && value <= MAX_YEAR ? value : null;
  if (raw.length === 2) {
    const expanded = TWO_DIGIT_BASE_CENTURY + value;
    return expanded >= MIN_YEAR && expanded <= MAX_YEAR ? expanded : null;
  }
  return null;
}

const validMonth = (month: number) => month >= 1 && month <= 12;
const validDay = (year: number, month: number, day: number) => day >= 1 && day <= lastDayOfMonth(year, month);

/**
 * Parse a date expression. `kind` only affects how a missing day is filled:
 * expiry → end of month, manufacturing → start of month.
 */
export function parseDate(input: string, kind: DateKind = 'expiry'): DateParseResult {
  const text = normalizeWhitespace(normalizeDigits(input)).replace(/[.\-–]/g, '/');
  if (!text) return null;

  // ── Named month: "JUN 2027", "12 يونيو 2027", "June 12, 2027" ──
  const monthNamePattern = new RegExp(
    String.raw`(?:(\d{1,2})\s*)?([A-Za-z؀-ۿ]{3,20}(?:\s[A-Za-z؀-ۿ]{3,10})?)\s*,?\s*(\d{4}|\d{2})(?!\d)`,
    'u',
  );
  const named = monthNamePattern.exec(text);
  if (named) {
    const monthKey = named[2].toLowerCase().trim();
    const month = MONTH_NAMES[monthKey];
    const year = expandYear(named[3]);
    if (month && year !== null) {
      if (named[1]) {
        const day = Number(named[1]);
        if (validDay(year, month, day)) {
          return { iso: toIso(year, month, day), dayInferred: false, raw: named[0] };
        }
      }
      const day = kind === 'expiry' ? lastDayOfMonth(year, month) : 1;
      return { iso: toIso(year, month, day), dayInferred: true, raw: named[0] };
    }
  }

  // ── Numeric with three parts: 12/06/2027 ──
  const triple = /(\d{1,4})\/(\d{1,2})\/(\d{1,4})/.exec(text);
  if (triple) {
    const [, first, second, third] = triple;

    // ISO-first (2027/06/12) is unambiguous.
    if (first.length === 4) {
      const year = expandYear(first);
      const month = Number(second);
      const day = Number(third);
      if (year !== null && validMonth(month) && validDay(year, month, day)) {
        return { iso: toIso(year, month, day), dayInferred: false, raw: triple[0] };
      }
      return null;
    }

    const year = expandYear(third);
    if (year === null) return null;
    const a = Number(first);
    const b = Number(second);

    const dayMonthValid = validMonth(b) && validDay(year, b, a);
    const monthDayValid = validMonth(a) && validDay(year, a, b);

    if (dayMonthValid && monthDayValid && a !== b) {
      // Genuinely ambiguous (03/04/2027). Refusing to choose is the whole point:
      // a wrong expiry by three months is a real dispensing hazard.
      return {
        ambiguous: true,
        candidates: [toIso(year, b, a), toIso(year, a, b)],
        raw: triple[0],
      };
    }
    if (dayMonthValid) return { iso: toIso(year, b, a), dayInferred: false, raw: triple[0] };
    if (monthDayValid) return { iso: toIso(year, a, b), dayInferred: false, raw: triple[0] };
    return null;
  }

  // ── Numeric month/year: "06/2027", "06/27" ──
  const pair = /(\d{1,2})\/(\d{4}|\d{2})(?!\d)/.exec(text);
  if (pair) {
    const month = Number(pair[1]);
    const year = expandYear(pair[2]);
    if (validMonth(month) && year !== null) {
      const day = kind === 'expiry' ? lastDayOfMonth(year, month) : 1;
      return { iso: toIso(year, month, day), dayInferred: true, raw: pair[0] };
    }
  }

  return null;
}

/** True when an ISO expiry is in the past relative to `today`. */
export function isExpired(iso: string, today = new Date()): boolean {
  const todayIso = today.toISOString().slice(0, 10);
  return iso < todayIso;
}

/**
 * Sanity window for an expiry read off a package. A date decades out or already
 * long past is far more likely an OCR misread than a real value, and is flagged
 * for review rather than accepted.
 */
export function isPlausibleExpiry(iso: string, today = new Date()): boolean {
  const year = Number(iso.slice(0, 4));
  const currentYear = today.getUTCFullYear();
  return year >= currentYear - 5 && year <= currentYear + 15;
}
