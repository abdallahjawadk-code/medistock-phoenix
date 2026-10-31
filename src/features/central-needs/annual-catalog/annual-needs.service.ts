/** P3-B RPC boundary. Writes and their audit/binding share one server transaction; never retry automatically. */
import { supabase } from '@/shared/supabase/client';
import { CentralNeedsError, centralNeedsErrorFromPostgrest } from '../central-needs.service';
import { isMissingNeedsContract } from '../manual/dossier.service';
import { checkManualQuantityText } from '../manual/manual-quantity';
import * as registration from '../manual/material-registration.service';
import type { MaterialRequest, MaterialRequestStatus, MaterialUnit } from '../manual/material-registration.service';
import type { AnnualCatalogScope } from './annual-catalog.contract';
import {
  AnnualCatalogContractError, catalogFingerprint, catalogIdempotencyKey, catalogInteger, catalogObject,
  catalogQuery, catalogReason, catalogScope, catalogText, catalogUuid, validateAnnualCatalogItem, validateAnnualMaterialDescriptor,
  validateAnnualOccurrences, validateCatalogCursor, type AddAnnualCatalogItemInput, type AnnualCatalogCursor,
  type AnnualCatalogItemResult, type AnnualCatalogPage, type AnnualCatalogWriteResult, type AnnualMaterialCompletionResult,
  type CompleteAnnualMaterialRequestInput, type RefreshAnnualCatalogItemInput,
} from './annual-catalog-server.contract';
import { createAnnualMaterialRequest } from './annual-catalog.service';
import {
  annualNeedsCheck, annualTimestamp, validateAnnualCatalogChange, validateAnnualCatalogEdit,
  validateAnnualEditableFields, validateAnnualNeedEvent, validateAnnualNeedsContract, validateAnnualNeedWrite,
  type AnnualCatalogChangesPage, type AnnualCatalogEditResult, type AnnualMaterialRequestsPage, type AnnualNeedEvent,
  type AnnualNeedEventsPage, type AnnualNeedsServerContract, type AnnualNeedVoidInput, type AnnualNeedWriteInput,
  type AnnualNeedWriteResult, type EditAnnualCatalogItemInput,
} from './annual-needs.contract';

const scopeArgs = (scope: AnnualCatalogScope) => ({ p_organization_id: scope.ownerOrgId, p_planning_year: scope.planningYear });
const MAX_AGGREGATE_PAGES = 200;

async function rpc(suffix: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const { data, error } = await supabase.rpc(`phoenix_central_needs_${suffix}`, args);
    if (error) throw centralNeedsErrorFromPostgrest(error);
    return data;
  } catch (error) {
    if (error instanceof CentralNeedsError) throw error;
    throw centralNeedsErrorFromPostgrest(error instanceof Error ? error : { message: String(error) });
  }
}

async function write<T>(suffix: string, args: Record<string, unknown>, validate: (value: unknown) => T): Promise<T> {
  const result = await rpc(suffix, args);
  try { return validate(result); }
  catch (error) {
    if (error instanceof AnnualCatalogContractError) error.outcomeUnknown = true;
    throw error;
  }
}

/** Only the exact missing-function response is absence; denial, malformed data and transport errors stay errors. */
export async function getAnnualNeedsContract(): Promise<AnnualNeedsServerContract | null> {
  const name = 'phoenix_central_needs_annual_needs_contract';
  const { data, error } = await supabase.rpc(name);
  if (isMissingNeedsContract(error, name)) return null;
  if (error) throw centralNeedsErrorFromPostgrest(error);
  return validateAnnualNeedsContract(data);
}

