/**
 * OUTLET-RETURN sources provider — reads injected, no Supabase.
 *
 * Proves the provider offers ONLY genuinely returnable dispatch lines, carries
 * the immutable provenance through, and subtracts reservations — the data the
 * composer draws from, so a free-text or non-received lot can never appear.
 */
import { describe, it, expect, vi } from 'vitest';
import { loadOutletReturnableSources } from '../outlet-return-sources';
import type { WarehouseDispatch, WarehouseDispatchLine } from '../dispatch.service';
import type { ExistingReturnLine } from '../outlet-return-model';

const dispatch = (over: Partial<WarehouseDispatch> = {}): WarehouseDispatch => ({
  id: 'D1', organizationId: 'org', warehouseId: 'wh', destinationDistributionPointId: 'OUT1',
  dispatchNumber: 'D-100', status: 'accepted', documentNumber: null, defaultCurrency: null,
  notes: null, sentAt: '2026-06-01', createdAt: '2026-06-01', ...over,
});

const dline = (over: Partial<WarehouseDispatchLine> = {}): WarehouseDispatchLine => ({
  id: 'DL1', dispatchId: 'D1', warehouseStockId: 'WS1', scientificName: 'Amoxicillin',
  tradeName: null, concentration: null, dosageForm: null, unit: 'box', nationalCode: null,
  batchNumber: 'B-1', internalBatchReference: null, expiryDate: '2027-01-01', unitPrice: null,
  currency: null, supplyTypeText: null, sentQuantity: 40, receivedQuantity: 40, returnedQuantity: 0,
  status: 'accepted', differenceReason: null, ...over,
});

function deps(dispatches: WarehouseDispatch[], lines: WarehouseDispatchLine[]) {
  return {
    getDispatches: vi.fn(async () => dispatches),
    getLines: vi.fn(async (_ids: string[]) => lines),
  };
}

describe('loadOutletReturnableSources', () => {
  it('offers a received, accepted line with headroom, carrying its provenance', async () => {
    const d = deps([dispatch()], [dline({ receivedQuantity: 40, returnedQuantity: 10 })]);
    const sources = await loadOutletReturnableSources('OUT1', [], d);
    expect(sources).toHaveLength(1);
    expect(sources[0].dispatchLineId).toBe('DL1');
    expect(sources[0].dispatchNumber).toBe('D-100');
    expect(sources[0].dispatchSentAt).toBe('2026-06-01');
  });

  it('excludes a line the outlet never received', async () => {
    const d = deps([dispatch()], [dline({ receivedQuantity: null })]);
    expect(await loadOutletReturnableSources('OUT1', [], d)).toHaveLength(0);
  });

  it('excludes a line with no headroom left', async () => {
    const d = deps([dispatch()], [dline({ receivedQuantity: 20, returnedQuantity: 20 })]);
    expect(await loadOutletReturnableSources('OUT1', [], d)).toHaveLength(0);
  });

  it('excludes a line that is not an accepted receipt', async () => {
    const d = deps([dispatch()], [dline({ status: 'pending' })]);
    expect(await loadOutletReturnableSources('OUT1', [], d)).toHaveLength(0);
  });

  it('subtracts an active reservation so an exhausted lot drops out', async () => {
    const existing: ExistingReturnLine[] = [{
      originalDispatchLineId: 'DL1', requestedQuantity: 40, approvedQuantity: null,
      fulfilledQuantity: 0, status: 'pending',
    }];
    const d = deps([dispatch()], [dline({ receivedQuantity: 40, returnedQuantity: 0 })]);
    expect(await loadOutletReturnableSources('OUT1', existing, d)).toHaveLength(0);
  });

  it('sorts soonest-expiry first', async () => {
    const d = deps([dispatch()], [
      dline({ id: 'DL-late', expiryDate: '2028-01-01' }),
      dline({ id: 'DL-soon', expiryDate: '2026-09-01' }),
    ]);
    const sources = await loadOutletReturnableSources('OUT1', [], d);
    expect(sources.map(s => s.dispatchLineId)).toEqual(['DL-soon', 'DL-late']);
  });

  it('reads no lines when the outlet has no dispatches', async () => {
    const d = deps([], [dline()]);
    expect(await loadOutletReturnableSources('OUT1', [], d)).toHaveLength(0);
    expect(d.getLines).not.toHaveBeenCalled();
  });

  it('returns empty for a missing distribution point without any read', async () => {
    const d = deps([dispatch()], [dline()]);
    expect(await loadOutletReturnableSources('', [], d)).toHaveLength(0);
    expect(d.getDispatches).not.toHaveBeenCalled();
  });
});
