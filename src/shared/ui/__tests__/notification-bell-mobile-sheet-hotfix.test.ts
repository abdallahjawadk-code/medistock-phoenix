import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const bell = readFileSync(join(SRC, 'shared/ui/NotificationBell.tsx'), 'utf8').replace(/\r\n/g, '\n');

describe('mobile notification sheet hotfix', () => {
  it('ports the phone sheet outside shell/topbar clipping contexts without breaking the E2E selector contract', () => {
    expect(bell).toContain("import { createPortal } from 'react-dom';");
    expect(bell).toContain("import { useIsMobileViewport } from './useResponsiveViewport';");
    expect(bell).toContain('className="nexus-notification-panel"');
    expect(bell).toContain('createPortal(notificationPanel, document.body)');
  });

  it('pins all four physical phone edges and overrides the historical logical-inset conflict at important priority', () => {
    expect(bell).toContain("position: 'fixed'");
    expect(bell).toContain("top: 'calc(var(--tbh) + env(safe-area-inset-top, 0px) + 8px)'");
    expect(bell).toContain("right: 'calc(8px + env(safe-area-inset-right, 0px))'");
    expect(bell).toContain("bottom: 'calc(var(--bnh) + env(safe-area-inset-bottom, 0px) + 8px)'");
    expect(bell).toContain("left: 'calc(8px + env(safe-area-inset-left, 0px))'");
    expect(bell).toContain("panel.style.setProperty('left', left, 'important')");
    expect(bell).toContain("panel.style.setProperty('right', right, 'important')");
    expect(bell).toContain("panel.style.setProperty('inset-inline-end', direction === 'rtl' ? left : right, 'important')");
    expect(bell).toContain("zIndex: 'var(--z-modal)'");
    expect(bell).toContain("overscrollBehavior: 'contain'");
  });

  it('keeps portalled clicks inside the panel and restores keyboard focus on Escape', () => {
    expect(bell).toContain('panelRef.current?.contains(target)');
    expect(bell).toContain("event.key !== 'Escape'");
    expect(bell).toContain('bellButtonRef.current?.focus()');
    expect(bell).toContain('aria-modal={isMobile ? true : undefined}');
    expect(bell).toContain('aria-controls="phoenix-notification-panel"');
  });

  it('preserves the existing bell-anchored desktop panel', () => {
    expect(bell).toContain("position: 'absolute', top: 'calc(100% + 8px)', insetInlineEnd: 0");
    expect(bell).toContain("width: 'min(380px, 92vw)'");
    expect(bell).toContain("zIndex: 'var(--z-topbar, 40)'");
  });
});
