/** C2 v1: received original bytes are not trusted cell extraction or catalog approval. */
import type { AnnualCatalogScope } from './annual-catalog.contract';
import {
  AnnualCatalogContractError, catalogBoolean, catalogFingerprint, catalogInteger, catalogObject,
  catalogScope, catalogText, catalogUuid,
} from './annual-catalog-server.contract';

export const ANNUAL_ORIGINAL_MAX_BYTES = 3_145_728;
export const ANNUAL_ORIGINAL_ATTESTATION = 'server_received_original' as const;
const MAX_BASE64_LENGTH = Math.ceil(ANNUAL_ORIGINAL_MAX_BYTES / 3) * 4;
const CONTROL_TEXT = /[\u0000-\u001F\u007F-\u009F]/;
const UNSAFE_FILENAME = /[\/\\\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
type Boundary = 'input' | 'response';

export interface AnnualOriginalsContract {
  version: 1;
  scope: 'owner_year';
  maxFileBytes: 3145728;
  extensions: ['xls', 'xlsx', 'csv'];
  attestation: typeof ANNUAL_ORIGINAL_ATTESTATION;
  atomicReceipt: true;
  intentBoundReplay: true;
}

export interface AnnualOriginal {
  originalId: string;
  sha256: string;
  byteSize: number;
  firstFilename: string;
  createdBy: string;
  createdByName: string;
  createdByRole: string;
  createdAt: string;
  attestation: typeof ANNUAL_ORIGINAL_ATTESTATION;
}

export interface AnnualOriginalUpload {
  uploadId: string;
  originalId: string;
  filename: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  createdAt: string;
}

/** actorId binds the acknowledgement to the initiating session; the database derives its own actor. */
export interface AnnualOriginalIntent {
  readonly scope: AnnualCatalogScope;
  readonly actorId: string;
  readonly filename: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly idempotencyKey: string;
}
export interface AnnualOriginalCaptureInput extends AnnualOriginalIntent { readonly base64: string }
export interface AnnualOriginalUploadRecord { original: AnnualOriginal; upload: AnnualOriginalUpload }
export interface AnnualOriginalWriteResult extends AnnualOriginalUploadRecord {
  scope: AnnualCatalogScope;
  idempotencyKey: string;
  deduplicated: boolean;
  idempotentReplay: boolean;
}
export interface AnnualOriginalReceipt {
  scope: AnnualCatalogScope;
  intent: Pick<AnnualOriginalIntent, 'filename' | 'sha256' | 'byteSize' | 'idempotencyKey'>;
  result: AnnualOriginalWriteResult | null;
}
export interface AnnualOriginalUploadsPage {
  scope: AnnualCatalogScope;
  uploads: AnnualOriginalUploadRecord[];
  nextAfterUploadId: string | null;
}
export interface AnnualOriginalDownload {
  scope: AnnualCatalogScope;
  original: AnnualOriginal;
  blob: Blob;
}

export function originalCheck(ok: boolean, path: string, boundary: Boundary = 'response'): asserts ok {
  if (!ok) throw new AnnualCatalogContractError(boundary, `annualOriginals.${path}`);
}

export function annualOriginalFilename(value: unknown, boundary: Boundary = 'input'): string {
  const name = catalogText(value, 'annualOriginals.filename', boundary, 255);
  originalCheck(name === name.trim() && !UNSAFE_FILENAME.test(name) && !name.startsWith('~$')
    && /\.(xls|xlsx|csv)$/i.test(name), 'filename', boundary);
  return name;
}

function operationKey(value: unknown, boundary: Boundary): string {
  const key = catalogText(value, 'annualOriginals.idempotencyKey', boundary, 128);
  originalCheck(key.length >= 8 && key === key.trim() && !CONTROL_TEXT.test(key), 'idempotencyKey', boundary);
  return key;
}

/** Return a detached, frozen intent so delayed I/O cannot observe a caller's mutation. */
export function annualOriginalIntent(value: AnnualOriginalIntent | AnnualOriginalCaptureInput): AnnualOriginalIntent {
  const row = catalogObject(value, ['scope', 'actorId', 'filename', 'sha256', 'byteSize', 'idempotencyKey'],
    'annualOriginals.intent', 'input', ['base64']);
  return Object.freeze({ scope: Object.freeze(catalogScope(row.scope)), actorId: catalogUuid(row.actorId, 'actorId'),
    filename: annualOriginalFilename(row.filename), sha256: catalogFingerprint(row.sha256, 'sha256'),
    byteSize: catalogInteger(row.byteSize, 1, ANNUAL_ORIGINAL_MAX_BYTES, 'byteSize'),
    idempotencyKey: operationKey(row.idempotencyKey, 'input') });
}

export function validateAnnualOriginalsContract(value: unknown): AnnualOriginalsContract {
  const row = catalogObject(value, ['version', 'scope', 'maxFileBytes', 'extensions', 'attestation', 'atomicReceipt', 'intentBoundReplay'],
    'annualOriginals.contract');
  originalCheck(row.version === 1 && row.scope === 'owner_year' && row.maxFileBytes === ANNUAL_ORIGINAL_MAX_BYTES
    && Array.isArray(row.extensions) && row.extensions.length === 3
    && row.extensions.every((value, i) => value === ['xls', 'xlsx', 'csv'][i])
    && row.attestation === ANNUAL_ORIGINAL_ATTESTATION && row.atomicReceipt === true && row.intentBoundReplay === true, 'contract');
  return row as unknown as AnnualOriginalsContract;
}

function actorText(value: unknown, path: string, max: number): string {
  const text = catalogText(value, path, 'response', max);
  originalCheck(!CONTROL_TEXT.test(text), path);
  return text;
}

function timestamp(value: unknown, path: string): string {
  const text = catalogText(value, path, 'response', 64);
  originalCheck(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)
    && Number.isFinite(Date.parse(text)), path);
  return text;
}

