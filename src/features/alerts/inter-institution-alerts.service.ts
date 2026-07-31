/**
 * @deprecated Superseded by `live-inter-institution-alerts.service.ts` (migrations
 * 036/038/039), which InterInstitutionAlertsScreen.tsx actually renders. This file
 * wraps the legacy `get_scoped_inter_institution_alerts` RPC (migration 009) over
 * institution_item_status_reports and has no runtime UI consumer (confirmed by
 * import-graph search, 2026-07-27 — only its own __tests__ reference it). Left in
 * place, not deleted, pending a dedicated cleanup PR after a monitoring window.
 */
import { supabase, supabaseConfigured } from '@/shared/supabase/client';
import { getStatusReports } from '@/shared/supabase/services/status-reports.service';
import type { AlertPriority } from '@/features/status/exchange-alerts';
import {
  buildScopedAlertsFromReports,
  statusPairKey,
  type ScopedAlert,
  type OrgContact,
} from './inter-institution-alerts';

export interface ScopedAlertsResult {
  alerts: ScopedAlert[];
  /** rpc = secure server-side; fallback = super_admin client-side; none = unavailable. */
  source: 'rpc' | 'fallback' | 'none';
  /** True when a non-super actor cannot be served safely (RPC/migration absent). */
  migrationMissing: boolean;
}

interface RpcAlertRow {
  alert_id: string;
  priority: AlertPriority;
  item_name: string | null;
  item_name_ar: string | null;
  source_organization_id: string;
  source_organization_name: string | null;
  source_organization_name_ar: string | null;
  target_organization_id: string;
  target_organization_name: string | null;
  target_organization_name_ar: string | null;
  source_status_type: string;
  target_status_type: string;
  source_quantity: number | null;
  source_unit: string | null;
  source_expiry_date: string | null;
  target_quantity: number | null;
  target_unit: string | null;
  source_contact_name: string | null;
  source_contact_phone: string | null;
  target_contact_name: string | null;
  target_contact_phone: string | null;
  recommendation_kind: 'surplus_match' | 'expiry_match';
}

function mapRpcRow(r: RpcAlertRow): ScopedAlert {
  return {
    id: r.alert_id,
    sourceOrgId: r.source_organization_id,
    sourceOrgName: r.source_organization_name ?? '',
    sourceOrgNameAr: r.source_organization_name_ar ?? '',
    targetOrgId: r.target_organization_id,
    targetOrgName: r.target_organization_name ?? '',
    targetOrgNameAr: r.target_organization_name_ar ?? '',
    itemKey: r.item_name ?? r.item_name_ar ?? r.alert_id,
    itemName: r.item_name ?? '',
    itemNameAr: r.item_name_ar ?? '',
    sourceStatus: r.source_status_type,
    targetStatus: r.target_status_type,
    quantity: r.source_quantity,
    unit: r.source_unit,
    expiryDate: r.source_expiry_date,
    priority: r.priority,
    manualActionRequired: true,
    recommendationKind: r.recommendation_kind,
    statusPair: statusPairKey(r.source_status_type, r.target_status_type),
    sourceContactName: r.source_contact_name,
    sourceContactPhone: r.source_contact_phone,
    targetContactName: r.target_contact_name,
    targetContactPhone: r.target_contact_phone,
  };
}

/**
 * Scoped inter-institution alerts.
 * - Always tries the SECURITY DEFINER RPC first (server-side isolation).
 * - If the RPC/migration is not yet applied:
 *     • super_admin falls back to a client-side computation over all reports
 *       (super is permitted to see everything anyway);
 *     • any other actor gets an empty result with migrationMissing=true —
 *       we never load other institutions' raw reports into a scoped browser.
 */
export async function getScopedInterInstitutionAlerts(
  actor: { isSuper: boolean; orgId: string | null },
): Promise<ScopedAlertsResult> {
  if (!supabaseConfigured) {
    return { alerts: [], source: 'none', migrationMissing: false };
  }

  const { data, error } = await supabase.rpc('get_scoped_inter_institution_alerts');
  if (!error && Array.isArray(data)) {
    return { alerts: (data as RpcAlertRow[]).map(mapRpcRow), source: 'rpc', migrationMissing: false };
  }

  // RPC unavailable (migration not applied) — degrade safely.
  if (actor.isSuper) {
    const reports = await getStatusReports({ activeOnly: true });
    const contacts = await fetchContactsSafe();
    return {
      alerts: buildScopedAlertsFromReports(reports, contacts, actor.orgId, true),
      source: 'fallback',
      migrationMissing: false,
    };
  }

  return { alerts: [], source: 'none', migrationMissing: true };
}

async function fetchContactsSafe(): Promise<OrgContact[]> {
  try {
    const { data, error } = await supabase
      .from('organization_status_contacts')
      .select('organization_id, display_name, phone, is_primary, created_at')
      .eq('is_active', true)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: true });
    if (error) return [];
    return (data ?? []).map((c: { organization_id: string; display_name: string | null; phone: string | null }) => ({
      organizationId: c.organization_id,
      displayName: c.display_name,
      phone: c.phone,
    }));
  } catch {
    return [];
  }
}
