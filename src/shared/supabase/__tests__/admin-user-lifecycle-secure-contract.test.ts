import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(
  join(__dirname, '../../../../supabase/functions/admin-user-lifecycle/index.ts'),
  'utf8',
);
const RECYCLE_SOURCE = readFileSync(
  join(__dirname, '../../../../supabase/functions/admin-recycle-user/index.ts'),
  'utf8',
);
const MIGRATION = readFileSync(
  join(__dirname, '../../../../supabase/migrations/093_phoenix_super_admin_lifecycle_guard.sql'),
  'utf8',
);
const SCREEN = readFileSync(
  join(__dirname, '../../../features/users/UserManagementScreen.tsx'),
  'utf8',
);
const SERVICE = readFileSync(
  join(__dirname, '../services/users.service.ts'),
  'utf8',
);

describe('admin-user-lifecycle / admin-recycle-user secure lifecycle contract (SECURE-USER-LIFECYCLE-PRODUCTION-A)', () => {
  it('the delete confirmation phrase embeds the target user id, never the Auth email', () => {
    expect(SOURCE).toContain('confirmation !== `DELETE_USER_${targetId}`');
    expect(SOURCE).not.toContain('targetEmail');
    expect(SOURCE).not.toContain('admin.auth.admin.getUserById');
  });

  it('delete confirmation is checked only after the atomic reserve/authorize step passes', () => {
    const reserveIdx = SOURCE.indexOf("caller.rpc('phoenix_lifecycle_reserve'");
    const deleteBlockStart = SOURCE.indexOf("if (action === 'delete')");
    const confirmIdx = SOURCE.indexOf('confirmation !== `DELETE_USER_${targetId}`');
    expect(deleteBlockStart).toBeGreaterThan(-1);
    expect(confirmIdx).toBeGreaterThan(reserveIdx);
    // The reserve call inside the delete branch precedes the confirmation check.
    const deleteReserveIdx = SOURCE.indexOf("caller.rpc('phoenix_lifecycle_reserve'", deleteBlockStart);
    expect(confirmIdx).toBeGreaterThan(deleteReserveIdx);
  });

  it('a confirmation mismatch compensates the reservation instead of leaving the target suspended', () => {
    const confirmIdx = SOURCE.indexOf('confirmation !== `DELETE_USER_${targetId}`');
    const nextCompensate = SOURCE.indexOf("phoenix_lifecycle_compensate", confirmIdx);
    const invalidReturn = SOURCE.indexOf("'INVALID_CONFIRMATION'", confirmIdx);
    expect(nextCompensate).toBeGreaterThan(confirmIdx);
    expect(invalidReturn).toBeGreaterThan(nextCompensate);
  });

  it('self-action (disable/delete/enable/rotate) is denied server-side in the atomic contract', () => {
    expect(MIGRATION).toContain("p_target_id = v_actor");
    expect(MIGRATION).toContain("'self_action'");
    // Present in reserve (disable/delete), enable, and authorize_rotation.
    const selfActionCount = (MIGRATION.match(/p_target_id = v_actor/g) ?? []).length;
    expect(selfActionCount).toBeGreaterThanOrEqual(3);
  });

  it('the last active super_admin can never be disabled or deleted', () => {
    expect(MIGRATION).toContain("'LAST_SUPER_ADMIN'");
    expect(MIGRATION).toContain("v_active_sa <= 1");
    expect(SOURCE).toContain("case 'LAST_SUPER_ADMIN': return 403;");
  });

  it('hard delete is forbidden for institution_admin at the contract level, not just the UI', () => {
    expect(MIGRATION).toContain("'delete_forbidden_for_role'");
  });

  it('institution_admin scope is re-derived server-side: own org only, never a platform-managed role', () => {
    expect(MIGRATION).toContain("'target_platform_managed'");
    expect(MIGRATION).toContain("'cross_org'");
  });

  it('a failed Auth Admin ban compensates the reservation back to its prior state', () => {
    const disableBlock = SOURCE.slice(SOURCE.indexOf("action === 'disable'"), SOURCE.indexOf("action === 'delete'"));
    expect(disableBlock).toContain('banErr');
    expect(disableBlock).toContain("phoenix_lifecycle_compensate");
  });

  it('a failed Auth Admin delete compensates the reservation instead of leaving a half-deleted account', () => {
    const deleteBlock = SOURCE.slice(SOURCE.indexOf("action === 'delete'"));
    expect(deleteBlock).toContain('deleteErr');
    const deleteErrIdx = deleteBlock.indexOf('if (deleteErr)');
    const compIdx = deleteBlock.indexOf('phoenix_lifecycle_compensate', deleteErrIdx);
    expect(compIdx).toBeGreaterThan(deleteErrIdx);
  });

  it('password rotation forces must_change_password and revokes prior sessions', () => {
    expect(MIGRATION).toContain('must_change_password = true');
    expect(SOURCE).toContain('must_change_password: true');
    expect(SOURCE).toContain("signOut(targetId, 'global')");
    expect(SOURCE).toContain('sessions_revoked');
  });

  it('recycle also forces must_change_password for local-mode accounts', () => {
    expect(MIGRATION).toContain("must_change_password = (p_login_mode = 'local')");
  });

  it('never logs or echoes back a password or the service key', () => {
    // \bpassword\b (not [a-z_]*password*) deliberately excludes the safe
    // `must_change_password` flag name, which is a boolean, never a secret.
    for (const src of [SOURCE, RECYCLE_SOURCE]) {
      expect(src).not.toMatch(/console\.(?:log|info|warn|error)\([^)]*\bpassword\b/i);
      expect(src).not.toMatch(/json\(\{[^}]*\bpassword\s*:/i);
      expect(src).not.toMatch(/console\.(?:log|info|warn|error)\([^)]*serviceKey/i);
    }
  });

  it('the delete confirmation phrase is constructible from data already in the user list (no extra fetch)', () => {
    // ManagedUser (from listUsers) already carries `id` — the UI never needs
    // to fetch the target's Auth email to build DELETE_USER_<id>.
    expect(SCREEN).toContain('DELETE_USER_${user.id}');
  });

  it('the delete flow surfaces translated errors with a correlation id and blocks repeat submits while busy', () => {
    const modal = SCREEN.slice(
      SCREEN.indexOf('function DeleteConfirmModal('),
    );
    expect(modal).toContain('canSubmit = confirm === expectedConfirm && !busy');
    expect(modal).toContain('withSupportRef(');
    expect(modal).toContain("res.error === 'LAST_SUPER_ADMIN'");
    expect(modal).toContain("res.error === 'INVALID_CONFIRMATION'");
  });

  it('deleteUserViaEdge passes the id-based confirmation through untouched', () => {
    expect(SERVICE).toContain(
      "export async function deleteUserViaEdge(targetUserId: string, confirmation: string): Promise<LifecycleResult> {",
    );
    expect(SERVICE).toContain("invokeLifecycle({ action: 'delete', target_user_id: targetUserId, confirmation });");
  });
});
