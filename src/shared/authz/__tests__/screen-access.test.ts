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
import { institutionsScreenAccess, isPlatformAdmin, isInstitutionAdmin, roleLandingScreen } from '../screen-access';
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

describe('authenticated landing is role-safe and session-scoped', () => {
  it('lands outlet officers in Outlet Operations instead of privileged reports', () => {
    expect(roleLandingScreen('outlet_officer')).toBe(18);
    expect(roleLandingScreen(undefined)).toBe(18);
    for (const role of ['super_admin', 'institution_admin', 'central_warehouse_manager', 'warehouse_officer']) {
      expect(roleLandingScreen(role), role).toBe(21);
    }
  });

  it('waits for the real profile and never reuses navigation from another profile', () => {
    const app = read('app/AuthenticatedApp.tsx');
    // PHASE-B1-AUTH-RESILIENCE-RACE: the wait this test pins got STRICTER, not
    // weaker. `!profile` alone would open the shell on any profile object that
    // happened to be in state — including one left over from the previous user
    // while the current session's read is still in flight. The gate is now the
    // `authenticated` state, which additionally requires the loaded profile to
    // belong to THIS session.
    expect(app).toContain("if (authStatus !== 'authenticated' || !profile) {");
    expect(app).toContain('navigation?.profileId === profile.id');
    expect(app).toContain('resolveRestoredScreen(profile.id, profile.role, myPermissions)');
    expect(read('app/screen-continuity.ts')).toContain('roleLandingScreen(role)');
    expect(app).toContain('setNavigation({ profileId: profile.id, screen: nextScreen })');
    expect(app).toContain('setNavigation(null);');
    expect(app).not.toContain('const [screen, setScreen] = useState(21);');
  });
});

describe('every navigation surface AND the route guard use the one predicate', () => {
  /**
   * R1.1-P (P1): screen 11's two-tier gate is now reached through the shared
   * projection rather than called directly in each component, and the bottom
   * nav — previously absent from this list — is held to it too. The relabel to
   * "My Organization" moved with the gate into nav-projection.ts, so this
   * follows the decision to its single home instead of expecting three copies.
   */
  it('every nav surface gates screen 11 through the shared projection, which uses institutionsScreenAccess', () => {
    for (const rel of [
      'shared/ui/PhoenixSidebar.tsx',
      'shared/ui/PhoenixMobileDrawer.tsx',
      'shared/ui/PhoenixMobileBottomNav.tsx',
      'shared/ui/CommandPalette.tsx',
    ]) {
      const src = read(rel);
      expect(src, rel).toContain("from '@/shared/authz/nav-projection'");
      expect(src, rel).toContain('projectNavigation(');
    }
    const projection = read('shared/authz/nav-projection.ts');
    expect(projection).toContain('institutionsScreenAccess');
    // and relabels to My Organization for the 'own' tier.
    expect(projection).toContain("'nav_my_organization'");
    expect(projection).toContain('isScreenAuthorized(');
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
