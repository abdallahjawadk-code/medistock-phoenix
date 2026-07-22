-- ============================================================================
-- AVAILABILITY-CATALOGUE-VISIBILITY-084  (Blocker 3, step 2 of the staged cutover)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply AFTER 083. Additive: one new function, drops nothing, revokes nothing.
--
-- VERIFICATION STATUS: EXECUTED on a disposable PostgreSQL 18.4 cluster with
-- 001→084 in order via tools/pg-rig. See docs/phoenix/migration-084-*.md.
-- Production is 17.6.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 053 added item_availability's removed marker
-- (removed_at/removed_by/removal_reason) — pure CATALOGUE VISIBILITY, entirely
-- independent of physical stock (which 083 made canonical via
-- phoenix_available_stock). Until now the ONLY way to CLEAR that marker was a
-- side effect of phoenix_upsert_availability's reactivation branch, i.e. a
-- manual QUANTITY-writer path. That coupling is exactly what Blocker 3 retires:
-- reactivation forced an operator to re-type a quantity into a projection that
-- is no longer stock truth.
--
-- This migration decouples the two. phoenix_set_availability_visibility hides or
-- reactivates a catalogue row by touching ONLY the three removed-marker columns.
-- It NEVER reads or writes quantity or condition — those remain derived from the
-- canonical ledgers. ReactivateMaterialModal is rewired to call it, so the
-- manual quantity write disappears from that surface, and the later parity-gated
-- revoke (085, PREPARED only) can retire the manual quantity writers without
-- taking catalogue visibility down with them.
-- ============================================================================

BEGIN;

-- ── Apply-time fail-closed preconditions ────────────────────────────────────
DO $precond$
BEGIN
  IF to_regclass('public.item_availability') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: item_availability missing — apply the earlier chain first';
  END IF;
  -- The three removed-marker columns 053 added are what this function edits.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='item_availability' AND column_name='removed_at'
  ) THEN
    RAISE EXCEPTION 'precondition failed: item_availability.removed_at missing — apply 053 first';
  END IF;
  IF to_regprocedure('public.phoenix_profile_has_permission(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_profile_has_permission missing — apply the RBAC chain first';
  END IF;
END;
$precond$;

-- ── Catalogue-visibility setter ─────────────────────────────────────────────
-- Symmetric: p_hidden=true hides (marks removed), p_hidden=false reactivates
-- (clears the marker). Touches ONLY removed_at/removed_by/removal_reason plus
-- last_updated_by. Quantity and condition are never read for a decision and
-- never written — physical availability is 083's job, not this function's.
CREATE OR REPLACE FUNCTION public.phoenix_set_availability_visibility(
  p_item_availability_id uuid,
  p_hidden               boolean,
  p_reason               text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_role    text;
  v_my_org  uuid;
  v_row     public.item_availability%ROWTYPE;
  v_is_super boolean;
  v_reason  text := NULLIF(btrim(p_reason), '');
  v_now     timestamptz := now();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_item_availability_id IS NULL OR p_hidden IS NULL THEN
    RAISE EXCEPTION 'item_and_visibility_required' USING ERRCODE = '23514';
  END IF;

  SELECT role, organization_id INTO v_role, v_my_org
  FROM public.profiles WHERE id = v_actor AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;
  v_is_super := (v_role = 'super_admin');

  -- Lock the target row; scope authority to the org read FROM THE LOCKED ROW,
  -- never a caller-supplied value.
  SELECT * INTO v_row
  FROM public.item_availability WHERE id = p_item_availability_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'availability_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT v_is_super AND v_row.organization_id IS DISTINCT FROM v_my_org THEN
    RAISE EXCEPTION 'forbidden_cross_org' USING ERRCODE = '42501';
  END IF;
  -- Same permission key catalogue edits already require (035/053): reusing it
  -- keeps the RBAC contract unchanged — no new permission key is invented.
  IF NOT v_is_super
     AND NOT public.phoenix_profile_has_permission(v_actor, 'availability.update') THEN
    RAISE EXCEPTION 'forbidden_availability_update' USING ERRCODE = '42501';
  END IF;

  IF p_hidden THEN
    UPDATE public.item_availability
       SET removed_at      = v_now,
           removed_by      = v_actor,
           removal_reason  = COALESCE(v_reason, 'hidden_by_operator'),
           last_updated_by = v_actor
     WHERE id = v_row.id;
  ELSE
    UPDATE public.item_availability
       SET removed_at      = NULL,
           removed_by      = NULL,
           removal_reason  = NULL,
           last_updated_by = v_actor
     WHERE id = v_row.id;
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_row.organization_id, v_actor, v_role,
    CASE WHEN p_hidden THEN 'availability.visibility_hidden' ELSE 'availability.visibility_reactivated' END,
    'item_availability', v_row.id, v_row.scientific_name,
    jsonb_build_object('hidden', p_hidden, 'reason', v_reason, 'quantity_unchanged', v_row.quantity)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'item_availability_id', v_row.id,
    'hidden', p_hidden,
    'quantity', v_row.quantity   -- echoed for the client, NOT modified
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_set_availability_visibility(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_set_availability_visibility(uuid, boolean, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_set_availability_visibility(uuid, boolean, text) IS
  'AVAILABILITY-CATALOGUE-VISIBILITY-084: hide (p_hidden=true) or reactivate '
  '(p_hidden=false) an item_availability catalogue row by editing ONLY the '
  '053 removed marker. Never reads or writes quantity/condition — physical '
  'availability is derived (083 phoenix_available_stock). Org-scoped from the '
  'locked row; reuses the availability.update permission key (no new RBAC key).';

COMMIT;

-- ============================================================================
-- POST-CONDITIONS — run AFTER apply. Read-only.
-- ============================================================================
-- 1. least-granted + pinned:
--    SELECT prosecdef, proconfig FROM pg_proc WHERE proname='phoenix_set_availability_visibility';
--    SELECT has_function_privilege('authenticated','public.phoenix_set_availability_visibility(uuid, boolean, text)','EXECUTE'); -- t
--    SELECT has_function_privilege('anon','public.phoenix_set_availability_visibility(uuid, boolean, text)','EXECUTE');          -- f
--
-- ROLLBACK: DROP FUNCTION IF EXISTS public.phoenix_set_availability_visibility(uuid, boolean, text);
-- ============================================================================
