/**
 * OUTLET STOCK — read-only views for the Outlet Operations screen.
 *
 * These are SELECTs only. The outlet's on-hand stock and its movement ledger are
 * projections of the server's own writes (070 receipts, 071 returns, dispenses);
 * nothing here mutates, and RLS re-scopes every row to the caller's outlet
 * regardless of the id passed. The "Stock & Batches" and "Movement History" tabs
 * are windows onto that truth, never an entry point into it.
 */
import { supabase, supabaseConfigured } from '@/shared/supabase/client';

export interface OutletStockRow {
  id: string;
  scientificName: string;
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  unit: string | null;
  nationalCode: string | null;
  batchNumber: string | null;
  internalBatchReference: string | null;
  expiryDate: string | null;
  onHandQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  /** Server-owned optimistic-concurrency generation (migration 086). Read here
   *  and passed back as expectedGeneration to phoenix_count_outlet_stock_guarded
   *  so a stale correction cannot silently overwrite a fresher one. */
  generation: number;
  /**
   * Migration 060's original central_items identity (never a client-side
   * derivation). NULL for legacy/unresolved rows — the same "cannot be
   * suspended because there is nothing resolved to key a suspension on"
   * exemption 204 itself applies server-side. Read here so the outlet stock
   * list can ask phoenix_get_material_dispensing_suspension_status once per
   * unique material and show the موقوف الصرف badge proactively, before the
   * operator opens the dispense composer and the server refuses it.
   */
  centralItemId: string | null;
}

interface OutletStockDbRow {
  id: string; scientific_name: string; trade_name: string | null; concentration: string | null;
  dosage_form: string | null; unit: string | null; national_code: string | null;
  batch_number: string | null; internal_batch_reference: string | null; expiry_date: string | null;
  on_hand_quantity: number; reserved_quantity: number; available_quantity: number;
  movement_seq: number | string; central_item_id: string | null;
}

const OUTLET_STOCK_COLUMNS =
  'id, scientific_name, trade_name, concentration, dosage_form, unit, national_code, ' +
  'batch_number, internal_batch_reference, expiry_date, on_hand_quantity, reserved_quantity, available_quantity, movement_seq, central_item_id';

/** Current on-hand batches at one outlet, soonest-expiry first. RLS-scoped, read-only. */
export async function getOutletStock(distributionPointId: string): Promise<OutletStockRow[]> {
  if (!supabaseConfigured || !distributionPointId) return [];
  const { data, error } = await supabase
    .from('outlet_stock').select(OUTLET_STOCK_COLUMNS)
    .eq('distribution_point_id', distributionPointId)
    .order('expiry_date', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data as unknown as OutletStockDbRow[] | null ?? []).map(r => ({
    id: r.id, scientificName: r.scientific_name, tradeName: r.trade_name, concentration: r.concentration,
    dosageForm: r.dosage_form, unit: r.unit, nationalCode: r.national_code, batchNumber: r.batch_number,
    internalBatchReference: r.internal_batch_reference, expiryDate: r.expiry_date,
    onHandQuantity: r.on_hand_quantity, reservedQuantity: r.reserved_quantity, availableQuantity: r.available_quantity,
    generation: typeof r.movement_seq === 'string' ? Number(r.movement_seq) : r.movement_seq,
    centralItemId: r.central_item_id,
  }));
}

/**
 * SECOND-PERSON-CORRECTION-APPROVAL (migration 098): correct one outlet_stock
 * LOT's on-hand quantity to an absolute counted value via the REQUEST RPC —
 * never the bare guarded RPC directly. `phoenix_request_outlet_stock_correction`
 * applies immediately ONLY when the variance is within the organization's
 * configured threshold (fail-closed default 0); any larger variance is queued
 * as a pending request that a DIFFERENT authorized person must approve or
 * reject — the proposer can never approve their own request, enforced
 * server-side by profile identity, not role. This is still the only outlet
 * correction entry point — it operates on canonical outlet_stock, never
 * item_availability — and is idempotent on requestId, non-negative,
 * reservation-safe, reason-mandatory, outlet-scoped.
 */
export interface CorrectOutletStockInput {
  requestId: string;
  outletStockId: string;
  countedQuantity: number;
  reason: string;
  expectedGeneration: number;
  notes?: string;
}

export interface CorrectOutletStockResult {
  ok: boolean;
  idempotentReplay: boolean;
  /** true when this landed as a PENDING request awaiting a second person —
   *  outlet_stock was NOT touched; false when it applied immediately
   *  (variance within the org's configured threshold). */
  requiresApproval: boolean;
  /** Populated only when requiresApproval is true. */
  correctionRequestId?: string;
  status?: 'pending' | 'approved' | 'rejected';
  variance?: number;
  threshold?: number;
  /** Populated only when the correction applied immediately. */
  outletStockId?: string;
  movementId?: string;
  quantityBefore?: number;
  quantityDelta?: number;
  quantityAfter?: number;
}

