/** TEST ONLY: actual P3-B components and application styles, synthetic in-memory services.
 * This file is outside the production entry graph. It does not connect to a database.
 * Browser evidence establishes rendering/interactions only; native tests prove server authority.
 */
import { createRoot } from 'react-dom/client';
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
import { PrismWorkspace } from '@/shared/ui/prism/PrismWorkspace';
import { AnnualNeedsWorkspace, type AnnualNeedsUiApi } from '@/features/central-needs/annual-catalog/AnnualNeedsWorkspace';
import { ANNUAL_IDENTITY_FIELDS, SOURCE_IDENTITY_FIELDS, type AnnualFieldVersion, type AnnualSourceOccurrence } from '@/features/central-needs/annual-catalog/annual-catalog.contract';
import type { AnnualCatalogItemResult, AnnualCanonicalPreview } from '@/features/central-needs/annual-catalog/annual-catalog-server.contract';
import { editableAnnualFields, type AnnualCatalogChange, type AnnualEditableFields, type AnnualNeedEvent,
  type AnnualNeedBinding, type AnnualNeedWriteInput, type AnnualNeedVoidInput } from '@/features/central-needs/annual-catalog/annual-needs.contract';
import type { ManualNeedsApi } from '@/features/central-needs/manual/ManualNeedsWorkspace';
import type { RegistrationApi } from '@/features/central-needs/manual/MaterialRegistrationPanel';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'ar';
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
document.documentElement.dataset.theme = theme;
const id = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Synthetic IDs only: the managed HTTP preview need not expose secure-context APIs.
let nextSyntheticId = 1000;
const newSyntheticId = () => id(nextSyntheticId++);
const OWNER = id(1), ACTOR = id(2), BENEFICIARY = id(3), REVISION = id(4);
const scope = { ownerOrgId: OWNER, planningYear: 2026 };
const time = '2026-10-31T10:30:00.123456+00:00';
const fingerprint = 'f'.repeat(64);
const caps = { view: true, edit: true, approve: false, manualSet: true, excelImportOpen: false, approveExcludedForRevision: false };
const descriptors: AnnualEditableFields[] = [
  { scientificName: 'Amoxicillin 500 mg', nameAr: 'أموكسيسيلين 500 ملغ', nationalCode: 'DEMO-001', barcode: null, dosageForm: 'Capsules (Oral)', concentration: '500 mg', unit: 'box' },
  { scientificName: 'Ceftriaxone 1 g', nameAr: null, nationalCode: 'DEMO-002', barcode: null, dosageForm: 'Injection powder', concentration: '1 g', unit: 'vial' },
  { scientificName: 'Sodium chloride sterile solution for intravenous infusion', nameAr: 'محلول كلوريد الصوديوم المعقم للتسريب الوريدي — اختبار اسم طويل', nationalCode: 'DEMO-003', barcode: null, dosageForm: 'Solution', concentration: '0.9%', unit: 'bottle' },
];
let catalog: AnnualCatalogItemResult[] = descriptors.map((values, index) => {
  const canonical = id(10 + index), annual = id(20 + index), version = id(30 + index);
  const fields = Object.fromEntries(ANNUAL_IDENTITY_FIELDS.map((field) => [field, values[field] === null
    ? { state: 'missing', reason: 'canonical_missing' }
    : { state: 'known', value: values[field], origins: [{ kind: 'canonical', canonicalItemId: canonical, decisionReference: 'Synthetic registration' }] }])) as AnnualFieldVersion['fields'];
  return { scope, membership: { scope, annualItemId: annual, canonicalItemId: canonical, status: 'active', currentFieldVersionId: version, occurrenceKeys: [] },
    fieldVersion: { scope, annualItemId: annual, fieldVersionId: version, versionNumber: 1, fields },
    canonicalFingerprint: fingerprint, canonicalDrift: false, selectable: true, selectionBlockers: [], sourceOccurrenceCount: 0, sourceAttestation: 'client_attested' };
});
// Synthetic source witnesses only; no original workbook bytes or employee uploader are implied.
const sourceWitnesses: AnnualSourceOccurrence[] = Array.from({ length: 2 }, (_, index) => {
  const values: Partial<Record<typeof SOURCE_IDENTITY_FIELDS[number], string | null>> = {
    ...descriptors[0], currentNationalCode: 'DEMO-001', previousNationalCode: '000-DEMO-OLD',
  };
  const fields = Object.fromEntries(SOURCE_IDENTITY_FIELDS.map((field, column) => {
    const value = values[field];
    if (value === null || value === undefined) return [field, { state: 'missing', reason: 'unmapped', witness: null }];
    const witness = { field,
      cell: { coordinate: { row: index + 1, col: column, a1: `${String.fromCharCode(65 + column)}${index + 2}` }, presence: 'value', valueType: 'string', rawValue: value, isFormula: false, hasComment: false },
      header: { coordinate: { row: 0, col: column, a1: `${String.fromCharCode(65 + column)}1` }, presence: 'value', valueType: 'string', rawValue: field, isFormula: false, hasComment: false },
    };
    if (index === 0 && field === 'concentration') return [field, { state: 'invalid', reason: 'formula', witness: { ...witness,
      cell: { ...witness.cell, valueType: 'number', rawValue: 500, isFormula: true, formula: '250*2' } } }];
    if (index === 1 && field === 'unit') return [field, { state: 'missing', reason: 'blank', witness: { ...witness,
      cell: { coordinate: witness.cell.coordinate, presence: 'blank', rawValue: null, isFormula: false, hasComment: false } } }];
    return [field, { state: 'value', text: value, witness }];
  })) as AnnualSourceOccurrence['fields'];
  return { occurrenceKey: id(500 + index), scope,
    source: { sourceId: id(600 + index), filename: `مصدر_تجريبي_للأدوية_ومقارنة_المعلومات_${index + 1}.xlsx`, sha256: 'a'.repeat(64),
      parser: { contractVersion: '1.2.0', sheetjsVersion: '0.20.3', sheetjsTarballSha256: 'b'.repeat(64), runtime: 'browser_worker' },
      sheetIndex: 0, sheetName: 'أدوية تجريبية', row: index + 1, blockId: 'synthetic-medicines', mappingReference: 'Synthetic mapping — no original file' },
    classification: { label: 'أدوية تجريبية', origin: index === 1 ? 'proposed' : 'source', reference: 'Synthetic classification' }, fields };
});
catalog = catalog.map((item, index) => index === 0 ? { ...item, sourceOccurrenceCount: sourceWitnesses.length,
  membership: { ...item.membership, occurrenceKeys: sourceWitnesses.map((entry) => entry.occurrenceKey) } } : item);
