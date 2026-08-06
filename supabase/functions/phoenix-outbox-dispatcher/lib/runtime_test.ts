// Offline tests for lib/runtime.ts (D3-2D).
//
// Every transport is an in-memory fake injected through clientFactory, so
// these prove the WIRING — gate order, disabled-by-default behavior, zero
// construction while disabled, fail-closed configuration, one cycle per
// request, and response sanitization. They prove nothing about the real
// supabase-js/PostgREST path, which is the D3-2E hosted gate.
//
// No environment, network, filesystem-write, subprocess, FFI, or system
// permission is used; every credential and identifier is synthetic.
import { strict as assert } from "node:assert";

import { handleDispatcherRuntime } from "./runtime.ts";
import { ARTIFACT_VERSION, SERVICE_NAME } from "./health.ts";
import { DISPATCH_SECRET_ENV_VAR } from "./config.ts";
import {
  CONSUMER_KEY_ENV_VAR,
  DISPATCH_ENABLED_ENV_VAR,
  SECRET_KEYS_ENV_VAR,
  SUPABASE_URL_ENV_VAR,
} from "./runtime-config.ts";
import type {
  RpcRequest,
  RpcResult,
  SupabaseRpcTransport,
} from "./supabase-rpc-adapter.ts";

const SECRET = "probe_nonprod_dispatch_secret_value_32ch";
const URL_OK = "https://probe-nonprod-d3-2d.example.invalid";
const KEY_OK = "sb_secret_probe_nonprod_value_not_real";
const CONSUMER = "probe_nonprod_d3_2_v1-runtime";
const LEASE = "00000000-0000-0000-0000-0000032d00aa";
const DS_ID = "00000000-0000-0000-0000-0000032d0001";
const EV_ID = "00000000-0000-0000-0000-0000032d0002";
const AG_ID = "00000000-0000-0000-0000-0000032d0003";
const ORG_ID = "00000000-0000-0000-0000-0000032d0004";
const T0 = "2020-01-01T00:00:00.000Z";
const T1 = "2020-01-01T00:05:00.000Z";
const NOW = new Date("2020-06-01T12:00:00.000Z");

const baseEnv: Record<string, string> = {
  [DISPATCH_SECRET_ENV_VAR]: SECRET,
  [SECRET_KEYS_ENV_VAR]: JSON.stringify({ default: KEY_OK }),
  [SUPABASE_URL_ENV_VAR]: URL_OK,
  [CONSUMER_KEY_ENV_VAR]: CONSUMER,
};

const envOf = (
  overrides: Record<string, string | undefined> = {},
): (name: string) => string | undefined => {
  const merged: Record<string, string | undefined> = {
    ...baseEnv,
    ...overrides,
  };
  return (name: string) => merged[name];
};

const enabledEnv = (overrides: Record<string, string | undefined> = {}) =>
  envOf({ [DISPATCH_ENABLED_ENV_VAR]: "true", ...overrides });

function request(secret: string | null = SECRET): Request {
  const headers = new Headers();
  if (secret !== null) headers.set("X-Phoenix-Dispatch-Secret", secret);
  return new Request("https://probe.example.invalid/", {
    method: "GET",
    headers,
  });
}

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

interface RecordedCall {
  functionName: string;
  args: Record<string, unknown>;
}

function makeTransport(
  respond: (functionName: string) => RpcResult<unknown>,
): { transport: SupabaseRpcTransport; calls: RecordedCall[]; built: number[] } {
  const calls: RecordedCall[] = [];
  const built: number[] = [];
  const transport: SupabaseRpcTransport = {
    rpc<T>(functionName: string, args: Record<string, unknown>): RpcRequest<T> {
      calls.push({ functionName, args });
      const settle = () =>
        Promise.resolve(respond(functionName) as RpcResult<T>);
      return {
        abortSignal: () => settle(),
        then(onfulfilled, onrejected) {
          return settle().then(onfulfilled, onrejected);
        },
      };
    },
  };
  return { transport, calls, built };
}

const okFor = (functionName: string): RpcResult<unknown> => {
  if (functionName === "phoenix_outbox_claim_batch") {
    return { data: [claimRow()], error: null };
  }
  return {
    data: { ok: true, delivery_state_id: DS_ID, available_at: T0 },
    error: null,
  };
};

// ── Disabled by default ─────────────────────────────────────────────────────

