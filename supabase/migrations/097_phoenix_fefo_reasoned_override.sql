-- ============================================================================
-- FEFO-REASONED-OVERRIDE-097-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 096.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- 072 already computes FEFO ordering (phoenix_inventory_fefo_batches/_pick),
-- but nothing ENFORCES it: 070's phoenix_add_dispatch_line lets the caller
-- name ANY warehouse_stock_id for the material, with no comparison against
-- the FEFO-earliest lot at all. Phase 2 contract: "no override by default;
-- requires a scoped permission and a mandatory reason, choice of the
-- alternate batch, and before/after + actor/time in audit. Never changes the
-- source or batch automatically."
--
-- NEW RPC, not a redefinition of 070's phoenix_add_dispatch_line (same
-- "distinctly-named guarded contract" discipline as 078/086): the legacy RPC
-- stays reachable during a parity window and is delegated to for the actual
-- INSERT, so RBAC/audit/insert logic is not forked.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure('public.phoenix_add_dispatch_line(uuid,uuid,integer)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 070 phoenix_add_dispatch_line is missing';
  END IF;
  IF to_regprocedure(
    'public.phoenix_inventory_fefo_batches(uuid,text,uuid,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 072 phoenix_inventory_fefo_batches is missing';
  END IF;
END;
$precond$;

-- ── A. New scoped permission — independent of warehouse_dispatch.edit_draft ─

INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous)
VALUES
  ('inventory.fefo_override', 'inventory', 'fefo_override',
   'Override FEFO batch selection with a reason', 'تجاوز اختيار الدفعة وفق FEFO بسبب مبرر', true)
ON CONFLICT (key) DO NOTHING;

-- Granted to warehouse_officer, NOT central_warehouse_manager: the person who
-- physically builds a dispatch (holding warehouse_dispatch.edit_draft, per
-- 061/070) is the one who can ever actually reach this RPC — auth.uid() is
-- the same caller for both the base edit_draft check (delegated to 070) and
-- this override check, so granting the override key to a role that does NOT
-- also hold edit_draft would make the override permanently unreachable.
-- central_warehouse_manager keeps its oversight role via the 098 variance-
-- approval policy instead, a genuinely separate concern.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
VALUES
  ('warehouse_officer', 'inventory.fefo_override', true)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ── B. Guarded add-line: FEFO by default, override requires permission + reason

CREATE OR REPLACE FUNCTION public.phoenix_add_dispatch_line_fefo_guarded(
  p_dispatch_id        uuid,
  p_warehouse_stock_id uuid,
  p_quantity           integer,
  p_fefo_override      boolean DEFAULT false,
  p_override_reason    text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fefo$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dispatch     public.warehouse_dispatches%ROWTYPE;
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
  IF p_dispatch_id IS NULL OR p_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_id_and_stock_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_dispatch FROM public.warehouse_dispatches WHERE id = p_dispatch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_stock FROM public.warehouse_stock WHERE id = p_warehouse_stock_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- The FEFO-earliest lot for the SAME material at the SAME warehouse — the
  -- default, no-override expectation.
  SELECT b.stock_id, b.batch_number, b.expiry_date
    INTO v_fefo_stock, v_fefo_batch, v_fefo_expiry
    FROM public.phoenix_inventory_fefo_batches(
           v_dispatch.organization_id, 'warehouse', v_dispatch.warehouse_id,
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
      v_actor, 'inventory.fefo_override', v_dispatch.organization_id, v_dispatch.warehouse_id, NULL
    ) THEN
      RAISE EXCEPTION 'forbidden_fefo_override' USING ERRCODE = '42501';
    END IF;

    SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

    -- Delegate the actual insert to 070's unmodified RPC — single write path.
    v_result := public.phoenix_add_dispatch_line(p_dispatch_id, p_warehouse_stock_id, p_quantity);

    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_dispatch.organization_id, v_actor, v_actor_role,
      'inventory.fefo_overridden', 'warehouse_dispatch_lines',
      NULLIF(v_result ->> 'dispatch_line_id', '')::uuid, v_stock.scientific_name,
      jsonb_build_object(
        'dispatch_id', p_dispatch_id,
        'before_fefo_stock_id', v_fefo_stock, 'before_fefo_batch', v_fefo_batch, 'before_fefo_expiry', v_fefo_expiry,
        'after_chosen_stock_id', p_warehouse_stock_id, 'after_chosen_batch', v_stock.batch_number, 'after_chosen_expiry', v_stock.expiry_date,
        'reason', v_reason, 'quantity', p_quantity
      )
    );

    RETURN v_result || jsonb_build_object('fefo_override_applied', true);
  END IF;

  -- FEFO-compliant (or no other batch exists to compare against) — plain
  -- delegation, no override machinery, no audit noise.
  RETURN public.phoenix_add_dispatch_line(p_dispatch_id, p_warehouse_stock_id, p_quantity)
         || jsonb_build_object('fefo_override_applied', false);
END;
$fefo$;

REVOKE ALL ON FUNCTION public.phoenix_add_dispatch_line_fefo_guarded(uuid, uuid, integer, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_add_dispatch_line_fefo_guarded(uuid, uuid, integer, boolean, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_add_dispatch_line_fefo_guarded(uuid, uuid, integer, boolean, text) IS
  'FEFO-enforced wrapper over 070''s phoenix_add_dispatch_line. Picking a '
  'non-earliest-expiry batch requires p_fefo_override=true, a mandatory '
  'reason, and the inventory.fefo_override scoped permission; the choice, '
  'before/after batch identity and actor/time are recorded to audit_logs. '
  'Never substitutes a batch automatically — the caller still names the '
  'exact lot, this only gates whether that naming is allowed unexplained.';

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. inventory.fefo_override exists in permission_keys, is_dangerous=true.
-- 2. Only warehouse_officer holds it by default (the actor who builds a
--    dispatch and thus reaches this RPC — see section A's reasoning above;
--    102 later extends this SAME key to central_warehouse_manager for the
--    068 transfer-send corridor, a distinct actor at a distinct RPC):
--    SELECT role FROM role_permission_defaults
--     WHERE permission_key='inventory.fefo_override' AND allowed=true;
-- 3. phoenix_add_dispatch_line (070) is completely untouched — same source
--    text as before this migration.
-- ============================================================================
-- ROLLBACK: DROP FUNCTION public.phoenix_add_dispatch_line_fefo_guarded(
--   uuid, uuid, integer, boolean, text); DELETE FROM role_permission_defaults
--   WHERE permission_key='inventory.fefo_override'; DELETE FROM
--   permission_keys WHERE key='inventory.fefo_override'; — 070's own RPC is
-- untouched throughout, so plain (unguarded) dispatch-line creation keeps
-- working exactly as before.
-- ============================================================================
