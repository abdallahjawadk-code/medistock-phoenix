/**
 * PERMISSION-SAVE-RPC-DIAGNOSTIC-FIX-A Guardrail Tests
 * Run: npm test -- --run
 *
 * Verifies that permission-save failures surface a SPECIFIC, safe reason
 * (self-edit, unheld permission, unauthorized-dangerous, unknown key)
 * instead of the generic "Check administrator authority or access rules"
 * message that PERMISSION-MATRIX-010-GUARD-FIX-A introduced as a catch-all.
 * Also verifies the actor-permissions race guard and RPC diagnostic
 * logging. No live Supabase connection is required — static source checks.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC     = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const readPhoenix = (rel: string) => readFileSync(join(PHOENIX, rel), 'utf8');

// ============================================================================
// 1. Specific safe messages replace the generic catch-all
// ============================================================================

describe('UserManagementScreen: messageForPermissionCodes maps each known error to a specific message', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');
  const strings = readSrc('shared/i18n/strings.ts');

  it('CANNOT_EDIT_OWN_PERMISSIONS / SELF_ESCALATION map to the self-edit-blocked message', () => {
    const block = screen.slice(screen.indexOf('function messageForPermissionCodes'));
    expect(block).toContain("'CANNOT_EDIT_OWN_PERMISSIONS', 'SELF_ESCALATION'");
    expect(block).toContain('um_perm_self_edit_blocked');
  });

  it('UNKNOWN_PERMISSION maps to the unknown-key message', () => {
    const block = screen.slice(screen.indexOf('function messageForPermissionCodes'));
    expect(block).toContain("'UNKNOWN_PERMISSION'");
    expect(block).toContain('um_perm_unknown_key');
  });

  it('NEEDS_AUTHORITY_FOR_DANGEROUS maps to the dangerous-unauthorized message', () => {
    const block = screen.slice(screen.indexOf('function messageForPermissionCodes'));
    expect(block).toContain("'NEEDS_AUTHORITY_FOR_DANGEROUS'");
    expect(block).toContain('um_perm_dangerous_unauthorized');
  });

  it('CANNOT_GRANT_UNHELD maps to the unheld-permission message', () => {
    const block = screen.slice(screen.indexOf('function messageForPermissionCodes'));
    expect(block).toContain("'CANNOT_GRANT_UNHELD'");
    expect(block).toContain('um_perm_unheld');
  });

  it('an unrecognized code still falls back to the generic save-failed message (never silent, never wrong)', () => {
    const block = screen.slice(screen.indexOf('function messageForPermissionCodes'));
    expect(block).toContain("return t('um_perm_save_failed', lang)");
  });

  it('i18n has all four new specific messages in Arabic and English with the exact required wording', () => {
    expect(strings).toContain('um_perm_self_edit_blocked');
    expect(strings).toContain('لا يمكنك تعديل صلاحيات حسابك الحالي.');
    expect(strings).toContain('You cannot edit permissions for your current account.');

    expect(strings).toContain('um_perm_unheld');
    expect(strings).toContain('لا يمكنك منح صلاحية لا تملكها.');
    expect(strings).toContain('You cannot grant a permission you do not have.');

    expect(strings).toContain('um_perm_dangerous_unauthorized');
    expect(strings).toContain('لا يمكنك منح صلاحية خطرة بدون تخويل.');
    expect(strings).toContain('You cannot grant a dangerous permission without authority.');

    expect(strings).toContain('um_perm_unknown_key');
    expect(strings).toContain('توجد صلاحية غير معروفة أو غير مسجلة في قاعدة البيانات.');
    expect(strings).toContain('One permission is unknown or not registered in the database.');
  });
});

// ============================================================================
// 2. Both the client pre-check AND the server RPC route through the same
//    specific-message mapping
// ============================================================================

describe('UserManagementScreen: client pre-check and server RPC rejections both get specific messages', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');

  it('the client-side validateOverrides rejection maps codes via messageForPermissionCodes (not a single generic toast)', () => {
    const onSaveBlock = screen.slice(screen.indexOf('async function onSave'), screen.indexOf('async function onReset'));
    expect(onSaveBlock).toContain('const check = validateOverrides(grantCtx, overrides)');
    expect(onSaveBlock).toContain('messageForPermissionCodes(check.rejected.map(r => r.error), lang)');
  });

  it('a per-key server rejection (res.rejected non-empty) is surfaced, never silently reported as "saved"', () => {
    const onSaveBlock = screen.slice(screen.indexOf('async function onSave'), screen.indexOf('async function onReset'));
    expect(onSaveBlock).toContain('res.rejected && res.rejected.length > 0');
    expect(onSaveBlock).toContain('messageForPermissionCodes(res.rejected.map(r => r.error), lang)');
  });

  it('a top-level RPC failure (res.ok === false) is mapped through permissionResultMessage, not a bare generic toast', () => {
    const onSaveBlock = screen.slice(screen.indexOf('async function onSave'), screen.indexOf('async function onReset'));
    expect(onSaveBlock).toContain('if (!res.ok)');
    expect(onSaveBlock).toContain("permissionResultMessage(res, lang, 'um_saved')");
  });

  it('only a true "saved with nothing rejected" outcome shows the plain success toast', () => {
    const onSaveBlock = screen.slice(screen.indexOf('async function onSave'), screen.indexOf('async function onReset'));
    expect(onSaveBlock).toContain("onToast(t('um_saved', lang))");
  });
});

// ============================================================================
// 3. Actor-permissions race guard: never diff against an empty Set
// ============================================================================

describe('PermissionMatrix: actorOverrides diff is skipped when actorPermissions has not loaded yet', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');

  it('guards the diff behind actorPermissions.size > 0', () => {
    const block = screen.slice(screen.indexOf('const actorOverrides: OverrideMap = {};'), screen.indexOf('const grantCtx: GrantContext'));
    expect(block).toContain('if (actorPermissions.size > 0)');
  });

  it('an empty actorPermissions Set produces an empty actorOverrides (falls back to pure role defaults, never "deny everything")', () => {
    const block = screen.slice(screen.indexOf('const actorOverrides: OverrideMap = {};'), screen.indexOf('const grantCtx: GrantContext'));
    // The diff loop must be nested inside the size > 0 guard, not run unconditionally.
    const guardIdx = block.indexOf('if (actorPermissions.size > 0)');
    const loopIdx = block.indexOf('for (const p of PERMISSION_KEYS)');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(guardIdx);
  });

  it('UserManagementScreen proactively reloads myPermissions on mount if it is still empty (load-race guard)', () => {
    expect(screen).toContain('if (myPermissions.size === 0) reloadMyPermissions();');
  });
});

// ============================================================================
// 4. Diagnostics: real Postgrest error fields are preserved (dev-only), never shown raw to users
// ============================================================================

describe('users.service.ts: RPC error diagnostics are captured safely', () => {
  const svc = readSrc('shared/supabase/services/users.service.ts');

  it('logRpcDiagnostic captures code/message/details/hint — never the request payload', () => {
    expect(svc).toContain('function logRpcDiagnostic');
    const block = svc.slice(svc.indexOf('function logRpcDiagnostic'), svc.indexOf('function logRpcDiagnostic') + 400);
    expect(block).toContain('error.code');
    expect(block).toContain('error.message');
    expect(block).toContain('error.details');
    expect(block).toContain('error.hint');
  });

  it('logRpcDiagnostic is called for assign/reset/get_effective_permissions on a real (non-migration-missing) RPC failure', () => {
    expect(svc).toContain("logRpcDiagnostic('get_effective_permissions', error)");
    expect(svc).toContain("logRpcDiagnostic('assign_profile_permissions', error)");
    expect(svc).toContain("logRpcDiagnostic('reset_profile_permissions', error)");
  });

  it('rejected permission keys are logged for diagnosis (catalog-mismatch visibility) without blocking the response', () => {
    expect(svc).toContain('assign_profile_permissions rejected keys');
  });

  it('diagnostic logging never references password fields', () => {
    const block = svc.slice(svc.indexOf('function logRpcDiagnostic'), svc.indexOf('function logRpcDiagnostic') + 400);
    expect(block.toLowerCase()).not.toContain('password');
  });
});

// ============================================================================
// 5. Security preserved: dangerous-permission protections, self-edit block,
//    institution_admin scope — unchanged by this diagnostic/message fix
// ============================================================================

describe('Security guardrails unchanged: anti-escalation protections still enforced server-side', () => {
  const migration010 = readPhoenix('supabase/migrations/010_phoenix_user_permission_matrix.sql');
  const migration015 = readPhoenix('supabase/migrations/015_phoenix_user_account_recycling.sql');
  const perms = readSrc('shared/lib/permissions.ts');

  it('assign_profile_permissions still blocks self-permission edits unconditionally', () => {
    const fnBlock = migration010.slice(migration010.indexOf('function assign_profile_permissions'), migration010.indexOf('function reset_profile_permissions'));
    expect(fnBlock).toContain("p_profile_id = v_actor");
    expect(fnBlock).toContain('CANNOT_EDIT_OWN_PERMISSIONS');
  });

  it('assign_profile_permissions still requires the actor to hold a dangerous permission before granting it', () => {
    const fnBlock = migration010.slice(migration010.indexOf('function assign_profile_permissions'), migration010.indexOf('function reset_profile_permissions'));
    expect(fnBlock).toContain('is_dangerous');
    expect(fnBlock).toContain('NEEDS_AUTHORITY_FOR_DANGEROUS');
  });

  it('assign_profile_permissions still scopes institution_admin (non-super) to their own org', () => {
    const fnBlock = migration010.slice(migration010.indexOf('function assign_profile_permissions'), migration010.indexOf('function reset_profile_permissions'));
    expect(fnBlock).toContain('OUT_OF_SCOPE');
    expect(fnBlock).toContain('v_target_org is distinct from v_org');
  });

  it('users.recycle remains dangerous and super_admin-only by default', () => {
    expect(perms).toContain("key: 'users.recycle'");
    const block = perms.slice(perms.indexOf("key: 'users.recycle'"), perms.indexOf("key: 'users.recycle'") + 200);
    expect(block).toContain('dangerous: true');
    expect(migration015).toContain("'super_admin', 'users.recycle', true");
  });

  it('client-side canActorSetPermission still blocks self-escalation and unheld dangerous grants', () => {
    expect(perms).toContain('SELF_ESCALATION');
    expect(perms).toContain('NEEDS_AUTHORITY_FOR_DANGEROUS');
    expect(perms).toContain('CANNOT_GRANT_UNHELD');
  });
});

// ============================================================================
// 6. Global guardrails still hold
// ============================================================================

describe('Permission-save diagnostic fix: global guardrails still hold', () => {
  const svc = readSrc('shared/supabase/services/users.service.ts');
  const screen = readSrc('features/users/UserManagementScreen.tsx');

  it('no service_role in frontend', () => {
    expect(svc).not.toContain('service_role');
    expect(screen).not.toContain('service_role');
  });

  it('no auth.admin in frontend', () => {
    expect(svc).not.toMatch(/auth\.admin/);
    expect(screen).not.toMatch(/auth\.admin/);
  });

  it('hard delete button is rendered, gated to super_admin and never self', () => {
    expect(screen).toContain('deleteTarget');
    expect(screen).toContain('um_delete_user_action');
    expect(screen).toContain('isSuper && !isSelf');
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

// ============================================================================
// 7. Logout/login persistence (from the prior fix) remains intact
// ============================================================================

describe('AppContext: logout/login DB-backed permission loading remains intact', () => {
  const ctx = readSrc('app/AppContext.tsx');

  it('still loads myPermissions via getEffectivePermissions on every profile load', () => {
    expect(ctx).toContain('getEffectivePermissions');
    expect(ctx).toContain('await loadPermissions(p)');
  });

  it('still clears myPermissions on signOut', () => {
    const block = ctx.slice(ctx.indexOf('const signOut'), ctx.indexOf('const signOut') + 400);
    expect(block).toContain('setMyPermissions(new Set())');
  });

  it('still exposes reloadMyPermissions for on-demand refresh', () => {
    expect(ctx).toContain('reloadMyPermissions');
  });
});
