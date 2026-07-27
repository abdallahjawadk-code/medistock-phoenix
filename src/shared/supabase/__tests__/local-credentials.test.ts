/**
 * LOCAL-CREDENTIALS-MODE-A Guardrail Tests
 * Run: npm test -- --run
 *
 * Verifies the local username + password credentials mode without requiring
 * a real DB connection: migration 016 shape/safety, Edge Function contracts,
 * frontend services, login resolution, and security guardrails (no
 * service_role/auth.admin in frontend, no password storage/logging/return).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SRC     = join(__dirname, '../../../');    // → phoenix/src/
const PHOENIX = join(__dirname, '../../../../'); // → phoenix/

function readSrc(rel: string) {
  return readFileSync(join(SRC, rel), 'utf8');
}
function readPhoenix(rel: string) {
  return readFileSync(join(PHOENIX, rel), 'utf8');
}
function readSql(rel: string) {
  return readPhoenix(join('supabase', rel));
}
function allTsxFiles(dir: string): string[] {
  const base = join(SRC, dir);
  return readdirSync(base, { recursive: true })
    .filter((f): f is string =>
      typeof f === 'string' &&
      (f.endsWith('.ts') || f.endsWith('.tsx')) &&
      !f.includes('__tests__') &&
      !f.endsWith('.test.ts') &&
      !f.endsWith('.spec.ts'))
    .map(f => join(base, f));
}
function readFile(path: string) {
  return readFileSync(path, 'utf8');
}

// ============================================================================
// 1. MIGRATION 016: shape, safety, idempotency
// ============================================================================

describe('Migration 016: local credentials mode', () => {
  const sql = readSql('migrations/016_phoenix_local_credentials_mode.sql');

  it('file exists and is non-empty', () => {
    expect(sql.length).toBeGreaterThan(500);
  });

  it('is manual-apply-only', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('DO NOT use');
    expect(sql).toContain('supabase db push');
  });

  it('has no DROP or TRUNCATE statements', () => {
    expect(sql).not.toMatch(/^\s*(drop table|drop function|truncate)\b/im);
  });

  it('adds the five new profiles columns using IF NOT EXISTS (idempotent)', () => {
    ['username', 'login_mode', 'contact_email', 'must_change_password', 'password_changed_at'].forEach(col => {
      expect(sql).toMatch(new RegExp(`add column if not exists ${col}`, 'i'));
    });
  });

  it('login_mode defaults to email (no automatic migration of existing users)', () => {
    expect(sql).toContain("login_mode text NOT NULL DEFAULT 'email'");
  });

  it('must_change_password defaults to false', () => {
    expect(sql).toContain('must_change_password boolean NOT NULL DEFAULT false');
  });

  it('adds a case-insensitive unique index on username, excluding NULLs', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_unique_idx');
    expect(sql).toContain('lower(username)');
    expect(sql).toContain('WHERE username IS NOT NULL');
  });

  it('adds a username format CHECK constraint (3-32 chars, lowercase/digits/dot/underscore/dash)', () => {
    expect(sql).toContain('profiles_username_format_chk');
    expect(sql).toContain("username ~ '^[a-z0-9._-]{3,32}\$'");
  });

  it('adds a login_mode value CHECK constraint', () => {
    expect(sql).toContain('profiles_login_mode_chk');
    expect(sql).toContain("login_mode IN ('email', 'local')");
  });

  it('constraint guards are idempotent (checked via pg_constraint before adding)', () => {
    expect(sql).toContain('pg_constraint');
  });

  it('creates phoenix_mark_password_changed() as SECURITY DEFINER, scoped to auth.uid()', () => {
    expect(sql).toContain('phoenix_mark_password_changed');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('auth.uid()');
  });

  it('phoenix_mark_password_changed() is granted to authenticated only', () => {
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION phoenix_mark_password_changed() TO authenticated');
    expect(sql).not.toContain('TO anon');
  });

  it('does not modify auth.users', () => {
    expect(sql).not.toMatch(/\b(insert|update|delete)\b.*auth\.users/i);
  });

  it('does not migrate existing users to local mode automatically', () => {
    expect(sql.toLowerCase()).toContain('does not migrate any existing user to local mode');
  });

  it('does not reference service_role', () => {
    expect(sql).not.toContain('service_role');
    expect(sql).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('does not add a new permission key (documents reuse of users.create/users.recycle)', () => {
    expect(sql).not.toContain('permission_keys');
    expect(sql.toLowerCase()).toContain('does not add a new permission key');
  });

  it('includes a verification block', () => {
    expect(sql.toLowerCase()).toContain('verify');
    expect(sql).toContain('ASSERT');
  });
});

// ============================================================================
// 2. USERNAME UTILITY: single source of truth for the synthetic email mapping
// ============================================================================

describe('Username utility: src/shared/lib/username.ts', () => {
  const src = readSrc('shared/lib/username.ts');

  it('uses the non-deliverable .invalid domain', () => {
    expect(src).toContain('local.medistock.invalid');
  });

  it('exports normalizeUsername, validateUsername, localUsernameToAuthEmail, resolveLoginIdentifier', () => {
    expect(src).toContain('export function normalizeUsername');
    expect(src).toContain('export function validateUsername');
    expect(src).toContain('export function localUsernameToAuthEmail');
    expect(src).toContain('export function resolveLoginIdentifier');
  });

  it('does not reference service_role or auth.admin', () => {
    expect(src).not.toContain('service_role');
    expect(src).not.toMatch(/auth\.admin/);
  });
});

// ============================================================================
// 3. LOGIN SCREEN: username-or-email, no profile probing, generic error
// ============================================================================

describe('LoginScreen: username-or-email login (no profile probing)', () => {
  const login = readSrc('features/auth/LoginScreen.tsx');
  const strings = readSrc('shared/i18n/strings.ts');

  it('uses resolveLoginIdentifier to map bare usernames to the synthetic email', () => {
    expect(login).toContain('resolveLoginIdentifier');
  });

  it('does not query profiles before authenticating', () => {
    expect(login).not.toContain("from('profiles')");
  });

  it('does not call auth.admin or reference service_role', () => {
    expect(login).not.toMatch(/auth\.admin/);
    expect(login).not.toContain('service_role');
  });

  it('shows a generic invalid-credentials error (never reveals which usernames exist)', () => {
    expect(login).toContain('invalid_creds');
  });

  it('i18n has bilingual username-or-email login label', () => {
    expect(strings).toContain('login_identifier');
    expect(strings).toContain('اسم المستخدم أو البريد الإلكتروني');
    expect(strings).toContain('Username or email');
  });

  it('i18n generic error mentions username (not just email)', () => {
    expect(strings).toContain('اسم المستخدم أو كلمة المرور غير صحيحة');
    expect(strings).toContain('Invalid username or password');
  });

  it('forgot-password flow shows a local-account note instead of calling the reset API for bare usernames', () => {
    expect(login).toContain('localResetNote');
    expect(login).toContain('login_local_reset_note');
  });

  it('i18n has the bilingual local forgot-password note (ask admin for a temporary password)', () => {
    expect(strings).toContain('login_local_reset_note');
    expect(strings).toContain('اطلب من مسؤول المؤسسة');
    expect(strings).toContain('ask your institution administrator');
  });
});

// ============================================================================
// 4. AUTH SERVICE: extended Profile type + password-changed RPC
// ============================================================================

describe('auth.service.ts: local credentials fields + markPasswordChanged', () => {
  const auth = readSrc('shared/supabase/services/auth.service.ts');

  it('Profile includes username, login_mode, contact_email, must_change_password', () => {
    expect(auth).toContain('username: string | null');
    expect(auth).toContain("login_mode: 'email' | 'local'");
    expect(auth).toContain('contact_email: string | null');
    expect(auth).toContain('must_change_password: boolean');
  });

  it('getMyProfile selects the new columns', () => {
    expect(auth).toContain('username, login_mode, contact_email, must_change_password');
  });

  it('exports markPasswordChanged calling the RPC (never a raw profiles update)', () => {
    expect(auth).toContain('export async function markPasswordChanged');
    expect(auth).toContain("supabase.rpc('phoenix_mark_password_changed')");
  });

  it('still uses signInWithPassword only (no admin API)', () => {
    expect(auth).toContain('signInWithPassword');
    expect(auth).not.toContain('admin.');
    expect(auth).not.toContain('service_role');
  });
});

// ============================================================================
// 5. MY ACCOUNT: shows username for local users, no synthetic email exposure
// ============================================================================

describe('MyAccountScreen: local account display + password-changed bookkeeping', () => {
  const screen = readSrc('features/account/MyAccountScreen.tsx');

  it('shows username + contact_email for local accounts, hides the synthetic auth email', () => {
    expect(screen).toContain('isLocal');
    expect(screen).toContain('profile?.username');
    expect(screen).toContain('profile?.contact_email');
  });

  it('does not introduce an email input field (still session-email read-only)', () => {
    expect(screen).not.toMatch(/type="email"/);
  });

  it('calls markPasswordChanged + reloadProfile after a successful must-change-password update', () => {
    expect(screen).toContain('markPasswordChanged');
    expect(screen).toContain('reloadProfile');
  });

  it('shows the local forgot-password note instead of an email reset card for local accounts', () => {
    expect(screen).toContain('login_local_reset_note');
  });

  it('does not use service_role or auth.admin', () => {
    expect(screen).not.toContain('service_role');
    expect(screen).not.toMatch(/auth\.admin/);
  });

  it('does not perform a raw profiles update for password bookkeeping', () => {
    expect(screen).not.toMatch(/from\(['"]profiles['"]\)\s*\.\s*update\s*\(/);
  });
});

// ============================================================================
// 6. USERS SERVICE: local-mode create/recycle inputs never carry a literal password field
// ============================================================================

describe('users.service.ts: local credentials create/recycle', () => {
  const svc = readSrc('shared/supabase/services/users.service.ts');

  it('CreateUserInput supports loginMode local/email with username + temporaryPassword', () => {
    const block = svc.slice(svc.indexOf('export interface CreateUserInput'), svc.indexOf('export interface CreateUserResult'));
    expect(block).toContain("loginMode: 'local' | 'email'");
    expect(block).toContain('username?: string');
    expect(block).toContain('temporaryPassword?: string');
  });

  it('RecycleUserInput supports loginMode local/email with newUsername + newTemporaryPassword', () => {
    const block = svc.slice(svc.indexOf('export interface RecycleUserInput'), svc.indexOf('export interface RecycleUserResult'));
    expect(block).toContain("loginMode: 'local' | 'email'");
    expect(block).toContain('newUsername?: string');
    expect(block).toContain('newTemporaryPassword?: string');
  });

  it('RecycleUserInput does not declare a bare "password" field', () => {
    const block = svc.slice(svc.indexOf('export interface RecycleUserInput'), svc.indexOf('export interface RecycleUserResult'));
    expect(block).not.toMatch(/\bpassword\b\s*:/);
  });

  it('createUserViaEdge / recycleUserViaEdge never call auth.admin or use service_role', () => {
    expect(svc).not.toMatch(/auth\.admin/);
    expect(svc).not.toContain('service_role');
  });

  it('RecycleUserResult never carries the temporary password — only a boolean flag', () => {
    const block = svc.slice(svc.indexOf('export interface RecycleUserResult'), svc.indexOf('export async function recycleUserViaEdge'));
    expect(block).toContain('temporaryPasswordSet?: boolean');
    expect(block).not.toMatch(/\btemporaryPassword\b\s*\?\s*:\s*string/);
  });
});

// ============================================================================
// 7. EDGE FUNCTION: admin-create-user local mode
// ============================================================================

describe('Edge Function admin-create-user: local credentials mode', () => {
  const fn = readPhoenix('supabase/functions/admin-create-user/index.ts');

  it('defaults login_mode to local when not specified', () => {
    expect(fn).toContain("body.login_mode === 'email' ? 'email' : 'local'");
  });

  it('validates username shape and minimum temporary password length', () => {
    expect(fn).toContain('USERNAME_PATTERN');
    expect(fn).toContain('INVALID_USERNAME');
    expect(fn).toContain('PASSWORD_TOO_SHORT');
  });

  it('synthesizes the internal auth email from the username', () => {
    expect(fn).toContain('LOCAL_AUTH_DOMAIN');
    expect(fn).toContain('`${username}@${LOCAL_AUTH_DOMAIN}`');
  });

  it('always email_confirms local accounts (no deliverable mailbox to confirm)', () => {
    expect(fn).toContain("loginMode === 'local' || password.length >= 8");
  });

  it('never sends an invite email for local accounts', () => {
    const inviteBlock = fn.slice(fn.indexOf('Invite email only'));
    expect(inviteBlock).toContain("loginMode === 'email'");
  });

  it('sets must_change_password true and login_mode on the profile for local accounts (via the contract)', () => {
    // The profile row is converted exactly once by the service-only migration
    // 146 contract; the Edge Function passes login_mode through to that RPC.
    expect(fn).toContain('phoenix_admin_provision_profile');
    expect(fn).toContain('p_login_mode: loginMode');
    const mig146 = readPhoenix('supabase/migrations/146_phoenix_secure_user_provisioning.sql');
    expect(mig146).toContain("must_change_password = (p_login_mode = 'local')");
  });

  it('never logs the temporary password', () => {
    expect(fn).not.toMatch(/console\.(log|info|warn).*temporaryPassword/i);
  });

  it('never returns the temporary password in the success response body', () => {
    const returnBlock = fn.slice(fn.lastIndexOf('return json('));
    expect(returnBlock.toLowerCase()).not.toMatch(/temporary_password|temporarypassword/);
  });

  it('still reads the service key only from Deno.env', () => {
    expect(fn).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
  });
});

// ============================================================================
// 8. EDGE FUNCTION: admin-recycle-user local mode
// ============================================================================

describe('Edge Function admin-recycle-user: local credentials mode', () => {
  const fn = readPhoenix('supabase/functions/admin-recycle-user/index.ts');

  it('defaults login_mode to local when not specified', () => {
    expect(fn).toContain("body.login_mode === 'email' ? 'email' : 'local'");
  });

  it('validates new username shape and minimum temporary password length', () => {
    expect(fn).toContain('USERNAME_PATTERN');
    expect(fn).toContain('INVALID_USERNAME');
  });

  it('sets the auth password directly server-side for local mode (no generateLink)', () => {
    expect(fn).toContain('authUpdate.password = newTemporaryPassword');
  });

  it('only calls generateLink for email-mode recycles', () => {
    const block = fn.slice(fn.indexOf('Step 4'));
    expect(block).toContain("loginMode === 'email'");
    expect(block).toContain('generateLink');
  });

  it('sets must_change_password true and login_mode on the profile for local mode (via the contract)', () => {
    // The profile transition is now performed by phoenix_recycle_apply
    // (migration 093); the Edge Function passes the login_mode through to it.
    expect(fn).toContain('phoenix_recycle_apply');
    expect(fn).toContain('p_login_mode: loginMode');
    const mig = readPhoenix('supabase/migrations/093_phoenix_super_admin_lifecycle_guard.sql');
    expect(mig).toContain("must_change_password = (p_login_mode = 'local')");
  });

  it('returns credential_mode + new_username + temporary_password_set (never the password itself)', () => {
    expect(fn).toContain('credential_mode: loginMode');
    expect(fn).toContain('new_username:');
    expect(fn).toContain('temporary_password_set:');
  });

  it('never returns the temporary password in any response', () => {
    const returnBlock = fn.slice(fn.lastIndexOf('return json('));
    expect(returnBlock.toLowerCase()).not.toMatch(/new_temporary_password|temporarypassword:/);
  });

  it('still requires confirmation phrase RECYCLE_USER_<id> regardless of mode', () => {
    expect(fn).toContain('RECYCLE_USER_');
    expect(fn).toContain('INVALID_CONFIRMATION');
  });

  it('still requires target to be suspended and blocks self/super_admin recycling (in the contract)', () => {
    const mig = readPhoenix('supabase/migrations/093_phoenix_super_admin_lifecycle_guard.sql');
    expect(mig).toContain('TARGET_NOT_SUSPENDED');
    expect(mig).toContain("'self_action'");
    expect(mig).toContain("'cannot_recycle_super_admin'");
  });
});

// ============================================================================
// 9. USER MANAGEMENT SCREEN: local mode is the default UI path
// ============================================================================

describe('UserManagementScreen: local credentials UI is the only normal UI (LOCAL-UX-PERMISSION-PERSISTENCE-FIX-A)', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');

  it('CreateUserForm always submits loginMode: local — no identity-mode toggle', () => {
    expect(screen).toContain("loginMode: 'local'");
    expect(screen).not.toContain("useState<'local' | 'email'>");
  });

  it('create form validates username + temporary password (no email/invite fields)', () => {
    expect(screen).toContain('validateUsername(username)');
    expect(screen).not.toContain('um_mode_email_secondary');
    expect(screen).not.toContain('um_invite_activation_msg');
  });

  it('RecycleConfirmModal always submits loginMode: local with username + temporary password fields', () => {
    expect(screen).toContain("loginMode: 'local'");
    expect(screen).toContain('newUsername');
    expect(screen).toContain('newTemporaryPassword');
  });

  it('recycle modal has no Email (advanced) tab in the normal UI', () => {
    expect(screen).not.toContain('um_mode_email_secondary');
    expect(screen).not.toContain('um_mode_local');
  });

  it('recycle modal does not require a real email for local recycling (no required new-email field)', () => {
    const recycleBlock = screen.slice(screen.indexOf('function RecycleConfirmModal'), screen.indexOf('function RecycleConfirmModal') + 4000);
    expect(recycleBlock).not.toContain('um_recycle_new_email');
    expect(recycleBlock).not.toContain('setNewEmail');
  });

  it('recycle modal does not show reset-email/recovery-link wording', () => {
    const recycleBlock = screen.slice(screen.indexOf('function RecycleConfirmModal'), screen.indexOf('function RecycleConfirmModal') + 4000);
    expect(recycleBlock).not.toContain("t('um_recycle_success', lang)");
    expect(recycleBlock).not.toContain('um_recycle_link_failed');
    expect(recycleBlock).not.toContain('passwordSetupStatus');
  });

  it('contact email field is labeled as not used for login or operation attribution', () => {
    expect(screen).toContain('um_contact_email_not_for_login');
  });

  it('recycle modal still requires the exact RECYCLE_USER_<id> confirmation', () => {
    expect(screen).toContain('expectedConfirm');
    expect(screen).toContain('RECYCLE_USER_');
  });

  it('does not perform a raw .update() on profiles (all changes via Edge Functions)', () => {
    expect(screen).not.toMatch(/from\(['"]profiles['"]\)\s*\.\s*update\s*\(/);
  });

  it('does not use service_role or auth.admin', () => {
    expect(screen).not.toContain('service_role');
    expect(screen).not.toMatch(/auth\.admin/);
  });
});

describe('i18n: contact email wording (LOCAL-UX-PERMISSION-PERSISTENCE-FIX-A)', () => {
  const strings = readSrc('shared/i18n/strings.ts');

  it('has the bilingual "not used for login or operation attribution" contact-email note', () => {
    expect(strings).toContain('um_contact_email_not_for_login');
    expect(strings).toContain('بريد تواصل اختياري — لا يُستخدم لتسجيل الدخول أو توثيق العمليات');
    expect(strings).toContain('Optional contact email — not used for login or operation attribution');
  });
});

describe('users.service.ts + Edge Functions: email mode retained as a hidden compatibility path only', () => {
  const svc = readSrc('shared/supabase/services/users.service.ts');
  const createFn = readPhoenix('supabase/functions/admin-create-user/index.ts');
  const recycleFn = readPhoenix('supabase/functions/admin-recycle-user/index.ts');

  it('CreateUserInput/RecycleUserInput still type loginMode as local | email (backend compatibility)', () => {
    expect(svc).toContain("loginMode: 'local' | 'email'");
  });

  it('Edge Functions still accept login_mode: email for backend compatibility', () => {
    expect(createFn).toContain("body.login_mode === 'email' ? 'email' : 'local'");
    expect(recycleFn).toContain("body.login_mode === 'email' ? 'email' : 'local'");
  });
});

// ============================================================================
// 10. GLOBAL GUARDRAILS: still hold after the local-credentials feature
// ============================================================================

describe('Local credentials feature: global guardrails still hold', () => {
  const files = allTsxFiles('');

  it('no service_role in any frontend .ts/.tsx file', () => {
    files.forEach(path => expect(readFile(path)).not.toContain('service_role'));
  });

  it('no auth.admin in any frontend .ts/.tsx file', () => {
    files.forEach(path => expect(readFile(path)).not.toMatch(/auth\.admin/));
  });

  it('hard delete button is still not rendered', () => {
    const screen = readSrc('features/users/UserManagementScreen.tsx');
    expect(screen).not.toContain('deleteTarget');
    expect(screen).not.toContain('um_delete_user_action');
  });

  it('Data Reset, OCR/Excel/DocIntel imports remain absent', () => {
    files.forEach(path => {
      const content = readFile(path);
      expect(content).not.toMatch(/import.*DataReset/i);
      expect(content).not.toMatch(/import.*OcrImport/i);
      expect(content).not.toMatch(/import.*ExcelImport/i);
      expect(content).not.toMatch(/import.*DocIntel/i);
    });
  });
});

// ============================================================================
// 11. DOCS: account-lifecycle-policy.md documents local credentials mode
// ============================================================================

describe('Docs: account-lifecycle-policy.md documents local credentials mode', () => {
  const policy = readPhoenix('docs/account-lifecycle-policy.md');

  it('documents the synthetic internal auth email domain', () => {
    expect(policy).toContain('local.medistock.invalid');
  });

  it('documents login_mode and username/contact_email columns', () => {
    expect(policy).toContain('profiles.login_mode');
    expect(policy).toContain('profiles.username');
    expect(policy).toContain('profiles.contact_email');
  });

  it('documents the narrow temporary-password exception and why it is safe', () => {
    expect(policy.toLowerCase()).toContain('temporary password');
    expect(policy).toContain('never logged, stored in `profiles`, or returned');
  });

  it('documents that forgot-password email does not work for local accounts', () => {
    expect(policy.toLowerCase()).toContain('does not work for local accounts');
  });
});

describe('Docs: manual-supabase-migrations.md registers migration 016', () => {
  const doc = readPhoenix('docs/manual-supabase-migrations.md');

  it('lists migration 016 in the apply table and apply order', () => {
    expect(doc).toContain('016_phoenix_local_credentials_mode.sql');
    expect(doc).toContain('Apply 016 manually');
  });
});