Deno.test("with no activation flag the response is byte-for-byte the D3-2A health payload", async () => {
  let factoryCalls = 0;
  const res = await handleDispatcherRuntime(request(), envOf(), NOW, {
    clientFactory: () => {
      factoryCalls += 1;
      throw new Error("must never be constructed while disabled");
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    service: SERVICE_NAME,
    status: "ok",
    version: ARTIFACT_VERSION,
    timestamp: NOW.toISOString(),
  });
  assert.equal(factoryCalls, 0, "no client may be constructed while disabled");
});

Deno.test("no near-miss activation value constructs a client or issues an RPC", async () => {
  for (
    const value of ["", " ", "TRUE", "True", "1", "yes", "true ", "true\n"]
  ) {
    let factoryCalls = 0;
    const res = await handleDispatcherRuntime(
      request(),
      envOf({ [DISPATCH_ENABLED_ENV_VAR]: value }),
      NOW,
      {
        clientFactory: () => {
          factoryCalls += 1;
          throw new Error("must never be constructed");
        },
      },
    );
    const body = await res.json();
    assert.equal(res.status, 200, `${JSON.stringify(value)}: status`);
    assert.equal(body.status, "ok", `${JSON.stringify(value)}: stays health`);
    assert.equal(factoryCalls, 0, `${JSON.stringify(value)}: no construction`);
  }
});

// ── Gates run before activation, configuration, and construction ────────────

Deno.test("authentication and configuration gates precede every activation path", async () => {
  const cases: Array<
    [string, Request, ReturnType<typeof envOf>, number, string]
  > = [
    [
      "unauthenticated while enabled",
      request("wrong-secret-value-that-is-long-enough"),
      enabledEnv(),
      401,
      "NOT_AUTHENTICATED",
    ],
    [
      "missing header while enabled",
      request(null),
      enabledEnv(),
      401,
      "NOT_AUTHENTICATED",
    ],
    [
      "server secret missing while enabled",
      request(),
      enabledEnv({ [DISPATCH_SECRET_ENV_VAR]: undefined }),
      500,
      "NOT_CONFIGURED",
    ],
    [
      "server secret too short while enabled",
      request(),
      enabledEnv({ [DISPATCH_SECRET_ENV_VAR]: "short" }),
      500,
      "NOT_CONFIGURED",
    ],
  ];
  for (const [label, req, env, status, error] of cases) {
    let factoryCalls = 0;
    const res = await handleDispatcherRuntime(req, env, NOW, {
      clientFactory: () => {
        factoryCalls += 1;
        throw new Error("must never be constructed");
      },
    });
    assert.equal(res.status, status, `${label}: status`);
    assert.equal((await res.json()).error, error, `${label}: error`);
    assert.equal(factoryCalls, 0, `${label}: no client construction`);
  }
});

Deno.test("a method or body violation is rejected before anything else, even when enabled", async () => {
  const post = new Request("https://probe.example.invalid/", {
    method: "POST",
    headers: new Headers({ "X-Phoenix-Dispatch-Secret": SECRET }),
  });
  const res = await handleDispatcherRuntime(post, enabledEnv(), NOW, {
    clientFactory: () => {
      throw new Error("must never be constructed");
    },
  });
  assert.equal(res.status, 405);
  assert.equal((await res.json()).error, "METHOD_NOT_ALLOWED");
});

Deno.test("a degraded (503) configuration never reaches dispatch even when enabled", async () => {
  let factoryCalls = 0;
  const res = await handleDispatcherRuntime(
    request(),
    enabledEnv({ [SECRET_KEYS_ENV_VAR]: undefined }),
    NOW,
    {
      clientFactory: () => {
        factoryCalls += 1;
        throw new Error("must never be constructed");
      },
    },
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).status, "degraded");
  assert.equal(factoryCalls, 0);
});

// ── Enabled: invalid runtime configuration ──────────────────────────────────

Deno.test("enabled but misconfigured fails closed as NOT_CONFIGURED without constructing a client", async () => {
  const overrides: Array<[string, Record<string, string | undefined>]> = [
    ["url missing", { [SUPABASE_URL_ENV_VAR]: undefined }],
    ["url not https", { [SUPABASE_URL_ENV_VAR]: "http://insecure.invalid" }],
    ["consumer missing", { [CONSUMER_KEY_ENV_VAR]: undefined }],
    ["consumer invalid", { [CONSUMER_KEY_ENV_VAR]: "Not Valid" }],
  ];
  for (const [label, override] of overrides) {
    let factoryCalls = 0;
    const res = await handleDispatcherRuntime(
      request(),
      enabledEnv(override),
      NOW,
      {
        clientFactory: () => {
          factoryCalls += 1;
          throw new Error("must never be constructed");
        },
      },
    );
    assert.equal(res.status, 500, `${label}: status`);
    const body = await res.json();
    assert.equal(body.error, "NOT_CONFIGURED", `${label}: error`);
    assert.ok(
      !JSON.stringify(body).includes(KEY_OK),
      `${label}: must not echo the key`,
    );
    assert.equal(factoryCalls, 0, `${label}: no client construction`);
  }
});

// ── Enabled: one cycle, exact surface ───────────────────────────────────────

