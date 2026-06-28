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

  const [orgsRes, whRes, dpRes, qrActiveRes, qrDisabledRes, availRes] = await Promise.all([
    supabase.from('organizations').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('warehouses').select('id', { count: 'exact', head: true }).neq('status', 'archived').match(orgMatch),
    supabase.from('distribution_points').select('id', { count: 'exact', head: true }).neq('status', 'archived').match(orgMatch),
    supabase.from('qr_tokens').select('id', { count: 'exact', head: true }).eq('status', 'active').match(orgMatch),
    supabase.from('qr_tokens').select('id', { count: 'exact', head: true }).eq('status', 'disabled').match(orgMatch),
    supabase.from('item_availability').select('condition').match(orgMatch),
  ]);

  const conditions = (availRes.data ?? []) as { condition: string }[];
  const available  = conditions.filter(r => r.condition === 'available').length;
  const lowStock   = conditions.filter(r => r.condition === 'low_stock').length;
  const missing    = conditions.filter(r => r.condition === 'missing').length;
  const nearExpiry = conditions.filter(r => r.condition === 'near_expiry').length;
  const surplus    = conditions.filter(r => r.condition === 'surplus').length;

  return {
    activeInstitutions: orgsRes.count ?? 0,
    activeWarehouses:   whRes.count ?? 0,
    activePorts:        dpRes.count ?? 0,
    activeQrCodes:      qrActiveRes.count ?? 0,
    disabledQrCodes:    qrDisabledRes.count ?? 0,
    availableItems:     available,
    lowStockCount:      lowStock,
    missingCount:       missing,
    nearExpiryCount:    nearExpiry,
    surplusCount:       surplus,
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

  const [orgsRes, availRes] = await Promise.all([
    supabase.from('organizations')
      .select('id, name, name_ar, code, status, city')
      .eq('status', 'active')
      .order('name_ar'),
    supabase.from('item_availability').select('organization_id, condition'),
  ]);

  if (orgsRes.error) throw orgsRes.error;
  if (availRes.error) throw availRes.error;

  const rows = (availRes.data ?? []) as { organization_id: string; condition: string }[];
  const byOrg = new Map<string, { available: number; low: number; missing: number }>();
  for (const r of rows) {
    const acc = byOrg.get(r.organization_id) ?? { available: 0, low: 0, missing: 0 };
    if (r.condition === 'available' || r.condition === 'surplus') acc.available += 1;
    else if (r.condition === 'low_stock' || r.condition === 'near_expiry') acc.low += 1;
    else if (r.condition === 'missing' || r.condition === 'expired') acc.missing += 1;
    byOrg.set(r.organization_id, acc);
  }

  return (orgsRes.data ?? []).map(o => {
    const c = byOrg.get(o.id) ?? { available: 0, low: 0, missing: 0 };
    return {
      id: o.id, name: o.name, name_ar: o.name_ar, code: o.code,
      status: o.status, city: o.city ?? '',
      available: c.available, low: c.low, missing: c.missing,
    };
  });
}