/** P3-B opt-in reader accepts truthful manual origins after contract discovery. */
export async function searchAnnualCatalogForNeeds(scope: AnnualCatalogScope, query: string, limit = 25,
  cursor: AnnualCatalogCursor | null = null): Promise<AnnualCatalogPage> {
  const target = catalogScope(scope); const term = catalogQuery(query); const size = catalogInteger(limit, 1, 50, 'limit');
  const after = cursor === null ? null : validateCatalogCursor(cursor, target, term);
  const row = catalogObject(await rpc('search_annual_catalog', { ...scopeArgs(target), p_query: term, p_limit: size, p_cursor: after }),
    ['scope', 'items', 'nextCursor'], 'annualNeeds.catalogPage');
  catalogScope(row.scope, target, 'response');
  annualNeedsCheck(Array.isArray(row.items) && row.items.length <= size, 'catalogPage.items');
  const items = row.items.map((item) => validateAnnualCatalogItem(item, target, { current: true, allowAnnualEdits: true }));
  const seen = new Set<string>(); const canonicals = new Set<string>(); let previous = after;
  for (const item of items) {
    const id = item.membership.annualItemId; const canonical = item.membership.canonicalItemId;
    const field = item.fieldVersion.fields.nationalCode;
    const rank = field.state === 'known' && field.value === term ? 0 : 1;
    annualNeedsCheck(!seen.has(id) && canonical !== null && !canonicals.has(canonical), 'catalogPage.duplicate');
    seen.add(id); canonicals.add(canonical);
    annualNeedsCheck(previous === null || rank > previous.rank || (rank === previous.rank && id > previous.annualItemId), 'catalogPage.order');
    previous = { ...target, query: term, rank, annualItemId: id };
  }
  if (row.nextCursor !== null) {
    const next = validateCatalogCursor(row.nextCursor, target, term, 'response');
    annualNeedsCheck(items.length > 0 && next.annualItemId === previous?.annualItemId && next.rank === previous?.rank, 'catalogPage.cursor');
  }
  return row as unknown as AnnualCatalogPage;
}

export async function getAnnualCatalogItemForNeeds(scope: AnnualCatalogScope, annualItemId: string,
  fieldVersionId: string | null = null): Promise<AnnualCatalogItemResult> {
  const target = catalogScope(scope); const annual = catalogUuid(annualItemId, 'annualItemId');
  const version = fieldVersionId === null ? null : catalogUuid(fieldVersionId, 'fieldVersionId');
  return validateAnnualCatalogItem(await rpc('get_annual_catalog_item', { ...scopeArgs(target), p_annual_item_id: annual, p_field_version_id: version }),
    target, { annualItemId: annual, fieldVersionId: version ?? undefined, current: version === null, allowAnnualEdits: true });
}

export async function editAnnualCatalogItem(input: EditAnnualCatalogItemInput): Promise<AnnualCatalogEditResult> {
  catalogObject(input, ['scope', 'annualItemId', 'expectedFieldVersionId', 'expectedCanonicalFingerprint', 'fields', 'reason', 'idempotencyKey'], 'annualNeeds.edit', 'input');
  const normalized = { ...input, scope: catalogScope(input.scope), annualItemId: catalogUuid(input.annualItemId, 'annualItemId'),
    expectedFieldVersionId: catalogUuid(input.expectedFieldVersionId, 'expectedFieldVersionId'),
    expectedCanonicalFingerprint: catalogFingerprint(input.expectedCanonicalFingerprint, 'expectedCanonicalFingerprint'),
    fields: validateAnnualEditableFields(input.fields), reason: catalogReason(input.reason), idempotencyKey: catalogIdempotencyKey(input.idempotencyKey) };
  return write('edit_annual_catalog_item', { ...scopeArgs(normalized.scope), p_annual_item_id: normalized.annualItemId,
    p_expected_field_version_id: normalized.expectedFieldVersionId, p_expected_canonical_fingerprint: normalized.expectedCanonicalFingerprint,
    p_fields: normalized.fields, p_reason: normalized.reason, p_idempotency_key: normalized.idempotencyKey },
  (data) => validateAnnualCatalogEdit(data, normalized));
}

