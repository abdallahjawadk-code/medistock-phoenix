import { supabase, supabaseConfigured } from '@/shared/supabase/client';

/**
 * INSTITUTION-LOCAL-PROCUREMENT-087 — thin client over the migration 087
 * contracts.
 *
 * This file NEVER writes stock or any procurement table directly: every
 * mutation goes through a SECURITY DEFINER RPC that re-checks institution and
 * warehouse scope server-side (062), and stock enters the warehouse ledger only
 * inside phoenix_procurement_receive_order. Reads go through RLS-scoped
 * SELECTs on the procurement tables.
 *
 * Receipt and return writes carry a caller-generated `requestId` idempotency
 * key plus an `expectedGeneration` optimistic-concurrency token (078/086
 * discipline): a lost-response retry replays the same requestId safely, and a
 * cross-device race surfaces as `*_generation_conflict` instead of silently
 * double-posting.
 */

export interface ProcurementResult<T = Record<string, unknown>> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Extract the RPC's raised lowercase_snake code token (065-style errors). */
function errorCode(message: string | undefined): string {
  if (!message) return 'unknown_error';
  const match = /[a-z][a-z0-9_]{3,}/.exec(message);
  return match ? match[0] : 'unknown_error';
}

async function callRpc<T = Record<string, unknown>>(
  fn: string,
  args: Record<string, unknown>,
): Promise<ProcurementResult<T>> {
  if (!supabaseConfigured) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, error: errorCode(error.message) };
  const payload = (data ?? {}) as { ok?: boolean } & T;
  return { ok: payload.ok !== false, data: payload as T };
}

/** One idempotency key per submission attempt; a retry must reuse it. */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/** Errors that mean "your view is stale — reload before retrying". */
export function isStaleGenerationError(code: string | undefined): boolean {
  return code === 'procurement_order_generation_conflict'
    || code === 'warehouse_stock_generation_conflict';
}

// ── row types (camelCase views over the RLS-readable tables) ────────────────

export type OrderStatus =
  | 'draft' | 'submitted' | 'approved' | 'rejected'
  | 'partially_received' | 'received' | 'cancelled';

export interface SupplierRow {
  id: string;
  organizationId: string;
  name: string;
  nameAr: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  taxNumber: string | null;
  notes: string | null;
  status: 'active' | 'inactive';
}

export interface OrderRow {
  id: string;
  organizationId: string;
  warehouseId: string;
  supplierId: string;
  orderNumber: string;
  status: OrderStatus;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  externalReference: string | null;
  currency: string | null;
  notes: string | null;
  ocrAssisted: boolean;
  orderGeneration: number;
  submittedBy: string | null;
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNotes: string | null;
  cancelReason: string | null;
  createdBy: string;
  createdAt: string;
}

export interface OrderLineRow {
  id: string;
  orderId: string;
  centralItemId: string | null;
  scientificName: string;
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  unit: string | null;
  nationalCode: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
  orderedQuantity: number;
  receivedQuantity: number;
  unitPrice: number | null;
  currency: string | null;
  notes: string | null;
}

export interface ReceiptRow {
  id: string;
  orderId: string;
  organizationId: string;
  warehouseId: string;
  supplierId: string;
  receiptNumber: string;
  invoiceNumber: string | null;
  notes: string | null;
  receivedBy: string;
  receivedByName: string | null;
  receivedByRole: string | null;
  createdAt: string;
}

export interface ReceiptLineRow {
  id: string;
  receiptId: string;
  orderLineId: string;
  quantity: number;
  batchNumber: string | null;
  hasNoBatchNumber: boolean;
  nationalCode: string | null;
  expiryDate: string | null;
  unitPrice: number | null;
  warehouseStockId: string | null;
  movementId: string | null;
  createdAt: string;
}

