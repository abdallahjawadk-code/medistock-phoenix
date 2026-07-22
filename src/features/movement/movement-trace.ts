/**
 * MOVEMENT-COMPOSER-A — canonical trace identity for supply/return documents.
 *
 * WHY UUID AND NOT A SERIAL: audited at 54f77e0, this database has NO atomic
 * server-side allocator for request_number / transfer_number / return_number /
 * shipment_number, and NO uniqueness constraint on any of them. All four are
 * plain `text` columns populated from client-supplied RPC parameters
 * (p_request_number, p_transfer_number, p_return_number).
 *
 * A browser-generated sequence is therefore unsafe under concurrent operators
 * and is forbidden — no MAX()+1, no row count, no Date.now(), no localStorage
 * counter. Closing that gap needs an additive migration, which is out of scope;
 * see docs/phoenix/proposals/sequential-document-numbers.md for the proposal.
 *
 * Until that lands:
 *   - the immutable database `uuid` primary key IS the canonical trace key;
 *   - any operator-typed number is an EXTERNAL REFERENCE ONLY and is labelled
 *     as such everywhere it appears. It is never called a serial.
 */

/** The four documents in the corridor. Deliberately distinct — a request is not a receipt. */
export type MovementDocumentKind =
  | 'supply_request'    // A — طلب تجهيز مباشر (editable, not a stock movement)
  | 'supply_dispatch'   // B — وصل تجهيز (issued only once materials are dispatched)
  | 'return_request'    // C — طلب إرجاع مباشر (editable, not a stock movement)
  | 'return_shipment'   // D — وصل إرجاع (issued only once materials are returned)
  | 'procurement_receipt'; // E — وصل استلام مشتريات محلية (087; issued only once stock is posted)

/** Documents that represent an actual stock movement, so may carry an OFFICIAL receipt. */
const OFFICIAL_RECEIPT_KINDS: readonly MovementDocumentKind[] =
  ['supply_dispatch', 'return_shipment', 'procurement_receipt'];

/** True when this document kind may be printed as an official receipt at all. */
export function isOfficialReceiptKind(kind: MovementDocumentKind): boolean {
  return OFFICIAL_RECEIPT_KINDS.includes(kind);
}

/**
 * Versioned internal QR namespace. Deliberately NOT the public medicine QR
 * contract (features/qr/PublicQrScreen) — internal movement receipts must never
 * resolve through a public page.
 */
export const MOVEMENT_QR_NAMESPACE = 'phxmv';
export const MOVEMENT_QR_VERSION = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTraceUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export interface MovementQrPayload {
  kind: MovementDocumentKind;
  /** The immutable database uuid. Opaque — carries no operational meaning. */
  id: string;
}

const KIND_CODES: Record<MovementDocumentKind, string> = {
  supply_request: 'sreq',
  supply_dispatch: 'sdsp',
  return_request: 'rreq',
  return_shipment: 'rshp',
  procurement_receipt: 'prcp',
};
const CODE_KINDS: Record<string, MovementDocumentKind> = Object.fromEntries(
  Object.entries(KIND_CODES).map(([k, v]) => [v, k as MovementDocumentKind]),
) as Record<string, MovementDocumentKind>;

/**
 * Build the QR payload for a receipt.
 *
 * Encodes ONLY the namespace, version, document kind and opaque id. No material
 * list, no quantities, no institution name, no user identity, no price — a
 * printed receipt may be photographed by anyone, so the code itself must leak
 * nothing. Every lookup re-reads the document through RLS.
 */
export function buildMovementQrPayload(kind: MovementDocumentKind, id: string): string {
  if (!isTraceUuid(id)) throw new Error('movement QR requires the immutable uuid trace key');
  return `${MOVEMENT_QR_NAMESPACE}:${MOVEMENT_QR_VERSION}:${KIND_CODES[kind]}:${id}`;
}

/** Parse a scanned payload. Returns null for anything that is not ours. */
export function parseMovementQrPayload(raw: string): MovementQrPayload | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split(':');
  if (parts.length !== 4) return null;
  const [namespace, version, code, id] = parts;
  if (namespace !== MOVEMENT_QR_NAMESPACE) return null;
  // Unknown FUTURE versions are rejected rather than guessed at.
  if (Number(version) !== MOVEMENT_QR_VERSION) return null;
  const kind = CODE_KINDS[code];
  if (!kind) return null;
  if (!isTraceUuid(id)) return null;
  return { kind, id };
}

/**
 * How an operator-typed number must be presented. Never "serial", never
 * "document number" on its own — the label has to say it is not controlled.
 */
export const EXTERNAL_REFERENCE_LABEL_KEY = 'mv_external_reference';

/** Short, stable, human-quotable form of the canonical key for print/screen. */
export function shortTraceKey(id: string): string {
  return isTraceUuid(id) ? id.slice(0, 8).toUpperCase() : '';
}
