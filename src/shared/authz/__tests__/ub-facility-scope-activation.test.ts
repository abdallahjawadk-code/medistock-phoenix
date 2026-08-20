/**
 * R1.1-U / U-B — SAFE ACTIVATION of the facility-scoped role, frontend side.
 *
 * The database is the authority and is proved separately in
 * supabase/migrations/__tests__/182-ub-facility-confidentiality.dynamic.test.ts.
 * What is proved HERE is the client contract that must agree with it:
 *
 *   · the scope reader actually transports facility rows (they were being
 *     silently dropped, which gave a manager valid DB scope and an empty UI);
 *   · the projection derives resources from facilities WITHOUT flattening two
 *     centres into whole-sector access, and WITHOUT ever reaching the sector
 *     main;
 *   · the role lands on a facility-safe surface;
 *   · report tabs whose only boundary is `authenticated_rls` are DENIED to the
 *     role rather than filtered client-side;
 *   · none of this changes any pre-existing role.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { roleLandingScreen, institutionsScreenAccess, isScreenAuthorized } from '../screen-access';
import { isScreenRestorable } from '@/app/screen-continuity';
import { allowedReportTabs, resolveAllowedReportTab, REPORT_TAB_ACCESS, REPORT_TAB_ORDER } from '@/features/reports/report-tab-access';
import { isFacilityScopedRole, OFFICIAL_ROLES } from '@/shared/lib/roles';
import { roleDefaults } from '@/shared/lib/permissions';

const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const ROLE = 'health_center_manager';
const perms = (r: string) => roleDefaults(r);

describe('U-B · the scope reader transports facility assignments', () => {
  const svc = read('shared/authz/rbac.service.ts');

  it('selects facility_id — without it a facility row arrives with no target at all', () => {
    expect(svc).toMatch(
      /\.select\('id, scope_type, organization_id, warehouse_id, distribution_point_id, facility_id'\)/,
    );
  });

  it('types the facility scope kind and carries facilityId through the mapping', () => {
    expect(svc).toContain("scopeType: 'warehouse' | 'distribution_point' | 'facility'");
    expect(svc).toContain('facilityId: string | null');
    expect(svc).toMatch(/facilityId:\s+\(r\.facility_id \?\? null\) as string \| null/);
  });

  it('still reads only profile_scope_assignments — no new table, no new RPC', () => {
    const tables = [...svc.matchAll(/\.from\('([a-z_]+)'\)/g)].map(m => m[1]);
    expect([...new Set(tables)]).toEqual(['profile_scope_assignments']);
  });
});

// G4.2 RE-POINTED — the guard is not weakened, it follows the decision.
//
// U-B's requirements are unchanged: a facility-scoped manager must reach its
// centre depots, must NEVER reach the sector main, and an outlet must follow
// its owning depot. What changed is WHERE that is decided. It used to be
// recomputed in this hook from `facilityId !== null` plus the assignment rows
// — an approximation, because `warehouses.is_main` never reached the browser.
// Migration 191 moved it to `phoenix_query_organization_scope_topology`, which
// delegates verbatim to `phoenix_profile_has_warehouse_assignment` (062 +
// 182's facility branch) — the SAME authority the server enforces with.
//
// So the client-side assertions below become their exact inverse: the
// reconstruction must be ABSENT, and the canonical query must be the source.
// The behavioural proofs live in the 191 dynamic suite, against a real
// database, which is strictly stronger than a source scan ever was.
describe('U-B · the projection is DB-derived, and the client reconstructs nothing', () => {
  const hook = read('features/inventory/useInventoryScopes.ts');

  it('no longer walks scope assignments to derive facility resources', () => {
    expect(hook).not.toContain("a.scopeType === 'facility'");
    expect(hook).not.toContain('assignedFacilities');
    expect(hook).not.toContain('facilityDerivedWarehouses');
  });

  it('SECTOR-MAIN EXCLUSION: no facility-null test decides scope in the client', () => {
    // The exclusion still holds — it is now 182's helper, reached through 191,
    // and it uses the COMPLETE 181 rule rather than the NULL alone.
    const code = hook.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/facilityId\s*!==\s*null/);
    expect(code).not.toMatch(/facilityId\s*===\s*null/);
  });

  it('outlets follow their owning depot by the SERVER answer, not a client walk', () => {
    expect(hook).not.toMatch(/reachableWarehouse\(o\.warehouseId\)/);
    expect(hook).toContain('outlets.filter(o => o.inEffectiveScope)');
  });

  it('reads the canonical topology query for the primary organization', () => {
    expect(hook).toContain('getOrganizationScopeTopology');
    expect(hook).toContain("from '@/shared/supabase/services/scope-topology.service'");
  });

  it('preserves the organization-wide short-circuit for roles that legitimately have it', () => {
    // PERMISSION, not scope — deliberately still decided client-side from an
    // exact 062 answer. The pinned line other suites assert on survives verbatim.
    expect(hook).toContain('const manageableWarehouses = managesWholeOrganization');
    expect(hook).toContain('const managesWholeOrganization = superAdmin || canManageOrganization');
  });

  it('does NOT add the facility-scoped role to any organization-wide branch', () => {
    expect(hook).not.toContain(ROLE);
  });
});

describe('U-B · landing is facility-safe', () => {
  it('the facility-scoped role does NOT land on the reports surface', () => {
    expect(roleLandingScreen(ROLE)).not.toBe(21);
  });

  it('it lands on the outlet surface, which self-gates on its derived outlets', () => {
    expect(roleLandingScreen(ROLE)).toBe(18);
  });

  it('every pre-existing role keeps its exact landing', () => {
    expect(roleLandingScreen('outlet_officer')).toBe(18);
    expect(roleLandingScreen('warehouse_officer')).toBe(21);
    expect(roleLandingScreen('institution_admin')).toBe(21);
    expect(roleLandingScreen('super_admin')).toBe(21);
    expect(roleLandingScreen('central_warehouse_manager')).toBe(21);
    // An unknown role still normalizes to the least-privileged identity.
    expect(roleLandingScreen('not_a_role')).toBe(18);
  });

  it('the role reaches no institutions surface', () => {
    expect(institutionsScreenAccess(ROLE)).toBe(false);
  });
});

describe('U-B · report tabs whose only boundary is RLS are DENIED, not filtered', () => {
  const tabs = allowedReportTabs(perms(ROLE), ROLE);

  it('the role receives NO authenticated_rls tab', () => {
    const rlsTabs = REPORT_TAB_ORDER.filter(t => REPORT_TAB_ACCESS[t].kind === 'authenticated_rls');
    expect(rlsTabs.length).toBeGreaterThan(0);
    for (const t of rlsTabs) expect(tabs, t).not.toContain(t);
  });

  it('it receives no permission-gated tab either, holding neither key', () => {
    expect(tabs).not.toContain('movements');
    expect(tabs).not.toContain('audit');
  });

  it('Global Search stays super_admin-only', () => {
    expect(tabs).not.toContain('global');
    expect(allowedReportTabs(perms('super_admin'), 'super_admin')).toContain('global');
  });

  it('with no allowed tab the screen resolves to null — a Forbidden render, not a leak', () => {
    expect(tabs).toEqual([]);
    expect(resolveAllowedReportTab('materials', tabs)).toBeNull();
  });

  it('EVERY pre-existing role keeps its exact tab set', () => {
    for (const role of OFFICIAL_ROLES.filter(r => !isFacilityScopedRole(r))) {
      const before = REPORT_TAB_ORDER.filter(tab => {
        const rule = REPORT_TAB_ACCESS[tab];
        if (rule.kind === 'authenticated_rls') return true;
        if (rule.kind === 'permission') return perms(role).has(rule.permission);
        return role === rule.role;
      });
      expect(allowedReportTabs(perms(role), role), role).toEqual(before);
    }
  });

  it('REPORT_TAB_ACCESS itself is unchanged — the denial is layered, not rewritten', () => {
    const src = read('features/reports/report-tab-access.ts');
    expect(src).toContain("overview: { kind: 'authenticated_rls' }");
    expect(src).toContain("movements: { kind: 'permission', permission: 'status_center.view' }");
    expect(src).toContain("audit: { kind: 'permission', permission: 'audit.view' }");
    expect(src).toContain("global: { kind: 'role', role: 'super_admin' }");
  });
});

describe('U-B · restoration and persistence cannot revive a denied screen', () => {
  const continuity = read('app/screen-continuity.ts');

  it('a restored screen is re-authorised, never trusted from storage', () => {
    expect(continuity).toContain('export function isScreenRestorable');
    // The restorable set is an allow-list, so an unknown screen fails closed.
    expect(continuity).toMatch(/if \(!\[[\d, ]+\]\.includes\(screen\)\) return false;/);
  });

  it('an unauthorised restore falls back to the ROLE LANDING, which is now safe', () => {
    expect(continuity).toContain('roleLandingScreen');
  });
});

/**
 * R1.1-U (U-B corrective, C2).
 *
 * An independent audit classified the restorable-screen gap as "no data escape"
 * because screen 21 renders empty for this role. That is not an authorization
 * decision — it is a coincidence of the current data. These tests assert the
 * DECISION itself: the screen must be refused, whatever it would have rendered.
 */
