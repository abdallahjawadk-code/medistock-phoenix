import { supabase, supabaseConfigured } from '@/shared/supabase/client';

/**
 * DECISION-INTELLIGENCE-REPORTS — "Differences and Corrections" section.
 *
 * Reuses the EXACT tables the second-person-approval workflow already
 * writes (098 outlet phoenix_stock_correction_requests, 101 warehouse
 * phoenix_warehouse_correction_requests) — no new table, no new RPC. Their
 * existing RLS SELECT policies are already org-scoped and NOT filtered by
 * status (`phoenix_..._select_scoped`, 098/101), so a full pending +
 * approved + rejected history is a plain read, unlike
 * listPendingOutletCorrections/listPendingWarehouseCorrections in
 * outlet-stock.service.ts/warehouse-intake.service.ts, which intentionally
 * narrow to status='pending' for the operational approval queues.
 */

export interface CorrectionHistoryRow {
  id: string;
  scope: 'outlet' | 'warehouse';
  status: 'pending' | 'approved' | 'rejected';
  scientificName: string | null;
  batchNumber: string | null;
  onHandBefore: number;
  afterOrProposed: number;
  variance: number;
  reason: string;
  decisionReason: string | null;
  proposedByName: string | null;
  proposedAt: string;
  decidedAt: string | null;
  /**
   * The ledger movement 133's approval RPC posted for this correction, once
   * approved (098/101's applied_movement_id — null while pending/rejected,
   * since no movement is ever posted for those outcomes). This is the
   * correction's traceability link back to the canonical movement ledger.
   */
  appliedMovementId: string | null;
}

interface WarehouseCorrectionDbRow {
  id: string; warehouse_stock_id: string; on_hand_before: number; new_quantity: number;
  variance: number; reason: string; status: string; decision_reason: string | null;
  proposed_by: string; proposed_at: string; decided_at: string | null;
  applied_movement_id: string | null;
}

interface OutletCorrectionDbRow {
  id: string; outlet_stock_id: string; on_hand_before: number; counted_quantity: number;
  variance: number; reason: string; status: string; decision_reason: string | null;
  proposed_by: string; proposed_at: string; decided_at: string | null;
  applied_movement_id: string | null;
}

/** Every warehouse + outlet correction request (any status) in the caller's org (RLS-scoped). */
export async function listCorrectionHistory(): Promise<CorrectionHistoryRow[]> {
  if (!supabaseConfigured) return [];

  const [wh, outlet] = await Promise.all([
    supabase.from('phoenix_warehouse_correction_requests')
      .select('id, warehouse_stock_id, on_hand_before, new_quantity, variance, reason, status, decision_reason, proposed_by, proposed_at, decided_at, applied_movement_id')
      .order('proposed_at', { ascending: false })
      .limit(200),
    supabase.from('phoenix_stock_correction_requests')
      .select('id, outlet_stock_id, on_hand_before, counted_quantity, variance, reason, status, decision_reason, proposed_by, proposed_at, decided_at, applied_movement_id')
      .order('proposed_at', { ascending: false })
      .limit(200),
  ]);
  if (wh.error) throw wh.error;
  if (outlet.error) throw outlet.error;

  const whRows = (wh.data as unknown as WarehouseCorrectionDbRow[] | null) ?? [];
  const outletRows = (outlet.data as unknown as OutletCorrectionDbRow[] | null) ?? [];

  const stockIds = whRows.map(r => r.warehouse_stock_id);
  const outletStockIds = outletRows.map(r => r.outlet_stock_id);
  const proposerIds = Array.from(new Set([...whRows, ...outletRows].map(r => r.proposed_by)));

  const [stockRes, outletStockRes, profileRes] = await Promise.all([
    stockIds.length
      ? supabase.from('warehouse_stock').select('id, scientific_name, batch_number').in('id', stockIds)
      : Promise.resolve({ data: [], error: null }),
    outletStockIds.length
      ? supabase.from('outlet_stock').select('id, scientific_name, batch_number').in('id', outletStockIds)
      : Promise.resolve({ data: [], error: null }),
    proposerIds.length
      ? supabase.from('profiles').select('id, full_name').in('id', proposerIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (stockRes.error) throw stockRes.error;
  if (outletStockRes.error) throw outletStockRes.error;
  if (profileRes.error) throw profileRes.error;

  interface StockLookup { id: string; scientific_name: string | null; batch_number: string | null }
  interface ProfileLookup { id: string; full_name: string | null }
  const stockById = new Map(((stockRes.data ?? []) as StockLookup[]).map(s => [s.id, s]));
  const outletStockById = new Map(((outletStockRes.data ?? []) as StockLookup[]).map(s => [s.id, s]));
  const nameById = new Map(((profileRes.data ?? []) as ProfileLookup[]).map(p => [p.id, p.full_name]));

  const rows: CorrectionHistoryRow[] = [
    ...whRows.map((r): CorrectionHistoryRow => {
      const stock = stockById.get(r.warehouse_stock_id);
      return {
        id: r.id, scope: 'warehouse', status: r.status as CorrectionHistoryRow['status'],
        scientificName: stock?.scientific_name ?? null, batchNumber: stock?.batch_number ?? null,
        onHandBefore: r.on_hand_before, afterOrProposed: r.new_quantity, variance: r.variance,
        reason: r.reason, decisionReason: r.decision_reason,
        proposedByName: nameById.get(r.proposed_by) ?? null, proposedAt: r.proposed_at, decidedAt: r.decided_at,
        appliedMovementId: r.applied_movement_id,
      };
    }),
    ...outletRows.map((r): CorrectionHistoryRow => {
      const stock = outletStockById.get(r.outlet_stock_id);
      return {
        id: r.id, scope: 'outlet', status: r.status as CorrectionHistoryRow['status'],
        scientificName: stock?.scientific_name ?? null, batchNumber: stock?.batch_number ?? null,
        onHandBefore: r.on_hand_before, afterOrProposed: r.counted_quantity, variance: r.variance,
        reason: r.reason, decisionReason: r.decision_reason,
        proposedByName: nameById.get(r.proposed_by) ?? null, proposedAt: r.proposed_at, decidedAt: r.decided_at,
        appliedMovementId: r.applied_movement_id,
      };
    }),
  ];

  return rows.sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
}
