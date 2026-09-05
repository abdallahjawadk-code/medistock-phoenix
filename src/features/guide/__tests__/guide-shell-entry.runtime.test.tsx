/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

/**
 * INTERACTIVE-GUIDE-IG1 — where the Guide & Help entry lives, and that opening
 * it actually mounts the engine.
 *
 * The placement is asserted rather than described because it is a MEASURED
 * decision: at 375px the topbar already fills its width with the menu trigger,
 * the title, the bell, the language toggle and the theme toggle, so the phone
 * entry belongs in the drawer. A future change that quietly adds the control
 * to the mobile topbar fails here.
 */

let appState = {
  lang: 'en' as 'ar' | 'en',
  dir: 'ltr' as 'rtl' | 'ltr',
  theme: 'light' as const,
  role: 'super_admin',
  myPermissions: new Set<string>(['dashboard.view']),
  toggleLang: () => undefined,
  toggleTheme: () => undefined,
  profile: { id: 'p1', full_name: 'Tester', role: 'super_admin' },
  session: { user: { id: 'u1' } },
  authStatus: 'authenticated' as string,
};

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('@/shared/ui/PhoenixIcon', () => ({
  PhoenixIcon: ({ name }: { name: string }) => <span aria-hidden="true" data-icon={name} />,
}));
vi.mock('@/shared/ui/PhoenixMark', () => ({ PhoenixMark: () => <span aria-hidden="true" /> }));
vi.mock('@/shared/ui/NotificationBell', () => ({ NotificationBell: () => <span data-testid="bell" /> }));

import { PhoenixTopbar } from '@/shared/ui/PhoenixTopbar';
import { PhoenixMobileDrawer } from '@/shared/ui/PhoenixMobileDrawer';
import { useGuideHost } from '../GuideHost';

function resetState() {
  appState = {
    lang: 'en', dir: 'ltr', theme: 'light',
    role: 'super_admin', myPermissions: new Set(['dashboard.view']),
    toggleLang: () => undefined, toggleTheme: () => undefined,
    profile: { id: 'p1', full_name: 'Tester', role: 'super_admin' },
    session: { user: { id: 'u1' } },
    authStatus: 'authenticated',
  };
}

beforeEach(resetState);
afterEach(() => { cleanup(); resetState(); });

function TopbarHarness({ isMobile }: { isMobile: boolean }) {
  const { controller, host } = useGuideHost({ currentScreen: 22, onNavigate: () => undefined });
  return (
    <div>
      <PhoenixTopbar
        title="Reporting"
        isMobile={isMobile}
        menuOpen={false}
        onMenuClick={() => undefined}
        onOpenGuide={controller.open}
      />
      {host}
    </div>
  );
}

function DrawerHarness() {
  const [open, setOpen] = useState(true);
  const { controller, host } = useGuideHost({ currentScreen: 22, onNavigate: () => undefined });
  return (
    <div>
      <main><a href="#bg">background</a></main>
      {open && (
        <PhoenixMobileDrawer
          currentScreen={22}
          onNavigate={() => undefined}
          onClose={() => setOpen(false)}
          onLogout={() => undefined}
          onOpenGuide={controller.open}
        />
      )}
      {host}
    </div>
  );
}