/** Preserve PostgreSQL microsecond order instead of collapsing to Date's milliseconds. */
export function annualOriginalTimestampOrder(value: string): bigint {
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  return BigInt(Date.parse(value)) * 1000n + BigInt(fraction.slice(3, 6).padEnd(3, '0'));
}

export function validateAnnualOriginal(value: unknown): AnnualOriginal {
  const row = catalogObject(value, ['originalId', 'sha256', 'byteSize', 'firstFilename', 'createdBy', 'createdByName',
    'createdByRole', 'createdAt', 'attestation'], 'annualOriginals.original');
  originalCheck(row.attestation === ANNUAL_ORIGINAL_ATTESTATION, 'original.attestation');
  return { originalId: catalogUuid(row.originalId, 'original.originalId', 'response'),
    sha256: catalogFingerprint(row.sha256, 'original.sha256', 'response'),
    byteSize: catalogInteger(row.byteSize, 1, ANNUAL_ORIGINAL_MAX_BYTES, 'original.byteSize', 'response'),
    firstFilename: annualOriginalFilename(row.firstFilename, 'response'),
    createdBy: catalogUuid(row.createdBy, 'original.createdBy', 'response'),
    createdByName: actorText(row.createdByName, 'original.createdByName', 4000),
    createdByRole: actorText(row.createdByRole, 'original.createdByRole', 128),
    createdAt: timestamp(row.createdAt, 'original.createdAt'), attestation: ANNUAL_ORIGINAL_ATTESTATION };
}

