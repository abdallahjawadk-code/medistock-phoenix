# D3-2B — Dispatch Orchestration + Integration Proof

Status: **locally implemented and validated. Not staged, not committed, not deployed.**

D3-2B adds the pure orchestration layer that sits between a caller and the
D3-1 Outbox consumer foundation delivered by Migration 163, plus the dynamic
integration proof that the layer drives the real database correctly.

It adds **no** runtime behavior to any deployed surface. Nothing calls
`runDispatchCycle` in Production, or anywhere else, yet.

---

## 1. Scope

Five new files, no existing file modified:

| File | Role |
| --- | --- |
| `supabase/functions/phoenix-outbox-dispatcher/lib/rpc-client.ts` | Portable types-only contract (`OutboxRpcClient`) for the four consumer operations |
| `supabase/functions/phoenix-outbox-dispatcher/lib/dispatch.ts` | Pure, dependency-injected `runDispatchCycle` orchestration |
| `supabase/functions/phoenix-outbox-dispatcher/lib/dispatch_test.ts` | Offline Deno tests against an in-memory fake client |
| `supabase/migrations/__tests__/163-d3-2b-dispatch-integration.dynamic.test.ts` | Dynamic pg-rig integration proof through Migration 163 |
| `docs/phoenix/D3-2B-DISPATCH-ORCHESTRATION-INTEGRATION.md` | This document |

Explicitly **out of scope**, and absent from this change:

- no production database adapter (there is no implementation of
  `OutboxRpcClient` outside the throwaway one inline in the dynamic test);
- no wiring into the D3-2A HTTP path — `index.ts` and `lib/handler.ts` are
  byte-identical to commit `8409d66` and do not reference D3-2B at all;
- no Migration 164, and no change to any `.sql` file;
- no scheduler, timer, cron entry, or background execution of any kind;
- no consumer registration anywhere except inside the disposable rig;
- no deployment, no Production access, no live secret, no Supabase CLI use.

D3-2C / D3-2D / D3-2E / D3-2F each require separate authorization.

---

## 2. Why this tests orchestration, not the database again

Migration 163's own dynamic suite
(`163-outbox-consumer-foundation.dynamic.test.ts`, 593 lines) already proves
the database state machine against a real Postgres across a 20-point
security and concurrency list: lease theft, idempotent same-token replay,
foreign-token rejection, the exponential backoff curve, dead-letter
terminality and non-reclaim, cross-consumer isolation, server-derived
organization scoping, gap-safe discovery, bounded diagnostics, and privilege
lockdown. `163-verification-hardening.dynamic.test.ts` hardens that further.

Re-proving any of it here would add runtime and maintenance cost while
proving nothing new. The D3-2B dynamic suite therefore exercises **each
orchestration route exactly once, end to end**, and cites the 163 suite for
the deeper state-machine proofs. What is genuinely new — and so is proven
here — is that the orchestrator:

- issues exactly one claim per cycle;
- passes `consumerKey`, `leaseToken` and `batchSize` through unchanged;
- routes each row's single outcome to exactly one real transition;
- propagates every real database rejection instead of swallowing it;
- never touches the D2 Outbox source rows;
- and that the snake_case → camelCase mapping is exact.

---

## 3. Module boundaries

```
                 caller (none yet — nothing calls this)
                        │
                        ▼
   lib/dispatch.ts  ──uses──▶  lib/rpc-client.ts   (types only)
        │                              ▲
        │ dependency-injected          │ implemented by
        ▼                              │
   OutboxRpcClient  ◀───── throwaway inline adapter (dynamic test only)
                                       │
                                       ▼
                          Migration 163's four RPCs
```

`lib/rpc-client.ts` is **types only** — no runnable code at all. No Deno
global, no Node import, no Postgres driver, no Supabase client, no `URL`, no
environment access, no credential, no connection string.

`lib/dispatch.ts` is pure: no clock, environment, network, database or
filesystem access; no identifier generation (the lease token is
caller-supplied, so callers and tests fully control lease identity); no
retry, backoff, polling loop, timer, scheduler or background execution.
Retry policy and backoff already live in the D3-1 database foundation, which
stays the single source of truth for them.

