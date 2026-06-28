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

export type PointType = 'dispensing' | 'storage' | 'returns' | 'emergency';

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

export async function createDistributionPoint(input: {
  warehouseId: string;
  organizationId: string;
  name: string;
  name_ar: string;
  pointType: PointType;
}): Promise<DistributionPoint> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase
    .from('distribution_points')
    .insert({
      warehouse_id:    input.warehouseId,
      organization_id: input.organizationId,
      name:            input.name,
      name_ar:         input.name_ar,
      point_type:      input.pointType,
    })
    .select('id, name, name_ar, status, warehouse_id, organization_id, point_type')
    .single();

  if (error) throw error;
  return {
    id: data.id, name: data.name, name_ar: data.name_ar,
    status: data.status, warehouseId: data.warehouse_id,
    organizationId: data.organization_id, pointType: data.point_type,
  };
}

export async function updateDistributionPoint(
  id: string,
  input: { name?: string; name_ar?: string; pointType?: PointType; status?: string },
): Promise<void> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const update: Record<string, unknown> = {};
  if (input.name !== undefined) update.name = input.name;
  if (input.name_ar !== undefined) update.name_ar = input.name_ar;
  if (input.pointType !== undefined) update.point_type = input.pointType;
  if (input.status !== undefined) update.status = input.status;

  const { error } = await supabase
    .from('distribution_points')
    .update(update)
    .eq('id', id);

  if (error) throw error;
}
