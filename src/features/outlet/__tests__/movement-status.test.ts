/**
 * CURRENT MOVEMENT STATUS resolver — RLS-scoped reads, no existence leak.
 *
 * Proves the security-critical rule: an unknown id and an unauthorized id
 * (filtered out by RLS, so absent from the read) return the SAME generic
 * `not_available` — the resolver can never be used to probe whether a record
 * exists. Also pins input parsing and the current-state mapping.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseMovementStatusInput, resolveMovementStatus, type MovementStatusDeps,
} from '../movement-status';
import { buildMovementQrPayload } from '@/features/movement/movement-trace';
import type { OutletReturnRequest, OutletReturnShipment } from '../outlet-return.service';

const REQ_ID = '11111111-1111-4111-8111-111111111111';
const SHIP_ID = '22222222-2222-4222-8222-222222222222';

const request: OutletReturnRequest = {
  id: REQ_ID, distributionPointId: 'OUT1', sourceOrganizationId: 'org',
  destinationWarehouseId: 'WH1', destinationOrganizationId: 'org', returnNumber: 'RET-1',
  status: 'submitted', requestedBySide: 'outlet', notes: null, createdAt: '2026-07-01T00:00:00Z',
};
const shipment: OutletReturnShipment = {
  id: SHIP_ID, returnRequestId: REQ_ID, distributionPointId: 'OUT1',
  destinationWarehouseId: 'WH1', shipmentNumber: 'SHP-1', status: 'in_transit',
};

function deps(over: Partial<MovementStatusDeps> = {}): MovementStatusDeps {
  return {
    getReturnRequests: vi.fn(async () => [request]),
    getReturnRequestLines: vi.fn(async () => [{
      id: 'L1', returnRequestId: REQ_ID, originalDispatchLineId: 'DL-9', sourceOutletStockId: 'OS1',
      scientificName: 'Amoxicillin', concentration: null, dosageForm: null, unit: null, nationalCode: null,
      batchNumber: 'B-1', internalBatchReference: null, expiryDate: '2027-01-01', reasonCode: 'damaged',
      reasonText: null, requestedQuantity: 5, approvedQuantity: null, fulfilledQuantity: 0, status: 'pending',
    }]),
    getReturnShipments: vi.fn(async () => [shipment]),
    getReturnShipmentLines: vi.fn(async () => [{
      id: 'SL1', shipmentId: SHIP_ID, returnRequestLineId: 'L1', originalDispatchLineId: 'DL-9',
      scientificName: 'Amoxicillin', batchNumber: 'B-1', expiryDate: '2027-01-01', sentQuantity: 5,
      receivedQuantity: 5, status: 'received', differenceReason: null, disposition: 'quarantined',
      custodyState: 'destination_quarantine',
    }]),
    ...over,
  };
}

describe('parseMovementStatusInput', () => {
  it('accepts a scanned QR payload and reads its kind', () => {
    const raw = buildMovementQrPayload('return_shipment', SHIP_ID);
    expect(parseMovementStatusInput(raw)).toEqual({ kind: 'return_shipment', id: SHIP_ID });
  });

  it('accepts a bare uuid with an explicit kind hint', () => {
    expect(parseMovementStatusInput(REQ_ID, 'return_request')).toEqual({ kind: 'return_request', id: REQ_ID });
  });

  it('rejects a bare uuid with no kind, and any non-canonical input', () => {
    expect(parseMovementStatusInput(REQ_ID)).toBeNull();
    expect(parseMovementStatusInput('not-a-uuid', 'return_request')).toBeNull();
    expect(parseMovementStatusInput('')).toBeNull();
  });
});

describe('resolveMovementStatus — current state', () => {
  it('resolves a return request to its current status and provenance', async () => {
    const r = await resolveMovementStatus({ kind: 'return_request', id: REQ_ID }, deps());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status.traceKey).toBe(REQ_ID);
      expect(r.status.externalReference).toBe('RET-1');
      expect(r.status.lines[0].provenance).toBe('DL-9');
      expect(r.status.lines[0].reason).toBe('damaged');
    }
  });

  it('resolves a shipment with disposition and custody', async () => {
    const r = await resolveMovementStatus({ kind: 'return_shipment', id: SHIP_ID }, deps());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status.kind).toBe('return_shipment');
      expect(r.status.lines[0].disposition).toBe('quarantined');
      expect(r.status.lines[0].custodyState).toBe('destination_quarantine');
      expect(r.status.lines[0].receivedQuantity).toBe(5);
    }
  });
});

describe('no existence leak', () => {
  it('returns the SAME not_available for an unknown id and an RLS-hidden id', async () => {
    // Unknown: id not in the (fully readable) list.
    const unknown = await resolveMovementStatus(
      { kind: 'return_request', id: '33333333-3333-4333-8333-333333333333' }, deps());
    // Unauthorized: RLS filtered it out, so the scoped read returns an empty list.
    const hidden = await resolveMovementStatus(
      { kind: 'return_request', id: REQ_ID }, deps({ getReturnRequests: vi.fn(async () => []) }));
    expect(unknown).toEqual({ ok: false, reason: 'not_available' });
    expect(hidden).toEqual({ ok: false, reason: 'not_available' });
  });

  it('never fetches lines for a document it could not read', async () => {
    const d = deps({ getReturnShipments: vi.fn(async () => []) });
    await resolveMovementStatus({ kind: 'return_shipment', id: SHIP_ID }, d);
    expect(d.getReturnShipmentLines).not.toHaveBeenCalled();
  });
});

describe('boundaries', () => {
  it('rejects a non-uuid target as invalid input', async () => {
    const r = await resolveMovementStatus({ kind: 'return_request', id: 'nope' }, deps());
    expect(r).toEqual({ ok: false, reason: 'invalid_input' });
  });

  it('reports supply kinds as unsupported without touching return reads', async () => {
    const d = deps();
    const r = await resolveMovementStatus({ kind: 'supply_dispatch', id: REQ_ID }, d);
    expect(r).toEqual({ ok: false, reason: 'unsupported_kind', kind: 'supply_dispatch' });
    expect(d.getReturnRequests).not.toHaveBeenCalled();
  });
});
