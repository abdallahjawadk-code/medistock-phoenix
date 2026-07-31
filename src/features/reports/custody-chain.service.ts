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
 *
 * REVIEWER FIX (Phase 4, migration 148 review): custody begins at the real
 * send/dispatch event, never at draft creation — a draft (including one
 * auto-created by phoenix_create_transfer_draft_from_suggestion) is an
 * administrative document with no physical custody yet. The three list*
 * functions below therefore exclude status='draft' rows; drafts remain
 * fully visible on their own operational request/dispatch list screens
 * (network.service.ts consumers), just not inside this custody trail.
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
  /**
   * MOVEMENT-TIMELINE-CONTRACT-FIELDS-139 — additive Unified Movements
   * contract fields. Nullable by design, and honestly so: a
   * derived_from_column event (a corridor header transition) has no
   * quantity or reason at all, and the event_ledger envelope never carried
   * reason_code. The UI must render '—' for those rather than invent a value.
   */
  reason_code: string | null;
  quantity_before: number | null;
  quantity_after: number | null;
  correlation_id: string | null;
  causation_id: string | null;
  /** true only for an outlet movement with a recorded beneficiary. The
   *  beneficiary itself is NEVER in this payload — call getDispenseContext()
   *  for the masked detail. */
  has_dispense_context: boolean;
}

export interface MovementTimelineResult {
  ok: boolean;
  events: MovementTimelineEvent[];
  complete: boolean;
  completeness_note: string;
}

/**
 * Every dispatch RLS-visible to the caller's organization EXCEPT drafts —
 * custody starts at the real send event, not at document creation.
 */
export async function listCustodyDispatches(): Promise<WarehouseDispatch[]> {
  const rows = await getWarehouseDispatches();
  return rows.filter(d => d.status !== 'draft');
}

/**
 * Every outlet return REQUEST RLS-visible to the caller's organization
 * EXCEPT drafts — custody starts at the real dispatched/sent event.
 */
export async function listCustodyReturnRequests(): Promise<OutletReturnRequest[]> {
  const rows = await getOutletReturnRequests();
  return rows.filter(r => r.status !== 'draft');
}

/** Every outlet return SHIPMENT (any status) RLS-visible to the caller's organization — a shipment row only ever exists once a real send has happened, so no draft filter applies here. */
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
