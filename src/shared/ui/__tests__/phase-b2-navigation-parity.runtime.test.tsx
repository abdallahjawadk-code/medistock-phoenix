/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { institutionsScreenAccess, roleLandingScreen } from '@/shared/authz/screen-access';
import { t } from '@/shared/i18n/strings';

const getOrganizations = vi.fn(async () => []);
let appState: {
  lang: 'ar' | 'en';
  dir: 'rtl' | 'ltr';
  role: string;
  profile: { full_name: string };
  myPermissions: Set<string>;
} = {
  lang: 'en',
  dir: 'ltr',
  role: 'warehouse_officer',
  profile: { full_name: 'Navigation Test User' },
  myPermissions: new Set(),
};

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('@/shared/supabase/services/organizations.service', () => ({
  getOrganizations: () => getOrganizations(),
}));
vi.mock('../PhoenixIcon', () => ({
  PhoenixIcon: ({ name }: { name: string }) => <span aria-hidden="true" data-icon={name} />,
}));
vi.mock('../PhoenixMark', () => ({
  PhoenixMark: () => <span aria-hidden="true" data-testid="phoenix-mark" />,
}));

import { PhoenixSidebar } from '../PhoenixSidebar';
import { PhoenixMobileDrawer } from '../PhoenixMobileDrawer';
import { PhoenixMobileBottomNav } from '../PhoenixMobileBottomNav';
import { CommandPalette } from '../CommandPalette';

type Surface = 'desktop' | 'drawer' | 'bottom' | 'palette';

const noop = () => undefined;

function setActor(role: string, permissions: string[] = [], lang: 'ar' | 'en' = 'en') {
  appState = {
    lang,
    dir: lang === 'ar' ? 'rtl' : 'ltr',
    role,
    profile: { full_name: 'Navigation Test User' },
    myPermissions: new Set(permissions),
  };
}

function renderSurface(surface: Surface) {
  if (surface === 'desktop') {
    return render(<PhoenixSidebar currentScreen={21} onNavigate={noop} onLogout={noop} />);
  }
  if (surface === 'drawer') {
    return render(
      <PhoenixMobileDrawer
        currentScreen={21}
        onNavigate={noop}
        onClose={noop}
        onLogout={noop}
      />,
    );
  }
  if (surface === 'bottom') {
    return render(<PhoenixMobileBottomNav currentScreen={21} onNavigate={noop} />);
  }
  const view = render(<CommandPalette onNavigate={noop} />);
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  return view;
}

function screen11Label(role: string): string {
  return t(institutionsScreenAccess(role) === 'own' ? 'nav_my_organization' : 'nav_institutions', 'en');
}

function surfaceHasScreen11(surface: Surface, role: string): boolean {
  const view = renderSurface(surface);
  const present = screen.queryByRole('button', { name: screen11Label(role) }) !== null;
  view.unmount();
  return present;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('dir');
});

describe('PHASE B2 — Screen 11 navigation permission parity', () => {
  it('hides Screen 11 on every permission-filtered surface for an ineligible user', () => {
    setActor('warehouse_officer', ['users.view', 'users.edit_scope']);
    for (const surface of ['desktop', 'drawer', 'bottom', 'palette'] as const) {
      expect(surfaceHasScreen11(surface, 'warehouse_officer'), surface).toBe(false);
    }
  });

  it('shows My Organization on every surface for an eligible institution admin', () => {
    setActor('institution_admin');
    for (const surface of ['desktop', 'drawer', 'bottom', 'palette'] as const) {
      expect(surfaceHasScreen11(surface, 'institution_admin'), surface).toBe(true);
    }
  });

  it('uses the central policy as the identical eligibility decision across all surfaces', () => {
    const roles = [
      'super_admin',
      'institution_admin',
      'hospital_admin',
      'warehouse_officer',
      'outlet_officer',
    ];
    for (const role of roles) {
      setActor(role);
      const expected = institutionsScreenAccess(role) !== false;
      const decisions = (['desktop', 'drawer', 'bottom', 'palette'] as const)
        .map(surface => surfaceHasScreen11(surface, role));
      expect(decisions, role).toEqual([expected, expected, expected, expected]);
    }
  });

  it('does not turn users.view or users.edit_scope into a new Screen 11 permission', () => {
    setActor('warehouse_officer', ['users.view', 'users.edit_scope']);
    expect(institutionsScreenAccess('warehouse_officer')).toBe(false);
    expect(surfaceHasScreen11('bottom', 'warehouse_officer')).toBe(false);

    setActor('super_admin');
    expect(surfaceHasScreen11('bottom', 'super_admin')).toBe(true);
  });
});

