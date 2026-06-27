# Phoenix V2 — Create / Confirm the First `super_admin` (Final)

**Project ref:** `eyrzxgfkvqybjdgyphap`
**Run in:** Supabase Dashboard → SQL Editor (NOT `npx supabase db push`)
**Prerequisite:** migrations 001–004 already applied; wipe verified `OK_FULL_WIPE_PHOENIX_READY`.

> This step cannot be performed from the app or from the build agent — it needs
> privileged SQL access to `auth.users` / `public.profiles`, which is only
> available in the Supabase SQL Editor. The frontend uses the anon key only and
> must never hold a privileged key.

---

## Step 1 — Check whether a super_admin already exists

```sql
select id, full_name, role, status
from public.profiles
where role = 'super_admin';
```

- **If a row exists and it is the correct person** → done. Nothing else to do.
- **If no row exists** → continue to Step 2.

---

## Step 2 — Confirm the Auth user

The profile `id` MUST equal an existing `auth.users.id`. Do not invent UUIDs.

Find the user in **Authentication → Users**, or list candidates:

```sql
select id, email, created_at
from auth.users
order by created_at
limit 20;
```

**Candidate email (confirm this is the real Auth user before running):**
`abdallahjawad2015@gmail.com`

> ⚠️ This email is the project owner's account address. Verify it actually exists
> in `auth.users` for this project. If the Auth user uses a different email,
> use that one instead — do not guess.

---

## Step 3 — Create / promote the super_admin (email lookup)

Replace the email only if Step 2 showed a different address.

```sql
do $$
declare
  v_uid uuid;
begin
  select id into v_uid
  from auth.users
  where email = 'abdallahjawad2015@gmail.com'   -- ← confirm / replace
  limit 1;

  if v_uid is null then
    raise exception 'No auth user for that email. Check Authentication → Users.';
  end if;

  insert into public.profiles (id, organization_id, full_name, role, status)
  values (v_uid, null, 'Abdallah Jawad', 'super_admin', 'active')
  on conflict (id) do update
    set role      = 'super_admin',
        status    = 'active',
        full_name = excluded.full_name,
        updated_at = now();

  raise notice 'super_admin profile set for %', v_uid;
end $$;
```

`organization_id` is `null` on purpose — a super_admin is global, not pinned to one
organization. The frontend lets a super_admin pick the org scope at runtime.

### Alternative — by known UUID

If you already have the UUID from Authentication → Users:

```sql
insert into public.profiles (id, organization_id, full_name, role, status)
values ('PASTE-AUTH-USER-UUID'::uuid, null, 'Abdallah Jawad', 'super_admin', 'active')
on conflict (id) do update
  set role = 'super_admin', status = 'active', updated_at = now();
```

---

## Step 4 — Verify

```sql
select id, full_name, role, status
from public.profiles
where role = 'super_admin';
```

Expected: exactly one active `super_admin` row for the correct person.

---

## Step 5 — Sign in

1. Open the deployed app (or `npm run dev` locally with `.env.local` filled).
2. Sign in with the super_admin **email + password** (the password is the one set
   for that user in Supabase Auth — reset it from Authentication → Users if unknown).
3. The sidebar should show the profile name with role `super_admin`, and the org
   scope selector should list all organizations.

---

## Notes

- New users self-register through Supabase Auth; the `phoenix_handle_new_user`
  trigger auto-creates their `profiles` row with role `viewer`. Promote them with
  the same `on conflict do update` pattern above (changing the target role).
- Never store a service-role / secret key in the frontend or in Vercel env vars.
