/**
 * BUGFIX-REPORTS-DATES-PORT-CLEAR-A
 *
 * 1. Print/Save PDF: window.open('', '_blank') can return null (popup
 *    blocked by the browser). Previously every print handler did a silent
 *    `if (!win) return;` — the user clicked, nothing happened, no message.
 *    Now each shows the translated print_popup_blocked toast instead.
 * 2. Dates: Arabic RTL bidi can visually reorder a slash-separated digit
 *    string (e.g. "2026/7/3" rendering as "3/7/2026" or worse). Date/time
 *    values now go through the stable, locale-independent formatStableDate /
 *    formatStableDateTime helpers, and every date-shaped column/meta line in
 *    the generated print HTML carries an explicit dir="ltr" — not just the
 *    on-screen table, which already had it in most places.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
const movementReport = readSrc('features/status/MovementReportSection.tsx');
const movementHistory = readSrc('features/status/MovementHistoryModal.tsx');

describe('StatusCenterScreen: print popup-blocked handling', () => {
  it('printReport shows print_popup_blocked instead of a silent return when window.open fails', () => {
    // SAFE-PROFESSIONAL-XLSX-EXPORT-A: exportCsv (the previous slice bound)
    // was replaced by exportXlsx.
    const fnBody = statusCenter.slice(statusCenter.indexOf('function printReport'), statusCenter.indexOf('async function exportXlsx'));
    expect(fnBody).toMatch(/if \(!win\) \{/);
    expect(fnBody).toContain("t('print_popup_blocked', lang)");
    expect(fnBody).not.toMatch(/if \(!win\) return;/);
  });
});

describe('StatusCenterScreen: stable date rendering', () => {
  it('the "updated" column value uses formatStableDate, not toLocaleDateString', () => {
    expect(statusCenter).toContain("value: r => formatStableDate(r.updated_at, lang)");
    expect(statusCenter).not.toMatch(/updated_at.*toLocaleDateString/);
  });

  it('generatedAt uses formatStableDateTime, not toLocaleString', () => {
    expect(statusCenter).toContain('const generatedAt = () => formatStableDateTime(new Date(), lang);');
  });

  it('print HTML wraps date-shaped columns (expiry, updated) with dir="ltr" per cell', () => {
    const fnBody = statusCenter.slice(statusCenter.indexOf('function buildReportHtml'), statusCenter.indexOf('function printReport'));
    expect(fnBody).toContain('LTR_COLUMN_KEYS.has(c.key)');
    expect(fnBody).toContain('dir="ltr"');
  });

  it('print HTML wraps the "generated at" value with dir="ltr"', () => {
    const fnBody = statusCenter.slice(statusCenter.indexOf('function buildReportHtml'), statusCenter.indexOf('function printReport'));
    expect(fnBody).toMatch(/generatedAt\(\)\)\}<\/span>/);
    expect(fnBody).toMatch(/<span class="val" dir="ltr">/);
  });

  it('LTR_COLUMN_KEYS includes exactly the date-shaped columns', () => {
    expect(statusCenter).toContain("const LTR_COLUMN_KEYS = new Set(['expiry', 'updated']);");
  });
});

describe('MovementReportSection: print popup-blocked handling', () => {
  it('printReport shows print_popup_blocked instead of a silent return when window.open fails', () => {
    const fnBody = movementReport.slice(movementReport.indexOf('function printReport'), movementReport.indexOf('function exportCsv'));
    expect(fnBody).toMatch(/if \(!win\) \{/);
    expect(fnBody).toContain("showToast(t('print_popup_blocked', lang))");
    expect(fnBody).not.toMatch(/if \(!win\) return;/);
  });

  it('renders the toast when set', () => {
    expect(movementReport).toContain('{toast && <PhoenixToast message={toast} />}');
  });
});

describe('MovementReportSection: stable date rendering', () => {
  it('the datetime column value uses formatStableDateTime, not toLocaleString', () => {
    expect(movementReport).toContain('value: r => formatStableDateTime(r.createdAt, lang)');
    expect(movementReport).not.toMatch(/r\.createdAt.*toLocaleString/);
  });

  it('generatedAt uses formatStableDateTime, not toLocaleString', () => {
    expect(movementReport).toContain('const generatedAt = () => formatStableDateTime(new Date(), lang);');
  });

  it('print HTML wraps date/numeric columns (datetime, before, delta, after) with dir="ltr" per cell', () => {
    expect(movementReport).toContain("const LTR_COLUMN_KEYS = new Set(['datetime', 'before', 'delta', 'after']);");
    const fnBody = movementReport.slice(movementReport.indexOf('function buildReportHtml'), movementReport.indexOf('function printReport'));
    expect(fnBody).toContain('LTR_COLUMN_KEYS.has(c.key)');
  });

  it('the on-screen table reuses the same LTR_COLUMN_KEYS set (single source of truth)', () => {
    expect(movementReport).toContain("dir={LTR_COLUMN_KEYS.has(c.key) ? 'ltr' : 'auto'}");
  });

  it('print HTML wraps the "generated at" value with dir="ltr"', () => {
    const fnBody = movementReport.slice(movementReport.indexOf('function buildReportHtml'), movementReport.indexOf('function printReport'));
    expect(fnBody).toMatch(/<span class="val" dir="ltr">/);
  });
});

describe('MovementHistoryModal: stable date rendering', () => {
  it('the datetime cell uses formatStableDateTime, not toLocaleString', () => {
    expect(movementHistory).toContain('{formatStableDateTime(m.createdAt, lang)}');
    expect(movementHistory).not.toMatch(/new Date\(m\.createdAt\)\.toLocaleString/);
  });

  it('the datetime cell still renders dir="ltr" (on-screen bidi safety preserved)', () => {
    expect(movementHistory).toMatch(/<td style=\{td\} dir="ltr">\{formatStableDateTime/);
  });
});

describe('Guards: no unrelated changes', () => {
  it('no inter_org_exchange reference was added to any file touched in this phase', () => {
    for (const src of [statusCenter, movementReport, movementHistory]) {
      expect(src).not.toMatch(/inter_org_exchange/i);
    }
  });

  it('no service_role/auth.admin usage in any file touched in this phase', () => {
    for (const src of [statusCenter, movementReport, movementHistory]) {
      expect(src).not.toMatch(/service_role|auth\.admin/i);
    }
  });
});
