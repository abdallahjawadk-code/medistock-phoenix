# D3-2C — Production RPC Adapter (Unwired)

Status: **locally implemented and validated. Not staged, not committed, not deployed.**

D3-2C adds the production Outbox RPC adapter and the runtime result-validation
boundary it depends on. The adapter is **unwired and unreachable**: nothing
imports it, and the deployed artifact's behavior is unchanged from D3-2A.

---

## 1. Scope

Seven files — six new, one narrowed:

| File | Kind | Role |
| --- | --- | --- |
| `supabase/functions/phoenix-outbox-dispatcher/lib/supabase-rpc-adapter.ts` | new | `OutboxRpcClient` over an **injected** structural transport |
| `supabase/functions/phoenix-outbox-dispatcher/lib/rpc-result-validation.ts` | new | Pure runtime validators, shared by the adapter and the pg-rig suite |
| `supabase/functions/phoenix-outbox-dispatcher/lib/supabase-rpc-adapter_test.ts` | new | Tier A — adapter logic, injected fake transport |
| `supabase/functions/phoenix-outbox-dispatcher/lib/rpc-result-validation_test.ts` | new | Tier A — validator behavior, table-driven |
| `supabase/migrations/__tests__/163-d3-2c-rpc-result-shape.dynamic.test.ts` | new | Tier B — real Migration 163 result shapes |
| `supabase/functions/phoenix-outbox-dispatcher/lib/static_guards_test.ts` | **modified** | Narrowed allow-list + new positive guards |
| `docs/phoenix/D3-2C-PRODUCTION-RPC-ADAPTER.md` | new | This document |

**`index.ts` and `lib/handler.ts` are unchanged**, byte-identical to commit
`8409d66`. The HTTP path is still health/auth/configuration-only.

Explicitly **out of scope and absent**: HTTP-handler wiring; environment
parsing; a dispatch-enabled flag; `verify_jwt` configuration; Migration 164;
any scheduler; any consumer registration; any secret; any deployment; any
Production contact.

---

## 2. The D1 owner ruling — no supabase-js runtime dependency

D3-2C imports **nothing remote**: no `npm:` specifier, no `https:` module, no
`@supabase/supabase-js`, no `@supabase/server`, no import map, no `deno.json`,
no `deno.lock`, and no change to `package.json`.

Instead the adapter declares a **minimal structural boundary** for the one
capability it needs and takes the transport in by injection:

```ts
interface SupabaseRpcTransport {
  rpc<T>(functionName: string, args: Record<string, unknown>): RpcRequest<T>;
}
```

Consequences, all deliberate:

- **This slice contains no supabase-js runtime dependency.**
- **D3-2D runtime composition must select and pin an exact, reviewed version.**
  No version is recorded or selected here — pinning is a D3-2D decision made at
  the point where the real client is actually constructed.
- D3-2C stays fully offline-validatable: `deno fmt`, `lint`, `check` and `test`
  need no network, no module cache, and no dependency resolution.

`createClient` is never called anywhere, including inside the adapter.

---

## 3. Adapter contract

```ts
createSupabaseOutboxRpcClient({
  supabaseUrl,        // injected, validated as a non-empty https URL
  secretKey,          // injected, presence-checked only
  timeoutMs,          // injected, positive safe integer, <= MAX_TIMEOUT_MS
  clientFactory,      // injected, invoked EXACTLY ONCE per adapter instance
  abortSignalFactory, // optional; defaults to AbortSignal.timeout
}): OutboxRpcClient
```

- **No environment lookup.** `Deno.env` and `process.env` appear nowhere.
- **No global mutable state.** The transport is built once, at factory time.
- Auth options are passed exactly: `autoRefreshToken: false`,
  `persistSession: false`, `detectSessionInUrl: false`.
- Every request chains `.abortSignal(...)` exactly once, with a signal from
  `abortSignalFactory(timeoutMs)`.
- **Exactly one RPC attempt per method. No retry, no fallback result.** Retry
  policy, backoff and the dead-letter ceiling already live in Migration 163;
  a second, divergent policy is what the D3-2B contract forbids.
- **No table access, no `fetch`, no logging** of any kind — no `console.*`.
- Configuration errors never echo the URL, the credential, or its length.

### Exact RPC surface

| Method | Routine | Arguments |
| --- | --- | --- |
| `claimBatch` | `phoenix_outbox_claim_batch` | `p_consumer_key`, `p_lease_token`, `p_batch_size` |
| `markCompleted` | `phoenix_outbox_mark_completed` | `p_consumer_key`, `p_delivery_state_id`, `p_lease_token` |
| `markFailed` | `phoenix_outbox_mark_failed` | `p_consumer_key`, `p_delivery_state_id`, `p_lease_token`, `p_error_code`, `p_error_summary` |
| `releaseLease` | `phoenix_outbox_release_lease` | `p_consumer_key`, `p_delivery_state_id`, `p_lease_token` |

There is no fifth routine and no direct table access.

---

## 4. Runtime-validation boundary

`lib/rpc-result-validation.ts` is pure: no client, no environment, no network,
no logging. It accepts the **raw snake_case JSON shape** a transport delivers,
validates completely, and only then maps to the D3-2B camelCase types.

- All twelve claim columns validated; **missing and extra fields both rejected**.
- UUID-shaped identifiers validated by shape and **returned unchanged** — case
  is never normalized.
