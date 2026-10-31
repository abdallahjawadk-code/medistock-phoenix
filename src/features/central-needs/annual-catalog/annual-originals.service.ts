/** C2: standalone original-file RPCs. Never invoke quantity intake or retry a write automatically. */
import { supabase } from '@/shared/supabase/client';
import { CentralNeedsError, centralNeedsErrorFromPostgrest } from '../central-needs.service';
import { isMissingNeedsContract } from '../manual/dossier.service';
import type { AnnualCatalogScope } from './annual-catalog.contract';
import { AnnualCatalogContractError, catalogInteger, catalogObject, catalogScope, catalogUuid } from './annual-catalog-server.contract';
import {
  ANNUAL_ORIGINAL_MAX_BYTES, annualOriginalFilename, annualOriginalIntent, annualOriginalSha256, annualOriginalTimestampOrder,
  decodeAnnualOriginalBytes, encodeAnnualOriginalBytes, originalCheck, validateAnnualOriginal, validateAnnualOriginalReceipt,
  validateAnnualOriginalsContract, validateAnnualOriginalUpload, validateAnnualOriginalWrite,
  type AnnualOriginalCaptureInput, type AnnualOriginalDownload, type AnnualOriginalIntent, type AnnualOriginalReceipt,
  type AnnualOriginalsContract, type AnnualOriginalUploadsPage, type AnnualOriginalWriteResult,
} from './annual-originals.contract';

export { annualOriginalIntent } from './annual-originals.contract';
const PREFIX = 'phoenix_central_needs_';
const scopeArgs = (scope: AnnualCatalogScope) => ({ p_organization_id: scope.ownerOrgId, p_planning_year: scope.planningYear });
const intentArgs = (intent: AnnualOriginalIntent) => ({ ...scopeArgs(intent.scope), p_filename: intent.filename,
  p_sha256: intent.sha256, p_byte_size: intent.byteSize, p_idempotency_key: intent.idempotencyKey, p_expected_actor_id: intent.actorId });
// These explicit server refusals/transaction aborts prove no command commit. Other failures stay ambiguous.
const CONFIRMED_REFUSALS = new Set(['23514', '23505', '42501', 'P0002', '25000', '22023', '22P02', '40P01', '55P03', '57014', '40001', 'PGRST202']);

export class AnnualOriginalWriteError extends CentralNeedsError {
  constructor(source: CentralNeedsError, readonly outcomeUnknown: boolean) {
    super(source.businessCode, source.message, { sqlstate: source.sqlstate, details: source.details, hint: source.hint, retryable: source.retryable });
    this.name = 'AnnualOriginalWriteError';
  }
}

export function isAnnualOriginalOutcomeUnknown(error: unknown): boolean {
  if (error instanceof AnnualOriginalWriteError) return error.outcomeUnknown;
  if (error instanceof AnnualCatalogContractError) return error.outcomeUnknown || error.code !== 'annual_catalog_invalid_input';
  // A caller must not turn an unexpected exception into proof that a sent command rolled back.
  return true;
}

function serviceError(error: unknown): CentralNeedsError {
  if (error instanceof CentralNeedsError) return error;
  if (error && typeof error === 'object') return centralNeedsErrorFromPostgrest(error);
  return centralNeedsErrorFromPostgrest({ message: String(error) });
}

async function rpc(suffix: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const { data, error } = await supabase.rpc(`${PREFIX}${suffix}`, args);
    if (error) throw centralNeedsErrorFromPostgrest(error);
    return data;
  } catch (error) { throw serviceError(error); }
}

/** Only an exact missing-capability response is absence; denial or malformed data cannot enable a fallback. */
export async function getAnnualOriginalsContract(): Promise<AnnualOriginalsContract | null> {
  try {
    const name = `${PREFIX}annual_originals_contract`;
    const { data, error } = await supabase.rpc(name);
    if (isMissingNeedsContract(error, name)) return null;
    if (error) throw centralNeedsErrorFromPostgrest(error);
    return validateAnnualOriginalsContract(data);
  } catch (error) {
    if (error instanceof AnnualCatalogContractError) throw error;
    throw serviceError(error);
  }
}

export interface PrepareAnnualOriginalInput {
  scope: AnnualCatalogScope;
  actorId: string;
  idempotencyKey: string;
  file: Pick<File, 'name' | 'size' | 'arrayBuffer'>;
}

/** Read and fingerprint once before confirmation; the returned intent retains the original bytes for same-key retry. */
export async function prepareAnnualOriginalFile(input: PrepareAnnualOriginalInput): Promise<AnnualOriginalCaptureInput> {
  const scope = catalogScope(input.scope); const actorId = catalogUuid(input.actorId, 'actorId');
  const filename = annualOriginalFilename(input.file.name);
  const byteSize = catalogInteger(input.file.size, 1, ANNUAL_ORIGINAL_MAX_BYTES, 'byteSize');
  const preliminary = annualOriginalIntent({ scope, actorId, filename, byteSize, sha256: '0'.repeat(64), idempotencyKey: input.idempotencyKey });
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  originalCheck(bytes.byteLength === byteSize, 'file.changedSize', 'input');
  const sha256 = await annualOriginalSha256(bytes);
  return Object.freeze({ ...preliminary, sha256, base64: encodeAnnualOriginalBytes(bytes) });
}

