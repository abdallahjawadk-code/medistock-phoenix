-- ============================================================================
-- FIVE-ROLE-CUTOVER-091   ***PREPARED - DO NOT APPLY TO PRODUCTION***
--
-- MANUAL APPLY ONLY (SQL Editor), after owner review, AFTER the attested
-- pre-launch runtime reset (supabase/ops/pre_launch_runtime_reset.sql) has
-- already run successfully against the SAME database. Never via
-- `supabase db push`. Replayed 001->091 on the disposable rig.
--
-- WHY
-- monthly_status_officer and viewer were audited and found to have NO safe
-- canonical target: monthly_status_officer uniquely owns
-- status_center.create/edit/resolve + status_contacts.manage (no other role
-- holds them), and viewer is pure read-only. Any role mapping would widen
-- privilege for whoever inherited those keys. The approved decision was a
-- pre-launch data reset instead of a mapping: keep exactly one super_admin,
-- delete every other profile, then narrow the role model to the five
-- canonical roles that remain:
--   super_admin, central_warehouse_manager, institution_admin,
--   warehouse_officer, outlet_officer.
--
-- This migration performs that final cutover:
--   1. FAILS CLOSED unless the reset already ran: exactly one row in
--      public.profiles, and it is an active super_admin. There is no
--      best-effort mode — a database that still has more than one profile,
--      or a survivor that is not super_admin, is not eligible for this
--      migration at all, and the whole transaction aborts.
--   2. Deletes every role_permission_defaults row for a non-canonical role
--      (monthly_status_officer, viewer, and the pre-existing legacy roles
--      hospital_admin/warehouse_manager/port_officer/point_operator/
--      transfer_manager — none of which can be assigned to a profile after
--      step 3 either).
--   3. Narrows profiles_role_check to EXACTLY the five canonical roles.
--   4. Rewrites every RLS policy / SECURITY DEFINER function that currently
--      references monthly_status_officer or viewer, found by introspecting
--      the live 001->090 rig (not by grepping historical migration SQL,
--      which is never edited): 7 policies, 4 functions. Two policies
--      (isr_select_viewer, osc_select_members) had NO role left in their
--      predicate after removing monthly_status_officer/viewer/other legacy
--      roles that can no longer exist — they are dropped outright rather
--      than widened to a role that was never granted that access, per the
--      "never expand privileges automatically" contract.
--
-- NOT part of this migration: institution_admin/central_warehouse_manager did
-- NOT gain status_center.create/edit/resolve or status_contacts.manage. Those
-- keys go unheld by any role until the monthly-status redesign (Phase 1c)
-- adds new scoped keys for them — leaving them ungranted here is intentional,
-- not an oversight.
--
-- PRECONDITIONS: 001..090 applied, AND the pre-launch runtime reset already
-- executed successfully against this exact database (one active super_admin,
-- zero other profiles). Confirmed on the disposable rig only; never run
-- against production without a verified backup, a read-only inventory
-- report, and explicit final cutover approval — none of which this file can
-- see, which is exactly why step 1 below refuses to guess.
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. FAIL CLOSED: refuse to run unless the pre-launch reset already happened.
-- ─────────────────────────────────────────────────────────────────────────────
DO $precondition$
DECLARE
  v_count   bigint;
  v_role    text;
  v_status  text;
BEGIN
  SELECT count(*) INTO v_count FROM public.profiles;
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'FIVE-ROLE-CUTOVER-091 REFUSED: expected exactly 1 profile (the pre-launch '
      'reset must run first), found %.', v_count;
  END IF;

  SELECT role, status INTO v_role, v_status FROM public.profiles LIMIT 1;
  IF v_role IS DISTINCT FROM 'super_admin' OR v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'FIVE-ROLE-CUTOVER-091 REFUSED: the surviving profile must be an active '
      'super_admin, found role=% status=%.', v_role, v_status;
  END IF;

  RAISE NOTICE 'FIVE-ROLE-CUTOVER-091: precondition satisfied (1 active super_admin, 0 other profiles).';
