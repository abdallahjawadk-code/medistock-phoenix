# Migration 086 — guarded outlet-stock correction: validation

**Nothing applied to production.** Executed on a disposable PostgreSQL 18.4
cluster via `tools/pg-rig` with the chain applied in order (001→084, **086** —
the rig skips the prepared-only 085; see below). Production is 17.6.

```
PHOENIX_RIG_PG=postgres://postgres@localhost:55432/postgres node tools/pg-rig/apply.mjs 86
# → OK — chain applied through 86 in ~6s; public functions: 211
PHOENIX_RIG_PG=postgres://postgres@localhost:55432/postgres \
  npx vitest run supabase/migrations/__tests__/086-outlet-correction-generation.dynamic.test.ts
# → 8 passed
```

## Why

The canonical-stock cutover routes every OUTLET quantity correction to the
`outlet_stock` ledger (`item_availability` is a read-only projection — 083).
Migration 067 already ships the correct guarded lot-level correction,
`phoenix_count_outlet_stock` (idempotent on request id, non-negative,
reservation-aware, reason-mandatory, batch/provenance-snapshotting,
actor-attributed, append-only `correction` movement + audit, scoped to
`outlet_stock.count` on the locked row's outlet). Its one gap for a stocktake is
optimistic concurrency. 086 closes it exactly as 078 did for `warehouse_stock`.

## What 086 adds

- `outlet_stock.movement_seq bigint NOT NULL DEFAULT 0` — server-owned
  generation, advanced by the BEFORE UPDATE trigger
  `phoenix_outlet_stock_bump_movement_seq` on every on_hand/reserved change
  (count, dispense, receive, return), never settable by a client.
- `phoenix_count_outlet_stock_guarded(request_id, outlet_stock_id,
  counted_quantity, reason, expected_generation, notes)` — checks the generation
  under the row lock (RAISE 40001 `outlet_stock_generation_conflict` on a moved
  generation), replay short-circuits BEFORE the check, then **delegates the write
  to the unchanged `phoenix_count_outlet_stock`**. Least-granted (authenticated
  only). The legacy body stays callable.

## Dynamic results — 8/8

| Case | Proven |
| --- | --- |
| new lot / correction | generation starts 0; a count sets on_hand, advances to 1, writes one `correction` movement with the reason |
| stale generation | a second count still carrying `expected=0` → 40001; on_hand unchanged |
| lost-response retry | same request id short-circuits as a replay, skips the generation check, one effect not two |
| reservation floor | counting below reserved → `outlet_quantity_below_reserved` |
| non-negative | negative counted → `counted_quantity_must_be_non_negative` |
| reason required | blank reason → `outlet_count_reason_required` |
| forbidden scope | foreign-org actor without `outlet_stock.count` → `forbidden_outlet_stock_count`; on_hand untouched |
| unguarded contract | `expected_generation = NULL` still corrects (legacy contract preserved) |

Static contract: `086-outlet-correction-generation.test.ts` — 14/14.

## Apply order note (prepared-only 085)

085 (the parity-gated revoke of the manual availability writers) is **PREPARED
ONLY** and fail-closed. It is **not** part of the standard applied chain and is
skipped by the disposable rig (`PREPARED_ONLY_SKIP` in `tools/pg-rig/rig.mjs`),
so later functional migrations can be exercised. Unexecuted apply order:
**001–084 and 086 apply now; 085 applies LAST, by hand, only at production
parity/cutover** (`SET phoenix.availability_cutover_attested='true'`). 085's own
fail-closed behaviour is pinned by its static test and the one-off abort proof.
