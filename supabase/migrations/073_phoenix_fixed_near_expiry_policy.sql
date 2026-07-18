-- 073_phoenix_fixed_near_expiry_policy.sql
-- MANUAL APPLY ONLY. NOT APPLIED BY THIS PR.
--
-- Contract:
--   * Near-expiry is one platform policy: exactly 270 days (nine months).
--   * The public RPC signature remains unchanged for rolling-client safety.
--   * An omitted/NULL legacy argument is normalized to 270.
--   * Any explicit non-270 value fails closed, including service_role/direct SQL.
--   * Existing threshold rows are normalized in-transaction; no stock, alert,
--     auth, audit-history, or application ledger row is deleted.
--
-- This migration intentionally hardens the server after the frontend began
-- sending 270 unconditionally. It does not recompute alert projections; the
-- established on-demand recompute RPC refreshes them under its normal scoped
-- authorization and audit contract.

begin;

-- ============================================================================
-- 0. PRECONDITIONS — fail before changing anything
-- ============================================================================
DO $pre$
BEGIN
  IF to_regclass('public.inventory_signal_thresholds') IS NULL
     OR to_regclass('public.inventory_alerts') IS NULL THEN
    RAISE EXCEPTION 'ABORT 073: migration 072 inventory-intelligence tables are absent.';
  END IF;

  IF to_regprocedure(
       'public.phoenix_upsert_inventory_threshold(uuid,text,uuid,text,text,integer,integer,integer,boolean)'
     ) IS NULL
     OR to_regprocedure('public.phoenix_inventory_threshold_guard()') IS NULL THEN
    RAISE EXCEPTION 'ABORT 073: migration 072 threshold functions are absent.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute a
    WHERE a.attrelid = 'public.inventory_signal_thresholds'::regclass
      AND a.attname = 'near_expiry_days'
      AND a.atttypid = 'integer'::regtype
      AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'ABORT 073: inventory_signal_thresholds.near_expiry_days is absent or not integer.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.inventory_signal_thresholds'::regclass
      AND c.conname = 'inventory_thresholds_near_expiry_days_chk'
      AND c.contype = 'c'
  ) THEN
    RAISE EXCEPTION 'ABORT 073: the reviewed 072 near-expiry constraint is absent.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = 'public.inventory_signal_thresholds'::regclass
      AND t.tgname = 'inventory_threshold_guard'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'ABORT 073: inventory_threshold_guard trigger is absent.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.inventory_signal_thresholds t
    WHERE t.scope_id IS NOT NULL
      AND public.phoenix_inventory_scope_org(t.scope_kind, t.scope_id)
          IS DISTINCT FROM t.organization_id
  ) THEN
    RAISE EXCEPTION 'ABORT 073: an existing threshold has an orphaned or cross-organization scope; repair it before policy normalization.';
  END IF;

  RAISE NOTICE '073 preconditions OK.';
END
$pre$;

-- ============================================================================
-- 1. EVERY-WRITER GUARD — legacy NULL becomes 270; other values are rejected
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_inventory_threshold_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.scope_kind NOT IN ('warehouse', 'outlet') THEN
    RAISE EXCEPTION 'guard_072_invalid_scope_kind';
  END IF;

  IF NEW.scope_id IS NOT NULL
     AND public.phoenix_inventory_scope_org(NEW.scope_kind, NEW.scope_id)
         IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'guard_072_threshold_scope_not_in_organization';
  END IF;

  -- Rolling-client compatibility: 072/older clients may still send NULL.
  IF NEW.near_expiry_days IS NULL THEN
    NEW.near_expiry_days := 270;
  ELSIF NEW.near_expiry_days <> 270 THEN
    RAISE EXCEPTION 'near_expiry_days_fixed_270';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_inventory_threshold_guard()
  FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 2. NORMALIZE EXISTING CONFIG + PIN THE COLUMN CONTRACT
-- ============================================================================
DO $normalize$
DECLARE
  v_normalized integer := 0;
BEGIN
  UPDATE public.inventory_signal_thresholds
  SET near_expiry_days = 270,
      updated_at = now()
  WHERE near_expiry_days IS DISTINCT FROM 270;

  GET DIAGNOSTICS v_normalized = ROW_COUNT;
  RAISE NOTICE '073 normalized % inventory threshold row(s) to 270 days.', v_normalized;
