/**
 * PDA-PROC-1 — Screen 19 (Local Procurement / supplementary purchases) is a
 * DOMAIN-eligibility surface: it additionally requires the active
 * organization's canonical organization_kind to be 'care_institution'.
 *
 * Everything here is behavioural: the canonical predicate, the "await the kind"
 * helper and the shared navigation projection are called directly. The
 * database (migration 221) remains the boundary; these are the UX gates that
 * must agree with it.
 */
import { describe, expect, it } from 'vitest';
import {
  LOCAL_PROCUREMENT_SCREEN,
  isScreenAuthorized,
  screenAwaitsOrganizationKind,
} from '../screen-access';
import { canSearchInstitutions, projectNavigation } from '../nav-projection';
import { roleDefaults, PERMISSION_KEY_SET } from '@/shared/lib/permissions';
import { OFFICIAL_ROLES, isFacilityScopedRole } from '@/shared/lib/roles';
import type { OrganizationKind } from '@/shared/lib/institution-hierarchy';

const CARE: OrganizationKind = 'care_institution';
const PDA: OrganizationKind = 'pharmacy_department_authority';

/** Every permission key the frontend knows — the super_admin top-up shape. */
const ALL_KEYS: ReadonlySet<string> = new Set(PERMISSION_KEY_SET);

const NON_FACILITY_ROLES = OFFICIAL_ROLES.filter(r => !isFacilityScopedRole(r));
const FACILITY_ROLES = OFFICIAL_ROLES.filter(r => isFacilityScopedRole(r));

/** Every screen id the app routes, plus unknown ids. */
const SCREENS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 99];

describe('PDA-PROC-1 · the canonical decision for Screen 19', () => {
  it('names the screen once', () => {
    expect(LOCAL_PROCUREMENT_SCREEN).toBe(19);
  });

  it('a care institution keeps Screen 19 for every non-facility role', () => {
    expect(NON_FACILITY_ROLES.length).toBeGreaterThan(0);
    for (const role of NON_FACILITY_ROLES) {
      expect(isScreenAuthorized(19, role, roleDefaults(role), CARE), role).toBe(true);
      expect(isScreenAuthorized(19, role, new Set(), CARE), `${role} / no keys`).toBe(true);
    }
  });

  it('a pharmacy department authority is refused Screen 19 for every role', () => {
    for (const role of OFFICIAL_ROLES) {
      expect(isScreenAuthorized(19, role, roleDefaults(role), PDA), role).toBe(false);
    }
  });

  it('null, undefined and an omitted kind are all refused (unknown is never eligible)', () => {
    for (const role of OFFICIAL_ROLES) {
      expect(isScreenAuthorized(19, role, roleDefaults(role), null), `${role} / null`).toBe(false);
      expect(isScreenAuthorized(19, role, roleDefaults(role), undefined), `${role} / undefined`).toBe(false);
      expect(isScreenAuthorized(19, role, roleDefaults(role)), `${role} / omitted`).toBe(false);
    }
  });

  it('an unrecognised kind smuggled past the type is refused', () => {
    const forged = 'care_institution_v2' as unknown as OrganizationKind;
    expect(isScreenAuthorized(19, 'super_admin', ALL_KEYS, forged)).toBe(false);
    expect(isScreenAuthorized(19, 'institution_admin', ALL_KEYS, forged)).toBe(false);
  });

  it('super_admin is NOT a bypass: every permission key plus a PDA or unknown org is still refused', () => {
    expect(isScreenAuthorized(19, 'super_admin', ALL_KEYS, PDA)).toBe(false);
    expect(isScreenAuthorized(19, 'super_admin', ALL_KEYS, null)).toBe(false);
    expect(isScreenAuthorized(19, 'super_admin', ALL_KEYS)).toBe(false);
    // ...and a care organization is admitted, so the refusal is about the kind.
    expect(isScreenAuthorized(19, 'super_admin', ALL_KEYS, CARE)).toBe(true);
  });

  it('a local_procurement.* permission cannot stand in for the organization kind', () => {
    // The five scoped keys useProcurementPermissions asks the server about.
    const procurementKeys = new Set([
      'local_procurement.view', 'local_procurement.manage', 'local_procurement.approve',
      'local_procurement.receive', 'local_procurement.return',
    ]);
    for (const role of NON_FACILITY_ROLES) {
      expect(isScreenAuthorized(19, role, procurementKeys, PDA), role).toBe(false);
      expect(isScreenAuthorized(19, role, procurementKeys, null), role).toBe(false);
    }
  });

  it('a facility-scoped role stays refused even inside a care institution', () => {
    expect(FACILITY_ROLES.length).toBeGreaterThan(0);
    for (const role of FACILITY_ROLES) {
      expect(isScreenAuthorized(19, role, roleDefaults(role), CARE), role).toBe(false);
      expect(isScreenAuthorized(19, role, ALL_KEYS, CARE), `${role} / all keys`).toBe(false);
    }
  });

  it('every OTHER screen ignores the organization kind entirely', () => {
    const roles = [...OFFICIAL_ROLES, 'hospital_admin', 'warehouse_manager', 'not_a_role'];
    const permSets: ReadonlySet<string>[] = [new Set<string>(), ALL_KEYS];
    for (const role of roles) {
      for (const base of [...permSets, roleDefaults(role)]) {
        for (const screen of SCREENS.filter(s => s !== 19)) {
          const without = isScreenAuthorized(screen, role, base);
          for (const kind of [CARE, PDA, null, undefined]) {
            expect(isScreenAuthorized(screen, role, base, kind), `${role} / ${screen} / ${kind}`).toBe(without);
          }
        }
      }
    }
  });
});

