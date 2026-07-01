import { supabase, supabaseConfigured } from '@/shared/supabase/client';

/**
 * ALERT-LIFECYCLE-RPC-A
 *
 * Read/write wrapper around the four inter-org alert lifecycle RPCs
 * (migration 039): phoenix_get_live_inter_institution_alerts_with_state,
 * phoenix_update_inter_org_alert_state, phoenix_reopen_inter_org_alert, and
 * phoenix_get_inter_org_alert_events. All reads/writes go through
 * supabase.rpc only — there is no direct table access anywhere in this file
 * (inter_org_alert_states/inter_org_alert_events have no client-writable
 * grants at all, and inter_org_alert_events has no direct SELECT grant
 * either, per migration 038). Not imported by any UI screen yet — that is a
 * later phase.
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
 * Fetch live inter-institution alerts merged with persisted lifecycle state
 * (migration 039's phoenix_get_live_inter_institution_alerts_with_state
 * RPC). Note: this call has a controlled write side effect server-side (it
 * creates/refreshes lifecycle rows for currently computed alerts) — see the
 * RPC's own migration comments for the full rationale.
 */
export async function getLiveInterInstitutionAlertsWithState(
  limit = 200,
): Promise<LiveInterInstitutionAlertsWithStateResult> {
  if (!supabaseConfigured) {
    return { ok: false, alerts: [], computedAt: null, error: 'not_configured' };
  }

  const { data, error } = await supabase.rpc('phoenix_get_live_inter_institution_alerts_with_state', {
    p_limit: limit,
  });

  if (error) {
    return { ok: false, alerts: [], computedAt: null, error: error.message };
  }

  const result = data as { ok: boolean; error?: string; alerts?: RawLiveAlertWithStateRow[]; computed_at?: string };

  if (!result.ok) {
    return { ok: false, alerts: [], computedAt: null, error: result.error };
  }

  const alerts = (result.alerts ?? []).map(mapRow);
  return { ok: true, alerts, computedAt: result.computed_at ?? null };
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
