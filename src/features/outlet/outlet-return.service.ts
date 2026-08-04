import { supabase, supabaseConfigured } from '@/shared/supabase/client';
import type { RpcResult } from './dispatch.service';

/**
 * OUTLET-CORRIDOR-071 — thin client over the migration 071 outlet → institution
 * warehouse return contracts and their read tables.
 *
 * Same discipline as dispatch.service.ts / network.service.ts: no client stock
 * computation, no privileged key, no direct table write. Every mutation is a
 * SECURITY DEFINER RPC that re-checks scope server-side; every read is RLS-scoped.
 *
 * PROVENANCE IS MANDATORY (071 schema): a return request line carries
 * original_dispatch_line_id + original_inbound_movement_id + source_outlet_stock_id,
 * all NOT NULL and pinned to each other by composite FKs, so a free-text or
 * unproven return is impossible in the schema as well as in the UI. The outlet may
 * only return to the SPECIFIC parent warehouse its distribution_points.warehouse_id
 * names — never to another outlet and never to central directly.
 */

function rpcErrorCode(message: string | undefined): string {
  if (!message) return 'unknown_error';
  const head = message.split(':', 1)[0]?.trim() ?? message;
  return /^[A-Z0-9_]+$/.test(head) ? head : 'unknown_error';
}

async function callRpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
  if (!supabaseConfigured) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, error: rpcErrorCode(error.message) };
  const payload = (data ?? {}) as { ok?: boolean } & T;
  return { ok: payload.ok !== false, data: payload as T };
}

// ─── Return request ──────────────────────────────────────────────────────────

export interface OutletReturnRequest {
  id: string;
  distributionPointId: string;
  sourceOrganizationId: string;
  destinationWarehouseId: string;
  destinationOrganizationId: string;
  returnNumber: string;
  status: string;
  requestedBySide: string;
  notes: string | null;
  createdAt: string;
}

interface OutletReturnRequestRow {
  id: string; distribution_point_id: string; source_organization_id: string;
  destination_warehouse_id: string; destination_organization_id: string;
  return_number: string; status: string; requested_by_side: string; notes: string | null; created_at: string;
}

const RETURN_REQUEST_COLUMNS =
  'id, distribution_point_id, source_organization_id, destination_warehouse_id, ' +
  'destination_organization_id, return_number, status, requested_by_side, notes, created_at';

function mapReturnRequest(r: OutletReturnRequestRow): OutletReturnRequest {
  return {
    id: r.id, distributionPointId: r.distribution_point_id, sourceOrganizationId: r.source_organization_id,
    destinationWarehouseId: r.destination_warehouse_id, destinationOrganizationId: r.destination_organization_id,
    returnNumber: r.return_number, status: r.status, requestedBySide: r.requested_by_side,
    notes: r.notes, createdAt: r.created_at,
  };
}

/** `organizationId` is an explicit narrowing filter (on top of RLS) for callers — like the
 *  reports screen — that must never show a super_admin's other RLS-visible organizations.
 *  Matches EITHER side: 071's orr_same_org_chk keeps source/destination identical today,
 *  but the OR is written against the real column pair, not that invariant. */
export async function getOutletReturnRequests(distributionPointId?: string, organizationId?: string): Promise<OutletReturnRequest[]> {
  if (!supabaseConfigured) return [];
  let q = supabase.from('outlet_return_requests').select(RETURN_REQUEST_COLUMNS).order('created_at', { ascending: false });
  if (distributionPointId) q = q.eq('distribution_point_id', distributionPointId);
  if (organizationId) q = q.or(`source_organization_id.eq.${organizationId},destination_organization_id.eq.${organizationId}`);
  const { data, error } = await q;
  if (error) throw error;
  // Concatenated const select → supabase-js infers GenericStringError[]; the shape
  // is asserted by OutletReturnRequestRow and RETURN_REQUEST_COLUMNS. Same pattern
  // as network.service.getIncomingTransferLines.
  return (data as unknown as OutletReturnRequestRow[] | null ?? []).map(mapReturnRequest);
}

export interface OutletReturnRequestLine {
  id: string;
  returnRequestId: string;
  originalDispatchLineId: string;
  sourceOutletStockId: string;
  scientificName: string;
  concentration: string | null;
  dosageForm: string | null;
  unit: string | null;
  nationalCode: string | null;
  batchNumber: string | null;
  internalBatchReference: string | null;
  expiryDate: string | null;
  reasonCode: string;
  reasonText: string | null;
  requestedQuantity: number;
  approvedQuantity: number | null;
  fulfilledQuantity: number;
  status: string;
}

