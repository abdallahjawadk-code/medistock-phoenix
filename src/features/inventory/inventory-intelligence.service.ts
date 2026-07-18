import { supabase, supabaseConfigured } from '@/shared/supabase/client';

/**
 * INVENTORY-INTELLIGENCE-FRONTEND-A
 *
 * Read/write wrapper around migration 072's inventory-intelligence layer
 * (inventory_signal_thresholds, inventory_alerts, inventory_transfer_suggestions
 * + their SECURITY DEFINER RPCs). 072 is a READ-ONLY intelligence + advisory
 * layer:
 *
 *   • Reads are plain RLS-protected table SELECTs — the three tables grant
 *     SELECT to `authenticated` and nothing else, and their RLS policies
 *     restrict every row to the organizations/scopes the caller may see
 *     (phoenix_can_read_inventory_signal). The frontend therefore never has to
 *     filter for authorization itself; it only narrows to the active org for
 *     the super_admin multi-org view.
 *   • Writes go exclusively through the 072 RPCs (the tables REVOKE
 *     INSERT/UPDATE/DELETE from authenticated). Each RPC re-checks the caller's
 *     SCOPED permission server-side, so the UI's permission gates are a
 *     convenience only — never the security boundary.
 *
 * ACCEPTANCE IS DISABLED (recommendation-only, migration 072 Round 5/6). There
 * is DELIBERATELY no accept wrapper in this file: phoenix_accept_inventory_
 * transfer_suggestion only raises `acceptance_disabled_recommendation_only`,
 * a structural CHECK (inventory_suggestions_no_accept_chk) makes the accepted
 * status unreachable, and the reserved accept columns are pinned NULL.
 * A suggestion is a RECOMMENDATION, never a reservation — no Accept, no
 * auto-execution, no stock movement. Only REJECT is offered, and only where the
 * reject RPC + inventory.act_on_suggestions permission prove it is allowed.
 */

// ── Vocabulary (verbatim from migration 072 CHECK constraints) ───────────────
export type InventoryScopeKind = 'warehouse' | 'outlet';
export type InventorySignalType = 'missing' | 'low_stock' | 'surplus' | 'near_expiry' | 'expired';
export type InventorySeverity = 'high' | 'medium' | 'low';
export type InventoryExpiryTier = 'expired' | 'critical_3m' | 'warning_6m' | 'watch_9m';
export type InventoryAlertStatus = 'open' | 'acknowledged' | 'in_progress' | 'resolved' | 'dismissed';
export type InventorySuggestionStatus = 'open' | 'accepted' | 'rejected' | 'superseded' | 'expired';
export type InventoryRouteKind = 'warehouse_to_outlet' | 'outlet_to_warehouse' | 'central_to_institution';

/** Result envelope for the mutation RPCs. RPC failures surface as { ok:false, error }. */
export interface InventoryRpcResult<T = Record<string, unknown>> {
  ok: boolean;
  data?: T;
  /** Raw server error code/message when ok is false (e.g. 'not_authorized_inventory_manage'). */
  error?: string;
}

export interface InventoryThreshold {
  id: string;
  organizationId: string;
  scopeKind: InventoryScopeKind;
  /** NULL = org-wide default values (never an expectation). */
  scopeId: string | null;
  scientificName: string;
  /** NULL = wildcard for the material at the scope. */
  nationalCode: string | null;
  reorderPoint: number | null;
  targetMax: number | null;
  /** Effective near-expiry window; NULL = the 270-day default. */
  nearExpiryDays: number | null;
  isActive: boolean;
  updatedAt: string;
}

