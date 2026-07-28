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
const MIGRATION_147 = readFileSync(
  join(__dirname, '../../../../supabase/migrations/147_phoenix_secure_user_delete_history_guard.sql'),
  'utf8',
);
const SCREEN = readFileSync(
  join(__dirname, '../../../features/users/UserManagementScreen.tsx'),
  'utf8',
);
const STRINGS = readFileSync(
  join(__dirname, '../../i18n/strings.ts'),
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

describe('SECURE-USER-DELETE-HISTORY-GUARD-147: hard delete requires zero operational history', () => {
  it('the Edge Function maps USER_HAS_OPERATIONAL_HISTORY to a distinct 409, not folded into REQUEST_DENIED', () => {
    expect(SOURCE).toContain("case 'USER_HAS_OPERATIONAL_HISTORY': return 409;");
  });

  it('migration 147 extends phoenix_lifecycle_reserve rather than editing 093', () => {
    // 093 itself must remain byte-identical to its original delete-branch shape —
    // this migration only ever CREATE OR REPLACEs the function in a NEW file.
    expect(MIGRATION).not.toContain('USER_HAS_OPERATIONAL_HISTORY');
    expect(MIGRATION_147).toContain('create or replace function public.phoenix_lifecycle_reserve(');
    expect(MIGRATION_147).toContain("'USER_HAS_OPERATIONAL_HISTORY'");
  });

  it('the history check runs inside reserve(), gated to the delete action, before any reservation is persisted', () => {
    const blockIdx = MIGRATION_147.indexOf("if p_action = 'delete' then");
    const historyCheckIdx = MIGRATION_147.indexOf('phoenix_profile_operational_blockers(p_target_id)');
    const reservationInsertIdx = MIGRATION_147.indexOf('insert into public.profile_lifecycle_reservations');
    expect(blockIdx).toBeGreaterThan(-1);
    expect(historyCheckIdx).toBeGreaterThan(blockIdx);
    expect(reservationInsertIdx).toBeGreaterThan(historyCheckIdx);
  });

  it('phoenix_profile_operational_blockers is an internal-only helper, never directly callable by a client role', () => {
    expect(MIGRATION_147).toContain(
      'revoke all on function public.phoenix_profile_operational_blockers(uuid) from authenticated;',
    );
    expect(MIGRATION_147).toContain(
      'revoke all on function public.phoenix_profile_operational_blockers(uuid) from anon;',
    );
    expect(MIGRATION_147).not.toMatch(
      /grant execute on function public\.phoenix_profile_operational_blockers\(uuid\) to (authenticated|anon|public)/,
    );
  });

  it('phoenix_lifecycle_reserve keeps its exact prior grant (authenticated only)', () => {
    expect(MIGRATION_147).toContain(
      'grant execute on function public.phoenix_lifecycle_reserve(uuid,text,uuid) to authenticated;',
    );
    expect(MIGRATION_147).not.toMatch(
      /grant execute on function public\.phoenix_lifecycle_reserve\(uuid,text,uuid\) to (anon|public)/,
    );
  });

  it('a brand-new, never-used account is never blocked by identity/permission-admin bookkeeping alone', () => {
    // Explicitly excluded from the blocker enumeration — see the migration's
    // own header for the full rationale. Checked as "never queried as a
    // blocker source", not as a banned substring, since the header comment
    // legitimately names these tables to explain the exclusion.
    for (const excludedTable of [
      'audit_logs', 'phoenix_notifications', 'phoenix_notification_reads',
      'profile_permission_overrides', 'profile_scope_assignments',
      'user_identity_history', 'profile_lifecycle_reservations',
    ]) {
      expect(MIGRATION_147).not.toContain(`to_regclass('public.${excludedTable}')`);
    }
  });

  it('the frontend shows the specific, translated message and never downgrades it to a generic or EDGE_NOT_DEPLOYED error', () => {
    const modal = SCREEN.slice(SCREEN.indexOf('function DeleteConfirmModal('));
    expect(modal).toContain("res.error === 'USER_HAS_OPERATIONAL_HISTORY'");
    expect(modal).toContain("t('um_delete_has_history', lang)");
    // The specific branch must be reachable before the generic fallback in
    // source order (the general `else` must come after it).
    const specificIdx = modal.indexOf("res.error === 'USER_HAS_OPERATIONAL_HISTORY'");
    const genericIdx = modal.lastIndexOf('} else {');
    expect(genericIdx).toBeGreaterThan(specificIdx);
  });

  it('the modal clarifies delete is only for genuinely unused accounts', () => {
    const modal = SCREEN.slice(SCREEN.indexOf('function DeleteConfirmModal('));
    expect(modal).toContain("t('um_delete_unused_only', lang)");
  });

  it('um_delete_has_history and um_delete_unused_only have non-empty Arabic and English text', () => {
    expect(STRINGS).toMatch(/um_delete_has_history:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'/);
    expect(STRINGS).toMatch(/um_delete_unused_only:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'/);
  });
});