END
$precondition$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. role_permission_defaults: drop every non-canonical role's rows.
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM public.role_permission_defaults
WHERE role NOT IN (
  'super_admin', 'central_warehouse_manager', 'institution_admin',
  'warehouse_officer', 'outlet_officer'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. profiles_role_check: exactly the five canonical roles.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (
  role = ANY (ARRAY[
    'super_admin', 'central_warehouse_manager', 'institution_admin',
    'warehouse_officer', 'outlet_officer'
  ])
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4a. institution_item_status_reports: isr_select_viewer had no other role in
--     its predicate — drop outright (no institution_admin replacement was
--     ever granted here; adding one now would be an unaudited widening).
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "isr_select_viewer" ON public.institution_item_status_reports;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4b. organization_status_contacts: osc_select_members named only
--     warehouse_manager/point_operator/viewer, none of which can exist in
--     profiles after step 3 either — drop outright.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "osc_select_members" ON public.organization_status_contacts;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4c. warehouses.wh_select_scoped
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "wh_select_scoped" ON public.warehouses;

CREATE POLICY "wh_select_scoped" ON public.warehouses
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'warehouses.view')
      AND (
        -- institution_admin: organization-wide compatibility (091 removed
        -- hospital_admin/monthly_status_officer/viewer from this predicate —
        -- none can exist in profiles anymore).
        phoenix_my_role() = 'institution_admin'
        OR phoenix_profile_has_warehouse_assignment(auth.uid(), id)
        OR (
          phoenix_my_role() = 'port_officer'
          AND phoenix_profile_has_permission(auth.uid(), 'warehouse_dispatch.view')
          AND EXISTS (
            SELECT 1 FROM public.warehouse_dispatches d
            WHERE d.warehouse_id     = warehouses.id
              AND d.organization_id  = warehouses.organization_id
              AND phoenix_profile_has_point_assignment(auth.uid(), d.destination_distribution_point_id)
          )
        )
      )
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4d. warehouse_stock.warehouse_stock_select_scoped
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "warehouse_stock_select_scoped" ON public.warehouse_stock;

CREATE POLICY "warehouse_stock_select_scoped" ON public.warehouse_stock
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'warehouse_stock.view')
      AND (
        phoenix_my_role() = 'institution_admin'
        OR phoenix_profile_has_warehouse_assignment(auth.uid(), warehouse_id)
      )
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4e. warehouse_stock_movements.warehouse_stock_mov_select_scoped
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "warehouse_stock_mov_select_scoped" ON public.warehouse_stock_movements;

CREATE POLICY "warehouse_stock_mov_select_scoped" ON public.warehouse_stock_movements
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'warehouse_stock.movements_view')
      AND (
        phoenix_my_role() = 'institution_admin'
        OR phoenix_profile_has_warehouse_assignment(auth.uid(), warehouse_id)
      )
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4f. warehouse_dispatches.warehouse_dispatches_select_scoped
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "warehouse_dispatches_select_scoped" ON public.warehouse_dispatches;

CREATE POLICY "warehouse_dispatches_select_scoped" ON public.warehouse_dispatches
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'warehouse_dispatch.view')
      AND (
        phoenix_my_role() = 'institution_admin'
        OR (
          phoenix_my_role() = 'warehouse_officer'
          AND phoenix_profile_has_warehouse_assignment(auth.uid(), warehouse_id)
        )
        OR (
          phoenix_my_role() = 'port_officer'
          AND phoenix_profile_has_point_assignment(auth.uid(), destination_distribution_point_id)
        )
      )
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4g. warehouse_dispatch_lines.warehouse_dispatch_lines_select_scoped
--     (derived through the header, same predicate as 4f — see 062's own note:
--     the line policy must never authorize on its own organization_id column).
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "warehouse_dispatch_lines_select_scoped" ON public.warehouse_dispatch_lines;

