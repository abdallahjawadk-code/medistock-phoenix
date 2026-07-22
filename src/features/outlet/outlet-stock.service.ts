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
}

interface OutletStockDbRow {
  id: string; scientific_name: string; trade_name: string | null; concentration: string | null;
  dosage_form: string | null; unit: string | null; national_code: string | null;
  batch_number: string | null; internal_batch_reference: string | null; expiry_date: string | null;
  on_hand_quantity: number; reserved_quantity: number; available_quantity: number;
  movement_seq: number | string;
}

const OUTLET_STOCK_COLUMNS =
  'id, scientific_name, trade_name, concentration, dosage_form, unit, national_code, ' +
  'batch_number, internal_batch_reference, expiry_date, on_hand_quantity, reserved_quantity, available_quantity, movement_seq';

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
  }));
}

/**
 * CANONICAL-STOCK-CUTOVER (migration 086): correct one outlet_stock LOT's on-hand
 * quantity to an absolute counted value via the guarded RPC. This is the only
 * outlet correction path — it operates on canonical outlet_stock, never
 * item_availability (which is now a read-only projection). The RPC is idempotent
 * on requestId, non-negative, reservation-safe, reason-mandatory, outlet-scoped,
 * and writes an append-only 'correction' movement + audit row. expectedGeneration
 * (the lot's last-read generation) makes a stale correction fail closed with a
 * conflict rather than silently overwrite a fresher count.
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
  outletStockId: string;
  movementId: string;
  quantityBefore: number;
  quantityDelta: number;
  quantityAfter: number;
}

export async function correctOutletStock(input: CorrectOutletStockInput): Promise<CorrectOutletStockResult> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');
  const { data, error } = await supabase.rpc('phoenix_count_outlet_stock_guarded', {
    p_request_id:          input.requestId,
    p_outlet_stock_id:     input.outletStockId,
    p_counted_quantity:    input.countedQuantity,
    p_reason:              input.reason,
    p_expected_generation: input.expectedGeneration,
    p_notes:               input.notes ?? null,
  });
  if (error) throw error;
  const r = data as {
    ok: boolean; idempotent_replay: boolean; outlet_stock_id: string; movement_id: string;
    quantity_before: number; quantity_delta: number; quantity_after: number;
  };
  return {
    ok: r.ok,
    idempotentReplay: r.idempotent_replay,
    outletStockId: r.outlet_stock_id,
    movementId: r.movement_id,
    quantityBefore: r.quantity_before,
    quantityDelta: r.quantity_delta,
    quantityAfter: r.quantity_after,
  };
}

/**
 * Classify a phoenix_count_outlet_stock_guarded failure into an i18n string key.
 * 40001 generation conflict is the "reload and retry" case; the rest are the
 * 067/086 validation vocabulary.
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
