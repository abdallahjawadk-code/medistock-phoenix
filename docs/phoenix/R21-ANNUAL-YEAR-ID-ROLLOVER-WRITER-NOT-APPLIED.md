# MediStock Phoenix — R21 Year Identity Rollover / SQL Candidate (NOT_APPLIED)

**Status: DRAFT / HOLD.** Date: 2026-11-02, owner scope: approved annual catalog identity only. This document is not an apply authorization, production migration, operational proof, or permission change.

## Parallel ownership

- R20 [#294](https://github.com/abdallahjawadk-code/medistock-phoenix/pull/294) holds the pure year-to-year eligibility preview. This PR stacks on its exact source head.
- Codex independently owns #287 R2 monthly proposed allocation, #290 C4 source review, #293 real route/preview; no changed file overlaps those three heads.
- #292 preview environment audit remains separate.

## Implemented proposal

Candidate: `supabase/candidates/R21_year_identity_rollover_NOT_APPLIED.sql`.
Test: `supabase/candidates/__tests__/r21-year-rollover.dynamic.test.ts`.

1. Adds two private, append-only, RLS-forced tables with **no direct browser role grants**: a checker-approved source-year identity fingerprint and a target/year source-to-target identity evidence link.
2. Adds a separate `central_needs.approve` checker action. It must be a different actor from all source material creators/current version editors; it does not approve annual quantities.
3. Adds a `central_needs.edit` user-authorized, bounded 1–100-row **atomic page** write, only after a source approval digest is still current and the target year exists and is active. Uses the existing vetted `annual_catalog_write_item_v1` helper, **not a second writer** for the historical annual tables.
4. Copies only a fresh canonical identity whose exact field version and fingerprint still match. Keeps original source year, original field version, reviewed original classifications and employee identity in an immutable link.
5. Holds retired/incomplete/drifted/unreviewed/duplicate target materials. **Never** copies quantities, monthly proposals/approved allotments, warehouse counts, lots, expirations, SEND/RECEIVE or other physical inventory.
6. Replays receipts under the existing A1 idempotency key, forbids interleaved same-year pages with the existing advisory lock, pins source year while computing its digest, and refuses stale source approval after a source-year change.

## Required acceptance and known limitations

- **No SQL was applied** to Staging or Production. The existing hosted role compatibility/HOLD is unchanged; Production stays at last independently verified migration M231 until a new check.
- PostgreSQL candidate, including DO verify and grants, requires a disposable PG17/18 exact-head dynamic test and an independent privilege/ownership review. The current PR is not mergeable solely because a local TypeScript test passes.
- Historical source field edits that differ from the current canonical identity are **held**, never relabeled as canonical. A separate reviewed policy may be needed for importing legitimately noncanonical field edits.
- The original reviewed classifications are in the new immutable evidence-link table. Today's catalog search API does not yet surface these; the UI must later read them through an authorized bounded reader.
- First-year source checker approval can become stale after source membership changes and is intentionally irreversible in this candidate; a later explicit reapproval/versioned lifecycle must be designed rather than bypassing the digest. For now: fail closed.
- A page is not a complete-year receipt. The caller must follow a signed/bounded `nextAfterCanonicalItemId` cursor and independently verify target counts/source digest after the last page.
- A preview with READY build is not a working authenticated browser until Supabase Staging, CSP, current SQL, role boundaries and owner session are actually verified.

## Exact review order

1. First CI and PostgreSQL disposable native tests, check attached `R21` result and known sources of issue.
2. Independent review of SQL use of `SECURITY DEFINER`, OWNER, ACL, RLS, default grants, class provenance, concurrency, and existing A1/P3B capability seal; do not alter historical seals or baseline migrations.
3. On accepted candidate, implement the authorized **reader for carry provenance**, target-year UI for ready/held rows, and a separate operational smoke test.
4. Only after Staging hosted parity, backup/restore evidence, and explicit production gate can the owner choose production apply. Never automatically apply based on a draft PR.

## Economy of tokens (original EXT-PTEA)

Read K04, K05, K07, K12, K14, K18, K24, K25, K30, K37 and EXT-PTEA selectively, not all historical skills each turn. Keep original K01–K40 plus EXT-PTEA and EXT-EXCEL-IDENTITY byte-identical inside the full continuity ZIP after verification.
