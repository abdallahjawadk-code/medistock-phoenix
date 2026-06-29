-- ============================================================================
-- 017_phoenix_permission_rpc_42703_fix.sql
-- MediStock Phoenix V2
--
-- Purpose:
--   Fixes a PostgreSQL 42703 (undefined_column) error observed when saving
--   permission overrides via assign_profile_permissions / resetting via
--   reset_profile_permissions (PERMISSION-RPC-42703-FIX-B).
--
-- Root cause:
--   Both assign_profile_permissions and reset_profile_permissions end with
--   `insert into audit_logs (...)`. Migration 014 attached a BEFORE INSERT
--   trigger (trg_actor_snapshot) to audit_logs that unconditionally writes
--   to audit_logs.actor_name_snapshot, actor_email_snapshot,
--   actor_org_snapshot, and actor_identity_version on every insert.
--   Those four columns are only added to audit_logs by migration 013
--   (section D1). If 013's audit_logs ALTER TABLE did not actually land on
--   the live database before 014's trigger went live — drift between what
--   was recorded as "applied" and what the live schema actually has — every
--   INSERT INTO audit_logs raises 42703, which aborts the ENTIRE calling
--   function (assign_profile_permissions / reset_profile_permissions),
--   rolling back the permission override that had already been written
--   successfully earlier in the same function call. The user only ever sees
--   "permission save failed" with no indication that the override itself
--   was fine and only the trailing audit-log write blew up.
--
--   phoenix_profile_has_permission was independently re-verified against
--   the live column list confirmed by the operator (role_permission_defaults
--   .allowed / .permission_key, profile_permission_overrides .allowed /
--   .permission_key) and already uses the correct column names — it is
--   redefined here only defensively (CREATE OR REPLACE with byte-identical
--   logic), to guarantee the live function can never have silently drifted
--   from this source of truth, e.g. via a manual SQL Editor edit.
--
-- What this migration does:
--   A. Re-asserts phoenix_profile_has_permission(uuid, text) with the exact
--      same, already-correct logic from migration 010 (defensive no-op if
--      the live function already matches; a real fix if it had drifted).
--   B. Replaces assign_profile_permissions(uuid, jsonb) with identical
--      authority/validation/upsert logic, wrapping ONLY the trailing
--      audit_logs insert in its own BEGIN/EXCEPTION block so a schema
--      mismatch (or any other audit-logging failure) can never roll back
--      an already-successful permission write. Adds a soft `audit_logged`
--      boolean to the JSON response so a failed audit write is visible
--      without failing the operation.
--   C. Replaces reset_profile_permissions(uuid) with the same treatment.
--   D. Verification block + post-apply verification SQL (in comments).
--
-- What this migration does NOT do:
--   - Does NOT touch get_effective_permissions (read-only; never inserts
--     into audit_logs; the operator already confirmed it uses the correct
--     columns — no evidence of an issue, so it is left untouched).
--   - Does NOT modify permission_keys, role_permission_defaults, or
--     profile_permission_overrides data or schema.
--   - Does NOT modify audit_logs schema (migration 013 already owns that;
--     re-running 013 is the correct remedy if its columns are genuinely
--     missing — see verification step 2 below).
--   - Does NOT touch auth.users, passwords, or any credential material.
--   - Does NOT weaken any authority check: NOT_AUTHENTICATED,
--     TARGET_NOT_FOUND, CANNOT_EDIT_OWN_PERMISSIONS, institution_admin
--     OUT_OF_SCOPE, INSUFFICIENT_PERMISSION (non-super_admin requires
--     users.manage_permissions), UNKNOWN_PERMISSION, and the
--     dangerous-permission / unheld-permission grant checks are all
--     reproduced byte-for-byte from migration 010.
--   - Does NOT add a new permission key or change any role default.
--   - Does NOT implement self-permission editing or any privilege escalation.
--
-- MANUAL APPLY ONLY — paste into Supabase Dashboard → SQL Editor and run.
-- DO NOT use "supabase db push" — this project manages migrations manually.
--
-- Prerequisites:
--   Migrations 001-016 should already be applied. In particular, if
--   verification step 2 below shows audit_logs is missing
--   actor_name_snapshot / actor_email_snapshot / actor_org_snapshot /
--   actor_identity_version, re-apply migration 013 (it is idempotent —
--   `add column if not exists` — safe to re-run) BEFORE relying solely on
--   this migration's exception handling as a permanent fix.
--
-- Safety:
--   - CREATE OR REPLACE FUNCTION only — no DROP FUNCTION, no DROP TABLE,
--     no TRUNCATE, no unsafe CASCADE.
--   - No data is deleted, moved, or migrated. profile_permission_overrides
--     and audit_logs rows are untouched by this file itself.
--   - Idempotent: safe to re-run; CREATE OR REPLACE FUNCTION is naturally
--     idempotent for identical or updated function bodies.
-- ============================================================================

-- ============================================================================
-- A. phoenix_profile_has_permission(uuid, text) — defensive re-assert.
--    Identical logic to migration 010: profile override first (when not
--    null), then role default, then false. Does not depend on auth.uid()
--    (this is a generic helper — the AUTHENTICATION check belongs to the
--    calling RPC, not this helper). Never grants a key that has no row in
--    either table (defaults to false). No secrets are read or returned.
-- ============================================================================

