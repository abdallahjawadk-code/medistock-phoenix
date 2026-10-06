/** @vitest-environment jsdom */
/**
 * PDA-PROC-1 — the four navigation surfaces render the SAME organization
 * eligibility answer for Screen 19 (Local Procurement / supplementary
 * purchases), because each hands the active organization kind to the one
 * shared projection. There is no per-surface "if PDA hide 19".
 *
 * The real components are rendered against a mocked useApp(); the decision
 * under test is the production projection, not a copy of it.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { t } from '@/shared/i18n/strings';
import type { OrganizationKind } from '@/shared/lib/institution-hierarchy';

const getOrganizations = vi.fn(async () => []);
let appState: {
  lang: 'ar' | 'en';
  dir: 'rtl' | 'ltr';
  role: string;
  profile: { full_name: string };
  myPermissions: Set<string>;
  activeOrganizationKind: OrganizationKind | null;
  activeOrganizationKindPending: boolean;
} = {
  lang: 'en',
  dir: 'ltr',
  role: 'institution_admin',
  profile: { full_name: 'Procurement Nav User' },
  myPermissions: new Set(),
  activeOrganizationKind: null,
  activeOrganizationKindPending: false,
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
const SURFACES: readonly Surface[] = ['desktop', 'drawer', 'bottom', 'palette'];
const MENU_SURFACES: readonly Surface[] = ['desktop', 'drawer', 'palette'];

const noop = () => undefined;
const PROCUREMENT = () => t('nav_local_procurement', 'en');
const REPORTS = () => t('nav_decision_reports', 'en');

function setActor(
  role: string,
  activeOrganizationKind: OrganizationKind | null,
  permissions: string[] = [],
  activeOrganizationKindPending = false,
) {
  appState = {
    lang: 'en',
    dir: 'ltr',
    role,
    profile: { full_name: 'Procurement Nav User' },
    myPermissions: new Set(permissions),
    activeOrganizationKind,
    activeOrganizationKindPending,
  };
}

function element(surface: Surface, onNavigate: (screen: number) => void = noop) {
  if (surface === 'desktop') return <PhoenixSidebar currentScreen={21} onNavigate={onNavigate} onLogout={noop} />;
  if (surface === 'drawer') {
    return <PhoenixMobileDrawer currentScreen={21} onNavigate={onNavigate} onClose={noop} onLogout={noop} />;
  }
  if (surface === 'bottom') return <PhoenixMobileBottomNav currentScreen={21} onNavigate={onNavigate} />;
  return <CommandPalette onNavigate={onNavigate} />;
}

function renderSurface(surface: Surface, onNavigate: (screen: number) => void = noop) {
  const view = render(element(surface, onNavigate));
  if (surface === 'palette') fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  return view;
}

/**
 * Is a button with exactly this accessible label rendered? A direct DOM scan
 * (aria-label, else text) rather than queryByRole: the role query recomputes
 * the accessibility tree per call, which is far too slow for these sweeps.
 */
function has(name: string): boolean {
  return Array.from(document.body.querySelectorAll('button')).some(button =>
    (button.getAttribute('aria-label') ?? button.textContent ?? '').replace(/\s+/g, ' ').trim() === name);
}

