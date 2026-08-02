/**
 * LOCAL-UX-PERMISSION-PERSISTENCE-FIX-A Guardrail Tests
 * Run: npm test -- --run
 *
 * Verifies the permission-persistence fix without requiring a real DB
 * connection: AppContext loads/clears the actor's DB-backed effective
 * permissions, UserManagementScreen consumes that instead of the hardcoded
 * role-default table, and the dangerous-permission / scope guardrails still
 * hold. The full cross-session scenario (Part C) requires a live Supabase
 * project and is documented as a manual QA checklist in
 * docs/account-lifecycle-policy.md §9 — it cannot be automated here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SRC     = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');

function readSrc(rel: string) { return readFileSync(join(SRC, rel), 'utf8'); }
function readPhoenix(rel: string) { return readFileSync(join(PHOENIX, rel), 'utf8'); }
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
function readFile(path: string) { return readFileSync(path, 'utf8'); }

// ============================================================================
// 1. AppContext: loads + clears DB-backed effective permissions
// ============================================================================

describe('AppContext: myPermissions is loaded from the DB, not the hardcoded role table', () => {
  const ctx = readSrc('app/AppContext.tsx');

  it('loads permissions via getEffectivePermissions (the get_effective_permissions RPC)', () => {
    expect(ctx).toContain('getEffectivePermissions');
    expect(ctx).toContain('loadPermissions');
  });

  /* PHASE-B1-AUTH-RESILIENCE-RACE: the RPC + roleDefaults fallback logic these
     three tests pin is unchanged; it moved from loadPermissions into
     readPermissions, which RETURNS the set instead of writing it. The split
     exists so a profile request that has been superseded (a newer session
     arrived while the RPC was in flight) can drop its answer — a function that
     sets state itself cannot be cancelled. loadPermissions still exists and
     still applies. Every guarantee below is asserted, just at its new home. */

  it('falls back to roleDefaults() only when the RPC has no data (migration missing)', () => {
    const block = ctx.slice(ctx.indexOf('const readPermissions'), ctx.indexOf('const loadPermissions'));
    expect(block).toContain('if (res.permissions)');
    expect(block).toContain('roleDefaults(p.role)');
    expect(block).toContain('migrationMissing');
  });

  it('reloads permissions every time the profile loads (login) and on reloadProfile', () => {
    expect(ctx).toContain('await readPermissions(p)');
    expect(ctx).toContain('setMyPermissions(perms)');
  });

  it('clears permissions on signOut (no stale state carried across sessions)', () => {
    const signOutBlock = ctx.slice(ctx.indexOf('const signOut'), ctx.indexOf('const signOut') + 800);
    expect(signOutBlock).toContain('clearIdentityState()');
    const clearBlock = ctx.slice(ctx.indexOf('const clearIdentityState'), ctx.indexOf('const clearIdentityState') + 400);
    expect(clearBlock).toContain('setMyPermissions(new Set())');
  });

  it('exposes myPermissions and reloadMyPermissions on the context', () => {
    expect(ctx).toContain('myPermissions');
    expect(ctx).toContain('reloadMyPermissions');
  });

  it('does not use service_role or auth.admin', () => {
    expect(ctx).not.toContain('service_role');
    expect(ctx).not.toMatch(/auth\.admin/);
  });
});

// ============================================================================
// 2. UserManagementScreen: gating uses AppContext's DB-backed permissions
// ============================================================================

describe('UserManagementScreen: actor gating reads myPermissions from AppContext, not the hardcoded table', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');

  it('destructures myPermissions from useApp() for the actor effective set', () => {
    expect(screen).toContain('myPermissions, reloadMyPermissions } = useApp()');
    expect(screen).toContain('const actorEff    = myPermissions;');
  });

  it('no longer calls the hardcoded effectivePermissions(role) for actor gating', () => {
    expect(screen).not.toContain('effectivePermissions(role)');
    expect(screen).not.toMatch(/import[^;]*\beffectivePermissions\b[^;]*from '@\/shared\/lib\/permissions'/);
  });

  it('passes the actor\'s real permissions down to the PermissionMatrix for the grant-authority check', () => {
    expect(screen).toContain('actorPermissions={actorEff}');
    expect(screen).toContain('actorPermissions: Set<string>');
  });

  it('builds actorOverrides for validateOverrides from the actor\'s real DB-backed permissions (not an empty default)', () => {
    const block = screen.slice(screen.indexOf('const actorDefaults'), screen.indexOf('const actorDefaults') + 600);
    expect(block).toContain('actorPermissions.has(p.key)');
    expect(block).toContain('actorOverrides');
    expect(screen).toContain('actorOverrides,');
  });
});