export async function storeAnnualOriginal(input: AnnualOriginalCaptureInput): Promise<AnnualOriginalWriteResult> {
  catalogObject(input, ['scope', 'actorId', 'filename', 'sha256', 'byteSize', 'idempotencyKey', 'base64'], 'annualOriginals.capture', 'input');
  const intent = annualOriginalIntent(input); const base64 = input.base64;
  const bytes = decodeAnnualOriginalBytes(base64, intent.byteSize, 'input');
  originalCheck(await annualOriginalSha256(bytes) === intent.sha256, 'capture.sha256', 'input');
  try {
    return validateAnnualOriginalWrite(await rpc('store_annual_original', { ...intentArgs(intent), p_base64: base64 }), intent);
  } catch (error) {
    if (error instanceof AnnualCatalogContractError) { error.outcomeUnknown = true; throw error; }
    const source = serviceError(error);
    throw new AnnualOriginalWriteError(source, !CONFIRMED_REFUSALS.has(source.sqlstate ?? ''));
  }
}

/** A missing receipt permits only an explicit same-key/same-intent retry, not a new capture key. */
export async function getAnnualOriginalReceipt(input: AnnualOriginalIntent): Promise<AnnualOriginalReceipt> {
  const intent = annualOriginalIntent(input);
  return validateAnnualOriginalReceipt(await rpc('get_annual_original_receipt', intentArgs(intent)), intent);
}

export async function listAnnualOriginalUploads(scope: AnnualCatalogScope, limit = 25,
  afterUploadId: string | null = null): Promise<AnnualOriginalUploadsPage> {
  const target = catalogScope(scope); const size = catalogInteger(limit, 1, 50, 'limit');
  const after = afterUploadId === null ? null : catalogUuid(afterUploadId, 'afterUploadId');
  const row = catalogObject(await rpc('list_annual_original_uploads', { ...scopeArgs(target), p_limit: size, p_after_upload_id: after }),
    ['scope', 'uploads', 'nextAfterUploadId'], 'annualOriginals.uploads');
  const returnedScope = catalogScope(row.scope, target, 'response');
  originalCheck(Array.isArray(row.uploads) && row.uploads.length <= size, 'uploads.rows');
  const originals = new Map<string, string>(); const ids = new Set<string>();
  const uploads = row.uploads.map((value) => {
    const record = catalogObject(value, ['original', 'upload'], 'annualOriginals.uploads.record');
    const original = validateAnnualOriginal(record.original); const upload = validateAnnualOriginalUpload(record.upload, original);
    originalCheck(!ids.has(upload.uploadId) && upload.uploadId !== after, 'uploads.duplicate');
    ids.add(upload.uploadId);
    const prior = originals.get(original.originalId); const metadata = JSON.stringify(original);
    originalCheck(prior === undefined || prior === metadata, 'uploads.originalChanged'); originals.set(original.originalId, metadata);
    return { original, upload };
  });
  uploads.forEach((record, index) => {
    if (index === 0) return;
    const previous = uploads[index - 1].upload;
    const time = annualOriginalTimestampOrder(record.upload.createdAt); const previousTime = annualOriginalTimestampOrder(previous.createdAt);
    originalCheck(time > previousTime || (time === previousTime && record.upload.uploadId > previous.uploadId), 'uploads.order');
  });
  const next = row.nextAfterUploadId === null ? null : catalogUuid(row.nextAfterUploadId, 'uploads.nextAfterUploadId', 'response');
  originalCheck(next === null || (uploads.length === size && next === uploads[uploads.length - 1]?.upload.uploadId), 'uploads.cursor');
  return { scope: returnedScope, uploads, nextAfterUploadId: next };
}

/** Bytes become a download Blob only after independent size/hash verification. Never render source content inline. */
export async function downloadAnnualOriginal(scope: AnnualCatalogScope, originalId: string): Promise<AnnualOriginalDownload> {
  const target = catalogScope(scope); const id = catalogUuid(originalId, 'originalId');
  const row = catalogObject(await rpc('download_annual_original', { ...scopeArgs(target), p_original_id: id }),
    ['scope', 'original', 'base64'], 'annualOriginals.download');
  const returnedScope = catalogScope(row.scope, target, 'response'); const original = validateAnnualOriginal(row.original);
  originalCheck(original.originalId === id, 'download.originalId');
  const bytes = decodeAnnualOriginalBytes(row.base64, original.byteSize, 'response');
  originalCheck(await annualOriginalSha256(bytes) === original.sha256, 'download.sha256');
  return { scope: returnedScope, original, blob: new Blob([bytes], { type: 'application/octet-stream' }) };
}