describe('PDA-PROC-1 · screenAwaitsOrganizationKind — wait, never grant', () => {
  it('is true only for Screen 19 for an actor a care institution would admit', () => {
    for (const role of NON_FACILITY_ROLES) {
      expect(screenAwaitsOrganizationKind(19, role, roleDefaults(role)), role).toBe(true);
      for (const screen of SCREENS.filter(s => s !== 19)) {
        expect(screenAwaitsOrganizationKind(screen, role, roleDefaults(role)), `${role} / ${screen}`).toBe(false);
      }
    }
    expect(screenAwaitsOrganizationKind(19, 'super_admin', ALL_KEYS)).toBe(true);
  });

  it('is false for a facility-scoped role, which no kind would admit', () => {
    for (const role of FACILITY_ROLES) {
      expect(screenAwaitsOrganizationKind(19, role, roleDefaults(role)), role).toBe(false);
    }
  });

  it('matches its definition on the whole screen x role grid', () => {
    for (const role of [...OFFICIAL_ROLES, 'not_a_role']) {
      for (const screen of SCREENS) {
        const perms = roleDefaults(role);
        const expected = !isScreenAuthorized(screen, role, perms, null)
          && isScreenAuthorized(screen, role, perms, CARE);
        expect(screenAwaitsOrganizationKind(screen, role, perms), `${role} / ${screen}`).toBe(expected);
      }
    }
  });

  it('grants nothing: a screen that awaits the kind is itself refused until the kind settles', () => {
    for (const role of NON_FACILITY_ROLES) {
      if (screenAwaitsOrganizationKind(19, role, roleDefaults(role))) {
        expect(isScreenAuthorized(19, role, roleDefaults(role), null), role).toBe(false);
      }
    }
  });
});

describe('PDA-PROC-1 · the shared navigation projection carries the same answer', () => {
  const ITEMS = [
    { screen: 21, labelKey: 'nav_decision_reports' },
    { screen: 19, labelKey: 'nav_local_procurement' },
    { screen: 3, labelKey: 'nav_editor' },
  ];
  const visible = (role: string, organizationKind?: OrganizationKind | null) =>
    projectNavigation(ITEMS, { role, permissions: roleDefaults(role), organizationKind }).map(i => i.screen);

  it('care keeps Screen 19; PDA, null and an omitted kind drop exactly Screen 19', () => {
    for (const role of NON_FACILITY_ROLES) {
      expect(visible(role, CARE), role).toEqual([21, 19, 3]);
      expect(visible(role, PDA), role).toEqual([21, 3]);
      expect(visible(role, null), role).toEqual([21, 3]);
      expect(visible(role), role).toEqual([21, 3]);
    }
  });

  it('super_admin with every key and a PDA org is not offered Screen 19', () => {
    expect(projectNavigation(ITEMS, { role: 'super_admin', permissions: ALL_KEYS, organizationKind: PDA })
      .map(i => i.screen)).not.toContain(19);
  });

  it('every projected screen is one the route guard admits for the same kind', () => {
    for (const role of [...OFFICIAL_ROLES, 'hospital_admin']) {
      for (const kind of [CARE, PDA, null]) {
        for (const screen of visible(role, kind)) {
          expect(isScreenAuthorized(screen, role, roleDefaults(role), kind), `${role} / ${kind} / ${screen}`).toBe(true);
        }
      }
    }
  });

  it('the institutions search decision is unaffected by the kind', () => {
    for (const role of [...OFFICIAL_ROLES, 'hospital_admin']) {
      const without = canSearchInstitutions({ role, permissions: roleDefaults(role) });
      for (const kind of [CARE, PDA, null]) {
        expect(canSearchInstitutions({ role, permissions: roleDefaults(role), organizationKind: kind }), role)
          .toBe(without);
      }
    }
  });
});
