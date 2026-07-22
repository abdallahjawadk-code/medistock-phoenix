/**
 * ROLE-REORG-§5 — five-role screen access + institutions-page lockdown.
 *
 * The server RLS/RPCs are the real boundary; these pin the UX gate agreement
 * across sidebar, drawer, palette and route guard, plus the assignment
 * protections (no self-escalation, no equal-or-higher grant).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { institutionsScreenAccess, isPlatformAdmin, isInstitutionAdmin } from '../screen-access';
import { canAssignRole, ASSIGNABLE_ROLES_BY_ACTOR } from '@/shared/lib/types';

const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

describe('institutions page access is platform-admin exclusive', () => {
  it('platform admin gets the global directory', () => {
    expect(institutionsScreenAccess('super_admin')).toBe('directory');
    expect(isPlatformAdmin('super_admin')).toBe(true);
  });

  it('institution / legacy org admin gets ONLY their own organization', () => {
    expect(institutionsScreenAccess('institution_admin')).toBe('own');
    expect(institutionsScreenAccess('hospital_admin')).toBe('own');
    expect(isInstitutionAdmin('institution_admin')).toBe(true);
  });

  it('every other operational role is refused', () => {
    for (const role of ['central_warehouse_manager', 'warehouse_officer', 'outlet_officer', 'monthly_status_officer', 'viewer', '']) {
      expect(institutionsScreenAccess(role), role).toBe(false);
    }
  });
});

describe('every navigation surface AND the route guard use the one predicate', () => {
  it('sidebar, drawer and palette gate screen 11 on institutionsScreenAccess', () => {
    for (const rel of ['shared/ui/PhoenixSidebar.tsx', 'shared/ui/PhoenixMobileDrawer.tsx', 'shared/ui/CommandPalette.tsx']) {
      const src = read(rel);
      expect(src, rel).toContain('institutionsScreenAccess');
      // and relabels to My Organization for the 'own' tier.
      expect(src, rel).toContain("'nav_my_organization'");
    }
  });

  it('the route guard renders a Forbidden screen for a refused direct navigation', () => {
    const app = read('app/AuthenticatedApp.tsx');
    expect(app).toContain('institutionsScreenAccess(role) === false');
    expect(app).toContain('<ForbiddenScreen />');
  });
});

describe('role assignment protections (self-escalation / equal-or-higher)', () => {
  it('platform admin may assign any role', () => {
    expect(canAssignRole('super_admin', 'super_admin')).toBe(true);
    expect(canAssignRole('super_admin', 'institution_admin')).toBe(true);
  });

  it('an institution admin can NEVER grant its own tier or higher', () => {
    expect(canAssignRole('institution_admin', 'institution_admin')).toBe(false);
    expect(canAssignRole('institution_admin', 'super_admin')).toBe(false);
    expect(canAssignRole('institution_admin', 'central_warehouse_manager')).toBe(false);
    // …only strictly-lower operational roles.
    expect(canAssignRole('institution_admin', 'warehouse_officer')).toBe(true);
    expect(canAssignRole('institution_admin', 'outlet_officer')).toBe(true);
  });

  it('non-admin roles can assign nothing', () => {
    for (const role of ['central_warehouse_manager', 'warehouse_officer', 'outlet_officer'] as const) {
      expect(ASSIGNABLE_ROLES_BY_ACTOR[role]).toEqual([]);
    }
  });
});