CREATE POLICY "warehouse_dispatch_lines_select_scoped" ON public.warehouse_dispatch_lines
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.warehouse_dispatches d
      WHERE d.id = warehouse_dispatch_lines.dispatch_id
        AND (
          phoenix_my_role() = 'super_admin'
          OR (
            d.organization_id = phoenix_my_org()
            AND phoenix_profile_has_permission(auth.uid(), 'warehouse_dispatch.view')
            AND (
              phoenix_my_role() = 'institution_admin'
              OR (
                phoenix_my_role() = 'warehouse_officer'
                AND phoenix_profile_has_warehouse_assignment(auth.uid(), d.warehouse_id)
              )
              OR (
                phoenix_my_role() = 'port_officer'
                AND phoenix_profile_has_point_assignment(auth.uid(), d.destination_distribution_point_id)
              )
            )
          )
        )
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 5a. assign_profile_role: allowlist narrows to the five canonical roles; the
--     hospital_admin actor bypass is removed (hospital_admin can never be a
--     profile's role after step 3, so its whole branch is now unreachable
--     and is dropped rather than left as dead code).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.assign_profile_role(p_target_id uuid, p_new_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_id     uuid;
  v_actor_role   text;
  v_target       profiles%rowtype;
  v_allowed_roles text[] := array[
    'super_admin', 'central_warehouse_manager', 'institution_admin',
    'warehouse_officer', 'outlet_officer'
  ];
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  end if;

  select role into v_actor_role
  from profiles where id = v_actor_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'ACTOR_PROFILE_NOT_FOUND');
  end if;

  -- FIVE-ROLE-CUTOVER-091: only the platform admin may assign roles through
  -- this legacy RPC now (hospital_admin can no longer exist as an actor).
  if v_actor_role <> 'super_admin' then
    return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  end if;

  if p_new_role != all(v_allowed_roles) then
    return jsonb_build_object('ok', false, 'error', 'INVALID_ROLE', 'allowed', v_allowed_roles);
  end if;

  select * into v_target from profiles where id = p_target_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND');
  end if;

  if p_target_id = v_actor_id then
    return jsonb_build_object('ok', false, 'error', 'CANNOT_CHANGE_OWN_ROLE');
  end if;

  if p_new_role = 'super_admin' and v_actor_role <> 'super_admin' then
    return jsonb_build_object('ok', false, 'error', 'CANNOT_ESCALATE_TO_SUPER_ADMIN');
  end if;

  if v_target.role = p_new_role then
    return jsonb_build_object('ok', true, 'changed', false, 'reason', 'ALREADY_ASSIGNED');
  end if;

  update profiles set role = p_new_role, updated_at = now() where id = p_target_id;

  insert into audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
    values (v_target.organization_id, v_actor_id, v_actor_role, 'role_assigned', 'profile',
            p_target_id, v_target.full_name,
            jsonb_build_object('previous_role', v_target.role, 'new_role', p_new_role));

  return jsonb_build_object('ok', true, 'changed', true, 'previous_role', v_target.role, 'new_role', p_new_role);
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5b. phoenix_handle_new_user: the 'viewer' fallback role no longer exists.
--     outlet_officer is the safe replacement — its default permission set is
--     empty (OUTLET_OFFICER_DEFAULTS = []), so an auth signup that arrives
--     without an explicit role metadata field gets zero permissions, not a
--     guess at a real operational role.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email, 'Unknown'),
    coalesce(new.raw_user_meta_data->>'role', 'outlet_officer')
  )
  on conflict (id) do nothing;
  return new;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5c. phoenix_profile_has_scoped_permission: v_org_wide_roles narrows to
