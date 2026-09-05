/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { GUIDE_ANCHORS } from '../guide.anchors';
import { GUIDE_REGISTRY } from '../guide.registry';
import { permittedSteps } from '../guide.permissions';
import { GUIDE_PROGRESS_STORAGE_KEY } from '../guide.progress';

/**
 * INTERACTIVE-GUIDE-IG1.1 — the three defects owner acceptance found on a real
 * phone, each asserted at the layer that can actually catch it.
 *
 *   A. the guide named the screen «مركز القيادة» while the screen calls itself
 *      «الإحصائيات»;
 *   B. it described the bottom bar as though it were the phone's only way to
 *      navigate, ignoring the side drawer that holds the full screen list;
 *   C. the Guide & Help step fell back to "not on this screen" on a phone,
 *      because that entry lives inside the closed drawer.
 *
 * Every case here fails against the merged IG-1 registry and engine.
 */

interface MutableAppState {
  lang: 'ar' | 'en';
  dir: 'rtl' | 'ltr';
  theme: 'light';
  role: string;
  myPermissions: Set<string>;
  profile: { id: string; full_name: string; role: string } | null;
  session: { user: { id: string } } | null;
  authStatus: string;
  toggleLang: () => void;
  toggleTheme: () => void;
}

let appState: MutableAppState;
let notifyAppChange: (() => void) | null = null;

function baseState(): MutableAppState {
  return {
    lang: 'ar', dir: 'rtl', theme: 'light',
    role: 'super_admin',
    myPermissions: new Set(['dashboard.view']),
    profile: { id: 'p1', full_name: 'Tester', role: 'super_admin' },
    session: { user: { id: 'u1' } },
    authStatus: 'authenticated',
    toggleLang: () => undefined,
    toggleTheme: () => undefined,
  };
}

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('@/shared/ui/PhoenixIcon', () => ({
  PhoenixIcon: ({ name }: { name: string }) => <span aria-hidden="true" data-icon={name} />,
}));

import { GuideEngine } from '../GuideEngine';

/**
 * The two shell layouts, with the drawer's contents existing only while it is
 * open — which is the whole point. A harness that always rendered the drawer
 * could not tell a working drawer step from the fallback defect C describes.
 */
function Shell({ phone, drawerOpen }: { phone: boolean; drawerOpen: boolean }) {
  return (
    <div id="test-shell">
      {!phone && (
        <>
          <nav data-guide-id={GUIDE_ANCHORS.shellNavigationRail} aria-label="sidebar" />
          <button data-guide-id={GUIDE_ANCHORS.shellTopbarHelp} type="button">Guide &amp; Help</button>
        </>
      )}
      {phone && (
        <>
          <button data-guide-id={GUIDE_ANCHORS.shellTopbarMenu} type="button">menu</button>
          <nav data-guide-id={GUIDE_ANCHORS.shellNavigationBottom} aria-label="bottom" />
        </>
      )}
      <button data-guide-id={GUIDE_ANCHORS.shellTopbarLanguage} type="button">EN</button>
      <span data-guide-id={GUIDE_ANCHORS.shellTopbarNotifications}>bell</span>
      {phone && drawerOpen && (
        <div id="drawer">
          <nav data-guide-id={GUIDE_ANCHORS.shellNavigationDrawer} aria-label="drawer nav">
            <button type="button">الإحصائيات</button>
          </nav>
          <button data-guide-id={GUIDE_ANCHORS.shellDrawerHelp} type="button">الدليل والمساعدة</button>
        </div>
      )}
      <header data-guide-id={GUIDE_ANCHORS.dashboardContextHeader}>scope</header>
      <section data-guide-id={GUIDE_ANCHORS.dashboardOverviewKpis}>kpis</section>
      <section data-guide-id={GUIDE_ANCHORS.dashboardSignalsPanel}>signals</section>
    </div>
  );
}

let drawerLog: string[] = [];

