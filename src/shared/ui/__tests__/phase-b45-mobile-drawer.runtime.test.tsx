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

interface DrawerHarnessProps {
  currentScreen?: number;
  onNavigate?: (screen: number) => void;
  onLogout?: () => void;
}

function DrawerHarness({
  currentScreen = 21,
  onNavigate = () => undefined,
  onLogout = () => undefined,
}: DrawerHarnessProps) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>open drawer</button>
      <main><a href="#background">background link</a></main>
      {open && <PhoenixMobileDrawer currentScreen={currentScreen} onNavigate={onNavigate} onClose={() => setOpen(false)} onLogout={onLogout} />}
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

  it('closes from both the close control and the backdrop', () => {
    render(<DrawerHarness />);
    const opener = screen.getByRole('button', { name: 'open drawer' });

    fireEvent.click(opener);
    expect(screen.getByRole('dialog')).toHaveAttribute('dir', 'ltr');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(opener);
    const backdrop = document.querySelector('.premium-drawer-backdrop');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('navigates, closes, and keeps the current item explicit', () => {
    const onNavigate = vi.fn();
    render(<DrawerHarness currentScreen={21} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'open drawer' }));

    const active = document.querySelector('.premium-nav-item[aria-current="page"]');
    expect(active).toHaveAttribute('data-active', 'true');

    const target = document.querySelector('.premium-nav-item:not([aria-current])');
    expect(target).not.toBeNull();
    fireEvent.click(target!);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('logs out once and closes the drawer', () => {
    const onLogout = vi.fn();
    render(<DrawerHarness onLogout={onLogout} />);
    fireEvent.click(screen.getByRole('button', { name: 'open drawer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
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
