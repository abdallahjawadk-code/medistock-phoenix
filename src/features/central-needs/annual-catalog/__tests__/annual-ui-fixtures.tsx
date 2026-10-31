import { vi } from 'vitest';
import type { ManualCapabilities } from '../../manual/manual-needs.service';
import type { MaterialRequest } from '../../manual/material-registration.service';
import { SOURCE_IDENTITY_FIELDS, type AnnualFieldState, type AnnualSourceOccurrence } from '../annual-catalog.contract';
import type { AnnualCatalogItemResult } from '../annual-catalog-server.contract';
import { editableAnnualFields, type AnnualCatalogChange, type AnnualNeedBinding, type AnnualNeedEvent, type AnnualNeedWriteInput, type EditAnnualCatalogItemInput } from '../annual-needs.contract';
import { realAnnualNeedsUiApi, type AnnualNeedsUiApi } from '../AnnualNeedsWorkspace';

export const ID = {
  owner: '10000000-0000-4000-8000-000000000001', beneficiary: '20000000-0000-4000-8000-000000000001',
  otherBeneficiary: '20000000-0000-4000-8000-000000000002', canonical: '30000000-0000-4000-8000-000000000001',
  annual: '40000000-0000-4000-8000-000000000001', version: '50000000-0000-4000-8000-000000000001',
  nextVersion: '50000000-0000-4000-8000-000000000002', revision: '60000000-0000-4000-8000-000000000001',
  actor: '70000000-0000-4000-8000-000000000001', event: '80000000-0000-4000-8000-000000000001',
  request: '90000000-0000-4000-8000-000000000001', change: 'a0000000-0000-4000-8000-000000000001',
};
export const SCOPE = { ownerOrgId: ID.owner, planningYear: 2026 };
export const CAPS: ManualCapabilities = { view: true, edit: true, manualSet: true, approve: false, approveExcludedForRevision: false, excelImportOpen: true };
const known = (value: string): AnnualFieldState => ({ state: 'known', value, origins: [{ kind: 'canonical', canonicalItemId: ID.canonical, decisionReference: 'registered' }] });
export function annualItem(): AnnualCatalogItemResult {
  return {
    scope: SCOPE,
    membership: { scope: SCOPE, annualItemId: ID.annual, canonicalItemId: ID.canonical, currentFieldVersionId: ID.version, status: 'active', occurrenceKeys: [] },
    fieldVersion: { scope: SCOPE, annualItemId: ID.annual, fieldVersionId: ID.version, versionNumber: 1,
      fields: { scientificName: known('Amoxicillin'), nameAr: known('أموكسيسيلين'), nationalCode: known('00012-A'), barcode: known('1234'),
        concentration: known('500 mg'), dosageForm: known('Capsules'), unit: known('box') } },
    canonicalFingerprint: 'a'.repeat(64), canonicalDrift: false, selectable: true, selectionBlockers: [], sourceOccurrenceCount: 0,
    sourceAttestation: 'client_attested',
  };
}
export const binding = (item = annualItem()): AnnualNeedBinding => ({ ...item.fieldVersion, canonicalItemId: ID.canonical });
export const change = (): AnnualCatalogChange => ({ changeId: ID.change, fromFieldVersionId: ID.version, toFieldVersionId: ID.nextVersion,
  actorId: ID.actor, actorName: 'Employee recorded by server', fromTrustedProfile: true, createdAt: '2026-10-31T09:15:00Z', reason: 'Corrected the annual display name',
  beforeFields: editableAnnualFields(annualItem().fieldVersion.fields), afterFields: { ...editableAnnualFields(annualItem().fieldVersion.fields), nameAr: 'اسم مصحح' }, requiresLegalReview: [] });