export interface InventoryAlert {
  id: string;
  organizationId: string;
  scopeKind: InventoryScopeKind;
  scopeId: string;
  signalType: InventorySignalType;
  severity: InventorySeverity;
  expiryTier: InventoryExpiryTier | null;
  scientificName: string;
  nationalCode: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
  observedOnHand: number | null;
  observedAvailable: number | null;
  thresholdReorderPoint: number | null;
  thresholdTargetMax: number | null;
  nearExpiryDays: number | null;
  daysToExpiry: number | null;
  status: InventoryAlertStatus;
  reason: string | null;
  occurrenceCount: number;
  lastObservedAt: string;
  updatedAt: string;
}

export interface InventoryTransferSuggestion {
  id: string;
  sourceOrganizationId: string;
  targetOrganizationId: string;
  scientificName: string;
  nationalCode: string | null;
  sourceScopeKind: InventoryScopeKind;
  sourceScopeId: string;
  targetScopeKind: InventoryScopeKind;
  targetScopeId: string;
  routeKind: InventoryRouteKind;
  suggestedQuantity: number;
  fefoBatchNumber: string | null;
  fefoExpiryDate: string | null;
  rationale: string | null;
  status: InventorySuggestionStatus;
  /** True when source and target organizations differ (advisory cross-org). */
  crossOrg: boolean;
  /**
   * The instant this suggestion's conservation was last PROVEN under the §9
   * guard locks. An OPEN suggestion is a recommendation, not a reservation — a
   * later real stock movement can make it stale, so any actor MUST re-validate
   * against live stock before acting. The UI uses this to surface staleness.
   */
  lastValidatedAt: string;
  lastSuggestedAt: string;
}

// ── Row shapes (snake_case, as returned by PostgREST) ────────────────────────
interface ThresholdRow {
  id: string; organization_id: string; scope_kind: InventoryScopeKind; scope_id: string | null;
  scientific_name: string; national_code: string | null;
  reorder_point: number | null; target_max: number | null; near_expiry_days: number | null;
  is_active: boolean; updated_at: string;
}
interface AlertRow {
  id: string; organization_id: string; scope_kind: InventoryScopeKind; scope_id: string;
  signal_type: InventorySignalType; severity: InventorySeverity; expiry_tier: InventoryExpiryTier | null;
  scientific_name: string; national_code: string | null; batch_number: string | null; expiry_date: string | null;
  observed_on_hand: number | null; observed_available: number | null;
  threshold_reorder_point: number | null; threshold_target_max: number | null;
  near_expiry_days: number | null; days_to_expiry: number | null;
  status: InventoryAlertStatus; reason: string | null; occurrence_count: number;
  last_observed_at: string; updated_at: string;
}
interface SuggestionRow {
  id: string; source_organization_id: string; target_organization_id: string;
  scientific_name: string; national_code: string | null;
  source_scope_kind: InventoryScopeKind; source_scope_id: string;
  target_scope_kind: InventoryScopeKind; target_scope_id: string;
  route_kind: InventoryRouteKind; suggested_quantity: number;
  fefo_batch_number: string | null; fefo_expiry_date: string | null; rationale: string | null;
  status: InventorySuggestionStatus; last_validated_at: string; last_suggested_at: string;
}

