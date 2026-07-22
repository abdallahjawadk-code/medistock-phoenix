# Proposal (NOT APPLIED): transfer-allocation / stock-layer model for multi-hop provenance

**Status:** proposal only. Additive. Blocks exactly one sub-feature (full
end-to-end multi-hop provenance / FEFO-correct outlet-return-to-central
attribution). It does **not** block the single-hop 070/071 corridors, which have
intact provenance and are safe to implement now.

## The gap (see STOCK-LOT-PROVENANCE-AUDIT.md)

`warehouse_stock` aggregates receipts into one balance per lot-key. The
institution→outlet dispatch line references that **aggregated** `warehouse_stock_id`,
so units dispatched to an outlet cannot be attributed to the **specific**
central→institution receipt (or its price/supply-type/original central lot) that
supplied them. The same is true for any hop that consumes an aggregated lot.

Reconstructing this in the client would require guessing an allocation
(FIFO/FEFO) that the ledger never recorded — which would be **fabricated
provenance**. That is explicitly forbidden.

## Proposed additive model (no existing column/constraint changed)

1. **`stock_layers`** — one immutable row per inbound credit to a lot:
   `id, warehouse_stock_id, source_kind (intake|transfer_receive|dispatch_receive|
   return_receive), source_reference_id (the transfer/dispatch/return line or
   intake movement), original_quantity, remaining_quantity, unit_cost, currency,
   received_at`. `remaining_quantity` is decremented as the layer is consumed.

2. **`stock_consumptions`** — one row per outbound allocation:
   `id, stock_layer_id, consumer_kind (transfer_send|dispatch_send|return_send|
   dispense|adjustment), consumer_reference_id, quantity, allocated_at`. The sum
   of consumptions against a layer never exceeds its `original_quantity`.

3. **Allocation is server-side and deterministic** (FEFO by layer `expiry_date`
   then `received_at`), performed inside the existing SEND RPCs in the same
   transaction that writes the movement, behind an additive
   `SECURITY DEFINER` function. No client input chooses the layer.

4. **Read view `v_provenance_chain`** — recursively walks
   `stock_consumptions → stock_layers → source_reference` to yield the full chain
   for any movement, which the Movement Tracking timeline can render truthfully.

## Migration/RLS/RBAC notes

- Purely additive tables + one function + one view; no change to 001–077.
- RLS mirrors the owning `warehouse_stock` row's policies (org/warehouse scope).
- Backfill is optional and best-effort; absence of a layer row degrades the
  timeline to the existing single-hop links, never to a fabricated chain.

## Until this is approved and applied

- The Movement Tracking timeline shows the **real single-hop links** only
  (adjacent layer), and states plainly where the aggregation boundary ends the
  precise chain — it never interpolates an allocation.
- All 070/071 lifecycle, receipts, XLSX, QR and single-hop tracking proceed
  normally.
