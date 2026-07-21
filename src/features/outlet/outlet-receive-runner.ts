/**
 * OUTLET-CORRIDOR-070 §2A — receipt orchestration and idempotency.
 *
 * THE CORRECTION THIS MODULE EXISTS FOR
 *
 * An earlier version minted a fresh request id on every ATTEMPT. That is
 * exactly backwards. The 070/065 RPCs deduplicate on `p_request_id`: replaying
 * a token returns the original result instead of posting again. So a token that
 * changes per attempt makes every retry a NEW logical operation — and the one
 * case idempotency exists to survive, a server success whose response was lost,
 * becomes a guaranteed double-post of stock.
 *
 * The rule here instead:
 *
 *   ONE stable token per logical receipt line, reused across every retry,
 *   released ONLY when a canonical server reload proves the line was received.
 *
 * Note the asymmetry: we release on proof of SUCCESS, never on failure — not
 * even on a failure that looks definitive. A client cannot distinguish "the
 * server rejected this" from "the server committed this and the response was
 * lost". Holding the token is safe in both readings; minting a new one is only
 * safe in one. So failures, ambiguous or not, always keep the token.
 *
 * The orchestration lives here rather than in the component so it can be driven
 * directly in tests with an injected writer — this codebase has no DOM test
 * environment, and source-scanning a component cannot prove that a retry
 * actually reuses a token.
 */

export interface ReceiveRpcInput {
  requestId: string;
  dispatchLineId: string;
  receivedQuantity: number;
  differenceReason: string | null;
}

export interface ReceiveRpcResult {
  ok: boolean;
  error?: string;
}

/** The single injected writer. Production passes the 070 receive RPC. */
export type ReceiveWriter = (input: ReceiveRpcInput) => Promise<ReceiveRpcResult>;

/** A line as the server reports it after a canonical reload. */
export interface ServerLineState {
  id: string;
  receivedQuantity: number | null;
}

/**
 * Stable per-line idempotency tokens.
 *
 * `tokenFor` mints once and then returns the same value forever, so a caller
 * cannot accidentally retry under a new identity. Releasing is deliberately not
 * exposed per-line: the only way a token leaves the store is
 * `releaseConfirmed`, driven by server truth.
 */
export class ReceiptTokenStore {
  private readonly tokens = new Map<string, string>();

  constructor(private readonly mint: () => string) {}

  /** The stable token for this logical receipt line. Minted at most once. */
  tokenFor(lineId: string): string {
    const existing = this.tokens.get(lineId);
    if (existing !== undefined) return existing;
    const minted = this.mint();
    this.tokens.set(lineId, minted);
    return minted;
  }

  has(lineId: string): boolean {
    return this.tokens.has(lineId);
  }

  get size(): number {
    return this.tokens.size;
  }

  /**
   * Drop tokens for lines the SERVER now reports as received.
   *
   * This is the only release path, and it runs off a canonical reload — the
   * outcome is proven, so the token has done its job and a future receipt of
   * the same line would be a genuinely new operation.
   */
  releaseConfirmed(serverLines: readonly ServerLineState[]): string[] {
    const released: string[] = [];
    for (const line of serverLines) {
      if (line.receivedQuantity !== null && this.tokens.delete(line.id)) {
        released.push(line.id);
      }
    }
    return released;
  }
}

/** Lines the server has already confirmed — never re-attempt these. */
export function confirmedLineIds(serverLines: readonly ServerLineState[]): Set<string> {
  return new Set(serverLines.filter(l => l.receivedQuantity !== null).map(l => l.id));
}

export interface ReceiveSelection {
  lineId: string;
  receivedQuantity: number;
  differenceReason: string | null;
}

export interface SingleReceiveOutcome extends ReceiveRpcResult {
  /** The token actually sent, so callers and tests can assert its stability. */
  requestId: string;
}

/** Receive one line, under its stable token. */
export async function runSingleReceive(
  write: ReceiveWriter,
  store: ReceiptTokenStore,
  input: ReceiveSelection,
): Promise<SingleReceiveOutcome> {
  const requestId = store.tokenFor(input.lineId);
  const result = await write({
    requestId,
    dispatchLineId: input.lineId,
    receivedQuantity: input.receivedQuantity,
    differenceReason: input.differenceReason,
  });
  return { ...result, requestId };
}

export type BulkSkipReason = 'already_confirmed' | 'not_eligible';

export interface BulkReceiveOutcome {
  attempted: string[];
  succeeded: string[];
  failed: Array<{ lineId: string; error: string | undefined }>;
  skipped: Array<{ lineId: string; reason: BulkSkipReason }>;
}

export interface BulkReceiveOptions {
  /** Explicitly chosen lines. Nothing outside this set is ever written. */
  selected: readonly ReceiveSelection[];
  /** Lines the shared receive-model judged safe. */
  eligibleIds: ReadonlySet<string>;
  /** Lines the server already confirmed — excluded from any retry. */
  confirmedIds: ReadonlySet<string>;
  /** Reports attempts RESOLVED, successes and failures alike. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Receive a chosen set of lines, one at a time, each under its stable token.
 *
 * Two exclusions are enforced here rather than left to the caller, because both
 * are load-bearing on a RETRY — the pass where a hand-rolled loop is most
 * likely to get them wrong:
 *
 *   - a line the server already confirmed is never attempted again;
 *   - a line outside the eligible set is never written, even if selected.
 *
 * The intersection is what mutates: explicitly selected AND eligible AND not
 * already confirmed.
 */
export async function runBulkReceive(
  write: ReceiveWriter,
  store: ReceiptTokenStore,
  options: BulkReceiveOptions,
): Promise<BulkReceiveOutcome> {
  const { selected, eligibleIds, confirmedIds, onProgress } = options;

  const outcome: BulkReceiveOutcome = { attempted: [], succeeded: [], failed: [], skipped: [] };

  const actionable = selected.filter(s => {
    if (confirmedIds.has(s.lineId)) {
      outcome.skipped.push({ lineId: s.lineId, reason: 'already_confirmed' });
      return false;
    }
    if (!eligibleIds.has(s.lineId)) {
      outcome.skipped.push({ lineId: s.lineId, reason: 'not_eligible' });
      return false;
    }
    return true;
  });

  let done = 0;
  for (const item of actionable) {
    const result = await runSingleReceive(write, store, item);
    outcome.attempted.push(item.lineId);
    if (result.ok) outcome.succeeded.push(item.lineId);
    else outcome.failed.push({ lineId: item.lineId, error: result.error });
    done += 1;
    onProgress?.(done, actionable.length);
  }

  return outcome;
}
