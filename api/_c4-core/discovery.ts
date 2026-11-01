/** Scoped availability of explicitly reviewed profiles. This does not read a
 * workbook, recognize its layout, or approve a catalog material. */
import type { AuthenticatedCaller } from '../_lib/supabase.ts';
import { errorResponse, jsonResponse } from '../_lib/http.ts';
import type { RegisteredAnnualLayout } from '../_c3-core/computation.ts';
import { snapshotReviewedLayouts } from '../_c3-core/registry.ts';
import { C4_UUID, c4Record } from './input.ts';

interface Dependencies {
  registrations: readonly RegisteredAnnualLayout[];
  authenticate(request: Request): Promise<AuthenticatedCaller | null>;
  authorized(caller: AuthenticatedCaller, org: string, permission: string): Promise<boolean>;
}
export function createAnnualSourceDiscoveryHandler(deps: Dependencies) {
  const profiles = snapshotReviewedLayouts(deps.registrations).map(item => ({
    id: item.manifest.template.id, version: item.manifest.template.version, sha256: item.expectedSha256,
  }));
  return async function handle(request: Request): Promise<Response> {
    if (request.method !== 'GET') return errorResponse(405, 'method_not_allowed');
    try {
      const caller = await deps.authenticate(request); if (!caller) return errorResponse(401, 'not_authenticated');
      const query = new URL(request.url).searchParams;
      const owner = query.get('ownerOrgId'), year = query.get('planningYear');
      if ([...query].length !== 2 || query.getAll('ownerOrgId').length !== 1 || query.getAll('planningYear').length !== 1
        || typeof owner !== 'string' || !C4_UUID.test(owner) || typeof year !== 'string' || !/^20\d\d$|^2100$/.test(year)) {
        return errorResponse(400, 'invalid_request');
      }
      const scope = { ownerOrgId: owner.toLowerCase(), planningYear: Number(year) };
      if (!await deps.authorized(caller, scope.ownerOrgId, 'central_needs.view')) return errorResponse(403, 'forbidden');
      let commitState: 'unavailable_registry' | 'forbidden' | 'missing_candidate' | 'inactive' | 'ready' = 'unavailable_registry';
      if (profiles.length) {
        commitState = 'forbidden';
        if (await deps.authorized(caller, scope.ownerOrgId, 'central_needs.edit')) {
          const contract = await caller.client.rpc('phoenix_c4_catalog_contract', {
            p_organization_id: scope.ownerOrgId, p_planning_year: scope.planningYear,
          });
          if (contract.error?.code === 'PGRST202') commitState = 'missing_candidate';
          else {
            const value = c4Record(contract.data);
            if (contract.error || value?.version !== 1 || typeof value.enabled !== 'boolean' || value.catalogCommitImplemented !== true
              || value.trustedPreparationRequiresServer !== true || value.maxPageRows !== 50 || value.maxEvidenceBytes !== 262144) {
              return errorResponse(503, 'annual_source_discovery_unavailable');
            }
            commitState = value.enabled ? 'ready' : 'inactive';
          }
        }
      }
      if (!await deps.authorized(caller, scope.ownerOrgId, 'central_needs.view')) return errorResponse(403, 'forbidden');
      return jsonResponse(200, { ok: true, capabilities: { version: 1, scope, selectionMode: 'explicit_reviewed_profile',
        readAvailable: profiles.length > 0, commitState, profiles, maxPageRows: 50, maxRequestBytes: 16384 } });
    } catch { return errorResponse(503, 'annual_source_discovery_unavailable'); }
  };
}