function mapThreshold(r: ThresholdRow): InventoryThreshold {
  return {
    id: r.id, organizationId: r.organization_id, scopeKind: r.scope_kind, scopeId: r.scope_id,
    scientificName: r.scientific_name, nationalCode: r.national_code,
    reorderPoint: r.reorder_point, targetMax: r.target_max, nearExpiryDays: r.near_expiry_days,
    isActive: r.is_active, updatedAt: r.updated_at,
  };
}
function mapAlert(r: AlertRow): InventoryAlert {
  return {
    id: r.id, organizationId: r.organization_id, scopeKind: r.scope_kind, scopeId: r.scope_id,
    signalType: r.signal_type, severity: r.severity, expiryTier: r.expiry_tier,
    scientificName: r.scientific_name, nationalCode: r.national_code,
    batchNumber: r.batch_number, expiryDate: r.expiry_date,
    observedOnHand: r.observed_on_hand, observedAvailable: r.observed_available,
    thresholdReorderPoint: r.threshold_reorder_point, thresholdTargetMax: r.threshold_target_max,
    nearExpiryDays: r.near_expiry_days, daysToExpiry: r.days_to_expiry,
    status: r.status, reason: r.reason, occurrenceCount: r.occurrence_count,
    lastObservedAt: r.last_observed_at, updatedAt: r.updated_at,
  };
}
function mapSuggestion(r: SuggestionRow): InventoryTransferSuggestion {
  return {
    id: r.id, sourceOrganizationId: r.source_organization_id, targetOrganizationId: r.target_organization_id,
    scientificName: r.scientific_name, nationalCode: r.national_code,
    sourceScopeKind: r.source_scope_kind, sourceScopeId: r.source_scope_id,
    targetScopeKind: r.target_scope_kind, targetScopeId: r.target_scope_id,
    routeKind: r.route_kind, suggestedQuantity: r.suggested_quantity,
    fefoBatchNumber: r.fefo_batch_number, fefoExpiryDate: r.fefo_expiry_date, rationale: r.rationale,
    status: r.status, crossOrg: r.source_organization_id !== r.target_organization_id,
    lastValidatedAt: r.last_validated_at, lastSuggestedAt: r.last_suggested_at,
  };
}

// ── READS (RLS-protected table SELECTs; no authorization done client-side) ───

/** Active alerts (default open/acknowledged/in_progress) the caller may see. */
export async function getInventoryAlerts(
  orgId?: string | null,
  opts: { statuses?: InventoryAlertStatus[]; limit?: number } = {},
): Promise<InventoryAlert[]> {
  if (!supabaseConfigured) return [];
  const statuses = opts.statuses ?? ['open', 'acknowledged', 'in_progress'];
  let q = supabase
    .from('inventory_alerts')
    .select('id,organization_id,scope_kind,scope_id,signal_type,severity,expiry_tier,scientific_name,national_code,batch_number,expiry_date,observed_on_hand,observed_available,threshold_reorder_point,threshold_target_max,near_expiry_days,days_to_expiry,status,reason,occurrence_count,last_observed_at,updated_at')
    .in('status', statuses)
    .order('severity', { ascending: true })
    .order('last_observed_at', { ascending: false })
    .limit(opts.limit ?? 200);
  if (orgId) q = q.eq('organization_id', orgId);
  const { data, error } = await q;
  if (error) throw error;
  return (data as AlertRow[] | null ?? []).map(mapAlert);
}

/** Configured thresholds the caller may see. */
export async function getInventoryThresholds(orgId?: string | null): Promise<InventoryThreshold[]> {
  if (!supabaseConfigured) return [];
  let q = supabase
    .from('inventory_signal_thresholds')
    .select('id,organization_id,scope_kind,scope_id,scientific_name,national_code,reorder_point,target_max,near_expiry_days,is_active,updated_at')
    .order('scientific_name', { ascending: true })
    .limit(500);
  if (orgId) q = q.eq('organization_id', orgId);
  const { data, error } = await q;
  if (error) throw error;
  return (data as ThresholdRow[] | null ?? []).map(mapThreshold);
}

/** Open transfer suggestions (recommendations) the caller may see. */
export async function getInventoryTransferSuggestions(
  orgId?: string | null,
  opts: { statuses?: InventorySuggestionStatus[]; limit?: number } = {},
): Promise<InventoryTransferSuggestion[]> {
  if (!supabaseConfigured) return [];
  const statuses = opts.statuses ?? ['open'];
  let q = supabase
    .from('inventory_transfer_suggestions')
    .select('id,source_organization_id,target_organization_id,scientific_name,national_code,source_scope_kind,source_scope_id,target_scope_kind,target_scope_id,route_kind,suggested_quantity,fefo_batch_number,fefo_expiry_date,rationale,status,last_validated_at,last_suggested_at')
    .in('status', statuses)
    .order('last_suggested_at', { ascending: false })
    .limit(opts.limit ?? 200);
  if (orgId) q = q.or(`source_organization_id.eq.${orgId},target_organization_id.eq.${orgId}`);
  const { data, error } = await q;
  if (error) throw error;
  return (data as SuggestionRow[] | null ?? []).map(mapSuggestion);
}

