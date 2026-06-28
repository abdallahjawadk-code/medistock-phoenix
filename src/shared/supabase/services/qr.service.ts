import { supabase, supabaseConfigured } from '../client';
import type { QrToken } from '../../lib/types';

export async function getPublicQrPayload(publicId: string) {
  if (!supabaseConfigured) return null;

  const { data, error } = await supabase.rpc('get_public_qr_payload', {
    p_public_id: publicId,
  });

  if (error) throw error;
  return data as Record<string, unknown>;
}

export async function createQrForTarget(
  targetType: 'warehouse' | 'distribution_point' | 'local_item',
  targetId: string,
  label?: string,
) {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('create_qr_for_target', {
    p_target_type: targetType,
    p_target_id:   targetId,
    p_label:       label ?? null,
  });

  if (error) throw error;
  return data as { ok: boolean; created: boolean; token_id: string; public_id: string };
}

export async function disableQrToken(tokenId: string, reason = 'manual_disable') {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('disable_qr_token', {
    p_token_id: tokenId,
    p_reason:   reason,
  });

  if (error) throw error;
  return data as { ok: boolean };
}

export async function getQrForPoint(pointId: string): Promise<{
  tokenId: string; publicId: string; status: string;
} | null> {
  if (!supabaseConfigured) return null;

  const { data, error } = await supabase
    .from('qr_tokens')
    .select('id, public_id, status, qr_targets!inner( target_type, target_id )')
    .eq('qr_targets.target_type', 'distribution_point')
    .eq('qr_targets.target_id', pointId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { tokenId: data.id, publicId: data.public_id, status: data.status };
}

export async function regenerateQrForPoint(pointId: string, label?: string): Promise<{
  ok: boolean; public_id: string;
}> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const existing = await getQrForPoint(pointId);
  if (existing) {
    await disableQrToken(existing.tokenId, 'regenerated');
  }

  const result = await createQrForTarget('distribution_point', pointId, label);
  return { ok: result.ok, public_id: result.public_id };
}

export async function getQrTokensByOrg(orgId: string): Promise<QrToken[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('qr_tokens')
    .select(`
      id, public_id, status, last_scanned_at, scan_count, created_at, disabled_at,
      qr_targets ( id, target_type, target_id, label, status )
    `)
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as unknown as QrToken[];
}
