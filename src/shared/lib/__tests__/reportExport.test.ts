/**
 * FINAL-EXPORT-REPORTS-PRO-A
 * Unit tests for the shared CSV/print report helpers (src/shared/lib/reportExport.ts).
 * Run: npm test -- --run
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  escHtml,
  csvSafeCell,
  buildStableFileName,
  buildCsvContent,
  buildPrintDocument,
  isLikelyMobilePrintContext,
  REPORT_BRAND,
  type ReportColumn,
} from '@/shared/lib/reportExport';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const moduleSrc = read('shared/lib/reportExport.ts');

interface Row { id: string; name: string; qty: number; when: string; }

const columns: ReportColumn<Row>[] = [
  { key: 'name', label: 'Name', value: r => r.name },
  { key: 'qty', label: 'Qty', value: r => String(r.qty) },
  { key: 'when', label: 'When', value: r => r.when, ltr: true },
];

describe('escHtml', () => {
  it('escapes all five dangerous characters', () => {
    expect(escHtml(`<script>&"'</script>`)).toBe('&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;');
  });

  it('leaves Arabic text untouched (no corruption / question marks)', () => {
    expect(escHtml('مستشفى بابل العام')).toBe('مستشفى بابل العام');
  });
});

describe('csvSafeCell (CSV-injection protection)', () => {
  it.each(['=SUM(A1)', '+1+1', '-cmd', '@import'])('prefixes formula-like values with an apostrophe: %s', v => {
    expect(csvSafeCell(v)).toBe(`'${v}`);
  });

  it('leaves ordinary text and Arabic text unchanged', () => {
    expect(csvSafeCell('Paracetamol 500mg')).toBe('Paracetamol 500mg');
    expect(csvSafeCell('باراسيتامول')).toBe('باراسيتامول');
  });
});

describe('buildStableFileName', () => {
  it('produces the stable report-name_YYYY-MM-DD_HH-mm.ext pattern', () => {
    const name = buildStableFileName('medistock-status', 'csv', new Date('2026-07-03T09:05:00'));
    expect(name).toBe('medistock-status_2026-07-03_09-05.csv');
  });

  it('sanitizes unsafe characters out of the base name without corrupting readable text', () => {
    const name = buildStableFileName('report / name : test', 'csv', new Date('2026-01-01T00:00:00'));
    expect(name).toMatch(/^report-name-test_2026-01-01_00-00\.csv$/);
  });

  it('falls back to a safe default when the base sanitizes to nothing', () => {
    const name = buildStableFileName('***', 'csv', new Date('2026-01-01T00:00:00'));
    expect(name.startsWith('report_')).toBe(true);
  });
});

describe('buildCsvContent', () => {
  const rows: Row[] = [{ id: 'row-1', name: 'باراسيتامول', qty: 5, when: '2026-07-03' }];

  it('includes a UTF-8 BOM as the first character', () => {
    const csv = buildCsvContent(columns, rows);
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
  });

  it('quote-wraps every cell and doubles embedded quotes', () => {
    const withQuote: Row[] = [{ id: '1', name: 'Brand "X"', qty: 1, when: '2026-01-01' }];
    const csv = buildCsvContent(columns, withQuote);
    expect(csv).toContain('"Brand ""X"""');
  });

  it('applies CSV-injection guard to cell values', () => {
    const dangerous: Row[] = [{ id: '1', name: '=cmd|calc', qty: 1, when: '2026-01-01' }];
    const csv = buildCsvContent(columns, dangerous);
    expect(csv).toContain(`"'=cmd|calc"`);
  });

  it('preserves Arabic text without corruption', () => {
    const csv = buildCsvContent(columns, rows);
    expect(csv).toContain('باراسيتامول');
  });

  it('prepends metadata lines (title/org/filters/generated-at) before the header row, separated by a blank line', () => {
    const csv = buildCsvContent(columns, rows, ['Report Title', 'Generated at: 2026-07-03']);
    const lines = csv.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toContain('Report Title');
    expect(lines[1]).toContain('Generated at');
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe('"Name","Qty","When"');
  });

  it('omits the metadata block entirely when none is given', () => {
    const csv = buildCsvContent(columns, rows);
    const lines = csv.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('"Name","Qty","When"');
  });
});

describe('buildPrintDocument', () => {
  const rows: Row[] = [{ id: '1', name: 'مادة <script>', qty: 3, when: '2026-07-03 09:00' }];

  it('sets dir="rtl" for Arabic and dir="ltr" for English on the root html element', () => {
    const ar = buildPrintDocument({ lang: 'ar', title: 'T', metaLines: [], columns, rows, footerText: 'F' });
    const en = buildPrintDocument({ lang: 'en', title: 'T', metaLines: [], columns, rows, footerText: 'F' });
    expect(ar).toContain('<html dir="rtl" lang="ar">');
    expect(en).toContain('<html dir="ltr" lang="en">');
  });

  it('includes the brand line, title, subtitle, metadata, and footer', () => {
    const html = buildPrintDocument({
      lang: 'en', title: 'Movement Report', subtitle: 'Babil General Hospital',
      metaLines: [{ label: 'Generated at', value: '2026-07-03', ltr: true }],
      columns, rows, footerText: 'Generated by MediStock Phoenix',
    });
    expect(html).toContain(REPORT_BRAND);
    expect(html).toContain('Movement Report');
    expect(html).toContain('Babil General Hospital');
    expect(html).toContain('Generated at');
    expect(html).toContain('class="footer"');
    expect(html).toContain('Generated by MediStock Phoenix');
  });

  it('escapes user/DB-derived values to prevent HTML injection', () => {
    const html = buildPrintDocument({ lang: 'en', title: 't', metaLines: [], columns, rows, footerText: 'f' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('marks LTR-flagged columns with dir="ltr" on their table cells', () => {
    const html = buildPrintDocument({ lang: 'ar', title: 't', metaLines: [], columns, rows, footerText: 'f' });
    expect(html).toMatch(/<td dir="ltr">/);
  });

  it('renders a translated empty-state message instead of an empty table when there are zero rows', () => {
    const html = buildPrintDocument({ lang: 'en', title: 't', metaLines: [], columns, rows: [], footerText: 'f', emptyMessage: 'No rows' });
    expect(html).toContain('No rows');
    expect(html).not.toContain('<table>');
  });

  it('forces a fixed light print theme (no app dark-mode CSS variables)', () => {
    const html = buildPrintDocument({ lang: 'en', title: 't', metaLines: [], columns, rows, footerText: 'f' });
    expect(html).not.toContain('var(--');
    expect(html).toContain('background: #fff');
  });

  it('includes @page and @media print rules, and avoids row page-breaks', () => {
    const html = buildPrintDocument({ lang: 'en', title: 't', metaLines: [], columns, rows, footerText: 'f' });
    expect(html).toContain('@page');
    expect(html).toContain('@media print');
    expect(html).toContain('page-break-inside: avoid');
    expect(html).toContain('thead { display: table-header-group; }');
  });
});

describe('isLikelyMobilePrintContext (BUGFIX-MOBILE-PRINT-DOES-NOT-EXIT-APP-A)', () => {
  it('never throws and returns false when window is undefined (this Node test env)', () => {
    expect(() => isLikelyMobilePrintContext()).not.toThrow();
    expect(isLikelyMobilePrintContext()).toBe(false);
  });

  it('checks a narrow viewport (<=768px), a mobile User-Agent, and standalone/PWA display-mode', () => {
    const fn = moduleSrc.slice(moduleSrc.indexOf('export function isLikelyMobilePrintContext'));
    expect(fn).toContain('window.innerWidth <= 768');
    expect(fn).toMatch(/Android\|iPhone\|iPad\|iPod\|Mobile/);
    expect(fn).toContain("window.matchMedia('(display-mode: standalone)').matches");
  });

  it('is defensive: every browser API access is wrapped in try/catch so it can never crash the app', () => {
    const fn = moduleSrc.slice(
      moduleSrc.indexOf('export function isLikelyMobilePrintContext'),
      moduleSrc.indexOf('export function downloadPrintableHtml'),
    );
    expect((fn.match(/try\s*{/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(fn).toContain('catch {');
  });
});

describe('downloadPrintableHtml (BUGFIX-MOBILE-PRINT-DOES-NOT-EXIT-APP-A)', () => {
  it('uses a stable .html filename (never mislabels the file as a real PDF)', () => {
    const fn = moduleSrc.slice(moduleSrc.indexOf('export function downloadPrintableHtml'));
    expect(fn).toContain("buildStableFileName(fileNameBase, 'html', when)");
    expect(fn).not.toMatch(/\.pdf/i);
  });

  it('downloads via the same downloadTextFile primitive used by CSV export (text/html mime)', () => {
    const fn = moduleSrc.slice(moduleSrc.indexOf('export function downloadPrintableHtml'));
    expect(fn).toContain('downloadTextFile(');
    expect(fn).toContain('text/html;charset=utf-8;');
  });
});

describe('openPrintWindow (source-verified: cannot execute window.open in a Node test env)', () => {
  it('opens synchronously with window.open, writes the document, prints, then closes the popup', () => {
    const fn = moduleSrc.slice(moduleSrc.indexOf('export function openPrintWindow'));
    expect(fn).toContain("window.open('', '_blank')");
    expect(fn).toContain('win.document.write(html)');
    expect(fn).toContain('win.print()');
    expect(fn).toContain('win.close()');
  });

  it('returns false when the popup is blocked instead of throwing', () => {
    const fn = moduleSrc.slice(moduleSrc.indexOf('export function openPrintWindow'), moduleSrc.indexOf('export function openPrintWindow') + 300);
    expect(fn).toContain('if (!win) return false;');
  });
});

describe('downloadTextFile (source-verified: cannot execute Blob/URL in a Node test env)', () => {
  it('is wrapped in try/catch and never throws on failure', () => {
    const fn = moduleSrc.slice(moduleSrc.indexOf('export function downloadTextFile'));
    expect(fn).toContain('try {');
    expect(fn).toContain('} catch {');
    expect(fn).toContain('return false;');
  });

  it('uses Blob + URL.createObjectURL + a temporary anchor download, and revokes the object URL', () => {
    const fn = moduleSrc.slice(moduleSrc.indexOf('export function downloadTextFile'));
    expect(fn).toContain('new Blob(');
    expect(fn).toContain('URL.createObjectURL');
    expect(fn).toContain('URL.revokeObjectURL');
  });
});

describe('module does not implement real .xlsx and stays out of scope', () => {
  it('package.json has no xlsx/exceljs/sheetjs/read-excel-file/papaparse dependency', () => {
    const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8');
    expect(pkg).not.toMatch(/"xlsx"|"exceljs"|"read-excel-file"|"sheetjs"|"papaparse"/i);
  });

  it('is not a Service-D / inter-org-exchange module and does not reference service_role', () => {
    expect(moduleSrc).not.toContain('inter_org_exchange');
    expect(moduleSrc).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE|auth\.admin/);
  });
});
