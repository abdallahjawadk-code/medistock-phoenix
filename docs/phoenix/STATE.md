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
   §3.4 requires the client major to match Production (17); the engine enforces
   equality, so it refuses until PG17 tooling exists. These are **two separate
   requirements** — a container does not satisfy the first:

   | need | why | how |
   |---|---|---|
   | PG17 **Windows client** (`psql.exe`, `pg_dump.exe`) | the engine shells out to them for staging/production | install PostgreSQL 17.x for Windows, or extract its client binaries |
   | PG17 **server** for the rehearsal clone | somewhere to restore and rehearse | `docker run -d --name phoenix-clone17 -p 55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17` |

   A container provides the *server* only. The engine still needs a real
   `psql.exe` on this machine for every target, clone included.

2. **No CA certificate pinned.** Each target has its own:
   `ops/certs/production-ca.crt` (+ committed `.sha256`) and
   `ops/certs/staging-ca.crt`. *Owner action: download each from its own
   dashboard, then `ops\pin-supabase-ca.ps1 -Target production` (and `-Target
   staging`).* The local clone needs none — it is loopback without TLS.
3. **No Staging project.** Creating one is an account/billing action for the
   owner; the runbook is written and ready.
4. **Restore is unproven.** A dump is not a backup until restored (v11 §R0-3).

## Local proof status

| suite | result |
|---|---|
| Option-A purge (rig, **PG18.4**) | 15/15 |
| purge manifest coverage (rig, **PG18.4**) | 7/7 |
| release engine contract | 19/19 |
| typecheck / lint / build | pass |
| full suite | 302 files, **12,139** passed, 0 failed tests |

The full-suite count moves as suites are added; it was 12,135 before the release
engine contract tests grew. Treat the number as a snapshot, not a constant.

**Local-only caveats.** The full suite must run
`--pool=forks --poolOptions.forks.singleFork --fileParallelism=false`; default
parallelism OOMs (pre-existing, reproduced on a pristine tree).
`tests/qa-harness-production-safety.test.ts` is flaky locally at suite level (its
internal ~80s build times out under load); it passes in isolation and on CI.

**All rig proofs to date ran on PostgreSQL 18.4, not 17.x.** Under v11 §3.4 they
do not satisfy the parity requirement and must be re-run on a PG17 rig.

## Release engine — one path, many targets

`ops/run-prelaunch-release-core.ps1` is target-agnostic; the environment comes
from a manifest in `ops/targets/`. `ops/release-stages.ps1` holds the single
implementation of the destructive path, dot-sourced by the engine, so the
rehearsal clone, staging and Production execute identical code in identical
order. There is deliberately no staging copy and no production copy.

| target | manifest | destructive | notes |
|---|---|---|---|
| rehearsal clone | `rehearsal-clone.example.json` | yes | loopback PG17, no Supabase/Vercel calls |
| staging | `staging.example.json` | yes | placeholders until the project exists |
| production | `production.json` | **false** | plus a rehearsal artifact is required |

Production additionally demands a rehearsal artifact whose head SHA, purge-SQL
digest, purge-manifest digest, PostgreSQL major, client tool versions and CA pin
all match the live repository and toolchain — otherwise
`STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED` fires **before** any password prompt.
Template: `ops/targets/rehearsal-artifact.example.json`.

## Next action

Close the blockers above, then execute the rehearsal in
[staging-rehearsal-runbook.md](staging-rehearsal-runbook.md). No Production
purge is authorized before an identical, successful, PG17-matched rehearsal and
an explicit Go decision recorded in
[adr/ADR-001-purge-vs-new-production.md](adr/ADR-001-purge-vs-new-production.md).
