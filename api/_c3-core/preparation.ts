/** Read bridge for internal computation only; HTTP must use the isolated worker. */
import type { AuthenticatedCaller } from '../_lib/supabase.ts';
import type { AnnualCatalogScope } from '../../src/features/central-needs/annual-catalog/annual-catalog.contract.ts';
import { readAnnualOriginalAsCaller } from './original-reader.ts';
import { createAnnualSourceComputer, type RegisteredAnnualLayout } from './computation.ts';
export type { RegisteredAnnualLayout, AnnualPreparationResult } from './computation.ts';

export function createAnnualOriginalPreparationService(registrations: readonly RegisteredAnnualLayout[]) {
  const computer = createAnnualSourceComputer(registrations);
  return {
    async prepare(caller: AuthenticatedCaller, scope: AnnualCatalogScope, originalId: string) {
      return computer.compute(await readAnnualOriginalAsCaller(caller, scope, originalId));
    },
  };
}
