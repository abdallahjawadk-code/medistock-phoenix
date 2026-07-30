# Pre-launch full purge — v147, Option A

Owner-authorized removal of all business/test data from Production at migration
ceiling **147**, preserving schema, migrations, RBAC and one keeper account.

**Owner runs the destructive step.** Everything here is prepared, pinned and
tested in advance; the single production command is executed by the owner from a
visible PowerShell window.

---

## 1. The historical plan is forbidden here

`supabase/ops/pre_launch_runtime_reset.sql` must **never** run against
Production. It is kept as a record only. Two proven reasons:

1. Its header forbids production use and its attestation token literally ends in
   `_DISPOSABLE`.
2. It was written for schema **090**. Its allowlist is closed and its emptiness
   checks cover only that allowlist. Between 090 and 147, **ten** runtime tables
   were added and **four** were renamed. On a 147 database it deletes nothing
   from them, asserts nothing about them, and still reaches `COMMIT` reporting a
   clean zero-state — a *false* zero-state, which is worse than a loud failure.

Missed at 147: `phoenix_demo_manifest`, `phoenix_dispatch_line_requests`,
`phoenix_movement_dispense_context`, `phoenix_notification_reads`,
`phoenix_notifications`, `phoenix_paper_references`, `phoenix_report_snapshots`,
`phoenix_stock_correction_requests`, `phoenix_warehouse_correction_requests`,
`profile_lifecycle_reservations`.
Renamed away (silently skipped via `to_regclass`): `notifications`,
`notification_reads`, `stock_corrections`, `stocktake_counts`.

## 2. Target state

```
CANONICAL_PRELAUNCH_EMPTY_BASELINE_V147
  = clean schema 147
  - every row seeded by migration 004_phoenix_seed_demo_data.sql
  + exactly one verified keeper account
  + required RBAC reference data (permission_keys 130, role_permission_defaults 415)
```

This is **deliberately emptier** than a fresh `001→147` replay. Migration 004
seeds demonstration rows — Babil General Hospital, Al-Hilla Teaching Hospital,
their warehouses, outlets, catalog, availability and QR rows, at fixed UUIDs
`…0001` / `…0002`. The owner classified all of it as test data. It is **not**
re-seeded afterwards.

The superseded term `CANONICAL_MIGRATION_SEEDED_BASELINE` is void — it preserved
exactly those rows.

Verified: **none of migrations 148–153 reference the 004 demo UUIDs**, so
removing them does not break the pending migrations. A test enforces this
(`ops-full-purge-v147.dynamic.test.ts`), so a future migration that starts
depending on the demo seed fails loudly.

## 3. Keeper contract

Keeper is resolved **by email**, never by age:

```
abdallahjawad2015@gmail.com
```

The purge aborts unless that email resolves to exactly **one** `auth.users` row
with exactly **one** profile that is `super_admin`, `active`, and global
(`organization_id IS NULL`). A keeper scoped to an organization is rejected,
because the purge deletes organizations.

## 4. Manifest

`supabase/ops/purge-manifest-v147.ts`, covering all 73 public tables:

| category | count | treatment |
|---|---|---|
| `PURGE_ORDER` | 70 | deleted to zero, FK-safe child-first |
| `PRESERVE` | 2 | `permission_keys` (130), `role_permission_defaults` (415) |
| `KEEPER_SCOPED` | `profiles`, `auth.users` | everything except the keeper |
| `EXTERNAL_OR_PRECONDITION` | `storage.objects`, `storage.buckets` | must already be zero |

Delete order is derived topologically from the real 147 FK graph using only
**ordering-forcing** constraints (`RESTRICT` / `NO ACTION`). `CASCADE` and
`SET NULL` edges do not constrain delete order — excluding them is what makes
the graph orderable at all: a naive all-edges sort leaves a six-table cycle
(`item_availability`, `item_availability_movements`, `outlet_stock`,
`warehouse_dispatch_lines`, `warehouse_dispatches`, `warehouse_stock`).

The coverage suite pins the manifest to `pg_catalog` in **both** directions, so
an unclassified table fails loudly instead of being silently skipped.

## 5. Immutability exception

Six application triggers block `DELETE` at 147:

