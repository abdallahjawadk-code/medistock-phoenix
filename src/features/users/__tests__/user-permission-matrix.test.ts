import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  OFFICIAL_ROLES, OFFICIAL_ROLE_LABEL_KEY, normalizeRole, isOfficialRole,
  canTargetRole, roleLabelKey,
} from '@/shared/lib/roles';
import {
  PERMISSION_KEYS, PERMISSION_KEY_SET, isValidPermissionKey, isDangerousPermission,
  roleDefaults, effectivePermissions, hasPermission, resetToDefaults,
  validateOverrides, canActorSetPermission, permissionsByModule,
  type GrantContext,
} from '@/shared/lib/permissions';

const SRC     = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const readPhoenix = (rel: string) => readFileSync(join(PHOENIX, rel), 'utf8');

// ============================================================================
// 1. Official role model
// ============================================================================
describe('Official role model', () => {
  it('has exactly the five official roles', () => {
    expect([...OFFICIAL_ROLES]).toEqual([
      'super_admin', 'warehouse_officer', 'port_officer', 'monthly_status_officer', 'viewer',
    ]);
  });

  it('maps legacy roles to official non-destructively', () => {
    expect(normalizeRole('warehouse_manager')).toBe('warehouse_officer');
    expect(normalizeRole('point_operator')).toBe('port_officer');
    expect(normalizeRole('transfer_manager')).toBe('monthly_status_officer');
    expect(normalizeRole('hospital_admin')).toBe('hospital_admin'); // legacy admin kept
    expect(normalizeRole('viewer')).toBe('viewer');
    expect(normalizeRole('unknown')).toBe('viewer'); // safe fallback
  });

  it('only super_admin can target super_admin', () => {
    expect(canTargetRole('super_admin', 'super_admin')).toBe(true);
    expect(canTargetRole('viewer', 'super_admin')).toBe(false);
    expect(canTargetRole('warehouse_officer', 'super_admin')).toBe(false);
    expect(canTargetRole('warehouse_officer', 'viewer')).toBe(true);
  });

  it('roleLabelKey uses official labels for legacy roles', () => {
    expect(roleLabelKey('warehouse_manager')).toBe('orole_warehouse_officer');
    expect(roleLabelKey('point_operator')).toBe('orole_port_officer');
    expect(roleLabelKey('hospital_admin')).toBe('orole_legacy_admin');
  });

  it('isOfficialRole guards', () => {
    expect(isOfficialRole('viewer')).toBe(true);
    expect(isOfficialRole('hospital_admin')).toBe(false);
  });
});

// ============================================================================
// 2. Bilingual role + permission labels
// ============================================================================
describe('Official role & permission labels (bilingual)', () => {
  const strings = readSrc('shared/i18n/strings.ts');

  it('every official role has an orole_ label key', () => {
    for (const r of OFFICIAL_ROLES) expect(strings).toContain(`${OFFICIAL_ROLE_LABEL_KEY[r]}:`);
  });

  it('official Arabic labels match the spec', () => {
    expect(strings).toContain('مدير المنصة');           // Platform Administrator
    expect(strings).toContain('مسؤول المذخر');          // Store Officer
    expect(strings).toContain('مسؤول المنفذ');          // Port Officer
    expect(strings).toContain('مسؤول المواقف الشهرية'); // Monthly Status Officer
  });

  it('official English labels match the spec', () => {
    ['Platform Administrator', 'Store Officer', 'Port Officer', 'Monthly Status Officer', 'Viewer']
      .forEach(l => expect(strings).toContain(l));
  });

  it('old Arabic labels are NOT used as official labels', () => {
    expect(strings).not.toContain('مدير المؤسسة');
    expect(strings).not.toContain('مسؤول المخزن');
    expect(strings).not.toContain('مشغل المنفذ');
    expect(strings).not.toContain('مسؤول الترحيل');
  });

  it('every permission key has a bilingual label string', () => {
    for (const p of PERMISSION_KEYS) expect(strings).toContain(`${p.labelKey}:`);
  });

  it('user management UI strings exist', () => {
    ['nav_users', 'um_title', 'um_create_user', 'um_permissions', 'um_role_perms',
     'um_custom_perms', 'um_reset_defaults', 'um_dangerous', 'um_contact', 'um_phone',
     'um_server_only', 'um_cannot_create_super', 'um_cannot_create_outside_org', 'um_cannot_grant']
      .forEach(k => expect(strings).toContain(`${k}:`));
  });
});

