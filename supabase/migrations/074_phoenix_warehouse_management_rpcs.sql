-- =============================================================================
-- MediStock Phoenix V2 — Migration 074: Warehouse Master Management RPCs (additive)
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard → SQL Editor after reading this file in full.
-- Apply ONLY after migration 073 is confirmed applied and healthy.
--
-- PHASE-B-NETWORK-CONTRACTS-WAREHOUSE-074-A
--
-- WHAT THIS MIGRATION DOES
--   Adds three SECURITY DEFINER write contracts for the `warehouses` master
--   record so the Network screen never has to issue raw client DML:
--     • phoenix_create_warehouse       — create a central or institution warehouse
--     • phoenix_update_warehouse       — rename / re-code an existing warehouse
--     • phoenix_set_warehouse_active   — activate / deactivate (never DELETE)
--
-- WHY AN RPC WHEN 060 ALREADY HAS RLS WRITE POLICIES
--   060's wh_insert_perm / wh_update_perm remain in force and unchanged. These
--   RPCs add three things a bare INSERT/UPDATE cannot: (1) a mandatory
--   audit_logs row for every human change, (2) atomic one-active-main-per-org
--   arbitration under an advisory lock, and (3) a single validated server
--   contract with clean, distinct error codes. They are strictly additive.
--
-- AUTHORITY (deliberately narrow)
--   Structure management is super_admin ONLY, per the approved model. A
--   central_warehouse_manager manages OPERATIONS inside an assigned warehouse
--   (later migrations), never the master record. Institution-scoped renaming by
--   institution_admin is intentionally NOT granted here; it can be added later
--   as an explicit, reviewed widening rather than assumed now.
--
-- SAFETY
--   • Additive only. No table/column/policy from 001–073 is dropped or altered.
--   • Single transaction. Fail-closed preconditions abort the whole apply.
--   • SECURITY DEFINER + fixed search_path = public, pg_temp.
--   • REVOKE ALL FROM PUBLIC, anon; GRANT EXECUTE TO authenticated only.
--   • No RBAC enforcement is toggled. No Auth object is touched. No data seeded.
--
-- ROLLBACK
--   DROP FUNCTION public.phoenix_set_warehouse_active(uuid, boolean, text);
--   DROP FUNCTION public.phoenix_update_warehouse(uuid, text, text, text);
--   DROP FUNCTION public.phoenix_create_warehouse(uuid, text, text, text, text, boolean);
-- =============================================================================

begin;

-- ── Preconditions: fail closed if the world is not what this migration expects ─
DO $guard$
BEGIN
  IF to_regclass('public.warehouses') IS NULL THEN
    RAISE EXCEPTION 'ABORT 074: public.warehouses is absent — apply 060/066 first.';
  END IF;
  IF to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'ABORT 074: public.audit_logs is absent — apply 001 first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouses' AND column_name = 'warehouse_kind'
  ) THEN
    RAISE EXCEPTION 'ABORT 074: warehouses.warehouse_kind is absent — apply 066 first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouses' AND column_name IN ('is_main', 'code')
    GROUP BY table_name HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'ABORT 074: warehouses.is_main/code are absent — apply 060 first.';
  END IF;
  IF to_regprocedure('public.phoenix_my_role()') IS NULL THEN
    RAISE EXCEPTION 'ABORT 074: public.phoenix_my_role() is absent — apply 001/023 first.';
  END IF;
END;
$guard$;