--     institution_admin only (hospital_admin/monthly_status_officer/viewer
--     removed — none can exist in profiles after step 3 either).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_profile_has_scoped_permission(p_profile_id uuid, p_permission_key text, p_organization_id uuid DEFAULT NULL::uuid, p_warehouse_id uuid DEFAULT NULL::uuid, p_distribution_point_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role   text;
  v_status text;
  v_org    uuid;
  -- Roles that legitimately answer organization-wide rather than per-resource.
  -- FIVE-ROLE-CUTOVER-091: hospital_admin/monthly_status_officer/viewer
  -- removed — they can no longer exist in profiles. warehouse_officer,
  -- port_officer and their legacy twins remain deliberately absent: they are
  -- operational roles and MUST name the resource they are acting on.
  v_org_wide_roles text[] := ARRAY['institution_admin'];
BEGIN
  IF p_profile_id IS NULL OR p_permission_key IS NULL OR btrim(p_permission_key) = '' THEN
    RETURN false;
  END IF;

  SELECT p.role, p.status, p.organization_id
    INTO v_role, v_status, v_org
  FROM public.profiles p
  WHERE p.id = p_profile_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_status IS DISTINCT FROM 'active' THEN
    RETURN false;
  END IF;

  IF v_role = 'super_admin' THEN
    RETURN true;
  END IF;

  IF p_warehouse_id IS NOT NULL AND p_distribution_point_id IS NOT NULL THEN
    RETURN false;
  END IF;

  IF v_org IS NULL THEN
    RETURN false;
  END IF;
  IF p_organization_id IS NULL OR p_organization_id IS DISTINCT FROM v_org THEN
    RETURN false;
  END IF;

  IF NOT phoenix_profile_has_permission(p_profile_id, p_permission_key) THEN
    RETURN false;
  END IF;

  IF p_warehouse_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.warehouses w
      WHERE w.id = p_warehouse_id
        AND w.organization_id = p_organization_id
        AND w.status = 'active'
    ) THEN
      RETURN false;
    END IF;

    IF v_role = ANY (v_org_wide_roles) THEN
      RETURN true;
    END IF;

    RETURN phoenix_profile_has_warehouse_assignment(p_profile_id, p_warehouse_id);
  END IF;

  IF p_distribution_point_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.distribution_points d
      WHERE d.id = p_distribution_point_id
        AND d.organization_id = p_organization_id
        AND d.status = 'active'
    ) THEN
      RETURN false;
    END IF;

    IF v_role = ANY (v_org_wide_roles) THEN
      RETURN true;
    END IF;

    RETURN phoenix_profile_has_point_assignment(p_profile_id, p_distribution_point_id);
  END IF;

  RETURN v_role = ANY (v_org_wide_roles);
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5d. phoenix_set_my_org_whatsapp_contact: eligibility narrows to
--     institution_admin only (hospital_admin/monthly_status_officer removed —
--     monthly_status_officer had no safe successor, so its ability to publish
--     an official org WhatsApp contact simply ends here rather than being
--     reassigned to a role that never held it).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_set_my_org_whatsapp_contact(p_enabled boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_profile        public.profiles%ROWTYPE;
  v_display_name   text;
  v_existing_id    uuid;
  v_is_primary     boolean;
  v_has_active_primary boolean;
  v_contact_id     uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  IF v_profile.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'profile_not_active';
  END IF;

  IF v_profile.organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required';
  END IF;

  IF v_profile.role NOT IN ('institution_admin') THEN
    RAISE EXCEPTION 'insufficient_role';
  END IF;

  SELECT id INTO v_existing_id
  FROM public.organization_status_contacts
  WHERE organization_id = v_profile.organization_id
    AND created_by = auth.uid();

  IF NOT p_enabled THEN
    IF v_existing_id IS NULL THEN
      RETURN jsonb_build_object('ok', true, 'enabled', false, 'contact_id', NULL, 'is_primary', NULL);
    END IF;

    UPDATE public.organization_status_contacts
    SET is_active = false,
        updated_at = now()
    WHERE id = v_existing_id;

    RETURN jsonb_build_object('ok', true, 'enabled', false, 'contact_id', v_existing_id, 'is_primary', NULL);
  END IF;

  IF v_profile.whatsapp_phone IS NULL OR btrim(v_profile.whatsapp_phone) = '' THEN
    RAISE EXCEPTION 'whatsapp_phone_required';
  END IF;

  IF v_profile.whatsapp_phone !~ '^[0-9]{8,15}$' THEN
    RAISE EXCEPTION 'invalid_whatsapp_phone';
  END IF;

  v_display_name := 'مدير المؤسسة' || CASE WHEN v_profile.full_name IS NOT NULL AND btrim(v_profile.full_name) <> ''
                                            THEN ' - ' || v_profile.full_name ELSE '' END;
  v_is_primary := true;

  IF v_is_primary THEN
    UPDATE public.organization_status_contacts
    SET is_primary = false,
        updated_at = now()
    WHERE organization_id = v_profile.organization_id
      AND (v_existing_id IS NULL OR id <> v_existing_id)
      AND is_primary = true;
  END IF;

  IF v_existing_id IS NOT NULL THEN
    UPDATE public.organization_status_contacts
    SET display_name = v_display_name,
        phone        = v_profile.whatsapp_phone,
        is_active    = true,
        is_primary   = v_is_primary,
        updated_at   = now()
    WHERE id = v_existing_id;

    v_contact_id := v_existing_id;
  ELSE
    INSERT INTO public.organization_status_contacts (
      organization_id, display_name, phone, is_primary, is_active, created_by
    ) VALUES (
      v_profile.organization_id, v_display_name, v_profile.whatsapp_phone, v_is_primary, true, auth.uid()
    )
    RETURNING id INTO v_contact_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'enabled', true, 'contact_id', v_contact_id, 'is_primary', v_is_primary);
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Verify
-- ─────────────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_txt text;
  v_n   bigint;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_txt FROM pg_constraint WHERE conname = 'profiles_role_check';
  ASSERT v_txt IS NOT NULL, 'VERIFY FAILED (091): profiles_role_check missing';
  FOR v_txt IN SELECT unnest(ARRAY[
    'monthly_status_officer','viewer','hospital_admin','warehouse_manager',
    'port_officer','point_operator','transfer_manager'
  ]) LOOP
    ASSERT (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'profiles_role_check')
      NOT LIKE '%''' || v_txt || '''%',
      'VERIFY FAILED (091): profiles_role_check still accepts removed role: ' || v_txt;
  END LOOP;

  SELECT count(*) INTO v_n FROM public.role_permission_defaults
    WHERE role NOT IN ('super_admin','central_warehouse_manager','institution_admin','warehouse_officer','outlet_officer');
  ASSERT v_n = 0, 'VERIFY FAILED (091): role_permission_defaults still has non-canonical role rows';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'isr_select_viewer'
  ), 'VERIFY FAILED (091): isr_select_viewer still exists';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'osc_select_members'
  ), 'VERIFY FAILED (091): osc_select_members still exists';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND (coalesce(qual,'') ILIKE '%monthly_status_officer%' OR coalesce(qual,'') ILIKE '%viewer%'
        OR coalesce(with_check,'') ILIKE '%monthly_status_officer%' OR coalesce(with_check,'') ILIKE '%viewer%')
  ), 'VERIFY FAILED (091): a policy still references monthly_status_officer/viewer';

  -- Quoted-literal match only (a SQL string comparison against the role), not
  -- a plain substring match — this migration's OWN explanatory comments name
  -- the removed roles in prose, which must not trip the guard.
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (p.prosrc ILIKE '%''monthly_status_officer''%' OR p.prosrc ILIKE '%''viewer''%')
  ), 'VERIFY FAILED (091): a function still references monthly_status_officer/viewer as a literal';

  RAISE NOTICE 'FIVE-ROLE-CUTOVER-091: verified — five canonical roles only, no monthly_status_officer/viewer references remain in RLS/RPC.';
END
$verify$;

COMMIT;
