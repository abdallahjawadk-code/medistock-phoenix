/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { GUIDE_ANCHORS } from '../guide.anchors';
import { GUIDE_PROGRESS_STORAGE_KEY } from '../guide.progress';
import { GUIDE_REGISTRY } from '../guide.registry';
import { permittedSteps } from '../guide.permissions';

/**
 * INTERACTIVE-GUIDE-IG1 — the tour engine's RUNTIME behaviour.
 *
 * Everything here is asserted against a rendered overlay, never against source
 * text: what the operator sees, what they can reach with a keyboard, what
 * happens when a target is not there, and what is written to storage.
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
 * A stand-in shell carrying the real anchor attributes the registry targets.
 *
 * IG-1.1: it now models the two LAYOUTS rather than one, because the guide's
 * navigation steps differ by viewport — the desktop has a sidebar, the phone
 * has a bottom bar plus a drawer, and the drawer's contents (including the
 * phone's Guide & Help entry) exist only while it is open. A harness that
 * always rendered every anchor could not tell a working drawer step from a
 * broken one.
 */
function Shell({
  withDashboard,
  viewport,
  drawerOpen,
}: {
  withDashboard: boolean;
  viewport: 'phone' | 'desktop';
  drawerOpen: boolean;
}) {
  const phone = viewport === 'phone';
  return (
    <div id="test-shell">
      {!phone && (
        <nav data-guide-id={GUIDE_ANCHORS.shellNavigationRail} aria-label="nav">
          <button type="button">Institutions</button>
        </nav>
      )}
      {phone && (
        <>
          <button data-guide-id={GUIDE_ANCHORS.shellTopbarMenu} type="button">menu</button>
          <nav data-guide-id={GUIDE_ANCHORS.shellNavigationBottom} aria-label="bottom">
            <button type="button">Statistics</button>
          </nav>
        </>
      )}
      <button data-guide-id={GUIDE_ANCHORS.shellTopbarLanguage} type="button">EN</button>
      <span data-guide-id={GUIDE_ANCHORS.shellTopbarNotifications}>bell</span>
      {!phone && <button data-guide-id={GUIDE_ANCHORS.shellTopbarHelp} type="button">help</button>}
      {phone && drawerOpen && (
        <div id="test-drawer">
          <nav data-guide-id={GUIDE_ANCHORS.shellNavigationDrawer} aria-label="drawer nav">
            <button type="button">Statistics</button>
          </nav>
          <button data-guide-id={GUIDE_ANCHORS.shellDrawerHelp} type="button">الدليل والمساعدة</button>
        </div>
      )}
      {withDashboard && (
        <>
          <header data-guide-id={GUIDE_ANCHORS.dashboardContextHeader}>scope</header>
          <section data-guide-id={GUIDE_ANCHORS.dashboardOverviewKpis}>kpis</section>
          <section data-guide-id={GUIDE_ANCHORS.dashboardSignalsPanel}>signals</section>
        </>
      )}
    </div>
  );
}

/** Observable drawer transitions, so the lifecycle can be asserted directly. */
let drawerLog: string[] = [];

function Harness({
  withDashboard = true,
  onNavigate = () => undefined,
  onClose = () => undefined,
  currentScreen = 22,
  viewport = 'desktop',
  drawerInitiallyOpen = false,
}: {
  withDashboard?: boolean;
  onNavigate?: (screen: number) => void;
  onClose?: () => void;
  currentScreen?: number;
  viewport?: 'phone' | 'desktop';
  drawerInitiallyOpen?: boolean;
}) {
  const [, force] = useState(0);
  notifyAppChange = () => force(n => n + 1);

  /**
   * The shell's OWN drawer state, modelled exactly as PhoenixAppShell holds
   * it: one boolean, one opener, one closer. The guide is given this and
   * nothing else, so a second drawer state anywhere would show up here as a
   * divergence between what the harness renders and what the guide believes.
   */
  const [drawerOpen, setDrawerOpen] = useState(drawerInitiallyOpen);
  const drawer = useMemo(() => ({
    isAvailable: viewport === 'phone',
    isOpen: drawerOpen,
    open: () => { drawerLog.push('open'); setDrawerOpen(true); },
    close: () => { drawerLog.push('close'); setDrawerOpen(false); },
  }), [viewport, drawerOpen]);

  return (
    <div>
      <Shell withDashboard={withDashboard} viewport={viewport} drawerOpen={drawerOpen} />
      <GuideEngine
        currentScreen={currentScreen}
        onNavigate={onNavigate}
        drawer={drawer}
        onClose={onClose}
      />
    </div>
  );
}

