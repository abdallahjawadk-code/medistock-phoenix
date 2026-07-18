-- =============================================================================
-- MediStock Phoenix V2 — Migration 076: Profile Scope Assignment RPCs (additive)
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard → SQL Editor after reading this file in full.
-- Apply ONLY after migration 075 is confirmed applied and healthy.
--
-- PHASE-B-NETWORK-CONTRACTS-SCOPE-ASSIGN-076-A
--
-- WHAT THIS MIGRATION DOES
--   Creates the write path that migration 062 designed but deferred: 062 built
--   public.profile_scope_assignments, REVOKED client DML, and its header named
--   the two RPCs that would own the writes — phoenix_assign_profile_scope and
--   phoenix_revoke_profile_scope — for "migration 063", which shipped hardening
--   only. This migration supplies them, honouring 062's audit contract verbatim:
--     scope_assigned / scope_revoked, entity_type 'profile_scope_assignment'.
--
-- WHAT ENFORCES WHAT (no rule is duplicated loosely)
--   • trg_validate_profile_scope_assignment (062) already guarantees, fail-closed,
--     that assignment.org == the PROFILE's org and that an active assignment
--     names an ACTIVE warehouse/outlet in that org. These RPCs do NOT re-derive
--     that; they set organization_id from the profile and let the trigger prove
--     the rest, so the two can never disagree.
--   • The composite FKs (062) pin the target to that same org structurally.
--   • The partial unique indexes (062) make "one active assignment per
--     (profile,target)" a hard guarantee; these RPCs treat a repeat as an
--     idempotent no-op rather than an error.
--   • These RPCs add: caller AUTHORITY, the cross-org IDOR guard for non-super
--     callers, mandatory revoke reason, and the audit_logs row.
--
-- AUTHORITY
--   super_admin (any organization), OR a caller holding users.edit_scope (062)
--   acting STRICTLY within its own organization. A non-super caller can never
--   assign a scope to a profile in another org, nor name a target in another org
--   — phoenix_my_org() must equal the profile's org, checked before any write.
--
-- SAFETY
--   • Additive only; 062's table/trigger/indexes/RLS untouched.
--   • Single transaction; fail-closed preconditions.
--   • SECURITY DEFINER + fixed search_path = public, pg_temp.
--   • REVOKE ALL FROM PUBLIC, anon; GRANT EXECUTE TO authenticated only.
--   • No RBAC enforcement toggled, no Auth object touched, no data seeded.
--
-- ROLLBACK
--   DROP FUNCTION public.phoenix_revoke_profile_scope(uuid, text);
--   DROP FUNCTION public.phoenix_assign_profile_scope(uuid, text, uuid);
-- =============================================================================

begin;

DO $guard$
BEGIN
  IF to_regclass('public.profile_scope_assignments') IS NULL THEN
    RAISE EXCEPTION 'ABORT 076: public.profile_scope_assignments is absent — apply 062 first.';
  END IF;
  IF to_regprocedure('public.phoenix_validate_profile_scope_assignment()') IS NULL THEN
    RAISE EXCEPTION 'ABORT 076: the 062 validation trigger function is absent — apply 062 first.';
  END IF;
  IF to_regprocedure('public.phoenix_profile_has_permission(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 076: public.phoenix_profile_has_permission(uuid, text) is absent.';
  END IF;
  IF to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'ABORT 076: public.audit_logs is absent — apply 001 first.';
  END IF;
END;
$guard$;

-- ── 1. ASSIGN (grant a warehouse/outlet scope to a profile) ──────────────────
CREATE OR REPLACE FUNCTION public.phoenix_assign_profile_scope(
  p_profile_id uuid,
  p_scope_type text,
  p_target_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role        text := public.phoenix_my_role();
  v_actor       uuid := auth.uid();
  v_is_super    boolean := (v_role = 'super_admin');
  v_profile_org uuid;
  v_existing    uuid;
  v_id          uuid;
BEGIN
  IF p_scope_type NOT IN ('warehouse', 'distribution_point') THEN
    RAISE EXCEPTION 'SCOPE_TYPE_INVALID: % (expected warehouse|distribution_point)', p_scope_type USING ERRCODE = '23514';
  END IF;

  -- Authority: super_admin, or users.edit_scope holder. Non-super callers are
  -- constrained to their own org below (the IDOR guard).
  IF NOT v_is_super AND NOT public.phoenix_profile_has_permission(v_actor, 'users.edit_scope') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_SCOPE_ASSIGN: requires super_admin or users.edit_scope' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_profile_org FROM public.profiles WHERE id = p_profile_id;
  IF v_profile_org IS NULL THEN
    -- Either the profile does not exist, or it is a platform profile (super_admin)
    -- with no org; neither can hold a scope. The trigger would also reject this.
    RAISE EXCEPTION 'SCOPE_ASSIGN_PROFILE_INELIGIBLE: profile % has no organization', p_profile_id USING ERRCODE = '23514';
  END IF;

  -- IDOR / cross-org guard for non-super callers: you may only assign within
  -- your own organization. super_admin is exempt (platform role).
  IF NOT v_is_super AND public.phoenix_my_org() IS DISTINCT FROM v_profile_org THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_SCOPE_ASSIGN_CROSS_ORG: caller may only assign within its own organization' USING ERRCODE = '42501';
  END IF;

  -- Idempotent: an existing ACTIVE assignment for this (profile, target) is a
  -- no-op, not an error (double-submit / retry safe). Serialize per profile so a
  -- concurrent duplicate cannot slip past the check-then-insert.
  PERFORM pg_advisory_xact_lock(hashtext('phoenix_scope_assign:' || p_profile_id::text));

  IF p_scope_type = 'warehouse' THEN
    SELECT id INTO v_existing FROM public.profile_scope_assignments
    WHERE profile_id = p_profile_id AND scope_type = 'warehouse' AND warehouse_id = p_target_id AND is_active = true;
  ELSE
    SELECT id INTO v_existing FROM public.profile_scope_assignments
    WHERE profile_id = p_profile_id AND scope_type = 'distribution_point' AND distribution_point_id = p_target_id AND is_active = true;
  END IF;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'assignment_id', v_existing, 'idempotent_replay', true);
  END IF;

  -- Insert. organization_id is taken from the profile so it can never disagree
  -- with it; the 062 trigger re-proves org-match + target-active fail-closed.
  INSERT INTO public.profile_scope_assignments
    (profile_id, organization_id, scope_type, warehouse_id, distribution_point_id, is_active, assigned_by)
  VALUES (
    p_profile_id, v_profile_org, p_scope_type,
    CASE WHEN p_scope_type = 'warehouse'          THEN p_target_id ELSE NULL END,
    CASE WHEN p_scope_type = 'distribution_point' THEN p_target_id ELSE NULL END,
    true, v_actor
  )
  RETURNING id INTO v_id;

  INSERT INTO audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_profile_org, v_actor, v_role, 'scope_assigned', 'profile_scope_assignment', v_id, NULL,
          jsonb_build_object('profile_id', p_profile_id, 'scope_type', p_scope_type, 'target_id', p_target_id));

  RETURN jsonb_build_object('ok', true, 'assignment_id', v_id, 'idempotent_replay', false);