// ============================================================================
// 3. Permission catalog (allowlist)
// ============================================================================
describe('Permission catalog', () => {
  const REQUIRED = [
    'dashboard.view', 'organizations.view', 'organizations.create', 'organizations.edit', 'organizations.archive',
    'users.view', 'users.create', 'users.assign_role', 'users.manage_permissions',
    'warehouses.view', 'warehouses.manage', 'ports.view', 'ports.create', 'ports.edit', 'ports.archive',
    'qr.view', 'qr.generate', 'qr.revoke', 'availability.view', 'availability.manage',
    'status_center.view', 'status_center.create', 'status_center.edit', 'status_center.resolve',
    'exchange_alerts.view', 'inter_institution_alerts.view', 'status_contacts.view', 'status_contacts.manage',
    'deletion_wizard.view', 'deletion_wizard.clear_port_items', 'deletion_wizard.archive_port', 'deletion_wizard.archive_organization',
  ];

  it('contains exactly the required permission keys', () => {
    expect([...PERMISSION_KEY_SET].sort()).toEqual([...REQUIRED].sort());
  });

  it('rejects unknown permission keys', () => {
    expect(isValidPermissionKey('fake.permission')).toBe(false);
    expect(isValidPermissionKey('users.create')).toBe(true);
  });

  it('flags dangerous permissions', () => {
    expect(isDangerousPermission('users.create')).toBe(true);
    expect(isDangerousPermission('organizations.archive')).toBe(true);
    expect(isDangerousPermission('qr.revoke')).toBe(true);
    expect(isDangerousPermission('dashboard.view')).toBe(false);
  });

  it('groups by module', () => {
    const mods = permissionsByModule();
    expect(mods.users.map(p => p.key)).toContain('users.create');
    expect(Object.keys(mods)).toContain('deletion_wizard');
  });
});

// ============================================================================
// 4. Role defaults
// ============================================================================
describe('Role default permissions', () => {
  it('super_admin has every permission', () => {
    const d = roleDefaults('super_admin');
    expect(d.size).toBe(PERMISSION_KEYS.length);
  });

  it('viewer is read-only (no create/manage/users)', () => {
    const d = roleDefaults('viewer');
    expect(d.has('dashboard.view')).toBe(true);
    expect(d.has('users.create')).toBe(false);
    expect(d.has('availability.manage')).toBe(false);
    expect(d.has('status_center.create')).toBe(false);
  });

  it('port_officer cannot manage users by default', () => {
    const d = roleDefaults('port_officer');
    expect(d.has('users.create')).toBe(false);
    expect(d.has('users.manage_permissions')).toBe(false);
    expect(d.has('ports.edit')).toBe(true);
  });

  it('monthly_status_officer can manage status center + contacts, not users', () => {
    const d = roleDefaults('monthly_status_officer');
    expect(d.has('status_center.create')).toBe(true);
    expect(d.has('status_contacts.manage')).toBe(true);
    expect(d.has('users.create')).toBe(false);
  });

  it('warehouse_officer manages stores, not users/orgs', () => {
    const d = roleDefaults('warehouse_officer');
    expect(d.has('warehouses.manage')).toBe(true);
    expect(d.has('users.create')).toBe(false);
    expect(d.has('organizations.archive')).toBe(false);
  });

  it('legacy roles inherit their mapped official defaults', () => {
    expect([...roleDefaults('warehouse_manager')].sort()).toEqual([...roleDefaults('warehouse_officer')].sort());
    expect([...roleDefaults('point_operator')].sort()).toEqual([...roleDefaults('port_officer')].sort());
  });
});

// ============================================================================
// 5. Effective permissions + overrides + reset
// ============================================================================
describe('Effective permissions', () => {
  it('override grants and denies on top of role defaults', () => {
    const eff = effectivePermissions('viewer', { 'availability.manage': true, 'dashboard.view': false });
    expect(eff.has('availability.manage')).toBe(true);
    expect(eff.has('dashboard.view')).toBe(false);
  });

  it('null override inherits the role default', () => {
    expect(hasPermission('viewer', { 'availability.manage': null }, 'availability.manage')).toBe(false);
  });

  it('ignores unknown override keys', () => {
    const eff = effectivePermissions('viewer', { 'fake.key': true } as Record<string, boolean>);
    expect(eff.has('fake.key')).toBe(false);
  });

  it('resetToDefaults clears overrides', () => {
    expect(resetToDefaults()).toEqual({});
  });
});

