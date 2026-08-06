// Offline, Deno-native tests for lib/dispatch.ts (D3-2B).
//
// Everything here runs against an in-memory fake OutboxRpcClient. No
// environment, network, database, filesystem write, subprocess, FFI or
// system permission is used. The only permission this file needs at all is
// read access to this function's own directory, for the two source-scan
// guards at the bottom — the same technique lib/static_guards_test.ts
// already uses, and the reason the D3-2B validation command is
// `deno test --allow-read="<function-dir>"`.
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runDispatchCycle } from "./dispatch.ts";
import type { ProcessOutcome } from "./dispatch.ts";
import type {
  ClaimBatchInput,
  ClaimedOutboxEvent,
  MarkCompletedInput,
  MarkCompletedResult,
  MarkFailedInput,
  MarkFailedResult,
  OutboxRpcClient,
  ReleaseLeaseInput,
  ReleaseLeaseResult,
} from "./rpc-client.ts";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const FUNCTION_DIR = dirname(LIB_DIR);

// ── Fixtures ────────────────────────────────────────────────────────────────

// Fixed, obviously-synthetic identities. Nothing here resembles a real
// organization, project, or consumer registration.
const CONSUMER_KEY = "probe_nonprod_d3_2_v1-deno";
const LEASE_TOKEN = "00000000-0000-0000-0000-0000000d32b1";
const OTHER_TOKEN = "00000000-0000-0000-0000-0000000d32b9";
const ORG = "00000000-0000-0000-0000-0000000d32ba";

function claimedEvent(n: number): ClaimedOutboxEvent {
  return {
    deliveryStateId: `ds-${n}`,
    outboxEventId: `ev-${n}`,
    eventKey: `probe_nonprod_d3_2_v1-key-${n}`,
    eventType: "stocktakes.recorded",
    eventVersion: 1,
    aggregateType: "stocktakes",
    aggregateId: `ag-${n}`,
    organizationId: ORG,
    payload: { probe: n },
    occurredAt: "2020-01-01T00:00:00.000Z",
    attemptCount: 0,
    leaseExpiresAt: "2020-01-01T00:05:00.000Z",
  };
}

type RecordedCall =
  | { method: "claimBatch"; input: ClaimBatchInput }
  | { method: "markCompleted"; input: MarkCompletedInput }
  | { method: "markFailed"; input: MarkFailedInput }
  | { method: "releaseLease"; input: ReleaseLeaseInput };

interface FakeOptions {
  claimed?: ClaimedOutboxEvent[];
  claimError?: Error;
  completedError?: Error;
  /**
   * 1-based index of the markCompleted invocation that should reject with
   * `completedError`. When omitted, `completedError` rejects EVERY call —
   * the pre-existing behavior the earlier abort tests rely on. Setting it
   * lets a test fail a LATER call, so earlier rows are genuinely finalized
   * before the cycle aborts.
   */
  completedErrorAtCall?: number;
  failedError?: Error;
  releaseError?: Error;
}

interface FakeClient extends OutboxRpcClient {
  readonly calls: RecordedCall[];
  /**
   * Delivery rows whose markCompleted actually RESOLVED, in call order.
   * Distinct from the call log, which also records the attempt that threw.
   */
  readonly completedOk: string[];
  countOf(method: RecordedCall["method"]): number;
  /** Every delivery row that received a terminal-or-release call. */
  finalizedIds(): string[];
}

