import { beforeEach, describe, expect, it, vi } from 'vitest';
const { mockRpc, mockFrom } = vi.hoisted(() => ({ mockRpc: vi.fn(), mockFrom: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: mockRpc, from: mockFrom } }));
import { ANNUAL_IDENTITY_FIELDS, type AnnualCatalogScope, type AnnualFieldVersion } from '../annual-catalog.contract';
import { AnnualCatalogContractError, validateAnnualCatalogItem, type AnnualCatalogItemResult } from '../annual-catalog-server.contract';
import {
  editableAnnualFields, validateAnnualCatalogChange, type AnnualCatalogChange, type AnnualEditableFields,
  type AnnualNeedBinding, type AnnualNeedEvent, type AnnualNeedWriteInput, type EditAnnualCatalogItemInput,
} from '../annual-needs.contract';
import {
  addAnnualNeedLine, completeAnnualMaterialRequestForNeeds, correctAnnualNeedLine, createAnnualRegistrationApi,
  editAnnualCatalogItem, getAnnualCatalogItemForNeeds, getAnnualNeedsContract, listAnnualCatalogChanges,
  listAnnualMaterialRequests, listAnnualNeedEvents, searchAnnualCatalogForNeeds, voidAnnualNeedLine,
} from '../annual-needs.service';
import { foldManualEvents } from '../../manual/manual-needs.view-model';
import { readAnnualNeeds } from '../../manual/dossier.service';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNER = id(1); const ANNUAL = id(2); const CANONICAL = id(3); const VERSION = id(4); const NEW_VERSION = id(5);
const ACTOR = id(6); const REVISION = id(7); const BENEFICIARY = id(8); const EVENT = id(9); const REQUEST = id(10);
const SCOPE: AnnualCatalogScope = { ownerOrgId: OWNER, planningYear: 2026 };
const FP = 'a'.repeat(64); const KEY = 'p3b-intent-001'; const REASON = 'تصحيح الاسم وفق الدليل';
const TIME = '2026-10-31T12:00:00.123456+00:00';
const ok = (data: unknown) => ({ data, error: null });
const contract = () => ({ version: 1, quantityBinding: true, annualEdits: true, actorSnapshots: true,
  scope: 'owner_year', editPolicy: 'annual_snapshot_with_legal_review' });
const flat = (): AnnualEditableFields => ({ scientificName: 'Amoxicillin', nameAr: null, nationalCode: '000123-01',
  barcode: null, dosageForm: 'Capsules', concentration: '500 mg', unit: 'box' });
function item(): AnnualCatalogItemResult {
  const fields = Object.fromEntries(ANNUAL_IDENTITY_FIELDS.map((field) => [field, flat()[field] === null
    ? { state: 'missing', reason: 'canonical_missing' }
    : { state: 'known', value: flat()[field], origins: [{ kind: 'canonical', canonicalItemId: CANONICAL, decisionReference: 'Reviewed registration' }] }])) as AnnualFieldVersion['fields'];
  return { scope: { ...SCOPE }, membership: { scope: { ...SCOPE }, annualItemId: ANNUAL, canonicalItemId: CANONICAL,
    status: 'active', currentFieldVersionId: VERSION, occurrenceKeys: [] }, fieldVersion: { scope: { ...SCOPE },
    annualItemId: ANNUAL, fieldVersionId: VERSION, versionNumber: 1, fields }, canonicalFingerprint: FP,
  canonicalDrift: false, selectable: true, selectionBlockers: [], sourceOccurrenceCount: 0, sourceAttestation: 'client_attested' };
}
const editInput = (): EditAnnualCatalogItemInput => ({ scope: { ...SCOPE }, annualItemId: ANNUAL,
  expectedFieldVersionId: VERSION, expectedCanonicalFingerprint: FP, fields: { ...flat(), nameAr: 'أموكسيسيلين' }, reason: REASON, idempotencyKey: KEY });
