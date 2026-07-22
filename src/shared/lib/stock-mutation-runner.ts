/**
 * STOCK-MUTATION RUNNER — the one place retry and idempotency are decided.
 *
 * Every stock-moving path in the app (institution receive, direct supply
 * send/receive, direct return send/receive, warehouse dispatch send, outlet
 * receive) funnels through here, so the rules below are stated once instead of
 * re-derived per component:
 *
 *   - the request id is DERIVED, never minted, so it is identical after a
 *     remount, a page reload, or in a second tab (see operation-token.ts);
 *   - a line the server has already confirmed is never attempted again;
 *   - a line outside the eligible set is never written, even if selected;
 *   - progress counts attempts RESOLVED, successes and failures alike.
 *
 * The writer is injected. That is not ceremony: this repo has no DOM test
 * environment, and source-scanning a component cannot prove that a retry
 * reuses a token — a component that mints a fresh uuid per attempt still
 * "looks" idempotent because it does pass a request id. Only driving a real
 * writer against a server that deduplicates tells the two apart.
 */
import {
  operationToken, type OperationIdentity,
} from './operation-token';
import { canonicalIntent, type IntentValue } from './canonical-intent';

/**
 * Remembers attempts whose outcome is not yet canonically known, so the payload
 * cannot be edited underneath an unresolved operation.
 *
 * After an ambiguous failure the client does not know whether the server
 * committed. Retrying the SAME intent is safe — it derives the same token and
 * is deduplicated. Retrying a DIFFERENT intent is not: it derives a different
 * token, so if the first attempt did commit, the second posts on top of it.
 * The ledger refuses that until a canonical reload has reconciled the row.
 *
 * Scope note, stated plainly: this is in-memory, so it constrains the session
 * that made the attempt. It does not need to survive a reload — a reloaded page
 * has no unresolved attempt of its own, and the canonical read it performs on
 * mount IS the reconciliation. Durability across reload is provided by token
 * derivation, not by this ledger.
 */
export class PendingIntentLedger {
  private readonly pending = new Map<string, string>();

  /** True when this entity has an attempt whose outcome is still unknown. */
  isPending(entityId: string): boolean {
    return this.pending.has(entityId);
  }

  pendingIntent(entityId: string): string | undefined {
    return this.pending.get(entityId);
  }

  /** May this intent be submitted for this entity right now? */
  allows(entityId: string, intent: string): boolean {
    const held = this.pending.get(entityId);
    return held === undefined || held === intent;
  }

  record(entityId: string, intent: string): void {
    this.pending.set(entityId, intent);
  }

