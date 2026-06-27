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
  availableItems: number;
  lowStockCount: number;
  missingCount: number;
  nearExpiryCount: number;
  bridgeHealth: { healthy: number; total: number };
  safeModeModules: number;
  lastUpdated: string;
}

const DEMO_METRICS: DashboardMetrics = {
  activeInstitutions: 4,
  availableItems: 1248,
  lowStockCount: 42,
  missingCount: 8,
  nearExpiryCount: 15,
  bridgeHealth: { healthy: 7, total: 7 },
  safeModeModules: 2,
  lastUpdated: new Date().toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' }),
};

export async function getDashboardMetrics(orgId?: string): Promise<DashboardMetrics> {
  if (!supabaseConfigured) return DEMO_METRICS;

  const org_filter = orgId ? { organization_id: orgId } : {};

  const [orgsRes, availRes] = await Promise.all([
    supabase.from('organizations').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('item_availability').select('condition', { count: 'exact' }).match(org_filter),
  ]);

  const conditions = (availRes.data ?? []) as { condition: string }[];
  const available   = conditions.filter(r => r.condition === 'available').length;
  const lowStock    = conditions.filter(r => r.condition === 'low_stock').length;
  const missing     = conditions.filter(r => r.condition === 'missing').length;
  const nearExpiry  = conditions.filter(r => r.condition === 'near_expiry').length;

  return {
    activeInstitutions: orgsRes.count ?? 0,
    availableItems:     available,
    lowStockCount:      lowStock,
    missingCount:       missing,
    nearExpiryCount:    nearExpiry,
    bridgeHealth:       { healthy: 7, total: 7 },   // computed separately when health module wired
    safeModeModules:    0,
    lastUpdated:        new Date().toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' }),
  };
}

/**
 * Live per-institution overview: each active organization with its real
 * availability counts. No fabricated numbers — counts come straight from
 * item_availability (RLS scopes what each role can see).
 */
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
