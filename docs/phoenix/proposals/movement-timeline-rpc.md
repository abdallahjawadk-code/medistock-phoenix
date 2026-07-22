# Proposal — unified server-authoritative movement-timeline RPC

Status: **PROPOSAL ONLY — not applied.** Requires an additive migration and
explicit approval. Out of scope for the current PR (#41), which keeps migration
065 a hard pre-deployment blocker and touches no migration / RPC / RLS.

## Problem

A receipt QR encodes the canonical document UUID (`phxmv:1:<code>:<uuid>`, see
`src/features/movement/movement-trace.ts`). Scanning it should show the document's
**complete, ordered, cross-lifecycle history** — request created → submitted →
reviewed → shipped → received → disposition → any correction.

That history does not live in one queryable place. The events are spread across
`outlet_return_requests`, `outlet_return_request_lines`, `outlet_return_shipments`,
`outlet_return_shipment_lines`, `warehouse_stock_movements`,
`warehouse_quarantine_stock_movements`, `outlet_stock_movements`, and the
equivalent direct-corridor tables. Stitching a correct, complete, non-leaky
timeline across them **on the client** is fragile (missed joins read as "nothing
happened") and duplicates authorization logic.

The current shipped surface (`CurrentMovementStatus`,
`src/features/outlet/movement-status.ts`) deliberately shows only the **current
status** of one document via existing RLS-scoped reads, and says so plainly. The
full timeline needs a server-authoritative RPC.

## Proposed RPC

```
phoenix_movement_timeline(
  p_kind text,     -- 'supply_request' | 'supply_dispatch' | 'return_request' | 'return_shipment'
  p_id   uuid      -- the canonical trace key
) RETURNS jsonb
```

`SECURITY DEFINER`, `SET search_path = public, pg_temp`. Called through the anon
client with the caller's JWT, exactly like the existing scoped RPCs.

### Authorization / RLS behaviour (the load-bearing part)

- Resolve the anchor row (by `p_kind`, `p_id`) and derive its
  `organization_id` + warehouse/outlet target **from the row, never from the
  caller**.
- Gate on the SAME scoped permission the corresponding read/receive path already
  checks, via `phoenix_profile_has_scoped_permission`:
  - return_shipment / return_request → `outlet_stock.return_receive` (or a new
    read-only `movement.trace_view`) on the destination warehouse;
  - supply_* → the direct-corridor read permission on the relevant warehouse.
- **Fail closed and INDISTINGUISHABLY:** if the anchor row does not exist OR the
  caller is not authorized, return the identical empty/`not_available` result.
  The RPC must never let a caller distinguish "no such id" from "not yours" — the
  same guarantee the client resolver already enforces. No count, no error code
  that reveals existence.
- No branch may widen scope for a role name; super_admin is the only global
  reader and only because every other RPC already treats it so.

### Normalized immutable events

Return an **append-only, ordered** event list — never editable rows:

```jsonc
{
  "ok": true,
  "kind": "return_shipment",
  "trace_key": "…uuid…",
  "external_reference": "SHP-7",     // operator text, labelled non-canonical
  "current_status": "received_with_difference",
  "events": [
    {
      "seq": 1,
      "at": "2026-07-01T10:00:00Z",  // server timestamp, immutable
      "type": "return_requested",     // controlled vocabulary, stable codes
      "actor_name": null,             // only when RLS legitimately exposes it
      "actor_role": null,
      "line_ref": null,               // null = header event
      "quantity": null,
      "disposition": null,
      "custody_state": null,
      "reason": null,
      "provenance": null              // original_dispatch_line_id where relevant
    }
    // … shipped, received (per line), disposition, correction …
  ]
}
```

Rules:
- Events are **derived from immutable movement rows** (the `*_movements` tables
  are already append-only) plus status-transition timestamps; the RPC composes
  them, it does not store a second copy.
- Ordering is `(at, seq)` with a deterministic tiebreak, so concurrent inserts
  render in a stable order.
- Event `type` is a closed vocabulary mirrored in an i18n map; the client renders
  labels, never raw codes.
- Prices and any field behind `reports.financial` are omitted unless the caller
  holds that scoped permission — the timeline honours the same field-level gates
  as the receipt field selector.

## Client wiring once it lands

- `movement-status.ts` gains a `resolveMovementTimeline(target, deps)` that calls
  the RPC; `CurrentMovementStatus` grows a timeline section and drops the
  "timeline unavailable" note.
- The generic not-available result and all loading/empty/error/offline/stale
  states already exist and are reused unchanged.

## Out of scope / dependencies

- Additive migration only; never edit a shipped migration in place
  (see `docs/manual-supabase-migrations.md`).
- Independent of, and does not resolve, the migration-065 expected-generation
  blocker (`docs/blocker-migration-065-accumulating-receipt-concurrency.md`).
- Sequential human-readable document numbers remain a separate proposal
  (`sequential-document-numbers.md`); the timeline keys on the UUID regardless.
