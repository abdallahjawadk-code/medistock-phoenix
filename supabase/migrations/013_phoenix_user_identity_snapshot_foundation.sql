-- ============================================================================
-- 013_phoenix_user_identity_snapshot_foundation.sql
-- MediStock Phoenix V2
--
-- Purpose:
--   Establishes the database foundation required for safe account identity
--   snapshots (USER-IDENTITY-SNAPSHOT-FOUNDATION-A).
--
--   This migration does NOT implement account recycling.
--   It does NOT add any recycling UI or workflow.
--   It is foundational schema + column prep only.
--
-- What this migration does:
--   A. Adds profiles.identity_version (integer, default 1).
--   B. Creates public.user_identity_history table.
--   C. Seeds an initial identity snapshot for every existing profile.
--   D. Adds actor_* snapshot columns to 6 operational tables.
--   E. Backfills snapshot columns for existing rows from current profiles.
--   F. Adds a helper RPC: public.get_profile_identity_snapshot(uuid).
--   G. Verification block.
--
-- MANUAL APPLY ONLY — paste into Supabase Dashboard → SQL Editor and run.
-- DO NOT use "supabase db push" — this project manages migrations manually.
--
-- Prerequisites:
--   Migrations 001–012 must be applied.
--   Migration 011 (user lifecycle) and 012 (institution_admin) are recommended
--   but this migration does not hard-depend on them.
--
-- Safety:
--   - All DDL uses IF NOT EXISTS / DO NOTHING / idempotent patterns.
--   - No DROP, TRUNCATE, or destructive CASCADE shortcuts.
--   - Safe to re-run.
--
-- After applying, verify with:
--   select column_name from information_schema.columns
--     where table_schema = 'public' and table_name = 'profiles'
--     and column_name = 'identity_version';
--
--   select count(*) from public.user_identity_history;
--   -- expect: one row per profile
--
--   select count(*) from information_schema.columns
--     where table_schema = 'public' and table_name = 'audit_logs'
--     and column_name in (
--       'actor_name_snapshot','actor_email_snapshot',
--       'actor_org_snapshot','actor_identity_version'
--     );
--   -- expect: 4
-- ============================================================================

-- ============================================================================
-- A. profiles.identity_version
--    Starts at 1 for all accounts (never recycled = version 1).
--    Incremented each time the account is recycled to a new person.
-- ============================================================================

alter table public.profiles
  add column if not exists identity_version integer not null default 1;

-- Add check constraint idempotently (identity_version must be >= 1).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_identity_version_check'
    and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_identity_version_check check (identity_version >= 1);
  end if;
exception when others then null;
end $$;

create index if not exists profiles_identity_version_idx
  on public.profiles (identity_version);

-- ============================================================================
-- B. user_identity_history table
--    Records each past identity version of a profile.
--    The CURRENT identity is always in public.profiles itself.
--    This table stores history only (valid_until = null → still current).
-- ============================================================================

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
  created_at       timestamptz not null default now()
);

-- Enable RLS (restrictive default — no policies yet, so direct table access
-- is blocked; the SECURITY DEFINER helper function bypasses RLS for reads).
alter table public.user_identity_history enable row level security;

-- Unique: each profile can only have one row per identity_version.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'uih_profile_version_unique'
    and conrelid = 'public.user_identity_history'::regclass
  ) then
    alter table public.user_identity_history
      add constraint uih_profile_version_unique unique (profile_id, identity_version);
  end if;
exception when others then null;
end $$;

create index if not exists uih_profile_id_idx
  on public.user_identity_history (profile_id, identity_version);

create index if not exists uih_org_idx
  on public.user_identity_history (organization_id);

create index if not exists uih_valid_from_idx
  on public.user_identity_history (valid_from);

create index if not exists uih_valid_until_idx
  on public.user_identity_history (valid_until)
  where valid_until is not null;

-- ============================================================================
-- C. Seed initial identity history for all existing profiles.
--    One row per profile with identity_version = 1, valid_until = null
--    (meaning this identity is still current).
--    ON CONFLICT DO NOTHING — safe to re-run.
-- ============================================================================

insert into public.user_identity_history (
  profile_id,
  identity_version,
  full_name,
  email,
  role,
  organization_id,
  valid_from,
  valid_until,
  change_reason
)
select
  p.id,
  p.identity_version,            -- 1 for all existing profiles
  p.full_name,
  u.email,                       -- resolved from auth.users (same id)
  p.role,
  p.organization_id,
  p.created_at,                  -- valid from when the profile was first created
  null,                          -- valid_until = null → current identity
  'initial_snapshot'
from public.profiles p
left join auth.users u on u.id = p.id
on conflict (profile_id, identity_version) do nothing;