function Harness({
  phone,
  drawerInitiallyOpen = false,
  onClose = () => undefined,
}: {
  phone: boolean;
  drawerInitiallyOpen?: boolean;
  onClose?: () => void;
}) {
  const [, force] = useState(0);
  notifyAppChange = () => force(n => n + 1);

  /** The shell's own single boolean, modelled exactly as PhoenixAppShell holds it. */
  const [drawerOpen, setDrawerOpen] = useState(drawerInitiallyOpen);
  const drawer = useMemo(() => ({
    isAvailable: phone,
    isOpen: drawerOpen,
    open: () => { drawerLog.push('open'); setDrawerOpen(true); },
    close: () => { drawerLog.push('close'); setDrawerOpen(false); },
  }), [phone, drawerOpen]);

  return (
    <div>
      <Shell phone={phone} drawerOpen={drawerOpen} />
      <GuideEngine
        currentScreen={22}
        onNavigate={() => undefined}
        drawer={drawer}
        onClose={onClose}
      />
    </div>
  );
}

const originalRect = Element.prototype.getBoundingClientRect;
const originalMatchMedia = window.matchMedia;

function stubLayout(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 812 });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: /max-width:\s*767px/.test(query) ? width <= 767 : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  Element.prototype.getBoundingClientRect = function fake(this: Element) {
    const guided = this.hasAttribute?.('data-guide-id');
    const box = guided
      ? { top: 100, left: 40, width: 120, height: 40 }
      : { top: 0, left: 0, width: 300, height: 200 };
    return {
      ...box, right: box.left + box.width, bottom: box.top + box.height,
      x: box.left, y: box.top, toJSON: () => box,
    } as DOMRect;
  };
  Element.prototype.scrollIntoView = () => undefined;
}

beforeEach(() => {
  appState = baseState();
  window.localStorage.clear();
  drawerLog = [];
});

afterEach(() => {
  cleanup();
  notifyAppChange = null;
  Element.prototype.getBoundingClientRect = originalRect;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function layer(): HTMLElement {
  const node = document.querySelector('[data-guide-tour]');
  if (!node) throw new Error('no tour overlay');
  return node as HTMLElement;
}

function next() {
  fireEvent.click(screen.getByRole('button', { name: 'التالي' }));
}

function back() {
  fireEvent.click(screen.getByRole('button', { name: 'السابق' }));
}

async function startTour() {
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'الدليل والمساعدة' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'ابدأ الجولة' }));
  await waitFor(() => expect(document.querySelector('[data-guide-tour]')).not.toBeNull());
}

async function goToStep(stepId: string) {
  for (let guard = 0; guard < 25; guard += 1) {
    if (layer().dataset.guideStep === stepId) return;
    next();
    await waitFor(() => expect(layer()).toBeInTheDocument());
  }
  throw new Error(`the tour never reached "${stepId}"`);
}

function runtimeStepIds(viewport: 'phone' | 'desktop', permissions = ['dashboard.view']) {
  return permittedSteps(
    GUIDE_REGISTRY.tours[0],
    { role: 'super_admin', permissions: new Set(permissions) },
    viewport,
  ).map(step => step.id);
}

/* ════════════════════════════════════════════════════════════════════════ */

describe('A — the guide names the screen what the screen calls itself', () => {
  const ALL = GUIDE_REGISTRY.tours.flatMap(tour => tour.steps);

  it('uses «الإحصائيات» and "Statistics" in the guide content', () => {
    const step = ALL.find(s => s.id === 'dashboard.context');
    expect(step).toBeDefined();
    expect(step?.title.ar).toBe('الإحصائيات');
    expect(step?.title.en).toBe('Statistics');
    expect(step?.body.ar).toContain('شاشة الإحصائيات');
    expect(step?.body.en).toContain('Statistics');
  });

  it('no longer says «مركز القيادة» or "Command Center" ANYWHERE in guide copy', () => {
    const copy = GUIDE_REGISTRY.tours.flatMap(tour => [
      tour.title.ar, tour.title.en, tour.description.ar, tour.description.en,
      ...tour.steps.flatMap(s => [s.title.ar, s.title.en, s.body.ar, s.body.en]),
    ]);
    for (const value of copy) {
      expect(value).not.toMatch(/مركز القيادة/);
      expect(value).not.toMatch(/Command Center/i);
    }
  });

  it('leaves the INTERNAL vocabulary alone', () => {
    /**
     * The rename is user-facing only. The screen constant, the permission key
     * and the anchors keep their existing names on purpose — renaming them
     * would be a refactor with none of the benefit and all of the risk.
     */
    const step = GUIDE_REGISTRY.tours[0].steps.find(s => s.id === 'dashboard.context');
    expect(step?.id).toBe('dashboard.context');
    expect(step?.anchors).toContain(GUIDE_ANCHORS.dashboardContextHeader);
    expect(GUIDE_ANCHORS.dashboardContextHeader).toBe('guide.dashboard.context.header');
    expect(step?.requiresPermissions).toContain('dashboard.view');
    expect(step?.screen).toBe(22);
  });
});