function makeFakeClient(options: FakeOptions = {}): FakeClient {
  const calls: RecordedCall[] = [];
  const completedOk: string[] = [];
  const claimed = options.claimed ?? [];
  let completedCalls = 0;

  return {
    calls,
    completedOk,
    countOf(method) {
      return calls.filter((c) => c.method === method).length;
    },
    finalizedIds() {
      return calls
        .filter((c) => c.method !== "claimBatch")
        .map((c) => (c.input as { deliveryStateId: string }).deliveryStateId);
    },
    claimBatch(input: ClaimBatchInput): Promise<readonly ClaimedOutboxEvent[]> {
      calls.push({ method: "claimBatch", input });
      if (options.claimError) return Promise.reject(options.claimError);
      return Promise.resolve(claimed);
    },
    markCompleted(input: MarkCompletedInput): Promise<MarkCompletedResult> {
      calls.push({ method: "markCompleted", input });
      completedCalls += 1;
      const failThisCall = options.completedError !== undefined &&
        (options.completedErrorAtCall === undefined ||
          options.completedErrorAtCall === completedCalls);
      if (failThisCall) return Promise.reject(options.completedError);
      completedOk.push(input.deliveryStateId);
      return Promise.resolve({
        ok: true,
        alreadyCompleted: false,
        deliveryStateId: input.deliveryStateId,
        completedAt: "2020-01-01T00:01:00.000Z",
      });
    },
    markFailed(input: MarkFailedInput): Promise<MarkFailedResult> {
      calls.push({ method: "markFailed", input });
      if (options.failedError) return Promise.reject(options.failedError);
      return Promise.resolve({
        ok: true,
        deliveryStateId: input.deliveryStateId,
        status: "pending",
        attemptCount: 1,
        availableAt: "2020-01-01T00:01:30.000Z",
        deadLetterAt: null,
      });
    },
    releaseLease(input: ReleaseLeaseInput): Promise<ReleaseLeaseResult> {
      calls.push({ method: "releaseLease", input });
      if (options.releaseError) return Promise.reject(options.releaseError);
      return Promise.resolve({
        ok: true,
        deliveryStateId: input.deliveryStateId,
        availableAt: "2020-01-01T00:01:00.000Z",
      });
    },
  };
}

function cycle(
  client: OutboxRpcClient,
  processEvent: (e: ClaimedOutboxEvent) => Promise<ProcessOutcome>,
  batchSize = 10,
) {
  return runDispatchCycle({
    client,
    consumerKey: CONSUMER_KEY,
    leaseToken: LEASE_TOKEN,
    batchSize,
    processEvent,
  });
}

const alwaysCompleted = (): Promise<ProcessOutcome> =>
  Promise.resolve({ kind: "completed" });

async function assertRejects(
  fn: () => Promise<unknown>,
  message: string,
): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof Error, "expected an Error to be thrown");
    return e;
  }
  throw new assert.AssertionError({ message });
}

// ── 1-3. Claim call shape ───────────────────────────────────────────────────

Deno.test("an empty claim returns an all-zero summary and finalizes nothing", async () => {
  const client = makeFakeClient({ claimed: [] });
  const summary = await cycle(client, alwaysCompleted);

  assert.deepEqual(summary, {
    claimed: 0,
    completed: 0,
    failed: 0,
    released: 0,
  });
  assert.equal(client.calls.length, 1);
  assert.equal(client.countOf("claimBatch"), 1);
});

Deno.test("claimBatch is called exactly once per cycle, even for a multi-row batch", async () => {
  const client = makeFakeClient({
    claimed: [claimedEvent(1), claimedEvent(2), claimedEvent(3)],
  });
  await cycle(client, alwaysCompleted);
  assert.equal(client.countOf("claimBatch"), 1);
});

Deno.test("consumerKey, leaseToken and batchSize reach claimBatch unchanged", async () => {
  const client = makeFakeClient({ claimed: [] });
  await cycle(client, alwaysCompleted, 7);

  const call = client.calls[0];
  assert.equal(call.method, "claimBatch");
  assert.deepEqual(call.input, {
    consumerKey: CONSUMER_KEY,
    leaseToken: LEASE_TOKEN,
    batchSize: 7,
  });
});

// ── 4-6. Outcome routing ────────────────────────────────────────────────────

Deno.test("a completed outcome calls markCompleted exactly once, and no other terminal call", async () => {
  const client = makeFakeClient({ claimed: [claimedEvent(1)] });
  const summary = await cycle(client, alwaysCompleted);

  assert.equal(client.countOf("markCompleted"), 1);
  assert.equal(client.countOf("markFailed"), 0);
  assert.equal(client.countOf("releaseLease"), 0);
  assert.deepEqual(summary, {
    claimed: 1,
    completed: 1,
    failed: 0,
    released: 0,
  });

  const call = client.calls[1];
  assert.equal(call.method, "markCompleted");
  assert.deepEqual(call.input, {
    consumerKey: CONSUMER_KEY,
    deliveryStateId: "ds-1",
    leaseToken: LEASE_TOKEN,
  });
});

