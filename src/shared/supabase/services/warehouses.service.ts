import { supabase, supabaseConfigured } from '../client';

export interface Warehouse {
  id: string;
  name: string;
  name_ar: string;
  status: string;
  organizationId: string;
}

export interface DistributionPoint {
  id: string;
  name: string;
  name_ar: string;
  status: string;
  warehouseId: string;
  organizationId: string;
  pointType: string;
}

export async function getWarehouses(orgId: string): Promise<Warehouse[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('warehouses')
    .select('id, name, name_ar, status, organization_id')
    .eq('organization_id', orgId)
    .neq('status', 'archived')
    .order('name_ar');

  if (error) throw error;
  return (data ?? []).map(r => ({
    id: r.id, name: r.name, name_ar: r.name_ar,
    status: r.status, organizationId: r.organization_id,
  }));
}

export async function getDistributionPoints(warehouseId: string): Promise<DistributionPoint[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('distribution_points')
    .select('id, name, name_ar, status, warehouse_id, organization_id, point_type')
    .eq('warehouse_id', warehouseId)
    .neq('status', 'archived')
    .order('name_ar');

  if (error) throw error;
  return (data ?? []).map(r => ({
    id: r.id, name: r.name, name_ar: r.name_ar,
    status: r.status, warehouseId: r.warehouse_id,
    organizationId: r.organization_id, pointType: r.point_type,
  }));
}

export async function getPointsByOrg(orgId: string): Promise<DistributionPoint[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('distribution_points')
    .select('id, name, name_ar, status, warehouse_id, organization_id, point_type')
    .eq('organization_id', orgId)
    .neq('status', 'archived')
    .order('name_ar');

  if (error) throw error;
  return (data ?? []).map(r => ({
    id: r.id, name: r.name, name_ar: r.name_ar,
    status: r.status, warehouseId: r.warehouse_id,
    organizationId: r.organization_id, pointType: r.point_type,
  }));
}