export async function listAnnualCatalogChanges(scope: AnnualCatalogScope, annualItemId: string, limit = 25,
  afterChangeId: string | null = null): Promise<AnnualCatalogChangesPage> {
  const target = catalogScope(scope); const annual = catalogUuid(annualItemId, 'annualItemId');
  const size = catalogInteger(limit, 1, 50, 'limit'); const after = afterChangeId === null ? null : catalogUuid(afterChangeId, 'afterChangeId');
  const row = catalogObject(await rpc('list_annual_catalog_changes', { ...scopeArgs(target), p_annual_item_id: annual,
    p_limit: size, p_after_change_id: after }), ['scope', 'annualItemId', 'changes', 'nextAfterChangeId'], 'annualNeeds.changes');
  catalogScope(row.scope, target, 'response');
  annualNeedsCheck(catalogUuid(row.annualItemId, 'changes.annualItemId', 'response') === annual, 'changes.annualItemId');
  annualNeedsCheck(Array.isArray(row.changes) && row.changes.length <= size, 'changes.rows');
  const changes = row.changes.map(validateAnnualCatalogChange);
  validatePageOrder(changes.map((change) => ({ id: change.changeId, createdAt: change.createdAt })), after, row.nextAfterChangeId, 'changes');
  return { ...row, changes } as unknown as AnnualCatalogChangesPage;
}

function validatePageOrder(rows: Array<{ id: string; createdAt: string }>, after: string | null, next: unknown, path: string): void {
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    annualNeedsCheck(row.id !== after && !seen.has(row.id), `${path}.duplicate`);
    seen.add(row.id);
    if (index > 0) {
      const previous = rows[index - 1];
      // PostgreSQL records microseconds; Date.parse alone would collapse distinct events into the same millisecond.
      const time = timestampOrder(row.createdAt); const beforeTime = timestampOrder(previous.createdAt);
      annualNeedsCheck(time < beforeTime || (time === beforeTime && row.id < previous.id), `${path}.order`);
    }
  });
  if (next !== null) annualNeedsCheck(catalogUuid(next, `${path}.next`, 'response') === rows[rows.length - 1]?.id && rows.length > 0, `${path}.next`);
}

function timestampOrder(value: string): bigint {
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  return BigInt(Date.parse(value)) * 1_000_000n + BigInt(fraction.slice(3, 9).padEnd(6, '0'));
}

function normalizeNeedInput(input: AnnualNeedWriteInput | AnnualNeedVoidInput, kind: 'add' | 'correct' | 'void'): AnnualNeedWriteInput | AnnualNeedVoidInput {
  catalogObject(input, ['scope', 'manualScope', 'annualItemId', 'fieldVersionId', 'reason', 'idempotencyKey', 'expectedLastEventId', 'reference',
    ...(kind === 'void' ? [] : ['quantityText'])], 'annualNeeds.write', 'input');
  const manual = catalogObject(input.manualScope, ['planRevisionId', 'beneficiaryOrganizationId', 'centralItemId', 'targetWarehouseId'], 'annualNeeds.manualScope', 'input');
  const manualScope = { planRevisionId: catalogUuid(manual.planRevisionId, 'planRevisionId'),
    beneficiaryOrganizationId: catalogUuid(manual.beneficiaryOrganizationId, 'beneficiaryOrganizationId'),
    centralItemId: catalogUuid(manual.centralItemId, 'centralItemId'),
    targetWarehouseId: manual.targetWarehouseId === null ? null : catalogUuid(manual.targetWarehouseId, 'targetWarehouseId') };
  const expectedLastEventId = input.expectedLastEventId === null ? null : catalogUuid(input.expectedLastEventId, 'expectedLastEventId');
  annualNeedsCheck(kind === 'add' || expectedLastEventId !== null, 'write.expectedEvent', 'input');
  const reference = input.reference === null ? null : catalogText(input.reference, 'reference', 'input', 4000, false);
  if (kind !== 'void') {
    const quantity = (input as AnnualNeedWriteInput).quantityText;
    annualNeedsCheck(typeof quantity === 'string' && checkManualQuantityText(quantity).ok, 'write.quantity', 'input');
  }
  return { ...input, scope: catalogScope(input.scope), manualScope, annualItemId: catalogUuid(input.annualItemId, 'annualItemId'),
    fieldVersionId: catalogUuid(input.fieldVersionId, 'fieldVersionId'), reason: catalogReason(input.reason),
    idempotencyKey: catalogIdempotencyKey(input.idempotencyKey), expectedLastEventId, reference };
}

