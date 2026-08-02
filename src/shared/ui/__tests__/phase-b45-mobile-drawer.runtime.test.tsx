/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

let appState = {
  lang: 'en' as 'ar' | 'en', dir: 'ltr' as 'rtl' | 'ltr',
  role: 'super_admin', myPermissions: new Set<string>(),
  toggleLang: () => undefined, toggleTheme: () => undefined, theme: 'light' as const,
};

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('../PhoenixIcon', () => ({ PhoenixIcon: ({ name }: { name: string }) => <span aria-hidden="true" data-icon={name} /> }));
vi.mock('../PhoenixMark', () => ({ PhoenixMark: () => <span aria-hidden="true" /> }));
vi.mock('../NotificationBell', () => ({ NotificationBell: () => null }));

import { PhoenixMobileDrawer } from '../PhoenixMobileDrawer';
import { PhoenixTopbar } from '../PhoenixTopbar';

function DrawerHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>open drawer</button>
      <main><a href="#background">background link</a></main>
      {open && <PhoenixMobileDrawer currentScreen={21} onNavigate={() => undefined} onClose={() => setOpen(false)} onLogout={() => undefined} />}
    </div>
  );
}

afterEach(() => {
  cleanup();
  appState = { lang: 'en', dir: 'ltr', role: 'super_admin', myPermissions: new Set(), toggleLang: () => undefined, toggleTheme: () => undefined, theme: 'light' };
});

describe('PHASE B5 — mobile drawer keyboard and semantics', () => {
  it('moves focus inside, traps Tab/Shift+Tab, and marks the background inert', () => {
    render(<DrawerHarness />);
    const opener = screen.getByRole('button', { name: 'open drawer' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'MediStock-Babil Phoenix' });
    const close = screen.getByRole('button', { name: 'Close' });
    const logout = screen.getByRole('button', { name: 'Sign out' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(close).toHaveFocus();
    expect(dialog.parentElement?.querySelector('main')).toHaveAttribute('inert');
    logout.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(logout).toHaveFocus();
  });

  it('Escape closes, removes trap/inert state, and restores focus', () => {
    render(<DrawerHarness />);
    const opener = screen.getByRole('button', { name: 'open drawer' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    expect(document.querySelector('main')).not.toHaveAttribute('inert');
  });

  it('uses bilingual labels and direction', () => {
    appState = { ...appState, lang: 'ar', dir: 'rtl' };
    render(<PhoenixMobileDrawer currentScreen={21} onNavigate={() => undefined} onClose={() => undefined} onLogout={() => undefined} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('navigation', { name: 'التنقّل الرئيسي' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إغلاق' })).toBeInTheDocument();
  });

  it('exposes trigger expansion and drawer relationship', () => {
    const { rerender } = render(<PhoenixTopbar title="Title" isMobile menuOpen={false} onMenuClick={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-controls', 'phoenix-mobile-drawer');
    rerender(<PhoenixTopbar title="Title" isMobile menuOpen onMenuClick={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
  });
});
