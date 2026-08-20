import { supabase, supabaseConfigured } from '@/shared/supabase/client';

/**
 * ALERT-LIFECYCLE-RPC-A
 *
 * Wrapper around the inter-org alert lifecycle RPCs. All reads/writes go
 * through supabase.rpc only — there is no direct table access anywhere in
 * this file (inter_org_alert_states/inter_org_alert_events have no
 * client-writable grants at all, and inter_org_alert_events has no direct
 * SELECT grant either, per migration 038).
 *
 * ALERT-CQRS-BOUNDARY-190 (G4.1)
 *
 * This module is now split along the command/query boundary migration 190
 * draws in the database, and the split is the whole point:
 *
 *   COMMANDS (may write server-side)
 *     refreshInterOrgAlertLifecycle  -> phoenix_refresh_inter_org_alert_lifecycle
 *     updateInterOrgAlertState       -> phoenix_update_inter_org_alert_state
 *     reopenInterOrgAlert            -> phoenix_reopen_inter_org_alert
 *
 *   QUERIES (pure — reading one can never write)
 *     queryLiveInterOrgAlertsPage    -> phoenix_query_live_inter_org_alerts_with_state_page
 *     queryLiveInterOrgAlertSummary  -> phoenix_query_live_inter_org_alert_summary
 *     getInterOrgAlertEvents         -> phoenix_get_inter_org_alert_events
 *
 * Before 190 the only way to read this feed was migration 039's
 * with_state hybrid (or its 148 paged wrapper), which upserts
 * inter_org_alert_states and emits an 'opened' lifecycle event as a side
 * effect of being read. Rendering the Dashboard therefore wrote to the
 * database. Those hybrid RPCs still exist server-side for the
 * currently-deployed application, but this module no longer calls either of
 * them: a screen that wants lifecycle state refreshed must now ask for it
 * explicitly, and every ordinary read is pure.
 */

export type LiveAlertType = 'surplus_to_shortage' | 'near_expiry_to_shortage';
export type LiveAlertSeverity = 'high' | 'medium';
export type AlertLifecycleStatus = 'open' | 'acknowledged' | 'in_progress' | 'resolved' | 'dismissed';

/** One live inter-institution alert merged with its persisted lifecycle state. */
export interface LiveInterInstitutionAlertWithState {
  alertType: LiveAlertType;
  severity: LiveAlertSeverity;
  sourceItemAvailabilityId: string;
  targetItemAvailabilityId: string;
  sourceOrganizationId: string;
  sourceOrganizationName: string | null;
  sourceOrganizationNameAr: string | null;
  sourceDistributionPointId: string | null;
  sourceDistributionPointName: string | null;
  sourceDistributionPointNameAr: string | null;
  targetOrganizationId: string;
  targetOrganizationName: string | null;
  targetOrganizationNameAr: string | null;
  targetDistributionPointId: string | null;
  targetDistributionPointName: string | null;
  targetDistributionPointNameAr: string | null;
  scientificName: string;
  concentration: string | null;
  dosageForm: string | null;
  /** Display/search only — never used to match two rows as the same material. */
  sourceTradeName: string | null;
  /** Display/search only — never used to match two rows as the same material. */
  targetTradeName: string | null;
  sourceStatus: string;
  targetStatus: string;
  sourceQuantity: number;
  targetQuantity: number;
  sourceExpiryDate: string | null;
  /**
   * ALERT-CARDS-EXPIRY-RISK-BADGES-UI-A: mirrors migration 048's
   * source_expiry_risk_tier/source_expiry_days_remaining jsonb fields,
   * computed server-side from the same source_expiry_date already carried
   * above. Optional/nullable so this stays backward-compatible with any
   * cached/pre-048 payload shape — absent or null must never crash the UI.
   */
  sourceExpiryRiskTier?: 'unknown' | 'expired' | 'critical_3m' | 'warning_6m' | 'watch_9m' | 'normal' | string | null;
  sourceExpiryDaysRemaining?: number | null;
  /**
   * UX-ALERTS-LIVE-WHATSAPP-CONTACT-WIRING-A: the source/target organization's
   * official WhatsApp contact phone, resolved SERVER-SIDE by migration 047
   * (organization_status_contacts, is_active + prefers is_primary, bypasses
   * that table's RLS via SECURITY DEFINER) — never fetched by a separate
   * client-side query. Null/absent means no active contact is configured;
   * never substituted with a fake/placeholder number.
   */
  sourceContactPhone?: string | null;
  targetContactPhone?: string | null;
  computedAt: string;
  /** Deterministic lifecycle key: sourceItemAvailabilityId:targetItemAvailabilityId:alertType. */
  alertKey: string;
  lifecycleStatus: AlertLifecycleStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  inProgressAt: string | null;
  inProgressBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  dismissedAt: string | null;
  dismissedBy: string | null;
  lifecycleReason: string | null;
  lifecycleNotes: string | null;
}

