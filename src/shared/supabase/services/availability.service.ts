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
 * Persist an availability record via the phoenix_upsert_availability RPC (migration 030).
 * Replaces PostgREST .upsert() which cannot match the COALESCE partial index (migration 029),
 * causing Postgres 42P10. The RPC performs UPDATE-then-INSERT server-side.
 *
 * concentration and dosage_form are sent as '' (empty string) instead of null so that
 * COALESCE(column, '') in the partial index evaluates to '' for both absent and
 * explicitly-empty values.
 *
 * organization_id is derived server-side from distribution_point_id — never trusted from client.
 */
export async function upsertAvailability(input: UpsertAvailabilityInput): Promise<void> {
  if (!supabaseConfigured) return;
  if (!input.scientificName?.trim()) {
    throw new Error('upsertAvailability requires scientificName');
  }

  const { error } = await supabase.rpc('phoenix_upsert_availability', {
    p_distribution_point_id: input.distributionPointId,
    p_scientific_name:       input.scientificName.trim(),
    p_trade_name:            input.tradeName ?? null,
    p_dosage_form:           input.dosageForm ?? '',
    p_concentration:         input.concentrationValue ?? '',
    p_quantity:              input.quantity,
    p_condition:             input.condition,
    p_expiry_date:           input.expiryDate ?? null,
    p_batch_number:          input.batchNumber ?? null,
    p_notes:                 input.notes ?? null,
    p_supply_type:           input.supplyType ?? null,
    p_price:                 input.price ?? null,
  });
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
