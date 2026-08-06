// Runtime validation of Outbox consumer-RPC results (D3-2C).
//
// PURE. No imports beyond the D3-2B type contract, no environment access, no
// network, no client, no logging, no global state. This module is deliberately
// transport-agnostic so BOTH of the following can share exactly one validator:
//
//   * lib/supabase-rpc-adapter.ts — validating what a real transport returned;
//   * the D3-2C pg-rig dynamic suite — validating what real Migration 163 SQL
//     produced, through a test-only direct-PostgreSQL invoker.
//
// INPUT SHAPE. Validators accept the RAW, snake_case, JSON-compatible row/object
// a Data-API-style transport delivers — not the camelCase interface type. They
// validate first and map second, so a caller can never receive a partially
// validated value: either every field passed, or nothing is returned at all.
//
// Timestamps are validated as ISO-8601 STRINGS and are never converted to Date,
// never re-formatted, and never normalized. Identifiers are validated for UUID
// shape and returned exactly as received — case is preserved, never lowered.
//
// NOTHING here coerces, defaults, truncates, or repairs. Every failure throws
// OutboxRpcValidationError, whose message names the offending FIELD and the
// EXPECTATION only — never the offending value, never a serialized object,
// never a credential, URL, lease token, or event payload.

import type {
  ClaimedOutboxEvent,
  FailedDeliveryStatus,
  MarkCompletedResult,
  MarkFailedResult,
  ReleaseLeaseResult,
} from "./rpc-client.ts";

/**
 * The only error this module throws. Deliberately carries a field path and an
 * expectation, and deliberately carries NO observed value: a validation error
 * is a diagnostic about shape, and echoing the offending data back is how
 * payload contents and credentials leak into logs and responses.
 */
export class OutboxRpcValidationError extends Error {
  readonly field: string;

  constructor(field: string, expectation: string) {
    super(`outbox rpc result invalid: ${field} ${expectation}`);
    this.name = "OutboxRpcValidationError";
    this.field = field;
  }
}

// ── Primitive guards ────────────────────────────────────────────────────────

// Canonical 8-4-4-4-12 hexadecimal form. Case-insensitive on input; the value
// is returned unchanged, so a mixed-case identifier is never rewritten.
const UUID_SHAPE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ISO-8601 instant with an explicit zone: "Z" or a numeric offset. Fractional
// seconds optional, 1-9 digits. Validated by shape only — deliberately NOT by
// constructing a Date, which would both accept sloppier input and hand back a
// converted value this contract does not want.
const ISO_TIMESTAMP_SHAPE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Exact-key enforcement, both directions: a missing field and an unexpected
 * extra field are equally rejected. An extra key means the transport returned
 * something this contract has not reviewed, and silently ignoring it is how a
 * changed database contract goes unnoticed until it matters.
 */
function requireExactKeys(
  value: unknown,
  expected: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new OutboxRpcValidationError(path, "must be a non-null object");
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  for (const key of wanted) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new OutboxRpcValidationError(`${path}.${key}`, "is required");
    }
  }
  for (const key of actual) {
    if (!wanted.includes(key)) {
      throw new OutboxRpcValidationError(
        `${path}.${key}`,
        "is not part of this result contract",
      );
    }
  }
  return value;
}

function requireNonEmptyString(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw new OutboxRpcValidationError(`${path}.${key}`, "must be a string");
  }
  if (value.length === 0) {
    throw new OutboxRpcValidationError(`${path}.${key}`, "must not be empty");
  }
  return value;
}

function requireUuid(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = requireNonEmptyString(source, key, path);
  if (!UUID_SHAPE.test(value)) {
    throw new OutboxRpcValidationError(
      `${path}.${key}`,
      "must be a UUID-shaped identifier",
    );
  }
  return value;
}

function requireIsoTimestamp(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = requireNonEmptyString(source, key, path);
  if (!ISO_TIMESTAMP_SHAPE.test(value)) {
    throw new OutboxRpcValidationError(
      `${path}.${key}`,
      "must be an ISO-8601 timestamp string with an explicit zone",
    );
  }
  return value;
}

function requireNullableIsoTimestamp(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  if (source[key] === null) return null;
  return requireIsoTimestamp(source, key, path);
}

/**
 * A non-negative safe integer. Rejects NaN, Infinity, fractional values and
 * negatives — every counter in this contract is a Postgres smallint that the
 * database itself constrains to be non-negative.
 */
function requireNonNegativeInteger(
  source: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const value = source[key];
  if (typeof value !== "number") {
    throw new OutboxRpcValidationError(`${path}.${key}`, "must be a number");
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OutboxRpcValidationError(
      `${path}.${key}`,
      "must be a non-negative safe integer",
    );
  }
  return value;
}

function requireTrueBoolean(
  source: Record<string, unknown>,
  key: string,
  path: string,
): boolean {
  const value = source[key];
  if (typeof value !== "boolean") {
    throw new OutboxRpcValidationError(`${path}.${key}`, "must be a boolean");
  }
  return value;
}

/**
 * The event payload contract, verified against the source table's own
 * constraint: Migration 158 enforces `jsonb_typeof(payload) = 'object'`, so a
 * JSON array, string, number, boolean or null is out of contract here too.
 * Contents are NEVER inspected, copied, or described in any error.
 */