END;
$$;

-- ── 2. REVOKE (state change + mandatory reason, never DELETE) ─────────────────
CREATE OR REPLACE FUNCTION public.phoenix_revoke_profile_scope(
  p_assignment_id uuid,
  p_reason        text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role     text := public.phoenix_my_role();
  v_actor    uuid := auth.uid();
  v_is_super boolean := (v_role = 'super_admin');
  v_org      uuid;
  v_active   boolean;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'SCOPE_REVOKE_REASON_REQUIRED: a non-empty reason is mandatory' USING ERRCODE = '23514';
  END IF;
  IF NOT v_is_super AND NOT public.phoenix_profile_has_permission(v_actor, 'users.edit_scope') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_SCOPE_REVOKE: requires super_admin or users.edit_scope' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id, is_active INTO v_org, v_active
  FROM public.profile_scope_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'SCOPE_ASSIGNMENT_NOT_FOUND: %', p_assignment_id USING ERRCODE = '23503';
  END IF;

  IF NOT v_is_super AND public.phoenix_my_org() IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_SCOPE_REVOKE_CROSS_ORG: caller may only revoke within its own organization' USING ERRCODE = '42501';
  END IF;

  -- Idempotent: revoking an already-revoked assignment is a no-op.
  IF NOT v_active THEN
    RETURN jsonb_build_object('ok', true, 'assignment_id', p_assignment_id, 'idempotent_replay', true);
  END IF;

  UPDATE public.profile_scope_assignments
  SET is_active = false, revoked_by = v_actor, revoked_at = now(), revoke_reason = v_reason
  WHERE id = p_assignment_id;

  INSERT INTO audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_org, v_actor, v_role, 'scope_revoked', 'profile_scope_assignment', p_assignment_id, NULL,
          jsonb_build_object('reason', v_reason));

  RETURN jsonb_build_object('ok', true, 'assignment_id', p_assignment_id, 'idempotent_replay', false);
END;
$$;

-- ── ACL ──────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.phoenix_assign_profile_scope(uuid, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.phoenix_revoke_profile_scope(uuid, text)       FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_assign_profile_scope(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_revoke_profile_scope(uuid, text)       TO authenticated;

DO $verify$
BEGIN
  IF to_regprocedure('public.phoenix_assign_profile_scope(uuid, text, uuid)') IS NULL
     OR to_regprocedure('public.phoenix_revoke_profile_scope(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (076): a scope-assignment RPC is missing.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name IN ('phoenix_assign_profile_scope', 'phoenix_revoke_profile_scope')
      AND grantee IN ('PUBLIC', 'anon')
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (076): a scope-assignment RPC is executable by PUBLIC/anon.';
  END IF;
END;
$verify$;

commit;