async function writeNeed(kind: 'add' | 'correct' | 'void', input: AnnualNeedWriteInput | AnnualNeedVoidInput): Promise<AnnualNeedWriteResult> {
  const target = normalizeNeedInput(input, kind); const manual = target.manualScope;
  return write(`${kind}_annual_need_line`, { ...scopeArgs(target.scope), p_plan_revision_id: manual.planRevisionId,
    p_beneficiary_organization_id: manual.beneficiaryOrganizationId, p_central_item_id: manual.centralItemId,
    p_target_warehouse_id: manual.targetWarehouseId, p_annual_item_id: target.annualItemId, p_field_version_id: target.fieldVersionId,
    ...(kind === 'void' ? {} : { p_quantity_text: (target as AnnualNeedWriteInput).quantityText }), p_reason: target.reason,
    p_idempotency_key: target.idempotencyKey, p_expected_last_event_id: target.expectedLastEventId, p_reference: target.reference },
  (data) => validateAnnualNeedWrite(data, target));
}

export const addAnnualNeedLine = (input: AnnualNeedWriteInput) => writeNeed('add', input);
export const correctAnnualNeedLine = (input: AnnualNeedWriteInput) => writeNeed('correct', input);
export const voidAnnualNeedLine = (input: AnnualNeedVoidInput) => writeNeed('void', input);

export async function listAnnualNeedEventsPage(scope: AnnualCatalogScope, planRevisionId: string, limit = 50,
  afterEventId: string | null = null): Promise<AnnualNeedEventsPage> {
  const target = catalogScope(scope); const revision = catalogUuid(planRevisionId, 'planRevisionId');
  const size = catalogInteger(limit, 1, 50, 'limit'); const after = afterEventId === null ? null : catalogUuid(afterEventId, 'afterEventId');
  const row = catalogObject(await rpc('list_annual_need_events', { ...scopeArgs(target), p_plan_revision_id: revision,
    p_limit: size, p_after_event_id: after }), ['scope', 'planRevisionId', 'events', 'nextAfterEventId'], 'annualNeeds.events');
  catalogScope(row.scope, target, 'response');
  annualNeedsCheck(catalogUuid(row.planRevisionId, 'events.planRevisionId', 'response') === revision, 'events.revision');
  annualNeedsCheck(Array.isArray(row.events) && row.events.length <= size, 'events.rows');
  const events = row.events.map((event) => validateAnnualNeedEvent(event, target, revision));
  validatePageOrder(events, after, row.nextAfterEventId, 'events');
  return { ...row, events } as unknown as AnnualNeedEventsPage;
}

/** The legacy workspace expects a complete event chain: partial pages are never presented as complete. */
export async function listAnnualNeedEvents(scope: AnnualCatalogScope, planRevisionId: string): Promise<AnnualNeedEvent[]> {
  const rows: AnnualNeedEvent[] = []; const seen = new Set<string>(); let after: string | null = null;
  for (let page = 0; page < MAX_AGGREGATE_PAGES; page += 1) {
    const result = await listAnnualNeedEventsPage(scope, planRevisionId, 50, after);
    validatePageOrder([...rows.slice(-1), ...result.events], null, result.nextAfterEventId, 'eventChain');
    for (const event of result.events) {
      annualNeedsCheck(!seen.has(event.id), 'eventChain.duplicate'); seen.add(event.id);
    }
    rows.push(...result.events);
    if (result.nextAfterEventId === null) return rows;
    after = result.nextAfterEventId;
  }
  throw new AnnualCatalogContractError('response', 'annualNeeds.eventChain.pageLimit');
}