// ── WRITES (RPC only; server re-checks scoped permission + raises on denial) ──

async function callRpc<T = Record<string, unknown>>(
  fn: string, args: Record<string, unknown>,
): Promise<InventoryRpcResult<T>> {
  if (!supabaseConfigured) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data ?? {}) as T };
}

/** Recompute alerts for the whole org, or one scope (needs inventory.recompute). */
export function recomputeInventoryAlerts(
  orgId: string, scopeKind?: InventoryScopeKind, scopeId?: string,
): Promise<InventoryRpcResult> {
  return callRpc('phoenix_recompute_inventory_alerts', {
    p_organization_id: orgId,
    p_scope_kind: scopeKind ?? null,
    p_scope_id: scopeId ?? null,
  });
}

/** Acknowledge an open alert (needs inventory.manage_alerts on the alert's scope). */
export function acknowledgeInventoryAlert(alertId: string): Promise<InventoryRpcResult> {
  return callRpc('phoenix_acknowledge_inventory_alert', { p_alert_id: alertId });
}

/** Resolve an alert with a required reason (needs inventory.manage_alerts). */
export function resolveInventoryAlert(alertId: string, reason: string): Promise<InventoryRpcResult> {
  return callRpc('phoenix_resolve_inventory_alert', { p_alert_id: alertId, p_reason: reason });
}

/** Dismiss an alert with a required reason (needs inventory.manage_alerts). */
export function dismissInventoryAlert(alertId: string, reason: string): Promise<InventoryRpcResult> {
  return callRpc('phoenix_dismiss_inventory_alert', { p_alert_id: alertId, p_reason: reason });
}

export interface UpsertThresholdInput {
  organizationId: string;
  scopeKind: InventoryScopeKind;
  /** NULL = org-wide default row. */
  scopeId: string | null;
  scientificName: string;
  nationalCode?: string | null;
  reorderPoint?: number | null;
  targetMax?: number | null;
  nearExpiryDays?: number | null;
  isActive?: boolean;
}

/** Create/update a threshold (needs inventory.manage_thresholds on the scope). */
export function upsertInventoryThreshold(input: UpsertThresholdInput): Promise<InventoryRpcResult> {
  return callRpc('phoenix_upsert_inventory_threshold', {
    p_organization_id: input.organizationId,
    p_scope_kind: input.scopeKind,
    p_scope_id: input.scopeId,
    p_scientific_name: input.scientificName,
    p_national_code: input.nationalCode ?? null,
    p_reorder_point: input.reorderPoint ?? null,
    p_target_max: input.targetMax ?? null,
    p_near_expiry_days: input.nearExpiryDays ?? null,
    p_is_active: input.isActive ?? true,
  });
}

/** Regenerate intra-org transfer recommendations (needs inventory.suggest_transfers). */
export function suggestInventoryTransfers(orgId: string): Promise<InventoryRpcResult> {
  return callRpc('phoenix_suggest_inventory_transfers', { p_organization_id: orgId });
}

/**
 * Reject a transfer recommendation with a required reason (needs
 * inventory.act_on_suggestions on one of its endpoints). This is the ONLY
 * lifecycle action offered on a suggestion — there is no accept counterpart
 * because acceptance is disabled server-side (recommendation-only).
 */
export function rejectInventoryTransferSuggestion(
  suggestionId: string, reason: string,
): Promise<InventoryRpcResult> {
  return callRpc('phoenix_reject_inventory_transfer_suggestion', {
    p_suggestion_id: suggestionId, p_reason: reason,
  });
}
