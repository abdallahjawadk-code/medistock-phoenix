/**
 * OUTLET-RETURN sources — the returnable-lot provider for the composer.
 *
 * Materials come ONLY from canonical received dispatch lines: the outlet's own
 * 070 dispatches, their immutable line snapshots, filtered to what is genuinely
 * returnable (accepted receipt, still has headroom under safeReturnable). No
 * free-text entry, no OCR, no stock invented here — every field is a server row.
 *
 * Reads are injected so the whole provider is testable without Supabase.
 */
import {
  getOutletDispatches, getDispatchLinesForDispatches,
  type WarehouseDispatch, type WarehouseDispatchLine,
} from './dispatch.service';
import { isReturnable, type ExistingReturnLine } from './outlet-return-model';
import type { OutletReturnableLine } from './outlet-return-draft';

export interface OutletReturnableSourcesDeps {
  getDispatches?: typeof getOutletDispatches;
  getLines?: typeof getDispatchLinesForDispatches;
}

/** Map one immutable dispatch-line snapshot to a returnable source. */
export function toReturnableLine(
  line: WarehouseDispatchLine,
  dispatch: WarehouseDispatch | undefined,
): OutletReturnableLine {
  return {
    dispatchLineId: line.id,
    scientificName: line.scientificName,
    batchNumber: line.batchNumber,
    expiryDate: line.expiryDate,
    unit: line.unit,
    receivedQuantity: line.receivedQuantity,
    returnedQuantity: line.returnedQuantity,
    status: line.status,
    tradeName: line.tradeName,
    concentration: line.concentration,
    dosageForm: line.dosageForm,
    nationalCode: line.nationalCode,
    internalBatchReference: line.internalBatchReference,
    dispatchNumber: dispatch?.dispatchNumber ?? null,
    dispatchSentAt: dispatch?.sentAt ?? null,
  };
}

/**
 * Every lot this outlet may still return, soonest-expiry first.
 *
 * Two batched reads joined in memory — never an N+1 walk: the outlet's
 * dispatches, then all their lines in one query. `existingLines` (the outlet's
 * live return-request lines) lets safeReturnable subtract unshipped
 * reservations so the offered cap matches what the server will accept.
 */
export async function loadOutletReturnableSources(
  distributionPointId: string,
  existingLines: readonly ExistingReturnLine[] = [],
  deps: OutletReturnableSourcesDeps = {},
): Promise<OutletReturnableLine[]> {
  if (!distributionPointId) return [];
  const getDispatches = deps.getDispatches ?? getOutletDispatches;
  const getLines = deps.getLines ?? getDispatchLinesForDispatches;

  const dispatches = await getDispatches(distributionPointId);
  if (dispatches.length === 0) return [];
  const dispatchById = new Map(dispatches.map(d => [d.id, d]));

  const lines = await getLines(dispatches.map(d => d.id));
  return lines
    .map(line => toReturnableLine(line, dispatchById.get(line.dispatchId)))
    .filter(source => isReturnable(source, existingLines))
    .sort((a, b) => (a.expiryDate ?? '9999-12-31').localeCompare(b.expiryDate ?? '9999-12-31'));
}