export async function addAnnualCatalogItemForNeeds(input: AddAnnualCatalogItemInput): Promise<AnnualCatalogWriteResult> {
  catalogObject(input, ['scope', 'canonicalItemId', 'expectedCanonicalFingerprint', 'occurrences', 'reason', 'idempotencyKey'], 'add', 'input');
  const target = catalogScope(input.scope); const canonical = catalogUuid(input.canonicalItemId, 'canonicalItemId');
  return write('add_annual_catalog_item', { ...scopeArgs(target), p_central_item_id: canonical,
    p_expected_canonical_fingerprint: catalogFingerprint(input.expectedCanonicalFingerprint, 'expectedCanonicalFingerprint'),
    p_occurrences: validateAnnualOccurrences(input.occurrences, target), p_reason: catalogReason(input.reason),
    p_idempotency_key: catalogIdempotencyKey(input.idempotencyKey) },
  (data) => validateAnnualCatalogItem(data, target, { canonicalItemId: canonical, current: true, write: true, allowAnnualEdits: true }) as AnnualCatalogWriteResult);
}

export async function refreshAnnualCatalogItemForNeeds(input: RefreshAnnualCatalogItemInput): Promise<AnnualCatalogWriteResult> {
  catalogObject(input, ['scope', 'annualItemId', 'expectedFieldVersionId', 'expectedCanonicalFingerprint', 'occurrences', 'reason', 'idempotencyKey'], 'refresh', 'input');
  const target = catalogScope(input.scope); const annual = catalogUuid(input.annualItemId, 'annualItemId');
  return write('refresh_annual_catalog_item', { ...scopeArgs(target), p_annual_item_id: annual,
    p_expected_field_version_id: catalogUuid(input.expectedFieldVersionId, 'expectedFieldVersionId'),
    p_expected_canonical_fingerprint: catalogFingerprint(input.expectedCanonicalFingerprint, 'expectedCanonicalFingerprint'),
    p_occurrences: validateAnnualOccurrences(input.occurrences, target), p_reason: catalogReason(input.reason),
    p_idempotency_key: catalogIdempotencyKey(input.idempotencyKey) },
  (data) => validateAnnualCatalogItem(data, target, { annualItemId: annual, current: true, write: true, allowAnnualEdits: true }) as AnnualCatalogWriteResult);
}

export async function completeAnnualMaterialRequestForNeeds(input: CompleteAnnualMaterialRequestInput): Promise<AnnualMaterialCompletionResult> {
  catalogObject(input, ['scope', 'requestId', 'expectedRequestVersion', 'expectedCanonicalFingerprint', 'reason', 'idempotencyKey'], 'complete', 'input');
  const target = catalogScope(input.scope); const request = catalogUuid(input.requestId, 'requestId');
  return write('complete_annual_material_request', { ...scopeArgs(target), p_request_id: request,
    p_expected_request_version: catalogInteger(input.expectedRequestVersion, 1, 2_147_483_647, 'expectedRequestVersion'),
    p_expected_canonical_fingerprint: catalogFingerprint(input.expectedCanonicalFingerprint, 'expectedCanonicalFingerprint'),
    p_reason: catalogReason(input.reason), p_idempotency_key: catalogIdempotencyKey(input.idempotencyKey) },
  (data) => validateAnnualCatalogItem(data, target, { current: true, write: true, requestId: request, allowAnnualEdits: true }) as AnnualMaterialCompletionResult);
}

function validateMaterialRequest(value: unknown, scope: AnnualCatalogScope): MaterialRequest {
  const row = catalogObject(value, ['id', 'organizationId', 'requesterId', 'status', 'version', 'scientificName', 'nameAr', 'tradeName',
    'strength', 'dosageForm', 'unit', 'barcode', 'nationalCode', 'note', 'provenanceKind', 'reviewerId', 'resolvedItemId', 'decisionReason', 'createdAt'], 'annualNeeds.request');
  for (const key of ['id', 'organizationId', 'requesterId']) catalogUuid(row[key], `request.${key}`, 'response');
  annualNeedsCheck(row.organizationId === scope.ownerOrgId, 'request.owner');
  for (const key of ['reviewerId', 'resolvedItemId']) if (row[key] !== null) catalogUuid(row[key], `request.${key}`, 'response');
  catalogInteger(row.version, 1, 2_147_483_647, 'request.version', 'response');
  annualNeedsCheck(['draft', 'submitted', 'under_review', 'needs_info', 'resolved_existing', 'approved_new', 'rejected', 'cancelled'].includes(String(row.status)), 'request.status');
  catalogText(row.scientificName, 'request.scientificName', 'response', 4000);
  for (const key of ['nameAr', 'tradeName', 'strength', 'dosageForm', 'barcode', 'nationalCode', 'note', 'decisionReason']) {
    if (row[key] !== null) catalogText(row[key], `request.${key}`, 'response', 4000, false);
  }
  annualNeedsCheck(registration.MATERIAL_UNITS.includes(row.unit as MaterialUnit), 'request.unit');
  annualNeedsCheck(row.provenanceKind === 'manual_typed', 'request.provenanceKind');
  annualTimestamp(row.createdAt, 'request.createdAt');
  return row as unknown as MaterialRequest;
}

