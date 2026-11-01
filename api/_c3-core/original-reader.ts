/** C3 bridge to the existing PR266 caller/contract/integrity reader.
 * Authentication is upstream; this adapter only narrows its proven source DTO. */
import { readAuthorizedAnnualC3Original } from '../_cn2b-core/annual-c3-authorized-source.ts';
import type { AuthenticatedCaller } from '../_lib/supabase.ts';
import type { AnnualCatalogScope } from '../../src/features/central-needs/annual-catalog/annual-catalog.contract.ts';
import type { AnnualExtractionOriginal } from '../../src/features/central-needs/annual-catalog/annual-extraction-core.ts';

export async function readAnnualOriginalAsCaller(caller: AuthenticatedCaller, scope: AnnualCatalogScope,
  originalId: string): Promise<AnnualExtractionOriginal> {
  const source = await readAuthorizedAnnualC3Original(caller, scope, originalId);
  return { origin: 'c2_original', scope: { ...source.scope }, originalId: source.original.originalId,
    filename: source.original.firstFilename, sha256: source.original.sha256,
    byteSize: source.original.byteSize, bytes: source.bytes };
}
