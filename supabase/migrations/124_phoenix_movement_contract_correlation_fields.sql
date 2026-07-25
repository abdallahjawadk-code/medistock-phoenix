-- ============================================================================
-- MOVEMENT-CONTRACT-CORRELATION-FIELDS-124
--
-- Third slice of the Unified Movements & Outlet Operations phase. 122/123
-- closed phoenix_movement_events coverage gaps (every domain movement now
-- emits exactly one canonical event). This migration starts standardizing
-- the shared contract fields across the three live quantity ledgers
-- (warehouse_stock_movements, outlet_stock_movements,
-- warehouse_quarantine_stock_movements) per the audit performed this
-- session:
--
--   * organization_id, movement_type, actor_id/role/name,
--     source_document_number, request_fingerprint already present and
--     consistent (in substance, if not always in column name) on all three
--     tables — no change needed.
--   * occurred_at, correlation_id, causation_id are MISSING on all three
--     ledger tables and on phoenix_movement_events itself. This migration
--     adds them additively (nullable or backfilled-default, never a
--     breaking change to any of the 19 existing SECURITY DEFINER writer
--     RPCs, all of which use explicit column-list INSERTs — verified this
--     session, zero positional INSERTs into any of the three tables).
--   * quantity_before/quantity_after are captured on the ledger rows today
--     (as on_hand_before/on_hand_after for warehouse+outlet, or
--     quantity_before/quantity_after for quarantine) but were NEVER
--     forwarded into phoenix_movement_events by 123's capture trigger —
--     only quantity_delta was. This migration closes that reconciliation
--     gap so the canonical envelope can prove before/after math without
--     joining back to the source ledger.
--
-- OUT OF SCOPE FOR THIS SLICE (tracked, not forgotten):
--   * A real closed-vocabulary reason_code column on the ledger rows
--     themselves (today: free-text `reason`, with a genuine closed
--     vocabulary one hop upstream on *_return_request_lines only). Adding
--     this touches write paths in all 19 RPCs and is a separate slice.
--   * Populating correlation_id/causation_id from callers. This migration
--     only adds the columns and threads them through the capture trigger;
--     the 19 writer RPCs still insert NULL for both until a follow-up
--     slice teaches each corridor to pass its own trace_id/parent event id
--     through. NULL is safe here — these columns are optional correlation
--     aids, not identity or RLS-scoping columns.
--   * Renaming on_hand_delta/on_hand_before/on_hand_after (warehouse,
--     outlet) to match quantity_delta/quantity_before/quantity_after
--     (quarantine), or distribution_point_id to a shared "location_id"
--     name. Physical-column renames would touch all 19 RPCs and every
--     report/view reading these tables for no functional gain — the
--     canonical envelope (phoenix_movement_events) is what "unified"
--     actually means here (see PR #57 description), and it already
--     presents a single normalized shape regardless of the source table's
--     own column names.
--
-- PRECONDITIONS: 123 applied (phoenix_movement_events + capture triggers on
--   the three ledgers + stocktakes already exist and are live).
-- ============================================================================

DO $precond$
BEGIN
  IF to_regclass('public.phoenix_movement_events') IS NULL THEN
    RAISE EXCEPTION '124 PRECONDITION FAILED: phoenix_movement_events missing — apply 081 first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE t.tgname = 'phoenix_capture_movement_posted'
       AND c.relname = 'warehouse_stock_movements'
  ) THEN
    RAISE EXCEPTION '124 PRECONDITION FAILED: 123 capture triggers missing — apply 123 first';
  END IF;
END;
$precond$;

-- ── A. New columns on the three live quantity ledgers ───────────────────────

ALTER TABLE public.warehouse_stock_movements
  ADD COLUMN IF NOT EXISTS occurred_at    timestamptz,
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS causation_id   uuid;
UPDATE public.warehouse_stock_movements SET occurred_at = created_at WHERE occurred_at IS NULL;
ALTER TABLE public.warehouse_stock_movements
  ALTER COLUMN occurred_at SET DEFAULT now(),
  ALTER COLUMN occurred_at SET NOT NULL;

ALTER TABLE public.outlet_stock_movements
  ADD COLUMN IF NOT EXISTS occurred_at    timestamptz,
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS causation_id   uuid;
UPDATE public.outlet_stock_movements SET occurred_at = created_at WHERE occurred_at IS NULL;
ALTER TABLE public.outlet_stock_movements
  ALTER COLUMN occurred_at SET DEFAULT now(),
  ALTER COLUMN occurred_at SET NOT NULL;

