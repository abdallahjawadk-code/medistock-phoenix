-- ============================================================================
-- MOVEMENT-TIMELINE-CORRECTION-COVERAGE-122
--
-- First slice of the Unified Movements & Outlet Operations phase: close a
-- concrete, proven gap in phoenix_movement_events' coverage before touching
-- anything else. 082 wired phoenix_capture_lifecycle to six corridor headers
-- (warehouse_transfer_requests, warehouse_return_requests,
-- warehouse_return_shipments, outlet_return_requests, outlet_return_shipments,
-- warehouse_dispatches); 099 added two more (procurement_orders,
-- inventory_status_reports). Two status-driven correction-request tables were
-- never wired at all, even though they are ordinary status-transition
-- documents that fit the SAME trigger function unmodified:
--
--   * phoenix_stock_correction_requests   (098) — status: pending/approved/
--     rejected, has organization_id directly.
--   * phoenix_warehouse_correction_requests (101) — identical shape.
--
-- Both already carry exactly the columns phoenix_capture_lifecycle_event()
-- reads (organization_id, status, proposed_by is NOT what it reads — actor
-- comes from auth.uid() at decision time, matching every other corridor).
-- No new trigger function needed; this migration only attaches the existing
-- one, exactly as 082/099 did for their tables.
--
-- Explicitly NOT covered by this migration (deferred to later slices of this
-- phase, each needs different handling, not a copy of this one):
--   * stocktakes (092) — no status column at all; needs a purpose-built
--     insert-only capture, not this UPDATE-driven trigger.
--   * warehouse_stock_movements / outlet_stock_movements /
--     warehouse_quarantine_stock_movements / item_availability_movements —
--     pure append-only ledger rows (no OLD/NEW status transition to detect);
--     need a purpose-built insert-only capture too.
--
-- PRECONDITIONS: 101 applied (host tables + phoenix_capture_lifecycle_event
--   from 082/094 already exist and are live — verified this session).
-- ============================================================================

DO $precond$
BEGIN
  IF to_regclass('public.phoenix_stock_correction_requests') IS NULL THEN
    RAISE EXCEPTION '122 PRECONDITION FAILED: phoenix_stock_correction_requests missing — apply 098 first';
  END IF;
  IF to_regclass('public.phoenix_warehouse_correction_requests') IS NULL THEN
    RAISE EXCEPTION '122 PRECONDITION FAILED: phoenix_warehouse_correction_requests missing — apply 101 first';
  END IF;
  IF to_regprocedure('public.phoenix_capture_lifecycle_event()') IS NULL THEN
    RAISE EXCEPTION '122 PRECONDITION FAILED: phoenix_capture_lifecycle_event() missing — apply 082 first';
  END IF;
END;
$precond$;

DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.phoenix_stock_correction_requests;
CREATE TRIGGER phoenix_capture_lifecycle
  AFTER INSERT OR UPDATE ON public.phoenix_stock_correction_requests
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_lifecycle_event('organization_id');

DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.phoenix_warehouse_correction_requests;
CREATE TRIGGER phoenix_capture_lifecycle
  AFTER INSERT OR UPDATE ON public.phoenix_warehouse_correction_requests
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_lifecycle_event('organization_id');

DO $verify$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
   WHERE t.tgname = 'phoenix_capture_lifecycle'
     AND c.relname IN ('phoenix_stock_correction_requests', 'phoenix_warehouse_correction_requests');
  IF v_count <> 2 THEN
    RAISE EXCEPTION '122 VERIFY FAILED: expected 2 phoenix_capture_lifecycle triggers on the correction-request tables, found %', v_count;
  END IF;
  RAISE NOTICE 'MOVEMENT-TIMELINE-CORRECTION-COVERAGE-122: verified.';
END;
$verify$;
