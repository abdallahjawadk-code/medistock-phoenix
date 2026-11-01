/**
 * C3-1b — PRIVATE server-side C2 original reader, no HTTP route and no writes.
 * The caller must originate from api/_lib/supabase.authenticate(req).
 * Every database request uses the verified employee's JWT, not service_role.
 * This is transport verification, NOT a second Excel/material parser.
 * No endpoint may invoke a parser without a separate enforceable worker limit.
 */
import { createHash } from 'node:crypto';
import type { AuthenticatedCaller } from '../_lib/supabase.ts';

/** Wire shapes deliberately isolated from application UI imports in tsconfig.api. */
export interface C3OriginalScope {
  readonly ownerOrgId: string;
  readonly planningYear: number;
}
export interface C3OriginalMetadata {
  readonly originalId: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly firstFilename: string;
  readonly createdBy: string;
  readonly createdByName: string;
  readonly createdByRole: string;
  readonly createdAt: string;
  readonly attestation: 'server_received_original';
}
export interface AuthorizedC3Original {
  readonly scope: C3OriginalScope;
  readonly original: C3OriginalMetadata;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

const MAX_BYTES = 3_145_728;
const MAX_BASE64_CHARS = Math.ceil(MAX_BYTES / 3) * 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const UNSAFE_NAME = /[\/\\\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

function reject(name: string): never { throw new Error('annual_c3_' + name); }
function object(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject(label);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || fields.some(k => !Object.hasOwn(record, k))) {
    return reject(label);
  }
  return record;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) return reject('invalid_uuid');
  return value.toLowerCase();
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max ||
      value.trim().length === 0 || CONTROL.test(value)) return reject('invalid_metadata');
  return value;
}
function scopeOf(value: unknown, expected?: C3OriginalScope): C3OriginalScope {
  const r = object(value, ['ownerOrgId', 'planningYear'], 'invalid_scope');
  const scope = { ownerOrgId: uuid(r.ownerOrgId), planningYear: r.planningYear };
  if (!Number.isSafeInteger(scope.planningYear) || (scope.planningYear as number) < 2000 ||
      (scope.planningYear as number) > 2100) return reject('invalid_scope');
  const checked = { ownerOrgId: scope.ownerOrgId, planningYear: scope.planningYear as number };
  if (expected && (expected.ownerOrgId !== checked.ownerOrgId ||
      expected.planningYear !== checked.planningYear)) return reject('scope_mismatch');
  return checked;
}
function validContract(value: unknown): void {
  const x = object(value, ['version','scope','maxFileBytes','extensions','attestation',
    'atomicReceipt','intentBoundReplay'], 'capability_invalid');
  if (x.version !== 1 || x.scope !== 'owner_year' || x.maxFileBytes !== MAX_BYTES ||
      x.attestation !== 'server_received_original' || x.atomicReceipt !== true ||
      x.intentBoundReplay !== true || !Array.isArray(x.extensions) ||
      x.extensions.length !== 3 || x.extensions[0] !== 'xls' ||
      x.extensions[1] !== 'xlsx' || x.extensions[2] !== 'csv') return reject('capability_invalid');
}
function validateOriginal(value: unknown, requestedId: string): C3OriginalMetadata {
  const x = object(value, ['originalId','sha256','byteSize','firstFilename','createdBy',
    'createdByName','createdByRole','createdAt','attestation'], 'original_invalid');
  const originalId = uuid(x.originalId);
  if (originalId !== requestedId) return reject('original_identity_mismatch');
  if (typeof x.sha256 !== 'string' || !SHA256.test(x.sha256) ||
      !Number.isSafeInteger(x.byteSize) || (x.byteSize as number) < 1 ||
      (x.byteSize as number) > MAX_BYTES ||
      x.attestation !== 'server_received_original') return reject('original_invalid');
  const filename = text(x.firstFilename, 255);
  if (filename !== filename.trim() || UNSAFE_NAME.test(filename) ||
      filename.startsWith('~$') || !/\.(xls|xlsx|csv)$/i.test(filename)) return reject('original_invalid');
  const name = text(x.createdByName, 4000);
  const role = text(x.createdByRole, 128);
  const at = text(x.createdAt, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(at) ||
      !Number.isFinite(Date.parse(at))) return reject('original_invalid');
  return {
    originalId, sha256: x.sha256, byteSize: x.byteSize as number,
    firstFilename: filename, createdBy: uuid(x.createdBy), createdByName: name,
    createdByRole: role, createdAt: at, attestation: 'server_received_original',
  };
}
function validatedBytes(value: unknown, original: C3OriginalMetadata): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length === 0 ||
      value.length > MAX_BASE64_CHARS || value.length !== Math.ceil(original.byteSize / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return reject('base64_invalid');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== original.byteSize || bytes.toString('base64') !== value) {
    return reject('base64_invalid');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== original.sha256) {
    return reject('original_sha256_mismatch');
  }
  // Explicit copy prevents caller mutation of an underlying Buffer-backed view.
  return Uint8Array.from(bytes);
}
/**
 * Read current employee authority, verify exact C2 contract, download the
 * immutable original under the actor's JWT, and recheck size and SHA-256.
 * A missing/denied RPC never becomes permission to use legacy imports.
 */
export async function readAuthorizedAnnualC3Original(
  caller: AuthenticatedCaller, targetScope: C3OriginalScope, originalId: string,
): Promise<AuthorizedC3Original> {
  if (!caller || !caller.client || typeof caller.client.rpc !== 'function' ||
      typeof caller.accessToken !== 'string' || caller.accessToken.length === 0) {
    return reject('not_authenticated');
  }
  uuid(caller.userId);
  const scope = scopeOf(targetScope);
  const id = uuid(originalId);

  let authorized = false;
  try {
    const { data, error } = await caller.client.rpc('phoenix_central_needs_actor_authorized', {
      p_organization_id: scope.ownerOrgId, p_key: 'central_needs.view',
    });
    authorized = !error && data === true;
  } catch { /* no fallback when authority is unreadable */ }
  if (!authorized) return reject('forbidden');

  let contract: unknown;
  try {
    const { data, error } = await caller.client.rpc('phoenix_central_needs_annual_originals_contract');
    if (error || data === null || data === undefined) throw new Error('unavailable');
    contract = data;
  } catch {
    return reject('capability_unavailable');
  }
  validContract(contract);

  let data: unknown;
  try {
    const result = await caller.client.rpc('phoenix_central_needs_download_annual_original', {
      p_organization_id: scope.ownerOrgId, p_planning_year: scope.planningYear, p_original_id: id,
    });
    if (result.error || result.data === null || result.data === undefined) throw new Error('unavailable');
    data = result.data;
  } catch {
    return reject('original_unavailable');
  }

  const result = object(data, ['scope','original','base64'], 'original_response_invalid');
  const responseScope = scopeOf(result.scope, scope);
  const original = validateOriginal(result.original, id);
  const bytes = validatedBytes(result.base64, original);
  return { scope: responseScope, original, bytes };
}
