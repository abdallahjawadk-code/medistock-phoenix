import { supabase, supabaseConfigured } from '../client';
import type { AvailabilityRecord, AvailabilityStatus } from '../../lib/types';

export interface UpsertAvailabilityInput {
  localItemId: string;
  distributionPointId: string;
  organizationId: string;
  quantity: number;
  condition: AvailabilityStatus;
  batchNumber?: string;
  expiryDate?: string;
  notes?: string;
}

export async function getAvailabilityByPoint(pointId: string): Promise<AvailabilityRecord[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('item_availability')
    .select(`
      id, quantity, condition, batch_number, expiry_date, notes, updated_at,
      local_items ( id, local_code,
        central_items ( id, name, name_ar, unit, barcode )
      )
    `)
    .eq('distribution_point_id', pointId)
    .order('updated_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as unknown as AvailabilityRecord[];
}

export async function upsertAvailability(input: UpsertAvailabilityInput): Promise<void> {
  if (!supabaseConfigured) return;

  const { error } = await supabase
    .from('item_availability')
    .upsert({
      local_item_id:         input.localItemId,
      distribution_point_id: input.distributionPointId,
      organization_id:       input.organizationId,
      quantity:              input.quantity,
      condition:             input.condition,
      batch_number:          input.batchNumber ?? null,
      expiry_date:           input.expiryDate ?? null,
      notes:                 input.notes ?? null,
    }, { onConflict: 'local_item_id,distribution_point_id' });

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