interface OutletReturnRequestLineRow {
  id: string; return_request_id: string; original_dispatch_line_id: string; source_outlet_stock_id: string;
  scientific_name: string; concentration: string | null; dosage_form: string | null; unit: string | null;
  national_code: string | null; batch_number: string | null; internal_batch_reference: string | null;
  expiry_date: string | null; reason_code: string; reason_text: string | null;
  requested_quantity: number; approved_quantity: number | null; fulfilled_quantity: number; status: string;
}

const RETURN_LINE_COLUMNS =
  'id, return_request_id, original_dispatch_line_id, source_outlet_stock_id, scientific_name, ' +
  'concentration, dosage_form, unit, national_code, batch_number, internal_batch_reference, expiry_date, ' +
  'reason_code, reason_text, requested_quantity, approved_quantity, fulfilled_quantity, status';

export async function getOutletReturnRequestLines(returnRequestId: string): Promise<OutletReturnRequestLine[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('outlet_return_request_lines').select(RETURN_LINE_COLUMNS)
    .eq('return_request_id', returnRequestId).order('scientific_name', { ascending: true });
  if (error) throw error;
  // Concatenated const select → supabase-js infers GenericStringError[]; the shape
  // is asserted by OutletReturnRequestLineRow and RETURN_LINE_COLUMNS. Same pattern
  // as network.service.getIncomingTransferLines.
  return (data as unknown as OutletReturnRequestLineRow[] | null ?? []).map(r => ({
    id: r.id, returnRequestId: r.return_request_id, originalDispatchLineId: r.original_dispatch_line_id,
    sourceOutletStockId: r.source_outlet_stock_id, scientificName: r.scientific_name,
    concentration: r.concentration, dosageForm: r.dosage_form, unit: r.unit, nationalCode: r.national_code,
    batchNumber: r.batch_number, internalBatchReference: r.internal_batch_reference, expiryDate: r.expiry_date,
    reasonCode: r.reason_code, reasonText: r.reason_text, requestedQuantity: r.requested_quantity,
    approvedQuantity: r.approved_quantity, fulfilledQuantity: r.fulfilled_quantity, status: r.status,
  }));
}

// ─── Return shipment (custody-carrying) ──────────────────────────────────────

export interface OutletReturnShipment {
  id: string;
  returnRequestId: string | null;
  distributionPointId: string;
  destinationWarehouseId: string;
  shipmentNumber: string;
  status: string;
}

interface OutletReturnShipmentRow {
  id: string; return_request_id: string | null; distribution_point_id: string;
  destination_warehouse_id: string; shipment_number: string; status: string;
}

/** `organizationId` is an explicit narrowing filter (on top of RLS) for callers — like the
 *  reports screen — that must never show a super_admin's other RLS-visible organizations.
 *  Matches EITHER side: 071's ors_same_org_chk keeps source/destination identical today,
 *  but the OR is written against the real column pair, not that invariant. */
export async function getOutletReturnShipments(destinationWarehouseId?: string, organizationId?: string): Promise<OutletReturnShipment[]> {
  if (!supabaseConfigured) return [];
  let q = supabase
    .from('outlet_return_shipments')
    .select('id, return_request_id, distribution_point_id, destination_warehouse_id, shipment_number, status')
    .order('created_at', { ascending: false });
  if (destinationWarehouseId) q = q.eq('destination_warehouse_id', destinationWarehouseId);
  if (organizationId) q = q.or(`source_organization_id.eq.${organizationId},destination_organization_id.eq.${organizationId}`);
  const { data, error } = await q;
  if (error) throw error;
  return (data as OutletReturnShipmentRow[] | null ?? []).map(r => ({
    id: r.id, returnRequestId: r.return_request_id, distributionPointId: r.distribution_point_id,
    destinationWarehouseId: r.destination_warehouse_id, shipmentNumber: r.shipment_number, status: r.status,
  }));
}

export interface OutletReturnShipmentLine {
  id: string;
  shipmentId: string;
  returnRequestLineId: string | null;
  originalDispatchLineId: string;
  scientificName: string;
  batchNumber: string | null;
  expiryDate: string | null;
  sentQuantity: number;
  receivedQuantity: number | null;
  status: string;
  differenceReason: string | null;
  disposition: string | null;
  custodyState: string;
}

interface OutletReturnShipmentLineRow {
  id: string; shipment_id: string; return_request_line_id: string | null; original_dispatch_line_id: string;
  scientific_name: string; batch_number: string | null; expiry_date: string | null;
  sent_quantity: number; received_quantity: number | null; status: string; difference_reason: string | null;
  disposition: string | null; custody_state: string;
}

