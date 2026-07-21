# PR #41 — hard deployment blockers

Nothing in this PR may be merged or deployed while any item below is open.

---

## 1. Migration 065 — expected-generation protection

**Status: open. Fail-closed gate is landed; the server fix is not.**

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
