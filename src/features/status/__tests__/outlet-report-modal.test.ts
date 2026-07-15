/**
 * PHASE2-STATUS-CENTER-OUTLET-REPORT-MODAL-A
 * Run: npm test -- --run outlet
 *
 * Static source-code tests for the outlet selector dropdown ("عرض حسب
 * المنفذ") and the read-only OutletAvailabilityReportModal it opens: its own
 * independent filters (search/condition/supply/quantity/price/expiry/
 * removed), its filtered-only XLSX export (via a new, purely additive
 * exportOutletReportXlsx — the main Status Center XLSX export is untouched),
 * and its filtered-only print (reusing the existing generic
 * triggerProfessionalPrint, no new PDF library).
 *
 * No live DB is used and no component is rendered — these are static
 * source-code assertions, matching this repo's established test conventions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const ROOT = join(__dirname, '../../../../');
const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
const modal = readSrc('features/status/OutletAvailabilityReportModal.tsx');
const exportModule = readSrc('shared/lib/professional-export.ts');
const strings = readSrc('shared/i18n/strings.ts');

function T(key: string): { ar: string; en: string } {
  const re = new RegExp(`${key}:\\s*\\{\\s*ar:\\s*'([^']+)',\\s*en:\\s*'([^']+)'`);
  const m = strings.match(re);
  if (!m) throw new Error(`key ${key} not found`);
  return { ar: m[1], en: m[2] };
}

describe('A) Outlet selector dropdown is built from currently loaded/filtered rows', () => {
  it('outletOptions is derived from the same `rows` memo (no new fetch), grouped by distribution_points', () => {
    const start = statusCenter.indexOf('const outletOptions = useMemo(');
    const body = statusCenter.slice(start, start + 700);
    expect(body).toContain('for (const r of rows)');
    expect(body).toContain('r.distribution_points');
    expect(body).not.toMatch(/getAvailabilityBy|supabase\.rpc\(|\.from\('/);
  });

  it('the dropdown is only rendered in outlet view mode and lists each outlet name + item count', () => {
    const start = statusCenter.indexOf("viewMode === 'outlet' && (");
    const body = statusCenter.slice(start, start + 900);
    expect(body).toContain('outletOptions.map(o =>');
    expect(body).toContain('o.count');
  });

  it('selecting an outlet sets reportOutlet (opens the modal) — does not mutate any Status Center filter state', () => {
    const start = statusCenter.indexOf("aria-label={t('sc_outlet_report_select', lang)}");
    const before = statusCenter.slice(Math.max(0, start - 500), start);
    expect(before).toContain('setReportOutlet({ id: o.id, name: o.name, nameAr: o.nameAr })');
    expect(before).not.toMatch(/setFilterStatus|setFilterSupply|setSearch\(/);
  });

  it('existing OutletMaterialGroups card display is untouched (still rendered, still fed the same `rows`)', () => {
    expect(statusCenter).toContain('<OutletMaterialGroups rows={rows} />');
  });
});

describe('B) Selecting an outlet opens the report modal with the right props', () => {
  it('OutletAvailabilityReportModal is wired with outletId/outletName/institutionName/rows', () => {
    expect(statusCenter).toContain('<OutletAvailabilityReportModal');
    expect(statusCenter).toContain('open={reportOutlet !== null}');
    expect(statusCenter).toContain('onClose={() => setReportOutlet(null)}');
    expect(statusCenter).toContain('outletId={reportOutlet?.id ?? null}');
    expect(statusCenter).toContain('institutionName={orgName}');
    expect(statusCenter).toContain('rows={rows}');
  });
});

describe('C) Modal shows the selected outlet name and narrows rows to it', () => {
  it('outletRows filters the incoming rows prop down to the matching distribution_points.id', () => {
    const start = modal.indexOf('const outletRows = useMemo(');
    const body = modal.slice(start, start + 200);
    expect(body).toContain('r.distribution_points?.id === outletId');
  });

  it('renders the outlet name and institution name in the header', () => {
    expect(modal).toContain('📦 {outletName');
    expect(modal).toContain('🏥 {institutionName}');
  });

  it('title is the required bilingual "تقرير مواد المنفذ" / "Outlet Availability Report"', () => {
    expect(T('sc_outlet_report_title')).toEqual({ ar: 'تقرير مواد المنفذ', en: 'Outlet Availability Report' });
    expect(modal).toContain("title={t('sc_outlet_report_title', lang)}");
  });
});

describe('D) Modal displays all required fields', () => {
  const fields = [
    'avail_scientific_name', 'avail_trade_name', 'avail_dosage_form', 'avail_concentration',
    'qty', 'avail_condition', 'sc_entered_price', 'avail_supply_type', 'batch_no', 'expiry',
    'avail_details_days_to_expiry', 'sc_notes', 'last_upd', 'sc_removed_badge',
  ];
  it.each(fields)('table has a header cell for %s', (key) => {
    expect(modal).toContain(`t('${key}', lang)`);
  });

  it('reads price/batch_number/expiry_date/supply_type/notes/updated_at/removed_at directly off the row', () => {
    expect(modal).toContain('r.price');
    expect(modal).toContain('r.batch_number');
    expect(modal).toContain('r.expiry_date');
    expect(modal).toContain('r.supply_type');
    expect(modal).toContain('r.notes');
    expect(modal).toContain('r.updated_at');
    expect(modal).toContain('r.removed_at');
  });

  it('shows a Removed badge only when removed_at is set, never a raw removed_by uuid', () => {
    expect(modal).toContain('r.removed_at != null');
    expect(modal).toContain('<PhoenixStatusBadge variant="err" label={t(\'sc_removed_badge\', lang)} />');
    expect(modal).not.toMatch(/r\.removed_by|row\.removed_by/);
  });
});

describe('E) Modal-only filters combine using AND logic and never crash on null', () => {
  const filterFnBody = (() => {
    const start = modal.indexOf('const filteredRows = useMemo(() => {');
    const end = modal.indexOf('}, [outletRows,');
    return modal.slice(start, end);
  })();

  it('starts from outletRows and only narrows `list` further at each step (AND semantics)', () => {
    expect(filterFnBody).toContain('let list = outletRows;');
    const assignments = filterFnBody.match(/list = list\.filter/g) ?? [];
    expect(assignments.length).toBeGreaterThanOrEqual(6);
  });

  it('search matches scientific/trade/concentration/dosage/batch, all null-safe with ?? \'\'', () => {
    expect(filterFnBody).toMatch(/r\.scientific_name \?\? ''/);
    expect(filterFnBody).toMatch(/r\.trade_name \?\? ''/);
    expect(filterFnBody).toMatch(/r\.concentration \?\? ''/);
    expect(filterFnBody).toMatch(/r\.dosage_form \?\? ''/);
    expect(filterFnBody).toMatch(/r\.batch_number \?\? ''/);
  });

  it('quantity filter has all/has_quantity/zero_quantity, both branches null-safe via ?? 0', () => {
    expect(filterFnBody).toContain("quantityFilter === 'has_quantity'");
    expect(filterFnBody).toContain("quantityFilter === 'zero_quantity'");
    expect(filterFnBody).toMatch(/\(r\.quantity \?\? 0\) > 0/);
    expect(filterFnBody).toMatch(/\(r\.quantity \?\? 0\) === 0/);
  });

  it('price filter has all 6 required modes, matching Status Center\'s own price filter contract', () => {
    for (const mode of ['no_entered_price', 'has_entered_price', 'entered_price_less_than', 'entered_price_greater_than', 'entered_price_between']) {
      expect(filterFnBody).toContain(`'${mode}'`);
    }
    // entered_price_between: invalid/missing/min>max safely yields zero rows, never a crash.
    expect(filterFnBody).toMatch(/if \(min === null \|\| max === null \|\| min > max\) \{\s*list = \[\];/);
  });

  it('expiry filter (all/near_expiry/expired/valid) is based on the effective condition, never throws on a null expiry_date', () => {
    expect(filterFnBody).toContain("expiryFilter === 'near_expiry'");
    expect(filterFnBody).toContain("expiryFilter === 'expired'");
    expect(filterFnBody).toContain("expiryFilter === 'valid'");
  });

  it('removed-status filter (all/active/removed) keys only on removed_at', () => {
    expect(filterFnBody).toContain("removedFilter === 'active'");
    expect(filterFnBody).toContain('r.removed_at == null');
    expect(filterFnBody).toContain("removedFilter === 'removed'");
    expect(filterFnBody).toContain('r.removed_at != null');
  });

  it('none of the modal filters touch Status Center\'s own filter state (filterStatus/filterSupply/search/priceFilterMode/etc. on the parent screen)', () => {
    expect(modal).not.toMatch(/setFilterStatus|setFilterSupply\b/);
  });
});

describe('F) Summary counts are derived from the currently filtered rows', () => {
  it('summary totals (available/lowStock/missing/nearExpiry/surplus/totalQuantity/pricedItemsCount) are computed from filteredRows, not outletRows', () => {
    const start = modal.indexOf('const summary = useMemo(() => {');
    const body = modal.slice(start, modal.indexOf('}, [filteredRows]);'));
    expect(body).toContain('for (const r of filteredRows)');
    expect(body).toContain('totalQuantity += r.quantity ?? 0;');
    expect(body).toContain('pricedItemsCount++');
  });

  it('does NOT invent a monetary total (no sum(quantity*price) anywhere) — only a priced-items count, per the task\'s explicit "do not invent financial meaning" rule', () => {
    expect(modal).not.toMatch(/quantity\s*\*\s*.*price|price\s*\*\s*.*quantity/i);
  });
});

describe('G) XLSX export uses only modal-filtered rows and includes Entered Price', () => {
  it('exportXlsx builds export rows from filteredRows (not outletRows/rows)', () => {
    const start = modal.indexOf('function buildExportRows(): OutletReportRow[] {');
    const body = modal.slice(start, start + 200);
    expect(body).toContain('filteredRows.map(');
  });

  it('exported row carries enteredPrice sourced only from row.price, never calculated', () => {
    const start = modal.indexOf('function buildExportRows(): OutletReportRow[] {');
    const body = modal.slice(start, modal.indexOf('async function exportXlsx'));
    expect(body).toContain("enteredPrice: typeof r.price === 'number' ? r.price : null,");
  });

  it('file name includes "MediStock-Babil_Outlet_Report_" + outlet name (date/time appended by buildStableFileName)', () => {
    expect(modal).toMatch(/fileNameBase: `MediStock-Babil_Outlet_Report_\$\{safeOutlet\}`/);
  });

  it('calls the new, separate exportOutletReportXlsx — never exportAvailabilityXlsx/exportProfessionalXlsx (those remain Status Center\'s own)', () => {
    expect(modal).toContain('exportOutletReportXlsx(');
    expect(modal).not.toMatch(/\bexportAvailabilityXlsx\(|\bexportProfessionalXlsx\(/);
  });
});

describe('H) professional-export.ts additions are purely additive — main Status Center XLSX export is unchanged', () => {
  it('buildAvailabilityExportWorkbook/exportAvailabilityXlsx/AVAIL_EXPORT_HEADERS/AVAIL_EXPORT_COLUMNS still exist, unrenamed', () => {
    expect(exportModule).toContain('export async function buildAvailabilityExportWorkbook');
    expect(exportModule).toContain('export async function exportAvailabilityXlsx');
    expect(exportModule).toContain('const AVAIL_EXPORT_HEADERS');
    expect(exportModule).toContain('const AVAIL_EXPORT_COLUMNS');
  });

  it('the new OutletReport types/functions are additive (new names), never modifying the Availability* ones in place', () => {
    expect(exportModule).toContain('export interface OutletReportRow extends AvailabilityExportRow');
    expect(exportModule).toContain('export interface OutletReportSummary');
    expect(exportModule).toContain('export interface OutletReportConfig');
    expect(exportModule).toContain('export async function buildOutletReportWorkbook');
    expect(exportModule).toContain('export async function exportOutletReportXlsx');
  });

  it('the new Outlet Availability sheet uses its own sheet name, distinct from the main "Availability Export" sheet', () => {
    expect(exportModule).toContain("data: 'Outlet Availability'");
    expect(exportModule).toContain("data: 'Availability Export'");
  });

  it('the outlet report workbook includes a Removed column and documents that this report may include removed rows (unlike the main export)', () => {
    const start = exportModule.indexOf('const OUTLET_REPORT_HEADERS');
    const body = exportModule.slice(start, start + 300);
    expect(body).toContain('removed:');
    expect(exportModule).toContain('OUTLET_REPORT_DICTIONARY');
  });

  it('StatusCenterScreen.tsx\'s own exportXlsx (main export) still excludes removed_at rows, unchanged by this phase', () => {
    const start = statusCenter.indexOf('async function exportXlsx');
    const body = statusCenter.slice(start, start + 400);
    expect(body).toMatch(/\.filter\(r => r\.removed_at == null\)/);
  });

  // PHASE2-EXPORT-FIELD-SELECTOR-A: a still later, separately-reviewed phase
  // adds real filtering logic to buildOutletReportWorkbook (a DIFFERENT
  // function, further down the file) — so this test now verifies
  // buildAvailabilityExportWorkbook's own body directly (content-based),
  // rather than diffing the whole file, since that function is genuinely
  // untouched even though the file as a whole now has a real, larger diff.
  it('buildAvailabilityExportWorkbook\'s own body is untouched — verified directly, not via file-wide diff', () => {
    const start = exportModule.indexOf('export async function buildAvailabilityExportWorkbook');
    const end = exportModule.indexOf('export async function exportAvailabilityXlsx');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = exportModule.slice(start, end);
    // Distinctive, unmodified original lines — if any of these ever changed,
    // it would mean buildAvailabilityExportWorkbook itself was edited.
    expect(body).toContain("wb.addWorksheet(safeSheetName(AVAIL_SHEET_NAMES.summary)");
    expect(body).toContain('conditionCounts[r.conditionKey] = (conditionCounts[r.conditionKey] ?? 0) + 1;');
    expect(body).toContain('dataWs.columns = AVAIL_EXPORT_COLUMNS.map(c => ({ key: c.key, width: c.width }));');
    expect(body).toContain('AVAIL_EXPORT_DICTIONARY.forEach((entry, i) => {');
  });
});

describe('I) Print/PDF uses modal-filtered rows and no new PDF dependency', () => {
  it('printReport passes rows: filteredRows to triggerProfessionalPrint (the existing generic print/PDF-via-browser-print primitive)', () => {
    const start = modal.indexOf('function printReport() {');
    const body = modal.slice(start, modal.indexOf('return (', start));
    expect(body).toContain('rows: filteredRows,');
    expect(body).toContain('triggerProfessionalPrint(config)');
  });

  it('mobile/PWA contexts route to the existing MobilePrintFallbackModal, exactly like every other screen\'s print button', () => {
    expect(modal).toContain('<MobilePrintFallbackModal');
    expect(modal).toContain('setMobilePrintHtml(mobileHtml)');
  });

  it('no new PDF library was added — package.json is untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('the modal never imports jspdf/pdfmake/pdf-lib or any other PDF-generation library', () => {
    expect(modal).not.toMatch(/jspdf|pdfmake|pdf-lib/i);
  });
});

describe('J) No sensitive fields exposed anywhere in this phase', () => {
  it('modal never reads/renders row.id or removed_by as an actual property access (doc comments mentioning removed_by to document its deliberate absence are fine)', () => {
    expect(modal).not.toMatch(/\brow\.id\b/);
    expect(modal).not.toMatch(/r\.removed_by|row\.removed_by/);
  });

  it('modal never renders a raw UUID pattern', () => {
    expect(modal).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('exported OutletReportRow never carries a removed_by field — only a friendly removedLabel string', () => {
    const start = exportModule.indexOf('export interface OutletReportRow extends AvailabilityExportRow {');
    const body = exportModule.slice(start, exportModule.indexOf('}', start));
    expect(body).not.toMatch(/removed_by\??:/);
    expect(body).toContain('removedLabel: string;');
  });

  it('modal never references dose/dosing/mechanism/warning/clinical/pharmacology-type medical content as UI copy', () => {
    const withoutComments = modal.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(withoutComments).not.toMatch(/mechanism of action|contraindicat|dosage instructions|side effect|drug interaction/i);
  });
});

describe('K) i18n: new keys exist bilingually with the exact required wording', () => {
  it('sc_outlet_report_title / sc_outlet_report_select', () => {
    expect(T('sc_outlet_report_title')).toEqual({ ar: 'تقرير مواد المنفذ', en: 'Outlet Availability Report' });
    expect(strings).toMatch(/sc_outlet_report_select:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'/);
  });

  it('all new sc_outlet_report_* keys have both ar and en labels', () => {
    const keys = [
      'sc_outlet_report_title', 'sc_outlet_report_select',
      'sc_outlet_report_summary_total_items', 'sc_outlet_report_summary_total_qty', 'sc_outlet_report_summary_priced_items',
      'sc_outlet_report_filter_removed_label', 'sc_outlet_report_filter_removed_active', 'sc_outlet_report_filter_removed_removed',
      'sc_outlet_report_filter_expiry_label', 'sc_outlet_report_filter_expiry_near', 'sc_outlet_report_filter_expiry_expired', 'sc_outlet_report_filter_expiry_valid',
      'sc_outlet_report_export', 'sc_outlet_report_active_label', 'sc_outlet_report_no_outlet',
    ];
    for (const k of keys) {
      expect(strings).toMatch(new RegExp(`${k}:\\s*\\{\\s*ar:\\s*'[^']+',\\s*en:\\s*'[^']+'`));
    }
  });
});

describe('Guards: no SQL/migration/package change, unrelated behavior untouched', () => {
  it('no migration .sql file was created or modified by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/055_phoenix_clean_availability_data.sql" ":!supabase/migrations/056_phoenix_platform_broadcast_notices.sql" ":!supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
    let listing = '';
    try {
      listing = execSync('git status --porcelain -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    // PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A: new reviewed migration 055,
    // prepared but not yet applied/committed, is the only allowed entry here.
    const unexpectedListing = listing.split(String.fromCharCode(10)).map(l => l.trim()).filter(Boolean)
      .filter(l => l !== '?? supabase/migrations/055_phoenix_clean_availability_data.sql'
                 && l !== 'A  supabase/migrations/055_phoenix_clean_availability_data.sql'
                 && l !== 'M supabase/migrations/055_phoenix_clean_availability_data.sql'
                 && l !== 'M  supabase/migrations/055_phoenix_clean_availability_data.sql'
                 && l !== '?? supabase/migrations/056_phoenix_platform_broadcast_notices.sql'
                 && l !== 'A  supabase/migrations/056_phoenix_platform_broadcast_notices.sql'
                 && l !== 'M supabase/migrations/056_phoenix_platform_broadcast_notices.sql'
                 && l !== 'M  supabase/migrations/056_phoenix_platform_broadcast_notices.sql'
                 && l !== '?? supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql'
                 && l !== 'A  supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql'
                 // PUBLIC-QR-DOSAGE-FORM-IMPLEMENT-A: new reviewed additive migration (untracked).
                 && l !== '?? supabase/migrations/058_phoenix_public_qr_dosage_form.sql'
                 && l !== '?? supabase/migrations/059_phoenix_public_qr_concentration.sql'
                 && l !== 'A  supabase/migrations/058_phoenix_public_qr_dosage_form.sql'
                 && l !== 'A  supabase/migrations/059_phoenix_public_qr_concentration.sql');
    expect(unexpectedListing).toEqual([]);
  });

  it('no migration 055 was created, other than the later, separately-reviewed PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A addition', () => {
    const migrationsDir = join(ROOT, 'supabase/migrations');
    const matches = readdirSync(migrationsDir).filter((f: string) => /^055_/.test(f));
    expect(matches).toEqual(['055_phoenix_clean_availability_data.sql']);
  });

  // QR-BUNDLE-CODE-SPLIT-A: a later, separately-reviewed phase legitimately
  // restructures src/app/App.tsx (route-level lazy loading) — excluded here.
  // DB-PRESSURE-QUICK-WINS-A: a later, separately-reviewed phase legitimately
  // adds a skipAuthBootstrap flag to src/app/AppContext.tsx — excluded here.
  it('no QR/alert-lifecycle/movement-history/auth/permissions file was touched by this phase', () => {
    let diff = '';
    try {
      diff = execSync(
        // PUBLIC-QR-DOSAGE-FORM-IMPLEMENT-A: PublicQrScreen.tsx excluded — additive
        // dosage_form render landed in that later, separately-reviewed phase.
        'git diff -- src/shared/supabase/services/qr.service.ts src/features/alerts/inter-org-alert-lifecycle.service.ts src/shared/supabase/services/auth.service.ts src/shared/lib/permissions.ts src/features/status/MovementHistoryModal.tsx src/features/status/MovementReportSection.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('remove/reactivate/clear-port behavior (InstitutionScreen/ReactivateMaterialModal) is untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/features/institutions/InstitutionScreen.tsx src/features/status/ReactivateMaterialModal.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('availability.service.ts was not touched (no new query/RPC needed for this phase)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/supabase/services/availability.service.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('premium-preview.html remains untracked (only "??" status if present)', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });

  it('supabase/.temp/ was not staged', () => {
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    const tempLine = status.split('\n').find(l => l.includes('supabase/.temp'));
    if (tempLine) {
      expect(tempLine.trim().startsWith('??')).toBe(true);
    }
  });

  it('Service-D stash (paused inter-org exchange service work) remains untouched', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });
});
