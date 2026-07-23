import { supabase, supabaseConfigured } from '@/shared/supabase/client';

/**
 * OUTLET-CORRIDOR-070 — thin client over the migration 070 institution-warehouse
 * → outlet dispatch contracts and their 061 read tables.
 *
 * Same discipline as network.service.ts: this file NEVER computes stock, never
 * uses a privileged key and never writes a table directly. Every mutation is a
 * SECURITY DEFINER RPC that re-checks warehouse/outlet scope server-side; every
 * read is an RLS-scoped SELECT. The authoritative hierarchy is
 * central → institution warehouse → outlet: this corridor is ONLY the
 * institution-warehouse → its-own-scoped-outlet hop. There is no central→outlet
 * shortcut here, and the dispatch line's source is always a canonical
 * warehouse_stock lot (never a typed/OCR material identity).
 */

export interface RpcResult<T = Record<string, unknown>> {
  ok: boolean;
  data?: T;
  error?: string;
}

function rpcErrorCode(message: string | undefined): string {
  if (!message) return 'unknown_error';
  const head = message.split(':', 1)[0]?.trim() ?? message;
  // Accepts BOTH this corridor's historical 'CODE: message' uppercase
  // convention and 065/097/102's bare lowercase_snake RAISE convention
  // (e.g. 'fefo_override_required') — a strict widening, never narrower.
  return /^[A-Za-z0-9_]+$/.test(head) ? head : 'unknown_error';
}

async function callRpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
  if (!supabaseConfigured) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, error: rpcErrorCode(error.message) };
  const payload = (data ?? {}) as { ok?: boolean } & T;
  return { ok: payload.ok !== false, data: payload as T };
}

// ─── Dispatch header (061 table, 070 lifecycle) ──────────────────────────────

export interface WarehouseDispatch {
  id: string;
  organizationId: string;
  warehouseId: string;
  destinationDistributionPointId: string;
  dispatchNumber: string;
  status: string;
  documentNumber: string | null;
  defaultCurrency: string | null;
  notes: string | null;
  sentAt: string | null;
  createdAt: string;
}

interface WarehouseDispatchRow {
  id: string; organization_id: string; warehouse_id: string;
  destination_distribution_point_id: string; dispatch_number: string; status: string;
  document_number: string | null; default_currency: string | null; notes: string | null;
  sent_at: string | null; created_at: string;
}

const DISPATCH_COLUMNS =
  'id, organization_id, warehouse_id, destination_distribution_point_id, dispatch_number, ' +
  'status, document_number, default_currency, notes, sent_at, created_at';

function mapDispatch(r: WarehouseDispatchRow): WarehouseDispatch {
  return {
    id: r.id, organizationId: r.organization_id, warehouseId: r.warehouse_id,
    destinationDistributionPointId: r.destination_distribution_point_id,
    dispatchNumber: r.dispatch_number, status: r.status, documentNumber: r.document_number,
    defaultCurrency: r.default_currency, notes: r.notes, sentAt: r.sent_at, createdAt: r.created_at,
  };
}

/** Dispatches FROM an institution warehouse (the officer's outbound queue). RLS-scoped. */
export async function getWarehouseDispatches(warehouseId?: string): Promise<WarehouseDispatch[]> {
  if (!supabaseConfigured) return [];
  let q = supabase.from('warehouse_dispatches').select(DISPATCH_COLUMNS).order('created_at', { ascending: false });
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  const { data, error } = await q;
  if (error) throw error;
  // Concatenated const select → supabase-js infers GenericStringError[]; the shape
  // is asserted by WarehouseDispatchRow and the 061 columns. Same pattern as
  // network.service.getIncomingTransferLines.
  return (data as unknown as WarehouseDispatchRow[] | null ?? []).map(mapDispatch);
}

/** Dispatches TO an outlet (the outlet's incoming/receive queue). RLS-scoped. */
export async function getOutletDispatches(distributionPointId?: string): Promise<WarehouseDispatch[]> {
  if (!supabaseConfigured) return [];
  let q = supabase.from('warehouse_dispatches').select(DISPATCH_COLUMNS).order('sent_at', { ascending: false });
  if (distributionPointId) q = q.eq('destination_distribution_point_id', distributionPointId);
  const { data, error } = await q;
  if (error) throw error;
  // Concatenated const select → supabase-js infers GenericStringError[]; the shape
  // is asserted by WarehouseDispatchRow and the 061 columns. Same pattern as
  // network.service.getIncomingTransferLines.
  return (data as unknown as WarehouseDispatchRow[] | null ?? []).map(mapDispatch);
}

// ─── Dispatch line (immutable snapshots) ─────────────────────────────────────

