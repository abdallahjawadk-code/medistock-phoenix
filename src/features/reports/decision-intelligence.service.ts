import { supabase, supabaseConfigured } from '@/shared/supabase/client';

/**
 * DECISION-INTELLIGENCE-REPORTS-119/120 — thin client over migrations
 * 119/120.
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

/**
 * PHOENIX-DEMO-ORGANIZATION-WATERMARK-145 / PHASE-C1-REPORT-INTEGRITY — whether
 * an organization belongs to the PHOENIX_DEMO_V1 dataset, so a report/snapshot
 * derived from it can be visibly watermarked ("تجريبي — غير رسمي") rather than
 * presented as an official record.
 *
 * Tri-state, not a boolean: a failed or malformed check is genuinely
 * `unverified`, never silently folded into `official`. A `false` return here
 * used to mean both "confirmed not demo" and "couldn't tell" — those are not
 * the same claim, and only the caller's downstream Official-report handling
 * can decide whether unverified is safe to treat leniently.
 */
export type OrganizationDataMode =
  | { status: 'demo' }
  | { status: 'official' }
  | { status: 'unverified'; error?: unknown };

export async function getOrganizationDataMode(organizationId: string | null | undefined): Promise<OrganizationDataMode> {
  if (!organizationId || !supabaseConfigured) return { status: 'unverified' };
  const { data, error } = await supabase.rpc('phoenix_is_demo_organization', {
    p_organization_id: organizationId,
  });
  if (error) {
    console.error('[phoenix] organization data mode check failed:', error);
    return { status: 'unverified', error };
  }
  if (data === true) return { status: 'demo' };
  if (data === false) return { status: 'official' };
  // Neither true nor false — a malformed/unexpected RPC response is treated
  // the same as a failure: unverified, never assumed official.
  return { status: 'unverified' };
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

export interface SupplySourceDetailRow {
  source_table: string;
  lot_id: string;
  location_kind: 'warehouse' | 'outlet';
  location_id: string;
  location_name: string;
  location_name_ar: string;
  scientific_name: string;
  trade_name: string | null;
  batch_number: string | null;
  expiry_date: string | null;
  on_hand_quantity: number;
  supply_bucket: string;
}

export interface SnapshotParityBucketDiff { snapshot: number; live: number; delta: number; }

export interface SnapshotParityResult {
  /** True only when every classification/supply bucket and materials_tracked match exactly. */
  matches: boolean;
  snapshotAsOf: string;
  liveAsOf: string;
  materialsTrackedSnapshot: number;
  materialsTrackedLive: number;
  /** Only buckets that DIFFER are present — an empty object means that group matches exactly. */
  classificationDiffs: Record<string, SnapshotParityBucketDiff>;
  supplySourceDiffs: {
    warehouse: Record<string, SnapshotParityBucketDiff>;
    outlet: Record<string, SnapshotParityBucketDiff>;
  };
}

function diffBuckets(snapshotCounts: Record<string, number>, liveCounts: Record<string, number>): Record<string, SnapshotParityBucketDiff> {
  const diffs: Record<string, SnapshotParityBucketDiff> = {};
  const keys = new Set([...Object.keys(snapshotCounts), ...Object.keys(liveCounts)]);
  for (const key of keys) {
    const snapshot = snapshotCounts[key] ?? 0;
    const live = liveCounts[key] ?? 0;
    if (snapshot !== live) diffs[key] = { snapshot, live, delta: live - snapshot };
  }
  return diffs;
}

/**
 * 119's OWN test proves a snapshot equals the live RPC's output AT THE
 * INSTANT of creation (same transaction, same function call — see
 * 119-report-snapshots-and-executive-overview.dynamic.test.ts). This is the
 * complementary check for an OLDER snapshot: re-fetches
 * phoenix_executive_overview for the snapshot's organization right now and
 * reports every field that has since drifted. Drift is the EXPECTED,
 * normal outcome once any stock movement has happened since the snapshot
 * was taken — this function documents/audits that drift, it does not assert
 * the two must be equal.
 */
export async function checkSnapshotParity(snapshot: ReportSnapshotRow): Promise<SnapshotParityResult> {
  const live = await getExecutiveOverview(snapshot.organization_id);
  const classificationDiffs = diffBuckets(snapshot.payload.classification_counts, live.classification_counts);
  const supplySourceDiffs = {
    warehouse: diffBuckets(snapshot.payload.supply_source_totals.warehouse, live.supply_source_totals.warehouse),
    outlet: diffBuckets(snapshot.payload.supply_source_totals.outlet, live.supply_source_totals.outlet),
  };
  const materialsTrackedLive = live.materials_tracked;
  const materialsTrackedSnapshot = snapshot.payload.materials_tracked;
  return {
    matches: materialsTrackedSnapshot === materialsTrackedLive
      && Object.keys(classificationDiffs).length === 0
      && Object.keys(supplySourceDiffs.warehouse).length === 0
      && Object.keys(supplySourceDiffs.outlet).length === 0,
    snapshotAsOf: snapshot.source_as_of,
    liveAsOf: live.as_of,
    materialsTrackedSnapshot,
    materialsTrackedLive,
    classificationDiffs,
    supplySourceDiffs,
  };
}

/** 120 — per-lot drill-down behind one supply-source bucket total. */
export async function getSupplySourcesDetail(
  organizationId: string,
  supplyBucket?: string,
): Promise<SupplySourceDetailRow[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase.rpc('phoenix_supply_sources_detail', {
    p_organization_id: organizationId,
    p_supply_bucket: supplyBucket ?? null,
  });
  if (error) throw error;
  return (data ?? []) as SupplySourceDetailRow[];
}
