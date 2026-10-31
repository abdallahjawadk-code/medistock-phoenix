/** Annual catalog RPC adapter. No direct DML, global search fallback, inferred fields or automatic retries. */
import { supabase } from '@/shared/supabase/client';
import { CentralNeedsError, centralNeedsErrorFromPostgrest } from '../central-needs.service';
import type { AnnualCatalogScope } from './annual-catalog.contract';
import {
  AnnualCatalogContractError, catalogObject, catalogUuid, catalogInteger, catalogBoolean, catalogScope,
  catalogQuery, catalogIdempotencyKey, catalogReason, catalogFingerprint,
  validateAnnualCatalogServerContract, validateCatalogYear, validateCatalogCursor, validateCanonicalPreview,
  validateAnnualCatalogItem, validateAnnualOccurrences, validateAnnualMaterialDescriptor, validateAnnualMaterialRequest,
  type AnnualCatalogServerContract, type AnnualCatalogYearResult, type AnnualCatalogYearsPage,
  type AnnualCanonicalPreview, type AnnualCatalogItemResult, type AnnualCatalogCursor, type AnnualCatalogPage,
  type AnnualCatalogOccurrencesPage, type AnnualCatalogWriteResult, type AnnualMaterialRequestResult,
  type AnnualMaterialCompletionResult, type AnnualMaterialDescriptor, type AddAnnualCatalogItemInput,
  type RefreshAnnualCatalogItemInput, type CompleteAnnualMaterialRequestInput,
} from './annual-catalog-server.contract';

const scopeArgs = (scope: AnnualCatalogScope) => ({ p_organization_id: scope.ownerOrgId, p_planning_year: scope.planningYear });

function responseCheck(ok: boolean, path: string): asserts ok {
  if (!ok) throw new AnnualCatalogContractError('response', path);
}

async function rpc(suffix: string, args?: Record<string, unknown>): Promise<unknown> {
  try {
    const { data, error } = args === undefined
      ? await supabase.rpc(`phoenix_central_needs_${suffix}`)
      : await supabase.rpc(`phoenix_central_needs_${suffix}`, args);
    if (error) throw centralNeedsErrorFromPostgrest(error);
    return data;
  } catch (error) {
    if (error instanceof CentralNeedsError) throw error;
    throw centralNeedsErrorFromPostgrest(error instanceof Error ? error : { message: String(error) });
  }
}

async function write<T>(suffix: string, args: Record<string, unknown>, validate: (data: unknown) => T): Promise<T> {
  const data = await rpc(suffix, args);
  try { return validate(data); }
  catch (error) {
    if (error instanceof AnnualCatalogContractError) error.outcomeUnknown = true;
    throw error;
  }
}

/** Contract discovery is explicit and never cached as authority or converted into legacy mode. */
export async function getAnnualCatalogContract(): Promise<AnnualCatalogServerContract> {
  return validateAnnualCatalogServerContract(await rpc('annual_catalog_contract'));
}

export async function openAnnualCatalogYear(scope: AnnualCatalogScope, idempotencyKey: string): Promise<AnnualCatalogYearResult> {
  const target = catalogScope(scope);
  return write('open_catalog_year', { ...scopeArgs(target), p_idempotency_key: catalogIdempotencyKey(idempotencyKey) }, (data) => {
    const row = catalogObject(data, ['scope', 'year', 'idempotentReplay'], 'openYear');
    catalogScope(row.scope, target, 'response');
    const year = validateCatalogYear(row.year);
    responseCheck(year.planningYear === target.planningYear, 'openYear.year');
    catalogBoolean(row.idempotentReplay, 'openYear.idempotentReplay');
    return row as unknown as AnnualCatalogYearResult;
  });
}

export async function listAnnualCatalogYears(ownerOrgId: string, limit = 25, afterYear: number | null = null): Promise<AnnualCatalogYearsPage> {
  const owner = catalogUuid(ownerOrgId, 'ownerOrgId');
  const size = catalogInteger(limit, 1, 50, 'limit');
  if (afterYear !== null) catalogInteger(afterYear, 2000, 2100, 'afterYear');
  const row = catalogObject(await rpc('list_catalog_years', { p_organization_id: owner, p_limit: size, p_after_year: afterYear }),
    ['ownerOrgId', 'years', 'nextAfterYear'], 'yearsPage');
  responseCheck(catalogUuid(row.ownerOrgId, 'yearsPage.ownerOrgId', 'response') === owner, 'yearsPage.ownerOrgId');
  responseCheck(Array.isArray(row.years) && row.years.length <= size, 'yearsPage.years');
  const years = row.years.map(validateCatalogYear);
  years.forEach((year, i) => responseCheck(year.planningYear < (i === 0 ? (afterYear ?? 2101) : years[i - 1].planningYear), 'yearsPage.order'));
  if (row.nextAfterYear !== null) {
    catalogInteger(row.nextAfterYear, 2000, 2100, 'yearsPage.nextAfterYear', 'response');
    responseCheck(years.length > 0 && row.nextAfterYear === years[years.length - 1].planningYear, 'yearsPage.nextAfterYear');
  }
  return row as unknown as AnnualCatalogYearsPage;
}

