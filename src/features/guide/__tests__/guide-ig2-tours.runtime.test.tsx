/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { GUIDE_ANCHORS } from '../guide.anchors';
import { GUIDE_REGISTRY, GUIDE_CAPABILITIES } from '../guide.registry';
import { COMMAND_CENTER_SCREEN, DASHBOARD_VIEW_PERMISSION } from '@/shared/authz/screen-access';
import { permittedTours } from '../guide.permissions';
import { GUIDE_PROGRESS_STORAGE_KEY } from '../guide.progress';
import {
  GuideSurfaceProvider,
  useGuideCapabilities,
  useGuidePresence,
  useGuideSurface,
  type GuideCapabilityState,
} from '../guide.surface';

/**
 * INTERACTIVE-GUIDE-IG2 — the ENGINE's contract for the two contextual tours.
 *
 * SCOPE, STATED SO IT CANNOT BE MISREAD. The surface below is a stand-in that
 * renders the anchors and publishes capabilities directly. That makes it the
 * right instrument for the ENGINE's rules — eligibility, absence, filtering,
 * invalidation, progress, language — because each can be driven to an exact
 * state and back.
 *
 * It proves NOTHING about the real panels. Whether QuarantinePanel and
 * MaterialDispensingSuspensionPanel actually place those anchors, in every
 * state they can be in, and whether a whole tour walks over them without
 * touching an operational path, is proven against the real components in
 * `guide-ig2-panels.runtime.test.tsx`, and the scoped-answer attribution in
 * `guide-ig2-scope-attribution.runtime.test.tsx`. Neither claim is made here.
 */

const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
const from = vi.fn(() => ({ select: vi.fn(() => Promise.resolve({ data: [], error: null })) }));
vi.mock('@/shared/supabase/client', () => ({
  supabase: { rpc, from, auth: { signOut: vi.fn() } },
  supabaseConfigured: true,
  __installQaSupabaseClient: () => undefined,
}));

let appState = {
  lang: 'ar' as 'ar' | 'en',
  dir: 'rtl' as 'rtl' | 'ltr',
  theme: 'light' as const,
  role: 'central_warehouse_manager',
  myPermissions: new Set<string>(),
  profile: { id: 'p1', full_name: 'T', role: 'central_warehouse_manager' } as { id: string; full_name: string; role: string } | null,
  session: { user: { id: 'u1' } } as { user: { id: string } } | null,
  authStatus: 'authenticated',
  toggleLang: () => undefined,
  toggleTheme: () => undefined,
};
let notify: (() => void) | null = null;

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('@/shared/ui/PhoenixIcon', () => ({
  PhoenixIcon: ({ name }: { name: string }) => <span aria-hidden="true" data-icon={name} />,
}));

import { GuideEngine } from '../GuideEngine';

const INERT_DRAWER = { isAvailable: false, isOpen: false, open: () => undefined, close: () => undefined };

