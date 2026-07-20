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
import { readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { findUnexpectedMigrationGitStatusEntries } from '../../../../supabase/migrations/__tests__/helpers/reviewed-migration-git-status';
import {
  readSourceFile,
  balancedBlockAt,
  declarationValueAt,
  blockBetween,
  enclosingJsxTag,
} from '../../../shared/__tests__/helpers/source-extract';

const ROOT = join(__dirname, '../../../../');
const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readSourceFile(join(SRC, rel));

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
    const block = declarationValueAt(modal, 'const FIELD_DEFINITIONS');
    const matches = block.match(/\{ key: '/g) ?? [];
    expect(matches.length).toBe(16);
  });

  it('FIELD_DEFINITIONS contains exactly the required 16 keys, no more, no less', () => {
    const block = declarationValueAt(modal, 'const FIELD_DEFINITIONS');
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
    const body = balancedBlockAt(modal, 'function selectAllFields()');
    expect(body).toContain('new Set(DEFAULT_SELECTED_FIELD_KEYS)');
  });

  it('clearAllFields sets an empty Set', () => {
    const body = balancedBlockAt(modal, 'function clearAllFields()');
    expect(body).toContain('new Set()');
  });

  it('restoreDefaultFields resets to DEFAULT_SELECTED_FIELD_KEYS', () => {
    const body = balancedBlockAt(modal, 'function restoreDefaultFields()');
    expect(body).toContain('new Set(DEFAULT_SELECTED_FIELD_KEYS)');
  });

  it('all three controls are wired to buttons with the required bilingual labels', () => {
    expect(modal).toContain("onClick={selectAllFields}>{t('sc_outlet_report_fields_select_all', lang)}");
    expect(modal).toContain("onClick={clearAllFields}>{t('sc_outlet_report_fields_clear_all', lang)}");
    expect(modal).toContain("onClick={restoreDefaultFields}>{t('sc_outlet_report_fields_restore_default', lang)}");
  });

  it('toggling a single field only adds/removes that one key (does not reset the whole set)', () => {
    const body = balancedBlockAt(modal, 'function toggleField(key: string)');
    expect(body).toContain('const next = new Set(selectedFields);');
    expect(body).toContain('if (next.has(key)) next.delete(key); else next.add(key);');
  });
});

describe('3) localStorage persistence under the exact required key, with a safe fallback', () => {
  it('uses the exact key phoenix_outlet_report_selected_fields', () => {
    expect(modal).toContain("const FIELD_SELECTOR_STORAGE_KEY = 'phoenix_outlet_report_selected_fields';");
  });

  it('loadSelectedFields reads/writes are try/catch wrapped and never throw', () => {
    const body = balancedBlockAt(modal, 'function loadSelectedFields()');
    expect(body).toContain('try {');
    expect(body).toContain('} catch {');
    expect(body).toContain('return new Set(DEFAULT_SELECTED_FIELD_KEYS);');
  });

  it('saveSelectedFields is try/catch wrapped (non-fatal on failure)', () => {
    const body = balancedBlockAt(modal, 'function saveSelectedFields(keys: Set<string>): void {');
    expect(body).toContain('try {');
    expect(body).toContain('} catch {');
  });

  it('every mutation path (toggle/select-all/clear-all/restore-default) calls updateSelectedFields, which persists via saveSelectedFields', () => {
    const body = balancedBlockAt(modal, 'function updateSelectedFields(next: Set<string>)');
    expect(body).toContain('setSelectedFields(next);');
    expect(body).toContain('saveSelectedFields(next);');
  });

  it('missing/empty localStorage value falls back to the default set', () => {
    const body = balancedBlockAt(modal, 'function loadSelectedFields()');
    expect(body).toContain('if (!raw) return new Set(DEFAULT_SELECTED_FIELD_KEYS);');
  });

  it('corrupt/non-array/invalid-key localStorage value falls back safely to the default set (never crashes)', () => {
    const body = balancedBlockAt(modal, 'function loadSelectedFields()');
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
    const btnTag = enclosingJsxTag(modal, 'onClick={exportXlsx}');
    expect(btnTag).toContain('disabled={xlsxBusy || noFieldsSelected}');
  });

  it('Print/PDF button is disabled when noFieldsSelected', () => {
    const btnTag = enclosingJsxTag(modal, 'onClick={printReport}');
    expect(btnTag).toContain('disabled={filteredRows.length === 0 || noFieldsSelected}');
  });

  it('exportXlsx() and printReport() both bail out early (no-op, no crash) when noFieldsSelected is true', () => {
    expect(balancedBlockAt(modal, 'async function exportXlsx()')).toContain('if (xlsxBusy || noFieldsSelected) return;');
    expect(balancedBlockAt(modal, 'function printReport()')).toContain('if (noFieldsSelected) return;');
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
    const body = balancedBlockAt(modal, 'async function exportXlsx()');
    expect(body).toContain('Array.from(selectedFields).map(k => FIELD_TO_EXCEL_COLUMN_KEY[k])');
    expect(body).toContain('selectedColumnKeys,');
  });

  it('printReport() filters printColumns by the SAME selectedFields set (one shared state)', () => {
    const body = balancedBlockAt(modal, 'function printReport()');
    expect(body).toContain('printColumns.filter(c => selectedFields.has(c.key))');
  });

  it('printColumns keys match the canonical FIELD_DEFINITIONS keys exactly (same 16-key vocabulary as Excel)', () => {
    const block = declarationValueAt(modal, 'const printColumns');
    for (const key of REQUIRED_16_KEYS) {
      expect(block).toContain(`key: '${key}'`);
    }
  });

  it('FIELD_TO_EXCEL_COLUMN_KEY maps all 16 canonical keys to a valid Excel column key', () => {
    const block = declarationValueAt(modal, 'const FIELD_TO_EXCEL_COLUMN_KEY');
    for (const key of REQUIRED_16_KEYS) {
      expect(block).toMatch(new RegExp(`${key}: '[a-zA-Z]+'`));
    }
  });
});

