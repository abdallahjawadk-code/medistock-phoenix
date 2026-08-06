// Offline tests for lib/rpc-result-validation.ts (D3-2C).
//
// Pure and permissionless: no environment, network, filesystem, subprocess,
// FFI, or system access. Every fixture is synthetic — the identifiers are
// obviously-fake UUIDs and the payloads carry no real data.
//
// Table-driven on purpose: each required field is exercised once for absence
// and once for a wrong type-category, rather than enumerating every
// type-times-field combination.
import { strict as assert } from "node:assert";

import {
  CLAIM_ROW_FIELDS,
  MARK_COMPLETED_FIELDS,
  MARK_FAILED_FIELDS,
  OutboxRpcValidationError,
  RELEASE_LEASE_FIELDS,
  validateClaimedEvents,
  validateMarkCompletedResult,
  validateMarkFailedResult,
  validateReleaseLeaseResult,
} from "./rpc-result-validation.ts";

// ── Synthetic fixtures (raw snake_case, as a transport would deliver) ────────

const DS_ID = "00000000-0000-0000-0000-0000032c0001";
const EV_ID = "00000000-0000-0000-0000-0000032c0002";
const AG_ID = "00000000-0000-0000-0000-0000032c0003";
const ORG_ID = "00000000-0000-0000-0000-0000032c0004";
const T0 = "2020-01-01T00:00:00.000Z";
const T1 = "2020-01-01T00:05:00.000Z";

function claimRow(): Record<string, unknown> {
  return {
    delivery_state_id: DS_ID,
    outbox_event_id: EV_ID,
    event_key: "probe_nonprod_d3_2_v1-key-1",
    event_type: "stocktakes.recorded",
    event_version: 1,
    aggregate_type: "stocktakes",
    aggregate_id: AG_ID,
    organization_id: ORG_ID,
    payload: { probe: 1 },
    occurred_at: T0,
    attempt_count: 0,
    lease_expires_at: T1,
  };
}

const completedResult = (): Record<string, unknown> => ({
  ok: true,
  already_completed: false,
  delivery_state_id: DS_ID,
  completed_at: T0,
});

const failedPending = (): Record<string, unknown> => ({
  ok: true,
  delivery_state_id: DS_ID,
  status: "pending",
  attempt_count: 1,
  available_at: T1,
  dead_letter_at: null,
});

const failedDeadLetter = (): Record<string, unknown> => ({
  ok: true,
  delivery_state_id: DS_ID,
  status: "dead_letter",
  attempt_count: 2,
  available_at: T1,
  dead_letter_at: T1,
});

const releaseResult = (): Record<string, unknown> => ({
  ok: true,
  delivery_state_id: DS_ID,
  available_at: T0,
});

function assertRejects(fn: () => unknown, label: string): Error {
  try {
    fn();
  } catch (e) {
    assert.ok(
      e instanceof OutboxRpcValidationError,
      `${label}: expected OutboxRpcValidationError`,
    );
    return e;
  }
  throw new assert.AssertionError({ message: `${label}: expected a throw` });
}

// ── Happy paths ─────────────────────────────────────────────────────────────

Deno.test("a valid claim row validates and maps to the camelCase contract", () => {
  const [event] = validateClaimedEvents([claimRow()]);
  assert.deepEqual(event, {
    deliveryStateId: DS_ID,
    outboxEventId: EV_ID,
    eventKey: "probe_nonprod_d3_2_v1-key-1",
    eventType: "stocktakes.recorded",
    eventVersion: 1,
    aggregateType: "stocktakes",
    aggregateId: AG_ID,
    organizationId: ORG_ID,
    payload: { probe: 1 },
    occurredAt: T0,
    attemptCount: 0,
    leaseExpiresAt: T1,
  });
  // Timestamps stay strings; identifiers are returned byte-for-byte.
  assert.equal(typeof event.occurredAt, "string");
  assert.equal(event.deliveryStateId, DS_ID);
});

