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
import { roleLandingScreen, institutionsScreenAccess } from '../screen-access';
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

describe('U-B · the projection derives resources from facilities', () => {
  const hook = read('features/inventory/useInventoryScopes.ts');

  it('derives warehouses from ASSIGNED FACILITIES', () => {
    expect(hook).toContain("a.scopeType === 'facility'");
    expect(hook).toContain('assignedFacilities');
    expect(hook).toContain('facilityDerivedWarehouses');
  });

  it('SECTOR-MAIN EXCLUSION: a facility-less warehouse can never be derived', () => {
    // The sector main is the health sector's only active facility_id IS NULL
    // warehouse (181). Requiring non-null here is the same test the server makes.
    expect(hook).toMatch(/w\.facilityId !== null && assignedFacilities\.has\(w\.facilityId\)/);
  });

  it('outlets follow their OWNING warehouse, so a centre pharmacy tracks its depot', () => {
    expect(hook).toMatch(/reachableWarehouse\(o\.warehouseId\)/);
  });

  it('preserves the organization-wide short-circuit for roles that legitimately have it', () => {
    // The pinned line other suites assert on must survive verbatim.
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
