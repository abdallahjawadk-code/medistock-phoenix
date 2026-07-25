/**
 * MOVEMENT-COMPOSER-A — build a ReceiptDocument from SERVER-RELOADED canonical
 * rows. Pure and dependency-free so it is fully testable without a database.
 *
 * THE RULE: a receipt states what the server holds, never what a local draft
 * asked for. Every mapper here takes rows straight from network.service reads
 * (RLS-scoped) and copies their values verbatim — nothing is inferred, defaulted
 * or reconstructed. Missing values stay null and print as "—".
 *
 * Watermark honesty: a request/return-request is not a stock movement, so it can
 * never carry an OFFICIAL (unwatermarked) receipt — it is marked 'draft' unless
 * cancelled. A dispatch/shipment is official once it exists, but a partially
 * received one is marked 'partial' so it never reads as fully closed.
 */
import type {
  Transfer, IncomingTransferLine, TransferRequest, TransferRequestLine,
} from '@/features/network/network.service';
import type { ReceiptDocument, ReceiptLine, ReceiptWatermark } from './receipt-model';
import type { ReceiptExceptionRow } from './receipt-xlsx';

export interface ReceiptPartyNames {
  organizationName: string | null;
  warehouseName: string | null;
}

const CANCELLED = new Set(['cancelled', 'rejected']);

/** A non-movement request document: 'draft' unless finalized/cancelled. */
export function requestWatermark(status: string): ReceiptWatermark {
  const s = (status ?? '').toLowerCase();
  if (CANCELLED.has(s)) return 'cancelled';
  // A request is never a movement receipt; only a fully-approved/fulfilled one
  // stops carrying the draft mark, and even then its TITLE says "request".
  if (s === 'draft' || s === 'submitted') return 'draft';
  return 'none';
}

/** A movement receipt: official unless cancelled or only partially completed. */
export function movementWatermark(status: string): ReceiptWatermark {
  const s = (status ?? '').toLowerCase();
  if (CANCELLED.has(s)) return 'cancelled';
  if (s.startsWith('partial') || s === 'in_transit' || s === 'sent') return 'partial';
  return 'none';
}

/** Supply REQUEST document (editable, not a stock movement). */
export function buildSupplyRequestReceipt(input: {
  request: TransferRequest;
  lines: readonly TransferRequestLine[];
  source: ReceiptPartyNames;
  destination: ReceiptPartyNames;
}): ReceiptDocument {
  const lines: ReceiptLine[] = input.lines.map((l, i) => ({
    lineNumber: i + 1,
    scientificName: l.scientificName,
    tradeName: null,
    concentration: l.concentration,
    dosageForm: l.dosageForm,
    unit: l.unit,
    nationalCode: null,
    batchNumber: null,
    internalBatchReference: null,
    expiryDate: null,
    requestedQuantity: l.requestedQuantity,
    approvedQuantity: l.approvedQuantity,
    movedQuantity: null,
    receivedQuantity: null,
    onHandSnapshot: null,
    returnReason: null,
    disposition: null,
    custodyState: null,
    unitPrice: null,
    currency: null,
    priceBasis: null,
    supplyType: null,
    purchaseOrigin: null,
    notes: l.notes,
    originalSupplyReference: null,
  }));

  return {
    kind: 'supply_request',
    traceKey: input.request.id,
    externalReference: input.request.requestNumber || null,
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
  };
}

/**
 * Supply DISPATCH receipt (official stock movement). Built from the FULL
 * immutable transfer lines — every product, batch, price and provenance column
 * as dispatched — so the receiving officer checks goods against the record.
 */
export function buildSupplyDispatchReceipt(input: {
  transfer: Transfer;
  lines: readonly IncomingTransferLine[];
  source: ReceiptPartyNames;
  destination: ReceiptPartyNames;
}): ReceiptDocument {
  const lines: ReceiptLine[] = input.lines.map((l, i) => ({
    lineNumber: i + 1,
    scientificName: l.scientificName,
    tradeName: l.tradeName,
    concentration: l.concentration,
    dosageForm: l.dosageForm,
    unit: l.unit,
    nationalCode: l.nationalCode,
    batchNumber: l.batchNumber,
    internalBatchReference: l.internalBatchReference,
    expiryDate: l.expiryDate,
    requestedQuantity: null,
    approvedQuantity: null,
    movedQuantity: l.sentQuantity,
    receivedQuantity: l.receivedQuantity,
    onHandSnapshot: null,
    returnReason: null,
    disposition: null,
    custodyState: null,
    unitPrice: l.unitPrice,
    currency: l.currency,
    priceBasis: l.priceBasis,
    supplyType: l.supplyTypeText,
    purchaseOrigin: (l as { purchaseOrigin?: string | null }).purchaseOrigin ?? null,
    notes: null,
    originalSupplyReference: l.transferRequestLineId,
  }));

  return {
    kind: 'supply_dispatch',
    traceKey: input.transfer.id,
    externalReference: input.transfer.transferNumber || null,
    requestTraceKey: input.transfer.transferRequestId,
    originalSupplyTraceKey: null,
    status: input.transfer.status,
    eventAt: null,
    source: input.source,
    destination: input.destination,
    actorName: null,
    actorRole: null,
    counterpartyName: null,
    watermark: movementWatermark(input.transfer.status),
    reprintedAt: null,
    lines,
  };
}

/**
 * Exceptions for the XLSX sheet: any dispatched line whose received quantity
 * disagrees with what was sent, or that carries a difference reason. Never
 * silently omitted — an absent exceptions sheet reads as "not checked".
 */
export function dispatchExceptionRows(lines: readonly IncomingTransferLine[]): ReceiptExceptionRow[] {
  const rows: ReceiptExceptionRow[] = [];
  lines.forEach((l, i) => {
    if (l.receivedQuantity !== null && l.receivedQuantity !== l.sentQuantity) {
      rows.push({
        lineNumber: i + 1,
        scientificName: l.scientificName,
        kind: 'quantity_discrepancy',
        detail: `sent ${l.sentQuantity} · received ${l.receivedQuantity}${l.differenceReason ? ` · ${l.differenceReason}` : ''}`,
      });
    } else if (l.differenceReason) {
      rows.push({
        lineNumber: i + 1,
        scientificName: l.scientificName,
        kind: 'flagged',
        detail: l.differenceReason,
      });
    }
  });
  return rows;
}
