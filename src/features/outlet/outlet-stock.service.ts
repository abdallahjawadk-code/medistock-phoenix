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
}

interface OutletStockDbRow {
  id: string; scientific_name: string; trade_name: string | null; concentration: string | null;
  dosage_form: string | null; unit: string | null; national_code: string | null;
  batch_number: string | null; internal_batch_reference: string | null; expiry_date: string | null;
  on_hand_quantity: number; reserved_quantity: number; available_quantity: number;
}

const OUTLET_STOCK_COLUMNS =
  'id, scientific_name, trade_name, concentration, dosage_form, unit, national_code, ' +
  'batch_number, internal_batch_reference, expiry_date, on_hand_quantity, reserved_quantity, available_quantity';

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
  }));
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
