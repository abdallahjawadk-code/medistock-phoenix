# PR #41 — hard deployment blockers

Nothing in this PR may be merged or deployed while any item below is open.

---

## Live environment — read-only findings (verified before authoring 078)

Recorded because they change the risk profile of blockers 2 and 3.

* PostgreSQL 17.6. `supabase_migrations.schema_migrations` = **77 rows, max
  077** — exactly matching the repository. **No drift.**
* Highest migration across the registry and **every** remote branch is 077, so
  078 is the first genuinely unused number. (Note: `066` is already taken by
  `066_phoenix_inventory_network_expand.sql`; "migration-066+" in blocker 3 means
  "066 or later", not that 066 is free.)
* **Every inventory table is EMPTY**: `warehouse_stock`,
  `warehouse_stock_movements`, `item_availability`, `outlet_stock` — all 0 rows.
  Duplicate lot-identity groups: 0. No null/negative/blank invalid state.
* Configuration data IS populated: 5 organizations, 4 profiles, 3 warehouses,
  5 distribution points, 112 permission keys, 882 role defaults, 9 QR tokens.

**Consequence for blocker 3:** there is currently no `item_availability` data to
migrate or reconcile. That makes the replacement far cheaper than assumed — but
the migration must still carry a precondition that ABORTS if rows exist at apply
time, because the owner applies manually at a later date and data may appear
first. Do not write a migration that assumes emptiness.

---

## 1. Migration 065 — expected-generation protection

**Status: open ONLY because nothing is applied. The fix is complete and
dynamically validated.**

Migrations **078** (guard), **079** (fail closed), **080** (cutover revoke), plus
the guarded client. Commits `0a77830` and `e955926`.

Executed on a disposable PostgreSQL 18.4 cluster with 001→080 applied in order:
**27/27 concurrency assertions passed**, including the two-device double-post
rejection, idempotent lost-response replay, and the privilege boundary verified
as the `authenticated` role. Record:
`migration-078-079-dynamic-validation.md`. Release steps:
`cutover-package-warehouse-generation.md`.

`MIGRATION_065_CONCURRENCY_RESOLVED` stays **false** until 078+079 are applied
AND the guarded client is deployed AND parity is observed — the exact conditions
are in §6 of the cutover package.

An accumulating-receipt flow can double-post across two devices: both read the
same generation, both post, and the second write lands on stale state. The
client-side fail-closed gate (`e04e134`) prevents the known path, but the
guarantee belongs on the server.

Required: `phoenix_*` receipt RPCs must take an expected generation and reject a
write whose generation no longer matches, so concurrency is settled in the
database rather than by client cooperation.

---

## 2. Unified movement-timeline RPC

**Status: open.**

`CurrentMovementStatus` (Screen 18) resolves a document's **current** state from
RLS-scoped reads. It is deliberately NOT a historical timeline, and the UI says
so. There is no backend able to return an ordered, permission-scoped history of
a movement document.

Required: a single timeline RPC. Until it exists, no surface may claim to show a
complete document history — see `docs/phoenix/proposals/movement-timeline-rpc.md`.

---

## 3. Reachable legacy manual-availability writer

**Status: open. One writer remains reachable.**

The approved model is the migration-065 warehouse ledger as stock truth:
availability condition is derived from the ledger and never typed in by an
operator. Three pre-065 writers still exist in the tree. Reachability was
audited directly, and is pinned by
`src/features/inventory/__tests__/legacy-availability-writer-audit.test.ts`.

| Writer | Reachable | Evidence | Disposition |
| --- | --- | --- | --- |
| `EditorScreen.tsx` | — | Was unreachable: screen 3 routed to `InventoryCenterScreen`, no production import, absent from `dist/` | **DELETED** (E6, `6dba1ef`) |
| `QuickAvailForm` (in `InstitutionScreen.tsx`) | — | Was unreachable: its `showAdd` flag had no `setShowAdd(true)` anywhere | **DELETED** (E6, `6dba1ef`) |
| `ReactivateMaterialModal.tsx` | **Yes** | `StatusCenterScreen` renders it and sets `reactivateRow` from a live control | **This blocker** |

`upsertAvailability` now has exactly **one** production call site, asserted by
exact array equality in `quantity-overwrite-guard.test.ts` and
`legacy-availability-writer-audit.test.ts`. A second entry fails the build.

### Why ReactivateMaterialModal is not simply removed

It is the ONLY way to un-remove a material whose `removed_at` is set. It is not
an unaudited balance write: quantity moves only through
`applyAvailabilityMovement` (migration 035's sole permitted quantity-write path,
which records a movement row), and the `upsertAvailability` that follows clears
the removed marker at the same quantity. It is gated on
`availability.quantity.set` + `availability.update`.

The migration-065 ledger offers **no parity replacement**: it models warehouse
stock, whereas this operates on distribution-point `item_availability` rows and
their migration-053 removed marker. Fail-closing it today would delete an
operator capability with nothing to replace it, so it is recorded here as a
blocker rather than silently disabled.

Required before deploy: a backend replacement (migration 066 or later) that
expresses reactivation in the ledger model, after which this modal is removed.

---

## Deletion — DONE (E6, `6dba1ef`)

Both unreachable writers are deleted. The isolation guards that read them were
migrated, not dropped:

- **isolation-only** ("EditorScreen is untouched by this phase") → absence
  guards via `tests/helpers/retired-surfaces.ts`. Strictly stronger: a deleted
  screen cannot gate on the wrong permission or grow movement wiring.
- **still-valid invariants** → moved to where they now live (the surviving
  writer, migration 051's own test, `quantity-overwrite-guard`).
- **obsolete writer assertions** → inverted, with the reason recorded in place.

The RPC-only table-write scan was **widened** from five hand-listed files to
every production source file, so it cannot go stale as screens are added.

Permanent guards now in force: the file stays deleted; no production module
imports or renders it; screen 3 stays `InventoryCenterScreen`; `QuickAvailForm`
and its trigger stay absent; `upsertAvailability` keeps exactly one call site.
