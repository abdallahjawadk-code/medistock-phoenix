/**
 * FINAL-EXPORT-REPORTS-PRO-A / EXPORT-PROFESSIONAL-XLSX-PDF-A / -B
 * StatusEditorScreen previously had the weakest export/print implementation
 * in the app: "Export PDF" and "Print" both called raw window.print() on the
 * live page DOM (no generated report, no popup-blocked handling, no
 * metadata/footer), and CSV export used hardcoded parallel arrays instead of
 * the shared column-definition pattern used elsewhere. This test file locks
 * in the rebuilt version.
 *
 * EXPORT-PROFESSIONAL-XLSX-PDF-B: the user explicitly required real Excel
 * export, not CSV. This screen's Excel button now calls the approved
 * `exceljs`-backed `exportProfessionalXlsx` (real `.xlsx` workbook) instead
 * of the earlier `exportProfessionalCsv`. Print/PDF is unchanged from -A
 * (still `triggerProfessionalPrint`, still the existing dependency-free
 * browser print-to-PDF path). Both share one `exportConfig()` object.
 * Run: npm test -- --run
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const screen = read('features/status/StatusEditorScreen.tsx');

describe('StatusEditorScreen: uses the shared professional-export helpers', () => {
  it('imports exportProfessionalXlsx, triggerProfessionalPrint from the shared professional-export module', () => {
    expect(screen).toContain("from '@/shared/lib/professional-export'");
    for (const fn of ['exportProfessionalXlsx', 'triggerProfessionalPrint']) {
      expect(screen).toContain(fn);
    }
  });

  it('no longer imports the legacy CSV export helper', () => {
    expect(screen).not.toContain('exportProfessionalCsv');
  });

  it('no longer calls raw window.print() on the live page', () => {
    expect(screen).not.toContain('window.print()');
  });

  it('defines a shared columns array used by the table, XLSX, and print (no hardcoded parallel header/row arrays)', () => {
    expect(screen).toContain('const columns: ProfessionalReportColumn<OrgAvailRow>[]');
    expect(screen).not.toContain('const headers = [');
  });

  it('shares one exportConfig() object between XLSX and print (single source of truth for title/filters/generated-at/row-count)', () => {
    expect(screen).toContain('function exportConfig()');
    const fn = screen.slice(screen.indexOf('function exportConfig()'), screen.indexOf('async function exportXlsx'));
    expect(fn).toContain('reportTitle:');
    expect(fn).toContain('generatedAt:');
    expect(fn).toContain('filtersSummary:');
    expect(fn).toContain('rows: filtered');
    expect(fn).toContain('labels:');
  });
});

describe('StatusEditorScreen: Excel (.xlsx) export', () => {
  it('exportXlsx delegates to exportProfessionalXlsx with the shared config', () => {
    const fn = screen.slice(screen.indexOf('async function exportXlsx'), screen.indexOf('function printReport'));
    expect(fn).toContain('await exportProfessionalXlsx(exportConfig())');
  });

  it('guards against double-clicks while the async workbook download is in flight', () => {
    const fn = screen.slice(screen.indexOf('async function exportXlsx'), screen.indexOf('function printReport'));
    expect(fn).toContain('xlsxBusy');
    expect(fn).toContain('setXlsxBusy(true)');
    expect(fn).toContain('setXlsxBusy(false)');
  });

  it('the shared config carries report metadata labels (title, filters, generated-at, row count)', () => {
    const fn = screen.slice(screen.indexOf('function exportConfig()'), screen.indexOf('async function exportXlsx'));
    expect(fn).toContain('sc_selected_filters');
    expect(fn).toContain('sc_generated_at');
    expect(fn).toContain('sc_total_rows');
    expect(fn).toContain("fileNameBase: 'medistock-status-editor'");
  });

  it('exportXlsx shows a translated failure toast when the download fails', () => {
    const fn = screen.slice(screen.indexOf('async function exportXlsx'), screen.indexOf('function printReport'));
    expect(fn).toContain("t('csv_export_failed', lang)");
  });

  it('the Excel button label reflects real .xlsx export, not CSV', () => {
    expect(screen).toContain("aria-label={t('se_export_excel', lang)}");
    const strings = read('shared/i18n/strings.ts');
    expect(strings).toMatch(/se_export_excel:\s*\{\s*ar:\s*'[^']*Excel[^']*\.xlsx[^']*',\s*en:\s*'[^']*Excel[^']*\.xlsx[^']*'/);
  });
});

describe('StatusEditorScreen: print / PDF (unchanged from EXPORT-PROFESSIONAL-XLSX-PDF-A)', () => {
  it('printReport generates a full premium report document via triggerProfessionalPrint (not the raw DOM)', () => {
    const fn = screen.slice(screen.indexOf('function printReport'), screen.indexOf('const fieldStyle'));
    expect(fn).toContain('triggerProfessionalPrint(exportConfig())');
  });

  it('shows a translated popup-blocked message when triggerProfessionalPrint reports failure', () => {
    const fn = screen.slice(screen.indexOf('function printReport'), screen.indexOf('const fieldStyle'));
    expect(fn).toContain("t('print_popup_blocked', lang)");
  });

  it('routes to the mobile print fallback when triggerProfessionalPrint returns mobileHtml', () => {
    const fn = screen.slice(screen.indexOf('function printReport'), screen.indexOf('const fieldStyle'));
    expect(fn).toContain('mobileHtml');
    expect(fn).toContain('setMobilePrintHtml(mobileHtml)');
  });

  it('the generated-at metadata label is wired (bidi-safe date rendering is handled inside professional-export.ts)', () => {
    const fn = screen.slice(screen.indexOf('function exportConfig()'), screen.indexOf('async function exportXlsx'));
    expect(fn).toContain("generatedAt: t('sc_generated_at', lang)");
  });

  it('the shared config supplies a severity/condition-based row accent for the premium print table and XLSX', () => {
    const fn = screen.slice(screen.indexOf('function exportConfig()'), screen.indexOf('async function exportXlsx'));
    expect(fn).toContain('rowAccent:');
    expect(fn).toContain("r.condition === 'missing'");
  });
});

describe('StatusEditorScreen: XLSX date/numeric column hints', () => {
  it('the expiry column is marked as a date column with a raw excelValue for a real Excel Date cell', () => {
    const colsBlock = screen.slice(screen.indexOf('const columns: ProfessionalReportColumn'), screen.indexOf('const selectedFiltersText'));
    expect(colsBlock).toMatch(/key:\s*'expiry'[\s\S]*?dateColumn:\s*'date'/);
    expect(colsBlock).toMatch(/key:\s*'expiry'[\s\S]*?excelValue:\s*r\s*=>\s*r\.expiry_date/);
  });

  it('quantity and price columns are marked numeric for real Excel number cells and right alignment', () => {
    const colsBlock = screen.slice(screen.indexOf('const columns: ProfessionalReportColumn'), screen.indexOf('const selectedFiltersText'));
    expect(colsBlock).toMatch(/key:\s*'qty'[\s\S]*?numeric:\s*true/);
    expect(colsBlock).toMatch(/key:\s*'price'[\s\S]*?numeric:\s*true/);
  });
});

describe('StatusEditorScreen: expiry date formatting', () => {
  it('expiry column uses formatStableDate instead of the raw expiry_date string', () => {
    expect(screen).toContain("value: r => formatStableDate(r.expiry_date, lang)");
  });
});

describe('StatusEditorScreen: no raw UUIDs exported to users', () => {
  it('the shared columns array never exposes the row id', () => {
    const colsBlock = screen.slice(screen.indexOf('const columns: ProfessionalReportColumn'), screen.indexOf('const selectedFiltersText'));
    expect(colsBlock).not.toMatch(/value:\s*r\s*=>\s*r\.id/);
  });
});

describe('StatusEditorScreen: mobile-friendly export/print buttons', () => {
  it('the action button row wraps instead of overflowing on narrow screens', () => {
    const jsx = screen.slice(screen.indexOf('Mobile-friendly'), screen.indexOf('</div>\n            </div>'));
    expect(jsx).toContain("flexWrap: 'wrap'");
  });

  it('every export/print button has a translated aria-label', () => {
    expect(screen).toMatch(/aria-label=\{t\('se_export_excel', lang\)\}/);
    expect(screen).toMatch(/aria-label=\{t\('se_export_pdf', lang\)\}/);
    expect(screen).toMatch(/aria-label=\{t\('se_print', lang\)\}/);
  });

  it('export/print buttons are disabled (not hidden) when there are zero rows, matching the existing product pattern', () => {
    expect(screen).toContain('disabled={filtered.length === 0}');
  });
});

describe('StatusEditorScreen: permission model unchanged (no new keys invented)', () => {
  it('does not introduce a myPermissions.has(...) gate where none existed before', () => {
    expect(screen).not.toContain('myPermissions');
  });
});

describe('StatusEditorScreen: safety guards', () => {
  it('no Service-D / inter_org_exchange UI was added', () => {
    expect(screen).not.toContain('inter_org_exchange');
    expect(screen).not.toMatch(/exchange.request|ExchangeRequest/);
  });

  it('no service_role/auth.admin/wipe tooling references', () => {
    expect(screen).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE|auth\.admin/);
    expect(screen).not.toMatch(/phoenix-wipe-execute|FULL_PUBLIC_APP_WIPE_APPROVED|full_wipe/);
  });

  it('no Supabase writes are added (read-only editor screen)', () => {
    expect(screen).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
    expect(screen).not.toContain('.rpc(');
  });
});