Deno.test("enabled and configured runs exactly one cycle over the four approved routines", async () => {
  const { transport, calls } = makeTransport(okFor);
  let factoryCalls = 0;
  const res = await handleDispatcherRuntime(request(), enabledEnv(), NOW, {
    clientFactory: (options) => {
      factoryCalls += 1;
      assert.equal(options.supabaseUrl, URL_OK);
      assert.equal(options.secretKey, KEY_OK);
      assert.deepEqual(options.auth, {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      });
      return transport;
    },
    newLeaseToken: () => LEASE,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    service: SERVICE_NAME,
    status: "dispatched",
    version: ARTIFACT_VERSION,
    timestamp: NOW.toISOString(),
    claimed: 1,
    completed: 0,
    failed: 0,
    released: 1,
  });
  assert.equal(factoryCalls, 1, "exactly one client per request");
  assert.deepEqual(calls.map((c) => c.functionName), [
    "phoenix_outbox_claim_batch",
    "phoenix_outbox_release_lease",
  ]);
  for (const call of calls) {
    assert.equal(call.args.p_consumer_key, CONSUMER);
    assert.equal(call.args.p_lease_token, LEASE);
  }
});

Deno.test("an empty claim yields a zero summary and exactly one RPC", async () => {
  const { transport, calls } = makeTransport(() => ({
    data: [],
    error: null,
  }));
  const res = await handleDispatcherRuntime(request(), enabledEnv(), NOW, {
    clientFactory: () => transport,
    newLeaseToken: () => LEASE,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.claimed, 0);
  assert.equal(body.released, 0);
  assert.equal(calls.length, 1);
});

Deno.test("the default processor never completes or fails a row — it only releases", async () => {
  const { transport, calls } = makeTransport(okFor);
  await handleDispatcherRuntime(request(), enabledEnv(), NOW, {
    clientFactory: () => transport,
    newLeaseToken: () => LEASE,
  });
  const names = calls.map((c) => c.functionName);
  assert.ok(!names.includes("phoenix_outbox_mark_completed"));
  assert.ok(!names.includes("phoenix_outbox_mark_failed"));
});

// ── Enabled: failure paths ──────────────────────────────────────────────────

Deno.test("a transport failure becomes a sanitized 500 with no retry", async () => {
  const leaked =
    "Key (id)=(00000000-0000-0000-0000-0000032d0009) already exists";
  const { transport, calls } = makeTransport(() => ({
    data: null,
    error: { code: "23505", message: leaked, details: leaked, hint: leaked },
  }));
  const res = await handleDispatcherRuntime(request(), enabledEnv(), NOW, {
    clientFactory: () => transport,
    newLeaseToken: () => LEASE,
  });
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.equal(text, JSON.stringify({ ok: false, error: "DISPATCH_FAILED" }));
  assert.ok(!text.includes(leaked), "must not leak a database message");
  assert.ok(!text.includes("23505"), "must not leak a code");
  assert.equal(calls.length, 1, "exactly one attempt — no retry");
});

Deno.test("a malformed result becomes a sanitized 500 and never a partial summary", async () => {
  const { transport } = makeTransport(() => ({
    data: [{ delivery_state_id: DS_ID }],
    error: null,
  }));
  const res = await handleDispatcherRuntime(request(), enabledEnv(), NOW, {
    clientFactory: () => transport,
    newLeaseToken: () => LEASE,
  });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ok: false, error: "DISPATCH_FAILED" });
});

Deno.test("a timeout-shaped rejection is not converted into a success", async () => {
  const aborted: SupabaseRpcTransport = {
    rpc<T>(): RpcRequest<T> {
      const rejected = () =>
        Promise.reject(new Error("aborted by deadline")) as Promise<
          RpcResult<T>
        >;
      return {
        abortSignal: () => rejected(),
        then(onfulfilled, onrejected) {
          return rejected().then(onfulfilled, onrejected);
        },
      };
    },
  };
  const res = await handleDispatcherRuntime(request(), enabledEnv(), NOW, {
    clientFactory: () => aborted,
    newLeaseToken: () => LEASE,
  });
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.ok(!text.includes("aborted"), "must not echo the rejection message");
});

Deno.test("no response ever contains the credential, url, or dispatch secret", async () => {
  const { transport } = makeTransport(okFor);
  for (
    const [req, env] of [
      [request(), envOf()],
      [request(), enabledEnv()],
      [request(null), enabledEnv()],
      [request(), enabledEnv({ [SUPABASE_URL_ENV_VAR]: undefined })],
    ] as Array<[Request, ReturnType<typeof envOf>]>
  ) {
    const res = await handleDispatcherRuntime(req, env, NOW, {
      clientFactory: () => transport,
      newLeaseToken: () => LEASE,
    });
    const text = await res.text();
    for (const secretish of [SECRET, KEY_OK, URL_OK, LEASE]) {
      assert.ok(
        !text.includes(secretish),
        `a response must never carry ${secretish.slice(0, 12)}…`,
      );
    }
  }
});

Deno.test("every response carries no-store and a JSON content type", async () => {
  const { transport } = makeTransport(okFor);
  for (const env of [envOf(), enabledEnv()]) {
    const res = await handleDispatcherRuntime(request(), env, NOW, {
      clientFactory: () => transport,
      newLeaseToken: () => LEASE,
    });
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("content-type"), "application/json");
  }
});
