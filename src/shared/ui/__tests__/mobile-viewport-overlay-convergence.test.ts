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
const globalCss = read('shared/lib/global.css');
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

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

describe('root sizing is explicit without hiding layout defects globally', () => {
  it('bounds root width but does not paper over defects with body overflow-x hidden', () => {
    expect(globalCss).toContain('#root { min-height: 100%; min-width: 0; width: 100%; max-width: 100%; }');
    expect(globalCss).not.toMatch(/body\s*\{[^}]*overflow-x:\s*hidden/s);
  });
});