export interface LiveInterInstitutionAlertsWithStateResult {
  ok: boolean;
  alerts: LiveInterInstitutionAlertWithState[];
  computedAt: string | null;
  /** Populated only when ok is false (e.g. 'FORBIDDEN', 'NOT_AUTHENTICATED'). */
  error?: string;
}

/**
 * ALERT-CQRS-BOUNDARY-190: the refresh COMMAND's result. Deliberately carries
 * NO alert rows — a command that also answered the read would keep inviting
 * callers to read through the writer, which is the habit 190 retires.
 */
export interface RefreshInterOrgAlertLifecycleResult {
  ok: boolean;
  /** How many live alerts had their lifecycle state created or refreshed. */
  refreshedCount?: number;
  computedAt?: string | null;
  /** Populated only when ok is false (e.g. 'FORBIDDEN', 'NOT_AUTHENTICATED'). */
  error?: string;
}

/**
 * ALERT-CQRS-BOUNDARY-190: server-computed Dashboard counters. Every number is
 * derived server-side from the same pure projection the alerts page reads, so
 * the widget and the screen it links to can never disagree.
 */
export interface LiveInterOrgAlertSummaryResult {
  ok: boolean;
  /** Active (open/acknowledged/in_progress) alerts in the summary window. */
  total?: number;
  high?: number;
  surplusToShortage?: number;
  nearExpiryToShortage?: number;
  computedAt?: string | null;
  /** Populated only when ok is false (e.g. 'FORBIDDEN', 'NOT_AUTHENTICATED'). */
  error?: string;
}

export interface UpdateAlertStateResult {
  ok: boolean;
  alertKey?: string;
  fromStatus?: string;
  toStatus?: string;
  error?: string;
}

export interface AlertLifecycleEvent {
  eventType: string;
  actorNameSnapshot: string | null;
  actorEmailSnapshot: string | null;
  actorRoleSnapshot: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  notes: string | null;
  createdAt: string;
}

export interface GetAlertEventsResult {
  ok: boolean;
  alertKey?: string;
  events: AlertLifecycleEvent[];
  error?: string;
}

interface RawLiveAlertWithStateRow {
  alert_type: LiveAlertType;
  severity: LiveAlertSeverity;
  source_item_availability_id: string;
  target_item_availability_id: string;
  source_organization_id: string;
  source_organization_name: string | null;
  source_organization_name_ar: string | null;
  source_distribution_point_id: string | null;
  source_distribution_point_name: string | null;
  source_distribution_point_name_ar: string | null;
  target_organization_id: string;
  target_organization_name: string | null;
  target_organization_name_ar: string | null;
  target_distribution_point_id: string | null;
  target_distribution_point_name: string | null;
  target_distribution_point_name_ar: string | null;
  scientific_name: string;
  concentration: string | null;
  dosage_form: string | null;
  source_trade_name: string | null;
  target_trade_name: string | null;
  source_status: string;
  target_status: string;
  source_quantity: number;
  target_quantity: number;
  source_expiry_date: string | null;
  source_expiry_risk_tier?: string | null;
  source_expiry_days_remaining?: number | null;
  source_contact_phone?: string | null;
  target_contact_phone?: string | null;
  computed_at: string;
  alert_key: string;
  lifecycle_status: AlertLifecycleStatus;
  first_seen_at: string;
  last_seen_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  in_progress_at: string | null;
  in_progress_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  dismissed_at: string | null;
  dismissed_by: string | null;
  lifecycle_reason: string | null;
  lifecycle_notes: string | null;
}

interface RawAlertEventRow {
  event_type: string;
  actor_name_snapshot: string | null;
  actor_email_snapshot: string | null;
  actor_role_snapshot: string | null;
  from_status: string | null;
  to_status: string | null;
  reason: string | null;
  notes: string | null;
  created_at: string;
}

