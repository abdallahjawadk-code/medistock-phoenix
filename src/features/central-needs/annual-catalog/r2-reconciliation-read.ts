/**
 * R2-1 — isolated, read-only evidence reconciliation (no client, SQL or UI).
 * Inputs must originate from separately authorized canonical reads. This
 * function NEVER attributes a physical transfer to an annual quota by name,
 * national code, temporal proximity, or destination alone. No approval policy
 * exists yet for quota execution D, so neither D nor a remaining-to-execute
 * quantity may be emitted.
 */
export interface R2Scope {
  readonly ownerOrgId: string;
  readonly planningYear: number;
  readonly beneficiaryOrgId: string;
  readonly canonicalItemId: string;
  readonly unit: string;
}
export interface R2TransferLine {
  readonly id: string;
  readonly transferId: string;
  readonly sourceOrgId: string;
  readonly destinationOrgId: string;
  readonly canonicalItemId: string;
  readonly unit: string;
  readonly status: 'in_transit' | 'received' | 'received_with_difference' | 'rejected';
  readonly sentQuantity: number;
  readonly receivedQuantity: number | null;
  readonly differenceReason: string | null;
  readonly receivedAt: string | null;
}
export interface R2ReadInput {
  readonly scope: R2Scope;
  readonly transfers: readonly R2TransferLine[];
}
export interface R2ReadSummary {
  readonly status: 'OBSERVED_UNATTRIBUTED_READ_ONLY';
  readonly sentObserved: number;
  readonly receivedKnownSubtotal: number;
  readonly receivedConfirmedTotal: number | null;
  readonly unresolvedLineCount: number;
  readonly rejectedLineCount: number;
  readonly differentLineCount: number;
  readonly transferLineIds: readonly string[];
  readonly quotaExecution: null;
  readonly remainingToExecute: null;
  readonly allocationLink: 'UNAVAILABLE_NO_VERIFIED_ATTRIBUTION';
  readonly stockBalance: null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function check(ok: boolean, code: string): asserts ok {
  if (!ok) throw new Error('r2_read_' + code);
}
function nonnegSafe(n: number): boolean { return Number.isSafeInteger(n) && n >= 0; }
export function reconcileObservedCentralTransfers(input: R2ReadInput): R2ReadSummary {
  const scope = input?.scope;
  check(!!scope && UUID.test(scope.ownerOrgId) && UUID.test(scope.beneficiaryOrgId) &&
    scope.ownerOrgId !== scope.beneficiaryOrgId &&
    UUID.test(scope.canonicalItemId) &&
    Number.isSafeInteger(scope.planningYear) && scope.planningYear >= 2000 &&
    scope.planningYear <= 2100 && typeof scope.unit === 'string' && scope.unit.trim().length > 0,
    'scope_invalid');
  check(Array.isArray(input.transfers) && input.transfers.length <= 10_000, 'list_invalid');
  const ids = new Set<string>();
  let sent = 0, received = 0, pending = 0, rejected = 0, different = 0;
  for (const line of input.transfers) {
    check(!!line && UUID.test(line.id) && UUID.test(line.transferId) && !ids.has(line.id),
      'line_invalid');
    ids.add(line.id);
    check(line.sourceOrgId === scope.ownerOrgId &&
      line.destinationOrgId === scope.beneficiaryOrgId &&
      line.canonicalItemId === scope.canonicalItemId && line.unit === scope.unit,
      'line_scope_mismatch');
    check(nonnegSafe(line.sentQuantity) && line.sentQuantity > 0 &&
      (line.receivedQuantity === null || (nonnegSafe(line.receivedQuantity) &&
        line.receivedQuantity <= line.sentQuantity)), 'quantity_invalid');
    if (line.status === 'in_transit') {
      check(line.receivedQuantity === null && line.differenceReason === null &&
        line.receivedAt === null, 'pending_status_invalid');
      pending++;
    } else {
      check(typeof line.receivedAt === 'string' && Number.isFinite(Date.parse(line.receivedAt)),
        'resolved_without_timestamp');
      if (line.status === 'received') {
        check(line.receivedQuantity === line.sentQuantity, 'receipt_invalid');
      } else if (line.status === 'received_with_difference') {
        check(line.receivedQuantity !== null && line.receivedQuantity < line.sentQuantity &&
          !!line.differenceReason?.trim(), 'difference_invalid');
        different++;
      } else if (line.status === 'rejected') {
        check(line.receivedQuantity === 0 && !!line.differenceReason?.trim(), 'rejection_invalid');
        rejected++;
      } else {
        check(false, 'unknown_status');
      }
      received += line.receivedQuantity ?? 0;
    }
    sent += line.sentQuantity;
    check(Number.isSafeInteger(sent) && Number.isSafeInteger(received), 'overflow');
  }
  return Object.freeze({
    status: 'OBSERVED_UNATTRIBUTED_READ_ONLY', sentObserved: sent,
    receivedKnownSubtotal: received, receivedConfirmedTotal: pending ? null : received,
    unresolvedLineCount: pending, rejectedLineCount: rejected, differentLineCount: different,
    transferLineIds: Object.freeze([...ids]), quotaExecution: null, remainingToExecute: null,
    allocationLink: 'UNAVAILABLE_NO_VERIFIED_ATTRIBUTION', stockBalance: null,
  });
}