The method names on `OutboxRpcClient` are portable camelCase
(`claimBatch`, `markCompleted`, `markFailed`, `releaseLease`). The literal
SQL routine names are deliberately **not** written in this directory's
non-test source: D3-2A's `lib/static_guards_test.ts` scans every non-test
`.ts` file here and fails if any prohibited D3-1 RPC or table identifier
appears. Both new source files pass that existing scan unmodified. The
mapping from portable method to real routine is made exactly once, inline,
in the dynamic test's throwaway adapter.

---

## 4. Exception behavior (fail-closed)

`runDispatchCycle` returns a summary **only** when every claimed row was
processed and finalized without error. There is no partial summary.

| Event | Behavior |
| --- | --- |
| `claimBatch` throws | Error propagates; nothing else is called. No row was leased, so nothing needs finalizing. |
| `processEvent` throws | Error propagates immediately. The row is **not** marked completed, **not** marked failed, and **not** released. |
| `markCompleted` / `markFailed` / `releaseLease` throws | Error propagates immediately. Remaining rows are **not** processed. No summary is manufactured. |
| Unrecognized outcome | Treated as an unknown terminal state: throws, finalizes nothing for that row, does not continue to later rows. |

Why an errored `processEvent` leaves the row leased rather than finalizing
it: the orchestrator does not know whether the side effect happened.
Marking it completed could lose an event; marking it failed could
double-apply one; releasing it immediately would hand a possibly
half-applied row straight back for instant reprocessing. Leaving it leased
is deliberate — the lease expires on the database's own schedule and the row
is reclaimed by a later claim, and **reclaim-by-expiry never increments
`attempt_count`** (a documented D3-1 design decision). Unfinalized rows are
therefore a designed recovery path, not a leak. This is proven end to end by
the dynamic suite's "processor rejection leaves the row leased, and the
expired lease is later reclaimed without burning an attempt" test.

---

## 5. Probe naming and organization scoping

All fixtures use the clearly non-production prefix `probe_nonprod_d3_2_v1`,
with per-test suffixes (`probe_nonprod_d3_2_v1-<suffix>-<ts>-<n>`).

Every probe consumer:

- has a **non-null** `organization_id` — no global probe consumer is ever
  created (`registerProbeConsumer` asserts both conditions before inserting);
- points at one of two throwaway organizations created by this suite
  (`…032b0001` / `…032b0002`, codes `probe-d32b-a` / `probe-d32b-b`);
- never uses a real organization, and never uses a production-shaped key.

Note on rig baseline: the canonical migration chain itself seeds two
baseline organizations in migration `001` (re-asserted by `004`), so a
freshly built rig is never literally empty of organizations, and cannot be
made so without modifying a migration — which D3-2B forbids. The pre-fixture
guard therefore asserts the strictly stronger, achievable property: the
organization set is **exactly** those two known chain-seeded rows and
nothing else, which proves a pristine disposable rig rather than a copy,
clone or restore of any real database. The three D3 Outbox tables — the ones
this suite actually writes to — are still required to be literally zero.
No probe consumer and no probe event ever references either baseline
organization; the final test asserts this.

---

## 6. Loopback-only database guard

Before anything is built or inserted, the dynamic test requires:

1. `PHOENIX_D3_2B_TEST_ONLY=1` — explicit closure-run flag;
2. `PHOENIX_RIG_PG` set, parseable as a URL, scheme `postgres:` or
   `postgresql:`;
3. hostname strictly one of `127.0.0.1`, `localhost`, `::1`;
4. the connection string containing neither `eyrzxgfkvqybjdgyphap` nor
   `supabase.co`, and not targeting a Production-shaped maintenance
   database;
5. `PHOENIX_RIG_DB` exactly `phoenix_rig_d3_2b` — a dedicated disposable
   database, never the ordinary `phoenix_rig`.

Anything else throws before a connection is attempted. Those two forbidden
literals exist in the test file **only** as negative controls, in the guard
that rejects them.

