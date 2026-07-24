import { supabase, supabaseConfigured } from '@/shared/supabase/client';

/**
 * DECISION-INTELLIGENCE-REPORTS-119 — thin client over migration 119.
 *
 * Never computes classification or supply-source totals itself: both come
 * straight from phoenix_executive_overview (the canonical aggregate) or from
 * a frozen phoenix_report_snapshots row. Snapshot creation is idempotent on
 * a caller-generated requestId, exactly like every other write RPC in this
 * codebase (065/087/089/115/116/119).
 */

export interface ExecutiveOverview {
  organization_id: string;
  as_of: string;
  materials_tracked: number;
  classification_counts: Record<string, number>;
  supply_source_totals: {
    warehouse: Record<string, number>;
    outlet: Record<string, number>;
  };
}

export interface ReportSnapshotRow {
  id: string;
  organization_id: string;
  report_type: string;
  official_number: string | null;
  filters: Record<string, unknown>;
  reporting_period: Record<string, unknown> | null;
  source_as_of: string;
  payload: ExecutiveOverview;
  qr_payload: string;
  created_by: string;
  created_by_role: string;
  created_by_name: string | null;
  created_at: string;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export async function getExecutiveOverview(organizationId: string): Promise<ExecutiveOverview> {
  if (!supabaseConfigured) throw new Error('not_configured');
  const { data, error } = await supabase.rpc('phoenix_executive_overview', {
    p_organization_id: organizationId,
  });
  if (error) throw error;
  return data as ExecutiveOverview;
}

export interface CreateSnapshotResult {
  ok: boolean;
  idempotent_replay: boolean;
  id: string;
  official_number: string;
  qr_payload: string;
  created_at: string;
}

export async function createReportSnapshot(
  requestId: string,
  organizationId: string,
  reportType: 'executive_overview',
  filters: Record<string, unknown> = {},
  reportingPeriod: Record<string, unknown> | null = null,
): Promise<CreateSnapshotResult> {
  if (!supabaseConfigured) throw new Error('not_configured');
  const { data, error } = await supabase.rpc('phoenix_create_report_snapshot', {
    p_request_id: requestId,
    p_organization_id: organizationId,
    p_report_type: reportType,
    p_filters: filters,
    p_reporting_period: reportingPeriod,
  });
  if (error) throw error;
  return data as CreateSnapshotResult;
}

export async function listReportSnapshots(
  organizationId: string,
  reportType?: string,
): Promise<ReportSnapshotRow[]> {
  if (!supabaseConfigured) return [];
  let query = supabase
    .from('phoenix_report_snapshots')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (reportType) query = query.eq('report_type', reportType);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as ReportSnapshotRow[];
}
