# Manual Supabase Migrations — MediStock-Babil Phoenix V2

These migrations are **applied manually** via the Supabase SQL Editor after review.
They are **NOT** auto-applied by the app and **MUST NOT** be applied with
`npx supabase db push`.

> ⚠️ **Always take a backup before applying any migration.**
> Supabase Dashboard → Database → Backups (or `pg_dump`). Do not proceed
> without a verified, restorable backup.

## Why manual

- The app reads/writes only via RLS-protected tables and `security definer` RPCs.
  Schema changes are an operator action, not a runtime action.
- `db push` can re-order or re-apply files unexpectedly against a live database.
  Each migration here is idempotent-friendly and reviewed individually.
- This keeps schema changes auditable and reversible one step at a time.

## Apply order

Apply strictly in order. Each builds on the previous schema.

| # | File | Purpose |
|---|------|---------|
| 001 | `001_phoenix_core_schema.sql` | Core 10-table schema, triggers, auto-profile |
| 002 | `002_phoenix_rls_policies.sql` | Row-level security policies |
| 003 | `003_phoenix_rpc_lifecycle.sql` | Lifecycle RPCs (archive / purge / QR) |
| 004 | `004_phoenix_seed_demo_data.sql` | Optional demo seed (skip in production) |
| **005** | `005_phoenix_assign_profile_role.sql` | Guarded role-assignment RPC |
| **006** | `006_phoenix_status_reports.sql` | Institution item status reports table + RLS |
| **007** | `007_phoenix_clear_port_availability.sql` | Safe clear-port-availability RPC |
| **008** | `008_phoenix_org_status_contacts.sql` | Org Monthly Status Officer / contact table + RLS (no anon) |
| **009** | `009_phoenix_inter_institution_alerts.sql` | `get_scoped_inter_institution_alerts` RPC for secure inter-institution alerts |
| **010** | `010_phoenix_user_permission_matrix.sql` | Official role model + permission matrix (seeds **32** permission keys) + RPCs |
| **011** | `011_phoenix_user_lifecycle_controls.sql` | Adds `users.disable` + `users.delete` keys (→ 34 total); `profiles.disabled_at/disabled_by` audit columns |
| **012** | `012_phoenix_institution_admin_role.sql` | Expands `profiles.role` CHECK to allow `institution_admin`; seeds 13 default permissions |
| **013** | `013_phoenix_user_identity_snapshot_foundation.sql` | Identity snapshot foundation: `profiles.identity_version`, `user_identity_history`, actor snapshot columns on 6 operational tables, initial backfill, helper RPC |
| **014** | `014_phoenix_actor_snapshot_write_path_triggers.sql` | Actor snapshot write-path triggers: BEFORE INSERT/UPDATE triggers on 6 operational tables to auto-populate actor snapshot fields |
| **015** | `015_phoenix_user_account_recycling.sql` | Account recycling permission: `users.recycle` permission key + super_admin default |
| **016** | `016_phoenix_local_credentials_mode.sql` | Local username credentials mode (LOCAL-CREDENTIALS-MODE-A): `profiles.username/login_mode/contact_email/must_change_password/password_changed_at` + `phoenix_mark_password_changed()` RPC |
| **017** | `017_phoenix_permission_rpc_42703_fix.sql` | Fixes a 42703 (undefined_column) error in the permission RPC stack (PERMISSION-RPC-42703-FIX-B): re-asserts `phoenix_profile_has_permission`, and makes the trailing `audit_logs` insert in `assign_profile_permissions`/`reset_profile_permissions` exception-safe so an audit-log schema mismatch can never roll back an already-successful permission write |

Apply each one **manually**, in this order:

