# MediStock-Babil Phoenix V2 — User Identity Snapshot Plan

**Plan ID:** USER-IDENTITY-SNAPSHOT-FOUNDATION-A (future phase)  
**Status:** Design only — not yet implemented  
**Depends on:** ACCOUNT-LIFECYCLE-POLICY-A (complete)

---

## 1. Problem Statement

When a user account is recycled (reassigned from one real person to another), simply updating `profiles.full_name` and `profiles.email` causes retroactive identity substitution: all historical operations appear to have been performed by the new person. This is a data integrity violation.

The fix is to **snapshot the user's identity at the moment of recycling** and carry that snapshot forward into every operation record that references the actor.

---

## 2. New Table: `user_identity_history`

Records each distinct identity version of every profile. Created when a profile is recycled.

```sql
create table if not exists user_identity_history (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null references profiles(id) on delete cascade,
  identity_version  int  not null,
  full_name         text not null,
  email             text not null,
  role              text not null,
  organization_id   uuid references organizations(id) on delete set null,
  valid_from        timestamptz not null default now(),
  valid_until       timestamptz null,           -- null = current version
  recycled_by       uuid references profiles(id) on delete set null,
  recycled_at       timestamptz null,
  unique (profile_id, identity_version)
);
```

**When a row is written:**
- On the first recycling of a profile: `identity_version = 1`, `valid_until = now()`.
- On subsequent recyclings: `identity_version` increments.
- The current live identity is always readable from `profiles` itself — `user_identity_history` only stores past versions.

---

## 3. New Column: `profiles.identity_version`

```sql
alter table profiles
  add column if not exists identity_version int not null default 0;
```

- Starts at `0` for all existing accounts (never recycled).
- Incremented to `1`, `2`, … on each recycling event.
- Allows any operation record to pin the exact version of the actor's identity at the time of the operation.

---

## 4. Actor Snapshot Fields on Operation Tables

Every table that records who performed an action must carry snapshot fields so that historical records survive future profile recycling. These fields are **denormalized copies** of the actor's identity at the moment of the operation — they do not change retroactively when the profile is recycled.

### Required snapshot fields per operation table:

| Column | Type | Description |
|---|---|---|
| `actor_name_snapshot` | `text` | `profiles.full_name` at time of operation |
| `actor_email_snapshot` | `text` | Actor's email at time of operation |
| `actor_role_snapshot` | `text` | `profiles.role` at time of operation |
| `actor_org_snapshot` | `text` | Organization name at time of operation |
| `actor_identity_version` | `int` | `profiles.identity_version` at time of operation |

### Tables requiring review before implementation:

| Table | Current actor reference | Needs snapshot columns? |
|---|---|---|
| `audit_logs` | `user_id` | ✅ Yes |
| `institution_item_status_reports` | `created_by` (likely) | ✅ Yes |
| `item_availability` | implicit (org-scoped) | Review |
| `qr_tokens` | `created_by` (if present) | Review |
| `organization_status_contacts` | `created_by` (if present) | Review |
| `profile_permission_overrides` | `set_by` (if present) | Review |
| `profiles` | self | `identity_version` column |

**Audit before implementation:** Run `rg "created_by|actor_id|set_by|performed_by"` across `supabase/migrations/` to identify all tables carrying actor references, then confirm snapshot columns are present or planned for each.

---

## 5. How Old Operations Stay Old

After a profile is recycled:

1. The profile row is updated with the new person's `full_name`, `email`, and `identity_version` is incremented.
2. The old identity is preserved in `user_identity_history`.
3. Historical operation records carry `actor_name_snapshot` / `actor_identity_version` that were written at operation time — **they do not change**.
4. Reporting queries join on `actor_identity_version` + `profile_id` to `user_identity_history` to display the correct name for historical records.
5. Live/recent queries display the current `profiles.full_name` via the normal join.

---

## 6. How New Operations Use the New Identity

After recycling:

1. The new person logs in using the recycled account.
2. New operations are written with the current `profiles.full_name`, `profiles.email`, and `profiles.identity_version` (now incremented).
3. These new records are correctly attributed to the new person.
4. Old records with a lower `actor_identity_version` remain attributed to the old person via `user_identity_history`.

---

## 7. Recycling Workflow (Future Implementation)

The recycling workflow must be an atomic server-side operation (Edge Function or SECURITY DEFINER RPC), never a sequence of frontend calls:

```
1. Validate caller is super_admin.
2. Validate target account is suspended.
3. Validate target account has no pending operations that could cause confusion.
4. INSERT into user_identity_history (profile_id, identity_version, full_name, email, role, organization_id, valid_from = now(), valid_until = now()).
5. UPDATE profiles SET identity_version = identity_version + 1, full_name = <new>, email = <new>, organization_id = <new-org-if-changed>.
6. UPDATE auth.users email via auth.admin.updateUserById (server-side only).
7. Re-enable account (remove ban).
8. RETURN { ok: true, new_identity_version }.
```

If any step fails, the entire operation must be rolled back (use a database transaction).

---

## 8. What Must NOT Be Done Before This Is Implemented

- Do not edit `profiles.full_name` or `profiles.email` to reassign an account to a different real person.
- Do not use the permission matrix or role assignment to approximate recycling.
- Do not create `user_identity_history` as a standalone migration without also adding snapshot columns to all operation tables — partial implementation is worse than no implementation.
- Do not implement recycling in the frontend UI before the server-side atomic workflow is complete.

---

## 9. Tables Requiring Full Review Before Implementation

Before implementing this plan, run the following audit and confirm every table is handled:

```bash
rg "created_by|actor_id|set_by|performed_by|user_id|profile_id" supabase/migrations/ --type sql
```

Expected findings to resolve:
- `audit_logs.user_id` → add snapshot columns or confirm full_name is already denormalized
- Status report tables → add `actor_name_snapshot`, `actor_role_snapshot`
- Permission override tables → add `set_by_name_snapshot` if audit trail is required
- QR token tables → review `created_by` and add snapshot if needed

Only after all operation tables are reviewed and updated should migration 013 be authored and applied.
