# D3-2F — Production activation verification (bounded, reverted)

**Status: CLOSED — PRODUCTION VERIFIED.**

D3-2F executed one bounded, owner-gated Production probe of the durable Outbox
dispatcher and reverted every runtime change it made. This document is the
authoritative D3-2F record. Current status lives in [STATE.md](STATE.md);
long-lived decisions in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Result

```
D3_2F_PRODUCTION_PROBE_PASS
```

| fact | value |
|---|---|
| Production evidence SHA256 | `52cef39eaa5ff24d6e26c2021591d74a86ceb6f36530d2082ffce60ddcd855fb` |
| Canonical plan (v2) SHA256 | `9cbce8089908df0486f547d5fafcb1ca3824d3660399c3170e0eb53048a419dc` |
| Superseded plan (v1) SHA256 — **VOID** | `fc8e97498da54dca5b4a8b6232c45896f9b22f84e86c3d642c5be1a1a440bcb2` |
| Non-processing halt evidence SHA256 | `fbc78905041dfc7c693c2d5b83685ef12132a43510e7baeaa81f5e1012cbcd33` |
| Local CI-equivalence evidence SHA256 | `9ef31bfda225d056888cb8f6907ace84a2e3defd6c6e8dbc2077ed6c9ac77718` |
| Repository baseline | `0c24b5906d3e3d80ed0f01623e8390b67b167cea` |
| Production migration history | exactly **001–163** · no 164+ |

Evidence artifacts live outside the repository, under `phoenix-evidence/`. They
are not committed; the hashes above bind them.

## 2. Probe outcome

Exactly one authenticated `GET` (no body) against the deployed dispatcher:

```json
{"service":"phoenix-outbox-dispatcher","status":"dispatched","version":"d3-2a.1",
 "timestamp":"2026-08-07T01:51:06.442Z","claimed":1,"completed":0,"failed":0,"released":1}
```

```
claimed = 1   completed = 0   failed = 0   released = 1
```

Proven from the database afterwards:

- exactly **one organization-scoped consumer resolved**;
- consumer discovery cursor advanced **0 → 1**;
- exactly **one claim**;
- exactly **one lease lifecycle**, and the lease was **released**;
- `attempt_count` remained **0** — a cooperative release does not burn an attempt;
- **no completion** (`completed_at` NULL) and **no failure** (`dead_letter_at`,
  `last_error_code` NULL);
- **no duplicate processing** — a single delivery-state row;
- organization isolation held — the scoped consumer never saw another
  organization's events.

### What was verified, precisely

Durable Outbox **plumbing** only:

```
discovery -> organization-scoped consumer -> claim -> lease -> processor -> release
```

**No external or business delivery was verified.** The wired default processor is
`releaseEveryRow` (`supabase/functions/phoenix-outbox-dispatcher/lib/runtime.ts`),
which performs no side effect and hands every claimed row straight back. It never
marks a row completed (that would discard an undelivered event) and never marks it
failed (that would consume the retry budget for a delivery nobody attempted).
`completed = 0` is therefore the correct and expected result. No notification,
email, SMS, webhook, or business-event completion occurred or was tested.

## 3. Retained verification artifacts

Deliberately retained under permanent labelled retention.

| artifact | identifier | final state |
|---|---|---|
| Organization | `4e792f87-52d0-418e-9e80-cd238947ff78` | **inactive** |
| Consumer | `ad609477-c1d5-47ec-a547-1979d9ceb909` (`phoenix_d3_2f_verify_dispatcher`) | **disabled** |
| Event | `4c639b11-b2a5-4ba7-a7c0-39a771d868af` | retained |
| Delivery state | `6bcbe7bf-86ec-4aa6-bacc-c7f1fcd2c47d` | `pending`, `attempt_count` 0 |
| Correlation ID | `f452bcc5-3685-4e1a-8747-861b04b4d320` | — |

Retention rules honoured: **no `phoenix_demo_purger` use**, **no
`PHOENIX_DEMO_V1` enrolment**, **no invented `DELETE`**. `phoenix_demo_purger`'s
policies admit only rows enrolled in the demo manifest, so it is not the purge
path for verification artifacts.

