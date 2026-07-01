import { supabase, supabaseConfigured } from '@/shared/supabase/client';

/**
 * LIVE-INTER-INSTITUTION-ALERTS-RPC-A
 *
 * Read-only wrapper around phoenix_get_live_inter_institution_alerts
 * (migration 036) — the ONLY source of live, item_availability-based
 * inter-institution Alerts. Deliberately separate from
 * inter-institution-alerts.service.ts (which wraps the legacy,
 * institution_item_status_reports-based get_scoped_inter_institution_alerts
 * RPC, migration 009) so the two data sources are never confused while both
 * exist side by side. This module has no dependency on the manual status
 * report layer anywhere in its imports or types, and is not wired into any
 * UI screen yet — that is a later phase.
 */

export type LiveAlertType = 'surplus_to_shortage' | 'near_expiry_to_shortage';
export type LiveAlertSeverity = 'high' | 'medium';

/** One live inter-institution alert row, camelCase, matching migration 036's payload exactly. */
export interface LiveInterInstitutionAlert {
  alertType: LiveAlertType;
  severity: LiveAlertSeverity;
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
}

export interface LiveInterInstitutionAlertsResult {
  ok: boolean;
  alerts: LiveInterInstitutionAlert[];
  computedAt: string | null;
  /** Populated only when ok is false (e.g. 'FORBIDDEN', 'NOT_AUTHENTICATED'). */
  error?: string;
}

interface RawLiveAlertRow {
  alert_type: LiveAlertType;
  severity: LiveAlertSeverity;
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
}

function mapRow(r: RawLiveAlertRow): LiveInterInstitutionAlert {
  return {
    alertType: r.alert_type,
    severity: r.severity,
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
  };
}

/**
 * Fetch live inter-institution alerts computed from item_availability
 * (migration 036's phoenix_get_live_inter_institution_alerts RPC). This is
 * the ONLY call in this module — no direct table SELECT, no manual status
 * report table, no elevated/admin API key. RLS/permission scoping
 * (super_admin sees all; everyone else only alerts where their own
 * organization is source or target) is enforced entirely server-side inside
 * the RPC — this wrapper does not and cannot bypass it.
 */
export async function getLiveInterInstitutionAlerts(
  limit = 200,
): Promise<LiveInterInstitutionAlertsResult> {
  if (!supabaseConfigured) {
    return { ok: false, alerts: [], computedAt: null, error: 'not_configured' };
  }

  const { data, error } = await supabase.rpc('phoenix_get_live_inter_institution_alerts', {
    p_limit: limit,
  });

  if (error) {
    return { ok: false, alerts: [], computedAt: null, error: error.message };
  }

  const result = data as { ok: boolean; error?: string; alerts?: RawLiveAlertRow[]; computed_at?: string };

  if (!result.ok) {
    return { ok: false, alerts: [], computedAt: null, error: result.error };
  }

  const alerts = (result.alerts ?? []).map(mapRow);
  return { ok: true, alerts, computedAt: result.computed_at ?? null };
}
