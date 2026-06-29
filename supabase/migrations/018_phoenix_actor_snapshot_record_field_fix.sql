-- ============================================================================
-- 018_phoenix_actor_snapshot_record_field_fix.sql
-- MediStock Phoenix V2
--
-- Purpose:
--   Fixes a confirmed live PostgreSQL 42703 (undefined_column) error
--   ("record \"new\" has no field \"actor_id\"") raised by
--   phoenix_populate_actor_snapshot() when it fires for
--   profile_permission_overrides (ACTOR-SNAPSHOT-TRIGGER-42703-FIX-A).
--
-- Confirmed live error (from a rollback-only diagnostic run):
--   SQLSTATE: 42703
--   MESSAGE:  record "new" has no field "actor_id"
--   CONTEXT:  PL/pgSQL assignment in phoenix_populate_actor_snapshot()
--             v_actor_id := case tg_table_name
--               when 'audit_logs' then coalesce(new.actor_id, auth.uid())
--               ...
--             end;
--   This fires while assign_profile_permissions does
--   `insert into profile_permission_overrides (...)`, which triggers
--   trg_actor_snapshot BEFORE INSERT on that table.
--
-- Root cause:
--   phoenix_populate_actor_snapshot() (migration 014) is one shared trigger
--   function attached to 6 different tables, each with a different
--   "actor" column (audit_logs.actor_id, ...submitted_by,
--   ...last_updated_by, ...created_by x3). The function resolved the actor
--   id with a single CASE expression that referenced ALL of those
--   table-specific NEW.<column> fields directly in one expression, e.g.
--   `coalesce(new.actor_id, auth.uid())` inside the `when 'audit_logs'`
--   branch. Because NEW inside this shared trigger is a generic RECORD
--   (its real row type varies per firing table), PL/pgSQL's record-field
--   binding for a CASE expression is not safely lazy across branches that
--   reference columns absent from the row type that is ACTUALLY bound at
--   that firing — referencing `new.actor_id` while NEW is bound to a
--   profile_permission_overrides row (which has no actor_id column at all)
--   raises 42703, even though the matching WHEN branch for
--   'profile_permission_overrides' only needed `new.created_by`. This
--   aborted the entire assign_profile_permissions call, rolling back the
--   permission override that would otherwise have been written
--   successfully. Migration 017's audit_logs-insert exception handling did
--   not (and could not) catch this, because the failure happens earlier,
--   inside the profile_permission_overrides insert itself.
--
-- What this migration does:
--   Replaces ONLY phoenix_populate_actor_snapshot() so actor-id resolution
--   never statically binds a table-specific NEW.<column> field outside the
--   one branch it actually belongs to. Instead, NEW is converted once to
--   jsonb (`to_jsonb(new)`) and the relevant field is read with the `->>`
--   text-extraction operator, which returns SQL NULL for a key that is not
--   present in that row's JSON representation instead of raising an error.
--   This is exactly the pattern PostgreSQL recommends for dynamic field
--   access against a RECORD whose type is not statically known to the
--   function body. All other behavior — snapshot population, the
--   audit_logs actor_role_snapshot guard, the UPDATE-preserves-existing-
--   snapshot rule (except item_availability), SECURITY DEFINER, and
--   search_path — is unchanged.
--
-- What this migration does NOT do:
--   - Does NOT touch any other function (assign_profile_permissions,
--     reset_profile_permissions, phoenix_profile_has_permission,
--     get_effective_permissions are untouched — migration 017 already
--     covers them and remains correct).
--   - Does NOT drop or recreate any trigger. CREATE OR REPLACE FUNCTION
--     updates the function body in place; the 6 existing
--     trg_actor_snapshot triggers (migration 014) keep pointing at the
--     same function name/OID and immediately use the new body on their
--     next firing — no DROP TRIGGER / CREATE TRIGGER needed.
--   - Does NOT modify any table schema, any permission rule, or any role
--     default.
--   - Does NOT touch auth.users, passwords, or any credential material.
--   - Does NOT disable RLS, audit logging, or any existing trigger.
--   - Does NOT reference service_role or any elevated server key.
--
-- MANUAL APPLY ONLY — paste into Supabase Dashboard → SQL Editor and run.
-- DO NOT use "supabase db push" — this project manages migrations manually.
--
-- Prerequisites:
--   Migrations 001-017 should already be applied (014 in particular, since
--   this migration replaces a function it created).
--
-- Safety:
--   - CREATE OR REPLACE FUNCTION only — no DROP FUNCTION, no DROP TABLE,
--     no TRUNCATE, no destructive DELETE, no unsafe CASCADE.
--   - No data is deleted, moved, or migrated.
--   - Idempotent: safe to re-run; CREATE OR REPLACE FUNCTION is naturally
--     idempotent.
-- ============================================================================