export function sourceOccurrence(index = 1): AnnualSourceOccurrence {
  const text: Record<string, string> = { scientificName: 'Amoxicillin', nationalCode: '00012-A', currentNationalCode: '00012-A', previousNationalCode: '00007-A' };
  const fields = Object.fromEntries(SOURCE_IDENTITY_FIELDS.map((field, column) => [field, text[field] === undefined
    ? { state: 'missing', reason: 'unmapped', witness: null }
    : { state: 'value', text: text[field], witness: { field,
      cell: { coordinate: { row: index, col: column, a1: `${String.fromCharCode(65 + column)}${index + 1}` }, presence: 'value', valueType: 'string', rawValue: text[field], isFormula: false, hasComment: false },
      header: { coordinate: { row: 0, col: column, a1: `${String.fromCharCode(65 + column)}1` }, presence: 'value', valueType: 'string', rawValue: field, isFormula: false, hasComment: false } } }])) as AnnualSourceOccurrence['fields'];
  return { occurrenceKey: `b0000000-0000-4000-8000-${String(index).padStart(12, '0')}`, scope: SCOPE,
    source: { sourceId: `c0000000-0000-4000-8000-${String(index).padStart(12, '0')}`, filename: `synthetic-source-${index}.xlsx`, sha256: 'b'.repeat(64),
      parser: { contractVersion: '1.2.0', sheetjsVersion: '0.20.3', sheetjsTarballSha256: 'c'.repeat(64), runtime: 'browser_worker' },
      sheetIndex: 0, sheetName: 'مواد تجريبية', row: index, blockId: 'synthetic-block', mappingReference: 'synthetic-mapping' },
    classification: { label: 'Synthetic medicines', origin: 'source', reference: 'synthetic-heading' }, fields };
}

