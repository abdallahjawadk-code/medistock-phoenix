/**
 * C3-1b — PRIVATE server-only read bridge. Not an HTTP endpoint.
 * The caller must originate from api/_lib/supabase.authenticate(req).
 * All reads use that actor's JWT and existing C2 authorization, never a service
 * role. The output is source bytes, not approved cells, materials or quantities.
 * A worker-enforced parser boundary is required before an endpoint can use it.
 */
import type { AuthenticatedCaller } from '../_lib/supabase.ts';
import type { AnnualCatalogScope } from '../../src/features/central-needs/annual-catalog/annual-catalog.contract.ts';
import { catalogObject, catalogScope, catalogUuid } from
  '../../src/features/central-needs/annual-catalog/annual-catalog-server.contract.ts';
import {
  annualOriginalSha256, decodeAnnualOriginalBytes, validateAnnualOriginal,
  validateAnnualOriginalsContract, type AnnualOriginal,
} from '../../src/features/central-needs/annual-catalog/annual-originals.contract.ts';

export interface AuthorizedC3Original {
  readonly scope: AnnualCatalogScope;
  readonly original: AnnualOriginal;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/**
 * This function performs no SQL mutation or parser execution. If capability,
 * current role or original differs from the requested owner/year, fail closed.
 * No caller-provided employee name, upload attestation, material or mapping.
 */
export async function readAuthorizedAnnualC3Original(
  caller: AuthenticatedCaller, targetScope: AnnualCatalogScope, originalId: string,
): Promise<AuthorizedC3Original> {
  if (!caller || typeof caller.client?.rpc !== 'function') throw new Error('annual_c3_not_authenticated');
  catalogUuid(caller.userId, 'annualC3.actor');
  const scope = catalogScope(targetScope);
  const id = catalogUuid(originalId, 'annualC3.originalId');

  // Independent fresh authority check in the user's own JWT context.
  let permitted = false;
  try {
    const { data, error } = await caller.client.rpc('phoenix_central_needs_actor_authorized', {
      p_organization_id: scope.ownerOrgId, p_key: 'central_needs.view',
    });
    permitted = !error && data === true;
  } catch { /* a network/error response is not permission */ }
  if (!permitted) throw new Error('annual_c3_forbidden');

  // The exact capability is mandatory: never redirect to legacy quantity import.
  let contract: unknown;
  try {
    const { data, error } = await caller.client.rpc('phoenix_central_needs_annual_originals_contract');
    if (error || data === null || data === undefined) throw new Error('unavailable');
    contract = data;
  } catch {
    throw new Error('annual_c3_capability_unavailable');
  }
  validateAnnualOriginalsContract(contract);

  // This C2 SECURITY DEFINER RPC independently rechecks the actor and scope
  // and re-hashes the immutable original bytes before returning them.
  let result: unknown;
  try {
    const { data, error } = await caller.client.rpc('phoenix_central_needs_download_annual_original', {
      p_organization_id: scope.ownerOrgId, p_planning_year: scope.planningYear, p_original_id: id,
    });
    if (error || data === null || data === undefined) throw new Error('unavailable');
    result = data;
  } catch {
    // No untrusted PostgREST exception or free-text detail is returned.
    throw new Error('annual_c3_original_unavailable');
  }

  const record = catalogObject(result, ['scope', 'original', 'base64'], 'annualC3.original', 'response');
  const serverScope = catalogScope(record.scope, scope, 'response');
  const original = validateAnnualOriginal(record.original);
  if (original.originalId !== id) throw new Error('annual_c3_original_identity_mismatch');
  const bytes = decodeAnnualOriginalBytes(record.base64, original.byteSize, 'response');
  if (await annualOriginalSha256(bytes) !== original.sha256) {
    throw new Error('annual_c3_original_sha256_mismatch');
  }
  return { scope: serverScope, original, bytes };
}
