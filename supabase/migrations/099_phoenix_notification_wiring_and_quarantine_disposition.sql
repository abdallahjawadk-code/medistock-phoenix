-- ============================================================================
-- NOTIFICATION-WIRING-AND-QUARANTINE-DISPOSITION-099-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 098.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS ADDS — Phase 2 contract item 1, the remaining events
-- ─────────────────────────────────────────────────────────────────────────────
-- 094 wired notifications into the six 082 corridor headers (request/send/
-- receive/reject/return already covered there via their status columns).
-- Still missing: local procurement (087/089), quarantine entry+disposition,
-- the monthly status center (092), dispensing, and stocktake/correction.
--
-- (A) Local procurement (087) and monthly status (092) headers BOTH already
--     have a `status` column + `organization_id`, the EXACT shape 082's
--     generic phoenix_capture_lifecycle_event(TG_ARGV) trigger was written
--     for — so this migration just ATTACHES that existing function to
--     procurement_orders and inventory_status_reports. Zero new trigger
--     logic; the same idempotent, transactional, actor-attributed capture
--     089's subpurchase direct-entry writes to the SAME procurement_orders
--     table (confirmed before writing this), so it is covered for free too.
--
-- (B) Dispensing (067, movement_type='dispense'), stock corrections (067/086/
--     098, movement_type='correction'), and quarantine entry+disposition
--     (069/071's quarantine_receive, plus THIS migration's new release/
--     destroy) have NO status-transitioning header — they are single
--     append-only rows. A SECOND generic trigger,
--     phoenix_capture_movement_notification(), fires AFTER INSERT on those
--     tables and notifies for an allowlisted set of movement_type values
--     (TG_ARGV[0], comma-separated; NULL means "every insert", used for
--     stocktakes and the quarantine movement table where every row IS the
--     event). Dedup is trivial here: each row's own id is already unique and
--     never reinserted for the same logical event (the writing RPC's own
--     idempotency prevents a second row), so dedupe_key = table||':'||id.
--
-- (C) Quarantine DISPOSITION never had any RPC at all (069's own comments
--     defer it; confirmed absent through 098 before writing this file) —
--     'quarantine_release'/'quarantine_destroy' sat in the CHECK constraint
--     unwritten since 069. This migration adds
--     phoenix_release_quarantine_stock (credits a named, existing
--     warehouse_stock lot — reuses the 'correction' movement_type already on
--     warehouse_stock_movements, no CHECK constraint widened) and
--     phoenix_destroy_quarantine_stock (pure debit, permanent, no credit
--     anywhere). Both are guarded (advisory lock + request-id idempotency,
--     same shape as every other guarded RPC in this repository).
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure('public.phoenix_capture_lifecycle_event()') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_lifecycle_event() missing — apply 082/094 first';
  END IF;
  IF to_regclass('public.procurement_orders') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: procurement_orders missing — apply 087 first';
  END IF;
  IF to_regclass('public.inventory_status_reports') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: inventory_status_reports missing — apply 092 first';
  END IF;
  IF to_regclass('public.warehouse_quarantine_stock') IS NULL
     OR to_regclass('public.warehouse_quarantine_stock_movements') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: quarantine tables missing — apply 069 first';
  END IF;
  IF to_regclass('public.phoenix_notifications') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_notifications missing — apply 094 first';
  END IF;
END;
$precond$;

-- ── A. Reuse the existing header trigger on 087/092 ─────────────────────────

DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.procurement_orders;
CREATE TRIGGER phoenix_capture_lifecycle
  AFTER INSERT OR UPDATE ON public.procurement_orders
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_lifecycle_event('organization_id');

DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.inventory_status_reports;
CREATE TRIGGER phoenix_capture_lifecycle
  AFTER INSERT OR UPDATE ON public.inventory_status_reports
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_lifecycle_event('organization_id');

-- ── B. Generic insert-notification trigger for headerless events ───────────

CREATE OR REPLACE FUNCTION public.phoenix_capture_movement_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $capture_mv$
DECLARE
  v_new       jsonb := to_jsonb(NEW);
  v_type      text  := v_new ->> 'movement_type';   -- NULL if the table has no such column
  v_allowlist text  := TG_ARGV[0];
  v_org       uuid  := NULLIF(v_new ->> 'organization_id', '')::uuid;
  v_actor     uuid  := COALESCE(NULLIF(v_new ->> 'actor_id', '')::uuid, NULLIF(v_new ->> 'performed_by', '')::uuid, NULLIF(v_new ->> 'created_by', '')::uuid);
  v_role      text  := v_new ->> 'actor_role';
  v_name      text  := v_new ->> 'actor_name';
  v_dedupe    text;