/** Called only in the explicit add-missing-material flow; this read never creates membership. */
export async function previewAnnualCanonical(scope: AnnualCatalogScope, canonicalItemId: string): Promise<AnnualCanonicalPreview> {
  const target = catalogScope(scope); const canonical = catalogUuid(canonicalItemId, 'canonicalItemId');
  return validateCanonicalPreview(await rpc('preview_annual_canonical', { ...scopeArgs(target), p_central_item_id: canonical }), target, canonical);
}

function itemRank(item: AnnualCatalogItemResult, query: string): 0 | 1 {
  const code = item.fieldVersion.fields.nationalCode;
  return code.state === 'known' && code.value === query ? 0 : 1;
}

export async function searchAnnualCatalog(scope: AnnualCatalogScope, query: string, limit = 25, cursor: AnnualCatalogCursor | null = null): Promise<AnnualCatalogPage> {
  const target = catalogScope(scope); const term = catalogQuery(query); const size = catalogInteger(limit, 1, 50, 'limit');
  const after = cursor === null ? null : validateCatalogCursor(cursor, target, term);
  const row = catalogObject(await rpc('search_annual_catalog', { ...scopeArgs(target), p_query: term, p_limit: size, p_cursor: after }),
    ['scope', 'items', 'nextCursor'], 'catalogPage');
  catalogScope(row.scope, target, 'response');
  responseCheck(Array.isArray(row.items) && row.items.length <= size, 'catalogPage.items');
  const items = row.items.map((item) => validateAnnualCatalogItem(item, target, { current: true }));
  const annualIds = items.map((item) => item.membership.annualItemId);
  const canonicalIds = items.map((item) => item.membership.canonicalItemId);
  responseCheck(new Set(annualIds).size === annualIds.length && new Set(canonicalIds).size === canonicalIds.length, 'catalogPage.duplicate');
  let previous = after;
  for (const item of items) {
    const rank = itemRank(item, term); const id = item.membership.annualItemId;
    responseCheck(previous === null || rank > previous.rank || (rank === previous.rank && id > previous.annualItemId), 'catalogPage.order');
    previous = { ...target, query: term, rank, annualItemId: id };
  }
  if (row.nextCursor !== null) {
    const next = validateCatalogCursor(row.nextCursor, target, term, 'response');
    responseCheck(items.length > 0 && next.annualItemId === previous?.annualItemId && next.rank === previous?.rank, 'catalogPage.nextCursor');
  }
  return row as unknown as AnnualCatalogPage;
}

export async function getAnnualCatalogItem(scope: AnnualCatalogScope, annualItemId: string, fieldVersionId: string | null = null): Promise<AnnualCatalogItemResult> {
  const target = catalogScope(scope); const annual = catalogUuid(annualItemId, 'annualItemId');
  const version = fieldVersionId === null ? null : catalogUuid(fieldVersionId, 'fieldVersionId');
  return validateAnnualCatalogItem(await rpc('get_annual_catalog_item', { ...scopeArgs(target), p_annual_item_id: annual, p_field_version_id: version }),
    target, { annualItemId: annual, fieldVersionId: version ?? undefined, current: version === null });
}

export async function listAnnualCatalogOccurrences(scope: AnnualCatalogScope, annualItemId: string, limit = 25, afterOccurrenceId: string | null = null): Promise<AnnualCatalogOccurrencesPage> {
  const target = catalogScope(scope); const annual = catalogUuid(annualItemId, 'annualItemId'); const size = catalogInteger(limit, 1, 50, 'limit');
  const after = afterOccurrenceId === null ? null : catalogUuid(afterOccurrenceId, 'afterOccurrenceId');
  const row = catalogObject(await rpc('list_annual_catalog_occurrences', { ...scopeArgs(target), p_annual_item_id: annual, p_limit: size, p_after_occurrence_id: after }),
    ['scope', 'annualItemId', 'occurrences', 'nextAfterOccurrenceId', 'attestation'], 'occurrencesPage');
  catalogScope(row.scope, target, 'response');
  responseCheck(catalogUuid(row.annualItemId, 'occurrencesPage.annualItemId', 'response') === annual, 'occurrencesPage.annualItemId');
  responseCheck(row.attestation === 'client_attested', 'occurrencesPage.attestation');
  const occurrences = validateAnnualOccurrences(row.occurrences, target, 'response', size);
  occurrences.forEach((entry, i) => responseCheck(entry.occurrenceKey > (i === 0 ? (after ?? '') : occurrences[i - 1].occurrenceKey), 'occurrencesPage.order'));
  if (row.nextAfterOccurrenceId !== null) {
    const next = catalogUuid(row.nextAfterOccurrenceId, 'occurrencesPage.nextAfterOccurrenceId', 'response');
    responseCheck(occurrences.length > 0 && next === occurrences[occurrences.length - 1].occurrenceKey, 'occurrencesPage.nextAfterOccurrenceId');
  }
  return { ...row, occurrences } as unknown as AnnualCatalogOccurrencesPage;
}

