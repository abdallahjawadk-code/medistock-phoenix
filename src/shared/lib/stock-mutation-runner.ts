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
}

/** Run one mutation under its derived, stable token. */
export async function runStockMutation<P>(
  write: TokenedWriter<P>,
  kind: string,
  item: MutationItem<P>,
  deriveToken: TokenDeriver = operationToken,
): Promise<SingleMutationOutcome> {
  const requestId = await deriveToken({
    kind, entityId: item.entityId, generation: item.generation,
  });
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
export async function runStockMutations<P>(
  write: TokenedWriter<P>,
  options: RunOptions<P>,
): Promise<BulkMutationOutcome> {
  const { kind, items, eligibleIds, confirmedIds, onProgress, deriveToken = operationToken } = options;

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
    const result = await runStockMutation(write, kind, item, deriveToken);
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
