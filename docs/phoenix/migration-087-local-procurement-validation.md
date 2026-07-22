# Migration 087 — institution local procurement: validation

**Nothing applied to production.** Executed on a disposable PostgreSQL 18.4
cluster via `tools/pg-rig` with the chain applied in order (001→084, 086, **087**
— the rig skips the prepared-only 085). Production is untouched until an
operator applies 087 by hand after 001–084 + 086.

```
PHOENIX_RIG_PG=postgres://postgres@127.0.0.1:55432/postgres node -e "… buildRig({ upTo: 87 }) …"
# → REPLAY 001->087 OK — 7 procurement tables, all relrowsecurity=t; 5 local_procurement.* keys
PHOENIX_RIG_PG=postgres://postgres@127.0.0.1:55432/postgres \
  npx vitest run supabase/migrations/__tests__/087-local-procurement.dynamic.test.ts
# → 16 passed
```

## What 087 adds

Institutions purchase locally as well as receiving central supply. 087 models
that end-to-end without ever letting a client write stock:

- `procurement_suppliers` — institution-scoped registry, unique name per org.
- `procurement_orders` + `procurement_order_lines` — purchase order with full
  product/batch/expiry/quantity/unit/price/invoice provenance; lifecycle
  `draft → submitted → approved/rejected → partially_received/received`,
  plus `cancelled` (only before any receipt). Server-owned `order_generation`
  advanced by trigger on every real change (078/086 discipline).
- `procurement_receipts` + `procurement_receipt_lines` — one guarded posting
  event; `request_id` UNIQUE + SHA-256 fingerprint (a replay with different
  content fails closed 23505). Receipt lines land on `warehouse_stock` through
  the 065 lot-identity merge and an append-only `add` movement with
  `reference_type='procurement_receipt_line'`; a partial unique index makes
  double-posting a receipt line structurally impossible.
- `procurement_returns` — supplier return pinned to the ORIGINAL receipt line
  (which pins the order line, the batch-identified lot, the price and the
  invoice); capped at that line's received total, reason-mandatory,
  reservation-safe, `subtract` movement referencing the return row (unique).
- `procurement_order_events` — append-only lifecycle/approval trail.
- Immutability triggers: receipts, receipt lines, returns and events reject
  UPDATE/DELETE even for a superuser session (the ONE sanctioned update is the
  same-transaction NULL→value fill of ledger pointers).
- Permission keys `local_procurement.{view,manage,approve,receive,return}`
  with separation-of-duty role defaults (the officer who composes/receives
  never approves; oversight roles that approve do no data entry), and the RPC
  additionally rejects `submitted_by = approver`.
- RLS: SELECT-only for clients, scoped through
  `phoenix_profile_has_scoped_permission` on the purchasing warehouse
  (org-wide for oversight roles); INSERT/UPDATE/DELETE revoked — every write
  is a SECURITY DEFINER RPC.

## Dynamic proof (16 tests)

Supplier scope + duplicate-name rejection; lifecycle with SoD; empty-draft
submit refusal; line edits close the submit generation; receipts blocked before
approval; partial → `partially_received` → `received` with exact ledger
reconciliation; over-receipt fails closed posting nothing; lost-response retry
idempotent while a changed payload is 23505; cross-device receipt races 40001
(`procurement_order_generation_conflict`) with the genuine retry replaying
clean; returns capped/idempotent/reason-mandatory/reservation-safe with exact
`subtract` movements; foreign-organization actors can neither write nor read;
cancel only before receipts; immutability holds against a superuser.

## Frontend

Screen 19 (Local Procurement): suppliers, order composer, approval queue,
partial/full receiving (held idempotency key, stale-generation reload prompt),
purchase history with official receipts — print, genuine XLSX, QR traceability
via the shared movement document pipeline extended additively with the
`procurement_receipt` kind — and provenance-pinned returns. AR/EN, RTL/LTR,
mobile-friendly; loading/empty/error/offline/denied/stale states; no direct
stock-table writes from React. OCR is deliberately absent from the write path:
an OCR-assisted draft (the `ocr_assisted` provenance flag) still walks
submit → approve → receive like any hand-typed order.
