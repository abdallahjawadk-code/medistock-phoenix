/**
 * TEST ONLY. Real ManualNeedsJourney and real production CSS, deterministic service fixtures.
 * No authentication, database, stock or real source workbooks. This is rendering/interaction
 * evidence, not server acceptance. Mutations below affect only this page's in-memory fixture.
 */
import { createRoot } from 'react-dom/client';
// Keep this list and its order identical to main.tsx. Component-owned PRISM styles are
// loaded through the real component graph, exactly as in the application.
import '@fontsource-variable/inter/wght.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-400.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-500.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-700.css';
import '@fontsource/ibm-plex-sans-arabic/latin-400.css';
import '@fontsource/ibm-plex-sans-arabic/latin-500.css';
import '@fontsource/ibm-plex-sans-arabic/latin-600.css';
import '@fontsource/ibm-plex-sans-arabic/latin-700.css';
import '@/shared/lib/global.css';
import '@/shared/lib/phase-a-foundation.css';
import '@/shared/lib/phase-a-auth.css';
import '@/shared/lib/phase-a-command-center.css';
import '@/shared/lib/rac3-command-center.css';
import '@/shared/lib/central-needs.css';
import '@/shared/lib/phase-a-inventory-transfers.css';
import '@/shared/lib/phase-a-institutions-outlets.css';
import '@/shared/lib/phase-a-alerts-admin-qr.css';
import '@/shared/lib/pharma-molecular.css';
import '@/shared/lib/phase-a-visual-convergence.css';
import '@/shared/lib/phase-a-auth-welcome-signature.css';
import { ManualNeedsJourney } from '@/features/central-needs/manual/ManualNeedsJourney';
import { CentralNeedsError } from '@/features/central-needs/central-needs.service';
import type { CatalogOption, JourneyApi, YearRevision } from '@/features/central-needs/manual/manual-journey.service';
import type { ManualNeedsApi } from '@/features/central-needs/manual/ManualNeedsWorkspace';
import type { ManualCapabilities, ManualNeedEvent, ManualScope, ManualWriteResult } from '@/features/central-needs/manual/manual-needs.service';
import type { RegistrationApi } from '@/features/central-needs/manual/MaterialRegistrationPanel';
import type { IdentityPreviewHandle } from '@/features/central-needs/manual/IdentityAssistPanel';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'ar';
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const scenario = params.get('scenario') ?? 'normal';
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.pharmaDesign = 'molecular';
document.documentElement.dataset.phoenixUiPhase = 'a';
document.documentElement.dataset.phoenixVisual = 'daylight';

const ORGANIZATION = 'fixture-owner';
const ACTOR = 'fixture-actor';
const REVISION = 'fixture-revision-2026';
const BENEFICIARY = 'fixture-beneficiary';
const DOSSIER = 'fixture-dossier-2026';
const materials: CatalogOption[] = [
  { id: 'fixture-amoxicillin', name: 'Amoxicillin 500 mg', nameAr: null, concentration: '500 mg', dosageForm: 'Capsules (Oral)', unit: 'capsule', nationalCode: 'DEMO-001' },
  { id: 'fixture-paracetamol', name: 'Paracetamol 500 mg', nameAr: 'باراسيتامول 500 ملغ', concentration: '500 mg', dosageForm: 'Tablet', unit: 'tablet', nationalCode: 'DEMO-002' },
  { id: 'fixture-ceftriaxone', name: 'Ceftriaxone 1 g', nameAr: null, concentration: '1 g', dosageForm: 'Injection powder', unit: 'vial', nationalCode: 'DEMO-003' },
  { id: 'fixture-long', name: 'Sodium chloride sterile solution for intravenous infusion — long material identity', nameAr: 'محلول كلوريد الصوديوم المعقم للتسريب الوريدي — اسم مادة طويل لاختبار القراءة', concentration: '0.9%', dosageForm: 'Solution', unit: 'bottle', nationalCode: 'DEMO-LONG-004' },
];
const caps: ManualCapabilities = { view: true, edit: scenario !== 'readonly', approve: false, manualSet: true, excelImportOpen: false, approveExcludedForRevision: false };
const revision: YearRevision = { id: REVISION, revisionNumber: 1, status: scenario === 'readonly' ? 'approved' : 'draft', sourceMode: 'manual', createdBy: ACTOR };
let events: ManualNeedEvent[] = scenario === 'empty' ? [] : [{
  id: 'fixture-event-1', planRevisionId: REVISION, beneficiaryOrganizationId: BENEFICIARY,
  centralItemId: materials[0].id, targetWarehouseId: null, eventSeq: 1, eventKind: 'add',
  quantityText: '2400.125', approvedUnit: 'capsule', reason: 'Synthetic rendering fixture', reference: null, actorId: ACTOR,
}];
const calls: Array<{ method: string; quantityText?: string; itemId?: string; query?: string }> = [];
let pendingReject: ((reason: Error) => void) | null = null;
let eventReadCount = 0;

interface PrismFixtureControl {
  snapshot(): { calls: typeof calls; events: ManualNeedEvent[]; eventReadCount: number; pending: boolean; scenario: string };
  rejectPending(): void;
}
declare global { interface Window { __prismNeedsFixture: PrismFixtureControl } }
window.__prismNeedsFixture = {
  snapshot: () => ({ calls: [...calls], events: [...events], eventReadCount, pending: pendingReject !== null, scenario }),
  rejectPending: () => { const reject = pendingReject; pendingReject = null; reject?.(new CentralNeedsError('manual_need_line_stale')); },
};