/** Does this surface offer Screen 19, and does it offer Reports (control)? */
function offers(surface: Surface): { procurement: boolean; reports: boolean } {
  const view = renderSurface(surface);
  const result = { procurement: has(PROCUREMENT()), reports: has(REPORTS()) };
  view.unmount();
  return result;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// The sweeps mount every surface many times; jsdom on a shared machine needs headroom.
describe('PDA-PROC-1 — Screen 19 on the four navigation surfaces', { timeout: 30_000 }, () => {
  it('a care institution keeps Supplementary Purchases in the sidebar, drawer and palette', () => {
    for (const role of ['institution_admin', 'warehouse_officer', 'central_warehouse_manager', 'super_admin']) {
      setActor(role, 'care_institution');
      for (const surface of MENU_SURFACES) {
        expect(offers(surface).procurement, `${role} / ${surface}`).toBe(true);
      }
    }
  });

  it('a pharmacy department authority sees it on NO surface, while the rest of the menu stays', () => {
    for (const role of ['institution_admin', 'warehouse_officer', 'central_warehouse_manager']) {
      setActor(role, 'pharmacy_department_authority');
      for (const surface of SURFACES) {
        const seen = offers(surface);
        expect(seen.procurement, `${role} / ${surface}`).toBe(false);
        // Control: the surface did render its other entries.
        expect(seen.reports, `${role} / ${surface} reports`).toBe(true);
      }
    }
  });

  it('an unknown kind (null) hides it on every surface', () => {
    setActor('institution_admin', null);
    for (const surface of SURFACES) {
      const seen = offers(surface);
      expect(seen.procurement, surface).toBe(false);
      expect(seen.reports, `${surface} reports`).toBe(true);
    }
  });

  it('a pending kind read hides it on every surface (fail closed while unknown)', () => {
    setActor('institution_admin', null, [], true);
    for (const surface of SURFACES) {
      expect(offers(surface).procurement, surface).toBe(false);
    }
  });

  it('super_admin holding every key is NOT a bypass for a PDA or an unknown organization', () => {
    const everything = ['users.view', 'users.edit_scope', 'warehouse_transfer.send', 'dashboard.view',
      'central_needs.view', 'local_procurement.view', 'local_procurement.manage'];
    for (const kind of ['pharmacy_department_authority', null] as const) {
      setActor('super_admin', kind, everything);
      for (const surface of SURFACES) {
        expect(offers(surface).procurement, `${kind} / ${surface}`).toBe(false);
      }
    }
  });

  it('the bottom bar never carries Screen 19 for any kind', () => {
    for (const kind of ['care_institution', 'pharmacy_department_authority', null] as const) {
      setActor('institution_admin', kind);
      expect(offers('bottom').procurement, String(kind)).toBe(false);
    }
  });

  it('a facility-scoped role inside a care institution still sees no Screen 19', () => {
    setActor('health_center_manager', 'care_institution');
    for (const surface of SURFACES) {
      expect(offers(surface).procurement, surface).toBe(false);
    }
  });

  it('the three menu surfaces that list Screen 19 give the identical answer for every kind', () => {
    for (const kind of ['care_institution', 'pharmacy_department_authority', null] as const) {
      setActor('institution_admin', kind);
      const answers = MENU_SURFACES.map(surface => offers(surface).procurement);
      const expected = kind === 'care_institution';
      expect(answers, String(kind)).toEqual([expected, expected, expected]);
    }
  });

  it('every projectNavigation call on all four surfaces forwards the active organization kind', async () => {
    // The bottom bar and the secondary lists hold no Screen 19 today, so no
    // rendered answer can tell whether they forward the kind. Pin the actor
    // shape instead, so a future organization-scoped entry cannot be added to
    // any surface that quietly projects without it.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const files = ['PhoenixSidebar.tsx', 'PhoenixMobileDrawer.tsx', 'PhoenixMobileBottomNav.tsx', 'CommandPalette.tsx'];
    const expectedCalls: Record<string, number> = {
      'PhoenixSidebar.tsx': 2, 'PhoenixMobileDrawer.tsx': 2, 'PhoenixMobileBottomNav.tsx': 1, 'CommandPalette.tsx': 1,
    };
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), 'src/shared/ui', file), 'utf8');
      const calls = [...source.matchAll(/projectNavigation\(\s*\w+,\s*\{([^}]*)\}/g)].map(m => m[1]);
      expect(calls.length, file).toBe(expectedCalls[file]);
      for (const actor of calls) {
        expect(actor, file).toMatch(/\borganizationKind:\s*activeOrganizationKind\b/);
      }
    }
  });

  it('an organization switch re-projects a mounted sidebar, drawer and open palette at once', () => {
    for (const surface of MENU_SURFACES) {
      setActor('institution_admin', 'care_institution');
      const view = renderSurface(surface);
      expect(has(PROCUREMENT()), `${surface} care`).toBe(true);

      // care -> PDA: the in-flight render (pending, kind null) already hides it.
      setActor('institution_admin', null, [], true);
      view.rerender(element(surface));
      expect(has(PROCUREMENT()), `${surface} pending`).toBe(false);

      setActor('institution_admin', 'pharmacy_department_authority');
      view.rerender(element(surface));
      expect(has(PROCUREMENT()), `${surface} pda`).toBe(false);
      expect(has(REPORTS()), `${surface} reports kept`).toBe(true);

      // ...and a later care organization brings it back.
      setActor('institution_admin', 'care_institution');
      view.rerender(element(surface));
      expect(has(PROCUREMENT()), `${surface} care again`).toBe(true);
      view.unmount();
    }
  });

  it('clicking the care entry navigates to exactly Screen 19', () => {
    setActor('institution_admin', 'care_institution');
    for (const surface of MENU_SURFACES) {
      const onNavigate = vi.fn();
      const view = renderSurface(surface, onNavigate);
      fireEvent.click(screen.getByRole('button', { name: PROCUREMENT() }));
      expect(onNavigate, surface).toHaveBeenCalledWith(19);
      view.unmount();
    }
  });
});