export async function getOutletReturnShipmentLines(shipmentId: string): Promise<OutletReturnShipmentLine[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('outlet_return_shipment_lines')
    .select('id, shipment_id, return_request_line_id, original_dispatch_line_id, scientific_name, batch_number, expiry_date, sent_quantity, received_quantity, status, difference_reason, disposition, custody_state')
    .eq('shipment_id', shipmentId).order('scientific_name', { ascending: true });
  if (error) throw error;
  return (data as OutletReturnShipmentLineRow[] | null ?? []).map(r => ({
    id: r.id, shipmentId: r.shipment_id, returnRequestLineId: r.return_request_line_id,
    originalDispatchLineId: r.original_dispatch_line_id, scientificName: r.scientific_name,
    batchNumber: r.batch_number, expiryDate: r.expiry_date, sentQuantity: r.sent_quantity,
    receivedQuantity: r.received_quantity, status: r.status, differenceReason: r.difference_reason,
    disposition: r.disposition, custodyState: r.custody_state,
  }));
}

/** Lines for MANY shipments in ONE query — the institution receive queue (no N+1). */
export async function getReturnShipmentLinesForShipments(shipmentIds: string[]): Promise<OutletReturnShipmentLine[]> {
  if (!supabaseConfigured || shipmentIds.length === 0) return [];
  const { data, error } = await supabase
    .from('outlet_return_shipment_lines')
    .select('id, shipment_id, return_request_line_id, original_dispatch_line_id, scientific_name, batch_number, expiry_date, sent_quantity, received_quantity, status, difference_reason, disposition, custody_state')
    .in('shipment_id', shipmentIds).order('scientific_name', { ascending: true });
  if (error) throw error;
  return (data as OutletReturnShipmentLineRow[] | null ?? []).map(r => ({
    id: r.id, shipmentId: r.shipment_id, returnRequestLineId: r.return_request_line_id,
    originalDispatchLineId: r.original_dispatch_line_id, scientificName: r.scientific_name,
    batchNumber: r.batch_number, expiryDate: r.expiry_date, sentQuantity: r.sent_quantity,
    receivedQuantity: r.received_quantity, status: r.status, differenceReason: r.difference_reason,
    disposition: r.disposition, custodyState: r.custody_state,
  }));
}

/**
 * OUTLET-RETURN-EXCEPTION-RESOLUTION-157 — unresolved exception_pending lines
 * for one destination warehouse.
 *
 * 157's own RPC NEVER updates outlet_return_shipment_lines.custody_state —
 * it stays 'exception_pending' forever, even after resolution (the original
 * zero-quantity receipt is never rewritten; the resolution is a separate,
 * additive row). So "still needs resolving" cannot be read off custody_state
 * alone — it requires excluding lines that already have a row in
 * phoenix_outlet_return_exception_resolutions, keyed by
 * return_shipment_line_id (071/157: at most one resolution per line).
 */
export async function getExceptionPendingLines(destinationWarehouseId: string): Promise<OutletReturnShipmentLine[]> {
  if (!supabaseConfigured || !destinationWarehouseId) return [];

  const { data: shipments, error: shipmentsErr } = await supabase
    .from('outlet_return_shipments')
    .select('id')
    .eq('destination_warehouse_id', destinationWarehouseId);
  if (shipmentsErr) throw shipmentsErr;
  const shipmentIds = (shipments ?? []).map(s => s.id as string);
  if (shipmentIds.length === 0) return [];

  const { data: lines, error: linesErr } = await supabase
    .from('outlet_return_shipment_lines')
    .select('id, shipment_id, return_request_line_id, original_dispatch_line_id, scientific_name, batch_number, expiry_date, sent_quantity, received_quantity, status, difference_reason, disposition, custody_state')
    .in('shipment_id', shipmentIds)
    .eq('custody_state', 'exception_pending')
    .order('scientific_name', { ascending: true });
  if (linesErr) throw linesErr;
  const rows = lines as OutletReturnShipmentLineRow[] | null ?? [];
  if (rows.length === 0) return [];

  const { data: resolutions, error: resolutionsErr } = await supabase
    .from('phoenix_outlet_return_exception_resolutions')
    .select('return_shipment_line_id')
    .in('return_shipment_line_id', rows.map(r => r.id));
  if (resolutionsErr) throw resolutionsErr;
  const resolved = new Set((resolutions ?? []).map(r => r.return_shipment_line_id as string));

  return rows.filter(r => !resolved.has(r.id)).map(r => ({
    id: r.id, shipmentId: r.shipment_id, returnRequestLineId: r.return_request_line_id,
    originalDispatchLineId: r.original_dispatch_line_id, scientificName: r.scientific_name,
    batchNumber: r.batch_number, expiryDate: r.expiry_date, sentQuantity: r.sent_quantity,
    receivedQuantity: r.received_quantity, status: r.status, differenceReason: r.difference_reason,
    disposition: r.disposition, custodyState: r.custody_state,
  }));
}

// ─── Mutations (071 RPCs) ────────────────────────────────────────────────────

