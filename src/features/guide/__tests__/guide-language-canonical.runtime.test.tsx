/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LANGUAGE_STORAGE_KEY } from '@/shared/lib/languagePreference';
import { GUIDE_PROGRESS_STORAGE_KEY } from '../guide.progress';

/**
 * INTERACTIVE-GUIDE-IG1 — the guide's language control is CANONICAL.
 *
 * This is the proof that the control introduced for the live-language contract
 * did not quietly become a second language system. Everything here runs against
 * the REAL `AppProvider` and the REAL `LanguagePreferenceBridge` — the exact
 * composition `App.tsx` mounts — with a genuine click on the rendered control,
 * so the assertion covers the whole path:
 *
 *     click → AppContext.toggleLang → AppContext.lang → bridge → one storage key
 *
 * A stand-in provider would prove nothing about that path, and a programmatic
 * state update would prove nothing about the control.
 */

vi.mock('@/shared/supabase/client', () => ({
  supabase: {
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    from: vi.fn(() => ({ select: vi.fn(() => Promise.resolve({ data: [], error: null })) })),
  },
  supabaseConfigured: false,
}));

vi.mock('@/shared/ui/PhoenixIcon', () => ({
  PhoenixIcon: ({ name }: { name: string }) => <span aria-hidden="true" data-icon={name} />,
}));

import { AppProvider, useApp } from '@/app/AppContext';
import { LanguagePreferenceBridge } from '@/app/App';
import { GuideLanguageControl } from '../GuideLanguageControl';

function Probe() {
  const { lang, dir } = useApp();
  return (
    <div>
      <span data-testid="lang">{lang}</span>
      <span data-testid="dir">{dir}</span>
      <GuideLanguageControl />
    </div>
  );
}

function Harness() {
  return (
    <AppProvider skipAuthBootstrap>
      <LanguagePreferenceBridge>
        <Probe />
      </LanguagePreferenceBridge>
    </AppProvider>
  );
}

const AR_LABEL = 'تغيير لغة البرنامج';
const EN_LABEL = 'Change application language';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('dir');
  document.documentElement.removeAttribute('lang');
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('the guide language control is labelled as required', () => {
  it('carries the Arabic label while the application is Arabic', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: AR_LABEL })).toBeInTheDocument();
  });

  it('carries the English label once the application is English', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: AR_LABEL }));
    await waitFor(() => expect(screen.getByRole('button', { name: EN_LABEL })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: AR_LABEL })).toBeNull();
  });
});

describe('the guide language control mutates ONLY the canonical state', () => {
  it('changes AppContext lang and dir on a real click', async () => {
    render(<Harness />);
    expect(screen.getByTestId('lang')).toHaveTextContent('ar');
    expect(screen.getByTestId('dir')).toHaveTextContent('rtl');

    fireEvent.click(screen.getByRole('button', { name: AR_LABEL }));

    await waitFor(() => expect(screen.getByTestId('lang')).toHaveTextContent('en'));
    expect(screen.getByTestId('dir')).toHaveTextContent('ltr');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });

  it('persists through the SAME bridge and the SAME single storage key', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: AR_LABEL }));

    await waitFor(() => {
      expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY))
        .toBe(JSON.stringify({ v: 1, lang: 'en' }));
    });

    /**
     * The anti-duplication assertion, and the point of the whole file: the
     * ONLY language-related key in storage is the application's own. A
     * guide-scoped preference of any name would show up here.
     */
    const keys = Object.keys(window.localStorage);
    expect(keys).toEqual([LANGUAGE_STORAGE_KEY]);
    expect(keys.some(key => /guide/i.test(key) && /lang/i.test(key))).toBe(false);
    expect(window.localStorage.getItem(GUIDE_PROGRESS_STORAGE_KEY)).toBeNull();
  });

  it('survives a reload: a later mount opens in the chosen language', async () => {
    const first = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: AR_LABEL }));
    await waitFor(() => {
      expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY))
        .toBe(JSON.stringify({ v: 1, lang: 'en' }));
    });
    first.unmount();
    document.documentElement.removeAttribute('dir');

    // A fresh mount is what a reload is, for this bridge.
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('lang')).toHaveTextContent('en'));
    expect(screen.getByTestId('dir')).toHaveTextContent('ltr');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(screen.getByRole('button', { name: EN_LABEL })).toBeInTheDocument();
  });

  it('round-trips back to Arabic through the same path', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: AR_LABEL }));
    await waitFor(() => expect(screen.getByTestId('lang')).toHaveTextContent('en'));
    fireEvent.click(screen.getByRole('button', { name: EN_LABEL }));
    await waitFor(() => expect(screen.getByTestId('lang')).toHaveTextContent('ar'));
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY))
      .toBe(JSON.stringify({ v: 1, lang: 'ar' }));
  });

  it('does not make blocked storage fatal', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    render(<Harness />);
    expect(() => fireEvent.click(screen.getByRole('button', { name: AR_LABEL }))).not.toThrow();
    // The in-memory switch still works; only "remember it" was lost.
    await waitFor(() => expect(screen.getByTestId('lang')).toHaveTextContent('en'));
    setItem.mockRestore();
  });
});

describe('the guide language control holds no state of its own', () => {
  it('renders no select, no radio group and no second toggle', () => {
    render(<Harness />);
    const control = document.querySelector('[data-guide-language-control]') as HTMLElement;
    expect(control).not.toBeNull();
    expect(control.tagName).toBe('BUTTON');
    expect(control.getAttribute('type')).toBe('button');
    expect(document.querySelectorAll('[data-guide-language-control]')).toHaveLength(1);
    expect(document.querySelector('select')).toBeNull();
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  });

  it('follows the application when the language changes from somewhere else', async () => {
    /**
     * The control is a VIEW of the canonical value, not an owner of one: a
     * change made anywhere else must be reflected here with no action of its
     * own. `AppContext.toggleLang` stands in for the topbar control, which is
     * the same function it calls.
     */
    function ExternalSwitch() {
      const { toggleLang } = useApp();
      return <button type="button" onClick={toggleLang}>topbar</button>;
    }
    render(
      <AppProvider skipAuthBootstrap>
        <LanguagePreferenceBridge>
          <ExternalSwitch />
          <GuideLanguageControl />
        </LanguagePreferenceBridge>
      </AppProvider>,
    );
    expect(screen.getByRole('button', { name: AR_LABEL })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'topbar' }));
    await waitFor(() => expect(screen.getByRole('button', { name: EN_LABEL })).toBeInTheDocument());
  });
});