function edited() {
  const previous = item();
  const next = { ...previous, membership: { ...previous.membership, currentFieldVersionId: NEW_VERSION },
    fieldVersion: { ...previous.fieldVersion, fieldVersionId: NEW_VERSION, versionNumber: 2, fields: { ...previous.fieldVersion.fields,
      nameAr: { state: 'known' as const, value: 'أموكسيسيلين', origins: [{ kind: 'manual' as const, decisionReference: NEW_VERSION }] } } } };
  const change: AnnualCatalogChange = { changeId: NEW_VERSION, fromFieldVersionId: VERSION, toFieldVersionId: NEW_VERSION,
    actorId: ACTOR, actorName: 'موظف الاختبار', fromTrustedProfile: true, createdAt: TIME, reason: REASON,
    beforeFields: flat(), afterFields: { ...flat(), nameAr: 'أموكسيسيلين' }, requiresLegalReview: [] };
  return { ...next, idempotentReplay: false, change };
}
const binding = (): AnnualNeedBinding => ({ scope: { ...SCOPE }, annualItemId: ANNUAL, fieldVersionId: VERSION,
  versionNumber: 1, canonicalItemId: CANONICAL, fields: item().fieldVersion.fields });
const writeInput = (): AnnualNeedWriteInput => ({ scope: { ...SCOPE }, manualScope: { planRevisionId: REVISION,
  beneficiaryOrganizationId: BENEFICIARY, centralItemId: CANONICAL, targetWarehouseId: null }, annualItemId: ANNUAL,
fieldVersionId: VERSION, quantityText: '9007199254740993.0000001', reason: REASON, idempotencyKey: KEY,
expectedLastEventId: null, reference: null });
const writeResult = () => ({ scope: { ...SCOPE }, planRevisionId: REVISION, eventId: EVENT, eventSeq: 1,
  idempotentReplay: false, annualBinding: binding() });
const event = (overrides: Partial<AnnualNeedEvent> = {}): AnnualNeedEvent => ({ id: EVENT, planRevisionId: REVISION,
  beneficiaryOrganizationId: BENEFICIARY, centralItemId: CANONICAL, targetWarehouseId: null, eventSeq: 1, eventKind: 'add',
  quantityText: '9', approvedUnit: 'box', reason: REASON, reference: null, actorId: ACTOR, actorName: 'موظف الاختبار',
  fromTrustedProfile: true, createdAt: TIME, annualBinding: binding(), ...overrides });
const page = (events: AnnualNeedEvent[], nextAfterEventId: string | null = null) => ({ scope: { ...SCOPE }, planRevisionId: REVISION, events, nextAfterEventId });
const materialRequest = () => ({ id: REQUEST, organizationId: OWNER, requesterId: ACTOR, status: 'draft', version: 1,
  scientificName: 'Amoxicillin', nameAr: null, tradeName: null, strength: '500 mg', dosageForm: 'Capsules', unit: 'box',
  barcode: null, nationalCode: '000123-01', note: null, provenanceKind: 'manual_typed', reviewerId: null,
  resolvedItemId: null, decisionReason: null, createdAt: TIME });
beforeEach(() => vi.resetAllMocks());