describe('6) Unchecking a field removes it from both Excel export and Print/PDF for this modal', () => {
  it('a deselected field key is absent from selectedColumnKeys (Excel) because only selectedFields members are mapped', () => {
    const body = balancedBlockAt(modal, 'const selectedColumnKeys = new Set(');
    expect(body).toContain('Array.from(selectedFields).map(k => FIELD_TO_EXCEL_COLUMN_KEY[k]).filter(Boolean)');
  });

  it('a deselected field key is absent from print columns because printColumns.filter only keeps selectedFields members', () => {
    expect(modal).toContain('const columns = printColumns.filter(c => selectedFields.has(c.key));');
    expect(modal).toContain('columns,\n      rows: filteredRows,');
  });
});

describe('7) Default (untouched) selection preserves existing export/print behavior', () => {
  it('with the default Set (all 16 keys), buildExportRows still returns every OutletReportRow field unconditionally (row shape is never filtered, only the Excel column list is)', () => {
    const body = balancedBlockAt(modal, 'function buildExportRows(): OutletReportRow[] {');
    for (const field of ['institution:', 'outlet:', 'scientificName:', 'tradeName:', 'dosageForm:', 'concentration:', 'batchNumber:', 'quantity:', 'enteredPrice:', 'conditionKey:', 'conditionLabel:', 'expiryDate:', 'daysToExpiry:', 'expiryRiskLabel:', 'lastUpdatedBy:', 'lastUpdatedAt:', 'notes:', 'removedLabel:', 'supplyType:']) {
      expect(body).toContain(field);
    }
  });

  it('buildOutletReportWorkbook keeps every column when selectedColumnKeys is omitted (default-preserving contract)', () => {
    const body = blockBetween(exportModule, 'const dataColumns = config.selectedColumnKeys', ': OUTLET_REPORT_COLUMNS;');
    expect(body).toContain('? OUTLET_REPORT_COLUMNS.filter(c => NON_FILTERABLE_OUTLET_COLUMNS.has(c.key) || config.selectedColumnKeys!.has(c.key))');
    expect(body).toContain(': OUTLET_REPORT_COLUMNS;');
  });

  it('selectedColumnKeys is an optional property on OutletReportConfig (every pre-existing caller compiles unchanged)', () => {
    const body = balancedBlockAt(exportModule, 'export interface OutletReportConfig {');
    expect(body).toContain('selectedColumnKeys?: Set<string>;');
  });

  it('non-filterable Excel-only columns (No, Expiry Risk, Last Updated By) are never removed by field filtering', () => {
    expect(exportModule).toContain("const NON_FILTERABLE_OUTLET_COLUMNS = new Set<OutletReportColumnKey>(['no', 'expiryRisk', 'lastUpdatedBy']);");
  });
});

describe('8) Field selector controls columns only — row filters are completely untouched', () => {
  it('field-selection state (selectedFields/fieldsOpen) is never referenced inside the row-filtering useMemo', () => {
    const body = balancedBlockAt(modal, 'const filteredRows = useMemo(() => {');
    expect(body).not.toMatch(/selectedFields|fieldsOpen/);
  });

  it('selectedFiltersText never includes field-selection state', () => {
    const body = balancedBlockAt(modal, 'const selectedFiltersText = useMemo(');
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
    const block = declarationValueAt(modal, 'const FIELD_DEFINITIONS');
    expect(block).not.toMatch(/\bid\b|uuid|removed_by|actor_id|entity_id|token|payload/i);
  });

  it('FIELD_TO_EXCEL_COLUMN_KEY never maps to a sensitive/internal Excel column name', () => {
    const block = declarationValueAt(modal, 'const FIELD_TO_EXCEL_COLUMN_KEY');
    expect(block).not.toMatch(/removed_by|actor_id|entity_id|token|payload/i);
  });

  it('OUTLET_REPORT_COLUMNS (the full underlying Excel column universe) has no ID/UUID/removed_by/actor/entity/token/payload column', () => {
    const block = declarationValueAt(exportModule, 'const OUTLET_REPORT_COLUMNS');
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
    // MIGRATION-GUARD-DERIVE-B: the allowed in-flight migration entries are
    // now DERIVED from the canonical reviewed registry instead of a copy kept
    // in this file, so registering a migration once permits it everywhere and
    // no historical guard needs an edit. Strictly stronger than the old list:
    // an unregistered migration still fails, and a MODIFIED reviewed migration
    // now fails too (the old list tolerated `M `/`M  ` entries).
    expect(findUnexpectedMigrationGitStatusEntries(listing)).toEqual([]);
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
      // PUBLIC-QR-DOSAGE-FORM-IMPLEMENT-A: PublicQrScreen.tsx excluded — additive
      // dosage_form render landed in that later, separately-reviewed phase.
      diff = execSync('git diff -- src/features/qr/QrScreen.tsx src/shared/supabase/services/qr.service.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  // QR-BUNDLE-CODE-SPLIT-A: a later, separately-reviewed phase legitimately
  // restructures src/app/App.tsx (route-level lazy loading) — excluded here.
  // DB-PRESSURE-QUICK-WINS-A: a later, separately-reviewed phase legitimately
  // adds a skipAuthBootstrap flag to src/app/AppContext.tsx — excluded here.
  it('auth/session/permissions files unchanged', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/supabase/services/auth.service.ts src/shared/lib/permissions.ts', { cwd: ROOT, encoding: 'utf8' });
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
