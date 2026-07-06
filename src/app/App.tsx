import { lazy, Suspense } from 'react';
import { AppProvider, useApp } from './AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';

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
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <PhoenixLoadingState label={t('loading', lang)} />
    </div>
  );
}

function AppInner() {
  // ── Anon public QR scan view — bypasses auth entirely, own lazy chunk ──
  const qid = publicQrId();
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
  return (
    <AppProvider>
      <AppInner />
    </AppProvider>
  );
}
