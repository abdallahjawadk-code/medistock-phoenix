import { supabase, supabaseConfigured } from '../client';
import type { AvailabilityRecord, AvailabilityCondition } from '../../lib/types';

export interface UpsertAvailabilityInput {
  /** Legacy item-selection flow (local_items FK). Mutually exclusive with portName. */
  localItemId?: string;
  /**
   * Free-text "المنفذ" (Access point / Port) value — the normal Availability
   * Editor flow as of AVAILABILITY-EDITOR-INSTITUTION-UX-A. Mutually
   * exclusive with localItemId. Requires migration 019
   * (item_availability.port_name + a relaxed local_item_id NOT NULL).
   */
  portName?: string;
  distributionPointId: string;
  organizationId: string;
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
 * Persist an availability record. Targets one of two conflict keys
 * depending on which identity the caller supplies:
 *   - localItemId  -> (local_item_id, distribution_point_id) — original flow.
 *   - portName     -> (distribution_point_id, port_name) — new free-text
 *                     flow (requires migration 019).
 * Exactly one of localItemId/portName must be provided.
 */
export async function upsertAvailability(input: UpsertAvailabilityInput): Promise<void> {
  if (!supabaseConfigured) return;
  if (!input.localItemId && !input.portName) {
    throw new Error('upsertAvailability requires either localItemId or portName');
  }

  const row: Record<string, unknown> = {
    distribution_point_id: input.distributionPointId,
    organization_id:       input.organizationId,
    quantity:              input.quantity,
    condition:             input.condition,
    batch_number:          input.batchNumber ?? null,
    expiry_date:           input.expiryDate ?? null,
    notes:                 input.notes ?? null,
    supply_type:           input.supplyType ?? null,
  };

  if (input.localItemId) {
    row.local_item_id = input.localItemId;
    const { error } = await supabase
      .from('item_availability')
      .upsert(row, { onConflict: 'local_item_id,distribution_point_id' });
    if (error) throw error;
  } else {
    row.port_name = input.portName;
    const { error } = await supabase
      .from('item_availability')
      .upsert(row, { onConflict: 'distribution_point_id,port_name' });
    if (error) throw error;
  }
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