  /**
   * A canonical reload has been observed, so nothing is ambiguous any more:
   * whatever the server now reports is the truth, and the operator may compose
   * a fresh intent from it.
   */
  reconcile(): void {
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}

export interface MutationResult {
  ok: boolean;
  error?: string;
}

/** Injected writer: receives the derived token plus the path-specific args. */
export type TokenedWriter<P> = (requestId: string, payload: P) => Promise<MutationResult>;

/** Injected token derivation. Production uses operationToken. */
export type TokenDeriver = (identity: OperationIdentity) => Promise<string>;

export interface MutationItem<P> {
  /** The row being mutated — dispatch line, transfer line, shipment line. */
  entityId: string;
  /**
   * Server-derived progress already completed on this row. Drives token
   * stability: unchanged while an attempt is unresolved, advanced once the
   * server confirms, so a later legitimate partial gets its own token.
   */
  generation: number;
  payload: P;
}

export interface SingleMutationOutcome extends MutationResult {
  /** The token actually sent, so callers and tests can assert stability. */
  requestId: string;
}

export type SkipReason = 'already_confirmed' | 'not_eligible';

export interface BulkMutationOutcome {
  attempted: string[];
  succeeded: string[];
  failed: Array<{ entityId: string; error: string | undefined }>;
  skipped: Array<{ entityId: string; reason: SkipReason }>;
}

export interface RunOptions<P> {
  /** Namespaces the token, e.g. 'transfer_receive'. */
  kind: string;
  /** Explicitly chosen rows. Nothing outside this list is ever written. */
  items: readonly MutationItem<P>[];
  /** Rows a domain model judged safe. Omit to treat every item as eligible. */
  eligibleIds?: ReadonlySet<string>;
  /** Rows the server already confirmed — excluded from any retry. */
  confirmedIds?: ReadonlySet<string>;
  onProgress?: (done: number, total: number) => void;
  /** Overridable for tests; defaults to the real derivation. */
  deriveToken?: TokenDeriver;
  /** Guards against editing a payload under an unresolved attempt. */
  ledger?: PendingIntentLedger;
}

/**
 * Run one mutation under its derived, stable token.
 *
 * If the token cannot be derived we report a failure and DO NOT call the
 * writer. That is the fail-closed rule from operation-token.ts carried through
 * to the call site: a mutation sent without a stable token cannot be safely
 * retried, so not sending it is the better outcome. Reporting this instead of
 * throwing also keeps a bulk loop alive — one underivable row must not abandon
 * the rows after it — and keeps callers' `busy` flags from stranding on an
 * exception thrown past their `setBusy(false)`.
 */
export async function runStockMutation<P extends IntentValue>(
  write: TokenedWriter<P>,
  kind: string,
  item: MutationItem<P>,
  deriveToken: TokenDeriver = operationToken,
  ledger?: PendingIntentLedger,
): Promise<SingleMutationOutcome> {
  let intent: string;
  let requestId: string;
  try {
    // The payload IS the mutation-relevant input set, so intent is derived from
    // it rather than restated at each call site — one less thing to forget.
    intent = canonicalIntent(item.payload);
    requestId = await deriveToken({
      kind, entityId: item.entityId, generation: item.generation, intent,
    });
  } catch {
    return { ok: false, error: 'operation_token_unavailable', requestId: '' };
  }

  // Refuse to change the payload underneath an operation whose outcome is
  // still unknown — see PendingIntentLedger.
  if (ledger && !ledger.allows(item.entityId, intent)) {
    return { ok: false, error: 'intent_changed_before_reconciliation', requestId };
  }
  ledger?.record(item.entityId, intent);

  const result = await write(requestId, item.payload);
  return { ...result, requestId };
}

/**
 * Run a chosen set of mutations, one at a time, each under its derived token.
 *
 * The two exclusions are enforced here rather than left to callers because both
 * are load-bearing on a RETRY — the pass where a hand-rolled loop is most
 * likely to get them wrong. What actually mutates is the intersection:
 * explicitly selected AND eligible AND not already confirmed.
 */
export async function runStockMutations<P extends IntentValue>(
  write: TokenedWriter<P>,
  options: RunOptions<P>,
): Promise<BulkMutationOutcome> {
  const {
    kind, items, eligibleIds, confirmedIds, onProgress,
    deriveToken = operationToken, ledger,
  } = options;

  const outcome: BulkMutationOutcome = { attempted: [], succeeded: [], failed: [], skipped: [] };

  const actionable = items.filter(item => {
    if (confirmedIds?.has(item.entityId)) {
      outcome.skipped.push({ entityId: item.entityId, reason: 'already_confirmed' });
      return false;
    }
    if (eligibleIds && !eligibleIds.has(item.entityId)) {
      outcome.skipped.push({ entityId: item.entityId, reason: 'not_eligible' });
      return false;
    }
    return true;
  });

  let done = 0;
  for (const item of actionable) {
    const result = await runStockMutation(write, kind, item, deriveToken, ledger);
    outcome.attempted.push(item.entityId);
    if (result.ok) outcome.succeeded.push(item.entityId);
    else outcome.failed.push({ entityId: item.entityId, error: result.error });
    done += 1;
    onProgress?.(done, actionable.length);
  }

  return outcome;
}

/** Rows the server reports as already carrying a confirmed outcome. */
export function confirmedEntityIds<T extends { id: string }>(
  rows: readonly T[],
  isConfirmed: (row: T) => boolean,
): Set<string> {
  return new Set(rows.filter(isConfirmed).map(r => r.id));
}
