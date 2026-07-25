/**
 * OUTLET-CORRIDOR-071 — build a ReceiptDocument from SERVER-RELOADED canonical
 * rows for the outlet return corridor. Pure and dependency-free, so it is fully
 * testable without a database and shares the exact rendering, print-field
 * selector, QR and XLSX pipeline the direct corridor already uses
 * (movement/receipt-model.ts, receipt-html.ts, receipt-xlsx.ts).
 *
 * THE RULE (identical to movement/receipt-source.ts): a receipt states what the
 * server holds, never what a local draft asked for. Every value is copied
 * verbatim from a server row; missing values stay null and print as "—". The
 * immutable database uuid is THE trace key; the operator-typed return number is
 * an external reference only.
 */
import type { ReceiptDocument, ReceiptLine } from '@/features/movement/receipt-model';
import { requestWatermark, movementWatermark, type ReceiptPartyNames } from '@/features/movement/receipt-source';
import type {
  OutletReturnRequest, OutletReturnRequestLine,
  OutletReturnShipment, OutletReturnShipmentLine,
} from './outlet-return.service';

/**
 * Outlet return REQUEST document (kind 'return_request'). Editable, not a stock
 * movement — so it can never carry an official receipt; it is watermarked draft
 * until finalized or cancelled.
 */
export function buildOutletReturnRequestReceipt(input: {
  request: OutletReturnRequest;
  lines: readonly OutletReturnRequestLine[];
  source: ReceiptPartyNames;
  destination: ReceiptPartyNames;
  /** PAPER-REFERENCE-CONTRACT-110: optional — omitted callers render nothing extra. */
  paperReference?: { paperReferenceNumber: string | null; paperReferenceDate: string | null; issuingAuthority: string | null } | null;
}): ReceiptDocument {
  const lines: ReceiptLine[] = input.lines.map((l, i) => ({
    lineNumber: i + 1,
    scientificName: l.scientificName,
    tradeName: null,
    concentration: l.concentration,
    dosageForm: l.dosageForm,
    unit: l.unit,
    nationalCode: l.nationalCode,
    batchNumber: l.batchNumber,
    internalBatchReference: l.internalBatchReference,
    expiryDate: l.expiryDate,
    requestedQuantity: l.requestedQuantity,
    approvedQuantity: l.approvedQuantity,
    movedQuantity: null,
    receivedQuantity: null,
    onHandSnapshot: null,
    returnReason: l.reasonText ? `${l.reasonCode} — ${l.reasonText}` : l.reasonCode,
    disposition: null,
    custodyState: null,
    unitPrice: null,
    currency: null,
    priceBasis: null,
    supplyType: null,
    purchaseOrigin: null,
    notes: null,
    // Provenance: the exact original dispatch line this return anchors to.
    originalSupplyReference: l.originalDispatchLineId,
  }));

  return {
    kind: 'return_request',
    traceKey: input.request.id,
    externalReference: input.request.returnNumber || null,
    requestTraceKey: null,
    originalSupplyTraceKey: null,
    status: input.request.status,
    eventAt: input.request.createdAt ?? null,
    source: input.source,
    destination: input.destination,
    actorName: null,
    actorRole: null,
    counterpartyName: null,
    watermark: requestWatermark(input.request.status),
    reprintedAt: null,
    lines,
    paperReferenceNumber: input.paperReference?.paperReferenceNumber ?? null,
    paperReferenceDate: input.paperReference?.paperReferenceDate ?? null,
    issuingAuthority: input.paperReference?.issuingAuthority ?? null,
  };
}

/**
 * Outlet return SHIPMENT receipt (kind 'return_shipment'). An official stock
 * movement once it exists; watermarked 'partial' while in transit so it never
 * reads as fully closed. Carries the received quantity, disposition and custody
 * state exactly as the server holds them.
 */
export function buildOutletReturnShipmentReceipt(input: {
  shipment: OutletReturnShipment;
  lines: readonly OutletReturnShipmentLine[];
  source: ReceiptPartyNames;
  destination: ReceiptPartyNames;
}): ReceiptDocument {
  const lines: ReceiptLine[] = input.lines.map((l, i) => ({
    lineNumber: i + 1,
    scientificName: l.scientificName,
    tradeName: null,
    concentration: null,
    dosageForm: null,
    unit: null,
    nationalCode: null,
    batchNumber: l.batchNumber,
    internalBatchReference: null,
    expiryDate: l.expiryDate,
    requestedQuantity: null,
    approvedQuantity: null,
    movedQuantity: l.sentQuantity,
    receivedQuantity: l.receivedQuantity,
    onHandSnapshot: null,
    returnReason: null,
    disposition: l.disposition,
    custodyState: l.custodyState,
    unitPrice: null,
    currency: null,
    priceBasis: null,
    supplyType: null,
    purchaseOrigin: null,
    notes: null,
    originalSupplyReference: l.originalDispatchLineId,
  }));

  return {
    kind: 'return_shipment',
    traceKey: input.shipment.id,
    externalReference: input.shipment.shipmentNumber || null,
    requestTraceKey: input.shipment.returnRequestId,
    originalSupplyTraceKey: null,
    status: input.shipment.status,
    eventAt: null,
    source: input.source,
    destination: input.destination,
    actorName: null,
    actorRole: null,
    counterpartyName: null,
    watermark: movementWatermark(input.shipment.status),
    reprintedAt: null,
    lines,
  };
}
