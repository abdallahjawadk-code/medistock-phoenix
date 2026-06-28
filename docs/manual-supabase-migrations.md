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

Apply each one **manually**, in this order:

1. **Apply 005 manually** — `005_phoenix_assign_profile_role.sql`
2. **Apply 006 manually** — `006_phoenix_status_reports.sql`
3. **Apply 007 manually** — `007_phoenix_clear_port_availability.sql`
4. **Apply 008 manually** — `008_phoenix_org_status_contacts.sql`
5. **Apply 009 manually** — `009_phoenix_inter_institution_alerts.sql` (requires 008)
6. **Apply 010 manually** — `010_phoenix_user_permission_matrix.sql` (requires 005–009)

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

## Prohibitions

- ❌ Do **not** run `npx supabase db push`.
- ❌ Do **not** apply out of order.
- ❌ Do **not** apply without a backup.
- ❌ Do **not** edit `auth.*` schema or delete `auth.users` from these migrations.
- ❌ No `DROP` / `TRUNCATE` / `CASCADE` shortcuts are used in 005–010; do not add any.
- ❌ Do **not** add a 33rd permission key to migration 010 — the canonical count is **32**.

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

When in doubt, restore from the backup taken before applying.