function requireJsonObject(
  source: Record<string, unknown>,
  key: string,
  path: string,
): unknown {
  const value = source[key];
  if (!isPlainObject(value)) {
    throw new OutboxRpcValidationError(
      `${path}.${key}`,
      "must be a JSON object",
    );
  }
  return value;
}

// ── Claim result ────────────────────────────────────────────────────────────

/** Exactly the twelve columns the claim routine declares, in its own order. */
export const CLAIM_ROW_FIELDS = [
  "delivery_state_id",
  "outbox_event_id",
  "event_key",
  "event_type",
  "event_version",
  "aggregate_type",
  "aggregate_id",
  "organization_id",
  "payload",
  "occurred_at",
  "attempt_count",
  "lease_expires_at",
] as const;

function validateClaimedEvent(
  value: unknown,
  path: string,
): ClaimedOutboxEvent {
  const row = requireExactKeys(value, CLAIM_ROW_FIELDS, path);
  return {
    deliveryStateId: requireUuid(row, "delivery_state_id", path),
    outboxEventId: requireUuid(row, "outbox_event_id", path),
    eventKey: requireNonEmptyString(row, "event_key", path),
    eventType: requireNonEmptyString(row, "event_type", path),
    eventVersion: requireNonNegativeInteger(row, "event_version", path),
    aggregateType: requireNonEmptyString(row, "aggregate_type", path),
    aggregateId: requireUuid(row, "aggregate_id", path),
    organizationId: requireUuid(row, "organization_id", path),
    payload: requireJsonObject(row, "payload", path),
    occurredAt: requireIsoTimestamp(row, "occurred_at", path),
    attemptCount: requireNonNegativeInteger(row, "attempt_count", path),
    leaseExpiresAt: requireIsoTimestamp(row, "lease_expires_at", path),
  };
}

/**
 * Validates a whole claim response. An empty array is valid and means "nothing
 * was claimable" — the single most common healthy outcome. Validation is
 * all-or-nothing: one bad row rejects the entire batch rather than silently
 * delivering a shorter one.
 */
export function validateClaimedEvents(
  input: unknown,
): readonly ClaimedOutboxEvent[] {
  if (!Array.isArray(input)) {
    throw new OutboxRpcValidationError("claim", "must be an array of rows");
  }
  const out: ClaimedOutboxEvent[] = [];
  for (let i = 0; i < input.length; i++) {
    out.push(validateClaimedEvent(input[i], `claim[${i}]`));
  }
  return out;
}

// ── Terminal and release results ────────────────────────────────────────────

export const MARK_COMPLETED_FIELDS = [
  "ok",
  "already_completed",
  "delivery_state_id",
  "completed_at",
] as const;

export const MARK_FAILED_FIELDS = [
  "ok",
  "delivery_state_id",
  "status",
  "attempt_count",
  "available_at",
  "dead_letter_at",
] as const;

export const RELEASE_LEASE_FIELDS = [
  "ok",
  "delivery_state_id",
  "available_at",
] as const;

const FAILED_STATUSES: readonly FailedDeliveryStatus[] = [
  "pending",
  "dead_letter",
];

export function validateMarkCompletedResult(
  input: unknown,
): MarkCompletedResult {
  const path = "markCompleted";
  const row = requireExactKeys(input, MARK_COMPLETED_FIELDS, path);
  return {
    ok: requireTrueBoolean(row, "ok", path),
    alreadyCompleted: requireTrueBoolean(row, "already_completed", path),
    deliveryStateId: requireUuid(row, "delivery_state_id", path),
    completedAt: requireIsoTimestamp(row, "completed_at", path),
  };
}

export function validateMarkFailedResult(input: unknown): MarkFailedResult {
  const path = "markFailed";
  const row = requireExactKeys(input, MARK_FAILED_FIELDS, path);
  const status = row["status"];
  // Closed enum. A status the contract does not know about is a changed
  // database contract, not a value to pass through.
  if (
    typeof status !== "string" ||
    !FAILED_STATUSES.includes(status as FailedDeliveryStatus)
  ) {
    throw new OutboxRpcValidationError(
      `${path}.status`,
      'must be exactly "pending" or "dead_letter"',
    );
  }
  return {
    ok: requireTrueBoolean(row, "ok", path),
    deliveryStateId: requireUuid(row, "delivery_state_id", path),
    status: status as FailedDeliveryStatus,
    attemptCount: requireNonNegativeInteger(row, "attempt_count", path),
    availableAt: requireIsoTimestamp(row, "available_at", path),
    deadLetterAt: requireNullableIsoTimestamp(row, "dead_letter_at", path),
  };
}

export function validateReleaseLeaseResult(
  input: unknown,
): ReleaseLeaseResult {
  const path = "releaseLease";
  const row = requireExactKeys(input, RELEASE_LEASE_FIELDS, path);
  return {
    ok: requireTrueBoolean(row, "ok", path),
    deliveryStateId: requireUuid(row, "delivery_state_id", path),
    availableAt: requireIsoTimestamp(row, "available_at", path),
  };
}