export async function correctOutletStock(input: CorrectOutletStockInput): Promise<CorrectOutletStockResult> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');
  const { data, error } = await supabase.rpc('phoenix_request_outlet_stock_correction', {
    p_request_id:          input.requestId,
    p_outlet_stock_id:     input.outletStockId,
    p_counted_quantity:    input.countedQuantity,
    p_reason:              input.reason,
    p_expected_generation: input.expectedGeneration,
    p_notes:               input.notes ?? null,
  });
  if (error) throw error;
  const r = data as {
    ok: boolean; idempotent_replay?: boolean; requires_approval: boolean;
    correction_request_id?: string; status?: 'pending' | 'approved' | 'rejected';
    variance?: number; threshold?: number;
    outlet_stock_id?: string; movement_id?: string;
    quantity_before?: number; quantity_delta?: number; quantity_after?: number;
  };
  return {
    ok: r.ok,
    idempotentReplay: r.idempotent_replay ?? false,
    requiresApproval: r.requires_approval,
    correctionRequestId: r.correction_request_id,
    status: r.status,
    variance: r.variance,
    threshold: r.threshold,
    outletStockId: r.outlet_stock_id,
    movementId: r.movement_id,
    quantityBefore: r.quantity_before,
    quantityDelta: r.quantity_delta,
    quantityAfter: r.quantity_after,
  };
}

/**
 * Classify a phoenix_request_outlet_stock_correction failure into an i18n
 * string key. 40001 generation conflict is the "reload and retry" case; the
 * rest are the 067/086/098 validation vocabulary.
 */
export function classifyOutletCorrectionError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  const message = (error as { message?: string } | null)?.message ?? '';
  if (code === '40001' || message.includes('outlet_stock_generation_conflict')) return 'outlet_correct_generation_conflict';
  if (message.includes('outlet_quantity_below_reserved')) return 'outlet_correct_below_reserved';
  if (message.includes('counted_quantity_must_be_non_negative')) return 'outlet_correct_negative';
  if (message.includes('outlet_count_reason_required')) return 'outlet_correct_reason_required';
  if (message.includes('request_id_conflict')) return 'outlet_correct_request_conflict';
  if (code === '42501' || /forbidden/.test(message)) return 'outlet_correct_forbidden';
  return 'load_error';
}

// ─── Second-person approval — pending list + approve/reject (098) ───────────

export interface PendingOutletCorrection {
  id: string;
  outletStockId: string;
  onHandBefore: number;
  countedQuantity: number;
  variance: number;
  reason: string;
  notes: string | null;
  proposedBy: string;
  proposedByName: string | null;
  proposedAt: string;
  /** Enriched client-side from outlet_stock — the row may have moved since
   *  the request was proposed, so this is read fresh, not snapshotted. */
  scientificName: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
  distributionPointId: string | null;
  /** Server-owned generation of the underlying outlet_stock row RIGHT NOW —
   *  read alongside the request so approve/reject can pass a live guard. */
  currentGeneration: number | null;
  currentOnHand: number | null;
}

interface PendingOutletCorrectionDbRow {
  id: string; outlet_stock_id: string; on_hand_before: number; counted_quantity: number;
  variance: number; reason: string; notes: string | null; proposed_by: string; proposed_at: string;
}

/** Every PENDING outlet correction request in the caller's organization (RLS-scoped). */
export async function listPendingOutletCorrections(): Promise<PendingOutletCorrection[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('phoenix_stock_correction_requests')
    .select('id, outlet_stock_id, on_hand_before, counted_quantity, variance, reason, notes, proposed_by, proposed_at')
    .eq('status', 'pending')
    .order('proposed_at', { ascending: true });
  if (error) throw error;
  const rows = (data as unknown as PendingOutletCorrectionDbRow[] | null) ?? [];
  if (rows.length === 0) return [];

  const stockIds = Array.from(new Set(rows.map(r => r.outlet_stock_id)));
  const proposerIds = Array.from(new Set(rows.map(r => r.proposed_by)));
  const [{ data: stockRows, error: stockError }, { data: profileRows, error: profileError }] = await Promise.all([
    supabase.from('outlet_stock')
      .select('id, scientific_name, batch_number, expiry_date, distribution_point_id, on_hand_quantity, movement_seq')
      .in('id', stockIds),
    supabase.from('profiles').select('id, full_name').in('id', proposerIds),
  ]);
  if (stockError) throw stockError;
  if (profileError) throw profileError;
  interface StockLookupRow {
    id: string; scientific_name: string | null; batch_number: string | null; expiry_date: string | null;
    distribution_point_id: string | null; on_hand_quantity: number; movement_seq: number | string;
  }
  interface ProfileLookupRow { id: string; full_name: string | null }
  const stockById = new Map((stockRows as StockLookupRow[] ?? []).map(s => [s.id, s]));
  const nameById = new Map((profileRows as ProfileLookupRow[] ?? []).map(p => [p.id, p.full_name]));

  return rows.map(r => {
    const stock = stockById.get(r.outlet_stock_id);
    return {
      id: r.id, outletStockId: r.outlet_stock_id, onHandBefore: r.on_hand_before,
      countedQuantity: r.counted_quantity, variance: r.variance, reason: r.reason, notes: r.notes,
      proposedBy: r.proposed_by, proposedByName: nameById.get(r.proposed_by) ?? null, proposedAt: r.proposed_at,
      scientificName: stock?.scientific_name ?? null, batchNumber: stock?.batch_number ?? null,
      expiryDate: stock?.expiry_date ?? null, distributionPointId: stock?.distribution_point_id ?? null,
      currentGeneration: stock ? Number(stock.movement_seq) : null,
      currentOnHand: stock?.on_hand_quantity ?? null,
    };
  });
}

