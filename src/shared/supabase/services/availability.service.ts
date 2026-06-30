import { supabase, supabaseConfigured } from '../client';
import type { AvailabilityRecord, AvailabilityCondition } from '../../lib/types';

export interface UpsertAvailabilityInput {
  distributionPointId: string;
  organizationId: string;
  scientificName: string;
  tradeName?: string;
  dosageForm?: string;
  concentrationValue?: string;
  price?: number;
  quantity: number;
  condition: AvailabilityCondition;
  batchNumber?: string;
  expiryDate?: string;
  notes?: string;
  /** Free-text "نوع التجهيز" (Supply type) — institution-private (migration 019). */
  supplyType?: string;
}

export async function getAvailabilityByPoint(pointId: string): Promise<AvailabilityRecord[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('item_availability')
    .select(`
      id, quantity, condition, batch_number, expiry_date, notes, updated_at,
      port_name, supply_type,
      scientific_name, trade_name, dosage_form, concentration, price,
      local_items ( id, local_code,
        central_items ( id, name, name_ar, unit, barcode )
      )
    `)
    .eq('distribution_point_id', pointId)
    .order('updated_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as unknown as AvailabilityRecord[];
}

/**
 * Persist an availability record using the material identity flow.
 * Conflict key: (distribution_point_id, scientific_name, concentration, dosage_form)
 * matching index item_availability_dp_sci_conc_form_uniq (migration 029).
 *
 * concentration and dosage_form are sent as '' (empty string) instead of null
 * so that COALESCE(column, '') in the partial index evaluates to '' for both
 * absent and explicitly-empty values, making the onConflict columns align with
 * the index key.  Sending null would cause Postgres 42P10 because the index
 * uses COALESCE expressions, not the raw column values.
 */
export async function upsertAvailability(input: UpsertAvailabilityInput): Promise<void> {
  if (!supabaseConfigured) return;
  if (!input.scientificName?.trim()) {
    throw new Error('upsertAvailability requires scientificName');
  }

  const row: Record<string, unknown> = {
    distribution_point_id: input.distributionPointId,
    organization_id:       input.organizationId,
    scientific_name:       input.scientificName.trim(),
    trade_name:            input.tradeName ?? null,
    dosage_form:           input.dosageForm ?? '',
    concentration:         input.concentrationValue ?? '',
    price:                 input.price ?? null,
    quantity:              input.quantity,
    condition:             input.condition,
    batch_number:          input.batchNumber ?? null,
    expiry_date:           input.expiryDate ?? null,
    notes:                 input.notes ?? null,
    supply_type:           input.supplyType ?? null,
  };

  const { error } = await supabase
    .from('item_availability')
    .upsert(row, { onConflict: 'distribution_point_id,scientific_name,concentration,dosage_form' });
  if (error) throw error;
}

export async function getLowStockItems(orgId: string) {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('item_availability')
    .select(`
      id, quantity, condition, expiry_date,
      distribution_points ( id, name, name_ar ),
      local_items ( id, central_items ( name, name_ar, unit ) )
    `)
    .eq('organization_id', orgId)
    .in('condition', ['low_stock', 'missing', 'near_expiry', 'expired'])
    .order('condition');

  if (error) throw error;
  return data ?? [];
}

export async function getAvailabilityByOrg(orgId: string) {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('item_availability')
    .select(`
      id, scientific_name, trade_name, dosage_form, concentration, price,
      quantity, condition, batch_number, expiry_date, notes, supply_type, updated_at,
      distribution_points ( id, name, name_ar )
    `)
    .eq('organization_id', orgId)
    .order('updated_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}
