-- =============================================================================
-- MediStock Phoenix V2 — Migration 075: Supply Route Management RPCs (additive)
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard → SQL Editor after reading this file in full.
-- Apply ONLY after migration 074 is confirmed applied and healthy.
--
-- PHASE-B-NETWORK-CONTRACTS-SUPPLY-ROUTES-075-A
--
-- WHAT THIS MIGRATION DOES
--   Adds the only write path for public.warehouse_supply_routes (066), which
--   REVOKED client INSERT/UPDATE/DELETE and shipped read-only. Three contracts:
--     • phoenix_create_supply_route      — central → institution supply link
--     • phoenix_update_supply_route      — change priority / notes
--     • phoenix_set_supply_route_active  — activate / deactivate (never DELETE)
--
-- ROUTE MODEL (mirrors 066's constraints, does not weaken them)
--   source is a CENTRAL warehouse, target is an INSTITUTION warehouse — enforced
--   structurally by 066's composite FKs and re-verified here for a clean error.
--   priority 1 = primary (at most one active primary per target, index-enforced),
--   priority >= 2 = fallbacks (unlimited).
--
-- AUTHORITY
--   super_admin ONLY — supply routes are global network structure. The
--   supply_routes.manage permission key (066) exists for a future scoped
--   widening; this contract does not rely on it and does not grant it to anyone.
--
-- SAFETY
--   • Additive only; 066's table/indexes/RLS are untouched.
--   • Single transaction; fail-closed preconditions.
--   • SECURITY DEFINER + fixed search_path = public, pg_temp.
--   • REVOKE ALL FROM PUBLIC, anon; GRANT EXECUTE TO authenticated only.
--   • No RBAC enforcement toggled, no Auth object touched, no data seeded.
--
-- ROLLBACK
--   DROP FUNCTION public.phoenix_set_supply_route_active(uuid, boolean, text);
--   DROP FUNCTION public.phoenix_update_supply_route(uuid, integer, text);
--   DROP FUNCTION public.phoenix_create_supply_route(uuid, uuid, integer, text);
-- =============================================================================

begin;

DO $guard$
BEGIN
  IF to_regclass('public.warehouse_supply_routes') IS NULL THEN
    RAISE EXCEPTION 'ABORT 075: public.warehouse_supply_routes is absent — apply 066 first.';
  END IF;
  IF to_regclass('public.warehouses') IS NULL OR to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'ABORT 075: warehouses/audit_logs absent — apply 060/001 first.';
  END IF;
  IF to_regprocedure('public.phoenix_my_role()') IS NULL THEN
    RAISE EXCEPTION 'ABORT 075: public.phoenix_my_role() is absent.';
  END IF;
END;
$guard$;

-- ── helper: assert the two endpoints are the right kind and active ───────────
-- Kept local by prefixing; validates existence + kind + active status so the
-- error is a clean domain error rather than a raw FK/constraint violation.
CREATE OR REPLACE FUNCTION public.phoenix_supply_route_assert_endpoints(
  p_source_warehouse_id uuid,
  p_target_warehouse_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_src_kind text; v_src_status text;
  v_tgt_kind text; v_tgt_status text;
BEGIN
  IF p_source_warehouse_id = p_target_warehouse_id THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_SELF: a warehouse cannot supply itself' USING ERRCODE = '23514';
  END IF;
  SELECT warehouse_kind, status INTO v_src_kind, v_src_status FROM public.warehouses WHERE id = p_source_warehouse_id;
  SELECT warehouse_kind, status INTO v_tgt_kind, v_tgt_status FROM public.warehouses WHERE id = p_target_warehouse_id;
  IF v_src_kind IS NULL THEN RAISE EXCEPTION 'SUPPLY_ROUTE_SOURCE_NOT_FOUND: %', p_source_warehouse_id USING ERRCODE = '23503'; END IF;
  IF v_tgt_kind IS NULL THEN RAISE EXCEPTION 'SUPPLY_ROUTE_TARGET_NOT_FOUND: %', p_target_warehouse_id USING ERRCODE = '23503'; END IF;
  IF v_src_kind <> 'central' THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_SOURCE_NOT_CENTRAL: source % is %', p_source_warehouse_id, v_src_kind USING ERRCODE = '23514';
  END IF;
  IF v_tgt_kind <> 'institution' THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_TARGET_NOT_INSTITUTION: target % is %', p_target_warehouse_id, v_tgt_kind USING ERRCODE = '23514';
  END IF;
  IF v_src_status <> 'active' OR v_tgt_status <> 'active' THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_ENDPOINT_INACTIVE: both endpoints must be active' USING ERRCODE = '23514';
  END IF;
END;
$$;

-- ── 1. CREATE ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_create_supply_route(
  p_source_warehouse_id uuid,
  p_target_warehouse_id uuid,
  p_priority integer DEFAULT 1,
  p_notes    text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role  text := public.phoenix_my_role();
  v_actor uuid := auth.uid();
  v_priority integer := coalesce(p_priority, 1);
  v_id    uuid;
BEGIN
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_SUPPLY_ROUTE: only super_admin may manage supply routes' USING ERRCODE = '42501';
  END IF;
  IF v_priority < 1 THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_PRIORITY_INVALID: priority must be >= 1' USING ERRCODE = '23514';
  END IF;
  PERFORM public.phoenix_supply_route_assert_endpoints(p_source_warehouse_id, p_target_warehouse_id);

  -- Serialize per target so the single active-primary slot and the active pair
  -- cannot be double-claimed by a concurrent create (indexes are the hard
  -- guarantee; this makes the race an ordered wait and a clean message).
  PERFORM pg_advisory_xact_lock(hashtext('phoenix_supply_route:' || p_target_warehouse_id::text));

  IF EXISTS (
    SELECT 1 FROM public.warehouse_supply_routes
    WHERE source_warehouse_id = p_source_warehouse_id AND target_warehouse_id = p_target_warehouse_id AND is_active
  ) THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_EXISTS: an active route already links this source and target' USING ERRCODE = '23505';
  END IF;
  IF v_priority = 1 AND EXISTS (
    SELECT 1 FROM public.warehouse_supply_routes
    WHERE target_warehouse_id = p_target_warehouse_id AND is_active AND priority = 1
  ) THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_PRIMARY_EXISTS: target % already has an active primary route (use priority >= 2)', p_target_warehouse_id USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.warehouse_supply_routes
    (source_warehouse_id, target_warehouse_id, priority, is_active, notes, created_by)
  VALUES (p_source_warehouse_id, p_target_warehouse_id, v_priority, true,
          nullif(btrim(coalesce(p_notes, '')), ''), v_actor)
  RETURNING id INTO v_id;

  INSERT INTO audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (NULL, v_actor, v_role, 'create', 'warehouse_supply_route', v_id, NULL,
          jsonb_build_object('source_warehouse_id', p_source_warehouse_id,
                             'target_warehouse_id', p_target_warehouse_id, 'priority', v_priority));

  RETURN jsonb_build_object('ok', true, 'supply_route_id', v_id, 'priority', v_priority);
END;
$$;

-- ── 2. UPDATE (priority / notes) ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_update_supply_route(
  p_route_id uuid,
  p_priority integer DEFAULT NULL,
  p_notes    text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role   text := public.phoenix_my_role();
  v_actor  uuid := auth.uid();
  v_target uuid; v_active boolean; v_cur_priority integer;
  v_new_priority integer;
BEGIN
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_SUPPLY_ROUTE: only super_admin may manage supply routes' USING ERRCODE = '42501';
  END IF;

  SELECT target_warehouse_id, is_active, priority INTO v_target, v_active, v_cur_priority
  FROM public.warehouse_supply_routes WHERE id = p_route_id FOR UPDATE;
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_NOT_FOUND: %', p_route_id USING ERRCODE = '23503';
  END IF;

  v_new_priority := coalesce(p_priority, v_cur_priority);
  IF v_new_priority < 1 THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_PRIORITY_INVALID: priority must be >= 1' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('phoenix_supply_route:' || v_target::text));
  IF v_active AND v_new_priority = 1 AND v_cur_priority <> 1 AND EXISTS (
    SELECT 1 FROM public.warehouse_supply_routes
    WHERE target_warehouse_id = v_target AND is_active AND priority = 1 AND id <> p_route_id
  ) THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_PRIMARY_EXISTS: target % already has an active primary route', v_target USING ERRCODE = '23505';
  END IF;

  UPDATE public.warehouse_supply_routes
  SET priority = v_new_priority,
      notes    = CASE WHEN p_notes IS NULL THEN notes ELSE nullif(btrim(p_notes), '') END,
      updated_at = now()
  WHERE id = p_route_id;

  INSERT INTO audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (NULL, v_actor, v_role, 'update', 'warehouse_supply_route', p_route_id, NULL,
          jsonb_build_object('priority_from', v_cur_priority, 'priority_to', v_new_priority,
                             'notes_changed', (p_notes IS NOT NULL)));

  RETURN jsonb_build_object('ok', true, 'supply_route_id', p_route_id, 'priority', v_new_priority);
END;
$$;

-- ── 3. ACTIVATE / DEACTIVATE ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_set_supply_route_active(
  p_route_id uuid,
  p_active   boolean,
  p_reason   text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role   text := public.phoenix_my_role();
  v_actor  uuid := auth.uid();
  v_source uuid; v_target uuid; v_priority integer; v_was_active boolean;
BEGIN
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_SUPPLY_ROUTE: only super_admin may manage supply routes' USING ERRCODE = '42501';
  END IF;

  SELECT source_warehouse_id, target_warehouse_id, priority, is_active
    INTO v_source, v_target, v_priority, v_was_active
  FROM public.warehouse_supply_routes WHERE id = p_route_id FOR UPDATE;
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_NOT_FOUND: %', p_route_id USING ERRCODE = '23503';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('phoenix_supply_route:' || v_target::text));

  IF p_active THEN
    -- Reactivation must re-verify the endpoints and not collide with a live pair
    -- or a live primary — the partial unique indexes only see active rows.
    PERFORM public.phoenix_supply_route_assert_endpoints(v_source, v_target);
    IF EXISTS (
      SELECT 1 FROM public.warehouse_supply_routes
      WHERE source_warehouse_id = v_source AND target_warehouse_id = v_target AND is_active AND id <> p_route_id
    ) THEN
      RAISE EXCEPTION 'SUPPLY_ROUTE_EXISTS: an active route already links this source and target' USING ERRCODE = '23505';
    END IF;
    IF v_priority = 1 AND EXISTS (
      SELECT 1 FROM public.warehouse_supply_routes
      WHERE target_warehouse_id = v_target AND is_active AND priority = 1 AND id <> p_route_id
    ) THEN
      RAISE EXCEPTION 'SUPPLY_ROUTE_PRIMARY_EXISTS: target % already has an active primary route', v_target USING ERRCODE = '23505';
    END IF;
  END IF;

  UPDATE public.warehouse_supply_routes
  SET is_active = p_active, updated_at = now()
  WHERE id = p_route_id;

  INSERT INTO audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (NULL, v_actor, v_role, 'update', 'warehouse_supply_route', p_route_id, NULL,
          jsonb_build_object('active_from', v_was_active, 'active_to', p_active,
                             'reason', nullif(btrim(coalesce(p_reason, '')), '')));

  RETURN jsonb_build_object('ok', true, 'supply_route_id', p_route_id, 'is_active', p_active);
END;
$$;

-- ── ACL ──────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.phoenix_supply_route_assert_endpoints(uuid, uuid)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.phoenix_create_supply_route(uuid, uuid, integer, text)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.phoenix_update_supply_route(uuid, integer, text)         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.phoenix_set_supply_route_active(uuid, boolean, text)     FROM PUBLIC, anon;
-- The endpoint assert is an internal helper: no direct client execution at all.
GRANT EXECUTE ON FUNCTION public.phoenix_create_supply_route(uuid, uuid, integer, text)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_update_supply_route(uuid, integer, text)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_set_supply_route_active(uuid, boolean, text)     TO authenticated;

DO $verify$
BEGIN
  IF to_regprocedure('public.phoenix_create_supply_route(uuid, uuid, integer, text)') IS NULL
     OR to_regprocedure('public.phoenix_update_supply_route(uuid, integer, text)') IS NULL
     OR to_regprocedure('public.phoenix_set_supply_route_active(uuid, boolean, text)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (075): a supply-route RPC is missing.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name IN ('phoenix_create_supply_route', 'phoenix_update_supply_route',
                           'phoenix_set_supply_route_active', 'phoenix_supply_route_assert_endpoints')
      AND grantee IN ('PUBLIC', 'anon')
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (075): a supply-route function is executable by PUBLIC/anon.';
  END IF;
END;
$verify$;

commit;