/**
 * jsdom gives every element a zero-sized box, which `isUsableTarget` correctly
 * rejects. Give the anchors a real rectangle so placement runs the same code
 * path a browser does; the card keeps a plausible size of its own.
 */
function stubLayout(width = 1440) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  /**
   * `useIsMobileViewport` — which `useGuideViewport` derives from — asks
   * matchMedia first. jsdom's own implementation does not evaluate width
   * queries, so it is answered here from the width above, following the same
   * approach `responsive-viewport.runtime.test.tsx` already uses.
   */
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
      ? { top: 100, left: 500, width: 120, height: 40 }
      : { top: 0, left: 0, width: 360, height: 220 };
    return { ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => box } as DOMRect;
  };
  Element.prototype.scrollIntoView = () => undefined;
}

const originalRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  appState = baseState();
  window.localStorage.clear();
  drawerLog = [];
  stubLayout();
});

afterEach(() => {
  cleanup();
  notifyAppChange = null;
  Element.prototype.getBoundingClientRect = originalRect;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

async function openHelpCenter() {
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'الدليل والمساعدة' })).toBeInTheDocument());
}

async function startTour() {
  await openHelpCenter();
  fireEvent.click(screen.getByRole('button', { name: 'ابدأ الجولة' }));
  await waitFor(() => expect(document.querySelector('[data-guide-tour]')).not.toBeNull());
}

function layer(): HTMLElement {
  const node = document.querySelector('[data-guide-tour]');
  if (!node) throw new Error('no tour overlay');
  return node as HTMLElement;
}

function next() {
  fireEvent.click(screen.getByRole('button', { name: 'التالي' }));
}

/**
 * IG-1.1 — everything below derives the tour's shape from the REGISTRY as the
 * engine filters it, never from a number written into the test.
 *
 * The step count is now a function of the viewport (the phone teaches two
 * navigation surfaces, the desktop one) and of permissions. A hardcoded
 * "9 steps" was correct exactly once, and would go on passing while the guide
 * silently taught the wrong navigation model — which is the class of defect
 * IG-1.1 exists to fix.
 */
function runtimeStepIds(
  viewport: 'phone' | 'desktop' = 'desktop',
  permissions: string[] = ['dashboard.view'],
  role = 'super_admin',
): string[] {
  return permittedSteps(
    GUIDE_REGISTRY.tours[0],
    { role, permissions: new Set(permissions) },
    viewport,
  ).map(step => step.id);
}

/** Walk forward until `stepId` is current. Immune to registry re-ordering. */
async function goToStep(stepId: string) {
  for (let guard = 0; guard < 25; guard += 1) {
    if (layer().dataset.guideStep === stepId) return;
    next();
    await waitFor(() => expect(layer()).toBeInTheDocument());
  }
  throw new Error(`the tour never reached "${stepId}"`);
}

/** Walk to the final step, whatever the filtered tour's length turns out to be. */
async function goToLastStep() {
  await goToStep('closing');
}