-- ============================================================================
-- D. Actor snapshot columns on operational tables.
--
--    All columns nullable (existing rows cannot be retroactively populated
--    with certainty — backfill is best-effort in section E).
--
--    Source actor per table:
--      audit_logs                       → actor_id (already has actor_role)
--      institution_item_status_reports  → submitted_by
--      item_availability                → last_updated_by
--      qr_tokens                        → created_by
--      organization_status_contacts     → created_by
--      profile_permission_overrides     → created_by
--
--    Structural tables NOT covered (created_by = structural entity creator,
--    not an operational audit actor):
--      organizations, warehouses, distribution_points,
--      central_items, local_items, qr_targets
-- ============================================================================

-- D1. audit_logs
--     Already has actor_role text. Adding name, email, org, identity_version.
--     No actor_role_snapshot needed (audit_logs.actor_role serves that purpose).
alter table public.audit_logs
  add column if not exists actor_name_snapshot    text,
  add column if not exists actor_email_snapshot   text,
  add column if not exists actor_org_snapshot     text,
  add column if not exists actor_identity_version integer;

-- D2. institution_item_status_reports
--     Primary actor: submitted_by.
--     resolved_by is secondary (resolver, not creator). Snapshots cover submitter.
alter table public.institution_item_status_reports
  add column if not exists actor_name_snapshot    text,
  add column if not exists actor_email_snapshot   text,
  add column if not exists actor_role_snapshot    text,
  add column if not exists actor_org_snapshot     text,
  add column if not exists actor_identity_version integer;

-- D3. item_availability
--     Primary actor: last_updated_by.
alter table public.item_availability
  add column if not exists actor_name_snapshot    text,
  add column if not exists actor_email_snapshot   text,
  add column if not exists actor_role_snapshot    text,
  add column if not exists actor_org_snapshot     text,
  add column if not exists actor_identity_version integer;

-- D4. qr_tokens
--     Primary actor: created_by.
--     disabled_by is a secondary actor tracked separately in future phase.
alter table public.qr_tokens
  add column if not exists actor_name_snapshot    text,
  add column if not exists actor_email_snapshot   text,
  add column if not exists actor_role_snapshot    text,
  add column if not exists actor_org_snapshot     text,
  add column if not exists actor_identity_version integer;

-- D5. organization_status_contacts
--     Primary actor: created_by (references profiles directly).
alter table public.organization_status_contacts
  add column if not exists actor_name_snapshot    text,
  add column if not exists actor_email_snapshot   text,
  add column if not exists actor_role_snapshot    text,
  add column if not exists actor_org_snapshot     text,
  add column if not exists actor_identity_version integer;

-- D6. profile_permission_overrides
--     Primary actor: created_by (references profiles directly).
alter table public.profile_permission_overrides
  add column if not exists actor_name_snapshot    text,
  add column if not exists actor_email_snapshot   text,
  add column if not exists actor_role_snapshot    text,
  add column if not exists actor_org_snapshot     text,
  add column if not exists actor_identity_version integer;

-- ============================================================================
-- E. Backfill existing rows.
--
--    Best-effort: joins current profiles (and auth.users for email) to populate
--    snapshot columns for rows where the actor can be resolved.
--    Rows where actor_id / created_by is NULL are left null — that is correct
--    (actor was not recorded at creation time).
--    Never overwrites non-null snapshot values (WHERE ... IS NULL guard).
-- ============================================================================

-- E1. audit_logs  (actor_id → auth.users → profiles)
update public.audit_logs al
set
  actor_name_snapshot    = p.full_name,
  actor_email_snapshot   = u.email,
  actor_org_snapshot     = o.name,
  actor_identity_version = p.identity_version
from public.profiles p
left join auth.users u              on u.id = p.id
left join public.organizations o   on o.id = p.organization_id
where al.actor_id         = p.id
  and al.actor_name_snapshot is null;

-- E2. institution_item_status_reports  (submitted_by → auth.users → profiles)
update public.institution_item_status_reports isr
set
  actor_name_snapshot    = p.full_name,
  actor_email_snapshot   = u.email,
  actor_role_snapshot    = p.role,
  actor_org_snapshot     = o.name,
  actor_identity_version = p.identity_version
from public.profiles p
left join auth.users u              on u.id = p.id
left join public.organizations o   on o.id = p.organization_id
where isr.submitted_by    = p.id
  and isr.actor_name_snapshot is null;

-- E3. item_availability  (last_updated_by → auth.users → profiles)
update public.item_availability ia
set
  actor_name_snapshot    = p.full_name,
  actor_email_snapshot   = u.email,
  actor_role_snapshot    = p.role,
  actor_org_snapshot     = o.name,
  actor_identity_version = p.identity_version
from public.profiles p
left join auth.users u              on u.id = p.id
left join public.organizations o   on o.id = p.organization_id
where ia.last_updated_by  = p.id
  and ia.actor_name_snapshot is null;

