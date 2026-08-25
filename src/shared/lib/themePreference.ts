import type { Theme } from './types';

export const THEME_STORAGE_KEY = 'medistock.phoenix.theme';

function isTheme(value: string | null): value is Theme {
  return value === 'light' || value === 'dark';
}

/** Read the browser-local theme preference. Light remains the safe fallback. */
export function readThemePreference(): Theme {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : 'light';
  } catch {
    return 'light';
  }
}

/** Persist a valid effective theme without ever making storage availability fatal. */
export function persistThemePreference(theme: Theme): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme switching remains an in-memory UI capability even when storage is blocked.
  }
}

/** Apply a theme synchronously so refresh does not wait for AppContext's passive effect. */
export function applyThemeToDocument(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
}

/** Restore the saved preference before React mounts. */
export function restoreThemeBeforeReact(): Theme {
  const theme = readThemePreference();
  applyThemeToDocument(theme);
  return theme;
}