| table | trigger |
|---|---|
| `item_availability` | `trg_guard_availability_source_kind` |
| `phoenix_report_snapshots` | `phoenix_report_snapshots_forbid_mutation` |
| `procurement_order_events` | `procurement_order_events_immutable` |
| `procurement_receipt_lines` | `procurement_receipt_lines_immutable` |
| `procurement_receipts` | `procurement_receipts_immutable` |
| `procurement_returns` | `procurement_returns_immutable` |

Their only sanctioned exemption (`phoenix_demo_row_is_purgeable`, migration 141)
requires rows marked `PHOENIX_DEMO_V1` in a demo-owned org, which does not cover
a general purge. So the plan disables **exactly these six by name**, inside the
transaction, and:

- refuses to run if any is missing, internal, FK-backed, or backed by an
  unexpected function;
- refuses if **any other** `BEFORE DELETE` trigger exists on a purge table;
- captures each definition and `tgenabled` beforehand;
- re-enables them **before** postconditions and proves definitions and enabled
  state are byte-identical.

Never used: `DISABLE TRIGGER ALL`, `session_replication_role`, FK or system
trigger tampering, permanent bypass GUCs.

## 6. Transaction contract

```sql
BEGIN;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(4771470147);
```

No `DROP`, no `TRUNCATE`, no unbounded `CASCADE`, no retry, and no exception
handler that could convert a failure into a success. Any failed assertion
`RAISE`s and the whole transaction rolls back — **data and triggers together**.

## 7. Storage

Storage is a **precondition**, not a postcondition. Deleting `storage.objects`
rows in SQL does not delete the underlying files, so a zero row count would be a
false zero-state. Purge Storage through the official Storage API / dashboard
first; the plan and the script both refuse to proceed while it is non-empty.

## 8. Running it

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ops\run-prelaunch-release-core.ps1 `
  -TargetManifest ops\targets\production.json `
  -RehearsalArtifact <rehearsal-artifact.json>
```

The engine is target-agnostic: the same file, functions and step order run against
the rehearsal clone, staging and Production. Only the manifest and the operator's
credentials differ. `ops/targets/production.json` ships with
`allow_destructive_execution: false`, and even once that is flipped the engine
still demands a rehearsal artifact whose head SHA, purge-SQL digest, purge-manifest
digest, PostgreSQL major, client tool versions and CA pin all match — otherwise it
stops with `STOP_PRODUCTION_RELEASE_NOT_AUTHORIZED` before requesting a password.

The script is fail-closed at every stage and stops **before** the next
destructive step on any drift. It:

1. verifies the purge SQL against its pinned SHA-256 (refuses if it changed);
2. verifies the worktree is clean;
3. reads the DB password once (`SecureString` → BSTR, process memory only);
4. runs a read-only probe (identity, SSL, ceiling = 147, keeper, Storage, counts);
5. takes a local `pg_dump` and requires you to confirm a platform backup;
6. requires Storage to be empty;
7. runs the purge — one transaction, one attempt, after you type the confirmation phrase;
8. reconciles post-purge counts;
9. applies migrations 148–153 via `supabase db push`;
10. verifies ceiling 153, keeper intact, RBAC 130/415, no invalid constraints.

Two typed confirmations are required: `I HAVE A RESTORABLE BACKUP` and
`PURGE PRODUCTION NOW`.

Credentials are zeroed in `finally`. A redacted log and the local dump are left
in `%TEMP%\phoenix-purge-<timestamp>\`. **Keep the dump until you are satisfied
with the outcome.**

## 9. If it stops

- **Before the purge** — nothing was deleted. Fix the reported drift and re-run.
- **During the purge** — the transaction rolled back atomically; data and
  triggers are unchanged. Do **not** re-run before reading the report. There is
  no automatic retry.
- **After the purge, during migrations** — data is already purged; the ceiling
  tells you where it stopped. Do not hand-edit migration history; re-run
  `supabase db push` only after the cause is understood.

## 10. Not done by this script

Marking the PR Ready, merging, deploying and production smoke tests are driven
separately, after the outcome is reported.

## 11. If the ceiling is not 147

Everything here is pinned to 147: the manifest, the FK-derived delete order, the
trigger allowlist and the RBAC constants. At any other ceiling, re-derive the
manifest from `pg_catalog` and re-run the full local test battery before
touching Production. The plan refuses to run at any other ceiling.