Deno.test("a failed outcome calls markFailed exactly once, carrying the error fields through", async () => {
  const client = makeFakeClient({ claimed: [claimedEvent(1)] });
  const summary = await cycle(client, () =>
    Promise.resolve({
      kind: "failed",
      errorCode: "probe_error",
      errorSummary: "probe summary",
    } as ProcessOutcome));

  assert.equal(client.countOf("markFailed"), 1);
  assert.equal(client.countOf("markCompleted"), 0);
  assert.equal(client.countOf("releaseLease"), 0);
  assert.deepEqual(summary, {
    claimed: 1,
    completed: 0,
    failed: 1,
    released: 0,
  });

  const call = client.calls[1];
  assert.equal(call.method, "markFailed");
  assert.deepEqual(call.input, {
    consumerKey: CONSUMER_KEY,
    deliveryStateId: "ds-1",
    leaseToken: LEASE_TOKEN,
    errorCode: "probe_error",
    errorSummary: "probe summary",
  });
});

Deno.test("a released outcome calls releaseLease exactly once, and never markFailed", async () => {
  const client = makeFakeClient({ claimed: [claimedEvent(1)] });
  const summary = await cycle(
    client,
    () => Promise.resolve({ kind: "released" } as ProcessOutcome),
  );

  assert.equal(client.countOf("releaseLease"), 1);
  assert.equal(client.countOf("markCompleted"), 0);
  assert.equal(client.countOf("markFailed"), 0);
  assert.deepEqual(summary, {
    claimed: 1,
    completed: 0,
    failed: 0,
    released: 1,
  });
});

// ── 7-9. Mixed batch, token propagation, single-finalization ────────────────

Deno.test("a mixed batch returns exact per-outcome counts summing to claimed", async () => {
  const events = [1, 2, 3, 4, 5, 6].map(claimedEvent);
  const client = makeFakeClient({ claimed: events });

  const plan: Record<string, ProcessOutcome> = {
    "ds-1": { kind: "completed" },
    "ds-2": { kind: "failed", errorCode: "c2", errorSummary: "s2" },
    "ds-3": { kind: "released" },
    "ds-4": { kind: "completed" },
    "ds-5": { kind: "completed" },
    "ds-6": { kind: "failed", errorCode: null, errorSummary: null },
  };

  const summary = await cycle(
    client,
    (e) => Promise.resolve(plan[e.deliveryStateId]),
  );

  assert.deepEqual(summary, {
    claimed: 6,
    completed: 3,
    failed: 2,
    released: 1,
  });
  assert.equal(
    summary.completed + summary.failed + summary.released,
    summary.claimed,
  );
  assert.equal(client.countOf("markCompleted"), 3);
  assert.equal(client.countOf("markFailed"), 2);
  assert.equal(client.countOf("releaseLease"), 1);
});

Deno.test("the SAME leaseToken reaches every terminal and release call", async () => {
  const events = [1, 2, 3].map(claimedEvent);
  const client = makeFakeClient({ claimed: events });

  const plan: Record<string, ProcessOutcome> = {
    "ds-1": { kind: "completed" },
    "ds-2": { kind: "failed", errorCode: null, errorSummary: null },
    "ds-3": { kind: "released" },
  };
  await cycle(client, (e) => Promise.resolve(plan[e.deliveryStateId]));

  const tokens = client.calls.map((c) => c.input.leaseToken);
  assert.equal(tokens.length, 4);
  for (const token of tokens) {
    assert.equal(token, LEASE_TOKEN);
    assert.notEqual(token, OTHER_TOKEN);
  }
});

Deno.test("no claimed row ever receives more than one terminal or release call", async () => {
  const events = [1, 2, 3, 4].map(claimedEvent);
  const client = makeFakeClient({ claimed: events });

  const plan: Record<string, ProcessOutcome> = {
    "ds-1": { kind: "completed" },
    "ds-2": { kind: "failed", errorCode: null, errorSummary: null },
    "ds-3": { kind: "released" },
    "ds-4": { kind: "completed" },
  };
  await cycle(client, (e) => Promise.resolve(plan[e.deliveryStateId]));

  const finalized = client.finalizedIds();
  assert.equal(finalized.length, 4);
  assert.equal(new Set(finalized).size, 4);
  assert.deepEqual(finalized, ["ds-1", "ds-2", "ds-3", "ds-4"]);
});