export interface WarehouseDispatchLine {
  id: string;
  dispatchId: string;
  warehouseStockId: string;
  scientificName: string;
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  unit: string | null;
  nationalCode: string | null;
  batchNumber: string | null;
  internalBatchReference: string | null;
  expiryDate: string | null;
  unitPrice: number | null;
  currency: string | null;
  supplyTypeText: string | null;
  sentQuantity: number;
  receivedQuantity: number | null;
  /**
   * Server-maintained: how much of this accepted line has already been returned.
   * Migration 071 keeps it as the single authoritative return counter, and its
   * ADD-LINE RPC caps a new return at `received_quantity - returned_quantity`.
   * Read it, show it, never recompute it.
   */
  returnedQuantity: number;
  status: string;
  differenceReason: string | null;
}

interface WarehouseDispatchLineRow {
  id: string; dispatch_id: string; warehouse_stock_id: string;
  scientific_name: string; trade_name: string | null; concentration: string | null;
  dosage_form: string | null; unit: string | null; national_code: string | null;
  batch_number: string | null; internal_batch_reference: string | null; expiry_date: string | null;
  unit_price: number | null; currency: string | null; supply_type_text: string | null;
  sent_quantity: number; received_quantity: number | null; returned_quantity: number;
  status: string; difference_reason: string | null;
}

const DISPATCH_LINE_COLUMNS =
  'id, dispatch_id, warehouse_stock_id, scientific_name, trade_name, concentration, dosage_form, ' +
  'unit, national_code, batch_number, internal_batch_reference, expiry_date, unit_price, currency, ' +
  'supply_type_text, sent_quantity, received_quantity, returned_quantity, status, difference_reason';

function mapDispatchLine(r: WarehouseDispatchLineRow): WarehouseDispatchLine {
  return {
    id: r.id, dispatchId: r.dispatch_id, warehouseStockId: r.warehouse_stock_id,
    scientificName: r.scientific_name, tradeName: r.trade_name, concentration: r.concentration,
    dosageForm: r.dosage_form, unit: r.unit, nationalCode: r.national_code,
    batchNumber: r.batch_number, internalBatchReference: r.internal_batch_reference,
    expiryDate: r.expiry_date, unitPrice: r.unit_price, currency: r.currency,
    supplyTypeText: r.supply_type_text, sentQuantity: r.sent_quantity,
    receivedQuantity: r.received_quantity, returnedQuantity: r.returned_quantity,
    status: r.status, differenceReason: r.difference_reason,
  };
}

export async function getWarehouseDispatchLines(dispatchId: string): Promise<WarehouseDispatchLine[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('warehouse_dispatch_lines').select(DISPATCH_LINE_COLUMNS)
    .eq('dispatch_id', dispatchId).order('scientific_name', { ascending: true });
  if (error) throw error;
  // Concatenated const select → supabase-js infers GenericStringError[]; the shape
  // is asserted by WarehouseDispatchLineRow and DISPATCH_LINE_COLUMNS. Same pattern
  // as network.service.getIncomingTransferLines.
  return (data as unknown as WarehouseDispatchLineRow[] | null ?? []).map(mapDispatchLine);
}

/** Lines for MANY dispatches in ONE query — the outlet receive queue (no N+1). */
export async function getDispatchLinesForDispatches(dispatchIds: string[]): Promise<WarehouseDispatchLine[]> {
  if (!supabaseConfigured || dispatchIds.length === 0) return [];
  const { data, error } = await supabase
    .from('warehouse_dispatch_lines').select(DISPATCH_LINE_COLUMNS)
    .in('dispatch_id', dispatchIds).order('scientific_name', { ascending: true });
  if (error) throw error;
  // Concatenated const select → supabase-js infers GenericStringError[]; the shape
  // is asserted by WarehouseDispatchLineRow and DISPATCH_LINE_COLUMNS. Same pattern
  // as network.service.getIncomingTransferLines.
  return (data as unknown as WarehouseDispatchLineRow[] | null ?? []).map(mapDispatchLine);
}

// ─── Mutations (070 RPCs — SECURITY DEFINER, scope re-checked server-side) ────

export function createWarehouseDispatch(input: {
  warehouseId: string; destinationDistributionPointId: string; dispatchNumber: string;
  documentNumber?: string | null; defaultCurrency?: string | null; notes?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_create_warehouse_dispatch', {
    p_warehouse_id: input.warehouseId,
    p_destination_distribution_point_id: input.destinationDistributionPointId,
    p_dispatch_number: input.dispatchNumber,
    p_document_number: input.documentNumber ?? null,
    p_default_currency: input.defaultCurrency ?? null,
    p_notes: input.notes ?? null,
  });
}

