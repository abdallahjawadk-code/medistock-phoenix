# MediStock-Babil Phoenix V2 — User Identity Snapshot Plan

**Plan ID:** USER-IDENTITY-SNAPSHOT-FOUNDATION-A  
**Status:** Foundation authored — migration 013 written, pending manual apply  
**Depends on:** ACCOUNT-LIFECYCLE-POLICY-A (complete)  
**Next phase:** ACTOR-SNAPSHOT-WRITE-PATHS-A (wire snapshot fields into Edge Function write paths)

---

## 1. Problem Statement

When a user account is recycled (reassigned from one real person to another), simply updating `profiles.full_name` and `profiles.email` causes retroactive identity substitution: all historical operations appear to have been performed by the new person. This is a data integrity violation.

The fix is to **snapshot the user's identity at the moment of recycling** and carry that snapshot forward into every operation record that references the actor.

---

## 2. New Table: `user_identity_history`

**Status: Created in migration 013** (`013_phoenix_user_identity_snapshot_foundation.sql`).

Records each distinct identity version of every profile. The initial row (version 1) is seeded from existing profiles by migration 013 with `valid_until = null` (meaning this identity is still current). A new row is written at recycling time.

```sql
create table if not exists public.user_identity_history (
  id               uuid        primary key default gen_random_uuid(),
  profile_id       uuid        not null references public.profiles(id) on delete cascade,
  identity_version integer     not null,
  full_name        text,
  email            text,
  role             text,
  organization_id  uuid        references public.organizations(id) on delete set null,
  valid_from       timestamptz not null default now(),
  valid_until      timestamptz,           -- null = this version is still the current one
  change_reason    text        not null default 'initial_snapshot',
  recycled_by      uuid        references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (profile_id, identity_version)
);
```

**When a row is written:**
- Migration 013 seeds one row per existing profile: `identity_version = 1`, `valid_until = null`.
- On the first recycling of a profile: the existing row gets `valid_until = now()`, then a new row is inserted with `identity_version = 2`, `valid_until = null`.
- The current live identity is always readable from `profiles` itself — `user_identity_history` stores all past versions.

---

## 3. New Column: `profiles.identity_version`

**Status: Added in migration 013.**

```sql
alter table public.profiles
  add column if not exists identity_version integer not null default 1;
```

- Starts at `1` for all existing accounts (version 1 = never recycled).
- Incremented to `2`, `3`, … on each recycling event.
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

### Tables — audit results and coverage status:

**Audit command run:** `rg "created_by|actor_id|set_by|performed_by|user_id|profile_id" supabase/migrations/ --type sql`

| Table | Actor column(s) | Snapshot columns added | Notes |
|---|---|---|---|
| `audit_logs` | `actor_id` (→ auth.users), `actor_role` (already denorm) | ✅ Yes (migration 013) | Added name, email, org, identity_version. No role_snapshot needed — actor_role already exists. |
| `institution_item_status_reports` | `submitted_by` (→ auth.users), `resolved_by` (→ auth.users) | ✅ Yes (migration 013) | Snapshots cover submitted_by (primary actor). resolved_by tracked in future phase. |
| `item_availability` | `last_updated_by` (→ auth.users) | ✅ Yes (migration 013) | All 5 snapshot fields added. |
| `qr_tokens` | `created_by` (→ auth.users), `disabled_by` (→ auth.users) | ✅ Yes (migration 013) | Snapshots cover created_by (primary actor). disabled_by tracked in future phase. |
| `organization_status_contacts` | `created_by` (→ profiles) | ✅ Yes (migration 013) | All 5 snapshot fields added. |
| `profile_permission_overrides` | `created_by` (→ profiles) | ✅ Yes (migration 013) | All 5 snapshot fields added. Column in code was `created_by`, not `set_by`. |
| `profiles` | self | ✅ `identity_version` added (migration 013) | — |

**Structural tables NOT covered** (created_by = entity creator for structural/catalog data, not operational audit actor):

| Table | created_by column | Why excluded |
|---|---|---|
| `organizations` | `created_by` → profiles | Structural creator, not an operational record |
| `warehouses` | `created_by`, `archived_by` → profiles | Structural |
| `distribution_points` | `created_by`, `archived_by` → profiles | Structural |
| `central_items` | `created_by` → profiles | Catalog management |
| `local_items` | `created_by`, `archived_by` → profiles | Catalog management |
| `qr_targets` | `created_by` → profiles | Structural |

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

## 8. What Must NOT Be Done Before the Write-Path Phase

- Do not edit `profiles.full_name` or `profiles.email` to reassign an account to a different real person.
- Do not use the permission matrix or role assignment to approximate recycling.
- Do not implement recycling in the frontend UI before the server-side atomic workflow is complete (ACCOUNT-RECYCLE-WORKFLOW-A).
- Do not create `user_identity_history` without also adding snapshot columns to all operation tables — partial implementation is worse than no implementation (migration 013 covers both together).
- The snapshot columns added in migration 013 will be `null` for all existing rows until write paths are wired. This is intentional — they are populated at the moment of the operation going forward (ACTOR-SNAPSHOT-WRITE-PATHS-A).

---

## 9. Foundation Applied — What Was Done in Migration 013

Migration 013 (`013_phoenix_user_identity_snapshot_foundation.sql`) completes the USER-IDENTITY-SNAPSHOT-FOUNDATION-A phase:

- ✅ `profiles.identity_version` column added (default 1).
- ✅ `user_identity_history` table created with unique(profile_id, identity_version) constraint.
- ✅ Initial identity snapshots seeded for all existing profiles (one row per profile, version 1, valid_until = null).
- ✅ Actor snapshot columns (`actor_name_snapshot`, `actor_email_snapshot`, `actor_role_snapshot`, `actor_org_snapshot`, `actor_identity_version`) added to 6 operational tables.
- ✅ Backfill applied for existing rows (best-effort; nulls remain where actor cannot be resolved).
- ✅ `get_profile_identity_snapshot(profile_id)` helper RPC added for use by future write paths.

**Next phase:** ACTOR-SNAPSHOT-WRITE-PATHS-A — wire the snapshot columns into Edge Function write operations so new records are always populated at creation time.
