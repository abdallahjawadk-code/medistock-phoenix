# STATE — current status only

> Daily source of truth. Keep it short; it is rewritten every stage.
> Long-lived decisions live in [ARCHITECTURE.md](ARCHITECTURE.md).
> Finished stage reports are appended to [HISTORY/](HISTORY/).

**Updated:** 2026-07-30
**Canonical decision memory:** v11 (supersedes v10 and all earlier plans)

---

## Gate

`R0 — Staging rehearsal package`. Phases A–J are **not** started and must not be.

## Repository

| | |
|---|---|
| worktree | `D:\phoenix-worktrees\pr68-align-master` |
| branch | `pr68-align-master` → `origin/feat/phoenix-transfer-suggestions-production` |
| PR | **#68**, OPEN, **Draft**, mergeable, base `master` |
| CI | 5/5 green |

v11 recorded head `db3a695`; two later commits (`dd62337`, `0a63113`) were made
after that snapshot and are CI-green. v11 §2.1 states the snapshot is
point-in-time and must be re-verified — it was, and the divergence is explained,
not drift.

## Production — verified read-only

| fact | value | how |
|---|---|---|
| project ref | `eyrzxgfkvqybjdgyphap` | Management API |
| status | `ACTIVE_HEALTHY` | Management API |
| **PostgreSQL** | **17.6.1.127 (engine 17)** | Management API |
| SSL enforcement | enabled | Management API |
| network restrictions | `0.0.0.0/0`, `::/0` | Management API |

**Production has never been connected to.** No dump, purge, migration, merge or
deployment has occurred.

## Production — NOT yet proven

Per v11 §2.4 these remain assumptions until a successful read-only probe:
migration ceiling 147 · keeper uniqueness · keeper is active global super_admin ·
RBAC 130/415 · Storage empty · all business data is test data.

## Open blockers

1. **No PostgreSQL 17 client locally.** Only 18.4 (scoop + Program Files). v11
   §3.4 requires the client major to match Production (17). The runner now
   enforces equality, so it will refuse until PG17 tooling exists. *Owner action:
   install PostgreSQL 17.x client tools, or provide a PG17 container.*
2. **No Supabase CA certificate pinned.** The runner requires
   `ops/certs/supabase-prod-ca.crt` + a committed `.sha256` pin. *Owner action:
   download from the dashboard, then run `ops\pin-supabase-ca.ps1` once.*
3. **No Staging project.** Creating one is an account/billing action for the
   owner; the runbook is written and ready.
4. **Restore is unproven.** A dump is not a backup until restored (v11 §R0-3).

## Local proof status

| suite | result |
|---|---|
| Option-A purge (rig) | 15/15 |
| purge manifest coverage (rig) | 7/7 |
| runner contract | 13/13 |
| typecheck / lint / build | pass |
| full suite | 12,135 passed, 0 failed tests |

**Local-only caveats.** The full suite must run
`--pool=forks --poolOptions.forks.singleFork --fileParallelism=false`; default
parallelism OOMs (pre-existing, reproduced on a pristine tree).
`tests/qa-harness-production-safety.test.ts` is flaky locally at suite level (its
internal ~80s build times out under load); it passes in isolation and on CI.

**All rig proofs to date ran on PostgreSQL 18.4, not 17.x.** Under v11 §3.4 they
do not satisfy the parity requirement and must be re-run on a PG17 rig.

## Next action

Close the blockers above, then execute the rehearsal in
[staging-rehearsal-runbook.md](staging-rehearsal-runbook.md). No Production
purge is authorized before an identical, successful, PG17-matched rehearsal and
an explicit Go decision recorded in
[adr/ADR-001-purge-vs-new-production.md](adr/ADR-001-purge-vs-new-production.md).
