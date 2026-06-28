-- ============================================================================
-- 014_phoenix_actor_snapshot_write_path_triggers.sql
-- MediStock Phoenix V2
--
-- Purpose:
--   Wires actor identity snapshot population into all operational write paths
--   using BEFORE INSERT / UPDATE triggers (ACTOR-SNAPSHOT-WRITE-PATHS-A).
--
--   Each trigger auto-populates the actor_* snapshot columns from the actor's
--   current profile identity at the time of the operation. This guarantees:
--     - Snapshot fields are always set server-side (not from frontend input)
--     - Frontend cannot spoof snapshot values (trigger always overwrites)
--     - Historical snapshots are preserved on UPDATE (only re-snapshot on
--       tables where the actor can change, e.g. item_availability)
--     - No existing RPCs or applied migrations need modification
--
-- What this migration does:
--   A. Creates a reusable SECURITY DEFINER trigger function that resolves
--      the actor's identity (name, email, role, org, identity_version).
--   B. Attaches BEFORE INSERT OR UPDATE triggers to 6 operational tables.
--
-- What this migration does NOT do:
--   - Does NOT implement account recycling
--   - Does NOT modify any existing RPC or applied migration SQL
--   - Does NOT add UI or Edge Function changes
--   - Does NOT use elevated service keys
--
-- MANUAL APPLY ONLY — paste into Supabase Dashboard → SQL Editor and run.
-- DO NOT use "supabase db push".
--
-- Prerequisites:
--   Migration 013 must be applied (snapshot columns + helper function exist).
--
-- Safety:
--   - All DDL uses CREATE OR REPLACE / DROP TRIGGER IF EXISTS.
--   - No DROP TABLE, TRUNCATE, or destructive CASCADE.
--   - Safe to re-run.
-- ============================================================================

-- ============================================================================
-- A. Trigger function: phoenix_populate_actor_snapshot
--
--    SECURITY DEFINER so it can JOIN auth.users (email requires elevated
--    privileges). The function is read-only against profiles/auth.users/orgs.
--
--    Actor resolution per table:
--      audit_logs                      → COALESCE(NEW.actor_id, auth.uid())
--      institution_item_status_reports → COALESCE(NEW.submitted_by, auth.uid())
--      item_availability               → COALESCE(NEW.last_updated_by, auth.uid())
--      qr_tokens                       → COALESCE(NEW.created_by, auth.uid())
--      organization_status_contacts    → COALESCE(NEW.created_by, auth.uid())
--      profile_permission_overrides    → COALESCE(NEW.created_by, auth.uid())
--
--    On INSERT: always populates snapshot (prevents frontend spoofing).
--    On UPDATE: only populates if snapshot is currently NULL, EXCEPT for
--      item_availability (always re-snapshots because last_updated_by tracks
--      the current actor, which changes with each update).
-- ============================================================================

create or replace function phoenix_populate_actor_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_identity_version integer;
  v_full_name        text;
  v_email            text;
  v_role             text;
  v_org_name         text;
begin
  -- Resolve actor from the appropriate column, falling back to auth.uid()
  v_actor_id := case tg_table_name
    when 'audit_logs'                      then coalesce(new.actor_id, auth.uid())
    when 'institution_item_status_reports'  then coalesce(new.submitted_by, auth.uid())
    when 'item_availability'               then coalesce(new.last_updated_by, auth.uid())
    when 'qr_tokens'                       then coalesce(new.created_by, auth.uid())
    when 'organization_status_contacts'    then coalesce(new.created_by, auth.uid())
    when 'profile_permission_overrides'    then coalesce(new.created_by, auth.uid())
    else auth.uid()
  end;

  if v_actor_id is null then
    return new;
  end if;

  -- On UPDATE: preserve existing snapshots (do not overwrite historical values).
  -- Exception: item_availability always re-snapshots (tracks current actor).
  if tg_op = 'UPDATE'
     and new.actor_name_snapshot is not null
     and tg_table_name <> 'item_availability'
  then
    return new;
  end if;

  -- Look up the actor's current identity
  select
    p.identity_version,
    p.full_name,
    u.email,
    p.role,
    o.name
  into
    v_identity_version,
    v_full_name,
    v_email,
    v_role,
    v_org_name
  from public.profiles p
  left join auth.users u on u.id = p.id
  left join public.organizations o on o.id = p.organization_id
  where p.id = v_actor_id;

  if not found then
    return new;
  end if;

  -- Populate snapshot fields
  new.actor_identity_version := v_identity_version;
  new.actor_name_snapshot    := v_full_name;
  new.actor_email_snapshot   := v_email;
  new.actor_org_snapshot     := v_org_name;

  -- actor_role_snapshot: skip for audit_logs (it already has actor_role column)
  if tg_table_name <> 'audit_logs' then
    new.actor_role_snapshot := v_role;
  end if;

  return new;