export function validateAnnualOriginalUpload(value: unknown, original: AnnualOriginal): AnnualOriginalUpload {
  const row = catalogObject(value, ['uploadId', 'originalId', 'filename', 'actorId', 'actorName', 'actorRole', 'createdAt'],
    'annualOriginals.upload');
  const upload = { uploadId: catalogUuid(row.uploadId, 'upload.uploadId', 'response'),
    originalId: catalogUuid(row.originalId, 'upload.originalId', 'response'),
    filename: annualOriginalFilename(row.filename, 'response'), actorId: catalogUuid(row.actorId, 'upload.actorId', 'response'),
    actorName: actorText(row.actorName, 'upload.actorName', 4000), actorRole: actorText(row.actorRole, 'upload.actorRole', 128),
    createdAt: timestamp(row.createdAt, 'upload.createdAt') };
  originalCheck(upload.originalId === original.originalId
    && annualOriginalTimestampOrder(original.createdAt) <= annualOriginalTimestampOrder(upload.createdAt), 'upload.original');
  return upload;
}

export function validateAnnualOriginalWrite(value: unknown, intent: AnnualOriginalIntent): AnnualOriginalWriteResult {
  const row = catalogObject(value, ['scope', 'idempotencyKey', 'original', 'upload', 'deduplicated', 'idempotentReplay'],
    'annualOriginals.write');
  const scope = catalogScope(row.scope, intent.scope, 'response');
  const key = operationKey(row.idempotencyKey, 'response');
  const original = validateAnnualOriginal(row.original); const upload = validateAnnualOriginalUpload(row.upload, original);
  const deduplicated = catalogBoolean(row.deduplicated, 'write.deduplicated');
  const idempotentReplay = catalogBoolean(row.idempotentReplay, 'write.idempotentReplay');
  originalCheck(key === intent.idempotencyKey && original.sha256 === intent.sha256 && original.byteSize === intent.byteSize
    && upload.filename === intent.filename && upload.actorId === intent.actorId, 'write.intent');
  if (!deduplicated) originalCheck(original.firstFilename === upload.filename && original.createdBy === upload.actorId
    && original.createdByName === upload.actorName && original.createdByRole === upload.actorRole
    && original.createdAt === upload.createdAt, 'write.firstUpload');
  return { scope, idempotencyKey: key, original, upload, deduplicated, idempotentReplay };
}

export function validateAnnualOriginalReceipt(value: unknown, intent: AnnualOriginalIntent): AnnualOriginalReceipt {
  const row = catalogObject(value, ['scope', 'intent', 'result'], 'annualOriginals.receipt');
  const scope = catalogScope(row.scope, intent.scope, 'response');
  const receivedIntent = catalogObject(row.intent, ['filename', 'sha256', 'byteSize', 'idempotencyKey'], 'annualOriginals.receipt.intent');
  originalCheck(receivedIntent.filename === intent.filename && receivedIntent.sha256 === intent.sha256
    && receivedIntent.byteSize === intent.byteSize && receivedIntent.idempotencyKey === intent.idempotencyKey, 'receipt.intent');
  const result = row.result === null ? null : validateAnnualOriginalWrite(row.result, intent);
  originalCheck(result === null || result.idempotentReplay === true, 'receipt.replay');
  return { scope, intent: { filename: intent.filename, sha256: intent.sha256, byteSize: intent.byteSize, idempotencyKey: intent.idempotencyKey }, result };
}

export function encodeAnnualOriginalBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function decodeAnnualOriginalBytes(value: unknown, byteSize: number, boundary: Boundary): Uint8Array<ArrayBuffer> {
  originalCheck(typeof value === 'string' && value.length > 0 && value.length <= MAX_BASE64_LENGTH
    && value.length === 4 * Math.ceil(byteSize / 3) && value.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'base64', boundary);
  let binary: string;
  try { binary = atob(value); }
  catch { throw new AnnualCatalogContractError(boundary, 'annualOriginals.base64'); }
  originalCheck(binary.length === byteSize && btoa(binary) === value, 'base64.canonical', boundary);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function annualOriginalSha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  originalCheck(typeof globalThis.crypto?.subtle?.digest === 'function', 'sha256.unavailable', 'input');
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
