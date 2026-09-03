# Suspended-from-Dispensing (203-208) — Consolidated UAT Supplement

**Status: both PRs CI-green, independently verified against a real disposable
Postgres. Neither PR is merged; no Production migration applied; no
Production data touched.**

This supplement is the single change-impact/UAT record for the whole
203-208 domain and its UI (PR #181 + PR #182), plus the accompanying
Quarantine audit. It follows the leaner "consolidated supplement" style
(one document, source-cited, real numbers) rather than the historical
per-migration ceremony file set.

## 1. Scope delivered

| # | Item | Where |
|---|---|---|
| 1 | `material_dispensing_suspensions` domain (table, RLS, permission keys, suspend/lift/status RPCs) | [203](../../supabase/migrations/203_phoenix_material_dispensing_suspension.sql) |
| 2 | Dispense-time enforcement | [204](../../supabase/migrations/204_phoenix_dispensing_suspension_enforcement_dispense.sql) |
| 3 | FEFO-candidate-engine enforcement | [205](../../supabase/migrations/205_phoenix_dispensing_suspension_enforcement_fefo.sql) |
| 4 | Suggestion-generation enforcement (intra-org + cross-org) | [206](../../supabase/migrations/206_phoenix_dispensing_suspension_enforcement_suggestions.sql) |
| 5 | All four guarded warehouse-send functions | [207](../../supabase/migrations/207_phoenix_dispensing_suspension_enforcement_warehouse_send.sql) |
| 6 | Emergency-replenishment + stale-draft enforcement | [208](../../supabase/migrations/208_phoenix_dispensing_suspension_enforcement_replenishment_and_drafts.sql) |
| 7 | Admin panel: org-wide **and** outlet-scoped suspend/lift, correct per-scope RBAC | `MaterialDispensingSuspensionPanel.tsx` |
| 8 | Proactive موقوف الصرف badge before submission, in the outlet dispense list and both warehouse-side stock pickers | `OutletOperationsScreen.tsx`, `DispenseComposerDialog.tsx`, `StockMaterialPicker.tsx` |
| 9 | Quarantine domain audit/closure (zero gaps; structural isolation, not a runtime gate) | [QUARANTINE-DOMAIN-AUDIT.md](../QUARANTINE-DOMAIN-AUDIT.md) |

Every dispensing/FEFO/replenishment/suggestion/warehouse-send RPC audited
for this work gates on `_phoenix_is_material_dispensing_suspended_v1`
before it can move stock or generate a live suggestion for a suspended
material — checked at the exact scope each call site itself operates at
(org-wide only for warehouse-side sends, matching 207; org-wide-or-this-outlet
for outlet-side dispensing/replenishment, matching 204/208).

## 2. Dynamic enforcement coverage — one suite per enforcement point

Every one of the six migrations has its own `*.dynamic.test.ts` executing
against a real disposable `postgres:18` with `001 → 208` applied in order
(this repository's `pg-rig` CI job). **No enforcement migration is left
with static-only coverage.**

| Migration | Dynamic suite | Core proof |
|---|---|---|
| 203 | `203-material-dispensing-suspension` | Domain, RLS, permission keys, suspend/lift idempotency + immutability |
| 204 | `204-…-enforcement-dispense` | Dispense refused; sibling outlet unaffected; lift restores |
| 205 | `205-…-enforcement-fefo` | Suspended material leaves the candidate list while a **different, non-suspended material at the same warehouse keeps its batch**; a point-scoped suspension hides candidates at that outlet only while a second outlet stays eligible; org-wide reaches both; `central_item_id IS NULL` rows unchanged; lift restores FEFO order |
| 206 | `206-…-enforcement-suggestions` | An identical surplus/deficit corridor yields a real suggestion for a free material (positive control) and **none** for a suspended one — intra-org *and* cross-org — and lifting makes it suggestible again |
| 207 | `207-…-enforcement-warehouse-send` | All four guarded paths refuse, **including with `p_fefo_override = true` and a valid reason from an actor who genuinely holds `inventory.fefo_override`**; a dispatch whose line was added *before* the suspension is refused at send time, stays `draft`, writes no movement row, and sends normally once lifted. Every refusal is asserted together with the stock balance, so "refused" can never silently mean "refused after a partial debit" |
| 208 | `208-…-enforcement-replenishment-and-drafts` | Suspended source refused even with a non-suspended sibling batch present (candidate-starvation is not the gate); non-suspended replenishes; lift restores; a stale since-suspended suggestion cannot be drafted |

## 3. Two real defects found and fixed during this work

Each was caught by an actual CI failure and root-caused before being
fixed — neither was found by review alone.

1. **203's lift RPC self-collision.** The immutability trigger correctly
   protected `request_fingerprint`, but the lift RPC reused that same
   column for its own replay fingerprint, silently defeating both its own
   idempotency and create's replay detection after a lift. One root
   cause, five cascading failures across two suites. Fixed with a
   dedicated `lift_request_fingerprint` column and its own partial unique
   index.
2. **208's first draft regressed two later migrations.** It reproduced
   `phoenix_replenish_emergency_outlet` from 168's *original* body
   (dropping 180's initial-provisioning-first gate) and the draft bridge
   from 150's *original* body (dropping 151's route-policy-gate and
   delegate architecture). 180's own suite and the `r1-6` E2E matrix
   caught it immediately. Both bases were re-derived from the current
   definition on disk — located by grepping every migration for the
   latest `CREATE OR REPLACE FUNCTION`, never assumed from the
   introducing migration number — and the fix was verified with a
   byte-for-byte `diff` against source showing only the intended one-check
   addition in each function. 208 now redefines the *delegate*, leaving
   151's wrapper untouched.

## 4. Acceptance matrix

| Check | PR #181 (db) | PR #182 (ui) |
|---|---|---|
| `PostgreSQL pg-rig` (real disposable Postgres, `001→208` in order) | ✅ | ✅ |
| `Security and quality gates` (typecheck + lint + build + full non-dynamic Vitest) | ✅ | ✅ |
| `Authenticated browser acceptance` (disposable local Supabase E2E) | ✅ | n/a (job runs on #181) |
| `Vercel` preview deploy | ✅ | ✅ |
| `npm audit` | clean | clean |

Numbers are read from the actual CI run logs (`gh run view --job <id> --log`),
never estimated.

## 5. Accounting — file counts and the two distinct heads

PR file counts are the **merge-base** diffs GitHub itself reports
(`gh pr diff <n> --name-only`), not a plain two-tree `git diff`:

| PR | Base | Files |
|---|---|---|
| #181 `feat/material-dispensing-suspension-db` | `master` | **33** |
| #182 `feat/material-dispensing-suspension-ui` | `feat/material-dispensing-suspension-db` | **17** |

PR #181 was **30 files** until the three dynamic suites in §2 were added
(30 + 3 = 33); the guard file registering them was already among the 30.
An earlier revision of this document reported PR #182 as 16 files, which
was correct only before this supplement itself was added to that PR.

**Two heads, deliberately distinguished.** Documentation necessarily lands
*after* the implementation it documents, so a single "head" would be
ambiguous:

- **Implementation head** — the commit whose code and tests CI actually
  exercised. PR #181: `265c20b4`. PR #182: the merge of that commit into
  the UI branch.
- **Documentation head** — the later commit that adds or updates this
  supplement. It changes no migration, no test and no application code.

The digests in §6 cover **migrations only**, and no documentation commit
touches a migration — so they are measured at the implementation head and
remain valid at the documentation head by construction. That is a
checkable claim, not a self-referential one.

## 6. Evidence — per-migration SHA-256

SHA-256 of each of the six migrations. These are **not ceremonial**: each
is exactly the `migration_sha256` input `apply-production-migration.yml`
requires for its own authorized run (§7).

```
bc46c2f9e984d8a5e8f40548878ff15ad9ae38410ef180aa909c0453d4cb6de8  203_phoenix_material_dispensing_suspension.sql
a29d301361fd83b85fff14056872e0eabf05bb4c34e34ede5cb0331a3f9d13fe  204_phoenix_dispensing_suspension_enforcement_dispense.sql
46f2b93e8cea4d05d28223b1d1f1cd4b3494a959c2352d5b61dabc463369b47c  205_phoenix_dispensing_suspension_enforcement_fefo.sql
1a155c94068eaa364f559668b3db06526a65f674980d31e45f904dfe2c7ce079  206_phoenix_dispensing_suspension_enforcement_suggestions.sql
44a0cb934376da07f19fe5dbea20d924a425e4daed56ce78c536fb35b2869b78  207_phoenix_dispensing_suspension_enforcement_warehouse_send.sql
0a7a1dd1788f9e86a95a07e93bc84d662125a9cb25d3fbd06e09db9d398468bd  208_phoenix_dispensing_suspension_enforcement_replenishment_and_drafts.sql
```

Reproduce each independently, from a clean checkout of the head named in
§5:

```bash
sha256sum supabase/migrations/203_phoenix_material_dispensing_suspension.sql
```

**Two things this section deliberately no longer does.**

A previous revision published a single "combined seal" formed by hashing a
local listing of these files. That value was **not reproducible** — the
listing it hashed embedded absolute, machine-specific paths — and it is
removed rather than restated.

That revision also sealed this domain's two prose documents. That is
removed too, for a substantive reason rather than convenience: a migration
is immutable once applied, so a digest genuinely pins it, and the apply
workflow consumes that digest directly as an input. A document is a living
record — during this reconciliation alone both prose files were
legitimately corrected, each correction invalidating a published digest
that had guaranteed nothing. Sealing them manufactures a false sense of
fixity and a standing maintenance trap. The migrations are sealed; the
documents are versioned in git, which is the right instrument for them.

## 7. There is no Staging environment — Production preflight instead

**Verified, not assumed.** A previous revision of this document
recommended applying 203-208 to Staging first. That recommendation was
wrong and has been removed, because:

- No workflow in `.github/workflows/` references a staging environment at
  all (`apply-production-migration.yml`, `ci.yml`, `e2e-authenticated.yml`,
  `ops-windows-acceptance.yml`, `production-demo-seed.yml` and the three
  admin-function deploy workflows — grepping for "staging" returns
  nothing).
- `docs/phoenix/05-staging-deployment.md` names project ref
  `eyrzxgfkvqybjdgyphap` as "staging", but that is the **same** ref
  `apply-production-migration.yml` uses as `PROJECT_REF` under
  `environment: production` with `PHOENIX_PRODUCTION_DATABASE_URL`, and
  the same ref `.env.example` ships. That document describes the
  001→004 era; the single project it set up is now Production. Following
  its "staging" instruction today would point an operator **at
  Production**.
- `docs/phoenix/staging-rehearsal-runbook.md` lists "Staging Supabase
  project created (owner action — account/billing)" as an *entry
  criterion* — a prerequisite the owner would have to provision, not an
  environment that exists.

**Conclusion: there is exactly one Supabase project, and it is
Production.** Nothing in this task created, altered or connected to it.

### Separately authorized Production apply — preflight

Every step below is a human action. Nothing here is automated by this
work, and no agent may perform it.

1. Merge PR #181 into `master` (human decision), then PR #182.
2. Take a fresh owner-run backup export before the first apply.
3. For each migration **in order — 203, 204, 205, 206, 207, 208 — run
   `apply-production-migration.yml` once.** The workflow is
   `workflow_dispatch`-only, pinned to `environment: production` (so it
   requires that environment's approval), serialized on a
   `production-migration-apply` concurrency group that is never cancelled,
   and **applies exactly one pinned migration per run**, asserting
   `expected_next_ceiling == expected_current_ceiling + 1`. Six migrations
   therefore mean six separately authorized runs; there is no batch mode
   and none should be improvised.
4. Each run requires exactly: `confirm_sha` (the 40-hex `master` commit),
   `migration_filename`, `migration_sha256` (§6), `expected_current_ceiling`,
   `expected_next_ceiling`, `remote_history_version` (a 14-digit version
   newer than every applied one), and the literal confirmation string
   `APPLY_PRODUCTION_MIGRATION`.
5. Before the first run, confirm Production's current ceiling really is
   `202`. If it is not, stop: the ceiling inputs for all six runs shift
   and must be recomputed from the real value.

### Post-apply verification

The workflow already performs, per run and without treating a zero exit
code as proof: a read-only preflight proving exactly one pending
migration, a dry-run preview, the apply, a post-apply dry-run asserting
nothing is pending, a fresh-connection check that history reached exactly
the pinned ceiling, and a re-check of the Major-H authorization
invariants. A failed run is classified rather than retried or repaired.

After all six runs, verify on Production:

1. Migration ceiling is exactly `208`.
2. `_phoenix_is_material_dispensing_suspended_v1` exists, is
   `SECURITY DEFINER`, and carries `search_path = public, pg_temp`.
3. The three domain RPCs and the `material_dispensing_suspension.*`
   permission keys exist, with `.view_badge` granted to all five roles and
   `.create`/`.lift`/`.view` to the administrative roles only.
4. `material_dispensing_suspensions` is empty and carries no direct
   `INSERT`/`UPDATE`/`DELETE` grant to `authenticated`.
5. A read-only smoke of the badge RPC returns `is_suspended = false` for
   any real `central_item_id` — i.e. the new gate is installed and inert
   until someone deliberately suspends something.

Steps 2-5 are read-only and mutate nothing.

## 8. Recommended merge order

1. **PR #181** into `master` — it is the dependency (#182's base branch is
   #181's head).
2. **PR #182** into `master` — GitHub retargets it automatically once #181
   lands.
3. Then, and only then, the separately authorized Production apply in §7.

Merging is a human decision point; no agent merged, deployed, or mutated
any database in producing this work.
