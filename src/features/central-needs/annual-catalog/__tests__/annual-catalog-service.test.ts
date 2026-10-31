import { beforeEach, describe, expect, it, vi } from 'vitest';
const { mockRpc, mockFrom } = vi.hoisted(() => ({ mockRpc: vi.fn(), mockFrom: vi.fn() }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: mockRpc, from: mockFrom } }));
import { CentralNeedsError } from '../../central-needs.service';
import {
  getAnnualCatalogContract, openAnnualCatalogYear, listAnnualCatalogYears, previewAnnualCanonical,
  searchAnnualCatalog, getAnnualCatalogItem, listAnnualCatalogOccurrences, addAnnualCatalogItem,
  refreshAnnualCatalogItem, createAnnualMaterialRequest, completeAnnualMaterialRequest,
} from '../annual-catalog.service';
import { AnnualCatalogContractError, type AnnualCatalogItemResult, type AnnualMaterialDescriptor,
  type AddAnnualCatalogItemInput, type AnnualCatalogCursor } from '../annual-catalog-server.contract';
import { ANNUAL_IDENTITY_FIELDS, type AnnualCatalogScope, type AnnualFieldVersion } from '../annual-catalog.contract';
import { extractAnnualIdentityBlock } from '../annual-catalog-source';
import { simpleInput } from './fixture-helpers';

const OWNER = '10000000-0000-4000-8000-000000000001';
const OTHER_OWNER = '10000000-0000-4000-8000-000000000002';
const ANNUAL = '20000000-0000-4000-8000-000000000001';
const ANNUAL_2 = '20000000-0000-4000-8000-000000000002';
const CANONICAL = '30000000-0000-4000-8000-000000000001';
const VERSION = '40000000-0000-4000-8000-000000000001';
const NEW_VERSION = '40000000-0000-4000-8000-000000000002';
const REQUEST = '50000000-0000-4000-8000-000000000001';
const SOURCE = '60000000-0000-4000-8000-000000000001';
const OCCURRENCE = '70000000-0000-4000-8000-000000000001';
const SCOPE: AnnualCatalogScope = { ownerOrgId: OWNER, planningYear: 2026 };
const FINGERPRINT = 'a'.repeat(64);
const KEY = 'intent-annual-2026-001';
const REASON = 'Reviewed canonical identity for the selected year';
const ok = (data: unknown) => ({ data, error: null });
const contract = () => ({ version: 1, scope: 'owner_year', canonicalSnapshots: true, sourceAttestation: 'client_attested', quantityBinding: false });
const year = (planningYear = 2026) => ({ planningYear, status: 'active', createdAt: '2026-10-31T12:00:00+00:00' });
const snapshot = () => ({ canonicalItemId: CANONICAL, scientificName: 'Amoxicillin', nameAr: null,
  nationalCode: '000123-04', barcode: '840001', dosageForm: 'Capsules', concentration: '500 mg', unit: 'box', status: 'active' });

function item(scope = SCOPE): AnnualCatalogItemResult {
  const canonical = snapshot();
  const fields = Object.fromEntries(ANNUAL_IDENTITY_FIELDS.map((key) => [key, canonical[key] === null
    ? { state: 'missing', reason: 'canonical_missing' }
    : { state: 'known', value: canonical[key], origins: [{ kind: 'canonical', canonicalItemId: CANONICAL, decisionReference: REASON }] }])) as AnnualFieldVersion['fields'];
  return { scope: { ...scope }, membership: { scope: { ...scope }, annualItemId: ANNUAL, canonicalItemId: CANONICAL,
    status: 'active', currentFieldVersionId: VERSION, occurrenceKeys: [] },
  fieldVersion: { scope: { ...scope }, annualItemId: ANNUAL, fieldVersionId: VERSION, versionNumber: 1, fields },
  canonicalFingerprint: FINGERPRINT, canonicalDrift: false, selectable: true,
  selectionBlockers: [], sourceOccurrenceCount: 0, sourceAttestation: 'client_attested' };
}

function occurrence() {
  const input = simpleInput(); input.scope = { ...SCOPE }; input.sourceScope = { ...SCOPE };
  return extractAnnualIdentityBlock(input)[0];
}

function persistedOccurrence() {
  const value = occurrence(); value.occurrenceKey = OCCURRENCE; value.source.sourceId = SOURCE;
  return value;
}

const addInput = (): AddAnnualCatalogItemInput => ({ scope: { ...SCOPE }, canonicalItemId: CANONICAL,
  expectedCanonicalFingerprint: FINGERPRINT, occurrences: [], reason: REASON, idempotencyKey: KEY });