export function annualFixture() {
  const state = { item: annualItem(), events: [] as AnnualNeedEvent[], changes: [] as AnnualCatalogChange[], requests: [] as MaterialRequest[], yearExists: true };
  const registrationApi = {
    ...realAnnualNeedsUiApi.createAnnualRegistrationApi(SCOPE),
    getMaterialCapabilities: vi.fn(async () => ({ canRequest: true, canReview: false, canLink: true })),
    listMaterialRequests: vi.fn(async () => state.requests), listMaterialRequestEvents: vi.fn(async () => []),
    listMaterialRequestCandidates: vi.fn(async () => []),
    createMaterialRequestDraft: vi.fn(async () => ({ requestId: ID.request, status: 'draft' as const, version: 1, idempotentReplay: false })),
    newMaterialIdempotencyKey: vi.fn(() => 'request-intent-0001'),
  };
  const saveNeed = async (input: AnnualNeedWriteInput) => {
    const itemBinding = binding(state.item);
    const event: AnnualNeedEvent = { id: ID.event, planRevisionId: input.manualScope.planRevisionId,
      beneficiaryOrganizationId: input.manualScope.beneficiaryOrganizationId, centralItemId: input.manualScope.centralItemId,
      targetWarehouseId: null, eventKind: 'add', eventSeq: 1, quantityText: input.quantityText, approvedUnit: 'box', reason: input.reason,
      reference: null, actorId: ID.actor, actorName: 'Employee recorded by server', fromTrustedProfile: true,
      createdAt: '2026-10-31T09:15:00Z', annualBinding: itemBinding };
    state.events = [event];
    return { scope: SCOPE, planRevisionId: ID.revision, eventId: event.id, eventSeq: event.eventSeq, idempotentReplay: false, annualBinding: itemBinding };
  };
  const api: AnnualNeedsUiApi = {
    ...realAnnualNeedsUiApi,
    listAnnualCatalogYears: vi.fn(async () => ({ ownerOrgId: ID.owner, years: state.yearExists ? [{ planningYear: 2026, status: 'active' as const, createdAt: '2026-01-01T00:00:00Z' }] : [], nextAfterYear: null })),
    openAnnualCatalogYear: vi.fn(async () => { state.yearExists = true; return { scope: SCOPE, year: { planningYear: 2026, status: 'active' as const, createdAt: '2026-10-31T09:15:00Z' }, idempotentReplay: false }; }),
    searchAnnualCatalogForNeeds: vi.fn(async () => ({ scope: SCOPE, items: [state.item], nextCursor: null })),
    getAnnualCatalogItemForNeeds: vi.fn(async () => state.item),
    previewAnnualCanonical: vi.fn(async () => ({ scope: SCOPE, canonicalItemId: ID.canonical,
      canonicalSnapshot: { canonicalItemId: ID.canonical, scientificName: 'Amoxicillin', nameAr: 'أموكسيسيلين', nationalCode: '00012-A', barcode: '1234', dosageForm: 'Capsules', concentration: '500 mg', unit: 'box', status: 'active' },
      canonicalFingerprint: 'a'.repeat(64), eligible: true, missingRequired: [] })),
    addAnnualCatalogItemForNeeds: vi.fn(async () => ({ ...state.item, idempotentReplay: false })),
    refreshAnnualCatalogItemForNeeds: vi.fn(async () => ({ ...state.item, idempotentReplay: false })),
    completeAnnualMaterialRequestForNeeds: vi.fn(async () => ({ ...state.item, requestId: ID.request, idempotentReplay: false })),
    editAnnualCatalogItem: vi.fn(async (input: EditAnnualCatalogItemInput) => {
      const audit = { ...change(), reason: input.reason, beforeFields: editableAnnualFields(state.item.fieldVersion.fields), afterFields: input.fields };
      state.changes = [audit];
      state.item = { ...state.item, membership: { ...state.item.membership, currentFieldVersionId: ID.nextVersion },
        fieldVersion: { ...state.item.fieldVersion, fieldVersionId: ID.nextVersion, versionNumber: 2,
          fields: Object.fromEntries(Object.entries(input.fields).map(([key, value]) => [key, value === null ? { state: 'missing', reason: 'manual_missing' } : known(value)])) as AnnualCatalogItemResult['fieldVersion']['fields'] } };
      return { ...state.item, idempotentReplay: false, change: audit };
    }),
    listAnnualCatalogChanges: vi.fn(async () => ({ scope: SCOPE, annualItemId: ID.annual, changes: state.changes, nextAfterChangeId: null })),
    listAnnualCatalogOccurrences: vi.fn(async (scope, annualItemId) => ({ scope, annualItemId, occurrences: [], nextAfterOccurrenceId: null, attestation: 'client_attested' as const })),
    createAnnualRegistrationApi: vi.fn(() => registrationApi),
    listAnnualNeedEvents: vi.fn(async () => state.events),
    addAnnualNeedLine: vi.fn(saveNeed), correctAnnualNeedLine: vi.fn(saveNeed),
    voidAnnualNeedLine: vi.fn(async () => ({ scope: SCOPE, planRevisionId: ID.revision, eventId: ID.event, eventSeq: 2, idempotentReplay: false, annualBinding: binding() })),
  };
  const manualApi = {
    getManualCapabilities: vi.fn(async () => CAPS),
    getManualCatalogLabels: vi.fn(async () => [{ id: ID.canonical, name: 'Current registered label', nameAr: 'الاسم القانوني الحالي', unit: 'box', nationalCode: '00012-A', dosageForm: 'Capsules', concentration: '500 mg', status: 'active' }]),
    listManualNeedEvents: vi.fn(async () => { throw new Error('legacy events used in annual mode'); }),
    addManualNeedLine: vi.fn(async () => { throw new Error('legacy writer used in annual mode'); }),
    correctManualNeedLine: vi.fn(async () => { throw new Error('legacy writer used in annual mode'); }),
    voidManualNeedLine: vi.fn(async () => { throw new Error('legacy writer used in annual mode'); }),
    newManualIdempotencyKey: vi.fn(() => 'annual-intent-0001'),
  };
  return { state, api, manualApi, registrationApi };
}
