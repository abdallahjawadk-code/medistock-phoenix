/**
 * VISUAL-QA-HARNESS-A — DEV/TEST-only visual gallery (see qaConfig.ts).
 *
 * Renders real UI against fixture personas across lang/theme so we can capture
 * the mandated screenshot matrix (desktop/mobile × light/dark × AR/EN × states)
 * WITHOUT a live session. Selection is driven entirely by URL params so a
 * screenshot runner can address each cell deterministically:
 *
 *   ?qa=1&persona=super_admin&lang=ar&theme=dark&scene=shell
 *
 * This module is import-gated in App.tsx behind {@link visualQaEnabled} and is
 * tree-shaken from production builds. It renders NO business mutation and reads
 * NO live data — data-backed screens arrive in a later increment behind a
 * network-free fixture client.
 */
import { useMemo } from 'react';
import type { Lang, Theme } from '@/shared/lib/types';
import { PhoenixAppShell } from '@/shared/ui/PhoenixAppShell';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { QaAppProvider } from './QaAppProvider';
import { QA_HARNESS_MARKER } from './qaConfig';
import { QA_PERSONAS, qaPersona, type QaPersonaId } from './qaFixtures';

type SceneId = 'shell' | 'states';

function readParams() {
  const q = new URLSearchParams(window.location.search);
  const persona = (q.get('persona') ?? 'super_admin') as QaPersonaId;
  const lang = (q.get('lang') === 'en' ? 'en' : 'ar') as Lang;
  const theme = (q.get('theme') === 'dark' ? 'dark' : 'light') as Theme;
  const scene = (q.get('scene') === 'states' ? 'states' : 'shell') as SceneId;
  return { persona, lang, theme, scene };
}

function StatesScene({ lang }: { lang: Lang }) {
  const ar = lang === 'ar';
  return (
    <div style={{ display: 'grid', gap: 'var(--sp-6)', maxWidth: 720, margin: '0 auto' }}>
      <PhoenixLoadingState label={ar ? 'جارٍ التحميل…' : 'Loading…'} />
      <PhoenixEmptyState
        title={ar ? 'لا توجد عناصر بعد' : 'Nothing here yet'}
        description={ar ? 'ستظهر البيانات هنا عند توفّرها ضمن نطاقك.' : 'Data will appear here once available in your scope.'}
      />
      <PhoenixErrorState
        title={ar ? 'تعذّر تحميل البيانات' : 'Could not load data'}
        message={ar ? 'أعد المحاولة، وإن استمرّ الخطأ راجع الاتصال.' : 'Try again; if it persists, check your connection.'}
        onRetry={() => { /* QA: inert */ }}
      />
    </div>
  );
}

export function QaHarness() {
  const { persona, lang, theme, scene } = useMemo(readParams, []);
  const active = qaPersona(persona);

  return (
    <QaAppProvider persona={active} lang={lang} theme={theme}>
      <div data-qa-marker={QA_HARNESS_MARKER}>
        <div
          role="note"
          style={{
            position: 'fixed', insetInlineStart: 8, bottom: 8, zIndex: 99999,
            padding: '4px 10px', borderRadius: 8, pointerEvents: 'none',
            font: '600 10px/1.4 system-ui', color: '#02050A',
            background: 'linear-gradient(90deg,#DDBA63,#FF7A1A)', opacity: 0.9,
          }}
        >
          QA ONLY · {active.id} · {lang.toUpperCase()} · {theme}
        </div>

        {scene === 'shell' ? (
          <PhoenixAppShell currentScreen={12} onNavigate={() => { /* QA: inert */ }} onLogout={() => { /* QA: inert */ }}>
            <div style={{ padding: 'var(--sp-4)' }}>
              <h2 style={{ color: 'var(--t)', fontSize: 'var(--fs-2xl)', fontWeight: 700 }}>
                {lang === 'ar' ? 'معاينة الهيكل — QA' : 'Shell preview — QA'}
              </h2>
              <p style={{ color: 'var(--t2)', marginTop: 8 }}>
                {lang === 'ar'
                  ? 'التنقّل والرأس والشريط الجانبي مقيّدة حسب صلاحيات الشخصية المختارة.'
                  : 'Navigation, topbar and sidebar are gated by the selected persona’s permissions.'}
              </p>
              <div style={{ marginTop: 'var(--sp-6)' }}>
                <StatesScene lang={lang} />
              </div>
            </div>
          </PhoenixAppShell>
        ) : (
          <div style={{ minHeight: '100dvh', background: 'var(--bg)', padding: 'var(--sp-8) var(--sp-4)' }}>
            <StatesScene lang={lang} />
          </div>
        )}
      </div>
    </QaAppProvider>
  );
}

/** Personas exposed for the screenshot runner to enumerate. */
export { QA_PERSONAS };
