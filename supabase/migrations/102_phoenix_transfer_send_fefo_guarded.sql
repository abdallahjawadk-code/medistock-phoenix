-- ============================================================================
-- TRANSFER-SEND-FEFO-GUARDED-102-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 101.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES — Phase 2 backend-parity audit
-- ─────────────────────────────────────────────────────────────────────────────
-- 097 enforced FEFO for 070's phoenix_add_dispatch_line (institution warehouse
-- -> outlet). The SAME gap exists one corridor up: 068's
-- phoenix_send_warehouse_transfer_line (088's currently-effective body) lets
-- the caller name ANY warehouse_stock_id at the source (central) warehouse for
-- the material being sent, with no comparison against the FEFO-earliest lot —
-- confirmed by reading 088's body before writing this file (no fefo reference
-- anywhere in it). This is the same distribution-outward shape 097 already
-- closed, just at the central->institution leg instead of the
-- institution->outlet leg. 069/071 (RETURN corridors) and 087 (procurement,
-- INBOUND) are deliberately excluded — FEFO governs which lot goes OUT to a
-- destination; a return ships back the exact lot already received, and a
-- procurement receipt has no outgoing lot choice to enforce.
--
-- NEW RPC, not a redefinition of phoenix_send_warehouse_transfer_line — same
-- "distinctly-named guarded contract, legacy path stays reachable, single
-- delegated write path" discipline as 097 itself.
--
-- REUSES 097's inventory.fefo_override permission key (one override concept,
-- not two) but the actor at THIS corridor's send step is central_warehouse_
-- manager (068's role_permission_defaults: warehouse_transfer.send = true for
-- central_warehouse_manager, false for warehouse_officer — the inverse of
-- 070's edit_draft holder). Granting the SAME key only to warehouse_officer
-- (097's original grant) would make the override permanently unreachable
-- here, exactly the failure mode 097's own comment warned against — so this
-- migration ALSO grants inventory.fefo_override to central_warehouse_manager.
-- warehouse_officer's existing grant (070's context) is untouched.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure(
    'public.phoenix_send_warehouse_transfer_line(uuid,uuid,uuid,integer,text,uuid,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 068/088 phoenix_send_warehouse_transfer_line is missing';
  END IF;
  IF to_regprocedure(
    'public.phoenix_inventory_fefo_batches(uuid,text,uuid,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 072 phoenix_inventory_fefo_batches is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.permission_keys WHERE key = 'inventory.fefo_override') THEN
    RAISE EXCEPTION 'precondition failed: 097 inventory.fefo_override permission is missing';
  END IF;
END;
$precond$;

-- ── A. Extend the existing override permission to the central-side actor ───

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
VALUES
  ('central_warehouse_manager', 'inventory.fefo_override', true)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ── B. Guarded send: FEFO by default, override requires permission + reason ─

CREATE OR REPLACE FUNCTION public.phoenix_send_warehouse_transfer_line_fefo_guarded(
  p_request_id               uuid,
  p_route_id                 uuid,
  p_warehouse_stock_id       uuid,
  p_quantity                 integer,
  p_transfer_number          text,
  p_transfer_request_line_id uuid    DEFAULT NULL,
  p_document_number          text    DEFAULT NULL,
  p_notes                    text    DEFAULT NULL,
  p_fefo_override            boolean DEFAULT false,
  p_override_reason          text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fefo$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_route        public.warehouse_supply_routes%ROWTYPE;
  v_stock        public.warehouse_stock%ROWTYPE;
  v_fefo_stock   uuid;
  v_fefo_batch   text;
  v_fefo_expiry  date;
  v_reason       text := NULLIF(btrim(p_override_reason), '');
  v_result       jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_route_id IS NULL OR p_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'route_and_stock_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_route FROM public.warehouse_supply_routes WHERE id = p_route_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supply_route_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_stock FROM public.warehouse_stock WHERE id = p_warehouse_stock_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- The FEFO-earliest lot for the SAME material at the SAME source
  -- warehouse — the default, no-override expectation.
  SELECT b.stock_id, b.batch_number, b.expiry_date
    INTO v_fefo_stock, v_fefo_batch, v_fefo_expiry
    FROM public.phoenix_inventory_fefo_batches(
           v_stock.organization_id, 'warehouse', v_stock.warehouse_id,
           v_stock.scientific_name, v_stock.national_code) b
   ORDER BY b.expiry_date ASC NULLS LAST, b.stock_id ASC
   LIMIT 1;

  IF v_fefo_stock IS NOT NULL AND v_fefo_stock IS DISTINCT FROM p_warehouse_stock_id THEN
    -- NOT the FEFO-earliest lot. Fail closed unless override is explicit,
    -- permitted, and reasoned.
    IF NOT p_fefo_override THEN
      RAISE EXCEPTION 'fefo_override_required' USING ERRCODE = '23514',
        DETAIL = format('fefo_batch=%s chosen_stock_id=%s', v_fefo_batch, p_warehouse_stock_id);
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'fefo_override_reason_required' USING ERRCODE = '23514';
    END IF;
    IF NOT public.phoenix_profile_has_scoped_permission(
      v_actor, 'inventory.fefo_override', v_stock.organization_id, v_stock.warehouse_id, NULL
    ) THEN
      RAISE EXCEPTION 'forbidden_fefo_override' USING ERRCODE = '42501';
    END IF;

    SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

    -- Delegate the actual send to 068/088's unmodified RPC — single write path.
    v_result := public.phoenix_send_warehouse_transfer_line(
      p_request_id, p_route_id, p_warehouse_stock_id, p_quantity, p_transfer_number,
      p_transfer_request_line_id, p_document_number, p_notes
    );

    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_stock.organization_id, v_actor, v_actor_role,
      'inventory.fefo_overridden', 'warehouse_stock_movements',
      NULLIF(v_result ->> 'movement_id', '')::uuid, v_stock.scientific_name,
      jsonb_build_object(
        'request_id', p_request_id, 'route_id', p_route_id,
        'before_fefo_stock_id', v_fefo_stock, 'before_fefo_batch', v_fefo_batch, 'before_fefo_expiry', v_fefo_expiry,
        'after_chosen_stock_id', p_warehouse_stock_id, 'after_chosen_batch', v_stock.batch_number, 'after_chosen_expiry', v_stock.expiry_date,
        'reason', v_reason, 'quantity', p_quantity
      )
    );

    RETURN v_result || jsonb_build_object('fefo_override_applied', true);
  END IF;

  -- FEFO-compliant (or no other batch exists to compare against) — plain
  -- delegation, no override machinery, no audit noise.
  RETURN public.phoenix_send_warehouse_transfer_line(
    p_request_id, p_route_id, p_warehouse_stock_id, p_quantity, p_transfer_number,
    p_transfer_request_line_id, p_document_number, p_notes
  ) || jsonb_build_object('fefo_override_applied', false);
END;
$fefo$;

REVOKE ALL ON FUNCTION public.phoenix_send_warehouse_transfer_line_fefo_guarded(
  uuid, uuid, uuid, integer, text, uuid, text, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_send_warehouse_transfer_line_fefo_guarded(
  uuid, uuid, uuid, integer, text, uuid, text, text, boolean, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_send_warehouse_transfer_line_fefo_guarded(
  uuid, uuid, uuid, integer, text, uuid, text, text, boolean, text) IS
  'FEFO-enforced wrapper over 068/088''s phoenix_send_warehouse_transfer_line '
  '(central -> institution transfer send). Picking a non-earliest-expiry '
  'batch requires p_fefo_override=true, a mandatory reason, and the '
  'inventory.fefo_override scoped permission (held by central_warehouse_'
  'manager here, the corridor''s actual sender); the choice, before/after '
  'batch identity and actor/time are recorded to audit_logs. Never '
  'substitutes a batch automatically — the caller still names the exact lot, '
  'this only gates whether that naming is allowed unexplained.';

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. inventory.fefo_override is now allowed=true for BOTH warehouse_officer
--    (097, institution-side dispatch) AND central_warehouse_manager (this
--    migration, central-side transfer send):
--      SELECT role FROM role_permission_defaults
--       WHERE permission_key='inventory.fefo_override' AND allowed=true;
--      -- => warehouse_officer, central_warehouse_manager
-- 2. phoenix_send_warehouse_transfer_line (068/088) is completely untouched —
--    same source text as before this migration.
-- ============================================================================
-- ROLLBACK: DROP FUNCTION public.phoenix_send_warehouse_transfer_line_fefo_
--   guarded(uuid, uuid, uuid, integer, text, uuid, text, text, boolean, text);
--   DELETE FROM role_permission_defaults WHERE permission_key=
--   'inventory.fefo_override' AND role='central_warehouse_manager'; — 068/088's
--   own RPC is untouched throughout, so plain (unguarded) send keeps working
--   exactly as before.
-- ============================================================================
