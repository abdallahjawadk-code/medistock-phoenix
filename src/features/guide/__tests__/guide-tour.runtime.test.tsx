/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { GUIDE_ANCHORS } from '../guide.anchors';
import { GUIDE_PROGRESS_STORAGE_KEY } from '../guide.progress';

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

/** A stand-in shell carrying the real anchor attributes the registry targets. */
function Shell({ withDashboard }: { withDashboard: boolean }) {
  return (
    <div id="test-shell">
      <nav data-guide-id={GUIDE_ANCHORS.shellNavigationRail} aria-label="nav">
        <button type="button">Institutions</button>
      </nav>
      <button data-guide-id={GUIDE_ANCHORS.shellTopbarLanguage} type="button">EN</button>
      <span data-guide-id={GUIDE_ANCHORS.shellTopbarNotifications}>bell</span>
      <button data-guide-id={GUIDE_ANCHORS.shellTopbarHelp} type="button">help</button>
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

function Harness({
  withDashboard = true,
  onNavigate = () => undefined,
  onClose = () => undefined,
  currentScreen = 22,
}: {
  withDashboard?: boolean;
  onNavigate?: (screen: number) => void;
  onClose?: () => void;
  currentScreen?: number;
}) {
  const [, force] = useState(0);
  notifyAppChange = () => force(n => n + 1);
  return (
    <div>
      <Shell withDashboard={withDashboard} />
      <GuideEngine currentScreen={currentScreen} onNavigate={onNavigate} onClose={onClose} />
    </div>
  );
}

/**
 * jsdom gives every element a zero-sized box, which `isUsableTarget` correctly
 * rejects. Give the anchors a real rectangle so placement runs the same code
 * path a browser does; the card keeps a plausible size of its own.
 */
function stubLayout() {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
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

describe('tour lifecycle', () => {
  it('starts at the first step and advances and retreats', async () => {
    render(<Harness />);
    await startTour();
    expect(layer().dataset.guideStep).toBe('welcome');

    next();
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.navigation'));

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
    for (let i = 0; i < 8; i += 1) {
      next();
      await waitFor(() => expect(layer()).toBeInTheDocument());
    }
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
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.navigation'));
    fireEvent.click(screen.getByRole('button', { name: 'تخطّي الجولة' }));
    await openHelpCenter();
    const stored = JSON.parse(window.localStorage.getItem(GUIDE_PROGRESS_STORAGE_KEY) as string);
    expect(stored.stepId).toBe('shell.navigation');
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
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.navigation'));
    expect(document.querySelector('.guide-ring')).not.toBeNull();
    expect(layer().dataset.guidePlacement).not.toBe('center');
  });

  it('falls back to a centred card when the target is not on this screen', async () => {
    render(<Harness withDashboard={false} />);
    await startTour();
    for (let i = 0; i < 4; i += 1) {
      next();
      await waitFor(() => expect(layer()).toBeInTheDocument());
    }
    expect(layer().dataset.guideStep).toBe('dashboard.context');
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
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.navigation'));
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
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.navigation'));
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
    next();
    next();
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.language'));
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
    expect(screen.getByText('الخطوة 1 من 9')).toBeInTheDocument();
    act(() => {
      appState = { ...appState, lang: 'en', dir: 'ltr' };
      notifyAppChange?.();
    });
    await waitFor(() => expect(screen.getByText('Step 1 of 9')).toBeInTheDocument());
  });

  it('offers no language control of its own', async () => {
    render(<Harness />);
    await startTour();
    const card = document.querySelector('.guide-card') as HTMLElement;
    for (const label of ['EN', 'عربي', 'English', 'العربية']) {
      expect(within(card).queryByRole('button', { name: label })).toBeNull();
    }
    expect(card.querySelector('select')).toBeNull();
  });
});

describe('permission-aware steps', () => {
  it('hides the Command Center steps from an actor without dashboard.view', async () => {
    appState = { ...baseState(), myPermissions: new Set<string>() };
    render(<Harness />);
    await startTour();
    expect(screen.getByText('الخطوة 1 من 6')).toBeInTheDocument();

    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      seen.push(layer().dataset.guideStep as string);
      next();
      await waitFor(() => expect(layer()).toBeInTheDocument());
    }
    seen.push(layer().dataset.guideStep as string);
    expect(seen.some(id => id.startsWith('dashboard.'))).toBe(false);
    expect(seen).toContain('shell.navigation');
  });

  it('never renders the name of a step it refused', async () => {
    appState = { ...baseState(), myPermissions: new Set<string>() };
    render(<Harness />);
    await startTour();
    for (let i = 0; i < 5; i += 1) {
      const html = document.querySelector('.guide-layer')?.innerHTML ?? '';
      expect(html).not.toMatch(/مركز القيادة/);
      expect(html).not.toMatch(/Command Center/i);
      next();
      await waitFor(() => expect(layer()).toBeInTheDocument());
    }
  });
});

describe('safety', () => {
  it('covers the whole viewport with a blocking layer while a step is shown', async () => {
    render(<Harness />);
    await startTour();
    next();
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.navigation'));
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
    for (let i = 0; i < 4; i += 1) {
      next();
      await waitFor(() => expect(layer()).toBeInTheDocument());
    }
    expect(layer().dataset.guideStep).toBe('dashboard.context');
    expect(onNavigate).toHaveBeenCalledWith(22);
    // Every call is the Command Center and nothing else.
    expect(onNavigate.mock.calls.every(([screen]) => screen === 22)).toBe(true);
  });

  it('never navigates for an actor the canonical decision refuses', async () => {
    appState = { ...baseState(), myPermissions: new Set<string>() };
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} currentScreen={21} />);
    await startTour();
    for (let i = 0; i < 5; i += 1) {
      next();
      await waitFor(() => expect(layer()).toBeInTheDocument());
    }
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
    expect(status).toHaveTextContent('الخطوة 1 من 9 — مرحبًا بك في الدليل');
    next();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('الخطوة 2 من 9'));
  });

  it('can be completed with the keyboard alone', async () => {
    render(<Harness />);
    await startTour();
    // Focus lands inside the card on every step, so Enter on the primary
    // control is enough to walk the whole tour.
    for (let i = 0; i < 8; i += 1) {
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
    await waitFor(() => expect(layer().dataset.guideStep).toBe('shell.navigation'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await openHelpCenter();
    const stored = JSON.parse(window.localStorage.getItem(GUIDE_PROGRESS_STORAGE_KEY) as string);
    expect(stored.completedTourIds).toEqual([]);
    expect(stored.stepId).toBe('shell.navigation');
  });
});