const descriptor = (): AnnualMaterialDescriptor => ({ scientificName: 'Reagent', nameAr: null, tradeName: null,
  strength: null, dosageForm: null, unit: 'test', barcode: '840001', nationalCode: '00043-A00-001', note: null });
const cursor = (overrides: Partial<AnnualCatalogCursor> = {}): AnnualCatalogCursor => ({ ...SCOPE, query: 'Amox', rank: 1, annualItemId: ANNUAL, ...overrides });
beforeEach(() => vi.resetAllMocks());

describe('annual contract discovery and failure boundaries', () => {
  it('requires the exact bounded v1 contract', async () => {
    mockRpc.mockResolvedValue(ok(contract()));
    expect(await getAnnualCatalogContract()).toEqual(contract());
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_annual_catalog_contract');
  });

  it.each([null, {}, { ...contract(), version: 2 }, { ...contract(), quantityBinding: true },
    { ...contract(), sourceAttestation: 'verified' }, { ...contract(), canonicalSnapshots: false }])('rejects unavailable/malformed semantics without a fallback: %j', async (value) => {
    mockRpc.mockResolvedValue(ok(value));
    await expect(getAnnualCatalogContract()).rejects.toBeInstanceOf(AnnualCatalogContractError);
    expect(mockRpc).toHaveBeenCalledTimes(1); expect(mockFrom).not.toHaveBeenCalled();
  });

  it.each([
    { code: 'PGRST202', message: 'Could not find phoenix_central_needs_search_annual_catalog' },
    { code: '42501', message: 'forbidden_central_needs' },
    { code: '23514', message: 'annual_catalog_year_not_found' },
    { code: '', message: 'TypeError: Failed to fetch' },
  ])('preserves server/transport errors and never searches the global catalog: $code', async (error) => {
    mockRpc.mockResolvedValue({ data: null, error });
    await expect(searchAnnualCatalog(SCOPE, 'Amox')).rejects.toMatchObject({ name: 'CentralNeedsError', sqlstate: error.code || null });
    expect(mockRpc).toHaveBeenCalledTimes(1); expect(mockFrom).not.toHaveBeenCalled();
  });

  it('maps a thrown transport failure without retrying a write or changing its intent', async () => {
    mockRpc.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(addAnnualCatalogItem(addInput())).rejects.toMatchObject({ businessCode: 'central_needs_request_failed', sqlstate: null });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc.mock.calls[0][1].p_idempotency_key).toBe(KEY);
  });

  it('marks a malformed mutation acknowledgement as uncertain, not proof of rollback', async () => {
    mockRpc.mockResolvedValue(ok({}));
    await expect(addAnnualCatalogItem(addInput())).rejects.toMatchObject({ code: 'annual_catalog_invalid_response', outcomeUnknown: true });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});

describe('owner/year reads and bounded pagination', () => {
  it('opens an explicitly empty year with only its scope and supplied key', async () => {
    const next = { ...SCOPE, planningYear: 2027 };
    mockRpc.mockResolvedValue(ok({ scope: next, year: year(2027), idempotentReplay: false }));
    expect((await openAnnualCatalogYear(next, KEY)).year.planningYear).toBe(2027);
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_open_catalog_year', {
      p_organization_id: OWNER, p_planning_year: 2027, p_idempotency_key: KEY,
    });
  });

  it('reads years in descending keyset order with explicit null first cursor', async () => {
    mockRpc.mockResolvedValue(ok({ ownerOrgId: OWNER, years: [year(2027), year(2026)], nextAfterYear: 2026 }));
    expect((await listAnnualCatalogYears(OWNER, 2)).nextAfterYear).toBe(2026);
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_list_catalog_years', {
      p_organization_id: OWNER, p_limit: 2, p_after_year: null,
    });
  });

  it.each([
    { ownerOrgId: OTHER_OWNER, years: [], nextAfterYear: null },
    { ownerOrgId: OWNER, years: [year(2026), year(2027)], nextAfterYear: null },
    { ownerOrgId: OWNER, years: [year(2026), year(2026)], nextAfterYear: null },
    { ownerOrgId: OWNER, years: [], nextAfterYear: 2026 },
  ])('rejects foreign or invalid year pages', async (value) => {
    mockRpc.mockResolvedValue(ok(value));
    await expect(listAnnualCatalogYears(OWNER)).rejects.toBeInstanceOf(AnnualCatalogContractError);
  });

  it('keeps literal query characters and sends all annual parameters explicitly', async () => {
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, items: [item()], nextCursor: null }));
    const result = await searchAnnualCatalog(SCOPE, '  000%_\\  ', 5);
    expect(result.items[0].membership.annualItemId).toBe(ANNUAL);
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_search_annual_catalog', {
      p_organization_id: OWNER, p_planning_year: 2026, p_query: '000%_\\', p_limit: 5, p_cursor: null,
    });
  });

  it.each([
    cursor({ ownerOrgId: OTHER_OWNER }), cursor({ planningYear: 2027 }), cursor({ query: 'different' }),
    cursor({ rank: 2 as 1 }),
  ])('refuses a cursor outside its scope/query before network access', async (after) => {
    await expect(searchAnnualCatalog(SCOPE, 'Amox', 25, after)).rejects.toMatchObject({ code: 'annual_catalog_invalid_input' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('validates next cursors against the last returned item and exact code rank', async () => {
    const next = cursor({ query: '000123-04', rank: 0 });
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, items: [item()], nextCursor: next }));
    expect((await searchAnnualCatalog(SCOPE, '000123-04', 1)).nextCursor).toEqual(next);
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, items: [item()], nextCursor: { ...next, rank: 1 } }));
    await expect(searchAnnualCatalog(SCOPE, '000123-04', 1)).rejects.toThrow('catalogPage.nextCursor');
  });

  it('rejects duplicate canonical memberships and cursor regressions', async () => {
    const second = item(); second.membership.annualItemId = ANNUAL_2;
    second.fieldVersion = { ...second.fieldVersion, annualItemId: ANNUAL_2 };
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, items: [item(), second], nextCursor: null }));
    await expect(searchAnnualCatalog(SCOPE, 'Amox')).rejects.toThrow('catalogPage.duplicate');
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, items: [item()], nextCursor: null }));
    await expect(searchAnnualCatalog(SCOPE, 'Amox', 25, cursor())).rejects.toThrow('catalogPage.order');
  });

  it.each([
    { ownerOrgId: OWNER, planningYear: 1999 }, { ownerOrgId: OWNER, planningYear: 2026.5 },
    { ownerOrgId: 'invalid-id', planningYear: 2026 },
  ])('rejects invalid database scopes before calling any RPC', async (scope) => {
    await expect(searchAnnualCatalog(scope, '')).rejects.toMatchObject({ code: 'annual_catalog_invalid_input' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects unbounded pages and queries before network access', async () => {
    await expect(searchAnnualCatalog(SCOPE, '', 51)).rejects.toThrow('limit');
    await expect(searchAnnualCatalog(SCOPE, 'a'.repeat(201))).rejects.toThrow('query');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('canonical preview, immutable versions and scoped response associations', () => {
  it('returns the server fingerprint without computing identity or creating membership', async () => {
    const value = { scope: SCOPE, canonicalItemId: CANONICAL, canonicalSnapshot: snapshot(), canonicalFingerprint: FINGERPRINT,
      eligible: true, missingRequired: [] };
    mockRpc.mockResolvedValue(ok(value));
    expect(await previewAnnualCanonical(SCOPE, CANONICAL)).toEqual(value);
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_preview_annual_canonical', {
      p_organization_id: OWNER, p_planning_year: 2026, p_central_item_id: CANONICAL,
    });
  });

  it('rejects a preview that promotes a barcode into an absent required national code', async () => {
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, canonicalItemId: CANONICAL, canonicalSnapshot: { ...snapshot(), nationalCode: null },
      canonicalFingerprint: FINGERPRINT, eligible: true, missingRequired: [] }));
    await expect(previewAnnualCanonical(SCOPE, CANONICAL)).rejects.toMatchObject({ code: 'annual_catalog_invalid_response' });
  });

  it('reads historical fields by their version without presenting them as current selection', async () => {
    const historical = item(); historical.membership.currentFieldVersionId = NEW_VERSION;
    historical.selectable = false; historical.selectionBlockers = ['historical_version'];
    mockRpc.mockResolvedValue(ok(historical));
    expect((await getAnnualCatalogItem(SCOPE, ANNUAL, VERSION)).fieldVersion.fieldVersionId).toBe(VERSION);
    expect(mockRpc).toHaveBeenCalledWith('phoenix_central_needs_get_annual_catalog_item', {
      p_organization_id: OWNER, p_planning_year: 2026, p_annual_item_id: ANNUAL, p_field_version_id: VERSION,
    });
    historical.selectable = true; historical.selectionBlockers = [];
    await expect(getAnnualCatalogItem(SCOPE, ANNUAL, VERSION)).rejects.toThrow('item.selectable');
  });

  it.each([
    (value: AnnualCatalogItemResult) => { value.scope.planningYear = 2027; },
    (value: AnnualCatalogItemResult) => { value.membership.scope.ownerOrgId = OTHER_OWNER; },
    (value: AnnualCatalogItemResult) => { value.fieldVersion = { ...value.fieldVersion, scope: { ...SCOPE, planningYear: 2027 } }; },
    (value: AnnualCatalogItemResult) => { value.fieldVersion = { ...value.fieldVersion, annualItemId: ANNUAL_2 }; },
    (value: AnnualCatalogItemResult) => { value.membership.currentFieldVersionId = NEW_VERSION; },
    (value: AnnualCatalogItemResult) => { value.canonicalDrift = true; },
    (value: AnnualCatalogItemResult) => { value.membership.status = 'retired'; },
    (value: AnnualCatalogItemResult) => { value.sourceOccurrenceCount = 501; },
  ])('refuses malformed/forged current item responses', async (mutate) => {
    const value = item(); mutate(value); mockRpc.mockResolvedValue(ok(value));
    await expect(getAnnualCatalogItem(SCOPE, ANNUAL)).rejects.toMatchObject({ code: 'annual_catalog_invalid_response' });
  });

  it('accepts a preparing item while retaining its missing national code', async () => {
    const value = item(); value.membership.status = 'preparing'; value.selectable = false;
    value.selectionBlockers = ['national_code_missing'];
    value.fieldVersion = { ...value.fieldVersion, fields: { ...value.fieldVersion.fields,
      nationalCode: { state: 'missing', reason: 'canonical_missing' } } };
    mockRpc.mockResolvedValue(ok(value));
    const result = await getAnnualCatalogItem(SCOPE, ANNUAL);
    expect(result.fieldVersion.fields.nationalCode.state).toBe('missing'); expect(result.selectable).toBe(false);
  });

  it('rejects client-style source/manual/NA field assertions in the canonical snapshot response', async () => {
    const value = item();
    value.fieldVersion = { ...value.fieldVersion, fields: { ...value.fieldVersion.fields, nationalCode: {
      state: 'known', value: '000123-04', origins: [{ kind: 'source', occurrenceKey: OCCURRENCE, field: 'previousNationalCode' }],
    } } };
    mockRpc.mockResolvedValue(ok(value));
    await expect(getAnnualCatalogItem(SCOPE, ANNUAL)).rejects.toThrow();
  });
});

