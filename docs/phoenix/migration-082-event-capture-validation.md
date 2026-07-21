# Migration 082 — movement-event capture: audit and dynamic validation

**Nothing was applied to the production database.** Migration 082 was executed
on a disposable PostgreSQL 18.4 cluster with 001→082 applied in filename order
via `tools/pg-rig`, and exercised by driving the **real** lifecycle RPCs and
then reading `phoenix_movement_timeline`. Production is 17.6 — see the version
gap note below.

---

## The audit that shaped the design (verifying Blocker 2 / 081)

081 created the ledger `public.phoenix_movement_events` and the read RPC
`phoenix_movement_timeline`, and its own header documents it as the writer for
"FUTURE document lifecycle transitions". **But 081 shipped no writer.** A
whole-tree search found the table named only in 081 itself and its test — no
`INSERT INTO public.phoenix_movement_events` exists anywhere in the migrations or
the application. Consequences, confirmed on the rig before writing 082:

* The `event_ledger` provenance branch of the timeline was **dead** — it could
  never return a row, because no row could ever be inserted.
* 081's `derived_events` branch queries only `outlet_return_requests`,
  `outlet_return_shipments` and `warehouse_dispatches`. It **never queries**
  `warehouse_transfer_requests` or `warehouse_return_requests`, so the entire
  central↔institution supply/return lifecycle produced **no** timeline events
  except the stock-movement rows from send/receive.
* A transfer request reaching `partially_fulfilled`/`fulfilled` has **no
  dedicated `_at`/`_by` column**, so even for the covered tables that transition
  was unrecoverable.

**Therefore Blocker 2 was incomplete**: real lifecycle RPCs did not create
timeline events. 082 closes exactly this, going forward only.

## What 082 does

An `AFTER INSERT OR UPDATE` trigger (`phoenix_capture_lifecycle`) on all six
corridor headers — `warehouse_transfer_requests`, `warehouse_return_requests`,
`warehouse_return_shipments`, `outlet_return_requests`, `outlet_return_shipments`,
`warehouse_dispatches` — calls one `SECURITY DEFINER` function that appends the
status transition to the ledger. The headers are written **only** by SECURITY
DEFINER RPCs, so no RPC body was touched and no frontend path is involved.

## Dynamic proof — 5/5 passed

`supabase/migrations/__tests__/082-event-capture.dynamic.test.ts`, run against
the rig with `PHOENIX_RIG_PG` set. It drives the **real** RPCs
(`phoenix_create_warehouse_transfer_request` → `_add_..._line` →
`_submit_...` → `_review_...` / `_cancel_...`) as an authenticated principal.

| Scenario | Result |
|---|---|
| create + submit + review, then `phoenix_movement_timeline` | ledger holds `draft`, `submitted`, `approved`; timeline surfaces them with `provenance='event_ledger'` |
| actor attribution | every event's `actor_id` = the authenticated caller (`auth.uid()`), not a client value |
| org ownership | every event owned by the initiating org (`destination_organization_id` for a transfer request) |
| cancellation via the real cancel RPC | `cancelled` event captured |
| lost-response retry (submit called twice) | RPC rejects the second call; **no** duplicate event |
| metadata-only + same-status writes | trigger fires but the `IS DISTINCT` guard emits **nothing** |
| duplicate `dedupe_key` insert | rejected by the partial UNIQUE index |
| foreign-org reader | timeline returns `[]` — forbidden and nonexistent remain indistinguishable |
| completeness | timeline still reports `complete=false` |

## Honesty about history

History from **before** 082 is **not** backfilled. Events accrue only for
transitions that happen after apply. `phoenix_movement_timeline` therefore still
returns `complete=false`. Nothing is invented.

## No double counting

For the three tables 081 already derived from columns, the timeline now
suppresses the `derived_from_column` branch for a trace once the ledger holds any
event for it (`v_has_ledger`). Pre-082 documents (empty ledger) still surface
their derived-column events. The four append-only stock-movement tables are
untouched by the ledger, so `movement_row` events are never duplicated.

## Cross-org visibility — owner-review point

A corridor spans two organizations, but each ledger event is owned by ONE org
for RLS — the initiating org — consistent with 081's existing single-org
exposure of the same documents. The counterparty sees the physical outcome via
the append-only movement rows (which carry their own org). Widening a corridor's
full lifecycle timeline to BOTH participating orgs is a deliberate future
decision and is **not** silently assumed here.

## Version gap

Prod is PostgreSQL **17.6**; the rig ran on **18.4** (Docker was unavailable this
session; 18.4 matches the 078/079/081 validation rigs). 082 uses only
long-stable features — `to_jsonb`, partial unique index, `AFTER` row triggers,
`ON CONFLICT ... WHERE ... DO NOTHING` — with no 18-only syntax. A 17.x re-run is
advised at cutover but no behavioral difference is expected.

## Naming note

The task brief referenced `phoenix_get_movement_timeline`; the actual RPC (from
081) is `phoenix_movement_timeline`. This validation used the real name.
