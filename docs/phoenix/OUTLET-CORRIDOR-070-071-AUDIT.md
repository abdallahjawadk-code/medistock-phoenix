# Outlet corridor audit — migrations 070 (dispatch) & 071 (return)

**Scope:** the institution-warehouse → outlet dispatch corridor (070) and the
outlet → institution-warehouse return corridor (071), plus every existing outlet
action that could touch stock. Read-only audit; **no** migration, backend, RLS,
RBAC, auth or production change was made. Classification per action:
`safe | conflicting | missing | unreachable`.

## Method

- Enumerated the 070/071 write contracts from the migration SQL.
- Grepped the entire `src/` tree for any frontend reference to those RPCs or their
  tables (`warehouse_dispatch*`, `outlet_return*`).
- Traced every existing outlet-facing write in the app to its service and RPC.

## Headline finding

**The 070 and 071 corridors are backend-only. No frontend service wraps them and
no screen mounts them.** The only `src/` references to the dispatch/return RPCs
are in the authorization **permission catalog** (`shared/authz/scoped-permissions.ts`)
and its **tests** — never in a service call or a component. So the corridors are
**MISSING (frontend)**, not *conflicting*: there is no client writer to correct,
because none was ever built.

Corollary for safety §8 (outlet must never overwrite a stock balance): because no
outlet stock UI exists at all, **there is no unsafe direct-balance editor to remove.**
The only outlet-facing editor in the app writes `item_availability`, which is
informational reporting (inventory rule 7) and cannot change ledger stock — see
below.

## 070 — institution warehouse → outlet dispatch

| Backend contract (exists) | Frontend service | UI | Status |
|---|---|---|---|
| `phoenix_create_warehouse_dispatch` | — | — | **missing** |
| `phoenix_add_dispatch_line` | — | — | **missing** |
| `phoenix_update_dispatch_line_quantity` | — | — | **missing** |
| `phoenix_delete_dispatch_line` | — | — | **missing** |
| `phoenix_send_warehouse_dispatch` | — | — | **missing** |
| `phoenix_receive_outlet_dispatch_line` | — | — | **missing** |
| `phoenix_cancel_warehouse_dispatch` | — | — | **missing** |

The RPCs enforce: outlet must belong to the same institution and permitted scope;
canonical institution-warehouse batches only; cannot dispatch more than
server-confirmed available; request/review/send lifecycle; receiver stock changes
only after server-confirmed receipt. **All server guarantees are in place; only the
UI is absent.**

## 071 — outlet → institution warehouse return

| Backend contract (exists) | Frontend service | UI | Status |
|---|---|---|---|
| `phoenix_request_outlet_return` | — | — | **missing** |
| `phoenix_add_outlet_return_request_line` | — | — | **missing** |
| `phoenix_submit_outlet_return_request` | — | — | **missing** |
| `phoenix_review_outlet_return_request` | — | — | **missing** |
| `phoenix_send_outlet_return_shipment_line` | — | — | **missing** |
| `phoenix_receive_outlet_return_shipment_line` | — | — | **missing** |
| `phoenix_recall_outlet_stock` | — | — | **missing** |
| `phoenix_cancel_outlet_return_request` | — | — | **missing** |

The RPCs enforce provenance (`original_transfer_line_id` NOT NULL), safe-returnable
caps, and the request → review → send → parent-warehouse-receipt lifecycle.

## Existing outlet-facing writes (what DOES exist today)

| UI | Service → RPC | Table | Stock effect | Status |
|---|---|---|---|---|
| Availability editor (`EditorScreen`) create | `availability.service` → `phoenix_upsert_availability` (030) | `item_availability` | none — informational only (rule 7) | **safe** |
| Availability existing-row quantity change | routed to Status Center → `phoenix_apply_availability_movement` (034) | `item_availability` | none — informational only | **safe** (silent-overwrite guarded: `quantity-overwrite-guard.test.ts`) |
| Inventory Center (ledger 065) | canonical ledger RPCs | `warehouse_stock` ledger | server-derived | **safe** (see Inventory Center milestone; the two legacy writers noted there are institution-side, not outlet) |

No frontend performs a direct `warehouse_stock` INSERT/UPDATE/DELETE for an outlet,
and `network-no-parallel-stock-writer.test.ts` pins that no parallel stock writer
exists in the network layer.

## Conclusion & recommended next step

- **Nothing to correct now.** There is no conflicting or unsafe outlet writer; the
  corridors are simply unbuilt on the client.
- **Next major slice (net-new, additive):** build a `dispatch.service.ts` /
  `outlet-return.service.ts` thin RPC client over 070/071 (mirroring
  `network.service.ts`), then mount the officer-facing dispatch composer and the
  outlet receive/return surfaces — reusing the movement composer primitives already
  in `features/movement/` (draft-first authoring, provenance picker, receive-model,
  receipt/XLSX/QR). The authoritative hierarchy stays central → institution
  warehouse → outlet; no central→outlet shortcut is exposed even though a generic
  backend call might technically accept one.
- This is feature work, not a safety fix, so it is out of scope for the current
  reconciliation PR and does not block it.
