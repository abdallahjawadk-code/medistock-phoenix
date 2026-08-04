/**
 * OUTLET-RETURN-COMPOSER — the local return draft, keyed on the DISPATCH LINE.
 *
 * A return is built from PROVENANCE, never typed. Every draft line's identity is
 * an `originalDispatchLineId` the outlet actually received (070), and migration
 * 071's ADD-LINE RPC makes that column mandatory — so a free-text return is
 * impossible in the schema as well as in this UI. Nothing in this module calls
 * an RPC or touches Supabase: a draft lives entirely in memory until the
 * operator confirms, which is what makes "Cancel persists nothing" true by
 * construction rather than by discipline.
 *
 * Caps come from outlet-return-model.safeReturnable (received − returned −
 * active reservation) — the same number the server enforces. This module shows
 * that number before submit; the server stays the authority.
 */
import {
  safeReturnable, validateReturnLine,
  type ReturnableSource, type ExistingReturnLine, type ReturnValidationIssue,
} from './outlet-return-model';

/**
 * A returnable dispatch line, enriched with the immutable material and
 * provenance fields the picker displays. Everything here is a server snapshot;
 * none of it is operator-typed.
 */
export interface OutletReturnableLine extends ReturnableSource {
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  nationalCode: string | null;
  internalBatchReference: string | null;
  /** Which dispatch this line arrived on — the provenance the operator reads. */
  dispatchNumber: string | null;
  dispatchSentAt: string | null;
}

/** One composed return line, before anything is persisted. */
export interface OutletReturnDraftLine {
  /**
   * Stable per-line key generated ONCE when the line is added. Serves two
   * roles: the local trace key for retry reconciliation and table identity,
   * AND (156) the entityId fed into operation-token.ts's operationToken() to
   * derive the RPC's p_request_id — stable across a retry of this exact
   * line, different the instant any of its mutation-relevant fields change.
   * 071's add-line is still structurally idempotent-by-conflict on the
   * unique (return_request_id, original_dispatch_line_id) index regardless;
   * 156's token turns a retry of that conflict into a clean replay instead
   * of a raw 23505.
   */
  idempotencyKey: string;
  /** The mandatory 071 provenance anchor. */
  originalDispatchLineId: string;
  scientificName: string;
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  unit: string | null;
  nationalCode: string | null;
  batchNumber: string | null;
  internalBatchReference: string | null;
  expiryDate: string | null;
  dispatchNumber: string | null;
  quantity: number;
  /** safeReturnable when the line was added or last revalidated. */
  maxQuantity: number;
  reasonCode: string;
  reasonText: string | null;
}

export interface OutletReturnDraftIssue {
  idempotencyKey: string;
  code: ReturnValidationIssue['code'] | 'duplicate_provenance' | 'source_unavailable';
}

/** Build a draft line from an authoritative returnable source. Identity is never typed. */
export function draftLineFromReturnable(
  source: OutletReturnableLine,
  quantity: number,
  reasonCode: string,
  reasonText: string | null,
  idempotencyKey: string,
  existingLines: readonly ExistingReturnLine[] = [],
): OutletReturnDraftLine {
  return {
    idempotencyKey,
    originalDispatchLineId: source.dispatchLineId,
    scientificName: source.scientificName,
    tradeName: source.tradeName,
    concentration: source.concentration,
    dosageForm: source.dosageForm,
    unit: source.unit,
    nationalCode: source.nationalCode,
    batchNumber: source.batchNumber,
    internalBatchReference: source.internalBatchReference,
    expiryDate: source.expiryDate,
    dispatchNumber: source.dispatchNumber,
    quantity,
    maxQuantity: safeReturnable(source, existingLines),
    reasonCode,
    reasonText,
  };
}

/**
 * Validate the whole draft against the CURRENT returnable sources.
 *
 * Each line is re-checked against its live source (caps move as other operators
 * return the same lot), and a dispatch line may appear at most once — 071's
 * unique index would reject a second add-line for it anyway, so surfacing it
 * here is the honest, earlier signal.
 */
export function validateOutletReturnDraft(
  lines: readonly OutletReturnDraftLine[],
  sources: readonly OutletReturnableLine[],
  existingLines: readonly ExistingReturnLine[] = [],
): OutletReturnDraftIssue[] {
  const byId = new Map(sources.map(s => [s.dispatchLineId, s]));
  const seen = new Set<string>();
  const issues: OutletReturnDraftIssue[] = [];

  for (const line of lines) {
    const source = byId.get(line.originalDispatchLineId);
    if (!source) {
      issues.push({ idempotencyKey: line.idempotencyKey, code: 'source_unavailable' });
      continue;
    }
    for (const issue of validateReturnLine(source, line.quantity, line.reasonCode, line.reasonText, existingLines)) {
      issues.push({ idempotencyKey: line.idempotencyKey, code: issue.code });
    }
    if (seen.has(line.originalDispatchLineId)) {
      issues.push({ idempotencyKey: line.idempotencyKey, code: 'duplicate_provenance' });
    } else {
      seen.add(line.originalDispatchLineId);
    }
  }

  return issues;
}

export function outletReturnDraftConfirmable(
  lines: readonly OutletReturnDraftLine[],
  sources: readonly OutletReturnableLine[],
  existingLines: readonly ExistingReturnLine[] = [],
): boolean {
  return lines.length > 0 && validateOutletReturnDraft(lines, sources, existingLines).length === 0;
}

/**
 * Recompute each line's cap against freshly reloaded sources immediately before
 * creation. Returns the updated lines and the keys whose cap changed, so the UI
 * can flag exactly what moved under the operator.
 */
export function revalidateOutletReturnDraft(
  lines: readonly OutletReturnDraftLine[],
  sources: readonly OutletReturnableLine[],
  existingLines: readonly ExistingReturnLine[] = [],
): { lines: OutletReturnDraftLine[]; changed: string[] } {
  const byId = new Map(sources.map(s => [s.dispatchLineId, s]));
  const changed: string[] = [];
  const next = lines.map(line => {
    const source = byId.get(line.originalDispatchLineId);
    const cap = source ? safeReturnable(source, existingLines) : 0;
    if (cap !== line.maxQuantity) {
      changed.push(line.idempotencyKey);
      return { ...line, maxQuantity: cap };
    }
    return line;
  });
  return { lines: next, changed };
}

/**
 * Decide what a retry may safely re-send.
 *
 * add-line is idempotent-by-conflict, so re-sending a line that already landed
 * is not a double-post — but it wastes a round trip and muddies the result. The
 * canonical basis for retry is the server's own lines: re-send only the draft
 * lines whose dispatch-line provenance is absent server-side.
 */
export function planOutletReturnRetry(
  draft: readonly OutletReturnDraftLine[],
  serverDispatchLineIds: readonly string[],
): { toSend: OutletReturnDraftLine[]; alreadyPresent: string[] } {
  const present = new Set(serverDispatchLineIds);
  const toSend: OutletReturnDraftLine[] = [];
  const alreadyPresent: string[] = [];
  for (const line of draft) {
    if (present.has(line.originalDispatchLineId)) alreadyPresent.push(line.idempotencyKey);
    else toSend.push(line);
  }
  return { toSend, alreadyPresent };
}
