/**
 * RESTORE-AVAILABILITY-EDITOR-HIDE-INTAKE-A
 *
 * Corrects a prior misunderstanding: AVAILABILITY-EDITOR-NAV-HIDE-A and
 * AVAILABILITY-EDITOR-VISIBLE-ENTRYPOINTS-HIDE-A/B hid nav_editor (screen 3,
 * Availability Editor) from the sidebar, mobile drawer, mobile bottom nav,
 * and Dashboard — but the owner only ever wanted the frozen Input page
 * (nav_intake, screen 8, IntakeFrozenScreen) hidden.
 *
 * This file now verifies the corrected intent:
 *  - nav_editor (screen 3) IS visible again in sidebar, drawer, bottom nav,
 *    and the Dashboard shortcut/quick-actions list.
 *  - nav_intake (screen 8) is hidden from sidebar, drawer, and bottom nav.
 *  - Both App.tsx routes (case 3 EditorScreen, case 8 IntakeFrozenScreen)
 *    remain fully intact — nav-only changes, no route removal.
 *  - EditorScreen.tsx and the permission matrix remain untouched.
 *  - The screen-level Editor entry points removed from IntakeFrozenScreen,
 *    MeshScreen, and MobileCommandScreen by
 *    AVAILABILITY-EDITOR-VISIBLE-ENTRYPOINTS-HIDE-B are NOT part of this
 *    correction and remain removed (the owner did not ask to restore those
 *    screen-specific shortcuts — only the normal sidebar/drawer/bottom-nav/
 *    dashboard entry points).
 *
 * Static source-code tests — no DB connection required.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { expectRetiredSurfaceAbsent } from '../../../../tests/helpers/retired-surfaces';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const sidebar             = readSrc('shared/ui/PhoenixSidebar.tsx');
const mobileDrawer        = readSrc('shared/ui/PhoenixMobileDrawer.tsx');
const mobileBottomNav     = readSrc('shared/ui/PhoenixMobileBottomNav.tsx');
const dashboardScreen     = readSrc('features/dashboard/DashboardScreen.tsx');
const intakeFrozenScreen  = readSrc('features/health/IntakeFrozenScreen.tsx');
const meshScreen          = readSrc('features/mesh/MeshScreen.tsx');
const mobileCommandScreen = readSrc('features/mesh/MobileCommandScreen.tsx');
// QR-BUNDLE-CODE-SPLIT-A: the screen-number switch now lives in its own
// lazy-loaded chunk (AuthenticatedApp.tsx), separate from App.tsx.
const authenticatedApp    = readSrc('app/AuthenticatedApp.tsx');

// ============================================================================
// 1. Desktop sidebar: nav_editor restored, nav_intake hidden
// ============================================================================

describe('Desktop sidebar: nav_editor visible, nav_intake hidden', () => {
  const navItemsBlock = sidebar.slice(
    sidebar.indexOf('const NAV_ITEMS'),
    sidebar.indexOf('const SECONDARY_ITEMS'),
  );
  const secondaryItemsBlock = sidebar.slice(sidebar.indexOf('const SECONDARY_ITEMS'));

  it("NAV_ITEMS contains 'nav_editor' (restored)", () => {
    expect(navItemsBlock).toContain("'nav_editor'");
  });

  it('NAV_ITEMS still contains the other required-visible pages', () => {
    // nav_reports was removed from this list (PHASE2-HIDE-REPORTS-MOVE-AUDIT-TO-STATUS-CENTER-A) — it is now hidden from nav; see section 12 below.
    ['nav_institutions', 'nav_status_center', 'nav_inter_alerts', 'nav_users']
      .forEach(key => expect(navItemsBlock).toContain(`'${key}'`));
  });

  it("SECONDARY_ITEMS does not contain 'nav_intake' (hidden)", () => {
    expect(secondaryItemsBlock).not.toContain("'nav_intake'");
  });

  it('SECONDARY_ITEMS still contains nav_my_account', () => {
    expect(secondaryItemsBlock).toContain("'nav_my_account'");
  });

  it('documents the corrected intent', () => {
    expect(sidebar).toContain('RESTORE-AVAILABILITY-EDITOR-HIDE-INTAKE-A');
  });
});

// ============================================================================
// 2. Mobile drawer: nav_editor restored, nav_intake hidden
// ============================================================================

describe('Mobile drawer: nav_editor visible, nav_intake hidden', () => {
  const allNavBlock = mobileDrawer.slice(
    mobileDrawer.indexOf('const ALL_NAV'),
    mobileDrawer.indexOf('interface Props'),
  );

  it("ALL_NAV contains 'nav_editor' (restored)", () => {
    expect(allNavBlock).toContain("'nav_editor'");
  });

  it("ALL_NAV does not contain 'nav_intake' (hidden)", () => {
    expect(allNavBlock).not.toContain("'nav_intake'");
  });

  it('ALL_NAV still contains the other required-visible pages', () => {
    // nav_reports was removed from this list (PHASE2-HIDE-REPORTS-MOVE-AUDIT-TO-STATUS-CENTER-A) — it is now hidden from nav; see section 12 below.
    ['nav_institutions', 'nav_status_center', 'nav_inter_alerts', 'nav_users']
      .forEach(key => expect(allNavBlock).toContain(`'${key}'`));
  });
});

// ============================================================================
// 3. Mobile bottom nav: nav_editor restored (nav_intake was never present)
// ============================================================================

describe('Mobile bottom nav: nav_editor visible', () => {
  const bottomNavBlock = mobileBottomNav.slice(
    mobileBottomNav.indexOf('const BOTTOM_NAV'),
    mobileBottomNav.indexOf('interface Props'),
  );

  it("BOTTOM_NAV contains 'nav_editor' (restored)", () => {
    expect(bottomNavBlock).toContain("'nav_editor'");
  });

  it("BOTTOM_NAV does not contain 'nav_intake' (never present)", () => {
    expect(bottomNavBlock).not.toContain("'nav_intake'");
  });

  it('BOTTOM_NAV still contains nav_status_center, nav_institutions, and nav_inter_alerts', () => {
    ['nav_status_center', 'nav_institutions', 'nav_inter_alerts']
      .forEach(key => expect(bottomNavBlock).toContain(`'${key}'`));
  });
});

// ============================================================================
// 4. Dashboard: nav_editor shortcut restored
// ============================================================================

describe('DashboardScreen exposes the Availability Editor shortcut again', () => {
  it('header button calls onNavigate(3)', () => {
    expect(dashboardScreen).toContain('onNavigate(3)');
  });

  it('header button renders the nav_editor label', () => {
    expect(dashboardScreen).toMatch(/t\(['"]nav_editor['"]/);
  });

  it('the quick-actions list includes screen 3 / nav_editor / editor_desc', () => {
    const quickActionsBlock = dashboardScreen.slice(
      dashboardScreen.indexOf('/* Quick actions */'),
    );
    expect(quickActionsBlock).toContain('screen: 3');
    expect(quickActionsBlock).toContain("labelKey: 'nav_editor'");
    expect(quickActionsBlock).toContain("descKey: 'editor_desc'");
  });

  it('the quick-actions list still includes Institutions, Status Center, and Reports', () => {
    const quickActionsBlock = dashboardScreen.slice(
      dashboardScreen.indexOf('/* Quick actions */'),
    );
    expect(quickActionsBlock).toContain("labelKey: 'nav_institutions'");
    expect(quickActionsBlock).toContain("labelKey: 'nav_status_center'");
    expect(quickActionsBlock).toContain("labelKey: 'nav_reports'");
  });

  it('other Dashboard navigation (alerts screen 13, institutions screen 11) is untouched', () => {
    expect(dashboardScreen).toContain('onNavigate(13)');
    expect(dashboardScreen).toContain('onNavigate(11)');
  });
});

