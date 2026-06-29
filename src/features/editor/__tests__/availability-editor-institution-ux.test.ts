/**
 * Availability Editor & Status Editor Tests
 * Run: npm test -- --run
 *
 * Static source-code tests verifying the UX changes without a DB connection.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const SRC     = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');

function readSrc(rel: string) {
  return readFileSync(join(SRC, rel), 'utf8');
}

function readPhoenix(rel: string) {
  return readFileSync(join(PHOENIX, rel), 'utf8');
}

function allTsxFiles(dir: string): string[] {
  const base = join(SRC, dir);
  return readdirSync(base, { recursive: true })
    .filter((f): f is string =>
      typeof f === 'string' &&
      (f.endsWith('.ts') || f.endsWith('.tsx')) &&
      !f.includes('__tests__') &&
      !f.endsWith('.test.ts') &&
      !f.endsWith('.spec.ts')
    )
    .map(f => join(base, f));
}

function readFile(path: string) {
  return readFileSync(path, 'utf8');
}

const editor  = readSrc('features/editor/EditorScreen.tsx');
const strings = readSrc('shared/i18n/strings.ts');
const types   = readSrc('shared/lib/types.ts');
const service = readSrc('shared/supabase/services/availability.service.ts');

// ============================================================================
// Free-text port_name removed from editor
// ============================================================================

describe('Port name free-text input removed from editor', () => {
  it('no ed-port text input in EditorScreen', () => {
    expect(editor).not.toContain('<input id="ed-port"');
  });

  it('no avail_port_field key used in editor', () => {
    expect(editor).not.toContain('avail_port_field');
  });

  it('no avail_port_ph key used in editor', () => {
    expect(editor).not.toContain('avail_port_ph');
  });

  it('no portName state in editor', () => {
    expect(editor).not.toContain("const [portName,");
  });
});

// ============================================================================
// Port selected via dropdown
// ============================================================================

describe('Port is selected via dropdown', () => {
  it('ed-point select element exists', () => {
    expect(editor).toContain('<select id="ed-point"');
  });

  it('uses avail_point_select key', () => {
    expect(editor).toContain('avail_point_select');
  });

  it('avail_point_select says "Select port"', () => {
    expect(strings).toContain("avail_point_select");
    const line = strings.split('\n').find(l => l.includes('avail_point_select'));
    expect(line).toContain('Select port');
    expect(line).toContain('اختر المنفذ');
  });
});

// ============================================================================
// No-ports warning
// ============================================================================

describe('No-ports warning', () => {
  it('avail_no_ports key exists in strings', () => {
    expect(strings).toContain('avail_no_ports');
  });

  it('avail_no_ports used in editor', () => {
    expect(editor).toContain('avail_no_ports');
  });
});

// ============================================================================
// New material identity fields in editor
// ============================================================================

describe('Material identity fields in editor', () => {
  it('scientific name field exists', () => {
    expect(editor).toContain('avail_scientific_name');
    expect(editor).toContain('scientificName');
  });

  it('trade name field exists', () => {
    expect(editor).toContain('avail_trade_name');
    expect(editor).toContain('tradeName');
  });

  it('dosage form field exists', () => {
    expect(editor).toContain('avail_dosage_form');
    expect(editor).toContain('dosageForm');
  });

  it('concentration field exists', () => {
    expect(editor).toContain('avail_concentration');
    expect(editor).toContain('concentrationVal');
  });

  it('price field exists', () => {
    expect(editor).toContain('avail_price');
    expect(editor).toContain('ed-price');
  });

  it('scientific name is required (in canSubmit)', () => {
    expect(editor).toContain('scientificName.trim()');
  });
});

// ============================================================================
// National code label remains
// ============================================================================

describe('National code label remains', () => {
  it('avail_national_code key used in editor', () => {
    expect(editor).toContain('avail_national_code');
  });

  it('bilingual national code labels exist', () => {
    expect(strings).toContain('الرمز الوطني');
    expect(strings).toContain('National code');
  });
});

// ============================================================================
// Status localized (all cond_ keys, surplus/near_expiry combined)
// ============================================================================

describe('Status localization', () => {
  it('all condition keys exist', () => {
    expect(strings).toContain('cond_available');
    expect(strings).toContain('cond_low_stock');
    expect(strings).toContain('cond_missing');
    expect(strings).toContain('cond_surplus');
    expect(strings).toContain('cond_near_expiry');
    expect(strings).toContain('cond_expired');
  });

  it('surplus and near_expiry both display as combined wording', () => {
    const surplusLine = strings.split('\n').find(l => l.includes('cond_surplus'));
    const nearLine = strings.split('\n').find(l => l.includes('cond_near_expiry'));
    expect(surplusLine).toContain('الفائضة - قريبة النفاذ');
    expect(nearLine).toContain('الفائضة - قريبة النفاذ');
  });
});

// ============================================================================
// Supply type field
// ============================================================================

describe('Supply type field exists', () => {
  it('supply type in editor', () => {
    expect(editor).toContain('avail_supply_type');
    expect(editor).toContain('supplyType');
  });

  it('bilingual supply type labels exist', () => {
    expect(strings).toContain('نوع التجهيز');
    expect(strings).toContain('Supply type');
  });
});

// ============================================================================
// Status Editor screen
// ============================================================================

describe('Status Editor screen', () => {
  const statusEditorPath = join(SRC, 'features/status/StatusEditorScreen.tsx');

  it('StatusEditorScreen file exists', () => {
    expect(existsSync(statusEditorPath)).toBe(true);
  });

  const statusEditor = readFile(statusEditorPath);

  it('has export excel button (se_export_excel)', () => {
    expect(statusEditor).toContain('se_export_excel');
  });

  it('has export pdf button (se_export_pdf)', () => {
    expect(statusEditor).toContain('se_export_pdf');
  });

  it('has print button (se_print)', () => {
    expect(statusEditor).toContain('se_print');
  });

  it('has filter controls', () => {
    expect(statusEditor).toContain('se_all_ports');
    expect(statusEditor).toContain('se_all_statuses');
    expect(statusEditor).toContain('filterPort');
    expect(statusEditor).toContain('filterStatus');
  });

  it('shows PhoenixOrgScope', () => {
    expect(statusEditor).toContain('PhoenixOrgScope');
  });

  it('uses getAvailabilityByOrg', () => {
    expect(statusEditor).toContain('getAvailabilityByOrg');
  });
});

// ============================================================================
// Migration 020 safety
// ============================================================================

describe('Migration 020: material identity fields', () => {
  const sql = readPhoenix('supabase/migrations/020_phoenix_availability_material_fields_and_status_editor.sql');

  it('file exists and is non-empty', () => {
    expect(sql.length).toBeGreaterThan(500);
  });

  it('is manual-apply-only', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('DO NOT use');
    expect(sql).toContain('supabase db push');
  });

  it('has no DROP, TRUNCATE, or destructive DELETE', () => {
    expect(sql).not.toMatch(/^\s*(drop table|drop function|truncate)\b/im);
    expect(sql).not.toMatch(/^\s*delete from\b/im);
  });

  it('has no unsafe CASCADE in SQL statements (comments excluded)', () => {
    const sqlStatements = sql.split('\n').filter(l => !l.trimStart().startsWith('--'));
    const joined = sqlStatements.join('\n');
    expect(joined).not.toMatch(/cascade/i);
  });

  it('does not write to auth.users', () => {
    expect(sql).not.toMatch(/\b(insert|update|delete)\b.*auth\.users/i);
  });

  it('adds scientific_name column', () => {
    expect(sql).toContain('add column if not exists scientific_name');
  });

  it('adds trade_name column', () => {
    expect(sql).toContain('add column if not exists trade_name');
  });

  it('adds dosage_form column', () => {
    expect(sql).toContain('add column if not exists dosage_form');
  });

  it('adds concentration column', () => {
    expect(sql).toContain('add column if not exists concentration');
  });

  it('adds price column', () => {
    expect(sql).toContain('add column if not exists price');
  });

  it('creates unique index for scientific_name upsert', () => {
    expect(sql).toContain('item_avail_point_sciname_idx');
    expect(sql).toContain('distribution_point_id, scientific_name');
  });

  it('includes a verification block', () => {
    expect(sql).toContain('assert');
    expect(sql).toContain('VERIFY');
  });

  it('is idempotent (uses IF NOT EXISTS patterns)', () => {
    expect(sql).toContain('if not exists');
    expect(sql).toContain('add column if not exists');
    expect(sql).toContain('create unique index if not exists');
  });

  it('does not reference service_role', () => {
    expect(sql).not.toContain('service_role');
  });
});

// ============================================================================
// Service layer: upsert uses scientific_name flow
// ============================================================================

describe('Service: availability upsert uses scientific_name', () => {
  it('UpsertAvailabilityInput has scientificName field', () => {
    expect(service).toContain('scientificName');
  });

  it('UpsertAvailabilityInput has supplyType field', () => {
    expect(service).toContain('supplyType');
  });

  it('upsert targets scientific_name conflict key', () => {
    expect(service).toContain("onConflict: 'distribution_point_id,scientific_name'");
  });

  it('does not write port_name in upsert row', () => {
    // The upsert function row assignment should not include port_name
    const upsertFn = service.slice(service.indexOf('async function upsertAvailability'));
    expect(upsertFn).not.toContain("port_name:");
    expect(upsertFn).not.toContain("row.port_name");
  });

  it('does not write local_item_id in upsert row', () => {
    const upsertFn = service.slice(service.indexOf('async function upsertAvailability'));
    expect(upsertFn).not.toContain("local_item_id:");
    expect(upsertFn).not.toContain("row.local_item_id");
  });

  it('getAvailabilityByOrg function exists', () => {
    expect(service).toContain('async function getAvailabilityByOrg');
    expect(service).toContain('organization_id');
  });
});

// ============================================================================
// i18n keys completeness
// ============================================================================

describe('All new i18n keys exist', () => {
  const REQUIRED_KEYS = [
    'avail_inst_label',
    'avail_inst_locked_note',
    'avail_point_select',
    'avail_national_code',
    'avail_national_code_ph',
    'avail_material_status',
    'avail_supply_type',
    'avail_supply_type_ph',
    'avail_no_ports',
    'avail_create_port_first',
    'avail_scientific_name',
    'avail_scientific_ph',
    'avail_trade_name',
    'avail_trade_ph',
    'avail_dosage_form',
    'avail_dosage_ph',
    'avail_concentration',
    'avail_concentration_ph',
    'avail_price',
    'avail_price_ph',
    'nav_status_editor',
    'se_sub',
    'se_export_excel',
    'se_export_pdf',
    'se_print',
    'se_filter_port',
    'se_filter_status',
    'se_all_ports',
    'se_all_statuses',
    'se_no_records',
  ];

  REQUIRED_KEYS.forEach(key => {
    it(`string key "${key}" exists in strings.ts`, () => {
      expect(strings).toContain(key);
    });
  });
});

// ============================================================================
// Types include new fields
// ============================================================================

describe('Types include new material fields', () => {
  it('scientific_name in AvailabilityRecord', () => {
    expect(types).toContain('scientific_name');
  });

  it('trade_name in AvailabilityRecord', () => {
    expect(types).toContain('trade_name');
  });

  it('dosage_form in AvailabilityRecord', () => {
    expect(types).toContain('dosage_form');
  });

  it('concentration in AvailabilityRecord', () => {
    expect(types).toContain('concentration');
  });

  it('price in AvailabilityRecord', () => {
    expect(types).toContain('price');
  });

  it('port_name still exists (legacy)', () => {
    expect(types).toContain('port_name');
  });

  it('supply_type still exists', () => {
    expect(types).toContain('supply_type');
  });
});

// ============================================================================
// Security guardrails (unchanged)
// ============================================================================

describe('Security: no service_role, no auth.admin in frontend', () => {
  const files = allTsxFiles('');

  it('no service_role in any frontend file', () => {
    files.forEach(path => {
      expect(readFile(path)).not.toContain('service_role');
    });
  });

  it('no auth.admin in any frontend file', () => {
    files.forEach(path => {
      expect(readFile(path)).not.toMatch(/auth\.admin/);
    });
  });
});

// ============================================================================
// Warehouse retired from port workflow
// ============================================================================

describe('Warehouse retired from port workflow', () => {
  const instScreen = readSrc('features/institutions/InstitutionScreen.tsx');

  it('AddPortForm does not have warehouse dropdown', () => {
    // The AddPortForm function should not reference port_warehouse or whId
    const addFormStart = instScreen.indexOf('function AddPortForm');
    const addFormEnd = instScreen.indexOf('function PortCard');
    const addFormBody = instScreen.slice(addFormStart, addFormEnd);
    expect(addFormBody).not.toContain('port_warehouse');
    expect(addFormBody).not.toContain('whId');
  });

  it('PortSection does not require warehouses prop', () => {
    expect(instScreen).not.toContain('warehouses.length === 0');
    expect(instScreen).not.toContain("port_no_wh");
  });

  it('warehouse count not shown in org detail', () => {
    expect(instScreen).not.toContain('whCount');
    expect(instScreen).not.toContain("inst_warehouses");
  });

  it('getWarehouses not imported in InstitutionScreen', () => {
    expect(instScreen).not.toContain('getWarehouses');
  });

  it('createDistributionPoint does not require warehouseId', () => {
    const svc = readSrc('shared/supabase/services/warehouses.service.ts');
    // warehouseId should be optional in the input type
    expect(svc).toContain('warehouseId?:');
  });

  it('migration 021 exists and makes warehouse_id nullable', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    expect(sql).toContain('warehouse_id');
    expect(sql).toContain('drop not null');
    expect(sql).toContain('MANUAL APPLY ONLY');
  });

  it('migration 021 has no DROP TABLE', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    expect(sql).not.toMatch(/^\s*drop table/im);
  });

  it('migration 021 has no TRUNCATE', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    expect(sql).not.toMatch(/truncate/i);
  });
});

// ============================================================================
// Permission-based port gating (PORT-PERMISSION-GATE-CORRECTION-A)
// ============================================================================

describe('Port management uses permission-based gating, not role-based', () => {
  const instScreen = readSrc('features/institutions/InstitutionScreen.tsx');

  it('PortSection does not use role-based canMutate = isAdminRole', () => {
    expect(instScreen).not.toContain("isAdminRole(actorRole) || actorRole === 'warehouse_manager'");
  });

  it('PortSection receives canCreatePorts prop', () => {
    expect(instScreen).toContain('canCreatePorts');
  });

  it('PortSection receives canEditPorts prop', () => {
    expect(instScreen).toContain('canEditPorts');
  });

  it('PortSection receives canArchivePorts prop', () => {
    expect(instScreen).toContain('canArchivePorts');
  });

  it('PortCard does not receive actorRole prop', () => {
    const cardSig = instScreen.slice(instScreen.indexOf('function PortCard'), instScreen.indexOf('function PortCard') + 300);
    expect(cardSig).not.toContain('actorRole');
  });

  it('OrgDetailView derives permission flags from actorPermissions.has(ports.*)', () => {
    expect(instScreen).toContain("actorPermissions.has('ports.view')");
    expect(instScreen).toContain("actorPermissions.has('ports.create')");
    expect(instScreen).toContain("actorPermissions.has('ports.edit')");
    expect(instScreen).toContain("actorPermissions.has('ports.archive')");
  });

  it('InstitutionScreen loads myPermissions from useApp', () => {
    expect(instScreen).toContain('myPermissions');
    expect(instScreen).toContain('reloadMyPermissions');
  });

  it('permission-denied message keys exist in strings', () => {
    expect(strings).toContain('perm_no_view_ports');
    expect(strings).toContain('perm_no_create_ports');
    expect(strings).toContain('perm_no_manage_ports');
  });

  it('no-view-ports message shown when canViewPorts is false', () => {
    expect(instScreen).toContain('perm_no_view_ports');
  });

  it('permission keys ports.view/create/edit/archive exist in catalog', () => {
    const perms = readSrc('shared/lib/permissions.ts');
    expect(perms).toContain("'ports.view'");
    expect(perms).toContain("'ports.create'");
    expect(perms).toContain("'ports.edit'");
    expect(perms).toContain("'ports.archive'");
  });

  it('institution_admin defaults do NOT include ports.create', () => {
    const perms = readSrc('shared/lib/permissions.ts');
    const instAdminBlock = perms.slice(
      perms.indexOf('INSTITUTION_ADMIN_DEFAULTS'),
      perms.indexOf('];', perms.indexOf('INSTITUTION_ADMIN_DEFAULTS'))
    );
    expect(instAdminBlock).not.toContain("'ports.create'");
  });

  it('hospital_admin (legacy) defaults include ports.create', () => {
    const perms = readSrc('shared/lib/permissions.ts');
    const legacyBlock = perms.slice(
      perms.indexOf('LEGACY_ADMIN_DEFAULTS'),
      perms.indexOf('];', perms.indexOf('LEGACY_ADMIN_DEFAULTS'))
    );
    expect(legacyBlock).toContain("'ports.create'");
  });
});

describe('Safety: Data Reset absent, Intake disabled', () => {
  const files = allTsxFiles('');

  it('no DataReset import', () => {
    files.forEach(path => {
      expect(readFile(path)).not.toMatch(/import.*DataReset/i);
    });
  });

  it('no OcrImport, ExcelImport, DocIntel import', () => {
    files.forEach(path => {
      const content = readFile(path);
      expect(content).not.toMatch(/import.*OcrImport/i);
      expect(content).not.toMatch(/import.*ExcelImport/i);
      expect(content).not.toMatch(/import.*DocIntel/i);
    });
  });
});
