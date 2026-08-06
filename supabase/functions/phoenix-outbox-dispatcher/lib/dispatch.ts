// Pure dispatch orchestration for phoenix-outbox-dispatcher (D3-2B).
//
// ONE cycle = one claim call, then a strictly sequential pass over exactly
// the rows that call returned, routing each row's single processing outcome
// to exactly one terminal-or-release operation. That is the whole module.
//
// What this file deliberately does NOT do:
//
//   * no clock, environment, network, database, or filesystem access;
//   * no identifier generation — the lease token is caller-supplied, so a
//     caller (and every test) fully controls lease identity;
//   * no retry, no backoff, no polling loop, no timer, no scheduler, no
//     background execution. Retry policy and backoff already live in the
//     D3-1 database foundation, which is the single source of truth for
//     them; duplicating either here would create a second, divergent one;
//   * no wiring to the D3-2A HTTP surface. index.ts and lib/handler.ts are
//     untouched by D3-2B and do not reference this module. Deciding when a
//     cycle runs is a later, separately authorized step.
//
// The client is dependency-injected as an OutboxRpcClient, so this module
// holds no credential, no connection, and no transport of any kind. See
// docs/phoenix/D3-2B-DISPATCH-ORCHESTRATION-INTEGRATION.md.

import type { ClaimedOutboxEvent, OutboxRpcClient } from "./rpc-client.ts";

/**
 * The single outcome a processor reports for one claimed row.
 *
 * Exactly one of three, and exactly one per row:
 *   completed — the side effect succeeded and must never be repeated;
 *   failed    — it did not; the database decides retry vs. dead-letter;
 *   released  — nothing was attempted; hand the row back untouched, which
 *               deliberately does not burn an attempt.
 */
export type ProcessOutcome =
  | { readonly kind: "completed" }
  | {
    readonly kind: "failed";
    readonly errorCode: string | null;
    readonly errorSummary: string | null;
  }
  | { readonly kind: "released" };

/**
 * Caller-supplied side effect for one claimed row. It must resolve with an
 * outcome or reject; it must never resolve with anything else (see the
 * unknown-outcome guard in runDispatchCycle).
 */
export type EventProcessor = (
  event: ClaimedOutboxEvent,
) => Promise<ProcessOutcome>;

export interface DispatchCycleInput {
  readonly client: OutboxRpcClient;
  readonly consumerKey: string;
  /** Passed through unchanged to the claim call and to EVERY finalization. */
  readonly leaseToken: string;
  readonly batchSize: number;
  readonly processEvent: EventProcessor;
}

/**
 * Counts for one cycle. Returned ONLY when the cycle completed in full:
 * every claimed row was processed and finalized without any error. A cycle
 * that threw has no summary at all — see the exception contract below.
 *
 * Invariant: completed + failed + released === claimed on every returned
 * summary, because each claimed row is routed exactly once.
 */
export interface DispatchCycleSummary {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly released: number;
}

/**
 * Runs exactly one dispatch cycle.
 *
 * Sequence, deterministic and non-concurrent:
 *
 *   1. Call claimBatch once, passing consumerKey, leaseToken and batchSize
 *      through unchanged. Never called a second time in the same cycle.
 *   2. For each claimed row, in the exact order the claim returned them,
 *      await processEvent, then route its one outcome to exactly one of
 *      markCompleted / markFailed / releaseLease, with the SAME leaseToken.
 *   3. Return the counts.
 *
 * EXCEPTION CONTRACT — fail-closed, no invention, no swallowing:
 *
 *   * claimBatch rejects  -> the error propagates and nothing else is
 *     called. No row was leased, so there is nothing to finalize.
 *   * processEvent rejects -> the error propagates immediately. The row is
 *     NOT marked completed and NOT marked failed: this module does not know
 *     whether the side effect happened, and guessing either way would
 *     either lose an event or double-apply one. Nor is it released, because
 *     an immediate release would hand a possibly-half-applied row straight
 *     back for instant reprocessing. It is left leased ON PURPOSE, so the
 *     lease expires on the database's own schedule and the row is reclaimed
 *     later — reclaim by expiry does not burn an attempt, which is exactly
 *     the conservative behavior wanted for an unknown-state row.
 *   * markCompleted / markFailed / releaseLease rejects -> the error
 *     propagates immediately. Remaining rows are NOT processed, and no
 *     partial or optimistic summary is manufactured. Those remaining rows
 *     are still leased and follow the same expiry-then-reclaim path.
 *   * an outcome this module does not recognize -> treated as an unknown
 *     terminal state: it throws, calls no finalization for that row, and
 *     does not continue to later rows.
 *
 * In every one of those cases the caller sees the original error and no
 * summary. Unfinalized rows are deliberately left for lease expiry and
 * later reclaim; that is the designed recovery path, not a leak.
 */
export async function runDispatchCycle(
  input: DispatchCycleInput,
): Promise<DispatchCycleSummary> {
  const { client, consumerKey, leaseToken, batchSize, processEvent } = input;

  // (1) Exactly one claim per cycle. A rejection here reaches the caller
  // untouched, with no other call having been made.
  const claimed = await client.claimBatch({
    consumerKey,
    leaseToken,
    batchSize,
  });

  let completed = 0;
  let failed = 0;
  let released = 0;

  // (2) Strictly sequential: `await` inside the loop is the point. Rows are
  // finalized one at a time, in claim order, so a rejection at row N leaves
  // rows N+1.. untouched and unprocessed rather than racing them.
  for (const event of claimed) {
    const outcome = await processEvent(event);

    if (outcome.kind === "completed") {
      await client.markCompleted({
        consumerKey,
        deliveryStateId: event.deliveryStateId,
        leaseToken,
      });
      completed += 1;
      continue;
    }

    if (outcome.kind === "failed") {
      await client.markFailed({
        consumerKey,
        deliveryStateId: event.deliveryStateId,
        leaseToken,
        errorCode: outcome.errorCode,
        errorSummary: outcome.errorSummary,
      });
      failed += 1;
      continue;
    }

    if (outcome.kind === "released") {
      await client.releaseLease({
        consumerKey,
        deliveryStateId: event.deliveryStateId,
        leaseToken,
      });
      released += 1;
      continue;
    }

    // Unknown outcome: fail closed. No finalization is attempted for this
    // row and the cycle stops here rather than guessing a terminal state
    // for it or silently skipping it and reporting a clean summary.
    throw new Error(
      `unknown dispatch outcome: ${
        JSON.stringify((outcome as { kind: unknown }).kind)
      }`,
    );
  }

  // (3) Reached only when every claimed row was routed exactly once.
  return { claimed: claimed.length, completed, failed, released };
}