ALTER TABLE public.warehouse_quarantine_stock_movements
  ADD COLUMN IF NOT EXISTS occurred_at    timestamptz,
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS causation_id   uuid;
UPDATE public.warehouse_quarantine_stock_movements SET occurred_at = created_at WHERE occurred_at IS NULL;
ALTER TABLE public.warehouse_quarantine_stock_movements
  ALTER COLUMN occurred_at SET DEFAULT now(),
  ALTER COLUMN occurred_at SET NOT NULL;

-- ── B. New columns on the canonical envelope ─────────────────────────────────

ALTER TABLE public.phoenix_movement_events
  ADD COLUMN IF NOT EXISTS quantity_before integer,
  ADD COLUMN IF NOT EXISTS quantity_after  integer,
  ADD COLUMN IF NOT EXISTS correlation_id  uuid,
  ADD COLUMN IF NOT EXISTS causation_id    uuid;

-- ── C. Thread the new fields through the 123 capture trigger ────────────────

CREATE OR REPLACE FUNCTION public.phoenix_capture_movement_posted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $capture$
DECLARE
  v_new     jsonb := to_jsonb(NEW);
  v_org     uuid  := NULLIF(v_new ->> 'organization_id', '')::uuid;
  v_before  integer := COALESCE(
                          NULLIF(v_new ->> 'on_hand_before', '')::integer,
                          NULLIF(v_new ->> 'quantity_before', '')::integer
                        );
  v_delta   integer := COALESCE(
                          NULLIF(v_new ->> 'on_hand_delta', '')::integer,
                          NULLIF(v_new ->> 'quantity_delta', '')::integer
                        );
  v_after   integer := COALESCE(
                          NULLIF(v_new ->> 'on_hand_after', '')::integer,
                          NULLIF(v_new ->> 'quantity_after', '')::integer
                        );
  v_actor   uuid  := NULLIF(v_new ->> 'actor_id', '')::uuid;
  v_role    text  := v_new ->> 'actor_role';
  v_name    text  := v_new ->> 'actor_name';
  v_type    text  := v_new ->> 'movement_type';
  v_doc     text  := v_new ->> 'source_document_number';
  v_occurred timestamptz := COALESCE(NEW.occurred_at, now());
  v_correlation uuid := NULLIF(v_new ->> 'correlation_id', '')::uuid;
  v_causation   uuid := NULLIF(v_new ->> 'causation_id', '')::uuid;
BEGIN
  IF v_org IS NULL THEN
    RETURN NEW;  -- never emit an event with no RLS owner; fail closed, not loud
  END IF;

  INSERT INTO public.phoenix_movement_events (
    organization_id, trace_id, event_type, occurred_at,
    actor_id, actor_role, actor_name,
    quantity_delta, quantity_before, quantity_after, status_after,
    reference_type, reference_id, notes,
    correlation_id, causation_id,
    dedupe_key
  )
  VALUES (
    v_org,
    NEW.id,
    TG_TABLE_NAME || '.posted',
    v_occurred,
    v_actor, v_role, v_name,
    v_delta, v_before, v_after,
    v_type,
    TG_TABLE_NAME,
    NEW.id,
    v_doc,
    v_correlation, v_causation,
    NEW.id::text || ':posted'
  )
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  RETURN NEW;
END;
$capture$;

REVOKE ALL ON FUNCTION public.phoenix_capture_movement_posted() FROM PUBLIC;

DO $verify$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('warehouse_stock_movements', 'outlet_stock_movements', 'warehouse_quarantine_stock_movements')
     AND column_name IN ('occurred_at', 'correlation_id', 'causation_id');
  IF v_count <> 9 THEN
    RAISE EXCEPTION '124 VERIFY FAILED: expected 9 new ledger columns (3 tables x 3 columns), found %', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'phoenix_movement_events'
     AND column_name IN ('quantity_before', 'quantity_after', 'correlation_id', 'causation_id');
  IF v_count <> 4 THEN
    RAISE EXCEPTION '124 VERIFY FAILED: expected 4 new phoenix_movement_events columns, found %', v_count;
  END IF;

  SELECT
    (SELECT count(*) FROM public.warehouse_stock_movements WHERE occurred_at IS NULL) +
    (SELECT count(*) FROM public.outlet_stock_movements WHERE occurred_at IS NULL) +
    (SELECT count(*) FROM public.warehouse_quarantine_stock_movements WHERE occurred_at IS NULL)
  INTO v_count;
  IF v_count <> 0 THEN
    RAISE EXCEPTION '124 VERIFY FAILED: % existing ledger rows have NULL occurred_at after backfill', v_count;
  END IF;

  RAISE NOTICE 'MOVEMENT-CONTRACT-CORRELATION-FIELDS-124: verified.';
END;
$verify$;