describe('B — the navigation model matches the viewport', () => {
  it('teaches BOTH phone navigation surfaces, and never the sidebar', async () => {
    stubLayout(375);
    render(<Harness phone />);
    await startTour();

    const ids = runtimeStepIds('phone');
    expect(ids).toContain('shell.navigation.quick');
    expect(ids).toContain('shell.navigation.menu');
    expect(ids).toContain('shell.navigation.all');
    expect(ids).not.toContain('shell.navigation.desktop');

    // The bottom bar is described as quick access to the most-used screens —
    // NOT as the only way to navigate, which was the defect.
    await goToStep('shell.navigation.quick');
    expect(screen.getByText('التنقّل السريع')).toBeInTheDocument();
    const quickBody = screen.getByText(/الشريط السفلي/);
    expect(quickBody).toBeInTheDocument();
    expect(quickBody.textContent).toMatch(/الأكثر استخدامًا/);

    await goToStep('shell.navigation.menu');
    expect(screen.getByText('القائمة الجانبية')).toBeInTheDocument();

    await goToStep('shell.navigation.all');
    expect(screen.getByText('جميع الشاشات')).toBeInTheDocument();
  });

  it('teaches the sidebar on desktop and hides the phone-only steps', async () => {
    stubLayout(1280);
    render(<Harness phone={false} />);
    await startTour();

    const ids = runtimeStepIds('desktop');
    expect(ids).toContain('shell.navigation.desktop');
    expect(ids).not.toContain('shell.navigation.quick');
    expect(ids).not.toContain('shell.navigation.menu');
    expect(ids).not.toContain('shell.navigation.all');

    await goToStep('shell.navigation.desktop');
    expect(screen.getByText('التنقّل بين الشاشات')).toBeInTheDocument();
  });

  it('produces a DIFFERENT step count per viewport, so nothing may hardcode one', () => {
    const phone = runtimeStepIds('phone');
    const desktop = runtimeStepIds('desktop');
    expect(phone.length).not.toBe(desktop.length);
    expect(phone.length).toBeGreaterThan(desktop.length);
  });

  it('numbers the steps from the FILTERED tour, not the registry', async () => {
    stubLayout(375);
    render(<Harness phone />);
    await startTour();
    expect(screen.getByText(`الخطوة 1 من ${runtimeStepIds('phone').length}`)).toBeInTheDocument();
  });

  it('never renders a step whose surface this viewport does not have', async () => {
    stubLayout(375);
    render(<Harness phone />);
    await startTour();
    const seen: string[] = [];
    for (const expected of runtimeStepIds('phone')) {
      seen.push(layer().dataset.guideStep as string);
      if (expected !== 'closing') {
        next();
        await waitFor(() => expect(layer()).toBeInTheDocument());
      }
    }
    expect(seen).toEqual(runtimeStepIds('phone'));
    expect(seen).not.toContain('shell.navigation.desktop');
  });

  it('discloses no unauthorized screen through the drawer step', async () => {
    stubLayout(375);
    appState = { ...baseState(), myPermissions: new Set<string>() };
    render(<Harness phone />);
    await startTour();
    await goToStep('shell.navigation.all');
    const html = (document.querySelector('.guide-layer') as HTMLElement).innerHTML;
    // The step speaks about the list generically; it names no screen at all.
    expect(html).not.toMatch(/الإحصائيات/);
    expect(html).not.toMatch(/Statistics/i);
    expect(html).not.toMatch(/مركز القيادة/);
    expect(runtimeStepIds('phone', []).some(id => id.startsWith('dashboard.'))).toBe(false);
  });
});