END
$normalize$;

ALTER TABLE public.inventory_signal_thresholds
  ALTER COLUMN near_expiry_days SET DEFAULT 270,
  ALTER COLUMN near_expiry_days SET NOT NULL;

ALTER TABLE public.inventory_signal_thresholds
  DROP CONSTRAINT inventory_thresholds_near_expiry_days_chk;

ALTER TABLE public.inventory_signal_thresholds
  ADD CONSTRAINT inventory_thresholds_near_expiry_days_chk
  CHECK (near_expiry_days = 270) NOT VALID;

ALTER TABLE public.inventory_signal_thresholds
  VALIDATE CONSTRAINT inventory_thresholds_near_expiry_days_chk;

-- ============================================================================
-- 3. CLIENT RPC — same signature; fixed policy + accurate audit payload
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_upsert_inventory_threshold(
  p_organization_id  uuid,
  p_scope_kind       text,
  p_scope_id         uuid,
  p_scientific_name  text,
  p_national_code    text DEFAULT NULL,
  p_reorder_point    integer DEFAULT NULL,
  p_target_max       integer DEFAULT NULL,
  p_near_expiry_days integer DEFAULT 270,
  p_is_active        boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_name  text := NULLIF(btrim(p_scientific_name), '');
  v_code  text := NULLIF(btrim(p_national_code), '');
  v_id    uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_scope_kind NOT IN ('warehouse', 'outlet') THEN RAISE EXCEPTION 'invalid_scope_kind'; END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'scientific_name_required'; END IF;

  -- NULL is accepted only as a rolling-client compatibility alias for 270.
  IF p_near_expiry_days IS NOT NULL AND p_near_expiry_days <> 270 THEN
    RAISE EXCEPTION 'near_expiry_days_fixed_270';
  END IF;

  IF p_scope_id IS NOT NULL
     AND public.phoenix_inventory_scope_org(p_scope_kind, p_scope_id)
         IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'scope_not_in_organization';
  END IF;

  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR (p_scope_id IS NOT NULL AND p_scope_kind = 'warehouse'
        AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_thresholds', p_organization_id, p_scope_id, NULL))
    OR (p_scope_id IS NOT NULL AND p_scope_kind = 'outlet'
        AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_thresholds', p_organization_id, NULL, p_scope_id))
    OR (p_scope_id IS NULL AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_thresholds', p_organization_id, NULL, NULL))
  ) THEN
    RAISE EXCEPTION 'not_authorized_inventory_manage_thresholds';
  END IF;

  INSERT INTO public.inventory_signal_thresholds AS t (
    organization_id, scope_kind, scope_id, scientific_name, national_code,
    reorder_point, target_max, near_expiry_days, is_active, created_by, updated_by
  ) VALUES (
    p_organization_id, p_scope_kind, p_scope_id, v_name, v_code,
    p_reorder_point, p_target_max, 270, COALESCE(p_is_active, true), v_actor, v_actor
  )
  ON CONFLICT (organization_id, scope_kind,
               COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
               lower(scientific_name), COALESCE(national_code, ''))
  DO UPDATE SET
    reorder_point = EXCLUDED.reorder_point,
    target_max = EXCLUDED.target_max,
    near_expiry_days = 270,
    is_active = EXCLUDED.is_active,
    updated_by = v_actor,
    updated_at = now()
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type,
    entity_id, entity_label, payload
  ) VALUES (
    p_organization_id, v_actor, public.phoenix_my_role(), 'update',
    'inventory_signal_threshold', v_id, p_scope_kind || ':' || v_name,
    jsonb_build_object(
      'reorder_point', p_reorder_point,
      'target_max', p_target_max,
      'near_expiry_days', 270,
      'is_active', COALESCE(p_is_active, true)
    )
  );

  RETURN jsonb_build_object(
    'id', v_id,
    'organization_id', p_organization_id,
    'scope_kind', p_scope_kind
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_upsert_inventory_threshold(
  uuid, text, uuid, text, text, integer, integer, integer, boolean
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_upsert_inventory_threshold(
  uuid, text, uuid, text, text, integer, integer, integer, boolean
) TO authenticated;

-- ============================================================================
-- 4. LIVE POST-CONDITIONS — any mismatch aborts the whole transaction
-- ============================================================================
DO $verify$
DECLARE
  v_default text;
  v_constraint text;
  v_upsert text;
  v_guard text;
BEGIN
  SELECT pg_get_expr(d.adbin, d.adrelid)
  INTO v_default
  FROM pg_attribute a
  JOIN pg_attrdef d
    ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.inventory_signal_thresholds'::regclass
    AND a.attname = 'near_expiry_days'
    AND a.attnotnull;

  IF v_default IS NULL OR v_default NOT IN ('270', '270::integer') THEN
    RAISE EXCEPTION 'VERIFY FAILED (073): near_expiry_days is not NOT NULL DEFAULT 270 (got %).', v_default;
  END IF;

  SELECT pg_get_constraintdef(c.oid)
  INTO v_constraint
  FROM pg_constraint c
  WHERE c.conrelid = 'public.inventory_signal_thresholds'::regclass
    AND c.conname = 'inventory_thresholds_near_expiry_days_chk'
    AND c.contype = 'c'
    AND c.convalidated;

  IF v_constraint IS NULL
     OR replace(replace(v_constraint, '(', ''), ')', '') NOT LIKE '%near_expiry_days = 270%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (073): fixed-270 CHECK is absent (%).', v_constraint;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.inventory_signal_thresholds
    WHERE near_expiry_days IS DISTINCT FROM 270
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (073): a threshold row is not fixed at 270.';
  END IF;

  SELECT pg_get_functiondef(
    'public.phoenix_upsert_inventory_threshold(uuid,text,uuid,text,text,integer,integer,integer,boolean)'::regprocedure
  ) INTO v_upsert;
  IF v_upsert NOT LIKE '%near_expiry_days_fixed_270%'
     OR v_upsert NOT LIKE '%p_near_expiry_days integer DEFAULT 270%'
     OR v_upsert NOT LIKE '%''near_expiry_days'', 270%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (073): upsert RPC does not pin and audit 270.';
  END IF;

  SELECT pg_get_functiondef('public.phoenix_inventory_threshold_guard()'::regprocedure)
  INTO v_guard;
  IF v_guard NOT LIKE '%NEW.near_expiry_days := 270%'
     OR v_guard NOT LIKE '%NEW.near_expiry_days <> 270%'
     OR v_guard NOT LIKE '%near_expiry_days_fixed_270%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (073): every-writer trigger guard is incomplete.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid = 'public.phoenix_inventory_threshold_guard()'::regprocedure
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (073): trigger guard security/search_path changed.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid = 'public.phoenix_upsert_inventory_threshold(uuid,text,uuid,text,text,integer,integer,integer,boolean)'::regprocedure
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (073): threshold upsert security/search_path changed.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.inventory_signal_thresholds'::regclass
      AND t.tgname = 'inventory_threshold_guard'
      AND t.tgenabled IN ('O', 'A')
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (073): inventory_threshold_guard is not enabled.';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.phoenix_upsert_inventory_threshold(uuid,text,uuid,text,text,integer,integer,integer,boolean)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.phoenix_upsert_inventory_threshold(uuid,text,uuid,text,text,integer,integer,integer,boolean)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.phoenix_inventory_threshold_guard()', 'EXECUTE'
     )
     OR has_function_privilege(
       'anon', 'public.phoenix_inventory_threshold_guard()', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (073): function ACL boundary is incorrect.';
  END IF;

  IF has_table_privilege('authenticated', 'public.inventory_signal_thresholds', 'INSERT')
     OR has_table_privilege('authenticated', 'public.inventory_signal_thresholds', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.inventory_signal_thresholds', 'DELETE')
     OR has_table_privilege('anon', 'public.inventory_signal_thresholds', 'SELECT')
     OR has_table_privilege('anon', 'public.inventory_signal_thresholds', 'INSERT')
     OR has_table_privilege('anon', 'public.inventory_signal_thresholds', 'UPDATE')
     OR has_table_privilege('anon', 'public.inventory_signal_thresholds', 'DELETE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (073): table ACL boundary changed.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.inventory_signal_thresholds'::regclass
      AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (073): threshold RLS is not enabled.';
  END IF;

  RAISE NOTICE '073 verified: near-expiry is fixed at 270 days in the column, CHECK, every-writer trigger and authenticated RPC; NULL legacy calls normalize safely; explicit overrides fail closed.';
END
$verify$;

commit;
