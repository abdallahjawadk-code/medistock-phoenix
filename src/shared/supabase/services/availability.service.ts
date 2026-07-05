import { supabase, supabaseConfigured } from '../client';
import type { AvailabilityRecord, AvailabilityCondition } from '../../lib/types';
import {
  computeEffectiveStatus,
  type RawAvailabilityCondition,
  type CanonicalStatus,
  type ExpiryBucket,
  type DerivedExpiryStatus,
  type EffectiveSeverity,
} from '../../lib/status/canonical';

/**
 * Non-breaking derived status fields appended to availability read rows
 * (EFFECTIVE-STATUS-DERIVATION-A). The raw stored `condition` field is always
 * preserved unchanged; these are additive, derived values for later UI/report
 * use. Snake_case to match the DB-shaped read payloads.
 */
export interface EffectiveAvailabilityFields {
  /** Copy of the raw stored condition (never modified). */
  raw_condition: string;
  /** Canonical vocabulary (scarce -> low_stock); falls back to 'available' for unknown. */
  normalized_condition: CanonicalStatus;
  /** Fine-grained expiry bucket from expiry_date, or null. */
  expiry_bucket: ExpiryBucket;
  /** normal | near_expiry | expired derived from expiry_date. */
  derived_expiry_status: DerivedExpiryStatus;
  /** Final status for later UI/report/alert use (raw condition is untouched). */
  effective_status: CanonicalStatus;
  /** Baseline severity for the effective status. */
  effective_severity: EffectiveSeverity;
}

/**
 * Append derived/effective status to a raw availability row WITHOUT mutating or
 * removing any existing field. `condition` stays the raw stored value; the new
 * fields are computed from condition + quantity + expiry_date via the canonical
 * helpers. Thresholds are inactive (low_stock/surplus stay manual). `today` is
 * injectable for deterministic tests.
 */
export function withEffectiveAvailabilityStatus<
  T extends { condition?: string | null; quantity?: number | null; expiry_date?: string | null },
>(row: T, today?: Date): T & EffectiveAvailabilityFields {
  const rawCondition = (row.condition ?? 'available') as RawAvailabilityCondition;
  const eff = computeEffectiveStatus({
    rawCondition,
    quantity: row.quantity ?? null,
    expiryDate: row.expiry_date ?? null,
    today,
  });
  return {
    ...row,
    raw_condition: (row.condition ?? rawCondition) as string,
    normalized_condition: eff.normalizedCondition,
    expiry_bucket: eff.expiryBucket,
    derived_expiry_status: eff.derivedExpiryStatus,
    effective_status: eff.effectiveStatus,
    effective_severity: eff.severity,
  };
}

export interface UpsertAvailabilityInput {
  distributionPointId: string;
  organizationId: string;
  scientificName: string;
  tradeName?: string;
  dosageForm?: string;
  concentrationValue?: string;
  price?: number;
  quantity: number;
  condition: AvailabilityCondition;
  batchNumber?: string;
  expiryDate?: string;
  notes?: string;
  /** Free-text "نوع التجهيز" (Supply type) — institution-private (migration 019). */
  supplyType?: string;
  /**
   * Official product/registration code (migration 049's national_code column,
   * migration 050's phoenix_upsert_availability p_national_code parameter).
   * A blank/undefined value is never sent to the RPC as an explicit clear —
   * see upsertAvailability() below, which omits p_national_code entirely in
   * that case so the RPC's own COALESCE-preserve behavior keeps any existing
   * value on the row untouched (AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A).
   */
  nationalCode?: string | null;
}

export async function getAvailabilityByPoint(
  pointId: string,
): Promise<(AvailabilityRecord & EffectiveAvailabilityFields)[]> {
  if (!supabaseConfigured) return [];

  // FRONTEND-LIVE-REMOVED-AT-FILTERS-A: this read is shared by both
  // EditorScreen (identity-matching an existing/removed row so
  // phoenix_upsert_availability can reactivate it) and InstitutionScreen's
  // PortAvailabilitySection (the live outlet material list) — it must NOT
  // filter removed_at itself, since EditorScreen needs removed rows visible
  // to find and reactivate them. removed_at is selected so each consumer can
  // decide for itself whether to display or hide a removed row.
  const { data, error } = await supabase
    .from('item_availability')
    .select(`
      id, quantity, condition, batch_number, national_code, expiry_date, notes, updated_at,
      port_name, supply_type, removed_at,
      scientific_name, trade_name, dosage_form, concentration, price,
      local_items ( id, local_code,
        central_items ( id, name, name_ar, unit, barcode )
      )
    `)
    .eq('distribution_point_id', pointId)
    .order('updated_at', { ascending: false });

  if (error) throw error;
  return ((data ?? []) as unknown as AvailabilityRecord[]).map(r => withEffectiveAvailabilityStatus(r));
}

