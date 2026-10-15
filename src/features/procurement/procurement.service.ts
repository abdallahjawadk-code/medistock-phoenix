import { supabase, supabaseConfigured } from '@/shared/supabase/client';
import { isDeadlineExceeded, withDeadline } from '@/shared/lib/deadline';

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

export function mapOrder(r: any): OrderRow {
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

/**
 * CI-4C — CONFIRM-ONLY reconciliation of one direct-entry request id, read through the EXISTING RLS-protected tables
 * (087 SELECT policies on receipts, orders, order events, order lines, receipt lines and suppliers). No RPC, no write.
 *
 * It can only CONFIRM that the server recorded THIS operator's purchase for THIS request. An empty, filtered, refused,
 * failing or slow read is `unresolved`, never a verdict that the purchase did not happen: RLS filters silently, the
 * original call may still be in flight, and the reader's access may have changed since the purchase.
 */
export const RECONCILE_DEADLINE_MS = 10_000;

export interface DirectEntryExpectation {
  /** The request id of the locked attempt. */
  requestId: string;
  /** The profile that created the attempt. It must be the signed-in user and the receipt's received_by. */
  actorId: string;
  organizationId: string;
  warehouseId: string;
  /** The frozen RPC arguments of the attempt, without p_request_id. */
  args: Readonly<Record<string, unknown>>;
}

export type DirectEntryReconciliation =
  | { status: 'confirmed'; orderNumber: string; receiptNumber: string }
  | {
      status: 'unresolved';
      reason: 'not_configured' | 'no_session' | 'not_own_session' | 'not_found' | 'ambiguous_rows' | 'not_own_receipt'
        | 'scope_mismatch' | 'order_mismatch' | 'provenance_missing' | 'payload_mismatch' | 'read_error' | 'timeout';
    };

type UnresolvedReconciliation = Extract<DirectEntryReconciliation, { status: 'unresolved' }>;
const notConfirmed = (reason: UnresolvedReconciliation['reason']): UnresolvedReconciliation => ({ status: 'unresolved', reason });

/**
 * 116 stores NULLIF(btrim(x), ''); the frozen argument is normalized the same way. PostgreSQL btrim with no character
 * list removes only U+0020 spaces, so JavaScript trim() (which also removes tabs, line breaks and no-break spaces) is
 * not used.
 */
function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/^ +| +$/g, '');
  return trimmed === '' ? null : trimmed;
}

function sameNumber(stored: unknown, expected: unknown): boolean {
  if (expected === null || expected === undefined) return stored === null || stored === undefined;
  return stored !== null && stored !== undefined && Number(stored) === Number(expected);
}

/** One bounded SELECT (at most two rows, so a duplicate is visible). A transport or RLS refusal is reported, not thrown. */
async function selectRows(
  table: string,
  columns: string,
  filters: Array<[string, unknown]>,
): Promise<Record<string, unknown>[] | 'error'> {
  let query = supabase.from(table).select(columns);
  for (const [column, value] of filters) query = query.eq(column, value);
  const { data, error } = await query.limit(2);
  if (error) return 'error';
  return (data ?? []) as unknown as Record<string, unknown>[];
}

