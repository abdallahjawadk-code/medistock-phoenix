-- ============================================================================
-- 046_phoenix_set_my_org_whatsapp_contact_rpc.sql
-- MediStock Phoenix V2
--
-- Purpose:
--   DB-OFFICIAL-ORG-WHATSAPP-CONTACT-RPC-A. Migrations 044/045 let any user
--   save their own personal WhatsApp number into profiles.whatsapp_phone,
--   but Inter-Institution Alerts' WhatsApp buttons still read exclusively
--   from organization_status_contacts.phone (migration 008/009) — so saving
--   a personal number does not, by itself, activate any WhatsApp button.
--   This migration adds a narrow, explicit, self-service RPC that lets an
--   eligible organization user publish their OWN already-saved
--   profiles.whatsapp_phone as their organization's official contact
--   number, or withdraw it again. No UI calls this function yet.
--
-- What this migration does:
--   A. Creates public.phoenix_set_my_org_whatsapp_contact(p_enabled boolean
--      DEFAULT true) — SECURITY DEFINER, scoped entirely to auth.uid().
--        - p_enabled = true:  copies the caller's own
--          profiles.whatsapp_phone into an organization_status_contacts row
--          for the caller's own organization_id, keyed by created_by =
--          auth.uid(), and marks it active.
--        - p_enabled = false: marks that same row inactive (never deletes).
--   B. Revokes execute from PUBLIC/anon and grants it to authenticated only.
--   C. Verification block.
--
-- What this migration does NOT do:
--   - Does NOT accept a phone number parameter — the only phone value ever
--     written is the caller's own current profiles.whatsapp_phone.
--   - Does NOT accept a profile/user/organization id parameter — every
--     lookup and write is scoped by auth.uid() alone.
--   - Does NOT touch profiles.role, profiles.status, profiles.organization_id,
--     profiles.full_name, profiles.contact_email, or profiles.login_mode.
--   - Does NOT let a viewer / point_operator / warehouse_manager / disabled
--     / org-less user call this successfully — role and status are checked
--     before any write.
--   - Does NOT solve super_admin assignment of contact numbers for other
--     users/organizations — that remains an explicitly separate, later
--     admin-facing phase.
--   - Does NOT delete any organization_status_contacts row — p_enabled=false
--     only flips is_active to false.
--   - Does NOT change any RLS policy on organization_status_contacts, and
--     does NOT disable RLS anywhere (this RPC is SECURITY DEFINER precisely
--     so it can perform its own narrowly-scoped write regardless of the
--     caller's row-level visibility, exactly like migration 045's
--     phoenix_update_my_whatsapp_phone already does for profiles).
--   - Does NOT grant any table privilege — EXECUTE on the function is the
--     only grant.
--   - Does NOT use service_role or auth.admin anywhere.
--   - Does NOT add a WhatsApp Cloud/Graph API call, token, or automatic
--     send — this is a plain data copy between two existing columns.
--   - Does NOT add any frontend UI call site — MyAccountScreen and
--     InterInstitutionAlertsScreen are unchanged in this phase.
--
-- MANUAL APPLY ONLY — paste into Supabase Dashboard → SQL Editor and run.
-- DO NOT use "supabase db push" — this project manages migrations manually.
--
-- Prerequisites:
--   Migrations 001–045 must be applied (008 creates
--   organization_status_contacts, 044 adds profiles.whatsapp_phone).
--
-- Safety:
--   - CREATE OR REPLACE — idempotent, safe to re-run.
--   - SECURITY DEFINER + SET search_path = public — prevents search-path
--     hijacking, matches every existing phoenix_* RPC in this project.
--   - Server-side re-validation of the phone shape mirrors migration 044's
--     CHECK constraint exactly.
--   - No DROP, TRUNCATE, or destructive CASCADE.
--
-- After applying, verify with:
--   SELECT proname, prosecdef FROM pg_proc
--   WHERE proname = 'phoenix_set_my_org_whatsapp_contact';
--   -- expect: 1 row, prosecdef = true
--
--   SELECT grantee, privilege_type FROM information_schema.routine_privileges
--   WHERE routine_name = 'phoenix_set_my_org_whatsapp_contact';
--   -- expect: authenticated / EXECUTE only — no anon row
-- ============================================================================

