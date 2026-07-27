/**
 * MOVEMENT-LEDGER-REPORT (migration 138) — the canonical, paginated Stock
 * Movements report, replacing the legacy item_availability_movements read
 * path (getAvailabilityMovementsReport in availability.service.ts).
 *
 * A single SECURITY DEFINER RPC unions the three live ledgers (warehouse,
 * outlet, quarantine) with the Unified Movements contract fields —
 * reason_code, quantity_before/delta/after, correlation_id, causation_id,
 * actor, reference_type/reference_id, source_document_number — plus a
 * joined location name. Org isolation, permission gating (status_center.view,
 * same as the screens that already embed this report) and pagination are
 * all enforced server-side; this file only shapes the request/response.
 *
 * Dispense-context detail (patient/crash-cart/internal-order) is NEVER
 * fetched by this service — the RPC only returns a `hasDispenseContext`
 * flag. Drill-down reuses getDispenseContext() from
 * features/outlet/dispense-context.service.ts VERBATIM, so the existing
 * server-side masking (movement_context.view_sensitive) is never
 * reimplemented or bypassed here.
 */
import { supabase, supabaseConfigured } from '@/shared/supabase/client';

export type MovementLedgerSource = 'warehouse' | 'outlet' | 'quarantine';

export interface MovementLedgerReportFilters {
  organizationId: string;
  /** Inclusive, ISO instant. */
  from?: string;
  /** Inclusive, ISO instant. */
  to?: string;
  ledgerSource?: MovementLedgerSource;
  movementType?: string;
  locationId?: string;
  /** Matched against scientific_name (ILIKE). */
  materialSearch?: string;
  /** Matched against actor_name (ILIKE). */
  actorSearch?: string;
  /** Defaults to 50; server clamps to [1, 200] regardless of what is sent. */
  limit?: number;
  offset?: number;
}

export interface MovementLedgerReportRow {
  ledgerSource: MovementLedgerSource;
  movementId: string;
  occurredAt: string;
  movementType: string;
  reasonCode: string;
  quantityBefore: number;
  quantityDelta: number;
  quantityAfter: number;
  scientificName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  batchNumber: string | null;
  locationId: string;
  locationName: string | null;
  locationNameAr: string | null;
  actorId: string | null;
  actorRole: string | null;
  actorName: string | null;
  referenceType: string | null;
  referenceId: string | null;
  sourceDocumentNumber: string | null;
  correlationId: string | null;
  causationId: string | null;
  /** true only for an outlet movement with a recorded beneficiary — the
   *  beneficiary itself is never included here; see getDispenseContext(). */
  hasDispenseContext: boolean;
}

export interface MovementLedgerReportResult {
  rows: MovementLedgerReportRow[];
  /** The full filtered set size, not just this page's row count. */
  totalCount: number;
}

interface RawRow {
  ledger_source: MovementLedgerSource;
  movement_id: string;
  occurred_at: string;
  movement_type: string;
  reason_code: string;
  quantity_before: number;
  quantity_delta: number;
  quantity_after: number;
  scientific_name: string | null;
  concentration: string | null;
  dosage_form: string | null;
  batch_number: string | null;
  location_id: string;
  location_name: string | null;
  location_name_ar: string | null;
  actor_id: string | null;
  actor_role: string | null;
  actor_name: string | null;
  reference_type: string | null;
  reference_id: string | null;
  source_document_number: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  has_dispense_context: boolean;
  total_count: number | string;
}

export async function getMovementLedgerReport(
  filters: MovementLedgerReportFilters,
): Promise<MovementLedgerReportResult> {
  if (!supabaseConfigured) return { rows: [], totalCount: 0 };

  const { data, error } = await supabase.rpc('phoenix_movement_ledger_report', {
    p_organization_id: filters.organizationId,
    p_from: filters.from ?? null,
    p_to: filters.to ?? null,
    p_ledger_source: filters.ledgerSource ?? null,
    p_movement_type: filters.movementType ?? null,
    p_location_id: filters.locationId ?? null,
    p_material_search: filters.materialSearch?.trim() || null,
    p_actor_search: filters.actorSearch?.trim() || null,
    p_limit: filters.limit ?? 50,
    p_offset: filters.offset ?? 0,
  });
  if (error) throw error;

  const raw = (data ?? []) as RawRow[];
  const rows: MovementLedgerReportRow[] = raw.map(r => ({
    ledgerSource: r.ledger_source,
    movementId: r.movement_id,
    occurredAt: r.occurred_at,
    movementType: r.movement_type,
    reasonCode: r.reason_code,
    quantityBefore: r.quantity_before,
    quantityDelta: r.quantity_delta,
    quantityAfter: r.quantity_after,
    scientificName: r.scientific_name,
    concentration: r.concentration,
    dosageForm: r.dosage_form,
    batchNumber: r.batch_number,
    locationId: r.location_id,
    locationName: r.location_name,
    locationNameAr: r.location_name_ar,
    actorId: r.actor_id,
    actorRole: r.actor_role,
    actorName: r.actor_name,
    referenceType: r.reference_type,
    referenceId: r.reference_id,
    sourceDocumentNumber: r.source_document_number,
    correlationId: r.correlation_id,
    causationId: r.causation_id,
    hasDispenseContext: r.has_dispense_context,
  }));

  return { rows, totalCount: raw.length > 0 ? Number(raw[0].total_count) : 0 };
}