/**
 * Persist an availability record via the phoenix_upsert_availability RPC (migration 030).
 * Replaces PostgREST .upsert() which cannot match the COALESCE partial index (migration 029),
 * causing Postgres 42P10. The RPC performs UPDATE-then-INSERT server-side.
 *
 * concentration and dosage_form are sent as '' (empty string) instead of null so that
 * COALESCE(column, '') in the partial index evaluates to '' for both absent and
 * explicitly-empty values.
 *
 * organization_id is derived server-side from distribution_point_id — never trusted from client.
 */
export async function upsertAvailability(input: UpsertAvailabilityInput): Promise<void> {
  if (!supabaseConfigured) return;
  if (!input.scientificName?.trim()) {
    throw new Error('upsertAvailability requires scientificName');
  }

  // AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A: p_national_code (migration 050)
  // is only ever included when a trimmed, non-empty value is supplied. A
  // blank/undefined nationalCode omits the key entirely rather than sending
  // an explicit null/empty string, so the RPC's own DEFAULT NULL +
  // COALESCE(v_national_code, ia.national_code) preserve-if-absent behavior
  // keeps any existing national_code on the row untouched — this call site
  // never intentionally clears it.
  const normalizedNationalCode = input.nationalCode?.trim();

  const { error } = await supabase.rpc('phoenix_upsert_availability', {
    p_distribution_point_id: input.distributionPointId,
    p_scientific_name:       input.scientificName.trim(),
    p_trade_name:            input.tradeName ?? null,
    p_dosage_form:           input.dosageForm ?? '',
    p_concentration:         input.concentrationValue ?? '',
    p_quantity:              input.quantity,
    p_condition:             input.condition,
    p_expiry_date:           input.expiryDate ?? null,
    p_batch_number:          input.batchNumber ?? null,
    p_notes:                 input.notes ?? null,
    p_supply_type:           input.supplyType ?? null,
    p_price:                 input.price ?? null,
    ...(normalizedNationalCode ? { p_national_code: normalizedNationalCode } : {}),
  });
  if (error) throw error;
}

/**
 * Classify a phoenix_upsert_availability RPC failure (42501 permission errors,
 * from migration 032's availability.create/availability.update matrix checks;
 * 23514 quantity_update_requires_movement from migration 035's hard guard)
 * into an i18n string key for the editor toast. Falls back to a generic
 * save-failure key for anything else (network errors, unexpected DB errors).
 */
export function classifyAvailabilitySaveError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  const message = (error as { message?: string } | null)?.message ?? '';
  if (message.includes('quantity_update_requires_movement')) return 'avail_qty_update_requires_movement';
  if (code === '42501' || /forbidden/.test(message)) {
    if (message.includes('create')) return 'avail_no_create_permission';
    if (message.includes('update')) return 'avail_no_update_permission';
    if (message.includes('cross_org')) return 'avail_cross_org_denied';
    return 'avail_no_edit_permission';
  }
  return 'load_error';
}

/**
 * AVAILABILITY-QUANTITY-MOVEMENT-RPC-A: the four supported quantity-movement
 * modes, matching migration 034's phoenix_apply_availability_movement RPC.
 */
export type AvailabilityMovementType = 'set_exact' | 'add' | 'subtract' | 'correction';

export interface ApplyAvailabilityMovementInput {
  itemAvailabilityId: string;
  movementType: AvailabilityMovementType;
  amount: number;
  reason?: string;
  notes?: string;
}

export interface ApplyAvailabilityMovementResult {
  ok: boolean;
  itemAvailabilityId: string;
  movementId: string;
  movementType: AvailabilityMovementType;
  quantityBefore: number;
  quantityDelta: number;
  quantityAfter: number;
}

/**
 * Apply an auditable quantity movement via the phoenix_apply_availability_movement
 * RPC (migration 034). This is the ONLY way to write a row into
 * item_availability_movements — the table itself grants no direct client
 * INSERT/UPDATE/DELETE privilege. No UI calls this yet (RPC-only phase).
 */