const toBinding = (item: AnnualCatalogItemResult): AnnualNeedBinding => ({ scope, annualItemId: item.membership.annualItemId,
  fieldVersionId: item.fieldVersion.fieldVersionId, versionNumber: item.fieldVersion.versionNumber,
  canonicalItemId: item.membership.canonicalItemId!, fields: item.fieldVersion.fields });
let events: AnnualNeedEvent[] = [{ id: id(40), planRevisionId: REVISION, beneficiaryOrganizationId: BENEFICIARY,
  centralItemId: catalog[0].membership.canonicalItemId!, targetWarehouseId: null, eventSeq: 1, eventKind: 'add', quantityText: '11520',
  approvedUnit: 'box', reason: 'تقدير سنوي تجريبي', reference: null, actorId: ACTOR,
  actorName: 'موظف تجريبي', fromTrustedProfile: true, createdAt: time, annualBinding: toBinding(catalog[0]) }];
const changes = new Map<string, AnnualCatalogChange[]>();
const notExercised = async (): Promise<never> => { throw new Error('Outside this synthetic rendering scenario'); };
const registration: RegistrationApi = {
  getMaterialCapabilities: async () => ({ canRequest: false, canReview: false, canLink: false }),
  listMaterialRequests: async () => [], listMaterialRequestEvents: async () => [], listMaterialRequestCandidates: async () => [],
  createMaterialRequestDraft: notExercised, updateMaterialRequestDraft: notExercised, submitMaterialRequest: notExercised,
  startMaterialReview: notExercised, requestMaterialInfo: notExercised, resolveMaterialExisting: notExercised,
  approveNewMaterial: notExercised, rejectMaterialRequest: notExercised, cancelMaterialRequest: notExercised,
  linkMaterialRequestToDraft: notExercised, newMaterialIdempotencyKey: newSyntheticId,
};
const canonicalPreview = (canonical: string): AnnualCanonicalPreview => {
  const index = catalog.findIndex((item) => item.membership.canonicalItemId === canonical);
  if (index < 0) throw new Error('Synthetic material not found');
  return { scope, canonicalItemId: canonical, canonicalSnapshot: { ...descriptors[index], canonicalItemId: canonical, status: 'active' },
    canonicalFingerprint: fingerprint, eligible: true, missingRequired: [] };
};
async function writeNeed(kind: 'add' | 'correct' | 'void', input: AnnualNeedWriteInput | AnnualNeedVoidInput) {
  const item = catalog.find((row) => row.membership.annualItemId === input.annualItemId)!;
  const previous = events.find((event) => event.id === input.expectedLastEventId);
  const binding = kind === 'void' ? previous!.annualBinding! : toBinding(item);
  const event: AnnualNeedEvent = { ...input.manualScope, id: newSyntheticId(), eventSeq: (previous?.eventSeq ?? 0) + 1,
    eventKind: kind, quantityText: 'quantityText' in input ? input.quantityText : null,
    approvedUnit: kind === 'void' ? null : editableAnnualFields(binding.fields).unit, reason: input.reason, reference: input.reference,
    actorId: ACTOR, actorName: 'موظف تجريبي', fromTrustedProfile: true, createdAt: new Date().toISOString(), annualBinding: binding };
  events = [event, ...events];
  return { scope, planRevisionId: REVISION, idempotentReplay: false, eventId: event.id, eventSeq: event.eventSeq, annualBinding: binding };
}
const annualApi: AnnualNeedsUiApi = {
  listAnnualCatalogYears: async () => ({ ownerOrgId: OWNER, years: [{ planningYear: 2026, status: 'active', createdAt: time }], nextAfterYear: null }),
  openAnnualCatalogYear: notExercised,
  previewAnnualCanonical: async (_scope, canonical) => canonicalPreview(canonical),
  searchAnnualCatalogForNeeds: async (_scope, query) => ({ scope, items: catalog.filter((item) => {
    const fields = editableAnnualFields(item.fieldVersion.fields);
    return [fields.scientificName, fields.nameAr, fields.nationalCode].some((value) => value?.toLowerCase().includes(query.toLowerCase()));
  }), nextCursor: null }),
  getAnnualCatalogItemForNeeds: async (_scope, annual) => structuredClone(catalog.find((item) => item.membership.annualItemId === annual)!),
  addAnnualCatalogItemForNeeds: notExercised, refreshAnnualCatalogItemForNeeds: notExercised,
  completeAnnualMaterialRequestForNeeds: notExercised,
  editAnnualCatalogItem: async (input) => {
    const index = catalog.findIndex((row) => row.membership.annualItemId === input.annualItemId);
    const before = catalog[index], version = newSyntheticId();
    if (before.fieldVersion.fieldVersionId !== input.expectedFieldVersionId) throw new Error('Synthetic stale version');
    const oldValues = editableAnnualFields(before.fieldVersion.fields);
    const fields = Object.fromEntries(ANNUAL_IDENTITY_FIELDS.map((field) => [field, oldValues[field] === input.fields[field]
      ? before.fieldVersion.fields[field] : input.fields[field] === null
        ? { state: 'missing', reason: 'annual_correction_missing' }
        : { state: 'known', value: input.fields[field], origins: [{ kind: 'manual', decisionReference: version }] }])) as AnnualFieldVersion['fields'];
    const review = ANNUAL_IDENTITY_FIELDS.filter((field) => field !== 'nameAr' && input.fields[field] !== descriptors[index][field]);
    const next: AnnualCatalogItemResult = { ...before, membership: { ...before.membership, currentFieldVersionId: version, status: review.length ? 'preparing' : 'active' },
      fieldVersion: { ...before.fieldVersion, fieldVersionId: version, versionNumber: before.fieldVersion.versionNumber + 1, fields },
      selectable: review.length === 0, selectionBlockers: review.length ? ['member_preparing'] : [] };
    const change: AnnualCatalogChange = { changeId: version, fromFieldVersionId: before.fieldVersion.fieldVersionId, toFieldVersionId: version,
      actorId: ACTOR, actorName: 'موظف تجريبي', fromTrustedProfile: true, createdAt: new Date().toISOString(), reason: input.reason,
      beforeFields: oldValues, afterFields: input.fields, requiresLegalReview: review };
    catalog = catalog.map((item, i) => i === index ? next : item);
    changes.set(input.annualItemId, [change, ...(changes.get(input.annualItemId) ?? [])]);
    return { ...next, idempotentReplay: false, change };
  },
  listAnnualCatalogChanges: async (_scope, annualItemId) => ({ scope, annualItemId, changes: changes.get(annualItemId) ?? [], nextAfterChangeId: null }),
  listAnnualCatalogOccurrences: async (target, annualItemId, limit = 25, after = null) => {
    if (target.ownerOrgId !== OWNER || target.planningYear !== 2026) throw new Error('Outside synthetic source scope');
    const remaining = (annualItemId === catalog[0].membership.annualItemId ? sourceWitnesses : []).filter((entry) => after === null || entry.occurrenceKey > after);
    const occurrences = remaining.slice(0, limit);
    return { scope, annualItemId, occurrences: structuredClone(occurrences),
      nextAfterOccurrenceId: remaining.length > limit ? occurrences[occurrences.length - 1].occurrenceKey : null, attestation: 'client_attested' };
  },
  createAnnualRegistrationApi: () => registration,
  listAnnualNeedEvents: async () => structuredClone(events),
  addAnnualNeedLine: (input) => writeNeed('add', input),
  correctAnnualNeedLine: (input) => writeNeed('correct', input),
  voidAnnualNeedLine: (input) => writeNeed('void', input),
};
const manualApi: ManualNeedsApi = { getManualCapabilities: async () => caps, listManualNeedEvents: async () => events,
  newManualIdempotencyKey: newSyntheticId, addManualNeedLine: notExercised, correctManualNeedLine: notExercised, voidManualNeedLine: notExercised };
