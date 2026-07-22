# Migration 081 — movement timeline: audit and dynamic validation

**Nothing was applied to the production database.** Migration 081 was executed
on a disposable PostgreSQL 18.4 cluster with 001→081 applied in order.

---

## The audit that shaped the design

The instruction was to check first whether the schema genuinely retains every
lifecycle transition, and never to fabricate events. It does not, so it doesn't.

**What IS genuinely retained**

* The four movement tables — `warehouse_stock_movements`,
  `outlet_stock_movements`, `warehouse_quarantine_stock_movements`,
  `item_availability_movements` — are append-only event rows, each with its own
  id, actor, quantities, reason, reference and `created_at`. Verified: **no
  UPDATE or DELETE policy exists on any of them** for `authenticated`. These are
  real events.
* Corridor headers keep **denormalized transition pairs**: `requested_at/by`,
  `reviewed_at/by`, `cancelled_at/by`, `sent_at/by`. A non-NULL pair proves that
  specific transition happened, when, and by whom.

**What is NOT retained, and cannot be recovered**

* Any transition without its own `_at`/`_by` pair. Headers carry **one mutable
  `status`**, overwritten in place — intermediate states leave no trace.
* `updated_at` is overwritten on every write and proves nothing about *which*
  transition occurred.
* `audit_logs` covers only some corridor actions, inconsistently (the live
  database has 4 `warehouse_transfer.request_created` rows and no comparable
  per-transition coverage for the other corridors).

**Therefore:** a complete retrospective timeline is impossible, and 081 says so
in the migration header, in the RPC's own payload (`complete: false` plus a
`completeness_note` explaining why), and per event via `provenance`:

| provenance | meaning |
|---|---|
| `movement_row` | a real append-only event row |
| `derived_from_column` | proven by a non-NULL header `_at`/`_by` pair |
| `event_ledger` | recorded by the new append-only ledger (future events) |

The new ledger `phoenix_movement_events` closes the gap **going forward**. It is
deliberately **not backfilled**: the derived-column path already surfaces exactly
the transitions that are provable, and inserting anything else would be
invention.

---

## Dynamic results — 23/23 passed

| Scenario | Result |
|---|---|
| Authorized persona | returns the trace's events, all marked `movement_row` |
| Completeness | `complete=false` always, with a stated reason |
| Deterministic ordering | identical across repeated calls |
| **Equal timestamps** | tie-broken by the immutable event id, ascending |
| Cursor pagination | page 1 limit honoured, cursor returned, page 2 returns the remainder |
| Pagination integrity | no event repeats; every event appears exactly once; last page has no cursor |
| Strict max page size | a request for 100 000 is clamped to ≤200 |
| Nonexistent trace | empty result |
| **Forbidden scope** | **byte-identical** to nonexistent — no existence oracle |
| Ledger INSERT / UPDATE / DELETE as `authenticated` | all denied (42501) |
| `reference_id` lookup | **Index Scan** |
| Header transition | appears as `derived_from_column`; no event invented where no timestamp exists |

### Two things the run corrected

**The index test was initially meaningless.** On a 3-row table the planner
correctly chose a sequential scan, and my assertion failed. That was the test
being naive, not the index being wrong: with 3 000 rows the planner switches to
an Index Scan, which is the condition the index exists for. The test now
populates realistic volume before running EXPLAIN.

**Movement rows cannot share a `(reference_type, reference_id)`.** The `*_once_uniq`
indexes are **partial**, scoped per `reference_type` — that is 065's idempotency
guarantee. So one trace is legitimately referenced by *several different*
corridor event types, which is also exactly the cross-corridor provenance case,
and the suite now exercises it that way.

---

## Not done

**Current Movement Status is unchanged.** The instruction was to upgrade it only
after the contract is dynamically proven. It now is — but migration 081 is **not
applied**, so the RPC does not exist in any live database. Upgrading the screen
now would break it in production. The upgrade belongs in the same change that
flips the feature on, after 081 is applied, exactly as the 078/079 gate works.

**Blocker 3 is not started.**

---

## Reproducing

Same disposable rig as 078/079: `initdb` a cluster on a spare port, bootstrap the
Supabase-shaped objects, apply `supabase/migrations/*.sql` in filename order,
seed an active `super_admin` before 062, then run the timeline script. The rig
lives in the scratchpad and is deliberately not committed — it is a throwaway,
not a maintained suite, and committing it would imply CI runs it.