export async function listAnnualMaterialRequestsPage(scope: AnnualCatalogScope, limit = 50,
  afterRequestId: string | null = null): Promise<AnnualMaterialRequestsPage> {
  const target = catalogScope(scope); const size = catalogInteger(limit, 1, 50, 'limit');
  const after = afterRequestId === null ? null : catalogUuid(afterRequestId, 'afterRequestId');
  const row = catalogObject(await rpc('list_annual_material_requests', { ...scopeArgs(target), p_limit: size, p_after_request_id: after }),
    ['scope', 'requests', 'nextAfterRequestId'], 'annualNeeds.requests');
  catalogScope(row.scope, target, 'response');
  annualNeedsCheck(Array.isArray(row.requests) && row.requests.length <= size, 'requests.rows');
  const requests = row.requests.map((request) => validateMaterialRequest(request, target));
  validatePageOrder(requests, after, row.nextAfterRequestId, 'requests');
  return { ...row, requests } as unknown as AnnualMaterialRequestsPage;
}

export async function listAnnualMaterialRequests(scope: AnnualCatalogScope): Promise<MaterialRequest[]> {
  const rows: MaterialRequest[] = []; const seen = new Set<string>(); let after: string | null = null;
  for (let page = 0; page < MAX_AGGREGATE_PAGES; page += 1) {
    const result = await listAnnualMaterialRequestsPage(scope, 50, after);
    validatePageOrder([...rows.slice(-1), ...result.requests], null, result.nextAfterRequestId, 'requestChain');
    for (const request of result.requests) {
      annualNeedsCheck(!seen.has(request.id), 'requestChain.duplicate'); seen.add(request.id);
    }
    rows.push(...result.requests);
    if (result.nextAfterRequestId === null) return rows;
    after = result.nextAfterRequestId;
  }
  throw new AnnualCatalogContractError('response', 'annualNeeds.requests.pageLimit');
}

/** Reuse the registration state machine; only creation/listing are narrowed to an explicit annual context. */
export function createAnnualRegistrationApi(scope: AnnualCatalogScope) {
  const target = catalogScope(scope);
  return { ...registration,
    async listMaterialRequests(organizationId: string) {
      annualNeedsCheck(catalogUuid(organizationId, 'organizationId') === target.ownerOrgId, 'registration.owner', 'input');
      return listAnnualMaterialRequests(target);
    },
    async createMaterialRequestDraft(...args: Parameters<typeof registration.createMaterialRequestDraft>) {
      const [organizationId, descriptor, key, provenance] = args;
      annualNeedsCheck(catalogUuid(organizationId, 'organizationId') === target.ownerOrgId, 'registration.owner', 'input');
      annualNeedsCheck(provenance.kind === 'manual_typed', 'registration.sourceRequiresAnnualEvidence', 'input');
      const fields = validateAnnualMaterialDescriptor({ ...descriptor, nationalCode: descriptor.nationalCode ?? null });
      const result = await createAnnualMaterialRequest(target, fields, key);
      return { requestId: result.requestId, version: result.version, status: result.status as MaterialRequestStatus,
        idempotentReplay: result.idempotentReplay };
    },
    async linkMaterialRequestToDraft(..._args: Parameters<typeof registration.linkMaterialRequestToDraft>): Promise<never> {
      throw new AnnualCatalogContractError('input', 'annualNeeds.registration.useAnnualCompletion');
    },
  };
}
