# Proposal — local procurement provenance

**Status: PROPOSAL ONLY. Blocked. Nothing implemented, no migration created or
applied.**

## The finding

Audited at `f39a968` across migrations 001–077:

| Searched | Result |
|---|---|
| `phoenix_*procure*` / `phoenix_*purchase*` RPC | **0** |
| `*procurement*` / `*purchase*` / `*supplier*` table | **0** |
| Purchase-order / supplier-invoice provenance columns | **0** |
| RLS policy naming a procurement scope | **0** |

The only occurrences of "procurement" in the entire migration set are two
incidental comments (027, 049) describing expiry and batch semantics. They
define nothing.

`supply_type_text` exists on `warehouse_stock`, `warehouse_transfer_lines` and
`warehouse_return_shipment_lines`, but it is a **free-text label**, not a
provenance contract: it has no supplier identity, no purchase-order reference,
no unit-cost basis, no approval chain, and no constraint on its values.

## Why this is a blocker and not an implementation task

There is exactly one plausible shortcut, and it must not be taken: routing local
procurement through the existing `phoenix_receive_warehouse_stock` intake and
tagging it `supply_type_text = 'local purchase'`.

That would be a fake writer. It would:

- record no supplier identity, so the stock could never be traced to who
  supplied it;
- record no purchase order or invoice, so quantity and price could not be
  reconciled against a commitment;
- bypass any approval chain, because none exists to bypass — procurement would
  become the *only* stock inflow with no reviewable authorization step, while
  central→institution supply has create → submit → review → dispatch → receive;
- be indistinguishable at the ledger level from a manual correction, so an audit
  could not separate "bought locally" from "someone typed a number".

The instruction is explicit that generic intake must not be reused and no fake
writer may be implemented. This document is the alternative.

## Proposed additive migration (079+) — for approval, not application

### 1. Supplier registry

```sql
CREATE TABLE public.suppliers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  name             text NOT NULL,
  name_ar          text,
  tax_reference    text,
  status           text NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now()
);
```

### 2. Procurement order and lines

Mirrors the transfer-request shape deliberately, so the lifecycle and its
reviewability are the same shape operators already know:

```sql
CREATE TABLE public.procurement_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  warehouse_id       uuid NOT NULL,          -- receiving warehouse
  supplier_id        uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  order_number       text NOT NULL,          -- see the numbering proposal
  status             text NOT NULL DEFAULT 'draft',
  -- draft -> submitted -> approved -> receiving -> closed | cancelled
  submitted_by uuid, submitted_at timestamptz,
  approved_by  uuid, approved_at  timestamptz,
  created_by   uuid, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.procurement_order_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  procurement_order_id uuid NOT NULL REFERENCES public.procurement_orders(id) ON DELETE CASCADE,
  central_item_id    uuid REFERENCES public.central_items(id) ON DELETE RESTRICT,
  scientific_name    text NOT NULL,
  concentration text, dosage_form text, unit text, national_code text,
  batch_number text, expiry_date date,
  ordered_quantity   integer NOT NULL CHECK (ordered_quantity > 0),
  received_quantity  integer NOT NULL DEFAULT 0,
  unit_price numeric(20,3), currency text, price_basis text,
  CONSTRAINT procurement_line_received_ck
    CHECK (received_quantity >= 0 AND received_quantity <= ordered_quantity)
);
```

### 3. Receipt RPC

`phoenix_receive_procurement_line(p_request_id uuid, p_procurement_order_line_id uuid, p_quantity integer, p_batch_number text, p_expiry_date date, ...)`

- `p_request_id` is an idempotency token, matching the existing send/receive RPCs;
- writes the ledger through the **same** migration-065 movement path that every
  other inflow uses, with `reference_type = 'procurement'` and
  `reference_id = procurement_order_line_id`, so procurement stock is traceable
  to its order rather than appearing as an unattributed adjustment;
- enforces `received_quantity <= ordered_quantity` inside the transaction.

### 4. Authorization

A new scoped permission key (`procurement.receive`, and `procurement.approve`
for the approval step) resolved through migration 062, exactly as
`warehouse_stock.adjust` / `warehouse_stock.correct` already are. No new
authorization mechanism.

### 5. RLS

Per-organization policies mirroring `warehouse_transfer_requests`: a supplier
and its orders are readable only within the owning organization's scope.

## Open questions for the owner

1. Is procurement per **institution**, per **central department**, or both?
2. Must an order be approved before any receipt, or may small purchases be
   received directly? (This decides whether the status machine can be shortened.)
3. Is unit price mandatory, and who may see it? The existing price-permission
   split would apply.
4. Should a procurement receipt be printable as an official document (a fourth
   receipt kind), or is it internal only?

## Until this is approved and applied

The UI must offer **no** local-procurement entry point. There is no honest way
to write that stock, so there is no honest screen to write it from.