/** The two IG-2 surfaces, with the anchors the registry actually targets. */
function Surface({ screen: screenNumber = 3, tab, caps, state, scopeKey }: {
  screen?: number;
  tab: string | null;
  caps: Record<string, boolean>;
  state: GuideCapabilityState;
  scopeKey: string;
}) {
  useGuideSurface(screenNumber, tab);
  useGuideCapabilities('panel', caps, state, scopeKey);
  // Everything this stand-in renders, it also declares. Presence is a separate
  // axis from permission (see guide.surface.tsx) and the engine reads it as
  // one; a stand-in that placed anchors without declaring them would be
  // testing a state the real panels can never produce.
  useGuidePresence('panel', {
    'inventory.quarantine.region': tab === 'quarantine',
    'inventory.quarantine.row': tab === 'quarantine',
    'inventory.quarantine.rowActions': tab === 'quarantine',
    'inventory.suspension.region': tab === 'suspensions',
    'inventory.suspension.row': tab === 'suspensions',
    'inventory.suspension.rowActions': tab === 'suspensions',
    'inventory.suspension.history': tab === 'suspensions',
    'inventory.suspension.createArea': tab === 'suspensions',
  });
  return (
    <div id="surface">
      <button data-guide-id={GUIDE_ANCHORS.inventoryTabQuarantine} type="button">q-tab</button>
      <button data-guide-id={GUIDE_ANCHORS.inventoryTabSuspensions} type="button">s-tab</button>
      {tab === 'quarantine' && (
        <div data-guide-id={GUIDE_ANCHORS.quarantineList}>
          <div data-guide-id={GUIDE_ANCHORS.quarantineRowIdentity}>identity</div>
          <div data-guide-id={GUIDE_ANCHORS.quarantineRowQuantity}>12</div>
          <span data-guide-id={GUIDE_ANCHORS.quarantineReleaseAction}>
            <button type="button" onClick={() => { openedForms.push('release'); }}>release</button>
          </span>
          <span data-guide-id={GUIDE_ANCHORS.quarantineDestroyAction}>
            <button type="button" onClick={() => { openedForms.push('destroy'); }}>destroy</button>
          </span>
        </div>
      )}
      {tab === 'suspensions' && (
        <div data-guide-id={GUIDE_ANCHORS.suspensionList}>
          <div data-guide-id={GUIDE_ANCHORS.suspensionSuspendAction}>
            <button type="button" onClick={() => { openedForms.push('suspend'); }}>suspend</button>
          </div>
          <span data-guide-id={GUIDE_ANCHORS.suspensionRowBadge}>badge</span>
          <div data-guide-id={GUIDE_ANCHORS.suspensionRowScope}>scope</div>
          <div data-guide-id={GUIDE_ANCHORS.suspensionLiftAction}>
            <button type="button" onClick={() => { openedForms.push('lift'); }}>lift</button>
          </div>
          <details data-guide-id={GUIDE_ANCHORS.suspensionHistory}><summary>history</summary></details>
        </div>
      )}
    </div>
  );
}

let openedForms: string[] = [];

function Harness({
  screen: screenNumber = 3,
  tab = 'quarantine' as string | null,
  caps = {},
  state = 'ready' as GuideCapabilityState,
  scopeKey = 'wh:A',
  onClose = () => undefined,
}) {
  const [, force] = useState(0);
  notify = () => force(n => n + 1);
  const drawer = useMemo(() => INERT_DRAWER, []);
  return (
    <GuideSurfaceProvider>
      <Surface screen={screenNumber} tab={tab} caps={caps} state={state} scopeKey={scopeKey} />
      <GuideEngine currentScreen={3} onNavigate={() => undefined} drawer={drawer} onClose={onClose} />
    </GuideSurfaceProvider>
  );
}

const originalRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  appState = { ...appState, lang: 'ar', dir: 'rtl', myPermissions: new Set<string>() };
  window.localStorage.clear();
  openedForms = [];
  rpc.mockClear();
  from.mockClear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
    }),
  });
  Element.prototype.getBoundingClientRect = function fake(this: Element) {
    const guided = this.hasAttribute?.('data-guide-id');
    const box = guided ? { top: 90, left: 60, width: 140, height: 40 } : { top: 0, left: 0, width: 320, height: 200 };
    return { ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => box } as DOMRect;
  };
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  cleanup();
  notify = null;
  Element.prototype.getBoundingClientRect = originalRect;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const ALL_CAPS = {
  [GUIDE_CAPABILITIES.quarantineView]: true,
  [GUIDE_CAPABILITIES.quarantineDispose]: true,
  [GUIDE_CAPABILITIES.suspensionView]: true,
  [GUIDE_CAPABILITIES.suspensionCreate]: true,
  [GUIDE_CAPABILITIES.suspensionLift]: true,
};

async function openCenter() {
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'الدليل والمساعدة' })).toBeInTheDocument());
}

function tourTitles(): string[] {
  return Array.from(document.querySelectorAll('.guide-tour-card__title')).map(n => n.textContent?.trim() ?? '');
}

async function startTour(title: string) {
  const card = Array.from(document.querySelectorAll('.guide-tour-card'))
    .find(n => n.querySelector('.guide-tour-card__title')?.textContent?.includes(title));
  if (!card) throw new Error(`tour "${title}" is not offered`);
  const buttons = Array.from(card.querySelectorAll('.guide-tour-card__actions button')) as HTMLElement[];
  fireEvent.click(buttons[buttons.length - 1]);
  await waitFor(() => expect(document.querySelector('[data-guide-tour]')).not.toBeNull());
}

