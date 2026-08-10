import { supabase, supabaseConfigured } from '../client';
import { isClinicalLocationKind, type ClinicalLocationKind } from '../../lib/institution-hierarchy';

export type WarehouseKind = 'central' | 'institution';

export interface Warehouse {
  id: string;
  name: string;
  name_ar: string;
  status: string;
  organizationId: string;
  warehouseKind: WarehouseKind;
  /** STAGE-E-E7-2: the subordinate facility this warehouse is assigned to
   *  (Migration 164/170). Null until assigned via phoenix_assign_warehouse_facility. */
  facilityId: string | null;
}

export interface DistributionPoint {
  id: string;
  name: string;
  name_ar: string;
  status: string;
  warehouseId: string | null;
  organizationId: string;
  pointType: string;
  /**
   * STAGE-E-E7-2: the outlet's clinical context (Migration 164).
   * Null until an operator sets it. Stage-E replenishment REQUIRES it on the
   * destination — the corridor raises
   * `destination_clinical_location_kind_required` while it is null — so it is
   * surfaced here rather than left invisible to the UI.
   *
   * OPTIONAL, not required: the DB column is nullable, and several
   * deliberately-frozen presentation fixtures construct this shape without it.
   * Both service read paths below always populate it, so real data is never
   * `undefined`; consumers treat absent and null identically.
   */
  clinicalLocationKind?: ClinicalLocationKind | null;
}

/** Types approved for operational outlet stock by migrations 066/067. */
export type ApprovedPointType = 'pharmacy' | 'crash_cabinet' | 'rescue_cart';

/** Legacy values remain readable so existing rows can be reclassified safely. */
export type LegacyPointType = 'dispensing' | 'storage' | 'returns' | 'emergency';
export type PointType = ApprovedPointType | LegacyPointType;

export async function getWarehouses(orgId: string): Promise<Warehouse[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('warehouses')
    .select('id, name, name_ar, status, organization_id, warehouse_kind, facility_id')
    .eq('organization_id', orgId)
    .neq('status', 'archived')
    .order('name_ar');

  if (error) throw error;
  return (data ?? []).map(r => ({
    id: r.id, name: r.name, name_ar: r.name_ar,
    status: r.status, organizationId: r.organization_id,
    warehouseKind: r.warehouse_kind as WarehouseKind,
    facilityId: r.facility_id ?? null,
  }));
}

export async function getDistributionPoints(warehouseId: string): Promise<DistributionPoint[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('distribution_points')
    .select('id, name, name_ar, status, warehouse_id, organization_id, point_type, clinical_location_kind')
    .eq('warehouse_id', warehouseId)
    .neq('status', 'archived')
    .order('name_ar');

  if (error) throw error;
  return (data ?? []).map(r => ({
    id: r.id, name: r.name, name_ar: r.name_ar,
    status: r.status, warehouseId: r.warehouse_id,
    organizationId: r.organization_id, pointType: r.point_type,
    clinicalLocationKind: isClinicalLocationKind(r.clinical_location_kind)
      ? r.clinical_location_kind : null,
  }));
}

export async function getPointsByOrg(orgId: string): Promise<DistributionPoint[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('distribution_points')
    .select('id, name, name_ar, status, warehouse_id, organization_id, point_type, clinical_location_kind')
    .eq('organization_id', orgId)
    .neq('status', 'archived')
    .order('name_ar');

  if (error) throw error;
  return (data ?? []).map(r => ({
    id: r.id, name: r.name, name_ar: r.name_ar,
    status: r.status, warehouseId: r.warehouse_id,
    organizationId: r.organization_id, pointType: r.point_type,
    clinicalLocationKind: isClinicalLocationKind(r.clinical_location_kind)
      ? r.clinical_location_kind : null,
  }));
}

export async function createDistributionPoint(input: {
  warehouseId: string;
  organizationId: string;
  name: string;
  name_ar: string;
  pointType: ApprovedPointType;
  /** STAGE-E-E7-2: required in practice for emergency outlets — see the
   *  DistributionPoint interface. Omitted stays null, exactly as before. */
  clinicalLocationKind?: ClinicalLocationKind | null;
}): Promise<DistributionPoint> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');
  if (!input.warehouseId) throw new Error('WAREHOUSE_REQUIRED');

  const row: Record<string, unknown> = {
    organization_id: input.organizationId,
    name:            input.name,
    name_ar:         input.name_ar,
    point_type:      input.pointType,
    warehouse_id:   input.warehouseId,
  };
  if (input.clinicalLocationKind != null) {
    row.clinical_location_kind = input.clinicalLocationKind;
  }

  const { data, error } = await supabase
    .from('distribution_points')
    .insert(row)
    .select('id, name, name_ar, status, warehouse_id, organization_id, point_type, clinical_location_kind')
    .single();

  if (error) {
    if (import.meta.env.DEV) {
      // Capture auth user ID to cross-check against profiles in DB
      const { data: authData } = await supabase.auth.getUser();
      console.error('[phoenix] createDistributionPoint insert failed:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
        payload: row,
        // code guide: '42501'=RLS INSERT blocked, 'PGRST116'=INSERT ok but RETURNING empty (SELECT RLS), '23502'=NOT NULL, '23503'=FK
        authUserId: authData?.user?.id ?? 'NO_SESSION',
      });
    }
    throw error;
  }
  return {
    id: data.id, name: data.name, name_ar: data.name_ar,
    status: data.status, warehouseId: data.warehouse_id,
    organizationId: data.organization_id, pointType: data.point_type,
    clinicalLocationKind: isClinicalLocationKind(data.clinical_location_kind)
      ? data.clinical_location_kind : null,
  };
}

export async function updateDistributionPoint(
  id: string,
  input: {
    name?: string; name_ar?: string; pointType?: ApprovedPointType;
    warehouseId?: string; status?: string;
    clinicalLocationKind?: ClinicalLocationKind | null;
  },
): Promise<void> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const update: Record<string, unknown> = {};
  if (input.name !== undefined) update.name = input.name;
  if (input.name_ar !== undefined) update.name_ar = input.name_ar;
  if (input.pointType !== undefined) update.point_type = input.pointType;
  if (input.warehouseId !== undefined) update.warehouse_id = input.warehouseId;
  if (input.status !== undefined) update.status = input.status;
  // Explicit null is meaningful (clears the context), so only `undefined` skips.
  if (input.clinicalLocationKind !== undefined) {
    update.clinical_location_kind = input.clinicalLocationKind;
  }

  const { error } = await supabase
    .from('distribution_points')
    .update(update)
    .eq('id', id);

  if (error) throw error;
}
