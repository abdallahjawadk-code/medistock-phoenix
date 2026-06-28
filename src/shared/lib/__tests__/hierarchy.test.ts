import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  canAssignRole,
  isAdminRole,
  canManageOrg,
  ASSIGNABLE_ROLES_BY_ACTOR,
} from '../types';
import type { Role } from '../types';

const SRC     = join(__dirname, '../../..');
const PHOENIX = join(__dirname, '../../../..');

function readSrc(rel: string) {
  return readFileSync(join(SRC, rel), 'utf8');
}

function readPhoenix(rel: string) {
  return readFileSync(join(PHOENIX, rel), 'utf8');
}

describe('Role hierarchy helpers', () => {
  it('super_admin can assign any role', () => {
    const roles: Role[] = ['super_admin', 'hospital_admin', 'warehouse_manager', 'point_operator', 'viewer'];
    roles.forEach(r => expect(canAssignRole('super_admin', r)).toBe(true));
  });

  it('hospital_admin can assign all roles except super_admin', () => {
    expect(canAssignRole('hospital_admin', 'hospital_admin')).toBe(true);
    expect(canAssignRole('hospital_admin', 'warehouse_manager')).toBe(true);
    expect(canAssignRole('hospital_admin', 'point_operator')).toBe(true);
    expect(canAssignRole('hospital_admin', 'viewer')).toBe(true);
    expect(canAssignRole('hospital_admin', 'super_admin')).toBe(false);
  });

  it('warehouse_manager cannot assign any role', () => {
    expect(canAssignRole('warehouse_manager', 'viewer')).toBe(false);
  });

  it('point_operator cannot assign any role', () => {
    expect(canAssignRole('point_operator', 'viewer')).toBe(false);
  });

  it('viewer cannot assign any role', () => {
    expect(canAssignRole('viewer', 'viewer')).toBe(false);
  });

  it('isAdminRole identifies admin-level roles', () => {
    expect(isAdminRole('super_admin')).toBe(true);
    expect(isAdminRole('hospital_admin')).toBe(true);
    expect(isAdminRole('warehouse_manager')).toBe(false);
    expect(isAdminRole('point_operator')).toBe(false);
    expect(isAdminRole('viewer')).toBe(false);
  });

  it('canManageOrg is super_admin only', () => {
    expect(canManageOrg('super_admin')).toBe(true);
    expect(canManageOrg('hospital_admin')).toBe(false);
    expect(canManageOrg('warehouse_manager')).toBe(false);
  });

  it('ASSIGNABLE_ROLES_BY_ACTOR: hospital_admin cannot assign super_admin', () => {
    expect(ASSIGNABLE_ROLES_BY_ACTOR.hospital_admin).not.toContain('super_admin');
  });

  it('ASSIGNABLE_ROLES_BY_ACTOR: non-admin roles have empty assignable list', () => {
    expect(ASSIGNABLE_ROLES_BY_ACTOR.warehouse_manager).toHaveLength(0);
    expect(ASSIGNABLE_ROLES_BY_ACTOR.point_operator).toHaveLength(0);
    expect(ASSIGNABLE_ROLES_BY_ACTOR.viewer).toHaveLength(0);
  });
});

describe('types.ts: no hardcoded institution codes', () => {
  const types = readSrc('shared/lib/types.ts');

  it('does not contain hardcoded institution codes', () => {
    expect(types).not.toMatch(/'marjan'|'hilla'|'babil'|'mahawil'/);
  });

  it('does not export Institution interface with hardcoded code union', () => {
    expect(types).not.toMatch(/code:\s*'marjan'/);
  });

  it('does not export BridgeLink interface', () => {
    expect(types).not.toContain('BridgeLink');
  });

  it('does not export InstitutionStatus type', () => {
    expect(types).not.toContain('InstitutionStatus');
  });

  it('exports Organization interface aligned with DB schema', () => {
    expect(types).toContain('Organization');
    expect(types).toContain('OrganizationStatus');
  });

  it('exports ProfileRow interface', () => {
    expect(types).toContain('ProfileRow');
  });

  it('AllowlistedEntityType includes warehouse and distribution_point', () => {
    expect(types).toContain("'warehouse'");
    expect(types).toContain("'distribution_point'");
    expect(types).toContain("'local_item'");
  });
});

describe('Institution management: bilingual display', () => {
  const strings = readSrc('shared/i18n/strings.ts');

  it('has bilingual institution management keys', () => {
    expect(strings).toContain('nav_institutions');
    expect(strings).toContain('inst_sub');
    expect(strings).toContain('inst_add');
    expect(strings).toContain('inst_edit');
    expect(strings).toContain('inst_users');
    expect(strings).toContain('inst_name_en');
    expect(strings).toContain('inst_name_ar');
  });

  it('has bilingual role labels', () => {
    expect(strings).toContain('role_super_admin');
    expect(strings).toContain('role_hospital_admin');
    expect(strings).toContain('role_warehouse_manager');
    expect(strings).toContain('role_point_operator');
    expect(strings).toContain('role_viewer');
  });

  it('has user creation limitation notice', () => {
    expect(strings).toContain('user_create_notice');
  });
});