export function requestOutletReturn(input: {
  distributionPointId: string; returnNumber: string; notes?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_request_outlet_return', {
    p_distribution_point_id: input.distributionPointId,
    p_return_number: input.returnNumber,
    p_notes: input.notes ?? null,
  });
}

/** Institution-initiated recall of stock held at an outlet. */
export function recallOutletStock(input: {
  distributionPointId: string; returnNumber: string; notes?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_recall_outlet_stock', {
    p_distribution_point_id: input.distributionPointId,
    p_return_number: input.returnNumber,
    p_notes: input.notes ?? null,
  });
}

/** Adds one provenance-anchored return line (original dispatch line is mandatory). */
export function addOutletReturnLine(input: {
  returnRequestId: string; originalDispatchLineId: string; requestedQuantity: number;
  reasonCode: string; reasonText?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_add_outlet_return_request_line', {
    p_return_request_id: input.returnRequestId,
    p_original_dispatch_line_id: input.originalDispatchLineId,
    p_requested_quantity: input.requestedQuantity,
    p_reason_code: input.reasonCode,
    p_reason_text: input.reasonText ?? null,
  });
}

export function deleteOutletReturnLine(returnRequestLineId: string): Promise<RpcResult> {
  return callRpc('phoenix_delete_outlet_return_request_line', {
    p_return_request_line_id: returnRequestLineId,
  });
}

export function submitOutletReturnRequest(returnRequestId: string): Promise<RpcResult> {
  return callRpc('phoenix_submit_outlet_return_request', { p_return_request_id: returnRequestId });
}

export function cancelOutletReturnRequest(returnRequestId: string, reason: string): Promise<RpcResult> {
  return callRpc('phoenix_cancel_outlet_return_request', {
    p_return_request_id: returnRequestId, p_cancellation_reason: reason,
  });
}

export function reviewOutletReturnRequest(
  returnRequestId: string,
  decisions: Array<{ line_id: string; approved_quantity: number }>,
): Promise<RpcResult> {
  return callRpc('phoenix_review_outlet_return_request', {
    p_return_request_id: returnRequestId, p_decisions: decisions,
  });
}

/** Ships one approved return line. `requestId` is a fresh idempotency token;
 *  `shipmentId` groups lines of one physical consignment. */
export function sendOutletReturnShipmentLine(input: {
  requestId: string; returnRequestLineId: string; shipmentId: string; quantity: number;
  shipmentNumber?: string | null; documentNumber?: string | null; notes?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_send_outlet_return_shipment_line', {
    p_request_id: input.requestId,
    p_return_request_line_id: input.returnRequestLineId,
    p_shipment_id: input.shipmentId,
    p_quantity: input.quantity,
    p_shipment_number: input.shipmentNumber ?? null,
    p_document_number: input.documentNumber ?? null,
    p_notes: input.notes ?? null,
  });
}

/** Institution warehouse receives one return line into quarantine/hold first. */
export function receiveOutletReturnShipmentLine(input: {
  requestId: string; shipmentLineId: string; receivedQuantity: number;
  differenceReason?: string | null; notes?: string | null; dispositionDecision?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_receive_outlet_return_shipment_line', {
    p_request_id: input.requestId,
    p_shipment_line_id: input.shipmentLineId,
    p_received_quantity: input.receivedQuantity,
    p_difference_reason: input.differenceReason ?? null,
    p_notes: input.notes ?? null,
    p_disposition_decision: input.dispositionDecision ?? null,
  });
}

/**
 * OUTLET-RETURN-EXCEPTION-RESOLUTION-157 — resolves a stuck exception_pending
 * line via one of two owner-mandated paths: 'corrected_receipt' (a real
 * quantity did arrive — requires correctedQuantity + dispositionDecision) or
 * 'confirmed_no_stock' (genuinely nothing arrived — neither field is sent).
 * `requestId` is a MANDATORY, caller-derived idempotency token (this RPC has
 * no optional/backward-compatible request_id design like 106/156 — see
 * migration 157's own header). Never mutates the original exception line;
 * the RPC records this in a separate, additive resolution ledger.
 */
export function resolveOutletReturnException(input: {
  requestId: string; returnShipmentLineId: string; resolutionKind: 'corrected_receipt' | 'confirmed_no_stock';
  reason: string; correctedQuantity?: number | null; dispositionDecision?: 'restockable' | 'quarantined' | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_resolve_outlet_return_exception', {
    p_request_id: input.requestId,
    p_return_shipment_line_id: input.returnShipmentLineId,
    p_resolution_kind: input.resolutionKind,
    p_reason: input.reason,
    p_corrected_quantity: input.correctedQuantity ?? null,
    p_disposition_decision: input.dispositionDecision ?? null,
  });
}