describe('bounded annual writes and receipt replay', () => {
  it('adds only explicit canonical membership using the opaque reviewed fingerprint', async () => {
    mockRpc.mockResolvedValue(ok({ ...item(), idempotentReplay: false }));
    await addAnnualCatalogItem(addInput());
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_add_annual_catalog_item', {
      p_organization_id: OWNER, p_planning_year: 2026, p_central_item_id: CANONICAL,
      p_expected_canonical_fingerprint: FINGERPRINT, p_occurrences: [], p_reason: REASON, p_idempotency_key: KEY,
    });
  });

  it('refreshes a known annual identity with an explicit compare-and-swap version', async () => {
    const updated = item(); updated.membership.currentFieldVersionId = NEW_VERSION;
    updated.fieldVersion = { ...updated.fieldVersion, fieldVersionId: NEW_VERSION, versionNumber: 2 };
    mockRpc.mockResolvedValue(ok({ ...updated, idempotentReplay: false }));
    await refreshAnnualCatalogItem({ scope: SCOPE, annualItemId: ANNUAL, expectedFieldVersionId: VERSION,
      expectedCanonicalFingerprint: FINGERPRINT, occurrences: [], reason: REASON, idempotencyKey: KEY });
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_refresh_annual_catalog_item', {
      p_organization_id: OWNER, p_planning_year: 2026, p_annual_item_id: ANNUAL,
      p_expected_field_version_id: VERSION, p_expected_canonical_fingerprint: FINGERPRINT,
      p_occurrences: [], p_reason: REASON, p_idempotency_key: KEY,
    });
  });

  it('accepts a replay solely as a historical receipt and does not perform an automatic read/write', async () => {
    const receipt = { ...item(), idempotentReplay: true, selectable: false, selectionBlockers: ['receipt_replay_requires_refresh'] };
    mockRpc.mockResolvedValue(ok(receipt));
    const result = await addAnnualCatalogItem(addInput());
    expect(result.selectable).toBe(false); expect(result.idempotentReplay).toBe(true);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    { selectable: true, selectionBlockers: [] }, { selectable: false, selectionBlockers: [] },
  ])('rejects a replay that lacks its required fresh-read boundary', async (overrides) => {
    mockRpc.mockResolvedValue(ok({ ...item(), idempotentReplay: true, ...overrides }));
    await expect(addAnnualCatalogItem(addInput())).rejects.toMatchObject({ outcomeUnknown: true });
  });

  it('does not retry or flatten a canonical fingerprint conflict', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '23514', message: 'annual_catalog_canonical_stale', details: 'current canonical changed' } });
    await expect(addAnnualCatalogItem(addInput())).rejects.toMatchObject({ businessCode: 'annual_catalog_canonical_stale', sqlstate: '23514', details: 'current canonical changed' });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('rejects arbitrary fields/quantity input before a mutation reaches the server', async () => {
    await expect(addAnnualCatalogItem({ ...addInput(), fields: {}, quantity: 0 } as AddAnnualCatalogItemInput)).rejects.toThrow('add.keys');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('preserves raw source identity independently and detaches it from caller changes', async () => {
    const evidence = occurrence();
    const unit = evidence.fields.unit;
    if (unit.state !== 'value') throw new Error('fixture');
    unit.text = 'tab '; unit.witness.cell.rawValue = 'tab ';
    let finish!: (result: ReturnType<typeof ok>) => void;
    mockRpc.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = addAnnualCatalogItem({ ...addInput(), occurrences: [evidence] });
    unit.text = 'changed'; unit.witness.cell.rawValue = 'changed';
    expect(mockRpc.mock.calls[0][1].p_occurrences[0].fields.unit.text).toBe('tab ');
    finish(ok({ ...item(), idempotentReplay: false }));
    const result = await pending;
    expect(result.fieldVersion.fields.unit).toMatchObject({ state: 'known', value: 'box' });
  });

  it.each(['quantity', 'commentText', 'foreignScope', 'oldCodeAsCurrent', 'formulaAsValue', 'numericCodeAsValue'])('rejects unsafe or inconsistent witness payload: %s', async (kind) => {
    const source = occurrence();
    const name = source.fields.scientificName;
    if (name.state !== 'value') throw new Error('fixture');
    if (kind === 'quantity') Object.assign(source, { annualQuantity: 0 });
    if (kind === 'commentText') Object.assign(name.witness.cell, { commentText: 'unrelated institution data' });
    if (kind === 'foreignScope') source.scope.planningYear = 2027;
    if (kind === 'oldCodeAsCurrent') source.fields.currentNationalCode = { state: 'value', text: 'OLD-01', witness: {
      field: 'previousNationalCode', cell: name.witness.cell, header: name.witness.header,
    } };
    if (kind === 'formulaAsValue') name.witness.cell.isFormula = true;
    if (kind === 'numericCodeAsValue') name.witness.cell.rawValue = 123;
    await expect(addAnnualCatalogItem({ ...addInput(), occurrences: [source] })).rejects.toMatchObject({ code: 'annual_catalog_invalid_input' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects overlarge source batches and repeated occurrence keys', async () => {
    await expect(addAnnualCatalogItem({ ...addInput(), occurrences: Array.from({ length: 101 }, occurrence) })).rejects.toThrow('occurrences');
    await expect(addAnnualCatalogItem({ ...addInput(), occurrences: [occurrence(), occurrence()] })).rejects.toThrow('occurrences.duplicate');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('preserves invalid formula evidence without making it usable identity', async () => {
    const source = occurrence(); const name = source.fields.scientificName;
    if (name.state !== 'value') throw new Error('fixture');
    name.witness.cell.isFormula = true; name.witness.cell.formula = 'A2';
    source.fields.scientificName = { state: 'invalid', reason: 'formula', witness: name.witness };
    mockRpc.mockResolvedValue(ok({ ...item(), idempotentReplay: false }));
    await addAnnualCatalogItem({ ...addInput(), occurrences: [source] });
    expect(mockRpc.mock.calls[0][1].p_occurrences[0].fields.scientificName).toEqual(source.fields.scientificName);
  });

  it('rejects a fabricated missing observation that still has a usable raw source value', async () => {
    const source = occurrence(); const name = source.fields.scientificName;
    if (name.state !== 'value') throw new Error('fixture');
    source.fields.scientificName = { state: 'missing', reason: 'blank', witness: name.witness };
    await expect(addAnnualCatalogItem({ ...addInput(), occurrences: [source] })).rejects.toThrow('observation.scientificName.reason');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('source pages and existing legal registration context', () => {
  it('reads bounded persisted source witnesses in the requested year/item', async () => {
    const value = { scope: SCOPE, annualItemId: ANNUAL, occurrences: [persistedOccurrence()], nextAfterOccurrenceId: OCCURRENCE, attestation: 'client_attested' };
    mockRpc.mockResolvedValue(ok(value));
    expect((await listAnnualCatalogOccurrences(SCOPE, ANNUAL, 1)).occurrences[0].occurrenceKey).toBe(OCCURRENCE);
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_list_annual_catalog_occurrences', {
      p_organization_id: OWNER, p_planning_year: 2026, p_annual_item_id: ANNUAL, p_limit: 1, p_after_occurrence_id: null,
    });
  });

  it('does not mistake client preparation IDs or a foreign occurrence for persisted evidence', async () => {
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, annualItemId: ANNUAL, occurrences: [occurrence()], nextAfterOccurrenceId: null, attestation: 'client_attested' }));
    await expect(listAnnualCatalogOccurrences(SCOPE, ANNUAL)).rejects.toThrow();
    const foreign = persistedOccurrence(); foreign.scope.planningYear = 2027;
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, annualItemId: ANNUAL, occurrences: [foreign], nextAfterOccurrenceId: null, attestation: 'client_attested' }));
    await expect(listAnnualCatalogOccurrences(SCOPE, ANNUAL)).rejects.toThrow('scope.mismatch');
  });

  it('creates a scoped registration request with distinct text codes and no invented plan/quantity', async () => {
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, requestId: REQUEST, status: 'draft', version: 1, idempotentReplay: false }));
    await createAnnualMaterialRequest(SCOPE, descriptor(), KEY);
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_create_annual_material_request', {
      p_organization_id: OWNER, p_planning_year: 2026, p_descriptor: descriptor(), p_idempotency_key: KEY,
    });
  });

  it('keeps a missing national code null without a barcode fallback', async () => {
    mockRpc.mockResolvedValue(ok({ scope: SCOPE, requestId: REQUEST, status: 'draft', version: 1, idempotentReplay: false }));
    await createAnnualMaterialRequest(SCOPE, { ...descriptor(), nationalCode: null }, KEY);
    expect(mockRpc.mock.calls[0][1].p_descriptor).toMatchObject({ nationalCode: null, barcode: '840001' });
  });

  it('rejects noncanonical units, numeric national codes and extra review fields', async () => {
    await expect(createAnnualMaterialRequest(SCOPE, { ...descriptor(), unit: 'tab' } as unknown as AnnualMaterialDescriptor, KEY)).rejects.toThrow('descriptor.unit');
    await expect(createAnnualMaterialRequest(SCOPE, { ...descriptor(), nationalCode: 123 } as unknown as AnnualMaterialDescriptor, KEY)).rejects.toThrow('descriptor.nationalCode');
    await expect(createAnnualMaterialRequest(SCOPE, { ...descriptor(), status: 'approved_new' } as AnnualMaterialDescriptor, KEY)).rejects.toThrow('descriptor.keys');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('completes only through the scoped wrapper with expected legal request version and fingerprint', async () => {
    mockRpc.mockResolvedValue(ok({ ...item(), requestId: REQUEST, idempotentReplay: false }));
    await completeAnnualMaterialRequest({ scope: SCOPE, requestId: REQUEST, expectedRequestVersion: 4,
      expectedCanonicalFingerprint: FINGERPRINT, reason: REASON, idempotencyKey: KEY });
    expect(mockRpc).toHaveBeenCalledExactlyOnceWith('phoenix_central_needs_complete_annual_material_request', {
      p_organization_id: OWNER, p_planning_year: 2026, p_request_id: REQUEST, p_expected_request_version: 4,
      p_expected_canonical_fingerprint: FINGERPRINT, p_reason: REASON, p_idempotency_key: KEY,
    });
  });

  it('surfaces unresolved registration refusal without attempting approval or another write', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '23514', message: 'material_request_not_resolved' } });
    await expect(completeAnnualMaterialRequest({ scope: SCOPE, requestId: REQUEST, expectedRequestVersion: 1,
      expectedCanonicalFingerprint: FINGERPRINT, reason: REASON, idempotencyKey: KEY })).rejects.toBeInstanceOf(CentralNeedsError);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});
