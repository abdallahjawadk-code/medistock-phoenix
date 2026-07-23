/**
 * NOTIFICATIONS — the read/write surface for migration 094/099's
 * org-scoped, append-only notification feed. The feed itself is populated
 * entirely server-side (082's lifecycle trigger + 099's headerless-event
 * trigger); nothing here ever inserts a notification row — only lists,
 * counts, and per-viewer read state.
 */
import { supabase, supabaseConfigured } from '@/shared/supabase/client';

export interface NotificationRow {
  id: string;
  eventType: string;
  occurredAt: string;
  actorId: string | null;
  actorRole: string | null;
  actorName: string | null;
  status: string | null;
  referenceType: string | null;
  referenceId: string | null;
  reference: string | null;
  isRead: boolean;
}

interface NotificationDbRow {
  id: string; event_type: string; occurred_at: string;
  actor_id: string | null; actor_role: string | null; actor_name: string | null;
  status: string | null; reference_type: string | null; reference_id: string | null;
  reference: string | null; is_read: boolean;
}

export interface NotificationsCursor {
  beforeAt: string;
  beforeId: string;
}

export interface NotificationsPage {
  notifications: NotificationRow[];
  nextCursor: NotificationsCursor | null;
}

function mapRow(r: NotificationDbRow): NotificationRow {
  return {
    id: r.id, eventType: r.event_type, occurredAt: r.occurred_at,
    actorId: r.actor_id, actorRole: r.actor_role, actorName: r.actor_name,
    status: r.status, referenceType: r.reference_type, referenceId: r.reference_id,
    reference: r.reference, isRead: r.is_read,
  };
}

/** One page of the caller's org-scoped notification feed, newest first. */
export async function listNotifications(
  opts: { limit?: number; before?: NotificationsCursor; unreadOnly?: boolean } = {},
): Promise<NotificationsPage> {
  if (!supabaseConfigured) return { notifications: [], nextCursor: null };
  const { data, error } = await supabase.rpc('phoenix_notifications_list', {
    p_limit: opts.limit ?? 30,
    p_before_at: opts.before?.beforeAt ?? null,
    p_before_id: opts.before?.beforeId ?? null,
    p_unread_only: opts.unreadOnly ?? false,
  });
  if (error) throw error;
  const r = data as { ok: boolean; notifications: NotificationDbRow[]; next_cursor: { before_at: string; before_id: string } | null };
  return {
    notifications: (r.notifications ?? []).map(mapRow),
    nextCursor: r.next_cursor ? { beforeAt: r.next_cursor.before_at, beforeId: r.next_cursor.before_id } : null,
  };
}

/** Count of unread notifications visible to the caller (org-scoped). */
export async function getUnreadNotificationCount(): Promise<number> {
  if (!supabaseConfigured) return 0;
  const { data, error } = await supabase.rpc('phoenix_notifications_unread_count');
  if (error) throw error;
  return typeof data === 'number' ? data : Number(data ?? 0);
}

/** Marks one notification read for the CALLING profile only — never another profile. */
export async function markNotificationRead(notificationId: string): Promise<void> {
  if (!supabaseConfigured) return;
  const { error } = await supabase.rpc('phoenix_notifications_mark_read', { p_notification_id: notificationId });
  if (error) throw error;
}

/** Marks every currently-unread, in-scope notification read for the CALLING profile. */
export async function markAllNotificationsRead(): Promise<number> {
  if (!supabaseConfigured) return 0;
  const { data, error } = await supabase.rpc('phoenix_notifications_mark_all_read');
  if (error) throw error;
  const r = data as { ok: boolean; marked: number };
  return r.marked ?? 0;
}
