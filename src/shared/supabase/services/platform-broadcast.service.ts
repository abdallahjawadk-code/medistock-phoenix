import { supabase, supabaseConfigured } from '../client';

export type BroadcastSeverity = 'info' | 'warning' | 'important' | 'urgent';
export type BroadcastTargetScope = 'all' | 'selected';

export interface PendingBroadcast {
  id: string;
  title: string;
  body: string;
  severity: BroadcastSeverity;
  publish_at: string;
  expires_at: string | null;
}

export interface AdminBroadcast {
  id: string;
  title: string;
  body: string;
  severity: BroadcastSeverity;
  target_scope: BroadcastTargetScope;
  publish_at: string;
  expires_at: string | null;
  is_active: boolean;
  created_at: string;
  target_count: number;
  acknowledged_count: number;
  pending_count: number;
}

export interface CreateBroadcastInput {
  title: string;
  body: string;
  severity: BroadcastSeverity;
  targetScope: BroadcastTargetScope;
  orgIds?: string[];
  publishAt?: string;
  expiresAt?: string | null;
}

export interface BroadcastOkResult {
  ok: true;
  [key: string]: unknown;
}

export interface BroadcastErrorResult {
  ok: false;
  error: string;
}

export type BroadcastResult<T extends Record<string, unknown> = Record<string, never>> =
  (BroadcastOkResult & T) | BroadcastErrorResult;

/** Super admin only — server-side enforced by phoenix_create_platform_broadcast (migration 056). */
export async function createPlatformBroadcast(
  input: CreateBroadcastInput,
): Promise<BroadcastResult<{ id: string }>> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('phoenix_create_platform_broadcast', {
    p_title: input.title,
    p_body: input.body,
    p_severity: input.severity,
    p_target_scope: input.targetScope,
    p_org_ids: input.targetScope === 'selected' ? (input.orgIds ?? []) : null,
    p_publish_at: input.publishAt ?? new Date().toISOString(),
    p_expires_at: input.expiresAt ?? null,
  });

  if (error) throw error;
  return data as BroadcastResult<{ id: string }>;
}

/** Super admin only — server-side enforced by phoenix_deactivate_platform_broadcast (migration 056). */
export async function deactivatePlatformBroadcast(messageId: string): Promise<BroadcastResult> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('phoenix_deactivate_platform_broadcast', {
    p_message_id: messageId,
  });

  if (error) throw error;
  return data as BroadcastResult;
}

/** Super admin only — server-side enforced by phoenix_list_platform_broadcasts_admin (migration 056). */
export async function listPlatformBroadcastsAdmin(): Promise<BroadcastResult<{ messages: AdminBroadcast[] }>> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('phoenix_list_platform_broadcasts_admin');

  if (error) throw error;
  return data as BroadcastResult<{ messages: AdminBroadcast[] }>;
}

/**
 * Any authenticated user with an organization. Returns active, published,
 * unexpired broadcasts targeted at the caller's org (or 'all') that have not
 * yet been acknowledged by that org. Returns an empty list (never an error)
 * when the caller has no organization.
 */
export async function getPendingPlatformBroadcasts(): Promise<BroadcastResult<{ broadcasts: PendingBroadcast[] }>> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('phoenix_get_pending_platform_broadcasts');

  if (error) throw error;
  return data as BroadcastResult<{ broadcasts: PendingBroadcast[] }>;
}

/**
 * Institution-level acknowledgement — idempotent under a multi-tab/multi-user
 * race (the RPC uses ON CONFLICT DO NOTHING), so calling this twice for the
 * same message/org is always safe and always returns ok=true.
 */
export async function acknowledgePlatformBroadcast(messageId: string): Promise<BroadcastResult> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('phoenix_ack_platform_broadcast', {
    p_message_id: messageId,
  });

  if (error) throw error;
  return data as BroadcastResult;
}
