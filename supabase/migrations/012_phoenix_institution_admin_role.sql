-- ============================================================================
-- 012_phoenix_institution_admin_role.sql
-- MediStock Phoenix V2
--
-- Adds the institution_admin role:
--   1. Expands profiles.role CHECK constraint to allow 'institution_admin'.
--   2. Seeds institution_admin role defaults into role_permission_defaults.
--   3. Conditionally grants users.disable to institution_admin if migration 011
--      has been applied (the users.disable key exists).
--
-- MANUAL APPLY ONLY — paste into Supabase Dashboard → SQL Editor and run.
-- DO NOT use "supabase db push" — this project manages migrations manually.
--
-- Prerequisites: migrations 001–010 must be applied.
--   If migration 011 was also applied (recommended): users.disable is
--   automatically granted to institution_admin by step 3.
--
-- After applying:
--   Verify with:
--     select role, count(*) from role_permission_defaults
--       where role = 'institution_admin' group by role;
--     -- expect 13 rows (or 14 if migration 011 was applied)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Expand profiles.role CHECK to include institution_admin
-- ----------------------------------------------------------------------------
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check check (
  role in (
    'super_admin', 'institution_admin',
    'warehouse_officer', 'port_officer', 'monthly_status_officer', 'viewer',
    'hospital_admin', 'warehouse_manager', 'point_operator', 'transfer_manager'
  )
);

-- ----------------------------------------------------------------------------
-- 2. Seed institution_admin role defaults (mirrors permissions.ts)
-- ----------------------------------------------------------------------------
insert into role_permission_defaults (role, permission_key, allowed)
values
  ('institution_admin', 'dashboard.view',                true),
  ('institution_admin', 'organizations.view',            true),
  ('institution_admin', 'users.view',                    true),
  ('institution_admin', 'users.create',                  true),
  ('institution_admin', 'users.assign_role',             true),
  ('institution_admin', 'warehouses.view',               true),
  ('institution_admin', 'ports.view',                    true),
  ('institution_admin', 'availability.view',             true),
  ('institution_admin', 'status_center.view',            true),
  ('institution_admin', 'exchange_alerts.view',          true),
  ('institution_admin', 'inter_institution_alerts.view', true),
  ('institution_admin', 'status_contacts.view',          true),
  ('institution_admin', 'status_contacts.manage',        true)
on conflict (role, permission_key) do nothing;

-- ----------------------------------------------------------------------------
-- 3. Grant users.disable to institution_admin if migration 011 was applied
--    (safe no-op if users.disable key does not yet exist)
-- ----------------------------------------------------------------------------
insert into role_permission_defaults (role, permission_key, allowed)
  select 'institution_admin', key, true
  from permission_keys
  where key = 'users.disable'
on conflict (role, permission_key) do nothing;

-- ----------------------------------------------------------------------------
-- 4. Verify
-- ----------------------------------------------------------------------------
do $$
declare
  v_count int;
begin
  select count(*) into v_count from role_permission_defaults
    where role = 'institution_admin';
  assert v_count >= 13, format('Expected at least 13 institution_admin permission rows, got %s', v_count);
end $$;
