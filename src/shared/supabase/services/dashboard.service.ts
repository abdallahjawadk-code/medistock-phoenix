import { supabase, supabaseConfigured } from '../client';

export interface InstitutionOverview {
  id: string;
  name: string;
  name_ar: string;
  code: string;
  status: string;
  city: string;
  available: number;
  low: number;
  missing: number;
}

export interface DashboardMetrics {
  activeInstitutions: number;
  activeWarehouses: number;
  activePorts: number;
  activeQrCodes: number;
  disabledQrCodes: number;
  availableItems: number;
  lowStockCount: number;
  missingCount: number;
  nearExpiryCount: number;
  surplusCount: number;
  lastUpdated: string;
}

export interface StatusReportCounts {
  scarce: number;
  surplus: number;
  nearExpiry: number;
  missing: number;
  active: number;
  resolved: number;
}

export async function getDashboardMetrics(orgId?: string): Promise<DashboardMetrics> {
  if (!supabaseConfigured) return {
    activeInstitutions: 0, activeWarehouses: 0, activePorts: 0,
    activeQrCodes: 0, disabledQrCodes: 0,
    availableItems: 0, lowStockCount: 0, missingCount: 0,
    nearExpiryCount: 0, surplusCount: 0,
    lastUpdated: new Date().toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' }),
  };

  const orgMatch = orgId ? { organization_id: orgId } : {};

  // PHASE2-DASHBOARD-SERVICE-RPC-SWITCH-A: condition counts are now computed
  // DB-side by phoenix_get_dashboard_condition_counts (migration 054) instead
  // of fetching every item_availability row and counting in JS. The RPC
  // itself applies removed_at IS NULL and enforces org scoping (super_admin
  // vs own-org-only), matching the removed_at exclusion this file previously
  // did client-side.
  const [orgsRes, whRes, dpRes, qrActiveRes, qrDisabledRes, countsRes] = await Promise.all([
    supabase.from('organizations').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('warehouses').select('id', { count: 'exact', head: true }).neq('status', 'archived').match(orgMatch),
    supabase.from('distribution_points').select('id', { count: 'exact', head: true }).neq('status', 'archived').match(orgMatch),
    supabase.from('qr_tokens').select('id', { count: 'exact', head: true }).eq('status', 'active').match(orgMatch),
    supabase.from('qr_tokens').select('id', { count: 'exact', head: true }).eq('status', 'disabled').match(orgMatch),
    supabase.rpc('phoenix_get_dashboard_condition_counts', { p_org_id: orgId ?? null }),
  ]);

  if (countsRes.error) throw countsRes.error;

  const counts = (countsRes.data ?? {}) as Partial<{
    available: number; low_stock: number; missing: number; near_expiry: number; surplus: number;
  }>;

  return {
    activeInstitutions: orgsRes.count ?? 0,
    activeWarehouses:   whRes.count ?? 0,
    activePorts:        dpRes.count ?? 0,
    activeQrCodes:      qrActiveRes.count ?? 0,
    disabledQrCodes:    qrDisabledRes.count ?? 0,
    availableItems:     counts.available ?? 0,
    lowStockCount:      counts.low_stock ?? 0,
    missingCount:       counts.missing ?? 0,
    nearExpiryCount:    counts.near_expiry ?? 0,
    surplusCount:       counts.surplus ?? 0,
    lastUpdated:        new Date().toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' }),
  };
}

export async function getStatusReportCounts(orgId?: string): Promise<StatusReportCounts> {
  if (!supabaseConfigured) return { scarce: 0, surplus: 0, nearExpiry: 0, missing: 0, active: 0, resolved: 0 };

  try {
    const orgMatch = orgId ? { organization_id: orgId } : {};
    const { data, error } = await supabase
      .from('institution_item_status_reports')
      .select('status_type, is_active')
      .match(orgMatch);

    if (error) throw error;

    const rows = (data ?? []) as { status_type: string; is_active: boolean }[];
    const active = rows.filter(r => r.is_active);
    return {
      scarce:     active.filter(r => r.status_type === 'scarce').length,
      surplus:    active.filter(r => r.status_type === 'surplus').length,
      nearExpiry: active.filter(r => r.status_type === 'near_expiry').length,
      missing:    active.filter(r => r.status_type === 'missing').length,
      active:     active.length,
      resolved:   rows.filter(r => !r.is_active).length,
    };
  } catch {
    return { scarce: 0, surplus: 0, nearExpiry: 0, missing: 0, active: 0, resolved: 0 };
  }
}

export async function getInstitutionOverviews(): Promise<InstitutionOverview[]> {
  if (!supabaseConfigured) return [];

  // PHASE2-DASHBOARD-SERVICE-RPC-SWITCH-A: per-org condition counts are now
  // computed DB-side by phoenix_get_institution_condition_counts (migration
  // 054) instead of fetching every item_availability row across every
  // organization and grouping in JS. The RPC applies removed_at IS NULL and
  // enforces org scoping (super_admin sees all orgs; a non-super caller only
  // ever gets their own org's row) — the organizations select below is kept
  // for name/status/city metadata the RPC does not return.
  const [orgsRes, countsRes] = await Promise.all([
    supabase.from('organizations')
      .select('id, name, name_ar, code, status, city')
      .eq('status', 'active')
      .order('name_ar'),
    supabase.rpc('phoenix_get_institution_condition_counts'),
  ]);

  if (orgsRes.error) throw orgsRes.error;
  if (countsRes.error) throw countsRes.error;

  const counts = (countsRes.data ?? []) as { organization_id: string; available: number; low: number; missing: number }[];
  const byOrg = new Map(counts.map(c => [c.organization_id, c]));

  return (orgsRes.data ?? []).map(o => {
    const c = byOrg.get(o.id);
    return {
      id: o.id, name: o.name, name_ar: o.name_ar, code: o.code,
      status: o.status, city: o.city ?? '',
      available: c?.available ?? 0, low: c?.low ?? 0, missing: c?.missing ?? 0,
    };
  });
}
