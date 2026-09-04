/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GUIDE_ANCHORS } from '../guide.anchors';

/**
 * INTERACTIVE-GUIDE-IG1 — the RUNTIME half of the safety contract (AD-04).
 *
 * `guide-safety.test.ts` proves the guide's source cannot reach a service.
 * This proves the same thing from the other end: a complete tour is driven
 * from first step to Finish with the Supabase client, `fetch`, `sendBeacon`
 * and `XMLHttpRequest` all instrumented, and none of them is touched.
 *
 * The two together are what the safety review asks for — a static call-path
 * review plus runtime spies — because neither alone is sufficient: a spy only
 * covers the path it walked, and source inspection only covers what it could
 * name.
 */

const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
const from = vi.fn(() => ({
  select: vi.fn(() => Promise.resolve({ data: [], error: null })),
  insert: vi.fn(() => Promise.resolve({ data: null, error: null })),
  update: vi.fn(() => Promise.resolve({ data: null, error: null })),
  delete: vi.fn(() => Promise.resolve({ data: null, error: null })),
}));
const auth = {
  signOut: vi.fn(),
  getSession: vi.fn(() => Promise.resolve({ data: { session: null }, error: null })),
};

vi.mock('@/shared/supabase/client', () => ({
  supabase: { rpc, from, auth },
  supabaseConfigured: true,
  __installQaSupabaseClient: () => undefined,
}));

let appState = {
  lang: 'en' as 'ar' | 'en',
  dir: 'ltr' as 'rtl' | 'ltr',
  theme: 'light' as const,
  role: 'super_admin',
  myPermissions: new Set<string>(['dashboard.view']),
  profile: { id: 'p1', full_name: 'T', role: 'super_admin' },
  session: { user: { id: 'u1' } },
  authStatus: 'authenticated',
  toggleLang: () => undefined,
  toggleTheme: () => undefined,
};

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('@/shared/ui/PhoenixIcon', () => ({
  PhoenixIcon: ({ name }: { name: string }) => <span aria-hidden="true" data-icon={name} />,
}));

import { GuideEngine } from '../GuideEngine';

const originalRect = Element.prototype.getBoundingClientRect;
let fetchSpy: ReturnType<typeof vi.fn>;
let beaconSpy: ReturnType<typeof vi.fn>;
let xhrOpenSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  rpc.mockClear();
  from.mockClear();
  auth.signOut.mockClear();

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

  fetchSpy = vi.fn(() => Promise.resolve(new Response('{}')));
  beaconSpy = vi.fn(() => true);
  xhrOpenSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  Object.defineProperty(window.navigator, 'sendBeacon', { configurable: true, value: beaconSpy });
  XMLHttpRequest.prototype.open = xhrOpenSpy as unknown as typeof XMLHttpRequest.prototype.open;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Element.prototype.getBoundingClientRect = originalRect;
  window.localStorage.clear();
});

/**
 * A shell whose "operational" control records every activation. If the guide
 * could ever activate it — by click, by keyboard, or by any mechanism of its
 * own — this counter moves.
 */
let operationalActivations = 0;

function Shell() {
  return (
    <div id="test-shell">
      <nav data-guide-id={GUIDE_ANCHORS.shellNavigationRail} aria-label="nav" />
      <button
        type="button"
        data-guide-id={GUIDE_ANCHORS.shellTopbarLanguage}
        onClick={() => { operationalActivations += 1; }}
      >
        EN
      </button>
      <span data-guide-id={GUIDE_ANCHORS.shellTopbarNotifications}>bell</span>
      <button type="button" data-guide-id={GUIDE_ANCHORS.shellTopbarHelp}>help</button>
      <header data-guide-id={GUIDE_ANCHORS.dashboardContextHeader}>scope</header>
      <section data-guide-id={GUIDE_ANCHORS.dashboardOverviewKpis}>kpis</section>
      <section data-guide-id={GUIDE_ANCHORS.dashboardSignalsPanel}>signals</section>
      {/* A real mutation control, the kind IG-2 will eventually describe. */}
      <button type="button" id="danger" onClick={() => { void rpc(); }}>Dispense</button>
    </div>
  );
}

async function driveWholeTour() {
  render(
    <div>
      <Shell />
      <GuideEngine currentScreen={22} onNavigate={() => undefined} onClose={() => undefined} />
    </div>,
  );
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'Guide & Help' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Start tour' }));
  await waitFor(() => expect(document.querySelector('[data-guide-tour]')).not.toBeNull());
  for (let i = 0; i < 8; i += 1) {
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).not.toBeNull());
  }
  expect((document.querySelector('[data-guide-tour]') as HTMLElement).dataset.guideStep).toBe('closing');
  fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
  await waitFor(() => expect(document.querySelector('[data-guide-tour]')).toBeNull());
}

describe('the guide performs no mutation, start to finish', () => {
  beforeEach(() => { operationalActivations = 0; });

  it('completes an entire tour without touching the Supabase client', async () => {
    await driveWholeTour();
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('issues no network traffic of any kind', async () => {
    await driveWholeTour();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beaconSpy).not.toHaveBeenCalled();
    expect(xhrOpenSpy).not.toHaveBeenCalled();
  });

  it('never activates the operational control it highlights', async () => {
    await driveWholeTour();
    expect(operationalActivations).toBe(0);
  });

  /**
   * Keyboard containment has TWO independent mechanisms, and this environment
   * can only prove one of them.
   *
   *   • the focus trap — Tab and Shift+Tab cycle inside the card. jsdom
   *     implements this fully, so it is asserted here.
   *   • `inert` on the background — jsdom sets the ATTRIBUTE but does not
   *     implement its behaviour, so `element.focus()` still succeeds there.
   *     Asserting otherwise would be asserting a jsdom bug. The real
   *     enforcement is proven against a real engine in
   *     `tests/interactive-guide.chromium.test.ts`, which shows that focusing
   *     a highlighted control is refused outright.
   */
  it('traps the keyboard inside the card and marks the background inert', async () => {
    render(
      <div>
        <Shell />
        <GuideEngine currentScreen={22} onNavigate={() => undefined} onClose={() => undefined} />
      </div>,
    );
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Guide & Help' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Start tour' }));
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).not.toBeNull());

    const danger = document.getElementById('danger') as HTMLButtonElement;
    const card = document.querySelector('.guide-card') as HTMLElement;

    // The mechanism is in place on every background sibling of the guide layer.
    const layer = document.querySelector('.guide-layer') as HTMLElement;
    for (const sibling of Array.from(document.body.children)) {
      if (sibling === layer) continue;
      expect(sibling).toHaveAttribute('inert');
      expect(sibling).toHaveAttribute('aria-hidden', 'true');
    }

    // Tab and Shift+Tab from either end of the card stay inside it, so the
    // keyboard never walks out to the mutation control.
    const focusables = Array.from(card.querySelectorAll('button')).filter(b => !b.disabled);
    focusables[focusables.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(card.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(danger);

    focusables[0].focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(card.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(danger);

    expect(rpc).not.toHaveBeenCalled();
  });

  it('writes only the guide progress key to storage', async () => {
    await driveWholeTour();
    const keys = Object.keys(window.localStorage);
    expect(keys).toEqual(['medistock.phoenix.guide.progress']);
  });
});