function layer(): HTMLElement {
  const n = document.querySelector('[data-guide-tour]');
  if (!n) throw new Error('no overlay');
  return n as HTMLElement;
}

function stepIds(caps: Record<string, boolean>, tab: string, tourId: string): string[] {
  const entry = permittedTours(GUIDE_REGISTRY.tours, {
    role: appState.role,
    permissions: appState.myPermissions,
    capabilities: caps,
    presence: {
      'inventory.quarantine.region': true,
      'inventory.quarantine.row': true,
      'inventory.quarantine.rowActions': true,
      'inventory.suspension.region': true,
      'inventory.suspension.row': true,
      'inventory.suspension.rowActions': true,
      'inventory.suspension.history': true,
      'inventory.suspension.createArea': true,
    },
    surface: { screen: 3, tab },
  }, 'desktop').find(e => e.tour.id === tourId);
  return entry?.steps.map(s => s.id) ?? [];
}

/* ════════════════════════════════════════════════════════════════════════ */

describe('IG-2 — a tour is offered only on its own surface', () => {
  it('offers the quarantine tour on the quarantine tab', async () => {
    render(<Harness tab="quarantine" caps={ALL_CAPS} />);
    await openCenter();
    expect(tourTitles()).toContain('الحجر الصحي');
    expect(tourTitles()).not.toContain('موقوفة الصرف');
  });

  it('offers the suspension tour on the suspensions tab', async () => {
    render(<Harness tab="suspensions" caps={ALL_CAPS} />);
    await openCenter();
    expect(tourTitles()).toContain('موقوفة الصرف');
    expect(tourTitles()).not.toContain('الحجر الصحي');
  });

  it('offers NEITHER on an unrelated tab, and still offers orientation', async () => {
    render(<Harness tab="stock" caps={ALL_CAPS} />);
    await openCenter();
    const titles = tourTitles();
    expect(titles).not.toContain('الحجر الصحي');
    expect(titles).not.toContain('موقوفة الصرف');
    expect(titles.some(t => t.includes('جولة تعريفية'))).toBe(true);
  });
});

describe('IG-2 — eligibility comes from the scoped answers, and hides the TOUR', () => {
  it('does not name the quarantine tour to an operator without the view capability', async () => {
    render(<Harness tab="quarantine" caps={{}} />);
    await openCenter();
    const panel = document.querySelector('.guide-center__panel') as HTMLElement;
    // Absent entirely — not disabled, not titled, not described.
    expect(panel.innerHTML).not.toMatch(/الحجر الصحي/);
    expect(panel.innerHTML).not.toMatch(/quarantine/i);
  });

  it('does not name the suspension tour without its view capability', async () => {
    render(<Harness tab="suspensions" caps={{}} />);
    await openCenter();
    const panel = document.querySelector('.guide-center__panel') as HTMLElement;
    expect(panel.innerHTML).not.toMatch(/موقوفة الصرف/);
    expect(panel.innerHTML).not.toMatch(/suspend/i);
  });

  it('shows a view-only operator the reading steps and NOT the action steps', async () => {
    const viewOnly = { [GUIDE_CAPABILITIES.quarantineView]: true };
    render(<Harness tab="quarantine" caps={viewOnly} />);
    await openCenter();
    await startTour('الحجر الصحي');

    const seen: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      seen.push(layer().dataset.guideStep as string);
      if (layer().dataset.guideStep === 'quarantine.closing') break;
      fireEvent.click(screen.getByRole('button', { name: 'التالي' }));
      await waitFor(() => expect(layer()).toBeInTheDocument());
    }
    expect(seen).toContain('quarantine.list');
    expect(seen).not.toContain('quarantine.release');
    expect(seen).not.toContain('quarantine.destroy');
    expect(seen).toEqual(stepIds(viewOnly, 'quarantine', 'guide.tour.quarantine'));
  });

  it('separates suspension view / create / lift independently', () => {
    const view = { [GUIDE_CAPABILITIES.suspensionView]: true };
    const viewCreate = { ...view, [GUIDE_CAPABILITIES.suspensionCreate]: true };
    const viewLift = { ...view, [GUIDE_CAPABILITIES.suspensionLift]: true };
    const id = 'guide.tour.dispensing-suspension';

    expect(stepIds(view, 'suspensions', id)).not.toContain('suspension.create');
    expect(stepIds(view, 'suspensions', id)).not.toContain('suspension.lift');
    expect(stepIds(viewCreate, 'suspensions', id)).toContain('suspension.create');
    expect(stepIds(viewCreate, 'suspensions', id)).not.toContain('suspension.lift');
    expect(stepIds(viewLift, 'suspensions', id)).toContain('suspension.lift');
    expect(stepIds(viewLift, 'suspensions', id)).not.toContain('suspension.create');
  });

  it('admits NOTHING while the scoped answers are still loading', async () => {
    render(<Harness tab="quarantine" caps={ALL_CAPS} state="loading" />);
    await openCenter();
    const panel = document.querySelector('.guide-center__panel') as HTMLElement;
    expect(panel.innerHTML).not.toMatch(/الحجر الصحي/);
  });

  it('admits NOTHING when a scoped answer failed', async () => {
    render(<Harness tab="quarantine" caps={ALL_CAPS} state="error" />);
    await openCenter();
    const panel = document.querySelector('.guide-center__panel') as HTMLElement;
    expect(panel.innerHTML).not.toMatch(/الحجر الصحي/);
  });
});