export async function applyAvailabilityMovement(
  input: ApplyAvailabilityMovementInput,
): Promise<ApplyAvailabilityMovementResult> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('phoenix_apply_availability_movement', {
    p_item_availability_id: input.itemAvailabilityId,
    p_movement_type:        input.movementType,
    p_amount:               input.amount,
    p_reason:               input.reason ?? null,
    p_notes:                input.notes ?? null,
  });
  if (error) throw error;

  const result = data as {
    ok: boolean; item_availability_id: string; movement_id: string; movement_type: string;
    quantity_before: number; quantity_delta: number; quantity_after: number;
  };
  return {
    ok: result.ok,
    itemAvailabilityId: result.item_availability_id,
    movementId: result.movement_id,
    movementType: result.movement_type as AvailabilityMovementType,
    quantityBefore: result.quantity_before,
    quantityDelta: result.quantity_delta,
    quantityAfter: result.quantity_after,
  };
}

/**
 * Classify a phoenix_apply_availability_movement RPC failure into an i18n
 * string key. Separate from classifyAvailabilitySaveError since the error
 * vocabulary differs (movement-specific codes vs. the editor's create/update
 * codes) — upsertAvailability's behavior/classification is unchanged.
 */
export function classifyAvailabilityMovementError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  const message = (error as { message?: string } | null)?.message ?? '';

  if (message.includes('availability_not_found')) return 'avail_movement_not_found';
  if (message.includes('quantity_cannot_go_negative')) return 'avail_movement_negative';
  if (message.includes('correction_reason_required')) return 'avail_movement_reason_required';

  if (code === '42501' || /forbidden/.test(message)) {
    if (message.includes('forbidden_cross_org')) return 'avail_cross_org_denied';
    if (message.includes('forbidden_availability_quantity_set')) return 'avail_movement_no_set_permission';
    if (message.includes('forbidden_availability_quantity_add')) return 'avail_movement_no_add_permission';
    if (message.includes('forbidden_availability_quantity_subtract')) return 'avail_movement_no_subtract_permission';
    if (message.includes('forbidden_availability_quantity_correct')) return 'avail_movement_no_correct_permission';
    return 'avail_no_edit_permission';
  }
  return 'load_error';
}

/**
 * AVAILABILITY-MOVEMENT-HISTORY-VIEW-A: one row of the read-only quantity
 * movement history for an item_availability row. Typed camelCase projection
 * of item_availability_movements (migration 033) — read access is enforced
 * server-side by the avail_mvmt_select_perm RLS policy (org scope +
 * availability.movements.view); this function does not and cannot bypass it.
 */
export interface AvailabilityMovementRecord {
  id: string;
  movementType: AvailabilityMovementType;
  quantityBefore: number;
  quantityDelta: number;
  quantityAfter: number;
  reason: string | null;
  notes: string | null;
  actorNameSnapshot: string | null;
  actorEmailSnapshot: string | null;
  actorRoleSnapshot: string | null;
  createdAt: string;
}

/**
 * Read-only history of quantity movements for one item_availability row,
 * newest first. This is a plain PostgREST SELECT (no RPC) — the table grants
 * SELECT only (no INSERT/UPDATE/DELETE to any client role, migration 033),
 * and avail_mvmt_select_perm RLS independently re-enforces org scope +
 * availability.movements.view for every caller. Limited to the most recent
 * 100 rows; this view does not need full unbounded history.
 */
