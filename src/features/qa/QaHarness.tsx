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
import { lazy, Suspense, useMemo, useState } from 'react';
import type { Lang, Theme } from '@/shared/lib/types';
import { PhoenixAppShell } from '@/shared/ui/PhoenixAppShell';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { __installQaSupabaseClient } from '@/shared/supabase/client';
import type { NetworkWarehouse, SupplyRoute } from '@/features/network/network.service';
import type { DistributionPoint } from '@/shared/supabase/services/warehouses.service';
import type { NodeAlert } from '@/features/network/NetworkTopologyStage';
import { QaAppProvider } from './QaAppProvider';
import { QA_HARNESS_MARKER } from './qaConfig';
import { QA_PERSONAS, qaPersona, type QaPersonaId } from './qaFixtures';
import { createQaFixtureClient } from './qaFixtureClient';

// Install the network-free fixture client before any screen service runs. This
// module is dev-only and tree-shaken from production, and the installer itself
// is a no-op in a production build (see client.ts).
__installQaSupabaseClient(createQaFixtureClient());

type SceneId = 'shell' | 'states' | 'institutions' | 'welcome' | 'dashboard' | 'twin';

const SCENE_IDS: SceneId[] = ['shell', 'states', 'institutions', 'welcome', 'dashboard', 'twin'];

function readParams() {
  const q = new URLSearchParams(window.location.search);
  const persona = (q.get('persona') ?? 'super_admin') as QaPersonaId;
  const lang = (q.get('lang') === 'en' ? 'en' : 'ar') as Lang;
  const theme = (q.get('theme') === 'dark' ? 'dark' : 'light') as Theme;
  const raw = q.get('scene') as SceneId | null;
  const scene: SceneId = raw && SCENE_IDS.includes(raw) ? raw : 'shell';
  return { persona, lang, theme, scene };
}

/** A real operational screen (screen 11) rendered against fixture data — proves
 *  the fixture client drives an actual service-backed screen, not a mock view. */
const InstitutionScreen = lazy(() =>
  import('@/features/institutions/InstitutionScreen').then(m => ({ default: m.InstitutionScreen })),
);
const DashboardScreen = lazy(() =>
  import('@/features/dashboard/DashboardScreen').then(m => ({ default: m.DashboardScreen })),
);
const NetworkTopologyStage = lazy(() =>
  import('@/features/network/NetworkTopologyStage').then(m => ({ default: m.NetworkTopologyStage })),
);
const PhoenixWelcomeExperience = lazy(() =>
  import('@/features/auth/PhoenixWelcomeExperience').then(m => ({ default: m.PhoenixWelcomeExperience })),
);

