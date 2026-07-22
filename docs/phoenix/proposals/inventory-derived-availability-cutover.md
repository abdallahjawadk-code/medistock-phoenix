# Blocker 3 — inventory-derived availability: audit and cutover design

**Status: AUDIT + DESIGN. The parity-gated cutover is NOT landed in this PR.**
A migration that revokes the availability writers must not ship until parity is
proven for every consumer (§4, §6). Shipping it unproven would break Status
Center, public QR and the institution/outlet views. This document is the honest
checkpoint: the exact current state, the target model, and what must be proven
before the cutover migration can land.

Audited live against the worktree at HEAD and the disposable rig (`tools/pg-rig`,
001→082 replayed on PostgreSQL 18.4).

---

## 1. Where availability actually comes from today

There are **two** stock models in the schema, and that is the whole problem:

* **Canonical stores (the truth going forward).** `warehouse_stock` (065),
  `outlet_stock` (067), their batch identities and the append-only movement
  tables. Outlets already have a **derived** availability projection —
  `phoenix_project_outlet_availability` + `phoenix_derive_outlet_availability_
  condition` (067) — computed from `outlet_stock`, never independently written.

* **`item_availability` (the legacy editable quantity).** Still an
  **independently writable** quantity for institution/port-level materials,
  written directly by manual RPCs. This is exactly what Blocker 3 says must stop:
  *"item_availability must never remain an independently writable quantity
  source."*

### Manual availability writers (server)

| RPC | Origin | What it writes | Retire? |
|---|---|---|---|
| `phoenix_upsert_availability` | 030/031/032/035/050/051 | inserts/updates an `item_availability` row's quantity + condition | **yes** — quantity path |
| `phoenix_apply_availability_movement` | 034/065 | `set_exact`/delta quantity movements on `item_availability` | **yes** — quantity path |
| `phoenix_clear_port_availability` | 007/042 | marks a port's rows removed | keep — this is **visibility** (removal), not a quantity source |
| `phoenix_clean_availability_data` | 055 | admin cleanup | out of scope (admin, not a live quantity source) |

`phoenix_guard_availability_source_kind` (065) already exists to police the
source of availability rows — the cutover extends that intent to a hard REVOKE.

### Reachable frontend writers (the real blast radius)

Verified by `grep` for actual invocations (not comments). Memory's "2 remaining"
was stale — the accurate list is:

| Call site | Writer used | Nature |
|---|---|---|
| `status/ReactivateMaterialModal.tsx:115,124` | `applyAvailabilityMovement(set_exact)` **and** `upsertAvailability` | sets a quantity to un-remove a row — **Blocker 3 point 4 target** |
| `status/AdjustQuantityModal.tsx:118` | `applyAvailabilityMovement` | operator edits a stored quantity directly |
| `institutions/InstitutionScreen.tsx:1707` | `applyAvailabilityMovement` | remove/adjust flow |
| `institutions/InstitutionScreen.tsx:1859` | `clearPortAvailability` | port clear (visibility) |

InstitutionScreen's **add** path was already migrated to the warehouse ledger
(065) — those remaining call sites are adjust/remove/reactivate, not create.

---

## 2. Target model (one authoritative availability)

1. **Physical availability is a projection**, derived only from canonical
   `warehouse_stock` / `outlet_stock` / batches / movement+receipt+return
   records. `item_availability` keeps only **catalogue** attributes; its stored
   `quantity`/`condition` stop being an authority and become (a) legacy history
   and eventually (b) a materialized read cache of the projection, never a
   writable input.
2. **Separate catalogue visibility from physical availability.** Migration 053's
   `removed_at/removed_by/removal_reason` is *visibility* (a catalogue row shown
   or hidden). Quantity is *physical availability*. They must not be changed by
   the same call. This is why `ReactivateMaterialModal` is wrong today: it
   restores visibility by writing a quantity.
3. **One projection RPC** (extend the 067 outlet projection to institution/port
   materials, or a sibling `phoenix_project_availability`) that Status Center,
   public QR, institutions, warehouses and outlets all consume — server
   authoritative, RLS-scoped, so forbidden and nonexistent rows are
   indistinguishable.

### Usable-quantity rules (audited, preserved — no new thresholds)

* **Exclude** expired, quarantined, rejected and unresolved-return quantities
  from usable availability. Quarantine lives in `warehouse_quarantine_stock`;
  near-expiry/expired is the **fixed 270-day** policy in migration 073 (never
  user-editable — pinned by the frontend guard); returns are unresolved until
  the 069/071 receive step.
* **Aggregate** repeated receipts of the same batch and multiple batches without
  double counting — batch identity is migration 051; the movement ledger's
  generation guard (078/079) already makes accumulating receipts idempotent.
* **Preserve** the approved low-stock / surplus definitions from migration 072
  (inventory intelligence) exactly — the projection reads them, it does not
  invent new ones.

