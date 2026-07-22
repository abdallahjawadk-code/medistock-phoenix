import type { ReceiptDocument, ReceiptLine } from '@/features/movement/receipt-model';
import type {
  OrderLineRow, OrderRow, ReceiptLineRow, ReceiptRow, SupplierRow,
} from './procurement.service';

/**
 * INSTITUTION-LOCAL-PROCUREMENT-087 — map canonical server rows to the shared
 * ReceiptDocument (print · genuine XLSX · QR via MovementDocumentActions).
 *
 * Documents come from RELOADED server state, never from a client draft: the
 * caller passes rows read back through RLS after the receipt RPC committed.
 * The QR trace key is the immutable procurement_receipts uuid, kind
 * 'procurement_receipt' — a locator only, resolved back through RLS.
 */
export function buildProcurementReceiptDocument(input: {
  order: OrderRow;
  supplier: SupplierRow | null;
  receipt: ReceiptRow;
  receiptLines: ReceiptLineRow[];
  orderLines: OrderLineRow[];
  warehouseName: string | null;
  organizationName: string | null;
}): ReceiptDocument {
  const { order, supplier, receipt, receiptLines, orderLines } = input;
  const byOrderLine = new Map(orderLines.map(l => [l.id, l]));

  const lines: ReceiptLine[] = receiptLines.map((rl, i) => {
    const ol = byOrderLine.get(rl.orderLineId) ?? null;
    return {
      lineNumber: i + 1,
      scientificName: ol?.scientificName ?? '—',
      tradeName: ol?.tradeName ?? null,
      concentration: ol?.concentration ?? null,
      dosageForm: ol?.dosageForm ?? null,
      unit: ol?.unit ?? null,
      nationalCode: rl.nationalCode,
      batchNumber: rl.batchNumber,
      internalBatchReference: null,
      expiryDate: rl.expiryDate,
      requestedQuantity: ol?.orderedQuantity ?? null,
      approvedQuantity: null,
      movedQuantity: rl.quantity,
      receivedQuantity: rl.quantity,
      onHandSnapshot: null,
      returnReason: null,
      disposition: null,
      custodyState: null,
      unitPrice: rl.unitPrice,
      currency: ol?.currency ?? order.currency,
      priceBasis: 'purchase',
      supplyType: 'local_procurement',
      notes: ol?.notes ?? null,
      originalSupplyReference: null,
    };
  });

  return {
    kind: 'procurement_receipt',
    traceKey: receipt.id,
    externalReference: receipt.invoiceNumber ?? order.orderNumber,
    requestTraceKey: order.id,
    originalSupplyTraceKey: null,
    status: order.status,
    eventAt: receipt.createdAt,
    // Source: the local supplier the institution purchased from.
    source: { organizationName: supplier?.name ?? null, warehouseName: null },
    // Destination: the purchasing institution warehouse.
    destination: {
      organizationName: input.organizationName,
      warehouseName: input.warehouseName,
    },
    actorName: receipt.receivedByName,
    actorRole: receipt.receivedByRole,
    counterpartyName: supplier?.contactPerson ?? null,
    watermark: 'none',
    reprintedAt: null,
    lines,
  };
}