// ============================================================================
// 5. nav_intake: hidden from all nav surfaces, no visible onNavigate(8)
// ============================================================================

describe('nav_intake is hidden from all visible navigation', () => {
  it('is not present anywhere in the sidebar file (nav array, not just a substring)', () => {
    const navItemsBlock = sidebar.slice(
      sidebar.indexOf('const NAV_ITEMS'),
      sidebar.indexOf('const SECONDARY_ITEMS'),
    );
    const secondaryItemsBlock = sidebar.slice(sidebar.indexOf('const SECONDARY_ITEMS'));
    expect(navItemsBlock).not.toContain("'nav_intake'");
    expect(secondaryItemsBlock).not.toContain("'nav_intake'");
  });

  it('is not present in the mobile drawer nav array', () => {
    const allNavBlock = mobileDrawer.slice(
      mobileDrawer.indexOf('const ALL_NAV'),
      mobileDrawer.indexOf('interface Props'),
    );
    expect(allNavBlock).not.toContain("'nav_intake'");
  });

  it('is not present in the mobile bottom nav array', () => {
    const bottomNavBlock = mobileBottomNav.slice(
      mobileBottomNav.indexOf('const BOTTOM_NAV'),
      mobileBottomNav.indexOf('interface Props'),
    );
    expect(bottomNavBlock).not.toContain("'nav_intake'");
  });

  it('no visible onNavigate(8) entrypoint exists in any nav surface or Dashboard', () => {
    [sidebar, mobileDrawer, mobileBottomNav, dashboardScreen].forEach(src => {
      expect(src).not.toContain('onNavigate(8)');
      expect(src).not.toContain('setScreen(8)');
    });
  });
});

