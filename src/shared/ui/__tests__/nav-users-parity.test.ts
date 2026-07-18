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

describe('D) Reports stays super_admin-only across surfaces (no regression)', () => {
  it('sidebar keeps nav_reports superAdminOnly', () => {
    expect(sidebar).toContain("labelKey: 'nav_reports', superAdminOnly: true");
  });
  it('drawer keeps nav_reports superAdminOnly', () => {
    expect(drawer).toContain("labelKey: 'nav_reports', superAdminOnly: true");
  });
  it('palette keeps nav_reports superAdminOnly', () => {
    expect(palette).toContain('superAdminOnly: true');
  });
});

describe('E) the bottom nav never listed Users (unaffected)', () => {
  it("BOTTOM_NAV does not contain 'nav_users'", () => {
    expect(bottomNav).not.toContain("'nav_users'");
  });
});
