/**
 * NAV-USERS-PARITY-A
 *
 * User Management (screen 14) was gated by `users.view` in the CommandPalette
 * but shown unconditionally in the desktop sidebar and the mobile drawer, so a
 * user without users.view saw a Users entry point on two of the three surfaces.
 * This phase makes every navigation surface agree on the exact same predicate:
 *
 *     role === 'super_admin' || myPermissions.has('users.view')
 *
 * Reports/global search stay super_admin-only (unchanged). The bottom nav never
 * listed Users, so it is unaffected.
 *
 * Static, single-line source assertions — line-ending independent, matching the
 * repo's established nav-test conventions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const sidebar = readSrc('shared/ui/PhoenixSidebar.tsx');
const drawer = readSrc('shared/ui/PhoenixMobileDrawer.tsx');
const bottomNav = readSrc('shared/ui/PhoenixMobileBottomNav.tsx');
const palette = readSrc('shared/ui/CommandPalette.tsx');

const USERS_PREDICATE = "role === 'super_admin' || myPermissions.has('users.view')";

describe('A) the desktop sidebar gates Users by users.view', () => {
  it('marks the nav_users item requiresUsersView', () => {
    expect(sidebar).toContain("labelKey: 'nav_users', requiresUsersView: true");
  });
  it('computes the same canSeeUsers predicate the palette uses', () => {
    expect(sidebar).toContain(`const canSeeUsers = ${USERS_PREDICATE};`);
  });
  it('filters requiresUsersView items at render time', () => {
    expect(sidebar).toContain('!item.requiresUsersView || canSeeUsers');
  });
});

describe('B) the mobile drawer gates Users by users.view', () => {
  it('marks the nav_users item requiresUsersView', () => {
    expect(drawer).toContain("labelKey: 'nav_users', requiresUsersView: true");
  });
  it('computes the same canSeeUsers predicate', () => {
    expect(drawer).toContain(`const canSeeUsers = ${USERS_PREDICATE};`);
  });
  it('filters requiresUsersView items at render time', () => {
    expect(drawer).toContain('!item.requiresUsersView || canSeeUsers');
  });
});

describe('C) the command palette already gated Users (unchanged)', () => {
  it('still derives canSeeUsers from users.view', () => {
    expect(palette).toContain("myPermissions.has('users.view')");
  });
});

// REPORTING-UNIFICATION: nav_reports no longer exists as its own nav entry —
// Reports' unique content (including super_admin-only global material
// search) moved into the single nav_decision_reports entry (screen 21) as a
// tab, gated internally by role rather than at the nav-item level. The
// superAdminOnly mechanism itself is preserved (still used by the `filter`
// predicates below) even though no top-level item currently sets it.
describe('D) Reports/global search gating moved inside the unified shell (no separate superAdminOnly nav entry)', () => {
  it('sidebar/drawer/palette no longer mark any item superAdminOnly (Reports consolidated away)', () => {
    [sidebar, drawer, palette].forEach(src => expect(src).not.toContain('superAdminOnly: true'));
  });
  it('the superAdminOnly filter mechanism itself is preserved, ready for reuse', () => {
    expect(sidebar).toContain("!item.superAdminOnly || role === 'super_admin'");
    expect(drawer).toContain("!item.superAdminOnly || role === 'super_admin'");
    expect(palette).toContain("!i.superAdminOnly || role === 'super_admin'");
  });
});

describe('E) the bottom nav never listed Users (unaffected)', () => {
  it("BOTTOM_NAV does not contain 'nav_users'", () => {
    expect(bottomNav).not.toContain("'nav_users'");
  });
});
