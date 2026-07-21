/**
 * Availability Editor & Status Editor Tests
 * Run: npm test -- --run
 *
 * Static source-code tests verifying the UX changes without a DB connection.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import {
  findUnreviewedMigrationFiles,
  reviewedMigrationFilesAbove,
} from '../../../../supabase/migrations/__tests__/helpers/reviewed-migrations';
import { actualMigrationFilesAbove } from '../../../../supabase/migrations/__tests__/helpers/migration-dir';
import {
  readSourceFile,
  statementAt,
  signatureAt,
} from '../../../shared/__tests__/helpers/source-extract';

import {
  expectRetiredSurfaceAbsent,
  expectScreenThreeIsInventoryCenter,
  expectQuickAvailFormAbsent,
} from '../../../../tests/helpers/retired-surfaces';

const SRC     = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');

function readSrc(rel: string) {
  return readSourceFile(join(SRC, rel));
}

function readPhoenix(rel: string) {
  return readSourceFile(join(PHOENIX, rel));
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
  return readSourceFile(path);
}

const strings = readSrc('shared/i18n/strings.ts');
const types   = readSrc('shared/lib/types.ts');
const service = readSrc('shared/supabase/services/availability.service.ts');

// ============================================================================
// Free-text port_name removed from editor
// ============================================================================

// ============================================================================
// E6 — the EditorScreen form UI these tests described is RETIRED.
//
// 50 assertions in this file described EditorScreen's manual availability
// FORM: its port dropdown replacing free-text port_name, its material identity
// fields, the independent national-code field, and the similar-material
// comparison/blocking panel. That screen is deleted, so those assertions have
// no subject and were removed rather than left reading a missing file.
//
// They are replaced by the absence contract below. Everything else in this
// file — StatusEditorScreen, the availability service, migration 050, the
// port-card QR UX and the i18n strings — is untouched and still asserted.
// ============================================================================

describe('E6: the manual availability editor form is retired', () => {
  it('EditorScreen is deleted, unimported and unrendered', () => {
    expectRetiredSurfaceAbsent('EditorScreen');
  });

  it('screen 3 routes to the Inventory Center that replaced it', () => {
    expectScreenThreeIsInventoryCenter();
  });

  it('the QuickAvailForm quick-add form is retired too', () => {
    expectQuickAvailFormAbsent();
  });

  it('no surviving surface reintroduces the retired form fields', () => {
    const inventory = readSrc('features/inventory/InventoryCenterScreen.tsx');
    expect(inventory).not.toContain('ed-national-code');
    expect(inventory).not.toContain('ed-point');
    expect(inventory).not.toContain('upsertAvailability');
  });
});

describe('Port is selected via dropdown', () => {




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


});

// ============================================================================
// New material identity fields in editor
// ============================================================================

describe('National code duplicate/conflict safety guard (folded into the generalized similar-match guard)', () => {






  it('bilingual avail_national_code_conflict key still exists (superseded by the generalized message, kept for compatibility)', () => {
    expect(strings).toContain('avail_national_code_conflict');
    expect(strings).toContain('توجد مادة مطابقة حالياً برمز وطني مختلف');
    expect(strings).toContain('A matching material already exists with a different national code');
  });
});

// ============================================================================
// AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-A: generalized similar-material
// comparison panel + blocking guard, covering national_code, batch_number,
// expiry_date, supply_type, and price — the current DB matching key
// (distribution_point_id + scientific_name + concentration + dosage_form)
// includes none of these, so a matched row's values in any of them could
// otherwise be silently overwritten.
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

  it('surplus and near_expiry have DISTINCT labels (no longer merged)', () => {
    const surplusLine = strings.split('\n').find(l => l.includes('cond_surplus:'));
    const nearLine = strings.split('\n').find(l => l.includes('cond_near_expiry:'));
    // Regression guards: the old merged wording must be gone in both languages.
    expect(surplusLine).not.toContain('الفائضة - قريبة النفاذ');
    expect(nearLine).not.toContain('الفائضة - قريبة النفاذ');
    expect(surplusLine).not.toContain('Surplus - Near expiry');
    expect(nearLine).not.toContain('Surplus - Near expiry');
    // The two condition labels are not identical.
    expect(surplusLine).not.toEqual(nearLine);
  });
});

// ============================================================================
// FIX-CONDITION-OPTIONS-NEAR-EXPIRY-A: surplus / near_expiry separated
// ============================================================================

describe('FIX-CONDITION-OPTIONS-NEAR-EXPIRY-A / STATUS-EDITOR-CLEANUP-A: condition options', () => {
  // E6: the assertions reading EditorScreen's module-private CONDITION_OPTIONS
  // retired with the screen (see the retirement describe at the top of this
  // file). The i18n and StatusEditorScreen expectations below are unaffected
  // and still assert that near_expiry remains a real, distinct condition.











  it('(B4) Arabic cond_surplus and cond_near_expiry are distinct', () => {
    const surplus = strings.match(/cond_surplus:\s*\{\s*ar:\s*'([^']*)'/);
    const near = strings.match(/cond_near_expiry:\s*\{\s*ar:\s*'([^']*)'/);
    expect(surplus?.[1]).toBeTruthy();
    expect(near?.[1]).toBeTruthy();
    expect(surplus![1]).not.toEqual(near![1]);
  });

  it('(B5) English cond_surplus and cond_near_expiry are distinct', () => {
    const surplus = strings.match(/cond_surplus:[^}]*en:\s*'([^']*)'/);
    const near = strings.match(/cond_near_expiry:[^}]*en:\s*'([^']*)'/);
    expect(surplus?.[1]).toBeTruthy();
    expect(near?.[1]).toBeTruthy();
    expect(surplus![1]).not.toEqual(near![1]);
  });

  it('(B6) cond_near_expiry exists with both Arabic and English', () => {
    expect(strings).toMatch(/cond_near_expiry:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/);
  });

  it('(B7) cond_expired remains present in both Arabic and English', () => {
    expect(strings).toMatch(/cond_expired:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/);
  });



  it('(D10) no test/source expects the merged "Surplus - Near expiry" label', () => {
    expect(strings).not.toContain('Surplus - Near expiry');
  });

  it('(D11) no source expects the merged Arabic "الفائضة - قريبة النفاذ" label', () => {
    expect(strings).not.toContain('الفائضة - قريبة النفاذ');
  });
});

// ============================================================================
// Supply type field
// ============================================================================

describe('Supply type field exists', () => {


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

  it('upsert calls phoenix_upsert_availability RPC (migration 030)', () => {
    expect(service).toContain("rpc('phoenix_upsert_availability'");
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

  it('availability conditions include the onboarding-safe unknown state', () => {
    expect(types).toContain("| 'unknown'");
  });

  it('availability conditions include not_stocked without misreporting it as missing', () => {
    expect(types).toContain("| 'not_stocked'");
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
// Operational warehouse pairing in outlet workflow
// ============================================================================

describe('Operational warehouse pairing in outlet workflow', () => {
  const instScreen = readSrc('features/institutions/InstitutionScreen.tsx');

  it('AddPortForm requires a warehouse selected from the RLS-scoped catalog', () => {
    const addFormStart = instScreen.indexOf('function AddPortForm');
    const addFormEnd = instScreen.indexOf('function PortCard');
    const addFormBody = instScreen.slice(addFormStart, addFormEnd);
    expect(addFormBody).toContain("t('port_warehouse', lang)");
    expect(addFormBody).toContain('value={warehouseId}');
    expect(addFormBody).toContain('warehouses.map(w =>');
    expect(addFormBody).not.toMatch(/placeholder=.*warehouseId/i);
  });

  it('AddPortForm fails closed when no eligible institution warehouse exists', () => {
    expect(instScreen).toContain('warehouses.length === 0');
    expect(instScreen).toContain("t('port_no_wh', lang)");
  });

  it('warehouse count not shown in org detail', () => {
    expect(instScreen).not.toContain('whCount');
    expect(instScreen).not.toContain("inst_warehouses");
  });

  it('loads only active institution warehouses for outlet pairing', () => {
    expect(instScreen).toContain('getWarehouses(orgId)');
    expect(instScreen).toContain("w.warehouseKind === 'institution'");
    expect(instScreen).toContain("w.status === 'active'");
  });

  it('createDistributionPoint requires warehouseId and rejects an empty pairing', () => {
    const svc = readSrc('shared/supabase/services/warehouses.service.ts');
    const fnStart = svc.indexOf('export async function createDistributionPoint');
    const fnEnd = svc.indexOf('export async function updateDistributionPoint');
    const body = svc.slice(fnStart, fnEnd);
    expect(body).toContain('warehouseId: string;');
    expect(body).toContain("if (!input.warehouseId) throw new Error('WAREHOUSE_REQUIRED')");
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

  it('createDistributionPoint always pins warehouse_id in the insert payload', () => {
    const svc = readSrc('shared/supabase/services/warehouses.service.ts');
    const fnStart = svc.indexOf('export async function createDistributionPoint');
    const fnEnd = svc.indexOf('export async function updateDistributionPoint');
    const body = svc.slice(fnStart, fnEnd);
    expect(body).toContain('warehouse_id:   input.warehouseId');
    expect(body).not.toMatch(/if \(input\.warehouseId\) row\.warehouse_id/);
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
    // pg_policies.cmd for FOR ALL is 'ALL', not '*' — '*' is the pg_policy.polcmd char
    expect(sql).toContain("cmd = 'ALL'");
    expect(sql).not.toContain("cmd = '*'");
  });

  it('migration 024 VERIFY block checks total policy count is exactly 3 (no unknown extras)', () => {
    const sql = readPhoenix('supabase/migrations/024_phoenix_distribution_points_rls_state_repair.sql');
    expect(sql).toContain('expected exactly 3 total policies on distribution_points');
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

  // ── Migration 025 tests ──────────────────────────────────────────────────────

  it('migration 025 exists as a table-level grants fix migration', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
  });

  it('migration 025 grants SELECT, INSERT, UPDATE to authenticated', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).toMatch(/GRANT\s+SELECT\s*,\s*INSERT\s*,\s*UPDATE\s+ON\s+TABLE\s+public\.distribution_points\s+TO\s+authenticated/i);
  });

  it('migration 025 does NOT grant DELETE to authenticated', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/GRANT\s+.*DELETE.*ON\s+TABLE\s+public\.distribution_points\s+TO\s+authenticated/i);
  });

  it('migration 025 revokes DELETE from authenticated', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).toMatch(/REVOKE\s+DELETE\s+ON\s+TABLE\s+public\.distribution_points\s+FROM\s+authenticated/i);
  });

  it('migration 025 revokes INSERT, UPDATE, DELETE from anon', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).toMatch(/REVOKE\s+INSERT\s*,\s*UPDATE\s*,\s*DELETE\s+ON\s+TABLE\s+public\.distribution_points\s+FROM\s+anon/i);
  });

  it('migration 025 does NOT grant any privilege to anon', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/GRANT\s+.*ON\s+TABLE\s+public\.distribution_points\s+TO\s+anon/i);
  });

  it('migration 025 does NOT grant to service_role', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/GRANT\s+.*ON\s+TABLE\s+public\.distribution_points\s+TO\s+service_role/i);
  });

  it('migration 025 VERIFY block asserts authenticated has SELECT', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    expect(sql).toContain("grantee = 'authenticated'");
    expect(sql).toContain("privilege_type = 'SELECT'");
    expect(sql).toContain('authenticated does not have SELECT on distribution_points');
  });

  it('migration 025 VERIFY block asserts authenticated has INSERT', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    expect(sql).toContain("privilege_type = 'INSERT'");
    expect(sql).toContain('authenticated does not have INSERT on distribution_points');
  });

  it('migration 025 VERIFY block asserts authenticated has UPDATE', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    expect(sql).toContain("privilege_type = 'UPDATE'");
    expect(sql).toContain('authenticated does not have UPDATE on distribution_points');
  });

  it('migration 025 VERIFY block asserts authenticated does NOT have DELETE', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    expect(sql).toContain('authenticated has DELETE on distribution_points');
  });

  it('migration 025 VERIFY block asserts anon has no INSERT/UPDATE/DELETE', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    expect(sql).toContain("grantee = 'anon'");
    expect(sql).toContain('anon has INSERT on distribution_points');
    expect(sql).toContain('anon has UPDATE on distribution_points');
    expect(sql).toContain('anon has DELETE on distribution_points');
  });

  it('migration 025 VERIFY block asserts exactly 3 RLS policies still exist', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    expect(sql).toContain('expected exactly 3 total policies on distribution_points');
  });

  it('migration 025 VERIFY block asserts no DELETE policy', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    expect(sql).toContain("cmd = 'DELETE'");
    expect(sql).toContain('unexpected DELETE policy found on distribution_points');
  });

  it('migration 025 VERIFY block asserts no FOR ALL policy', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    expect(sql).toContain("cmd = 'ALL'");
    expect(sql).not.toContain("cmd = '*'");
    expect(sql).toContain('unexpected FOR ALL policy found on distribution_points');
  });

  it('migration 025 VERIFY block asserts trg_guard_dp_archive still exists', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    expect(sql).toContain("tgname = 'trg_guard_dp_archive'");
    expect(sql).toContain('trg_guard_dp_archive trigger not found on distribution_points');
  });

  it('migration 025 uses information_schema.role_table_grants for VERIFY assertions', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    expect(sql).toContain('information_schema.role_table_grants');
  });

  it('migration 025 has no DROP TABLE, no TRUNCATE, no destructive CASCADE', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/^\s*drop table/im);
    expect(noComments).not.toMatch(/truncate/i);
    expect(noComments).not.toMatch(/delete cascade/i);
  });

  it('migration 025 has no RLS policy creation or modification', () => {
    const sql = readPhoenix('supabase/migrations/025_phoenix_distribution_points_grants_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/CREATE\s+POLICY/i);
    expect(noComments).not.toMatch(/DROP\s+POLICY/i);
    expect(noComments).not.toMatch(/ALTER\s+POLICY/i);
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
    const cardSig = signatureAt(instScreen, 'function PortCard');
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

  it('AddPortForm exposes only the three approved operational outlet types', () => {
    const addFormStart = instScreen.indexOf('function AddPortForm');
    const addFormEnd   = instScreen.indexOf('function PortCard');
    const addFormBody  = instScreen.slice(addFormStart, addFormEnd);
    expect(addFormBody).toContain("t('port_type', lang)");
    expect(addFormBody).toContain('APPROVED_POINT_TYPES.map(type =>');
    expect(instScreen).toContain("value: 'pharmacy'");
    expect(instScreen).toContain("value: 'crash_cabinet'");
    expect(instScreen).toContain("value: 'rescue_cart'");
  });

  it('AddPortForm defaults to pharmacy and never creates a legacy dispensing outlet', () => {
    const addFormStart = instScreen.indexOf('function AddPortForm');
    const addFormEnd   = instScreen.indexOf('function PortCard');
    const addFormBody  = instScreen.slice(addFormStart, addFormEnd);
    expect(addFormBody).toContain("useState<ApprovedPointType>('pharmacy')");
    expect(addFormBody).not.toContain("'dispensing'");
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
    const cardBody  = instScreen.slice(cardStart, instScreen.indexOf('function QrPreviewModal', cardStart));
    expect(cardBody).toContain('canGenerateQr');
    // generate/revoke buttons should NOT use canEditPorts as their sole QR gate
    expect(cardBody).not.toMatch(/canEditPorts\s*&&[^(]+qr_generate/);
  });

  it('PortCard regenerate QR button gated by both canGenerateQr AND canRevokeQr', () => {
    // regenerateQrForPoint = disableQrToken (needs qr.revoke) + createQrForTarget (needs qr.generate)
    // so regenerate must require both permissions to avoid a runtime error when revoke is missing
    const cardStart = instScreen.indexOf('function PortCard');
    const cardBody  = instScreen.slice(cardStart, instScreen.indexOf('function QrPreviewModal', cardStart));
    expect(cardBody).toMatch(/canGenerateQr\s*&&\s*canRevokeQr/);
  });

  it('PortCard QR revoke button gated by canRevokeQr', () => {
    const cardStart = instScreen.indexOf('function PortCard');
    const cardBody  = instScreen.slice(cardStart, instScreen.indexOf('function QrPreviewModal', cardStart));
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

  // ── Migration 026 tests ──────────────────────────────────────────────────────

  it('migration 026 exists as a QR random bytes fix migration', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
  });

  it('migration 026 fixes unqualified gen_random_bytes by using extensions schema', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).toContain('extensions.gen_random_bytes(32)');
    expect(noComments).toContain('extensions.gen_random_bytes(12)');
  });

  it('migration 026 fixes unqualified digest by using extensions schema', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).toContain("extensions.digest(v_plain_token, 'sha256')");
  });

  it('migration 026 does not use unqualified gen_random_bytes in executable SQL', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    // No unqualified gen_random_bytes call should remain (must have schema prefix)
    expect(noComments).not.toMatch(/[^.]gen_random_bytes\(/);
  });

  it('migration 026 preserves qr.generate permission check', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    expect(sql).toContain("qr.generate");
    expect(sql).toContain('create_qr_for_target');
  });

  it('migration 026 preserves phoenix_profile_has_permission in create_qr_for_target', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION create_qr_for_target');
    // function body ends before the schema-qualified REVOKE statement
    const fnEnd   = sql.indexOf('REVOKE ALL ON FUNCTION public.create_qr_for_target');
    const body = sql.slice(fnStart, fnEnd);
    expect(body).toContain('phoenix_profile_has_permission');
  });

  it('migration 026 preserves SECURITY DEFINER in create_qr_for_target', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION create_qr_for_target');
    const fnEnd   = sql.indexOf('REVOKE ALL ON FUNCTION public.create_qr_for_target');
    const body = sql.slice(fnStart, fnEnd);
    expect(body).toContain('SECURITY DEFINER');
  });

  it('migration 026 preserves org guard TARGET_NOT_FOUND_OR_FORBIDDEN', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION create_qr_for_target');
    const fnEnd   = sql.indexOf('REVOKE ALL ON FUNCTION public.create_qr_for_target');
    const body = sql.slice(fnStart, fnEnd);
    expect(body).toContain('TARGET_NOT_FOUND_OR_FORBIDDEN');
  });

  it('migration 026 revokes EXECUTE from PUBLIC for create_qr_for_target', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.create_qr_for_target.*FROM\s+PUBLIC/i);
  });

  it('migration 026 grants EXECUTE to authenticated and revokes from PUBLIC and anon for create_qr_for_target', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.create_qr_for_target.*TO\s+authenticated/i);
    expect(noComments).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.create_qr_for_target.*FROM\s+anon/i);
  });

  it('migration 026 does not grant EXECUTE to anon for create_qr_for_target', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.create_qr_for_target.*TO\s+anon/i);
  });

  it('migration 026 revokes EXECUTE from PUBLIC for disable_qr_token', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.disable_qr_token.*FROM\s+PUBLIC/i);
  });

  it('migration 026 revokes EXECUTE from anon for disable_qr_token', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.disable_qr_token.*FROM\s+anon/i);
  });

  it('migration 026 grants EXECUTE to authenticated for disable_qr_token', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.disable_qr_token.*TO\s+authenticated/i);
  });

  it('migration 026 does not grant EXECUTE to anon for disable_qr_token', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.disable_qr_token.*TO\s+anon/i);
  });

  it('migration 026 VERIFY block asserts create_qr_for_target is SECURITY DEFINER', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    expect(sql).toContain('prosecdef');
    expect(sql).toContain('create_qr_for_target is not SECURITY DEFINER');
  });

  it('migration 026 VERIFY block asserts extensions.gen_random_bytes and digest are in function body', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    expect(sql).toContain('extensions.gen_random_bytes — 42883 fix not applied');
    expect(sql).toContain('extensions.digest — 42883 fix not applied');
  });

  it('migration 026 VERIFY block asserts authenticated can EXECUTE and anon cannot for create_qr_for_target', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    expect(sql).toContain("has_function_privilege('authenticated'");
    expect(sql).toContain("has_function_privilege('anon'");
    expect(sql).toContain('authenticated cannot EXECUTE create_qr_for_target');
    expect(sql).toContain('anon can EXECUTE create_qr_for_target — REVOKE FROM PUBLIC may not have applied');
  });

  it('migration 026 VERIFY block checks PUBLIC cannot EXECUTE create_qr_for_target via proacl', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    // PostgreSQL ACL grantee OID 0 = pseudo-role PUBLIC
    expect(sql).toContain('grantee = 0 AND privilege_type');
    expect(sql).toContain('proacl IS NOT NULL FROM pg_proc WHERE oid = v_fn_oid');
    expect(sql).toContain('PUBLIC (grantee OID 0) still has EXECUTE on create_qr_for_target');
  });

  it('migration 026 VERIFY block checks disable_qr_token still has qr.revoke', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    expect(sql).toContain('disable_qr_token');
    expect(sql).toContain('qr.revoke');
    expect(sql).toContain('disable_qr_token does not reference qr.revoke');
  });

  it('migration 026 VERIFY block checks authenticated and anon EXECUTE for disable_qr_token', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    expect(sql).toContain('authenticated cannot EXECUTE disable_qr_token');
    expect(sql).toContain('anon can EXECUTE disable_qr_token');
    expect(sql).toContain('PUBLIC (grantee OID 0) still has EXECUTE on disable_qr_token');
  });

  it('migration 026 create_qr_for_target function body has no service_role reference', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    // Check the function body only — VERIFY block legitimately references service_role
    // for detection; the function itself must not expose it.
    const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION create_qr_for_target');
    const fnEnd   = sql.indexOf('$$;', fnStart) + 3;
    const fnBody  = sql.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/service_role/i);
  });

  it('migration 026 has no DROP TABLE, no TRUNCATE, no destructive CASCADE', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/^\s*drop table/im);
    expect(noComments).not.toMatch(/truncate/i);
    expect(noComments).not.toMatch(/delete cascade/i);
  });

  it('migration 026 does not replace disable_qr_token function body', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    // 026 manages disable_qr_token grants only; the function body is not replaced
    expect(noComments).not.toContain('CREATE OR REPLACE FUNCTION disable_qr_token');
  });

  it('migration 026 does not add anon write grants on QR tables', () => {
    const sql = readPhoenix('supabase/migrations/026_phoenix_qr_random_bytes_fix.sql');
    const noComments = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE).*ON\s+(TABLE\s+)?.*qr_/i);
  });
});

// ============================================================================
// FIX-AVAILABILITY-UPSERT-UNIQUE-A (migration 029) — updated for RPC path
// ============================================================================

describe('FIX-AVAILABILITY-UPSERT-UNIQUE-A: upsertAvailability normalization (preserved in RPC)', () => {
  it('scientific_name is trimmed before RPC call', () => {
    const upsertFn = service.slice(service.indexOf('async function upsertAvailability'));
    expect(upsertFn).toContain('input.scientificName.trim()');
  });

  it('p_concentration sent as empty string when absent (not null)', () => {
    const upsertFn = service.slice(service.indexOf('async function upsertAvailability'));
    expect(upsertFn).toContain("p_concentration:");
    expect(upsertFn).toContain("input.concentrationValue ?? ''");
    expect(upsertFn).not.toContain("input.concentrationValue ?? null");
  });

  it('p_dosage_form sent as empty string when absent (not null)', () => {
    const upsertFn = service.slice(service.indexOf('async function upsertAvailability'));
    expect(upsertFn).toContain("p_dosage_form:");
    expect(upsertFn).toContain("input.dosageForm ?? ''");
    expect(upsertFn).not.toContain("input.dosageForm ?? null");
  });

  it('PostgREST onConflict is gone — no longer needed with RPC', () => {
    expect(service).not.toContain("onConflict:");
  });

  it('old 2-column onConflict key is not present', () => {
    expect(service).not.toContain(
      "onConflict: 'distribution_point_id,scientific_name'"
    );
  });

  it('comment documents COALESCE and 42P10 motivation', () => {
    expect(service).toContain('COALESCE');
    expect(service).toContain('42P10');
  });
});

// ============================================================================
// FIX-AVAILABILITY-RPC-A (migration 030)
// ============================================================================

describe('FIX-AVAILABILITY-RPC-A: upsertAvailability uses RPC not PostgREST .upsert()', () => {
  it('(a) RPC name is exactly phoenix_upsert_availability', () => {
    expect(service).toContain("rpc('phoenix_upsert_availability'");
  });

  it('(b) p_concentration param is empty string when absent', () => {
    const upsertFn = service.slice(service.indexOf('async function upsertAvailability'));
    expect(upsertFn).toContain("p_concentration:");
    expect(upsertFn).toContain("input.concentrationValue ?? ''");
  });

  it('(b) p_dosage_form param is empty string when absent', () => {
    const upsertFn = service.slice(service.indexOf('async function upsertAvailability'));
    expect(upsertFn).toContain("p_dosage_form:");
    expect(upsertFn).toContain("input.dosageForm ?? ''");
  });

  it('(c) scientific_name guard throws before RPC is called', () => {
    const upsertFn = service.slice(service.indexOf('async function upsertAvailability'));
    expect(upsertFn).toContain("input.scientificName?.trim()");
    expect(upsertFn).toContain('upsertAvailability requires scientificName');
  });

  it('(d) old PostgREST .upsert() is not present in upsert function', () => {
    // Scope to upsertAvailability body only (slice stops at next export)
    const start = service.indexOf('async function upsertAvailability');
    const end   = service.indexOf('export async function getLowStockItems');
    const upsertFn = service.slice(start, end);
    expect(upsertFn).not.toContain(".upsert(");
    expect(upsertFn).not.toContain("onConflict:");
    expect(upsertFn).not.toContain(".from('item_availability')");
  });

  it('organization_id not sent from client — derived server-side in RPC', () => {
    const upsertFn = service.slice(service.indexOf('async function upsertAvailability'));
    expect(upsertFn).not.toContain("p_organization_id:");
    expect(upsertFn).not.toContain("organization_id:       input.organizationId");
  });

  it('all 12 RPC params are present in the call', () => {
    const upsertFn = service.slice(service.indexOf('async function upsertAvailability'));
    expect(upsertFn).toContain('p_distribution_point_id:');
    expect(upsertFn).toContain('p_scientific_name:');
    expect(upsertFn).toContain('p_trade_name:');
    expect(upsertFn).toContain('p_dosage_form:');
    expect(upsertFn).toContain('p_concentration:');
    expect(upsertFn).toContain('p_quantity:');
    expect(upsertFn).toContain('p_condition:');
    expect(upsertFn).toContain('p_expiry_date:');
    expect(upsertFn).toContain('p_batch_number:');
    expect(upsertFn).toContain('p_notes:');
    expect(upsertFn).toContain('p_supply_type:');
    expect(upsertFn).toContain('p_price:');
  });
});

// ============================================================================
// AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A: p_national_code (migration 050)
// is only ever included when a normalized, non-empty value is supplied — a
// blank/undefined nationalCode omits the key entirely (never sends an
// explicit clear), preserving compatibility with every existing caller and
// with migration 050's own COALESCE-preserve-if-absent RPC behavior.
// ============================================================================

describe('Service: upsertAvailability p_national_code handling (migration 050)', () => {
  const upsertFn = service.slice(service.indexOf('async function upsertAvailability'), service.indexOf('export function classifyAvailabilitySaveError'));

  it('nationalCode is trimmed before being considered for the RPC call', () => {
    expect(upsertFn).toContain('input.nationalCode?.trim()');
  });

  it('p_national_code is only spread into the RPC payload when normalizedNationalCode is truthy (non-empty)', () => {
    expect(upsertFn).toContain('...(normalizedNationalCode ? { p_national_code: normalizedNationalCode } : {})');
  });

  it('does not unconditionally include p_national_code in the base RPC object (no destructive-clear default)', () => {
    // The 12 original params are listed as fixed keys; p_national_code must
    // NOT be one of them — it only appears via the conditional spread above.
    const baseObjectEnd = upsertFn.indexOf('...(normalizedNationalCode');
    const baseObject = upsertFn.slice(upsertFn.indexOf('p_distribution_point_id:'), baseObjectEnd);
    expect(baseObject).not.toContain('p_national_code:');
  });

  it('UpsertAvailabilityInput type declares nationalCode as optional/nullable', () => {
    const typeBlock = service.slice(service.indexOf('export interface UpsertAvailabilityInput'), service.indexOf('export async function getAvailabilityByPoint'));
    expect(typeBlock).toContain('nationalCode?: string | null');
  });

  it('existing callers without nationalCode remain compatible (input.nationalCode is optional, not required)', () => {
    expect(upsertFn).not.toMatch(/if \(!input\.nationalCode/);
  });


});

// ============================================================================
// FIX-AVAILABILITY-RPC-PORT-NAME-GIT-SYNC-A (migration 031)
//   Syncs the live hotfix that made phoenix_upsert_availability derive and
//   insert port_name, satisfying item_availability_identity_chk.
// ============================================================================

describe('FIX-AVAILABILITY-RPC-PORT-NAME-GIT-SYNC-A: migration 031 port_name fix', () => {
  const REL = 'supabase/migrations/031_phoenix_availability_upsert_rpc_port_name_fix.sql';

  it('(1) migration 031 file exists and is non-empty', () => {
    expect(existsSync(join(PHOENIX, REL))).toBe(true);
    expect(readPhoenix(REL).length).toBeGreaterThan(500);
  });

  it('(2) replaces public.phoenix_upsert_availability', () => {
    const sql = readPhoenix(REL);
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability');
  });

  it('(2b) keeps the same 12-argument signature', () => {
    const sql = readPhoenix(REL);
    expect(sql).toContain('p_distribution_point_id uuid');
    expect(sql).toContain('p_scientific_name        text');
    expect(sql).toContain('p_trade_name             text');
    expect(sql).toContain('p_dosage_form            text');
    expect(sql).toContain('p_concentration          text');
    expect(sql).toContain('p_quantity               integer');
    expect(sql).toContain('p_condition              text');
    expect(sql).toContain('p_expiry_date            date');
    expect(sql).toContain('p_batch_number           text');
    expect(sql).toContain('p_notes                  text');
    expect(sql).toContain('p_supply_type            text');
    expect(sql).toContain('p_price                  numeric');
  });

  it('(3) is SECURITY DEFINER', () => {
    expect(readPhoenix(REL)).toContain('SECURITY DEFINER');
  });

  it('(4) sets search_path = public', () => {
    expect(readPhoenix(REL)).toContain('SET search_path = public');
  });

  it('(4b) keeps LANGUAGE plpgsql', () => {
    expect(readPhoenix(REL)).toContain('LANGUAGE plpgsql');
  });

  it('(4c) keeps the scientific_name_required guard', () => {
    expect(readPhoenix(REL)).toContain('scientific_name_required');
  });

  it('(5) inserts port_name into item_availability', () => {
    const sql = readPhoenix(REL);
    const insertStart = sql.indexOf('INSERT INTO public.item_availability');
    const insertEnd   = sql.indexOf('RETURNING id INTO v_id', insertStart);
    const insertBlock = sql.slice(insertStart, insertEnd);
    expect(insertStart).toBeGreaterThan(-1);
    expect(insertBlock).toContain('port_name');
    expect(insertBlock).toContain('v_port_name');
  });

  it('(6) derives v_port_name from distribution_points', () => {
    const sql = readPhoenix(REL);
    expect(sql).toContain('v_port_name');
    expect(sql).toContain('FROM public.distribution_points');
    // port_name is derived from the distribution_points row, not the client
    expect(sql).toMatch(/v_port_name\s*:=\s*COALESCE/);
  });

  it('(6b) derives organization_id from distribution_points, not the client', () => {
    const sql = readPhoenix(REL);
    expect(sql).toContain('v_point_org := v_dp.organization_id');
    expect(sql).not.toContain('p_organization_id');
  });

  it('(7) keeps REVOKE ALL ... FROM PUBLIC, anon', () => {
    const sql = readPhoenix(REL);
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION[\s\S]*FROM\s+PUBLIC,\s*anon/i);
  });

  it('(8) grants EXECUTE to authenticated', () => {
    const sql = readPhoenix(REL);
    expect(sql).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION[\s\S]*TO\s+authenticated/i);
  });

  it('(8b) preserves the role authorization matrix', () => {
    const sql = readPhoenix(REL);
    expect(sql).toContain("v_role = 'super_admin'");
    expect(sql).toContain("v_role IN ('hospital_admin', 'warehouse_manager', 'point_operator')");
    expect(sql).toContain("v_role = 'point_operator'");
    expect(sql).toContain('point_operator_cannot_insert');
  });

  it('(8c) UPDATE matches on dp id, scientific_name, COALESCE(concentration/dosage_form)', () => {
    const sql = readPhoenix(REL);
    expect(sql).toContain('ia.distribution_point_id = p_distribution_point_id');
    expect(sql).toContain('ia.scientific_name       = p_scientific_name');
    expect(sql).toContain("COALESCE(ia.concentration, '') = v_conc");
    expect(sql).toContain("COALESCE(ia.dosage_form,  '') = v_dosage");
  });

  it('(9) contains no DELETE, no TRUNCATE, no service_role', () => {
    const noComments = readPhoenix(REL)
      .split('\n')
      .filter(l => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(noComments).not.toMatch(/\bdelete\b/i);
    expect(noComments).not.toMatch(/truncate/i);
    expect(noComments).not.toMatch(/service_role/i);
  });

  it('(9b) does not set actor_* fields manually (left to trigger 018)', () => {
    const sql = readPhoenix(REL);
    const insertStart = sql.indexOf('INSERT INTO public.item_availability');
    const insertBlock = sql.slice(insertStart, sql.indexOf('RETURNING id INTO v_id', insertStart));
    expect(insertBlock).not.toMatch(/actor_/i);
  });

  it('(9c) ends with NOTIFY pgrst reload schema', () => {
    expect(readPhoenix(REL)).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('(10) availability service still calls .rpc(phoenix_upsert_availability, ...)', () => {
    expect(service).toContain("rpc('phoenix_upsert_availability'");
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

// ============================================================================
// PORT-CARD-QR-PREVIEW-PRINT-UX-A
// ============================================================================

describe('PORT-CARD-QR-PREVIEW-PRINT-UX-A: QR preview and print in port cards', () => {
  const institution = readSrc('features/institutions/InstitutionScreen.tsx');
  const stringsFile = readSrc('shared/i18n/strings.ts');

  // ── i18n strings ──

  it('i18n has qr_preview string', () => {
    expect(stringsFile).toContain("qr_preview:");
  });

  it('i18n has qr_open_preview string', () => {
    expect(stringsFile).toContain("qr_open_preview:");
  });

  it('i18n has qr_print string', () => {
    expect(stringsFile).toContain("qr_print:");
  });

  it('i18n has qr_close string', () => {
    expect(stringsFile).toContain("qr_close:");
  });

  it('i18n has qr_large_preview string', () => {
    expect(stringsFile).toContain("qr_large_preview:");
  });

  it('i18n has qr_display_error string', () => {
    expect(stringsFile).toContain("qr_display_error:");
  });

  it('i18n has qr_print_empty string', () => {
    expect(stringsFile).toContain("qr_print_empty:");
  });

  it('i18n has qr_generated_for_port string', () => {
    expect(stringsFile).toContain("qr_generated_for_port:");
  });

  it('i18n qr_print has Arabic and English translations', () => {
    expect(stringsFile).toMatch(/qr_print:\s*\{[^}]*ar:.*طباعة/);
    expect(stringsFile).toMatch(/qr_print:\s*\{[^}]*en:.*Print/);
  });

  it('i18n qr_close has Arabic and English translations', () => {
    expect(stringsFile).toMatch(/qr_close:\s*\{[^}]*ar:.*إغلاق/);
    expect(stringsFile).toMatch(/qr_close:\s*\{[^}]*en:.*Close/);
  });

  // ── Dependencies ──

  it('InstitutionScreen imports qrcode library', () => {
    expect(institution).toContain("from 'qrcode'");
  });

  // ── Component existence ──

  it('QrPreviewModal component exists in InstitutionScreen', () => {
    expect(institution).toContain('function QrPreviewModal');
  });

  it('QrPreviewModal is invoked inside PortCard', () => {
    expect(institution).toContain('<QrPreviewModal');
  });

  // ── PortCard QR thumbnail ──

  it('PortCard shows QR thumbnail button when active QR exists', () => {
    expect(institution).toContain("onClick={() => setShowPreview(true)}");
  });

  it('PortCard QR thumbnail is guarded by qr && publicUrl condition', () => {
    // Both the null-guard and the preview button must be present in the file
    expect(institution).toContain('qr && publicUrl');
    expect(institution).toContain('setShowPreview(true)');
    // The button must appear after the guard (order check via indexOf)
    expect(institution.indexOf('setShowPreview(true)')).toBeGreaterThan(institution.indexOf('qr && publicUrl'));
  });

  it('PortCard QR thumbnail renders img when src available', () => {
    expect(institution).toContain('qrSrc');
    expect(institution).toMatch(/qrSrc\s*\?\s*\(/);
  });

  it('PortCard shows qr_display_error when QR rendering fails', () => {
    expect(institution).toContain("t('qr_display_error'");
    expect(institution).toContain('qrSrcErr');
  });

  it('PortCard generates QR data URL via QRCode.toDataURL', () => {
    expect(institution).toContain('QRCode.toDataURL');
  });

  it('PortCard useEffect cancels QR generation on unmount', () => {
    expect(institution).toContain('let cancelled = false');
    expect(institution).toContain('cancelled = true');
  });

  // ── Modal content ──

  it('QrPreviewModal shows port name', () => {
    const modalStart = institution.indexOf('function QrPreviewModal');
    const modalEnd   = institution.indexOf('\n/* ──', modalStart);
    const modalBody  = institution.slice(modalStart, modalEnd);
    expect(modalBody).toContain('portName');
  });

  it('QrPreviewModal shows large QR image (200x200)', () => {
    const modalStart = institution.indexOf('function QrPreviewModal');
    const modalEnd   = institution.indexOf('\n/* ──', modalStart);
    const modalBody  = institution.slice(modalStart, modalEnd);
    expect(modalBody).toContain('200');
    expect(modalBody).toContain('<img');
  });

  it('QrPreviewModal shows org name when provided', () => {
    const modalStart = institution.indexOf('function QrPreviewModal');
    const modalEnd   = institution.indexOf('\n/* ──', modalStart);
    const modalBody  = institution.slice(modalStart, modalEnd);
    expect(modalBody).toContain('orgName');
  });

  it('QrPreviewModal shows public URL', () => {
    const modalStart = institution.indexOf('function QrPreviewModal');
    const modalEnd   = institution.indexOf('\n/* ──', modalStart);
    const modalBody  = institution.slice(modalStart, modalEnd);
    expect(modalBody).toContain('url');
  });

  it('QrPreviewModal has print button using qr_print key', () => {
    expect(institution).toContain("t('qr_print'");
  });

  it('QrPreviewModal has close button using qr_close key', () => {
    expect(institution).toContain("t('qr_close'");
  });

  // ── Print behavior ──

  it('Print handler opens a new window', () => {
    expect(institution).toContain("window.open(");
  });

  it('Print handler calls window.print()', () => {
    expect(institution).toContain('win.print()');
  });

  it('Print content includes brand label', () => {
    expect(institution).toContain('MediStock-Babil / MASAR Health Network');
  });

  it('Print content escapes HTML to prevent XSS', () => {
    expect(institution).toContain('function esc(');
    expect(institution).toContain("replace(/&/g, '&amp;')");
  });

  it('Print function does not expose QR token secrets', () => {
    const printStart = institution.indexOf('function handlePrint');
    const printEnd   = institution.indexOf('\n  }', printStart) + 4;
    const printFn    = institution.slice(printStart, printEnd);
    expect(printFn).not.toContain('tokenId');
    expect(printFn).not.toContain('token_hash');
    expect(printFn).not.toContain('service_role');
  });

  it('Print is disabled when QR src is not yet generated', () => {
    expect(institution).toContain('disabled={!src}');
  });

  // ── Permissions ──

  it('Regenerate button in modal requires qr.generate AND qr.revoke', () => {
    expect(institution).toContain('canRegenerate={canGenerateQr && canRevokeQr}');
  });

  it('Regenerate button is gated by canRegenerate prop in QrPreviewModal', () => {
    const modalStart = institution.indexOf('function QrPreviewModal');
    const modalEnd   = institution.indexOf('\n/* ──', modalStart);
    const modalBody  = institution.slice(modalStart, modalEnd);
    expect(modalBody).toContain('canRegenerate');
    expect(modalBody).toContain('{canRegenerate && (');
  });

  it('orgName is threaded from OrgDetailView through PortSection to PortCard', () => {
    expect(institution).toContain('orgName={o ? orgDisplayName(o, lang) : undefined}');
    expect(institution).toContain('orgName={orgName}');
  });

  // ── Security ──

  it('no service_role in InstitutionScreen frontend', () => {
    expect(institution).not.toMatch(/service_role/i);
  });

  it('no auth.admin in InstitutionScreen frontend', () => {
    expect(institution).not.toMatch(/auth\.admin/i);
  });

  it('no SQL migration created for QR preview UX', () => {
    const migsDir = join(PHOENIX, 'supabase/migrations');
    if (!existsSync(migsDir)) return;
    const migFiles = readdirSync(migsDir) as string[];
    // Migration 027 exists but is the privacy-hardening migration, not a QR preview UX migration.
    // Confirm that any 027_ file is the privacy hardening one, not a port-card/QR-preview migration.
    expect(migFiles.some((f: string) => f.startsWith('027_') && /qr_preview|port_card/i.test(f))).toBe(false);
  });

  it('Data Reset is still absent after QR preview UX changes', () => {
    const files = allTsxFiles('');
    files.forEach(path => {
      expect(readFile(path)).not.toMatch(/import.*DataReset/i);
    });
  });

  it('Intake is still disabled after QR preview UX changes', () => {
    const files = allTsxFiles('');
    files.forEach(path => {
      const content = readFile(path);
      expect(content).not.toMatch(/import.*OcrImport/i);
      expect(content).not.toMatch(/import.*ExcelImport/i);
    });
  });
});

// ============================================================================
// STATUS-EDITOR-CLEANUP-A: near_expiry removed from manual editor dropdown,
// kept everywhere else (types, filters, display, RPC/migration compatibility).
// ============================================================================

describe('STATUS-EDITOR-CLEANUP-A: near_expiry legacy/display/RPC compatibility', () => {
  const types = readSrc('shared/lib/types.ts');
  const canonical = readSrc('shared/lib/status/canonical.ts');
  const statusEditor = readSrc('features/status/StatusEditorScreen.tsx');
  const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
  const expiryRisk = readSrc('shared/lib/expiry-risk.ts');

  it('AvailabilityCondition type still includes near_expiry (saved-data compatibility)', () => {
    const typeBlock = statementAt(types, 'AvailabilityCondition =');
    expect(typeBlock).toContain("'near_expiry'");
  });

  it('canonical status helpers still recognize near_expiry (computeEffectiveStatus precedence unchanged)', () => {
    expect(canonical).toContain("'near_expiry'");
  });

  it('cond_near_expiry label remains defined for legacy row display', () => {
    expect(strings).toMatch(/cond_near_expiry:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/);
  });

  it('StatusEditorScreen filter dropdown still offers near_expiry (filters unaffected — dropdown-only removal was scoped to the manual EditorScreen save form)', () => {
    const optsBlock = statusEditor.slice(
      statusEditor.indexOf('const CONDITION_OPTIONS'),
      statusEditor.indexOf('as const', statusEditor.indexOf('const CONDITION_OPTIONS')),
    );
    expect(optsBlock).toContain("'near_expiry'");
  });

  it('StatusEditorScreen filter dropdown row renders condition = near_expiry rows without special-casing/crashing', () => {
    expect(statusEditor).toContain("r.condition ? t('cond_' + r.condition, lang) : '—'");
  });

  it('StatusCenterScreen near_expiry filter chip still present (legacy filter compatibility)', () => {
    expect(statusCenter).toContain("key: 'near_expiry'");
    expect(statusCenter).toContain("labelKey: 'cond_near_expiry'");
  });



  it('the 9/6/3 expiry-risk-tier helper (visual source of truth) is untouched by this phase — still derives tiers from expiry_date only', () => {
    expect(expiryRisk).toContain("'critical_3m'");
    expect(expiryRisk).toContain("'warning_6m'");
    expect(expiryRisk).toContain("'watch_9m'");
    expect(expiryRisk).toContain('export function getExpiryRiskTier');
  });


});

// ============================================================================
// STATUS-EDITOR-CLEANUP-A: migration 048 still preserved by this phase
// ============================================================================

describe('STATUS-EDITOR-CLEANUP-A: migration 048 preserved (not discarded by this phase)', () => {
  const migration048Path = join(PHOENIX, 'supabase/migrations/048_live_alerts_expiry_risk_tiers.sql');

  it('048_live_alerts_expiry_risk_tiers.sql still exists', () => {
    expect(existsSync(migration048Path)).toBe(true);
  });

  it('still exposes source_expiry_risk_tier and source_expiry_days_remaining', () => {
    const sql = readFile(migration048Path);
    expect(sql).toContain("'source_expiry_risk_tier',");
    expect(sql).toContain("'source_expiry_days_remaining',");
  });

  it('still preserves alert_key stability (src:tgt:alert_type, no tier component)', () => {
    const sql = readFile(migration048Path);
    expect(sql).toContain(
      "(m.src_availability_id::text || ':' || m.tgt_availability_id::text || ':' || m.alert_type) AS alert_key",
    );
  });

  it('still preserves condition = near_expiry RPC compatibility branch', () => {
    const sql = readFile(migration048Path);
    expect(sql).toContain("WHEN ia.condition = 'near_expiry' THEN 'near_expiry'");
  });
});

// ============================================================================
// STATUS-EDITOR-CLEANUP-A: safety guards for this phase only
// ============================================================================

describe('STATUS-EDITOR-CLEANUP-A: no SQL/db-push/package/permission side effects from the frontend dropdown change', () => {
  // MIGRATION-GUARD-DERIVE-A: the expected filenames beyond 048 now come from the
  // canonical reviewed-migration registry instead of a copy kept in this file.
  // Still exact-filename equality: an unregistered file on disk fails here, so
  // this phase still cannot smuggle in a migration of its own.
  it('no SQL was applied and no supabase db push was run as part of this phase (only exactly-reviewed migrations exist beyond 048)', () => {
    const migsDir = join(PHOENIX, 'supabase/migrations');
    expect(actualMigrationFilesAbove(48, migsDir)).toEqual(reviewedMigrationFilesAbove(48));
  });

  it('no package/lockfile diff from this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: PHOENIX, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });



  it('premium-preview.html remains untracked (only "??" status if present)', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: PHOENIX, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });

  it('supabase/.temp/ was not staged by this phase', () => {
    const status = execSync('git status --porcelain', { cwd: PHOENIX, encoding: 'utf8' });
    const tempLine = status.split('\n').find(l => l.includes('supabase/.temp'));
    if (tempLine) {
      expect(tempLine.trim().startsWith('??')).toBe(true);
    }
  });

  it('Service-D stash (paused inter-org exchange service work) remains untouched', () => {
    const stashList = execSync('git stash list', { cwd: PHOENIX, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });
});

// ============================================================================
// AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A safety guards
// ============================================================================

describe('AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A: no SQL/migration/package side effects', () => {
  // MIGRATION-GUARD-DERIVE-A: was a hard-coded "no 060+" range regex needing a
  // bump per migration. Now exact-membership based and strictly broader — ANY
  // unreviewed migration file at ANY number fails here.
  it('no unreviewed migration file exists (approval is exact-filename membership in the canonical reviewed registry, not a number ceiling)', () => {
    const migsDir = join(PHOENIX, 'supabase/migrations');
    expect(findUnreviewedMigrationFiles(readdirSync(migsDir) as string[])).toEqual([]);
  });

  // REFRESH-MIGRATION-051-DIFF-GUARDS-A: 051 is excluded from this 001-050
  // check (it was never in scope: 051 is a later, separately-reviewed
  // migration correctable in-place before its first successful manual apply
  // by FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A) — the original glob
  // "0[4-5][0-9]_*.sql" matched 040-059 and so accidentally covered 051 too.
  it('migrations 001-050 have no working-tree diff (this phase is frontend-only)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/0[0-3][0-9]_*.sql" "supabase/migrations/04[0-9]_*.sql" "supabase/migrations/050_*.sql"', { cwd: PHOENIX, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('no package/lockfile diff from this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: PHOENIX, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('premium-preview.html remains untracked (only "??" status if present)', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: PHOENIX, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });

  it('supabase/.temp/ was not staged by this phase', () => {
    const status = execSync('git status --porcelain', { cwd: PHOENIX, encoding: 'utf8' });
    const tempLine = status.split('\n').find(l => l.includes('supabase/.temp'));
    if (tempLine) {
      expect(tempLine.trim().startsWith('??')).toBe(true);
    }
  });

  it('Service-D stash (paused inter-org exchange service work) remains untouched', () => {
    const stashList = execSync('git stash list', { cwd: PHOENIX, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });
});