function mapRow(r: RawLiveAlertWithStateRow): LiveInterInstitutionAlertWithState {
  return {
    alertType: r.alert_type,
    severity: r.severity,
    sourceItemAvailabilityId: r.source_item_availability_id,
    targetItemAvailabilityId: r.target_item_availability_id,
    sourceOrganizationId: r.source_organization_id,
    sourceOrganizationName: r.source_organization_name,
    sourceOrganizationNameAr: r.source_organization_name_ar,
    sourceDistributionPointId: r.source_distribution_point_id,
    sourceDistributionPointName: r.source_distribution_point_name,
    sourceDistributionPointNameAr: r.source_distribution_point_name_ar,
    targetOrganizationId: r.target_organization_id,
    targetOrganizationName: r.target_organization_name,
    targetOrganizationNameAr: r.target_organization_name_ar,
    targetDistributionPointId: r.target_distribution_point_id,
    targetDistributionPointName: r.target_distribution_point_name,
    targetDistributionPointNameAr: r.target_distribution_point_name_ar,
    scientificName: r.scientific_name,
    concentration: r.concentration,
    dosageForm: r.dosage_form,
    sourceTradeName: r.source_trade_name,
    targetTradeName: r.target_trade_name,
    sourceStatus: r.source_status,
    targetStatus: r.target_status,
    sourceQuantity: r.source_quantity,
    targetQuantity: r.target_quantity,
    sourceExpiryDate: r.source_expiry_date,
    sourceExpiryRiskTier: r.source_expiry_risk_tier ?? null,
    sourceExpiryDaysRemaining: r.source_expiry_days_remaining ?? null,
    sourceContactPhone: r.source_contact_phone ?? null,
    targetContactPhone: r.target_contact_phone ?? null,
    computedAt: r.computed_at,
    alertKey: r.alert_key,
    lifecycleStatus: r.lifecycle_status,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    acknowledgedAt: r.acknowledged_at,
    acknowledgedBy: r.acknowledged_by,
    inProgressAt: r.in_progress_at,
    inProgressBy: r.in_progress_by,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    dismissedAt: r.dismissed_at,
    dismissedBy: r.dismissed_by,
    lifecycleReason: r.lifecycle_reason,
    lifecycleNotes: r.lifecycle_notes,
  };
}

function mapEvent(r: RawAlertEventRow): AlertLifecycleEvent {
  return {
    eventType: r.event_type,
    actorNameSnapshot: r.actor_name_snapshot,
    actorEmailSnapshot: r.actor_email_snapshot,
    actorRoleSnapshot: r.actor_role_snapshot,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    reason: r.reason,
    notes: r.notes,
    createdAt: r.created_at,
  };
}

/**
 * ALERT-CQRS-BOUNDARY-190 — the COMMAND.
 *
 * Explicitly refresh/synchronize lifecycle state for the currently live
 * inter-organization alerts (migration 190's
 * phoenix_refresh_inter_org_alert_lifecycle). This is the only function in
 * this module whose PURPOSE is to cause alert lifecycle writes, and the only
 * one a screen may call for that purpose.
 *
 * Server-side it delegates to migration 039's with_state hybrid, so the
 * lifecycle upsert and the 'opened' event keep exactly one implementation —
 * the already-reviewed one — and then discards the read payload. It returns
 * no alert rows on purpose: rows come from the pure queries below, so a
 * caller cannot drift back into reading through the writer.
 */
