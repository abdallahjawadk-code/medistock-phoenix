# D3-2E — Hosted Disabled Verification (Pre-Launch Production)

Status: **hosted verification complete with dispatch DISABLED. No activation, no
event processing, no synthetic data. D3-2F remains owner-gated.**

> **Superseded status note (2026-08-07).** D3-2F has since run under its own owner
> gate and is **CLOSED — Production verified**; see
> [D3-2F-PRODUCTION-ACTIVATION-VERIFICATION.md](D3-2F-PRODUCTION-ACTIVATION-VERIFICATION.md).
> The D3-2E findings recorded below are unchanged and remain accurate **for D3-2E**.

This document records the D3-2E hosted verification of `phoenix-outbox-dispatcher`
against the real pre-launch Production project. Every value below is a
non-sensitive identifier or an aggregate. No secret value, token, database URL,
certificate body, or request header appears anywhere in this file.

---

## 1. Target

| Item | Value |
| --- | --- |
| Project ref | `eyrzxgfkvqybjdgyphap` |
| Project name | MediStock QR Network |
| Classification | **PRE-LAUNCH PRODUCTION REHEARSAL** — the application has not been publicly launched |
| Function | `phoenix-outbox-dispatcher` |
| Source commit | `d8433b92034bb5c828926b64c586ba87e3752553` |
| Review branch | `feat/d3-2d-f-outbox-runtime` (PR #100, Draft) |

This is the **real Production project**, not a separate staging project. It was
authorized as a pre-launch rehearsal only after the database preflight below
proved the Outbox and organization state completely empty.

---

## 2. Database preflight — passed

Executed by the owner through the Supabase SQL Editor as a read-only
`BEGIN TRANSACTION READ ONLY … ROLLBACK` block. Aggregates only; no payload,
identifier list, or personal data was retrieved.

| Check | Result |
| --- | --- |
| `migration_rows` | 163 |
| `missing_001_163` | 0 |
| `version_163_count` | 1 |
| `duplicate_versions` | 0 |
| `migrations_ge_164` | 0 |
| `nonnumeric_migration_versions` | 0 |
| `phoenix_outbox_events` | exists, **0 rows** |
| `phoenix_outbox_consumers` | exists, **0 rows** |
| `phoenix_outbox_delivery_state` | exists, **0 rows** |
| `eligible_rows` | 0 |
| `undiscovered_claimable_events` | 0 |
| `active_leases` / `expired_leases` | 0 / 0 |
| `consumers_total` / `consumers_enabled` / `consumers_enabled_global` | 0 / 0 / 0 |
| `organizations_total` | 0 |
| `ds_outside_consumer_org` / `ds_org_mismatch_vs_event` | 0 / 0 |

Migration history is therefore **exactly 001–163**, with Migration 163 present
exactly once and no Migration 164+. There was **no historical Outbox backlog**
and no cross-organization exposure to protect against.

The four consumer routines were independently confirmed present and matching the
committed Migration 163 definitions — `phoenix_outbox_claim_batch`,
`phoenix_outbox_mark_completed`, `phoenix_outbox_mark_failed`,
`phoenix_outbox_release_lease` — all `SECURITY DEFINER`, owner `postgres`,
`search_path = public, pg_temp`, with argument names, types, order and arity
identical to the migration.

> **Note for `docs/phoenix/STATE.md`.** That document still records
> *"Production has never been connected to"* and a working assumption of
> migration ceiling 147. Both are stale: the migration history is 001–163 and
> eight Edge Functions are deployed. STATE.md should be refreshed before it is
> used as a safety input again.

---

## 3. Deployment — disabled

The deployment command was executed **manually by the owner** from the review
worktree, because the agent's tooling permission layer declined to run it:

```
supabase functions deploy phoenix-outbox-dispatcher --project-ref eyrzxgfkvqybjdgyphap
```

| Item | Value |
| --- | --- |
| Deployment ID | `c30a5c51-b5ba-4fda-9cff-8bc7cf7a642f` |
| Status | `ACTIVE` |
| Version | `1` at deploy; `2` after the secret rotation (Supabase metadata update only — no second deployment) |
| Deployed at (UTC) | 2026-08-06 18:02:42 |
| `verify_jwt` | `false` — **this function only** |

**Deployed-source verification.** The deployed bundle was downloaded read-only
with `supabase functions download` and compared file-by-file against the commit:
**12 production modules, 12 byte-identical to `d8433b92`, 0 differing, 0
unaccounted for.** The `*_test.ts` files and `lib/rpc-client.ts` are absent from
the bundle as expected — the former are never imported, the latter is type-only
and erased at build time.

**`verify_jwt` scope.** Confirmed against the live project: the dispatcher is
`false`; `create-user`, `reset-user-password`, `update-user`, `delete-user`,
`admin-create-user`, `admin-user-lifecycle` and `admin-recycle-user` all remain
`true`. The `supabase/config.verify-jwt-future.toml` transition for the admin
functions remains inactive and untouched.

---

## 4. Secrets

| Secret | State |
| --- | --- |
| `PHOENIX_OUTBOX_DISPATCH_SECRET` | **configured** — value never disclosed |
| `PHOENIX_OUTBOX_DISPATCH_ENABLED` | **absent** |
| `SUPABASE_SECRET_KEYS` | pre-existing; not created, not modified by this work |

The dispatch secret was generated locally from
`System.Security.Cryptography.RandomNumberGenerator` (64 random bytes,
hex-encoded to 128 characters), delivered to Supabase through a temporary
`--env-file` **outside the repository**, and that file was deleted immediately
after the hosted tests. The value was never placed on a command line, written
into the repository, printed, logged, or recorded in shell history. It is not
recoverable from this repository or from any artifact of this task.

`SUPABASE_SECRET_KEYS` already existed before D3-2E and was deliberately left
alone. One unrelated pre-existing secret is malformed — its **name** is a JWT
string with an empty value. It is inert and was **not** touched; cleaning it up
is a separate owner-gated task.

---

## 5. Hosted tests — three, all disabled-state

Three bounded `GET` requests. No request body, no enabled probe, no header value
recorded here.

| # | Test | Expected (committed contract) | Observed | Result |
| --- | --- | --- | --- | --- |
| A | missing `X-Phoenix-Dispatch-Secret` | `401 {"ok":false,"error":"NOT_AUTHENTICATED"}` | identical | ✅ |
| B | incorrect secret (locally generated) | `401 {"ok":false,"error":"NOT_AUTHENTICATED"}` | identical | ✅ |
| C | correct secret, dispatch disabled | D3-2A health payload, returned verbatim | `200 {"service":"phoenix-outbox-dispatcher","status":"ok","version":"d3-2a.1","timestamp":…}` | ✅ |

All three carried `content-type: application/json` and `cache-control: no-store`.

Tests A and B are indistinguishable by design: `lib/auth.ts` collapses missing,
empty, ambiguous and incorrect secrets into one generic response, so a caller
learns nothing about which failure occurred.

Test C is the decisive one. Expected status was **not** assumed: `lib/handler.ts`
returns `200 "ok"` when `SUPABASE_SECRET_KEYS` is well-formed and `503 "degraded"`
otherwise, and that variable pre-existed this work. The observed `200 "ok"` is
therefore the correct contract outcome and additionally proves the hosted
secret-key configuration is well-formed.

---

## 6. Zero-RPC and zero-mutation proof

Supabase CLI 2.109.0 exposes no `functions logs` subcommand, so log-based
evidence was unavailable. The proof below rests on **response-shape** and
**deployed-source structural** evidence, both verified against the live
deployment rather than inferred from the local checkout.

**Response-shape proof (decisive).** `lib/runtime.ts` has exactly one 200-status
path past the activation gate, and it returns
`{service, status:"dispatched", version, timestamp, claimed, completed, failed,
released}`. Test C returned `{service, status:"ok", version:"d3-2a.1",
timestamp}` — the unchanged D3-2A health payload. That payload is only reachable
through `if (!isDispatchEnabled(readEnv)) return gate;`, so the disabled branch
was taken and the dispatch branch was never entered.

**Structural proof, verified on the deployed bundle:**

- gate ordering by source offset — handler `3366` → activation `3535` → client
  construction `3904` → dispatch `4170`; the unchanged D3-2A handler runs first
  and any non-200 is returned verbatim;
- `createClient(` appears in exactly one deployed module (`lib/supabase-client.ts`);
- `.rpc(` appears in exactly one deployed module (`lib/supabase-rpc-adapter.ts`);
- both are reachable only *after* the activation gate;
- activation is strict identity against the literal `"true"` — no trim, no
  case-folding, no truthiness;
- `PHOENIX_OUTBOX_DISPATCH_ENABLED` is absent, so `Deno.env.get` returns
  `undefined` and the comparison is false;
- zero scheduler primitives in the deployed bundle — no `setInterval`,
  `setTimeout`, `Deno.cron`, `queueMicrotask`, `waitUntil`, `pg_cron`, `pg_net`.

Tests A and B never reached the activation gate at all: both were rejected with
`401` inside `lib/handler.ts`.

**Therefore, during D3-2E:**

- `phoenix_outbox_claim_batch` — **not invoked**
- `phoenix_outbox_mark_completed` — **not invoked**
- `phoenix_outbox_mark_failed` — **not invoked**
- `phoenix_outbox_release_lease` — **not invoked**
- no Supabase database client constructed
- no SQL executed, no direct table access
- no event, consumer, organization, delivery-state row or lease created,
  claimed, leased, completed, failed or released
- no scheduler, timer, cron, queue or background task created or bound

---

## 7. What is still NOT done

- **Dispatch is disabled.** `PHOENIX_OUTBOX_DISPATCH_ENABLED` is absent.
- No enabled probe was run.
- No synthetic organization, consumer, or Outbox record exists.
- No consumer is registered; no scheduler exists.
- No migration was applied, repaired or created; history remains 001–163.
- PR #100 remains Draft and unmerged; `master` was not pushed.
- **D3-2F (activation) was not begun** and remains a separate owner gate.

Activating dispatch in Production requires its own explicit authorization,
covering at minimum: registering a consumer, setting
`PHOENIX_OUTBOX_DISPATCH_ENABLED`, and deciding the invocation mechanism.
