/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Owner decision 2026-10-30: production no longer exposes an interactive guide
// or a phone bottom bar. Keep the real drawer and canonical nav projection.
let mobile = false;
let lang: 'ar' | 'en' = 'en';
const navigate = vi.fn();
const logout = vi.fn();
const toggleLang = vi.fn();
const toggleTheme = vi.fn();
vi.mock('@/app/AppContext', () => ({ useApp: () => ({
  lang, dir: lang === 'ar' ? 'rtl' : 'ltr', theme: 'light',
  role: 'super_admin', myPermissions: new Set(['dashboard.view', 'central_needs.view']),
  activeOrganizationKind: 'pharmacy_department',
  toggleLang, toggleTheme, profile: { id: 'fixture-user', role: 'super_admin' },
}) }));
vi.mock('@/shared/ui/useResponsiveViewport', () => ({ useIsMobileViewport: () => mobile }));
vi.mock('@/shared/ui/NotificationBell', () => ({ NotificationBell: () => <span data-testid="bell" /> }));
vi.mock('@/shared/pwa/PwaInstallPrompt', () => ({ PwaInstallPrompt: () => null }));
vi.mock('@/features/platform-broadcast/PlatformBroadcastGate', () => ({ PlatformBroadcastGate: () => null }));
vi.mock('@/shared/ui/CommandPalette', () => ({ CommandPalette: () => null }));
// Fail if shell retirement regresses into mounting the guide or phone bar.
vi.mock('../GuideHost', () => ({ useGuideHost: () => { throw new Error('Retired guide host reached'); } }));
vi.mock('@/shared/ui/PhoenixMobileBottomNav', () => ({ PhoenixMobileBottomNav: () => { throw new Error('Retired bottom bar reached'); } }));
import { PhoenixAppShell } from '@/shared/ui/PhoenixAppShell';

function mount() {
  return render(<PhoenixAppShell currentScreen={22} onNavigate={navigate} onLogout={logout}>
    <button>Screen action</button>
  </PhoenixAppShell>);
}
function expectNoRetiredUi() {
  expect(document.querySelector('.guide-entry-button,.guide-layer,.premium-bottom-nav')).toBeNull();
  expect(screen.queryByRole('button', { name: /Guide & Help|الدليل والمساعدة/ })).toBeNull();
}
afterEach(() => { cleanup(); vi.clearAllMocks(); mobile = false; lang = 'en'; });

for (const language of ['ar', 'en'] as const) {
  for (const phone of [false, true]) {
    describe(`${language} ${phone ? 'phone' : 'desktop/tablet'} shell after retirement`, () => {
      it('renders the real screen and retains language, theme and notifications without guide or bottom bar', () => {
        lang = language; mobile = phone; mount(); expectNoRetiredUi();
        expect(screen.getByRole('button', { name: 'Screen action' })).toBeInTheDocument();
        expect(screen.getByTestId('bell')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: language === 'ar' ? 'التبديل إلى الإنجليزية' : 'Switch to Arabic' }));
        fireEvent.click(screen.getByRole('button', { name: language === 'ar' ? 'تفعيل المظهر الداكن' : 'Activate dark theme' }));
        expect(toggleLang).toHaveBeenCalledOnce(); expect(toggleTheme).toHaveBeenCalledOnce();
        if (phone) {
          expect(screen.queryByRole('navigation')).toBeNull();
          fireEvent.click(screen.getByRole('button', { name: language === 'ar' ? 'القائمة' : 'Menu' }));
          expect(screen.getByRole('dialog')).toBeInTheDocument(); expectNoRetiredUi();
        } else expect(screen.getByRole('navigation')).toBeInTheDocument();
      });
    });
  }
  it(`phone drawer navigates through the existing callback, closes and restores focus — ${language}`, () => {
    lang = language; mobile = true; mount();
    const menu = screen.getByRole('button', { name: language === 'ar' ? 'القائمة' : 'Menu' });
    menu.focus(); fireEvent.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: language === 'ar' ? 'حسابي' : 'My Account' }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith(15);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(menu).toHaveFocus(); expect(menu).toHaveAttribute('aria-expanded', 'false');
  });
}
it('Escape closes the drawer, restores background accessibility and preserves the screen', () => {
  mobile = true; mount(); const menu = screen.getByRole('button', { name: 'Menu' });
  menu.focus(); fireEvent.click(menu);
  expect(document.querySelector('.nexus-app-column')).toHaveAttribute('inert');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.querySelector('.nexus-app-column')).not.toHaveAttribute('inert');
  expect(menu).toHaveFocus(); expect(navigate).not.toHaveBeenCalled();
});
it('drawer logout uses the existing callback once', () => {
  mobile = true; mount(); fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(logout).toHaveBeenCalledOnce(); expect(screen.queryByRole('dialog')).toBeNull();
});
