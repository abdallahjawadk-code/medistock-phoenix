-- ============================================================================
-- WAREHOUSE-RECEIPT-OFFICIAL-NUMBER-090   ***PREPARED - DO NOT APPLY***
--
-- MANUAL APPLY ONLY (SQL Editor), after owner review, AFTER 089. Never via
-- `supabase db push`. Replayed 001->090 on the disposable rig.
--
-- WHY
-- Every OTHER canonical stock document already carries an official,
-- server-generated human-readable number: dispatch (document_number), outlet
-- returns (shipment_number), inter-warehouse transfers, and local/direct
-- procurement (PR-/SP-). The one approved intake that had only its permanent
-- movement UUID was the DIRECT warehouse-department receipt / adjustment
-- (065's warehouse_stock_movements). This migration gives those movements an
-- official number too, so a printable receipt exists for every approved
-- pharmacy-department intake — WITHOUT a duplicate write path: the number is
-- stamped, additively, onto the movement the 065 poster already creates.
--
-- CONTRACT
--   * new nullable column warehouse_stock_movements.official_number;
--   * a BEFORE INSERT trigger allocates 'WR-YYYY-nnnnnn' (receipt) or
--     'WA-YYYY-nnnnnn' (adjustment) from a server-owned sequence — clients
--     cannot set or guess it (the column is not in any client insert, and the
--     sequence is revoked from all client roles);
--   * the external/source document reference is preserved AS-IS and is NOT
--     treated as unique — the official number is the authoritative key, the
--     movement UUID is the permanent trace key, both linkable to the external
--     ref when present;
--   * existing dispatch/return/procurement identifiers are untouched — no new
--     or duplicate document path is created.
--
-- PRECONDITIONS: 060/065 applied (warehouse_stock_movements exists).
-- FORWARD-ONLY. Backfill of pre-existing rows is unnecessary in production
-- (all movement counts are 0 at cutover) and is intentionally omitted.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.warehouse_stock_movements') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 060/065 not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='warehouse_stock_movements'
                AND column_name='official_number') THEN
    RAISE EXCEPTION 'precondition failed: 090 already applied';
  END IF;
END;
$precond$;

ALTER TABLE public.warehouse_stock_movements
  ADD COLUMN official_number text;

-- Unique when present; NULLs allowed (a legacy row, or a movement kind we do
-- not number).
CREATE UNIQUE INDEX warehouse_stock_movements_official_number_uniq
  ON public.warehouse_stock_movements (official_number)
  WHERE official_number IS NOT NULL;

CREATE SEQUENCE public.warehouse_receipt_number_seq;
REVOKE ALL ON SEQUENCE public.warehouse_receipt_number_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_stamp_warehouse_official_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $stamp$
DECLARE
  v_prefix text;
BEGIN
  -- Stamp only when a client/RPC did not (cannot) supply one, and only for the
  -- receipt/adjustment movements this contract numbers.
  IF NEW.official_number IS NOT NULL THEN
    RETURN NEW;  -- an idempotent replay re-inserting the same row keeps its number
  END IF;
  v_prefix := CASE
    WHEN NEW.reference_type = 'warehouse_request' THEN 'WR'
    WHEN NEW.movement_type IN ('add', 'subtract', 'correction', 'set_exact') THEN 'WA'
    ELSE NULL
  END;
  IF v_prefix IS NOT NULL THEN
    NEW.official_number := v_prefix || '-' || to_char(now(), 'YYYY') || '-' ||
      lpad(nextval('public.warehouse_receipt_number_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$stamp$;

REVOKE ALL ON FUNCTION public.phoenix_stamp_warehouse_official_number() FROM PUBLIC;

DROP TRIGGER IF EXISTS warehouse_stock_movements_stamp_official ON public.warehouse_stock_movements;
CREATE TRIGGER warehouse_stock_movements_stamp_official
  BEFORE INSERT ON public.warehouse_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_stamp_warehouse_official_number();

COMMENT ON COLUMN public.warehouse_stock_movements.official_number IS
  'Server-generated official receipt/adjustment number (WR-/WA-YYYY-nnnnnn), '
  'stamped by phoenix_stamp_warehouse_official_number. Authoritative human key; '
  'the row id is the permanent trace key; source_document_number is the '
  'external reference (not unique).';

COMMIT;

-- ============================================================================
-- POST-CONDITIONS (read-only, after apply):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='warehouse_stock_movements' AND column_name='official_number'; -- 1 row
--   -- After the next real receipt, its movement row carries a WR-YYYY-###### number.
-- ROLLBACK (lossless; production movement rows are 0 at cutover):
--   DROP TRIGGER warehouse_stock_movements_stamp_official ON public.warehouse_stock_movements;
--   DROP FUNCTION public.phoenix_stamp_warehouse_official_number();
--   DROP INDEX public.warehouse_stock_movements_official_number_uniq;
--   ALTER TABLE public.warehouse_stock_movements DROP COLUMN official_number;
--   DROP SEQUENCE public.warehouse_receipt_number_seq;
-- ============================================================================
