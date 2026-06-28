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

const SRC = join(__dirname, '../../..');

function readSrc(rel: string) {
  return readFileSync(join(SRC, rel), 'utf8');
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
