/**
 * CURRENT MOVEMENT STATUS — resolve a canonical trace key to the document's
 * CURRENT server state, using ONLY existing RLS-scoped reads.
 *
 * This is deliberately NOT a historical timeline. The unified, ordered,
 * cross-lifecycle timeline requires a server-authoritative timeline RPC that
 * does not yet exist (see docs/proposals/movement-timeline-rpc.md); until it
 * lands, this view shows the live status of ONE document, read through the same
 * RLS-scoped queries the rest of the app uses.
 *
 * SECURITY: no privileged key, no auth.admin, no service_role, no fabricated
 * history. A record the caller may not see is filtered out by RLS, so it simply
 * does not appear in the read — and this resolver returns the SAME generic
 * `not_available` result whether the id is unknown or merely unauthorized. The
 * two are never distinguished, so existence is never leaked.
 */
import { parseMovementQrPayload, isTraceUuid, type MovementDocumentKind } from '@/features/movement/movement-trace';
import type {
  OutletReturnRequest, OutletReturnRequestLine,
  OutletReturnShipment, OutletReturnShipmentLine,
} from './outlet-return.service';

export interface MovementStatusLine {
  scientificName: string;
  batchNumber: string | null;
  expiryDate: string | null;
  requestedQuantity: number | null;
  movedQuantity: number | null;
  receivedQuantity: number | null;
  disposition: string | null;
  custodyState: string | null;
  /** The original dispatch line this return anchors to. */
  provenance: string | null;
  reason: string | null;
  status: string;
}

export interface MovementStatus {
  kind: MovementDocumentKind;
  /** The immutable canonical uuid. */
  traceKey: string;
  externalReference: string | null;
  status: string;
  lines: MovementStatusLine[];
}

export type MovementStatusResult =
  | { ok: true; status: MovementStatus }
  /** Unknown OR unauthorized — deliberately indistinguishable. */
  | { ok: false; reason: 'not_available' }
  /** The trace key is well-formed but this view cannot resolve its kind yet. */
  | { ok: false; reason: 'unsupported_kind'; kind: MovementDocumentKind }
  /** The input was not a canonical trace key at all. */
  | { ok: false; reason: 'invalid_input' };

export interface MovementStatusTarget {
  kind: MovementDocumentKind;
  id: string;
}

/**
 * Parse operator input into a trace target.
 *
 * Accepts a scanned/pasted movement QR payload (which carries the kind), or a
 * bare canonical uuid together with an explicit kind chosen in the UI. Anything
 * else is invalid input — never guessed.
 */
export function parseMovementStatusInput(raw: string, kindHint?: MovementDocumentKind): MovementStatusTarget | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const qr = parseMovementQrPayload(trimmed);
  if (qr) return { kind: qr.kind, id: qr.id };
  if (kindHint && isTraceUuid(trimmed)) return { kind: kindHint, id: trimmed };
  return null;
}

export interface MovementStatusDeps {
  getReturnRequests: () => Promise<OutletReturnRequest[]>;
  getReturnRequestLines: (id: string) => Promise<OutletReturnRequestLine[]>;
  getReturnShipments: () => Promise<OutletReturnShipment[]>;
  getReturnShipmentLines: (id: string) => Promise<OutletReturnShipmentLine[]>;
}

function requestStatus(request: OutletReturnRequest, lines: readonly OutletReturnRequestLine[]): MovementStatus {
  return {
    kind: 'return_request',
    traceKey: request.id,
    externalReference: request.returnNumber || null,
    status: request.status,
    lines: lines.map(l => ({
      scientificName: l.scientificName,
      batchNumber: l.batchNumber,
      expiryDate: l.expiryDate,
      requestedQuantity: l.requestedQuantity,
      movedQuantity: null,
      receivedQuantity: null,
      disposition: null,
      custodyState: null,
      provenance: l.originalDispatchLineId,
      reason: l.reasonText ? `${l.reasonCode} — ${l.reasonText}` : l.reasonCode,
      status: l.status,
    })),
  };
}

function shipmentStatus(shipment: OutletReturnShipment, lines: readonly OutletReturnShipmentLine[]): MovementStatus {
  return {
    kind: 'return_shipment',
    traceKey: shipment.id,
    externalReference: shipment.shipmentNumber || null,
    status: shipment.status,
    lines: lines.map(l => ({
      scientificName: l.scientificName,
      batchNumber: l.batchNumber,
      expiryDate: l.expiryDate,
      requestedQuantity: null,
      movedQuantity: l.sentQuantity,
      receivedQuantity: l.receivedQuantity,
      disposition: l.disposition,
      custodyState: l.custodyState,
      provenance: l.originalDispatchLineId,
      reason: l.differenceReason,
      status: l.status,
    })),
  };
}

/**
 * Resolve one document's current status through RLS-scoped reads.
 *
 * Throws are the CALLER's to catch (→ an error state); a clean "row not present
 * in the RLS-scoped read" resolves to `not_available`, identical to unknown.
 */
export async function resolveMovementStatus(
  target: MovementStatusTarget,
  deps: MovementStatusDeps,
): Promise<MovementStatusResult> {
  if (!isTraceUuid(target.id)) return { ok: false, reason: 'invalid_input' };

  if (target.kind === 'return_request') {
    const request = (await deps.getReturnRequests()).find(r => r.id === target.id);
    if (!request) return { ok: false, reason: 'not_available' };
    return { ok: true, status: requestStatus(request, await deps.getReturnRequestLines(target.id)) };
  }

  if (target.kind === 'return_shipment') {
    const shipment = (await deps.getReturnShipments()).find(s => s.id === target.id);
    if (!shipment) return { ok: false, reason: 'not_available' };
    return { ok: true, status: shipmentStatus(shipment, await deps.getReturnShipmentLines(target.id)) };
  }

  // supply_request / supply_dispatch belong to the direct corridor and are not
  // resolvable here yet — this is about the view's coverage, not the record, so
  // it cannot leak whether the id exists.
  return { ok: false, reason: 'unsupported_kind', kind: target.kind };
}
