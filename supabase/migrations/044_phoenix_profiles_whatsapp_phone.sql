-- ============================================================================
-- 044_phoenix_profiles_whatsapp_phone.sql
-- MediStock Phoenix V2
--
-- Purpose:
--   DB-MY-ACCOUNT-WHATSAPP-PHONE-A. Adds a real, nullable personal WhatsApp
--   phone column to profiles so a future, separately-reviewed My Account
--   change can let every user save their own WhatsApp number. A prior
--   validate-only My Account UI was reverted because it had nowhere real to
--   persist the number (profiles had no phone/whatsapp/contact_phone column
--   at all — see migration 008's comment: "profiles has no phone field, so
--   contact name + phone live here [organization_status_contacts]"). This
--   migration is preparation only: it adds the column and its shape
--   constraint, nothing else. No frontend code reads or writes this column
--   yet.
--
-- What this migration does:
--   A. Adds profiles.whatsapp_phone (nullable text).
--   B. Adds a CHECK constraint: NULL, or digits-only, 8–15 characters —
--      mirrors the exact same shape rule normalizeWhatsappPhone() /
--      isValidWhatsappPhone() already enforce client-side
--      (src/shared/lib/whatsapp.ts), so a value that passes client
--      validation will also pass this constraint, and vice versa.
--   C. Verification block.
--
-- What this migration does NOT do:
--   - Does NOT set NOT NULL — every existing row gets NULL, not a fake number.
--   - Does NOT set a default value.
--   - Does NOT backfill any existing row.
--   - Does NOT modify any other column, table, role, or user status logic.
--   - Does NOT add or change any RLS policy. The existing self-update policy
--     (profiles_update_own, migration 002) already allows an authenticated
--     user to update their own profile row for any column except role
--     ("role = (select role from profiles where id = auth.uid())" — cannot
--     self-promote). RLS in Postgres is row-scoped, not column-scoped, so
--     this pre-existing policy already covers the new column with no change
--     needed — mirrors migration 016's identical reasoning when it added
--     username/login_mode/contact_email/must_change_password.
--   - Does NOT add any RPC, Edge Function, or frontend service/UI.
--   - Does NOT touch alert lifecycle, QR, export/print, or user-management
--     logic — this migration only adds one nullable column + one CHECK
--     constraint to profiles.
--
-- MANUAL APPLY ONLY — paste into Supabase Dashboard → SQL Editor and run.
-- DO NOT use "supabase db push" — this project manages migrations manually.
--
-- Prerequisites:
--   Migrations 001–043 must be applied.
--
-- Safety:
--   - ADD COLUMN IF NOT EXISTS — idempotent.
--   - CHECK constraint guarded by a pg_constraint existence check — idempotent,
--     safe to re-run (mirrors migration 016's profiles_username_format_chk /
--     profiles_login_mode_chk pattern).
--   - No DROP, TRUNCATE, or destructive CASCADE.
--   - No data written or modified — every existing row simply gains a NULL
--     whatsapp_phone.
--
-- After applying, verify with:
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'profiles' AND column_name = 'whatsapp_phone';
--   -- expect: 1 row, is_nullable = 'YES', column_default = NULL
--
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname = 'profiles_whatsapp_phone_format_chk';
--   -- expect: 1 row
-- ============================================================================

-- ============================================================================
-- A. New nullable profiles column
-- ============================================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS whatsapp_phone text;

-- ============================================================================
-- B. Shape constraint — NULL or digits-only, 8-15 characters. Same rule
--    src/shared/lib/whatsapp.ts's normalizeWhatsappPhone()/isValidWhatsappPhone()
--    already enforce client-side (no country-code guessing, no separators).
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_whatsapp_phone_format_chk'
  ) THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_whatsapp_phone_format_chk
      CHECK (whatsapp_phone IS NULL OR whatsapp_phone ~ '^[0-9]{8,15}$');
  END IF;
END $$;

-- ============================================================================
-- C. Verification
-- ============================================================================

DO $$
DECLARE
  v_column_exists boolean;
  v_is_nullable   text;
  v_constraint_exists boolean;
BEGIN
  SELECT true, is_nullable INTO v_column_exists, v_is_nullable
  FROM information_schema.columns
  WHERE table_name = 'profiles' AND column_name = 'whatsapp_phone';

  ASSERT v_column_exists IS TRUE, 'profiles.whatsapp_phone column was not created';
  ASSERT v_is_nullable = 'YES', 'profiles.whatsapp_phone must remain nullable (no NOT NULL)';

  SELECT true INTO v_constraint_exists
  FROM pg_constraint WHERE conname = 'profiles_whatsapp_phone_format_chk';

  ASSERT v_constraint_exists IS TRUE, 'profiles_whatsapp_phone_format_chk constraint was not created';
END $$;

-- ============================================================================
-- END OF MIGRATION 044
-- ============================================================================