Deno.test("an empty claim array is valid and yields no events", () => {
  assert.deepEqual(validateClaimedEvents([]), []);
});

Deno.test("a mixed-case UUID is accepted and never normalized", () => {
  const row = claimRow();
  const mixed = "AbCdEf01-0000-0000-0000-0000032C0009";
  row.delivery_state_id = mixed;
  const [event] = validateClaimedEvents([row]);
  assert.equal(event.deliveryStateId, mixed);
});

Deno.test("terminal and release results validate and map", () => {
  assert.deepEqual(validateMarkCompletedResult(completedResult()), {
    ok: true,
    alreadyCompleted: false,
    deliveryStateId: DS_ID,
    completedAt: T0,
  });
  assert.deepEqual(validateMarkFailedResult(failedPending()), {
    ok: true,
    deliveryStateId: DS_ID,
    status: "pending",
    attemptCount: 1,
    availableAt: T1,
    deadLetterAt: null,
  });
  assert.deepEqual(validateMarkFailedResult(failedDeadLetter()), {
    ok: true,
    deliveryStateId: DS_ID,
    status: "dead_letter",
    attemptCount: 2,
    availableAt: T1,
    deadLetterAt: T1,
  });
  assert.deepEqual(validateReleaseLeaseResult(releaseResult()), {
    ok: true,
    deliveryStateId: DS_ID,
    availableAt: T0,
  });
});

// ── Missing fields (table-driven, one case per required field) ───────────────

Deno.test("every required claim field is rejected when missing", () => {
  for (const field of CLAIM_ROW_FIELDS) {
    const row = claimRow();
    delete row[field];
    const err = assertRejects(
      () => validateClaimedEvents([row]),
      `missing ${field}`,
    );
    assert.ok(
      err.message.includes(field),
      `error should name the missing field ${field}`,
    );
  }
});

Deno.test("every required terminal/release field is rejected when missing", () => {
  const cases: Array<
    [readonly string[], () => Record<string, unknown>, (v: unknown) => unknown]
  > = [
    [MARK_COMPLETED_FIELDS, completedResult, validateMarkCompletedResult],
    [MARK_FAILED_FIELDS, failedPending, validateMarkFailedResult],
    [RELEASE_LEASE_FIELDS, releaseResult, validateReleaseLeaseResult],
  ];
  for (const [fields, make, validate] of cases) {
    for (const field of fields) {
      const value = make();
      delete value[field];
      assertRejects(() => validate(value), `missing ${field}`);
    }
  }
});

// ── Additional fields ───────────────────────────────────────────────────────

Deno.test("an unexpected extra field is rejected in every result shape", () => {
  const claimExtra = claimRow();
  claimExtra.injected = "x";
  assertRejects(() => validateClaimedEvents([claimExtra]), "claim extra");

  const completedExtra = completedResult();
  completedExtra.injected = "x";
  assertRejects(
    () => validateMarkCompletedResult(completedExtra),
    "completed extra",
  );

  const failedExtra = failedPending();
  failedExtra.injected = "x";
  assertRejects(() => validateMarkFailedResult(failedExtra), "failed extra");

  const releaseExtra = releaseResult();
  releaseExtra.injected = "x";
  assertRejects(
    () => validateReleaseLeaseResult(releaseExtra),
    "release extra",
  );
});

// ── Wrong type per field category ───────────────────────────────────────────

Deno.test("wrong primitive types are rejected, one case per field category", () => {
  const cases: Array<[string, unknown, string]> = [
    ["delivery_state_id", 42, "uuid given a number"],
    ["event_key", 7, "text given a number"],
    ["event_version", "1", "integer given a string"],
    ["payload", "not-an-object", "json object given a string"],
    ["occurred_at", 1577836800000, "timestamp given a number"],
    ["attempt_count", 1.5, "integer given a fraction"],
  ];
  for (const [field, bad, label] of cases) {
    const row = claimRow();
    row[field] = bad;
    assertRejects(() => validateClaimedEvents([row]), label);
  }
});