const notExercised = async (): Promise<never> => { throw new Error('Fixture action is outside this rendering scenario'); };
const labels = async (ids: string[]) => materials.filter((m) => ids.includes(m.id)).map((m) => ({ ...m, nationalCode: m.nationalCode ?? null, status: 'active' }));
const api: JourneyApi = {
  features: async () => ({ nationalCode: true, sameActorManual: true, dossiers: true, workbookIntake: false }),
  listBeneficiaries: async () => [{ id: BENEFICIARY, name: 'Test beneficiary institution', nameAr: 'مؤسسة مستفيدة تجريبية' }],
  listYearRevisions: async () => [revision],
  listDossiers: async () => [{ id: DOSSIER, key: 'fixture-essential', name: lang === 'ar' ? 'الأدوية — حزمة تجريبية' : 'Medicines — test dossier', latestRevisionId: REVISION, latestStatus: revision.status, latestNumber: 1, approvedRevisionId: scenario === 'readonly' ? REVISION : null, approvedNumber: scenario === 'readonly' ? 1 : null }],
  listDossierRevisions: async () => [revision],
  annualSummary: async () => [],
  getCaps: async () => caps,
  readCatalogItems: labels,
  searchCatalog: async (query) => {
    calls.push({ method: 'searchCatalog', query });
    if (scenario === 'search-error' || query === 'FAIL') throw new Error('Deliberate fixture search refusal');
    if (scenario === 'empty' || query === 'MISSING') return [];
    if (query === 'all' || query === 'DEMO') return materials;
    const q = query.toLocaleLowerCase();
    return materials.filter((m) => [m.name, m.nameAr, m.nationalCode].some((v) => v?.toLocaleLowerCase().includes(q)));
  },
  resolveForIdentity: async () => [],
  openPlan: notExercised, openCorrection: notExercised, openDossier: notExercised, openDossierCorrection: notExercised,
  readiness: async () => ({ planRevisionId: REVISION, status: 'draft', ready: false, blockers: [{ blocker: 'manual_revision_has_no_lines', detail: null }] }),
  submit: notExercised, approve: notExercised, reject: notExercised,
};

const addFixtureLine = async (scope: ManualScope, quantityText: string, reason: string): Promise<ManualWriteResult> => {
  calls.push({ method: 'addManualNeedLine', quantityText, itemId: scope.centralItemId });
  if (scenario === 'write-error') throw new CentralNeedsError('manual_need_line_stale');
  if (scenario === 'pending') await new Promise<never>((_resolve, reject) => { pendingReject = reject; });
  const eventSeq = events.length + 1;
  const eventId = `fixture-event-${eventSeq}`;
  events = [...events, { id: eventId, ...scope, eventSeq, eventKind: 'add', quantityText,
    approvedUnit: materials.find((m) => m.id === scope.centralItemId)?.unit ?? null, reason, reference: null, actorId: ACTOR }];
  return { eventId, eventSeq, idempotentReplay: false };
};
const workspaceApi: ManualNeedsApi = {
  getManualCapabilities: async () => caps,
  getManualCatalogLabels: labels,
  listManualNeedEvents: async () => { eventReadCount += 1; if (scenario === 'load-error') throw new Error('Deliberate fixture read failure'); return [...events]; },
  addManualNeedLine: addFixtureLine,
  correctManualNeedLine: async () => { calls.push({ method: 'correctManualNeedLine' }); return notExercised(); },
  voidManualNeedLine: async () => { calls.push({ method: 'voidManualNeedLine' }); return notExercised(); },
  newManualIdempotencyKey: () => crypto.randomUUID(),
};
const registrationApi: RegistrationApi = {
  getMaterialCapabilities: async () => ({ canRequest: false, canReview: false, canLink: false }),
  listMaterialRequests: async () => [], listMaterialRequestEvents: async () => [], listMaterialRequestCandidates: async () => [],
  createMaterialRequestDraft: notExercised, updateMaterialRequestDraft: notExercised, submitMaterialRequest: notExercised,
  startMaterialReview: notExercised, requestMaterialInfo: notExercised, resolveMaterialExisting: notExercised,
  approveNewMaterial: notExercised, rejectMaterialRequest: notExercised, cancelMaterialRequest: notExercised,
  linkMaterialRequestToDraft: notExercised, newMaterialIdempotencyKey: () => crypto.randomUUID(),
};
const preview: IdentityPreviewHandle = { state: { phase: 'idle' }, reset: () => undefined, parse: () => { throw new Error('Workbook parsing is outside this rendering fixture'); } };

createRoot(document.getElementById('root')!).render(
  <>
    <aside role="note" data-testid="fixture-banner" style={{ padding: '10px 16px', background: '#fff1bf', color: '#302500', fontSize: 13, borderBottom: '1px solid #bda03e' }}>
      {lang === 'ar' ? 'بيانات اختبار فقط — معاينة المكوّن الحقيقي بخدمات تجريبية؛ لا اتصال بقاعدة بيانات أو حفظ فعلي.' : 'Test data only — real component with service fixtures; no database connection or real persistence.'}
    </aside>
    <main style={{ padding: 'clamp(8px, 2vw, 24px)', minWidth: 0 }}>
      <ManualNeedsJourney lang={lang} organizationId={ORGANIZATION} actorId={ACTOR}
        api={api} workspaceApi={workspaceApi} registrationApi={registrationApi} preview={preview} initialYear={2026} />
    </main>
  </>,
);
