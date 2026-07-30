# STATE — current status only

> Daily source of truth. Keep it short; it is rewritten every stage.
> Long-lived decisions live in [ARCHITECTURE.md](ARCHITECTURE.md).
> Finished stage reports are appended to [HISTORY/](HISTORY/).

**Updated:** 2026-07-31
**Canonical decision memory:** v12 (supersedes v11, v10 and all earlier plans)

---

## Gate

`R0 — Authorization and evidence chain`. Phases A–J are **not** started and must not be.

## Repository

| | |
|---|---|
| worktree | `D:\phoenix-worktrees\pr68-align-master` |
| branch | `pr68-align-master` → `origin/feat/phoenix-transfer-suggestions-production` |
| PR | **#68**, OPEN, **Draft**, mergeable, base `master` |
| CI | 5/5 green |

v12 recorded head `a7ff05e`; R0-authorization-chain work landed on top of it (see
git log for the exact new head). Production remains untouched throughout.

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
| release engine contract | 56/56 |
| typecheck / lint / build | pass |
| full suite | 302 files passed (381 total, 79 skipped), **12,182** passed, 0 failed tests |

The full-suite count moves as suites are added; it was 12,155 before the R0
evidence-authenticity-hardening tests grew. Treat the number as a snapshot, not
a constant.

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
order. There is deliberately no staging copy and no production copy. Each
target's manifest carries `execution_policy` (`rehearsal_allowed` /
`requires_rehearsal_authorization` / `disabled`) — the old
`allow_destructive_execution` boolean is retired, because "authorizing" a
release by editing and committing `production.json` meant the file was never
byte-identical between rehearsal and the real run.

| target | manifest | execution_policy | notes |
|---|---|---|---|
| rehearsal clone | `rehearsal-clone.example.json` | `rehearsal_allowed` | loopback PG17, no Supabase/Vercel calls |
| staging | `staging.example.json` | `rehearsal_allowed` | placeholders until the project exists |
| production | `production.json` | `requires_rehearsal_authorization` (permanent, never flipped) | requires the full evidence chain below |

## Authorization and evidence chain (R0)

Production requires three generated (never hand-written) files, chained by
SHA-256, described in [ops/evidence/README.md](../../ops/evidence/README.md):

```text
restore-proof.json              ops/generate-restore-proof.ps1
    -> staging-rehearsal-proof.json   ops/generate-staging-rehearsal-proof.ps1
        -> owner-go.json               ops/record-owner-go.ps1
```

At production-run time the engine re-verifies every field of every file
against the live repository and toolchain — head SHA, purge-SQL digest,
purge-manifest digest, migrations 148-153 digest, staging and production
manifest digests (production.json must be byte-identical to what was
rehearsed), staging and production CA pins (checked separately, never shared),
exact `psql`/`pg_dump` version strings, executable paths and executable
SHA-256, and the owner's Go decision bound to the exact staging proof and
commit — before requesting any credential. Any placeholder, empty field, or
mismatch: `STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED`. None of the three evidence
files exist in this repository yet; R0 is not closed.

**Authenticity hardening.** `-Confirmed` alone cannot produce a restore proof
— `ops/generate-restore-proof.ps1` requires a structured execution report
(`-RestoreRunReportPath`) and validates nine fields of it (exit code, probe,
ceiling 147, keeper, RBAC, trigger before==after, rollback, reconciliation,
clone major 17). A staging proof cannot be hand-typed either — the release
engine itself writes `staging-run-result.json` at the end of a real staging
success, and `ops/generate-staging-rehearsal-proof.ps1` re-verifies the
backup and both tool executables against the filesystem rather than trusting
that file's own claims. `ops/evidence-chain.ps1` is the single shared
validator dot-sourced by the engine, `record-owner-go.ps1`, and both
generators: the owner sees the Go prompt only after the exact same
cross-checks (staging/restore backup SHA match, trigger/rollback subset hash
recomputation, restore clone PG major, staging manifest/CA re-hashed against
the live file, and `restore <= staging <= owner` timestamp ordering) the
Production engine will re-run.

## Next action

Close the blockers above, then execute the rehearsal in
[staging-rehearsal-runbook.md](staging-rehearsal-runbook.md), generate the
evidence chain, and record an explicit Go decision per
[adr/ADR-001-purge-vs-new-production.md](adr/ADR-001-purge-vs-new-production.md).
No Production purge is authorized before all three evidence files exist and
verify clean.