export async function refreshInterOrgAlertLifecycle(
  limit = 500,
): Promise<RefreshInterOrgAlertLifecycleResult> {
  if (!supabaseConfigured) {
    return { ok: false, error: 'not_configured' };
  }

  const { data, error } = await supabase.rpc('phoenix_refresh_inter_org_alert_lifecycle', {
    p_limit: limit,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  const result = data as { ok: boolean; error?: string; refreshed_count?: number; computed_at?: string };

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return {
    ok: true,
    refreshedCount: result.refreshed_count ?? 0,
    computedAt: result.computed_at ?? null,
  };
}

export interface LiveInterInstitutionAlertsPageResult extends LiveInterInstitutionAlertsWithStateResult {
  totalCount: number;
  limit: number;
  offset: number;
}

/**
 * ALERT-CQRS-BOUNDARY-190 — the PURE paged QUERY.
 *
 * Real server-side pagination over the canonical alert set, merged with
 * persisted lifecycle state (migration 190's
 * phoenix_query_live_inter_org_alerts_with_state_page). Payload-compatible
 * with the 148 paged wrapper it replaces — same envelope, same 500-row
 * universe, same permanently-non-executable stamp — but it writes NOTHING:
 * no lifecycle upsert, no lifecycle event. Turning a page can therefore never
 * mutate the database.
 *
 * Every alert this returns is permanently non-executable — this screen's own
 * domain (peer-institution discovery) has no execution corridor; see the
 * screen's disclaimer copy.
 */
export async function queryLiveInterOrgAlertsPage(
  limit = 50, offset = 0,
): Promise<LiveInterInstitutionAlertsPageResult> {
  if (!supabaseConfigured) {
    return { ok: false, alerts: [], computedAt: null, totalCount: 0, limit, offset, error: 'not_configured' };
  }

  const { data, error } = await supabase.rpc('phoenix_query_live_inter_org_alerts_with_state_page', {
    p_limit: limit, p_offset: offset,
  });

  if (error) {
    return { ok: false, alerts: [], computedAt: null, totalCount: 0, limit, offset, error: error.message };
  }

  const result = data as {
    ok: boolean; error?: string; alerts?: RawLiveAlertWithStateRow[]; computed_at?: string;
    total_count?: number; limit?: number; offset?: number;
  };

  if (!result.ok) {
    return { ok: false, alerts: [], computedAt: null, totalCount: 0, limit, offset, error: result.error };
  }

  const alerts = (result.alerts ?? []).map(mapRow);
  return {
    ok: true, alerts, computedAt: result.computed_at ?? null,
    totalCount: result.total_count ?? alerts.length,
    limit: result.limit ?? limit, offset: result.offset ?? offset,
  };
}

/**
 * ALERT-CQRS-BOUNDARY-190 — the PURE summary QUERY.
 *
 * Server-computed counters for the Dashboard widget (migration 190's
 * phoenix_query_live_inter_org_alert_summary). The Dashboard used to fetch
 * 200 whole alert objects through the write-capable hybrid and reduce them in
 * the browser; it now asks for four numbers and writes nothing at all.
 *
 * Counting semantics are preserved exactly: only ACTIVE lifecycle states
 * (open / acknowledged / in_progress) are counted, within the same 200-row
 * window the hybrid call already used.
 */
export async function queryLiveInterOrgAlertSummary(
  limit = 200,
): Promise<LiveInterOrgAlertSummaryResult> {
  if (!supabaseConfigured) {
    return { ok: false, error: 'not_configured' };
  }

  const { data, error } = await supabase.rpc('phoenix_query_live_inter_org_alert_summary', {
    p_limit: limit,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  const result = data as {
    ok: boolean; error?: string; total?: number; high?: number;
    surplus_to_shortage?: number; near_expiry_to_shortage?: number; computed_at?: string;
  };

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return {
    ok: true,
    total: result.total ?? 0,
    high: result.high ?? 0,
    surplusToShortage: result.surplus_to_shortage ?? 0,
    nearExpiryToShortage: result.near_expiry_to_shortage ?? 0,
    computedAt: result.computed_at ?? null,
  };
}

/**
 * Transition an alert's lifecycle status (migration 039's
 * phoenix_update_inter_org_alert_state RPC). Throws are not used — RPC
 * errors (raised as Postgres exceptions server-side) surface via the
 * Supabase client's error object and are returned as { ok: false, error }.
 */
export async function updateInterOrgAlertState(
  alertKey: string,
  toStatus: AlertLifecycleStatus,
  reason?: string,
  notes?: string,
): Promise<UpdateAlertStateResult> {
  if (!supabaseConfigured) {
    return { ok: false, error: 'not_configured' };
  }

  const { data, error } = await supabase.rpc('phoenix_update_inter_org_alert_state', {
    p_alert_key: alertKey,
    p_to_status: toStatus,
    p_reason: reason ?? null,
    p_notes: notes ?? null,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  const result = data as { ok: boolean; alert_key?: string; from_status?: string; to_status?: string };
  return {
    ok: result.ok,
    alertKey: result.alert_key,
    fromStatus: result.from_status,
    toStatus: result.to_status,
  };
}

/**
 * Manually reopen a resolved/dismissed alert (migration 039's
 * phoenix_reopen_inter_org_alert RPC). Reason is required by the RPC.
 */
export async function reopenInterOrgAlert(
  alertKey: string,
  reason: string,
  notes?: string,
): Promise<UpdateAlertStateResult> {
  if (!supabaseConfigured) {
    return { ok: false, error: 'not_configured' };
  }

  const { data, error } = await supabase.rpc('phoenix_reopen_inter_org_alert', {
    p_alert_key: alertKey,
    p_reason: reason,
    p_notes: notes ?? null,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  const result = data as { ok: boolean; alert_key?: string; from_status?: string; to_status?: string };
  return {
    ok: result.ok,
    alertKey: result.alert_key,
    fromStatus: result.from_status,
    toStatus: result.to_status,
  };
}

/**
 * Fetch the immutable event history for one alert (migration 039's
 * phoenix_get_inter_org_alert_events RPC) — the only read path for
 * inter_org_alert_events, which has no direct table grant of any kind.
 */
export async function getInterOrgAlertEvents(alertKey: string): Promise<GetAlertEventsResult> {
  if (!supabaseConfigured) {
    return { ok: false, events: [], error: 'not_configured' };
  }

  const { data, error } = await supabase.rpc('phoenix_get_inter_org_alert_events', {
    p_alert_key: alertKey,
  });

  if (error) {
    return { ok: false, events: [], error: error.message };
  }

  const result = data as { ok: boolean; error?: string; alert_key?: string; events?: RawAlertEventRow[] };

  if (!result.ok) {
    return { ok: false, events: [], error: result.error };
  }

  return { ok: true, alertKey: result.alert_key, events: (result.events ?? []).map(mapEvent) };
}
