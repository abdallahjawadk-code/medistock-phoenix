# Stock lot, provenance & custody audit (live schema)

Read-only audit of the live stock schema and RPCs, done **before** any logic
change (mandate §3/§4/§5/§7). No migration/backend/RLS/RBAC/auth change was made.
Cites migration line numbers as of PR #41 base.

## Canonical material identity & lot-merge key

`phoenix_receive_warehouse_stock` (065) merges an incoming receipt into an
existing `warehouse_stock` row on this exact key (065 lines 409–416):

```
warehouse_id
+ scientific_name
+ COALESCE(concentration,'')
+ COALESCE(dosage_form,'')
+ COALESCE(national_code,'')
+ COALESCE(batch_number,'')
+ COALESCE(expiry_date,'0001-01-01')
+ COALESCE(internal_batch_reference,'')
```

Consequences (all **server-enforced**, matching mandate §3):
- Same material + same batch + expiry + concentration/dosage/national-code →
  **one aggregated lot balance** (`on_hand`/`reserved`/`available`).
- **Different batch or expiry → a separate lot row.** Never merged.
- A same-batch row with a **conflicting** product identity does not match this
  key, so it cannot silently overwrite an existing lot; identity-flag checks
  (`explicit_identity_flags_required`, `*_flag_mismatch`) fail closed.
- Branch warehouses/outlets never *create* received materials: intake is the only
  create path, and transfer receipt (`resulting_warehouse_stock_id`) reuses the
  canonical lot — the receiving side has no material picker/free-text/OCR.

## Per-receipt provenance layers (what IS preserved)

Although the **balance** is aggregated per lot, every receipt remains an
immutable, separately-addressable layer:
- `warehouse_stock_movements` — one row per movement (idempotency-unique index
  `warehouse_stock_movements_request_once_uniq`, 065:209), so a duplicate retry
  UUID **adds no quantity twice**.
- `warehouse_transfer_lines.resulting_warehouse_stock_id` (068/069) — links a
  received transfer line to the lot it credited.
- `outlet_stock_movements.dispatch_line_id` (070) — links an outlet receipt to
  its exact dispatch line.
- 071 outlet-return lines carry BOTH `original_dispatch_line_id`
  (→`warehouse_dispatch_lines.id`, NOT NULL, 071:397) and
  `original_inbound_movement_id` (→`outlet_stock_movements.id`, NOT NULL,
  071:398), with composite FKs (071:439–465) pinning
  (movement, dispatch_line, source_stock, source_org) to one another.

So **single-hop provenance is intact at every corridor**, and the frontend must
render these real links — never invent them.

## Cumulative caps (server-enforced; the UI mirrors, never computes truth)

- Supply send: `remainingToSend = approvedQuantity − cumulativeSuccessfullySent`;
  multiple shipments may fulfil one approved line but cumulative send cannot
  exceed approved (068/077 send RPCs).
- Return: `safeReturnable = min(originalAccepted − cumulativeCompletedReturns −
  activeReservations, currentServerReturnableForThatLot/provenance)` — see
  `src/features/movement/provenance.ts` `computeProvenanceCaps`, which mirrors the
  server cap for display; the RPC is the boundary.
- Receiver stock increases only by the **accepted, server-confirmed** quantity; a
  discrepancy stays a tracked exception (`difference_reason`), never silent.

## Return custody / quarantine (§5) — server-enforced

`warehouse_quarantine_stock` + `warehouse_quarantine_stock_movements` (069, reused
by 071) hold a received return until an authorized disposition. The receive RPCs
take a `disposition_decision`; the three fail-closed reasons
(`RETURN_DISPOSITION_REASONS = near_expiry | excess | shipment_error`) require an
explicit decision, and expired/damaged/recalled/temperature-excursion returns are
fail-closed. A received return therefore **does not become available stock** until
disposition verifies it. The frontend must present `custody_state`/`disposition`
and must never treat a quarantined return as available.

## §4 multi-hop provenance — GENUINE BACKEND BLOCKER

The chain is traceable **hop-by-hop to the adjacent aggregated lot**, but the
institution→outlet dispatch (`phoenix_add_dispatch_line`, 070:719/781) draws from
the **aggregated** `warehouse_stock_id` (merged by the lot-key across *many*
central→institution receipts). There is **no allocation record** tying a specific
outlet dispatch back to the specific central→institution receipt line that
supplied those exact units.

Therefore the full chain
`central intake → central lot → central→institution line → institution receipt
layer → institution→outlet line → outlet receipt → outlet return → institution
return receipt` **cannot be reconstructed** across the aggregation boundary from
the existing schema.

Per mandate §4 this is not simulated in React. The additive fix is proposed in
[`proposals/multi-hop-transfer-allocation.md`](proposals/multi-hop-transfer-allocation.md)
and **nothing is applied**. Single-hop corridor provenance (070/071) is intact and
safe to implement now.