describe('tour lifecycle', () => {
  it('starts at the first step and advances and retreats', async () => {
    render(<Harness />);
    await startTour();
    expect(layer().dataset.guideStep).toBe('welcome');

    next();
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.navigation.desktop'));

    fireEvent.click(screen.getByRole('button', { name: 'السابق' }));
    await waitFor(() => expect(layer().dataset.guideStep).toBe('welcome'));
  });

  it('disables Back on the first step rather than wrapping around', async () => {
    render(<Harness />);
    await startTour();
    expect(screen.getByRole('button', { name: 'السابق' })).toBeDisabled();
  });

  it('offers Finish on the last step and records completion', async () => {
    render(<Harness />);
    await startTour();
    await goToLastStep();
    expect(layer().dataset.guideStep).toBe('closing');
    fireEvent.click(screen.getByRole('button', { name: 'إنهاء' }));
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).toBeNull());
    const stored = JSON.parse(window.localStorage.getItem(GUIDE_PROGRESS_STORAGE_KEY) as string);
    expect(stored.completedTourIds).toContain('guide.tour.orientation');
    expect(stored.tourId).toBeNull();
  });

  it('returns to the Help Center when the tour is skipped, keeping the place', async () => {
    render(<Harness />);
    await startTour();
    next();
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.navigation.desktop'));
    fireEvent.click(screen.getByRole('button', { name: 'تخطّي الجولة' }));
    await openHelpCenter();
    const stored = JSON.parse(window.localStorage.getItem(GUIDE_PROGRESS_STORAGE_KEY) as string);
    expect(stored.stepId).toBe('shell.navigation.desktop');
  });

  it('resumes at the remembered step after a fresh mount', async () => {
    window.localStorage.setItem(GUIDE_PROGRESS_STORAGE_KEY, JSON.stringify({
      v: 1, tourId: 'guide.tour.orientation', stepId: 'shell.language',
      completedTourIds: [], updatedAt: Date.now(),
    }));
    render(<Harness />);
    await openHelpCenter();
    fireEvent.click(screen.getByRole('button', { name: 'استئناف' }));
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.language'));
  });

  it('resets progress from the Help Center and stops offering Resume', async () => {
    window.localStorage.setItem(GUIDE_PROGRESS_STORAGE_KEY, JSON.stringify({
      v: 1, tourId: 'guide.tour.orientation', stepId: 'shell.language',
      completedTourIds: ['guide.tour.orientation'], updatedAt: Date.now(),
    }));
    render(<Harness />);
    await openHelpCenter();
    expect(screen.getByRole('button', { name: 'استئناف' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'مسح تقدّم الدليل' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'استئناف' })).toBeNull());
    expect(window.localStorage.getItem(GUIDE_PROGRESS_STORAGE_KEY)).toBeNull();
    expect(screen.getByText('تم مسح تقدّم الدليل.')).toBeInTheDocument();
  });
});