describe('Guide & Help entry placement', () => {
  it('sits in the desktop topbar', () => {
    render(<TopbarHarness isMobile={false} />);
    expect(screen.getByRole('button', { name: 'Open Guide & Help' })).toBeInTheDocument();
  });

  /**
   * The regression for the owner acceptance failure, at the cheapest layer.
   *
   * The entry first shipped as a bare glyph. It was present, visible and
   * clickable on desktop — and unfindable, because nothing on it said what it
   * was. Presence is therefore not what these assert: the control must carry
   * its own translated NAME as rendered text. The browser suite proves the
   * same thing against real layout at 1280, 1440 and 1920.
   */
  it('carries its translated name as visible text on desktop', () => {
    render(<TopbarHarness isMobile={false} />);
    const entry = screen.getByRole('button', { name: 'Open Guide & Help' });
    const label = entry.querySelector('.nexus-control__label');
    expect(label).not.toBeNull();
    expect(label).toHaveTextContent('Guide & Help');
    // WCAG 2.5.3: the accessible name contains the visible label.
    expect(entry.getAttribute('aria-label')).toContain('Guide & Help');
  });

  it('names itself in Arabic when the application is Arabic', () => {
    appState = { ...appState, lang: 'ar', dir: 'rtl' };
    render(<TopbarHarness isMobile={false} />);
    const entry = screen.getByRole('button', { name: 'فتح الدليل والمساعدة' });
    expect(entry.querySelector('.nexus-control__label')).toHaveTextContent('الدليل والمساعدة');
    expect(entry.getAttribute('aria-label')).toContain('الدليل والمساعدة');
  });

  it('keeps a tooltip so the constrained icon-only fallback still identifies itself', () => {
    // Below 1024px the stylesheet drops the label; `title` and `aria-label`
    // are rendered unconditionally so that fallback is never anonymous.
    render(<TopbarHarness isMobile={false} />);
    const entry = screen.getByRole('button', { name: 'Open Guide & Help' });
    expect(entry.getAttribute('title')).toContain('Guide & Help');
  });

  it('offers exactly one entry on desktop and one on a phone, never two', () => {
    const desktop = render(<TopbarHarness isMobile={false} />);
    expect(document.querySelectorAll('[data-guide-id="guide.shell.topbar.help"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-guide-id="guide.shell.drawer.help"]')).toHaveLength(0);
    desktop.unmount();

    render(<DrawerHarness />);
    expect(document.querySelectorAll('[data-guide-id="guide.shell.topbar.help"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-guide-id="guide.shell.drawer.help"]')).toHaveLength(1);
  });

  it('is offered to an operator holding no permissions at all', () => {
    /**
     * Discoverability is not permission-gated. Permissions filter the guide's
     * CONTENT — see guide.permissions.ts — never the way in.
     */
    appState = { ...appState, myPermissions: new Set<string>(), role: 'outlet_officer' };
    render(<TopbarHarness isMobile={false} />);
    expect(screen.getByRole('button', { name: 'Open Guide & Help' })).toBeInTheDocument();
  });

  it('is ABSENT from the mobile topbar, which has no room for it', () => {
    render(<TopbarHarness isMobile />);
    expect(screen.queryByRole('button', { name: 'Open Guide & Help' })).toBeNull();
    // The controls it must not displace are all still there.
    expect(screen.getByRole('button', { name: 'Menu' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to Arabic' })).toBeInTheDocument();
  });

  it('sits in the mobile drawer instead, beside the other standalone pages', () => {
    render(<DrawerHarness />);
    expect(screen.getByRole('button', { name: 'Guide & Help' })).toBeInTheDocument();
  });

  it('renders its label in Arabic when the application is Arabic', () => {
    appState = { ...appState, lang: 'ar', dir: 'rtl' };
    render(<TopbarHarness isMobile={false} />);
    expect(screen.getByRole('button', { name: 'فتح الدليل والمساعدة' })).toBeInTheDocument();
  });
});

describe('Guide & Help entry behaviour', () => {
  it('mounts nothing of the guide until it is asked for', () => {
    render(<TopbarHarness isMobile={false} />);
    expect(document.querySelector('.guide-layer')).toBeNull();
  });

  it('opens the Help Center on click', async () => {
    render(<TopbarHarness isMobile={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Guide & Help' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Guide & Help' })).toBeInTheDocument());
  });

  it('returns focus to the control that opened it when it closes', async () => {
    render(<TopbarHarness isMobile={false} />);
    const opener = screen.getByRole('button', { name: 'Open Guide & Help' });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Guide & Help' })).toBeInTheDocument());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Guide & Help' })).toBeNull());
    expect(opener).toHaveFocus();
  });

  it('closes the drawer before opening, so focus is not fought over', async () => {
    render(<DrawerHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Guide & Help' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Guide & Help' })).toBeInTheDocument());
    // The drawer is gone; only the guide's dialog remains.
    expect(screen.queryByRole('dialog', { name: 'MediStock-Babil Phoenix' })).toBeNull();
  });

  it('does not crash when the opener has unmounted behind the guide', async () => {
    // Exactly the drawer case: the element that was focused at open time is
    // detached by the time the guide closes.
    render(<DrawerHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Guide & Help' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Guide & Help' })).toBeInTheDocument());
    expect(() => fireEvent.keyDown(document, { key: 'Escape' })).not.toThrow();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Guide & Help' })).toBeNull());
  });
});
