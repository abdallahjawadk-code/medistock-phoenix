/**
 * AVAILABILITY-EDITOR-NAV-HIDE-A
 *
 * Verifies the Availability Editor / Input page (nav_editor, screen 3) is
 * hidden from desktop sidebar, mobile drawer, and mobile bottom nav — while
 * its route/screen case in App.tsx, EditorScreen.tsx itself, and the
 * permission matrix remain fully untouched. Nav-only hiding, no route
 * removal, no save-logic or permission-logic change.
 *
 * Static source-code tests — no DB connection required.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const sidebar        = readSrc('shared/ui/PhoenixSidebar.tsx');
const mobileDrawer    = readSrc('shared/ui/PhoenixMobileDrawer.tsx');
const dashboardScreen = readSrc('features/dashboard/DashboardScreen.tsx');
const intakeFrozenScreen = readSrc('features/health/IntakeFrozenScreen.tsx');
const meshScreen         = readSrc('features/mesh/MeshScreen.tsx');
const mobileCommandScreen = readSrc('features/mesh/MobileCommandScreen.tsx');
const mobileBottomNav = readSrc('shared/ui/PhoenixMobileBottomNav.tsx');
const app             = readSrc('app/App.tsx');
const editorScreen    = readSrc('features/editor/EditorScreen.tsx');

// ============================================================================
// 1. Desktop sidebar no longer lists nav_editor
// ============================================================================

describe('Desktop sidebar hides Availability Editor', () => {
  const navItemsBlock = sidebar.slice(
    sidebar.indexOf('const NAV_ITEMS'),
    sidebar.indexOf('const SECONDARY_ITEMS'),
  );

  it("NAV_ITEMS does not contain 'nav_editor'", () => {
    expect(navItemsBlock).not.toContain("'nav_editor'");
  });

  it('NAV_ITEMS still contains the required-visible pages', () => {
    ['nav_dash', 'nav_institutions', 'nav_status_center', 'nav_inter_alerts', 'nav_users', 'nav_reports']
      .forEach(key => expect(navItemsBlock).toContain(`'${key}'`));
  });

  it('documents the hide-only intent (route remains wired in App.tsx)', () => {
    expect(sidebar).toContain('AVAILABILITY-EDITOR-NAV-HIDE-A');
  });
});

// ============================================================================
// 2. Mobile drawer no longer lists nav_editor
// ============================================================================

describe('Mobile drawer hides Availability Editor', () => {
  const allNavBlock = mobileDrawer.slice(
    mobileDrawer.indexOf('const ALL_NAV'),
    mobileDrawer.indexOf('interface Props'),
  );

  it("ALL_NAV does not contain 'nav_editor'", () => {
    expect(allNavBlock).not.toContain("'nav_editor'");
  });

  it('ALL_NAV still contains the required-visible pages', () => {
    ['nav_dash', 'nav_institutions', 'nav_status_center', 'nav_inter_alerts', 'nav_users', 'nav_reports']
      .forEach(key => expect(allNavBlock).toContain(`'${key}'`));
  });
});

// ============================================================================
// 3. Mobile bottom nav no longer lists nav_editor
// ============================================================================

describe('Mobile bottom nav hides Availability Editor', () => {
  const bottomNavBlock = mobileBottomNav.slice(
    mobileBottomNav.indexOf('const BOTTOM_NAV'),
    mobileBottomNav.indexOf('interface Props'),
  );

  it("BOTTOM_NAV does not contain 'nav_editor'", () => {
    expect(bottomNavBlock).not.toContain("'nav_editor'");
  });

  it('BOTTOM_NAV still contains nav_dash and nav_institutions and nav_inter_alerts', () => {
    ['nav_dash', 'nav_institutions', 'nav_inter_alerts']
      .forEach(key => expect(bottomNavBlock).toContain(`'${key}'`));
  });
});

// ============================================================================
// 4. App.tsx retains EditorScreen import and case (route not removed)
// ============================================================================

describe('App.tsx retains the EditorScreen route (not removed)', () => {
  it('imports EditorScreen', () => {
    expect(app).toContain("import { EditorScreen } from '@/features/editor/EditorScreen'");
  });

  it('still renders EditorScreen on case 3', () => {
    expect(app).toMatch(/case 3:\s*return <EditorScreen \/>/);
  });
});

// ============================================================================
// 5. EditorScreen.tsx itself was not modified
// ============================================================================

describe('EditorScreen.tsx save/permission logic is untouched', () => {
  it('still gates save on availability.create/availability.update permissions', () => {
    expect(editorScreen).toContain("myPermissions.has('availability.view')");
    expect(editorScreen).toContain("myPermissions.has('availability.create')");
    expect(editorScreen).toContain("myPermissions.has('availability.update')");
  });

  it('still calls upsertAvailability and classifyAvailabilitySaveError', () => {
    expect(editorScreen).toContain('upsertAvailability(');
    expect(editorScreen).toContain('classifyAvailabilitySaveError(');
  });

  it('still keeps the super_admin org dropdown vs locked-display behavior', () => {
    expect(editorScreen).toContain("const isSuper = role === 'super_admin'");
  });
});

// ============================================================================
// 6. Permission matrix files were not modified
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
// 7. No SQL/migration changes were introduced by this task
// ============================================================================

describe('No SQL/migration changes for this nav-hide task', () => {
  it('migration 032 (availability permission matrix) is unaffected by nav hiding', () => {
    const migration = readFileSync(
      join(SRC, '../supabase/migrations/032_phoenix_availability_permission_matrix_integration.sql'),
      'utf8',
    );
    expect(migration).toContain('phoenix_upsert_availability');
    expect(migration).toContain("phoenix_profile_has_permission(auth.uid(), 'availability.create')");
  });
});

// ============================================================================
// 8. Status Center remains visible
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
// 9. Reports remains visible
// ============================================================================

describe('Reports remains visible', () => {
  it('nav_reports is present in the desktop sidebar', () => {
    expect(sidebar).toContain("'nav_reports'");
  });

  it('nav_reports is present in the mobile drawer', () => {
    expect(mobileDrawer).toContain("'nav_reports'");
  });
});

// ============================================================================
// i18n key retained (not removed)
// ============================================================================

describe('nav_editor i18n key is not removed', () => {
  it('strings.ts still defines nav_editor bilingually', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    expect(strings).toMatch(/nav_editor:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/);
  });
});

// ============================================================================
// AVAILABILITY-EDITOR-VISIBLE-ENTRYPOINTS-HIDE-A: Dashboard quick-nav shortcut
// ============================================================================

describe('DashboardScreen no longer exposes an Availability Editor shortcut', () => {
  it('does not call onNavigate(3) anywhere', () => {
    expect(dashboardScreen).not.toContain('onNavigate(3)');
  });

  it('does not reference nav_editor', () => {
    // Only the explanatory code comment may mention it by name; no t('nav_editor', ...) call remains.
    expect(dashboardScreen).not.toMatch(/t\(['"]nav_editor['"]/);
  });

  it('the quick-actions list no longer includes screen 3 / editor_desc', () => {
    const quickActionsBlock = dashboardScreen.slice(
      dashboardScreen.indexOf('/* Quick actions */'),
    );
    expect(quickActionsBlock).not.toContain('screen: 3');
    expect(quickActionsBlock).not.toContain("labelKey: 'nav_editor'");
    expect(quickActionsBlock).not.toContain("descKey: 'editor_desc'");
  });

  it('the quick-actions list still includes Institutions, Status Center, and Reports', () => {
    const quickActionsBlock = dashboardScreen.slice(
      dashboardScreen.indexOf('/* Quick actions */'),
    );
    expect(quickActionsBlock).toContain("labelKey: 'nav_institutions'");
    expect(quickActionsBlock).toContain("labelKey: 'nav_status_center'");
    expect(quickActionsBlock).toContain("labelKey: 'nav_reports'");
  });

  it('the header no longer renders a button that navigates to screen 3', () => {
    const headerBlock = dashboardScreen.slice(
      dashboardScreen.indexOf('{/* Header */}'),
      dashboardScreen.indexOf('{!configured'),
    );
    expect(headerBlock).not.toContain('<button');
    expect(headerBlock).not.toContain('onNavigate(3)');
  });

  it('documents the entry-point removal intent', () => {
    expect(dashboardScreen).toContain('AVAILABILITY-EDITOR-VISIBLE-ENTRYPOINTS-HIDE-A');
  });

  it('other Dashboard navigation (alerts screen 13, institutions screen 11) is untouched', () => {
    expect(dashboardScreen).toContain('onNavigate(13)');
    expect(dashboardScreen).toContain('onNavigate(11)');
  });
});

