# 2026-07-30 — R0 (part): purge package and runner hardening

Filed report. Append-only; do not edit.

**Outcome:** local package built and proven; **Production never connected to**.

## Delivered

- `supabase/ops/pre_launch_full_purge_v147.sql` — Option-A purge, SHA-256
  `4ee2facffa814ee50b323f46d7d4c45a71d7635fc73b31a3fde800d6c27cf0a8`.
- `supabase/ops/purge-manifest-v147.ts` — 70 purge / 2 preserve / 2 keeper-scoped.
- `ops/run-prelaunch-purge-v147.ps1` and the release/post-purge orchestrators.
- Rig suites: Option-A 15/15, manifest coverage 7/7, runner contract 13/13.

## Defects found and fixed

**Historical 090-era reset is unsafe at 147.** Its closed allowlist misses ten
runtime tables added after 090 and names four since renamed (silently skipped via
`to_regclass`), so on a 147 database it reaches `COMMIT` reporting a clean
zero-state while those tables still hold rows — a *false* zero-state. Superseded,
not deleted.

**Migration 004 seeds the "canonical baseline".** A clean `001→147` replay leaves
rows in 14 tables — two demo hospitals with their warehouses, outlets, catalog,
availability and QR rows. These were simultaneously "test data to delete" and
"migration-seeded baseline to preserve". Owner resolved as **Option A**: purge
them, never re-seed. Verified none of 148–153 reference the demo UUIDs.

**Six immutability triggers block DELETE at 147.** Only sanctioned exemption
(`phoenix_demo_row_is_purgeable`, migration 141) requires demo-marked rows, which
a general purge does not satisfy. Resolved by disabling exactly those six by
name inside the transaction against an audited allowlist, proven byte-identically
restored before `COMMIT`.

**FK graph has a six-table cycle** (`item_availability`,
`item_availability_movements`, `outlet_stock`, `warehouse_dispatch_lines`,
`warehouse_dispatches`, `warehouse_stock`). Resolved by ordering on
**ordering-forcing** constraints only (`RESTRICT`/`NO ACTION`); `CASCADE` and
`SET NULL` do not constrain delete order.

**Windows PowerShell 5.1 parse failure.** Nine em dashes (U+2014) in a UTF-8
file with no BOM decoded under CP1252 into `U+201D`, which PowerShell treats as
a string delimiter; nine is odd, so the parser was left mid-string and the first
reported error landed on an unrelated `SELECT` 215 lines below the real break at
line 3. Fixed by making the runner pure ASCII. 22 parse errors → 0.

**TLS could not connect.** `sslmode=verify-full` requires a CA bundle; the
per-user file did not exist, so the connection died before it was attempted.
First fixed with `sslrootcert=system` (commit `dd62337`) — **subsequently
superseded by canonical memory v11 §3.2**, which demotes that to unproven and
requires an explicit checksum-pinned CA instead.

## Superseded by v11

| this report | v11 |
|---|---|
| `sslrootcert=system` as the fix | explicit CA + pinned SHA-256; `system` only after proof |
| client `psql >= 16`, `pg_dump >= 17` | client major must **equal** Production major (17) |
| rig on PostgreSQL 18.4 | PG17.x primary; PG18 non-blocking compatibility only |
| owner may run the purge once locally green | no Production purge before a full PG17 staging rehearsal + Go |

All rig proofs in this report ran on **PostgreSQL 18.4** and therefore do not
satisfy v11's parity requirement. They must be re-run on a PG17 rig.

## Known local-only issues

- Full suite OOMs under default parallelism; use
  `--pool=forks --poolOptions.forks.singleFork --fileParallelism=false`.
  Pre-existing, reproduced on a pristine tree.
- `tests/qa-harness-production-safety.test.ts` flaky at suite level locally (its
  internal ~80s build times out under load); passes in isolation and on CI.
- Migration 141's comment says `procurement_order_events` has no immutability
  trigger, but the catalog shows 087's is present. Harmless (allowlisted),
  unresolved.
