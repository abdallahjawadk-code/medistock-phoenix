import { supabase, supabaseConfigured } from '../client';
import type { PurgeImpact } from '../../lib/types';

type AllowlistedType = 'warehouse' | 'distribution_point' | 'local_item';

export async function getEntityPurgeImpact(
  entityType: AllowlistedType,
  entityId: string,
): Promise<PurgeImpact> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('get_entity_purge_impact', {
    p_entity_type: entityType,
    p_entity_id:   entityId,
  });

  if (error) throw error;
  return data as PurgeImpact;
}

export async function archiveEntity(
  entityType: AllowlistedType,
  entityId: string,
  reason: string,
) {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('archive_entity', {
    p_entity_type: entityType,
    p_entity_id:   entityId,
    p_reason:      reason,
  });

  if (error) throw error;
  return data as { ok: boolean; archived: boolean };
}

export async function purgeEntityWithAllData(
  entityType: AllowlistedType,
  entityId: string,
) {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const confirmation = `CONFIRM_PURGE_${entityId}`;

  const { data, error } = await supabase.rpc('purge_entity_with_all_data', {
    p_entity_type:  entityType,
    p_entity_id:    entityId,
    p_confirmation: confirmation,
  });

  if (error) throw error;
  return data as { ok: boolean; purged: boolean; impact: PurgeImpact };
}
