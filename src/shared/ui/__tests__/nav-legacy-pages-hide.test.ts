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

  it('NAV_ITEMS still contains nav_reports (must remain visible)', () => {
    expect(navItemsBlock).toContain("'nav_reports'");
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

  it('ALL_NAV still contains nav_reports (must remain visible)', () => {
    expect(allNavBlock).toContain("'nav_reports'");
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
// 4. Reports (nav_reports) remains visible everywhere it was before
// ============================================================================

describe('Reports remains visible in this phase', () => {
  it('nav_reports is still present in the desktop sidebar', () => {
    expect(sidebar).toContain("'nav_reports'");
  });

  it('nav_reports is still present in the mobile drawer', () => {
    expect(mobileDrawer).toContain("'nav_reports'");
  });
});

// ============================================================================
// 5. App.tsx routes/screen cases are fully untouched
// ============================================================================

describe('App.tsx retains all screen cases for hidden-nav pages (routes not removed)', () => {
  it('imports and renders QrScreen on case 6', () => {
    expect(app).toContain("import { QrScreen } from '@/features/qr/QrScreen'");
    expect(app).toMatch(/case 6:\s*return <QrScreen \/>/);
  });

  it('imports and renders RegistryScreen on case 4', () => {
    expect(app).toContain("import { RegistryScreen } from '@/features/registry/RegistryScreen'");
    expect(app).toMatch(/case 4:\s*return <RegistryScreen \/>/);
  });

  it('imports and renders StatusEditorScreen on case 16', () => {
    expect(app).toContain("import { StatusEditorScreen } from '@/features/status/StatusEditorScreen'");
    expect(app).toMatch(/case 16:\s*return <StatusEditorScreen \/>/);
  });

  it('imports and renders ReportsScreen on case 9', () => {
    expect(app).toContain("import { ReportsScreen } from '@/features/reports/ReportsScreen'");
    expect(app).toMatch(/case 9:\s*return <ReportsScreen \/>/);
  });
});

// ============================================================================
// 6. Public QR path is untouched
// ============================================================================

describe('Public QR path is untouched by nav hiding', () => {
  it('App.tsx still resolves ?qid=/?token= to PublicQrScreen before auth', () => {
    expect(app).toContain("import { PublicQrScreen } from '@/features/qr/PublicQrScreen'");
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
