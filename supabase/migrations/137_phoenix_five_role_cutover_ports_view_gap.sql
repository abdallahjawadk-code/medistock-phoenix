-- ============================================================================
-- PHOENIX-FIVE-ROLE-CUTOVER-PORTS-VIEW-GAP-137
--
-- A REAL, LIVE, PREVIOUSLY-UNDISCOVERED RBAC gap in PR #57's own headline
-- feature (the dispense composer), found by driving the actual Outlet
-- Operations screen through a real authenticated browser session — not a
-- source scan, not an RPC-level dynamic test (which calls RPCs directly and
-- never exercises distribution_points_grants_fix's frontend-facing RLS
-- policy at all).
--
-- dp_read_perm (024_phoenix_distribution_points_rls_state_repair.sql) reads:
--   phoenix_my_role() = 'super_admin'
--   OR (phoenix_profile_has_permission(auth.uid(), 'ports.view')
--       AND organization_id = phoenix_my_org())
--
-- role_permission_defaults (010_phoenix_user_permission_matrix.sql) grants
-- 'ports.view' to 'warehouse_officer', 'port_officer', 'viewer',
-- 'hospital_admin' (010) and 'institution_admin' (012). 091's five-role
-- cutover renamed/consolidated roles down to super_admin,
-- central_warehouse_manager, institution_admin, warehouse_officer,
-- outlet_officer — but never migrated 'port_officer' (retired) and whatever
-- the prior central-warehouse role was forward to their replacement names'
-- own role_permission_defaults rows. warehouse_officer and institution_admin
-- kept their pre-cutover names, so they already had 'ports.view'; the two
-- genuinely NEW names (outlet_officer, central_warehouse_manager) never
-- got it at all — confirmed by grep: zero matches for either name paired
-- with 'ports.view' anywhere in the migration set before this one.
--
-- Consequence, proven live: an outlet_officer with a real, correctly-active
-- profile_scope_assignments row for their own outlet still gets an EMPTY
-- array back from distribution_points (RLS silently filters every row,
-- HTTP 200, not an error) — so Outlet Operations can never resolve ANY
-- outlet for them, and the dispense composer this whole PR delivers is
-- unreachable for the one role it exists for. central_warehouse_manager has
-- the identical structural gap (same missing-name pattern) even though it
-- was not hit by this session's own live browser run (that only exercised
-- outlet_officer/institution_admin) — fixed here too rather than left as a
-- known-but-unfixed twin of the same defect.
--
-- Scope: additive only. Grants exactly one existing permission key to two
-- existing roles; no schema change, no RLS policy change, no other
-- permission touched.
-- ============================================================================

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
VALUES
  ('outlet_officer', 'ports.view', true),
  ('central_warehouse_manager', 'ports.view', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = true;

-- ============================================================================
-- VERIFY — inside the transaction; failure rolls back all of 137
-- ============================================================================

DO $$
DECLARE
  v_allowed boolean;
BEGIN
  SELECT allowed INTO v_allowed FROM public.role_permission_defaults
    WHERE role = 'outlet_officer' AND permission_key = 'ports.view';
  ASSERT v_allowed IS TRUE,
    'VERIFY FAILED (137): outlet_officer.ports.view is not true';

  SELECT allowed INTO v_allowed FROM public.role_permission_defaults
    WHERE role = 'central_warehouse_manager' AND permission_key = 'ports.view';
  ASSERT v_allowed IS TRUE,
    'VERIFY FAILED (137): central_warehouse_manager.ports.view is not true';

  -- No other role's ports.view grant was touched by this migration.
  ASSERT (
    SELECT allowed FROM public.role_permission_defaults
      WHERE role = 'warehouse_officer' AND permission_key = 'ports.view'
  ) IS TRUE, 'VERIFY FAILED (137): warehouse_officer.ports.view regressed';
  ASSERT (
    SELECT allowed FROM public.role_permission_defaults
      WHERE role = 'institution_admin' AND permission_key = 'ports.view'
  ) IS TRUE, 'VERIFY FAILED (137): institution_admin.ports.view regressed';

  RAISE NOTICE '137 ✓ outlet_officer and central_warehouse_manager can now read distribution_points via dp_read_perm''s ports.view + organization_id gate — the live gap a real authenticated browser session found is closed.';
END $$;