It then verifies the migration set `buildRig({ upTo: 163 })` will apply —
maximum version exactly `163`, exactly one `163_*` file, nothing above 163 —
*before* applying it, and after building asserts both D3-1 tables and all
four Migration 163 functions exist (resolved by full signature via
`to_regprocedure`, never a bare name lookup).

**A skip is not a pass.** Generic full-suite runs use the established
repository skip behavior, so the suite is skipped when the rig variables are
absent. The dedicated D3-2B closure command below pre-checks both required
variables and fails *before* Vitest starts if either is missing.

---

## 7. Synthetic event generation

Every event dispatched by the suite is produced through the **real producer
path**: a genuine `stocktakes` INSERT fires Migration 162's own trigger,
which appends one real Outbox event — exactly how Production would produce
one.

No `phoenix_outbox_events` row is ever hand-inserted. This matches the rule
Migration 163's own dynamic suite already follows.

---

## 8. Exact local validation commands

Deno (function directory = `supabase/functions/phoenix-outbox-dispatcher`):

```bash
deno fmt supabase/functions/phoenix-outbox-dispatcher
```

```bash
deno fmt --check supabase/functions/phoenix-outbox-dispatcher
```

```bash
deno lint supabase/functions/phoenix-outbox-dispatcher
```

```bash
deno check supabase/functions/phoenix-outbox-dispatcher/index.ts
```

```bash
deno check supabase/functions/phoenix-outbox-dispatcher/lib/rpc-client.ts supabase/functions/phoenix-outbox-dispatcher/lib/dispatch.ts
```

```bash
deno test --allow-read=supabase/functions/phoenix-outbox-dispatcher supabase/functions/phoenix-outbox-dispatcher
```

Repository:

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npx vitest run src/shared/supabase/__tests__/edge-auth-hardening.test.ts src/shared/supabase/__tests__/phoenix-guardrails.test.ts
```

Dedicated D3-2B dynamic closure (PowerShell). The pre-check fails before
Vitest if either required variable is absent, so a skip can never be
mistaken for a pass:

```bash
$env:PHOENIX_D3_2B_TEST_ONLY='1'; $env:PHOENIX_RIG_DB='phoenix_rig_d3_2b'; $env:PHOENIX_RIG_PG='postgres://postgres@127.0.0.1:55432/postgres'; if (-not $env:PHOENIX_D3_2B_TEST_ONLY) { exit 9 }; if (-not $env:PHOENIX_RIG_PG) { exit 9 }; npx vitest run "supabase/migrations/__tests__/163-d3-2b-dispatch-integration.dynamic.test.ts" --fileParallelism=false --pool=forks --poolOptions.forks.singleFork
```

The `127.0.0.1:55432` value is the loopback rig recorded throughout this
repository (`.github/workflows/ci.yml`, and the header of every
`*.dynamic.test.ts`). Substitute any other **verified loopback-only**
disposable server; the guard rejects everything else.

---

## 9. Evidence preservation

The rig database `phoenix_rig_d3_2b` is dedicated and disposable. It is
dropped and recreated by `buildRig` at the start of each run and is **left
in place afterwards**, so its final state remains inspectable as evidence.

The ordinary `phoenix_rig` database is never used or overwritten by D3-2B —
`PHOENIX_RIG_DB` is required to be exactly `phoenix_rig_d3_2b`, and the
guard fails closed on any other value.

Within a run, the suite proves the D2 Outbox source rows are preserved: a
full mixed cycle (one completed, one failed, one released) is bracketed by a
complete ordered snapshot of every `phoenix_outbox_events` row, and the
before/after snapshots must be byte-identical. No Outbox row is ever mutated
or deleted.

---

## 10. What is still not done

- No Production access of any kind — no connection, key, URL, organization,
  or event. The dynamic guard is loopback-only and rejects the Production
  project reference outright.
- No HTTP handler wiring. The D3-2A endpoint still only does auth + health.
- No production adapter implementing `OutboxRpcClient`.
- No deployment, no PR, no push.
- No consumer registered outside the disposable rig.
- No scheduler and no Migration 164.

D3-2C and beyond require separate authorization.