// ============================================================================
// 6. Authority checks (mirrors RPC)
// ============================================================================
describe('Permission grant authority', () => {
  const base: GrantContext = { actorRole: 'monthly_status_officer', isSelf: false, sameScope: true };

  it('cannot grant a permission the actor does not hold', () => {
    const r = canActorSetPermission(base, 'warehouses.manage', true);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('CANNOT_GRANT_UNHELD');
  });

  it('dangerous permission requires authority', () => {
    const r = canActorSetPermission(base, 'users.create', true);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('NEEDS_AUTHORITY_FOR_DANGEROUS');
  });

  it('blocks self-escalation', () => {
    const r = canActorSetPermission({ ...base, actorRole: 'super_admin', isSelf: true }, 'users.create', true);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('SELF_ESCALATION');
  });

  it('blocks acting out of scope for non-super', () => {
    const r = canActorSetPermission({ actorRole: 'warehouse_officer', isSelf: false, sameScope: false }, 'warehouses.manage', true);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('OUT_OF_SCOPE');
  });

  it('super_admin can grant anything in scope (not self)', () => {
    const r = canActorSetPermission({ actorRole: 'super_admin', isSelf: false, sameScope: true }, 'organizations.archive', true);
    expect(r.ok).toBe(true);
  });

  it('denying/inheriting is always allowed in scope', () => {
    expect(canActorSetPermission(base, 'users.create', false).ok).toBe(true);
    expect(canActorSetPermission(base, 'users.create', null).ok).toBe(true);
  });

  it('validateOverrides rejects unknown keys and returns accepted subset', () => {
    const ctx: GrantContext = { actorRole: 'super_admin', isSelf: false, sameScope: true };
    const res = validateOverrides(ctx, { 'dashboard.view': true, 'fake.key': true });
    expect(res.ok).toBe(false);
    expect(res.rejected.find(r => r.key === 'fake.key')?.error).toBe('UNKNOWN_PERMISSION');
    expect(res.accepted['dashboard.view']).toBe(true);
  });
});

// ============================================================================
// 7. Navigation wiring
// ============================================================================
describe('User management navigation wiring', () => {
  it('App routes screen 14 to UserManagementScreen', () => {
    const app = readSrc('app/App.tsx');
    expect(app).toContain('UserManagementScreen');
    expect(app).toMatch(/case 14:\s*return <UserManagementScreen/);
  });
  it('sidebar + drawer + shell expose the users page', () => {
    expect(readSrc('shared/ui/PhoenixSidebar.tsx')).toContain('nav_users');
    expect(readSrc('shared/ui/PhoenixMobileDrawer.tsx')).toContain('nav_users');
    expect(readSrc('shared/ui/PhoenixAppShell.tsx')).toContain("14: 'nav_users'");
  });
});

// ============================================================================
// 8. Frontend security
// ============================================================================
describe('User management frontend security', () => {
  const screen  = readSrc('features/users/UserManagementScreen.tsx');
  const service = readSrc('shared/supabase/services/users.service.ts');
  const roles   = readSrc('shared/lib/roles.ts');
  const perms   = readSrc('shared/lib/permissions.ts');

  it('no service_role anywhere in the new frontend code', () => {
    [screen, service, roles, perms].forEach(c => expect(c).not.toContain('service_role'));
  });
  it('no auth.admin in the frontend', () => {
    [screen, service].forEach(c => expect(c).not.toContain('auth.admin'));
  });
  it('create-user goes through the Edge Function, not direct auth', () => {
    expect(service).toContain("functions.invoke('admin-create-user'");
  });
  it('permission changes go through the scoped RPCs', () => {
    expect(service).toContain("rpc('assign_profile_permissions'");
    expect(service).toContain("rpc('get_effective_permissions'");
    expect(service).toContain("rpc('reset_profile_permissions'");
  });
  it('screen offers only official roles in the dropdown', () => {
    expect(screen).toContain('OFFICIAL_ROLES');
    expect(screen).not.toContain('role_hospital_admin');
    expect(screen).not.toContain('role_warehouse_manager');
  });
  it('monthly_status_officer contact integration exists', () => {
    expect(screen).toContain('getOrgStatusContacts');
    expect(screen).toContain('ContactSection');
    expect(screen).toContain('um_multi_officer');
  });
  it('institution screen no longer uses old role label keys', () => {
    const inst = readSrc('features/institutions/InstitutionScreen.tsx');
    expect(inst).not.toContain("'role_hospital_admin'");
    expect(inst).not.toContain("'role_warehouse_manager'");
    expect(inst).toContain('roleLabelKey');
  });
});