// ============================================================================
// AVAILABILITY-EDITOR-VISIBLE-ENTRYPOINTS-HIDE-B: remaining visible entrypoints
// ============================================================================

describe('IntakeFrozenScreen no longer offers a visible Editor CTA', () => {
  it('does not call onNavigate(3) anywhere', () => {
    expect(intakeFrozenScreen).not.toContain('onNavigate(3)');
  });

  it('does not render a visible nav_editor label/button', () => {
    expect(intakeFrozenScreen).not.toMatch(/t\(['"]nav_editor['"]/);
    expect(intakeFrozenScreen).not.toContain('use_editor_instead');
  });

  it('still shows the frozen/disabled notice (screen otherwise intact)', () => {
    expect(intakeFrozenScreen).toContain("t('nav_intake', lang)");
    expect(intakeFrozenScreen).toContain("t('intake_frozen', lang)");
    expect(intakeFrozenScreen).toContain('BLOCKED');
  });

  it('documents the entry-point removal intent', () => {
    expect(intakeFrozenScreen).toContain('AVAILABILITY-EDITOR-VISIBLE-ENTRYPOINTS-HIDE-B');
  });
});

describe('MeshScreen no longer offers a visible Editor button', () => {
  it('does not call onNavigate(3) anywhere', () => {
    expect(meshScreen).not.toContain('onNavigate(3)');
  });

  it('does not render a visible nav_editor label/button', () => {
    expect(meshScreen).not.toMatch(/t\(['"]nav_editor['"]/);
    expect(meshScreen).not.toContain('<PhoenixButton');
  });

  it('other mesh/institution interactions remain (selecting a node)', () => {
    expect(meshScreen).toContain('setSelectedId');
    expect(meshScreen).toContain('getInstitutionOverviews');
  });

  it('documents the entry-point removal intent', () => {
    expect(meshScreen).toContain('AVAILABILITY-EDITOR-VISIBLE-ENTRYPOINTS-HIDE-B');
  });
});

describe('MobileCommandScreen no longer offers a visible Editor FAB', () => {
  it('does not call onNavigate(3) anywhere', () => {
    expect(mobileCommandScreen).not.toContain('onNavigate(3)');
  });

  it('does not render a visible nav_editor label/button', () => {
    expect(mobileCommandScreen).not.toMatch(/t\(['"]nav_editor['"]/);
  });

  it('other mobile command navigation remains (institutions quick view, screen 6)', () => {
    expect(mobileCommandScreen).toContain('onNavigate(6)');
  });

  it('documents the entry-point removal intent', () => {
    expect(mobileCommandScreen).toContain('AVAILABILITY-EDITOR-VISIBLE-ENTRYPOINTS-HIDE-B');
  });
});

describe('Repo-wide: no forbidden visible entrypoint to screen 3 remains', () => {
  it('none of the three fixed screens contain onNavigate(3)', () => {
    [intakeFrozenScreen, meshScreen, mobileCommandScreen].forEach(src => {
      expect(src).not.toContain('onNavigate(3)');
    });
  });
});