BEGIN
  IF v_allowlist IS NOT NULL AND (v_type IS NULL OR NOT (v_type = ANY(string_to_array(v_allowlist, ',')))) THEN
    RETURN NEW;
  END IF;
  IF v_org IS NULL THEN
    RETURN NEW; -- cannot own an RLS row without an org; never invent one
  END IF;

  IF v_actor IS NOT NULL AND v_role IS NULL THEN
    SELECT p.role, p.full_name INTO v_role, v_name FROM public.profiles p WHERE p.id = v_actor;
  END IF;

  v_dedupe := TG_TABLE_NAME || ':' || NEW.id::text;

  INSERT INTO public.phoenix_notifications (
    organization_id, event_type, occurred_at,
    actor_id, actor_role, actor_name,
    status_after, reference_type, reference_id, reference_label, dedupe_key
  )
  VALUES (
    v_org,
    TG_TABLE_NAME || COALESCE('.' || v_type, '.created'),
    now(),
    v_actor, v_role, v_name,
    v_type,
    TG_TABLE_NAME,
    NEW.id,
    NULLIF(v_new ->> 'scientific_name_snapshot', COALESCE(v_new ->> 'scientific_name', '')),
    v_dedupe
  )
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  RETURN NEW;
END;
$capture_mv$;

REVOKE ALL ON FUNCTION public.phoenix_capture_movement_notification() FROM PUBLIC;

COMMENT ON FUNCTION public.phoenix_capture_movement_notification() IS
  'AFTER INSERT notification capture for headerless append-only events '
  '(dispense/correction movements, quarantine movements, stocktakes). '
  'TG_ARGV[0] is an optional comma-separated movement_type allowlist; NULL '
  'means every insert is notification-worthy. Dedup keys off the row''s own '
  'id, which is never reinserted for the same logical event.';

DROP TRIGGER IF EXISTS phoenix_capture_movement_notification ON public.outlet_stock_movements;
CREATE TRIGGER phoenix_capture_movement_notification
  AFTER INSERT ON public.outlet_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_movement_notification('dispense,correction');

DROP TRIGGER IF EXISTS phoenix_capture_movement_notification ON public.warehouse_stock_movements;
CREATE TRIGGER phoenix_capture_movement_notification
  AFTER INSERT ON public.warehouse_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_movement_notification('correction');