-- ============================================================================
-- A. The RPC
-- ============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_set_my_org_whatsapp_contact(p_enabled boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  IF v_profile.role NOT IN ('institution_admin', 'hospital_admin', 'monthly_status_officer') THEN
    RAISE EXCEPTION 'insufficient_role';
  END IF;

  -- Locate this caller's own existing official contact row for their org,
  -- if one already exists (by created_by, not by phone/display_name).
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

  -- p_enabled = true from here on.
  IF v_profile.whatsapp_phone IS NULL OR btrim(v_profile.whatsapp_phone) = '' THEN
    RAISE EXCEPTION 'whatsapp_phone_required';
  END IF;

  IF v_profile.whatsapp_phone !~ '^[0-9]{8,15}$' THEN
    RAISE EXCEPTION 'invalid_whatsapp_phone';
  END IF;

  v_display_name := CASE
    WHEN v_profile.role IN ('institution_admin', 'hospital_admin') THEN
      'مدير المؤسسة' || CASE WHEN v_profile.full_name IS NOT NULL AND btrim(v_profile.full_name) <> ''
                              THEN ' - ' || v_profile.full_name ELSE '' END
    ELSE
      'مسؤول المواقف الشهرية' || CASE WHEN v_profile.full_name IS NOT NULL AND btrim(v_profile.full_name) <> ''
                                       THEN ' - ' || v_profile.full_name ELSE '' END
  END;

  IF v_profile.role IN ('institution_admin', 'hospital_admin') THEN
    v_is_primary := true;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.organization_status_contacts
      WHERE organization_id = v_profile.organization_id
        AND is_active = true
        AND is_primary = true
        AND (v_existing_id IS NULL OR id <> v_existing_id)
    ) INTO v_has_active_primary;
    v_is_primary := NOT v_has_active_primary;
  END IF;

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
$$;

-- ============================================================================
-- B. Grants — authenticated only, never anon/PUBLIC
-- ============================================================================

REVOKE ALL ON FUNCTION public.phoenix_set_my_org_whatsapp_contact(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_set_my_org_whatsapp_contact(boolean) TO authenticated;

-- ============================================================================
-- C. Verification
-- ============================================================================

DO $$
DECLARE
  v_is_secdef boolean;
  v_authenticated_has_execute boolean;
  v_anon_has_execute boolean;
  v_fn_body text;
BEGIN
  SELECT prosecdef INTO v_is_secdef
  FROM pg_proc
  WHERE proname = 'phoenix_set_my_org_whatsapp_contact';

  ASSERT v_is_secdef IS TRUE, 'phoenix_set_my_org_whatsapp_contact must be SECURITY DEFINER';

  SELECT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_name = 'phoenix_set_my_org_whatsapp_contact'
      AND grantee = 'authenticated'
      AND privilege_type = 'EXECUTE'
  ) INTO v_authenticated_has_execute;

  ASSERT v_authenticated_has_execute IS TRUE, 'authenticated must have EXECUTE on phoenix_set_my_org_whatsapp_contact';

  SELECT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_name = 'phoenix_set_my_org_whatsapp_contact'
      AND grantee = 'anon'
      AND privilege_type = 'EXECUTE'
  ) INTO v_anon_has_execute;

  ASSERT v_anon_has_execute IS FALSE, 'anon must NOT have EXECUTE on phoenix_set_my_org_whatsapp_contact';

  SELECT pg_get_functiondef(oid) INTO v_fn_body
  FROM pg_proc
  WHERE proname = 'phoenix_set_my_org_whatsapp_contact';

  ASSERT v_fn_body LIKE '%auth.uid()%', 'function body must reference auth.uid()';
  ASSERT v_fn_body LIKE '%whatsapp_phone%', 'function body must reference profiles.whatsapp_phone';
  ASSERT v_fn_body LIKE '%organization_status_contacts%', 'function body must reference organization_status_contacts';
  ASSERT v_fn_body NOT LIKE '%service' || '_role%', 'function body must not reference the elevated service role';
  ASSERT v_fn_body NOT LIKE '%auth.' || 'admin%', 'function body must not reference the auth admin API';
END $$;

-- ============================================================================
-- END OF MIGRATION 046
-- ============================================================================
