/**
 * PHASE2-EXPORT-FIELD-SELECTOR-A
 * Run: npm test -- --run outlet
 *
 * Static source-code tests for the outlet report modal's export/print field
 * (column) selector: exactly the 16 non-sensitive fields specified in the
 * task, Select all/Clear all/Restore default controls, localStorage
 * persistence with a safe fallback, the zero-fields-selected guard on both
 * Excel and Print/PDF, and confirmation that field selection never touches
 * row filtering or the main Status Center XLSX export.
 *
 * No live DB is used and no component is rendered — these are static
 * source-code assertions, matching this repo's established test conventions
 * (e.g. pwa-install-prompt.test.ts also verifies localStorage handling this
 * way, without executing the hook).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const ROOT = join(__dirname, '../../../../');
const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const modal = readSrc('features/status/OutletAvailabilityReportModal.tsx');
const exportModule = readSrc('shared/lib/professional-export.ts');
const strings = readSrc('shared/i18n/strings.ts');

function T(key: string): { ar: string; en: string } {
  const re = new RegExp(`${key}:\\s*\\{\\s*ar:\\s*'([^']+)',\\s*en:\\s*'([^']+)'`);
  const m = strings.match(re);
  if (!m) throw new Error(`key ${key} not found`);
  return { ar: m[1], en: m[2] };
}

const REQUIRED_16_KEYS = [
  'institution', 'outlet', 'scientificName', 'tradeName', 'dosageForm', 'concentration',
  'quantity', 'condition', 'enteredPrice', 'supplyType', 'batchNumber', 'expiryDate',
  'daysToExpiry', 'notes', 'lastUpdated', 'removedStatus',
];

describe('1) Field selector defines exactly the required 16 selectable fields, all checked by default', () => {
  it('FIELD_DEFINITIONS has exactly 16 entries', () => {
    const start = modal.indexOf('const FIELD_DEFINITIONS: FieldDefinition[] = [');
    const end = modal.indexOf('];', start);
    const block = modal.slice(start, end);
    const matches = block.match(/\{ key: '/g) ?? [];
    expect(matches.length).toBe(16);
  });

  it('FIELD_DEFINITIONS contains exactly the required 16 keys, no more, no less', () => {
    const start = modal.indexOf('const FIELD_DEFINITIONS: FieldDefinition[] = [');
    const end = modal.indexOf('];', start);
    const block = modal.slice(start, end);
    for (const key of REQUIRED_16_KEYS) {
      expect(block).toContain(`key: '${key}'`);
    }
    // No extra keys beyond the required 16.
    const foundKeys = Array.from(block.matchAll(/key: '([a-zA-Z]+)'/g)).map(m => m[1]);
    expect(foundKeys.sort()).toEqual([...REQUIRED_16_KEYS].sort());
  });

  it('DEFAULT_SELECTED_FIELD_KEYS is derived from all of FIELD_DEFINITIONS (all 16 selected by default)', () => {
    expect(modal).toContain('const DEFAULT_SELECTED_FIELD_KEYS = FIELD_DEFINITIONS.map(f => f.key);');
  });

  it('the field selector checkbox is checked based on selectedFields.has(f.key) for every FIELD_DEFINITIONS entry', () => {
    expect(modal).toContain('checked={selectedFields.has(f.key)}');
    expect(modal).toContain('{FIELD_DEFINITIONS.map(f =>');
  });

  it('initial state is loaded via loadSelectedFields(), which falls back to the full default set', () => {
    expect(modal).toContain("const [selectedFields, setSelectedFields] = useState<Set<string>>(() => loadSelectedFields());");
  });
});

describe('2) Select all / Clear all / Restore default controls', () => {
  it('selectAllFields sets every DEFAULT_SELECTED_FIELD_KEYS (all 16)', () => {
    const start = modal.indexOf('function selectAllFields()');
    const body = modal.slice(start, start + 120);
    expect(body).toContain('new Set(DEFAULT_SELECTED_FIELD_KEYS)');
  });

  it('clearAllFields sets an empty Set', () => {
    const start = modal.indexOf('function clearAllFields()');
    const body = modal.slice(start, start + 80);
    expect(body).toContain('new Set()');
  });

  it('restoreDefaultFields resets to DEFAULT_SELECTED_FIELD_KEYS', () => {
    const start = modal.indexOf('function restoreDefaultFields()');
    const body = modal.slice(start, start + 120);
    expect(body).toContain('new Set(DEFAULT_SELECTED_FIELD_KEYS)');
  });

  it('all three controls are wired to buttons with the required bilingual labels', () => {
    expect(modal).toContain("onClick={selectAllFields}>{t('sc_outlet_report_fields_select_all', lang)}");
    expect(modal).toContain("onClick={clearAllFields}>{t('sc_outlet_report_fields_clear_all', lang)}");
    expect(modal).toContain("onClick={restoreDefaultFields}>{t('sc_outlet_report_fields_restore_default', lang)}");
  });

  it('toggling a single field only adds/removes that one key (does not reset the whole set)', () => {
    const start = modal.indexOf('function toggleField(key: string)');
    const body = modal.slice(start, start + 200);
    expect(body).toContain('const next = new Set(selectedFields);');
    expect(body).toContain('if (next.has(key)) next.delete(key); else next.add(key);');
  });
});

describe('3) localStorage persistence under the exact required key, with a safe fallback', () => {
  it('uses the exact key phoenix_outlet_report_selected_fields', () => {
    expect(modal).toContain("const FIELD_SELECTOR_STORAGE_KEY = 'phoenix_outlet_report_selected_fields';");
  });

  it('loadSelectedFields reads/writes are try/catch wrapped and never throw', () => {
    const start = modal.indexOf('function loadSelectedFields()');
    const end = modal.indexOf('function saveSelectedFields');
    const body = modal.slice(start, end);
    expect(body).toContain('try {');
    expect(body).toContain('} catch {');
    expect(body).toContain('return new Set(DEFAULT_SELECTED_FIELD_KEYS);');
  });

  it('saveSelectedFields is try/catch wrapped (non-fatal on failure)', () => {
    const start = modal.indexOf('function saveSelectedFields(keys: Set<string>): void {');
    const body = modal.slice(start, start + 250);
    expect(body).toContain('try {');
    expect(body).toContain('} catch {');
  });

  it('every mutation path (toggle/select-all/clear-all/restore-default) calls updateSelectedFields, which persists via saveSelectedFields', () => {
    const start = modal.indexOf('function updateSelectedFields(next: Set<string>)');
    const body = modal.slice(start, start + 150);
    expect(body).toContain('setSelectedFields(next);');
    expect(body).toContain('saveSelectedFields(next);');
  });

  it('missing/empty localStorage value falls back to the default set', () => {
    const start = modal.indexOf('function loadSelectedFields()');
    const body = modal.slice(start, modal.indexOf('function saveSelectedFields'));
    expect(body).toContain('if (!raw) return new Set(DEFAULT_SELECTED_FIELD_KEYS);');
  });

  it('corrupt/non-array/invalid-key localStorage value falls back safely to the default set (never crashes)', () => {
    const start = modal.indexOf('function loadSelectedFields()');
    const body = modal.slice(start, modal.indexOf('function saveSelectedFields'));
    expect(body).toContain('const parsed: unknown = JSON.parse(raw);');
    expect(body).toContain('if (!Array.isArray(parsed)) return new Set(DEFAULT_SELECTED_FIELD_KEYS);');
    expect(body).toContain('typeof k === \'string\' && validKeys.has(k)');
    expect(body).toContain('return restored.length > 0 ? new Set(restored) : new Set(DEFAULT_SELECTED_FIELD_KEYS);');
  });
});

describe('4) Zero-fields-selected guard: Excel export, Print/PDF, and inline validation', () => {
  it('noFieldsSelected is derived from selectedFields.size === 0', () => {
    expect(modal).toContain('const noFieldsSelected = selectedFields.size === 0;');
  });

  it('Export Excel button is disabled when noFieldsSelected', () => {
    const idx = modal.indexOf("onClick={exportXlsx}");
    const btnTag = modal.slice(Math.max(0, idx - 300), idx);
    expect(btnTag).toContain('disabled={xlsxBusy || noFieldsSelected}');
  });

  it('Print/PDF button is disabled when noFieldsSelected', () => {
    const idx = modal.indexOf("onClick={printReport}");
    const btnTag = modal.slice(Math.max(0, idx - 300), idx);
    expect(btnTag).toContain('disabled={filteredRows.length === 0 || noFieldsSelected}');
  });

  it('exportXlsx() and printReport() both bail out early (no-op, no crash) when noFieldsSelected is true', () => {
    const exportStart = modal.indexOf('async function exportXlsx()');
    expect(modal.slice(exportStart, exportStart + 100)).toContain('if (xlsxBusy || noFieldsSelected) return;');
    const printStart = modal.indexOf('function printReport()');
    expect(modal.slice(printStart, printStart + 80)).toContain('if (noFieldsSelected) return;');
  });

  it('a bilingual inline validation message renders when noFieldsSelected', () => {
    expect(modal).toContain('{noFieldsSelected && (');
    expect(modal).toContain("t('sc_outlet_report_fields_none_selected', lang)");
    expect(T('sc_outlet_report_fields_none_selected').ar).toBe('يجب اختيار عمود واحد على الأقل قبل التصدير أو الطباعة');
    expect(T('sc_outlet_report_fields_none_selected').en).toBe('Select at least one column before exporting or printing');
  });
});

describe('5) Field selection is applied identically to Excel and Print/PDF', () => {
  it('exportXlsx() translates selectedFields to Excel column keys via FIELD_TO_EXCEL_COLUMN_KEY and passes selectedColumnKeys', () => {
    const start = modal.indexOf('async function exportXlsx()');
    const end = modal.indexOf('async function exportXlsx()') + modal.slice(modal.indexOf('async function exportXlsx()')).indexOf('\n  }\n') + 5;
    const body = modal.slice(start, end);
    expect(body).toContain('Array.from(selectedFields).map(k => FIELD_TO_EXCEL_COLUMN_KEY[k])');
    expect(body).toContain('selectedColumnKeys,');
  });

  it('printReport() filters printColumns by the SAME selectedFields set (one shared state)', () => {
    const start = modal.indexOf('function printReport()');
    const body = modal.slice(start, start + 400);
    expect(body).toContain('printColumns.filter(c => selectedFields.has(c.key))');
  });

  it('printColumns keys match the canonical FIELD_DEFINITIONS keys exactly (same 16-key vocabulary as Excel)', () => {
    const start = modal.indexOf('const printColumns: ProfessionalReportColumn<LiveAvailRow>[] = [');
    const end = modal.indexOf('];', start);
    const block = modal.slice(start, end);
    for (const key of REQUIRED_16_KEYS) {
      expect(block).toContain(`key: '${key}'`);
    }
  });

  it('FIELD_TO_EXCEL_COLUMN_KEY maps all 16 canonical keys to a valid Excel column key', () => {
    const start = modal.indexOf('const FIELD_TO_EXCEL_COLUMN_KEY: Record<string, string> = {');
    const end = modal.indexOf('};', start);
    const block = modal.slice(start, end);
    for (const key of REQUIRED_16_KEYS) {
      expect(block).toMatch(new RegExp(`${key}: '[a-zA-Z]+'`));
    }
  });
});

describe('6) Unchecking a field removes it from both Excel export and Print/PDF for this modal', () => {
  it('a deselected field key is absent from selectedColumnKeys (Excel) because only selectedFields members are mapped', () => {
    const start = modal.indexOf('const selectedColumnKeys = new Set(');
    const body = modal.slice(start, start + 150);
    expect(body).toContain('Array.from(selectedFields).map(k => FIELD_TO_EXCEL_COLUMN_KEY[k]).filter(Boolean)');
  });

  it('a deselected field key is absent from print columns because printColumns.filter only keeps selectedFields members', () => {
    expect(modal).toContain('const columns = printColumns.filter(c => selectedFields.has(c.key));');
    expect(modal).toContain('columns,\n      rows: filteredRows,');
  });
});

describe('7) Default (untouched) selection preserves existing export/print behavior', () => {
  it('with the default Set (all 16 keys), buildExportRows still returns every OutletReportRow field unconditionally (row shape is never filtered, only the Excel column list is)', () => {
    const start = modal.indexOf('function buildExportRows(): OutletReportRow[] {');
    const body = modal.slice(start, modal.indexOf('async function exportXlsx()'));
    for (const field of ['institution:', 'outlet:', 'scientificName:', 'tradeName:', 'dosageForm:', 'concentration:', 'batchNumber:', 'quantity:', 'enteredPrice:', 'conditionKey:', 'conditionLabel:', 'expiryDate:', 'daysToExpiry:', 'expiryRiskLabel:', 'lastUpdatedBy:', 'lastUpdatedAt:', 'notes:', 'removedLabel:', 'supplyType:']) {
      expect(body).toContain(field);
    }
  });

  it('buildOutletReportWorkbook keeps every column when selectedColumnKeys is omitted (default-preserving contract)', () => {
    const start = exportModule.indexOf('const dataColumns = config.selectedColumnKeys');
    const body = exportModule.slice(start, start + 300);
    expect(body).toContain('? OUTLET_REPORT_COLUMNS.filter(c => NON_FILTERABLE_OUTLET_COLUMNS.has(c.key) || config.selectedColumnKeys!.has(c.key))');
    expect(body).toContain(': OUTLET_REPORT_COLUMNS;');
  });

  it('selectedColumnKeys is an optional property on OutletReportConfig (every pre-existing caller compiles unchanged)', () => {
    const start = exportModule.indexOf('export interface OutletReportConfig {');
    const body = exportModule.slice(start, exportModule.indexOf('}', start));
    expect(body).toContain('selectedColumnKeys?: Set<string>;');
  });

  it('non-filterable Excel-only columns (No, Expiry Risk, Last Updated By) are never removed by field filtering', () => {
    expect(exportModule).toContain("const NON_FILTERABLE_OUTLET_COLUMNS = new Set<OutletReportColumnKey>(['no', 'expiryRisk', 'lastUpdatedBy']);");
  });
});

describe('8) Field selector controls columns only — row filters are completely untouched', () => {
  it('field-selection state (selectedFields/fieldsOpen) is never referenced inside the row-filtering useMemo', () => {
    const start = modal.indexOf('const filteredRows = useMemo(() => {');
    const end = modal.indexOf('}, [outletRows,');
    const body = modal.slice(start, end);
    expect(body).not.toMatch(/selectedFields|fieldsOpen/);
  });

  it('selectedFiltersText never includes field-selection state', () => {
    const start = modal.indexOf('const selectedFiltersText = useMemo(');
    const end = modal.indexOf('}, [search, conditionFilter');
    const body = modal.slice(start, end);
    expect(body).not.toMatch(/selectedFields|FIELD_DEFINITIONS/);
  });

  it('none of the existing row filter setters (search/condition/supply/quantity/price/expiry/removed) were touched by this phase', () => {
    expect(modal).toContain('const [search, setSearch] = useState');
    expect(modal).toContain('const [conditionFilter, setConditionFilter] = useState<CanonicalCondition | \'\'>');
    expect(modal).toContain('const [supplyFilter, setSupplyFilter] = useState<SupplyCategory | \'\'>');
    expect(modal).toContain('const [quantityFilter, setQuantityFilter] = useState<QuantityFilter>');
    expect(modal).toContain('const [priceFilterMode, setPriceFilterMode] = useState<PriceFilterMode>');
    expect(modal).toContain('const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>');
    expect(modal).toContain('const [removedFilter, setRemovedFilter] = useState<RemovedFilter>');
  });
});

describe('9) Sensitive/internal fields are never selectable or exportable', () => {
  it('none of the 16 FIELD_DEFINITIONS keys are ID/UUID/removed_by/actor/entity/token/payload-shaped', () => {
    const start = modal.indexOf('const FIELD_DEFINITIONS: FieldDefinition[] = [');
    const end = modal.indexOf('];', start);
    const block = modal.slice(start, end);
    expect(block).not.toMatch(/\bid\b|uuid|removed_by|actor_id|entity_id|token|payload/i);
  });

  it('FIELD_TO_EXCEL_COLUMN_KEY never maps to a sensitive/internal Excel column name', () => {
    const start = modal.indexOf('const FIELD_TO_EXCEL_COLUMN_KEY: Record<string, string> = {');
    const end = modal.indexOf('};', start);
    const block = modal.slice(start, end);
    expect(block).not.toMatch(/removed_by|actor_id|entity_id|token|payload/i);
  });

  it('OUTLET_REPORT_COLUMNS (the full underlying Excel column universe) has no ID/UUID/removed_by/actor/entity/token/payload column', () => {
    const start = exportModule.indexOf('const OUTLET_REPORT_COLUMNS: ');
    const end = exportModule.indexOf('];', start);
    const block = exportModule.slice(start, end);
    expect(block).not.toMatch(/key: 'id'|uuid|removedBy|actorId|entityId|token|payload/i);
  });
});

describe('10) Bilingual labels: no mixed/broken labels', () => {
  it('all new sc_outlet_report_fields_* keys exist bilingually', () => {
    const keys = [
      'sc_outlet_report_fields_title', 'sc_outlet_report_fields_select_all',
      'sc_outlet_report_fields_clear_all', 'sc_outlet_report_fields_restore_default',
      'sc_outlet_report_fields_none_selected',
    ];
    for (const k of keys) {
      expect(strings).toMatch(new RegExp(`${k}:\\s*\\{\\s*ar:\\s*'[^']+',\\s*en:\\s*'[^']+'`));
    }
  });

  it('every FIELD_DEFINITIONS labelKey resolves to an existing bilingual i18n key', () => {
    const labelKeys = ['avail_inst_label', 'avail_details_outlet_label', 'avail_scientific_name', 'avail_trade_name',
      'avail_dosage_form', 'avail_concentration', 'qty', 'avail_condition', 'sc_entered_price', 'avail_supply_type',
      'batch_no', 'expiry', 'avail_details_days_to_expiry', 'sc_notes', 'last_upd', 'sc_removed_badge'];
    for (const k of labelKeys) {
      expect(strings).toMatch(new RegExp(`${k}:\\s*\\{\\s*ar:\\s*'[^']+',\\s*en:\\s*'[^']+'`));
    }
  });
});

describe('Guards: no SQL/migration/package change; QR/alerts/movement-history/auth/permissions unchanged; main Status Center XLSX unchanged', () => {
  it('main Status Center XLSX export (StatusCenterScreen.tsx exportXlsx/exportAvailabilityXlsx) is untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/status/StatusCenterScreen.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('buildAvailabilityExportWorkbook/exportAvailabilityXlsx (the main export path) still exist unrenamed and untouched', () => {
    expect(exportModule).toContain('export async function buildAvailabilityExportWorkbook');
    expect(exportModule).toContain('export async function exportAvailabilityXlsx');
  });

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
                 && l !== 'A  supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql');
    expect(unexpectedListing).toEqual([]);
  });

  it('no migration 055 was created, other than the later, separately-reviewed PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A addition', () => {
    const migrationsDir = join(ROOT, 'supabase/migrations');
    const matches = readdirSync(migrationsDir).filter((f: string) => /^055_/.test(f));
    expect(matches).toEqual(['055_phoenix_clean_availability_data.sql']);
  });

  it('no package/lockfile diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('QR files unchanged', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/qr/PublicQrScreen.tsx src/features/qr/QrScreen.tsx src/shared/supabase/services/qr.service.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('auth/session/permissions files unchanged', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/supabase/services/auth.service.ts src/shared/lib/permissions.ts src/app/AppContext.tsx src/app/App.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('alerts lifecycle files unchanged', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/alerts/inter-org-alert-lifecycle.service.ts src/features/alerts/InterInstitutionAlertsScreen.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('movement history files unchanged', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/status/MovementHistoryModal.tsx src/features/status/MovementReportSection.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('remove/reactivate/clear-port behavior unchanged', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/institutions/InstitutionScreen.tsx src/features/status/ReactivateMaterialModal.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('dashboard RPC service file unchanged', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/supabase/services/dashboard.service.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('Audit Log tab / Reports route files unchanged', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/reports/AuditLogSection.tsx src/features/reports/ReportsScreen.tsx', { cwd: ROOT, encoding: 'utf8' });
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
