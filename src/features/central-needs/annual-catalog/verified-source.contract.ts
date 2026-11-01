/** Read/commit transport only. Cell witnesses do not establish legal identity or authorization. */
import { CN2A_CONTRACT_VERSION, type CellEvidence, type ParserIdentity } from '../import/contract';
import { annualScopeKey } from './annual-catalog.model';
import type { AnnualCatalogScope, AnnualSourceOccurrence } from './annual-catalog.contract';
import { AnnualCatalogContractError, catalogBoolean, catalogFingerprint, catalogInteger, catalogObject, catalogScope,
  catalogText, catalogUuid, validateAnnualCatalogItem, validateAnnualOccurrences, validateCanonicalPreview, validateWitnessCell, type AnnualCanonicalPreview, type AnnualCatalogWriteResult } from './annual-catalog-server.contract';

export interface ReviewedSourceProfile { readonly id: string; readonly version: number; readonly sha256: string }
export interface SourcePageInput {
  readonly scope: AnnualCatalogScope;
  readonly original: { readonly originalId: string; readonly sha256: string; readonly byteSize: number; readonly firstFilename: string };
  readonly profile: ReviewedSourceProfile; readonly cursor: string | null; readonly pageSize: number;
}
export interface SourceCapabilities {
  readonly version: 1; readonly scope: AnnualCatalogScope; readonly selectionMode: 'explicit_reviewed_profile';
  readonly readAvailable: boolean; readonly commitState: 'unavailable_registry' | 'forbidden' | 'missing_candidate' | 'inactive' | 'ready';
  readonly profiles: readonly ReviewedSourceProfile[]; readonly maxPageRows: 50; readonly maxRequestBytes: 16384;
}
export interface VerifiedSourcePage {
  readonly scope: AnnualCatalogScope; readonly original: { readonly originalId: string; readonly sha256: string; readonly byteSize: number; readonly attestation: 'server_received_original' };
  readonly template: { readonly id: string; readonly version: string; readonly sha256: string };
  readonly status: 'source_evidence_only_review_required'; readonly persisted: false;
  readonly preparationStatus: 'prepared' | 'held'; readonly heldReason?: 'layout_unavailable' | 'layout_ambiguous' | 'parse_rejected' | 'evidence_limit';
  readonly rows: readonly AnnualSourceOccurrence[]; readonly totalRows: number; readonly nextCursor: string | null;
  readonly coreTemplate?: { readonly id: string; readonly version: number; readonly reviewReference: string; readonly sha256: string };
  readonly parser?: ParserIdentity; readonly registrySha256?: string;
  readonly classifications?: ReadonlyArray<{ readonly blockId: string; readonly sheetIndex: number; readonly cell: CellEvidence }>;
}
export interface VerifiedMembershipRequest {
  readonly scope: AnnualCatalogScope; readonly requestId: string; readonly originalId: string; readonly expectedOriginalSha256: string;
  readonly templateId: string; readonly templateVersion: number; readonly expectedTemplateSha256: string; readonly cursor: string | null;
  readonly pageSize: number; readonly occurrenceKeys: readonly string[]; readonly canonicalItemId: string;
  readonly expectedCanonicalFingerprint: string; readonly reason: string;
}
export interface VerifiedMembershipIntent { readonly actorId: string; readonly request: VerifiedMembershipRequest }
export interface C4Verification {
  readonly attestation: 'server_verified_c2_extraction_v1'; readonly proofId: string; readonly proofSha256: string;
  readonly originalId: string; readonly originalSha256: string; readonly registrationSha256: string; readonly workerSha256: string;
  readonly reviewedById: string; readonly reviewedByName: string; readonly reviewedAt: string;
}
export type VerifiedMembership = AnnualCatalogWriteResult & { readonly c4Verification: C4Verification };
export type VerifiedReceipt = { readonly status: 'missing'; readonly requestId: string }
  | { readonly status: 'prepared'; readonly requestId: string; readonly proofId: string; readonly proofSha256: string }
  | { readonly status: 'committed'; readonly requestId: string; readonly result: VerifiedMembership };
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
function check(value: unknown, path: string): asserts value { if (!value) throw new AnnualCatalogContractError('response', `verifiedSource.${path}`); }
function bounded(value: unknown) { check(new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144, 'size'); }
function snapshot<T>(value: T): T {
  const copied = JSON.parse(JSON.stringify(value));
  const freeze = (entry: unknown) => { if (entry && typeof entry === 'object') { Object.values(entry).forEach(freeze); Object.freeze(entry); } };
  freeze(copied); return copied;
}
function clean(value: unknown, path: string, max = 2000) { const text = catalogText(value, path, 'response', max); check(!CONTROL.test(text), path); return text; }
function cursor(value: unknown): string | null { check(value === null || (typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)), 'cursor'); return value; }
function profile(value: unknown): ReviewedSourceProfile {
  const p = catalogObject(value, ['id', 'version', 'sha256'], 'profile');
  const id = clean(p.id, 'profile.id', 100); check(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id), 'profile.id');
  return { id, version: catalogInteger(p.version, 1, Number.MAX_SAFE_INTEGER, 'profile.version', 'response'), sha256: catalogFingerprint(p.sha256, 'profile.sha256', 'response') };
}
export function decodeSourceCapabilities(value: unknown, scope: AnnualCatalogScope): SourceCapabilities {
  bounded(value); const body = catalogObject(value, ['ok', 'capabilities'], 'discovery'); check(body.ok === true, 'discovery.ok');
  const c = catalogObject(body.capabilities, ['version','scope','selectionMode','readAvailable','commitState','profiles','maxPageRows','maxRequestBytes'], 'capabilities');
  catalogScope(c.scope, scope, 'response');
  check(c.version === 1 && c.selectionMode === 'explicit_reviewed_profile' && c.maxPageRows === 50 && c.maxRequestBytes === 16384, 'capabilities.contract');
  check(Array.isArray(c.profiles) && c.profiles.length <= 100, 'profiles'); const profiles = c.profiles.map(profile);
  check(new Set(profiles.map(p => JSON.stringify([p.id, p.version]))).size === profiles.length, 'profiles.duplicate');
  catalogBoolean(c.readAvailable, 'readAvailable'); check(c.readAvailable === (profiles.length > 0), 'readAvailable');
  check(profiles.length ? ['forbidden','missing_candidate','inactive','ready'].includes(String(c.commitState)) : c.commitState === 'unavailable_registry', 'commitState');
  return snapshot(c as unknown as SourceCapabilities);
}
export function decodeSourcePage(value: unknown, expected: SourcePageInput): VerifiedSourcePage {
  bounded(value); const body = catalogObject(value, ['ok', 'evidence'], 'sourcePage'); check(body.ok === true, 'page.ok');
  const raw = catalogObject(body.evidence, ['scope','original','template','status','preparationStatus','persisted','rows','totalRows','nextCursor'], 'page', 'response',
    ['heldReason','coreTemplate','parser','registrySha256','classifications']);
  catalogScope(raw.scope, expected.scope, 'response');
  check(raw.status === 'source_evidence_only_review_required' && raw.persisted === false, 'page.status');
  const original = catalogObject(raw.original, ['originalId','sha256','byteSize','attestation'], 'original');
  check(catalogUuid(original.originalId, 'original.id', 'response') === expected.original.originalId
    && catalogFingerprint(original.sha256, 'original.sha', 'response') === expected.original.sha256
    && catalogInteger(original.byteSize, 1, 3145728, 'original.bytes', 'response') === expected.original.byteSize
    && original.attestation === 'server_received_original', 'original.binding');
  const template = catalogObject(raw.template, ['id','version','sha256'], 'template');
  check(template.id === expected.profile.id && template.version === String(expected.profile.version)
    && template.sha256 === expected.profile.sha256, 'registration.binding');
  catalogInteger(raw.totalRows, 0, 5000, 'totalRows', 'response');
  check(Array.isArray(raw.rows) && raw.rows.length <= expected.pageSize && raw.rows.length <= Number(raw.totalRows), 'rows.count');
  cursor(raw.nextCursor); check(raw.nextCursor === null || (raw.rows.length > 0 && raw.nextCursor !== expected.cursor), 'nextCursor.progress');
  const base = ['scope','original','template','status','preparationStatus','persisted','rows','totalRows','nextCursor'];
  if (raw.preparationStatus === 'held') {
    catalogObject(raw, [...base, 'heldReason'], 'held');
    check(['layout_unavailable','layout_ambiguous','parse_rejected','evidence_limit'].includes(String(raw.heldReason))
      && raw.rows.length === 0 && raw.totalRows === 0 && raw.nextCursor === null, 'held');
  } else {
    check(raw.preparationStatus === 'prepared', 'preparationStatus'); catalogObject(raw, [...base, 'coreTemplate','parser','registrySha256','classifications'], 'prepared');
    const core = catalogObject(raw.coreTemplate, ['id','version','reviewReference','sha256'], 'coreTemplate');
    check(core.id === expected.profile.id && core.version === expected.profile.version, 'coreTemplate.binding'); clean(core.reviewReference, 'reviewReference');
    catalogFingerprint(core.sha256, 'coreTemplate.sha', 'response'); catalogFingerprint(raw.registrySha256, 'registry.sha', 'response');
    const parser = catalogObject(raw.parser, ['contractVersion','sheetjsVersion','sheetjsTarballSha256','runtime'], 'parser');
    check(parser.contractVersion === CN2A_CONTRACT_VERSION && parser.runtime === 'node', 'parser'); clean(parser.sheetjsVersion, 'sheetjsVersion', 100);
    catalogFingerprint(parser.sheetjsTarballSha256, 'parser.sha', 'response');
    // Only the preparation-key restriction differs from persisted A1 rows.
    // Reuse every existing cell/observation guard, then bind source IDs and deterministic keys explicitly.
    let rows: AnnualSourceOccurrence[];
    try { rows = validateAnnualOccurrences(raw.rows, expected.scope, 'input', expected.pageSize); }
    catch { throw new AnnualCatalogContractError('response', 'verifiedSource.rows'); }
    for (const row of rows) {
      check(row.source.sourceId === expected.original.originalId && row.source.sha256 === expected.original.sha256
        && row.source.filename === expected.original.firstFilename && row.source.parser.contractVersion === parser.contractVersion
        && row.source.parser.runtime === parser.runtime && row.source.parser.sheetjsVersion === parser.sheetjsVersion
        && row.source.parser.sheetjsTarballSha256 === parser.sheetjsTarballSha256, 'row.source');
      check(row.occurrenceKey === JSON.stringify([annualScopeKey(expected.scope), expected.original.originalId, expected.original.sha256,
        row.source.sheetIndex, row.source.blockId, row.source.row]), 'row.key');
    }
    check(Array.isArray(raw.classifications) && raw.classifications.length <= 200, 'classifications');
    for (const item of raw.classifications) {
      const c = catalogObject(item, ['blockId','sheetIndex','cell'], 'classification'); clean(c.blockId, 'classification.blockId');
      catalogInteger(c.sheetIndex, 0, 199, 'classification.sheetIndex', 'response'); validateWitnessCell(c.cell, 'classification.cell', 'response');
    }
  }
  return snapshot(raw as unknown as VerifiedSourcePage);
}
export function decodeVerifiedMembership(value: unknown, intent: VerifiedMembershipIntent): VerifiedMembership {
  bounded(value); check(value && typeof value === 'object' && !Array.isArray(value), 'membership');
  const { c4Verification, ...oldBody } = value as Record<string, unknown>;
  const result = validateAnnualCatalogItem(oldBody, intent.request.scope, { write: true, canonicalItemId: intent.request.canonicalItemId }) as AnnualCatalogWriteResult;
  const v = catalogObject(c4Verification, ['attestation','proofId','proofSha256','originalId','originalSha256','registrationSha256','workerSha256','reviewedById','reviewedByName','reviewedAt'], 'verification');
  check(v.attestation === 'server_verified_c2_extraction_v1', 'verification.attestation'); catalogUuid(v.proofId, 'proof.id', 'response');
  for (const key of ['proofSha256','originalSha256','registrationSha256','workerSha256']) catalogFingerprint(v[key], key, 'response');
  check(v.originalId === intent.request.originalId && v.originalSha256 === intent.request.expectedOriginalSha256
    && v.registrationSha256 === intent.request.expectedTemplateSha256 && v.reviewedById === intent.actorId, 'verification.binding');
  clean(v.reviewedByName, 'reviewedByName', 4000); const date = clean(v.reviewedAt, 'reviewedAt', 64);
  check(Number.isFinite(Date.parse(date)) && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(date), 'reviewedAt');
  check(result.sourceOccurrenceCount === intent.request.occurrenceKeys.length && result.canonicalFingerprint === intent.request.expectedCanonicalFingerprint, 'membership.binding');
  return snapshot(value as VerifiedMembership);
}
export function decodeVerifiedReceipt(value: unknown, intent: VerifiedMembershipIntent): VerifiedReceipt {
  bounded(value); check(value && typeof value === 'object' && !Array.isArray(value), 'receipt'); const status = (value as Record<string, unknown>).status;
  const r = catalogObject(value, status === 'missing' ? ['status','requestId'] : status === 'prepared' ? ['status','requestId','proofId','proofSha256'] : ['status','requestId','result'], 'receipt');
  check(r.requestId === intent.request.requestId, 'receipt.requestId');
  if (status === 'prepared') { catalogUuid(r.proofId, 'receipt.proofId', 'response'); catalogFingerprint(r.proofSha256, 'receipt.proofSha256', 'response'); }
  else if (status === 'committed') {
    const result = decodeVerifiedMembership(r.result, intent);
    check(result.idempotentReplay === true && result.selectable === false && result.selectionBlockers.includes('receipt_replay_requires_refresh'), 'receipt.refreshRequired');
  } else check(status === 'missing', 'receipt.status');
  return snapshot(r as unknown as VerifiedReceipt);
}

