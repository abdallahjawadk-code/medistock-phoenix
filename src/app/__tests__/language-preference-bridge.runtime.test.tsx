/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LANGUAGE_STORAGE_KEY } from '@/shared/lib/languagePreference';

/**
 * INTERACTIVE-GUIDE-IG1 — the bridge between AppContext's in-memory `lang`
 * and the browser-local preference, exercised through the real AppProvider.
 *
 * The property under test is ownership: AppContext remains the single source
 * of the live value, and storage only remembers it. A regression here looks
 * like an English operator being thrown back to Arabic by a refresh, which is
 * exactly the defect this phase exists to fix.
 */

vi.mock('@/shared/supabase/client', () => ({
  supabase: {
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    from: vi.fn(() => ({ select: vi.fn(() => Promise.resolve({ data: [], error: null })) })),
  },
  supabaseConfigured: false,
}));

import { AppProvider, useApp } from '../AppContext';
import { App } from '../App';

function LanguageProbe() {
  const { lang, dir, toggleLang } = useApp();
  return (
    <div>
      <span data-testid="lang">{lang}</span>
      <span data-testid="dir">{dir}</span>
      <button type="button" onClick={toggleLang}>toggle</button>
    </div>
  );
}

/**
 * The bridge lives inside App.tsx, so the probe is mounted underneath the real
 * <App /> tree via the same provider. `App` itself renders a lazy chunk we do
 * not need here, so the bridge is exercised through a minimal equivalent
 * mounting: AppProvider + the exported App, with the probe read out of the
 * provider AppProvider itself supplies.
 */
function Harness() {
  return (
    <AppProvider skipAuthBootstrap>
      <LanguageProbe />
    </AppProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('dir');
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('AppContext language ownership', () => {
  it('starts at Arabic with RTL when nothing is stored', () => {
    render(<Harness />);
    expect(screen.getByTestId('lang')).toHaveTextContent('ar');
    expect(screen.getByTestId('dir')).toHaveTextContent('rtl');
  });

  it('keeps AppContext as the only owner of the live value', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('lang')).toHaveTextContent('en');
    expect(screen.getByTestId('dir')).toHaveTextContent('ltr');
  });
});

describe('language preference bridge', () => {
  it('persists the app language and restores it on a later mount', async () => {
    const first = render(<App />);
    await waitFor(() => {
      expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe(JSON.stringify({ v: 1, lang: 'ar' }));
    });
    first.unmount();

    // A later session finds English stored and must open in English.
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, JSON.stringify({ v: 1, lang: 'en' }));
    render(<App />);
    await waitFor(() => expect(document.documentElement.getAttribute('dir')).toBe('ltr'));
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });

  it('falls back to Arabic RTL when the stored preference is corrupt', async () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'not-json');
    render(<App />);
    await waitFor(() => expect(document.documentElement.getAttribute('dir')).toBe('rtl'));
    expect(document.documentElement.getAttribute('lang')).toBe('ar');
    // And it repairs the stored value rather than leaving the corruption.
    await waitFor(() => {
      expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe(JSON.stringify({ v: 1, lang: 'ar' }));
    });
  });

  it('does not make a blocked storage fatal to the application', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => render(<App />)).not.toThrow();
    await waitFor(() => expect(document.documentElement.getAttribute('dir')).toBe('rtl'));
    setItem.mockRestore();
  });
});