describe('PHASE B2 — keyboard-only Command Palette entry', () => {
  it('renders no floating or hidden focusable trigger in any direction or theme', () => {
    for (const lang of ['ar', 'en'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        setActor('super_admin', [], lang);
        document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
        document.documentElement.setAttribute('data-theme', theme);
        const view = render(<CommandPalette onNavigate={noop} />);
        expect(document.querySelector('.premium-command-trigger')).toBeNull();
        expect(screen.queryByRole('button', { name: t('cc_palette_open', lang) })).toBeNull();
        view.unmount();
      }
    }
  });

  it('opens exactly one palette with Ctrl+K and exactly one with Cmd+K', () => {
    setActor('super_admin');
    render(<CommandPalette onNavigate={noop} />);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('leaves no floating spacing, z-index, keyboard marker, or CSS residue', () => {
    const srcRoot = join(__dirname, '../../../');
    const palette = readFileSync(join(srcRoot, 'shared/ui/CommandPalette.tsx'), 'utf8');
    const shell = readFileSync(join(srcRoot, 'shared/ui/PhoenixAppShell.tsx'), 'utf8');
    const css = readFileSync(join(srcRoot, 'shared/lib/phoenix-nexus.css'), 'utf8');

    for (const source of [palette, css]) expect(source).not.toContain('premium-command-trigger');
    expect(css).not.toContain('html[data-keyboard="open"]');
    expect(shell).not.toContain('window.visualViewport');
    expect(shell).not.toContain("setAttribute('data-keyboard', 'open')");
  });
});

describe('PHASE B2 — copy and preserved navigation contracts', () => {
  it('renders the official English Sign out label and preserves Arabic خروج', () => {
    setActor('super_admin', [], 'en');
    const english = render(<PhoenixSidebar currentScreen={21} onNavigate={noop} onLogout={noop} />);
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Exit Demo' })).toBeNull();
    english.unmount();

    setActor('super_admin', [], 'ar');
    render(<PhoenixSidebar currentScreen={21} onNavigate={noop} onLogout={noop} />);
    expect(screen.getByRole('button', { name: 'خروج' })).toBeInTheDocument();
  });

  it('preserves the existing landing screens and direct Screen 11 access policy', () => {
    expect(roleLandingScreen('outlet_officer')).toBe(18);
    expect(roleLandingScreen('warehouse_officer')).toBe(21);
    expect(roleLandingScreen('super_admin')).toBe(21);
    expect(institutionsScreenAccess('super_admin')).toBe('directory');
    expect(institutionsScreenAccess('institution_admin')).toBe('own');
    expect(institutionsScreenAccess('warehouse_officer')).toBe(false);
  });
});

// MOBILE_DRAWER_ANNUAL_NEEDS_NAVIGATION: Screen 23 (Annual Needs) must be reachable from the phone drawer through the SAME
// candidate list + projectNavigation policy as the desktop sidebar — no drawer-local permission or role check.
describe('MOBILE DRAWER — Screen 23 (Annual Needs) navigation parity', () => {
  const annualNeeds = () => t('cn2b_nav', 'en');

  function drawerHasAnnualNeeds(): boolean {
    const view = render(
      <PhoenixMobileDrawer currentScreen={21} onNavigate={noop} onClose={noop} onLogout={noop} />,
    );
    const present = screen.queryByRole('button', { name: annualNeeds() }) !== null;
    view.unmount();
    return present;
  }

  function sidebarHasAnnualNeeds(): boolean {
    const view = render(<PhoenixSidebar currentScreen={21} onNavigate={noop} onLogout={noop} />);
    const present = screen.queryByRole('button', { name: annualNeeds() }) !== null;
    view.unmount();
    return present;
  }

  it('shows Annual Needs in the drawer for super_admin (same decision as the desktop sidebar)', () => {
    setActor('super_admin');
    expect(drawerHasAnnualNeeds()).toBe(true);
    expect(sidebarHasAnnualNeeds()).toBe(true);
  });

  it('shows Annual Needs in the drawer for central_warehouse_manager holding central_needs.view', () => {
    setActor('central_warehouse_manager', ['central_needs.view']);
    expect(drawerHasAnnualNeeds()).toBe(true);
    expect(sidebarHasAnnualNeeds()).toBe(true);
  });

  it('hides Annual Needs in the drawer for central_warehouse_manager without central_needs.view', () => {
    setActor('central_warehouse_manager');
    expect(drawerHasAnnualNeeds()).toBe(false);
    expect(sidebarHasAnnualNeeds()).toBe(false);
  });

  it('hides Annual Needs in the drawer for an unrelated role even when it holds central_needs.view', () => {
    setActor('institution_admin', ['central_needs.view']);
    expect(drawerHasAnnualNeeds()).toBe(false);
    expect(sidebarHasAnnualNeeds()).toBe(false);
  });

  it('navigates to exactly Screen 23 when the drawer entry is clicked', () => {
    setActor('super_admin');
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<PhoenixMobileDrawer currentScreen={21} onNavigate={onNavigate} onClose={onClose} onLogout={noop} />);
    fireEvent.click(screen.getByRole('button', { name: annualNeeds() }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith(23);
  });

  it('closes the drawer with the same click', () => {
    setActor('central_warehouse_manager', ['central_needs.view']);
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<PhoenixMobileDrawer currentScreen={21} onNavigate={onNavigate} onClose={onClose} onLogout={noop} />);
    fireEvent.click(screen.getByRole('button', { name: annualNeeds() }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith(23);
  });
});