// ============================================================================
// 9. Edge Function safety
// ============================================================================
describe('admin-create-user Edge Function', () => {
  const fn = readPhoenix('supabase/functions/admin-create-user/index.ts');

  it('reads service_role only from the server env', () => {
    expect(fn).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
  });
  it('verifies the caller and their users.create permission', () => {
    expect(fn).toContain('getUser');
    expect(fn).toContain("p_key: 'users.create'");
  });
  it('only super_admin can create super_admin', () => {
    expect(fn).toContain('CANNOT_CREATE_SUPER_ADMIN');
  });
  it('blocks cross-organization creation', () => {
    expect(fn).toContain('CROSS_ORG_FORBIDDEN');
  });
  it('accepts only official roles', () => {
    expect(fn).toContain('OFFICIAL_ROLES');
    expect(fn).toContain('INVALID_ROLE');
  });
});

// ============================================================================
// 10. Migration 010 safety + 008/009 untouched
// ============================================================================
describe('Migration 010 + prior migrations', () => {
  const sql = readPhoenix('supabase/migrations/010_phoenix_user_permission_matrix.sql');

  it('expands the role CHECK with official + legacy keys', () => {
    expect(sql).toContain("'super_admin', 'warehouse_officer', 'port_officer', 'monthly_status_officer', 'viewer'");
    expect(sql).toContain('hospital_admin');
  });
  it('creates the three matrix tables', () => {
    expect(sql).toMatch(/create table if not exists permission_keys/i);
    expect(sql).toMatch(/create table if not exists role_permission_defaults/i);
    expect(sql).toMatch(/create table if not exists profile_permission_overrides/i);
  });
  it('permission RPCs are SECURITY DEFINER with fixed search_path', () => {
    ['get_effective_permissions', 'assign_profile_permissions', 'reset_profile_permissions'].forEach(fn => {
      expect(sql).toContain(fn);
    });
    expect((sql.match(/security definer/gi) ?? []).length).toBeGreaterThanOrEqual(4);
    expect((sql.match(/set search_path = public, pg_temp/gi) ?? []).length).toBeGreaterThanOrEqual(4);
  });
  it('rejects self permission edits and out-of-scope', () => {
    expect(sql).toContain('CANNOT_EDIT_OWN_PERMISSIONS');
    expect(sql).toContain('OUT_OF_SCOPE');
  });
  it('revokes anon execute on the permission RPCs', () => {
    expect(sql).toContain('revoke all on function get_effective_permissions(uuid) from anon');
    expect(sql).toContain('revoke all on function assign_profile_permissions(uuid, jsonb) from anon');
  });
  it('uses no DROP TABLE / TRUNCATE shortcut', () => {
    expect(sql).not.toMatch(/drop table/i);
    expect(sql).not.toMatch(/truncate/i);
  });
  it('warns not to use db push', () => {
    expect(sql).toContain('supabase db push');
  });

  it('does not modify migration 008 or 009 (signatures intact)', () => {
    const m008 = readPhoenix('supabase/migrations/008_phoenix_org_status_contacts.sql');
    const m009 = readPhoenix('supabase/migrations/009_phoenix_inter_institution_alerts.sql');
    expect(m008).toContain('create table if not exists organization_status_contacts');
    expect(m009).toContain('function get_scoped_inter_institution_alerts');
  });
});

// ============================================================================
// 11. Disabled-modules guardrails still hold
// ============================================================================
describe('Disabled modules unaffected by this phase', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');
  it('no Data Reset, no Intake/OCR/Excel re-enabled in the new screen', () => {
    expect(screen).not.toMatch(/DataReset|data-reset/i);
    expect(screen).not.toMatch(/import.*[Oo]cr|import.*[Ee]xcel|import.*[Dd]oc[Ii]ntel/);
  });
});
