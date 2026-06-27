# Admin Access After Full Wipe

**Project ref:** `eyrzxgfkvqybjdgyphap`  
**Created:** 2026-06-27

---

## What Happens to Auth Users

The full wipe drops only the `public` schema. **Auth users in `auth.users` are NOT deleted.**

However, the `public.profiles` table is recreated empty after the wipe. This means:
- Auth users can still log in
- But they have no `profiles` row → they are treated as unauthenticated by RLS
- All RLS policies that call `phoenix_my_role()` will return `null` → SELECT/INSERT denied

**You must create a `profiles` row for at least one admin user before using the app.**

---

## Step 1 — Find Your Auth User UUID

1. Go to [Supabase Dashboard → Authentication → Users](https://supabase.com/dashboard/project/eyrzxgfkvqybjdgyphap/auth/users)
2. Find your email
3. Copy the UUID (shown in the Id column)

---

## Step 2 — Create Admin Profile

Run the helper SQL file:
```
supabase/full_wipe_tools/create_first_admin_profile.sql
```

**Option A** (UUID-based — recommended):
1. Open the file
2. Replace `'YOUR-AUTH-USER-UUID-HERE'` with your actual UUID
3. Replace `'Your Full Name'` with your name
4. Run in Supabase SQL Editor

**Option B** (email-based — uncomment the second block):
1. Replace `'your-email@example.com'`
2. Run in SQL Editor

---

## Step 3 — Verify

After running the SQL, verify in the SQL Editor:
```sql
select id, full_name, role, status from public.profiles where role = 'super_admin';
```

Expected: one row with `role = 'super_admin'` and `status = 'active'`.

---

## Step 4 — Log In via Phoenix Frontend

1. Start the Phoenix dev server: `npm run dev` from `C:\Users\abdal\OneDrive\Desktop\phoenix`
2. Navigate to `http://localhost:5174`
3. Click the `super_admin` role chip
4. Click **Demo Login** (or configure real Supabase auth if anon key is set)

---

## Other Users

After the admin is set up, create additional profiles via SQL or the Users Management page (when wired in a future phase):

```sql
-- Example: create hospital_admin for existing auth user
insert into public.profiles (id, full_name, organization_id, role, status)
values (
  'ANOTHER-USER-UUID'::uuid,
  'Hospital Admin Name',
  '00000000-0000-0000-0000-000000000001',   -- Babil General Hospital (from seed)
  'hospital_admin',
  'active'
);
```

---

## Role Reference

| Role | Access |
|------|--------|
| `super_admin` | Full access, all organizations, can purge |
| `hospital_admin` | Full access within own organization |
| `warehouse_manager` | Read all in org; write warehouses + availability |
| `point_operator` | Read all in org; update item_availability only |
| `viewer` | Read-only within own organization |