export async function getAvailabilityMovementsByItem(
  itemAvailabilityId: string,
): Promise<AvailabilityMovementRecord[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('item_availability_movements')
    .select(`
      id, movement_type, quantity_before, quantity_delta, quantity_after,
      reason, notes, actor_name_snapshot, actor_email_snapshot, actor_role_snapshot,
      created_at
    `)
    .eq('item_availability_id', itemAvailabilityId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw error;

  return (data ?? []).map(r => ({
    id: r.id,
    movementType: r.movement_type as AvailabilityMovementType,
    quantityBefore: r.quantity_before,
    quantityDelta: r.quantity_delta,
    quantityAfter: r.quantity_after,
    reason: r.reason,
    notes: r.notes,
    actorNameSnapshot: r.actor_name_snapshot,
    actorEmailSnapshot: r.actor_email_snapshot,
    actorRoleSnapshot: r.actor_role_snapshot,
    createdAt: r.created_at,
  }));
}

/**
 * AVAILABILITY-MOVEMENT-REPORTS-PRINT-A: one row of the filterable, org-wide
 * quantity-movement report — extends AvailabilityMovementRecord with the
 * denormalized material identity + distribution point already stored on
 * each movement row (migration 033), so the report never needs a second
 * query per row.
 */
export interface AvailabilityMovementReportRecord extends AvailabilityMovementRecord {
  scientificName: string | null;
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  distributionPointId: string;
  distributionPointName: string | null;
  distributionPointNameAr: string | null;
}

export interface AvailabilityMovementsReportFilters {
  organizationId: string;
  /** Inclusive, 'YYYY-MM-DD'. */
  dateFrom?: string;
  /** Inclusive, 'YYYY-MM-DD'. */
  dateTo?: string;
  movementType?: AvailabilityMovementType;
  distributionPointId?: string;
  /** Matched against scientific_name / trade_name / concentration / dosage_form. */
  materialSearch?: string;
  /** Matched against actor_name_snapshot / actor_email_snapshot. */
  actorSearch?: string;
  /** Defaults to 200 — a reporting view, not an unbounded export. */
  limit?: number;
}

/**
 * BUGFIX-MOVEMENT-REPORT-NO-RESULTS-A: convert a plain 'YYYY-MM-DD' date
 * (as produced by an <input type="date">, which is always a LOCAL calendar
 * date with no timezone of its own) into the UTC instant for the start of
 * that day in the browser's local timezone. Naively appending a literal
 * 'Z' (e.g. `${date}T00:00:00.000Z`) was WRONG: it treats the date as UTC
 * midnight regardless of the user's actual timezone, which for a positive
 * UTC offset (e.g. Baghdad, UTC+3 — this project's primary user base)
 * shifts the boundary 3 hours late and silently EXCLUDES movements made
 * between local midnight and 3 AM on the "from" date. `new Date(str)` with
 * no offset suffix parses `str` as local time, so `.toISOString()` yields
 * the correct absolute UTC instant regardless of the caller's timezone.
 */
export function startOfLocalDayIso(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toISOString();
}

/** Same fix as startOfLocalDayIso, for the inclusive end of the local day. */
export function endOfLocalDayIso(dateStr: string): string {
  return new Date(`${dateStr}T23:59:59.999`).toISOString();
}

/**
 * BUGFIX-MOVEMENT-REPORT-NO-RESULTS-A: safely interpolate a free-text search
 * term into a PostgREST `.or(...)` ilike filter. PostgREST's filter grammar
 * treats comma, parentheses, and double-quote as RESERVED characters — all
 * of which are common in real material names (e.g. "Augmentin (Amoxicillin,
 * Clavulanate)"). Interpolating the raw term unescaped silently broke the
 * filter grammar (a stray `,`/`(`/`)` in the term — or in ANY of the OR'd
 * column values PostgREST tries to parse the whole expression against —
 * could truncate or corrupt the filter), causing the query to return zero
 * or wrong rows instead of erroring. Per PostgREST's documented escaping
 * rule, wrapping the value in double quotes (with any embedded backslash/
 * double-quote itself escaped) makes it safe regardless of content, while
 * leaving the `%` ilike wildcards intact.
 */
export function escapePostgrestIlikeValue(raw: string): string {
  const escaped = raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"%${escaped}%"`;
}

/**
 * Read-only, filterable quantity-movement report for one organization. This
 * is a plain PostgREST SELECT (no RPC) against item_availability_movements —
 * the table grants SELECT only (no INSERT/UPDATE/DELETE to any client role,
 * migration 033), and avail_mvmt_select_perm RLS independently re-enforces
 * org scope + availability.movements.view for every caller regardless of
 * which filters the client sends. All filters here are plain equality/range/
 * ilike predicates — never raw SQL, never an elevated/admin key.
 *
 * distribution_points is embedded with the explicit `!left` hint so a row
 * whose distribution point cannot be resolved/read for any reason never
 * silently drops the movement row itself from the report — it only nulls
 * out the point name/name_ar (defense-in-depth; movement visibility must
 * depend solely on avail_mvmt_select_perm, never on a secondary embed).
 */
export async function getAvailabilityMovementsReport(
  filters: AvailabilityMovementsReportFilters,
): Promise<AvailabilityMovementReportRecord[]> {
  if (!supabaseConfigured) return [];

  let query = supabase
    .from('item_availability_movements')
    .select(`
      id, movement_type, quantity_before, quantity_delta, quantity_after,
      reason, notes, actor_name_snapshot, actor_email_snapshot, actor_role_snapshot,
      created_at, scientific_name, trade_name, concentration, dosage_form,
      distribution_point_id,
      distribution_points!left ( name, name_ar )
    `)
    .eq('organization_id', filters.organizationId);

  if (filters.dateFrom) query = query.gte('created_at', startOfLocalDayIso(filters.dateFrom));
  if (filters.dateTo) query = query.lte('created_at', endOfLocalDayIso(filters.dateTo));
  if (filters.movementType) query = query.eq('movement_type', filters.movementType);
  if (filters.distributionPointId) query = query.eq('distribution_point_id', filters.distributionPointId);
  if (filters.materialSearch?.trim()) {
    const q = escapePostgrestIlikeValue(filters.materialSearch.trim());
    query = query.or(`scientific_name.ilike.${q},trade_name.ilike.${q},concentration.ilike.${q},dosage_form.ilike.${q}`);
  }
  if (filters.actorSearch?.trim()) {
    const q = escapePostgrestIlikeValue(filters.actorSearch.trim());
    query = query.or(`actor_name_snapshot.ilike.${q},actor_email_snapshot.ilike.${q}`);
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? 200);

  if (error) throw error;

  return (data ?? []).map(r => {
    const dp = (Array.isArray(r.distribution_points) ? r.distribution_points[0] : r.distribution_points) as
      { name: string | null; name_ar: string | null } | null;
    return {
      id: r.id,
      movementType: r.movement_type as AvailabilityMovementType,
      quantityBefore: r.quantity_before,
      quantityDelta: r.quantity_delta,
      quantityAfter: r.quantity_after,
      reason: r.reason,
      notes: r.notes,
      actorNameSnapshot: r.actor_name_snapshot,
      actorEmailSnapshot: r.actor_email_snapshot,
      actorRoleSnapshot: r.actor_role_snapshot,
      createdAt: r.created_at,
      scientificName: r.scientific_name,
      tradeName: r.trade_name,
      concentration: r.concentration,
      dosageForm: r.dosage_form,
      distributionPointId: r.distribution_point_id,
      distributionPointName: dp?.name ?? null,
      distributionPointNameAr: dp?.name_ar ?? null,
    };
  });
}

export async function getLowStockItems(orgId: string) {
  if (!supabaseConfigured) return [];

  // FRONTEND-LIVE-REMOVED-AT-FILTERS-A: this is a live shortage report (feeds
  // ReportsScreen's low-stock/missing tabs) — a removed row is forced to
  // condition='missing' but is not a genuine shortage that needs a resupply,
  // so it must not appear here. Unlike getAvailabilityByPoint, nothing
  // downstream of this function needs to see removed rows.
  const { data, error } = await supabase
    .from('item_availability')
    .select(`
      id, quantity, condition, expiry_date,
      distribution_points ( id, name, name_ar ),
      local_items ( id, central_items ( name, name_ar, unit ) )
    `)
    .eq('organization_id', orgId)
    .in('condition', ['low_stock', 'missing', 'near_expiry', 'expired'])
    .is('removed_at', null)
    .order('condition');

  if (error) throw error;
  return (data ?? []).map(r => withEffectiveAvailabilityStatus(r as {
    condition?: string | null; quantity?: number | null; expiry_date?: string | null;
  }));
}

export async function getAvailabilityByOrg(orgId: string) {
  if (!supabaseConfigured) return [];

  // Added actor_name_snapshot (a plain display-name text column, migration
  // 013/014 — never the raw last_updated_by auth uuid) and removed_at
  // (migration 053's intentional-removal marker) to this already-existing
  // select. Both are already-present, non-sensitive columns on
  // item_availability; no new query source, no schema change. Status
  // Center itself remains intentionally unfiltered by removed_at
  // (operations/reactivation context) — only the Excel export built from
  // these rows excludes removed_at rows.
  const { data, error } = await supabase
    .from('item_availability')
    .select(`
      id, scientific_name, trade_name, dosage_form, concentration, price,
      quantity, condition, batch_number, national_code, expiry_date, notes, supply_type, updated_at,
      actor_name_snapshot, removed_at,
      distribution_points ( id, name, name_ar, status )
    `)
    .eq('organization_id', orgId)
    .order('updated_at', { ascending: false });

  if (error) throw error;
  return (data ?? []).map(r => withEffectiveAvailabilityStatus(r as {
    condition?: string | null; quantity?: number | null; expiry_date?: string | null;
  }));
}