-- No argument at all (NOT a literal NULL — CREATE TRIGGER arguments are
-- always string constants, so writing the bare token NULL would pass the
-- four-character STRING 'NULL' as TG_ARGV[0], which is NOT NULL inside the
-- function and would make every row's movement_type spuriously required to
-- equal the text 'NULL'. Omitting the argument entirely leaves TG_NARGS=0,
-- so TG_ARGV[0] is genuinely NULL in PL/pgSQL (out-of-bounds array access),
-- which is what "no filter, every insert notifies" actually requires.
DROP TRIGGER IF EXISTS phoenix_capture_movement_notification ON public.warehouse_quarantine_stock_movements;
CREATE TRIGGER phoenix_capture_movement_notification
  AFTER INSERT ON public.warehouse_quarantine_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_movement_notification();

DROP TRIGGER IF EXISTS phoenix_capture_movement_notification ON public.stocktakes;
CREATE TRIGGER phoenix_capture_movement_notification
  AFTER INSERT ON public.stocktakes
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_movement_notification();

-- ── C. Quarantine disposition — the RPCs that never existed ────────────────

CREATE OR REPLACE FUNCTION public.phoenix_release_quarantine_stock(
  p_request_id                   uuid,
  p_quarantine_stock_id          uuid,
  p_quantity                     integer,
  p_reason                       text,
  p_destination_warehouse_stock_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $release$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_actor_name text;
  v_q          public.warehouse_quarantine_stock%ROWTYPE;
  v_dest       public.warehouse_stock%ROWTYPE;
  v_existing   public.warehouse_quarantine_stock_movements%ROWTYPE;
  v_reason     text := NULLIF(btrim(p_reason), '');
  v_fp         text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'release_reason_required' USING ERRCODE = '23514';
  END IF;
  IF p_destination_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'destination_warehouse_stock_id_required' USING ERRCODE = '23514';
  END IF;

  v_fp := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'quarantine_release', 'quarantine_stock_id', p_quarantine_stock_id,
    'quantity', p_quantity, 'reason', v_reason,
    'destination', p_destination_warehouse_stock_id
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 99099));

  SELECT * INTO v_existing
  FROM public.warehouse_quarantine_stock_movements m
  WHERE m.reference_type = 'quarantine_request' AND m.reference_id = p_request_id;
  IF FOUND THEN
    IF v_existing.quarantine_stock_id IS DISTINCT FROM p_quarantine_stock_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'movement_id', v_existing.id);
  END IF;

  SELECT * INTO v_q FROM public.warehouse_quarantine_stock WHERE id = p_quarantine_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quarantine_stock_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_quantity > v_q.quantity THEN
    RAISE EXCEPTION 'release_quantity_exceeds_quarantined' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_dest FROM public.warehouse_stock WHERE id = p_destination_warehouse_stock_id FOR UPDATE;
  IF NOT FOUND OR v_dest.organization_id <> v_q.organization_id OR v_dest.warehouse_id <> v_q.warehouse_id THEN
    RAISE EXCEPTION 'destination_not_at_this_warehouse' USING ERRCODE = '23514';
  END IF;
  -- Material/batch/expiry must match — release credits the SAME lot it was
  -- quarantined from, never a substitution.
  IF v_dest.scientific_name IS DISTINCT FROM v_q.scientific_name
     OR COALESCE(v_dest.batch_number,'') IS DISTINCT FROM COALESCE(v_q.batch_number,'')
     OR v_dest.expiry_date IS DISTINCT FROM v_q.expiry_date THEN
    RAISE EXCEPTION 'destination_material_batch_expiry_mismatch' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_request', v_q.organization_id, v_q.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_quarantine_release' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  UPDATE public.warehouse_quarantine_stock SET quantity = quantity - p_quantity, updated_by = v_actor WHERE id = v_q.id;
  UPDATE public.warehouse_stock SET on_hand_quantity = on_hand_quantity + p_quantity WHERE id = v_dest.id;

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id, movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after, reason,
    reference_type, reference_id, request_fingerprint,
    actor_id, actor_role, actor_name,
    scientific_name_snapshot, batch_number_snapshot
  ) VALUES (
    v_dest.id, v_dest.organization_id, v_dest.warehouse_id, 'correction',
    v_dest.on_hand_quantity, p_quantity, v_dest.on_hand_quantity + p_quantity,
    v_dest.reserved_quantity, 0, v_dest.reserved_quantity,
    'quarantine_release: ' || v_reason,
    'quarantine_request', p_request_id, v_fp,
    v_actor, v_actor_role, v_actor_name,
    v_dest.scientific_name, v_dest.batch_number
  );

  INSERT INTO public.warehouse_quarantine_stock_movements (
    quarantine_stock_id, organization_id, warehouse_id, movement_type,
    quantity_before, quantity_delta, quantity_after, reason,
    reference_type, reference_id, request_fingerprint,
    actor_id, actor_role, actor_name,
    scientific_name_snapshot, batch_number_snapshot, internal_batch_reference_snapshot
  ) VALUES (
    v_q.id, v_q.organization_id, v_q.warehouse_id, 'quarantine_release',
    v_q.quantity, -p_quantity, v_q.quantity - p_quantity, v_reason,
    'quarantine_request', p_request_id, v_fp,
    v_actor, v_actor_role, v_actor_name,
    v_q.scientific_name, v_q.batch_number, v_q.internal_batch_reference
  )
  RETURNING id INTO v_existing;

  RETURN jsonb_build_object('ok', true, 'movement_id', v_existing.id, 'destination_warehouse_stock_id', v_dest.id);
END;
$release$;

