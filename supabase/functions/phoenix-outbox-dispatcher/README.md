# Edge Function — `phoenix-outbox-dispatcher`

**D3-2A slice only: authentication, health, and configuration validation.** No
Outbox access, no database connection, no scheduler wiring, no consumer
registration. **Not authorized for deployment.**

Full contract, threat model, and test/negative-control plan:
[`docs/phoenix/D3-2A-OUTBOX-DISPATCHER-AUTH-HEALTH.md`](../../../docs/phoenix/D3-2A-OUTBOX-DISPATCHER-AUTH-HEALTH.md).

## Request and response

```text
GET /functions/v1/phoenix-outbox-dispatcher
X-Phoenix-Dispatch-Secret: <shared secret>

-> 200 { service, status: "ok",       version, timestamp }
-> 503 { service, status: "degraded", version, timestamp }   (SUPABASE_SECRET_KEYS config invalid)
-> 401 { ok: false, error: "NOT_AUTHENTICATED" }   (missing / empty / incorrect / ambiguous secret header)
-> 405 { ok: false, error: "METHOD_NOT_ALLOWED" }  (any method other than GET)
-> 400 { ok: false, error: "MALFORMED_REQUEST" }   (unexpected request body)
-> 500 { ok: false, error: "NOT_CONFIGURED" }       (server's own secret env var missing/too short/malformed)
```

Every response above also carries `Cache-Control: no-store` alongside
`Content-Type: application/json` — set once in `lib/handler.ts`'s centralized
`jsonResponse`, so it applies to all six status classes by construction
(table-driven test in `lib/handler_test.ts`).

## Secret

Reads `PHOENIX_OUTBOX_DISPATCH_SECRET` — no default, no fallback to any other
key. Fails closed (`500 NOT_CONFIGURED`) if absent, empty, shorter than 32
characters, or containing a comma. **Not set by this change** — no live secret
was introduced and `supabase secrets set` was not run.

## Why no Outbox or database access here

This is intended to become the first artifact ever deployed to Production for
D3-2 (per the amended architecture plan), and the first deployment must be
provably incapable of touching Outbox state — not merely disabled by convention.
Every `phoenix_outbox_*` RPC/table name, `createClient(`, `.rpc(`, and `fetch(`
call is verified absent from this directory's source by
`lib/static_guards_test.ts`.

## Key resolution

Does **not** reuse `../_shared/edge-auth.ts`'s `resolveEdgeApiKeys` — that
function requires both `SUPABASE_SECRET_KEYS` _and_ `SUPABASE_PUBLISHABLE_KEYS`,
because the three existing admin-* functions genuinely need both (a
caller-scoped client for a browser JWT, plus a privileged client). This endpoint
has no caller-scoped client and no browser-JWT concept, so it has no use for
`SUPABASE_PUBLISHABLE_KEYS` — requiring it anyway would be an unnecessary
coupling and a false "degraded" signal if only that unrelated variable were
absent. `lib/config.ts`'s `checkSecretKeyConfiguration` instead re-implements
just the `SUPABASE_SECRET_KEYS` half of that same validation shape locally,
without modifying the shared helper. It never constructs a Supabase client and
never retains the resolved key value.

Does **not** reuse `parseBearerAuthorization` either: this endpoint
authenticates a scheduler via one static shared-secret header, not a browser
user via a JWT, so it uses its own narrowly-scoped `lib/auth.ts` instead.

## Tests

Deno-native (`Deno.test`), colocated as `lib/*_test.ts` (not `*.test.ts`, so the
repository's vitest suite — which scans `src/` and
`supabase/migrations/__tests__/` — never attempts to collect or execute them).
Run with `deno test` from this directory. No Docker, Supabase daemon, Postgres,
or network access required.
