// Portable Outbox consumer-RPC CONTRACT for phoenix-outbox-dispatcher (D3-2B).
//
// This file is types only. It declares the shape of the four consumer
// operations the D3-1 database foundation already exposes, so that
// lib/dispatch.ts can orchestrate them without knowing — or being able to
// reach — any database, transport, or credential.
//
// Absolute boundary (mechanically enforced by lib/static_guards_test.ts,
// which scans every non-test .ts file in this function's directory):
//
//   * no Deno globals, no Node imports, no Postgres driver import;
//   * no Supabase client construction and no remote-procedure invocation;
//   * no URL, no environment access, no credential, no connection string;
//   * no concrete implementation of any kind — there is no runnable code
//     in this file at all, only interfaces and result types.
//
// Method names are deliberately portable camelCase. The underlying SQL
// routine names are NOT written here: a reusable, host-agnostic contract
// must not carry database identifiers, and the D3-2A static guards forbid
// them in this directory's non-test source. The mapping from these methods
// to the real routines is made exactly once, inline, in the D3-2B pg-rig
// integration test's throwaway adapter, and is documented in
// docs/phoenix/D3-2B-DISPATCH-ORCHESTRATION-INTEGRATION.md.
//
// Implementing this interface against a real database is explicitly OUT OF
// SCOPE for D3-2B. No production adapter exists yet.

/**
 * One row returned by a claim call — the delivery-state identity plus the
 * immutable event data joined from the D2 Outbox source row.
 *
 * Field-for-field mirror of the claim routine's declared result columns, in
 * declaration order, converted snake_case -> camelCase. Every column is NOT
 * NULL at the source, so every field here is non-nullable.
 *
 * Timestamps are carried as opaque strings: this module never parses,
 * compares, or reasons about time (see lib/dispatch.ts — no clock access).
 * `payload` is `unknown` because the orchestrator must never inspect,
 * reshape, or log event contents; only a caller-supplied processor may.
 */
export interface ClaimedOutboxEvent {
  readonly deliveryStateId: string;
  readonly outboxEventId: string;
  readonly eventKey: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly organizationId: string;
  readonly payload: unknown;
  readonly occurredAt: string;
  readonly attemptCount: number;
  readonly leaseExpiresAt: string;
}

/** Terminal status a failure call may leave a delivery row in. */
export type FailedDeliveryStatus = "pending" | "dead_letter";

export interface ClaimBatchInput {
  readonly consumerKey: string;
  /** Caller-generated lease identity. This module never generates one. */
  readonly leaseToken: string;
  readonly batchSize: number;
}

export interface MarkCompletedInput {
  readonly consumerKey: string;
  readonly deliveryStateId: string;
  readonly leaseToken: string;
}

export interface MarkFailedInput {
  readonly consumerKey: string;
  readonly deliveryStateId: string;
  readonly leaseToken: string;
  /**
   * Bounded diagnostics only. The database truncates both defensively; this
   * contract adds no scanning, redaction, or interpretation of its own, so
   * callers must not place secrets or payload contents here.
   */
  readonly errorCode: string | null;
  readonly errorSummary: string | null;
}

export interface ReleaseLeaseInput {
  readonly consumerKey: string;
  readonly deliveryStateId: string;
  readonly leaseToken: string;
}

/**
 * Completion result. `alreadyCompleted` is true for an idempotent replay by
 * the SAME lease token; a foreign token is rejected by the database and
 * surfaces here as a thrown error, never as a result object.
 */
export interface MarkCompletedResult {
  readonly ok: boolean;
  readonly alreadyCompleted: boolean;
  readonly deliveryStateId: string;
  readonly completedAt: string;
}

/**
 * Failure result. `attemptCount` is the post-increment value chosen by the
 * database, `availableAt` its server-controlled backoff instant, and
 * `deadLetterAt` non-null exactly when the row crossed its attempt ceiling.
 * None of these are decided, or even inspected, by the orchestrator.
 */
export interface MarkFailedResult {
  readonly ok: boolean;
  readonly deliveryStateId: string;
  readonly status: FailedDeliveryStatus;
  readonly attemptCount: number;
  readonly availableAt: string;
  readonly deadLetterAt: string | null;
}

/**
 * Cooperative-release result. A release is not a failure: the database
 * deliberately leaves the attempt counter untouched.
 */
export interface ReleaseLeaseResult {
  readonly ok: boolean;
  readonly deliveryStateId: string;
  readonly availableAt: string;
}

/**
 * The four consumer operations, and only those four. Any implementation is
 * expected to REJECT (throw) on every error the underlying foundation
 * raises — unknown consumer, disabled consumer, out-of-bounds batch size,
 * unknown delivery row, stale or foreign lease token, row not currently
 * leased. lib/dispatch.ts relies on that: it never inspects an error and
 * never converts one into a success, so a rejection here is always
 * propagated to the caller unchanged.
 */
export interface OutboxRpcClient {
  claimBatch(input: ClaimBatchInput): Promise<readonly ClaimedOutboxEvent[]>;
  markCompleted(input: MarkCompletedInput): Promise<MarkCompletedResult>;
  markFailed(input: MarkFailedInput): Promise<MarkFailedResult>;
  releaseLease(input: ReleaseLeaseInput): Promise<ReleaseLeaseResult>;
}
