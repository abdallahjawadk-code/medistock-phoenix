/**
 * MOVEMENT-TIMELINE — thin client over migration 081's
 * phoenix_movement_timeline RPC (live in production since the 2026-07-22
 * cutover). Server-authoritative, RLS/org-scoped, append-only sources, strict
 * page size; unknown and unauthorized trace ids are indistinguishable (the
 * RPC returns the same empty shape).
 */
import { supabase, supabaseConfigured } from '@/shared/supabase/client';

export interface MovementTimelineEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
  actorName: string | null;
  actorRole: string | null;
  statusAfter: string | null;
  materialLabel: string | null;
  batchLabel: string | null;
  quantityDelta: number | null;
  referenceLabel: string | null;
  provenance: string;
}

export interface MovementTimeline {
  events: MovementTimelineEvent[];
  complete: boolean;
  completenessNote: string | null;
}

export async function getMovementTimeline(traceId: string): Promise<MovementTimeline> {
  if (!supabaseConfigured) return { events: [], complete: false, completenessNote: null };
  const { data, error } = await supabase.rpc('phoenix_movement_timeline', {
    p_trace_id: traceId,
    p_limit: 100,
  });
  if (error) throw error;
  const payload = data as {
    ok: boolean;
    events: Array<Record<string, unknown>>;
    complete: boolean;
    completeness_note: string | null;
  };
  return {
    events: (payload.events ?? []).map(e => ({
      eventId: String(e.event_id),
      eventType: String(e.event_type ?? ''),
      occurredAt: String(e.occurred_at ?? ''),
      actorName: (e.actor_name as string | null) ?? null,
      actorRole: (e.actor_role as string | null) ?? null,
      statusAfter: (e.status_after as string | null) ?? null,
      materialLabel: (e.material_label as string | null) ?? null,
      batchLabel: (e.batch_label as string | null) ?? null,
      quantityDelta: typeof e.quantity_delta === 'number' ? e.quantity_delta : null,
      referenceLabel: (e.reference_label as string | null) ?? null,
      provenance: String(e.provenance ?? ''),
    })),
    complete: Boolean(payload.complete),
    completenessNote: payload.completeness_note ?? null,
  };
}
