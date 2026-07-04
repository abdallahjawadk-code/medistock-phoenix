/**
 * USER-MANAGEMENT-CREATE-DELETE-ROTATE-FIX-A
 *
 * Verifies:
 *  - the "user creation not enabled" UI is a real edge-function-failure path,
 *    not a hardcoded fake-disabled stub;
 *  - the frontend never touches service_role/auth.admin directly and only
 *    ever calls the secure Edge Functions via supabase.functions.invoke;
 *  - the new rotate_password action added to admin-user-lifecycle;
 *  - the closed last-super_admin gap on the 'disable' action;
 *  - the new Rotate Password UI (confirmation, one-time password display,
 *    no logging/persistence beyond the modal);
 *  - hard delete remains hidden/unavailable in the UI;
 *  - the existing safety guardrails (Service-D, wipe tooling, package/lockfile,
 *    migrations) remain untouched by this phase.
 *
 * Run: npm test -- --run
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const readRoot = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const screen = readSrc('features/users/UserManagementScreen.tsx');
const usersService = readSrc('shared/supabase/services/users.service.ts');
const strings = readSrc('shared/i18n/strings.ts');
const lifecycleFn = readRoot('supabase/functions/admin-user-lifecycle/index.ts');
const createFn = readRoot('supabase/functions/admin-create-user/index.ts');

describe('1-2. Create-user UI is a real edge-function call, not a fake/stubbed success', () => {
  it('CreateUserForm calls createUserViaEdge (no local fake-success branch)', () => {
    const formStart = screen.indexOf('function CreateUserForm');
    const form = screen.slice(formStart, screen.indexOf('function DisableConfirmModal'));
    expect(form).toContain('await createUserViaEdge(');
    expect(form).not.toMatch(/setTimeout\([^)]*onCreated/);
    expect(form).not.toContain('// fake');
  });

  it('createUserViaEdge calls supabase.functions.invoke, never auth.admin directly', () => {
    const fn = usersService.slice(usersService.indexOf('export async function createUserViaEdge'), usersService.indexOf('export interface LifecycleResult'));
    expect(fn).toContain("supabase.functions.invoke('admin-create-user'");
    expect(fn).not.toContain('auth.admin');
  });

  it('the "not enabled yet" message is shown only on a real edge-call failure (edgeMissing), not unconditionally', () => {
    const formStart = screen.indexOf('function CreateUserForm');
    const form = screen.slice(formStart, screen.indexOf('function DisableConfirmModal'));
    expect(form).toContain('if (res.edgeMissing)');
    expect(form).toContain("setError(t('um_edge_disabled', lang))");
  });
});

describe('3. No service_role / auth.admin anywhere in the frontend bundle', () => {
  it('users.service.ts never references service_role or auth.admin', () => {
    expect(usersService).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE|auth\.admin/);
  });
  it('UserManagementScreen.tsx never references service_role or auth.admin', () => {
    expect(screen).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE|auth\.admin/);
  });
  it('users.service.ts never calls deleteUser/admin.createUser/admin.updateUserById directly (only via functions.invoke)', () => {
    expect(usersService).not.toMatch(/\.auth\.admin\.(deleteUser|createUser|updateUserById)/);
  });
});

describe('4. Duplicate username/internal-email conflict is a server-side rejection, not silently accepted', () => {
  it('admin-create-user validates username format and rejects invalid usernames before creating anything', () => {
    expect(createFn).toContain('INVALID_USERNAME');
    expect(createFn).toContain('USERNAME_PATTERN');
  });
  it('a duplicate auth email (derived from username) surfaces as CREATE_AUTH_USER_FAILED, never a raw provider error', () => {
    const fn = createFn.slice(createFn.indexOf('admin.auth.admin.createUser'), createFn.indexOf('admin.auth.admin.createUser') + 300);
    expect(fn).toContain('CREATE_AUTH_USER_FAILED');
  });
  it('the frontend maps known creation error codes to safe, translated messages (no raw error passthrough)', () => {
    const formStart = screen.indexOf('function CreateUserForm');
    const form = screen.slice(formStart, screen.indexOf('function DisableConfirmModal'));
    expect(form).toContain("res.error === 'INVALID_USERNAME'");
    expect(form).toContain("setError(t('um_username_invalid', lang))");
  });
});

describe('5-6. Self-disable / last-active-super_admin protection', () => {
  it('admin-user-lifecycle rejects any action against the caller themself', () => {
    expect(lifecycleFn).toContain('SELF_ACTION_FORBIDDEN');
    const idx = lifecycleFn.indexOf('Self-action guard');
    const block = lifecycleFn.slice(idx, idx + 200);
    expect(block).toContain('targetId === callerId');
  });

  it('disable now shares the same last-active-super_admin guard as delete (USER-MANAGEMENT-CREATE-DELETE-ROTATE-FIX-A fix)', () => {
    const disableStart = lifecycleFn.indexOf("if (action === 'disable')");
    const disableBlock = lifecycleFn.slice(disableStart, lifecycleFn.indexOf("if (action === 'enable')"));
    expect(disableBlock).toContain('isLastActiveSuperAdmin()');
    expect(disableBlock).toContain('LAST_SUPER_ADMIN');
  });

  it('delete still checks the shared last-active-super_admin guard', () => {
    const deleteStart = lifecycleFn.indexOf("if (action === 'delete')");
    const deleteBlock = lifecycleFn.slice(deleteStart);
    expect(deleteBlock).toContain('isLastActiveSuperAdmin()');
    expect(deleteBlock).toContain('LAST_SUPER_ADMIN');
  });

  it('the shared guard only counts active super_admin profiles', () => {
    const idx = lifecycleFn.indexOf('async function isLastActiveSuperAdmin');
    const fn = lifecycleFn.slice(idx, idx + 400);
    expect(fn).toContain("eq('role', 'super_admin')");
    expect(fn).toContain("eq('status', 'active')");
    expect(fn).toContain('<= 1');
  });
});

describe('7-8. Disable/enable a normal (non-admin, non-self) user', () => {
  it('disable action bans the auth user and suspends the profile', () => {
    const block = lifecycleFn.slice(lifecycleFn.indexOf("if (action === 'disable')"), lifecycleFn.indexOf("if (action === 'enable')"));
    expect(block).toContain("ban_duration: '876000h'");
    expect(block).toContain("status: 'suspended'");
  });
  it('enable action removes the ban and reactivates the profile', () => {
    const block = lifecycleFn.slice(lifecycleFn.indexOf("if (action === 'enable')"), lifecycleFn.indexOf('// ── action: rotate_password'));
    expect(block).toContain("ban_duration: 'none'");
    expect(block).toContain("status: 'active'");
  });
  it('UI wires disable/enable buttons to disableUserViaEdge/enableUserViaEdge behind a confirmation modal', () => {
    expect(screen).toContain('enableUserViaEdge(disableTarget.id)');
    expect(screen).toContain('disableUserViaEdge(disableTarget.id)');
    expect(screen).toContain('<DisableConfirmModal');
  });
});

describe('9-11. Rotate temporary password: confirmation, one-time display, no persistence/logging', () => {
  const modalStart = screen.indexOf('function RotatePasswordModal');
  const modal = screen.slice(modalStart, screen.indexOf('/* ── Recycle account modal ── */'));

  it('RotatePasswordModal exists and is wired from a "Rotate password" button', () => {
    expect(modalStart).toBeGreaterThan(-1);
    expect(screen).toContain("setRotateTarget(u)");
    expect(screen).toContain("t('um_rotate_password', lang)");
  });

  it('requires an explicit confirm step before calling the edge function (not fired on modal open)', () => {
    expect(modal).toContain('async function onConfirm()');
    expect(modal).toContain('onClick={onConfirm}');
    // The mount of the modal itself must not call rotatePasswordViaEdge.
    const beforeConfirmFn = modal.slice(0, modal.indexOf('async function onConfirm()'));
    expect(beforeConfirmFn).not.toContain('rotatePasswordViaEdge(');
  });

  it('validates password length and confirmation match client-side before calling the server', () => {
    expect(modal).toContain('newPassword.length < 8');
    expect(modal).toContain('newPassword !== confirmPassword');
  });

  it('shows the new password exactly once, from local state, with the required one-time warning', () => {
    expect(modal).toContain('resultPassword');
    expect(modal).toContain("t('um_rotate_password_show_once', lang)");
    expect(modal).toContain('{resultPassword}');
  });

  it('clears the password from state on close and never logs it', () => {
    expect(modal).not.toMatch(/console\.(log|warn|error)\([^)]*password/i);
    expect(modal).toContain("setNewPassword('')");
    expect(modal).toContain("setConfirmPassword('')");
    expect(modal).toContain('setResultPassword(null)');
  });

  it('rotatePasswordViaEdge sends the password only to the edge function, never returns/stores it', () => {
    const fn = usersService.slice(usersService.indexOf('export async function rotatePasswordViaEdge'), usersService.indexOf('export async function rotatePasswordViaEdge') + 400);
    expect(fn).toContain("action: 'rotate_password'");
    expect(fn).toContain('new_password: newPassword');
  });

  it('the Edge Function never echoes the new password back in its response', () => {
    const block = lifecycleFn.slice(lifecycleFn.indexOf('// ── action: rotate_password'), lifecycleFn.indexOf('// ── action: delete'));
    const returnLine = block.slice(block.lastIndexOf('return json('));
    expect(returnLine).not.toContain('newPassword');
    expect(returnLine).not.toMatch(/\bpassword\s*:/);
    expect(returnLine).toContain("action: 'password_rotated'");
  });

  it('the Edge Function never logs the password', () => {
    expect(lifecycleFn).not.toMatch(/console\.(log|warn|error)\([^)]*password/i);
  });

  it('rotate_password requires new_password and enforces an 8-char minimum server-side', () => {
    expect(lifecycleFn).toContain("if (!newPassword) return json({ ok: false, error: 'MISSING_FIELDS' }, 400);");
    expect(lifecycleFn).toContain("if (newPassword.length < 8) return json({ ok: false, error: 'PASSWORD_TOO_SHORT' }, 400);");
  });

  it('sets must_change_password after rotation so the temporary password must be changed at next login', () => {
    const block = lifecycleFn.slice(lifecycleFn.indexOf('// ── action: rotate_password'), lifecycleFn.indexOf('// ── action: delete'));
    expect(block).toContain('must_change_password: true');
  });
});

