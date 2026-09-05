import type { Lang } from './types';

/**
 * INTERACTIVE-GUIDE-IG1 — browser-local persistence of the APPLICATION
 * language.
 *
 * `AppContext` has always started every session at Arabic and kept the choice
 * in memory only, so a refresh silently threw an English operator back to
 * Arabic mid-task. This module is the storage half of the fix; `AppContext`
 * remains the single owner of the live value (see `LanguagePreferenceBridge`
 * in App.tsx, which mirrors the existing `ThemePreferenceBridge` exactly).
 *
 * Unlike the theme key, the stored shape is VERSIONED. The interactive guide
 * reads the app language rather than owning one of its own, so this value now
 * has a second consumer and a defined migration story: an unknown, corrupt,
 * older or NEWER schema resolves to Arabic instead of guessing, and never
 * throws. Storage being unavailable (private mode, blocked site data) is a
 * normal outcome here, not an error — language switching stays a working
 * in-memory capability in that case.
 */
export const LANGUAGE_STORAGE_KEY = 'medistock.phoenix.language';

/** Bump ONLY when the stored shape changes. A mismatch resets, never migrates blindly. */
export const LANGUAGE_SCHEMA_VERSION = 1;

/** The safe fallback for every unreadable, absent or unrecognised value. */
export const DEFAULT_LANG: Lang = 'ar';

interface StoredLanguagePreference {
  v: number;
  lang: Lang;
}

function isLang(value: unknown): value is Lang {
  return value === 'ar' || value === 'en';
}

/**
 * Read the persisted application language.
 *
 * Accepts exactly one shape — `{"v":1,"lang":"ar"|"en"}`. Anything else
 * (absent, non-JSON, wrong version, unknown language, a bare legacy string)
 * resolves to Arabic. No value read here can ever reach the UI unvalidated.
 */
export function readLanguagePreference(): Lang {
  if (typeof window === 'undefined') return DEFAULT_LANG;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return DEFAULT_LANG;
  }
  if (!raw) return DEFAULT_LANG;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_LANG;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_LANG;

  const candidate = parsed as Partial<StoredLanguagePreference>;
  if (candidate.v !== LANGUAGE_SCHEMA_VERSION) return DEFAULT_LANG;
  return isLang(candidate.lang) ? candidate.lang : DEFAULT_LANG;
}

/** Persist a validated language. Storage failure never becomes a UI failure. */
export function persistLanguagePreference(lang: Lang): void {
  if (typeof window === 'undefined') return;
  if (!isLang(lang)) return;
  try {
    window.localStorage.setItem(
      LANGUAGE_STORAGE_KEY,
      JSON.stringify({ v: LANGUAGE_SCHEMA_VERSION, lang } satisfies StoredLanguagePreference),
    );
  } catch {
    // Language switching remains an in-memory capability when storage is blocked.
  }
}

/**
 * Apply direction and language to the document synchronously.
 *
 * Deliberately the same three attributes AppContext's own effect sets, so the
 * pre-React restore below and that effect can never disagree about direction.
 */
export function applyLanguageToDocument(lang: Lang): void {
  if (typeof document === 'undefined') return;
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.documentElement.setAttribute('dir', dir);
  document.documentElement.setAttribute('lang', lang);
  document.body?.setAttribute('dir', dir);
}

/** Restore the saved preference before React mounts, so the first paint is correct. */
export function restoreLanguageBeforeReact(): Lang {
  const lang = readLanguagePreference();
  applyLanguageToDocument(lang);
  return lang;
}