- Timestamps validated as ISO-8601 strings and **never converted to `Date`**.
- `payload` must be a JSON object, matching Migration 158's own
  `jsonb_typeof(payload) = 'object'` constraint. Contents are never inspected.
- `markFailed.status` must be exactly `pending` or `dead_letter`.
- **Never coerces, never defaults, never returns a partially validated value.**

Errors are `OutboxRpcValidationError`, carrying the offending **field path and
expectation only** — never the value, never a serialized object, never a
credential, URL, lease token, or payload content.

Transport failures become `OutboxRpcTransportError`, which preserves the
SQLSTATE-style `code` and a `reason` **only** when the database's message is a
bare snake_case identifier — the exact form Migration 163 raises. Any richer
message is dropped, because a generic Postgres error can embed row values.

---

## 5. Static-guard narrowing, and why it is safe

The existing D3-2A prohibitions are **narrowed for exactly one path, never
deleted**:

- `createClient(`, `.from('…')`, `fetch(`, `SUPABASE_SERVICE_ROLE_KEY`,
  `pg_cron`/`pg_net`, `postgresql://`, and `pg` imports remain prohibited in
  **every** production file **including the adapter**.
- The two D3-1 **table** names remain prohibited everywhere, including the
  adapter — its authority is four routines, never a table.
- Only `lib/supabase-rpc-adapter.ts` may carry the four **routine** names and
  `.rpc(`.

Four new positive guards bound that narrowing:

1. the allow-listed adapter **must** actually carry those identifiers, so the
   allow-list cannot silently cover a file that no longer needs it;
2. **exactly one** production file carries them — asserted by scanning all;
3. the adapter's own prohibitions hold, including no remote import, no
   `Deno.env`/`process.env`, no `console.*`, and no request auth-header
   construction;
4. **no non-test production file imports** the adapter or the validation module
   (the adapter may import the validators), and `index.ts`/`handler.ts` remain
   free of every dispatch and adapter identifier.

**A pre-existing hole was closed in passing.** The original guard used
`/\.rpc\s*\(/`, which does not match `.rpc<T>(…)` — the shape a typed client is
normally called with. The guard now uses `/\.rpc\s*(<[^>]*>)?\s*\(/`, so
generic-parameterized calls are caught. This strengthens the rule for every
file. Reachability is now judged by **import specifiers** rather than raw
substrings, so a module named in a comment is documentation while a module
named in an import is a live edge in the dependency graph.

---

## 6. Three proof tiers

| Tier | What it is | What it proves | What it cannot prove |
| --- | --- | --- | --- |
| **A** | Offline Deno unit tests, injected fake transport | RPC names, argument mapping, abort wiring, validation hand-off, error sanitization, no-retry | Anything about the network |
| **B** | pg-rig dynamic suite, test-only `PgRpcInvoker` over direct PostgreSQL wire | Real Migration 163 result shapes satisfy the shared validators; real rejections propagate; Outbox rows unmodified | **Nothing about HTTP transport** |
| **C** | Hosted non-Production verification (**D3-2E gate**) | Real supabase-js → PostgREST → Edge Function runtime | — |

> **pg-rig does not prove HTTP transport.** Tier B speaks the PostgreSQL wire
> protocol directly. It exercises no HTTP, no PostgREST function-invocation
> semantics, no API-key handling, and no Edge Function runtime. Any claim that
> a pg-rig run validates the production adapter's transport would be false.

**One deliberate transport normalization in tier B:** node-postgres returns
`timestamptz` as `Date`, whereas a JSON transport delivers ISO strings. The
invoker converts those to ISO strings — transport work that PostgREST performs
natively — so the validator keeps a single JSON-shaped contract. The
jsonb-returning routines need no such step.

---

## 7. Security posture

**`service_role` and RLS.** A Supabase secret key maps to the `service_role`
Postgres role, which carries `BYPASSRLS` and skips every Row Level Security
policy. Migration 163 grants EXECUTE on the four routines to `service_role`
alone, so the adapter has no lower-privilege option. Compensating controls:

- the adapter's entire surface is four routines — no table access, enforced by
  static guard;
- it is unreachable (no production importer), enforced by static guard;
- no credential, URL, lease token, payload, or raw database error is ever
  logged or placed in an error message;
- dispatch remains unwired, no consumer is registered, and no secret exists.

**Credential recommendation for D3-2D:** prefer a **dedicated, named
`sb_secret_*` key** for the dispatcher. Do not assume the default key is the
long-term choice. Secret creation and selection remain hosted, owner-gated
operations; none was performed here.

**`verify_jwt = false` belongs to D3-2D.** New-style publishable/secret keys
are not JWTs, Edge Functions verify JWTs only via the legacy `anon`/
`service_role` keys, and the platform does not verify the `apikey` header — so
a service-to-service caller requires JWT verification disabled plus in-function
authorization. `X-Phoenix-Dispatch-Secret` remains the real authentication
factor. No configuration change is made in this slice.

---

## 8. What is still not done

- No HTTP-handler wiring; `index.ts` and `handler.ts` unchanged.
- No environment parsing and no runtime composition.
- No supabase-js version selected or pinned.
- No Migration 164.
- No scheduler, no consumer registration, no secret creation.
- No deployment, no push, no PR.
- No Production contact of any kind.

D3-2D and beyond require separate authorization.
