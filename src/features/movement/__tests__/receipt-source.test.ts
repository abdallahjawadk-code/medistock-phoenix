/**
 * MOVEMENT-COMPOSER-A — the server-row → ReceiptDocument mappers are pure and
 * copy canonical values verbatim: nothing inferred, nothing fabricated, and the
 * watermark is honest about how final the document is.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildSupplyRequestReceipt, buildSupplyDispatchReceipt,
  dispatchExceptionRows, requestWatermark, movementWatermark,
} from '../receipt-source';
import type {
  TransferRequest, TransferRequestLine, Transfer, IncomingTransferLine,
} from '@/features/network/network.service';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

const request = (over: Partial<TransferRequest> = {}): TransferRequest => ({
  id: UUID_A, routeId: null, direct: true,
  sourceWarehouseId: 'sw', sourceOrganizationId: 'so',
  destinationWarehouseId: 'dw', destinationOrganizationId: 'do',
  requestNumber: 'EXT-9', status: 'draft', notes: null, createdAt: '2026-07-20T10:00:00Z',
  ...over,
});

const reqLine = (over: Partial<TransferRequestLine> = {}): TransferRequestLine => ({
  id: 'l1', transferRequestId: UUID_A, scientificName: 'Amoxicillin',
  concentration: '500mg', dosageForm: 'capsule', unit: 'box',
  requestedQuantity: 10, approvedQuantity: null, fulfilledQuantity: 0, status: 'pending', notes: null,
  ...over,
});

describe('buildSupplyRequestReceipt', () => {
  it('maps a request to a supply_request document keyed by the immutable uuid', () => {
    const doc = buildSupplyRequestReceipt({
      request: request(), lines: [reqLine()],
      source: { organizationName: 'Central', warehouseName: 'Main' },
      destination: { organizationName: 'Hospital A', warehouseName: 'Depot' },
    });
    expect(doc.kind).toBe('supply_request');
    expect(doc.traceKey).toBe(UUID_A);
    // Operator number is an external reference, never the trace key.
    expect(doc.externalReference).toBe('EXT-9');
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({
      lineNumber: 1, scientificName: 'Amoxicillin', concentration: '500mg',
      requestedQuantity: 10, movedQuantity: null, receivedQuantity: null,
    });
  });

  it('never fabricates identity/actor fields — they stay null until server-exposed', () => {
    const doc = buildSupplyRequestReceipt({
      request: request(), lines: [reqLine()],
      source: { organizationName: null, warehouseName: null },
      destination: { organizationName: null, warehouseName: null },
    });
    expect(doc.actorName).toBeNull();
    expect(doc.counterpartyName).toBeNull();
    expect(doc.lines[0].batchNumber).toBeNull();
    expect(doc.lines[0].unitPrice).toBeNull();
  });

  it('watermarks a draft/submitted request as draft, a cancelled one as cancelled', () => {
    expect(requestWatermark('draft')).toBe('draft');
    expect(requestWatermark('submitted')).toBe('draft');
    expect(requestWatermark('cancelled')).toBe('cancelled');
    expect(requestWatermark('rejected')).toBe('cancelled');
    expect(requestWatermark('approved')).toBe('none');
  });
});

const transfer = (over: Partial<Transfer> = {}): Transfer => ({
  id: UUID_B, routeId: null, direct: true, transferRequestId: UUID_A,
  sourceWarehouseId: 'sw', destinationWarehouseId: 'dw', destinationOrganizationId: 'do',
  transferNumber: 'T-1', status: 'in_transit', documentNumber: null,
  ...over,
});

const incLine = (over: Partial<IncomingTransferLine> = {}): IncomingTransferLine => ({
  id: 'il1', transferId: UUID_B, sourceOrganizationId: 'so', sourceWarehouseStockId: 'ws',
  transferRequestLineId: 'rl1', centralItemId: 'ci', scientificName: 'Amoxicillin',
  tradeName: 'Amoxil', concentration: '500mg', dosageForm: 'capsule', unit: 'box',
  nationalCode: 'NC1', hasNoNationalCode: false, batchNumber: 'B7', hasNoBatchNumber: false,
  internalBatchReference: null, expiryDate: '2027-01-01', unitPrice: 12, priceBasis: 'unit',
  currency: 'IQD', supplyTypeText: 'grant', sentQuantity: 10, receivedQuantity: null,
  returnedQuantity: 0, returnReceivedQuantity: 0, status: 'in_transit',
  differenceReason: null, receivedAt: null, resultingWarehouseStockId: null,
  ...over,
});

describe('buildSupplyDispatchReceipt', () => {
  it('carries the FULL immutable dispatch record and links back to the request', () => {
    const doc = buildSupplyDispatchReceipt({
      transfer: transfer(), lines: [incLine()],
      source: { organizationName: 'Central', warehouseName: 'Main' },
      destination: { organizationName: 'Hospital A', warehouseName: 'Depot' },
    });
    expect(doc.kind).toBe('supply_dispatch');
    expect(doc.traceKey).toBe(UUID_B);
    expect(doc.requestTraceKey).toBe(UUID_A);
    expect(doc.lines[0]).toMatchObject({
      scientificName: 'Amoxicillin', tradeName: 'Amoxil', batchNumber: 'B7',
      expiryDate: '2027-01-01', movedQuantity: 10, unitPrice: 12, currency: 'IQD',
      originalSupplyReference: 'rl1',
    });
  });

  it('an in-transit / partial dispatch is watermarked partial, never final', () => {
    expect(movementWatermark('in_transit')).toBe('partial');
    expect(movementWatermark('partially_received')).toBe('partial');
    expect(movementWatermark('received')).toBe('none');
    expect(movementWatermark('cancelled')).toBe('cancelled');
  });
});

describe('dispatchExceptionRows', () => {
  it('flags any received quantity that disagrees with what was dispatched', () => {
    const rows = dispatchExceptionRows([
      incLine({ receivedQuantity: 8, differenceReason: 'short 2' }),
      incLine({ id: 'il2', receivedQuantity: 10 }), // exact — not an exception
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('quantity_discrepancy');
    expect(rows[0].detail).toContain('sent 10');
    expect(rows[0].detail).toContain('received 8');
  });

  it('flags a pre-existing difference reason even without a quantity change', () => {
    const rows = dispatchExceptionRows([incLine({ differenceReason: 'damaged carton' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('flagged');
  });
});

// ── wiring: the receipt actions are mounted on the canonical request detail ──
const NET = join(__dirname, '..', '..', 'network');
const operations = readFileSync(join(NET, 'DirectSupplyOperations.tsx'), 'utf8');

describe('MovementDocumentActions mounted on the server-reloaded request detail', () => {
  it('builds the document from server rows and renders the actions', () => {
    expect(operations).toMatch(/buildSupplyRequestReceipt\(\{/);
    expect(operations).toMatch(/lines: lines\.data \?\? \[\]/);
    expect(operations).toMatch(/<MovementDocumentActions document=\{requestDocument\}/);
    // Only after the canonical lines have loaded — never from an unsaved draft.
    expect(operations).toMatch(/!lines\.loading && \(/);
  });
});
