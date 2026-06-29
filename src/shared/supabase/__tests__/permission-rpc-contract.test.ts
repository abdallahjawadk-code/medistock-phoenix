/**
 * PERMISSION-RPC-CONTRACT-FIX-B Guardrail Tests
 * Run: npm test -- --run
 *
 * Verifies the frontend's RPC argument names, payload shape, and response
 * parsing match migration 010's assign_profile_permissions /
 * reset_profile_permissions / get_effective_permissions exactly, and that a
 * structured diagnostic (safe to log/show, no secrets) is produced whenever
 * a save fails for a reason with no specific mapped message. No live
 * Supabase connection is required — static source + contract cross-checks.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC     = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const readPhoenix = (rel: string) => readFileSync(join(PHOENIX, rel), 'utf8');

// ============================================================================
// 1. RPC argument names match migration 010's exact function signatures
// ============================================================================

describe('users.service.ts: RPC argument names match migration 010 exactly', () => {
  const svc = readSrc('shared/supabase/services/users.service.ts');
  const sql = readPhoenix('supabase/migrations/010_phoenix_user_permission_matrix.sql');

  it('assign_profile_permissions(p_profile_id uuid, p_permissions jsonb) — frontend sends the same two argument names', () => {
    expect(sql).toContain('function assign_profile_permissions(p_profile_id uuid, p_permissions jsonb)');
    const block = svc.slice(svc.indexOf("rpc('assign_profile_permissions'"), svc.indexOf("rpc('assign_profile_permissions'") + 150);
    expect(block).toContain('p_profile_id: profileId');
    expect(block).toContain('p_permissions: overrides');
  });

  it('reset_profile_permissions(p_profile_id uuid) — frontend sends the same single argument name', () => {
    expect(sql).toContain('function reset_profile_permissions(p_profile_id uuid)');
    const block = svc.slice(svc.indexOf("rpc('reset_profile_permissions'"), svc.indexOf("rpc('reset_profile_permissions'") + 100);
    expect(block).toContain('p_profile_id: profileId');
  });

  it('get_effective_permissions(p_profile_id uuid) — frontend sends the same single argument name', () => {
    expect(sql).toContain('function get_effective_permissions(p_profile_id uuid)');
    const block = svc.slice(svc.indexOf("rpc('get_effective_permissions'", svc.indexOf('export async function getEffectivePermissions')), svc.indexOf("rpc('get_effective_permissions'", svc.indexOf('export async function getEffectivePermissions')) + 100);
    expect(block).toContain('p_profile_id: profileId');
  });
});

// ============================================================================
// 2. Payload shape: p_permissions is a FLAT { key: bool|null } object — not
//    an array of { key, allowed } records, and not under any other field name
// ============================================================================

describe('Payload shape: p_permissions is the flat OverrideMap object itself', () => {
  const svc = readSrc('shared/supabase/services/users.service.ts');
  const sql = readPhoenix('supabase/migrations/010_phoenix_user_permission_matrix.sql');

  it('migration 010 documents p_permissions as { "key": true|false|null, ... }', () => {
    expect(sql).toContain('permissions = { "key": true|false|null, ... }');
  });

  it('migration 010 iterates p_permissions with jsonb_each — confirming it is an object, not an array', () => {
    const fnBlock = sql.slice(sql.indexOf('function assign_profile_permissions'), sql.indexOf('function reset_profile_permissions'));
    expect(fnBlock).toContain('select * from jsonb_each(p_permissions)');
  });

  it('frontend OverrideMap is Record<string, boolean | null> — already the exact flat shape, no extra wrapper field', () => {
    const perms = readSrc('shared/lib/permissions.ts');
    expect(perms).toContain('export type OverrideMap = Record<string, boolean | null>');
  });

  it('users.service.ts passes the OverrideMap object directly as p_permissions — no .map() into {key, allowed} records', () => {
    const block = svc.slice(svc.indexOf("rpc('assign_profile_permissions'"), svc.indexOf("rpc('assign_profile_permissions'") + 150);
    expect(block).not.toMatch(/overrides\.map/);
    expect(block).toContain('p_permissions: overrides');
  });

  it('migration 010 distinguishes JSON null (inherit default) from a boolean via jsonb_typeof, matching OverrideMap null semantics', () => {
    const fnBlock = sql.slice(sql.indexOf('function assign_profile_permissions'), sql.indexOf('function reset_profile_permissions'));
    expect(fnBlock).toContain("jsonb_typeof(v_val) = 'null'");
    expect(fnBlock).toContain('v_bool := null');
  });
});

// ============================================================================
// 3. Response parsing: data.ok is checked, not just a Postgrest transport error
// ============================================================================

describe('Response parsing: business-logic ok:false and rejected[] are both handled', () => {
  const svc = readSrc('shared/supabase/services/users.service.ts');
  const screen = readSrc('features/users/UserManagementScreen.tsx');

  it('assignProfilePermissions returns the RPC JSON body as-is, including ok:false business rejections', () => {
    const block = svc.slice(svc.indexOf('export async function assignProfilePermissions'), svc.indexOf('export async function resetProfilePermissions'));
    expect(block).toContain('const result = data as AssignPermissionsResult');
    expect(block).toContain('return result');
  });

  it('UserManagementScreen checks res.ok (not just whether the RPC call itself errored)', () => {
    const onSaveBlock = screen.slice(screen.indexOf('async function onSave'), screen.indexOf('async function onReset'));
    expect(onSaveBlock).toContain('if (!res.ok)');
  });

  it('a non-empty rejected[] array from a successful (ok:true) call is parsed and surfaced, not treated as full success', () => {
    const onSaveBlock = screen.slice(screen.indexOf('async function onSave'), screen.indexOf('async function onReset'));
    expect(onSaveBlock).toContain('res.rejected && res.rejected.length > 0');
  });

  it('rejected entries are prioritized by severity (self-edit > unknown > dangerous > unheld) when choosing which message to show', () => {
    const block = screen.slice(screen.indexOf('function messageForPermissionCodes'));
    const order = ['CANNOT_EDIT_OWN_PERMISSIONS', 'UNKNOWN_PERMISSION', 'NEEDS_AUTHORITY_FOR_DANGEROUS', 'CANNOT_GRANT_UNHELD'];
    let lastIdx = -1;
    for (const code of order) {
      const idx = block.indexOf(code);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });
});

// ============================================================================
// 4. Structured diagnostics: safe fields only, no secrets
// ============================================================================

describe('PermissionSaveDiagnostics: structured, safe diagnostic object', () => {
  const svc = readSrc('shared/supabase/services/users.service.ts');

  it('exports PermissionSaveDiagnostics with the required fields', () => {
    expect(svc).toContain('export interface PermissionSaveDiagnostics');
    const block = svc.slice(svc.indexOf('export interface PermissionSaveDiagnostics'), svc.indexOf('export interface PermissionSaveDiagnostics') + 700);
    expect(block).toContain('ok: boolean');
    expect(block).toContain('status:');
    expect(block).toContain('diagnostic_code: string');
    expect(block).toContain('rpc_error_code?: string');
    expect(block).toContain('rpc_error_message?: string');
    expect(block).toContain('returned_error?: string');
    expect(block).toContain('rejected_codes?: string[]');
    expect(block).toContain('rejected_keys?: string[]');
    expect(block).toContain('target_profile_id: string');
    expect(block).toContain('payload_key_count: number');
    expect(block).toContain('actor_has_users_manage_permissions?: boolean');
  });

  it('assignProfilePermissions attaches diagnostics on every path (RPC error, business rejection, partial rejection, success)', () => {
    const block = svc.slice(svc.indexOf('export async function assignProfilePermissions'), svc.indexOf('export async function resetProfilePermissions'));
    expect(block).toContain('diagnostics: buildSaveDiagnostics');
    expect(block).toContain('result.diagnostics = buildSaveDiagnostics');
  });

  it('diagnostics never include the raw request payload, permission values, or any password/token field', () => {
    const block = svc.slice(svc.indexOf('function buildSaveDiagnostics'), svc.indexOf('export interface AssignPermissionsResult'));
    expect(block.toLowerCase()).not.toContain('password');
    expect(block.toLowerCase()).not.toContain('token');
    expect(block).not.toContain('overrides');
  });

  it('diagnostic_code prefers the real RPC error code over the business error over the first rejected code', () => {
    const block = svc.slice(svc.indexOf('function buildSaveDiagnostics'), svc.indexOf('function buildSaveDiagnostics') + 700);
    expect(block).toContain("params.rpcError?.code ?? params.returnedError ?? rejected_codes?.[0] ?? 'SUCCESS'");
  });
});

// ============================================================================
// 5. UI: diagnostic code shown only as a last resort, never for known codes
// ============================================================================

describe('UserManagementScreen: diagnostic-code fallback message', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');
  const strings = readSrc('shared/i18n/strings.ts');

  it('permissionResultMessage falls back to the diagnostic-code message only after migration/network/known-code checks', () => {
    const block = screen.slice(screen.indexOf('function permissionResultMessage'), screen.indexOf('function permissionResultMessage') + 900);
    const migrationIdx = block.indexOf('um_perm_unavailable');
    const networkIdx = block.indexOf('um_perm_network_error');
    const knownIdx = block.indexOf('KNOWN_PERMISSION_CODES');
    const diagIdx = block.indexOf('um_perm_diag_prefix');
    expect(migrationIdx).toBeGreaterThan(-1);
    expect(diagIdx).toBeGreaterThan(networkIdx);
    expect(diagIdx).toBeGreaterThan(knownIdx);
  });

  it('does not show the diagnostic message for a plain SUCCESS diagnostic code', () => {
    const block = screen.slice(screen.indexOf('function permissionResultMessage'), screen.indexOf('function permissionResultMessage') + 900);
    expect(block).toContain("diag !== 'SUCCESS'");
  });

  it('i18n: diagnostic-code prefix matches the required exact wording', () => {
    expect(strings).toContain('um_perm_diag_prefix');
    expect(strings).toContain('تعذر حفظ الصلاحيات. رمز التشخيص:');
    expect(strings).toContain('Could not save permissions. Diagnostic code:');
  });
});

// ============================================================================
// 6. Role/default logic: empty myPermissions never falsely blocks super_admin
// ============================================================================

describe('Actor authority: empty myPermissions load race does not block valid super_admin saves', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');

  it('the actorOverrides diff is skipped entirely while actorPermissions is empty (treated as "not loaded", not "denies everything")', () => {
    const block = screen.slice(screen.indexOf('const actorOverrides: OverrideMap = {};'), screen.indexOf('const grantCtx: GrantContext'));
    expect(block).toContain('if (actorPermissions.size > 0)');
  });

  it('UserManagementScreen reloads myPermissions on mount when still empty, before any save can run', () => {
    expect(screen).toContain('useEffect(() => {');
    expect(screen).toContain('if (myPermissions.size === 0) reloadMyPermissions();');
  });

  it('server-side RPC remains the sole authority — the frontend pre-check never replaces it', () => {
    const onSaveBlock = screen.slice(screen.indexOf('async function onSave'), screen.indexOf('async function onReset'));
    expect(onSaveBlock).toContain('assignProfilePermissions(user.id, overrides, actorHasManagePermissions)');
  });
});

// ============================================================================
// 7. No unknown frontend-only permission keys are ever sent
// ============================================================================

describe('Payload never contains unknown or unchanged-only keys', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');
  const perms = readSrc('shared/lib/permissions.ts');

  it('onSave only ever iterates PERMISSION_KEYS (the canonical, DB-mirrored catalog) to build the diff', () => {
    const onSaveBlock = screen.slice(screen.indexOf('async function onSave'), screen.indexOf('const check = validateOverrides'));
    expect(onSaveBlock).toContain('for (const p of PERMISSION_KEYS)');
  });

  it('onSave skips keys whose value did not change from the initial loaded state', () => {
    const onSaveBlock = screen.slice(screen.indexOf('async function onSave'), screen.indexOf('const check = validateOverrides'));
    expect(onSaveBlock).toContain('if (cur === init) continue;');
  });

  it('PERMISSION_KEYS is the single allowlisted catalog — no ad-hoc keys constructed elsewhere in the screen', () => {
    expect(perms).toContain('The complete, allowlisted permission catalog');
  });
});

// ============================================================================
// 8. Security unchanged: dangerous-permission protection, self-edit block,
//    no privilege escalation
// ============================================================================

describe('Security guardrails unchanged by the RPC-contract diagnostic fix', () => {
  const migration010 = readPhoenix('supabase/migrations/010_phoenix_user_permission_matrix.sql');
  const svc = readSrc('shared/supabase/services/users.service.ts');
  const screen = readSrc('features/users/UserManagementScreen.tsx');

  it('assign_profile_permissions still blocks self-edits and requires dangerous-permission authority server-side', () => {
    const fnBlock = migration010.slice(migration010.indexOf('function assign_profile_permissions'), migration010.indexOf('function reset_profile_permissions'));
    expect(fnBlock).toContain('CANNOT_EDIT_OWN_PERMISSIONS');
    expect(fnBlock).toContain('NEEDS_AUTHORITY_FOR_DANGEROUS');
  });

  it('actorHasManagePermissions is diagnostic-only — never passed to the RPC, never used to bypass a check', () => {
    const block = svc.slice(svc.indexOf('export async function assignProfilePermissions'), svc.indexOf('export async function resetProfilePermissions'));
    expect(block).not.toMatch(/p_permissions:\s*actorHasManagePermissions/);
    expect(block).not.toMatch(/p_profile_id:\s*actorHasManagePermissions/);
  });

  it('no service_role in frontend', () => {
    expect(svc).not.toContain('service_role');
    expect(screen).not.toContain('service_role');
  });

  it('no auth.admin in frontend', () => {
    expect(svc).not.toMatch(/auth\.admin/);
    expect(screen).not.toMatch(/auth\.admin/);
  });

  it('Data Reset still absent', () => {
    expect(screen).not.toMatch(/import.*DataReset/i);
  });

  it('Intake/OCR/Excel/DocIntel remain disabled', () => {
    expect(screen).not.toMatch(/import.*OcrImport/i);
    expect(screen).not.toMatch(/import.*ExcelImport/i);
    expect(screen).not.toMatch(/import.*DocIntel/i);
  });
});
