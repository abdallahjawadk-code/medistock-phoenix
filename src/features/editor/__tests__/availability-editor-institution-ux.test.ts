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

  it('createDistributionPoint insert payload uses point_type, not type', () => {
    const svc = readSrc('shared/supabase/services/warehouses.service.ts');
    const fnStart = svc.indexOf('export async function createDistributionPoint');
    const fnEnd = svc.indexOf('export async function updateDistributionPoint');
    const body = svc.slice(fnStart, fnEnd);
    expect(body).toContain('point_type:');
    expect(body).not.toMatch(/\btype:\s*input\.pointType/);
  });

  it('createDistributionPoint never sends pointType directly to Supabase', () => {
    const svc = readSrc('shared/supabase/services/warehouses.service.ts');
    const fnStart = svc.indexOf('export async function createDistributionPoint');
    const fnEnd = svc.indexOf('export async function updateDistributionPoint');
    const body = svc.slice(fnStart, fnEnd);
    // the row object built for insert() must not contain a raw "pointType" key
    expect(body).not.toMatch(/row\.pointType/);
    expect(body).not.toMatch(/pointType:\s*input\.pointType/);
  });

  it('createDistributionPoint insert payload includes organization_id, name, name_ar', () => {
    const svc = readSrc('shared/supabase/services/warehouses.service.ts');
    const fnStart = svc.indexOf('export async function createDistributionPoint');
    const fnEnd = svc.indexOf('export async function updateDistributionPoint');
    const body = svc.slice(fnStart, fnEnd);
    expect(body).toContain('organization_id: input.organizationId');
    expect(body).toContain('name:            input.name');
    expect(body).toContain('name_ar:         input.name_ar');
  });

  it('createDistributionPoint omits warehouse_id from row when not provided', () => {
    const svc = readSrc('shared/supabase/services/warehouses.service.ts');
    const fnStart = svc.indexOf('export async function createDistributionPoint');
    const fnEnd = svc.indexOf('export async function updateDistributionPoint');
    const body = svc.slice(fnStart, fnEnd);
    expect(body).toMatch(/if \(input\.warehouseId\) row\.warehouse_id = input\.warehouseId;/);
  });

  it('createDistributionPoint logs dev-only diagnostics on insert error without secrets', () => {
    const svc = readSrc('shared/supabase/services/warehouses.service.ts');
    const fnStart = svc.indexOf('export async function createDistributionPoint');
    const fnEnd = svc.indexOf('export async function updateDistributionPoint');
    const body = svc.slice(fnStart, fnEnd);
    expect(body).toContain('import.meta.env.DEV');
    expect(body).not.toMatch(/service_role/i);
    expect(body).not.toMatch(/auth\.admin/);
  });

  it('migration 021 exists and makes warehouse_id nullable', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    expect(sql).toContain('warehouse_id');
    expect(sql).toContain('DROP NOT NULL');
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

  it('migration 021 replaces role-based policies with permission-based policies', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    expect(sql).toContain('DROP POLICY IF EXISTS "dp_write_superadmin"');
    expect(sql).toContain('DROP POLICY IF EXISTS "dp_write_hospitaladmin"');
    expect(sql).toContain('DROP POLICY IF EXISTS "dp_write_wh_manager"');
    expect(sql).toContain('CREATE POLICY "dp_read_perm"');
    expect(sql).toContain('CREATE POLICY "dp_insert_perm"');
    expect(sql).toContain('CREATE POLICY "dp_update_perm"');
    // FOR ALL replaced with separate INSERT/UPDATE — no combined write policy
    expect(sql).not.toContain('CREATE POLICY "dp_write_perm"');
  });

  it('migration 021 does not create FOR ALL policy on distribution_points', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    // Strip comments, then check no CREATE POLICY ... FOR ALL remains
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/CREATE\s+POLICY\s+\S+\s+ON\s+distribution_points\s+FOR\s+ALL/i);
  });

  it('migration 021 does not create FOR DELETE policy on distribution_points', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/CREATE\s+POLICY\s+\S+\s+ON\s+distribution_points\s+FOR\s+DELETE/i);
  });

  it('migration 021 INSERT policy requires ports.create (not ports.edit)', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    const insertBlock = sql.slice(
      sql.indexOf('CREATE POLICY "dp_insert_perm"'),
      sql.indexOf('CREATE POLICY "dp_update_perm"'),
    );
    expect(insertBlock).toContain("phoenix_profile_has_permission(auth.uid(), 'ports.create')");
    expect(insertBlock).not.toContain("phoenix_profile_has_permission(auth.uid(), 'ports.edit')");
  });

  it('migration 021 UPDATE policy requires ports.edit', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    const updateBlock = sql.slice(
      sql.indexOf('CREATE POLICY "dp_update_perm"'),
      sql.indexOf('-- No DELETE policy'),
    );
    expect(updateBlock).toContain("phoenix_profile_has_permission(auth.uid(), 'ports.edit')");
  });

  it('migration 021 verification asserts no DELETE policy exists', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    expect(sql).toContain("cmd = 'DELETE'");
    expect(sql).toContain('unexpected DELETE policy found on distribution_points');
  });

  it('migration 021 dp_read_perm SELECT policy requires ports.view at top level (known asymmetry — fixed by 023)', () => {
    // This test documents the asymmetry that caused the super_admin INSERT RETURNING bug.
    // dp_read_perm in 021 puts phoenix_profile_has_permission OUTSIDE the super_admin bypass,
    // meaning super_admin also needs ports.view for RETURNING to return rows.
    // Migration 023 fixes this by restructuring dp_read_perm consistently with INSERT/UPDATE.
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    const readBlock = sql.slice(
      sql.indexOf('CREATE POLICY "dp_read_perm"'),
      sql.indexOf('CREATE POLICY "dp_insert_perm"'),
    );
    // Confirm the 021 pattern: permission check comes first, super_admin is nested inside AND
    expect(readBlock).toContain("phoenix_profile_has_permission(auth.uid(), 'ports.view')");
    expect(readBlock).toContain("phoenix_my_role() = 'super_admin'");
  });

  it('migration 023 exists and fixes dp_read_perm super_admin bypass', () => {
    const sql = readPhoenix('supabase/migrations/023_phoenix_live_profile_role_resolution_fix.sql');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('DROP POLICY IF EXISTS "dp_read_perm"');
    expect(sql).toContain('CREATE POLICY "dp_read_perm"');
  });

  it('migration 023 dp_read_perm puts super_admin bypass first (consistent with INSERT/UPDATE)', () => {
    const sql = readPhoenix('supabase/migrations/023_phoenix_live_profile_role_resolution_fix.sql');
    const readBlock = sql.slice(
      sql.indexOf('CREATE POLICY "dp_read_perm"'),
      sql.indexOf('-- ============================================================================\n-- VERIFY'),
    );
    // super_admin bypass must come before the permission check
    const superAdminPos = readBlock.indexOf("phoenix_my_role() = 'super_admin'");
    const permCheckPos  = readBlock.indexOf("phoenix_profile_has_permission");
    expect(superAdminPos).toBeGreaterThan(-1);
    expect(permCheckPos).toBeGreaterThan(-1);
    expect(superAdminPos).toBeLessThan(permCheckPos);
  });

  it('migration 023 dp_read_perm still requires ports.view for non-super users', () => {
    const sql = readPhoenix('supabase/migrations/023_phoenix_live_profile_role_resolution_fix.sql');
    const readBlock = sql.slice(
      sql.indexOf('CREATE POLICY "dp_read_perm"'),
      sql.indexOf('-- ============================================================================\n-- VERIFY'),
    );
    expect(readBlock).toContain("phoenix_profile_has_permission(auth.uid(), 'ports.view')");
    expect(readBlock).toContain('organization_id = phoenix_my_org()');
  });

  it('migration 023 does not touch dp_insert_perm or dp_update_perm', () => {
    const sql = readPhoenix('supabase/migrations/023_phoenix_live_profile_role_resolution_fix.sql');
    expect(sql).not.toContain('DROP POLICY IF EXISTS "dp_insert_perm"');
    expect(sql).not.toContain('DROP POLICY IF EXISTS "dp_update_perm"');
    expect(sql).not.toContain('CREATE POLICY "dp_insert_perm"');
    expect(sql).not.toContain('CREATE POLICY "dp_update_perm"');
  });

  it('migration 023 has no DELETE policy on distribution_points', () => {
    const sql = readPhoenix('supabase/migrations/023_phoenix_live_profile_role_resolution_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/CREATE\s+POLICY\s+\S+\s+ON\s+distribution_points\s+FOR\s+DELETE/i);
  });

  it('migration 023 has no DROP TABLE, no TRUNCATE, no destructive CASCADE', () => {
    const sql = readPhoenix('supabase/migrations/023_phoenix_live_profile_role_resolution_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/^\s*drop table/im);
    expect(noComments).not.toMatch(/truncate/i);
    expect(noComments).not.toMatch(/delete cascade/i);
  });

  it('migration 023 verification block asserts no DELETE policy on distribution_points', () => {
    const sql = readPhoenix('supabase/migrations/023_phoenix_live_profile_role_resolution_fix.sql');
    expect(sql).toContain("cmd = 'DELETE'");
  });

  it('institution_admin has ports.view but NOT ports.create by default (explicit grant required)', () => {
    const sql = readPhoenix('supabase/migrations/012_phoenix_institution_admin_role.sql');
    expect(sql).toContain("'institution_admin', 'ports.view',                    true");
    expect(sql).not.toContain("'institution_admin', 'ports.create'");
    expect(sql).not.toContain("'institution_admin', 'ports.edit'");
  });

  it('AddPortForm catch block shows port_create_error for DB/RLS failures, not perm_no_create_ports', () => {
    const instScreen = readSrc('features/institutions/InstitutionScreen.tsx');
    const addFormStart = instScreen.indexOf('function AddPortForm');
    const addFormEnd   = instScreen.indexOf('function PortCard');
    const catchStart   = instScreen.indexOf('} catch (e) {', addFormStart);
    const catchBlock   = instScreen.slice(catchStart, Math.min(catchStart + 600, addFormEnd));
    // catch block (after canCreate guard already passed) must not show perm_no_create_ports
    // it shows 021_pending for null violations, and port_create_error for everything else
    expect(catchBlock).toContain("t('port_create_error', lang)");
    expect(catchBlock).not.toContain("t('perm_no_create_ports', lang)");
  });

  // ── Migration 024 tests ──────────────────────────────────────────────────────

  it('migration 024 exists as a live-state repair migration', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
  });

  it('migration 024 drops all legacy and stale distribution_points policies', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    expect(sql).toContain('DROP POLICY IF EXISTS "dp_select_org"');
    expect(sql).toContain('DROP POLICY IF EXISTS "dp_write_superadmin"');
    expect(sql).toContain('DROP POLICY IF EXISTS "dp_write_hospitaladmin"');
    expect(sql).toContain('DROP POLICY IF EXISTS "dp_write_wh_manager"');
    expect(sql).toContain('DROP POLICY IF EXISTS "dp_write_perm"');
    expect(sql).toContain('DROP POLICY IF EXISTS "dp_read_perm"');
    expect(sql).toContain('DROP POLICY IF EXISTS "dp_insert_perm"');
    expect(sql).toContain('DROP POLICY IF EXISTS "dp_update_perm"');
  });

  it('migration 024 creates all 3 final permission-based policies', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    expect(sql).toContain('CREATE POLICY "dp_read_perm"');
    expect(sql).toContain('CREATE POLICY "dp_insert_perm"');
    expect(sql).toContain('CREATE POLICY "dp_update_perm"');
  });

  it('migration 024 dp_read_perm has super_admin bypass first (023 shape)', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    const readBlock = sql.slice(
      sql.indexOf('CREATE POLICY "dp_read_perm"'),
      sql.indexOf('CREATE POLICY "dp_insert_perm"'),
    );
    const superAdminPos = readBlock.indexOf("phoenix_my_role() = 'super_admin'");
    const permCheckPos  = readBlock.indexOf("phoenix_profile_has_permission");
    expect(superAdminPos).toBeGreaterThan(-1);
    expect(permCheckPos).toBeGreaterThan(-1);
    expect(superAdminPos).toBeLessThan(permCheckPos);
  });

  it('migration 024 dp_insert_perm uses ports.create', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    const block = sql.slice(
      sql.indexOf('CREATE POLICY "dp_insert_perm"'),
      sql.indexOf('CREATE POLICY "dp_update_perm"'),
    );
    expect(block).toContain("phoenix_profile_has_permission(auth.uid(), 'ports.create')");
    expect(block).toContain('organization_id = phoenix_my_org()');
  });

  it('migration 024 dp_update_perm uses ports.edit', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    const block = sql.slice(
      sql.indexOf('CREATE POLICY "dp_update_perm"'),
      sql.indexOf('-- No DELETE policy'),
    );
    expect(block).toContain("phoenix_profile_has_permission(auth.uid(), 'ports.edit')");
    expect(block).toContain('organization_id = phoenix_my_org()');
  });

  it('migration 024 creates no DELETE policy', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/CREATE\s+POLICY\s+\S+\s+ON\s+distribution_points\s+FOR\s+DELETE/i);
  });

  it('migration 024 creates no FOR ALL policy', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/CREATE\s+POLICY\s+\S+\s+ON\s+distribution_points\s+FOR\s+ALL/i);
  });

  it('migration 024 recreates archive trigger idempotently', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).toContain('DROP TRIGGER IF EXISTS trg_guard_dp_archive');
    expect(noComments).toContain('CREATE TRIGGER trg_guard_dp_archive');
    expect(noComments).toContain('phoenix_guard_dp_archive_update');
  });

  it('migration 024 recreates archive_entity with ports.archive and archive_bypass', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION archive_entity(");
    const fnEnd   = sql.indexOf('-- ============================================================================\n-- F. VERIFY');
    const body = sql.slice(fnStart, fnEnd);
    expect(body).toContain("ports.archive");
    expect(body).toContain("archive_bypass");
    expect(body).toContain("INSUFFICIENT_PERMISSION");
  });

  it('migration 024 VERIFY block asserts no DELETE policy and no FOR ALL policy', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    expect(sql).toContain("cmd = 'DELETE'");
    expect(sql).toContain("cmd = '*'");
  });

  it('migration 024 VERIFY block asserts trg_guard_dp_archive exists', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    expect(sql).toContain("tgname = 'trg_guard_dp_archive'");
    expect(sql).toContain('trg_guard_dp_archive trigger not found');
  });

  it('migration 024 VERIFY block asserts archive_entity has ports.archive and archive_bypass', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    expect(sql).toContain("v_fn_src LIKE '%ports.archive%'");
    expect(sql).toContain("v_fn_src LIKE '%archive_bypass%'");
  });

  it('migration 024 VERIFY block asserts warehouse_id is nullable', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    expect(sql).toContain("v_nullable = 'YES'");
    expect(sql).toContain("warehouse_id is still NOT NULL");
  });

  it('migration 024 has no DROP TABLE, no TRUNCATE, no destructive CASCADE', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/^\s*drop table/im);
    expect(noComments).not.toMatch(/truncate/i);
    expect(noComments).not.toMatch(/delete cascade/i);
  });

  it('migration 024 has no service_role references', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/service_role/i);
  });

  it('migration 021 verification asserts dp_write_perm no longer exists', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    expect(sql).toContain("policyname = 'dp_write_perm'");
    expect(sql).toContain('dp_write_perm (FOR ALL) still exists');
  });

  it('migration 021 uses phoenix_profile_has_permission for RLS', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    expect(sql).toContain("phoenix_profile_has_permission(auth.uid(), 'ports.view')");
    expect(sql).toContain("phoenix_profile_has_permission(auth.uid(), 'ports.create')");
    expect(sql).toContain("phoenix_profile_has_permission(auth.uid(), 'ports.edit')");
  });

  it('migration 021 enforces org scope in write policy', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    expect(sql).toContain('organization_id = phoenix_my_org()');
  });

  it('migration 021 does not add broad USING(true) for writes', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    const lines = sql.split('\n').filter(l => !l.trimStart().startsWith('--'));
    const writeBlock = lines.join('\n');
    expect(writeBlock).not.toMatch(/using\s*\(\s*true\s*\)/i);
  });

  it('migration 021 does not add duplicate permission keys', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    expect(sql).not.toContain('INSERT INTO permission_keys');
    expect(sql).not.toContain('insert into permission_keys');
  });

  it('migration 021 does not add anon/public write policies', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    expect(sql).not.toContain('to anon');
    expect(sql).not.toContain('to public');
  });

  it('migration 021 has verification block checking old policies gone and new ones exist', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    expect(sql).toContain('dp_read_perm');
    expect(sql).toContain('dp_insert_perm');
    expect(sql).toContain('dp_update_perm');
    expect(sql).toContain('ASSERT');
    expect(sql).toContain('old role-based policies still exist');
  });

  it('migration 021 replaces archive_entity to enforce ports.archive at DB level', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION archive_entity');
    expect(sql).toContain("phoenix_profile_has_permission(auth.uid(), 'ports.archive')");
    expect(sql).toContain("INSUFFICIENT_PERMISSION");
  });

  it('archive_entity keeps role check for non-port entities (warehouse/local_item)', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    expect(sql).toContain("INSUFFICIENT_ROLE");
    expect(sql).toContain("'super_admin', 'hospital_admin'");
  });

  it('archive_entity still enforces org scope for distribution_point', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    const fnBody = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION archive_entity'));
    expect(fnBody).toContain('organization_id = v_org_id');
  });

  it('archive_entity is SECURITY DEFINER', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    const fnBlock = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION archive_entity'));
    expect(fnBlock).toContain('SECURITY DEFINER');
  });

  it('migration 021 verification checks archive_entity exists', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    expect(sql).toContain("p.proname = 'archive_entity'");
  });

  it('archive_entity sets bypass flag before distribution_point UPDATE', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    const fnBody = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION archive_entity'));
    expect(fnBody).toContain("set_config('phoenix.archive_bypass', 'true', true)");
  });

  it('archive_entity clears bypass flag after distribution_point UPDATE', () => {
    const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');
    const fnBody = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION archive_entity'));
    expect(fnBody).toContain("set_config('phoenix.archive_bypass', '', true)");
  });
});

