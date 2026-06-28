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

Migrations 005, 006 and 007 are the ones still pending for the current
hardening cycle. Apply each one **manually**, in this order:

1. **Apply 005 manually** — `005_phoenix_assign_profile_role.sql`
2. **Apply 006 manually** — `006_phoenix_status_reports.sql`
3. **Apply 007 manually** — `007_phoenix_clear_port_availability.sql`

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

## Prohibitions

- ❌ Do **not** run `npx supabase db push`.
- ❌ Do **not** apply out of order.
- ❌ Do **not** apply without a backup.
- ❌ Do **not** edit `auth.*` schema or delete `auth.users` from these migrations.
- ❌ No `DROP` / `TRUNCATE` / `CASCADE` shortcuts are used in 005–007; do not add any.

## Rollback

Each migration is small and reversible:

- **005 / 007** — drop the added function:
  `drop function if exists assign_profile_role(uuid, text);`
  `drop function if exists clear_port_availability(uuid, text);`
- **006** — the table can be dropped only if intentionally rolling back the
  status-report feature and no data must be preserved. Back up the table first.

When in doubt, restore from the backup taken before applying.