export function validateSourcePageInput(value: SourcePageInput): SourcePageInput {
  try {
    catalogObject(value, ['scope','original','profile','cursor','pageSize'], 'sourcePageInput', 'input');
    const scope = catalogScope(value.scope);
    const original = catalogObject(value.original, ['originalId','sha256','byteSize','firstFilename'], 'original', 'input');
    const firstFilename = catalogText(original.firstFilename, 'original.filename', 'input', 255);
    if (!/^[^/\\\u0000-\u001f\u007f-\u009f]{1,255}\.(xls|xlsx|csv)$/i.test(firstFilename)) throw new Error('filename');
    const checked = { scope, original: { originalId: catalogUuid(original.originalId, 'originalId'),
      sha256: catalogFingerprint(original.sha256, 'original.sha256'), byteSize: catalogInteger(original.byteSize, 1, 3145728, 'original.bytes'), firstFilename },
    profile: profile(value.profile), cursor: cursor(value.cursor), pageSize: catalogInteger(value.pageSize, 1, 50, 'pageSize') };
    return snapshot(checked);
  } catch { throw new AnnualCatalogContractError('input', 'verifiedSource.pageInput'); }
}
export function freezeVerifiedIntent(value: VerifiedMembershipIntent): VerifiedMembershipIntent {
  try {
    catalogObject(value, ['actorId','request'], 'intent', 'input');
    const actorId = catalogUuid(value.actorId, 'actorId');
    const r = catalogObject(value.request, ['scope','requestId','originalId','expectedOriginalSha256','templateId','templateVersion',
      'expectedTemplateSha256','cursor','pageSize','occurrenceKeys','canonicalItemId','expectedCanonicalFingerprint','reason'], 'request', 'input');
    const scope = catalogScope(r.scope), size = catalogInteger(r.pageSize, 1, 50, 'pageSize');
    const p = profile({ id: r.templateId, version: r.templateVersion, sha256: r.expectedTemplateSha256 });
    if (!Array.isArray(r.occurrenceKeys) || !r.occurrenceKeys.length || r.occurrenceKeys.length > size
      || new Set(r.occurrenceKeys).size !== r.occurrenceKeys.length) throw new Error('keys');
    const occurrenceKeys = r.occurrenceKeys.map(key => clean(key, 'occurrenceKey'));
    const request = { scope, requestId: catalogUuid(r.requestId, 'requestId'), originalId: catalogUuid(r.originalId, 'originalId'),
      expectedOriginalSha256: catalogFingerprint(r.expectedOriginalSha256, 'original.sha256'), templateId: p.id, templateVersion: p.version,
      expectedTemplateSha256: p.sha256, cursor: cursor(r.cursor), pageSize: size, occurrenceKeys,
      canonicalItemId: catalogUuid(r.canonicalItemId, 'canonicalItemId'), expectedCanonicalFingerprint: catalogFingerprint(r.expectedCanonicalFingerprint, 'canonicalFingerprint'),
      reason: clean(r.reason, 'reason').trim() };
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 16384) throw new Error('size');
    return snapshot({ actorId, request });
  } catch { throw new AnnualCatalogContractError('input', 'verifiedSource.intent'); }
}
export function createVerifiedMembershipIntent(input: { actorId: string; requestId: string; source: SourcePageInput; page: VerifiedSourcePage;
  occurrenceKeys: readonly string[]; canonical: AnnualCanonicalPreview; reason: string }): VerifiedMembershipIntent {
  const source = validateSourcePageInput(input.source), page = decodeSourcePage({ ok: true, evidence: input.page }, source);
  const canonical = validateCanonicalPreview(input.canonical, source.scope, input.canonical.canonicalItemId);
  if (page.preparationStatus !== 'prepared' || !canonical.eligible || !Array.isArray(input.occurrenceKeys)
    || input.occurrenceKeys.length < 1 || input.occurrenceKeys.length > source.pageSize
    || input.occurrenceKeys.some(key => !page.rows.some(row => row.occurrenceKey === key))) {
    throw new AnnualCatalogContractError('input', 'verifiedSource.reviewRequired');
  }
  return freezeVerifiedIntent({ actorId: input.actorId, request: { scope: source.scope, requestId: input.requestId,
    originalId: source.original.originalId, expectedOriginalSha256: source.original.sha256, templateId: source.profile.id,
    templateVersion: source.profile.version, expectedTemplateSha256: source.profile.sha256, cursor: source.cursor, pageSize: source.pageSize,
    occurrenceKeys: input.occurrenceKeys, canonicalItemId: canonical.canonicalItemId, expectedCanonicalFingerprint: canonical.canonicalFingerprint, reason: input.reason } });
}
