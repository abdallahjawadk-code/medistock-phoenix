# Cutover package — warehouse receipt concurrency (blocker 1)

Everything needed to release migrations 078–080. **Nothing here has been
applied.** The owner applies each step manually, in this order, verifying before
moving on.

Dynamic validation record: `migration-078-079-dynamic-validation.md`.
Defect analysis: `../blocker-migration-065-accumulating-receipt-concurrency.md`.

---

## 1. Manual apply order

| Step | Action | Safe while the current client is live? |
|---|---|---|
| 1 | Preflight SQL (§4) | read-only |
| 2 | Apply **078** — `movement_seq`, trigger, guarded RPCs | **yes** — purely additive |
| 3 | Apply **079** — guarded RPCs reject a NULL generation | **yes** — legacy path untouched |
| 3b | Apply **081** — movement timeline ledger + RPC | **yes** — purely additive, nothing existing altered |
| 4 | Deploy the **guarded client** (already in this PR) | yes |
| 5 | Observe parity (§7) | — |
| 6 | Flip `MIGRATION_065_CONCURRENCY_RESOLVED` to `true` (§6) | yes |
| 7 | Apply **080** — revoke legacy EXECUTE | **NO** — breaks any client still on the legacy names |

Steps 2 and 3 may be applied together. Step 7 must not be reached until step 5
shows no legacy calls.

---

## 2. Migrations

* `supabase/migrations/078_phoenix_warehouse_receipt_expected_generation.sql`
* `supabase/migrations/079_phoenix_warehouse_generation_fail_closed.sql`
* `supabase/migrations/080_phoenix_revoke_unguarded_warehouse_writers.sql`

---

## 3. Signatures and grants, before and after

**Before (live today).** Two functions, one overload each, `SECURITY DEFINER`,
`search_path=public, pg_temp`, owner `postgres`, `EXECUTE` to `authenticated` +
`postgres` + `service_role`:

```
phoenix_receive_warehouse_stock(p_request_id uuid, p_warehouse_id uuid,
  p_scientific_name text, p_quantity integer, p_has_no_national_code boolean,
  p_has_no_batch_number boolean, p_central_item_id uuid, p_trade_name text,
  p_concentration text, p_dosage_form text, p_unit text, p_national_code text,
  p_batch_number text, p_expiry_date date, p_unit_price numeric,
  p_price_basis text, p_currency text, p_supply_type_text text,
  p_source_document_number text, p_notes text) -> jsonb

phoenix_apply_warehouse_stock_movement(p_request_id uuid,
  p_warehouse_stock_id uuid, p_movement_type text, p_amount integer,
  p_reason text, p_source_document_number text, p_notes text) -> jsonb
```

**After 078/079.** Both unchanged and still granted. Two NEW functions, plus one
trigger function, and one new column:

```
phoenix_receive_warehouse_stock_guarded(… , p_expected_generation bigint
  DEFAULT NULL as the 7th parameter, …) -> jsonb          EXECUTE: authenticated
phoenix_apply_warehouse_stock_movement_guarded(p_request_id uuid,
  p_warehouse_stock_id uuid, p_movement_type text, p_amount integer,
  p_reason text, p_expected_generation bigint DEFAULT NULL,
  p_source_document_number text, p_notes text) -> jsonb   EXECUTE: authenticated
phoenix_warehouse_stock_bump_movement_seq() -> trigger    EXECUTE: revoked from PUBLIC

warehouse_stock.movement_seq bigint NOT NULL DEFAULT 0
```

The `DEFAULT NULL` is retained deliberately: it preserves function identity so
079 can `CREATE OR REPLACE` without creating an overload. 079 changes the
**body** to refuse NULL, not the signature.

**After 080.** Identical, except `EXECUTE` on the two bare (unguarded) names is
revoked from `authenticated`. They remain owned by `postgres` and reachable from
the guarded functions via `SECURITY DEFINER`.

---

## 4. Preflight SQL (run before step 2)

```sql
-- a. Migration ledger: expect 77 rows, max '077'.
select count(*) as applied, max(version) as newest
  from supabase_migrations.schema_migrations;

-- b. 078 must not already be applied: expect 0.
select count(*) from information_schema.columns
 where table_schema='public' and table_name='warehouse_stock'
   and column_name='movement_seq';

-- c. Exactly one overload of each legacy writer: expect 1 and 1.
select p.proname, count(*) from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public'
   and p.proname in ('phoenix_receive_warehouse_stock',
                     'phoenix_apply_warehouse_stock_movement')
 group by p.proname;

-- d. BASELINE for reconciliation — record these numbers.
select count(*) as lots,
       coalesce(sum(on_hand_quantity),0)  as on_hand,
       coalesce(sum(reserved_quantity),0) as reserved
  from public.warehouse_stock;
select count(*) as movements from public.warehouse_stock_movements;

-- e. Invalid state that must not exist: all zero.
select count(*) filter (where on_hand_quantity is null)  as null_on_hand,
       count(*) filter (where on_hand_quantity < 0)      as negative_on_hand
  from public.warehouse_stock;
```

