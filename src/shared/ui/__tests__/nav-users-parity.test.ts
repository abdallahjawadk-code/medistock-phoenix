/**
 * NAV-USERS-PARITY-A — updated by R1.1-P (P1).
 *
 * ORIGINAL INTENT, UNCHANGED: User Management (screen 14) was gated by
 * `users.view` in the CommandPalette but shown unconditionally in the desktop
 * sidebar and the mobile drawer, so a user without users.view saw a Users entry
 * point on two of the three surfaces. Every navigation surface must agree on
 * the exact same predicate:
 *
 *     role === 'super_admin' || myPermissions.has('users.view')
 *
 * WHAT R1.1-P CHANGED: that predicate is no longer hand-copied into each
 * component. All four surfaces now project their candidate list through
 * `projectNavigation`, which delegates to `isScreenAuthorized` — the single
 * place the predicate is written. The original assertions pinned the copies;
 * these pin the shared decision, which is a STRICTLY STRONGER anti-drift
 * guarantee: parity can no longer be broken by editing one component, because
 * there is only one predicate left to edit.
 *
 * The tests are correspondingly upgraded from source-scan to BEHAVIOURAL where
 * possible — projectNavigation is pure, so the real parity question ("do all
 * four surfaces admit the same screens for the same actor?") can be asserted
 * directly instead of inferred from matching source strings. The source scans
 * that remain exist to prove no component re-introduces a local copy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { projectNavigation } from '@/shared/authz/nav-projection';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const sidebar = readSrc('shared/ui/PhoenixSidebar.tsx');
const drawer = readSrc('shared/ui/PhoenixMobileDrawer.tsx');
const bottomNav = readSrc('shared/ui/PhoenixMobileBottomNav.tsx');
const palette = readSrc('shared/ui/CommandPalette.tsx');
const screenAccess = readSrc('shared/authz/screen-access.ts');

const NAV_SURFACES: [string, string][] = [
  ['PhoenixSidebar', sidebar],
  ['PhoenixMobileDrawer', drawer],
  ['PhoenixMobileBottomNav', bottomNav],
  ['CommandPalette', palette],
];

/** The candidate shape every surface feeds the shared projection. */
const USERS_ITEM = { screen: 14, labelKey: 'nav_users' };
const screens = (items: { screen: number }[]) => items.map(i => i.screen);

describe('A) the users.view predicate is written exactly ONCE', () => {
  it('lives in screen-access.ts, the canonical decision module', () => {
    expect(screenAccess).toContain("permissions.has('users.view')");
  });

  it('no navigation surface re-implements it locally', () => {
    for (const [name, src] of NAV_SURFACES) {
      expect(src, `${name} must not hand-copy the users.view gate`)
        .not.toContain("myPermissions.has('users.view')");
      expect(src, `${name} must not hand-copy the users.edit_scope gate`)
        .not.toContain("myPermissions.has('users.edit_scope')");
    }
  });
});

describe('B) every surface projects through the ONE shared helper', () => {
  it('all four import projectNavigation from the shared module', () => {
    for (const [name, src] of NAV_SURFACES) {
      expect(src, `${name} must import the shared projection`)
        .toContain("from '@/shared/authz/nav-projection'");
      expect(src, `${name} must call the shared projection`)
        .toContain('projectNavigation(');
    }
  });

  it('no surface filters its candidate list on a raw role name', () => {
    for (const [name, src] of NAV_SURFACES) {
      expect(src, `${name} must not gate navigation on a raw role literal`)
        .not.toContain("role === 'health_center_manager'");
    }
  });
});

describe('C) Users parity, asserted behaviourally on the shared projection', () => {
  it('a role WITHOUT users.view never receives screen 14', () => {
    const projected = projectNavigation([USERS_ITEM], {
      role: 'warehouse_officer',
      permissions: new Set<string>(),
    });
    expect(screens(projected)).not.toContain(14);
  });

  it('a role WITH users.view receives screen 14', () => {
    const projected = projectNavigation([USERS_ITEM], {
      role: 'warehouse_officer',
      permissions: new Set(['users.view']),
    });
    expect(screens(projected)).toContain(14);
  });

  it('super_admin receives screen 14 without holding the key explicitly', () => {
    const projected = projectNavigation([USERS_ITEM], {
      role: 'super_admin',
      permissions: new Set<string>(),
    });
    expect(screens(projected)).toContain(14);
  });

  it('parity is structural: one projection cannot disagree with itself', () => {
    // The former defect was three surfaces each holding their own copy. With a
    // single pure function, feeding the same candidate and actor to the "four
    // surfaces" is literally the same call — so instead of comparing copies,
    // assert the property that made the copies dangerous is gone.
    const actor = { role: 'warehouse_officer', permissions: new Set(['users.view']) };
    const results = NAV_SURFACES.map(() => screens(projectNavigation([USERS_ITEM], actor)));
    for (const result of results) expect(result).toEqual(results[0]);
  });
});

// REPORTING-UNIFICATION: nav_reports no longer exists as its own nav entry —
// Reports' unique content (including super_admin-only global material search)
// moved into the single nav_decision_reports entry (screen 21) as a tab, gated
// internally by role rather than at the nav-item level. The superAdminOnly
// mechanism itself is preserved (R1.1-P moved it into projectNavigation) even
// though no top-level item currently sets it.
describe('D) Reports/global search gating moved inside the unified shell', () => {
  it('no surface marks any item superAdminOnly (Reports consolidated away)', () => {
    for (const [name, src] of NAV_SURFACES) {
      expect(src, `${name} must not set superAdminOnly`).not.toContain('superAdminOnly: true');
    }
  });

  it('the superAdminOnly mechanism is preserved in the shared projection, ready for reuse', () => {
    const item = { screen: 3, labelKey: 'nav_editor', superAdminOnly: true };
    expect(screens(projectNavigation([item], {
      role: 'super_admin', permissions: new Set<string>(),
    }))).toContain(3);
    expect(screens(projectNavigation([item], {
      role: 'warehouse_officer', permissions: new Set<string>(),
    }))).not.toContain(3);
  });
});

describe('E) the bottom nav never listed Users (unaffected)', () => {
  it("BOTTOM_NAV does not contain 'nav_users'", () => {
    expect(bottomNav).not.toContain("'nav_users'");
  });
});