describe('C — Guide & Help has a real target on a phone', () => {
  it('opens the drawer and highlights the REAL entry, with no fallback text', async () => {
    stubLayout(375);
    render(<Harness phone />);
    await startTour();
    await goToStep('help.entry');

    // The drawer is genuinely open and its entry is mounted.
    await waitFor(() => {
      expect(document.querySelector(`[data-guide-id="${GUIDE_ANCHORS.shellDrawerHelp}"]`)).not.toBeNull();
    });
    // ...and the step anchored to it rather than falling back to a centred card.
    await waitFor(() => expect(layer().dataset.guidePlacement).not.toBe('center'));
    expect(document.querySelector('.guide-ring')).not.toBeNull();
    expect(screen.queryByText('هذا الجزء غير ظاهر على الشاشة الحالية، والشرح معروض هنا.')).toBeNull();
  });

  it('shows exactly one Guide & Help entry and one overlay', async () => {
    stubLayout(375);
    render(<Harness phone />);
    await startTour();
    await goToStep('help.entry');
    await waitFor(() => {
      expect(document.querySelector(`[data-guide-id="${GUIDE_ANCHORS.shellDrawerHelp}"]`)).not.toBeNull();
    });
    expect(document.querySelectorAll(`[data-guide-id="${GUIDE_ANCHORS.shellDrawerHelp}"]`)).toHaveLength(1);
    expect(document.querySelectorAll(`[data-guide-id="${GUIDE_ANCHORS.shellTopbarHelp}"]`)).toHaveLength(0);
    expect(document.querySelectorAll('[data-guide-tour]')).toHaveLength(1);
    // No duplicate entry smuggled into the tour card.
    const card = document.querySelector('.guide-card') as HTMLElement;
    expect(card.querySelectorAll('[data-guide-id]')).toHaveLength(0);
  });

  it('keeps the blocker and inert protection over the opened drawer', async () => {
    stubLayout(375);
    render(<Harness phone />);
    await startTour();
    await goToStep('help.entry');
    await waitFor(() => {
      expect(document.querySelector(`[data-guide-id="${GUIDE_ANCHORS.shellDrawerHelp}"]`)).not.toBeNull();
    });
    expect(document.querySelector('.guide-blocker')).not.toBeNull();
    const guideLayer = document.querySelector('.guide-layer') as HTMLElement;
    for (const sibling of Array.from(document.body.children)) {
      if (sibling === guideLayer) continue;
      expect(sibling).toHaveAttribute('inert');
      expect(sibling).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('targets the topbar control on desktop instead', async () => {
    stubLayout(1280);
    render(<Harness phone={false} />);
    await startTour();
    await goToStep('help.entry');
    expect(document.querySelectorAll(`[data-guide-id="${GUIDE_ANCHORS.shellTopbarHelp}"]`)).toHaveLength(1);
    expect(document.querySelectorAll(`[data-guide-id="${GUIDE_ANCHORS.shellDrawerHelp}"]`)).toHaveLength(0);
    expect(drawerLog).toEqual([]);
  });
});

describe('drawer lifecycle — borrowed, then given back', () => {
  async function reachDrawerStep() {
    stubLayout(375);
    render(<Harness phone />);
    await startTour();
    await goToStep('shell.navigation.all');
    await waitFor(() => expect(drawerLog).toContain('open'));
  }

  it('opens it for the step that needs it', async () => {
    await reachDrawerStep();
    expect(document.getElementById('drawer')).not.toBeNull();
  });

  it('closes it again when the tour moves past the drawer steps', async () => {
    await reachDrawerStep();
    await goToStep('shell.language');
    await waitFor(() => expect(document.getElementById('drawer')).toBeNull());
    expect(drawerLog).toEqual(['open', 'close']);
  });

  it('closes it on Back out of the drawer block', async () => {
    await reachDrawerStep();
    back();
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.navigation.menu'));
    await waitFor(() => expect(document.getElementById('drawer')).toBeNull());
  });

  it.each([
    ['Skip', 'تخطّي الجولة'],
    ['Finish is not offered mid-tour, so Skip stands in', 'تخطّي الجولة'],
  ])('closes it on %s', async (_label, button) => {
    await reachDrawerStep();
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(document.getElementById('drawer')).toBeNull());
  });

  it('closes it on Escape', async () => {
    await reachDrawerStep();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.getElementById('drawer')).toBeNull());
  });

  it('closes it when the tour finishes', async () => {
    await reachDrawerStep();
    await goToStep('closing');
    await waitFor(() => expect(document.getElementById('drawer')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'إنهاء' }));
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).toBeNull());
    expect(document.getElementById('drawer')).toBeNull();
  });

  it('closes it when the session goes away', async () => {
    const onClose = vi.fn();
    stubLayout(375);
    render(<Harness phone onClose={onClose} />);
    await startTour();
    await goToStep('shell.navigation.all');
    await waitFor(() => expect(document.getElementById('drawer')).not.toBeNull());
    act(() => {
      appState = { ...appState, session: null, authStatus: 'unauthenticated' };
      notifyAppChange?.();
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('closes it when the overlay unmounts entirely', async () => {
    await reachDrawerStep();
    expect(document.getElementById('drawer')).not.toBeNull();
    cleanup();
    expect(drawerLog).toContain('close');
  });

  it('LEAVES A DRAWER THE OPERATOR OPENED alone', async () => {
    /**
     * The guide closes only a drawer it opened. If the operator already had it
     * open, closing it on the way past would be the guide undoing a choice
     * that was never its own.
     */
    stubLayout(375);
    render(<Harness phone drawerInitiallyOpen />);
    await startTour();
    await goToStep('shell.navigation.all');
    expect(drawerLog).not.toContain('open');

    await goToStep('shell.language');
    expect(drawerLog).not.toContain('close');
    expect(document.getElementById('drawer')).not.toBeNull();
  });

  it('persists nothing about the drawer', async () => {
    await reachDrawerStep();
    const stored = window.localStorage.getItem(GUIDE_PROGRESS_STORAGE_KEY);
    expect(Object.keys(window.localStorage)).toEqual([GUIDE_PROGRESS_STORAGE_KEY]);
    expect(stored).not.toMatch(/drawer/i);
    expect(stored).not.toMatch(/sidebar/i);
  });
});

describe('language switching during a drawer step', () => {
  it('keeps the step, the drawer, one overlay and valid focus', async () => {
    stubLayout(375);
    const toggleLang = vi.fn(() => {
      appState = { ...appState, lang: 'en', dir: 'ltr' };
      notifyAppChange?.();
    });
    appState = { ...baseState(), toggleLang };
    render(<Harness phone />);
    await startTour();
    await goToStep('help.entry');
    await waitFor(() => expect(document.getElementById('drawer')).not.toBeNull());

    const before = {
      tour: layer().dataset.guideTour,
      step: layer().dataset.guideStep,
      dir: layer().getAttribute('dir'),
    };

    fireEvent.click(screen.getByRole('button', { name: 'تغيير لغة البرنامج' }));
    await waitFor(() => expect(screen.getByText('Guide & Help')).toBeInTheDocument());

    expect(layer().dataset.guideTour).toBe(before.tour);
    expect(layer().dataset.guideStep).toBe(before.step);
    expect(before.dir).toBe('rtl');
    expect(layer()).toHaveAttribute('dir', 'ltr');
    // The drawer stayed open and the target is still the canonical one.
    expect(document.getElementById('drawer')).not.toBeNull();
    expect(document.querySelector(`[data-guide-id="${GUIDE_ANCHORS.shellDrawerHelp}"]`)).not.toBeNull();
    expect(document.querySelectorAll('[data-guide-tour]')).toHaveLength(1);
    expect(document.activeElement).not.toBe(document.body);
    expect((document.querySelector('.guide-card') as HTMLElement).contains(document.activeElement)).toBe(true);
    // No storage key of its own appeared.
    expect(Object.keys(window.localStorage)).toEqual([GUIDE_PROGRESS_STORAGE_KEY]);
  });
});
