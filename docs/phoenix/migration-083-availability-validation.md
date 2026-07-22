# Migration 083 — inventory-derived availability: audit and dynamic validation

**Nothing was applied to the production database.** Migration 083 was executed
on a disposable PostgreSQL 18.4 cluster with **001→083 applied in filename
order** via `tools/pg-rig`, and exercised by driving the **real** stock and
lifecycle RPCs and then reading `phoenix_available_stock` /
`phoenix_movement_timeline`. Production is 17.6 — the same major-version gap
documented for the 078/079/081/082 rigs applies here; nothing in 083 depends on
an 18-only feature.

Reproduce:

```
# a throwaway cluster on a spare port (initdb/pg_ctl), then:
PHOENIX_RIG_PG=postgres://postgres@localhost:55432/postgres \
  node tools/pg-rig/apply.mjs 83
# → OK — chain applied through 83 in ~5s; public functions: 208

PHOENIX_RIG_PG=postgres://postgres@localhost:55432/postgres \
  npx vitest run supabase/migrations/__tests__/083-availability-projection.dynamic.test.ts
# → 7 passed

PHOENIX_RIG_PG=postgres://postgres@localhost:55432/postgres \
  npx vitest run supabase/migrations/__tests__/082-all-corridors.dynamic.test.ts
# → 6 passed  (the sixth corridor, outlet_return_shipments, is unblocked by 083 Part A)
```

---

## The audit that shaped the design (Blocker 3)

`item_availability` is a projection cache, but until 083 it was still an
**independently writable quantity** for institution/port rows — a second source
of stock truth alongside the canonical `outlet_stock` / `warehouse_stock`
ledgers. Two concrete facts drove the design:

1. **A latent projection-writer defect.** Migration 067's
   `phoenix_project_outlet_availability` upserts into `item_availability` with a
   **7-column** `ON CONFLICT`, but the live identity index created in 061 is
   **8-column** — it carries `COALESCE(internal_batch_reference,'')`. A 7-column
   `ON CONFLICT` cannot infer an 8-column index, so PostgreSQL raises
   *"no unique or exclusion constraint matching the ON CONFLICT specification"*
   on **every** call. This is latent in production only because the outlet
   corridor is not yet mounted; it aborts the instant an outlet dispatch is
   received. It is exactly why the sixth movement-timeline corridor
   (`outlet_return_shipments`, whose send path calls this writer) had to be
   deferred in `082-all-corridors.dynamic.test.ts`.

2. **No server-authoritative read.** Consumers read
   `item_availability.quantity` directly, so a stale or hand-edited cache row was
   indistinguishable from real stock.

---

## What 083 does

**Part A — repair the outlet projection writer.** `CREATE OR REPLACE` of
`phoenix_project_outlet_availability` with the SUM and the `ON CONFLICT` aligned
to the real 8-column identity (adding `internal_batch_reference`). Because
`outlet_stock`'s own identity is also 8-column, each projected row maps 1:1, so
the SUM is exact and cannot double count. Still server-only — no client role
holds `EXECUTE`. Nothing is dropped.

**Part B — `phoenix_available_stock(distribution_point_id)`.** A `STABLE`,
`SECURITY DEFINER`, search-path-pinned, read-only projection derived **only**
from canonical `outlet_stock`. It aggregates every batch/lot without double
counting, excludes expired/missing quantity from `usable_quantity`, and derives
`condition` through the same audited 067 policy
(`phoenix_derive_outlet_availability_condition`). RLS-scoped: `super_admin` or
same-org only; **forbidden and nonexistent both return the same empty result**,
so the RPC never reveals that an off-scope point exists. Independent of
catalogue visibility (053's `removed_at`) — physical availability stands whether
or not a catalogue row is hidden. Least-granted: revoked from `PUBLIC`,
`EXECUTE` to `authenticated` only, never `anon`.

`item_availability` is **not** dropped and **not** made read-only here. It
remains a compatibility cache; this RPC is the new authority a consumer reads
instead of trusting `item_availability.quantity`. The parity-gated revoke of the
manual availability writers is a **separate, later** migration.

---

## Dynamic results (real RPCs on the rig)

`083-availability-projection.dynamic.test.ts` — **7/7**:

| Case | Proven |
| --- | --- |
| zero stock | an empty outlet projects `items: []` with `source: canonical_projection` |
| one usable batch | exact quantity (30) and audited condition (`available`) |
| multiple batches | aggregate without double counting; reserved netted out (BB 20−5=15); expired lot → `usable 0`, `is_usable false`; material total usable = 45, each lot counted once |
| repeated receipt | a second receipt of the same batch accumulates into **one** lot, counted once (35) |
| catalogue visibility | a hidden/removed `item_availability` row does **not** change the physical projection (BV still 12) |
| forbidden scope | a foreign org sees the **same** empty result as a nonexistent point |
| real dispatch→receive chain | after a real `receive → dispatch → send → receive_outlet_dispatch_line`, the projection reports the real received quantity (25), derived from `outlet_stock` — never a manual write. This path exercises the Part A repair. |

`082-all-corridors.dynamic.test.ts` — **6/6**, the sixth corridor
(`outlet_return_shipments`) now driving the full
`dispatch → outlet-receive → outlet-return → send-shipment` chain. The send
mutates `outlet_stock` and calls the Part A-repaired projection writer; the
shipment header's transition is captured in `phoenix_movement_events`
(`reference_type = outlet_return_shipments`, actor-attributed, org-scoped) and
surfaces through `phoenix_movement_timeline` with `provenance = event_ledger`
and `complete = false`. `phoenix_available_stock` then reports the **net**
physical stock (40 received − 15 returned = 25), proving Parts A and B together.

Static contract: `083-availability-projection.test.ts` — **20/20**.

---

## Post-conditions checked after apply (read-only)

```sql
-- least-granted, pinned read projection
SELECT prosecdef, provolatile, proconfig FROM pg_proc WHERE proname='phoenix_available_stock';
-- prosecdef=t, provolatile='s', {search_path=public,pg_temp}
SELECT has_function_privilege('authenticated','public.phoenix_available_stock(uuid)','EXECUTE'); -- t
SELECT has_function_privilege('anon','public.phoenix_available_stock(uuid)','EXECUTE');          -- f
-- repaired writer holds no client EXECUTE
SELECT has_function_privilege('authenticated','public.phoenix_project_outlet_availability(uuid)','EXECUTE'); -- f
```
