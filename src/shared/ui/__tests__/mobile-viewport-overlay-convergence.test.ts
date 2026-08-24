/**
 * MAJOR-J MOBILE RESPONSIVE + OVERLAY CONVERGENCE
 *
 * Durable source contracts for the shared phone geometry. Runtime/browser
 * acceptance remains a separate gate; these assertions prevent later desktop
 * polish from silently reintroducing clipped dialogs, notch overlap or
 * notification/palette overflow.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const dialog = read('shared/ui/PhoenixDialog.tsx');
const drawer = read('shared/ui/PhoenixMobileDrawer.tsx');
const topbar = read('shared/ui/PhoenixTopbar.tsx');
const bell = read('shared/ui/NotificationBell.tsx');
const nexus = read('shared/lib/phoenix-nexus.css');
const phaseAuth = read('shared/lib/phase-a-auth.css');
const globalCss = read('shared/lib/global.css');
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const userManagement = read('features/users/UserManagementScreen.tsx');
const toast = read('shared/ui/PhoenixToast.tsx');
const institutions = read('features/institutions/InstitutionScreen.tsx');
const directSupply = read('features/network/DirectSupplyOperations.tsx');
const facilityManagement = read('features/institutions/FacilityManagementPanel.tsx');
const myAccount = read('features/account/MyAccountScreen.tsx');
const thresholdModal = read('features/inventory/InventoryThresholdModal.tsx');
const broadcastAdmin = read('features/platform-broadcast/PlatformBroadcastAdminPanel.tsx');
const commandPalette = read('shared/ui/CommandPalette.tsx');
const publicQr = read('features/qr/PublicQrScreen.tsx');

describe('shared dialog geometry is bounded by the usable mobile viewport', () => {
  it('uses the modal z-layer, all four safe-area edges and responsive padding', () => {
    expect(dialog).toContain("zIndex: 'var(--z-modal)'");
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      expect(dialog).toContain(`safe-area-inset-${edge}`);
    }
    expect(dialog).toContain("padding: 'clamp(16px, 4vw, 28px)'");
  });

  it('cannot grow past dynamic viewport height and owns its scroll', () => {
    expect(dialog).toContain("maxHeight: 'calc(100dvh - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))'");
    expect(dialog).toContain("overflowY: 'auto'");
    expect(dialog).toContain("overscrollBehavior: 'contain'");
    expect(dialog).toContain("maxInlineSize: '100%'");
    expect(dialog).toContain('minWidth: 0');
  });
});

describe('highest-precedence Phase-A auth layer preserves real safe-area geometry', () => {
  it('binds inline-end controls to the physical safe edge in both directions', () => {
    expect(phaseAuth).toContain("html[data-phoenix-ui-phase='a'][dir='ltr'] .nexus-login__controls");
    expect(phaseAuth).toContain("html[data-phoenix-ui-phase='a'][dir='rtl'] .nexus-login__controls");
    expect(phaseAuth).toContain("html[data-phoenix-ui-phase='a'][dir='ltr'] .nexus-welcome__skip");
    expect(phaseAuth).toContain("html[data-phoenix-ui-phase='a'][dir='rtl'] .nexus-welcome__skip");
    expect(phaseAuth).toContain('safe-area-inset-right');
    expect(phaseAuth).toContain('safe-area-inset-left');
  });

  it('keeps narrow login/welcome content outside all four cutout/gesture insets', () => {
    expect(phaseAuth).toContain('padding-left: calc(14px + env(safe-area-inset-left, 0px));');
    expect(phaseAuth).toContain('padding-right: calc(14px + env(safe-area-inset-right, 0px));');
    expect(phaseAuth).toContain('calc(14px + env(safe-area-inset-top, 0px))');
    expect(phaseAuth).toContain('calc(14px + env(safe-area-inset-bottom, 0px))');
    expect(phaseAuth).toContain('left: calc(14px + env(safe-area-inset-left, 0px));');
    expect(phaseAuth).toContain('right: calc(14px + env(safe-area-inset-right, 0px));');
  });
});

describe('mobile shell chrome respects cutouts and short viewports', () => {
  it('keeps viewport-fit and Android keyboard resizing enabled', () => {
    expect(indexHtml).toContain('viewport-fit=cover');
    expect(indexHtml).toContain('interactive-widget=resizes-content');
  });

  it('topbar includes status-bar safe area and never wraps into an accidental row', () => {
    expect(topbar).toContain('safe-area-inset-top');
    expect(topbar).toContain("flexWrap: 'nowrap'");
    expect(nexus).toContain('safe-area-inset-left');
    expect(nexus).toContain('safe-area-inset-right');
  });

  it('drawer uses 100dvh and four physical safe-area insets', () => {
    expect(drawer).toContain("height: '100dvh'");
    expect(drawer).toContain("maxHeight: '100dvh'");
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      expect(drawer).toContain(`safe-area-inset-${edge}`);
    }
  });
});

describe('command palette behaves as a real modal surface', () => {
  it('traps Tab focus, restores prior focus and uses the modal z-layer', () => {
    expect(commandPalette).toContain('previouslyFocusedRef');
    expect(commandPalette).toContain("event.key !== 'Tab'");
    expect(commandPalette).toContain('panel.contains(active)');
    expect(commandPalette).toContain('previouslyFocusedRef.current?.focus?.()');
    expect(commandPalette).toContain("zIndex: 'var(--z-modal)'");
    expect(commandPalette).toContain('ref={panelRef}');
    expect(commandPalette).toContain('tabIndex={-1}');
  });
});

describe('non-PhoenixDialog overlays are phone-bounded', () => {
  it('notification panel becomes a fixed safe-area-bounded phone sheet', () => {
    expect(bell).toContain('className="nexus-notification-panel"');
    const mobile = nexus.slice(nexus.indexOf('@media (max-width: 767px)'));
    expect(mobile).toContain('.nexus-notification-panel');
    expect(mobile).toContain('position: fixed !important;');
    expect(mobile).toContain('safe-area-inset-top');
    expect(mobile).toContain('safe-area-inset-bottom');
    expect(mobile).toContain('overflow-y: auto !important;');
  });

  it('command palette shrinks with 100dvh and safe-area bounds', () => {
    const mobile = nexus.slice(nexus.indexOf('@media (max-width: 767px)'));
    expect(mobile).toContain('.nexus-command-backdrop');
    expect(mobile).toContain('.nexus-command-panel');
    expect(mobile).toContain('max-height: calc(100dvh - 16px');
  });

  it('install prompt clears horizontal cutouts and reflows actions at 380px', () => {
    expect(globalCss).toContain('left: calc(10px + env(safe-area-inset-left, 0px));');
    expect(globalCss).toContain('right: calc(10px + env(safe-area-inset-right, 0px));');
    expect(globalCss).toContain('grid-template-columns: auto minmax(0, 1fr);');
    expect(globalCss).toContain('min-height: var(--touch-target);');
  });
});

describe('authenticated shell keeps landscape content outside side cutouts', () => {
  it('adds left/right safe-area insets to the mobile main scroll owner', () => {
    const appShell = read('shared/ui/PhoenixAppShell.tsx');
    expect(appShell).toContain('env(safe-area-inset-right, 0px)');
    expect(appShell).toContain('env(safe-area-inset-left, 0px)');
    expect(appShell).toContain('calc(var(--bnh) + 14px + env(safe-area-inset-bottom, 0px))');
  });

  it('lets dialog actions wrap on 320-380px phones instead of forcing overflow', () => {
    expect(nexus).toContain('@media (max-width: 380px)');
    expect(nexus).toContain('.premium-dialog-panel .phoenix-button');
    expect(nexus).toContain('white-space: normal !important;');
    expect(nexus).toContain('overflow-wrap: anywhere;');
  });
});

describe('public QR shell respects phone cutouts without authenticated AppShell', () => {
  it('uses dynamic height and all four safe-area insets', () => {
    expect(publicQr).toContain("minHeight: '100dvh'");
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      expect(publicQr).toContain(`safe-area-inset-${edge}`);
    }
  });
});

describe('shell-absent mobile surfaces respect safe areas too', () => {
  it('login controls and form padding clear top/bottom/cutout insets', () => {
    expect(nexus).toContain('top: calc(20px + env(safe-area-inset-top, 0px));');
    expect(nexus).toContain('calc(72px + env(safe-area-inset-top, 0px))');
    expect(nexus).toContain('calc(34px + env(safe-area-inset-bottom, 0px))');
    expect(nexus).toContain('[dir="rtl"] .nexus-login__controls');
    expect(nexus).toContain('[dir="ltr"] .nexus-login__controls');
  });

  it('welcome root/skip and full-screen state clear physical safe areas', () => {
    const welcome = nexus.slice(nexus.indexOf('.nexus-welcome {'));
    expect(welcome).toContain('safe-area-inset-top');
    expect(welcome).toContain('safe-area-inset-right');
    expect(welcome).toContain('safe-area-inset-bottom');
    expect(welcome).toContain('safe-area-inset-left');
    expect(nexus).toContain('[dir="rtl"] .nexus-welcome__skip');
    expect(nexus).toContain('[dir="ltr"] .nexus-welcome__skip');
    const state = nexus.slice(nexus.indexOf('.nexus-state-screen {'));
    expect(state).toContain('safe-area-inset-top');
    expect(state).toContain('safe-area-inset-bottom');
  });
});

describe('narrow-phone forms collapse fixed desktop columns', () => {
  it('marks institution city/email rows and direct-supply add-line row for mobile collapse', () => {
    expect((institutions.match(/nexus-responsive-two-col/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((userManagement.match(/nexus-responsive-two-col/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((facilityManagement.match(/nexus-responsive-two-col/g) ?? []).length).toBe(2);
    expect(myAccount).toContain('nexus-responsive-two-col');
    expect(thresholdModal).toContain('nexus-responsive-two-col');
    expect(broadcastAdmin).toContain('nexus-responsive-two-col');
    expect(directSupply).toContain('nexus-responsive-action-grid');
    expect(nexus).toContain('.nexus-responsive-two-col');
    expect(nexus).toContain('.nexus-responsive-action-grid');
    expect(nexus).toContain('grid-template-columns: minmax(0, 1fr) !important;');
  });
});

describe('legacy user lifecycle overlays now satisfy modal keyboard semantics', () => {
  it('shares one focus/escape controller across all four lifecycle overlays', () => {
    expect(userManagement).toContain('function useLifecycleModalAccessibility');
    expect(userManagement).toContain("event.key === 'Escape'");
    expect(userManagement).toContain("event.key !== 'Tab'");
    expect(userManagement).toContain('previouslyFocusedRef.current?.focus?.()');
    expect((userManagement.match(/useLifecycleModalAccessibility\(/g) ?? []).length).toBe(5);
    expect((userManagement.match(/aria-modal="true"/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect((userManagement.match(/ref=\{modalRef\}/g) ?? []).length).toBe(4);
  });

  it('does not allow Escape to dismiss a lifecycle request while it is busy', () => {
    expect(userManagement).toContain('closeDisabledRef.current');
    expect(userManagement).toContain('useLifecycleModalAccessibility(onCancel, busy)');
    expect(userManagement).toContain('useLifecycleModalAccessibility(handleClose, busy)');
  });
});

describe('legacy user-management overlays and toast are viewport bounded', () => {
  it('bounds all lifecycle overlays by safe areas and 100dvh', () => {
    expect((userManagement.match(/nexus-ua-modal-overlay/g) ?? []).length).toBe(4);
    expect(nexus).toContain('.nexus-ua-modal-overlay');
    expect(nexus).toContain('.nexus-ua-modal-panel');
    expect(nexus).toContain('max-height: calc(100dvh - 24px');
    expect(nexus).toContain('overscroll-behavior: contain;');
  });

  it('lets recycle-account form grids collapse to one column on narrow phones', () => {
    expect(userManagement).toContain("repeat(auto-fit, minmax(150px, 1fr))");
  });

  it('keeps toast above the gesture bar and inside horizontal cutouts', () => {
    expect(toast).toContain('safe-area-inset-bottom');
    expect(toast).toContain('safe-area-inset-left');
    expect(toast).toContain('safe-area-inset-right');
  });
});

describe('root sizing is explicit without hiding layout defects globally', () => {
  it('bounds root width but does not paper over defects with body overflow-x hidden', () => {
    expect(globalCss).toContain('#root { min-height: 100%; min-width: 0; width: 100%; max-width: 100%; }');
    expect(globalCss).not.toMatch(/body\s*\{[^}]*overflow-x:\s*hidden/s);
  });
});