-- E4. qr_tokens  (created_by → auth.users → profiles)
update public.qr_tokens qt
set
  actor_name_snapshot    = p.full_name,
  actor_email_snapshot   = u.email,
  actor_role_snapshot    = p.role,
  actor_org_snapshot     = o.name,
  actor_identity_version = p.identity_version
from public.profiles p
left join auth.users u              on u.id = p.id
left join public.organizations o   on o.id = p.organization_id
where qt.created_by       = p.id
  and qt.actor_name_snapshot is null;

-- E5. organization_status_contacts  (created_by → profiles directly)
update public.organization_status_contacts osc
set
  actor_name_snapshot    = p.full_name,
  actor_email_snapshot   = u.email,
  actor_role_snapshot    = p.role,
  actor_org_snapshot     = o.name,
  actor_identity_version = p.identity_version
from public.profiles p
left join auth.users u              on u.id = p.id
left join public.organizations o   on o.id = p.organization_id
where osc.created_by      = p.id
  and osc.actor_name_snapshot is null;

-- E6. profile_permission_overrides  (created_by → profiles directly)
update public.profile_permission_overrides ppo
set
  actor_name_snapshot    = p.full_name,
  actor_email_snapshot   = u.email,
  actor_role_snapshot    = p.role,
  actor_org_snapshot     = o.name,
  actor_identity_version = p.identity_version
from public.profiles p
left join auth.users u              on u.id = p.id
left join public.organizations o   on o.id = p.organization_id
where ppo.created_by      = p.id
  and ppo.actor_name_snapshot is null;

-- ============================================================================
-- F. Helper function: get_profile_identity_snapshot(profile_id)
--
--    Returns the current live identity for a profile.
--    Future write paths (ACTOR-SNAPSHOT-WRITE-PATHS-A) will call this at
--    the moment of an operation to capture the snapshot values.
--
--    Uses SECURITY DEFINER to join auth.users (email access requires elevated
--    privileges). This is safe: the function is read-only and returns only the
--    profile owned by the given profile_id.
-- ============================================================================

create or replace function public.get_profile_identity_snapshot(p_profile_id uuid)
returns table (
  identity_version  integer,
  full_name         text,
  email             text,
  role              text,
  organization_id   uuid
)
security definer
set search_path = public, pg_temp
language plpgsql as $$
begin
  return query
    select
      p.identity_version,
      p.full_name,
      u.email,
      p.role,
      p.organization_id
    from public.profiles p
    left join auth.users u on u.id = p.id
    where p.id = p_profile_id;
end;
$$;

-- Grant execute to authenticated users (callers of future write-path RPCs).
grant execute on function public.get_profile_identity_snapshot(uuid) to authenticated;

-- ============================================================================
-- G. Verification
-- ============================================================================

do $$
declare
  v_col_count  int;
  v_tbl_exists boolean;
begin
  -- profiles.identity_version must exist
  select count(*) into v_col_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'profiles'
    and column_name = 'identity_version';
  assert v_col_count = 1,
    'VERIFY FAILED: profiles.identity_version column is missing';

  -- user_identity_history must exist
  select exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename = 'user_identity_history'
  ) into v_tbl_exists;
  assert v_tbl_exists,
    'VERIFY FAILED: user_identity_history table is missing';

  -- audit_logs must have all 4 snapshot columns
  select count(*) into v_col_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'audit_logs'
    and column_name in (
      'actor_name_snapshot', 'actor_email_snapshot',
      'actor_org_snapshot',  'actor_identity_version'
    );
  assert v_col_count = 4,
    format('VERIFY FAILED: audit_logs snapshot columns: expected 4, got %s', v_col_count);

  -- item_availability must have all 5 snapshot columns
  select count(*) into v_col_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'item_availability'
    and column_name in (
      'actor_name_snapshot', 'actor_email_snapshot', 'actor_role_snapshot',
      'actor_org_snapshot',  'actor_identity_version'
    );
  assert v_col_count = 5,
    format('VERIFY FAILED: item_availability snapshot columns: expected 5, got %s', v_col_count);

  raise notice 'Migration 013 verification passed.';
end $$;

-- ============================================================================
-- END OF MIGRATION 013
--
-- Quick checks after applying:
--   select identity_version, count(*) from public.profiles group by 1;
--   -- expect: all rows have identity_version = 1
--
--   select count(*) from public.user_identity_history;
--   -- expect: one row per profile
--
--   select column_name from information_schema.columns
--     where table_schema = 'public'
--     and table_name = 'audit_logs'
--     order by column_name;
--   -- expect: actor_email_snapshot, actor_identity_version,
--   --         actor_name_snapshot, actor_org_snapshot appear in list
--
-- NOTE: This migration does NOT implement account recycling.
--       Recycling workflow (ACCOUNT-RECYCLE-WORKFLOW-A) is a separate future phase.
-- ============================================================================