const width = params.get('viewport');
const embedded = new URL(location.href); embedded.searchParams.delete('viewport');
if (width === '390') {
  createRoot(document.getElementById('root')!).render(<main style={{ padding: 16 }}>
    <p>390 px viewport · actual responsive component · synthetic data</p>
    <iframe title="Annual needs mobile viewport" src={embedded.href} style={{ width: 390, height: 1300, border: '1px solid #92a8bd', display: 'block', margin: 'auto' }} />
  </main>);
} else {
  createRoot(document.getElementById('root')!).render(<>
    <aside role="note" style={{ background: '#fff1bf', color: '#302500', padding: 10, fontSize: 13 }}>
      {lang === 'ar' ? 'بيانات اختبار فقط — المكوّن الفعلي بخدمات تجريبية محلية؛ لا حفظ في قاعدة البيانات.' : 'Test data only — actual components, in-memory services; no database persistence.'}
    </aside>
    <main style={{ padding: 'clamp(8px, 2vw, 24px)', minWidth: 0 }}>
      <PrismWorkspace lang={lang} headingId="annual-title" title={lang === 'ar' ? 'الاحتياج والتحصيص — فهرس السنة' : 'Annual needs — yearly catalog'}
        description={lang === 'ar' ? 'البحث عن المواد وتوثيق تعديلاتها وإعداد الاحتياج السنوي' : 'Find materials, record attributed edits and prepare annual quantities'} context={<bdi>2026 · DEMO</bdi>}>
        <AnnualNeedsWorkspace lang={lang} scope={scope} actorId={ACTOR} revision={{ id: REVISION, revisionNumber: 1, status: 'draft', sourceMode: 'manual', createdBy: ACTOR }}
          capabilities={caps} beneficiaries={[{ id: BENEFICIARY, name: 'Demo beneficiary', nameAr: 'مؤسسة مستفيدة تجريبية' }]}
          searchRegisteredMaterials={async () => []} nationalCodeEnabled sameActorEnabled api={annualApi} manualApi={manualApi} />
      </PrismWorkspace>
    </main>
  </>);
}