describe('targets and safe fallback', () => {
  it('draws a highlight ring when the target is present', async () => {
    render(<Harness />);
    await startTour();
    next();
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.navigation.desktop'));
    expect(document.querySelector('.guide-ring')).not.toBeNull();
    expect(layer().dataset.guidePlacement).not.toBe('center');
  });

  it('falls back to a centred card when the target is not on this screen', async () => {
    render(<Harness withDashboard={false} />);
    await startTour();
    await goToStep('dashboard.context');
    expect(layer().dataset.guidePlacement).toBe('center');
    expect(document.querySelector('.guide-ring')).toBeNull();
    // Explains the situation, and names nothing.
    const card = document.querySelector('.guide-card') as HTMLElement;
    expect(within(card).getByText('هذا الجزء غير ظاهر على الشاشة الحالية، والشرح معروض هنا.')).toBeInTheDocument();
    expect(card.innerHTML).not.toContain('guide.dashboard');
    expect(card.innerHTML).not.toContain('data-guide-id');
  });

  it('survives the target being removed after the step has begun', async () => {
    render(<Harness />);
    await startTour();
    next();
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.navigation.desktop'));
    act(() => {
      document.querySelector(`[data-guide-id="${GUIDE_ANCHORS.shellNavigationRail}"]`)?.remove();
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(layer().dataset.guidePlacement).toBe('center'));
    // Still navigable, not stuck.
    expect(screen.getByRole('button', { name: 'التالي' })).toBeEnabled();
  });

  it('repositions on scroll and on resize instead of leaving a stale rectangle', async () => {
    render(<Harness />);
    await startTour();
    next();
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.navigation.desktop'));
    const before = (document.querySelector('.guide-ring') as HTMLElement).style.top;
    Element.prototype.getBoundingClientRect = function fake(this: Element) {
      const guided = this.hasAttribute?.('data-guide-id');
      const box = guided
        ? { top: 400, left: 500, width: 120, height: 40 }
        : { top: 0, left: 0, width: 360, height: 220 };
      return { ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => box } as DOMRect;
    };
    act(() => { document.dispatchEvent(new Event('scroll', { bubbles: false })); });
    await waitFor(() => {
      expect((document.querySelector('.guide-ring') as HTMLElement).style.top).not.toBe(before);
    });
  });
});

describe('language contract', () => {
  it('keeps the same tour and step when the application language changes', async () => {
    render(<Harness />);
    await startTour();
    await goToStep('shell.language');
    expect(screen.getByText('لغة البرنامج')).toBeInTheDocument();

    act(() => {
      appState = { ...appState, lang: 'en', dir: 'ltr' };
      notifyAppChange?.();
    });

    await waitFor(() => expect(screen.getByText('Application language')).toBeInTheDocument());
    // Same tour, same step, one overlay, direction flipped.
    expect(layer().dataset.guideTour).toBe('guide.tour.orientation');
    expect(layer().dataset.guideStep).toBe('shell.language');
    expect(document.querySelectorAll('[data-guide-tour]')).toHaveLength(1);
    expect(layer()).toHaveAttribute('dir', 'ltr');
    expect(screen.queryByText('لغة البرنامج')).toBeNull();
  });

  it('renders the step counter in the current language', async () => {
    render(<Harness />);
    await startTour();
    expect(screen.getByText(`الخطوة 1 من ${runtimeStepIds().length}`)).toBeInTheDocument();
    act(() => {
      appState = { ...appState, lang: 'en', dir: 'ltr' };
      notifyAppChange?.();
    });
    await waitFor(() => expect(screen.getByText(`Step 1 of ${runtimeStepIds().length}`)).toBeInTheDocument());
  });

  /**
   * The guide carries ONE language control, and it is a view over the
   * application's own value rather than a selector of its own. The engine-level
   * behaviour is asserted here; that it mutates the canonical state and
   * persists through the canonical bridge is proven end to end against the real
   * provider in `guide-language-canonical.runtime.test.tsx`.
   */
  it('offers exactly one language control, and it is not a selector', async () => {
    render(<Harness />);
    await startTour();
    const card = document.querySelector('.guide-card') as HTMLElement;
    expect(card.querySelectorAll('[data-guide-language-control]')).toHaveLength(1);
    expect(card.querySelector('select')).toBeNull();
    expect(card.querySelectorAll('input')).toHaveLength(0);
    // It is labelled as the APPLICATION language switch, in the current language.
    expect(within(card).getByRole('button', { name: 'تغيير لغة البرنامج' })).toBeInTheDocument();
  });

  it('sits in the card header, not among the step actions', async () => {
    render(<Harness />);
    await startTour();
    const control = document.querySelector('[data-guide-language-control]') as HTMLElement;
    expect(control.closest('.guide-card__head')).not.toBeNull();
    expect(control.closest('.guide-card__actions')).toBeNull();
  });

  it('calls the canonical AppContext setter and nothing else', async () => {
    const toggleLang = vi.fn(() => {
      appState = {
        ...appState,
        lang: appState.lang === 'ar' ? 'en' : 'ar',
        dir: appState.dir === 'rtl' ? 'ltr' : 'rtl',
      };
      notifyAppChange?.();
    });
    appState = { ...baseState(), toggleLang };
    render(<Harness />);
    await startTour();
    fireEvent.click(screen.getByRole('button', { name: 'تغيير لغة البرنامج' }));
    await waitFor(() => expect(toggleLang).toHaveBeenCalledTimes(1));
    // No storage of its own: the tour's progress key is the only thing written.
    expect(Object.keys(window.localStorage)).toEqual([GUIDE_PROGRESS_STORAGE_KEY]);
  });

  it('keeps the tour open on the identical step, flips direction and reflows', async () => {
    const toggleLang = vi.fn(() => {
      appState = { ...appState, lang: 'en', dir: 'ltr' };
      notifyAppChange?.();
    });
    appState = { ...baseState(), toggleLang };
    render(<Harness />);
    await startTour();
    await goToStep('shell.language');

    const before = {
      tour: layer().dataset.guideTour,
      step: layer().dataset.guideStep,
      dir: layer().getAttribute('dir'),
      title: (document.querySelector('.guide-card__title') as HTMLElement).textContent,
    };
    expect(before.dir).toBe('rtl');

    fireEvent.click(screen.getByRole('button', { name: 'تغيير لغة البرنامج' }));
    await waitFor(() => expect(screen.getByText('Application language')).toBeInTheDocument());

    // Byte-identical tour and step identity.
    expect(layer().dataset.guideTour).toBe(before.tour);
    expect(layer().dataset.guideStep).toBe(before.step);
    // Direction and copy changed.
    expect(layer()).toHaveAttribute('dir', 'ltr');
    expect((document.querySelector('.guide-card__title') as HTMLElement).textContent)
      .not.toBe(before.title);
    const languageIndex = runtimeStepIds().indexOf('shell.language');
    expect(screen.getByText(`Step ${languageIndex + 1} of ${runtimeStepIds().length}`)).toBeInTheDocument();
    // Exactly one overlay, and the placement was recomputed rather than dropped.
    expect(document.querySelectorAll('[data-guide-tour]')).toHaveLength(1);
    expect(document.querySelectorAll('.guide-card')).toHaveLength(1);
    expect(layer().dataset.guidePlacement).toBeDefined();
  });

  it('leaves focus on the control the operator just used', async () => {
    const toggleLang = vi.fn(() => {
      appState = { ...appState, lang: 'en', dir: 'ltr' };
      notifyAppChange?.();
    });
    appState = { ...baseState(), toggleLang };
    render(<Harness />);
    await startTour();
    const control = screen.getByRole('button', { name: 'تغيير لغة البرنامج' });
    control.focus();
    fireEvent.click(control);
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Change application language' }),
    ).toBeInTheDocument());
    // The SAME DOM node survives the re-render, and keeps focus.
    const after = screen.getByRole('button', { name: 'Change application language' });
    expect(after).toBe(control);
    expect(after).toHaveFocus();
    expect((document.querySelector('.guide-card') as HTMLElement)
      .contains(document.activeElement)).toBe(true);
  });

  it('is reachable and operable by keyboard alone', async () => {
    const toggleLang = vi.fn();
    appState = { ...baseState(), toggleLang };
    render(<Harness />);
    await startTour();
    const control = screen.getByRole('button', { name: 'تغيير لغة البرنامج' });

    // A new step opens on the primary action; the control is a tab stop the
    // keyboard can reach without leaving the card.
    expect(document.querySelector('[data-guide-primary]')).toHaveFocus();
    control.focus();
    expect(control).toHaveFocus();

    // A <button> activates on Enter and on Space through the browser's own
    // default behaviour; both are dispatched as the click that behaviour
    // produces. The real key presses are exercised in the browser suite.
    fireEvent.keyDown(control, { key: 'Enter' });
    fireEvent.click(control);
    fireEvent.keyDown(control, { key: ' ' });
    fireEvent.click(control);
    expect(toggleLang).toHaveBeenCalledTimes(2);
  });

  it('is operable by touch', async () => {
    const toggleLang = vi.fn();
    appState = { ...baseState(), toggleLang };
    render(<Harness />);
    await startTour();
    const control = screen.getByRole('button', { name: 'تغيير لغة البرنامج' });
    fireEvent.touchStart(control);
    fireEvent.touchEnd(control);
    fireEvent.click(control);
    expect(toggleLang).toHaveBeenCalledTimes(1);
  });

  it('opens a NEW step on the primary action, not on the language control', async () => {
    render(<Harness />);
    await startTour();
    expect(document.querySelector('[data-guide-primary]')).toHaveFocus();
    next();
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.navigation.desktop'));
    expect(document.querySelector('[data-guide-primary]')).toHaveFocus();
  });

  it('offers the same control on the Help Center surface', async () => {
    render(<Harness />);
    await openHelpCenter();
    const panel = document.querySelector('.guide-center__panel') as HTMLElement;
    expect(panel.querySelectorAll('[data-guide-language-control]')).toHaveLength(1);
    expect(within(panel).getByRole('button', { name: 'تغيير لغة البرنامج' })).toBeInTheDocument();
  });
});