describe('InstitutionScreen: safety checks', () => {
  const screen = readSrc('features/institutions/InstitutionScreen.tsx');

  it('does not import service_role or admin API', () => {
    expect(screen).not.toContain('service_role');
    expect(screen).not.toContain('admin.');
  });

  it('uses canManageOrg for org CRUD gating', () => {
    expect(screen).toContain('canManageOrg');
  });

  it('uses canAssignRole for role change gating', () => {
    expect(screen).toContain('canAssignRole');
  });

  it('uses dir="ltr" for technical identifiers', () => {
    expect(screen).toContain('dir="ltr"');
  });

  it('uses dir="auto" for user-entered content', () => {
    expect(screen).toContain('dir="auto"');
  });

  it('uses dir="rtl" for Arabic name input', () => {
    expect(screen).toContain('dir="rtl"');
  });

  it('does not contain DataReset or OCR imports', () => {
    expect(screen).not.toMatch(/DataReset|OCR|DocIntel|ExcelImport/i);
  });

  it('handles RPC escalation errors with bilingual messages', () => {
    expect(screen).toContain('CANNOT_ESCALATE_TO_SUPER_ADMIN');
    expect(screen).toContain('CANNOT_MODIFY_OTHER_ORG');
    expect(screen).toContain('CANNOT_CHANGE_OWN_ROLE');
    expect(screen).toContain('role_no_escalate');
  });
});

describe('Role assignment: RPC-based (not direct update)', () => {
  const orgService = readSrc('shared/supabase/services/organizations.service.ts');

  it('updateProfileRole calls assign_profile_role RPC', () => {
    expect(orgService).toContain('assign_profile_role');
    expect(orgService).toContain("supabase.rpc('assign_profile_role'");
  });

  it('updateProfileRole does NOT use direct .update() on profiles', () => {
    const fnStart = orgService.indexOf('async function updateProfileRole');
    const fnEnd = orgService.indexOf('}', orgService.indexOf('return result', fnStart));
    const fnBody = orgService.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/\.from\(['"]profiles['"]\)\s*\.\s*update/);
  });

  it('updateProfileRole rejects non-ok RPC responses', () => {
    expect(orgService).toContain('ROLE_ASSIGN_FAILED');
    expect(orgService).toContain('result.ok');
  });
});

describe('Migration 005: assign_profile_role RPC security', () => {
  const sql = readPhoenix('supabase/migrations/005_phoenix_assign_profile_role.sql');

  it('is SECURITY DEFINER', () => {
    expect(sql).toContain('security definer');
  });

  it('sets search_path to public, pg_temp', () => {
    expect(sql).toContain('set search_path = public, pg_temp');
  });

  it('checks auth.uid() is not null', () => {
    expect(sql).toContain('auth.uid()');
    expect(sql).toContain('NOT_AUTHENTICATED');
  });

  it('validates role against allowlist', () => {
    expect(sql).toContain('INVALID_ROLE');
    expect(sql).toContain("'super_admin', 'hospital_admin', 'warehouse_manager', 'point_operator', 'viewer'");
  });

  it('blocks self-assignment', () => {
    expect(sql).toContain('CANNOT_CHANGE_OWN_ROLE');
    expect(sql).toContain('p_target_id = v_actor_id');
  });

  it('blocks hospital_admin from assigning super_admin', () => {
    expect(sql).toContain('CANNOT_ESCALATE_TO_SUPER_ADMIN');
    expect(sql).toContain("p_new_role = 'super_admin'");
  });

  it('blocks hospital_admin from modifying profiles outside own org', () => {
    expect(sql).toContain('CANNOT_MODIFY_OTHER_ORG');
    expect(sql).toContain('v_target.organization_id is distinct from v_actor_org_id');
  });

  it('blocks hospital_admin from modifying super_admin profiles', () => {
    expect(sql).toContain('CANNOT_MODIFY_SUPER_ADMIN');
  });

  it('only super_admin and hospital_admin can assign roles', () => {
    expect(sql).toContain('INSUFFICIENT_ROLE');
    expect(sql).toContain("v_actor_role not in ('super_admin', 'hospital_admin')");
  });

  it('writes audit log on role change', () => {
    expect(sql).toContain("'role_assigned'");
    expect(sql).toContain('previous_role');
    expect(sql).toContain('new_role');
  });

  it('is not granted to anon', () => {
    expect(sql).toContain('revoke all on function assign_profile_role');
    expect(sql).toContain('from anon');
  });

  it('is granted to authenticated', () => {
    expect(sql).toContain('grant execute on function assign_profile_role');
    expect(sql).toContain('to authenticated');
  });
});

describe('Disabled modules remain disabled', () => {
  const frozen = readSrc('features/health/IntakeFrozenScreen.tsx');

  it('IntakeFrozenScreen still shows frozen state', () => {
    expect(frozen.toLowerCase()).toMatch(/frozen|مجمد|blocked|محظور/);
  });

  it('IntakeFrozenScreen does not import OCR/Excel/DocIntel', () => {
    expect(frozen).not.toMatch(/import.*[Oo]cr/);
    expect(frozen).not.toMatch(/import.*[Ee]xcel/);
    expect(frozen).not.toMatch(/import.*[Dd]oc[Ii]ntel/);
  });
});