create or replace function phoenix_profile_has_permission(p_profile_id uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select o.allowed
       from profile_permission_overrides o
      where o.profile_id = p_profile_id and o.permission_key = p_key
        and o.allowed is not null),
    (select d.allowed
       from role_permission_defaults d
       join profiles pr on pr.id = p_profile_id
      where d.role = pr.role and d.permission_key = p_key),
    false
  );
$$;

-- ============================================================================
-- B. assign_profile_permissions(uuid, jsonb) — same contract as migration
--    010, only the trailing audit_logs insert is now exception-safe.
-- ============================================================================

create or replace function assign_profile_permissions(p_profile_id uuid, p_permissions jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_role  text;
  v_org   uuid;
  v_target_org uuid;
  v_key   text;
  v_val   jsonb;
  v_bool  boolean;
  v_dangerous boolean;
  v_applied  int := 0;
  v_rejected jsonb := '[]'::jsonb;
  v_audit_logged boolean := true;
begin
  v_actor := auth.uid();
  if v_actor is null then return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); end if;

  select role, organization_id into v_role, v_org from profiles where id = v_actor;
  select organization_id into v_target_org from profiles where id = p_profile_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND'); end if;

  -- authority: super_admin, or holds users.manage_permissions within same org
  if v_role <> 'super_admin' then
    if not phoenix_profile_has_permission(v_actor, 'users.manage_permissions') then
      return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_PERMISSION');
    end if;
    if v_target_org is distinct from v_org then
      return jsonb_build_object('ok', false, 'error', 'OUT_OF_SCOPE');
    end if;
  end if;

  -- block self-permission edits (no self-escalation)
  if p_profile_id = v_actor then
    return jsonb_build_object('ok', false, 'error', 'CANNOT_EDIT_OWN_PERMISSIONS');
  end if;

  for v_key, v_val in select * from jsonb_each(p_permissions) loop
    -- unknown key
    if not exists (select 1 from permission_keys where key = v_key) then
      v_rejected := v_rejected || jsonb_build_object('key', v_key, 'error', 'UNKNOWN_PERMISSION');
      continue;
    end if;

    if jsonb_typeof(v_val) = 'null' then
      v_bool := null;
    else
      v_bool := v_val::text::boolean;
    end if;

    -- granting requires the actor to hold the permission (dangerous included)
    if v_bool is true and v_role <> 'super_admin' then
      if not phoenix_profile_has_permission(v_actor, v_key) then
        select is_dangerous into v_dangerous from permission_keys where key = v_key;
        v_rejected := v_rejected || jsonb_build_object(
          'key', v_key,
          'error', case when v_dangerous then 'NEEDS_AUTHORITY_FOR_DANGEROUS' else 'CANNOT_GRANT_UNHELD' end
        );
        continue;
      end if;
    end if;

    insert into profile_permission_overrides (profile_id, permission_key, allowed, created_by)
      values (p_profile_id, v_key, v_bool, v_actor)
    on conflict (profile_id, permission_key)
      do update set allowed = excluded.allowed, created_by = v_actor, updated_at = now();
    v_applied := v_applied + 1;
  end loop;

  -- Audit logging is best-effort: a schema mismatch or any other failure
  -- writing to audit_logs must NEVER roll back the permission overrides
  -- already written above. The nested BEGIN/EXCEPTION block scopes the
  -- failure to just this insert (PL/pgSQL sub-blocks act as an implicit
  -- savepoint) — it does not swallow or weaken any security/authority
  -- check above, all of which already returned before this point on failure.
  begin
    insert into audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
      values (v_target_org, v_actor, v_role, 'permissions_assigned', 'profile', p_profile_id,
              jsonb_build_object('applied', v_applied, 'rejected', v_rejected));
  exception when others then
    v_audit_logged := false;
    raise warning 'assign_profile_permissions: audit_logs insert failed (permissions were still saved): %', sqlerrm;
  end;

  return jsonb_build_object('ok', true, 'applied', v_applied, 'rejected', v_rejected, 'audit_logged', v_audit_logged);
end;
$$;

-- ============================================================================
-- C. reset_profile_permissions(uuid) — same contract as migration 010,
--    only the trailing audit_logs insert is now exception-safe.
-- ============================================================================

create or replace function reset_profile_permissions(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_role  text;
  v_org   uuid;
  v_target_org uuid;
  v_count int;
  v_audit_logged boolean := true;
begin
  v_actor := auth.uid();
  if v_actor is null then return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); end if;

  select role, organization_id into v_role, v_org from profiles where id = v_actor;
  select organization_id into v_target_org from profiles where id = p_profile_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND'); end if;

  if v_role <> 'super_admin' then
    if not phoenix_profile_has_permission(v_actor, 'users.manage_permissions') then
      return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_PERMISSION');
    end if;
    if v_target_org is distinct from v_org then
      return jsonb_build_object('ok', false, 'error', 'OUT_OF_SCOPE');
    end if;
  end if;

  delete from profile_permission_overrides where profile_id = p_profile_id;
  get diagnostics v_count = row_count;

  -- Same audit-logging safety as assign_profile_permissions above — never
  -- roll back a successful reset because of an audit_logs write failure.
  begin
    insert into audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
      values (v_target_org, v_actor, v_role, 'permissions_reset', 'profile', p_profile_id,
              jsonb_build_object('cleared', v_count));
  exception when others then
    v_audit_logged := false;
    raise warning 'reset_profile_permissions: audit_logs insert failed (reset was still applied): %', sqlerrm;
  end;

  return jsonb_build_object('ok', true, 'cleared', v_count, 'audit_logged', v_audit_logged);
