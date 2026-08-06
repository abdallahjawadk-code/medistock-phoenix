# D3-2A — Outbox Dispatcher: Auth, Health, and Configuration Validation

Function: `supabase/functions/phoenix-outbox-dispatcher/`
Status: local source + unit tests only. **Not deployed. Deployment is not
authorized for this slice.**

## Boundary

D3-2A adds exactly one new Edge Function directory. It does **not** add: any
call to `phoenix_outbox_claim_batch`, `phoenix_outbox_mark_completed`,
`phoenix_outbox_mark_failed`, or `phoenix_outbox_release_lease`; any
reference to `phoenix_outbox_consumers` or `phoenix_outbox_delivery_state`;
a consumer registration; a database connection of any kind; a scheduler
(Supabase Cron, GitHub Actions, or Vercel Cron); `pg_cron`/`pg_net`/Vault;
Migration 164; or any change to `supabase/config.toml`,
`.github/workflows/`, `vercel.json`, or the three existing Edge Functions.
All of this is proven structurally, not just by omission — see "Tests and
negative controls" below.

This document, together with `supabase/functions/phoenix-outbox-dispatcher/README.md`,
is the complete record of what D3-2A is and is not.

## Why this slice exists, and why it has no Outbox access

Per the amended D3-2 architecture plan, the first artifact ever deployed to
Production for D3-2 must be provably incapable of claiming, completing,
failing, or releasing any Outbox row — not merely disabled by a flag, but
structurally absent from the source. Registering a consumer and then
immediately marking a naive skeleton's claims "completed" without a real
delivery would fabricate permanent, misleading `completed` delivery-state
rows for real historical Production events (see the architecture-amendment
report for the full mechanism). D3-2A sidesteps that entirely by containing
no code path that could do it: the deployment pipeline, authentication
mechanism, and configuration resolution are validated in complete isolation
from any Outbox behavior, which is added only in later, separately
authorized slices (D3-2B onward).

## Endpoint contract

```text
GET /functions/v1/phoenix-outbox-dispatcher
X-Phoenix-Dispatch-Secret: <shared secret>
```

