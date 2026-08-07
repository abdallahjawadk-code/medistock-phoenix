# Stage D — closure report

**Filed:** 2026-08-07
**Stage:** D — supply, transfers, receipt, Outbox and durable consumers
**Outcome:** **CLOSED**, after D3-2F passed its bounded Production verification.

Append-only record. Current status: [../STATE.md](../STATE.md). Long-lived
decisions: [../ARCHITECTURE.md](../ARCHITECTURE.md).

---

## Sub-stage status

| sub-stage | status |
|---|---|
| **D3-1** — Outbox consumer foundation (Migration 163) | **CLOSED** — must not be reopened, re-applied, repaired or modified |
| **D3-2A** — dispatcher auth and health | **CLOSED** |
| **D3-2B** — dispatch orchestration | **CLOSED** |
| **D3-2C** — production RPC adapter | **CLOSED** |
| **D3-2D** — runtime wiring, disabled by default | **CLOSED** |
| **D3-2E** — hosted disabled-state verification | **CLOSED** |
| **D3-2F** — bounded Production activation verification | **CLOSED — PRODUCTION VERIFIED** |
| **D** — stage overall | **CLOSED** |

## What Stage D delivered

The durable transactional-Outbox path, proven end to end in Production under a
bounded owner-gated probe:

```
discovery -> organization-scoped consumer -> claim -> lease -> processor -> release
```

Probe result: `claimed=1  completed=0  failed=0  released=1`.

**Scope of the claim.** This verifies durable Outbox **plumbing** only. The wired
default processor is `releaseEveryRow`, which performs no side effect. **No
external or business delivery was verified** — no notification, email, SMS,
webhook, or business-event completion occurred or was tested. `completed = 0` is
the correct expected result, not a shortfall.

## Evidence chain

| artifact | SHA256 |
|---|---|
| D3-2F Production evidence | `52cef39eaa5ff24d6e26c2021591d74a86ceb6f36530d2082ffce60ddcd855fb` |
| D3-2F plan v2 (canonical) | `9cbce8089908df0486f547d5fafcb1ca3824d3660399c3170e0eb53048a419dc` |
| D3-2F plan v1 (**VOID**) | `fc8e97498da54dca5b4a8b6232c45896f9b22f84e86c3d642c5be1a1a440bcb2` |
| Non-processing halt evidence | `fbc78905041dfc7c693c2d5b83685ef12132a43510e7baeaa81f5e1012cbcd33` |
| Local CI-equivalence evidence | `9ef31bfda225d056888cb8f6907ace84a2e3defd6c6e8dbc2077ed6c9ac77718` |

Full detail: [../D3-2F-PRODUCTION-ACTIVATION-VERIFICATION.md](../D3-2F-PRODUCTION-ACTIVATION-VERIFICATION.md).

The local CI-equivalence run was accepted by the owner in place of the GitHub
Actions gate for D3-2F only, during an Actions incident. It executed the
committed `ci.yml` gates against source materialised from canonical Git objects
at `0c24b5906d3e3d80ed0f01623e8390b67b167cea`.

## Superseded decision

The earlier invariant **"Edge Function version stays 2"** is **withdrawn**. A
Supabase environment or secret mutation may increment the function version while
the deployed bundle remains byte-identical. Version is informational platform
revision metadata; the code-integrity invariants are the function ID
`c30a5c51-b5ba-4fda-9cff-8bc7cf7a642f` and the bundle digest
`a28bb6fbf4e8d7acd1112ec3f9746f3fd0e81b440d9a91c4a639b7cea51633f0`. Final
observed version during D3-2F: **13**.

## Production state left behind

Dispatch **disabled** (`PHOENIX_OUTBOX_DISPATCH_ENABLED` absent) · temporary
`PHOENIX_OUTBOX_CONSUMER_KEY` and `PHOENIX_OUTBOX_BATCH_SIZE` removed · no
scheduler, cron, timer or queue · no active lease · verification consumer
disabled · verification organization inactive · verification event retained under
permanent labelled retention · migrations **001–163**, no 164+ · no business-data
impact.

## Remaining programme roadmap

Stage D closure does **not** authorise the next stage. The remaining roadmap is
unchanged and must not be collapsed or skipped:

```
E — Outlets & Emergency Replenishment
F — Patient Dispensing
G — Availability, QR, Search & CQRS
H — Reports, Audit & Reconciliation
I — Durable Operations        (AI portion CANCELLED — must not be reintroduced)
J — Observability, Security & Rollout

then: Restore / Staging / Owner GO / Production evidence
then: final whole-programme comprehensive audit and closure
```

The long-lived phase table remains [../ARCHITECTURE.md](../ARCHITECTURE.md) §6.

**Stage E has not begun** and is separately owner-gated.
