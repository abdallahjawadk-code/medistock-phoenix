import { supabase, supabaseConfigured } from '@/shared/supabase/client';
import { getWarehouseDispatches, type WarehouseDispatch } from '@/features/outlet/dispatch.service';
import {
  getOutletReturnRequests, getOutletReturnShipments,
  type OutletReturnRequest, type OutletReturnShipment,
} from '@/features/outlet/outlet-return.service';

/**
 * DECISION-INTELLIGENCE-REPORTS — "Custody Chain" section.
 *
 * Reuses the EXACT header lists dispatch.service.ts/outlet-return.service.ts
 * already expose (called with no id filter, they return every RLS-visible
 * row for the caller's organization — the same functions the operational
 * screens use, just without narrowing to one warehouse/outlet). No new
 * table, no new list RPC.
 *
 * Per-document drill-down reuses phoenix_movement_timeline (081/082)
 * VERBATIM — that RPC's own header comment is explicit that a full
 * retrospective history cannot always be reconstructed (`complete: false`
 * with a `completeness_note`), and this report surfaces that honestly
 * rather than pretending otherwise.
 */

export type { WarehouseDispatch, OutletReturnRequest, OutletReturnShipment };

export interface MovementTimelineEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  actor_id: string | null;
  actor_role: string | null;
  actor_name: string | null;
  status: string | null;
  material: string | null;
  batch: string | null;
  quantity_delta: number | null;
  reference_type: string | null;
  reference_id: string | null;
  reference: string | null;
  provenance: string;
}

export interface MovementTimelineResult {
  ok: boolean;
  events: MovementTimelineEvent[];
  complete: boolean;
  completeness_note: string;
}

/** Every dispatch (any status) RLS-visible to the caller's organization. */
export function listCustodyDispatches(): Promise<WarehouseDispatch[]> {
  return getWarehouseDispatches();
}

/** Every outlet return REQUEST (any status) RLS-visible to the caller's organization. */
export function listCustodyReturnRequests(): Promise<OutletReturnRequest[]> {
  return getOutletReturnRequests();
}

/** Every outlet return SHIPMENT (any status) RLS-visible to the caller's organization. */
export function listCustodyReturnShipments(): Promise<OutletReturnShipment[]> {
  return getOutletReturnShipments();
}

/** The full known event trail for one document — honest about incompleteness. */
export async function getMovementTimeline(traceId: string): Promise<MovementTimelineResult> {
  if (!supabaseConfigured) return { ok: false, events: [], complete: false, completeness_note: '' };
  const { data, error } = await supabase.rpc('phoenix_movement_timeline', {
    p_trace_id: traceId,
    p_limit: 50,
    p_after_at: null,
    p_after_id: null,
  });
  if (error) throw error;
  return data as MovementTimelineResult;
}