1. **Apply 005 manually** — `005_phoenix_assign_profile_role.sql`
2. **Apply 006 manually** — `006_phoenix_status_reports.sql`
3. **Apply 007 manually** — `007_phoenix_clear_port_availability.sql`
4. **Apply 008 manually** — `008_phoenix_org_status_contacts.sql`
5. **Apply 009 manually** — `009_phoenix_inter_institution_alerts.sql` (requires 008)
6. **Apply 010 manually** — `010_phoenix_user_permission_matrix.sql` (requires 005–009)
7. **Apply 011 manually** — `011_phoenix_user_lifecycle_controls.sql` (requires 010)
8. **Apply 012 manually** — `012_phoenix_institution_admin_role.sql` (requires 010; 011 recommended)
9. **Apply 013 manually** — `013_phoenix_user_identity_snapshot_foundation.sql` (requires 001–010; 011+012 recommended)
10. **Apply 014 manually** — `014_phoenix_actor_snapshot_write_path_triggers.sql` (requires 013)
11. **Apply 015 manually** — `015_phoenix_user_account_recycling.sql` (requires 010; deploy `admin-recycle-user` Edge Function after applying)
12. **Apply 016 manually** — `016_phoenix_local_credentials_mode.sql` (requires 001–015; redeploy `admin-create-user` and `admin-recycle-user` Edge Functions after applying — they now support `login_mode: 'local'`)
13. **Apply 017 manually** — `017_phoenix_permission_rpc_42703_fix.sql` (requires 010; if its own verification shows `audit_logs` is still missing the actor snapshot columns, re-apply 013 first — no Edge Function changes needed)

## How to apply (each migration)

1. **Take a backup first** (see warning above).
2. Open Supabase Dashboard → **SQL Editor**.
3. Paste the contents of the migration file.
4. Read the header comment — confirm the prerequisite migration is already applied.
5. Run. Confirm there are no errors.
6. Run the **smoke test** for that migration (below).
7. Do **not** run `npx supabase db push`.

## Verification smoke tests

### After 005 — assign_profile_role

```sql
-- RPC exists
select routine_name from information_schema.routines
where routine_schema = 'public' and routine_name = 'assign_profile_role';

-- anon has NO execute, authenticated does
select grantee, privilege_type
from information_schema.routine_privileges
where routine_name = 'assign_profile_role';
```

Functional check (as a hospital_admin session): assigning `super_admin`
must return `{"ok": false, "error": "CANNOT_ESCALATE_TO_SUPER_ADMIN"}`.
Assigning your own id must return `CANNOT_CHANGE_OWN_ROLE`.

### After 006 — institution_item_status_reports

```sql
-- table exists
select tablename from pg_tables
where schemaname = 'public' and tablename = 'institution_item_status_reports';

-- RLS is enabled
select relrowsecurity from pg_class
where relname = 'institution_item_status_reports';
```

Functional check: the dashboard status-report counts load without error.
If 006 is not yet applied, the app degrades gracefully (counts show 0).

### After 007 — clear_port_availability

```sql
-- RPC exists
select routine_name from information_schema.routines
where routine_schema = 'public' and routine_name = 'clear_port_availability';
```

Functional check: calling with a wrong confirmation string must return
`{"ok": false, "error": "CONFIRMATION_MISMATCH"}`. A correct call clears
only `item_availability` rows for that point — it does **not** delete the
port or its QR token.

### After 008 — organization_status_contacts

Purpose: a scoped directory of each institution's **Monthly Status Officer**
(name + phone). `profiles` has no phone field, so contact details live here.
Used **only** inside authenticated, scoped inter-institution alerts (009) —
never on public QR pages and never for anonymous visitors.

Manual action: apply via Supabase SQL Editor **after a backup**.

```sql
-- table exists
select tablename from pg_tables
where schemaname = 'public' and tablename = 'organization_status_contacts';

-- RLS is enabled
select relrowsecurity from pg_class
where relname = 'organization_status_contacts';

-- no policy targets anon (every policy must be 'authenticated' only)
select polname, roles::text
from pg_policies
where tablename = 'organization_status_contacts';
```

Functional checks:
- As a `hospital_admin` (or `super_admin`), insert/manage a scoped contact for
  your own organization — it should succeed:
  ```sql
  insert into organization_status_contacts (organization_id, display_name, phone, is_primary)
  values ('<your-org-id>', 'Officer Name', '+9647700000000', true);
  ```