REVOKE ALL ON FUNCTION public.phoenix_release_quarantine_stock(uuid, uuid, integer, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_release_quarantine_stock(uuid, uuid, integer, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_destroy_quarantine_stock(
  p_request_id          uuid,
  p_quarantine_stock_id uuid,
  p_quantity            integer,
  p_reason              text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $destroy$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_actor_name text;
  v_q          public.warehouse_quarantine_stock%ROWTYPE;
  v_existing   public.warehouse_quarantine_stock_movements%ROWTYPE;
  v_reason     text := NULLIF(btrim(p_reason), '');
  v_fp         text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'destroy_reason_required' USING ERRCODE = '23514';
  END IF;

  v_fp := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'quarantine_destroy', 'quarantine_stock_id', p_quarantine_stock_id,
    'quantity', p_quantity, 'reason', v_reason
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 99098));

  SELECT * INTO v_existing
  FROM public.warehouse_quarantine_stock_movements m
  WHERE m.reference_type = 'quarantine_request' AND m.reference_id = p_request_id;
  IF FOUND THEN
    IF v_existing.quarantine_stock_id IS DISTINCT FROM p_quarantine_stock_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'movement_id', v_existing.id);
  END IF;

  SELECT * INTO v_q FROM public.warehouse_quarantine_stock WHERE id = p_quarantine_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quarantine_stock_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_quantity > v_q.quantity THEN
    RAISE EXCEPTION 'destroy_quantity_exceeds_quarantined' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_request', v_q.organization_id, v_q.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_quarantine_destroy' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  UPDATE public.warehouse_quarantine_stock SET quantity = quantity - p_quantity, updated_by = v_actor WHERE id = v_q.id;

  INSERT INTO public.warehouse_quarantine_stock_movements (
    quarantine_stock_id, organization_id, warehouse_id, movement_type,
    quantity_before, quantity_delta, quantity_after, reason,
    reference_type, reference_id, request_fingerprint,
    actor_id, actor_role, actor_name,
    scientific_name_snapshot, batch_number_snapshot, internal_batch_reference_snapshot
  ) VALUES (
    v_q.id, v_q.organization_id, v_q.warehouse_id, 'quarantine_destroy',
    v_q.quantity, -p_quantity, v_q.quantity - p_quantity, v_reason,
    'quarantine_request', p_request_id, v_fp,
    v_actor, v_actor_role, v_actor_name,
    v_q.scientific_name, v_q.batch_number, v_q.internal_batch_reference
  )
  RETURNING id INTO v_existing;

  RETURN jsonb_build_object('ok', true, 'movement_id', v_existing.id);
END;
$destroy$;

REVOKE ALL ON FUNCTION public.phoenix_destroy_quarantine_stock(uuid, uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_destroy_quarantine_stock(uuid, uuid, integer, text) TO authenticated;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. Triggers exist on procurement_orders, inventory_status_reports
--    (phoenix_capture_lifecycle) and outlet_stock_movements,
--    warehouse_stock_movements, warehouse_quarantine_stock_movements,
--    stocktakes (phoenix_capture_movement_notification):
--    SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
--     WHERE t.tgname IN ('phoenix_capture_lifecycle','phoenix_capture_movement_notification')
--     ORDER BY 1,2; -- expect 8 rows total (2 existing headers untouched + these 6 new)
-- 2. Both new quarantine RPCs exist exactly once, SECURITY DEFINER, pinned search_path.
-- 3. RECONCILIATION: warehouse_quarantine_stock/warehouse_stock row counts
--    and sums unchanged immediately after apply (pure DDL + function/trigger
--    definitions until an RPC is actually called).
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--   BEGIN;
--     DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.procurement_orders;
--     DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.inventory_status_reports;
--     DROP TRIGGER IF EXISTS phoenix_capture_movement_notification ON public.outlet_stock_movements;
--     DROP TRIGGER IF EXISTS phoenix_capture_movement_notification ON public.warehouse_stock_movements;
--     DROP TRIGGER IF EXISTS phoenix_capture_movement_notification ON public.warehouse_quarantine_stock_movements;
--     DROP TRIGGER IF EXISTS phoenix_capture_movement_notification ON public.stocktakes;
--     DROP FUNCTION IF EXISTS public.phoenix_capture_movement_notification();
--     DROP FUNCTION IF EXISTS public.phoenix_release_quarantine_stock(uuid, uuid, integer, text, uuid);
--     DROP FUNCTION IF EXISTS public.phoenix_destroy_quarantine_stock(uuid, uuid, integer, text);
--   COMMIT;
-- Containment without a schema change: stop calling the two new quarantine
-- RPCs from the frontend; the new triggers are harmless (append-only,
-- RLS-scoped) even if nothing consumes their output.
-- ============================================================================