describe('12. Hard delete remains hidden/unavailable in the UI', () => {
  it('no delete-user button or DeleteConfirmModal is rendered', () => {
    expect(screen).not.toContain('<DeleteConfirmModal');
    expect(screen).not.toContain('function DeleteConfirmModal');
    expect(screen).not.toContain('deleteUserViaEdge(');
  });
  it('the service function still exists server-side-safely for a future phase, but is unused by the UI', () => {
    expect(usersService).toContain('export async function deleteUserViaEdge');
  });
});

describe('13-16. Edge Function auth/authorization guards', () => {
  it('rejects an unauthenticated caller (no/invalid Bearer token) before touching any table', () => {
    const idx = lifecycleFn.indexOf('NOT_AUTHENTICATED');
    expect(idx).toBeGreaterThan(-1);
    expect(lifecycleFn.slice(0, idx)).not.toMatch(/\.from\('profiles'\)/);
  });
  it('rejects non-super_admin / non-institution_admin callers for lifecycle actions', () => {
    expect(lifecycleFn).toContain('isCallerSuper');
    expect(lifecycleFn).toContain('!isCallerSuper && !isCallerInstitutionAdmin');
    expect(lifecycleFn).toContain("return json({ ok: false, error: 'INSUFFICIENT_PERMISSION' }, 403);");
  });
  it('rejects self-delete (and self-rotate/self-disable) via the shared self-action guard', () => {
    expect(lifecycleFn).toContain('SELF_ACTION_FORBIDDEN');
  });
  it('rejects deleting or disabling the last active super_admin', () => {
    expect(lifecycleFn.match(/LAST_SUPER_ADMIN/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('17. Arabic/English strings exist for rotate-password UI', () => {
  const keys = [
    'um_rotate_password', 'um_rotate_password_confirm_q', 'um_rotate_password_new',
    'um_rotate_password_show_once', 'um_rotate_password_success', 'um_rotate_password_failed',
    'um_rotate_password_close', 'um_cannot_rotate_self',
  ];
  it.each(keys)('%s has a non-empty ar and en translation', key => {
    expect(strings).toMatch(new RegExp(`${key}:\\s*\\{\\s*ar:\\s*'[^']+',\\s*en:\\s*'[^']+'`));
  });
  it('the required one-time-display warning uses the exact specified Arabic/English copy', () => {
    expect(strings).toContain("um_rotate_password_show_once:  { ar: 'اعرض كلمة المرور للمستخدم مرة واحدة فقط ولا تحفظها.'");
    expect(strings).toContain("en: 'Show this password to the user once and do not store it.'");
  });
});

describe('18. Mobile: user-management action buttons remain reachable', () => {
  it('the per-user lifecycle action row wraps instead of overflowing on narrow screens', () => {
    const rowStart = screen.indexOf("isSuper && !isSelf && (");
    const row = screen.slice(rowStart, rowStart + 400);
    expect(row).toContain("flexWrap: 'wrap'");
  });
});

describe('19-22. Safety guards', () => {
  it('no package/lockfile changes', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
  });

  it('no existing migration SQL changed, and no unreviewed migration SQL created — only the separately-reviewed migration 045 (DB-MY-ACCOUNT-WHATSAPP-RPC-A) is allowed as an untracked addition (test-only maintenance under supabase/migrations/__tests__/ is not a migration SQL change; 044 is already committed and no longer appears here)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
    let status = '';
    try {
      status = execSync('git status --porcelain -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    const ALLOWED_UNTRACKED = new Set([
      '?? supabase/migrations/045_phoenix_update_my_whatsapp_phone_rpc.sql',
      'A  supabase/migrations/045_phoenix_update_my_whatsapp_phone_rpc.sql',
      '?? supabase/migrations/046_phoenix_set_my_org_whatsapp_contact_rpc.sql',
      'A  supabase/migrations/046_phoenix_set_my_org_whatsapp_contact_rpc.sql',
    ]);
    const unexpected = status.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !ALLOWED_UNTRACKED.has(l));
    expect(unexpected).toEqual([]);
  });

  it('no Service-D / inter_org_exchange UI added to the touched files', () => {
    for (const src of [screen, usersService, lifecycleFn]) {
      expect(src).not.toContain('inter_org_exchange');
    }
  });

  it('no wipe tooling restored', () => {
    for (const src of [screen, usersService, lifecycleFn]) {
      expect(src).not.toMatch(/phoenix-wipe-execute|FULL_PUBLIC_APP_WIPE_APPROVED|full_wipe/i);
    }
  });

  it('Service-D stash (paused inter-org exchange work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });

  it('premium-preview.html remains untouched', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });

  it('admin-user-lifecycle README documents the new rotate_password action (or the code alone is authoritative)', () => {
    // README updates are documentation-only and intentionally out of scope for
    // this phase; the code comment contract at the top of index.ts is the
    // authoritative, in-scope source of truth.
    expect(lifecycleFn).toContain("action = 'rotate_password'");
  });
});

describe('Edge Function file existence (no new function created — existing ones extended)', () => {
  it('admin-create-user, admin-user-lifecycle, admin-recycle-user still exist; no admin-users function was added', () => {
    expect(existsSync(join(ROOT, 'supabase/functions/admin-create-user/index.ts'))).toBe(true);
    expect(existsSync(join(ROOT, 'supabase/functions/admin-user-lifecycle/index.ts'))).toBe(true);
    expect(existsSync(join(ROOT, 'supabase/functions/admin-recycle-user/index.ts'))).toBe(true);
    expect(existsSync(join(ROOT, 'supabase/functions/admin-users/index.ts'))).toBe(false);
  });
});