-- ── 1. CREATE ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_create_warehouse(
  p_organization_id uuid,
  p_name            text,
  p_name_ar         text,
  p_warehouse_kind  text,
  p_code            text DEFAULT NULL,
  p_is_main         boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role  text := public.phoenix_my_role();
  v_actor uuid := auth.uid();
  v_name    text := btrim(coalesce(p_name, ''));
  v_name_ar text := btrim(coalesce(p_name_ar, ''));
  v_code    text := nullif(btrim(coalesce(p_code, '')), '');
  v_is_main boolean := coalesce(p_is_main, false);
  v_id    uuid;
BEGIN
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_WAREHOUSE_MANAGE: only super_admin may create warehouses' USING ERRCODE = '42501';
  END IF;
  IF p_warehouse_kind NOT IN ('central', 'institution') THEN
    RAISE EXCEPTION 'INVALID_WAREHOUSE_KIND: % (expected central|institution)', p_warehouse_kind USING ERRCODE = '23514';
  END IF;
  IF v_name = '' OR v_name_ar = '' THEN
    RAISE EXCEPTION 'WAREHOUSE_NAME_REQUIRED: name and name_ar must be non-empty' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id) THEN
    RAISE EXCEPTION 'ORGANIZATION_NOT_FOUND: %', p_organization_id USING ERRCODE = '23503';
  END IF;

  -- Serialize main-warehouse arbitration per org: the partial unique index
  -- warehouses_one_active_main_per_org_uniq is the hard guarantee, this advisory
  -- lock turns a concurrent race into an ordered wait and a clean error.
  IF v_is_main THEN
    PERFORM pg_advisory_xact_lock(hashtext('phoenix_warehouse_main:' || p_organization_id::text));
    IF EXISTS (
      SELECT 1 FROM public.warehouses w
      WHERE w.organization_id = p_organization_id AND w.is_main = true AND w.status = 'active'
    ) THEN
      RAISE EXCEPTION 'WAREHOUSE_MAIN_EXISTS: organization % already has an active main warehouse', p_organization_id USING ERRCODE = '23505';
    END IF;
  END IF;

  IF v_code IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.warehouses w
    WHERE w.organization_id = p_organization_id AND btrim(w.code) = v_code
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_CODE_EXISTS: code % already used in organization %', v_code, p_organization_id USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.warehouses (organization_id, name, name_ar, warehouse_kind, is_main, code, status)
  VALUES (p_organization_id, v_name, v_name_ar, p_warehouse_kind, v_is_main, v_code, 'active')
  RETURNING id INTO v_id;

  INSERT INTO audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (p_organization_id, v_actor, v_role, 'create', 'warehouse', v_id, v_name,
          jsonb_build_object('warehouse_kind', p_warehouse_kind, 'is_main', v_is_main, 'code', v_code));

  RETURN jsonb_build_object('ok', true, 'warehouse_id', v_id, 'warehouse_kind', p_warehouse_kind, 'is_main', v_is_main);
END;
$$;

-- ── 2. UPDATE (rename / re-code) ─────────────────────────────────────────────
-- NULL argument = leave unchanged. An empty-string p_code = clear the code to
-- NULL (absence is NULL, never a placeholder). Kind and organization are
-- immutable here by design.
CREATE OR REPLACE FUNCTION public.phoenix_update_warehouse(
  p_warehouse_id uuid,
  p_name    text DEFAULT NULL,
  p_name_ar text DEFAULT NULL,
  p_code    text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role   text := public.phoenix_my_role();
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_new_name    text;
  v_new_name_ar text;
  v_new_code    text;
  v_clear_code  boolean := (p_code IS NOT NULL AND btrim(p_code) = '');
BEGIN
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_WAREHOUSE_MANAGE: only super_admin may update warehouses' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_org FROM public.warehouses WHERE id = p_warehouse_id FOR UPDATE;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'WAREHOUSE_NOT_FOUND: %', p_warehouse_id USING ERRCODE = '23503';
  END IF;

  v_new_name    := CASE WHEN p_name    IS NULL THEN NULL ELSE btrim(p_name)    END;
  v_new_name_ar := CASE WHEN p_name_ar IS NULL THEN NULL ELSE btrim(p_name_ar) END;
  IF v_new_name    = '' THEN RAISE EXCEPTION 'WAREHOUSE_NAME_REQUIRED'    USING ERRCODE = '23514'; END IF;
  IF v_new_name_ar = '' THEN RAISE EXCEPTION 'WAREHOUSE_NAME_AR_REQUIRED' USING ERRCODE = '23514'; END IF;

  v_new_code := CASE WHEN v_clear_code THEN NULL
                     WHEN p_code IS NULL THEN NULL
                     ELSE nullif(btrim(p_code), '') END;
  IF v_new_code IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.warehouses w
    WHERE w.organization_id = v_org AND btrim(w.code) = v_new_code AND w.id <> p_warehouse_id
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_CODE_EXISTS: code % already used in organization %', v_new_code, v_org USING ERRCODE = '23505';
  END IF;

  UPDATE public.warehouses
  SET name    = COALESCE(v_new_name, name),
      name_ar = COALESCE(v_new_name_ar, name_ar),
      code    = CASE WHEN v_clear_code THEN NULL
                     WHEN p_code IS NULL THEN code
                     ELSE v_new_code END
  WHERE id = p_warehouse_id;

  INSERT INTO audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_org, v_actor, v_role, 'update', 'warehouse', p_warehouse_id, COALESCE(v_new_name, ''),
          jsonb_build_object('name', v_new_name, 'name_ar', v_new_name_ar,
                             'code_changed', (p_code IS NOT NULL), 'code_cleared', v_clear_code));

  RETURN jsonb_build_object('ok', true, 'warehouse_id', p_warehouse_id);
