/**
 * MOVEMENT-SMART-SEARCH — resolve ANY operator input to trace candidates.
 *
 * Accepts: a movement QR payload, a bare UUID, an OFFICIAL server number
 * (order SP-/PO, receipt PR-, return/shipment numbers) or an external
 * document reference — and, as a fallback, a material/batch text (matched
 * against the caller's OWN RLS-visible documents only).
 *
 * External references are NOT unique: every hit is returned and the operator
 * chooses. All reads are the same RLS-scoped selects the rest of the app
 * uses, so an id/number outside the caller's authority simply yields nothing
 * — 'not found' and 'not authorized' remain indistinguishable, and a
 * malformed input is reported as invalid WITHOUT any read at all.
 */
import { supabase, supabaseConfigured } from '@/shared/supabase/client';
import { parseMovementQrPayload, isTraceUuid, type MovementDocumentKind } from './movement-trace';
import { escapePostgrestIlikeValue } from '@/shared/supabase/services/availability.service';

export interface TraceCandidate {
  kind: MovementDocumentKind | 'procurement_order' | 'procurement_receipt';
  id: string;
  /** The official number shown to the operator. */
  number: string | null;
  externalReference: string | null;
  label: string | null;
  status: string | null;
}

export type TraceSearchResult =
  | { ok: true; candidates: TraceCandidate[] }
  | { ok: false; reason: 'invalid_input' | 'not_found' };

/** True when the text is structurally a search key (not empty/absurd). */
function isPlausibleQuery(raw: string): boolean {
  const s = raw.trim();
  return s.length >= 2 && s.length <= 120;
}

export async function searchMovementDocuments(raw: string): Promise<TraceSearchResult> {
  const input = (raw ?? '').trim();
  if (!input || !isPlausibleQuery(input)) return { ok: false, reason: 'invalid_input' };

  // 1. QR payload → definitive kind + id, no reads needed.
  const qr = parseMovementQrPayload(input);
  if (qr) return { ok: true, candidates: [{ kind: qr.kind, id: qr.id, number: null, externalReference: null, label: null, status: null }] };

  // 2. Bare UUID → the timeline accepts it directly (kind resolved server-side
  //    by the 081 RPC's own sources).
  if (isTraceUuid(input)) {
    return { ok: true, candidates: [{ kind: 'return_request', id: input, number: null, externalReference: null, label: null, status: null }] };
  }

  if (!supabaseConfigured) return { ok: false, reason: 'not_found' };

  // 3. Official numbers + external references, across the caller's own
  //    RLS-visible documents. Exact number first; external refs may repeat.
  const eq = JSON.stringify(input);
  const ilike = escapePostgrestIlikeValue(input);
  const candidates: TraceCandidate[] = [];

  const [requests, shipments, orders, receipts] = await Promise.all([
    supabase.from('outlet_return_requests')
      .select('id, return_number, status')
      .or(`return_number.eq.${eq},return_number.ilike.${ilike}`)
      .limit(8),
    supabase.from('outlet_return_shipments')
      .select('id, shipment_number, status')
      .or(`shipment_number.eq.${eq},shipment_number.ilike.${ilike}`)
      .limit(8),
    supabase.from('procurement_orders')
      .select('id, order_number, external_reference, status')
      .or(`order_number.eq.${eq},external_reference.eq.${eq},order_number.ilike.${ilike},external_reference.ilike.${ilike}`)
      .limit(8),
    supabase.from('procurement_receipts')
      .select('id, receipt_number, invoice_number')
      .or(`receipt_number.eq.${eq},invoice_number.eq.${eq},receipt_number.ilike.${ilike}`)
      .limit(8),
  ]);

  for (const r of requests.data ?? []) {
    candidates.push({ kind: 'return_request', id: r.id, number: r.return_number, externalReference: null, label: null, status: r.status });
  }
  for (const r of shipments.data ?? []) {
    candidates.push({ kind: 'return_shipment', id: r.id, number: r.shipment_number, externalReference: null, label: null, status: r.status });
  }
  for (const r of orders.data ?? []) {
    candidates.push({ kind: 'procurement_order', id: r.id, number: r.order_number, externalReference: r.external_reference, label: null, status: r.status });
  }
  for (const r of receipts.data ?? []) {
    candidates.push({ kind: 'procurement_receipt', id: r.id, number: r.receipt_number, externalReference: r.invoice_number, label: null, status: null });
  }

  if (candidates.length > 0) return { ok: true, candidates };
  return { ok: false, reason: 'not_found' };
}
