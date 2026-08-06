# STATE — current status only

> Daily source of truth. Keep it short; it is rewritten every stage.
> Long-lived decisions live in [ARCHITECTURE.md](ARCHITECTURE.md).
> Finished stage reports are appended to [HISTORY/](HISTORY/).

**Updated:** 2026-08-06
**Canonical decision memory:** v13 (supersedes v12, v11, v10 and all earlier plans)

> **Two independent tracks.** Most of this file describes the **R0 pre-launch
> purge/release** program, which is still gated and unstarted. The **D3-2 Outbox
> dispatcher** track is separate, is further along, and has now touched
> Production. See [D3-2 — Outbox dispatcher](#d3-2--outbox-dispatcher-authoritative)
> for its authoritative state. Statements elsewhere in this file apply to the R0
> track unless they say otherwise.

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

**No dump, purge, or destructive release has occurred, and no R0 stage has run.**
That remains true and is what the rest of this file is about.

**Production HAS been contacted, deliberately and under explicit owner
authorization, by the separate D3-2 track.** A read-only database preflight was
executed through the Supabase SQL Editor, and one Edge Function was deployed in a
disabled state. Superseded on 2026-08-06 — earlier revisions of this file stated
"Production has never been connected to", which is no longer accurate. Details in
[D3-2 — Outbox dispatcher](#d3-2--outbox-dispatcher-authoritative).

## Production — proven vs. still assumed

**Proven read-only on 2026-08-06** (Supabase SQL Editor, aggregates only):

| fact | value |
|---|---|
| migration history | **exactly 001–163**, no gaps, no duplicates |
| Migration 163 | present **exactly once** |
| Migration 164+ | **none** |
| `phoenix_outbox_events` / `_consumers` / `_delivery_state` | exist, **0 rows each** |
| eligible rows · active leases · organizations | **0 · 0 · 0** |
| organization-isolation mismatches | **0** |

> The previously assumed **migration ceiling 147 is superseded**: the real
> ceiling is **163**. Any R0 material below that reasons from 147 — including
> `ops/targets/production.json` (`expected_initial_ceiling: 147`,
> `expected_final_ceiling: 153`) and the purge/restore rigs — must be
> re-derived against 163 before an R0 stage is authorized. This is an open R0
> blocker, recorded below.

**Still assumed** (unchanged, pending their own read-only probe): keeper
uniqueness · keeper is active global super_admin · RBAC 130/415 · Storage empty ·
all business data is test data. Note that `organizations_total = 0` is now proven,
which is consistent with "all business data is test data" but does not prove the
keeper/RBAC/Storage items.

## Open blockers

1. ~~**No PostgreSQL 17 client locally.**~~ **RESOLVED 2026-08-06.** An official
   PostgreSQL **17.10** Windows x64 client is installed at
   `D:\phoenix-tools\postgresql-17\bin\psql.exe` (client binaries only — no
   server, no service, no `initdb`, no pgAdmin, and deliberately **not** on
   `PATH`, so every caller must use the exact path). Source: postgresql.org →
   EDB binaries ZIP, Defender-scanned, archive
   SHA-256 `EF9B1E5E23D2E8A83914BA13D9DC536A72210FBA53FD1808FF1F7E06BB22B106`.
   The PG17 **server** for a rehearsal clone is still a separate need — the
   original two-requirement note is retained below because only the first half
   is satisfied:

   | need | why | how |
   |---|---|---|
   | PG17 **Windows client** (`psql.exe`, `pg_dump.exe`) | the engine shells out to them for staging/production | install PostgreSQL 17.x for Windows, or extract its client binaries |
   | PG17 **server** for the rehearsal clone | somewhere to restore and rehearse | `docker run -d --name phoenix-clone17 -p 55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17` |

   A container provides the *server* only. The engine still needs a real
   `psql.exe` on this machine for every target, clone included.

2. **CA pinning — production RESOLVED, staging still missing.**
   `ops/certs/production-ca.crt` is now present locally (gitignored by design)
   and its SHA-256 matches the committed pin
   `700723581420DD1AC98FD7E9AC529F0EF210EADCAF87FC868A3AD7D114C2F3B7` exactly.
   `ops\pin-supabase-ca.ps1` was **not** run and the committed `.sha256` was
   **not** modified — the downloaded certificate was verified *against* the
   existing pin. `verify-full` using it has been confirmed working against the
   live Production endpoint. `ops/certs/staging-ca.crt` remains absent because
   no staging project exists. The local clone needs none — loopback without TLS.
3. **No Staging project.** Creating one is an account/billing action for the
   owner; the runbook is written and ready.
4. **Restore is unproven.** A dump is not a backup until restored (v11 §R0-3).
5. **R0 ceiling arithmetic is stale.** Every R0 artifact that assumes an initial
   ceiling of 147 must be re-derived against the proven ceiling **163** before
   any R0 stage is authorized.

## Local proof status

| suite | result |
|---|---|
| Option-A purge (rig, **PG18.4**) | 15/15 |
| purge manifest coverage (rig, **PG18.4**) | 7/7 |
| release engine contract | 85/85 |
| typecheck / lint / build | pass |
| full suite | 302 files passed (381 total, 79 skipped), **12,211** passed, 0 failed tests |

The full-suite count moves as suites are added; it was 12,193 before the v13
stale-evidence-and-local-clone-safety patch grew it. Treat the number as a
snapshot, not a constant.

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

Production requires an evidence chain, chained by SHA-256, described in
[ops/evidence/README.md](../../ops/evidence/README.md). Nothing in it is
hand-written; two files are raw execution reports and four are built on top
of them:

```text
ops/run-pg17-restore-rehearsal.ps1  (the ONE tool that produces this)
    -> restore-run-result.json
        -> restore-proof.json           ops/generate-restore-proof.ps1

ops/run-prelaunch-release-core.ps1  (target: staging, writes this itself)
    -> staging-run-result.json
        -> staging-rehearsal-proof.json ops/generate-staging-rehearsal-proof.ps1

restore-proof.json + staging-rehearsal-proof.json
    -> owner-go.json                    ops/record-owner-go.ps1
```

At production-run time the engine re-verifies every field of every file
against the live repository and toolchain — head SHA, purge-SQL digest,
purge-manifest digest, migrations 148-153 digest, staging and production
manifest digests (production.json must be byte-identical to what was
rehearsed), staging and production CA pins (checked separately, never shared),
exact `psql`/`pg_dump` version strings, executable paths and executable
SHA-256, and the owner's Go decision bound to the exact staging proof and
commit — before requesting any credential. It also re-loads and re-validates
**both raw run-result files** (`-RestoreRunResultPath` / `-StagingRunResultPath`)
with the exact same validators the generators used, and requires their
current SHA-256 to still match what each proof references — editing or
deleting a raw file after its proof exists invalidates the proof. Any
placeholder, empty field, or mismatch: `STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED`.
None of the evidence files exist in this repository yet; R0 is not closed.

**Authenticity hardening.** `-Confirmed` alone cannot produce a restore proof.
`ops/run-pg17-restore-rehearsal.ps1` is the only tool that writes
`restore-run-result.json`: it takes exactly three inputs (backup path, a
`rehearsal_clone` manifest, an output directory — never a boolean, exit code,
or version), and performs the real sequence against a local, disposable,
loopback PG17 clone (drop/recreate, `pg_restore`, probe, ceiling 147, keeper,
RBAC 130/415, trigger definitions before, a deliberate rollback test, trigger
definitions after, reconciliation) before writing anything — any failure
stops before the file is written. `ops/generate-restore-proof.ps1` then
re-verifies the backup hash independently and validates every field of that
report. A staging proof cannot be hand-typed either — the release engine
itself writes `staging-run-result.json` at the end of a real staging success,
and `ops/generate-staging-rehearsal-proof.ps1` re-verifies the backup and
both tool executables against the filesystem rather than trusting that
file's own claims. `ops/evidence-chain.ps1` is the single shared validator
dot-sourced by the engine, `record-owner-go.ps1`, both generators, and the
restore rig: the owner sees the Go prompt only after the exact same
cross-checks (staging/restore backup SHA match, trigger/rollback subset hash
recomputation, restore clone PG major, staging manifest/CA re-hashed against
the live file, raw-result re-validation, and `restore <= staging <= owner`
timestamp ordering) the Production engine will re-run.

**Worktree gate.** The engine refuses to run against a dirty `git status`,
and evidence output defaults into `ops/evidence/`. `.gitignore` now excludes
`ops/evidence/*.json`, `*.json.tmp`, `*.log`, `*.dump`, and the filled-in
`ops/targets/staging.json` / `rehearsal-clone.json` — `ops/evidence/README.md`
and the manifest `.example.json` templates (and `production.json`) stay
committed. Generating the default evidence files no longer blocks a
rehearsal or Production run; a genuine code change still does.

**Stale-evidence protection (v13).** Both raw-result writers now follow the
same contract: delete any stale final and `.tmp` for that file before an
attempt does anything else; write the real result to `.tmp`; self-validate
the round-tripped file with the exact same `Test-RestoreRunReport` /
`Test-StagingRunResult` functions every downstream consumer uses; atomically
`Move-Item` the `.tmp` to its final name only after that validation passes;
and on any failure, the catch block removes both the final and `.tmp` path
for that attempt. A failed attempt can no longer leave a previous
successful run's evidence looking current.

**Local clone DROP DATABASE safety (v13).** Before
`ops/run-pg17-restore-rehearsal.ps1` runs `pg_terminate_backend` / `DROP
DATABASE` / `CREATE DATABASE` against the disposable rehearsal clone, it
re-checks (again, not only at manifest load) that the host is loopback and
`ssl_mode=disable`; that `database_name` matches
`^phoenix_rehearsal_[a-z0-9_]+$`, is not `postgres`/`template0`/`template1`,
and contains no space/quote/semicolon/comment syntax; queries the
maintenance connection's *live* server major and refuses anything but 17;
and requires the operator to type `RESET LOCAL PG17 CLONE <database_name>`
naming the exact database, never auto-answered. Every destructive statement
uses a safely double-quoted identifier. All of this is local-only: no
Production or Staging connection, no live migration, no real restore/purge.

## D3-2 — Outbox dispatcher (authoritative)

Separate from the R0 track above. **Closed through D3-2E; D3-2F not begun.**

| fact | value |
|---|---|
| Production project ref | `eyrzxgfkvqybjdgyphap` |
| Production migration history | exactly **001–163** · 163 present once · no 164+ |
| **D3-1** | **CLOSED — must not be reopened.** Migration 163 is applied and must not be re-applied, repaired, or modified |
| D3-2D runtime source commit | `d8433b92034bb5c828926b64c586ba87e3752553` |
| D3-2E evidence commit | `7c66182d843388ba5fee42a98179ace07aa4c436` |
| Function | `phoenix-outbox-dispatcher` |
| Deployment ID | `c30a5c51-b5ba-4fda-9cff-8bc7cf7a642f` |
| Status | **ACTIVE** |
| Version | **2** — v1 at deploy, refreshed to v2 by Supabase metadata after the secret rotation; **no second deployment** |
| Deployed source | verified **byte-identical to `d8433b92`** (12 bundled modules downloaded and compared; 0 differing) |
| `verify_jwt` | `false` — **this function only**; the seven other deployed functions remain `true` |
| `PHOENIX_OUTBOX_DISPATCH_SECRET` | **configured** — value **never disclosed**, not recoverable from this repository |
| `PHOENIX_OUTBOX_DISPATCH_ENABLED` | **ABSENT** |
| Dispatch | **DISABLED** |
| PR | **#100**, open, **Draft**, unmerged, base `master` |

**Hosted verification (D3-2E), all disabled-state:**

| test | result |
|---|---|
| missing `X-Phoenix-Dispatch-Secret` | `401 NOT_AUTHENTICATED` ✅ |
| incorrect secret | `401 NOT_AUTHENTICATED` ✅ |
| correct secret while disabled | `200` D3-2A health payload, returned verbatim ✅ |

**What did NOT happen.** No enabled dispatch · no `phoenix_outbox_*` RPC of any
kind · no Supabase database client constructed · no SQL or direct table access ·
no database mutation · no synthetic data · no consumer · no organization · no
event · no delivery-state row · no lease · no scheduler, cron, timer, queue or
background task · no historical backlog existed to process.

Full evidence, including the zero-RPC argument:
[D3-2E-HOSTED-DISABLED-VERIFICATION.md](D3-2E-HOSTED-DISABLED-VERIFICATION.md).

**D3-2F has not begun and remains separately owner-gated.** Activation would
require at minimum: registering a consumer, setting
`PHOENIX_OUTBOX_DISPATCH_ENABLED`, and deciding the invocation mechanism.

## Next action

**D3-2 track:** decide the PR #100 merge gate, then D3-2F activation — each its
own owner gate. Nothing further is authorized.

**R0 track:** close the blockers above, then execute the rehearsal in
[staging-rehearsal-runbook.md](staging-rehearsal-runbook.md), generate the
evidence chain, and record an explicit Go decision per
[adr/ADR-001-purge-vs-new-production.md](adr/ADR-001-purge-vs-new-production.md).
No Production purge is authorized before all three evidence files exist and
verify clean.