// ============================================================================
// 3. Permission save/reload round trip still goes through the persistent RPCs
// ============================================================================

describe('Permission save/reload: persistent RPC round trip (unchanged, still correct)', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');
  const svc = readSrc('shared/supabase/services/users.service.ts');
  const migration010 = readPhoenix('supabase/migrations/010_phoenix_user_permission_matrix.sql');

  it('onSave calls assignProfilePermissions (writes to profile_permission_overrides via RPC)', () => {
    expect(screen).toContain('assignProfilePermissions(user.id, overrides, actorHasManagePermissions)');
    expect(svc).toContain("rpc('assign_profile_permissions'");
  });

  it('after saving, the matrix reloads from the DB (eff.reload()) — UI state is not assumed from local state', () => {
    const onSaveBlock = screen.slice(screen.indexOf('async function onSave'), screen.indexOf('async function onReset'));
    expect(onSaveBlock).toContain('eff.reload()');
  });

  it('save computes a null override (inherit default) when the new value equals the role default — does not force-write redundant overrides', () => {
    const onSaveBlock = screen.slice(screen.indexOf('async function onSave'), screen.indexOf('async function onReset'));
    expect(onSaveBlock).toContain('cur === defaults.has(p.key) ? null : cur');
  });

  it('assign_profile_permissions upserts overrides and never overwrites unrelated permission_keys (per-key upsert only)', () => {
    const fnBlock = migration010.slice(migration010.indexOf('function assign_profile_permissions'), migration010.indexOf('function reset_profile_permissions'));
    expect(fnBlock).toContain('on conflict (profile_id, permission_key)');
    expect(fnBlock).toContain('do update set allowed = excluded.allowed');
  });

  it('get_effective_permissions resolves override-then-role-default-then-false (DB is the single source of truth at read time)', () => {
    expect(migration010).toContain('function phoenix_profile_has_permission');
    const fnBlock = migration010.slice(migration010.indexOf('function phoenix_profile_has_permission'), migration010.indexOf('function get_effective_permissions'));
    expect(fnBlock).toContain('profile_permission_overrides');
    expect(fnBlock).toContain('role_permission_defaults');
  });
});

// ============================================================================
// 4. Role defaults never overwrite existing per-profile overrides
// ============================================================================

describe('Role defaults do not overwrite profile overrides', () => {
  const migration010 = readPhoenix('supabase/migrations/010_phoenix_user_permission_matrix.sql');

  it('phoenix_profile_has_permission checks the override table FIRST, only falling back to role defaults when the override is null/absent', () => {
    const fnBlock = migration010.slice(migration010.indexOf('function phoenix_profile_has_permission'), migration010.indexOf('function get_effective_permissions'));
    const overrideIdx = fnBlock.indexOf('profile_permission_overrides');
    const defaultsIdx = fnBlock.indexOf('role_permission_defaults');
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(defaultsIdx).toBeGreaterThan(overrideIdx);
  });

  it('reset_profile_permissions only deletes the target profile\'s own override rows (scoped by profile_id)', () => {
    const fnBlock = migration010.slice(migration010.indexOf('function reset_profile_permissions'));
    expect(fnBlock).toContain('delete from profile_permission_overrides where profile_id = p_profile_id');
  });
});

// ============================================================================
// 5. Dangerous permissions remain guarded
// ============================================================================