create or replace function phoenix_populate_actor_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row              jsonb;
  v_actor_id         uuid;
  v_identity_version integer;
  v_full_name        text;
  v_email            text;
  v_role             text;
  v_org_name         text;
begin
  -- Convert NEW to jsonb once. This is the safe way to probe for a
  -- table-specific column that may not exist on the row type currently
  -- bound to this shared trigger invocation: the ->> operator returns SQL
  -- NULL for an absent key instead of raising 42703, unlike a direct
  -- new.<column> reference inside a CASE branch that doesn't match the
  -- firing table.
  v_row := to_jsonb(new);

  v_actor_id := case tg_table_name
    when 'audit_logs'                       then nullif(v_row->>'actor_id', '')::uuid
    when 'institution_item_status_reports'  then nullif(v_row->>'submitted_by', '')::uuid
    when 'item_availability'                then nullif(v_row->>'last_updated_by', '')::uuid
    when 'qr_tokens'                        then nullif(v_row->>'created_by', '')::uuid
    when 'organization_status_contacts'     then nullif(v_row->>'created_by', '')::uuid
    when 'profile_permission_overrides'     then nullif(v_row->>'created_by', '')::uuid
    else null
  end;

  v_actor_id := coalesce(v_actor_id, auth.uid());

  if v_actor_id is null then
    return new;
  end if;

  -- On UPDATE: preserve existing snapshots (do not overwrite historical values).
  -- Exception: item_availability always re-snapshots (tracks current actor).
  -- actor_name_snapshot exists on all 6 trigger-attached tables (migration
  -- 013), so direct field access here is safe and unchanged from migration 014.
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

  -- Populate snapshot fields (common to all 6 trigger-attached tables —
  -- safe direct field access, unchanged from migration 014).
  new.actor_identity_version := v_identity_version;
  new.actor_name_snapshot    := v_full_name;
  new.actor_email_snapshot   := v_email;
  new.actor_org_snapshot     := v_org_name;

  -- actor_role_snapshot: skip for audit_logs (it already has actor_role column).
  if tg_table_name <> 'audit_logs' then
    new.actor_role_snapshot := v_role;
  end if;

  return new;
end;
$$;

-- ============================================================================
-- Verification
-- ============================================================================

do $$
declare
  v_exists boolean;
begin
  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'phoenix_populate_actor_snapshot'
  ) into v_exists;
  assert v_exists, 'VERIFY FAILED: phoenix_populate_actor_snapshot() is missing';

  raise notice 'Migration 018 verification passed: phoenix_populate_actor_snapshot() replaced with field-safe actor resolution.';
end $$;

-- ============================================================================
-- END OF MIGRATION 018
--
-- Post-apply verification (run manually):
--
-- 1. Confirm the live function body now uses to_jsonb(new) / ->> and no
--    longer directly references new.actor_id / new.submitted_by /
--    new.last_updated_by / new.created_by inside the actor-resolution CASE:
--    select pg_get_functiondef('public.phoenix_populate_actor_snapshot()'::regprocedure);
--
-- 2. Confirm the same 6 triggers are still attached (this migration does
--    not touch triggers, only the function body — they should be
--    unchanged from before applying):
--    select
--      dep_trigger.tgname   as trigger_name,
--      dep_table.relname    as table_name,
--      dep_function.proname as function_name
--    from pg_trigger dep_trigger
--    join pg_class dep_table on dep_table.oid = dep_trigger.tgrelid
--    join pg_proc dep_function on dep_function.oid = dep_trigger.tgfoid
--    where dep_function.proname = 'phoenix_populate_actor_snapshot'
--      and not dep_trigger.tgisinternal
--    order by table_name;
--    -- expect 6 rows: audit_logs, institution_item_status_reports,
--    --                item_availability, qr_tokens,
--    --                organization_status_contacts,
--    --                profile_permission_overrides
--
-- 3. Rollback-only reproduction of the original failure — replace the two
--    placeholders with a real super_admin profile id and a DIFFERENT real
--    target profile id (self-edit is correctly blocked by design and would
--    only reproduce CANNOT_EDIT_OWN_PERMISSIONS, not this bug):
--    begin;
--    select set_config('request.jwt.claim.sub', '<SUPER_ADMIN_UUID>', true);
--    select set_config('request.jwt.claim.role', 'authenticated', true);
--    select public.assign_profile_permissions(
--      '<TARGET_USER_UUID>'::uuid,
--      '{"users.view": true}'::jsonb
--    );
--    rollback;
--    -- expect: { "ok": true, "applied": 1, "rejected": [], "audit_logged": true }
--    -- (or "audit_logged": false if an unrelated audit_logs issue remains —
--    -- that would no longer abort the permission write, per migration 017).
--    -- The ROLLBACK guarantees nothing here is ever persisted.
-- ============================================================================