- Contacts are **not public**: an `anon` (logged-out) request must return no
  rows / be denied. Confirm no policy lists the `anon` role above.
- A non-admin member of another organization must not be able to read or write
  another org's contacts (RLS scopes direct access to the owner org only;
  cross-org reads happen solely through the 009 RPC).

### After 009 — get_scoped_inter_institution_alerts

Purpose: a `SECURITY DEFINER` RPC that computes inter-institution exchange
alerts server-side so each institution receives **only** alerts where it is the
source or target party, plus the counterpart officer contact for that match.

Manual action: apply via Supabase SQL Editor **after 008**.

```sql
-- RPC exists
select routine_name from information_schema.routines
where routine_schema = 'public'
  and routine_name = 'get_scoped_inter_institution_alerts';

-- anon has NO execute, authenticated does
select grantee, privilege_type
from information_schema.routine_privileges
where routine_name = 'get_scoped_inter_institution_alerts';
```

Functional checks:
- As `super_admin`: `select * from get_scoped_inter_institution_alerts();`
  returns **all** matching alerts across institutions.
- As a non-super (org-scoped) user: every returned row must have
  `source_organization_id = my org` **OR** `target_organization_id = my org`.
- **Unrelated institution alerts are hidden** — alerts between two other
  organizations must never appear for a non-super user.
- **Public users cannot access alerts**: the RPC is revoked from `anon` and the
  alerts page is behind the app auth gate.
- **No phone/contact data on public QR**: scan a public QR (`?qid=…`) while
  logged out and confirm no officer name/phone or contact field is shown.

### After 010 — user permission matrix

Purpose: the official role model + the two-layer permission matrix
(`permission_keys`, `role_permission_defaults`, `profile_permission_overrides`)
and the scoped RPCs `get_effective_permissions`, `assign_profile_permissions`,
`reset_profile_permissions`. It also re-creates `assign_profile_role` with the
expanded official+legacy role allowlist.

Manual action: apply via Supabase SQL Editor **after a backup** and after 005–009.

Read-only verification checks:

```sql
-- Expect EXACTLY 32 permission keys (canonical count).
select count(*) from public.permission_keys;            -- expect 32

-- Per-role default counts (super_admin should equal 32).
select role, count(*) from public.role_permission_defaults group by role order by role;

-- All four permission/role RPCs must exist.
select proname from pg_proc
where proname in ('assign_profile_permissions','get_effective_permissions',
                  'reset_profile_permissions','assign_profile_role')
order by proname;
```

> **Canonical permission count is 32.** A live `permission_keys` count of 32 is
> correct and expected — it matches `PERMISSION_KEYS` in
> `src/shared/lib/permissions.ts` and the seed in migration 010. No permission
> key is missing; do not add a 33rd key to "reach" 33.

Functional checks:
- `super_admin` default count = 32; `viewer` is read-only (no `*.create` /
  `*.manage` / `users.*`).
- A non-super actor cannot grant a permission they do not hold, cannot edit
  their own permissions, and cannot act outside their organization
  (`assign_profile_permissions` returns `INSUFFICIENT_PERMISSION` /
  `CANNOT_EDIT_OWN_PERMISSIONS` / `OUT_OF_SCOPE`).

### After 011 — user lifecycle controls

Purpose: adds `users.disable` and `users.delete` permission keys (total: 34); adds `profiles.disabled_at` and `profiles.disabled_by` audit columns for disable/enable tracking.

```sql
-- Expect 34 permission keys (32 from 010 + 2 from 011).
select count(*) from public.permission_keys;  -- expect 34

-- Audit columns must exist.
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'profiles'
  and column_name in ('disabled_at', 'disabled_by');
-- expect: 2 rows
```

### After 012 — institution_admin role

Purpose: expands `profiles.role` CHECK to include `institution_admin`; seeds 13 default permissions for the new role.

