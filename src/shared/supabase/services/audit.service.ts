import { supabase, supabaseConfigured } from '../client';
import type { AuditEntry } from '../../lib/types';

export async function getAuditLog(
  orgId: string,
  limit = 50,
): Promise<AuditEntry[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('audit_logs')
    .select('id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload, created_at')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as unknown as AuditEntry[];
}

export async function writeAuditLog(entry: {
  organizationId?: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId?: string;
  entityLabel?: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  if (!supabaseConfigured) return;

  const { error } = await supabase.from('audit_logs').insert({
    organization_id: entry.organizationId ?? null,
    actor_role:      entry.actorRole,
    action:          entry.action,
    entity_type:     entry.entityType,
    entity_id:       entry.entityId ?? null,
    entity_label:    entry.entityLabel ?? null,
    payload:         entry.payload ?? null,
  });

  if (error) console.error('Audit log write failed:', error);
}
