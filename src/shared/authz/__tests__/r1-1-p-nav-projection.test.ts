/**
 * R1.1-P (P1) — FACILITY-SAFE NAVIGATION PROJECTION.
 *
 * The gap this closes: `isScreenAuthorized` was already the canonical route
 * decision, and the route guard and session-restore path already used it — but
 * the four VISIBLE navigation surfaces did not. Each kept its own historical
 * gates, so a facility-scoped health_center_manager was shown Reports,
 * Inter-Institution Alerts and Local Procurement, and the guard then bounced
 * every click back to the landing screen.
 *
 * These tests pin the projection itself rather than four sets of source
 * strings. The candidate lists are READ OUT OF THE REAL COMPONENTS, so a screen
 * added to any surface tomorrow is automatically covered here — the test cannot
 * silently fall behind the menus it is guarding.
 *
 * Everything below is a UX assertion. The database remains the boundary: RLS and
 * SECURITY DEFINER RPCs re-prove every read and write behind every screen.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { projectNavigation, canSearchInstitutions } from '../nav-projection';
import { isScreenAuthorized, roleLandingScreen } from '../screen-access';
import { isScreenRestorable } from '@/app/screen-continuity';

const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

/**
 * Pull a surface's REAL candidate screens out of its source. Every surface
 * declares its items as `{ screen: N, icon: '…', labelKey: '…' }`, so this
 * tracks the components instead of duplicating them.
 */
