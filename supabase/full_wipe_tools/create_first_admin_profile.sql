-- =============================================================================
-- MediStock Phoenix — Create First Admin Profile
-- Run AFTER migrations 001-004 are applied.
-- Maps an existing Supabase Auth user to the super_admin role.
--
-- Usage:
--   1. Find your user's UUID in Supabase Dashboard → Authentication → Users
--   2. Replace 'YOUR-AUTH-USER-UUID-HERE' with your actual UUID
--   3. Replace 'Your Full Name' with your name
--   4. Run in Supabase SQL Editor
-- =============================================================================

-- Option A: Use a known UUID
-- Replace the UUID and name before running.
insert into public.profiles (id, full_name, role, status)
values (
  'YOUR-AUTH-USER-UUID-HERE'::uuid,
  'Your Full Name',
  'super_admin',
  'active'
)
on conflict (id) do update
  set role   = 'super_admin',
      status = 'active';

-- Option B: Use a known email (looks up auth.users)
-- Uncomment and use this block if you prefer email lookup.
/*
do $$
declare
  v_uid uuid;
begin
  select id into v_uid
  from auth.users
  where email = 'your-email@example.com'
  limit 1;

  if v_uid is null then
    raise exception 'User not found for that email. Check spelling.';
  end if;

  insert into public.profiles (id, full_name, role, status)
  values (v_uid, 'Admin', 'super_admin', 'active')
  on conflict (id) do update
    set role   = 'super_admin',
        status = 'active';

  raise notice 'super_admin profile set for user %', v_uid;
end $$;
*/

-- Verify
select id, full_name, role, status, created_at
from public.profiles
where role = 'super_admin';