The consumer cannot ever be selected again: Migration 163 raises
`consumer_disabled` (ERRCODE `23514`) before any claim work when
`is_enabled = false`.

## 4. Final Production runtime state

| item | state |
|---|---|
| `PHOENIX_OUTBOX_DISPATCH_ENABLED` | **ABSENT** — dispatch disabled |
| `PHOENIX_OUTBOX_CONSUMER_KEY` | removed |
| `PHOENIX_OUTBOX_BATCH_SIZE` | removed |
| `PHOENIX_OUTBOX_DISPATCH_SECRET` | configured; value never disclosed, not recoverable |
| Scheduler / cron / timer / queue | **none** |
| Active leases | **none** |
| Migrations | 001–163, no 164+ |
| Business data | unchanged — no movement, stocktake, patient, dispensing, supply or transfer record touched |

## 5. Deployment-integrity rule (supersedes the earlier false invariant)

**Supabase may increment an Edge Function's version as a side effect of an
environment or secret mutation, even when the deployed source bundle is
byte-identical.**

```
FUNCTION VERSION IS INFORMATIONAL PLATFORM REVISION METADATA ONLY.
```

The code-integrity invariants are:

| invariant | value |
|---|---|
| Function ID | `c30a5c51-b5ba-4fda-9cff-8bc7cf7a642f` |
| Bundle SHA256 (`ezbr_sha256`) | `a28bb6fbf4e8d7acd1112ec3f9746f3fd0e81b440d9a91c4a639b7cea51633f0` |

Do **not** expect or restore version 2. **Final observed version during D3-2F:
13.** Every increment correlated with exactly one approved configuration
mutation; the bundle digest and function ID were re-verified at every checkpoint
and never changed (`BUNDLE_DRIFT_ROWS = 0`).

A change in function ID or bundle digest is `FAIL-CLOSED_D3_2F_BUNDLE_DRIFT`.
A version increment alone is **not** code drift.

### The earlier safe halt that produced this rule

The first activation attempt (plan v1) failed closed at its own secret-rotation
step: the rotation moved the function version 2 → 3 while the bundle stayed
byte-identical. v1 simultaneously mandated the rotation **and** asserted
"function version stays 2", making it internally unsatisfiable. Execution halted
rather than continuing, the v1 owner gate was voided, and v2 replaced the version
binding with the bundle-digest binding above. No dispatch was ever enabled during
that attempt.

## 6. Non-blocking execution defects (verification tooling only)

Both defects were in **transient local verification scripts**, not in repository
product code. No product source, migration, or workflow file was changed to
address them.

1. **PowerShell `curl --config` construction.** The config file was written as a
   single line because PowerShell's comma operator binds tighter than `+`, so an
   `@('a' + $q + 'b' + $q, 'c' + ...)` array collapsed into one space-joined
   string. curl consumed every directive as part of the `url` value, so no
   `X-Phoenix-Dispatch-Secret` header was sent. The request returned `401` at the
   authentication gate **before** any dispatch, discovery, claim or lease.
   Consumer cursor stayed `0`; `delivery_state` stayed `0`. Classified
   `NONPROCESSING_PREAUTH_REQUEST`. One owner-authorised replacement processing
   attempt then succeeded (section 2). The working mechanism is
   `Invoke-WebRequest` with a headers hashtable.

2. **`Add-Ledger` truthiness.** A helper's `Write-Output` was captured into its
   return value, so `if (-not (Add-Ledger ...))` tested a 2-element array, which
   is always truthy — the inline bundle-drift guard was ineffective. The ledger
   **file** was written correctly regardless, and integrity was independently
   re-verified from that file and again live after the run:
   `BUNDLE_DRIFT_ROWS = 0`. No checkpoint went unverified, so this is
   non-blocking to D3-2F closure.

## 7. Boundaries honoured

No Migration 164 · no `supabase db push` · no migration repair · no schema, RLS,
RBAC, role, policy or grant change · no Edge Function source change and no
explicit redeploy · no scheduler, cron, or recurring execution · no second
processing invocation · no real operational organization used · no business,
inventory, patient, dispensing, supply or transfer data touched · no repository
source modified · the dispatcher secret value never printed, never committed,
never placed in evidence, and destroyed locally after use.
