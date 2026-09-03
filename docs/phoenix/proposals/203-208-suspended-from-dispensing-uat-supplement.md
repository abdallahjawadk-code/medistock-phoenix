# Suspended-from-Dispensing (203-208) — Consolidated UAT Supplement

**Status: both PRs CI-green, independently verified against a real disposable
Postgres. Neither PR is merged; no Production migration was applied; no
Production data was touched.**

This supplement is the single change-impact/UAT record for the whole
203-208 domain and its UI (PR #181 + PR #182), plus the accompanying
Quarantine audit. It follows the leaner "consolidated supplement" style
(one document, source-cited, real numbers) rather than the historical
per-migration ceremony file set.

## 1. Scope delivered

| # | Item | Where |
|---|---|---|
| 1 | `material_dispensing_suspensions` domain (table, RLS, permission keys, suspend/lift/status RPCs) | [203_phoenix_material_dispensing_suspension.sql](../../supabase/migrations/203_phoenix_material_dispensing_suspension.sql) |
| 2 | Dispense-time enforcement | [204](../../supabase/migrations/204_phoenix_dispensing_suspension_enforcement_dispense.sql) |
| 3 | FEFO-time enforcement | [205](../../supabase/migrations/205_phoenix_dispensing_suspension_enforcement_fefo.sql) |
| 4 | Suggestion-generation enforcement | [206](../../supabase/migrations/206_phoenix_dispensing_suspension_enforcement_suggestions.sql) |
| 5 | Warehouse-dispatch send enforcement | [207](../../supabase/migrations/207_phoenix_dispensing_suspension_enforcement_warehouse_send.sql) |
| 6 | Emergency-replenishment + stale-draft enforcement | [208](../../supabase/migrations/208_phoenix_dispensing_suspension_enforcement_replenishment_and_drafts.sql) |
| 7 | Admin management panel, org-wide AND outlet-scoped suspend/lift UI | `MaterialDispensingSuspensionPanel.tsx` |
| 8 | Proactive بموقوف الصرف badge in the outlet dispense picker and the warehouse-dispatch/direct-supply stock pickers | `OutletOperationsScreen.tsx`, `DispenseComposerDialog.tsx`, `StockMaterialPicker.tsx` |
| 9 | Quarantine domain audit/closure (zero gaps found; structural isolation, not a runtime gate) | [QUARANTINE-DOMAIN-AUDIT.md](../QUARANTINE-DOMAIN-AUDIT.md) |

Every dispensing/FEFO/replenishment/suggestion/warehouse-send RPC audited
for this work now gates on `_phoenix_is_material_dispensing_suspended_v1`
before it can move stock or generate a live suggestion for a suspended
material — org-wide and outlet-scoped, checked at the exact scope each
call site itself operates at (org-wide only for warehouse-side sends,
matching 207; org-wide-or-this-outlet for outlet-side dispensing/
replenishment, matching 204/208).

## 2. Two real defects found and fixed during this work (not merely
   "tests run"; each is a genuine server-side or fixture bug caught by a
   real pg-rig failure and root-caused before being fixed)

1. **203's lift RPC self-collision** (found via CI, not local review): the
   immutability trigger correctly protected `request_fingerprint`, but the
   lift RPC illegally reused that same column for its own replay
   fingerprint, silently defeating both its own idempotency AND create's
   replay-detection after a lift. One root cause, five cascading test
   failures across two files, all traced to it before the fix (dedicated
   `lift_request_fingerprint` column + index).
2. **208's first draft regressed two later migrations** (found via CI, not
   local review): the emergency-replenishment body was based on 168's
   *original* text instead of 180's current one (dropping 180's
   initial-provisioning-first gate), and the draft-from-suggestion body was
   based on 150's *original* text instead of 151's current
   wrapper-plus-delegate architecture (dropping 151's route-policy-gate
   call). Both were re-derived from the actual current definition on disk
   — confirmed by grepping every migration for the latest
   `CREATE OR REPLACE FUNCTION`, never assumed from the introducing
   migration number — and the fix was verified with a byte-for-byte `diff`
   against the real source showing only the intended one-check addition in
   each function. Two further fixture-only bugs in the new dynamic test
   (a wrong `source_scope_id`, a fabricated `material_identity_key`, a
   placeholder `target_scope_id` with no backing row) were caught by the
   same CI round-trips and fixed the same way — real logs, real root
   cause, no guessing.

Full narrative for both is in each migration's own header comment and in
the git history of PR #181 (5 commits, each fixing one CI-caught issue).

## 3. Acceptance matrix

