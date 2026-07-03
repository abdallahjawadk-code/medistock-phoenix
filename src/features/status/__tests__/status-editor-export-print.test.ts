/**
 * FINAL-EXPORT-REPORTS-PRO-A
 * StatusEditorScreen previously had the weakest export/print implementation
 * in the app: "Export PDF" and "Print" both called raw window.print() on the
 * live page DOM (no generated report, no popup-blocked handling, no
 * metadata/footer), and CSV export used hardcoded parallel arrays instead of
 * the shared column-definition pattern used elsewhere. This test file locks
 * in the rebuilt version.
 * Run: npm test -- --run
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const screen = read('features/status/StatusEditorScreen.tsx');

describe('StatusEditorScreen: uses the shared report-export helpers', () => {
  it('imports buildCsvContent, buildPrintDocument, buildStableFileName, downloadTextFile, openPrintWindow', () => {
    expect(screen).toContain("from '@/shared/lib/reportExport'");
    for (const fn of ['buildCsvContent', 'buildPrintDocument', 'buildStableFileName', 'downloadTextFile', 'openPrintWindow']) {
      expect(screen).toContain(fn);
    }
  });

  it('no longer calls raw window.print() on the live page', () => {
    expect(screen).not.toContain('window.print()');
  });

  it('defines a shared columns array used by the table, CSV, and print (no hardcoded parallel header/row arrays)', () => {
    expect(screen).toContain('const columns: ReportColumn<OrgAvailRow>[]');
    expect(screen).not.toContain('const headers = [');
  });
});

describe('StatusEditorScreen: CSV export', () => {
  it('exportCsv builds a stable file name via buildStableFileName', () => {
    const fn = screen.slice(screen.indexOf('function exportCsv'), screen.indexOf('function printReport'));
    expect(fn).toContain("buildStableFileName('medistock-status-editor', 'csv')");
  });

  it('exportCsv includes report metadata (title, filters, generated-at, row count)', () => {
    const fn = screen.slice(screen.indexOf('function exportCsv'), screen.indexOf('function printReport'));
    expect(fn).toContain('metadataLines');
    expect(fn).toContain('sc_selected_filters');
    expect(fn).toContain('sc_generated_at');
    expect(fn).toContain('sc_total_rows');
  });

  it('exportCsv is wrapped in error handling and shows a translated failure toast on download failure', () => {
    const fn = screen.slice(screen.indexOf('function exportCsv'), screen.indexOf('function printReport'));
    expect(fn).toContain('try {');
    expect(fn).toContain("t('csv_export_failed', lang)");
  });
});

describe('StatusEditorScreen: print / PDF', () => {
  it('printReport generates a full report document via buildPrintDocument (not the raw DOM)', () => {
    const fn = screen.slice(screen.indexOf('function printReport'), screen.indexOf('const fieldStyle'));
    expect(fn).toContain('buildPrintDocument({');
    expect(fn).toContain('footerText:');
  });

  it('shows a translated popup-blocked message when openPrintWindow returns false', () => {
    const fn = screen.slice(screen.indexOf('function printReport'), screen.indexOf('const fieldStyle'));
    expect(fn).toContain('openPrintWindow(html)');
    expect(fn).toContain("t('print_popup_blocked', lang)");
  });

  it('the generated-at metadata line is marked ltr (bidi-safe date rendering)', () => {
    const fn = screen.slice(screen.indexOf('function printReport'), screen.indexOf('const fieldStyle'));
    expect(fn).toMatch(/sc_generated_at[\s\S]*ltr:\s*true/);
  });
});

describe('StatusEditorScreen: expiry date formatting', () => {
  it('expiry column uses formatStableDate instead of the raw expiry_date string', () => {
    expect(screen).toContain("value: r => formatStableDate(r.expiry_date, lang)");
  });
});

describe('StatusEditorScreen: no raw UUIDs exported to users', () => {
  it('the shared columns array never exposes the row id', () => {
    const colsBlock = screen.slice(screen.indexOf('const columns: ReportColumn'), screen.indexOf('const selectedFiltersText'));
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