describe('U-B corrective · the canonical screen decision refuses unsafe surfaces', () => {
  const noPerms = new Set<string>();
  const continuity = read('app/screen-continuity.ts');

  it('the reports surface is REFUSED, not merely rendered empty', () => {
    expect(isScreenAuthorized(21, ROLE, perms(ROLE))).toBe(false);
    // ...and it is refused for the reason that matters: the decision does not
    // depend on the tab list happening to be empty.
    expect(allowedReportTabs(perms(ROLE), ROLE)).toEqual([]);
  });

  it('every organization-level screen is refused to the facility-scoped role', () => {
    // 11 institutions · 13 inter-institution alerts · 14 users · 17 network
    // · 19 local procurement · 21 reports
    for (const s of [11, 13, 14, 17, 19, 21]) {
      expect(isScreenAuthorized(s, ROLE, perms(ROLE)), `screen ${s}`).toBe(false);
    }
  });

  it('the facility-safe surfaces stay reachable, or the role is unusable', () => {
    for (const s of [3, 6, 15, 18]) {
      expect(isScreenAuthorized(s, ROLE, perms(ROLE)), `screen ${s}`).toBe(true);
    }
    // The landing must itself be authorized, or login lands on a refusal.
    expect(isScreenAuthorized(roleLandingScreen(ROLE), ROLE, perms(ROLE))).toBe(true);
  });

  it('is an ALLOW-list: an unknown future screen is refused to this role', () => {
    for (const s of [7, 8, 16, 20, 22, 99]) {
      expect(isScreenAuthorized(s, ROLE, perms(ROLE)), `screen ${s}`).toBe(false);
    }
  });

  it('restoration, refresh and Back all inherit that decision', () => {
    // isScreenRestorable is what resolveRestoredScreen and screenFromPopState
    // both consult, so proving it here covers persisted state, reload and
    // browser history in one place.
    expect(isScreenRestorable(21, ROLE, perms(ROLE))).toBe(false);
    expect(isScreenRestorable(13, ROLE, perms(ROLE))).toBe(false);
    expect(isScreenRestorable(18, ROLE, perms(ROLE))).toBe(true);
  });

  it('no historical role loses a screen it could reach before', () => {
    // institution_admin keeps 11/14/17/21; the officers keep their surfaces.
    expect(isScreenAuthorized(21, 'institution_admin', perms('institution_admin'))).toBe(true);
    expect(isScreenAuthorized(11, 'institution_admin', perms('institution_admin'))).toBe(true);
    expect(isScreenAuthorized(14, 'institution_admin', perms('institution_admin'))).toBe(true);
    expect(isScreenAuthorized(21, 'outlet_officer', perms('outlet_officer'))).toBe(true);
    expect(isScreenAuthorized(21, 'warehouse_officer', perms('warehouse_officer'))).toBe(true);
    expect(isScreenAuthorized(21, 'super_admin', perms('super_admin'))).toBe(true);
    // ...and the pre-existing permission gates still bite for a role that
    // genuinely lacks the key, exactly as before this correction.
    expect(isScreenAuthorized(14, 'outlet_officer', noPerms)).toBe(false);
    expect(isScreenAuthorized(17, 'outlet_officer', noPerms)).toBe(false);
    expect(isScreenAuthorized(11, 'outlet_officer', noPerms)).toBe(false);
  });

  it('the app resolves the screen through the canonical decision, not per-component', () => {
    const app = read('app/AuthenticatedApp.tsx');
    expect(app).toContain('isScreenAuthorized(requestedScreen, profile.role, myPermissions)');
    expect(app).toContain('roleLandingScreen(profile.role)');
    // The restoration module must delegate rather than re-implement the gates.
    expect(continuity).toContain('isScreenAuthorized(screen, role, permissions)');
    expect(continuity).not.toContain('institutionsScreenAccess');
  });
});

describe('U-B · the role gains no organization-wide capability', () => {
  it('holds no user-lifecycle or administrative permission', () => {
    const d = perms(ROLE);
    for (const k of ['users.view', 'users.create', 'users.edit_scope', 'reports.view',
                     'audit.view', 'status_center.view', 'warehouses.manage']) {
      expect(d.has(k), k).toBe(false);
    }
  });

  it('is the ONLY facility-scoped role, and no historical role became one', () => {
    for (const r of OFFICIAL_ROLES) {
      expect(isFacilityScopedRole(r), r).toBe(r === ROLE);
    }
  });
});