// ============================================================================
// Direct archive UPDATE trigger guard
// ============================================================================

describe('Direct archive UPDATE trigger guard on distribution_points', () => {
  const sql = readPhoenix('supabase/migrations/021_phoenix_ports_permissions_warehouse_retirement.sql');

  it('trigger function phoenix_guard_dp_archive_update exists', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION phoenix_guard_dp_archive_update');
  });

  it('trigger fires BEFORE UPDATE on distribution_points', () => {
    expect(sql).toContain('BEFORE UPDATE ON public.distribution_points');
    expect(sql).toContain('trg_guard_dp_archive');
  });

  it('trigger checks ports.archive for archive-related changes', () => {
    expect(sql).toContain("phoenix_profile_has_permission(auth.uid(), 'ports.archive')");
    expect(sql).toContain('PORT_ARCHIVE_PERMISSION_REQUIRED');
  });

  it('trigger detects status change to archived', () => {
    expect(sql).toContain("NEW.status = 'archived'");
    expect(sql).toContain('NEW.archived_at IS DISTINCT FROM OLD.archived_at');
  });

  it('trigger blocks cross-institution org_id tampering', () => {
    expect(sql).toContain('NEW.organization_id IS DISTINCT FROM OLD.organization_id');
    expect(sql).toContain('CROSS_INSTITUTION_UPDATE_BLOCKED');
  });

  it('trigger respects archive_bypass session flag from archive_entity', () => {
    expect(sql).toContain("current_setting('phoenix.archive_bypass', true)");
  });

  it('trigger is SECURITY DEFINER', () => {
    const fnBlock = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION phoenix_guard_dp_archive_update'));
    expect(fnBlock).toContain('SECURITY DEFINER');
  });

  it('trigger is idempotent (DROP TRIGGER IF EXISTS before CREATE)', () => {
    expect(sql).toContain('DROP TRIGGER IF EXISTS trg_guard_dp_archive');
  });

  it('migration 021 verification checks trigger exists', () => {
    expect(sql).toContain("t.tgname = 'trg_guard_dp_archive'");
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

  // ── AddPortForm simplification ──────────────────────────────────────────────
  it('AddPortForm has a single visible name field (port_name), not English+Arabic pair', () => {
    const addFormStart = instScreen.indexOf('function AddPortForm');
    const addFormEnd   = instScreen.indexOf('function PortCard');
    const addFormBody  = instScreen.slice(addFormStart, addFormEnd);
    expect(addFormBody).toContain("port_name");
    expect(addFormBody).not.toContain("port_name_en");
    expect(addFormBody).not.toContain("port_name_ar");
  });

  it('AddPortForm has no port type dropdown', () => {
    const addFormStart = instScreen.indexOf('function AddPortForm');
    const addFormEnd   = instScreen.indexOf('function PortCard');
    const addFormBody  = instScreen.slice(addFormStart, addFormEnd);
    expect(addFormBody).not.toContain("port_type");
    expect(addFormBody).not.toContain("ptType");
    expect(addFormBody).not.toContain("setPtType");
  });

  it('AddPortForm defaults pointType to dispensing internally', () => {
    const addFormStart = instScreen.indexOf('function AddPortForm');
    const addFormEnd   = instScreen.indexOf('function PortCard');
    const addFormBody  = instScreen.slice(addFormStart, addFormEnd);
    expect(addFormBody).toContain("dispensing");
  });

  it('AddPortForm receives canCreate prop and guards submission', () => {
    const addFormStart = instScreen.indexOf('function AddPortForm');
    const addFormEnd   = instScreen.indexOf('function PortCard');
    const addFormBody  = instScreen.slice(addFormStart, addFormEnd);
    expect(addFormBody).toContain('canCreate');
  });

  it('port_create_error and port_create_021_pending strings exist', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    expect(strings).toContain('port_create_error');
    expect(strings).toContain('port_create_021_pending');
  });

  // ── QR permission gating ────────────────────────────────────────────────────
  it('OrgDetailView derives canGenerateQr from actorPermissions.has(qr.generate)', () => {
    expect(instScreen).toContain("actorPermissions.has('qr.generate')");
  });

  it('OrgDetailView derives canRevokeQr from actorPermissions.has(qr.revoke)', () => {
    expect(instScreen).toContain("actorPermissions.has('qr.revoke')");
  });

  it('PortSection receives canGenerateQr and canRevokeQr props', () => {
    expect(instScreen).toContain('canGenerateQr');
    expect(instScreen).toContain('canRevokeQr');
  });

  it('PortCard QR generate button gated by canGenerateQr, not canEditPorts', () => {
    const cardStart = instScreen.indexOf('function PortCard');
    const cardBody  = instScreen.slice(cardStart, cardStart + 4000);
    expect(cardBody).toContain('canGenerateQr');
    // generate/revoke buttons should NOT use canEditPorts as their sole QR gate
    expect(cardBody).not.toMatch(/canEditPorts\s*&&[^(]+qr_generate/);
  });

  it('PortCard regenerate QR button gated by both canGenerateQr AND canRevokeQr', () => {
    // regenerateQrForPoint = disableQrToken (needs qr.revoke) + createQrForTarget (needs qr.generate)
    // so regenerate must require both permissions to avoid a runtime error when revoke is missing
    const cardStart = instScreen.indexOf('function PortCard');
    const cardBody  = instScreen.slice(cardStart, cardStart + 8000);
    expect(cardBody).toMatch(/canGenerateQr\s*&&\s*canRevokeQr/);
  });

  it('PortCard QR revoke button gated by canRevokeQr', () => {
    const cardStart = instScreen.indexOf('function PortCard');
    const cardBody  = instScreen.slice(cardStart, cardStart + 4000);
    expect(cardBody).toContain('canRevokeQr');
  });

  it('perm_no_qr_generate and qr_create_error strings exist', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    expect(strings).toContain('perm_no_qr_generate');
    expect(strings).toContain('qr_create_error');
  });

  it('qr.service createQrForTarget throws when data.ok is false', () => {
    const svc = readSrc('shared/supabase/services/qr.service.ts');
    expect(svc).toContain('result.ok');
    expect(svc).toContain('QR_CREATION_FAILED');
  });

  it('qr.service disableQrToken throws when data.ok is false and not already_disabled', () => {
    const svc = readSrc('shared/supabase/services/qr.service.ts');
    expect(svc).toContain('already_disabled');
    expect(svc).toContain('QR_REVOKE_FAILED');
  });

  // ── Migration 022 ───────────────────────────────────────────────────────────
  it('migration 022 exists', () => {
    const sql = readPhoenix('supabase/migrations/022_phoenix_qr_permission_fix.sql');
    expect(sql.length).toBeGreaterThan(100);
  });

  it('migration 022 replaces role-gate in create_qr_for_target with qr.generate permission', () => {
    const sql = readPhoenix('supabase/migrations/022_phoenix_qr_permission_fix.sql');
    expect(sql).toContain("qr.generate");
    expect(sql).toContain('create_qr_for_target');
  });

  it('migration 022 replaces role-gate in disable_qr_token with qr.revoke permission', () => {
    const sql = readPhoenix('supabase/migrations/022_phoenix_qr_permission_fix.sql');
    expect(sql).toContain("qr.revoke");
    expect(sql).toContain('disable_qr_token');
  });

  it('migration 022 does not hardcode hospital_admin in the primary QR permission gate', () => {
    const sql = readPhoenix('supabase/migrations/022_phoenix_qr_permission_fix.sql');
    // The old role-list check ('hospital_admin', 'warehouse_manager') must not be
    // the primary gate — it may appear in comments but not as the IF condition
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/IF\s+v_role\s+NOT?\s+IN\s*\([^)]*hospital_admin/i);
  });

  it('migration 022 has verification block', () => {
    const sql = readPhoenix('supabase/migrations/022_phoenix_qr_permission_fix.sql');
    expect(sql).toContain('VERIFY');
    expect(sql).toContain('ASSERT');
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
