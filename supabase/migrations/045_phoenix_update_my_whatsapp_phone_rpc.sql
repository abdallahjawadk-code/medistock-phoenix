-- ============================================================================
-- 045_phoenix_update_my_whatsapp_phone_rpc.sql
-- MediStock Phoenix V2
--
-- Purpose:
--   DB-MY-ACCOUNT-WHATSAPP-RPC-A. The prior migration (044) added the
--   nullable public.profiles.whatsapp_phone column, and a separately
--   reviewed frontend/service phase (UX-MY-ACCOUNT-WHATSAPP-SAVE-A) already
--   calls supabase.rpc('phoenix_update_my_whatsapp_phone', { p_phone })
--   from src/shared/supabase/services/auth.service.ts — but that RPC did
--   not exist in the database yet, so every save attempt failed honestly
--   (function not found), never with a fake success. This migration adds
--   that missing RPC.
--
--   phoenix_mark_password_changed() (migration 016) is the exact precedent
--   this mirrors: this project's "no raw .update() on profiles in frontend
--   code" guardrail (phoenix-guardrails.test.ts) requires every self-service
--   profiles mutation to go through a SECURITY DEFINER RPC scoped to
--   auth.uid(), never a direct client-side table update.
--
-- What this migration does:
--   A. Creates public.phoenix_update_my_whatsapp_phone(p_phone text) —
--      updates ONLY the CALLING user's own whatsapp_phone, after
--      server-side re-validating the same digits-only 8-15 shape the
--      column's CHECK constraint (migration 044) and the frontend's
--      normalizeWhatsappPhone/isValidWhatsappPhone already enforce.
--   B. Revokes execute from PUBLIC/anon and grants it to authenticated only.
--   C. Verification block.
--
-- What this migration does NOT do:
--   - Does NOT accept a profile/user id parameter — the row to update is
--     found only via auth.uid(), so no caller can ever target another
--     user's row.
--   - Does NOT touch role, status, organization_id, full_name,
--     contact_email, or login_mode — the UPDATE statement's SET clause
--     names only whatsapp_phone.
--   - Does NOT change any RLS policy, and does NOT disable RLS anywhere.
--     (This RPC is SECURITY DEFINER precisely so it can perform its single,
--     narrowly-scoped write regardless of the caller's own RLS visibility —
--     exactly like phoenix_mark_password_changed already does.)
--   - Does NOT use service_role or auth.admin anywhere.
--   - Does NOT add a WhatsApp Cloud/Graph API call, token, or automatic
--     send — this is a plain data column update.
--   - Does NOT set a fake/default phone value and does NOT backfill any
--     existing row — only the calling user's own row is touched, only when
--     this function is explicitly invoked.
--   - Does NOT add any organization_status_contacts write path — that
--     remains an explicitly separate, later phase.
--
-- MANUAL APPLY ONLY — paste into Supabase Dashboard → SQL Editor and run.
-- DO NOT use "supabase db push" — this project manages migrations manually.
--
-- Prerequisites:
--   Migrations 001–044 must be applied (044 adds the whatsapp_phone column
--   and its format CHECK constraint this RPC re-validates).
--
-- Safety:
--   - CREATE OR REPLACE — idempotent, safe to re-run.
--   - SECURITY DEFINER + SET search_path = public — prevents search-path
--     hijacking, matches every existing phoenix_* RPC in this project.
--   - Server-side re-validation mirrors the DB CHECK constraint exactly, so
--     an invalid value can never reach the UPDATE even if a caller bypasses
--     client-side validation.
--   - No DROP, TRUNCATE, or destructive CASCADE.
--
-- After applying, verify with:
--   SELECT proname, prosecdef FROM pg_proc
--   WHERE proname = 'phoenix_update_my_whatsapp_phone';
--   -- expect: 1 row, prosecdef = true
--
--   SELECT grantee, privilege_type FROM information_schema.routine_privileges
--   WHERE routine_name = 'phoenix_update_my_whatsapp_phone';
--   -- expect: authenticated / EXECUTE only — no anon row
-- ============================================================================

-- ============================================================================
-- A. The RPC
-- ============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_update_my_whatsapp_phone(p_phone text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text := NULLIF(btrim(p_phone), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF v_phone IS NOT NULL AND v_phone !~ '^[0-9]{8,15}$' THEN
    RAISE EXCEPTION 'invalid_whatsapp_phone';
  END IF;

  UPDATE public.profiles
  SET whatsapp_phone = v_phone
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;
END;
$$;

-- ============================================================================
-- B. Grants — authenticated only, never anon/PUBLIC
-- ============================================================================

REVOKE ALL ON FUNCTION public.phoenix_update_my_whatsapp_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_update_my_whatsapp_phone(text) TO authenticated;

-- ============================================================================
-- C. Verification
-- ============================================================================

DO $$
DECLARE
  v_is_secdef boolean;
  v_authenticated_has_execute boolean;
  v_anon_has_execute boolean;
BEGIN
  SELECT prosecdef INTO v_is_secdef
  FROM pg_proc
  WHERE proname = 'phoenix_update_my_whatsapp_phone';

  ASSERT v_is_secdef IS TRUE, 'phoenix_update_my_whatsapp_phone must be SECURITY DEFINER';

  SELECT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_name = 'phoenix_update_my_whatsapp_phone'
      AND grantee = 'authenticated'
      AND privilege_type = 'EXECUTE'
  ) INTO v_authenticated_has_execute;

  ASSERT v_authenticated_has_execute IS TRUE, 'authenticated must have EXECUTE on phoenix_update_my_whatsapp_phone';

  SELECT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_name = 'phoenix_update_my_whatsapp_phone'
      AND grantee = 'anon'
      AND privilege_type = 'EXECUTE'
  ) INTO v_anon_has_execute;

  ASSERT v_anon_has_execute IS FALSE, 'anon must NOT have EXECUTE on phoenix_update_my_whatsapp_phone';
END $$;

-- ============================================================================
-- END OF MIGRATION 045
-- ============================================================================