---

## 3. First landable step (specified, ready, not yet built)

`ReactivateMaterialModal` → **visibility only**. Requires a new migration (next
free number **083**) adding `phoenix_restore_availability_visibility(
p_item_availability_id uuid)` that:

* clears `removed_at/removed_by/removal_reason` **only** — no quantity write, no
  insert, no call into `phoenix_upsert_availability`;
* requires the row to exist and be currently removed (else a clear error);
* enforces the same scope/permission the row's org requires (RLS preserved;
  forbidden/nonexistent indistinguishable);
* if the row's canonical stock is zero, returns a code the modal maps to *"no
  stock — use Inventory Intake"* rather than fabricating a quantity.

The modal then drops its quantity input and its `applyAvailabilityMovement` +
`upsertAvailability` calls. This is provable end-to-end on the rig (remove a row,
restore visibility, assert `removed_at` cleared, `quantity` unchanged, and **no**
`item_availability_movements` row written). It removes one of the reachable
quantity writers and is a clean, isolated commit.

`AdjustQuantityModal` and `InstitutionScreen`'s adjust path are the harder half:
they exist because institution/port materials have no canonical `*_stock` store
behind them yet. Retiring them requires the projection of §2.3 to actually source
those materials — a larger body of work, staged next.

---

## 4. Per-consumer parity checklist (gate for the cutover)

The cutover migration (§5) may not land until each of these reads the **same**
authoritative projection and matches the pre-cutover numbers on a fixture set:

- [ ] **Status Center** (`StatusCenterScreen`) — list + conditions from the projection.
- [ ] **Public QR** (026/027/028/052/058/059 read path) — usable quantity + condition from the projection; still leaks nothing about forbidden rows.
- [ ] **Institutions** (`InstitutionScreen`) — outlet/material lists from the projection.
- [ ] **Warehouses** — already canonical (065); confirm no `item_availability` dependency remains.
- [ ] **Outlets** — already projected (067); confirm Status/QR use the same one.

---

## 5. Cutover migration design (final step, after §4 is green)

A single migration that:

1. `REVOKE EXECUTE ON FUNCTION public.phoenix_upsert_availability(...) FROM
   authenticated;` and the same for the manual `phoenix_apply_availability_
   movement` overload — the retired quantity writers (Blocker 3 point 11). The
   SECURITY DEFINER internal path used by canonical flows is unaffected.
2. Keeps `phoenix_clear_port_availability` and the new
   `phoenix_restore_availability_visibility` (visibility, not quantity).
3. **Apply-time abort** if the previously-audited empty-inventory assumption has
   changed: the audit was taken against a specific state; the migration must
   `RAISE` if, at apply time, `item_availability` rows exist whose quantity is
   not reproducible from the projection (i.e. real divergence), so it is never
   applied against a database that has drifted since the audit and would silently
   lose an editable quantity nobody re-derived.
4. Preserves RLS and scoped permissions throughout.

---

## 6. Required dynamic cases → rig mapping

All to be proven on `tools/pg-rig` before the cutover lands, each asserting the
projection equals the hand-computed expectation:

| Case | Setup |
|---|---|
| no stock | material, zero canonical stock → availability 0, not an editable row |
| one positive batch | single receipt → exact quantity |
| repeated receipts, same batch | two receipts → summed once (078 idempotency), not doubled |
| multiple batches | distinct batches → summed, each counted once |
| partial dispatch + receive | send+receive subset → remaining = sent−received-in-transit |
| return + quarantine | returned/quarantined excluded from usable |
| expired batch | past the 073 window → excluded |
| catalogue hidden/reactivated | `removed_at` toggles visibility, quantity unchanged |
| concurrent mutations | two receipts race → generation guard serializes, no double |
| forbidden scope | foreign org → empty, indistinguishable from nonexistent |
| public QR | anon read → usable quantity only, no forbidden existence leak |
| no manual write path | grep + behavioural: no reachable frontend path calls a retired writer |

---

## 7. Status against Blocker 3's 13 points

Done here: **1** (model named), **2** (writer inventory), **3** (visibility vs
availability separation specified), **7/8/9** (exclusion, aggregation, preserved
thresholds — sourced, not invented), **13** (apply-time abort designed).
Specified & ready but not built: **4/5** (ReactivateMaterialModal visibility-only
+ RPC 083), **6** (single projection consumed by all), **10/11** (retire + revoke
after parity), **12** (RLS preserved — carried from 067/081 patterns).

## 8. Owner decisions needed

* Confirm the projection strategy: **extend** `phoenix_project_outlet_availability`
  to institution/port materials, or add a sibling `phoenix_project_availability`.
* Confirm whether `item_availability.quantity` becomes a **read cache** of the
  projection or is dropped as an authority entirely.
* Approve the visibility-only reactivation UX (no quantity; no-stock → Inventory
  Intake) before RPC 083 is authored.