end;
$$;

-- ============================================================================
-- B. Attach triggers to all 6 operational tables.
--    DROP IF EXISTS + CREATE ensures idempotent re-run.
-- ============================================================================

-- B1. audit_logs
drop trigger if exists trg_actor_snapshot on public.audit_logs;
create trigger trg_actor_snapshot
  before insert or update on public.audit_logs
  for each row execute function phoenix_populate_actor_snapshot();

-- B2. institution_item_status_reports
drop trigger if exists trg_actor_snapshot on public.institution_item_status_reports;
create trigger trg_actor_snapshot
  before insert or update on public.institution_item_status_reports
  for each row execute function phoenix_populate_actor_snapshot();

-- B3. item_availability
drop trigger if exists trg_actor_snapshot on public.item_availability;
create trigger trg_actor_snapshot
  before insert or update on public.item_availability
  for each row execute function phoenix_populate_actor_snapshot();

-- B4. qr_tokens
drop trigger if exists trg_actor_snapshot on public.qr_tokens;
create trigger trg_actor_snapshot
  before insert or update on public.qr_tokens
  for each row execute function phoenix_populate_actor_snapshot();

-- B5. organization_status_contacts
drop trigger if exists trg_actor_snapshot on public.organization_status_contacts;
create trigger trg_actor_snapshot
  before insert or update on public.organization_status_contacts
  for each row execute function phoenix_populate_actor_snapshot();

-- B6. profile_permission_overrides
drop trigger if exists trg_actor_snapshot on public.profile_permission_overrides;
create trigger trg_actor_snapshot
  before insert or update on public.profile_permission_overrides
  for each row execute function phoenix_populate_actor_snapshot();

-- ============================================================================
-- C. Verification
-- ============================================================================

do $$
declare
  v_count int;
begin
  -- Verify trigger function exists
  if not exists (
    select 1 from pg_proc
    where proname = 'phoenix_populate_actor_snapshot'
  ) then
    raise exception 'VERIFY FAILED: phoenix_populate_actor_snapshot function missing';
  end if;

  -- Verify all 6 triggers exist
  select count(*) into v_count
  from pg_trigger
  where tgname = 'trg_actor_snapshot'
    and tgrelid in (
      'public.audit_logs'::regclass,
      'public.institution_item_status_reports'::regclass,
      'public.item_availability'::regclass,
      'public.qr_tokens'::regclass,
      'public.organization_status_contacts'::regclass,
      'public.profile_permission_overrides'::regclass
    );
  assert v_count = 6,
    format('VERIFY FAILED: expected 6 actor snapshot triggers, got %s', v_count);

  raise notice 'Migration 014 verification passed: 6 actor snapshot triggers active.';
end $$;

-- ============================================================================
-- END OF MIGRATION 014
--
-- Verification after applying:
--   SELECT tgname, tgrelid::regclass AS table_name
--   FROM pg_trigger
--   WHERE tgname = 'trg_actor_snapshot'
--   ORDER BY table_name;
--   -- expect: 6 rows, one per operational table
--
--   SELECT proname, prosecdef
--   FROM pg_proc
--   WHERE proname = 'phoenix_populate_actor_snapshot';
--   -- expect: 1 row, prosecdef = true (SECURITY DEFINER)
--
-- Smoke test (as authenticated user, after inserting a test audit_log):
--   INSERT INTO audit_logs (organization_id, actor_id, actor_role, action,
--     entity_type, entity_id)
--   VALUES ('<org-uuid>', auth.uid(), 'super_admin', 'test_snapshot',
--     'test', gen_random_uuid());
--   SELECT actor_name_snapshot, actor_email_snapshot, actor_org_snapshot,
--     actor_identity_version
--   FROM audit_logs WHERE action = 'test_snapshot'
--   ORDER BY created_at DESC LIMIT 1;
--   -- expect: all 4 fields populated from the caller's profile
--
-- NOTE: This migration does NOT implement account recycling.
-- ============================================================================