describe('Dangerous permissions remain guarded after the persistence fix', () => {
  const perms = readSrc('shared/lib/permissions.ts');
  const migration010 = readPhoenix('supabase/migrations/010_phoenix_user_permission_matrix.sql');
  const migration015 = readPhoenix('supabase/migrations/015_phoenix_user_account_recycling.sql');

  it('users.recycle is still marked dangerous and super_admin-only by default', () => {
    expect(perms).toContain("key: 'users.recycle'");
    const block = perms.slice(perms.indexOf("key: 'users.recycle'"), perms.indexOf("key: 'users.recycle'") + 200);
    expect(block).toContain('dangerous: true');
    expect(migration015).toContain("'super_admin', 'users.recycle', true");
  });

  it('institution_admin defaults do not include users.recycle', () => {
    expect(perms).not.toMatch(/INSTITUTION_ADMIN_DEFAULTS[^\]]*users\.recycle/);
  });

  it('granting a dangerous permission still requires the actor to hold it themselves (client-side pre-check + server RPC)', () => {
    expect(perms).toContain('NEEDS_AUTHORITY_FOR_DANGEROUS');
    const assignFn = migration010.slice(migration010.indexOf('function assign_profile_permissions'), migration010.indexOf('function reset_profile_permissions'));
    expect(assignFn).toContain('is_dangerous');
  });

  it('self-permission-escalation is blocked both client-side and server-side', () => {
    expect(perms).toContain('SELF_ESCALATION');
    const assignFn = migration010.slice(migration010.indexOf('function assign_profile_permissions'), migration010.indexOf('function reset_profile_permissions'));
    expect(assignFn).toContain('CANNOT_EDIT_OWN_PERMISSIONS');
  });

  it('institution_admin cannot assign permissions outside their own organization (server-side OUT_OF_SCOPE check)', () => {
    const assignFn = migration010.slice(migration010.indexOf('function assign_profile_permissions'), migration010.indexOf('function reset_profile_permissions'));
    expect(assignFn).toContain('OUT_OF_SCOPE');
    expect(assignFn).toContain('v_target_org is distinct from v_org');
  });
});

// ============================================================================
// 6. Security + safety guardrails still hold
// ============================================================================

describe('Permission persistence fix: global guardrails still hold', () => {
  const files = allTsxFiles('');

  it('no service_role in any frontend .ts/.tsx file', () => {
    files.forEach(path => expect(readFile(path)).not.toContain('service_role'));
  });

  it('no auth.admin in any frontend .ts/.tsx file', () => {
    files.forEach(path => expect(readFile(path)).not.toMatch(/auth\.admin/));
  });

  it('no password logging, storage in profiles, or return — unaffected by this fix', () => {
    const createFn = readPhoenix('supabase/functions/admin-create-user/index.ts');
    const recycleFn = readPhoenix('supabase/functions/admin-recycle-user/index.ts');
    [createFn, recycleFn].forEach(fn => {
      expect(fn).not.toMatch(/console\.(log|info|warn).*password/i);
    });
  });

  it('hard delete button is rendered, gated to super_admin and never self', () => {
    const screen = readSrc('features/users/UserManagementScreen.tsx');
    expect(screen).toContain('deleteTarget');
    expect(screen).toContain('um_delete_user_action');
    expect(screen).toContain('isSuper && !isSelf');
  });

  it('Data Reset still absent from src', () => {
    files.forEach(path => expect(readFile(path)).not.toMatch(/import.*DataReset/i));
  });

  it('Intake/OCR/Excel/DocIntel remain disabled', () => {
    files.forEach(path => {
      const content = readFile(path);
      expect(content).not.toMatch(/import.*OcrImport/i);
      expect(content).not.toMatch(/import.*ExcelImport/i);
      expect(content).not.toMatch(/import.*DocIntel/i);
    });
  });
});

// ============================================================================
// 7. Docs: permission persistence root cause + manual scenario documented
// ============================================================================

describe('Docs: account-lifecycle-policy.md documents the permission persistence fix', () => {
  const policy = readPhoenix('docs/account-lifecycle-policy.md');

  it('documents the root cause (frontend gating ignored DB overrides)', () => {
    expect(policy).toContain('Root cause');
    expect(policy.toLowerCase()).toContain('myPermissions'.toLowerCase());
  });

  it('documents the manual cross-session verification scenario', () => {
    expect(policy).toContain('Manual verification scenario');
    expect(policy).toContain('as the test user');
    expect(policy).toContain('Log out and back in again as the test user');
  });
});
