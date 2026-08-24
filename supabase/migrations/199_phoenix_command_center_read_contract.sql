-- ============================================================================
-- MEDISTOCK PHOENIX v2.1 — RAC-2 COMMAND CENTER READ CONTRACT — 199
--
-- Additive/forward-hardening migration for the future role-aware Command Center.
-- Historical migrations are immutable. M199 creates one new scoped read contract
-- and forward-redefines the two legacy dashboard-count RPCs only to enforce the
-- already-existing dashboard.view permission at the server boundary.
--
-- This migration does NOT seed permissions, change routing/UI, create trend
-- models, add a table/index, or mutate business data.
--
-- Security contract:
--   * actor identity is always auth.uid()
--   * dashboard.view is enforced server-side
--   * caller-supplied scope is requested scope, never authority
--   * unknown/inactive/unscoped/unauthorized identities fail closed
--   * legacy count RPC output shapes stay unchanged for authorized callers
--   * PUBLIC/anon receive no EXECUTE on the new contract
--   * SECURITY DEFINER search_path is public, pg_temp
--
-- Scope semantics for the new contract:
--   * global: super_admin only (no organization/resource requested)
--   * organization: condition/network summary within one authorized org
--   * warehouse: stock summary for exactly one authorized warehouse
--   * distribution_point: stock summary for exactly one authorized outlet
--
-- Near-expiry uses the existing platform policy fixed by M073: 270 days.
-- Trend-over-time is intentionally absent pending measured query evidence.
-- ============================================================================

BEGIN;