// ============================================================================
// 6. App.tsx retains both EditorScreen (case 3) and IntakeFrozenScreen (case 8)
// ============================================================================

describe('App.tsx retains both routes (nothing removed)', () => {
  // INVENTORY-CENTER-INTAKE-A: screen 3 is no longer the Availability Editor.
  // The editor wrote item_availability directly with a hand-picked condition,
  // competing with the warehouse ledger for stock truth; the Inventory Center
  // replaces it and writes only through the migration-065 ledger RPCs. What
  // this section still guards is that screen 3 remains a REACHABLE route and
  // that screen 8 stays the frozen-intake page — see
  // features/inventory/__tests__/inventory-center-invariants.test.ts for the
  // replacement's own invariants.
  it('imports and renders InventoryCenterScreen on case 3', () => {
    expect(authenticatedApp).toContain("import { InventoryCenterScreen } from '@/features/inventory/InventoryCenterScreen'");
    expect(authenticatedApp).toMatch(/case 3:\s*return <InventoryCenterScreen \/>/);
  });

  it('the retired Availability Editor is no longer routed anywhere', () => {
    expect(authenticatedApp).not.toContain('<EditorScreen />');
    expect(authenticatedApp).not.toContain("from '@/features/editor/EditorScreen'");
  });

  it('imports and renders IntakeFrozenScreen on case 8', () => {
    expect(authenticatedApp).toContain("import { IntakeFrozenScreen } from '@/features/health/IntakeFrozenScreen'");
    expect(authenticatedApp).toMatch(/case 8:\s*return <IntakeFrozenScreen onNavigate={setScreen} \/>/);
  });
});

// ============================================================================
// 7. EditorScreen.tsx itself was not modified
// ============================================================================

describe('EditorScreen.tsx save/permission logic is untouched', () => {
  // E6: was an isolation assertion against EditorScreen.tsx. The screen is
  // retired, so this is now an absence guard — strictly stronger.
  it('EditorScreen stays retired (still gates save on availability.create/availability.update )', () => {
    expectRetiredSurfaceAbsent('EditorScreen');
  });

  it('the retired screen calls nothing at all — it is deleted', () => {
    expectRetiredSurfaceAbsent('EditorScreen');
  });

  it('the retired screen keeps no behaviour — it is deleted', () => {
    expectRetiredSurfaceAbsent('EditorScreen');
  });
});

// ============================================================================
// 8. IntakeFrozenScreen.tsx route/content remain (only its nav link is hidden)
// ============================================================================

describe('IntakeFrozenScreen route remains intact', () => {
  it('still renders the frozen/disabled notice', () => {
    expect(intakeFrozenScreen).toContain("t('nav_intake', lang)");
    expect(intakeFrozenScreen).toContain("t('intake_frozen', lang)");
    expect(intakeFrozenScreen).toContain('BLOCKED');
  });
});

