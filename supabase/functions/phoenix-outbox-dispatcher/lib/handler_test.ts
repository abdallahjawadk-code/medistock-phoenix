import { strict as assert } from "node:assert";
import { handleDispatcherRequest } from "./handler.ts";
import { DISPATCH_SECRET_HEADER } from "./auth.ts";
import { DISPATCH_SECRET_ENV_VAR, MINIMUM_SECRET_LENGTH } from "./config.ts";

const SECRET = "x".repeat(MINIMUM_SECRET_LENGTH);
const NOW = new Date("2026-01-01T00:00:00.000Z");

function env(overrides: Record<string, string | undefined> = {}) {
  // Deliberately does NOT set SUPABASE_PUBLISHABLE_KEYS by default — this
  // endpoint's health check depends only on SUPABASE_SECRET_KEYS (see
  // lib/config.ts's checkSecretKeyConfiguration). The test below asserts
  // this decoupling explicitly.
  const base: Record<string, string | undefined> = {
    [DISPATCH_SECRET_ENV_VAR]: SECRET,
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_placeholder" }),
    ...overrides,
  };
  return (name: string) => base[name];
}

function request(
  init: { method?: string; headers?: HeadersInit } = {},
): Request {
  return new Request(
    "https://example.invalid/functions/v1/phoenix-outbox-dispatcher",
    {
      method: init.method ?? "GET",
      headers: init.headers,
    },
  );
}

Deno.test("handler: correct secret + GET returns 200 with the minimal healthy payload", () => {
  const res = handleDispatcherRequest(
    request({ headers: { [DISPATCH_SECRET_HEADER]: SECRET } }),
    env(),
    NOW,
  );
  assert.equal(res.status, 200);
});

Deno.test("handler: 200 body matches the exact minimal contract", async () => {
  const res = handleDispatcherRequest(
    request({ headers: { [DISPATCH_SECRET_HEADER]: SECRET } }),
    env(),
    NOW,
  );
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), [
    "service",
    "status",
    "timestamp",
    "version",
  ]);
  assert.equal(body.status, "ok");
});

Deno.test("handler: missing header returns 401 NOT_AUTHENTICATED", async () => {
  const res = handleDispatcherRequest(request(), env(), NOW);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "NOT_AUTHENTICATED");
});

Deno.test("handler: empty header returns 401", () => {
  const res = handleDispatcherRequest(
    request({ headers: { [DISPATCH_SECRET_HEADER]: "" } }),
    env(),
    NOW,
  );
  assert.equal(res.status, 401);
});

Deno.test("handler: incorrect secret returns 401", () => {
  const res = handleDispatcherRequest(
    request({ headers: { [DISPATCH_SECRET_HEADER]: "nope" } }),
    env(),
    NOW,
  );
  assert.equal(res.status, 401);
});

Deno.test("handler: duplicate/ambiguous header returns 401", () => {
  const headers = new Headers();
  headers.append(DISPATCH_SECRET_HEADER, SECRET);
  headers.append(DISPATCH_SECRET_HEADER, "another");
  const req = new Request("https://example.invalid/", {
    method: "GET",
    headers,
  });
  const res = handleDispatcherRequest(req, env(), NOW);
  assert.equal(res.status, 401);
});

Deno.test("handler: server secret not configured returns 500 NOT_CONFIGURED", async () => {
  const res = handleDispatcherRequest(
    request({ headers: { [DISPATCH_SECRET_HEADER]: "irrelevant" } }),
    env({ [DISPATCH_SECRET_ENV_VAR]: undefined }),
    NOW,
  );
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, "NOT_CONFIGURED");
});

Deno.test("handler: server secret below minimum strength is treated as not configured (500), regardless of caller input", () => {
  const res = handleDispatcherRequest(
    request({ headers: { [DISPATCH_SECRET_HEADER]: "anything" } }),
    env({ [DISPATCH_SECRET_ENV_VAR]: "tooshort" }),
    NOW,
  );
  assert.equal(res.status, 500);
});

Deno.test("handler: unsupported method returns 405", () => {
  const res = handleDispatcherRequest(
    request({ method: "POST", headers: { [DISPATCH_SECRET_HEADER]: SECRET } }),
    env(),
    NOW,
  );
  assert.equal(res.status, 405);
});

Deno.test("handler: malformed request (unexpected body signaled via content-length on GET) returns 400", async () => {
  const headers = new Headers({
    [DISPATCH_SECRET_HEADER]: SECRET,
    "content-length": "11",
  });
  const req = new Request("https://example.invalid/", {
    method: "GET",
    headers,
  });
  const res = handleDispatcherRequest(req, env(), NOW);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "MALFORMED_REQUEST");
});

Deno.test("handler: an unauthenticated caller gets 401 even when server config is otherwise degraded (no info leak)", () => {
  const res = handleDispatcherRequest(
    request(),
    env({ SUPABASE_SECRET_KEYS: undefined }),
    NOW,
  );
  assert.equal(res.status, 401);
});

