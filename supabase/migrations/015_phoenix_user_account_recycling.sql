-- ============================================================================
-- 015_phoenix_user_account_recycling.sql
-- MediStock Phoenix V2
--
-- Purpose:
--   Registers the permission key and role defaults required for user account
--   recycling (USER-ACCOUNT-RECYCLE-PERMISSION-A).
--
--   This migration does NOT implement recycling logic.
--   It does NOT modify auth.users.
--   It does NOT add RLS policies on user_identity_history.
--   It is permission key registration only.
--
-- What this migration does:
--   A. Inserts `users.recycle` into permission_keys.
--   B. Seeds role_permission_defaults: super_admin = allowed.
--   C. Verification block.
--
-- What this migration does NOT do:
--   - Does NOT implement account recycling workflow or logic
--   - Does NOT modify auth.users or any user data
--   - Does NOT add RLS policies on user_identity_history (that table is
--     only accessed via SECURITY DEFINER functions and the Edge Function
--     via elevated server keys — no direct client reads needed)
--   - Does NOT reference elevated server keys
--   - Does NOT add UI or Edge Function changes
--
-- MANUAL APPLY ONLY — paste into Supabase Dashboard → SQL Editor and run.
-- DO NOT use "supabase db push" — this project manages migrations manually.
--
-- Prerequisites:
--   Migrations 001–014 must be applied.
--
-- Safety:
--   - All DML uses ON CONFLICT DO NOTHING — idempotent.
--   - No DROP, TRUNCATE, or destructive CASCADE.
--   - Safe to re-run.
--
-- After applying, verify with:
--   SELECT key, module, action, is_dangerous
--   FROM permission_keys
--   WHERE key = 'users.recycle';
--   -- expect: 1 row, is_dangerous = true
--
--   SELECT role, permission_key, allowed
--   FROM role_permission_defaults
--   WHERE permission_key = 'users.recycle';
--   -- expect: 1 row, role = 'super_admin', allowed = true
-- ============================================================================

-- ============================================================================
-- A. Permission key: users.recycle
--    Marks the ability to recycle (re-assign) user accounts.
--    is_dangerous = true — only super_admin should have this by default.
-- ============================================================================

INSERT INTO permission_keys (key, module, action, label_en, label_ar, is_dangerous) VALUES
  ('users.recycle', 'users', 'recycle', 'Recycle accounts', 'تدوير الحسابات', true)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- B. Role defaults
--    super_admin: allowed = true
--    All other roles: no row inserted (= false by default).
-- ============================================================================

INSERT INTO role_permission_defaults (role, permission_key, allowed) VALUES
  ('super_admin', 'users.recycle', true)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- C. Verification
-- ============================================================================

do $$
declare
  v_key_exists boolean;
begin
  -- Verify permission key exists
  SELECT EXISTS (
    SELECT 1 FROM permission_keys
    WHERE key = 'users.recycle'
  ) INTO v_key_exists;
  assert v_key_exists,
    'VERIFY FAILED: permission key users.recycle is missing from permission_keys';

  raise notice 'Migration 015 verification passed: users.recycle permission key registered.';
end $$;

-- ============================================================================
-- END OF MIGRATION 015
--
-- Verification after applying:
--   SELECT key, module, action, label_en, label_ar, is_dangerous
--   FROM permission_keys
--   WHERE key = 'users.recycle';
--   -- expect: 1 row
--   --   key = 'users.recycle'
--   --   module = 'users'
--   --   action = 'recycle'
--   --   label_en = 'Recycle accounts'
--   --   label_ar = 'تدوير الحسابات'
--   --   is_dangerous = true
--
--   SELECT role, permission_key, allowed
--   FROM role_permission_defaults
--   WHERE permission_key = 'users.recycle';
--   -- expect: 1 row, role = 'super_admin', allowed = true
--
-- NOTE: This migration does NOT implement account recycling logic.
--       Recycling workflow (ACCOUNT-RECYCLE-WORKFLOW-A) is a separate future phase.
-- ============================================================================
