# Proposal — atomic sequential document numbers

**Status: PROPOSAL ONLY. Not created, not applied, not approved.**
No migration file exists for this. Nothing in this document has touched the
database. It is written so the numbering gap is recorded precisely rather than
papered over in the frontend.

## The finding

Audited at `54f77e0` across migrations 001–077:

```
CREATE SEQUENCE / nextval( / GENERATED … AS IDENTITY   → 0 matches
UNIQUE on request_number | transfer_number
        | return_number  | shipment_number             → 0 matches
```

All four columns are plain `text NOT NULL`, populated from client-supplied RPC
parameters:

| Column | Table | Supplied by |
|---|---|---|
| `request_number` | `warehouse_transfer_requests` | `p_request_number` |
| `transfer_number` | `warehouse_transfers` | `p_transfer_number` |
| `return_number` | `warehouse_return_requests` | `p_return_number` |
| `shipment_number` | `warehouse_return_shipments` | `p_shipment_number` |

There is **no atomic server-side allocator and no uniqueness constraint**. Two
operators can independently type `2026-001` and both will be stored.

## What the frontend does about it, today

It does **not** fake a serial. Specifically, the composer never uses
`MAX(number)+1`, a row count, `Date.now()`, a random number, `localStorage`, or
any client-side counter — all of which are unsafe under concurrent operators and
would look authoritative while being wrong.

Instead:

- the immutable `uuid` primary key **is** the canonical trace key. It is what
  the receipt prints, what the QR encodes, and what tracking resolves;
- any operator-typed number is labelled **"External / operator reference"**
  (`mv_external_reference`) everywhere it appears, with the hint that it is not
  an official serial;
- `buildMovementQrPayload()` throws on a non-uuid, so a typed number cannot
  become the trace key even by accident.

**The human-readable sequential number requirement is therefore NOT complete,
and this is the only reason.**

## Proposed additive migration (078) — for approval, not application

### 1. Allocation table

```sql
CREATE TABLE public.document_number_sequences (
  document_kind   text NOT NULL,
  issuing_scope   uuid NOT NULL,   -- organization_id; agreed scope, see Q1
  period_year     integer NOT NULL,
  last_value      bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_kind, issuing_scope, period_year),
  CONSTRAINT document_number_kind_ck
    CHECK (document_kind IN ('supply_request','supply_dispatch',
                             'return_request','return_shipment'))
);
```

### 2. Atomic allocator

Concurrency safety rests on `INSERT … ON CONFLICT DO UPDATE … RETURNING`, which
takes a row lock and is atomic under concurrent callers. No `SELECT max()`.

```sql
CREATE OR REPLACE FUNCTION public.phoenix_allocate_document_number(
  p_document_kind text,
  p_issuing_scope uuid,
  p_period_year   integer DEFAULT EXTRACT(year FROM now())::integer
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_next bigint; v_prefix text;
BEGIN
  v_prefix := CASE p_document_kind
    WHEN 'supply_request'  THEN 'SUP-REQ'
    WHEN 'supply_dispatch' THEN 'SUP-DSP'
    WHEN 'return_request'  THEN 'RET-REQ'
    WHEN 'return_shipment' THEN 'RET-SHP'
    ELSE NULL END;
  IF v_prefix IS NULL THEN RAISE EXCEPTION 'unknown document kind %', p_document_kind; END IF;

  INSERT INTO public.document_number_sequences AS s
        (document_kind, issuing_scope, period_year, last_value)
  VALUES (p_document_kind, p_issuing_scope, p_period_year, 1)
  ON CONFLICT (document_kind, issuing_scope, period_year)
  DO UPDATE SET last_value = s.last_value + 1, updated_at = now()
  RETURNING last_value INTO v_next;

  RETURN format('%s-%s-%s', v_prefix, p_period_year, lpad(v_next::text, 6, '0'));
END $$;
```

Display formats: `SUP-REQ-2026-000001`, `SUP-DSP-2026-000001`,
`RET-REQ-2026-000001`, `RET-SHP-2026-000001`.

### 3. Uniqueness

Added as `NOT VALID` first, then validated, so a deploy cannot fail on
pre-existing duplicates:

```sql
ALTER TABLE public.warehouse_transfer_requests
  ADD CONSTRAINT warehouse_transfer_requests_number_uk
  UNIQUE (source_organization_id, request_number);
-- and the equivalent for transfers / return requests / return shipments
```

### 4. UUID mapping

The `uuid` PK remains the canonical internal key. The allocated serial is a
*display* identifier mapped 1:1 onto it. Receipts print both; the QR keeps
encoding only the uuid, so a re-numbering could never orphan a printed code.

### 5. Concurrency and retry behaviour

- Allocation happens **inside** the same transaction as the row it numbers, so a
  rolled-back create consumes no number.
- Gaps are acceptable and expected; a gap is not evidence of a lost document.
- The existing send RPCs keep their `p_request_id` idempotency token. A retried
  send must reuse the number already allocated to that token, never allocate a
  second one.
- Backfill of existing rows is **out of scope** — historical operator-typed
  values stay as external references.

## Open questions for the owner

1. **Issuing scope** — per organization, per warehouse, or global? The table is
   keyed on it, so this must be decided before the migration is written.
2. **Period reset** — reset yearly (as drafted) or run continuously?
3. **Existing rows** — leave historical numbers untouched (recommended), or
   backfill?
4. Should the operator still be able to record their own external reference
   alongside the allocated serial? (Recommended: yes — they are different
   things, and paper documents from suppliers carry their own numbers.)

## Required before this could be called done

- rollback script and a post-condition VERIFY block, matching the house style of
  migrations 060–077;
- a concurrency test proving N parallel allocations yield N distinct numbers
  with no duplicates;
- a test proving no client-side sequence logic exists anywhere in `src/`;
- confirmation that no existing guard test is weakened or deleted.
