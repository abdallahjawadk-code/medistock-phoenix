-- ============================================================================
-- 016_phoenix_local_credentials_mode.sql
-- MediStock Phoenix V2
--
-- Purpose:
--   Adds local username + password login as an alternative to email-based
--   accounts (LOCAL-CREDENTIALS-MODE-A). Supabase Auth remains the only
--   authentication backend — local accounts simply use a synthesized,
--   non-deliverable internal email (<username>@local.medistock.invalid) as
--   their Supabase Auth identifier, so email delivery (SMTP) is never
--   required to create or recover a local account.
--
-- What this migration does:
--   A. Adds profiles.username, profiles.login_mode, profiles.contact_email,
--      profiles.must_change_password, profiles.password_changed_at.
--   B. Adds a unique, case-insensitive index on username (NULLs excluded).
--   C. Adds a CHECK constraint on username shape and on login_mode values.
--   D. Adds the phoenix_mark_password_changed() SECURITY DEFINER RPC, used
--      by the frontend after a successful self-service password change to
--      clear must_change_password — the frontend never writes that column
--      directly.
--   E. Verification block.
--
-- What this migration does NOT do:
--   - Does NOT modify auth.users.
--   - Does NOT migrate any existing user to local mode. All existing rows
--     keep login_mode = 'email' (the column default) until an admin
--     explicitly creates or recycles an account as local.
--   - Does NOT add a new permission key. Local-account creation reuses the
--     existing users.create permission; local-account recycling reuses the
--     existing users.recycle permission (see docs/account-lifecycle-policy.md
--     for the rationale). Admin-initiated temporary-password reset for an
--     already-local account is deferred to a future phase
--     (LOCAL-TEMP-PASSWORD-RESET-A) and is not implemented here.
--   - Does NOT reference elevated server keys.
--   - Does NOT add RLS policies — existing row-level policies on profiles
--     already scope which rows a caller can see/update; RLS does not
--     restrict columns, so no policy change is needed for the new columns.
--
-- MANUAL APPLY ONLY — paste into Supabase Dashboard → SQL Editor and run.
-- DO NOT use "supabase db push" — this project manages migrations manually.
--
-- Prerequisites:
--   Migrations 001–015 must be applied.
--
-- Safety:
--   - All DDL uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS — idempotent.
--   - No DROP, TRUNCATE, or destructive CASCADE.
--   - Safe to re-run.
--
-- After applying, verify with:
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'profiles'
--     AND column_name IN ('username', 'login_mode', 'contact_email',
--                          'must_change_password', 'password_changed_at')
--   ORDER BY column_name;
--   -- expect: 5 rows
--
--   SELECT routine_name FROM information_schema.routines
--   WHERE routine_name = 'phoenix_mark_password_changed';
--   -- expect: 1 row
-- ============================================================================

-- ============================================================================
-- A. New profiles columns
-- ============================================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS login_mode text NOT NULL DEFAULT 'email';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;

-- ============================================================================
-- B. Unique, case-insensitive index on username (NULLs excluded — most rows
--    stay email-mode with no username at all).
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_unique_idx
  ON profiles (lower(username))
  WHERE username IS NOT NULL;

-- ============================================================================
-- C. Shape + value constraints
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_username_format_chk'
  ) THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_username_format_chk
      CHECK (username IS NULL OR username ~ '^[a-z0-9._-]{3,32}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_login_mode_chk'
  ) THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_login_mode_chk
      CHECK (login_mode IN ('email', 'local'));
  END IF;
END $$;

-- ============================================================================
-- D. phoenix_mark_password_changed() — self-service bookkeeping RPC.
--    Lets the caller clear their OWN must_change_password flag after a
--    successful Supabase Auth password update. SECURITY DEFINER is required
--    because the frontend must never run a raw UPDATE on profiles for this
--    column (see phoenix-guardrails.test.ts: "no raw .update() on profiles
--    in frontend code"). Scoped strictly to auth.uid() — cannot target any
--    other profile.
-- ============================================================================

CREATE OR REPLACE FUNCTION phoenix_mark_password_changed()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  UPDATE profiles
  SET must_change_password = false,
      password_changed_at = now()
  WHERE id = v_uid;

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION phoenix_mark_password_changed() TO authenticated;

-- ============================================================================
-- E. Verification
-- ============================================================================

DO $$
DECLARE
  v_col_count integer;
  v_fn_exists boolean;
BEGIN
  SELECT count(*) INTO v_col_count
  FROM information_schema.columns
  WHERE table_name = 'profiles'
    AND column_name IN ('username', 'login_mode', 'contact_email',
                         'must_change_password', 'password_changed_at');
  ASSERT v_col_count = 5,
    'VERIFY FAILED: expected 5 new profiles columns, found ' || v_col_count;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.routines
    WHERE routine_name = 'phoenix_mark_password_changed'
  ) INTO v_fn_exists;
  ASSERT v_fn_exists,
    'VERIFY FAILED: phoenix_mark_password_changed() is missing';

  RAISE NOTICE 'Migration 016 verification passed: local credentials columns + RPC in place.';
END $$;

-- ============================================================================
-- END OF MIGRATION 016
--
-- Verification after applying:
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'profiles'
--     AND column_name IN ('username', 'login_mode', 'contact_email',
--                          'must_change_password', 'password_changed_at')
--   ORDER BY column_name;
--
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'profiles' AND indexname = 'profiles_username_unique_idx';
--
--   SELECT conname FROM pg_constraint
--   WHERE conname IN ('profiles_username_format_chk', 'profiles_login_mode_chk');
--
-- NOTE: This migration does NOT migrate any existing user to local mode.
--       Existing users remain login_mode = 'email' unless an admin explicitly
--       creates or recycles their account as local (admin-create-user /
--       admin-recycle-user Edge Functions, deployed separately after this
--       migration is applied and reviewed).
-- ============================================================================
