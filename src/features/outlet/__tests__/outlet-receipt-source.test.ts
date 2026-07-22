/**
 * OUTLET-RETURN receipts — built from server rows, rendered XSS-safe.
 *
 * Proves the canonical document rules for the return corridor: the immutable
 * uuid is the trace key (the operator number is only an external reference),
 * provenance and disposition are copied verbatim, watermarks stay honest, and a
 * hostile server value cannot break out of the shared print renderer.
 */
import { describe, it, expect } from 'vitest';
import {
  buildOutletReturnRequestReceipt, buildOutletReturnShipmentReceipt,
} from '../outlet-receipt-source';
import { buildReceiptHtml } from '@/features/movement/receipt-html';
import { RECEIPT_FIELDS } from '@/features/movement/receipt-model';
import type {
  OutletReturnRequest, OutletReturnRequestLine,
  OutletReturnShipment, OutletReturnShipmentLine,
} from '../outlet-return.service';

const req = (over: Partial<OutletReturnRequest> = {}): OutletReturnRequest => ({
  id: '11111111-1111-4111-8111-111111111111', distributionPointId: 'OUT1',
  sourceOrganizationId: 'org', destinationWarehouseId: 'WH1', destinationOrganizationId: 'org',
  returnNumber: 'RET-042', status: 'submitted', requestedBySide: 'outlet', notes: null,
  createdAt: '2026-07-01T10:00:00Z', ...over,
});
const reqLine = (over: Partial<OutletReturnRequestLine> = {}): OutletReturnRequestLine => ({
  id: 'L1', returnRequestId: 'R1', originalDispatchLineId: 'DL-9', sourceOutletStockId: 'OS1',
  scientificName: 'Amoxicillin', concentration: '500mg', dosageForm: 'cap', unit: 'box',
  nationalCode: 'NC1', batchNumber: 'B-1', internalBatchReference: null, expiryDate: '2027-01-01',
  reasonCode: 'damaged', reasonText: null, requestedQuantity: 5, approvedQuantity: null,
  fulfilledQuantity: 0, status: 'pending', ...over,
});

const ship = (over: Partial<OutletReturnShipment> = {}): OutletReturnShipment => ({
  id: '22222222-2222-4222-8222-222222222222', returnRequestId: '11111111-1111-4111-8111-111111111111',
  distributionPointId: 'OUT1', destinationWarehouseId: 'WH1', shipmentNumber: 'SHP-7', status: 'in_transit', ...over,
});
const shipLine = (over: Partial<OutletReturnShipmentLine> = {}): OutletReturnShipmentLine => ({
  id: 'SL1', shipmentId: 'S1', returnRequestLineId: 'L1', originalDispatchLineId: 'DL-9',
  scientificName: 'Amoxicillin', batchNumber: 'B-1', expiryDate: '2027-01-01', sentQuantity: 5,
  receivedQuantity: null, status: 'in_transit', differenceReason: null, disposition: null, custodyState: 'in_transit', ...over,
});

const parties = { source: { organizationName: 'Org', warehouseName: 'Outlet 1' }, destination: { organizationName: 'Org', warehouseName: 'Central WH' } };

describe('return request receipt', () => {
  it('uses the immutable uuid as the trace key, the return number only as an external reference', () => {
    const doc = buildOutletReturnRequestReceipt({ request: req(), lines: [reqLine()], ...parties });
    expect(doc.traceKey).toBe('11111111-1111-4111-8111-111111111111');
    expect(doc.externalReference).toBe('RET-042');
    expect(doc.kind).toBe('return_request');
  });

  it('carries provenance and the reason verbatim from the server line', () => {
    const doc = buildOutletReturnRequestReceipt({ request: req(), lines: [reqLine({ reasonCode: 'expired', reasonText: 'past date' })], ...parties });
    expect(doc.lines[0].originalSupplyReference).toBe('DL-9');
    expect(doc.lines[0].returnReason).toBe('expired — past date');
    expect(doc.lines[0].requestedQuantity).toBe(5);
  });

  it('is watermarked draft while submitted and cancelled when cancelled', () => {
    expect(buildOutletReturnRequestReceipt({ request: req({ status: 'submitted' }), lines: [], ...parties }).watermark).toBe('draft');
    expect(buildOutletReturnRequestReceipt({ request: req({ status: 'cancelled' }), lines: [], ...parties }).watermark).toBe('cancelled');
  });
});

describe('return shipment receipt', () => {
  it('is an official movement, partial while in transit, carrying disposition and custody', () => {
    const doc = buildOutletReturnShipmentReceipt({
      shipment: ship({ status: 'in_transit' }),
      lines: [shipLine({ receivedQuantity: 5, disposition: 'quarantined', custodyState: 'destination_quarantine' })],
      ...parties,
    });
    expect(doc.kind).toBe('return_shipment');
    expect(doc.watermark).toBe('partial');
    expect(doc.requestTraceKey).toBe('11111111-1111-4111-8111-111111111111');
    expect(doc.lines[0].movedQuantity).toBe(5);
    expect(doc.lines[0].disposition).toBe('quarantined');
    expect(doc.lines[0].custodyState).toBe('destination_quarantine');
  });

  it('drops the partial watermark once fully received', () => {
    expect(buildOutletReturnShipmentReceipt({ shipment: ship({ status: 'received' }), lines: [], ...parties }).watermark).toBe('none');
  });
});

describe('the document renders XSS-safe through the shared print pipeline', () => {
  it('escapes a hostile server value instead of emitting live markup', () => {
    const doc = buildOutletReturnRequestReceipt({
      request: req({ returnNumber: '<img src=x onerror=alert(1)>' }),
      lines: [reqLine({ scientificName: '<script>alert(1)</script>' })],
      ...parties,
    });
    const html = buildReceiptHtml({
      document: doc,
      selectedFields: RECEIPT_FIELDS.map(f => f.key),
      lang: 'en',
      qrDataUrl: null,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;script&gt;');
  });
});