// ── 10-12. Fail-closed exception behavior ───────────────────────────────────

Deno.test("a claimBatch rejection propagates and nothing else is called", async () => {
  const boom = new Error("consumer_disabled");
  const client = makeFakeClient({ claimError: boom });
  let processed = 0;

  const thrown = await assertRejects(
    () =>
      cycle(client, () => {
        processed += 1;
        return alwaysCompleted();
      }),
    "expected the claim rejection to propagate",
  );

  assert.equal(thrown, boom);
  assert.equal(processed, 0);
  assert.equal(client.calls.length, 1);
  assert.equal(client.countOf("claimBatch"), 1);
});

Deno.test("a processEvent rejection propagates and makes NO terminal call for that row", async () => {
  const boom = new Error("side effect exploded");
  const client = makeFakeClient({
    claimed: [claimedEvent(1), claimedEvent(2)],
  });

  const thrown = await assertRejects(
    () => cycle(client, () => Promise.reject(boom)),
    "expected the processor rejection to propagate",
  );

  assert.equal(thrown, boom);
  // Not completed, not failed, not released — the row is deliberately left
  // leased so the database reclaims it on lease expiry without burning an
  // attempt. Guessing a terminal state here would either lose the event or
  // double-apply its side effect.
  assert.equal(client.countOf("markCompleted"), 0);
  assert.equal(client.countOf("markFailed"), 0);
  assert.equal(client.countOf("releaseLease"), 0);
  assert.equal(client.calls.length, 1);
});

Deno.test("a terminal-RPC rejection propagates and later rows are NOT processed", async () => {
  const boom = new Error("stale_or_foreign_lease_token");
  const client = makeFakeClient({
    claimed: [claimedEvent(1), claimedEvent(2), claimedEvent(3)],
    completedError: boom,
  });
  const seen: string[] = [];

  const thrown = await assertRejects(
    () =>
      cycle(client, (e) => {
        seen.push(e.deliveryStateId);
        return alwaysCompleted();
      }),
    "expected the terminal-call rejection to propagate",
  );

  assert.equal(thrown, boom);
  // Only the FIRST row was ever processed; no optimistic summary was
  // manufactured for the remaining two, which stay leased for expiry.
  assert.deepEqual(seen, ["ds-1"]);
  assert.equal(client.countOf("markCompleted"), 1);
  assert.equal(client.calls.length, 2);
});

Deno.test("a releaseLease rejection also propagates and stops the cycle", async () => {
  const boom = new Error("delivery_state_not_currently_leased");
  const client = makeFakeClient({
    claimed: [claimedEvent(1), claimedEvent(2)],
    releaseError: boom,
  });

  const thrown = await assertRejects(
    () =>
      cycle(
        client,
        () => Promise.resolve({ kind: "released" } as ProcessOutcome),
      ),
    "expected the release rejection to propagate",
  );

  assert.equal(thrown, boom);
  assert.equal(client.countOf("releaseLease"), 1);
  assert.equal(client.calls.length, 2);
});

Deno.test("an unrecognized outcome throws, finalizes nothing, and stops the cycle", async () => {
  const client = makeFakeClient({
    claimed: [claimedEvent(1), claimedEvent(2)],
  });

  await assertRejects(
    () =>
      cycle(
        client,
        () =>
          Promise.resolve(
            { kind: "not_a_real_outcome" } as unknown as ProcessOutcome,
          ),
      ),
    "expected an unknown outcome to fail closed",
  );

  assert.equal(client.countOf("markCompleted"), 0);
  assert.equal(client.countOf("markFailed"), 0);
  assert.equal(client.countOf("releaseLease"), 0);
  assert.equal(client.calls.length, 1);
});

