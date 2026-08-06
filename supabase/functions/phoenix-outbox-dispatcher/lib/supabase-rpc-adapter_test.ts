// Offline tests for lib/supabase-rpc-adapter.ts (D3-2C).
//
// TIER A PROOF — ADAPTER LOGIC ONLY.
// Every transport here is an in-memory fake injected through clientFactory.
// These tests prove RPC names, argument mapping, abort wiring, validation
// hand-off, error sanitization, and the no-retry rule. They prove NOTHING
// about the real supabase-js/PostgREST HTTP path: that is tier C, the D3-2E
// hosted gate. Tier B (the pg-rig suite) proves real SQL result shapes.
//
// No environment, network, filesystem-write, subprocess, FFI or system
// permission is used. All credentials, URLs and identifiers are synthetic.
import { strict as assert } from "node:assert";

import {
  createSupabaseOutboxRpcClient,
  MAX_TIMEOUT_MS,
  OutboxRpcConfigurationError,
  OutboxRpcTransportError,
  type RpcRequest,
  type RpcResult,
  type SupabaseRpcTransport,
} from "./supabase-rpc-adapter.ts";
import { OutboxRpcValidationError } from "./rpc-result-validation.ts";

// ── Synthetic configuration ─────────────────────────────────────────────────

const URL_OK = "https://probe-nonprod-d3-2c.example.invalid";
const KEY_OK = "probe_nonprod_secret_key_value_not_real";
const TIMEOUT = 30_000;

const CONSUMER = "probe_nonprod_d3_2_v1-adapter";
const LEASE = "00000000-0000-0000-0000-0000032c00aa";
const DS_ID = "00000000-0000-0000-0000-0000032c0001";
const EV_ID = "00000000-0000-0000-0000-0000032c0002";
const AG_ID = "00000000-0000-0000-0000-0000032c0003";
const ORG_ID = "00000000-0000-0000-0000-0000032c0004";
const T0 = "2020-01-01T00:00:00.000Z";
const T1 = "2020-01-01T00:05:00.000Z";

const claimRow = () => ({
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
});

// ── Recording fake transport ────────────────────────────────────────────────

interface RecordedRpc {
  functionName: string;
  args: Record<string, unknown>;
  abortCalls: number;
  signal: AbortSignal | null;
}

interface FakeTransport extends SupabaseRpcTransport {
  readonly calls: RecordedRpc[];
}

interface FactoryLog {
  readonly options: Array<Record<string, unknown>>;
  count: number;
}

function makeHarness(
  respond: (functionName: string) => RpcResult<unknown>,
): {
  transport: FakeTransport;
  factoryLog: FactoryLog;
  signals: number[];
  clientFactory: (o: Record<string, unknown>) => SupabaseRpcTransport;
  abortSignalFactory: (ms: number) => AbortSignal;
} {
  const calls: RecordedRpc[] = [];
  const factoryLog: FactoryLog = { options: [], count: 0 };
  const signals: number[] = [];

  // Distinct signal per requested timeout so a test can prove the signal that
  // reached abortSignal() is the one the factory produced.
  const madeSignals = new Map<number, AbortSignal>();
  const abortSignalFactory = (ms: number): AbortSignal => {
    signals.push(ms);
    const controller = new AbortController();
    madeSignals.set(ms, controller.signal);
    return controller.signal;
  };

  const transport: FakeTransport = {
    calls,
    rpc<T>(functionName: string, args: Record<string, unknown>): RpcRequest<T> {
      const record: RecordedRpc = {
        functionName,
        args,
        abortCalls: 0,
        signal: null,
      };
      calls.push(record);
      const settle = () =>
        Promise.resolve(respond(functionName) as RpcResult<T>);
      const request: RpcRequest<T> = {
        abortSignal(signal: AbortSignal) {
          record.abortCalls += 1;
          record.signal = signal;
          return settle();
        },
        then(onfulfilled, onrejected) {
          return settle().then(onfulfilled, onrejected);
        },
      };
      return request;
    },
  };

  const clientFactory = (o: Record<string, unknown>): SupabaseRpcTransport => {
    factoryLog.count += 1;
    factoryLog.options.push(o);
    return transport;
  };

  return { transport, factoryLog, signals, clientFactory, abortSignalFactory };
}