/**
 * Adds one line from a CANONICAL institution warehouse_stock lot (never free
 * text). Calls 106's idempotency-wrapped 097/102 FEFO-guarded RPC — picking a
 * non-earliest-expiry batch fails closed with 'fefo_override_required' unless
 * `fefoOverride` is set together with a reason. This is the ONLY
 * dispatch-line-add call site; FEFO enforcement is therefore active for every
 * real caller, not just a server-side capability nothing in the UI actually
 * reaches.
 *
 * `requestId` is REQUIRED (107 tightened 106's p_request_id from optional to
 * mandatory server-side, closing the NULL bypass — omitting it now raises
 * 'request_id_required' before any read or write). It MUST be derived via
 * operation-token.ts (see OutletDispatchComposer), never minted fresh per
 * call — that derivation is what makes a retry of the SAME logical add-line
 * attempt replay the original result server-side instead of creating a
 * second line, while an actual payload change (a different quantity, a
 * different override reason) derives a DIFFERENT id and is correctly
 * treated as a new request. The TS type is intentionally honest about this
 * requirement (requestId: string, not requestId?: string) so a caller that
 * forgets to derive one fails to compile, not just fails at the RPC.
 */
export function addDispatchLine(input: {
  dispatchId: string; warehouseStockId: string; quantity: number;
  fefoOverride?: boolean; overrideReason?: string | null; requestId: string;
}): Promise<RpcResult<{ dispatch_line_id?: string; fefo_override_applied?: boolean }>> {
  return callRpc('phoenix_add_dispatch_line_fefo_guarded', {
    p_dispatch_id: input.dispatchId,
    p_warehouse_stock_id: input.warehouseStockId,
    p_quantity: input.quantity,
    p_fefo_override: input.fefoOverride ?? false,
    p_override_reason: input.overrideReason ?? null,
    p_request_id: input.requestId,
  });
}

export interface FefoBatch {
  stockId: string;
  batchNumber: string | null;
  expiryDate: string | null;
  availableQuantity: number;
}

interface FefoBatchDbRow {
  stock_id: string; batch_number: string | null; expiry_date: string | null; available_quantity: number;
}

/**
 * Every eligible batch for this material at this warehouse, FEFO-ordered
 * (072's own read: expiry_date ASC NULLS LAST, then id ASC — the SAME order
 * 097/102's guard compares against). Read-only; used to show the operator
 * WHY a pick was refused and what the earliest alternative actually is,
 * never to pick automatically.
 */
export async function getFefoAlternatives(
  organizationId: string, warehouseId: string, scientificName: string, nationalCode: string | null,
): Promise<FefoBatch[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase.rpc('phoenix_inventory_fefo_batches', {
    p_organization_id: organizationId,
    p_scope_kind: 'warehouse',
    p_scope_id: warehouseId,
    p_scientific_name: scientificName,
    p_national_code: nationalCode,
  });
  if (error) throw error;
  return ((data as FefoBatchDbRow[] | null) ?? []).map(r => ({
    stockId: r.stock_id, batchNumber: r.batch_number, expiryDate: r.expiry_date,
    availableQuantity: r.available_quantity,
  }));
}

export function updateDispatchLineQuantity(input: { dispatchLineId: string; quantity: number }): Promise<RpcResult> {
  return callRpc('phoenix_update_dispatch_line_quantity', {
    p_dispatch_line_id: input.dispatchLineId, p_quantity: input.quantity,
  });
}

export function deleteDispatchLine(dispatchLineId: string): Promise<RpcResult> {
  return callRpc('phoenix_delete_dispatch_line', { p_dispatch_line_id: dispatchLineId });
}

/** Sends the whole dispatch. `requestId` is a fresh idempotency token. */
export function sendWarehouseDispatch(input: { requestId: string; dispatchId: string }): Promise<RpcResult> {
  return callRpc('phoenix_send_warehouse_dispatch', {
    p_request_id: input.requestId, p_dispatch_id: input.dispatchId,
  });
}

export function cancelWarehouseDispatch(dispatchId: string, reason: string): Promise<RpcResult> {
  return callRpc('phoenix_cancel_warehouse_dispatch', {
    p_dispatch_id: dispatchId, p_cancellation_reason: reason,
  });
}

/** Outlet receives one dispatched line. `requestId` is a fresh idempotency token. */
export function receiveOutletDispatchLine(input: {
  requestId: string; dispatchLineId: string; receivedQuantity: number;
  differenceReason?: string | null; notes?: string | null;
}): Promise<RpcResult> {
  return callRpc('phoenix_receive_outlet_dispatch_line', {
    p_request_id: input.requestId,
    p_dispatch_line_id: input.dispatchLineId,
    p_received_quantity: input.receivedQuantity,
    p_difference_reason: input.differenceReason ?? null,
    p_notes: input.notes ?? null,
  });
}