export interface CorrectionDecisionResult {
  ok: boolean;
  quantityBefore?: number;
  quantityAfter?: number;
}

/** A DIFFERENT authorized person approves — applies the correction inline, server-side. */
export async function approveOutletStockCorrection(
  correctionRequestId: string, expectedGeneration: number | null,
): Promise<CorrectionDecisionResult> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');
  const { data, error } = await supabase.rpc('phoenix_approve_outlet_stock_correction', {
    p_correction_request_id: correctionRequestId,
    p_expected_generation: expectedGeneration,
  });
  if (error) throw error;
  const r = data as { ok: boolean; quantity_before?: number; quantity_after?: number };
  return { ok: r.ok, quantityBefore: r.quantity_before, quantityAfter: r.quantity_after };
}

/** Rejects a pending request — no stock write of any kind. */
export async function rejectOutletStockCorrection(
  correctionRequestId: string, decisionReason: string,
): Promise<{ ok: boolean }> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');
  const { data, error } = await supabase.rpc('phoenix_reject_outlet_stock_correction', {
    p_correction_request_id: correctionRequestId,
    p_decision_reason: decisionReason,
  });
  if (error) throw error;
  return { ok: (data as { ok: boolean }).ok };
}

/**
 * Classify an approve/reject failure. 'proposer_cannot_approve_own_correction'
 * and 'forbidden_correction_approval' are both fail-closed authorization
 * refusals, never a partial application.
 */
export function classifyCorrectionDecisionError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  const message = (error as { message?: string } | null)?.message ?? '';
  if (code === '40001' || message.includes('outlet_stock_generation_conflict')) return 'outlet_correct_generation_conflict';
  if (message.includes('proposer_cannot_approve_own_correction')) return 'correction_proposer_cannot_approve';
  if (message.includes('forbidden_correction_approval')) return 'correction_forbidden_approval';
  if (message.includes('correction_request_not_pending')) return 'correction_not_pending';
  if (message.includes('correction_request_not_found')) return 'correction_not_found';
  if (message.includes('decision_reason_required')) return 'correction_reason_required';
  if (code === '42501' || /forbidden/.test(message)) return 'outlet_correct_forbidden';
  return 'load_error';
}

export interface OutletMovementRow {
  id: string;
  movementType: string;
  scientificName: string;
  batchNumber: string | null;
  expiryDate: string | null;
  onHandBefore: number;
  onHandDelta: number;
  onHandAfter: number;
  reason: string | null;
  sourceDocumentNumber: string | null;
  actorName: string | null;
  createdAt: string;
}

interface OutletMovementDbRow {
  id: string; movement_type: string; scientific_name_snapshot: string; batch_number_snapshot: string | null;
  expiry_date_snapshot: string | null; on_hand_before: number; on_hand_delta: number; on_hand_after: number;
  reason: string | null; source_document_number: string | null; actor_name: string | null; created_at: string;
}

const OUTLET_MOVEMENT_COLUMNS =
  'id, movement_type, scientific_name_snapshot, batch_number_snapshot, expiry_date_snapshot, ' +
  'on_hand_before, on_hand_delta, on_hand_after, reason, source_document_number, actor_name, created_at';

/** Newest-first movement ledger for one outlet, capped — an audit view, not an export. */
export async function getOutletStockMovements(
  distributionPointId: string,
  limit = 100,
): Promise<OutletMovementRow[]> {
  if (!supabaseConfigured || !distributionPointId) return [];
  const { data, error } = await supabase
    .from('outlet_stock_movements').select(OUTLET_MOVEMENT_COLUMNS)
    .eq('distribution_point_id', distributionPointId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as unknown as OutletMovementDbRow[] | null ?? []).map(r => ({
    id: r.id, movementType: r.movement_type, scientificName: r.scientific_name_snapshot,
    batchNumber: r.batch_number_snapshot, expiryDate: r.expiry_date_snapshot,
    onHandBefore: r.on_hand_before, onHandDelta: r.on_hand_delta, onHandAfter: r.on_hand_after,
    reason: r.reason, sourceDocumentNumber: r.source_document_number,
    actorName: r.actor_name, createdAt: r.created_at,
  }));
}