const okFor = (functionName: string): RpcResult<unknown> => {
  switch (functionName) {
    case "phoenix_outbox_claim_batch":
      return { data: [claimRow()], error: null };
    case "phoenix_outbox_mark_completed":
      return {
        data: {
          ok: true,
          already_completed: false,
          delivery_state_id: DS_ID,
          completed_at: T0,
        },
        error: null,
      };
    case "phoenix_outbox_mark_failed":
      return {
        data: {
          ok: true,
          delivery_state_id: DS_ID,
          status: "pending",
          attempt_count: 1,
          available_at: T1,
          dead_letter_at: null,
        },
        error: null,
      };
    default:
      return {
        data: { ok: true, delivery_state_id: DS_ID, available_at: T0 },
        error: null,
      };
  }
};

function build(
  h: ReturnType<typeof makeHarness>,
  overrides: Record<string, unknown> = {},
) {
  return createSupabaseOutboxRpcClient({
    supabaseUrl: URL_OK,
    secretKey: KEY_OK,
    timeoutMs: TIMEOUT,
    clientFactory: h.clientFactory,
    abortSignalFactory: h.abortSignalFactory,
    ...overrides,
  });
}

async function assertRejects(
  fn: () => Promise<unknown>,
  label: string,
): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof Error, `${label}: expected an Error`);
    return e;
  }
  throw new assert.AssertionError({
    message: `${label}: expected a rejection`,
  });
}

// ── Construction ────────────────────────────────────────────────────────────

