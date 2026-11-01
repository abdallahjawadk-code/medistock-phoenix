/** Node read bridge only. Authenticate upstream; C2 rechecks current authority.
 * No service identity, browser-supplied bytes, persistence or approval. */
import { createHash } from 'node:crypto';
import type { AuthenticatedCaller } from '../_lib/supabase.ts';
import type { AnnualCatalogScope } from '../../src/features/central-needs/annual-catalog/annual-catalog.contract.ts';
import type { AnnualExtractionOriginal } from '../../src/features/central-needs/annual-catalog/annual-extraction-core.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 3_145_728;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireResponse(ok: unknown): asserts ok {
  if (!ok) throw new Error('c3_original_response_invalid');
}

export async function readAnnualOriginalAsCaller(caller: AuthenticatedCaller, requestedScope: AnnualCatalogScope,
  originalId: string): Promise<AnnualExtractionOriginal> {
  if (!record(requestedScope) || typeof requestedScope.ownerOrgId !== 'string' || !uuid.test(requestedScope.ownerOrgId)
    || !Number.isInteger(requestedScope.planningYear) || requestedScope.planningYear < 2000 || requestedScope.planningYear > 2100
    || typeof originalId !== 'string' || !uuid.test(originalId)) {
    throw new Error('c3_original_input_invalid');
  }
  const scope = { ownerOrgId: requestedScope.ownerOrgId.toLowerCase(), planningYear: requestedScope.planningYear };
  const id = originalId.toLowerCase();
  let result;
  try {
    result = await caller.client.rpc('phoenix_central_needs_download_annual_original', {
      p_organization_id: scope.ownerOrgId, p_planning_year: scope.planningYear, p_original_id: id,
    });
  } catch { throw new Error('c3_original_unavailable'); }
  if (result.error) throw new Error('c3_original_unavailable');
  const data: unknown = result.data;
  requireResponse(record(data) && record(data.scope) && record(data.original));
  requireResponse(data.scope.ownerOrgId === scope.ownerOrgId && data.scope.planningYear === scope.planningYear);
  const original = data.original;
  requireResponse(original.originalId === id && original.attestation === 'server_received_original'
    && typeof original.sha256 === 'string' && /^[0-9a-f]{64}$/.test(original.sha256)
    && typeof original.byteSize === 'number' && Number.isSafeInteger(original.byteSize)
    && original.byteSize > 0 && original.byteSize <= MAX_BYTES);
  const filename = original.firstFilename;
  requireResponse(typeof filename === 'string' && filename.length > 0 && filename.length <= 255
    && filename === filename.trim() && !filename.startsWith('~$') && /\.(xls|xlsx|csv)$/i.test(filename)
    && !/[\/\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(filename));
  requireResponse(typeof data.base64 === 'string' && data.base64.length === 4 * Math.ceil(original.byteSize / 3)
    && data.base64.length <= 4 * Math.ceil(MAX_BYTES / 3) && /^[A-Za-z0-9+/]*={0,2}$/.test(data.base64));
  const bytes = Buffer.from(data.base64, 'base64');
  requireResponse(bytes.length === original.byteSize && bytes.toString('base64') === data.base64
    && createHash('sha256').update(bytes).digest('hex') === original.sha256);
  // Canonical C2 firstFilename identifies these retained bytes. Renamed upload
  // history remains in C2; this bridge never rewrites it or accepts a new name.
  return { origin: 'c2_original', scope, originalId: id, filename, sha256: original.sha256,
    byteSize: original.byteSize, bytes: new Uint8Array(bytes) };
}