describe('approved annual summary preserves the used material version', () => {
  const summary = () => ({ dossier_id: id(41), dossier_name: 'احتياج الأدوية', revision_id: REVISION,
    beneficiary_id: BENEFICIARY, item_id: CANONICAL, name: flat().scientificName, name_ar: flat().nameAr,
    national_code: flat().nationalCode, quantity_text: '9.0000000', unit: 'box', warehouse_id: null });
  it('reads the frozen version and exact quantity text without a current catalog lookup', async () => {
    mockRpc.mockResolvedValue(ok([{ ...summary(), annual_binding: binding(), identity_source: 'annual_version' }]));
    expect(await readAnnualNeeds(OWNER, 2026)).toEqual([expect.objectContaining({ annualBinding: binding(),
      identitySource: 'annual_version', name: 'Amoxicillin', quantityText: '9.0000000' })]);
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_annual_summary',
      { p_organization_id: OWNER, p_plan_year: 2026 });
    expect(mockFrom).not.toHaveBeenCalled();
  });
  it('preserves legacy rows without fabricating annual snapshots', async () => {
    mockRpc.mockResolvedValue(ok([summary()]));
    const [old] = await readAnnualNeeds(OWNER, 2026);
    expect(old).not.toHaveProperty('annualBinding');
    mockRpc.mockResolvedValue(ok([{ ...summary(), annual_binding: null, identity_source: 'legacy_current_canonical' }]));
    expect(await readAnnualNeeds(OWNER, 2026)).toEqual([expect.objectContaining({ annualBinding: null,
      identitySource: 'legacy_current_canonical' })]);
  });
  it.each([
    () => ({ annual_binding: binding(), identity_source: 'legacy_current_canonical' }),
    () => ({ annual_binding: null, identity_source: 'annual_version' }),
    () => ({ annual_binding: binding() }),
    () => ({ annual_binding: { ...binding(), scope: { ...SCOPE, planningYear: 2027 } }, identity_source: 'annual_version' }),
    () => ({ annual_binding: { ...binding(), canonicalItemId: id(42) }, identity_source: 'annual_version' }),
    () => ({ annual_binding: binding(), identity_source: 'annual_version', name_ar: 'اسم حالي غير مثبت' }),
    () => ({ annual_binding: binding(), identity_source: 'annual_version', unit: 'vial' }),
  ])('rejects an inconsistent report or foreign annual reference', async (change) => {
    mockRpc.mockResolvedValue(ok([{ ...summary(), ...change() }]));
    await expect(readAnnualNeeds(OWNER, 2026)).rejects.toBeInstanceOf(AnnualCatalogContractError);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('capability and annual read boundaries', () => {
  it('only an exact missing capability permits the existing journey', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find phoenix_central_needs_annual_needs_contract' } });
    expect(await getAnnualNeedsContract()).toBeNull();
    mockRpc.mockResolvedValue(ok(contract()));
    expect(await getAnnualNeedsContract()).toEqual(contract());
  });
  it.each([
    { code: 'PGRST202', message: 'Could not find another_function' },
    { code: '42501', message: 'forbidden_central_needs' },
    { code: '', message: 'Failed to fetch' },
  ])('does not turn denial, other missing resources or transport into legacy mode', async (error) => {
    mockRpc.mockResolvedValue({ data: null, error });
    await expect(getAnnualNeedsContract()).rejects.toThrow();
    expect(mockRpc).toHaveBeenCalledTimes(1); expect(mockFrom).not.toHaveBeenCalled();
  });
  it.each([null, {}, { ...contract(), quantityBinding: false }, { ...contract(), actorSnapshots: false },
    { ...contract(), editPolicy: 'anything' }])('rejects an incomplete advertised capability', async (data) => {
    mockRpc.mockResolvedValue(ok(data));
    await expect(getAnnualNeedsContract()).rejects.toBeInstanceOf(AnnualCatalogContractError);
  });
  it('accepts truthful annual edits only in the explicit P3-B reader; A1 stays strict', async () => {
    const next = edited();
    Reflect.deleteProperty(next, 'change');
    Reflect.deleteProperty(next, 'idempotentReplay');
    mockRpc.mockResolvedValue(ok(next));
    expect((await getAnnualCatalogItemForNeeds(SCOPE, ANNUAL)).fieldVersion.fields.nameAr).toMatchObject({ value: 'أموكسيسيلين' });
    expect(() => validateAnnualCatalogItem(next, SCOPE)).toThrow('origin');
    expect(mockFrom).not.toHaveBeenCalled();
  });
  it('keeps an unselectable identity proposal visible rather than replacing it with global search', async () => {
    const next = item(); next.membership.status = 'preparing'; next.selectable = false;
    next.selectionBlockers = ['annual_identity_requires_legal_review'];
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, items: [next], nextCursor: null }));
    expect((await searchAnnualCatalogForNeeds(SCOPE, '000123-01')).items[0].selectable).toBe(false);
    expect(mockRpc).toHaveBeenCalledTimes(1); expect(mockFrom).not.toHaveBeenCalled();
  });
  it('refuses a foreign year and a foreign cursor', async () => {
    mockRpc.mockResolvedValue(ok({ scope: { ...SCOPE, planningYear: 2027 }, items: [], nextCursor: null }));
    await expect(searchAnnualCatalogForNeeds(SCOPE, '')).rejects.toThrow('scope.mismatch');
    mockRpc.mockReset();
    await expect(searchAnnualCatalogForNeeds(SCOPE, '', 25, { ...SCOPE, planningYear: 2027, query: '', rank: 1, annualItemId: ANNUAL })).rejects.toThrow();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('attributed corrections and unknown outcomes', () => {
  it('sends seven fields, reason and CAS fences, never an actor name or time', async () => {
    mockRpc.mockResolvedValue(ok(edited()));
    const result = await editAnnualCatalogItem(editInput());
    expect(result.change.actorName).toBe('موظف الاختبار');
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_edit_annual_catalog_item', {
      p_organization_id: OWNER, p_planning_year: 2026, p_annual_item_id: ANNUAL,
      p_expected_field_version_id: VERSION, p_expected_canonical_fingerprint: FP,
      p_fields: editInput().fields, p_reason: REASON, p_idempotency_key: KEY,
    });
  });
  it.each([
    (input: EditAnnualCatalogItemInput) => ({ ...input, actorName: 'Spoofed employee' }),
    (input: EditAnnualCatalogItemInput) => ({ ...input, createdAt: TIME }),
    (input: EditAnnualCatalogItemInput) => ({ ...input, reason: '\u00a0\ufeff' }),
    (input: EditAnnualCatalogItemInput) => ({ ...input, fields: { ...input.fields, unit: 'carton' } }),
    (input: EditAnnualCatalogItemInput) => ({ ...input, fields: { ...input.fields, nationalCode: ' ' } }),
    (input: EditAnnualCatalogItemInput) => ({ ...input, fields: { ...input.fields, nationalCode: 'bad\u0000value' } }),
  ])('rejects spoofed attribution or invalid edits before I/O', async (mutate) => {
    await expect(editAnnualCatalogItem(mutate(editInput()) as EditAnnualCatalogItemInput)).rejects.toMatchObject({ code: 'annual_catalog_invalid_input' });
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it.each([
    (result: ReturnType<typeof edited>) => { result.change.actorName = null; result.change.fromTrustedProfile = false; },
    (result: ReturnType<typeof edited>) => { result.change.reason = 'different intent'; },
    (result: ReturnType<typeof edited>) => { result.change.fromFieldVersionId = id(99); },
    (result: ReturnType<typeof edited>) => { result.change.afterFields.nameAr = 'different'; },
    (result: ReturnType<typeof edited>) => { result.change.requiresLegalReview = ['unit']; },
  ])('does not report a mismatched acknowledgement as confirmed success', async (mutate) => {
    const result = edited(); mutate(result); mockRpc.mockResolvedValue(ok(result));
    await expect(editAnnualCatalogItem(editInput())).rejects.toMatchObject({ outcomeUnknown: true });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
  it('preserves an ambiguous write failure for exact-intent reconciliation without auto-retry', async () => {
    mockRpc.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(editAnnualCatalogItem(editInput())).rejects.toMatchObject({ businessCode: 'central_needs_request_failed', sqlstate: null });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
  it('accepts an exact replay only when it is explicitly unselectable until a fresh read', async () => {
    mockRpc.mockResolvedValue(ok({ ...edited(), idempotentReplay: true, selectable: false, selectionBlockers: ['receipt_replay_requires_refresh'] }));
    expect((await editAnnualCatalogItem(editInput())).idempotentReplay).toBe(true);
    mockRpc.mockResolvedValue(ok({ ...edited(), idempotentReplay: true }));
    await expect(editAnnualCatalogItem(editInput())).rejects.toMatchObject({ outcomeUnknown: true });
  });
  it('keeps old unknown employee names honest and permits a provenance-only historical refresh', () => {
    const record = { ...edited().change, actorName: null, fromTrustedProfile: false, afterFields: flat() };
    expect(validateAnnualCatalogChange(record)).toEqual(record);
    expect(() => validateAnnualCatalogChange({ ...record, fromTrustedProfile: true })).toThrow('actorSource');
    expect(() => validateAnnualCatalogChange({ ...record, changeId: id(88) })).toThrow('change.version');
  });
  it('validates descending microsecond history rather than collapsing it to milliseconds', async () => {
    const first = edited().change; const second = { ...first, changeId: id(100), toFieldVersionId: id(100), createdAt: '2026-10-31T12:00:00.123455+00:00' };
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, annualItemId: ANNUAL, changes: [first, second], nextAfterChangeId: second.changeId }));
    expect((await listAnnualCatalogChanges(SCOPE, ANNUAL)).changes).toHaveLength(2);
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, annualItemId: ANNUAL, changes: [second, first], nextAfterChangeId: null }));
    await expect(listAnnualCatalogChanges(SCOPE, ANNUAL)).rejects.toThrow('order');
  });
});

describe('atomic annual need transport and history', () => {
  it('passes precise quantity text and both references to a single existing-writer wrapper', async () => {
    mockRpc.mockResolvedValue(ok(writeResult()));
    await addAnnualNeedLine(writeInput());
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_add_annual_need_line', {
      p_organization_id: OWNER, p_planning_year: 2026, p_plan_revision_id: REVISION, p_beneficiary_organization_id: BENEFICIARY,
      p_central_item_id: CANONICAL, p_target_warehouse_id: null, p_annual_item_id: ANNUAL, p_field_version_id: VERSION,
      p_quantity_text: '9007199254740993.0000001', p_reason: REASON, p_idempotency_key: KEY,
      p_expected_last_event_id: null, p_reference: null,
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });
  it('correct and void preserve explicit prior-event fences; void sends no quantity', async () => {
    mockRpc.mockResolvedValue(ok(writeResult()));
    await correctAnnualNeedLine({ ...writeInput(), expectedLastEventId: id(11) });
    const cancel = writeInput();
    Reflect.deleteProperty(cancel, 'quantityText');
    await voidAnnualNeedLine({ ...cancel, expectedLastEventId: id(11) });
    expect(mockRpc.mock.calls[0][0]).toBe('phoenix_central_needs_correct_annual_need_line');
    expect(mockRpc.mock.calls[1][0]).toBe('phoenix_central_needs_void_annual_need_line');
    expect(mockRpc.mock.calls[1][1]).not.toHaveProperty('p_quantity_text');
    expect(mockRpc.mock.calls[1][1]).toHaveProperty('p_field_version_id', VERSION);
  });
  it.each(['', '01', '1e3', '-1', '٣', '1.0'])('refuses invalid quantity %j before any request', async (quantityText) => {
    await expect(addAnnualNeedLine({ ...writeInput(), quantityText })).rejects.toMatchObject({ code: 'annual_catalog_invalid_input' });
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('requires the beneficiary and expected event for corrections', async () => {
    await expect(addAnnualNeedLine({ ...writeInput(), manualScope: { ...writeInput().manualScope, beneficiaryOrganizationId: '' } })).rejects.toThrow();
    await expect(correctAnnualNeedLine(writeInput())).rejects.toThrow('expectedEvent');
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it.each([
    (result: ReturnType<typeof writeResult>) => { result.annualBinding.scope.planningYear = 2027; },
    (result: ReturnType<typeof writeResult>) => { result.annualBinding.fieldVersionId = NEW_VERSION; },
    (result: ReturnType<typeof writeResult>) => { result.annualBinding.canonicalItemId = id(99); },
    (result: ReturnType<typeof writeResult>) => { result.planRevisionId = id(99); },
  ])('keeps a foreign or changed binding acknowledgement unresolved', async (mutate) => {
    const result = writeResult(); mutate(result); mockRpc.mockResolvedValue(ok(result));
    await expect(addAnnualNeedLine(writeInput())).rejects.toMatchObject({ outcomeUnknown: true });
  });
  it('reassembles complete pages and retains the exact historical material version', async () => {
    const newer = event({ id: id(20), eventSeq: 2, eventKind: 'correct', quantityText: '10' });
    const older = event({ createdAt: '2026-10-31T11:00:00+00:00' });
    mockRpc.mockResolvedValueOnce(ok(page([newer], newer.id))).mockResolvedValueOnce(ok(page([older])));
    const events = await listAnnualNeedEvents(SCOPE, REVISION);
    expect(events).toHaveLength(2);
    const [row] = foldManualEvents(events);
    expect(row.annualBinding?.fieldVersionId).toBe(VERSION);
    expect(editableAnnualFields(row.annualBinding!.fields).nameAr).toBeNull();
    expect(mockRpc.mock.calls[1][1].p_after_event_id).toBe(newer.id);
    expect(mockFrom).not.toHaveBeenCalled();
  });
  it('does not fabricate a binding or employee name for old records', async () => {
    mockRpc.mockResolvedValue(ok(page([event({ annualBinding: null, actorName: null, fromTrustedProfile: false })])));
    const [old] = await listAnnualNeedEvents(SCOPE, REVISION);
    expect(old.annualBinding).toBeNull(); expect(old.actorName).toBeNull();
  });
  it.each([
    () => event({ annualBinding: null }),
    () => event({ actorName: null, fromTrustedProfile: false }),
  ])('refuses an employee snapshot inconsistent with the event binding', async (inconsistent) => {
    mockRpc.mockResolvedValue(ok(page([inconsistent()])));
    await expect(listAnnualNeedEvents(SCOPE, REVISION)).rejects.toThrow('bindingActor');
  });
  it('does not return a partial chain when a later page fails or repeats its cursor', async () => {
    mockRpc.mockResolvedValueOnce(ok(page([event()], EVENT))).mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'forbidden_central_needs' } });
    await expect(listAnnualNeedEvents(SCOPE, REVISION)).rejects.toThrow();
    mockRpc.mockReset(); mockRpc.mockResolvedValue(ok(page([event()], EVENT)));
    await expect(listAnnualNeedEvents(SCOPE, REVISION)).rejects.toThrow('duplicate');
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });
  it('refuses a historical unit which contradicts the frozen annual fields', async () => {
    mockRpc.mockResolvedValue(ok(page([event({ approvedUnit: 'vial' })])));
    await expect(listAnnualNeedEvents(SCOPE, REVISION)).rejects.toThrow('bindingUnit');
  });
});

describe('year-scoped lawful registration integration', () => {
  it('lists only the scoped server page and rejects a foreign owner response', async () => {
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, requests: [materialRequest()], nextAfterRequestId: null }));
    expect(await listAnnualMaterialRequests(SCOPE)).toHaveLength(1);
    expect(mockRpc.mock.calls[0][1]).toEqual({ p_organization_id: OWNER, p_planning_year: 2026, p_limit: 50, p_after_request_id: null });
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, requests: [{ ...materialRequest(), organizationId: id(99) }], nextAfterRequestId: null }));
    await expect(listAnnualMaterialRequests(SCOPE)).rejects.toThrow('request.owner');
  });
  it('creates an explicit annual registration without linking an unapproved quantity', async () => {
    const api = createAnnualRegistrationApi(SCOPE);
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, requestId: REQUEST, status: 'draft', version: 1, idempotentReplay: false }));
    const descriptor = { scientificName: 'New item', nameAr: null, tradeName: null, strength: null, dosageForm: null,
      unit: 'box' as const, nationalCode: '009', barcode: null, note: null };
    expect((await api.createMaterialRequestDraft(OWNER, descriptor, KEY, { kind: 'manual_typed' }, REVISION)).requestId).toBe(REQUEST);
    expect(mockRpc.mock.calls[0][0]).toBe('phoenix_central_needs_create_annual_material_request');
    expect(mockRpc.mock.calls[0][1]).not.toHaveProperty('p_plan_revision_id');
    await expect(api.linkMaterialRequestToDraft(REQUEST, REVISION)).rejects.toThrow('useAnnualCompletion');
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
  it('does not relabel workbook evidence as a manual registration', async () => {
    const api = createAnnualRegistrationApi(SCOPE);
    const descriptor = { scientificName: 'New item', nameAr: null, tradeName: null, strength: null, dosageForm: null,
      unit: 'box' as const, barcode: null, note: null };
    await expect(api.createMaterialRequestDraft(OWNER, descriptor, KEY, { kind: 'excel_assist', pointer: {
      file_hash: FP, sheet_index: 0, row: 2,
    } })).rejects.toThrow('sourceRequiresAnnualEvidence');
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('completion keeps the approved request/version and returns an annual reference', async () => {
    mockRpc.mockResolvedValue(ok({ ...item(), requestId: REQUEST, idempotentReplay: false }));
    expect((await completeAnnualMaterialRequestForNeeds({ scope: SCOPE, requestId: REQUEST, expectedRequestVersion: 3,
      expectedCanonicalFingerprint: FP, reason: REASON, idempotencyKey: KEY })).membership.annualItemId).toBe(ANNUAL);
    expect(mockRpc.mock.calls[0][1]).toHaveProperty('p_expected_request_version', 3);
  });
});