| Check | PR #181 (db) | PR #182 (ui) | Real / real data source |
|---|---|---|---|
| `PostgreSQL pg-rig` (real disposable Postgres, `001→208` applied in order) | ✅ pass, 7m51s | ✅ pass, 7m37s | 153 dynamic test files, 2442 individual assertions passed, 0 failed |
| `Security and quality gates` (typecheck + lint + non-DB Vitest) | ✅ pass, 3m57s | ✅ pass, 4m21s | 453 test files passed, 0 failed |
| `Authenticated browser acceptance` (disposable local Supabase E2E) | ✅ pass, 8m47s | n/a (181-only job) | — |
| `Vercel` preview deploy | ✅ pass | ✅ pass | — |
| Migration 208's own dynamic suite | ✅ 4/4 tests | ✅ 4/4 tests | Suspended-source replenishment refused (with a non-suspended sibling present, proving it is a real gate, not FEFO-starvation), non-suspended material replenishes normally, lift restores replenishment, stale suspended suggestion cannot be drafted |
| Freeze-guard / governance cascade (16 files, migration-numbering conventions) | ✅ local, folded into quality gates | ✅ same | 630 assertions |
| Quarantine domain | ✅ audited, zero gaps | — | 27 pre-existing dynamic suites spanning its full history; see the audit doc |

Every number above is read directly from the actual CI run logs
(`gh run view --job <id> --log`), not estimated — job IDs:
[181 pg-rig](https://github.com/abdallahjawadk-code/medistock-phoenix/actions/runs/33783031789/job/100741058748) ·
[182 pg-rig](https://github.com/abdallahjawadk-code/medistock-phoenix/actions/runs/33783052818/job/100741121610) ·
[181 quality gates](https://github.com/abdallahjawadk-code/medistock-phoenix/actions/runs/33783031789/job/100741059073) ·
[182 quality gates](https://github.com/abdallahjawadk-code/medistock-phoenix/actions/runs/33783052818/job/100741121093).

## 4. PR heads and file scope

- **PR #181** — `feat/material-dispensing-suspension-db` → `master`.
  Head `d2fc0531f544a2ef5d6c37d1d72639eb322786d8`. 30 files: migrations
  203-208, their dynamic tests, the design doc, and the freeze-guard
  cascade update for migration 208's numbering.
- **PR #182** — `feat/material-dispensing-suspension-ui` →
  `feat/material-dispensing-suspension-db` (stacked). Head
  `f72c690b77485786d5cddd31d1ea766c116e7191`. 16 files: the admin panel,
  the two permission hooks, the three picker/composer surfaces carrying
  the proactive badge, one real bug fix in an unrelated composer
  (`OutletDispatchComposer.tsx`'s `toCandidates` was hardcoding
  `centralItemId: null`, silently disabling the badge on that one screen),
  the Quarantine audit doc, and the two governance tests the new picker
  reachability required updating.

Neither PR has been merged. No `master` migration was applied to any
database. No Production data was read, written, or touched — every
verification above ran against CI's disposable Postgres containers.

## 5. Evidence seal

SHA-256 of each of the eight files that constitute the domain's
server-side and audit core (migrations 203-208 plus both docs), computed
directly from the working tree at the exact commits above:

```
bc46c2f9e984d8a5e8f40548878ff15ad9ae38410ef180aa909c0453d4cb6de8  203_phoenix_material_dispensing_suspension.sql
a29d301361fd83b85fff14056872e0eabf05bb4c34e34ede5cb0331a3f9d13fe  204_phoenix_dispensing_suspension_enforcement_dispense.sql
46f2b93e8cea4d05d28223b1d1f1cd4b3494a959c2352d5b61dabc463369b47c  205_phoenix_dispensing_suspension_enforcement_fefo.sql
1a155c94068eaa364f559668b3db06526a65f674980d31e45f904dfe2c7ce079  206_phoenix_dispensing_suspension_enforcement_suggestions.sql
44a0cb934376da07f19fe5dbea20d924a425e4daed56ce78c536fb35b2869b78  207_phoenix_dispensing_suspension_enforcement_warehouse_send.sql
0a7a1dd1788f9e86a95a07e93bc84d662125a9cb25d3fbd06e09db9d398468bd  208_phoenix_dispensing_suspension_enforcement_replenishment_and_drafts.sql
1b800ef8db37d6e15f9836d1221916fb50584149ecba052d36df8e9c19861ba8  QUARANTINE-DOMAIN-AUDIT.md
41c73bba6a693b94a966924689c8db6adfddfb03445653b8285df541227c89e8  203-material-dispensing-suspension.md
```

**Combined seal** (SHA-256 of the eight lines above, in the order shown):

```
edf248399d9f00e792ddf0be3f7defe22c17b3a950949025331e098caba5bca7
```

Reproduce with `sha256sum` over the same eight paths, in this order, at
commit `f72c690b77485786d5cddd31d1ea766c116e7191`.

## 6. Recommended merge order

1. Review and merge **PR #181** into `master` first (it is the
   dependency; #182's base branch is #181's head).
2. Apply the resulting `master` migrations 203-208 to Staging, then
   re-run the acceptance matrix there before any Production step — this
   supplement covers CI's disposable database only, not Staging/Production
   parity, which is a separate, later gate this task was explicitly
   scoped to never touch.
3. Merge **PR #182** into `master` (GitHub will re-target it automatically
   once #181 lands, or it can be rebased first).
4. Neither PR should be merged by an agent — this is a human decision
   point per the task's own constraints.
