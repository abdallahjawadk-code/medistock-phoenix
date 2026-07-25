-- ============================================================================
-- MOVEMENT-LEDGER-EVENT-CAPTURE-123
--
-- Second slice of the Unified Movements & Outlet Operations phase. 122 closed
-- the correction-request gap by reusing the existing UPDATE-driven
-- phoenix_capture_lifecycle_event() trigger (status-transition documents).
-- This migration closes the two remaining, structurally DIFFERENT gaps
-- identified in that same audit — both are INSERT-only, append-only fact
-- tables with no OLD/NEW status transition to detect, so the existing
-- trigger function is genuinely the wrong shape for them (it returns early
-- whenever NEW.status is NULL, which every row here always is):
--
--   * warehouse_stock_movements, outlet_stock_movements,
--     warehouse_quarantine_stock_movements — the three LIVE quantity ledgers
--     (item_availability_movements is explicitly excluded: its sole writer,
--     phoenix_apply_availability_movement, is confirmed to have ZERO
--     production call sites — see
--     src/features/inventory/__tests__/legacy-availability-writer-audit.test.ts
--     — so it is a dead table today and not worth the same investment;
--     deployment-blockers.md §3 already flags it for eventual retirement).
--   * stocktakes (092) — records a physical count, not a quantity change.
--
-- WHY THIS IS NOT A DUPLICATE-EVENT RISK
--
-- A corridor RPC (e.g. receiving a dispatch line) can, in the SAME
-- transaction, both (a) transition a corridor header's status — already
-- captured by phoenix_capture_lifecycle on that header table — and (b)
-- INSERT a warehouse_stock_movements/outlet_stock_movements row — newly
-- captured here. These are two DIFFERENT facts about two DIFFERENT rows
-- (reference_type/reference_id point at the header in one event and at the
-- movement row itself in the other), so they never collide on
-- phoenix_movement_events' dedupe_key (built from each row's OWN globally-
-- unique id) and are never the same fact recorded twice: "the shipment was
-- received" and "42 units posted to warehouse X, batch Y" are both real,
-- independently useful audit facts — collapsing them would lose information
-- (one header transition can correspond to several movement rows, one per
-- batch/lot). A genuine idempotent retry never re-INSERTs a movement row at
-- all (065's request_fingerprint short-circuits before the INSERT), so no
-- duplicate movement-posted event can arise from a retry either.
--
-- The three quantity-ledger tables share identical relevant column names
-- (organization_id, movement_type, actor_id/actor_role/actor_name,
-- reference_type/reference_id, source_document_number) and differ only in
-- their delta shape (on_hand_delta for warehouse/outlet vs quantity_delta
-- for quarantine), so ONE flexible function (same to_jsonb/COALESCE style as
-- the existing phoenix_capture_lifecycle_event) covers all three. stocktakes
-- has a genuinely different shape (performed_by, not actor_id; no
-- movement_type/delta at all) and gets its own small function rather than
-- being forced into the same one.
--
-- PRECONDITIONS: 122 applied (phoenix_movement_events + the three quantity
--   ledgers + stocktakes already exist and are live — verified this session).
-- ============================================================================

DO $precond$
BEGIN
  IF to_regclass('public.phoenix_movement_events') IS NULL THEN
    RAISE EXCEPTION '123 PRECONDITION FAILED: phoenix_movement_events missing — apply 081 first';
  END IF;
  IF to_regclass('public.warehouse_stock_movements') IS NULL
     OR to_regclass('public.outlet_stock_movements') IS NULL
     OR to_regclass('public.warehouse_quarantine_stock_movements') IS NULL
     OR to_regclass('public.stocktakes') IS NULL THEN
    RAISE EXCEPTION '123 PRECONDITION FAILED: one or more source tables missing — apply 060/067/069/092 first';
  END IF;
END;
$precond$;

-- ── A. Quantity-ledger capture: warehouse/outlet/quarantine movements ───────

CREATE OR REPLACE FUNCTION public.phoenix_capture_movement_posted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $capture$
DECLARE
  v_new     jsonb := to_jsonb(NEW);
  v_org     uuid  := NULLIF(v_new ->> 'organization_id', '')::uuid;
  v_delta   integer := COALESCE(
                          NULLIF(v_new ->> 'on_hand_delta', '')::integer,
                          NULLIF(v_new ->> 'quantity_delta', '')::integer
                        );
  v_actor   uuid  := NULLIF(v_new ->> 'actor_id', '')::uuid;
  v_role    text  := v_new ->> 'actor_role';
  v_name    text  := v_new ->> 'actor_name';
  v_type    text  := v_new ->> 'movement_type';
  v_doc     text  := v_new ->> 'source_document_number';
BEGIN
  IF v_org IS NULL THEN
    RETURN NEW;  -- never emit an event with no RLS owner; fail closed, not loud
  END IF;

  INSERT INTO public.phoenix_movement_events (
    organization_id, trace_id, event_type, occurred_at,
    actor_id, actor_role, actor_name,
    quantity_delta, status_after, reference_type, reference_id, notes,
    dedupe_key
  )
  VALUES (
    v_org,
    NEW.id,
    TG_TABLE_NAME || '.posted',
    now(),
    v_actor, v_role, v_name,
    v_delta,
    v_type,
    TG_TABLE_NAME,
    NEW.id,
    v_doc,
    NEW.id::text || ':posted'
  )
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  RETURN NEW;
END;
$capture$;

REVOKE ALL ON FUNCTION public.phoenix_capture_movement_posted() FROM PUBLIC;

DROP TRIGGER IF EXISTS phoenix_capture_movement_posted ON public.warehouse_stock_movements;
CREATE TRIGGER phoenix_capture_movement_posted
  AFTER INSERT ON public.warehouse_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_movement_posted();

DROP TRIGGER IF EXISTS phoenix_capture_movement_posted ON public.outlet_stock_movements;
CREATE TRIGGER phoenix_capture_movement_posted
  AFTER INSERT ON public.outlet_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_movement_posted();

DROP TRIGGER IF EXISTS phoenix_capture_movement_posted ON public.warehouse_quarantine_stock_movements;
CREATE TRIGGER phoenix_capture_movement_posted
  AFTER INSERT ON public.warehouse_quarantine_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_movement_posted();

-- ── B. Stocktake capture: a count was recorded, not a quantity change ───────

CREATE OR REPLACE FUNCTION public.phoenix_capture_stocktake_recorded()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $capture$
DECLARE
  v_role text;
  v_name text;
BEGIN
  IF NEW.performed_by IS NOT NULL THEN
    SELECT p.role, p.full_name INTO v_role, v_name
      FROM public.profiles p WHERE p.id = NEW.performed_by;
  END IF;

  INSERT INTO public.phoenix_movement_events (
    organization_id, trace_id, event_type, occurred_at,
    actor_id, actor_role, actor_name,
    status_after, reference_type, reference_id, notes,
    dedupe_key
  )
  VALUES (
    NEW.organization_id,
    NEW.id,
    'stocktakes.recorded',
    now(),
    NEW.performed_by, v_role, v_name,
    'recorded',
    'stocktakes',
    NEW.id,
    NEW.notes,
    NEW.id::text || ':recorded'
  )
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  RETURN NEW;
END;
$capture$;

REVOKE ALL ON FUNCTION public.phoenix_capture_stocktake_recorded() FROM PUBLIC;

DROP TRIGGER IF EXISTS phoenix_capture_stocktake_recorded ON public.stocktakes;
CREATE TRIGGER phoenix_capture_stocktake_recorded
  AFTER INSERT ON public.stocktakes
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_stocktake_recorded();

DO $verify$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
   WHERE t.tgname = 'phoenix_capture_movement_posted'
     AND c.relname IN ('warehouse_stock_movements', 'outlet_stock_movements', 'warehouse_quarantine_stock_movements');
  IF v_count <> 3 THEN
    RAISE EXCEPTION '123 VERIFY FAILED: expected 3 phoenix_capture_movement_posted triggers, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
   WHERE t.tgname = 'phoenix_capture_stocktake_recorded'
     AND c.relname = 'stocktakes';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '123 VERIFY FAILED: expected 1 phoenix_capture_stocktake_recorded trigger on stocktakes, found %', v_count;
  END IF;

  RAISE NOTICE 'MOVEMENT-LEDGER-EVENT-CAPTURE-123: verified.';
END;
$verify$;
