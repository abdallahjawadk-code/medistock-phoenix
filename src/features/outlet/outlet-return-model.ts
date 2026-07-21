/**
 * OUTLET-CORRIDOR-071 §2B/§4 — what an outlet may return, and how much.
 *
 * The SERVER is the authority. Migration 071's ADD-LINE RPC caps a return at
 * `received_quantity - returned_quantity` on the originating dispatch line and
 * raises `requested_quantity_exceeds_returnable_cap` otherwise; its SEND RPC
 * consumes that cap under a row lock so two concurrent sends cannot both pass.
 * Nothing here replaces those checks — this module exists so the operator is
 * shown a truthful number BEFORE submitting, instead of discovering the cap by
 * being rejected.
 *
 * One subtlety drives the whole file: `returned_quantity` is incremented when a
 * line is SENT, not when it is added to a request. So a request line that has
 * been created but not yet shipped is a RESERVATION the server counter does not
 * yet reflect. Ignoring it would let an operator build two requests that each
 * look valid alone but cannot both ship. §4 therefore defines:
 *
 *   safeReturnable = min(
 *     accepted − completed returns − active reservations,
 *     current server-confirmed returnable stock
 *   )
 *
 * Both terms here are read from server rows. Nothing is reconstructed: the
 * multi-hop provenance the mandate warns about is resolved by the server, which
 * derives original_inbound_movement_id and source_outlet_stock_id itself from
 * the single original_dispatch_line_id the UI passes.
 */

/** Reason codes accepted by 071. Mirrors the orrl_reason_code_chk constraint. */
export const RETURN_REASON_CODES = [
  'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',
  'recalled', 'quality_issue', 'temperature_excursion', 'other',
] as const;

export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number];

export function isReturnReasonCode(v: string): v is ReturnReasonCode {
  return (RETURN_REASON_CODES as readonly string[]).includes(v);
}

/**
 * Dispatch-line statuses that represent a COMPLETED receipt at the outlet.
 * 071 refuses to anchor a return to anything else
 * (`original_dispatch_line_not_a_completed_receipt`).
 */
const ACCEPTED_DISPATCH_STATUSES = new Set(['accepted', 'accepted_with_difference']);

/**
 * Return-request-line statuses that still hold a claim on the cap. 071 treats
 * 'pending' and 'approved' as the live set when cancelling; a partially
 * fulfilled line still reserves its unshipped remainder.
 */
const LIVE_RETURN_LINE_STATUSES = new Set(['pending', 'approved', 'partially_fulfilled']);

/** The outlet-held lot a return may be anchored to — server columns only. */
export interface ReturnableSource {
  dispatchLineId: string;
  scientificName: string;
  batchNumber: string | null;
  expiryDate: string | null;
  unit: string | null;
  /** Null until the outlet has actually received the line. */
  receivedQuantity: number | null;
  /** Server counter, incremented at SEND. Never recompute it. */
  returnedQuantity: number;
  /** The dispatch line's own status. */
  status: string;
}

/** An existing return-request line, as read back from the server. */
export interface ExistingReturnLine {
  originalDispatchLineId: string;
  requestedQuantity: number;
  approvedQuantity: number | null;
  fulfilledQuantity: number;
  status: string;
}

/**
 * Quantity already spoken for by return lines that exist but have not shipped.
 *
 * An approved quantity supersedes the requested one once a reviewer has set it.
 * Already-fulfilled quantity is excluded because it is, by then, part of the
 * dispatch line's own `returned_quantity`.
 */
export function activeReservation(
  lines: readonly ExistingReturnLine[],
  dispatchLineId: string,
): number {
  return lines
    .filter(l => l.originalDispatchLineId === dispatchLineId && LIVE_RETURN_LINE_STATUSES.has(l.status))
    .reduce((sum, l) => {
      const claimed = l.approvedQuantity ?? l.requestedQuantity;
      const outstanding = claimed - l.fulfilledQuantity;
      return sum + (outstanding > 0 ? outstanding : 0);
    }, 0);
}

/**
 * How much of this lot the outlet may still safely ask to return.
 *
 * Clamped at zero: a negative cap is meaningless to an operator, and any
 * genuine inconsistency is the server's to report, not this function's to
 * invent.
 */
export function safeReturnable(
  source: ReturnableSource,
  existingLines: readonly ExistingReturnLine[] = [],
): number {
  if (!ACCEPTED_DISPATCH_STATUSES.has(source.status)) return 0;
  if (source.receivedQuantity === null) return 0;

  const reserved = activeReservation(existingLines, source.dispatchLineId);
  const remaining = source.receivedQuantity - source.returnedQuantity - reserved;
  return remaining > 0 ? remaining : 0;
}

/** Only lots the outlet actually received, and still has headroom on, are offered. */
export function isReturnable(
  source: ReturnableSource,
  existingLines: readonly ExistingReturnLine[] = [],
): boolean {
  return safeReturnable(source, existingLines) > 0;
}

export interface ReturnValidationIssue {
  code:
    | 'not_returnable'
    | 'quantity_not_positive'
    | 'quantity_not_integer'
    | 'quantity_exceeds_safe_returnable'
    | 'reason_code_required'
    | 'reason_code_invalid'
    | 'reason_text_required';
}

/**
 * Validate one proposed return line.
 *
 * A reason is mandatory for every return — unlike a receipt, where it is only
 * required on a discrepancy. 'other' additionally demands free text, because
 * an unexplained 'other' is indistinguishable from no reason at all.
 */
export function validateReturnLine(
  source: ReturnableSource,
  quantity: number,
  reasonCode: string,
  reasonText: string | null,
  existingLines: readonly ExistingReturnLine[] = [],
): ReturnValidationIssue[] {
  const issues: ReturnValidationIssue[] = [];
  const cap = safeReturnable(source, existingLines);

  if (cap <= 0) {
    issues.push({ code: 'not_returnable' });
  } else if (!Number.isFinite(quantity) || quantity <= 0) {
    issues.push({ code: 'quantity_not_positive' });
  } else if (!Number.isInteger(quantity)) {
    issues.push({ code: 'quantity_not_integer' });
  } else if (quantity > cap) {
    issues.push({ code: 'quantity_exceeds_safe_returnable' });
  }

  if (!reasonCode) {
    issues.push({ code: 'reason_code_required' });
  } else if (!isReturnReasonCode(reasonCode)) {
    issues.push({ code: 'reason_code_invalid' });
  } else if (reasonCode === 'other' && !reasonText?.trim()) {
    issues.push({ code: 'reason_text_required' });
  }

  return issues;
}

/**
 * The subset safe to submit in bulk, each at its full remaining cap.
 *
 * Bulk return is deliberately narrower than bulk receipt: a return always
 * carries a reason, and a reason is a per-lot human judgement. So bulk is
 * offered ONLY once the operator has chosen one reason to apply, and only over
 * lots that need no further decision.
 */
export function bulkReturnableSources(
  sources: readonly ReturnableSource[],
  reasonCode: string,
  reasonText: string | null = null,
  existingLines: readonly ExistingReturnLine[] = [],
): ReturnableSource[] {
  return sources.filter(s => {
    const cap = safeReturnable(s, existingLines);
    return cap > 0 && validateReturnLine(s, cap, reasonCode, reasonText, existingLines).length === 0;
  });
}