describe('permission-aware steps', () => {
  it('hides the Command Center steps from an actor without dashboard.view', async () => {
    appState = { ...baseState(), myPermissions: new Set<string>() };
    const expected = runtimeStepIds('desktop', []);
    render(<Harness />);
    await startTour();
    expect(screen.getByText(`الخطوة 1 من ${expected.length}`)).toBeInTheDocument();

    const seen: string[] = [];
    for (let i = 0; i < expected.length; i += 1) {
      seen.push(layer().dataset.guideStep as string);
      if (i < expected.length - 1) {
        next();
        await waitFor(() => expect(layer()).toBeInTheDocument());
      }
    }
    expect(seen).toEqual(expected);
    expect(seen.some(id => id.startsWith('dashboard.'))).toBe(false);
    expect(seen).toContain('shell.navigation.desktop');
  });

  it('never renders the name of a step it refused', async () => {
    appState = { ...baseState(), myPermissions: new Set<string>() };
    const expected = runtimeStepIds('desktop', []);
    render(<Harness />);
    await startTour();
    for (let i = 0; i < expected.length; i += 1) {
      const html = document.querySelector('.guide-layer')?.innerHTML ?? '';
      // Neither the internal name nor the user-facing one may appear for an
      // operator the Statistics steps were filtered away from.
      expect(html).not.toMatch(/مركز القيادة/);
      expect(html).not.toMatch(/Command Center/i);
      expect(html).not.toMatch(/الإحصائيات/);
      expect(html).not.toMatch(/Statistics/i);
      if (i < expected.length - 1) {
        next();
        await waitFor(() => expect(layer()).toBeInTheDocument());
      }
    }
  });
});

