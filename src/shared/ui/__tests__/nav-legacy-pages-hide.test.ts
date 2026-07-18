/**
 * UI-LEGACY-PAGES-NAV-HIDE-A
 *
 * Verifies legacy/redundant pages (QR Center, Item Registry, Status Editor)
 * are hidden from desktop sidebar and mobile drawer navigation, while their
 * routes/screen cases in App.tsx remain fully intact — nav-only hiding, no
 * route removal, no deletion.
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
const mobileBottomNav = readSrc('shared/ui/PhoenixMobileBottomNav.tsx');
const app             = readSrc('app/App.tsx');
// QR-BUNDLE-CODE-SPLIT-A: screen-case routing moved into its own lazy chunk.
const authenticatedApp = readSrc('app/AuthenticatedApp.tsx');

// Reports is no longer part of this legacy-hidden list: the authenticated
// smoke test for the super-admin global material search restored a guarded
// desktop entry. The original legacy pages remain hidden exactly as before.
const HIDDEN_KEYS = ['nav_qr_audit', 'nav_reg', 'nav_status_editor'];

// ============================================================================
// 1. Desktop sidebar no longer lists the hidden nav items
// ============================================================================

describe('Desktop sidebar hides legacy pages', () => {
  const navItemsBlock = sidebar.slice(
    sidebar.indexOf('const NAV_ITEMS'),
    sidebar.indexOf('const SECONDARY_ITEMS'),
  );

  HIDDEN_KEYS.forEach(key => {
    it(`NAV_ITEMS does not contain '${key}'`, () => {
      expect(navItemsBlock).not.toContain(`'${key}'`);
    });
  });

  it('NAV_ITEMS still contains the core unaffected pages', () => {
    // nav_editor is restored (RESTORE-AVAILABILITY-EDITOR-HIDE-INTAKE-A) — see
    // nav-availability-editor-hide.test.ts for the full corrected-intent tests.
    ['nav_institutions', 'nav_status_center', 'nav_inter_alerts', 'nav_users', 'nav_editor']
      .forEach(key => expect(navItemsBlock).toContain(`'${key}'`));
  });

  it('documents the hide-only intent (routes remain wired in App.tsx)', () => {
    expect(sidebar).toContain('UI-LEGACY-PAGES-NAV-HIDE-A');
  });
});

// ============================================================================
// 2. Mobile drawer no longer lists the hidden nav items
// ============================================================================

describe('Mobile drawer hides legacy pages', () => {
  const allNavBlock = mobileDrawer.slice(
    mobileDrawer.indexOf('const ALL_NAV'),
    mobileDrawer.indexOf('interface Props'),
  );

  it("ALL_NAV does not contain 'nav_qr_audit'", () => {
    expect(allNavBlock).not.toContain("'nav_qr_audit'");
  });

  it("ALL_NAV does not contain 'nav_reg'", () => {
    expect(allNavBlock).not.toContain("'nav_reg'");
  });

  it("ALL_NAV does not contain 'nav_status_editor' (was never present)", () => {
    expect(allNavBlock).not.toContain("'nav_status_editor'");
  });

  it('ALL_NAV still contains the core unaffected pages', () => {
    // nav_editor is restored (RESTORE-AVAILABILITY-EDITOR-HIDE-INTAKE-A).
    // nav_intake is intentionally excluded here — it is the page the owner
    // actually wants hidden; see nav-availability-editor-hide.test.ts.
    ['nav_institutions', 'nav_status_center', 'nav_inter_alerts', 'nav_users', 'nav_editor']
      .forEach(key => expect(allNavBlock).toContain(`'${key}'`));
  });
});

// ============================================================================
// 3. Mobile bottom nav — never had these items; confirm still absent
// ============================================================================

describe('Mobile bottom nav does not reintroduce legacy pages', () => {
  HIDDEN_KEYS.forEach(key => {
    it(`BOTTOM_NAV does not contain '${key}'`, () => {
      expect(mobileBottomNav).not.toContain(`'${key}'`);
    });
  });
});

// ============================================================================
// 4. Reports is restored to desktop/mobile navigation for super_admin only.
// ============================================================================

describe('Reports has scoped entries without reopening legacy pages', () => {
  it('nav_reports is present and guarded in desktop NAV_ITEMS', () => {
    const navBlock = sidebar.slice(sidebar.indexOf('const NAV_ITEMS'), sidebar.indexOf('const ROLE_MAP'));
    expect(navBlock).toContain("'nav_reports'");
    expect(navBlock).toContain('superAdminOnly: true');
    expect(sidebar).toContain("!item.superAdminOnly || role === 'super_admin'");
  });

  it('nav_reports is present and guarded in mobile ALL_NAV', () => {
    const drawerBlock = mobileDrawer.slice(mobileDrawer.indexOf('const ALL_NAV'), mobileDrawer.indexOf('interface Props'));
    expect(drawerBlock).toContain("'nav_reports'");
    expect(drawerBlock).toContain('superAdminOnly: true');
    expect(mobileDrawer).toContain("!item.superAdminOnly || role === 'super_admin'");
  });
});

// ============================================================================
// 5. App.tsx routes/screen cases are fully untouched
// ============================================================================

describe('App.tsx retains all screen cases for hidden-nav pages (routes not removed)', () => {
  // QR-BUNDLE-CODE-SPLIT-A: the screen switch now lives in the lazy-loaded
  // AuthenticatedApp.tsx, not App.tsx itself — App.tsx only decides which
  // lazy chunk (public QR vs authenticated app) to load.
  it('imports and renders QrScreen on case 6', () => {
    expect(authenticatedApp).toContain("import { QrScreen } from '@/features/qr/QrScreen'");
    expect(authenticatedApp).toMatch(/case 6:\s*return <QrScreen \/>/);
  });

  it('imports and renders RegistryScreen on case 4', () => {
    expect(authenticatedApp).toContain("import { RegistryScreen } from '@/features/registry/RegistryScreen'");
    expect(authenticatedApp).toMatch(/case 4:\s*return <RegistryScreen \/>/);
  });

  it('imports and renders StatusEditorScreen on case 16', () => {
    expect(authenticatedApp).toContain("import { StatusEditorScreen } from '@/features/status/StatusEditorScreen'");
    expect(authenticatedApp).toMatch(/case 16:\s*return <StatusEditorScreen \/>/);
  });

  it('imports and renders ReportsScreen on case 9', () => {
    expect(authenticatedApp).toContain("import { ReportsScreen } from '@/features/reports/ReportsScreen'");
    expect(authenticatedApp).toMatch(/case 9:\s*return <ReportsScreen \/>/);
  });
});

// ============================================================================
// 6. Public QR path is untouched
// ============================================================================

describe('Public QR path is untouched by nav hiding', () => {
  it('App.tsx still resolves ?qid=/?token= to PublicQrScreen before auth', () => {
    // QR-BUNDLE-CODE-SPLIT-A: PublicQrScreen is now lazy-loaded (its own
    // chunk) rather than statically imported — the module path is the same.
    expect(app).toContain("import('@/features/qr/PublicQrScreen')");
    expect(app).toContain("params.get('qid')");
    expect(app).toContain("params.get('token')");
    expect(app).toContain('<PublicQrScreen publicId={qid} />');
  });

  it('qr.service.ts still exposes getPublicQrPayload calling get_public_qr_payload', () => {
    const qrService = readSrc('shared/supabase/services/qr.service.ts');
    expect(qrService).toContain('export async function getPublicQrPayload');
    expect(qrService).toContain("supabase.rpc('get_public_qr_payload'");
  });
});

// ============================================================================
// 7. No manual status-report write UI was reintroduced
// ============================================================================

describe('No manual status-report write UI reintroduced', () => {
  it('no .tsx file calls createStatusReport/updateStatusReport/resolveStatusReport', () => {
    const files = [
      'shared/ui/PhoenixSidebar.tsx',
      'shared/ui/PhoenixMobileDrawer.tsx',
      'shared/ui/PhoenixMobileBottomNav.tsx',
      'features/status/StatusEditorScreen.tsx',
      'features/reports/ReportsScreen.tsx',
      'features/qr/QrScreen.tsx',
      'features/registry/RegistryScreen.tsx',
    ];
    files.forEach(rel => {
      const content = readSrc(rel);
      expect(content).not.toContain('createStatusReport(');
      expect(content).not.toContain('updateStatusReport(');
      expect(content).not.toContain('resolveStatusReport(');
    });
  });

  it('StatusEditorScreen still documents/derives from live availability, not status_reports', () => {
    const statusEditor = readSrc('features/status/StatusEditorScreen.tsx');
    expect(statusEditor).toContain('getAvailabilityByOrg');
    expect(statusEditor).not.toContain('status-reports.service');
  });
});
