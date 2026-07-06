import { supabase, supabaseConfigured } from '../client';
import type { PurgeImpact } from '../../lib/types';
import { invalidateOrganizationsCache } from './organizations.service';

type AllowlistedType = 'warehouse' | 'distribution_point' | 'local_item';

export interface OrgDeleteImpact {
  activeWarehouses: number;
  activePorts: number;
  activeQrTokens: number;
  availabilityRows: number;
  activeStatusReports: number;
  profiles: number;
  canArchive: boolean;
  canPurge: boolean;
}

export async function getOrgDeleteImpact(orgId: string): Promise<OrgDeleteImpact> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const [whRes, dpRes, qrRes, availRes, profileRes] = await Promise.all([
    supabase.from('warehouses').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).neq('status', 'archived'),
    supabase.from('distribution_points').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).neq('status', 'archived'),
    supabase.from('qr_tokens').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('status', 'active'),
    supabase.from('item_availability').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
  ]);

  let activeStatusReports = 0;
  try {
    const srRes = await supabase.from('institution_item_status_reports')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId).eq('is_active', true);
    activeStatusReports = srRes.count ?? 0;
  } catch { /* table may not exist */ }

  const wh = whRes.count ?? 0;
  const dp = dpRes.count ?? 0;
  const qr = qrRes.count ?? 0;
  const avail = availRes.count ?? 0;
  const profiles = profileRes.count ?? 0;

  return {
    activeWarehouses: wh,
    activePorts: dp,
    activeQrTokens: qr,
    availabilityRows: avail,
    activeStatusReports,
    profiles,
    canArchive: wh === 0 && dp === 0 && qr === 0 && avail === 0,
    canPurge: wh === 0 && dp === 0 && qr === 0 && avail === 0 && profiles === 0 && activeStatusReports === 0,
  };
}

export async function clearPortAvailability(pointId: string): Promise<{ ok: boolean; cleared: number }> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const confirmation = `CLEAR_PORT_ITEMS_${pointId}`;
  const { data, error } = await supabase.rpc('clear_port_availability', {
    p_point_id: pointId,
    p_confirmation: confirmation,
  });

  if (error) throw error;
  const result = data as { ok: boolean; cleared: number; error?: string };
  if (!result.ok) throw new Error(result.error ?? 'CLEAR_FAILED');
  return result;
}

/**
 * BUGFIX-REPORTS-DATES-PORT-CLEAR-A: classify a clearPortAvailability failure
 * into an i18n string key instead of showing the raw backend error code
 * (INSUFFICIENT_ROLE, CONFIRMATION_MISMATCH, ...) or a raw Postgres message.
 *
 * clear_port_availability (migration 007) hard-DELETEs item_availability
 * rows. item_availability_movements.item_availability_id references that
 * table ON DELETE RESTRICT (migration 033), added after 007 shipped — so any
 * port that has quantity-movement history (the common case once Adjust
 * Quantity is used) makes the DELETE fail with Postgres 23503
 * (foreign_key_violation). That case is classified to dw_clear_has_movements
 * so the user gets an honest, actionable message instead of a raw DB error.
 * A backend fix (see BUGFIX-REPORTS-DATES-PORT-CLEAR-A migration plan) is
 * required to actually allow clearing ports with movement history; this is
 * frontend-only error classification, not a workaround for the underlying
 * restriction.
 */
export function classifyClearPortItemsError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  const message = (error as { message?: string } | null)?.message ?? '';

  if (code === '23503' || /foreign key constraint/i.test(message)) return 'dw_clear_has_movements';
  if (message === 'INSUFFICIENT_ROLE') return 'dw_clear_forbidden_role';
  if (message === 'FORBIDDEN_ORG') return 'dw_clear_forbidden_org';
  if (message === 'CONFIRMATION_MISMATCH') return 'dw_clear_confirmation_mismatch';
  if (message === 'POINT_NOT_FOUND') return 'dw_clear_point_not_found';
  return 'load_error';
}

export async function archiveOrganization(orgId: string): Promise<void> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { error } = await supabase
    .from('organizations')
    .update({ status: 'inactive' })
    .eq('id', orgId);

  if (error) throw error;
  invalidateOrganizationsCache();
}

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
  // BUGFIX-OUTLET-MATERIAL-AND-OUTLET-DELETE-A: archive_entity (migration 003)
  // returns { ok: false, error: '...' } as a normal JSONB payload (not a
  // thrown Postgres exception) for INSUFFICIENT_ROLE / NOT_FOUND_OR_ALREADY_ARCHIVED
  // / etc — callers must check `ok`, not rely on this function throwing.
  return data as { ok: boolean; archived?: boolean; error?: string };
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