// ── 15. Synchronous processEvent throw (LOW-1) ──────────────────────────────
//
// Every other processor-failure test above uses Promise.reject. This one
// uses a REAL synchronous throw — the shape a processor takes when it blows
// up before reaching its first await. `await processEvent(event)` evaluates
// the call before awaiting, so the throw escapes during invocation, and
// because runDispatchCycle is an async function it surfaces as a rejection
// of the cycle. No terminal call can have been reached for that row.

Deno.test("a SYNCHRONOUS processEvent throw propagates, finalizes nothing, and stops the batch", async () => {
  const boom = new Error("synchronous side-effect explosion");
  // (1) The batch genuinely contains claimed work — two rows, so the
  // "later row is not processed" half of this proof is observable.
  const claimedEvents = [claimedEvent(1), claimedEvent(2)];
  const client = makeFakeClient({ claimed: claimedEvents });
  assert.equal(claimedEvents.length, 2);

  const processed: string[] = [];
  // (2) A genuine synchronous throw. A body that only throws is typed
  // `never`, which satisfies the declared Promise<ProcessOutcome> return
  // type, so this needs no cast and no Promise.reject.
  const throwingProcessor = (
    event: ClaimedOutboxEvent,
  ): Promise<ProcessOutcome> => {
    processed.push(event.deliveryStateId);
    throw boom;
  };

  const thrown = await assertRejects(
    () => cycle(client, throwingProcessor),
    "expected a synchronous processor throw to propagate",
  );

  // (3) Exact error IDENTITY, not merely an equal message.
  assert.equal(thrown, boom);
  assert.ok(
    thrown === boom,
    "the rejection must be the very same Error object",
  );

  // (4,5,6) Nothing was finalized in any direction.
  assert.equal(client.countOf("markCompleted"), 0);
  assert.equal(client.countOf("markFailed"), 0);
  assert.equal(client.countOf("releaseLease"), 0);
  assert.deepEqual(client.finalizedIds(), []);
  assert.deepEqual(client.completedOk, []);

  // (7) No summary: assertRejects proved the cycle did not resolve, and the
  // exact call log proves it stopped at the claim.
  assert.equal(client.countOf("claimBatch"), 1);
  assert.deepEqual(client.calls.map((c) => c.method), ["claimBatch"]);

  // (8) Exact processEvent order — the later row was never reached.
  assert.deepEqual(processed, ["ds-1"]);
});

// ── 16. Terminal failure AFTER earlier rows were finalized (LOW-2) ───────────
//
// The abort tests above all fail on the FIRST terminal call, so none of them
// observes the partially-finalized state. Here rows 1 and 2 are really
// completed, row 3's terminal call rejects, and row 4 is never touched. The
// point is that runDispatchCycle still returns NO summary and manufactures
// NO compensating call for the rows it already finalized — the unfinalized
// remainder is deliberately left for lease expiry, unchanged.

Deno.test("a terminal failure AFTER earlier rows were finalized yields no summary and no compensation", async () => {
  const boom = new Error("stale_or_foreign_lease_token on the third row");
  const claimedEvents = [1, 2, 3, 4].map(claimedEvent);
  const client = makeFakeClient({
    claimed: claimedEvents,
    completedError: boom,
    // (4) Fails on the THIRD markCompleted invocation, not the first.
    completedErrorAtCall: 3,
  });

  const processed: string[] = [];
  const thrown = await assertRejects(
    () =>
      cycle(client, (event) => {
        processed.push(event.deliveryStateId);
        return alwaysCompleted();
      }),
    "expected the third terminal call's rejection to propagate",
  );

  // (5) Exact error identity.
  assert.equal(thrown, boom);
  assert.ok(
    thrown === boom,
    "the rejection must be the very same Error object",
  );

  // (1,3) Exact processEvent order: rows 1-3 processed, row 4 never.
  assert.deepEqual(processed, ["ds-1", "ds-2", "ds-3"]);

  // (2,6) Rows 1 and 2 were genuinely completed and are preserved as
  // observed, RESOLVED calls — exact count before the failure is 2.
  assert.deepEqual(client.completedOk, ["ds-1", "ds-2"]);
  assert.equal(client.completedOk.length, 2);

  // Exact terminal-call order, including the third attempt that rejected.
  assert.deepEqual(client.finalizedIds(), ["ds-1", "ds-2", "ds-3"]);
  assert.equal(client.countOf("markCompleted"), 3);

  // (7,8) Row 4 reached neither the processor nor any terminal call.
  assert.ok(!processed.includes("ds-4"), "ds-4 must never be processed");
  assert.ok(
    !client.finalizedIds().includes("ds-4"),
    "ds-4 must never be finalized",
  );

  // (10) No compensation was manufactured for the partially finalized batch:
  // no markFailed, no releaseLease, no retry of the failed row.
  assert.equal(client.countOf("markFailed"), 0);
  assert.equal(client.countOf("releaseLease"), 0);

  // (9) Exact full call log — one claim plus three completions, nothing else.
  assert.deepEqual(client.calls.map((c) => c.method), [
    "claimBatch",
    "markCompleted",
    "markCompleted",
    "markCompleted",
  ]);
});

