/**
 * MOBILE-NAV-BRAND-POLISH-A
 * Run: npm test -- --run
 *
 * Static source-code tests for:
 *  - removing the mobile bottom-nav "More / المزيد" hamburger item
 *  - preserving drawer access via the topbar's icon-only menu button
 *  - mobile drawer now mirroring the desktop sidebar's full page set
 *    (including the previously-missing nav_my_account)
 *  - the sidebar/drawer brand subtitle replacing "MASAR Health Network"
 *    with the new department string
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const bottomNav = readSrc('shared/ui/PhoenixMobileBottomNav.tsx');
const drawer     = readSrc('shared/ui/PhoenixMobileDrawer.tsx');
const sidebar    = readSrc('shared/ui/PhoenixSidebar.tsx');
const topbar     = readSrc('shared/ui/PhoenixTopbar.tsx');
const appShell   = readSrc('shared/ui/PhoenixAppShell.tsx');
const strings    = readSrc('shared/i18n/strings.ts');

describe('Mobile bottom nav: "More / المزيد" item removed', () => {
  it('does not render the hamburger icon (☰) anywhere', () => {
    expect(bottomNav).not.toContain('☰');
  });

  it('does not call t(\'more\'', () => {
    expect(bottomNav).not.toContain("t('more'");
  });

  it('does not have an onMoreClick prop/handler', () => {
    expect(bottomNav).not.toContain('onMoreClick');
  });

  it('does not render the literal label "More" or "المزيد"', () => {
    expect(bottomNav).not.toContain('>More<');
    expect(bottomNav).not.toContain('المزيد');
    expect(bottomNav).not.toMatch(/aria-label="More"/);
  });

  it('BOTTOM_NAV array itself still has 4 core pages (nav_status_center replaced the removed central dashboard)', () => {
    const bottomNavBlock = bottomNav.slice(
      bottomNav.indexOf('const BOTTOM_NAV'),
      bottomNav.indexOf('interface Props'),
    );
    ['nav_status_center', 'nav_editor', 'nav_institutions', 'nav_inter_alerts']
      .forEach(key => expect(bottomNavBlock).toContain(`'${key}'`));
  });

  it('remaining nav buttons are rebalanced with space-evenly (no blank slot left)', () => {
    expect(bottomNav).toContain("justifyContent: 'space-evenly'");
  });

  it('touch targets remain at least 44px', () => {
    expect(bottomNav).toContain("minWidth: '44px', minHeight: '44px'");
  });

  it('keeps safe-area padding for notch/gesture-bar devices', () => {
    expect(bottomNav).toMatch(/env\(safe-area-inset-bottom/);
  });
});

describe('Drawer access is preserved via the topbar menu button', () => {
  it('PhoenixTopbar still renders an icon-only mobile menu button', () => {
    expect(topbar).toContain('☰');
    expect(topbar).toContain('onMenuClick');
  });

  it('the topbar menu button has no visible "More/المزيد" text label', () => {
    const buttonBlock = topbar.slice(topbar.indexOf('isMobile && ('), topbar.indexOf('</button>'));
    expect(buttonBlock).not.toContain('المزيد');
    expect(buttonBlock).not.toMatch(/>\s*More\s*</);
  });

  it('the topbar menu button uses a localized aria-label, not a hardcoded string', () => {
    expect(topbar).toContain("aria-label={t('menu', lang)}");
  });

  it("strings.ts defines the 'menu' key bilingually", () => {
    const line = strings.split('\n').find(l => l.includes('menu:'));
    expect(line).toContain('القائمة');
    expect(line).toContain('Menu');
  });

  it('AppShell wires the same setSidebarOpen toggle to both the topbar menu button and the drawer', () => {
    expect(appShell).toContain('onMenuClick={() => setSidebarOpen(s => !s)}');
    expect(appShell).toContain('PhoenixMobileDrawer');
  });

  it('AppShell no longer passes onMoreClick to the bottom nav', () => {
    const bottomNavUsage = appShell.slice(appShell.indexOf('<PhoenixMobileBottomNav'), appShell.indexOf('<PhoenixMobileBottomNav') + 200);
    expect(bottomNavUsage).not.toContain('onMoreClick');
  });

  it('the drawer itself has its own explicit close button (additional access parity)', () => {
    expect(drawer).toContain('premium-drawer-close');
    expect(drawer).toContain('onClick={onClose}');
  });
});

describe('Mobile drawer mirrors the desktop sidebar page set', () => {
  const allNavBlock = drawer.slice(drawer.indexOf('const ALL_NAV'), drawer.indexOf('interface Props'));
  const navItemsBlock = sidebar.slice(sidebar.indexOf('const NAV_ITEMS'), sidebar.indexOf('const SECONDARY_ITEMS'));
  const secondaryItemsBlock = sidebar.slice(sidebar.indexOf('const SECONDARY_ITEMS'));

  it('drawer ALL_NAV contains every primary desktop NAV_ITEMS label key', () => {
    // nav_reports removed from this mirror-check (PHASE2-HIDE-REPORTS-MOVE-AUDIT-TO-STATUS-CENTER-A) — hidden from both surfaces now, see nav-reports-hide.test.ts.
    ['nav_institutions', 'nav_status_center', 'nav_inter_alerts', 'nav_users', 'nav_editor']
      .forEach(key => {
        expect(navItemsBlock).toContain(`'${key}'`);
        expect(allNavBlock).toContain(`'${key}'`);
      });
  });

  it('drawer now includes nav_my_account (previously missing, present in desktop SECONDARY_ITEMS)', () => {
    expect(secondaryItemsBlock).toContain("'nav_my_account'");
    expect(drawer).toContain("'nav_my_account'");
  });

  it('drawer has a distinct SECONDARY_NAV section mirroring desktop SECONDARY_ITEMS', () => {
    expect(drawer).toContain('const SECONDARY_NAV');
    const secondaryNavBlock = drawer.slice(drawer.indexOf('const SECONDARY_NAV'), drawer.indexOf('interface Props'));
    expect(secondaryNavBlock).toContain("'nav_my_account'");
  });

  it('no route permissions/visibility rules were removed (screen 15 still routes to MyAccountScreen)', () => {
    const app = readSrc('app/App.tsx');
    expect(app).toMatch(/case 15:\s*return <MyAccountScreen/);
  });
});

describe('Mobile drawer active-route styling still exists', () => {
  it('uses data-active + premium-nav-item, same active-indicator pattern as desktop sidebar', () => {
    expect(drawer).toContain('premium-nav-item');
    expect(drawer).toContain('data-active={currentScreen === item.screen}');
    expect(sidebar).toContain('data-active={currentScreen === item.screen}');
  });

  it('active nav item still gets a distinct background/color/fontWeight via the ns() helper', () => {
    expect(drawer).toMatch(/const ns = \(n: number\) => \(\{/);
    expect(drawer).toContain("background: currentScreen === n ? 'var(--p2)' : 'transparent'");
  });
});

describe('Brand text replacement: "MASAR Health Network" removed from sidebar/drawer brand areas', () => {
  it('PhoenixSidebar no longer renders the literal "MASAR Health Network" string', () => {
    expect(sidebar).not.toContain('MASAR Health Network');
  });

  it('PhoenixMobileDrawer no longer renders the literal "MASAR Health Network" string', () => {
    expect(drawer).not.toContain('MASAR Health Network');
  });

  it('both use the new shell_brand_department i18n key instead', () => {
    expect(sidebar).toContain("t('shell_brand_department', lang)");
    expect(drawer).toContain("t('shell_brand_department', lang)");
  });

  it('shell_brand_department is defined bilingually with the exact requested phrases', () => {
    const line = strings.split('\n').find(l => l.includes('shell_brand_department:'));
    expect(line).toContain('دائرة صحة بابل - قسم الصيدلة');
    expect(line).toContain('Babylon Health Directorate - Pharmacy Department');
  });

  it('does not mix Arabic and English within a single string value', () => {
    const line = strings.split('\n').find(l => l.includes('shell_brand_department:'));
    const arMatch = line!.match(/ar: '([^']+)'/);
    const enMatch = line!.match(/en: '([^']+)'/);
    expect(arMatch![1]).not.toMatch(/[a-zA-Z]/);
    expect(enMatch![1]).not.toMatch(/[؀-ۿ]/);
  });

  it('the product name MediStock-Babil is still present in both brand areas', () => {
    expect(sidebar).toContain('MediStock-Babil');
    expect(drawer).toContain('MediStock-Babil');
  });

  it('print/report footer branding ("MediStock-Babil / MASAR Health Network") is untouched (out of scope for this UI nav phase)', () => {
    const institutions = readSrc('features/institutions/InstitutionScreen.tsx');
    const movementReport = readSrc('features/status/MovementReportSection.tsx');
    const qrScreen = readSrc('features/qr/QrScreen.tsx');
    const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
    [institutions, movementReport, qrScreen, statusCenter].forEach(content => {
      expect(content).toContain('MediStock-Babil / MASAR Health Network');
    });
  });
});

describe('Mobile drawer professional styling', () => {
  it('reuses the premium-sidebar + premium-dialog-panel glass/depth classes', () => {
    expect(drawer).toContain('premium-sidebar premium-dialog-panel premium-mobile-drawer');
  });

  it('has a styled backdrop class (not a raw inline color)', () => {
    expect(drawer).toContain('premium-drawer-backdrop');
  });

  it('supports smooth scrolling for a long nav list', () => {
    expect(drawer).toContain("overflowY: 'auto'");
  });

  it('reserves safe-area bottom spacing', () => {
    expect(drawer).toMatch(/env\(safe-area-inset-bottom/);
  });

  it('nav items keep at least 44px touch targets', () => {
    expect(drawer).toContain("minHeight: '44px'");
  });

  it('respects RTL via the dir attribute from context', () => {
    expect(drawer).toContain('dir={dir}');
    expect(drawer).toMatch(/textAlign: 'start'/);
  });
});

describe('CSS/tokens: new classes are CSS-only, reduced-motion safe, pointer-gated', () => {
  const css = readSrc('shared/lib/global.css');

  it('defines premium-drawer-backdrop, premium-drawer-close, premium-drawer-trigger, premium-bottom-nav-item', () => {
    ['premium-drawer-backdrop', 'premium-drawer-close', 'premium-drawer-trigger', 'premium-bottom-nav-item']
      .forEach(cls => expect(css).toContain(cls));
  });

  it('new hover effects are gated behind (hover: hover) and (pointer: fine)', () => {
    const hoverBlockStart = css.indexOf('.premium-drawer-close:hover');
    const surrounding = css.slice(Math.max(0, hoverBlockStart - 200), hoverBlockStart);
    expect(surrounding).toContain('@media (hover: hover) and (pointer: fine)');
  });

  it('global reduced-motion kill-switch still exists and is untouched', () => {
    expect(css).toContain('prefers-reduced-motion');
  });

  it('no WebGL/three.js/canvas-based effects were introduced', () => {
    expect(css).not.toMatch(/three\.js|WebGLRenderer|<canvas/i);
  });
});

describe('No forbidden content introduced by this phase', () => {
  const files = [bottomNav, drawer, sidebar, topbar, appShell];

  it('no supply_type in any touched file', () => {
    files.forEach(f => expect(f).not.toContain('supply_type'));
  });

  it('no suggestion/recommendation/opportunity/اقتراح/فرصة wording', () => {
    files.forEach(f => {
      expect(f.toLowerCase()).not.toMatch(/suggestion|suggested|recommendation|recommended|opportunit/);
      expect(f).not.toContain('اقتراح');
      expect(f).not.toContain('فرصة');
    });
  });

  it('no service_role or auth.admin', () => {
    files.forEach(f => {
      expect(f).not.toContain('service_role');
      expect(f).not.toMatch(/auth\.admin/);
    });
  });

  it('no Excel/XLSX import', () => {
    files.forEach(f => expect(f).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i));
  });

  it('no quantity-movement calls or direct item_availability quantity writes', () => {
    files.forEach(f => {
      expect(f).not.toContain('phoenix_apply_availability_movement');
      expect(f).not.toMatch(/UPDATE\s+(public\.)?item_availability\s+SET\s+quantity/i);
    });
  });

  it('no QR reference in the touched nav/shell files', () => {
    files.forEach(f => expect(f).not.toMatch(/qr[_-]?token|get_public_qr_payload/i));
  });
});
