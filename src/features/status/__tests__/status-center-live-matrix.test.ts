/**
 * LIVE-STATUS-CENTER-REPORTS-PRINT-EXPORT-A
 * Static source tests: StatusCenter is now a live-availability reporting center
 * driven by getAvailabilityByOrg, with print/Excel/PDF export. The manual status
 * report add/edit/resolve UI has been removed from the screen (the service and DB
 * table are intentionally kept).
 * Run: npm test -- --run
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const screen  = read('features/status/StatusCenterScreen.tsx');
const strings = read('shared/i18n/strings.ts');

// ============================================================================
// Live report data source
// ============================================================================

describe('StatusCenter: live availability reporting center', () => {
  it('(1) main reporting uses getAvailabilityByOrg', () => {
    expect(screen).toContain("import { getAvailabilityByOrg }");
    expect(screen).toContain('getAvailabilityByOrg(effectiveOrgId)');
  });

  it('(1b) does not use status_reports for the main reporting', () => {
    expect(screen).not.toContain('getStatusReports');
    expect(screen).not.toContain("status-reports.service");
  });

  it('(4) filters include all six canonical effective statuses', () => {
    const block = screen.slice(
      screen.indexOf('CANONICAL_STATUSES: CanonicalStatus[] = ['),
      screen.indexOf('];', screen.indexOf('CANONICAL_STATUSES: CanonicalStatus[] = [')),
    );
    for (const s of ['available', 'low_stock', 'missing', 'surplus', 'near_expiry', 'expired']) {
      expect(block).toContain(`'${s}'`);
    }
    // status filter dropdown is present
    expect(screen).toContain('setFilterStatus');
    expect(screen).toContain('sc_all_statuses');
  });

  it('(5) supply type filter labels exist for purchases, kimadia, donations, aid', () => {
    for (const c of ['purchases', 'kimadia', 'donations', 'aid']) {
      expect(screen).toContain(`labelKey: 'sc_supply_${c}'`);
    }
    expect(screen).toContain('setFilterSupply');
    expect(screen).toContain('normalizeSupplyType');
    expect(screen).toContain('sc_all_supply_types');
  });

  it('search filters scientific_name, trade_name, concentration, dosage_form, port', () => {
    const fn = screen.slice(screen.indexOf('const rows = useMemo'), screen.indexOf('const counts = useMemo'));
    expect(fn).toContain('scientific_name');
    expect(fn).toContain('trade_name');
    expect(fn).toContain('concentration');
    expect(fn).toContain('dosage_form');
    expect(fn).toContain('distribution_points');
  });

  it('(6) report table includes raw condition and effective status', () => {
    expect(screen).toContain('sc_raw_condition');
    expect(screen).toContain('sc_effective_status');
  });
});

// ============================================================================
// Print / export
// ============================================================================

describe('StatusCenter: print and export', () => {
  it('(7) print button exists and uses a print flow', () => {
    expect(screen).toContain('sc_print_report');
    expect(screen).toContain('function printReport');
    expect(screen).toContain('window.open(');
    expect(screen).toContain('.print()');
  });

  it('(8) Excel export button exists', () => {
    expect(screen).toContain('sc_export_excel');
    expect(screen).toContain('function exportCsv');
  });

  it('(9) PDF button exists and uses print/save-as-PDF flow (no PDF lib)', () => {
    expect(screen).toContain('sc_print_pdf');
    // PDF button routes through the same print flow.
    const pdfBtnIdx = screen.indexOf('sc_print_pdf');
    const around = screen.slice(pdfBtnIdx - 120, pdfBtnIdx + 40);
    expect(around).toContain('printReport');
  });

  it('CSV export includes a UTF-8 BOM for Arabic and a medistock-status filename', () => {
    const fn = screen.slice(screen.indexOf('function exportCsv'), screen.indexOf('function exportCsv') + 900);
    expect(fn).toContain('﻿');
    expect(fn).toContain('text/csv;charset=utf-8');
    expect(fn).toContain('medistock-status');
  });

  it('CSV export escapes cells that could be interpreted as spreadsheet formulas', () => {
    expect(screen).toContain('function csvSafeCell');
    const fn = screen.slice(screen.indexOf('function csvSafeCell'), screen.indexOf('function csvSafeCell') + 300);
    expect(fn).toContain('/^[=+\\-@]/');
    const exportFn = screen.slice(screen.indexOf('function exportCsv'), screen.indexOf('function exportCsv') + 900);
    expect(exportFn).toContain('csvSafeCell');
  });

  it('print html escapes content to prevent injection', () => {
    expect(screen).toContain('function escHtml');
  });
});

// ============================================================================
// Manual report UI removed + phase isolation
// ============================================================================

describe('StatusCenter: manual report UI removed & isolation', () => {
  it('(2) manual report create/update/resolve UI is removed', () => {
    expect(screen).not.toContain('function ReportForm');
    expect(screen).not.toContain('updateStatusReport');
    expect(screen).not.toContain('resolveStatusReport');
    expect(screen).not.toContain("t('sc_add'");
  });

  it('(3) no createStatusReport call is used by the screen', () => {
    expect(screen).not.toContain('createStatusReport');
  });

  it('(10) no fake/mock rows are introduced', () => {
    expect(screen).not.toMatch(/mock/i);
    expect(screen).not.toMatch(/fakeRows|sampleRows|dummyData|placeholderRows/);
    expect(screen).toContain('(live.data ?? [])');
  });

  it('(11) no Supabase writes are added', () => {
    expect(screen).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
    expect(screen).not.toContain('.rpc(');
  });

  it('(12) no alert engine is introduced', () => {
    expect(screen).not.toMatch(/materialAlertEngine/);
    expect(screen).not.toMatch(/computeMaterialAlerts/);
    expect(screen).not.toMatch(/generateExchangeAlerts/);
    expect(screen).not.toMatch(/inter-institution-alerts/);
  });

  it('reads only the active org (no cross-institution data)', () => {
    expect(screen).toContain('effectiveOrgId ? getAvailabilityByOrg(effectiveOrgId) : Promise.resolve([])');
  });

  it('does not expose contact/phone data', () => {
    expect(screen).not.toMatch(/phone|contact/i);
  });
});

// ============================================================================
// i18n
// ============================================================================

describe('StatusCenter live report i18n (AR + EN)', () => {
  it('(13) report header/title labels exist bilingually', () => {
    expect(strings).toMatch(/sc_report_title:\s*\{\s*ar:\s*'تقرير موقف التوفر الحي للمواد',\s*en:\s*'Live Material Availability Status Report'/);
  });

  it('print/export/filters labels exist bilingually', () => {
    const keys = [
      'sc_print_report', 'sc_export_excel', 'sc_print_pdf',
      'sc_all_statuses', 'sc_all_supply_types',
      'sc_supply_purchases', 'sc_supply_kimadia', 'sc_supply_donations', 'sc_supply_aid',
      'sc_generated_at', 'sc_total_rows', 'sc_selected_filters', 'sc_no_match',
    ];
    for (const k of keys) {
      expect(strings).toMatch(new RegExp(`${k}:\\s*\\{\\s*ar:\\s*'[^']+',\\s*en:\\s*'[^']+'`));
    }
  });

  it('Arabic supply-type labels match the product spec', () => {
    expect(strings).toMatch(/sc_supply_purchases:\s*\{\s*ar:\s*'مشتريات'/);
    expect(strings).toMatch(/sc_supply_kimadia:\s*\{\s*ar:\s*'كيماديا'/);
    expect(strings).toMatch(/sc_supply_donations:\s*\{\s*ar:\s*'هبات'/);
    expect(strings).toMatch(/sc_supply_aid:\s*\{\s*ar:\s*'مساعدات'/);
  });
});