end;
$$;

-- ============================================================================
-- D. Grants — unchanged contract, re-asserted defensively (idempotent).
-- ============================================================================

revoke all on function phoenix_profile_has_permission(uuid, text) from anon;
revoke all on function assign_profile_permissions(uuid, jsonb) from anon;
revoke all on function reset_profile_permissions(uuid) from anon;
grant execute on function phoenix_profile_has_permission(uuid, text) to authenticated;
grant execute on function assign_profile_permissions(uuid, jsonb) to authenticated;
grant execute on function reset_profile_permissions(uuid) to authenticated;

-- ============================================================================
-- E. Verification
-- ============================================================================

do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('phoenix_profile_has_permission', 'assign_profile_permissions', 'reset_profile_permissions');
  assert v_count >= 3,
    'VERIFY FAILED: expected at least 3 matching function names, found ' || v_count;

  raise notice 'Migration 017 verification passed: permission RPC functions re-asserted with exception-safe audit logging.';
end $$;

-- ============================================================================
-- END OF MIGRATION 017
--
-- Post-apply verification (run manually, one block at a time):
--
-- 1. Confirm the live permission-table columns match the expected contract:
--    select table_name, column_name, data_type
--    from information_schema.columns
--    where table_schema = 'public'
--      and table_name in ('permission_keys', 'role_permission_defaults', 'profile_permission_overrides')
--    order by table_name, ordinal_position;
--    -- expect: permission_keys.key, role_permission_defaults.{role,permission_key,allowed},
--    --         profile_permission_overrides.{profile_id,permission_key,allowed,...}
--
-- 2. Confirm audit_logs actually has the 4 snapshot columns the migration-014
--    trigger writes to (this is the column most likely to have been missing
--    and causing the original 42703):
--    select column_name, data_type
--    from information_schema.columns
--    where table_schema = 'public' and table_name = 'audit_logs'
--    order by ordinal_position;
--    -- expect to find: actor_name_snapshot, actor_email_snapshot,
--    --                  actor_org_snapshot, actor_identity_version
--    -- If any are missing, re-apply migration 013 (idempotent) — that is
--    -- the actual schema gap; this migration's exception handling is a
--    -- safety net so permission saves keep working in the meantime, not a
--    -- substitute for the missing columns.
--
-- 3. Inspect the redefined helper function directly:
--    select pg_get_functiondef('public.phoenix_profile_has_permission(uuid,text)'::regprocedure);
--    -- expect: references profile_permission_overrides.allowed /
--    --         .permission_key and role_permission_defaults.allowed /
--    --         .permission_key only — no is_allowed anywhere.
--
-- 4. Confirm no duplicate/ambiguous overloads remain:
--    select p.oid::regprocedure as signature
--    from pg_proc p
--    join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('phoenix_profile_has_permission', 'assign_profile_permissions',
--                         'get_effective_permissions', 'reset_profile_permissions')
--    order by signature::text;
--    -- expect exactly one row per function name, matching the signatures in
--    -- this file's header (uuid,text / uuid,jsonb / uuid / uuid).
--
-- 5. Confirm super_admin still holds every users.% permission by default:
--    select role, permission_key, allowed
--    from role_permission_defaults
--    where role = 'super_admin' and permission_key like 'users.%'
--    order by permission_key;
--    -- expect: one row per users.% key, allowed = true for all of them.
--
-- 6. Confirm no data was deleted by this migration:
--    select count(*) from profile_permission_overrides;
--    select count(*) from role_permission_defaults;
--    select count(*) from permission_keys;
--    select count(*) from audit_logs;
--    -- Compare each count against a pre-migration snapshot (e.g. from your
--    -- backup) — none of these counts should ever decrease as a result of
--    -- applying this migration; it contains no DELETE/TRUNCATE statements.
--
-- NOTE on get_effective_permissions: it depends on auth.uid(), which is
-- only populated inside an authenticated PostgREST/RPC request context —
-- calling it directly from the SQL Editor (no JWT) will return
-- { ok: false, error: 'NOT_AUTHENTICATED' } regardless of whether the
-- function itself is correct. To fully exercise it, call it from the app
-- (or via `supabase.rpc(...)` with a real session) rather than the SQL
-- Editor. Its definition can still be reviewed directly:
--    select pg_get_functiondef('public.get_effective_permissions(uuid)'::regprocedure);
-- This migration does not modify get_effective_permissions — no issue was
-- found in it during this investigation.
-- ============================================================================