Only `GET` is accepted; every other method returns `405`. The endpoint takes
no body; a request carrying one returns `400`. Every response, on every
status code below, carries `Content-Type: application/json` and
`Cache-Control: no-store` — the latter is a fix from the final D3-2A
commit-readiness review: since this endpoint's response varies by whether
the caller presented the correct secret, an intermediary that cached a
response could otherwise serve a previously-authenticated result to a
caller who never authenticated. Both headers are set in one centralized
response builder (`lib/handler.ts`'s `jsonResponse`), so every status class
carries them by construction, verified by a table-driven test
(`lib/handler_test.ts`) that checks all six.

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ service, status: "ok", version, timestamp }` | Authenticated; server's own `SUPABASE_SECRET_KEYS` configuration is structurally valid |
| 503 | `{ service, status: "degraded", version, timestamp }` | Authenticated; server's own `SUPABASE_SECRET_KEYS` configuration is missing or malformed |
| 401 | `{ ok: false, error: "NOT_AUTHENTICATED" }` | Missing, empty, incorrect, or ambiguous/duplicated secret header — all four cases return this identical response |
| 405 | `{ ok: false, error: "METHOD_NOT_ALLOWED" }` | Any method other than `GET` |
| 400 | `{ ok: false, error: "MALFORMED_REQUEST" }` | A body was present on the request |
| 500 | `{ ok: false, error: "NOT_CONFIGURED" }` | The server's own `PHOENIX_OUTBOX_DISPATCH_SECRET` is missing, empty, too short, or contains a comma |

No response on any path ever includes: an environment variable value, a
secret (caller-supplied or server-configured, correct or incorrect), a
database identifier (project ref, connection string, table/RPC name), or an
internal stack trace. The function never calls `console.*` on any path,
verified by test.

Field ordering deliberately keeps `service`/`status`/`version`/`timestamp`
as the *entire* body on success — no extra fields, so an authenticated
caller (the scheduler) gets a stable, minimal contract to parse.

## Secret contract

| | |
|---|---|
| Environment variable | `PHOENIX_OUTBOX_DISPATCH_SECRET` |
| Header | `X-Phoenix-Dispatch-Secret` |
| Default value | None |
| Fallback | None — never falls back to any other key, public or otherwise |
| Minimum length | 32 characters |
| Character constraint | Must not contain a comma (see "Why ambiguous headers are rejected" below) |
| Generation | A cryptographically random value, e.g. `openssl rand -base64 32` or longer — never a human-chosen phrase |
| Storage | Not yet decided operationally — this slice does not set, deploy, or reference a live value anywhere. When D3-2C/D3-2F set one, it must be stored as a Supabase Edge Function secret (`supabase secrets set`, out of scope here) and, if a GitHub-Actions-based scheduler is used, mirrored as a GitHub Actions environment secret. Never as a `VITE_`-prefixed variable — those compile into the public client bundle. |
| Rotation | No mechanism exists yet in this repository for any secret; establishing one is out of scope for D3-2A. |

No real value for this secret appears anywhere in this change — not in
source, not in test fixtures (tests use `'x'.repeat(32)` and other
obviously-synthetic placeholders), not in this document, not in any log.

## Threat model

**In scope for this slice:**
- An unauthenticated network caller attempting to reach the endpoint without
  the correct secret. Mitigated by `lib/auth.ts`'s timing-resistant,
  full-length comparison (it always walks the entire longer input and never
  returns early on the first mismatching byte — this is a deliberate
  avoidance of the obvious early-exit timing side channel, not an absolute
  cryptographic constant-time guarantee, which JavaScript on a JIT-compiled
  VM cannot make) and by collapsing every distinct failure reason
  (missing/empty/incorrect/ambiguous) into one identical `401` response — an
  attacker cannot use response differences to narrow down which failure
  mode they hit.
- A caller attempting to smuggle a second, conflicting value for the auth
  header (HTTP header duplication/pollution). Rejected as `ambiguous`,
  itself collapsed into the same generic `401`.
- Accidental logging or response-body leakage of the secret, in any branch,
  correct or incorrect. Verified by test (`lib/handler_test.ts`).
- Server misconfiguration (missing/weak/malformed secret) being exploitable
  as an authentication bypass. Explicitly ordered so the server resolves
  its own secret *before* evaluating the caller's header, and fails closed
  (`500`) rather than open in every such case.

**Out of scope for this slice (because there is nothing here to attack):**
- Any interaction with `phoenix_outbox_*` state — there is no code path
  capable of it.
- Replay of a captured, valid secret value — a static shared secret has no
  built-in replay protection (no nonce, no timestamp signing). This is an
  accepted limitation for an internal scheduler-to-function channel over
  HTTPS and is not addressed here; if this needs strengthening later
  (e.g. HMAC-signed, time-boxed tokens), that is separate, explicitly
  scoped future work, not assumed as already handled.
- Anything requiring Production access, since this slice is never deployed.

### Why ambiguous headers are rejected instead of resolved

The Fetch/WHATWG `Headers` object coalesces repeated instances of the same
header name (including case-variant duplicates, since header names are
case-insensitive) into one comma-joined string before any application code
ever sees it — `Headers.get()` never exposes the original, separate values.
By the time `lib/auth.ts` runs, the only remaining signal that a header was
sent more than once is a value containing more than one non-empty,
comma-separated segment. Rather than guessing which segment was "real" (an
attacker-influenceable choice), the endpoint treats any such value as
ambiguous and rejects it outright. This is also why the configured secret
itself must never contain a comma — `lib/config.ts` enforces that at
resolution time so a legitimate secret can never collide with this
detection logic and permanently lock every caller out.

## Failure behavior, summarized

Every failure path returns a small, generic, non-differentiating JSON body
and an appropriate HTTP status; nothing is ever logged. A misconfigured
server fails closed as `500` before any caller input is even inspected. An
unauthenticated caller always receives `401`, regardless of *why* — even if
the server's downstream configuration also happens to be degraded, an
unauthenticated caller never learns that (`503` is only ever returned to an
already-authenticated caller).

## Shared-helper decision

`../_shared/edge-auth.ts` is **not imported by this function at all.**
Its `resolveEdgeApiKeys` function requires both `SUPABASE_SECRET_KEYS` *and*
`SUPABASE_PUBLISHABLE_KEYS` to be present and well-formed, because the three
existing admin-* functions genuinely need both: a caller-scoped client
(publishable key) to verify a browser user's JWT, plus a privileged client
(secret key). This endpoint has no caller-scoped client and no browser-JWT
concept at all — it has no use for `SUPABASE_PUBLISHABLE_KEYS`, and calling
the bundled dual-key function anyway would report this endpoint "degraded"
whenever that entirely unrelated variable happened to be absent, an
unnecessary coupling to a shared helper this endpoint only half-needs.

`lib/config.ts`'s `checkSecretKeyConfiguration` instead re-implements just
the `SUPABASE_SECRET_KEYS` half of that same validation shape (a JSON
object with a `default` property carrying the correct key-class prefix)
locally, without modifying `_shared/edge-auth.ts` (out of scope for D3-2A)
and without ever constructing a Supabase client or retaining the resolved
key value beyond a boolean + non-sensitive issue code. `lib/handler_test.ts`
proves the decoupling directly: an environment with `SUPABASE_SECRET_KEYS`
set but `SUPABASE_PUBLISHABLE_KEYS` entirely absent still returns `200`,
not `503`.

`parseBearerAuthorization` from that same shared file is **not** reused. It parses
a browser user's `Authorization: Bearer <jwt>` header — a different caller,
a different credential shape, and a different threat model from a
scheduler presenting one static shared secret. Reusing it here would have
implied this endpoint accepts user JWTs, which it must not (per the owner's
explicit instruction not to automatically reuse browser/user JWT
verification, admin-user authorization, or profile/RBAC assumptions). A new,
narrowly-scoped local module, `lib/auth.ts`, was written instead — local to
this function's own directory rather than added to `_shared/`, to keep this
change's surface to exactly what D3-2A needs and avoid implying a
repository-wide convention prematurely.

## Tests and negative controls

Deno-native (`Deno.test`), colocated as `lib/*_test.ts` — this naming
(underscore, not `.test.ts`) is deliberate: the repository's vitest suite
(which has no configured `include`/`exclude` and therefore uses Vitest's
own default `**/*.{test,spec}.ts` glob) would otherwise attempt to collect
and execute these files under Node, where `Deno.test`/`Deno.serve` are not
defined. `_test.ts` does not match that glob, so the two test ecosystems
never collide. Every test module uses only pure functions, the standard
Fetch API (`Request`/`Headers`/`Response`, available natively in Deno), and
Node's built-in `node:assert` — no external package, no network fetch of a
test-framework module, no Docker, no Postgres, no Supabase daemon.

Positive tests: correct secret + supported method returns success and the
exact minimal health contract; the pure auth/config/health functions are
each proven deterministic for identical inputs.

Negative controls, one-to-one with the required list: missing header,
empty header, incorrect secret, duplicated/ambiguous header (including a
case-variant duplicate), missing configured server secret, server secret
below minimum length (and, additionally, containing a comma), unsupported
HTTP method, malformed request (unexpected body), no secret in the response
body on any path, no secret in error output, no secret ever reaches
`console.*`, and the existing three Edge Functions are provably unreferenced
by this one.

Two corrections from the final D3-2A commit-readiness review are covered
directly: a single table-driven test in `lib/handler_test.ts` asserts
`Cache-Control: no-store` and `Content-Type: application/json` on all six
response classes (200, 503, 401, 405, 400, 500); and `lib/config_test.ts`
pins `MINIMUM_SECRET_LENGTH === 32` plus literal (not constant-derived)
31-character-rejected / 32-character-accepted boundary checks, so a future
weakening of that constant fails a test instead of passing silently.

Static guards (`lib/static_guards_test.ts`) prove, by reading this
directory's own source text, what runtime tests alone cannot fully prove —
a true absence: none of the six prohibited D3-1 identifiers appear anywhere
in this function's source; no `createClient(`, `.rpc(`, or `.from('table')`
call exists; no `fetch(` call exists; no `SUPABASE_SERVICE_ROLE_KEY`
reference exists; no `pg_cron`/`pg_net`/`cron.schedule` reference exists; no
raw Postgres connection string or `pg` driver import exists; and none of the
three existing function names are referenced.

## Authorization boundary for D3-2B and beyond

D3-2A ends here. Nothing in this slice registers a consumer, claims an
event, or wires a scheduler. The next authorized slice, D3-2B, is an
isolated/Staging claim-complete test using a dedicated, clearly-marked
non-production probe consumer against a disposable `pg-rig` (or genuine
Staging) database — never Production, never this deployed function's real
Production instance (which does not yet exist, since deployment itself is
not authorized here). D3-2C (scheduler), D3-2D (real delivery target), and
onward remain exactly as scoped in the architecture-amendment report and
require their own separate owner authorization. This document does not
finalize a scheduler mechanism or a delivery target — both remain
deliberately undecided.

## Deployment status

**Not deployed. Not authorized for deployment by this change.**
`supabase functions deploy` was not run; the linked Supabase project was not
contacted; no live secret was set (`supabase secrets set` was not run); no
consumer was registered; `supabase/config.toml` was not edited.
