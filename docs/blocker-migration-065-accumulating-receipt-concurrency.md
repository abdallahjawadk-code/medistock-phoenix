# BLOCKER — migration-065 accumulating-receipt cross-device concurrency

Status: **OPEN — HARD PRE-DEPLOYMENT BLOCKER. Server contract AUTHORED, NOT APPLIED.**

> **Where this stands.** Migration
> `078_phoenix_warehouse_receipt_expected_generation.sql` implements the §2
> contract and the client is wired to it (commit `0a77830`). The blocker stays
> OPEN because **078 has not been applied to any database** — this repository
> never applies migrations automatically; the owner applies them manually after
> review.
>
> `MIGRATION_065_CONCURRENCY_RESOLVED` therefore remains `false`, asserted by a
> test. Flip it only after BOTH: 078 is applied, and the guarded path is
> observed working in a real environment.
>
> The delivered design differs from §2 in two deliberate ways, each argued in
> the migration header:
> * the generation advances via a **trigger**, not by editing each RPC body, so
>   it advances for every writer — including the legacy RPCs that stay callable
>   during the parity window — and cannot be forgotten by a later RPC author;
> * the precondition lives in **new, distinctly-named guarded RPCs** that
>   delegate to the 065 originals, because adding a parameter to an existing
>   PostgreSQL function creates a second overload instead of replacing it.

Owner path: `src/features/inventory/warehouse-intake.service.ts`
(`receiveWarehouseStock`, additive `applyWarehouseStockMovement`).
Gate: `src/features/inventory/warehouse-intake-safety.ts`.

The manual warehouse accumulating-receipt path **must not be enabled in a
production build** until the server change below lands. The gate enforces this
by folding to `false` in a production build; the fail-closed refusal is proven
by `src/features/inventory/__tests__/warehouse-intake-safety.test.ts`.

Do **not** flip `MIGRATION_065_CONCURRENCY_RESOLVED` to `true`, and do **not**
merge or deploy PR #41, while this document reads OPEN.

---

## 1. The defect

`phoenix_receive_warehouse_stock` (migration `065`) posts an **additive**
receipt: the caller states `p_quantity` that physically moved, and the ledger
appends it to the batch's on-hand. Its only idempotency guard is
`p_request_id`:

- replaying the **same** `p_request_id` → returns the original result
  (`idempotent_replay: true`);
- replaying the **same** `p_request_id` with **different** arguments →
  `RAISE request_id_conflict` (23505).

That guard makes a **single client's own retry** safe. It does nothing about two
**independent** submissions of the **same physical receipt**, because each mints
its own `p_request_id` (`newRequestId()` → `crypto.randomUUID()`), so the ids
never collide:

| step | device A | device B | ledger on-hand |
|------|----------|----------|----------------|
| read | batch = 0 | batch = 0 | 0 |
| post | +30 (req R_A) | | 30 |
| post | | +30 (req R_B ≠ R_A) | **60** |

Sixty units are recorded for a thirty-unit delivery, and **no error is ever
shown**. A silent wrong balance in a pharmaceutical ledger is worse than a
visible rejection.

The additive receipt has **no natural upper bound** the server can check —
unlike the `070`/`071` line receives, whose target line carries a
`pending → decided` status the RPC enforces (`dispatch_line_already_decided`,
`return_shipment_line_already_received`). The accumulating receipt has no
equivalent per-target precondition, so the double-post is invisible. The
additive modes of `phoenix_apply_warehouse_stock_movement` (`add`, and
`correction` when it increases on-hand) share the identical gap.

This **cannot be closed on the client** across devices or reloads: two clients
that never see each other cannot coordinate a token. The server must adjudicate.

---

## 2. Required server solution — expected-generation precondition

Add optimistic concurrency to the accumulating-receipt RPCs. Requires explicit
approval to apply (migration change).

### 2.1 A server-owned per-batch generation

Give each `warehouse_stock` batch a monotonic generation the server alone
advances, incremented in the **same statement** as every posted movement:

```sql
ALTER TABLE public.warehouse_stock
  ADD COLUMN movement_seq bigint NOT NULL DEFAULT 0;
```

Every movement-posting path (`phoenix_receive_warehouse_stock`,
`phoenix_apply_warehouse_stock_movement`) does, under the existing per-request
advisory lock and after `SELECT ... FOR UPDATE` of the batch:

```sql
UPDATE public.warehouse_stock
   SET on_hand_quantity = on_hand_quantity + v_delta,
       movement_seq     = movement_seq + 1
 WHERE id = v_stock.id;
```

(If a new column is undesirable, `on_hand_quantity` itself can serve as the
generation — it is already monotonic for pure receipts — but a dedicated
`movement_seq` also covers corrections that leave on-hand unchanged.)

### 2.2 An optional expected-generation parameter

```sql
-- new trailing parameter, defaulted so existing callers are unaffected
p_expected_generation bigint DEFAULT NULL
```

Under the advisory lock, after resolving/locking the target batch and **after**
the existing `p_request_id` replay check (so a genuine retry still short-circuits
to `idempotent_replay`):

```sql
IF p_expected_generation IS NOT NULL
   AND v_stock.movement_seq IS DISTINCT FROM p_expected_generation THEN
  RAISE EXCEPTION 'warehouse_receipt_generation_conflict'
    USING ERRCODE = '40001';   -- serialization_failure: client must reload + re-confirm
END IF;
```

Semantics:

- A **brand-new** batch has generation `0`. Two concurrent "new batch" posts
  both read `0`; the advisory lock serializes them; the first commits and
  advances to `1`; the second, still carrying expected `0`, now sees `1` under
  the lock → **conflict**, not a second post.
- A genuine **retry** of the first post replays the same `p_request_id` and is
  short-circuited before the generation check ever runs — retries stay safe.
- A genuine **later** receipt into the same batch is a NEW submission that first
  reads the current generation and passes it as `p_expected_generation`, so it
  is accepted and advances the generation again.

### 2.3 Client wiring (already prepared)

The client already carries the exact value needed: the derived idempotency
token's `generation` axis (`src/shared/lib/operation-token.ts`) is a canonical
server-read progress measure. On resolution, `warehouse-intake.service.ts`
passes the batch's last canonically-read `movement_seq` as
`p_expected_generation`, and `classifyIntakeError` maps
`warehouse_receipt_generation_conflict` → a "reload and re-confirm" message.

---

## 3. Resolution checklist

1. Land the migration in §2 (new migration file; do **not** edit `065` in place —
   see `docs/manual-supabase-migrations.md`).
2. Thread `expectedGeneration` through `receiveWarehouseStock` /
   `applyWarehouseStockMovement` and add the `warehouse_receipt_generation_conflict`
   case to `classifyIntakeError` (+ AR/EN string).
3. Add a behavioral test: two concurrent different-request receipts against one
   batch → exactly one commits, the second raises the conflict.
4. In the **same commit** as (1), set `MIGRATION_065_CONCURRENCY_RESOLVED = true`.
5. Update this document's status to CLOSED with the resolving migration + commit.
