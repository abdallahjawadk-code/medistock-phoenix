/**
 * MOVEMENT-COMPOSER-A — what the institution may accept, and in bulk or not.
 *
 * "Accept all safe eligible lines" is a convenience for the ordinary case: a
 * consignment that arrived exactly as dispatched. It must never become a way to
 * wave through the lines that actually need a human decision.
 *
 * So bulk acceptance is deliberately CONSERVATIVE. Anything expired, already
 * partly handled, quantity-adjusted, flagged, or in an unexpected state drops
 * out of the bulk set and has to be received individually, where the operator
 * states a quantity and a reason.
 */

export interface ReceivableLine {
  id: string;
  scientificName: string;
  batchNumber: string | null;
  expiryDate: string | null;
  sentQuantity: number;
  receivedQuantity: number | null;
  status: string;
  differenceReason: string | null;
}

export type ReceiveExclusion =
  | 'already_received'
  | 'not_in_transit'
  | 'expired'
  | 'quantity_adjusted'
  | 'has_difference_reason'
  | 'non_positive_quantity';

export interface ReceiveEligibility {
  lineId: string;
  /** May be accepted by the bulk action with no further input. */
  bulkEligible: boolean;
  /** May still be received individually. */
  individuallyReceivable: boolean;
  exclusions: ReceiveExclusion[];
}

/** Statuses that represent a line still awaiting receipt. */
const IN_TRANSIT_STATUSES = new Set(['in_transit', 'sent', 'pending']);

export function isLineExpired(expiryDate: string | null, today: Date = new Date()): boolean {
  if (!expiryDate) return false;
  const expiry = new Date(`${expiryDate}T00:00:00Z`);
  if (Number.isNaN(expiry.getTime())) return false;
  const midnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return expiry < midnight;
}

/**
 * Classify one line.
 *
 * `proposedQuantity` is what the operator typed for an individual receipt; when
 * omitted the line is judged for BULK acceptance at its full sent quantity.
 */
export function assessReceive(
  line: ReceivableLine,
  today: Date = new Date(),
  proposedQuantity?: number,
): ReceiveEligibility {
  const exclusions: ReceiveExclusion[] = [];

  if (line.receivedQuantity !== null) exclusions.push('already_received');
  if (!IN_TRANSIT_STATUSES.has(line.status)) exclusions.push('not_in_transit');
  // Expired goods are a decision, never an automatic acceptance — but the
  // institution may still receive them deliberately and record why.
  if (isLineExpired(line.expiryDate, today)) exclusions.push('expired');
  // A pre-existing difference reason means someone already flagged this line.
  if (line.differenceReason) exclusions.push('has_difference_reason');
  if (!Number.isInteger(line.sentQuantity) || line.sentQuantity <= 0) exclusions.push('non_positive_quantity');
  if (proposedQuantity !== undefined && proposedQuantity !== line.sentQuantity) {
    exclusions.push('quantity_adjusted');
  }

  // Whether it can be received AT ALL is a narrower question than whether it is
  // safe to bulk-accept: expiry and flags do not block a deliberate receipt.
  const blocking: ReceiveExclusion[] = ['already_received', 'not_in_transit', 'non_positive_quantity'];
  const individuallyReceivable = !exclusions.some(e => blocking.includes(e));

  return {
    lineId: line.id,
    bulkEligible: exclusions.length === 0,
    individuallyReceivable,
    exclusions,
  };
}

/** The subset the bulk action will act on. Everything else needs a human. */
export function bulkEligibleLines(lines: readonly ReceivableLine[], today: Date = new Date()): ReceivableLine[] {
  return lines.filter(line => assessReceive(line, today).bulkEligible);
}

export interface ReceiveValidationIssue {
  code: 'quantity_not_positive' | 'quantity_not_integer' | 'quantity_exceeds_sent' | 'difference_reason_required';
}

/**
 * Validate one individual receipt.
 *
 * A quantity that differs from what was dispatched is the single most important
 * thing to explain — it is a discrepancy between paper and physical goods — so
 * a reason is mandatory whenever the two disagree.
 */
export function validateReceive(
  line: ReceivableLine,
  receivedQuantity: number,
  differenceReason: string | null,
): ReceiveValidationIssue[] {
  const issues: ReceiveValidationIssue[] = [];

  if (!Number.isFinite(receivedQuantity) || receivedQuantity <= 0) {
    issues.push({ code: 'quantity_not_positive' });
  } else if (!Number.isInteger(receivedQuantity)) {
    issues.push({ code: 'quantity_not_integer' });
  } else if (receivedQuantity > line.sentQuantity) {
    // Receiving more than was dispatched is never a discrepancy to explain —
    // it is impossible, and would corrupt the provenance cap for returns.
    issues.push({ code: 'quantity_exceeds_sent' });
  } else if (receivedQuantity !== line.sentQuantity && !differenceReason?.trim()) {
    issues.push({ code: 'difference_reason_required' });
  }

  return issues;
}