describe('IG-2 — a context change never reuses stale eligibility', () => {
  it('closes an open tour when the scope changes, showing nothing from before', async () => {
    const { rerender } = render(<Harness tab="quarantine" caps={ALL_CAPS} scopeKey="wh:A" />);
    await openCenter();
    await startTour('الحجر الصحي');
    expect(layer().dataset.guideTour).toBe('guide.tour.quarantine');

    // A different warehouse: the answers were computed for the previous one.
    rerender(<Harness tab="quarantine" caps={{}} scopeKey="wh:B" />);
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).toBeNull());
    const panel = document.querySelector('.guide-center__panel') as HTMLElement;
    expect(panel.innerHTML).not.toMatch(/الحجر الصحي/);
  });

  it('closes an open tour when the tab changes underneath it', async () => {
    const { rerender } = render(<Harness tab="quarantine" caps={ALL_CAPS} />);
    await openCenter();
    await startTour('الحجر الصحي');
    rerender(<Harness tab="suspensions" caps={ALL_CAPS} />);
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).toBeNull());
    // ...and what is offered now belongs to the new tab only.
    expect(tourTitles()).toContain('موقوفة الصرف');
    expect(tourTitles()).not.toContain('الحجر الصحي');
  });

  it('does NOT cancel the guide’s own legitimate navigation to «الإحصائيات» — PROP SWAP ONLY', async () => {
    /**
     * NARROWER than it looks: `Harness` hard-codes `currentScreen={3}` and
     * `onNavigate={() => undefined}`, so this never drives the engine's own
     * `onNavigate` call or an actual subtree remount — it only checks that
     * swapping `<Surface>`'s `screen`/`tab` PROPS in place does not, on its
     * own, read as a capability change. `NavigationHarness` below is the
     * test that answers the real question: does a REAL screen unmount, of the
     * kind `onNavigate` actually causes, survive?
     */
    appState = { ...appState, myPermissions: new Set([DASHBOARD_VIEW_PERMISSION]) };
    const { rerender } = render(<Harness screen={3} tab="quarantine" caps={ALL_CAPS} />);
    await openCenter();
    await startTour('جولة تعريفية');
    const startedOn = layer().dataset.guideStep;
    expect(startedOn).toBeDefined();

    rerender(<Harness screen={COMMAND_CENTER_SCREEN} tab={null} caps={ALL_CAPS} />);
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).not.toBeNull());
    expect(layer().dataset.guideTour).toBe('guide.tour.orientation');
    expect(layer().dataset.guideStep).toBe(startedOn);
  });

  it('still closes a TAB-scoped tour when its tab changes — PROP SWAP ONLY', async () => {
    const { rerender } = render(<Harness tab="quarantine" caps={ALL_CAPS} />);
    await openCenter();
    await startTour('الحجر الصحي');
    rerender(<Harness screen={COMMAND_CENTER_SCREEN} tab={null} caps={ALL_CAPS} />);
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).toBeNull());
  });

  /**
   * THE REAL PATH: `onNavigate` swaps which SCREEN COMPONENT is mounted —
   * exactly what `AuthenticatedApp`'s own `case <screen>: return <...Screen />`
   * dispatch does — so the Inventory Center's surface-and-capability
   * publisher genuinely UNMOUNTS, the way `InventoryCenterScreen` and
   * `QuarantinePanel` would when the operator is carried to a different
   * screen. `Harness` above cannot exercise this: it hard-codes
   * `currentScreen={3}` and discards `onNavigate` entirely, so a previous
   * version of this suite asserted a PROP swap on the same still-mounted
   * component and called it proof of navigation surviving — it never was.
   *
   * A prior implementation of the engine's own invalidation watched a
   * signal built from every mounted capability publisher's existence; that
   * signal vanishing when Inventory Center unmounts read as "the
   * authorization context changed" and closed the orientation tour on its
   * own last step. Reproduced here with a REAL unmount before it was fixed.
   */
  function StatisticsStandIn() {
    useGuideSurface(COMMAND_CENTER_SCREEN, null);
    return <div id="statistics-screen" />;
  }

  function NavigationHarness({ onClose = () => undefined }: { onClose?: () => void }) {
    const [currentScreen, setCurrentScreen] = useState(3);
    const drawer = useMemo(() => INERT_DRAWER, []);
    return (
      <GuideSurfaceProvider>
        <button type="button" onClick={() => setCurrentScreen(COMMAND_CENTER_SCREEN)}>manual-navigate-away</button>
        {currentScreen === 3
          ? <Surface screen={3} tab="quarantine" caps={ALL_CAPS} state="ready" scopeKey="wh:A" />
          : <StatisticsStandIn />}
        <GuideEngine currentScreen={currentScreen} onNavigate={setCurrentScreen} drawer={drawer} onClose={onClose} />
      </GuideSurfaceProvider>
    );
  }

  it('survives the engine’s OWN real navigation — a genuine screen unmount, not a prop swap', async () => {
    appState = { ...appState, myPermissions: new Set([DASHBOARD_VIEW_PERMISSION]) };
    render(<NavigationHarness />);
    await openCenter();
    await startTour('جولة تعريفية');

    // Walk until the tour's own «الإحصائيات» step fires the engine's REAL
    // onNavigate, actually unmounting the Inventory Center subtree.
    for (let guard = 0; guard < 15; guard += 1) {
      if (document.querySelector('#statistics-screen')) break;
      const primary = document.querySelector('.guide-card .guide-btn--primary') as HTMLElement | null;
      if (!primary) break;
      fireEvent.click(primary);
      await waitFor(() => expect(document.querySelector('[data-guide-tour]')).not.toBeNull());
    }

    expect(document.querySelector('#statistics-screen')).not.toBeNull();
    expect(document.querySelector('#surface')).toBeNull(); // Inventory Center genuinely gone.
    expect(layer().dataset.guideTour).toBe('guide.tour.orientation');
  });

  it('a TAB-scoped tour still closes on a genuine navigate-away unmount (not just a prop swap)', async () => {
    /**
     * The counterpart negative case: the quarantine tour is NOT the
     * orientation tour, and belongs to a tab that a real navigation genuinely
     * destroys. This must still close — the fix narrows WHAT is watched
     * (capabilities the active tour declares, not every mounted publisher),
     * it does not stop watching the active tour's own eligibility. `!
     * activeEntry` (surface no longer matches) is what closes it here, the
     * same mechanism the prop-swap test above already exercises — this
     * confirms it survives a REAL unmount too, not only a prop change.
     */
    render(<NavigationHarness />);
    await openCenter();
    await startTour('الحجر الصحي');
    expect(layer().dataset.guideTour).toBe('guide.tour.quarantine');

    fireEvent.click(screen.getByText('manual-navigate-away'));
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).toBeNull());
    expect(document.querySelector('#surface')).toBeNull();
  });

  it('closes when the session goes away', async () => {
    const onClose = vi.fn();
    render(<Harness tab="quarantine" caps={ALL_CAPS} onClose={onClose} />);
    await openCenter();
    act(() => {
      appState = { ...appState, session: null, authStatus: 'unauthenticated' };
      notify?.();
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('IG-2 — the guide never touches an operational path', () => {
  /**
   * ONE tour, walked end to end. The previous version of this helper was named
   * `walkBothTours` and walked only the quarantine one, so the suspension tour
   * had no walk at all behind a name that claimed otherwise. Each tour now
   * names the tour it walks, and the walks over the REAL panels live in
   * guide-ig2-panels.runtime.test.tsx.
   */
  async function walk(tab: string, title: string, lastStepId: string) {
    render(<Harness tab={tab} caps={ALL_CAPS} />);
    await openCenter();
    await startTour(title);
    for (let i = 0; i < 20; i += 1) {
      if (layer().dataset.guideStep === lastStepId) break;
      fireEvent.click(screen.getByRole('button', { name: 'التالي' }));
      await waitFor(() => expect(layer()).toBeInTheDocument());
    }
    expect(layer().dataset.guideStep).toBe(lastStepId);
    fireEvent.click(screen.getByRole('button', { name: 'إنهاء' }));
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).toBeNull());
  }

  it('opens no business form and calls no RPC across the quarantine tour', async () => {
    await walk('quarantine', 'الحجر الصحي', 'quarantine.closing');
    // The release form auto-selects a destination lot the moment it opens —
    // real business-form state. The guide must never cause that.
    expect(openedForms).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('opens no business form and calls no RPC across the suspension tour', async () => {
    await walk('suspensions', 'موقوفة الصرف', 'suspension.history');
    expect(openedForms).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('anchors on wrappers, never acquiring the operational buttons themselves', async () => {
    render(<Harness tab="quarantine" caps={ALL_CAPS} />);
    await openCenter();
    await startTour('الحجر الصحي');
    for (const anchor of [GUIDE_ANCHORS.quarantineReleaseAction, GUIDE_ANCHORS.quarantineDestroyAction]) {
      const el = document.querySelector(`[data-guide-id="${anchor}"]`) as HTMLElement;
      expect(el).not.toBeNull();
      expect(el.tagName).not.toBe('BUTTON');
    }
  });

  it('stores only tour and step identity, never business content', async () => {
    render(<Harness tab="quarantine" caps={ALL_CAPS} />);
    await openCenter();
    await startTour('الحجر الصحي');
    const raw = window.localStorage.getItem(GUIDE_PROGRESS_STORAGE_KEY) as string;
    expect(Object.keys(JSON.parse(raw)).sort())
      .toEqual(['completedTourIds', 'stepId', 'tourId', 'updatedAt', 'v']);
    for (const forbidden of [/warehouse/i, /organization/i, /material/i, /quantity/i, /reason/i, /outlet/i]) {
      expect(forbidden.test(raw), `progress leaked ${forbidden}`).toBe(false);
    }
    expect(Object.keys(window.localStorage)).toEqual([GUIDE_PROGRESS_STORAGE_KEY]);
  });
});

describe('IG-2 — bilingual copy follows the application language', () => {
  it('renders the quarantine tour in English when the app is English', async () => {
    appState = { ...appState, lang: 'en', dir: 'ltr' };
    render(<Harness tab="quarantine" caps={ALL_CAPS} />);
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Guide & Help' })).toBeInTheDocument());
    expect(tourTitles()).toContain('Quarantine');
    expect(tourTitles()).not.toContain('الحجر الصحي');
  });

  it('renders the suspension tour in English too', async () => {
    appState = { ...appState, lang: 'en', dir: 'ltr' };
    render(<Harness tab="suspensions" caps={ALL_CAPS} />);
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Guide & Help' })).toBeInTheDocument());
    expect(tourTitles()).toContain('Suspended from Dispensing');
  });

  it('numbers steps from the filtered tour, not the registry', async () => {
    const viewOnly = { [GUIDE_CAPABILITIES.quarantineView]: true };
    render(<Harness tab="quarantine" caps={viewOnly} />);
    await openCenter();
    await startTour('الحجر الصحي');
    const total = stepIds(viewOnly, 'quarantine', 'guide.tour.quarantine').length;
    expect(screen.getByText(`الخطوة 1 من ${total}`)).toBeInTheDocument();
    expect(total).toBeLessThan(GUIDE_REGISTRY.tours.find(t => t.id === 'guide.tour.quarantine')!.steps.length);
  });
});