async function verifyDirectEntry(expected: DirectEntryExpectation): Promise<DirectEntryReconciliation> {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user?.id ?? null;
  if (userId === null) return notConfirmed('no_session');
  if (userId !== expected.actorId) return notConfirmed('not_own_session');

  const receipts = await selectRows('procurement_receipts',
    'id, order_id, organization_id, warehouse_id, request_id, received_by, receipt_number, notes',
    [['request_id', expected.requestId]]);
  if (receipts === 'error') return notConfirmed('read_error');
  if (receipts.length === 0) return notConfirmed('not_found');
  if (receipts.length !== 1 || receipts[0].request_id !== expected.requestId) return notConfirmed('ambiguous_rows');
  const receipt = receipts[0];
  if (receipt.received_by !== userId) return notConfirmed('not_own_receipt');
  if (receipt.organization_id !== expected.organizationId || receipt.warehouse_id !== expected.warehouseId) {
    return notConfirmed('scope_mismatch');
  }

  const orders = await selectRows('procurement_orders',
    'id, organization_id, warehouse_id, supplier_id, order_number, invoice_number, invoice_date, notes',
    [['id', receipt.order_id]]);
  if (orders === 'error') return notConfirmed('read_error');
  if (orders.length !== 1) return notConfirmed('order_mismatch');
  const order = orders[0];
  if (order.id !== receipt.order_id || order.organization_id !== expected.organizationId
    || order.warehouse_id !== expected.warehouseId) {
    return notConfirmed('order_mismatch');
  }

  // Provenance: 116:193-195 logs the order's 'created' event with direct_entry and the request id.
  const events = await selectRows('procurement_order_events', 'order_id, event_type, payload',
    [['order_id', order.id], ['event_type', 'created']]);
  if (events === 'error') return notConfirmed('read_error');
  const provenance = (events.length === 1 ? events[0].payload : null) as Record<string, unknown> | null;
  if (provenance === null || provenance.direct_entry !== true || provenance.request_id !== expected.requestId) {
    return notConfirmed('provenance_missing');
  }

  const orderLines = await selectRows('procurement_order_lines',
    'id, order_id, central_item_id, scientific_name, trade_name, concentration, dosage_form, unit, national_code, ordered_quantity',
    [['order_id', order.id]]);
  if (orderLines === 'error') return notConfirmed('read_error');
  const receiptLines = await selectRows('procurement_receipt_lines',
    'receipt_id, order_line_id, quantity, batch_number, has_no_batch_number, national_code, expiry_date, unit_price',
    [['receipt_id', receipt.id]]);
  if (receiptLines === 'error') return notConfirmed('read_error');
  const suppliers = await selectRows('procurement_suppliers', 'id, name', [['id', order.supplier_id]]);
  if (suppliers === 'error') return notConfirmed('read_error');
  if (orderLines.length !== 1 || receiptLines.length !== 1 || suppliers.length !== 1) return notConfirmed('payload_mismatch');

  // The recorded purchase must equal the frozen payload as 116 stores it (116:178-237): every argument the RPC persists
  // for a direct entry, not only the replay fingerprint (116:109-113).
  const args = expected.args;
  const orderLine = orderLines[0];
  const receiptLine = receiptLines[0];
  const supplierName = suppliers[0].name;
  const expectedSupplier = trimmedOrNull(args.p_supplier_name) ?? 'شراء مباشر';
  const expectedNotes = trimmedOrNull(args.p_notes);
  const consistent = receiptLine.order_line_id === orderLine.id
    && orderLine.scientific_name === trimmedOrNull(args.p_scientific_name)
    && sameNumber(orderLine.ordered_quantity, args.p_quantity)
    && sameNumber(receiptLine.quantity, args.p_quantity)
    && (receiptLine.batch_number ?? null) === trimmedOrNull(args.p_batch_number)
    && receiptLine.has_no_batch_number === (args.p_has_no_batch === true)
    && (receiptLine.expiry_date ?? null) === (args.p_expiry_date ?? null)
    && sameNumber(receiptLine.unit_price, args.p_unit_price)
    && (order.invoice_number ?? null) === trimmedOrNull(args.p_invoice_number)
    && (order.invoice_date ?? null) === (args.p_purchase_date ?? null)
    && (order.notes ?? null) === expectedNotes
    && (receipt.notes ?? null) === expectedNotes
    && (orderLine.central_item_id ?? null) === (args.p_central_item_id ?? null)
    && (orderLine.trade_name ?? null) === trimmedOrNull(args.p_trade_name)
    && (orderLine.concentration ?? null) === trimmedOrNull(args.p_concentration)
    && (orderLine.dosage_form ?? null) === trimmedOrNull(args.p_dosage_form)
    && (orderLine.unit ?? null) === trimmedOrNull(args.p_unit)
    && (orderLine.national_code ?? null) === trimmedOrNull(args.p_national_code)
    && (receiptLine.national_code ?? null) === trimmedOrNull(args.p_national_code)
    // 116:157-158 reuses an existing supplier matched by lower(name), so the stored name may differ in letter case.
    && typeof supplierName === 'string' && supplierName.toLowerCase() === expectedSupplier.toLowerCase();
  if (!consistent) return notConfirmed('payload_mismatch');

  const orderNumber = order.order_number;
  const receiptNumber = receipt.receipt_number;
  if (typeof orderNumber !== 'string' || typeof receiptNumber !== 'string') return notConfirmed('payload_mismatch');

  // The answer is only usable by the user it was read for: a sign-out or a user switch during the reads voids it.
  const { data: finalSession } = await supabase.auth.getSession();
  const finalUserId = finalSession.session?.user?.id ?? null;
  if (finalUserId === null) return notConfirmed('no_session');
  if (finalUserId !== userId) return notConfirmed('not_own_session');
  return { status: 'confirmed', orderNumber, receiptNumber };
}

/** One bounded, read-only check. It never polls, never retries, and never writes. */
export async function reconcileDirectEntry(
  expected: DirectEntryExpectation,
  deadlineMs: number = RECONCILE_DEADLINE_MS,
): Promise<DirectEntryReconciliation> {
  if (!supabaseConfigured) return notConfirmed('not_configured');
  try {
    const result = await withDeadline(verifyDirectEntry(expected), deadlineMs);
    return isDeadlineExceeded(result) ? notConfirmed('timeout') : result;
  } catch {
    return notConfirmed('read_error');
  }
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

export interface DuplicateCandidate {
  source: 'catalog' | 'existing_lot';
  sourceId: string;
  scientificName: string;
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  nationalCode: string | null;
  similarityScore: number;
}

/**
 * 117 — advisory-only (never blocking) fuzzy duplicate lookup for the
 * supplementary-purchase entry screen. Returns [] on any error/empty term
 * rather than surfacing a hard failure — this is a hint, not a gate.
 */
export async function getDuplicateCandidates(
  warehouseId: string,
  scientificName: string,
  tradeName?: string | null,
  nationalCode?: string | null,
): Promise<DuplicateCandidate[]> {
  if (!supabaseConfigured || scientificName.trim().length < 2) return [];
  const { data, error } = await supabase.rpc('phoenix_subpurchase_duplicate_candidates', {
    p_warehouse_id: warehouseId,
    p_scientific_name: scientificName.trim(),
    p_trade_name: tradeName?.trim() || null,
    p_national_code: nationalCode?.trim() || null,
    p_limit: 5,
  });
  if (error || !Array.isArray(data)) return [];
  return (data as Array<Record<string, unknown>>).map(r => ({
    source: r.source as 'catalog' | 'existing_lot',
    sourceId: r.source_id as string,
    scientificName: r.scientific_name as string,
    tradeName: (r.trade_name as string | null) ?? null,
    concentration: (r.concentration as string | null) ?? null,
    dosageForm: (r.dosage_form as string | null) ?? null,
    nationalCode: (r.national_code as string | null) ?? null,
    similarityScore: Number(r.similarity_score ?? 0),
  }));
}
