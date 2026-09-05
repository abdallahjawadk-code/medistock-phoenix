// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LANG,
  LANGUAGE_SCHEMA_VERSION,
  LANGUAGE_STORAGE_KEY,
  applyLanguageToDocument,
  persistLanguagePreference,
  readLanguagePreference,
  restoreLanguageBeforeReact,
} from '../languagePreference';

/**
 * INTERACTIVE-GUIDE-IG1 — the application language now survives a reload.
 *
 * The behaviour that matters most here is the FALLBACK: this value decides the
 * document's writing direction, so an unreadable one must resolve to Arabic
 * rather than to `undefined`, and must never throw on the way.
 */

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('dir');
  document.documentElement.removeAttribute('lang');
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('language preference — round trip', () => {
  it('defaults to Arabic when nothing is stored', () => {
    expect(readLanguagePreference()).toBe('ar');
    expect(DEFAULT_LANG).toBe('ar');
  });

  it('persists and reads back both languages', () => {
    persistLanguagePreference('en');
    expect(readLanguagePreference()).toBe('en');
    persistLanguagePreference('ar');
    expect(readLanguagePreference()).toBe('ar');
  });

  it('stores a versioned object, not a bare string', () => {
    persistLanguagePreference('en');
    const raw = window.localStorage.getItem(LANGUAGE_STORAGE_KEY) as string;
    expect(JSON.parse(raw)).toEqual({ v: LANGUAGE_SCHEMA_VERSION, lang: 'en' });
  });

  it('refuses to persist a value outside ar|en', () => {
    persistLanguagePreference('fr' as never);
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
  });
});

describe('language preference — hostile storage', () => {
  it.each([
    ['not JSON', 'ar'],
    ['a bare legacy string', '"en"'],
    ['null', 'null'],
    ['an array', '["en"]'],
    ['an unknown language', JSON.stringify({ v: 1, lang: 'fr' })],
    ['a missing language', JSON.stringify({ v: 1 })],
    ['an older schema', JSON.stringify({ v: 0, lang: 'en' })],
    ['a FUTURE schema', JSON.stringify({ v: 99, lang: 'en' })],
  ])('resolves safely to Arabic for %s', (_label, raw) => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, raw);
    expect(() => readLanguagePreference()).not.toThrow();
    expect(readLanguagePreference()).toBe('ar');
  });

  it('survives storage that throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readLanguagePreference()).toBe('ar');
    expect(() => persistLanguagePreference('en')).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe('language preference — document direction', () => {
  it('sets rtl for Arabic and ltr for English on html and body', () => {
    applyLanguageToDocument('ar');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(document.documentElement.getAttribute('lang')).toBe('ar');
    expect(document.body.getAttribute('dir')).toBe('rtl');

    applyLanguageToDocument('en');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    expect(document.body.getAttribute('dir')).toBe('ltr');
  });

  it('restores the stored preference and applies it before React would', () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, JSON.stringify({ v: 1, lang: 'en' }));
    expect(restoreLanguageBeforeReact()).toBe('en');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
  });

  it('restores Arabic RTL when the stored value is unusable', () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, '{{{');
    expect(restoreLanguageBeforeReact()).toBe('ar');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
  });
});