Deno.test("a malformed UUID is rejected", () => {
  for (
    const bad of [
      "",
      "not-a-uuid",
      "00000000-0000-0000-0000-00003",
      DS_ID + "0",
    ]
  ) {
    const row = claimRow();
    row.aggregate_id = bad;
    assertRejects(() => validateClaimedEvents([row]), "bad uuid");
  }
});

Deno.test("a malformed ISO timestamp is rejected", () => {
  for (
    const bad of [
      "2020-01-01",
      "2020-01-01 00:00:00+00",
      "2020-01-01T00:00:00",
      "yesterday",
    ]
  ) {
    const row = claimRow();
    row.occurred_at = bad;
    assertRejects(() => validateClaimedEvents([row]), "bad timestamp");
  }
});

Deno.test("a payload that is not a JSON object is rejected", () => {
  for (const bad of [[], "x", 1, true, null]) {
    const row = claimRow();
    row.payload = bad;
    assertRejects(() => validateClaimedEvents([row]), "bad payload");
  }
});

Deno.test("null is rejected wherever the contract is non-nullable", () => {
  for (const field of CLAIM_ROW_FIELDS) {
    const row = claimRow();
    row[field] = null;
    assertRejects(() => validateClaimedEvents([row]), `null ${field}`);
  }
  const failedNullAvailable = failedPending();
  failedNullAvailable.available_at = null;
  assertRejects(
    () => validateMarkFailedResult(failedNullAvailable),
    "null available_at",
  );
});

Deno.test("dead_letter_at is the one nullable terminal field", () => {
  const value = failedPending();
  value.dead_letter_at = null;
  assert.equal(validateMarkFailedResult(value).deadLetterAt, null);
});

// ── Enum and top-level shape ────────────────────────────────────────────────

Deno.test("an unexpected markFailed status is rejected", () => {
  for (const bad of ["completed", "leased", "PENDING", "", 1, null]) {
    const value = failedPending();
    value.status = bad;
    assertRejects(() => validateMarkFailedResult(value), "bad status");
  }
});

Deno.test("null and array/object mismatches at the top level are rejected", () => {
  assertRejects(() => validateClaimedEvents(null), "null claim");
  assertRejects(() => validateClaimedEvents(claimRow()), "object where array");
  assertRejects(() => validateClaimedEvents([null]), "null row");
  assertRejects(() => validateClaimedEvents([[]]), "array row");
  for (
    const validate of [
      validateMarkCompletedResult,
      validateMarkFailedResult,
      validateReleaseLeaseResult,
    ]
  ) {
    assertRejects(() => validate(null), "null result");
    assertRejects(() => validate([]), "array where object");
    assertRejects(() => validate("x"), "string where object");
  }
});

// ── Error hygiene ───────────────────────────────────────────────────────────

Deno.test("validation errors name the field but never echo the value or serialize the object", () => {
  const secretish = "sb_secret_should_never_appear";
  const row = claimRow();
  row.event_key = secretish;
  row.payload = { patient: "should-never-appear", token: secretish };
  row.occurred_at = "not-a-timestamp";

  const err = assertRejects(() => validateClaimedEvents([row]), "hygiene");
  assert.ok(err.message.includes("occurred_at"), "should name the field");
  assert.ok(!err.message.includes(secretish), "must not echo a value");
  assert.ok(
    !err.message.includes("should-never-appear"),
    "must not echo payload contents",
  );
  assert.ok(!err.message.includes("{"), "must not serialize an object");
  // The only bracket a message may carry is a numeric row index in the field
  // path (e.g. `claim[0].occurred_at`) — never a serialized array.
  for (const fragment of err.message.split("[").slice(1)) {
    assert.ok(
      /^\d+\]/.test(fragment),
      "the only permitted bracket is a numeric row index",
    );
  }
});