Abort if (b) is non-zero, if (c) is anything but 1 and 1, or if (e) is non-zero.

---

## 5. Post-apply reconciliation

Run after 078/079, and again after 080. **All three must be unchanged from the
preflight baseline (d)** — none of these migrations touches ledger data:

```sql
select count(*) as lots,
       coalesce(sum(on_hand_quantity),0)  as on_hand,
       coalesce(sum(reserved_quantity),0) as reserved
  from public.warehouse_stock;
select count(*) as movements from public.warehouse_stock_movements;
select count(*) as null_generations
  from public.warehouse_stock where movement_seq is null;   -- expect 0
```

Structural checks are in each migration's own POST-CONDITIONS section. The
`_guarded` privilege check in 080 is the one that proves the boundary:

```sql
select p.proname,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public'
   and p.proname like 'phoenix_%warehouse_stock%'
 order by 1;
-- after 080: bare names FALSE, *_guarded names TRUE
```

---

## 6. The exact point the safety gate may change

`src/features/inventory/warehouse-intake-safety.ts` →
`MIGRATION_065_CONCURRENCY_RESOLVED`

It is `false` today and a test asserts it. It may become `true` **only when all
of these hold**:

1. **078 and 079 are applied** to the target database (verified by §4b and by
   079's post-condition 3 — a NULL generation is refused).
2. **The guarded client is deployed** — the code in this PR, which calls the
   `_guarded` names and refuses to post without a proven generation.
3. **Parity is observed** (§7): manual intake succeeds through the guarded path,
   and a deliberate two-device attempt produces the reload-and-review message
   rather than a double post.

Flipping it before (1) makes every manual receipt fail with
`expected_generation_required`. Flipping it before (3) re-opens the defect.
Applying **080** before (3) breaks intake outright for any stale client.

---

## 7. Preview verification plan (before production merge)

On a preview/staging database, after 078 + 079:

1. **Single receipt.** Post one manual receipt; confirm on-hand increases by the
   stated amount and `movement_seq` becomes 1.
2. **Two-device race.** Open the intake form in two browser sessions on the same
   batch. Post in one, then post in the other **without reloading**. The second
   must show *"This batch changed while you were entering it — reload and review"*
   and the ledger must show ONE receipt.
3. **Reload and continue.** Reload the second session and post again; it must
   succeed and accumulate. This proves the guard blocks duplicates without
   blocking legitimate work.
4. **Offline/failed read.** Simulate a failed generation read; the client must
   refuse with *"nothing was recorded"* and post nothing.
5. **Legacy still reachable** (pre-080): confirm an old client build still works,
   proving 078/079 are safe under a live deployment.
6. **After 080 only:** repeat (1)–(4), then confirm a direct PostgREST call to
   the bare `phoenix_receive_warehouse_stock` is rejected for an authenticated
   session.

---

## 8. Containment and rollback

**Containment, no schema change** — point the client back at the legacy RPC
names, or set the safety gate to `false`. The guarded functions become inert.
This is the fastest response and works at any stage before 080.

**Rollback 080** — instant and lossless; it changed only privileges:

```sql
GRANT EXECUTE ON FUNCTION public.phoenix_receive_warehouse_stock(
  uuid, uuid, text, integer, boolean, boolean, uuid, text, text, text, text,
  text, text, date, numeric, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_apply_warehouse_stock_movement(
  uuid, uuid, text, integer, text, text, text) TO authenticated;
```

**Rollback 079** — re-apply 078's sections B and C to restore NULL tolerance.
Nothing structural changes, so there is no data to restore.

**Rollback 078** — drop the two guarded functions, the trigger, the trigger
function, then `ALTER TABLE public.warehouse_stock DROP COLUMN movement_seq`.
Full statement list is in 078's own ROLLBACK section. Dropping `movement_seq`
discards only the counter; no quantity, movement or audit row depends on it.

---

## 9. Scope

**Included:** blocker 1 (078/079/080) and blocker 2 (**081**, movement
timeline — additive, may be applied any time after 077; see
`migration-081-timeline-validation.md`).

**Still open:** blocker 3 (inventory-derived availability replacement). It needs
its own migration, which must claim **082+** — 078–081 are taken and the
reviewed-migration registry is the authority.

**Also open, unrelated:** the migration-023 replay gap
(`proposals/dr-repair-migration-023-replay.md`). Production is unaffected; a
fresh 001→latest rebuild is not.

### Upgrading Current Movement Status

The timeline RPC is proven but **not applied**, so it exists in no live
database. Upgrading the screen to consume it must happen in the same change that
turns it on, after 081 is applied — exactly like the 078/079 gate. Upgrading it
before then would break the screen in production.
