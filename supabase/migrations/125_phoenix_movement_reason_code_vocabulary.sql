-- ============================================================================
-- MOVEMENT-REASON-CODE-VOCABULARY-125
--
-- Fourth slice of the Unified Movements & Outlet Operations phase (item A of
-- PR #57's plan: standardized movement contract). Schema-only preparation
-- for reason_code standardization across the 20 SECURITY DEFINER writer
-- functions that INSERT into the three live quantity ledgers
-- (warehouse_stock_movements, outlet_stock_movements,
-- warehouse_quarantine_stock_movements) — audited in full this session.
--
-- WHY SCHEMA-ONLY, WHY NOW, WHY ALL THREE TABLES TOGETHER
--
-- This migration touches ZERO RPC function bodies — it only adds a column.
-- That is deliberate: the 20 writer functions will be migrated to populate
-- reason_code in small, independently-verified domain slices (warehouse
-- receive/intake, transfer send/receive, return send/receive, direct
-- central-institution, procurement, outlet dispatch/dispense/count/return,
-- quarantine, correction-approval), per explicit instruction to avoid a
-- single high-blast-radius change touching all 20 at once.
--
-- Doing the DDL for all three tables in ONE migration is safe precisely
-- BECAUSE it touches no RPC: every one of the 20 functions uses an explicit
-- column-list INSERT (verified this session — zero positional inserts
-- across all three tables), so a new column is invisible to unmodified
-- callers. The NOT NULL constraint is satisfiable immediately, for every
-- existing and not-yet-updated writer, via a column DEFAULT — no writer
-- needs to change today for this migration to apply cleanly.
--
-- THE VOCABULARY (single closed set, not two parallel axes)
--
-- The audit found 9 pre-existing closed values (on
-- warehouse_return_request_lines/outlet_return_request_lines only, never on
-- the ledgers themselves): excess, shipment_error, near_expiry, expired,
-- damaged, recalled, quality_issue, temperature_excursion, other. Six of
-- the 20 writers accept UNRESTRICTED CLIENT FREE TEXT into the ledger's
-- `reason` column today with no vocabulary check at all (confirmed:
-- phoenix_apply_warehouse_stock_movement, phoenix_procurement_return_to_supplier,
-- phoenix_receive_outlet_dispatch_line, phoenix_dispense_outlet_stock,
-- phoenix_count_outlet_stock, phoenix_release_quarantine_stock,
-- phoenix_destroy_quarantine_stock). The existing `reason` column keeps
-- serving exactly the "reason_detail" role the phase spec calls for — it
-- is not renamed (a rename would force touching every writer of a given
-- table simultaneously, since warehouse_stock_movements alone is written
-- by writers across nearly every domain group audited; that IS the
-- high-blast-radius change this slice avoids). `reason_code` is additive
-- and NEW; `reason` continues to carry the free-text human explanation,
-- unchanged.
--
-- The 9 existing values are extended with 6 routine/generic values the
-- audit found no existing vocabulary covers at all (receiving, transferring,
-- dispensing and counting are not damage/loss events; a generic manual
-- correction or quarantine release needs a landing value when no more
-- specific anomaly code applies) plus one migration-only value for rows
-- that predate this column and cannot be retroactively classified:
--
--   received, transferred, dispensed, counted, corrected, released,
--   excess, shipment_error, near_expiry, expired, damaged, recalled,
--   quality_issue, temperature_excursion, other, legacy_unclassified
--
-- `legacy_unclassified` is the DEFAULT for this column precisely so it
-- lands only on rows this migration did not (and structurally cannot)
-- reclassify -- every row inserted by an as-yet-unmigrated writer between
-- this migration and its own domain slice, plus every row that already
-- existed before this migration ran. No application code path may ever
-- write `legacy_unclassified` deliberately; it exists purely as the
-- backfill/default landing zone documented in item A of the phase plan.
--
-- PRECONDITIONS: 124 applied (correlation_id/causation_id/occurred_at
--   already present on all three ledgers).
-- ============================================================================

DO $precond$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'warehouse_stock_movements'
       AND column_name = 'correlation_id'
  ) THEN
    RAISE EXCEPTION '125 PRECONDITION FAILED: 124 (correlation_id/causation_id) missing — apply 124 first';
  END IF;
END;
$precond$;

-- ── The single canonical reason_code vocabulary, shared by all three ledgers ─

ALTER TABLE public.warehouse_stock_movements
  ADD COLUMN IF NOT EXISTS reason_code text NOT NULL DEFAULT 'legacy_unclassified';
ALTER TABLE public.warehouse_stock_movements
  ADD CONSTRAINT warehouse_stock_movements_reason_code_chk
  CHECK (reason_code IN (
    'received', 'transferred', 'dispensed', 'counted', 'corrected', 'released',
    'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged', 'recalled',
    'quality_issue', 'temperature_excursion', 'other', 'legacy_unclassified'
  ));

ALTER TABLE public.outlet_stock_movements
  ADD COLUMN IF NOT EXISTS reason_code text NOT NULL DEFAULT 'legacy_unclassified';
ALTER TABLE public.outlet_stock_movements
  ADD CONSTRAINT outlet_stock_movements_reason_code_chk
  CHECK (reason_code IN (
    'received', 'transferred', 'dispensed', 'counted', 'corrected', 'released',
    'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged', 'recalled',
    'quality_issue', 'temperature_excursion', 'other', 'legacy_unclassified'
  ));

ALTER TABLE public.warehouse_quarantine_stock_movements
  ADD COLUMN IF NOT EXISTS reason_code text NOT NULL DEFAULT 'legacy_unclassified';
ALTER TABLE public.warehouse_quarantine_stock_movements
  ADD CONSTRAINT warehouse_quarantine_stock_movements_reason_code_chk
  CHECK (reason_code IN (
    'received', 'transferred', 'dispensed', 'counted', 'corrected', 'released',
    'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged', 'recalled',
    'quality_issue', 'temperature_excursion', 'other', 'legacy_unclassified'
  ));

DO $verify$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('warehouse_stock_movements', 'outlet_stock_movements', 'warehouse_quarantine_stock_movements')
     AND column_name = 'reason_code';
  IF v_count <> 3 THEN
    RAISE EXCEPTION '125 VERIFY FAILED: expected reason_code on 3 tables, found %', v_count;
  END IF;

  SELECT
    (SELECT count(*) FROM public.warehouse_stock_movements WHERE reason_code IS NULL OR reason_code = '') +
    (SELECT count(*) FROM public.outlet_stock_movements WHERE reason_code IS NULL OR reason_code = '') +
    (SELECT count(*) FROM public.warehouse_quarantine_stock_movements WHERE reason_code IS NULL OR reason_code = '')
  INTO v_count;
  IF v_count <> 0 THEN
    RAISE EXCEPTION '125 VERIFY FAILED: % existing ledger rows have a NULL/blank reason_code after backfill', v_count;
  END IF;

  RAISE NOTICE 'MOVEMENT-REASON-CODE-VOCABULARY-125: verified.';
END;
$verify$;
