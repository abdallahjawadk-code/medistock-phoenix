/**
 * BUGFIX-REPORTS-DATES-PORT-CLEAR-A
 *
 * formatStableDate / formatStableDateTime must produce a fixed-order,
 * locale-independent string — never delegate to toLocaleString('ar', ...),
 * whose ICU output and digit set vary across runtimes and can visually
 * reorder under RTL bidi without an explicit LTR wrapper.
 */
import { describe, it, expect } from 'vitest';
import { formatStableDate, formatStableDateTime } from '../date';

describe('formatStableDate', () => {
  it('formats Arabic as YYYY/MM/DD', () => {
    expect(formatStableDate('2026-07-03T10:00:00Z', 'ar')).toMatch(/^2026\/\d{2}\/\d{2}$/);
  });

  it('formats English as YYYY-MM-DD', () => {
    expect(formatStableDate('2026-07-03T10:00:00Z', 'en')).toMatch(/^2026-\d{2}-\d{2}$/);
  });

  it('zero-pads single-digit month and day (regression: no "32026/7/"-style malformed output)', () => {
    const d = new Date(2026, 6, 3); // July 3, 2026 — local time, month/day both single-digit source values
    const out = formatStableDate(d, 'ar');
    expect(out).toBe('2026/07/03');
    expect(out).not.toMatch(/^3/); // must not start with the day digit (the reported bug's visual symptom)
  });

  it('returns em-dash for null/undefined/empty input', () => {
    expect(formatStableDate(null, 'ar')).toBe('—');
    expect(formatStableDate(undefined, 'en')).toBe('—');
    expect(formatStableDate('', 'ar')).toBe('—');
  });

  it('returns em-dash for an invalid date string instead of "Invalid Date"', () => {
    expect(formatStableDate('not-a-date', 'ar')).toBe('—');
  });

  it('never contains Arabic-Indic digits or bidi control characters', () => {
    const out = formatStableDate('2026-07-03T10:00:00Z', 'ar');
    expect(out).not.toMatch(/[٠-٩]/); // Arabic-Indic digits
    expect(out).not.toMatch(/[‎‏⁦-⁩]/); // bidi control chars
  });
});

describe('formatStableDateTime', () => {
  it('formats Arabic as YYYY/MM/DD hh:mm:ss + ص/م period', () => {
    const out = formatStableDateTime('2026-07-03T10:15:30', 'ar');
    expect(out).toMatch(/^2026\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} (ص|م)$/);
  });

  it('formats English as YYYY-MM-DD hh:mm:ss + AM/PM period', () => {
    const out = formatStableDateTime('2026-07-03T10:15:30', 'en');
    expect(out).toMatch(/^2026-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (AM|PM)$/);
  });

  it('midnight (00:xx) renders as 12 with the correct period, not 00', () => {
    const d = new Date(2026, 6, 3, 0, 5, 0);
    const out = formatStableDateTime(d, 'en');
    expect(out).toContain('12:05:00 AM');
  });

  it('noon (12:xx) renders as 12 PM, not 00', () => {
    const d = new Date(2026, 6, 3, 12, 5, 0);
    const out = formatStableDateTime(d, 'en');
    expect(out).toContain('12:05:00 PM');
  });

  it('returns em-dash for null/undefined input', () => {
    expect(formatStableDateTime(null, 'ar')).toBe('—');
    expect(formatStableDateTime(undefined, 'en')).toBe('—');
  });

  it('never contains Arabic-Indic digits or bidi control characters', () => {
    const out = formatStableDateTime('2026-07-03T10:15:30', 'ar');
    expect(out).not.toMatch(/[٠-٩]/);
    expect(out).not.toMatch(/[‎‏⁦-⁩]/);
  });
});