export interface ReturnRow {
  id: string;
  orderId: string;
  receiptLineId: string;
  quantity: number;
  reason: string;
  notes: string | null;
  movementId: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface OrderEventRow {
  id: string;
  orderId: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorName: string | null;
  actorRole: string | null;
  notes: string | null;
  createdAt: string;
}

// ── reads (RLS-scoped; return [] when unreachable so panels can show state) ──

/* eslint-disable @typescript-eslint/no-explicit-any */

function mapSupplier(r: any): SupplierRow {
  return {
    id: r.id, organizationId: r.organization_id, name: r.name, nameAr: r.name_ar,
    contactPerson: r.contact_person, phone: r.phone, email: r.email,
    address: r.address, taxNumber: r.tax_number, notes: r.notes, status: r.status,
  };
}

function mapOrder(r: any): OrderRow {
  return {
    id: r.id, organizationId: r.organization_id, warehouseId: r.warehouse_id,
    supplierId: r.supplier_id, orderNumber: r.order_number, status: r.status,
    invoiceNumber: r.invoice_number, invoiceDate: r.invoice_date,
    externalReference: r.external_reference, currency: r.currency, notes: r.notes,
    ocrAssisted: r.ocr_assisted, orderGeneration: Number(r.order_generation),
    submittedBy: r.submitted_by, submittedAt: r.submitted_at,
    decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNotes: r.decision_notes,
    cancelReason: r.cancel_reason, createdBy: r.created_by, createdAt: r.created_at,
  };
}

function mapOrderLine(r: any): OrderLineRow {
  return {
    id: r.id, orderId: r.order_id, centralItemId: r.central_item_id,
    scientificName: r.scientific_name, tradeName: r.trade_name,
    concentration: r.concentration, dosageForm: r.dosage_form, unit: r.unit,
    nationalCode: r.national_code, batchNumber: r.batch_number,
    expiryDate: r.expiry_date, orderedQuantity: r.ordered_quantity,
    receivedQuantity: r.received_quantity,
    unitPrice: r.unit_price === null ? null : Number(r.unit_price),
    currency: r.currency, notes: r.notes,
  };
}

function mapReceipt(r: any): ReceiptRow {
  return {
    id: r.id, orderId: r.order_id, organizationId: r.organization_id,
    warehouseId: r.warehouse_id, supplierId: r.supplier_id,
    receiptNumber: r.receipt_number, invoiceNumber: r.invoice_number,
    notes: r.notes, receivedBy: r.received_by,
    receivedByName: r.received_by_name, receivedByRole: r.received_by_role,
    createdAt: r.created_at,
  };
}

function mapReceiptLine(r: any): ReceiptLineRow {
  return {
    id: r.id, receiptId: r.receipt_id, orderLineId: r.order_line_id,
    quantity: r.quantity, batchNumber: r.batch_number,
    hasNoBatchNumber: r.has_no_batch_number, nationalCode: r.national_code,
    expiryDate: r.expiry_date,
    unitPrice: r.unit_price === null ? null : Number(r.unit_price),
    warehouseStockId: r.warehouse_stock_id, movementId: r.movement_id,
    createdAt: r.created_at,
  };
}

function mapReturn(r: any): ReturnRow {
  return {
    id: r.id, orderId: r.order_id, receiptLineId: r.receipt_line_id,
    quantity: r.quantity, reason: r.reason, notes: r.notes,
    movementId: r.movement_id, actorName: r.actor_name, createdAt: r.created_at,
  };
}

function mapEvent(r: any): OrderEventRow {
  return {
    id: r.id, orderId: r.order_id, eventType: r.event_type,
    fromStatus: r.from_status, toStatus: r.to_status,
    actorName: r.actor_name, actorRole: r.actor_role,
    notes: r.notes, createdAt: r.created_at,
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

export async function getSuppliers(orgId: string): Promise<SupplierRow[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('procurement_suppliers')
    .select('*')
    .eq('organization_id', orgId)
    .order('name');
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapSupplier);
}

export async function getOrders(
  warehouseId: string,
  statuses?: OrderStatus[],
): Promise<OrderRow[]> {
  if (!supabaseConfigured) return [];
  let query = supabase
    .from('procurement_orders')
    .select('*')
    .eq('warehouse_id', warehouseId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (statuses && statuses.length > 0) query = query.in('status', statuses);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapOrder);
}

export async function getOrderLines(orderId: string): Promise<OrderLineRow[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('procurement_order_lines')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at');
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapOrderLine);
}

export async function getReceipts(orderId: string): Promise<ReceiptRow[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('procurement_receipts')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapReceipt);
}

export async function getReceiptLines(receiptId: string): Promise<ReceiptLineRow[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('procurement_receipt_lines')
    .select('*')
    .eq('receipt_id', receiptId)
    .order('created_at');
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapReceiptLine);
}

export async function getReturnsForOrder(orderId: string): Promise<ReturnRow[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('procurement_returns')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapReturn);
}

export async function getOrderEvents(orderId: string): Promise<OrderEventRow[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('procurement_order_events')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at');
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapEvent);
}

// ── mutations (RPC-only; the server re-authorizes every one) ────────────────

export interface SaveSupplierInput {
  organizationId: string;
  supplierId?: string | null;
  name?: string | null;
  nameAr?: string | null;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  taxNumber?: string | null;
  notes?: string | null;
  status?: 'active' | 'inactive' | null;
}

export function saveSupplier(input: SaveSupplierInput) {
  return callRpc<{ supplier_id: string; created: boolean }>('phoenix_procurement_save_supplier', {
    p_organization_id: input.organizationId,
    p_supplier_id: input.supplierId ?? null,
    p_name: input.name ?? null,
    p_name_ar: input.nameAr ?? null,
    p_contact_person: input.contactPerson ?? null,
    p_phone: input.phone ?? null,
    p_email: input.email ?? null,
    p_address: input.address ?? null,
    p_tax_number: input.taxNumber ?? null,
    p_notes: input.notes ?? null,
    p_status: input.status ?? null,
  });
}

