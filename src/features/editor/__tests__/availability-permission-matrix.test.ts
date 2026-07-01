/**
 * AVAILABILITY-PERMISSION-MATRIX-INTEGRATION-A
 *
 * Verifies:
 *  - EditorScreen gates save on myPermissions (availability.create/update),
 *    not on a hardcoded super_admin-only check.
 *  - Save error handling classifies 42501 permission denials correctly.
 *  - Migration 032 replaces hardcoded-role authorization with
 *    phoenix_profile_has_permission(auth.uid(), 'availability.create'/'update')
 *    in both the RPC and the item_availability RLS write policies.
 *  - The misleading "(تجريبي)" / "(demo)" success toast text is gone.
 *
 * Static source-code tests — no DB connection required.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { classifyAvailabilitySaveError } from '@/shared/supabase/services/availability.service';

const SRC     = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');
const readSrc     = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const readPhoenix = (rel: string) => readFileSync(join(PHOENIX, rel), 'utf8');

const editor  = readSrc('features/editor/EditorScreen.tsx');
const strings = readSrc('shared/i18n/strings.ts');
const migration032 = readPhoenix('supabase/migrations/032_phoenix_availability_permission_matrix_integration.sql');

// ============================================================================
// EditorScreen: permission-matrix gating
// ============================================================================

describe('EditorScreen uses the permission matrix for save UX', () => {
  it('reads myPermissions from useApp()', () => {
    expect(editor).toContain('myPermissions');
    expect(editor).toMatch(/useApp\(\)/);
  });

  it('derives canViewAvailability / canCreateAvailability / canUpdateAvailability from myPermissions', () => {
    expect(editor).toContain("myPermissions.has('availability.view')");
    expect(editor).toContain("myPermissions.has('availability.create')");
    expect(editor).toContain("myPermissions.has('availability.update')");
  });

  it('does not gate save purely on role === super_admin', () => {
    // isSuper is still used for the institution dropdown vs locked-display UX,
    // but canSubmit/canAttemptSave must not be defined as `role === 'super_admin'`.
    expect(editor).not.toMatch(/canSubmit\s*=\s*role\s*===\s*'super_admin'/);
    expect(editor).not.toMatch(/canAttemptSave\s*=\s*role\s*===\s*'super_admin'/);
  });

  it('canSubmit requires create-or-update capability', () => {
    expect(editor).toContain('canAttemptSave');
    expect(editor).toMatch(/canSubmit\s*=\s*canAttemptSave/);
  });

  it('still keeps the super_admin org dropdown vs locked-display behavior', () => {
    expect(editor).toContain("const isSuper = role === 'super_admin'");
    expect(editor).toContain('isSuper ?');
  });

  it('shows a permission denial message when the actor can neither create nor update', () => {
    expect(editor).toContain('avail_no_edit_permission');
  });

  it('classifies save errors instead of always showing the generic load_error toast', () => {
    expect(editor).toContain('classifyAvailabilitySaveError');
    expect(editor).not.toMatch(/setToast\(t\('load_error', lang\)\);\s*\n\s*setTimeout\(\(\) => setToast\(null\), 3000\);\s*\n\s*\}\s*finally/);
  });

  it('imports classifyAvailabilitySaveError from availability.service', () => {
    expect(editor).toContain('classifyAvailabilitySaveError');
    expect(editor).toContain("from '@/shared/supabase/services/availability.service'");
  });
});

// ============================================================================
// availability.service.ts: error classification
// ============================================================================

describe('classifyAvailabilitySaveError', () => {
  it('classifies forbidden_availability_create as the create-denial key', () => {
    expect(classifyAvailabilitySaveError({ code: '42501', message: 'forbidden_availability_create' }))
      .toBe('avail_no_create_permission');
  });

  it('classifies forbidden_availability_update as the update-denial key', () => {
    expect(classifyAvailabilitySaveError({ code: '42501', message: 'forbidden_availability_update' }))
      .toBe('avail_no_update_permission');
  });

  it('classifies forbidden_cross_org as the cross-org-denial key', () => {
    expect(classifyAvailabilitySaveError({ code: '42501', message: 'forbidden_cross_org' }))
      .toBe('avail_cross_org_denied');
  });

  it('classifies a generic forbidden_role_or_permission as the generic edit-denial key', () => {
    expect(classifyAvailabilitySaveError({ code: '42501', message: 'forbidden_role_or_permission' }))
      .toBe('avail_no_edit_permission');
  });

  it('classifies non-permission errors as the generic load_error key', () => {
    expect(classifyAvailabilitySaveError({ code: '23514', message: 'scientific_name_required' }))
      .toBe('load_error');
    expect(classifyAvailabilitySaveError(new Error('network down'))).toBe('load_error');
  });
});

// ============================================================================
// i18n: permission-denial strings + demo-toast removal
// ============================================================================

describe('Bilingual permission-denial strings exist', () => {
  it('avail_no_edit_permission exists bilingually', () => {
    expect(strings).toMatch(/avail_no_edit_permission:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/);
  });
  it('avail_no_create_permission exists bilingually', () => {
    expect(strings).toMatch(/avail_no_create_permission:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/);
    expect(strings).toContain('You do not have permission to create a new availability record.');
  });
  it('avail_no_update_permission exists bilingually', () => {
    expect(strings).toMatch(/avail_no_update_permission:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/);
    expect(strings).toContain('You do not have permission to update this availability record.');
  });
  it('avail_cross_org_denied exists bilingually', () => {
    expect(strings).toMatch(/avail_cross_org_denied:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/);
    expect(strings).toContain('You cannot modify availability outside your organization.');
  });
});

describe('Success toast no longer says "(demo)" / "(تجريبي)"', () => {
  it('apply_success has no demo suffix', () => {
    const line = strings.split('\n').find(l => l.trimStart().startsWith('apply_success:'));
    expect(line).toBeTruthy();
    expect(line).not.toContain('تجريبي');
    expect(line).not.toContain('demo');
    expect(line).toContain('تم التطبيق بنجاح');
    expect(line).toContain('Applied successfully');
  });
});

// ============================================================================
// Migration 032: permission catalog + RPC + RLS
// ============================================================================

describe('Migration 032 exists and is manual-apply-only', () => {
  it('file exists and is non-empty', () => {
    expect(migration032.length).toBeGreaterThan(500);
  });

  it('is manual-apply-only', () => {
    expect(migration032).toContain('MANUAL APPLY ONLY');
    expect(migration032).toContain('DO NOT use');
    expect(migration032).toContain('supabase db push');
  });

  it('has no DROP TABLE, TRUNCATE, or destructive DELETE', () => {
    const noComments = migration032.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/^\s*(drop table|truncate)\b/im);
    expect(noComments).not.toMatch(/^\s*delete from\b/im);
  });

  it('does not reference service_role', () => {
    expect(migration032).not.toMatch(/service_role/i);
  });

  it('does not write to auth.users', () => {
    expect(migration032).not.toMatch(/\b(insert|update|delete)\b.*auth\.users/i);
  });
});

describe('Migration 032 adds availability.create / availability.update to the permission catalog', () => {
  it('inserts the two new permission keys', () => {
    expect(migration032).toContain("'availability.create'");
    expect(migration032).toContain("'availability.update'");
    expect(migration032).toContain('INSERT INTO permission_keys');
  });

  it('is idempotent for the catalog insert (ON CONFLICT DO NOTHING)', () => {
    const block = migration032.slice(
      migration032.indexOf('INSERT INTO permission_keys'),
      migration032.indexOf('-- =', migration032.indexOf('INSERT INTO permission_keys')),
    );
    expect(block).toContain('ON CONFLICT (key) DO NOTHING');
  });

  it('does not delete or update the existing availability.view / availability.manage catalog rows', () => {
    expect(migration032).not.toMatch(/DELETE\s+FROM\s+permission_keys/i);
    expect(migration032).not.toMatch(/UPDATE\s+permission_keys[\s\S]*?availability\.(view|manage)/i);
  });
});

describe('Migration 032 seeds role_permission_defaults per the approved matrix', () => {
  const seedBlock = migration032.slice(
    migration032.indexOf('INSERT INTO role_permission_defaults'),
    migration032.indexOf('ON CONFLICT (role, permission_key) DO UPDATE'),
  );

  it('super_admin: create + update = true', () => {
    expect(seedBlock).toContain("('super_admin',             'availability.create', true)");
    expect(seedBlock).toContain("('super_admin',             'availability.update', true)");
  });

  it('institution_admin: create + update = true', () => {
    expect(seedBlock).toContain("('institution_admin',       'availability.create', true)");
    expect(seedBlock).toContain("('institution_admin',       'availability.update', true)");
  });

  it('hospital_admin (legacy): create + update = true', () => {
    expect(seedBlock).toContain("('hospital_admin',          'availability.create', true)");
    expect(seedBlock).toContain("('hospital_admin',          'availability.update', true)");
  });

  it('warehouse_officer and warehouse_manager: create + update = true', () => {
    expect(seedBlock).toContain("('warehouse_officer',       'availability.create', true)");
    expect(seedBlock).toContain("('warehouse_officer',       'availability.update', true)");
    expect(seedBlock).toContain("('warehouse_manager',       'availability.create', true)");
    expect(seedBlock).toContain("('warehouse_manager',       'availability.update', true)");
  });

  it('port_officer and point_operator: update = true, create = false', () => {
    expect(seedBlock).toContain("('port_officer',            'availability.create', false)");
    expect(seedBlock).toContain("('port_officer',            'availability.update', true)");
    expect(seedBlock).toContain("('point_operator',          'availability.create', false)");
    expect(seedBlock).toContain("('point_operator',          'availability.update', true)");
  });

  it('monthly_status_officer and transfer_manager: read-only (both false)', () => {
    expect(seedBlock).toContain("('monthly_status_officer',  'availability.create', false)");
    expect(seedBlock).toContain("('monthly_status_officer',  'availability.update', false)");
    expect(seedBlock).toContain("('transfer_manager',        'availability.create', false)");
    expect(seedBlock).toContain("('transfer_manager',        'availability.update', false)");
  });

  it('viewer: read-only (both false)', () => {
    expect(seedBlock).toContain("('viewer',                  'availability.create', false)");
    expect(seedBlock).toContain("('viewer',                  'availability.update', false)");
  });
});

describe('Migration 032 RPC: permission-matrix authorization', () => {
  const fnBlock = migration032.slice(
    migration032.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability'),
    migration032.indexOf('REVOKE ALL ON FUNCTION public.phoenix_upsert_availability'),
  );

  it('checks phoenix_profile_has_permission for availability.create', () => {
    expect(fnBlock).toContain("phoenix_profile_has_permission(auth.uid(), 'availability.create')");
  });

  it('checks phoenix_profile_has_permission for availability.update', () => {
    expect(fnBlock).toContain("phoenix_profile_has_permission(auth.uid(), 'availability.update')");
  });

  it('does not contain the old hardcoded allowlist block', () => {
    expect(fnBlock).not.toMatch(/IN\s*\(\s*'hospital_admin'\s*,\s*'warehouse_manager'\s*,\s*'point_operator'\s*\)/);
  });

  it('super_admin still bypasses org scope', () => {
    expect(fnBlock).toContain("v_role = 'super_admin'");
  });

  it('non-super users are scoped to their own organization', () => {
    expect(fnBlock).toContain('v_point_org = v_my_org');
    expect(fnBlock).toContain('forbidden_cross_org');
  });

  it('raises forbidden_availability_create and forbidden_availability_update with 42501', () => {
    expect(fnBlock).toMatch(/forbidden_availability_create'\s*USING ERRCODE = '42501'/);
    expect(fnBlock).toMatch(/forbidden_availability_update'\s*USING ERRCODE = '42501'/);
  });

  it('preserves port_name derivation from distribution_points', () => {
    expect(fnBlock).toContain('v_port_name := COALESCE(');
    expect(fnBlock).toContain("to_jsonb(v_dp)->>'name'");
  });

  it('preserves scientific_name required check', () => {
    expect(fnBlock).toContain('scientific_name_required');
  });

  it('preserves organization_id derivation from distribution_points (never trusted from client)', () => {
    expect(fnBlock).toContain('v_point_org := v_dp.organization_id');
  });

  it('preserves identity match by distribution_point_id + scientific_name + COALESCE(concentration/dosage_form)', () => {
    expect(fnBlock).toContain('ia.distribution_point_id = p_distribution_point_id');
    expect(fnBlock).toContain('ia.scientific_name       = p_scientific_name');
    expect(fnBlock).toContain("COALESCE(ia.concentration, '') = v_conc");
    expect(fnBlock).toContain("COALESCE(ia.dosage_form,  '') = v_dosage");
  });

  it('does not write actor_* manual fields', () => {
    expect(fnBlock).not.toMatch(/actor_name_snapshot\s*[,=]/);
    expect(fnBlock).not.toMatch(/actor_email_snapshot\s*[,=]/);
  });

  it('is SECURITY DEFINER with search_path = public', () => {
    expect(fnBlock).toContain('SECURITY DEFINER');
    expect(fnBlock).toContain('SET search_path = public');
  });

  it('no service_role or auth.admin references', () => {
    expect(fnBlock).not.toMatch(/service_role/i);
    expect(fnBlock).not.toMatch(/auth\.admin/);
  });
});

describe('Migration 032 grants: authenticated only, anon revoked, no DELETE', () => {
  const grantBlock = migration032.slice(
    migration032.indexOf('REVOKE ALL ON FUNCTION public.phoenix_upsert_availability'),
    migration032.indexOf('-- ============================================================================\n-- 4. Replace item_availability'),
  );

  it('revokes from PUBLIC and anon', () => {
    expect(grantBlock).toContain('FROM PUBLIC, anon');
  });

  it('grants execute only to authenticated', () => {
    expect(grantBlock).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_upsert_availability');
    expect(grantBlock).toContain('TO authenticated');
  });

  it('no DELETE policy is created anywhere in the migration', () => {
    const noComments = migration032.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(noComments).not.toMatch(/CREATE\s+POLICY\s+\S+\s+ON\s+item_availability\s+FOR\s+DELETE/i);
  });
});

describe('Migration 032 RLS: replaces hardcoded write policies with permission-based insert/update', () => {
  const rlsBlock = migration032.slice(
    migration032.indexOf('-- 4. Replace item_availability hardcoded-role write RLS policies'),
    migration032.indexOf('-- No DELETE policy: unchanged from migration 002'),
  );

  it('drops the old hardcoded-role write policies', () => {
    expect(rlsBlock).toContain('DROP POLICY IF EXISTS "avail_write_superadmin"');
    expect(rlsBlock).toContain('DROP POLICY IF EXISTS "avail_write_hospitaladmin"');
    expect(rlsBlock).toContain('DROP POLICY IF EXISTS "avail_write_wh_manager"');
    expect(rlsBlock).toContain('DROP POLICY IF EXISTS "avail_write_point_operator"');
  });

  it('creates avail_insert_perm gated by availability.create + org scope (or super_admin)', () => {
    expect(rlsBlock).toContain('CREATE POLICY "avail_insert_perm"');
    expect(rlsBlock).toContain("phoenix_profile_has_permission(auth.uid(), 'availability.create')");
    expect(rlsBlock).toContain("phoenix_my_role() = 'super_admin'");
    expect(rlsBlock).toContain('organization_id = phoenix_my_org()');
  });

  it('creates avail_update_perm gated by availability.update + org scope (or super_admin)', () => {
    expect(rlsBlock).toContain('CREATE POLICY "avail_update_perm"');
    expect(rlsBlock).toContain("phoenix_profile_has_permission(auth.uid(), 'availability.update')");
  });

  it('does not add a policy granting write access to anon', () => {
    expect(rlsBlock).not.toContain('TO anon');
    expect(rlsBlock).not.toContain('to anon');
  });

  it('does not touch the read policies (avail_select_org / avail_select_anon)', () => {
    expect(rlsBlock).not.toContain('DROP POLICY IF EXISTS "avail_select_org"');
    expect(rlsBlock).not.toContain('DROP POLICY IF EXISTS "avail_select_anon"');
  });
});

describe('Migration 032 documents the assigned-point scope limitation', () => {
  it('explains no reliable assignment model exists and org scope is used instead', () => {
    expect(migration032).toMatch(/no reliable assigned-distribution-point/i);
    expect(migration032).toContain('KNOWN LIMITATION');
  });

  it('does not invent a new assignment table or column', () => {
    expect(migration032).not.toMatch(/CREATE TABLE.*assign/i);
    expect(migration032).not.toMatch(/ADD COLUMN.*assigned_point/i);
  });
});

describe('Migration 032 verification block', () => {
  it('asserts availability.create/update role defaults for spot-check roles', () => {
    expect(migration032).toContain("role = 'institution_admin' AND permission_key = 'availability.create'");
    expect(migration032).toContain("role = 'port_officer' AND permission_key = 'availability.create'");
    expect(migration032).toContain("role = 'port_officer' AND permission_key = 'availability.update'");
  });

  it('asserts the RPC no longer contains the old allowlist and still has SECURITY DEFINER', () => {
    expect(migration032).toContain('does not reference availability.create');
    expect(migration032).toContain('still contains the old hardcoded allowlist');
  });

  it('asserts exactly 4 policies remain on item_availability (2 read + 2 write, no DELETE)', () => {
    expect(migration032).toContain('expected exactly 4 policies on item_availability');
  });
});