function candidateScreens(rel: string): number[] {
  const src = read(rel);
  const found = [...src.matchAll(/\{\s*screen:\s*(\d+),\s*icon:/g)].map(m => Number(m[1]));
  // A surface that stops matching would silently make every assertion vacuous.
  expect(found.length, `${rel} declared no nav candidates — the parser drifted`).toBeGreaterThan(0);
  return found;
}

const SURFACES = {
  sidebar: 'shared/ui/PhoenixSidebar.tsx',
  drawer: 'shared/ui/PhoenixMobileDrawer.tsx',
  bottomNav: 'shared/ui/PhoenixMobileBottomNav.tsx',
  palette: 'shared/ui/CommandPalette.tsx',
} as const;

const HCM = { role: 'health_center_manager', permissions: new Set<string>() };

/** What a surface actually shows this actor. */
function visibleScreens(rel: string, actor: { role: string; permissions: ReadonlySet<string> }): number[] {
  const items = candidateScreens(rel).map(screen => ({ screen, labelKey: `k${screen}` }));
  return projectNavigation(items, actor).map(i => i.screen);
}

/** The facility-safe allow-list, restated here so a widening of it fails loudly. */
const FACILITY_SAFE = [3, 6, 15, 18];

describe('A) a health_center_manager sees ONLY facility-safe screens, on every surface', () => {
  for (const [name, rel] of Object.entries(SURFACES)) {
    it(`${name}: every visible screen is in the facility-safe set`, () => {
      for (const screen of visibleScreens(rel, HCM)) {
        expect(FACILITY_SAFE, `${name} offered screen ${screen} to a facility-scoped role`).toContain(screen);
      }
    });
  }

  it.each([
    [21, 'Unified Reports'],
    [13, 'Inter-Institution Alerts'],
    [19, 'Local Procurement'],
    [11, 'Institution directory'],
    [14, 'User Management'],
    [17, 'Network Management'],
    [5, 'Mesh'],
    [10, 'Mobile Command'],
  ])('screen %i (%s) appears on NO surface', (screen) => {
    for (const [name, rel] of Object.entries(SURFACES)) {
      expect(visibleScreens(rel, HCM), `${name} must not offer screen ${screen}`).not.toContain(screen);
    }
    // …and the guard agrees, so the menu is not merely hiding a reachable page.
    expect(isScreenAuthorized(screen, HCM.role, HCM.permissions)).toBe(false);
  });

  it('the four facility-safe screens remain reachable as designed', () => {
    for (const screen of FACILITY_SAFE) {
      expect(isScreenAuthorized(screen, HCM.role, HCM.permissions), `screen ${screen}`).toBe(true);
    }
    // Each safe screen is offered by at least one surface, so "authorized" is
    // not a decision the operator can never act on.
    const everywhere = new Set(Object.values(SURFACES).flatMap(rel => visibleScreens(rel, HCM)));
    for (const screen of [3, 18, 15, 6]) {
      expect([...everywhere], `screen ${screen} is authorized but unreachable from any menu`).toContain(screen);
    }
  });

  it('grants no permission: holding extra keys still cannot widen the set', () => {
    const overPermissioned = {
      role: 'health_center_manager',
      permissions: new Set(['users.view', 'users.edit_scope', 'reports.view', 'local_procurement.view']),
    };
    for (const [name, rel] of Object.entries(SURFACES)) {
      for (const screen of visibleScreens(rel, overPermissioned)) {
        expect(FACILITY_SAFE, `${name} widened on a permission key`).toContain(screen);
      }
    }
  });
});

describe('B) the four surfaces agree with each other AND with the route guard', () => {
  const ACTORS = [
    { label: 'super_admin', role: 'super_admin', permissions: new Set<string>() },
    { label: 'institution_admin', role: 'institution_admin', permissions: new Set(['users.view']) },
    { label: 'central_warehouse_manager', role: 'central_warehouse_manager', permissions: new Set<string>() },
    { label: 'warehouse_officer', role: 'warehouse_officer', permissions: new Set<string>() },
    { label: 'outlet_officer', role: 'outlet_officer', permissions: new Set<string>() },
    { label: 'health_center_manager', role: 'health_center_manager', permissions: new Set<string>() },
    { label: 'hospital_admin (legacy)', role: 'hospital_admin', permissions: new Set<string>() },
    { label: 'warehouse_manager (legacy)', role: 'warehouse_manager', permissions: new Set<string>() },
    { label: 'port_officer (legacy)', role: 'port_officer', permissions: new Set<string>() },
    { label: 'point_operator (legacy)', role: 'point_operator', permissions: new Set<string>() },
    { label: 'transfer_manager (legacy)', role: 'transfer_manager', permissions: new Set<string>() },
    { label: 'unknown role', role: 'something_new', permissions: new Set<string>() },
  ];

  it.each(ACTORS)('$label: nothing any surface offers is refused by the guard', (actor) => {
    for (const [name, rel] of Object.entries(SURFACES)) {
      for (const screen of visibleScreens(rel, actor)) {
        expect(
          isScreenAuthorized(screen, actor.role, actor.permissions),
          `${name} offered screen ${screen} that the route guard refuses`,
        ).toBe(true);
      }
    }
  });

  it.each(ACTORS)('$label: a surface never drops a screen it lists and is authorized for', (actor) => {
    for (const [name, rel] of Object.entries(SURFACES)) {
      const authorized = candidateScreens(rel)
        .filter(s => isScreenAuthorized(s, actor.role, actor.permissions));
      expect(new Set(visibleScreens(rel, actor)), name).toEqual(new Set(authorized));
    }
  });
});

describe('C) historical roles keep their exact previous menus', () => {
  /**
   * The predicates the four components used to hand-copy, restated here as the
   * ORACLE. If projectNavigation ever diverges from what those copies produced
   * for a pre-182 role, this fails — which is the "no historical role loses a
   * legal navigation item" requirement, asserted rather than asserted-about.
   */
  const legacyOracle = (screen: number, role: string, perms: ReadonlySet<string>): boolean => {
    if (screen === 11) {
      return role === 'super_admin' || role === 'institution_admin' || role === 'hospital_admin';
    }
    if (screen === 14) return role === 'super_admin' || perms.has('users.view');
    /**
     * R1.3 restated screen 17: it is now CAPABILITY-gated, admitting
     * `warehouse_transfer.send` as well, because gating the Supply surface on
     * `users.edit_scope` refused it to central_warehouse_manager — the role
     * that holds the send capability and is granted users.edit_scope by no
     * migration at all. The oracle is updated to the current rule rather than
     * left stale, and PERM_SETS below now exercises the new permission, so this
     * parity check cannot pass merely by never testing it.
     */
    if (screen === 17) {
      return role === 'super_admin'
        || perms.has('users.edit_scope')
        || perms.has('warehouse_transfer.send');
    }
    return true;
  };

  const HISTORICAL = [
    'super_admin', 'institution_admin', 'central_warehouse_manager',
    'warehouse_officer', 'outlet_officer', 'hospital_admin',
    'warehouse_manager', 'port_officer', 'point_operator', 'transfer_manager',
  ];
  const PERM_SETS = [
    new Set<string>(),
    new Set(['users.view']),
    new Set(['users.edit_scope']),
    new Set(['users.view', 'users.edit_scope']),
    // R1.3 — the supply capability, alone and combined. Without these the
    // screen-17 branch above would never be exercised for the very role
    // (central_warehouse_manager) whose menu the change affects.
    new Set(['warehouse_transfer.send']),
    new Set(['warehouse_transfer.send', 'users.edit_scope']),
    new Set(['warehouse_transfer.send', 'users.view']),
  ];

  it.each(HISTORICAL)('%s: identical to the pre-R1.1-P gates on every surface and permission set', (role) => {
    for (const permissions of PERM_SETS) {
      for (const [name, rel] of Object.entries(SURFACES)) {
        const expected = candidateScreens(rel).filter(s => legacyOracle(s, role, permissions));
        expect(
          visibleScreens(rel, { role, permissions }),
          `${name} / ${role} / [${[...permissions].join(',')}]`,
        ).toEqual(expected);
      }
    }
  });

  it('screen 11 still relabels to "My Organization" for an institution admin only', () => {
    const item = [{ screen: 11, labelKey: 'nav_institutions' }];
    expect(projectNavigation(item, { role: 'institution_admin', permissions: new Set() })[0].labelKey)
      .toBe('nav_my_organization');
    expect(projectNavigation(item, { role: 'hospital_admin', permissions: new Set() })[0].labelKey)
      .toBe('nav_my_organization');
    expect(projectNavigation(item, { role: 'super_admin', permissions: new Set() })[0].labelKey)
      .toBe('nav_institutions');
    expect(projectNavigation(item, HCM)).toEqual([]);
  });

  it('projection never mutates the caller’s candidate array or its items', () => {
    const items = [{ screen: 11, labelKey: 'nav_institutions' }, { screen: 21, labelKey: 'nav_decision_reports' }];
    const snapshot = JSON.parse(JSON.stringify(items));
    projectNavigation(items, { role: 'institution_admin', permissions: new Set() });
    expect(items).toEqual(snapshot);
  });
});

describe('D) a forged, deep-linked or restored unsafe screen fails closed', () => {
  it('every restorable screen is re-checked against the canonical decision', () => {
    for (const screen of [3, 6, 11, 13, 14, 15, 17, 18, 19, 21]) {
      const restorable = isScreenRestorable(screen, HCM.role, HCM.permissions);
      if (restorable) expect(FACILITY_SAFE, `screen ${screen} restorable`).toContain(screen);
      expect(restorable).toBe(isScreenAuthorized(screen, HCM.role, HCM.permissions));
    }
  });

  it('Back/forward and session restore cannot resurrect Reports for a facility-scoped role', () => {
    expect(isScreenRestorable(21, HCM.role, HCM.permissions)).toBe(false);
    expect(isScreenRestorable(13, HCM.role, HCM.permissions)).toBe(false);
    expect(isScreenRestorable(19, HCM.role, HCM.permissions)).toBe(false);
    expect(isScreenRestorable(11, HCM.role, HCM.permissions)).toBe(false);
  });

  it('the safe landing a refusal falls back to is itself facility-safe', () => {
    const landing = roleLandingScreen(HCM.role);
    expect(landing).toBe(18);
    expect(FACILITY_SAFE).toContain(landing);
    expect(isScreenAuthorized(landing, HCM.role, HCM.permissions)).toBe(true);
  });

  it('the route guard still routes an unauthorized request to that landing', () => {
    const app = read('app/AuthenticatedApp.tsx');
    expect(app).toContain('isScreenAuthorized(requestedScreen, profile.role, myPermissions)');
    expect(app).toContain('roleLandingScreen(profile.role)');
  });
});

describe('E) the command palette performs no organization-level read for a facility-scoped role', () => {
  it('canSearchInstitutions refuses a health_center_manager and allows the historical admins', () => {
    expect(canSearchInstitutions(HCM)).toBe(false);
    expect(canSearchInstitutions({ role: 'super_admin', permissions: new Set() })).toBe(true);
    expect(canSearchInstitutions({ role: 'institution_admin', permissions: new Set() })).toBe(true);
    expect(canSearchInstitutions({ role: 'hospital_admin', permissions: new Set() })).toBe(true);
    expect(canSearchInstitutions({ role: 'warehouse_officer', permissions: new Set() })).toBe(false);
    expect(canSearchInstitutions({ role: 'outlet_officer', permissions: new Set() })).toBe(false);
  });

  it('the lazy getOrganizations() read is gated on that decision, not only its results', () => {
    const palette = read('shared/ui/CommandPalette.tsx');
    expect(palette).toContain('if (!open || orgs !== null || !maySearchInstitutions) return;');
    // Defence in depth: rows already in state are dropped too, so a mid-session
    // role change cannot leave an institution hit rendered.
    expect(palette).toContain('|| !maySearchInstitutions) return [];');
    // Every institution hit navigates to screen 11 — an unreachable target.
    expect(palette).toContain('onClick={() => choose(11)}');
  });
});

describe('F) the bottom bar removes unauthorized items instead of re-pointing them', () => {
  const bottomNav = read('shared/ui/PhoenixMobileBottomNav.tsx');

  it('never substitutes a safe destination behind an unauthorized label', () => {
    // The anti-pattern: rendering "Reports" but navigating to 18.
    expect(bottomNav).not.toMatch(/onNavigate\(\s*18\s*\)/);
    expect(bottomNav).toContain('onNavigate(item.screen)');
  });

  it('projects, and renders nothing at all when no slot survives', () => {
    expect(bottomNav).toContain('projectNavigation(BOTTOM_NAV');
    expect(bottomNav).toContain('if (visibleItems.length === 0) return null;');
  });

  it('its layout is defined for fewer than four slots', () => {
    // flex:1 alone stretched a lone survivor across the whole bar.
    expect(bottomNav).toContain("maxWidth: '25%'");
  });

  it('a facility-scoped role gets a smaller bar, and every slot in it is legal', () => {
    const visible = visibleScreens(SURFACES.bottomNav, HCM);
    const all = candidateScreens(SURFACES.bottomNav);
    expect(visible.length).toBeLessThan(all.length);
    for (const screen of visible) expect(FACILITY_SAFE).toContain(screen);
  });
});

describe('G) the shell shows a translated role label, never the raw DB value', () => {
  const sidebar = read('shared/ui/PhoenixSidebar.tsx');

  it('renders roleLabelKey through t(), so "health_center_manager" never reaches the user row', () => {
    expect(sidebar).toContain('t(roleLabelKey(role), lang)');
    expect(sidebar).not.toMatch(/>\{role\}</);
  });

  it('the name fallback is a label too, not the raw role', () => {
    expect(sidebar).toContain('profile?.full_name ?? t(roleLabelKey(role), lang)');
  });
});