export interface CreateOrderInput {
  warehouseId: string;
  supplierId: string;
  orderNumber: string;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  externalReference?: string | null;
  currency?: string | null;
  notes?: string | null;
  /** True ONLY when an OCR draft pre-filled the composer; provenance flag, nothing branches on it. */
  ocrAssisted?: boolean;
}

export function createOrder(input: CreateOrderInput) {
  return callRpc<{ order_id: string; status: OrderStatus; order_generation: number }>(
    'phoenix_procurement_create_order', {
      p_warehouse_id: input.warehouseId,
      p_supplier_id: input.supplierId,
      p_order_number: input.orderNumber,
      p_invoice_number: input.invoiceNumber ?? null,
      p_invoice_date: input.invoiceDate ?? null,
      p_external_reference: input.externalReference ?? null,
      p_currency: input.currency ?? null,
      p_notes: input.notes ?? null,
      p_ocr_assisted: input.ocrAssisted ?? false,
    });
}

export interface OrderLineInput {
  scientificName: string;
  orderedQuantity: number;
  centralItemId?: string | null;
  tradeName?: string | null;
  concentration?: string | null;
  dosageForm?: string | null;
  unit?: string | null;
  nationalCode?: string | null;
  batchNumber?: string | null;
  expiryDate?: string | null;
  unitPrice?: number | null;
  currency?: string | null;
  notes?: string | null;
}

export function addOrderLine(orderId: string, line: OrderLineInput) {
  return callRpc<{ order_line_id: string }>('phoenix_procurement_add_order_line', {
    p_order_id: orderId,
    p_scientific_name: line.scientificName,
    p_ordered_quantity: line.orderedQuantity,
    p_central_item_id: line.centralItemId ?? null,
    p_trade_name: line.tradeName ?? null,
    p_concentration: line.concentration ?? null,
    p_dosage_form: line.dosageForm ?? null,
    p_unit: line.unit ?? null,
    p_national_code: line.nationalCode ?? null,
    p_batch_number: line.batchNumber ?? null,
    p_expiry_date: line.expiryDate ?? null,
    p_unit_price: line.unitPrice ?? null,
    p_currency: line.currency ?? null,
    p_notes: line.notes ?? null,
  });
}

export function removeOrderLine(orderLineId: string) {
  return callRpc('phoenix_procurement_remove_order_line', { p_order_line_id: orderLineId });
}

export function submitOrder(orderId: string, expectedGeneration: number | null) {
  return callRpc<{ status: OrderStatus; order_generation: number }>(
    'phoenix_procurement_submit_order',
    { p_order_id: orderId, p_expected_generation: expectedGeneration });
}

export function decideOrder(
  orderId: string,
  approve: boolean,
  notes: string | null,
  expectedGeneration: number | null,
) {
  return callRpc<{ status: OrderStatus }>('phoenix_procurement_decide_order', {
    p_order_id: orderId,
    p_approve: approve,
    p_notes: notes,
    p_expected_generation: expectedGeneration,
  });
}

export function cancelOrder(orderId: string, reason: string, expectedGeneration: number | null) {
  return callRpc<{ status: OrderStatus }>('phoenix_procurement_cancel_order', {
    p_order_id: orderId,
    p_reason: reason,
    p_expected_generation: expectedGeneration,
  });
}

export interface ReceiveLineInput {
  orderLineId: string;
  quantity: number;
  batchNumber: string | null;
  hasNoBatchNumber: boolean;
  expiryDate?: string | null;
  unitPrice?: number | null;
}

export interface ReceiveResult {
  receipt_id: string;
  receipt_number: string;
  order_status: OrderStatus;
  idempotent_replay: boolean;
  lines: Array<{
    receipt_line_id: string;
    order_line_id: string;
    quantity: number;
    warehouse_stock_id: string;
    movement_id: string;
  }>;
}

export function receiveOrder(
  requestId: string,
  orderId: string,
  lines: ReceiveLineInput[],
  expectedGeneration: number | null,
  notes?: string | null,
) {
  return callRpc<ReceiveResult>('phoenix_procurement_receive_order', {
    p_request_id: requestId,
    p_order_id: orderId,
    p_lines: lines.map(l => ({
      order_line_id: l.orderLineId,
      quantity: l.quantity,
      batch_number: l.batchNumber,
      has_no_batch_number: l.hasNoBatchNumber,
      expiry_date: l.expiryDate ?? null,
      unit_price: l.unitPrice ?? null,
    })),
    p_expected_generation: expectedGeneration,
    p_notes: notes ?? null,
  });
}

export function returnToSupplier(
  requestId: string,
  receiptLineId: string,
  quantity: number,
  reason: string,
  notes?: string | null,
) {
  return callRpc<{ return_id: string; quantity_after: number; idempotent_replay: boolean }>(
    'phoenix_procurement_return_to_supplier', {
      p_request_id: requestId,
      p_receipt_line_id: receiptLineId,
      p_quantity: quantity,
      p_reason: reason,
      p_notes: notes ?? null,
      p_expected_generation: null,
    });
}