Deno.test("clientFactory is invoked exactly once, with the exact url, key and auth options", () => {
  const h = makeHarness(okFor);
  build(h);

  assert.equal(h.factoryLog.count, 1);
  assert.deepEqual(h.factoryLog.options[0], {
    supabaseUrl: URL_OK,
    secretKey: KEY_OK,
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
});

Deno.test("clientFactory is not re-invoked per RPC call", async () => {
  const h = makeHarness(okFor);
  const client = build(h);
  await client.claimBatch({
    consumerKey: CONSUMER,
    leaseToken: LEASE,
    batchSize: 10,
  });
  await client.markCompleted({
    consumerKey: CONSUMER,
    deliveryStateId: DS_ID,
    leaseToken: LEASE,
  });
  assert.equal(h.factoryLog.count, 1);
});

Deno.test("configuration is validated fail-closed without echoing any value", () => {
  const h = makeHarness(okFor);
  const bad: Array<[Record<string, unknown>, string]> = [
    [{ supabaseUrl: "" }, "empty url"],
    [{ supabaseUrl: "not a url" }, "unparseable url"],
    [{ supabaseUrl: "http://insecure.example.invalid" }, "non-https url"],
    [{ secretKey: "" }, "empty key"],
    [{ timeoutMs: 0 }, "zero timeout"],
    [{ timeoutMs: -1 }, "negative timeout"],
    [{ timeoutMs: 1.5 }, "fractional timeout"],
    [{ timeoutMs: Number.POSITIVE_INFINITY }, "infinite timeout"],
    [{ timeoutMs: MAX_TIMEOUT_MS + 1 }, "over-bound timeout"],
  ];
  for (const [override, label] of bad) {
    let threw: unknown = null;
    try {
      build(h, override);
    } catch (e) {
      threw = e;
    }
    assert.ok(
      threw instanceof OutboxRpcConfigurationError,
      `${label}: expected OutboxRpcConfigurationError`,
    );
    const message = (threw as Error).message;
    assert.ok(!message.includes(KEY_OK), `${label}: must not echo the key`);
    assert.ok(!message.includes(URL_OK), `${label}: must not echo the url`);
  }
  // A valid upper-bound timeout is accepted.
  build(h, { timeoutMs: MAX_TIMEOUT_MS });
});

// ── RPC names and argument mapping ──────────────────────────────────────────

Deno.test("each method issues exactly one RPC with the exact name and argument names", async () => {
  const h = makeHarness(okFor);
  const client = build(h);

  await client.claimBatch({
    consumerKey: CONSUMER,
    leaseToken: LEASE,
    batchSize: 7,
  });
  await client.markCompleted({
    consumerKey: CONSUMER,
    deliveryStateId: DS_ID,
    leaseToken: LEASE,
  });
  await client.markFailed({
    consumerKey: CONSUMER,
    deliveryStateId: DS_ID,
    leaseToken: LEASE,
    errorCode: "probe_code",
    errorSummary: "probe summary",
  });
  await client.releaseLease({
    consumerKey: CONSUMER,
    deliveryStateId: DS_ID,
    leaseToken: LEASE,
  });

  assert.equal(h.transport.calls.length, 4);
  assert.deepEqual(h.transport.calls.map((c) => c.functionName), [
    "phoenix_outbox_claim_batch",
    "phoenix_outbox_mark_completed",
    "phoenix_outbox_mark_failed",
    "phoenix_outbox_release_lease",
  ]);
  assert.deepEqual(h.transport.calls[0].args, {
    p_consumer_key: CONSUMER,
    p_lease_token: LEASE,
    p_batch_size: 7,
  });
  assert.deepEqual(h.transport.calls[1].args, {
    p_consumer_key: CONSUMER,
    p_delivery_state_id: DS_ID,
    p_lease_token: LEASE,
  });
  assert.deepEqual(h.transport.calls[2].args, {
    p_consumer_key: CONSUMER,
    p_delivery_state_id: DS_ID,
    p_lease_token: LEASE,
    p_error_code: "probe_code",
    p_error_summary: "probe summary",
  });
  assert.deepEqual(h.transport.calls[3].args, {
    p_consumer_key: CONSUMER,
    p_delivery_state_id: DS_ID,
    p_lease_token: LEASE,
  });
});

Deno.test("null diagnostics are passed through to markFailed unchanged", async () => {
  const h = makeHarness(okFor);
  await build(h).markFailed({
    consumerKey: CONSUMER,
    deliveryStateId: DS_ID,
    leaseToken: LEASE,
    errorCode: null,
    errorSummary: null,
  });
  assert.equal(h.transport.calls[0].args.p_error_code, null);
  assert.equal(h.transport.calls[0].args.p_error_summary, null);
});

// ── Abort wiring ────────────────────────────────────────────────────────────

Deno.test("every RPC chains abortSignal exactly once with a signal from abortSignalFactory(timeoutMs)", async () => {
  const h = makeHarness(okFor);
  const client = build(h);
  await client.claimBatch({
    consumerKey: CONSUMER,
    leaseToken: LEASE,
    batchSize: 1,
  });
  await client.releaseLease({
    consumerKey: CONSUMER,
    deliveryStateId: DS_ID,
    leaseToken: LEASE,
  });

  assert.deepEqual(h.signals, [TIMEOUT, TIMEOUT]);
  for (const call of h.transport.calls) {
    assert.equal(
      call.abortCalls,
      1,
      "abortSignal must be chained exactly once",
    );
    assert.ok(
      call.signal instanceof AbortSignal,
      "a real signal must be passed",
    );
    assert.equal(call.signal?.aborted, false);
  }
});

// ── Result mapping ──────────────────────────────────────────────────────────

Deno.test("valid results map to the existing D3-2B typed contract", async () => {
  const h = makeHarness(okFor);
  const client = build(h);

  const claimed = await client.claimBatch({
    consumerKey: CONSUMER,
    leaseToken: LEASE,
    batchSize: 10,
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].deliveryStateId, DS_ID);
  assert.equal(claimed[0].occurredAt, T0);
  for (const key of Object.keys(claimed[0])) {
    assert.ok(!key.includes("_"), "no snake_case key may survive the adapter");
  }

  assert.deepEqual(
    await client.markCompleted({
      consumerKey: CONSUMER,
      deliveryStateId: DS_ID,
      leaseToken: LEASE,
    }),
    {
      ok: true,
      alreadyCompleted: false,
      deliveryStateId: DS_ID,
      completedAt: T0,
    },
  );
  assert.deepEqual(
    await client.markFailed({
      consumerKey: CONSUMER,
      deliveryStateId: DS_ID,
      leaseToken: LEASE,
      errorCode: null,
      errorSummary: null,
    }),
    {
      ok: true,
      deliveryStateId: DS_ID,
      status: "pending",
      attemptCount: 1,
      availableAt: T1,
      deadLetterAt: null,
    },
  );
  assert.deepEqual(
    await client.releaseLease({
      consumerKey: CONSUMER,
      deliveryStateId: DS_ID,
      leaseToken: LEASE,
    }),
    { ok: true, deliveryStateId: DS_ID, availableAt: T0 },
  );
});

// ── Transport error handling ────────────────────────────────────────────────

Deno.test("a transport error rejects, preserving code and a bare snake_case reason", async () => {
  const h = makeHarness(() => ({
    data: null,
    error: { code: "23514", message: "consumer_disabled" },
  }));
  const err = await assertRejects(
    () =>
      build(h).claimBatch({
        consumerKey: CONSUMER,
        leaseToken: LEASE,
        batchSize: 10,
      }),
    "transport error",
  );
  assert.ok(err instanceof OutboxRpcTransportError);
  assert.equal((err as OutboxRpcTransportError).code, "23514");
  assert.equal((err as OutboxRpcTransportError).reason, "consumer_disabled");
  assert.ok(err.message.includes("consumer_disabled"));
  assert.ok(err.message.includes("23514"));
});

Deno.test("a value-bearing database message is dropped rather than reproduced", async () => {
  const leaked =
    "Key (id)=(00000000-0000-0000-0000-0000032c0009) already exists";
  const h = makeHarness(() => ({
    data: null,
    error: {
      code: "23505",
      message:
        `duplicate key value violates unique constraint. DETAIL: ${leaked}`,
      details: leaked,
      hint: leaked,
    },
  }));
  const err = await assertRejects(
    () =>
      build(h).markCompleted({
        consumerKey: CONSUMER,
        deliveryStateId: DS_ID,
        leaseToken: LEASE,
      }),
    "rich error",
  );
  assert.ok(err instanceof OutboxRpcTransportError);
  assert.equal((err as OutboxRpcTransportError).code, "23505");
  assert.equal((err as OutboxRpcTransportError).reason, null);
  assert.ok(!err.message.includes(leaked), "must not reproduce raw details");
  assert.ok(
    !err.message.includes("duplicate key"),
    "must not reproduce message",
  );
  assert.ok(!err.message.includes(DS_ID), "must not leak an identifier");
});

Deno.test("an error with no safe fields still rejects, without serializing the object", async () => {
  const h = makeHarness(() => ({
    data: null,
    error: { unexpected: { a: 1 } },
  }));
  const err = await assertRejects(
    () =>
      build(h).releaseLease({
        consumerKey: CONSUMER,
        deliveryStateId: DS_ID,
        leaseToken: LEASE,
      }),
    "opaque error",
  );
  assert.ok(err instanceof OutboxRpcTransportError);
  assert.equal((err as OutboxRpcTransportError).code, null);
  assert.ok(!err.message.includes("{"), "must not serialize the error object");
});

Deno.test("no thrown message ever contains the credential, url or lease token", async () => {
  const harnesses = [
    makeHarness(() => ({ data: null, error: { code: "42501" } })),
    makeHarness(() => ({ data: { wrong: true }, error: null })),
  ];
  for (const h of harnesses) {
    const err = await assertRejects(
      () =>
        build(h).claimBatch({
          consumerKey: CONSUMER,
          leaseToken: LEASE,
          batchSize: 10,
        }),
      "hygiene",
    );
    for (const secretish of [KEY_OK, URL_OK, LEASE]) {
      assert.ok(
        !err.message.includes(secretish),
        "error message must not leak configuration or lease identity",
      );
    }
  }
});

// ── Malformed data ──────────────────────────────────────────────────────────

Deno.test("malformed data rejects with a validation error, per method", async () => {
  const cases: Array<[string, unknown, () => Promise<unknown>]> = [];
  const mk = (data: unknown) => makeHarness(() => ({ data, error: null }));

  const h1 = mk({ not: "an array" });
  cases.push(["claimBatch", null, () =>
    build(h1).claimBatch({
      consumerKey: CONSUMER,
      leaseToken: LEASE,
      batchSize: 10,
    })]);

  const h2 = mk({ ok: true });
  cases.push(["markCompleted", null, () =>
    build(h2).markCompleted({
      consumerKey: CONSUMER,
      deliveryStateId: DS_ID,
      leaseToken: LEASE,
    })]);

  const h3 = mk({
    ok: true,
    delivery_state_id: DS_ID,
    status: "leased",
    attempt_count: 1,
    available_at: T1,
    dead_letter_at: null,
  });
  cases.push(["markFailed", null, () =>
    build(h3).markFailed({
      consumerKey: CONSUMER,
      deliveryStateId: DS_ID,
      leaseToken: LEASE,
      errorCode: null,
      errorSummary: null,
    })]);

  const h4 = mk(null);
  cases.push(["releaseLease", null, () =>
    build(h4).releaseLease({
      consumerKey: CONSUMER,
      deliveryStateId: DS_ID,
      leaseToken: LEASE,
    })]);

  for (const [label, , run] of cases) {
    const err = await assertRejects(run, label);
    assert.ok(
      err instanceof OutboxRpcValidationError,
      `${label}: expected OutboxRpcValidationError`,
    );
  }
});

// ── Abort, no-retry, no-fallback ────────────────────────────────────────────

Deno.test("an aborted request rejects and the rejection propagates unchanged", async () => {
  const boom = new Error("aborted by deadline");
  const h = makeHarness(okFor);
  const aborting: SupabaseRpcTransport = {
    rpc<T>(): RpcRequest<T> {
      const rejected = () => Promise.reject(boom) as Promise<RpcResult<T>>;
      return {
        abortSignal: () => rejected(),
        then(onfulfilled, onrejected) {
          return rejected().then(onfulfilled, onrejected);
        },
      };
    },
  };
  const client = createSupabaseOutboxRpcClient({
    supabaseUrl: URL_OK,
    secretKey: KEY_OK,
    timeoutMs: TIMEOUT,
    clientFactory: () => aborting,
    abortSignalFactory: h.abortSignalFactory,
  });

  const err = await assertRejects(
    () =>
      client.claimBatch({
        consumerKey: CONSUMER,
        leaseToken: LEASE,
        batchSize: 10,
      }),
    "abort",
  );
  assert.equal(err, boom, "the original rejection must propagate");
});

Deno.test("a failing call is attempted exactly once — there is no retry and no fallback result", async () => {
  const h = makeHarness(() => ({ data: null, error: { code: "42501" } }));
  const client = build(h);

  await assertRejects(
    () =>
      client.claimBatch({
        consumerKey: CONSUMER,
        leaseToken: LEASE,
        batchSize: 10,
      }),
    "first",
  );
  assert.equal(h.transport.calls.length, 1, "exactly one attempt");

  // A later, independent call is not manufactured by the adapter itself.
  await assertRejects(
    () =>
      client.markFailed({
        consumerKey: CONSUMER,
        deliveryStateId: DS_ID,
        leaseToken: LEASE,
        errorCode: null,
        errorSummary: null,
      }),
    "second",
  );
  assert.equal(
    h.transport.calls.length,
    2,
    "one attempt per caller invocation",
  );
});

// ── Independence guards ─────────────────────────────────────────────────────

Deno.test("the adapter needs no environment and no network to operate", async () => {
  // Nothing in this file grants --allow-env or --allow-net. A successful run
  // is itself the proof: any environment read or socket open would fail under
  // the read-only permission set this suite is executed with.
  const h = makeHarness(okFor);
  const claimed = await build(h).claimBatch({
    consumerKey: CONSUMER,
    leaseToken: LEASE,
    batchSize: 10,
  });
  assert.equal(claimed.length, 1);
});