describe('safety', () => {
  it('covers the whole viewport with a blocking layer while a step is shown', async () => {
    render(<Harness />);
    await startTour();
    next();
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.navigation.desktop'));
    const blocker = document.querySelector('.guide-blocker');
    expect(blocker).not.toBeNull();
    expect(blocker).toHaveAttribute('aria-hidden', 'true');
  });

  it('marks everything behind the guide inert and aria-hidden, then restores it', async () => {
    const shell = document.createElement('div');
    shell.id = 'background-sibling';
    document.body.appendChild(shell);
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await startTour();
    await waitFor(() => expect(shell).toHaveAttribute('inert'));
    expect(shell).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'تخطّي الجولة' }));
    await openHelpCenter();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    cleanup();
    await waitFor(() => expect(shell).not.toHaveAttribute('inert'));
    expect(shell).not.toHaveAttribute('aria-hidden');
    shell.remove();
  });

  it('closes itself when the session goes away', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await openHelpCenter();
    act(() => {
      appState = { ...appState, session: null, authStatus: 'unauthenticated' };
      notifyAppChange?.();
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('navigates only to a screen the operator is already authorized for', async () => {
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} currentScreen={21} />);
    await startTour();
    await goToStep('dashboard.context');
    expect(onNavigate).toHaveBeenCalledWith(22);
    // Every call is the Command Center and nothing else.
    expect(onNavigate.mock.calls.every(([screen]) => screen === 22)).toBe(true);
  });

  it('never navigates for an actor the canonical decision refuses', async () => {
    appState = { ...baseState(), myPermissions: new Set<string>() };
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} currentScreen={21} />);
    await startTour();
    await goToLastStep();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('accessibility', () => {
  it('exposes the step as a labelled, described modal dialog', async () => {
    render(<Harness />);
    await startTour();
    const card = screen.getByRole('dialog', { name: 'مرحبًا بك في الدليل' });
    expect(card).toHaveAttribute('aria-modal', 'true');
    expect(card).toHaveAttribute('aria-describedby');
  });

  it('announces each step politely through a live region', async () => {
    render(<Harness />);
    await startTour();
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent(`الخطوة 1 من ${runtimeStepIds().length} — مرحبًا بك في الدليل`);
    next();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`الخطوة 2 من ${runtimeStepIds().length}`));
  });

  it('can be completed with the keyboard alone', async () => {
    render(<Harness />);
    await startTour();
    // Focus lands inside the card on every step, so Enter on the primary
    // control is enough to walk the whole tour.
    const total = runtimeStepIds().length;
    for (let i = 0; i < total - 1; i += 1) {
      const primary = document.querySelector('.guide-btn--primary') as HTMLElement;
      expect(document.activeElement && (document.querySelector('.guide-card') as HTMLElement).contains(document.activeElement)).toBe(true);
      fireEvent.click(primary);
      await waitFor(() => expect(layer()).toBeInTheDocument());
    }
    expect(layer().dataset.guideStep).toBe('closing');
  });

  it('traps Tab inside the card', async () => {
    render(<Harness />);
    await startTour();
    const card = document.querySelector('.guide-card') as HTMLElement;
    const buttons = Array.from(card.querySelectorAll('button')) as HTMLElement[];
    const enabled = buttons.filter(b => !(b as HTMLButtonElement).disabled);
    enabled[enabled.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(card.contains(document.activeElement)).toBe(true);
  });

  it('leaves the tour on Escape without marking it complete', async () => {
    render(<Harness />);
    await startTour();
    next();
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.navigation.desktop'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await openHelpCenter();
    const stored = JSON.parse(window.localStorage.getItem(GUIDE_PROGRESS_STORAGE_KEY) as string);
    expect(stored.completedTourIds).toEqual([]);
    expect(stored.stepId).toBe('shell.navigation.desktop');
  });
});