// ============================================================================
// 9. Permission matrix files were not modified
// ============================================================================

describe('Permission matrix files are untouched', () => {
  it('permissions.ts still defines availability.create and availability.update keys', () => {
    const permissions = readSrc('shared/lib/permissions.ts');
    expect(permissions).toContain("key: 'availability.create'");
    expect(permissions).toContain("key: 'availability.update'");
  });

  it('roles.ts still defines the official role model', () => {
    const roles = readSrc('shared/lib/roles.ts');
    expect(roles).toContain('institution_admin');
    expect(roles).toContain('super_admin');
  });
});

// ============================================================================
// 10. No SQL/migration changes were introduced by this task
// ============================================================================

describe('No SQL/migration changes for this restore/hide task', () => {
  it('migration 032 (availability permission matrix) is unaffected', () => {
    const migration = readFileSync(
      join(SRC, '../supabase/migrations/032_phoenix_availability_permission_matrix_integration.sql'),
      'utf8',
    );
    expect(migration).toContain('phoenix_upsert_availability');
    expect(migration).toContain("phoenix_profile_has_permission(auth.uid(), 'availability.create')");
  });
});

// ============================================================================
// 11. Status Center remains visible
// ============================================================================

describe('Status Center remains visible', () => {
  it('nav_status_center is present in the desktop sidebar', () => {
    expect(sidebar).toContain("'nav_status_center'");
  });

  it('nav_status_center is present in the mobile drawer', () => {
    expect(mobileDrawer).toContain("'nav_status_center'");
  });
});

// ============================================================================
// 12. Reports is restored to desktop and mobile navigation for super_admin only.
// ============================================================================

describe('Reports is reachable only through super-admin navigation entries', () => {
  it('nav_reports is present and marked superAdminOnly in desktop NAV_ITEMS', () => {
    const navItemsBlock = sidebar.slice(sidebar.indexOf('const NAV_ITEMS'), sidebar.indexOf('const SECONDARY_ITEMS'));
    expect(navItemsBlock).toContain("'nav_reports'");
    expect(navItemsBlock).toContain('superAdminOnly: true');
    expect(sidebar).toContain("!item.superAdminOnly || role === 'super_admin'");
  });

  it('nav_reports is present and marked superAdminOnly in mobile ALL_NAV', () => {
    const allNavBlock = mobileDrawer.slice(mobileDrawer.indexOf('const ALL_NAV'), mobileDrawer.indexOf('interface Props'));
    expect(allNavBlock).toContain("'nav_reports'");
    expect(allNavBlock).toContain('superAdminOnly: true');
    expect(mobileDrawer).toContain("!item.superAdminOnly || role === 'super_admin'");
  });
});

// ============================================================================
// 13. i18n keys retained (not removed)
// ============================================================================

describe('nav_editor and nav_intake i18n keys are not removed', () => {
  it('strings.ts still defines nav_editor bilingually', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    expect(strings).toMatch(/nav_editor:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/);
  });

  it('strings.ts still defines nav_intake bilingually', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    expect(strings).toMatch(/nav_intake:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/);
  });
});

// ============================================================================
// 14. AVAILABILITY-EDITOR-VISIBLE-ENTRYPOINTS-HIDE-B screens are UNCHANGED by
//     this correction — the owner did not ask to restore these screen-level
//     shortcuts, only the normal sidebar/drawer/bottom-nav/dashboard ones.
// ============================================================================

describe('IntakeFrozenScreen/MeshScreen/MobileCommandScreen Editor shortcuts remain removed (out of scope for this correction)', () => {
  it('IntakeFrozenScreen still has no onNavigate(3) redirect button', () => {
    expect(intakeFrozenScreen).not.toContain('onNavigate(3)');
  });

  it('MeshScreen still has no onNavigate(3) button', () => {
    expect(meshScreen).not.toContain('onNavigate(3)');
  });

  it('MobileCommandScreen still has no onNavigate(3) FAB', () => {
    expect(mobileCommandScreen).not.toContain('onNavigate(3)');
  });
});