Deno.test("handler: SUPABASE_PUBLISHABLE_KEYS being entirely absent does NOT cause a degraded response (deliberately decoupled)", async () => {
  const res = handleDispatcherRequest(
    request({ headers: { [DISPATCH_SECRET_HEADER]: SECRET } }),
    env({ SUPABASE_PUBLISHABLE_KEYS: undefined }),
    NOW,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
});

Deno.test("handler: degraded config surfaces as 503 only to an authenticated caller", async () => {
  const res = handleDispatcherRequest(
    request({ headers: { [DISPATCH_SECRET_HEADER]: SECRET } }),
    env({ SUPABASE_SECRET_KEYS: undefined }),
    NOW,
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.status, "degraded");
});

Deno.test("handler: no secret value appears anywhere in the response body text, on any path", async () => {
  const scenarios = [
    request(),
    request({ headers: { [DISPATCH_SECRET_HEADER]: "wrong-guess-value" } }),
    request({ headers: { [DISPATCH_SECRET_HEADER]: SECRET } }),
  ];
  for (const req of scenarios) {
    const res = handleDispatcherRequest(req, env(), NOW);
    const text = await res.text();
    assert.ok(!text.includes(SECRET));
    assert.ok(!text.includes("wrong-guess-value"));
  }
});

Deno.test("handler: never calls console.* on any path (nothing to leak a secret through)", () => {
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  };
  const captured: unknown[] = [];
  console.log = (...a: unknown[]) => captured.push(a);
  console.error = (...a: unknown[]) => captured.push(a);
  console.warn = (...a: unknown[]) => captured.push(a);
  console.info = (...a: unknown[]) => captured.push(a);
  try {
    handleDispatcherRequest(
      request({ headers: { [DISPATCH_SECRET_HEADER]: "wrong" } }),
      env(),
      NOW,
    );
    handleDispatcherRequest(
      request({ headers: { [DISPATCH_SECRET_HEADER]: SECRET } }),
      env(),
      NOW,
    );
    handleDispatcherRequest(
      request(),
      env({ [DISPATCH_SECRET_ENV_VAR]: undefined }),
      NOW,
    );
  } finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
    console.info = original.info;
  }
  assert.equal(captured.length, 0);
});

Deno.test("handler: every supported response class includes Cache-Control: no-store, and Content-Type is preserved", () => {
  const cases: Array<
    { name: string; expectedStatus: number; build: () => Response }
  > = [
    {
      name: "200 (authenticated, healthy)",
      expectedStatus: 200,
      build: () =>
        handleDispatcherRequest(
          request({ headers: { [DISPATCH_SECRET_HEADER]: SECRET } }),
          env(),
          NOW,
        ),
    },
    {
      name: "503 (authenticated, degraded downstream config)",
      expectedStatus: 503,
      build: () =>
        handleDispatcherRequest(
          request({ headers: { [DISPATCH_SECRET_HEADER]: SECRET } }),
          env({ SUPABASE_SECRET_KEYS: undefined }),
          NOW,
        ),
    },
    {
      name: "401 (missing auth header)",
      expectedStatus: 401,
      build: () => handleDispatcherRequest(request(), env(), NOW),
    },
    {
      name: "405 (unsupported method)",
      expectedStatus: 405,
      build: () =>
        handleDispatcherRequest(
          request({
            method: "POST",
            headers: { [DISPATCH_SECRET_HEADER]: SECRET },
          }),
          env(),
          NOW,
        ),
    },
    {
      name: "400 (malformed request — unexpected body)",
      expectedStatus: 400,
      build: () => {
        const headers = new Headers({
          [DISPATCH_SECRET_HEADER]: SECRET,
          "content-length": "11",
        });
        return handleDispatcherRequest(
          new Request("https://example.invalid/", { method: "GET", headers }),
          env(),
          NOW,
        );
      },
    },
    {
      name: "500 (server's own dispatch secret not configured)",
      expectedStatus: 500,
      build: () =>
        handleDispatcherRequest(
          request({ headers: { [DISPATCH_SECRET_HEADER]: "irrelevant" } }),
          env({ [DISPATCH_SECRET_ENV_VAR]: undefined }),
          NOW,
        ),
    },
  ];

  for (const { name, expectedStatus, build } of cases) {
    const res = build();
    assert.equal(
      res.status,
      expectedStatus,
      `${name}: expected HTTP status ${expectedStatus}`,
    );
    assert.equal(
      res.headers.get("cache-control"),
      "no-store",
      `${name}: expected Cache-Control: no-store`,
    );
    assert.equal(
      res.headers.get("content-type"),
      "application/json",
      `${name}: expected Content-Type: application/json to be preserved`,
    );
  }
});