export async function addAnnualCatalogItem(input: AddAnnualCatalogItemInput): Promise<AnnualCatalogWriteResult> {
  catalogObject(input, ['scope', 'canonicalItemId', 'expectedCanonicalFingerprint', 'occurrences', 'reason', 'idempotencyKey'], 'add', 'input');
  const target = catalogScope(input.scope); const canonical = catalogUuid(input.canonicalItemId, 'canonicalItemId');
  return write('add_annual_catalog_item', { ...scopeArgs(target), p_central_item_id: canonical,
    p_expected_canonical_fingerprint: catalogFingerprint(input.expectedCanonicalFingerprint, 'expectedCanonicalFingerprint'),
    p_occurrences: validateAnnualOccurrences(input.occurrences, target), p_reason: catalogReason(input.reason),
    p_idempotency_key: catalogIdempotencyKey(input.idempotencyKey) },
  (data) => validateAnnualCatalogItem(data, target, { canonicalItemId: canonical, current: true, write: true }) as AnnualCatalogWriteResult);
}

export async function refreshAnnualCatalogItem(input: RefreshAnnualCatalogItemInput): Promise<AnnualCatalogWriteResult> {
  catalogObject(input, ['scope', 'annualItemId', 'expectedFieldVersionId', 'expectedCanonicalFingerprint', 'occurrences', 'reason', 'idempotencyKey'], 'refresh', 'input');
  const target = catalogScope(input.scope); const annual = catalogUuid(input.annualItemId, 'annualItemId');
  return write('refresh_annual_catalog_item', { ...scopeArgs(target), p_annual_item_id: annual,
    p_expected_field_version_id: catalogUuid(input.expectedFieldVersionId, 'expectedFieldVersionId'),
    p_expected_canonical_fingerprint: catalogFingerprint(input.expectedCanonicalFingerprint, 'expectedCanonicalFingerprint'),
    p_occurrences: validateAnnualOccurrences(input.occurrences, target), p_reason: catalogReason(input.reason),
    p_idempotency_key: catalogIdempotencyKey(input.idempotencyKey) },
  (data) => validateAnnualCatalogItem(data, target, { annualItemId: annual, current: true, write: true }) as AnnualCatalogWriteResult);
}

export async function createAnnualMaterialRequest(scope: AnnualCatalogScope, descriptor: AnnualMaterialDescriptor, idempotencyKey: string): Promise<AnnualMaterialRequestResult> {
  const target = catalogScope(scope);
  return write('create_annual_material_request', { ...scopeArgs(target), p_descriptor: validateAnnualMaterialDescriptor(descriptor),
    p_idempotency_key: catalogIdempotencyKey(idempotencyKey) }, (data) => validateAnnualMaterialRequest(data, target));
}

export async function completeAnnualMaterialRequest(input: CompleteAnnualMaterialRequestInput): Promise<AnnualMaterialCompletionResult> {
  catalogObject(input, ['scope', 'requestId', 'expectedRequestVersion', 'expectedCanonicalFingerprint', 'reason', 'idempotencyKey'], 'complete', 'input');
  const target = catalogScope(input.scope); const request = catalogUuid(input.requestId, 'requestId');
  return write('complete_annual_material_request', { ...scopeArgs(target), p_request_id: request,
    p_expected_request_version: catalogInteger(input.expectedRequestVersion, 1, 2_147_483_647, 'expectedRequestVersion'),
    p_expected_canonical_fingerprint: catalogFingerprint(input.expectedCanonicalFingerprint, 'expectedCanonicalFingerprint'),
    p_reason: catalogReason(input.reason), p_idempotency_key: catalogIdempotencyKey(input.idempotencyKey) },
  (data) => validateAnnualCatalogItem(data, target, { current: true, write: true, requestId: request }) as AnnualMaterialCompletionResult);
}