END;
$$;

-- ── 3. ACTIVATE / DEACTIVATE ─────────────────────────────────────────────────
-- Retirement stays status-based (never DELETE). Deactivating also clears is_main
-- so warehouses_main_requires_active_chk can never be violated. Archived
-- warehouses are out of scope here and must go through the archive_entity path.
CREATE OR REPLACE FUNCTION public.phoenix_set_warehouse_active(
  p_warehouse_id uuid,
  p_active       boolean,
  p_reason       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role    text := public.phoenix_my_role();
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_status  text;
  v_new     text := CASE WHEN p_active THEN 'active' ELSE 'inactive' END;
BEGIN
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_WAREHOUSE_MANAGE: only super_admin may (de)activate warehouses' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id, status INTO v_org, v_status
  FROM public.warehouses WHERE id = p_warehouse_id FOR UPDATE;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'WAREHOUSE_NOT_FOUND: %', p_warehouse_id USING ERRCODE = '23503';
  END IF;
  IF v_status = 'archived' THEN
    RAISE EXCEPTION 'WAREHOUSE_ARCHIVED: % is archived — use the archive path, not (de)activation', p_warehouse_id USING ERRCODE = '23514';
  END IF;

  UPDATE public.warehouses
  SET status  = v_new,
      is_main = CASE WHEN p_active THEN is_main ELSE false END
  WHERE id = p_warehouse_id;

  INSERT INTO audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_org, v_actor, v_role, 'update', 'warehouse', p_warehouse_id, NULL,
          jsonb_build_object('status_from', v_status, 'status_to', v_new,
                             'reason', nullif(btrim(coalesce(p_reason, '')), '')));

  RETURN jsonb_build_object('ok', true, 'warehouse_id', p_warehouse_id, 'status', v_new);
END;
$$;

-- ── ACL: never PUBLIC/anon; authenticated only (server re-checks super_admin) ──
REVOKE ALL ON FUNCTION public.phoenix_create_warehouse(uuid, text, text, text, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.phoenix_update_warehouse(uuid, text, text, text)               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.phoenix_set_warehouse_active(uuid, boolean, text)               FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_create_warehouse(uuid, text, text, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_update_warehouse(uuid, text, text, text)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_set_warehouse_active(uuid, boolean, text)               TO authenticated;

-- ── Postconditions: prove the three contracts exist with the intended ACL ─────
DO $verify$
BEGIN
  IF to_regprocedure('public.phoenix_create_warehouse(uuid, text, text, text, text, boolean)') IS NULL
     OR to_regprocedure('public.phoenix_update_warehouse(uuid, text, text, text)') IS NULL
     OR to_regprocedure('public.phoenix_set_warehouse_active(uuid, boolean, text)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (074): one or more warehouse-management RPCs is missing.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name IN ('phoenix_create_warehouse', 'phoenix_update_warehouse', 'phoenix_set_warehouse_active')
      AND grantee IN ('PUBLIC', 'anon')
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (074): a warehouse-management RPC is executable by PUBLIC/anon.';
  END IF;
END;
$verify$;

commit;