```sql
-- institution_admin rows must exist.
select count(*) from public.role_permission_defaults
where role = 'institution_admin';
-- expect: 13 (or 14 if migration 011 was also applied — users.disable included)

-- role CHECK must include institution_admin.
select pg_get_constraintdef(oid) from pg_constraint
where conname = 'profiles_role_check';
-- expect: 'institution_admin' in the list
```

### After 013 — user identity snapshot foundation

Purpose: foundational schema for safe account recycling in a future phase.
**Does NOT implement recycling.** Adds `profiles.identity_version`, the
`user_identity_history` table, actor snapshot columns on 6 operational tables,
and initial backfill from existing profile data.

```sql
-- profiles.identity_version must exist, all rows = 1.
select identity_version, count(*)
from public.profiles group by 1;
-- expect: all rows have identity_version = 1

-- One history row per profile.
select count(*) from public.user_identity_history;
-- expect: equals count(*) from public.profiles

-- audit_logs snapshot columns (4 added, no actor_role_snapshot — already exists as actor_role).
select count(*) from information_schema.columns
where table_schema = 'public' and table_name = 'audit_logs'
  and column_name in (
    'actor_name_snapshot', 'actor_email_snapshot',
    'actor_org_snapshot',  'actor_identity_version'
  );
-- expect: 4

-- item_availability snapshot columns (5 added).
select count(*) from information_schema.columns
where table_schema = 'public' and table_name = 'item_availability'
  and column_name in (
    'actor_name_snapshot', 'actor_email_snapshot', 'actor_role_snapshot',
    'actor_org_snapshot',  'actor_identity_version'
  );
-- expect: 5

-- Helper function exists.
select proname from pg_proc where proname = 'get_profile_identity_snapshot';
-- expect: 1 row
```

> **Important:** Migration 013 does NOT implement account recycling. The recycling
> workflow (ACCOUNT-RECYCLE-WORKFLOW-A) is a separate future phase. Do not attempt
> to recycle accounts before that workflow is implemented.

## Prohibitions

- ❌ Do **not** run `npx supabase db push`.
- ❌ Do **not** apply out of order.
- ❌ Do **not** apply without a backup.
- ❌ Do **not** edit `auth.*` schema or delete `auth.users` from these migrations.
- ❌ No `DROP` / `TRUNCATE` / `CASCADE` shortcuts are used in 005–013; do not add any.
- ❌ Do **not** add a 33rd permission key to migration 010 — the canonical count is **32**
  (migrations 011/012 add to different tables; the base 010 count stays 32).
- ❌ Do **not** use migration 013 as a trigger to implement account recycling — that
  is a separate, future, atomic workflow.

## Rollback

Each migration is small and reversible:

- **005 / 007 / 009** — drop the added function:
  `drop function if exists assign_profile_role(uuid, text);`
  `drop function if exists clear_port_availability(uuid, text);`
  `drop function if exists get_scoped_inter_institution_alerts();`
- **006 / 008** — the table can be dropped only if intentionally rolling back
  the feature and no data must be preserved. Back up the table first. Note 009
  depends on 008, so roll back 009 (the RPC) before 008 (the contacts table).
- **010** — drop the permission RPCs and matrix tables if rolling back the
  feature (back up `profile_permission_overrides` first). The expanded
  `profiles_role_check` is additive; reverting it would require no rows to use
  the new official role keys.
- **011** — drop columns `disabled_at` / `disabled_by` from `profiles`;
  delete the `users.disable` and `users.delete` rows from `permission_keys`.
- **012** — revert `profiles_role_check` to exclude `institution_admin`;
  delete `institution_admin` rows from `role_permission_defaults`.
- **013** — drop `user_identity_history` table; drop `identity_version` from
  `profiles`; drop actor snapshot columns from the 6 operational tables;
  drop function `get_profile_identity_snapshot`. This is the most involved
  rollback — take a backup and do it only if truly necessary.

When in doubt, restore from the backup taken before applying.