// Prop-driven fixtures for the Digital Twin scene (no service calls). Shapes
// match the real warehouse/route/outlet/alert types so the twin renders exactly
// as it does against live RLS-scoped data. Deliberately DENSE (1 central,
// 4 institution stores, 8 outlets) so the captured 2D map proves the
// deterministic layout keeps dense nodes/labels from overlapping.
const TWIN_WAREHOUSES: NetworkWarehouse[] = [
  { id: 'c1', name: 'Central Store', name_ar: 'المخزن المركزي', warehouseKind: 'central', status: 'active', isMain: true, code: 'C-01', organizationId: 'org' },
  { id: 'i1', name: 'Babil General', name_ar: 'مذخر بابل العام', warehouseKind: 'institution', status: 'active', isMain: false, code: 'I-01', organizationId: 'org' },
  { id: 'i2', name: 'Hilla Teaching', name_ar: 'مذخر الحلة التعليمي', warehouseKind: 'institution', status: 'active', isMain: false, code: 'I-02', organizationId: 'org' },
  { id: 'i3', name: 'Mahawil Store', name_ar: 'مذخر المحاويل', warehouseKind: 'institution', status: 'active', isMain: false, code: 'I-03', organizationId: 'org' },
  { id: 'i4', name: 'Musayyib Store', name_ar: 'مذخر المسيّب', warehouseKind: 'institution', status: 'active', isMain: false, code: 'I-04', organizationId: 'org' },
];
const TWIN_ROUTES: SupplyRoute[] = [
  { id: 'r1', sourceWarehouseId: 'c1', targetWarehouseId: 'i1', priority: 1, isActive: true, notes: null },
  { id: 'r2', sourceWarehouseId: 'c1', targetWarehouseId: 'i2', priority: 1, isActive: true, notes: null },
  { id: 'r3', sourceWarehouseId: 'c1', targetWarehouseId: 'i3', priority: 1, isActive: true, notes: null },
  { id: 'r4', sourceWarehouseId: 'c1', targetWarehouseId: 'i4', priority: 1, isActive: false, notes: null },
];
const TWIN_OUTLETS: DistributionPoint[] = [
  { id: 'o1', name: 'Pharmacy A', name_ar: 'صيدلية أ', status: 'active', warehouseId: 'i1', organizationId: 'org', pointType: 'pharmacy' },
  { id: 'o2', name: 'Rescue Cart', name_ar: 'عربة إنعاش', status: 'active', warehouseId: 'i2', organizationId: 'org', pointType: 'rescue_cart' },
  { id: 'o3', name: 'Pharmacy B', name_ar: 'صيدلية ب', status: 'active', warehouseId: 'i1', organizationId: 'org', pointType: 'pharmacy' },
  { id: 'o4', name: 'Crash Cabinet 1', name_ar: 'خزانة إنعاش ١', status: 'active', warehouseId: 'i2', organizationId: 'org', pointType: 'crash_cabinet' },
  { id: 'o5', name: 'Pharmacy C', name_ar: 'صيدلية ج', status: 'active', warehouseId: 'i3', organizationId: 'org', pointType: 'pharmacy' },
  { id: 'o6', name: 'Rescue Cart 2', name_ar: 'عربة إنعاش ٢', status: 'active', warehouseId: 'i3', organizationId: 'org', pointType: 'rescue_cart' },
  { id: 'o7', name: 'Pharmacy D', name_ar: 'صيدلية د', status: 'active', warehouseId: 'i4', organizationId: 'org', pointType: 'pharmacy' },
  { id: 'o8', name: 'Crash Cabinet 2', name_ar: 'خزانة إنعاش ٢', status: 'active', warehouseId: 'i4', organizationId: 'org', pointType: 'crash_cabinet' },
];
const TWIN_ALERTS = new Map<string, NodeAlert>([
  ['i1', { severity: 'high', count: 3, topSignal: 'missing' }],
  ['o2', { severity: 'medium', count: 1, topSignal: 'near_expiry' }],
  ['i3', { severity: 'low', count: 2, topSignal: 'surplus' }],
  ['o6', { severity: 'high', count: 5, topSignal: 'low_stock' }],
]);

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
  const initial = useMemo(readParams, []);
  const { persona, lang, theme } = initial;
  const active = qaPersona(persona);

  // DEV-only: make the harness's OWN navigation functional so a screenshot
  // runner (or a reviewer) reaches a scene through the REAL sidebar / drawer
  // controls, not a URL shortcut. The nav items carry production screen numbers;
  // map the ones the harness can render to their scene, and fall back to the
  // shell placeholder for anything else. This is NOT a production navigation
  // path — the whole harness is tree-shaken from production builds (proven by
  // tests/qa-harness-production-safety.test.ts). The initial scene still comes
  // from ?scene=, preserving the existing per-cell URL contract.
  const [scene, setScene] = useState<SceneId>(initial.scene);
  const handleNavigate = (n: number) =>
    setScene(n === 17 ? 'twin' : n === 11 ? 'institutions' : n === 2 ? 'dashboard' : 'shell');
  // Reflect the active scene as the production screen number its nav item uses,
  // so the correct sidebar/drawer item reads as current (twin = 17 / network).
  const currentScreen = scene === 'twin' ? 17 : scene === 'institutions' ? 11 : scene === 'dashboard' ? 2 : 1;

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

        {scene === 'welcome' ? (
          <Suspense fallback={<PhoenixLoadingState />}>
            <PhoenixWelcomeExperience onComplete={() => { /* QA: inert */ }} />
          </Suspense>
        ) : scene === 'states' ? (
          <div style={{ minHeight: '100dvh', background: 'var(--bg)', padding: 'var(--sp-8) var(--sp-4)' }}>
            <StatesScene lang={lang} />
          </div>
        ) : (
          <PhoenixAppShell currentScreen={currentScreen} onNavigate={handleNavigate} onLogout={() => { /* QA: inert */ }}>
            {scene === 'institutions' ? (
              <Suspense fallback={<PhoenixLoadingState />}>
                <InstitutionScreen />
              </Suspense>
            ) : scene === 'dashboard' ? (
              <Suspense fallback={<PhoenixLoadingState />}>
                <DashboardScreen onNavigate={() => { /* QA: inert */ }} />
              </Suspense>
            ) : scene === 'twin' ? (
              <Suspense fallback={<PhoenixLoadingState />}>
                <NetworkTopologyStage
                  lang={lang}
                  warehouses={TWIN_WAREHOUSES}
                  routes={TWIN_ROUTES}
                  outlets={TWIN_OUTLETS}
                  organizationName={lang === 'ar' ? 'دائرة صحة بابل · قسم الصيدلة' : 'Babil Health · Pharmacy Department'}
                  alerts={TWIN_ALERTS}
                />
              </Suspense>
            ) : (
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
            )}
          </PhoenixAppShell>
        )}
      </div>
    </QaAppProvider>
  );
}

/** Personas exposed for the screenshot runner to enumerate. */
export { QA_PERSONAS };
