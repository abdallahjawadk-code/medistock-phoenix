import { supabase, supabaseConfigured } from '../client';

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
