-- ============================================================================
-- 011_phoenix_user_lifecycle_controls.sql
-- MediStock Phoenix V2
--
-- Adds:
--   1. users.disable and users.delete permission keys
--      (ON CONFLICT DO NOTHING — safe to re-run).
--   2. profiles.disabled_at / profiles.disabled_by audit columns
--      (IF NOT EXISTS — safe to re-run).
--
-- MANUAL APPLY ONLY — paste into Supabase Dashboard → SQL Editor and run.
-- DO NOT use "supabase db push" — this project manages migrations manually.
--
-- Prerequisites: migrations 001–010 must be applied first.
-- After applying:
--   1. Deploy admin-user-lifecycle Edge Function.
--   2. After apply, permission_keys count becomes 34.
--      Run: select count(*) from permission_keys;  -- expect 34
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Add new permission keys (users.disable, users.delete)
-- ----------------------------------------------------------------------------
insert into permission_keys (key, module, action, label_en, label_ar, is_dangerous)
values
  ('users.disable','users','disable','Disable users','تعطيل المستخدمين', true),
  ('users.delete', 'users','delete', 'Delete users', 'حذف المستخدمين',  true)
on conflict (key) do nothing;

-- super_admin gets both (all-keys policy already covers it via the wildcard
-- insert in 010, but be explicit here for clarity).
insert into role_permission_defaults (role, permission_key, is_allowed)
values
  ('super_admin','users.disable', true),
  ('super_admin','users.delete',  true)
on conflict (role, permission_key) do nothing;

-- All other roles default to false (no explicit row = denied by effective-perm logic).

-- ----------------------------------------------------------------------------
-- 2. Add audit columns to profiles (nullable, so existing rows are unaffected)
-- ----------------------------------------------------------------------------
alter table profiles
  add column if not exists disabled_at  timestamptz null,
  add column if not exists disabled_by  uuid        null references profiles(id) on delete set null;

-- ----------------------------------------------------------------------------
-- 3. Verify
-- ----------------------------------------------------------------------------
do $$
declare
  v_count int;
begin
  select count(*) into v_count from permission_keys where key in ('users.disable','users.delete');
  assert v_count = 2, 'Expected 2 new permission keys';
end $$;

-- select count(*) from permission_keys;  -- expect 34 (was 32 after 010)