DO $precondition$
BEGIN
  IF to_regprocedure('public.phoenix_profile_has_scoped_permission(uuid,text,uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.phoenix_profile_has_permission(uuid,text)') IS NULL THEN
    RAISE EXCEPTION '199 PRECONDITION FAILED: canonical permission helper missing';
  END IF;
  IF to_regprocedure('public.phoenix_get_dashboard_condition_counts(uuid)') IS NULL
     OR to_regprocedure('public.phoenix_get_institution_condition_counts()') IS NULL THEN
    RAISE EXCEPTION '199 PRECONDITION FAILED: legacy dashboard count RPC missing';
  END IF;
  IF to_regclass('public.item_availability') IS NULL
     OR to_regclass('public.warehouse_stock') IS NULL
     OR to_regclass('public.outlet_stock') IS NULL
     OR to_regclass('public.organizations') IS NULL
     OR to_regclass('public.warehouses') IS NULL
     OR to_regclass('public.distribution_points') IS NULL THEN
    RAISE EXCEPTION '199 PRECONDITION FAILED: required inventory/topology relation missing';
  END IF;
  IF to_regprocedure('public.phoenix_command_center_read_contract(uuid,uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '199 PRECONDITION FAILED: command-center read contract already exists';
  END IF;
END;
$precondition$;

-- ============================================================================
-- A. FORWARD HARDEN THE TWO LEGACY DASHBOARD COUNT RPCs
--
-- The legacy functions predate dashboard.view enforcement. Their existing
-- response shapes and organization scoping are preserved. The only new behavior
-- is a server-side WHAT gate for non-super callers. health_center_manager keeps
-- the exact pre-M199 empty/zero behavior introduced by its existing hardening.
-- This closes direct-RPC bypass without editing historical migration 054.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_get_dashboard_condition_counts(
  p_org_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $legacy_dashboard_counts$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_my_org uuid;
  v_is_super boolean;
  v_effective_org uuid;
  v_available integer;
  v_low_stock integer;
  v_missing integer;
  v_near_expiry integer;
  v_surplus integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  v_role := public.phoenix_my_role();
  v_my_org := public.phoenix_my_org();
  v_is_super := COALESCE(v_role = 'super_admin', false);

  -- Preserve the existing HCM compatibility result exactly: no dashboard data,
  -- no existence oracle, and no privilege expansion.
  IF v_role = 'health_center_manager' THEN
    RETURN jsonb_build_object(
      'available', 0,
      'low_stock', 0,
      'missing', 0,
      'near_expiry', 0,
      'surplus', 0
    );
  END IF;

  IF NOT v_is_super
     AND NOT public.phoenix_profile_has_permission(v_actor, 'dashboard.view') THEN
    RAISE EXCEPTION 'dashboard_view_forbidden' USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_super AND v_my_org IS NULL THEN
    RETURN jsonb_build_object(
      'available', 0,
      'low_stock', 0,
      'missing', 0,
      'near_expiry', 0,
      'surplus', 0
    );
  END IF;

  v_effective_org := CASE WHEN v_is_super THEN p_org_id ELSE v_my_org END;

  SELECT
    count(*) FILTER (WHERE condition = 'available'),
    count(*) FILTER (WHERE condition = 'low_stock'),
    count(*) FILTER (WHERE condition = 'missing'),
    count(*) FILTER (WHERE condition = 'near_expiry'),
    count(*) FILTER (WHERE condition = 'surplus')
  INTO v_available, v_low_stock, v_missing, v_near_expiry, v_surplus
  FROM public.item_availability
  WHERE removed_at IS NULL
    AND (v_effective_org IS NULL OR organization_id = v_effective_org);

  RETURN jsonb_build_object(
    'available', COALESCE(v_available, 0),
    'low_stock', COALESCE(v_low_stock, 0),
    'missing', COALESCE(v_missing, 0),
    'near_expiry', COALESCE(v_near_expiry, 0),
    'surplus', COALESCE(v_surplus, 0)
  );
END;
$legacy_dashboard_counts$;

CREATE OR REPLACE FUNCTION public.phoenix_get_institution_condition_counts()
RETURNS TABLE(
  organization_id uuid,
  available integer,
  low integer,
  missing integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $legacy_institution_counts$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_my_org uuid;
  v_is_super boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  v_role := public.phoenix_my_role();
  v_my_org := public.phoenix_my_org();
  v_is_super := COALESCE(v_role = 'super_admin', false);

  -- Preserve existing HCM empty-result behavior.
  IF v_role = 'health_center_manager' THEN
    RETURN;
  END IF;

  IF NOT v_is_super
     AND NOT public.phoenix_profile_has_permission(v_actor, 'dashboard.view') THEN
    RAISE EXCEPTION 'dashboard_view_forbidden' USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_super AND v_my_org IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    o.id,
    COALESCE(SUM(CASE WHEN ia.condition IN ('available', 'surplus') THEN 1 ELSE 0 END), 0)::integer,
    COALESCE(SUM(CASE WHEN ia.condition IN ('low_stock', 'near_expiry') THEN 1 ELSE 0 END), 0)::integer,
    COALESCE(SUM(CASE WHEN ia.condition IN ('missing', 'expired') THEN 1 ELSE 0 END), 0)::integer
  FROM public.organizations o
  LEFT JOIN public.item_availability ia
    ON ia.organization_id = o.id
   AND ia.removed_at IS NULL
  WHERE o.status = 'active'
    AND (v_is_super OR o.id = v_my_org)
  GROUP BY o.id;
END;
$legacy_institution_counts$;

-- Preserve the existing RPC ACL contract explicitly after replacement.
REVOKE ALL ON FUNCTION public.phoenix_get_dashboard_condition_counts(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_dashboard_condition_counts(uuid)
  TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_get_institution_condition_counts()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_institution_condition_counts()
  TO authenticated;

-- ============================================================================
-- B. NEW ROLE-AWARE COMMAND CENTER READ CONTRACT
-- ============================================================================

CREATE FUNCTION public.phoenix_command_center_read_contract(
  p_organization_id uuid DEFAULT NULL,
  p_warehouse_id uuid DEFAULT NULL,
  p_distribution_point_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $command_center$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_status text;
  v_home_org uuid;
  v_effective_org uuid;
  v_resource_org uuid;
  v_scope_kind text;
  v_authorized boolean := false;
  v_summary jsonb := '{}'::jsonb;
  v_network jsonb := '{}'::jsonb;
  v_capabilities jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT p.role, p.status, p.organization_id
    INTO v_role, v_status, v_home_org
  FROM public.profiles p
  WHERE p.id = v_actor;

  IF NOT FOUND OR v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'command_center_forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_warehouse_id IS NOT NULL AND p_distribution_point_id IS NOT NULL THEN
    RAISE EXCEPTION 'command_center_invalid_scope' USING ERRCODE = '22023';
  END IF;

  -- Caller input selects requested scope only. For ordinary actors, omitted
  -- organization means their home organization. A super_admin may omit all
  -- scope to request the global Command Center.
  v_effective_org := COALESCE(p_organization_id, v_home_org);

  IF p_warehouse_id IS NOT NULL THEN
    SELECT w.organization_id INTO v_resource_org
    FROM public.warehouses w
    WHERE w.id = p_warehouse_id AND w.status = 'active';

    IF NOT FOUND
       OR (p_organization_id IS NOT NULL AND v_resource_org IS DISTINCT FROM p_organization_id) THEN
      RAISE EXCEPTION 'command_center_forbidden' USING ERRCODE = '42501';
    END IF;
    v_effective_org := v_resource_org;
    v_scope_kind := 'warehouse';
  ELSIF p_distribution_point_id IS NOT NULL THEN
    SELECT d.organization_id INTO v_resource_org
    FROM public.distribution_points d
    WHERE d.id = p_distribution_point_id AND d.status = 'active';

    IF NOT FOUND
       OR (p_organization_id IS NOT NULL AND v_resource_org IS DISTINCT FROM p_organization_id) THEN
      RAISE EXCEPTION 'command_center_forbidden' USING ERRCODE = '42501';
    END IF;
    v_effective_org := v_resource_org;
    v_scope_kind := 'distribution_point';
  ELSIF v_role = 'super_admin' AND p_organization_id IS NULL THEN
    v_scope_kind := 'global';
  ELSE
    v_scope_kind := 'organization';
  END IF;

  IF v_scope_kind <> 'global' AND NOT EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id = v_effective_org AND o.status = 'active'
  ) THEN
    RAISE EXCEPTION 'command_center_forbidden' USING ERRCODE = '42501';
  END IF;

  v_authorized := public.phoenix_profile_has_scoped_permission(
    v_actor,
    'dashboard.view',
    v_effective_org,
    p_warehouse_id,
    p_distribution_point_id
  );

  IF NOT COALESCE(v_authorized, false) THEN
    RAISE EXCEPTION 'command_center_forbidden' USING ERRCODE = '42501';
  END IF;

  -- Capability hints are derived from the same canonical permission engine.
  -- They are presentation hints only; destination RPCs must still enforce
  -- their own authorization independently.
  v_capabilities := jsonb_build_object(
    'dashboard_view', true,
    'alerts_view', public.phoenix_profile_has_scoped_permission(
      v_actor, 'inter_institution_alerts.view', v_effective_org,
      p_warehouse_id, p_distribution_point_id),
    'reports_view', public.phoenix_profile_has_scoped_permission(
      v_actor, 'reports.view', v_effective_org,
      p_warehouse_id, p_distribution_point_id),
    'warehouse_stock_view', public.phoenix_profile_has_scoped_permission(
      v_actor, 'warehouse_stock.view', v_effective_org,
      p_warehouse_id, p_distribution_point_id),
    'outlet_stock_view', public.phoenix_profile_has_scoped_permission(
      v_actor, 'outlet_stock.view', v_effective_org,
      p_warehouse_id, p_distribution_point_id),
    'warehouse_transfer_view', public.phoenix_profile_has_scoped_permission(
      v_actor, 'warehouse_transfer.view', v_effective_org,
      p_warehouse_id, p_distribution_point_id)
  );

  IF v_scope_kind IN ('global', 'organization') THEN
    SELECT jsonb_build_object(
      'availability_rows', count(*)::bigint,
      'quantity_units', COALESCE(sum(ia.quantity), 0)::bigint,
      'available', count(*) FILTER (WHERE ia.condition = 'available')::bigint,
      'low_stock', count(*) FILTER (WHERE ia.condition = 'low_stock')::bigint,
      'missing', count(*) FILTER (WHERE ia.condition = 'missing')::bigint,
      'near_expiry', count(*) FILTER (WHERE ia.condition = 'near_expiry')::bigint,
      'expired', count(*) FILTER (WHERE ia.condition = 'expired')::bigint,
      'surplus', count(*) FILTER (WHERE ia.condition = 'surplus')::bigint
    ) INTO v_summary
    FROM public.item_availability ia
    WHERE ia.removed_at IS NULL
      AND (v_scope_kind = 'global' OR ia.organization_id = v_effective_org);

    SELECT jsonb_build_object(
      -- At organization scope the organization count is deliberately exactly
      -- one, preventing a platform-size counting channel.
      'organizations', CASE WHEN v_scope_kind = 'global'
        THEN (SELECT count(*)::bigint FROM public.organizations o WHERE o.status = 'active')
        ELSE 1::bigint END,
      'warehouses', (SELECT count(*)::bigint FROM public.warehouses w
        WHERE w.status = 'active'
          AND (v_scope_kind = 'global' OR w.organization_id = v_effective_org)),
      'distribution_points', (SELECT count(*)::bigint FROM public.distribution_points d
        WHERE d.status = 'active'
          AND (v_scope_kind = 'global' OR d.organization_id = v_effective_org))
    ) INTO v_network;

  ELSIF v_scope_kind = 'warehouse' THEN
    SELECT jsonb_build_object(
      'stock_lines', count(*)::bigint,
      'on_hand_units', COALESCE(sum(ws.on_hand_quantity), 0)::bigint,
      'available_units', COALESCE(sum(ws.available_quantity), 0)::bigint,
      'zero_available_lines', count(*) FILTER (WHERE ws.available_quantity <= 0)::bigint,
      'expired_lines', count(*) FILTER (
        WHERE ws.on_hand_quantity > 0 AND ws.expiry_date < current_date
      )::bigint,
      'near_expiry_lines', count(*) FILTER (
        WHERE ws.on_hand_quantity > 0
          AND ws.expiry_date >= current_date
          AND ws.expiry_date <= current_date + 270
      )::bigint
    ) INTO v_summary
    FROM public.warehouse_stock ws
    WHERE ws.organization_id = v_effective_org
      AND ws.warehouse_id = p_warehouse_id;

    v_network := jsonb_build_object(
      'organizations', 1,
      'warehouses', 1,
      'distribution_points', (
        SELECT count(*)::bigint
        FROM public.distribution_points d
        WHERE d.status = 'active'
          AND d.organization_id = v_effective_org
          AND d.warehouse_id = p_warehouse_id
      )
    );

  ELSE
    SELECT jsonb_build_object(
      'stock_lines', count(*)::bigint,
      'on_hand_units', COALESCE(sum(os.on_hand_quantity), 0)::bigint,
      'available_units', COALESCE(sum(os.available_quantity), 0)::bigint,
      'zero_available_lines', count(*) FILTER (WHERE os.available_quantity <= 0)::bigint,
      'expired_lines', count(*) FILTER (
        WHERE os.on_hand_quantity > 0 AND os.expiry_date < current_date
      )::bigint,
      'near_expiry_lines', count(*) FILTER (
        WHERE os.on_hand_quantity > 0
          AND os.expiry_date >= current_date
          AND os.expiry_date <= current_date + 270
      )::bigint
    ) INTO v_summary
    FROM public.outlet_stock os
    WHERE os.organization_id = v_effective_org
      AND os.distribution_point_id = p_distribution_point_id;

    v_network := jsonb_build_object(
      'organizations', 1,
      'warehouses', 0,
      'distribution_points', 1
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'scope', jsonb_build_object(
      'kind', v_scope_kind,
      'organization_id', v_effective_org,
      'warehouse_id', p_warehouse_id,
      'distribution_point_id', p_distribution_point_id
    ),
    'capabilities', v_capabilities,
    'summary', COALESCE(v_summary, '{}'::jsonb),
    'network', COALESCE(v_network, '{}'::jsonb),
    'trend', NULL,
    'trend_status', 'deferred_pending_measurement',
    'near_expiry_days', 270,
    'as_of', now()
  );
END;
$command_center$;

REVOKE ALL ON FUNCTION public.phoenix_command_center_read_contract(uuid,uuid,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_command_center_read_contract(uuid,uuid,uuid)
  TO authenticated;

COMMENT ON FUNCTION public.phoenix_command_center_read_contract(uuid,uuid,uuid) IS
  'RAC-2 role-aware Command Center read boundary. Enforces dashboard.view with '
  'phoenix_profile_has_scoped_permission at the requested organization, warehouse '
  'or distribution-point scope; global scope is super_admin-only by the canonical '
  'helper. Returns bounded summary/network/capability JSON. No trend read model.';

-- ============================================================================
-- C. SELF-VERIFY SECURITY + ACL CONTRACTS
-- ============================================================================
DO $verify$
DECLARE
  v_definition text;
  v_public_execute boolean;
  v_legacy_dashboard text;
  v_legacy_institution text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'public.phoenix_command_center_read_contract(uuid,uuid,uuid)'::regprocedure
      AND p.prosecdef
      AND p.provolatile = 's'
      AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION '199 VERIFY FAILED: function security/stability/search_path contract incorrect';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.phoenix_command_center_read_contract(uuid,uuid,uuid)'::regprocedure
      AND a.grantee = 0
      AND a.privilege_type = 'EXECUTE'
  ) INTO v_public_execute;

  IF v_public_execute
     OR has_function_privilege(
       'anon', 'public.phoenix_command_center_read_contract(uuid,uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege(
       'authenticated', 'public.phoenix_command_center_read_contract(uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '199 VERIFY FAILED: function ACL boundary incorrect';
  END IF;

  SELECT pg_get_functiondef(
    'public.phoenix_command_center_read_contract(uuid,uuid,uuid)'::regprocedure
  ) INTO v_definition;
  SELECT pg_get_functiondef(
    'public.phoenix_get_dashboard_condition_counts(uuid)'::regprocedure
  ) INTO v_legacy_dashboard;
  SELECT pg_get_functiondef(
    'public.phoenix_get_institution_condition_counts()'::regprocedure
  ) INTO v_legacy_institution;

  IF v_definition NOT LIKE '%auth.uid()%'
     OR v_definition NOT LIKE '%phoenix_profile_has_scoped_permission%'
     OR v_definition NOT LIKE '%''dashboard.view''%'
     OR v_definition NOT LIKE '%ERRCODE = ''42501''%'
     OR v_definition NOT LIKE '%deferred_pending_measurement%'
     OR v_definition NOT LIKE '%current_date + 270%' THEN
    RAISE EXCEPTION '199 VERIFY FAILED: required authorization/data-contract clauses missing';
  END IF;

  IF v_legacy_dashboard NOT LIKE '%phoenix_profile_has_permission%'
     OR v_legacy_dashboard NOT LIKE '%''dashboard.view''%'
     OR v_legacy_dashboard NOT LIKE '%dashboard_view_forbidden%'
     OR v_legacy_institution NOT LIKE '%phoenix_profile_has_permission%'
     OR v_legacy_institution NOT LIKE '%''dashboard.view''%'
     OR v_legacy_institution NOT LIKE '%dashboard_view_forbidden%' THEN
    RAISE EXCEPTION '199 VERIFY FAILED: legacy dashboard RPC bypass remains open';
  END IF;
END;
$verify$;

COMMIT;
