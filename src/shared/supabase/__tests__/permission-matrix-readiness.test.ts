/**
 * PERMISSION-MATRIX-010-GUARD-FIX-A Guardrail Tests
 * Run: npm test -- --run
 *
 * Verifies the permission-matrix readiness guard tests REAL DB capability
 * (tables + RPCs existing) instead of falsely reporting "migration 010
 * missing" whenever any RPC call fails for an unrelated reason (RLS,
 * network, a later-migration runtime bug, or a stale exact-count
 * assumption). No live Supabase connection is required — these are static
 * source checks plus pure-function classifier tests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC     = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const readPhoenix = (rel: string) => readFileSync(join(PHOENIX, rel), 'utf8');

// ============================================================================
// 1. Root cause is fixed: errors are classified, not blindly mapped
// ============================================================================

describe('users.service.ts: RPC errors are classified, never blindly mapped to migrationMissing', () => {
  const svc = readSrc('shared/supabase/services/users.service.ts');

  it('getEffectivePermissions only sets migrationMissing for a genuinely missing function', () => {
    const block = svc.slice(svc.indexOf('export async function getEffectivePermissions'), svc.indexOf('export interface AssignPermissionsResult'));
    expect(block).toContain('isMissingFunctionError(error)');
    expect(block).not.toMatch(/if \(error\) return \{ permissions: null, migrationMissing: true \};/);
  });

  it('assignProfilePermissions only sets migrationMissing for a genuinely missing function', () => {
    const block = svc.slice(svc.indexOf('export async function assignProfilePermissions'), svc.indexOf('export async function resetProfilePermissions'));
    expect(block).toContain('isMissingFunctionError(error)');
    expect(block).toContain("error: 'SAVE_FAILED'");
    expect(block).not.toMatch(/if \(error\) return \{ ok: false, migrationMissing: true/);
  });

  it('resetProfilePermissions only sets migrationMissing for a genuinely missing function', () => {
    const block = svc.slice(svc.indexOf('export async function resetProfilePermissions'));
    expect(block).toContain('isMissingFunctionError(error)');
    expect(block).toContain("error: 'SAVE_FAILED'");
  });

  it('a thrown/network exception is classified as NETWORK_ERROR, not a missing migration', () => {
    expect(svc).toContain("error: 'NETWORK_ERROR'");
  });

  it('save/reset no longer throw on missing config — they return a gracefully classifiable result', () => {
    const assignBlock = svc.slice(svc.indexOf('export async function assignProfilePermissions'), svc.indexOf('export async function resetProfilePermissions'));
    expect(assignBlock).not.toContain("throw new Error('Supabase not configured')");
    expect(assignBlock).toContain("ok: false, error: 'NOT_CONFIGURED'");
  });

  it('isMissingFunctionError matches Postgrest "function not found" signatures only', () => {
    expect(svc).toContain("error.code === 'PGRST202'");
    expect(svc).toContain("error.code === '42883'");
  });

  it('isMissingRelationError matches Postgrest "relation does not exist" signatures only', () => {
    expect(svc).toContain("error.code === '42P01'");
  });

  it('no exact-permission-count comparison drives the readiness decision', () => {
    expect(svc).not.toMatch(/count.*===?\s*32/);
    expect(svc).not.toMatch(/permission_keys.*length/i);
  });

  it('does not reference the wrong column name is_allowed anywhere', () => {
    expect(svc).not.toContain('is_allowed');
  });
});

// ============================================================================
// 2. checkPermissionMatrixReady: explicit, side-effect-free capability probe
// ============================================================================

describe('checkPermissionMatrixReady: explicit DB-capability probe', () => {
  const svc = readSrc('shared/supabase/services/users.service.ts');

  it('is exported and checks all three tables + the RPC', () => {
    expect(svc).toContain('export async function checkPermissionMatrixReady');
    const block = svc.slice(svc.indexOf('export async function checkPermissionMatrixReady'));
    expect(block).toContain("from('permission_keys')");
    expect(block).toContain("from('role_permission_defaults')");
    expect(block).toContain("from('profile_permission_overrides')");
    expect(block).toContain("rpc('get_effective_permissions'");
  });

  it('never writes data — only .select() and a non-mutating RPC probe call', () => {
    const block = svc.slice(svc.indexOf('export async function checkPermissionMatrixReady'), svc.indexOf('export interface EffectivePermissionsResult'));
    expect(block).not.toMatch(/\.(insert|update|delete|upsert)\(/);
  });

  it('uses .limit(1) reads, never an exact row-count assumption', () => {
    const block = svc.slice(svc.indexOf('export async function checkPermissionMatrixReady'), svc.indexOf('export interface EffectivePermissionsResult'));
    expect(block).toContain('.limit(1)');
    expect(block).not.toMatch(/count\(\*\)/);
  });

  it('reports distinct reasons: TABLES_MISSING, RPC_MISSING, UNKNOWN_ERROR, NOT_CONFIGURED', () => {
    expect(svc).toContain("'TABLES_MISSING'");
    expect(svc).toContain("'RPC_MISSING'");
    expect(svc).toContain("'UNKNOWN_ERROR'");
    expect(svc).toContain("'NOT_CONFIGURED'");
  });
});

// ============================================================================
// 3. UI: distinct messages for migration-missing vs save-failed vs network
// ============================================================================

describe('UserManagementScreen: distinct, honest permission-matrix messages', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');
  const strings = readSrc('shared/i18n/strings.ts');

  it('permissionResultMessage only shows the migration message when migrationMissing is true', () => {
    expect(screen).toContain('function permissionResultMessage');
    const block = screen.slice(screen.indexOf('function permissionResultMessage'), screen.indexOf('function permissionResultMessage') + 600);
    expect(block).toContain('if (res.migrationMissing) return');
  });

  it('a save/reset failure that is NOT migrationMissing falls through to messageForPermissionCodes, never the migration message', () => {
    const block = screen.slice(screen.indexOf('function permissionResultMessage'), screen.indexOf('function permissionResultMessage') + 700);
    expect(block).toContain('if (res.migrationMissing) return');
    expect(block).toContain('messageForPermissionCodes');
  });

  it('a network/config failure shows a distinct network message', () => {
    const block = screen.slice(screen.indexOf('function permissionResultMessage'), screen.indexOf('function permissionResultMessage') + 600);
    expect(block).toContain('um_perm_network_error');
  });

  it('the matrix read path renders its own loadError banner distinct from the migration banner', () => {
    expect(screen).toContain('!migrationMissing && loadError');
  });

  it('readOnly is forced whenever there is no confirmed DB data (migration missing OR any load error)', () => {
    expect(screen).toContain('readOnly = !canManage || migrationMissing || !!loadError');
  });

  it('after a successful save, the matrix reloads from the DB (not from local component state)', () => {
    const onSaveBlock = screen.slice(screen.indexOf('async function onSave'), screen.indexOf('async function onReset'));
    expect(onSaveBlock).toContain('if (!res.ok)');
    expect(onSaveBlock).toContain('eff.reload()');
  });

  it('i18n: migration message is updated to mention verifying the same Supabase project', () => {
    expect(strings).toContain('um_perm_unavailable');
    expect(strings).toContain('نفس مشروع Supabase المستخدم حاليًا');
    expect(strings).toContain('the same Supabase project currently used by the app');
  });

  it('i18n: save-failed message mentions administrator authority / access rules', () => {
    expect(strings).toContain('um_perm_save_failed');
    expect(strings).toContain('تحقق من صلاحية المدير أو قيود الوصول');
    expect(strings).toContain('Check administrator authority or access rules');
  });

  it('i18n: network message mentions the Supabase configuration used by this build', () => {
    expect(strings).toContain('um_perm_network_error');
    expect(strings).toContain('تعذر الاتصال بقاعدة البيانات');
    expect(strings).toContain('Could not connect to the database');
  });
});

// ============================================================================
// 4. Migration 010: real column names, no later-migration count assumption baked in
// ============================================================================

describe('Migration 010: column names and capability are independent of exact permission count', () => {
  const sql = readPhoenix('supabase/migrations/010_phoenix_user_permission_matrix.sql');

  it('role_permission_defaults and profile_permission_overrides use "allowed", never "is_allowed"', () => {
    expect(sql).toContain('allowed        boolean not null default false');
    expect(sql).not.toContain('is_allowed');
  });

  it('get_effective_permissions/assign_profile_permissions/reset_profile_permissions exist and are granted to authenticated', () => {
    expect(sql).toContain('create or replace function get_effective_permissions');
    expect(sql).toContain('create or replace function assign_profile_permissions');
    expect(sql).toContain('create or replace function reset_profile_permissions');
    expect(sql).toContain('grant execute on function get_effective_permissions(uuid) to authenticated');
    expect(sql).toContain('grant execute on function assign_profile_permissions(uuid, jsonb) to authenticated');
    expect(sql).toContain('grant execute on function reset_profile_permissions(uuid) to authenticated');
  });

  it('get_effective_permissions iterates the live permission_keys table — it adapts to however many keys later migrations add', () => {
    const fnBlock = sql.slice(sql.indexOf('function get_effective_permissions'), sql.indexOf('function assign_profile_permissions'));
    expect(fnBlock).toContain('from permission_keys k');
    expect(fnBlock).not.toMatch(/count\(\*\)\s*=\s*32/);
  });
});

// ============================================================================
// 5. Logout/login still uses DB-backed permissions (regression guard from the
//    previous fix — unaffected by this readiness-guard change)
// ============================================================================

describe('AppContext: still loads myPermissions from the DB on every login (unaffected by this fix)', () => {
  const ctx = readSrc('app/AppContext.tsx');

  it('loadPermissions calls getEffectivePermissions and is invoked on every profile load', () => {
    expect(ctx).toContain('getEffectivePermissions');
    expect(ctx).toContain('await loadPermissions(p)');
  });

  it('myPermissions is cleared on signOut (no stale cross-session state)', () => {
    const block = ctx.slice(ctx.indexOf('const signOut'), ctx.indexOf('const signOut') + 400);
    expect(block).toContain('setMyPermissions(new Set())');
  });
});

// ============================================================================
// 6. Security + safety guardrails still hold
// ============================================================================

describe('Permission-matrix guard fix: global guardrails still hold', () => {
  it('no service_role in users.service.ts or UserManagementScreen.tsx', () => {
    const svc = readSrc('shared/supabase/services/users.service.ts');
    const screen = readSrc('features/users/UserManagementScreen.tsx');
    expect(svc).not.toContain('service_role');
    expect(screen).not.toContain('service_role');
  });

  it('no auth.admin in users.service.ts or UserManagementScreen.tsx', () => {
    const svc = readSrc('shared/supabase/services/users.service.ts');
    const screen = readSrc('features/users/UserManagementScreen.tsx');
    expect(svc).not.toMatch(/auth\.admin/);
    expect(screen).not.toMatch(/auth\.admin/);
  });

  it('hard delete button is rendered, gated to super_admin and never self', () => {
    const screen = readSrc('features/users/UserManagementScreen.tsx');
    expect(screen).toContain('deleteTarget');
    expect(screen).toContain('um_delete_user_action');
    expect(screen).toContain('isSuper && !isSelf');
  });

  it('Data Reset still absent', () => {
    const screen = readSrc('features/users/UserManagementScreen.tsx');
    expect(screen).not.toMatch(/import.*DataReset/i);
  });

  it('Intake/OCR/Excel/DocIntel remain disabled', () => {
    const screen = readSrc('features/users/UserManagementScreen.tsx');
    expect(screen).not.toMatch(/import.*OcrImport/i);
    expect(screen).not.toMatch(/import.*ExcelImport/i);
    expect(screen).not.toMatch(/import.*DocIntel/i);
  });
});
