import { lazy, Suspense, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { AppProvider, useApp } from './AppContext';
import { t } from '@/shared/i18n/strings';
import {
  applyThemeToDocument,
  persistThemePreference,
  readThemePreference,
} from '@/shared/lib/themePreference';
import {
  applyLanguageToDocument,
  persistLanguagePreference,
  readLanguagePreference,
} from '@/shared/lib/languagePreference';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';

/**
 * VISUAL-QA-HARNESS-A: DEV/TEST-only visual gallery. The `if
 * (!import.meta.env.DEV) return null` FIRST line matters — in a production
 * build Vite replaces `import.meta.env.DEV` with `false`, making the guard
 * `if (true) return null` and the dynamic `import()` below unreachable, so
 * Rollup drops the harness chunk and every marker/fixture entirely. There is
 * NO static import of the qa module from this entry, so nothing pulls it into
 * the production graph. `tests/qa-harness-production-safety.test.ts` enforces
 * this against a build with the QA flag forced on.
 */
function maybeQaHarness(): ReactNode {
  // The single outer `if (import.meta.env.DEV)` is the canonical Vite dead-code
  // guard: production replaces it with `if (false)`, so Rollup strips the whole
  // block — including the dynamic import() — and never emits a harness chunk,
  // regardless of VITE_ENABLE_VISUAL_QA.
  if (import.meta.env.DEV) {
    let requested = false;
    try {
      requested = new URLSearchParams(window.location.search).has('qa');
    } catch {
      requested = false;
    }
    if (import.meta.env.VITE_ENABLE_VISUAL_QA === 'true' && requested) {
      const QaHarness = lazy(() => import('@/features/qa/QaHarness').then(m => ({ default: m.QaHarness })));
      return (
        <Suspense fallback={<PhoenixLoadingState fullScreen />}>
          <QaHarness />
        </Suspense>
      );
    }
  }
  return null;
}

/**
 * QR-BUNDLE-CODE-SPLIT-A: the anonymous public QR route and the
 * authenticated app (login, shell, every screen) are separate lazy chunks,
 * so a public QR visitor never downloads login/admin/dashboard code. Route
 * detection itself (the `qid` check below) is unchanged from before this
 * phase — only *which module gets fetched* for each branch changed.
 */
const PublicQrScreen = lazy(() =>
  import('@/features/qr/PublicQrScreen').then(m => ({ default: m.PublicQrScreen })),
);
const AuthenticatedApp = lazy(() =>
  import('./AuthenticatedApp').then(m => ({ default: m.AuthenticatedApp })),
);

/** Read a public QR handle from the URL (?qid=… or ?token=…). Anon, no auth. */
function publicQrId(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('qid') ?? params.get('token');
}

function LoadingFallback() {
  const { lang } = useApp();
  return <PhoenixLoadingState fullScreen label={t('loading', lang)} />;
}

/**
 * THEME-PERSISTENCE-HOTFIX: AppContext historically starts at light on every
 * mount. Reconcile that in-memory state with the validated browser preference
 * in a layout effect, before paint, then persist each real theme transition.
 *
 * This bridge is deliberately UI-only: no account/profile/database state is
 * involved, and storage failures never make the application unavailable.
 */
function ThemePreferenceBridge({ children }: { children: ReactNode }) {
  const { theme, setTheme } = useApp();
  const [initialTheme] = useState(readThemePreference);
  const hydratedRef = useRef(false);
  const setThemeRef = useRef(setTheme);
  setThemeRef.current = setTheme;

  useLayoutEffect(() => {
    if (!hydratedRef.current && theme !== initialTheme) {
      applyThemeToDocument(initialTheme);
      setThemeRef.current(initialTheme);
      return;
    }

    hydratedRef.current = true;
    applyThemeToDocument(theme);
    persistThemePreference(theme);
  }, [initialTheme, theme]);

  return <>{children}</>;
}

/**
 * INTERACTIVE-GUIDE-IG1 — the language counterpart of ThemePreferenceBridge.
 *
 * AppContext starts every mount at Arabic and keeps `lang` in memory only, so
 * a refresh discarded an English operator's choice. This reconciles that
 * in-memory state with the validated browser preference in a layout effect,
 * before paint, then persists each real language transition — the SAME shape
 * as the theme bridge directly above, deliberately, so there is one pattern
 * for "AppContext owns the live value, storage only remembers it".
 *
 * AppContext stays the single owner of `lang`: nothing here introduces a
 * second source of truth, and the interactive guide reads that one value
 * rather than carrying a language selector of its own.
 *
 * UI-only: no account, profile or database state is involved, and a storage
 * failure never makes the application unavailable.
 *
 * Exported so the canonical persistence path can be proven END TO END —
 * `AppContext.setLang` → this bridge → `persistLanguagePreference` → the one
 * storage key — against the real provider rather than a stand-in. The guide's
 * own language control calls that same canonical setter and nothing else, so
 * this is the composition its persistence proof has to exercise. `<App />`
 * itself cannot serve: it renders the authenticated shell through a lazy
 * chunk behind a real session.
 */
export function LanguagePreferenceBridge({ children }: { children: ReactNode }) {
  const { lang, setLang } = useApp();
  const [initialLang] = useState(readLanguagePreference);
  const hydratedRef = useRef(false);
  const setLangRef = useRef(setLang);
  setLangRef.current = setLang;

  useLayoutEffect(() => {
    if (!hydratedRef.current && lang !== initialLang) {
      applyLanguageToDocument(initialLang);
      setLangRef.current(initialLang);
      return;
    }

    hydratedRef.current = true;
    applyLanguageToDocument(lang);
    persistLanguagePreference(lang);
  }, [initialLang, lang]);

  return <>{children}</>;
}

function AppInner({ qid }: { qid: string | null }) {
  // ── Anon public QR scan view — bypasses auth entirely, own lazy chunk ──
  if (qid) {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <PublicQrScreen publicId={qid} />
      </Suspense>
    );
  }

  // ── Everything else (login gate, app shell, every screen) is its own
  //    lazy chunk — see AuthenticatedApp.tsx ──
  return (
    <Suspense fallback={<LoadingFallback />}>
      <AuthenticatedApp />
    </Suspense>
  );
}

export function App() {
  // VISUAL-QA-HARNESS-A: DEV/TEST-only visual gallery, self-contained (its own
  // fixture provider, no AppProvider, no auth bootstrap, no live data). Returns
  // null — and is fully tree-shaken — in production. See maybeQaHarness above.
  const qa = maybeQaHarness();
  if (qa) return qa;

  // Read once per render, before AppProvider decides whether to run its
  // auth-bootstrap effect (DB-PRESSURE-QUICK-WINS-A) — same detection logic
  // as before, just hoisted one level so AppProvider can see it too.
  const qid = publicQrId();
  return (
    <AppProvider skipAuthBootstrap={!!qid}>
      <ThemePreferenceBridge>
        <LanguagePreferenceBridge>
          <AppInner qid={qid} />
        </LanguagePreferenceBridge>
      </ThemePreferenceBridge>
    </AppProvider>
  );
}
