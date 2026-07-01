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
  it('has exactly the six official roles (including institution_admin)', () => {
    expect([...OFFICIAL_ROLES]).toEqual([
      'super_admin', 'institution_admin', 'warehouse_officer', 'port_officer', 'monthly_status_officer', 'viewer',
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

  it('only super_admin can target super_admin or institution_admin', () => {
    expect(canTargetRole('super_admin', 'super_admin')).toBe(true);
    expect(canTargetRole('super_admin', 'institution_admin')).toBe(true);
    expect(canTargetRole('viewer', 'super_admin')).toBe(false);
    expect(canTargetRole('institution_admin', 'super_admin')).toBe(false);
    expect(canTargetRole('institution_admin', 'institution_admin')).toBe(false);
    expect(canTargetRole('warehouse_officer', 'super_admin')).toBe(false);
    expect(canTargetRole('warehouse_officer', 'institution_admin')).toBe(false);
    expect(canTargetRole('institution_admin', 'warehouse_officer')).toBe(true);
    expect(canTargetRole('institution_admin', 'viewer')).toBe(true);
    expect(canTargetRole('warehouse_officer', 'viewer')).toBe(true);
  });

  it('roleLabelKey uses official labels for legacy roles', () => {
    expect(roleLabelKey('warehouse_manager')).toBe('orole_warehouse_officer');
    expect(roleLabelKey('point_operator')).toBe('orole_port_officer');
    expect(roleLabelKey('hospital_admin')).toBe('orole_legacy_admin');
  });

  it('isOfficialRole guards', () => {
    expect(isOfficialRole('viewer')).toBe(true);
    expect(isOfficialRole('institution_admin')).toBe(true);
    expect(isOfficialRole('hospital_admin')).toBe(false);
  });

  it('normalizeRole returns institution_admin for institution_admin', () => {
    expect(normalizeRole('institution_admin')).toBe('institution_admin');
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
    expect(strings).toContain('مسؤول المؤسسة');         // Institution Administrator
    expect(strings).toContain('مسؤول المذخر');          // Store Officer
    expect(strings).toContain('مسؤول المنفذ');          // Port Officer
    expect(strings).toContain('مسؤول المواقف الشهرية'); // Monthly Status Officer
  });

  it('official English labels match the spec', () => {
    ['Platform Administrator', 'Institution Administrator', 'Store Officer', 'Port Officer', 'Monthly Status Officer', 'Viewer']
      .forEach(l => expect(strings).toContain(l));
  });

  it('old Arabic labels are NOT used as official labels', () => {
    // مدير المؤسسة = old hospital_admin label; مسؤول المؤسسة = new institution_admin label (different)
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

  it('invite-first onboarding strings exist', () => {
    ['um_mode_invite', 'um_invite_activation_msg', 'um_invite_notice',
     'um_created_invited', 'um_created_no_invite', 'um_advanced_options',
     'um_password_mode_warning', 'um_created_password']
      .forEach(k => expect(strings).toContain(`${k}:`));
  });

  it('institution_admin scope strings exist (bilingual)', () => {
    ['um_scope_own_institution', 'um_invite_own_org_only',
     'um_cannot_create_institution_admin', 'um_lifecycle_requires_enable',
     'orole_institution_admin']
      .forEach(k => expect(strings).toContain(`${k}:`));
    // Bilingual content
    expect(strings).toContain('Institution Administrator');
    expect(strings).toContain('Own institution only');
    expect(strings).toContain('ضمن مؤسستك فقط');
    expect(strings).toContain('يمكنك دعوة مستخدمين داخل مؤسستك فقط');
  });

  it('invite activation message contains required bilingual text', () => {
    expect(strings).toContain('سيستلم المستخدم رابطاً على بريده لتفعيل الحساب وتعيين كلمة المرور.');
    expect(strings).toContain('The user will receive an email link to activate the account and set a password.');
  });

  it('password mode warning does not imply emailing a password', () => {
    expect(strings).toContain('um_password_mode_warning:');
    expect(strings).toContain('خارج البريد الإلكتروني');
    expect(strings).toContain('outside email');
  });
});

// ============================================================================
// 3. Permission catalog (allowlist)
// ============================================================================
describe('Permission catalog', () => {
  const REQUIRED = [
    'dashboard.view', 'organizations.view', 'organizations.create', 'organizations.edit', 'organizations.archive',
    'users.view', 'users.create', 'users.assign_role', 'users.manage_permissions',
    'users.disable', 'users.delete',  // migration 011
    'warehouses.view', 'warehouses.manage', 'ports.view', 'ports.create', 'ports.edit', 'ports.archive',
    'qr.view', 'qr.generate', 'qr.revoke', 'availability.view', 'availability.manage',
    'availability.create', 'availability.update', // AVAILABILITY-PERMISSION-MATRIX-INTEGRATION-A
    'availability.quantity.set', 'availability.quantity.add', 'availability.quantity.subtract',
    'availability.quantity.correct', 'availability.movements.view', 'availability.movements.export',
    'availability.movements.print', // AVAILABILITY-QUANTITY-MOVEMENT-DB-A
    'status_center.view', 'status_center.create', 'status_center.edit', 'status_center.resolve',
    'exchange_alerts.view', 'inter_institution_alerts.view', 'status_contacts.view', 'status_contacts.manage',
    'deletion_wizard.view', 'deletion_wizard.clear_port_items', 'deletion_wizard.archive_port', 'deletion_wizard.archive_organization',
    'users.recycle',
  ];

  it('contains exactly the required permission keys', () => {
    expect([...PERMISSION_KEY_SET].sort()).toEqual([...REQUIRED].sort());
  });

  it('canonical permission count is exactly 44 (37 previous + 7 from AVAILABILITY-QUANTITY-MOVEMENT-DB-A)', () => {
    expect(REQUIRED).toHaveLength(44);
    expect(PERMISSION_KEYS).toHaveLength(44);
    expect(PERMISSION_KEY_SET.size).toBe(44);
  });

  it('rejects unknown permission keys', () => {
    expect(isValidPermissionKey('fake.permission')).toBe(false);
    expect(isValidPermissionKey('users.create')).toBe(true);
  });

  it('flags dangerous permissions', () => {
    expect(isDangerousPermission('users.create')).toBe(true);
    expect(isDangerousPermission('organizations.archive')).toBe(true);
    expect(isDangerousPermission('qr.revoke')).toBe(true);
    expect(isDangerousPermission('users.disable')).toBe(true);
    expect(isDangerousPermission('users.delete')).toBe(true);
    expect(isDangerousPermission('dashboard.view')).toBe(false);
  });

  it('users.disable and users.delete are in the users module', () => {
    const mods = permissionsByModule();
    const userKeys = mods.users.map(p => p.key);
    expect(userKeys).toContain('users.disable');
    expect(userKeys).toContain('users.delete');
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
  it('super_admin has every permission (auto-includes migration 011 keys)', () => {
    const d = roleDefaults('super_admin');
    expect(d.size).toBe(PERMISSION_KEYS.length);
    expect(d.has('users.disable')).toBe(true);
    expect(d.has('users.delete')).toBe(true);
  });

  it('viewer is read-only (no create/manage/users/lifecycle)', () => {
    const d = roleDefaults('viewer');
    expect(d.has('dashboard.view')).toBe(true);
    expect(d.has('users.create')).toBe(false);
    expect(d.has('users.disable')).toBe(false);
    expect(d.has('users.delete')).toBe(false);
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

  it('institution_admin can create users in own org, not outside it', () => {
    const d = roleDefaults('institution_admin');
    expect(d.has('users.view')).toBe(true);
    expect(d.has('users.create')).toBe(true);
    expect(d.has('users.assign_role')).toBe(true);
    expect(d.has('dashboard.view')).toBe(true);
    expect(d.has('organizations.view')).toBe(true);
    expect(d.has('status_contacts.manage')).toBe(true);
  });

  it('institution_admin does NOT get dangerous org/user management by default', () => {
    const d = roleDefaults('institution_admin');
    expect(d.has('organizations.create')).toBe(false);
    expect(d.has('organizations.archive')).toBe(false);
    expect(d.has('users.manage_permissions')).toBe(false);
    expect(d.has('users.disable')).toBe(false);
    expect(d.has('users.delete')).toBe(false);
    expect(d.has('deletion_wizard.archive_organization')).toBe(false);
    expect(d.has('deletion_wizard.archive_port')).toBe(false);
  });

  it('institution_admin default count is exactly 22 (15 + 7 quantity/movement keys)', () => {
    expect(roleDefaults('institution_admin').size).toBe(22);
  });

  it('legacy roles inherit their mapped official defaults', () => {
    expect([...roleDefaults('warehouse_manager')].sort()).toEqual([...roleDefaults('warehouse_officer')].sort());
    expect([...roleDefaults('point_operator')].sort()).toEqual([...roleDefaults('port_officer')].sort());
  });
});

// ============================================================================
// 4b. AVAILABILITY-PERMISSION-MATRIX-INTEGRATION-A: availability.create / availability.update
// ============================================================================
describe('Availability create/update permission matrix', () => {
  it('permission catalog contains availability.create and availability.update', () => {
    expect(PERMISSION_KEY_SET.has('availability.create')).toBe(true);
    expect(PERMISSION_KEY_SET.has('availability.update')).toBe(true);
  });

  it('super_admin has availability.create and availability.update', () => {
    const d = roleDefaults('super_admin');
    expect(d.has('availability.create')).toBe(true);
    expect(d.has('availability.update')).toBe(true);
  });

  it('institution_admin has availability.create and availability.update', () => {
    const d = roleDefaults('institution_admin');
    expect(d.has('availability.create')).toBe(true);
    expect(d.has('availability.update')).toBe(true);
  });

  it('hospital_admin (legacy) has availability.create and availability.update', () => {
    const d = roleDefaults('hospital_admin');
    expect(d.has('availability.create')).toBe(true);
    expect(d.has('availability.update')).toBe(true);
  });

  it('warehouse_officer has availability.create and availability.update', () => {
    const d = roleDefaults('warehouse_officer');
    expect(d.has('availability.create')).toBe(true);
    expect(d.has('availability.update')).toBe(true);
  });

  it('warehouse_manager (legacy) has availability.create and availability.update', () => {
    const d = roleDefaults('warehouse_manager');
    expect(d.has('availability.create')).toBe(true);
    expect(d.has('availability.update')).toBe(true);
  });

  it('port_officer has availability.update but NOT availability.create', () => {
    const d = roleDefaults('port_officer');
    expect(d.has('availability.update')).toBe(true);
    expect(d.has('availability.create')).toBe(false);
  });

  it('point_operator (legacy) has availability.update but NOT availability.create', () => {
    const d = roleDefaults('point_operator');
    expect(d.has('availability.update')).toBe(true);
    expect(d.has('availability.create')).toBe(false);
  });

  it('monthly_status_officer / transfer_manager are read-only for availability', () => {
    const monthly = roleDefaults('monthly_status_officer');
    const transfer = roleDefaults('transfer_manager');
    expect(monthly.has('availability.create')).toBe(false);
    expect(monthly.has('availability.update')).toBe(false);
    expect(transfer.has('availability.create')).toBe(false);
    expect(transfer.has('availability.update')).toBe(false);
  });

  it('viewer does not have availability.create or availability.update', () => {
    const d = roleDefaults('viewer');
    expect(d.has('availability.create')).toBe(false);
    expect(d.has('availability.update')).toBe(false);
  });

  it('port_officer does NOT get availability.manage (avoids implying create via the legacy key)', () => {
    const d = roleDefaults('port_officer');
    expect(d.has('availability.manage')).toBe(false);
  });

  it('availability.view remains granted to every role (read access unchanged)', () => {
    for (const role of ['super_admin', 'institution_admin', 'hospital_admin', 'warehouse_officer', 'port_officer', 'monthly_status_officer', 'viewer']) {
      expect(roleDefaults(role).has('availability.view')).toBe(true);
    }
  });
});

// ============================================================================
// 4c. AVAILABILITY-QUANTITY-MOVEMENT-DB-A: quantity movement permission matrix
// ============================================================================
describe('Quantity movement permission matrix', () => {
  const QUANTITY_KEYS = [
    'availability.quantity.set', 'availability.quantity.add',
    'availability.quantity.subtract', 'availability.quantity.correct',
  ];
  const MOVEMENT_KEYS = [
    'availability.movements.view', 'availability.movements.export', 'availability.movements.print',
  ];

  it('permission catalog contains all 7 quantity-movement keys', () => {
    [...QUANTITY_KEYS, ...MOVEMENT_KEYS].forEach(key => expect(PERMISSION_KEY_SET.has(key)).toBe(true));
  });

  it('super_admin has all 7 keys', () => {
    const d = roleDefaults('super_admin');
    [...QUANTITY_KEYS, ...MOVEMENT_KEYS].forEach(key => expect(d.has(key)).toBe(true));
  });

  it('institution_admin has set/add/subtract/correct/view/export/print', () => {
    const d = roleDefaults('institution_admin');
    [...QUANTITY_KEYS, ...MOVEMENT_KEYS].forEach(key => expect(d.has(key)).toBe(true));
  });

  it('hospital_admin (legacy) has set/add/subtract/correct/view/export/print', () => {
    const d = roleDefaults('hospital_admin');
    [...QUANTITY_KEYS, ...MOVEMENT_KEYS].forEach(key => expect(d.has(key)).toBe(true));
  });

  it('warehouse_officer has set/add/subtract/view/export/print but NOT correct', () => {
    const d = roleDefaults('warehouse_officer');
    expect(d.has('availability.quantity.set')).toBe(true);
    expect(d.has('availability.quantity.add')).toBe(true);
    expect(d.has('availability.quantity.subtract')).toBe(true);
    expect(d.has('availability.quantity.correct')).toBe(false);
    expect(d.has('availability.movements.view')).toBe(true);
    expect(d.has('availability.movements.export')).toBe(true);
    expect(d.has('availability.movements.print')).toBe(true);
  });

  it('warehouse_manager (legacy) has set/add/subtract/view/export/print but NOT correct', () => {
    const d = roleDefaults('warehouse_manager');
    expect(d.has('availability.quantity.set')).toBe(true);
    expect(d.has('availability.quantity.correct')).toBe(false);
    expect(d.has('availability.movements.export')).toBe(true);
  });

  it('port_officer has add/subtract/view only', () => {
    const d = roleDefaults('port_officer');
    expect(d.has('availability.quantity.add')).toBe(true);
    expect(d.has('availability.quantity.subtract')).toBe(true);
    expect(d.has('availability.movements.view')).toBe(true);
    expect(d.has('availability.quantity.set')).toBe(false);
    expect(d.has('availability.quantity.correct')).toBe(false);
    expect(d.has('availability.movements.export')).toBe(false);
    expect(d.has('availability.movements.print')).toBe(false);
  });

  it('point_operator (legacy) has add/subtract/view only', () => {
    const d = roleDefaults('point_operator');
    expect(d.has('availability.quantity.add')).toBe(true);
    expect(d.has('availability.quantity.subtract')).toBe(true);
    expect(d.has('availability.movements.view')).toBe(true);
    expect(d.has('availability.quantity.set')).toBe(false);
    expect(d.has('availability.quantity.correct')).toBe(false);
    expect(d.has('availability.movements.export')).toBe(false);
    expect(d.has('availability.movements.print')).toBe(false);
  });

  it('monthly_status_officer and transfer_manager have view only', () => {
    for (const role of ['monthly_status_officer', 'transfer_manager']) {
      const d = roleDefaults(role);
      expect(d.has('availability.movements.view')).toBe(true);
      QUANTITY_KEYS.forEach(key => expect(d.has(key)).toBe(false));
      expect(d.has('availability.movements.export')).toBe(false);
      expect(d.has('availability.movements.print')).toBe(false);
    }
  });

  it('viewer has view only', () => {
    const d = roleDefaults('viewer');
    expect(d.has('availability.movements.view')).toBe(true);
    QUANTITY_KEYS.forEach(key => expect(d.has(key)).toBe(false));
    expect(d.has('availability.movements.export')).toBe(false);
    expect(d.has('availability.movements.print')).toBe(false);
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

  it('local username + temporary password is the only normal create mode (LOCAL-UX-PERMISSION-PERSISTENCE-FIX-A)', () => {
    expect(screen).toContain("loginMode: 'local'");
    expect(screen).not.toContain("useState<'local' | 'email'>");
  });

  it('local creation message is shown in the create form (no email/invite toggle)', () => {
    expect(screen).toContain('um_local_creation_msg');
    expect(screen).not.toContain('um_mode_email_secondary');
  });

  it('hard delete is not exposed in the UI (gated pending next phase)', () => {
    // No deleteTarget state — delete flow is removed from the UI
    expect(screen).not.toContain('deleteTarget');
    // deleteUserViaEdge is not imported in the screen
    expect(screen).not.toMatch(/import[^;]*deleteUserViaEdge/);
    // No delete button rendered — um_delete_user_action not used as a label
    expect(screen).not.toContain('um_delete_user_action');
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
  it('only super_admin can create institution_admin', () => {
    expect(fn).toContain('CANNOT_CREATE_INSTITUTION_ADMIN');
    expect(fn).toContain('institution_admin');
  });
  it('blocks cross-organization creation', () => {
    expect(fn).toContain('CROSS_ORG_FORBIDDEN');
  });
  it('accepts only official roles', () => {
    expect(fn).toContain('OFFICIAL_ROLES');
    expect(fn).toContain('INVALID_ROLE');
  });

  // Password mode support (Part A of USER-CREATION-PASSWORD-DELETE-A)
  it('supports optional password field (Mode 1)', () => {
    expect(fn).toContain('password');
    expect(fn).toContain('PASSWORD_TOO_SHORT');
    expect(fn).toContain('password_mode');
  });
  it('sets email_confirm: true only in password mode', () => {
    expect(fn).toContain('email_confirm: passwordMode');
  });
  it('never logs or stores password in profile', () => {
    // password is NOT included in the upsert payload
    expect(fn).not.toContain("upsert({ id: newId, organization_id: orgId, full_name: fullName, role, status: 'active', password");
  });
  it('raw password string is never in a json response', () => {
    // The response returns password_mode (a boolean flag) which is fine.
    // What must NOT appear: the actual password value echoed back to the caller.
    // Verify the response line only contains password_mode, not the raw password field.
    expect(fn).toContain('password_mode: passwordMode');
    // The password variable is never directly serialized into a response.
    expect(fn).not.toMatch(/json\(\{[^}]*password\s*:/);
  });
});

// ============================================================================
// 9b. admin-user-lifecycle Edge Function safety
// ============================================================================
describe('admin-user-lifecycle Edge Function', () => {
  const fn = readPhoenix('supabase/functions/admin-user-lifecycle/index.ts');

  it('reads service_role only from the server env', () => {
    expect(fn).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
  });
  it('service_role key value is never in a json response body', () => {
    // Acceptable: reading the key from Deno.env into a const.
    // Not acceptable: leaking the key string in a response payload.
    // Check: no line that calls json() also contains the literal key name as a value.
    const lines = fn.split('\n');
    const leaks = lines.filter(l => l.includes('json(') && l.includes('SUPABASE_SERVICE_ROLE_KEY'));
    expect(leaks).toHaveLength(0);
  });
  it('guards against self-action', () => {
    expect(fn).toContain('SELF_ACTION_FORBIDDEN');
  });
  it('guards against last super_admin deletion', () => {
    expect(fn).toContain('LAST_SUPER_ADMIN');
  });
  it('requires confirmation string for hard delete', () => {
    expect(fn).toContain('INVALID_CONFIRMATION');
    expect(fn).toContain('DELETE_USER_');
  });
  it('uses ban_duration to disable users server-side', () => {
    expect(fn).toContain('ban_duration');
    expect(fn).toContain('876000h');
  });
  it('only accepts valid actions', () => {
    expect(fn).toContain('INVALID_ACTION');
    expect(fn).toContain("'disable', 'enable', 'delete'");
  });
  it('requires super_admin or institution_admin caller (with users.disable)', () => {
    expect(fn).toContain('INSUFFICIENT_PERMISSION');
    expect(fn).toContain('institution_admin');
    expect(fn).toContain("p_key: 'users.disable'");
  });
  it('institution_admin cannot act on super_admin or institution_admin targets', () => {
    expect(fn).toContain("'super_admin', 'institution_admin'");
    expect(fn).toContain('CROSS_ORG_FORBIDDEN');
  });
  it('institution_admin cannot hard-delete users', () => {
    // institution_admin scope guard rejects delete action before reaching delete logic
    const lines = fn.split('\n');
    const institutionAdminBlock = lines.slice(
      lines.findIndex(l => l.includes('isCallerInstitutionAdmin')),
      lines.findIndex(l => l.includes("action === 'delete'")) + 5,
    ).join('\n');
    expect(institutionAdminBlock).toContain('INSUFFICIENT_PERMISSION');
  });
});

// ============================================================================
// 10. Migration 010 + 011 safety + 008/009 untouched
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

describe('Migration 011 (user lifecycle)', () => {
  const sql = readPhoenix('supabase/migrations/011_phoenix_user_lifecycle_controls.sql');

  it('inserts users.disable and users.delete permission keys', () => {
    expect(sql).toContain("'users.disable'");
    expect(sql).toContain("'users.delete'");
    expect(sql).toContain('on conflict (key) do nothing');
  });
  it('uses correct column name "allowed" (not "is_allowed") for role_permission_defaults', () => {
    // role_permission_defaults.allowed is the correct column from migration 010
    expect(sql).toContain('role_permission_defaults (role, permission_key, allowed)');
    expect(sql).not.toContain('is_allowed');
  });
  it('adds audit columns with IF NOT EXISTS (safe re-run)', () => {
    expect(sql).toContain('add column if not exists disabled_at');
    expect(sql).toContain('add column if not exists disabled_by');
  });
  it('carries a manual-apply-only warning', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
  });
  it('does not use DROP TABLE or TRUNCATE', () => {
    expect(sql).not.toMatch(/drop table/i);
    expect(sql).not.toMatch(/truncate/i);
  });
});

describe('Migration 012 (institution_admin role)', () => {
  const sql = readPhoenix('supabase/migrations/012_phoenix_institution_admin_role.sql');

  it('carries a manual-apply-only warning', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
  });
  it('expands profiles.role CHECK to include institution_admin', () => {
    expect(sql).toContain("'institution_admin'");
    expect(sql).toContain('profiles_role_check');
  });
  it('seeds institution_admin role defaults (13 required permissions)', () => {
    const insertBlock = sql.substring(sql.indexOf('institution_admin'));
    [
      'dashboard.view', 'organizations.view', 'users.view', 'users.create', 'users.assign_role',
      'warehouses.view', 'ports.view', 'availability.view', 'status_center.view',
      'exchange_alerts.view', 'inter_institution_alerts.view',
      'status_contacts.view', 'status_contacts.manage',
    ].forEach(key => expect(insertBlock).toContain(key));
  });
  it('conditionally grants users.disable if migration 011 key exists (safe no-op if not)', () => {
    expect(sql).toContain("key = 'users.disable'");
    // The conditional insert selects from permission_keys — if key doesn't exist, 0 rows inserted
    expect(sql).toContain('select');
    expect(sql).toContain('from permission_keys');
  });
  it('uses correct column name "allowed" for role_permission_defaults', () => {
    expect(sql).toContain('role_permission_defaults (role, permission_key, allowed)');
    expect(sql).not.toContain('is_allowed');
  });
  it('does not use DROP TABLE or TRUNCATE', () => {
    expect(sql).not.toMatch(/drop table/i);
    expect(sql).not.toMatch(/truncate/i);
  });
  it('explicitly warns against supabase db push', () => {
    // The migration should contain a "DO NOT use supabase db push" warning comment.
    expect(sql).toContain('DO NOT use');
    expect(sql).toContain('supabase db push');
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

// ============================================================================
// 12. institution_admin UI scoping (INSTITUTION-ADMIN-USER-SCOPE-A)
// ============================================================================
describe('institution_admin role scoping (UI + Edge Function)', () => {
  const screen = readSrc('features/users/UserManagementScreen.tsx');
  const createFn = readPhoenix('supabase/functions/admin-create-user/index.ts');
  const lifecycleFn = readPhoenix('supabase/functions/admin-user-lifecycle/index.ts');

  it('CreateUserForm accepts actorRole prop and uses canTargetRole for filtering', () => {
    expect(screen).toContain('actorRole');
    expect(screen).toContain('canTargetRole(actorRole, r)');
  });

  it('CreateUserForm shows own-institution-only scope badge for institution_admin', () => {
    expect(screen).toContain('um_invite_own_org_only');
    expect(screen).toContain('isInstitutionAdmin');
  });

  it('CreateUserForm guards CANNOT_CREATE_INSTITUTION_ADMIN server error', () => {
    expect(screen).toContain('CANNOT_CREATE_INSTITUTION_ADMIN');
    expect(screen).toContain('um_cannot_create_institution_admin');
  });

  it('CreateUserForm client-side guard: non-super cannot pick institution_admin', () => {
    expect(screen).toContain("selRole === 'institution_admin' && !isSuper");
  });

  it('admin-create-user lists institution_admin as an official role', () => {
    expect(createFn).toContain("'institution_admin'");
  });

  it('admin-create-user blocks non-super from creating institution_admin', () => {
    expect(createFn).toContain("role === 'institution_admin' && !isSuper");
    expect(createFn).toContain('CANNOT_CREATE_INSTITUTION_ADMIN');
  });

  it('admin-user-lifecycle allows institution_admin caller with users.disable', () => {
    expect(lifecycleFn).toContain('isCallerInstitutionAdmin');
    expect(lifecycleFn).toContain("p_key: 'users.disable'");
  });

  it('admin-user-lifecycle institution_admin cross-org guard', () => {
    expect(lifecycleFn).toContain('CROSS_ORG_FORBIDDEN');
    expect(lifecycleFn).toContain('organization_id');
  });

  it('institution_admin canTargetRole: can create operator-level roles, not admin-level', () => {
    expect(canTargetRole('institution_admin', 'warehouse_officer')).toBe(true);
    expect(canTargetRole('institution_admin', 'port_officer')).toBe(true);
    expect(canTargetRole('institution_admin', 'monthly_status_officer')).toBe(true);
    expect(canTargetRole('institution_admin', 'viewer')).toBe(true);
    expect(canTargetRole('institution_admin', 'super_admin')).toBe(false);
    expect(canTargetRole('institution_admin', 'institution_admin')).toBe(false);
  });
});

// ============================================================================
// 13. super_admin effective permission resolution (SUPERADMIN-PORT-PERMISSION-RESOLUTION-FIX-A)
// ============================================================================
describe('super_admin effective permission resolution', () => {
  const appCtx  = readSrc('app/AppContext.tsx');
  const instScreen = readSrc('features/institutions/InstitutionScreen.tsx');

  // roleDefaults('super_admin') is the source of truth for the frontend catalog
  it('super_admin roleDefaults includes ports.create, ports.view, ports.edit, ports.archive', () => {
    const d = roleDefaults('super_admin');
    expect(d.has('ports.create')).toBe(true);
    expect(d.has('ports.view')).toBe(true);
    expect(d.has('ports.edit')).toBe(true);
    expect(d.has('ports.archive')).toBe(true);
  });

  it('super_admin roleDefaults includes qr.generate and qr.revoke', () => {
    const d = roleDefaults('super_admin');
    expect(d.has('qr.generate')).toBe(true);
    expect(d.has('qr.revoke')).toBe(true);
  });

  it('super_admin roleDefaults has ALL permission keys in the frontend catalog', () => {
    const d = roleDefaults('super_admin');
    for (const key of PERMISSION_KEY_SET) {
      expect(d.has(key)).toBe(true);
    }
    expect(d.size).toBe(PERMISSION_KEYS.length);
  });

  it('AppContext augments super_admin permissions with PERMISSION_KEY_SET when DB returns partial result', () => {
    // Confirms the fix: AppContext adds all keys from PERMISSION_KEY_SET for super_admin
    // even if the DB returned a partial or empty permissions object.
    expect(appCtx).toContain("p.role === 'super_admin'");
    expect(appCtx).toContain('PERMISSION_KEY_SET');
    expect(appCtx).toContain('perms.add(key)');
  });

  it('AppContext imports PERMISSION_KEY_SET from permissions', () => {
    expect(appCtx).toContain('PERMISSION_KEY_SET');
    expect(appCtx).toMatch(/import[^;]*PERMISSION_KEY_SET[^;]*from[^;]*permissions/);
  });

  it('institution_admin does NOT get ports.create by roleDefaults', () => {
    const d = roleDefaults('institution_admin');
    expect(d.has('ports.create')).toBe(false);
  });

  it('institution_admin CAN get ports.create via explicit effectivePermissions override', () => {
    const d = effectivePermissions('institution_admin', { 'ports.create': true });
    expect(d.has('ports.create')).toBe(true);
  });

  it('institution_admin WITHOUT explicit ports.create cannot submit AddPortForm (canCreate stays false)', () => {
    // roleDefaults for institution_admin has ports.view but not ports.create
    const d = roleDefaults('institution_admin');
    expect(d.has('ports.view')).toBe(true);
    expect(d.has('ports.create')).toBe(false);
  });

  it('viewer cannot create ports by default', () => {
    const d = roleDefaults('viewer');
    expect(d.has('ports.create')).toBe(false);
  });

  it('AddPortForm shows perm_no_create_ports only from !canCreate early-return, not from catch block', () => {
    const addFormStart = instScreen.indexOf('function AddPortForm');
    const addFormEnd   = instScreen.indexOf('function PortCard');
    const addFormBody  = instScreen.slice(addFormStart, addFormEnd);
    // The early-return guard still exists
    expect(addFormBody).toContain("if (!canCreate)");
    expect(addFormBody).toContain("perm_no_create_ports");
    // The catch block must NOT re-show perm_no_create_ports
    const catchStart = addFormBody.indexOf('} catch (e)');
    const catchBody  = addFormBody.slice(catchStart);
    expect(catchBody).not.toContain('perm_no_create_ports');
  });

  it('AddPortForm catch block does not match on "row-level security" or "permission" keyword for error routing', () => {
    const addFormStart = instScreen.indexOf('function AddPortForm');
    const addFormEnd   = instScreen.indexOf('function PortCard');
    const addFormBody  = instScreen.slice(addFormStart, addFormEnd);
    const catchStart   = addFormBody.indexOf('} catch (e)');
    const catchBody    = addFormBody.slice(catchStart);
    expect(catchBody).not.toContain('row-level security');
    expect(catchBody).not.toContain("'RLS'");
    expect(catchBody).not.toContain("'permission'");
    expect(catchBody).not.toContain('INSUFFICIENT');
  });

  it('no service_role usage in InstitutionScreen', () => {
    expect(instScreen).not.toContain('service_role');
    expect(instScreen).not.toContain('SUPABASE_SERVICE');
  });

  it('no auth.admin usage in InstitutionScreen', () => {
    expect(instScreen).not.toContain('auth.admin');
    expect(instScreen).not.toContain('supabaseAdmin');
  });

  it('Data Reset absent from InstitutionScreen', () => {
    expect(instScreen).not.toMatch(/DataReset|data-reset/i);
  });

  it('Intake/OCR/Excel/DocIntel imports absent', () => {
    expect(instScreen).not.toMatch(/import.*OcrImport|import.*ExcelImport|import.*DocIntel/i);
  });
});
