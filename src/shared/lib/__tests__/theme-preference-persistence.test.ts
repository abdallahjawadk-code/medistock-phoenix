// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  persistThemePreference,
  readThemePreference,
  restoreThemeBeforeReact,
} from '../themePreference';

const ROOT = join(__dirname, '../../../../');

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.setAttribute('data-theme', 'light');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('theme preference persistence', () => {
  it('keeps light as the safe default when no preference exists', () => {
    expect(readThemePreference()).toBe('light');
    expect(restoreThemeBeforeReact()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('restores a saved dark preference and applies it to the document before React', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(restoreThemeBeforeReact()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('restores a saved light preference', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(restoreThemeBeforeReact()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('ignores an invalid stored value and falls back to light', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(restoreThemeBeforeReact()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('persists both valid theme transitions', () => {
    persistThemePreference('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    persistThemePreference('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('does not crash when browser storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(readThemePreference()).toBe('light');
  });

  it('does not crash or prevent an in-memory theme change when storage cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'QuotaExceededError');
    });
    expect(() => persistThemePreference('dark')).not.toThrow();
    expect(() => applyThemeToDocument('dark')).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('restores before createRoot and bridges both public and authenticated routes before paint', () => {
    const main = readFileSync(join(ROOT, 'src/main.tsx'), 'utf8');
    const app = readFileSync(join(ROOT, 'src/app/App.tsx'), 'utf8');

    expect(main).toContain('restoreThemeBeforeReact();');
    expect(main.indexOf('restoreThemeBeforeReact();')).toBeLessThan(main.indexOf('createRoot('));

    expect(app).toContain('function ThemePreferenceBridge');
    expect(app).toContain('useLayoutEffect(() =>');
    expect(app).toContain('persistThemePreference(theme);');
    const bridgeOpen = app.indexOf('<ThemePreferenceBridge>');
    const routedApp = app.indexOf('<AppInner qid={qid} />');
    const bridgeClose = app.indexOf('</ThemePreferenceBridge>');
    expect(bridgeOpen).toBeGreaterThan(-1);
    expect(routedApp).toBeGreaterThan(bridgeOpen);
    expect(bridgeClose).toBeGreaterThan(routedApp);
  });
});