// ── 13-14. Source-scan guards ───────────────────────────────────────────────

const D3_2B_SOURCE_FILES = ["lib/rpc-client.ts", "lib/dispatch.ts"];

// Negative controls. These literals exist ONLY here, in a test that asserts
// their ABSENCE from the D3-2B source files.
const PROHIBITED_IN_SOURCE = [
  "eyrzxgfkvqybjdgyphap",
  "supabase.co",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEYS",
  "service_role",
  "createClient",
  "sb_secret_",
  "eyJhbGciOi",
];

for (const relative of D3_2B_SOURCE_FILES) {
  const source = Deno.readTextFileSync(join(FUNCTION_DIR, relative));

  Deno.test(`D3-2B source guard [${relative}]: no secret, URL, Supabase client, or Production identifier`, () => {
    for (const needle of PROHIBITED_IN_SOURCE) {
      assert.ok(
        !source.includes(needle),
        `${relative} must not contain "${needle}"`,
      );
    }
    assert.ok(
      !/https?:\/\//i.test(source),
      `${relative} must not contain any URL`,
    );
    assert.ok(
      !/postgres(ql)?:\/\//i.test(source),
      `${relative} must not contain a database connection string`,
    );
    assert.ok(
      !/\bnew URL\s*\(/.test(source),
      `${relative} must not construct a URL`,
    );
    assert.ok(
      !/Deno\.(env|readTextFile|readFile|serve|connect)/.test(source),
      `${relative} must not use Deno environment, filesystem, or network globals`,
    );
    assert.ok(
      !/from\s+["']node:/.test(source),
      `${relative} must not import a Node builtin`,
    );
    assert.ok(
      !/from\s+["']pg["']/.test(source),
      `${relative} must not import a Postgres driver`,
    );
  });
}

Deno.test("D3-2B does not reference or wire itself into the D3-2A HTTP surface", () => {
  for (const relative of D3_2B_SOURCE_FILES) {
    const source = Deno.readTextFileSync(join(FUNCTION_DIR, relative));
    for (
      const forbidden of [
        "./handler.ts",
        "./auth.ts",
        "./config.ts",
        "./health.ts",
        "./request.ts",
        "handleDispatcherRequest",
      ]
    ) {
      assert.ok(
        !source.includes(forbidden),
        `${relative} must not reference the D3-2A HTTP module "${forbidden}"`,
      );
    }
  }
});

Deno.test("the D3-2A HTTP handler and entry point are unchanged by D3-2B and do not know about it", () => {
  const handler = Deno.readTextFileSync(join(LIB_DIR, "handler.ts"));
  const index = Deno.readTextFileSync(join(FUNCTION_DIR, "index.ts"));

  // Still exactly the D3-2A surface...
  assert.ok(
    handler.includes("export function handleDispatcherRequest("),
    "handler.ts must still export handleDispatcherRequest",
  );
  assert.ok(
    index.includes("handleDispatcherRequest"),
    "index.ts must still call handleDispatcherRequest",
  );

  // ...and neither has acquired any D3-2B wiring.
  for (const source of [handler, index]) {
    for (
      const forbidden of [
        "runDispatchCycle",
        "./dispatch.ts",
        "./rpc-client.ts",
        "OutboxRpcClient",
      ]
    ) {
      assert.ok(
        !source.includes(forbidden),
        `the D3-2A HTTP path must not reference "${forbidden}"`,
      );
    }
  }
});
