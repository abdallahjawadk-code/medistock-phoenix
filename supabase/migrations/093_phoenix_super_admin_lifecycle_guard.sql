-- =============================================================================
-- MediStock Phoenix — Migration 093: atomic account-lifecycle guard contract
-- SECURITY-ARCH-HARDENING-A (closes deferred D1 + D2)
--
-- WHY
--   The three admin Edge Functions previously (a) checked the "is this the last
--   active super_admin?" invariant and then mutated auth + profiles in separate,
--   non-atomic steps — a TOCTOU where two concurrent disable/delete calls could
--   each read count=2 and both proceed, leaving ZERO platform managers (D1); and
--   (b) returned distinct TARGET_NOT_FOUND / CROSS_ORG_FORBIDDEN /
--   INSUFFICIENT_PERMISSION responses that let a caller use error differences as
--   a user-/org-existence oracle (D2).
--
-- WHAT
--   A server-side, atomic lifecycle contract that the Edge Functions call
--   INSTEAD of mutating profile role/status directly:
--
--     phoenix_lifecycle_reserve(target, action, corr)   -- disable | delete
--     phoenix_lifecycle_commit(target, corr)            -- finalize a disable
--     phoenix_lifecycle_note_delete(target, role, corr) -- audit a done delete
--     phoenix_lifecycle_compensate(target, corr)        -- undo on Auth failure
--     phoenix_lifecycle_enable(target, corr)            -- suspended -> active
--     phoenix_lifecycle_authorize_rotation(target,corr) -- gate a pw rotation
--     phoenix_provision_profile(...)                    -- create's profile row
--     phoenix_recycle_apply(...)                        -- recycle's whole DB txn
--
--   The invariant + the state transition happen under ONE shared advisory
--   xact lock and are COMMITTED together (reserve flips profiles.status to
--   'suspended' and records a reservation row). Because the decision is
--   PERSISTED — not merely guarded by a lock released before the external Auth
--   call — a concurrent reserve observes the committed state and correctly
--   sees the target as no longer an active super_admin. If the subsequent Auth
--   Admin call fails, the Edge Function calls compensate, which restores the
--   exact prior status (no privilege expansion, no half-deleted account).
--
--   D2: every authorization/existence denial returns a single generic
--   'REQUEST_DENIED' while the real reason is recorded, with a correlation id,
--   in the RLS-protected audit_logs (action='security.access_denied'). No
--   secrets, no unnecessary PII (target is referenced by id only).
--
-- SAFETY
--   Transaction-wrapped. Every function is SECURITY DEFINER with a pinned
--   search_path, REVOKE-d from PUBLIC/anon, and GRANT-ed EXECUTE only to
--   `authenticated` (each function re-derives authority from auth.uid()).
--   Additive: no existing function/table/column/grant is dropped or narrowed;
--   no data migration. Not applied to Production by this PR.
-- =============================================================================

begin;

-- ── Persisted reservation state ──────────────────────────────────────────────
-- One in-flight lifecycle transition per profile. prior_status/prior_role let
-- compensation restore the exact pre-reservation state. Cascades away with the
-- profile (so a completed hard-delete leaves no dangling reservation).
create table if not exists public.profile_lifecycle_reservations (
  profile_id     uuid primary key references public.profiles(id) on delete cascade,
  action         text        not null check (action in ('disable', 'delete')),
  prior_status   text        not null,
  prior_role     text        not null,
  actor_id       uuid        not null,
  correlation_id uuid        not null,
  reserved_at    timestamptz not null default now()
);

comment on table public.profile_lifecycle_reservations is
  'SECURITY-ARCH-HARDENING-A: in-flight account-lifecycle reservations. Written '
  'only by the phoenix_lifecycle_* SECURITY DEFINER functions; RLS-enabled with '
  'no policy so no client role can read or write it directly.';

alter table public.profile_lifecycle_reservations enable row level security;
-- No policy is defined on purpose: RLS-enabled + zero policies denies every
-- non-owner role. The SECURITY DEFINER functions (owned by the migration role)
-- bypass RLS on this owned table; anon/authenticated get nothing.
revoke all on public.profile_lifecycle_reservations from public;
revoke all on public.profile_lifecycle_reservations from anon;
revoke all on public.profile_lifecycle_reservations from authenticated;

-- Shared lock key: every super-admin-affecting transition serializes on this one
-- key, so the count-check-and-transition can never interleave across sessions.
-- (bigint constant; value is arbitrary but fixed.)
-- Used via pg_advisory_xact_lock(9_314_093_001) inside each mutating function.

-- ── Internal helper: record a denial in the RLS-protected audit log ──────────
-- Kept as a separate SECURITY DEFINER function so every lifecycle function logs
-- denials identically. Never stores secrets/passwords; the target is referenced
-- by id only. Returns the generic client-facing payload.
create or replace function public._phoenix_lifecycle_deny(
  p_actor        uuid,
  p_actor_role   text,
  p_actor_org    uuid,
  p_target       uuid,
  p_reason       text,
  p_correlation  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.audit_logs
    (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
  values
    (p_actor_org, p_actor, p_actor_role, 'security.access_denied', 'profile', p_target,
     jsonb_build_object('reason', p_reason, 'correlation_id', p_correlation));
  return jsonb_build_object('ok', false, 'error', 'REQUEST_DENIED', 'correlation_id', p_correlation);
end;
$$;

-- Platform-managed roles an institution_admin may never act on.
-- (super_admin, institution_admin, central_warehouse_manager)

-- ── reserve: authorize + enforce the last-super-admin invariant + persist ────
create or replace function public.phoenix_lifecycle_reserve(
  p_target_id     uuid,
  p_action        text,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor       uuid := auth.uid();
  v_arole       text;
  v_aorg        uuid;
  v_astatus     text;
  v_is_super    boolean;
  v_is_inst     boolean;
  v_trole       text;
  v_tstatus     text;
  v_torg        uuid;
  v_active_sa   integer;
begin
  if p_action not in ('disable', 'delete') then
    return jsonb_build_object('ok', false, 'error', 'INVALID_ACTION', 'correlation_id', p_correlation_id);
  end if;
  if v_actor is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED', 'correlation_id', p_correlation_id);
  end if;

  -- Serialize ALL super-admin-affecting transitions on one key.
  perform pg_advisory_xact_lock(9314093001);

  select role, organization_id, status into v_arole, v_aorg, v_astatus
  from public.profiles where id = v_actor;
  v_is_super := (v_arole = 'super_admin' and v_astatus = 'active');
  v_is_inst  := (v_arole = 'institution_admin' and v_astatus = 'active');

  -- Actor must be an active super_admin or institution_admin.
  if not (v_is_super or v_is_inst) then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'actor_not_authorized', p_correlation_id);
  end if;
  -- institution_admin additionally needs the users.disable permission.
  if v_is_inst and coalesce(public.phoenix_profile_has_permission(v_actor, 'users.disable'), false) is not true then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'actor_missing_permission', p_correlation_id);
  end if;

  -- Self-action is never allowed.
  if p_target_id = v_actor then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'self_action', p_correlation_id);
  end if;

  select role, status, organization_id into v_trole, v_tstatus, v_torg
  from public.profiles where id = p_target_id;
  if v_trole is null then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'target_not_found', p_correlation_id);
  end if;

  -- institution_admin scope: own org only, never a platform-managed role,
  -- never a hard-delete.
  if v_is_inst then
    if v_trole in ('super_admin', 'institution_admin', 'central_warehouse_manager') then
      return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'target_platform_managed', p_correlation_id);
    end if;
    if v_aorg is distinct from v_torg then
      return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'cross_org', p_correlation_id);
    end if;
    if p_action = 'delete' then
      return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'delete_forbidden_for_role', p_correlation_id);
    end if;
  end if;

  -- Invariant: never remove the last active super_admin.
  if v_trole = 'super_admin' and v_tstatus = 'active' then
    select count(*) into v_active_sa
    from public.profiles where role = 'super_admin' and status = 'active';
    if v_active_sa <= 1 then
      -- Distinct, non-oracle code: fires only for an authorized actor acting on
      -- a real active super_admin. Logged too, for completeness.
      perform public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'last_super_admin', p_correlation_id);
      return jsonb_build_object('ok', false, 'error', 'LAST_SUPER_ADMIN', 'correlation_id', p_correlation_id);
    end if;
  end if;

  -- One in-flight transition per target.
  if exists (select 1 from public.profile_lifecycle_reservations where profile_id = p_target_id) then
    return jsonb_build_object('ok', false, 'error', 'LIFECYCLE_IN_PROGRESS', 'correlation_id', p_correlation_id);
  end if;

  -- PERSIST the decision: record the reservation and flip the target out of
  -- 'active' in the same committed transaction. From here a concurrent reserve
  -- observes the target as non-active and cannot also drain the last super_admin.
  insert into public.profile_lifecycle_reservations
    (profile_id, action, prior_status, prior_role, actor_id, correlation_id)
  values (p_target_id, p_action, v_tstatus, v_trole, v_actor, p_correlation_id);

  if p_action = 'disable' then
    update public.profiles
       set status = 'suspended', disabled_at = now(), disabled_by = v_actor, updated_at = now()
     where id = p_target_id;
  else -- delete: reserve by suspending; the row is removed after the Auth delete.
    update public.profiles
       set status = 'suspended', updated_at = now()
     where id = p_target_id;
  end if;

  insert into public.audit_logs
    (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
  values
    (coalesce(v_torg, v_aorg), v_actor, v_arole, 'user.lifecycle_reserved', 'profile', p_target_id,
     jsonb_build_object('action', p_action, 'target_role', v_trole, 'correlation_id', p_correlation_id));

  return jsonb_build_object('ok', true, 'action', p_action, 'target_role', v_trole,
                            'target_org', v_torg, 'correlation_id', p_correlation_id);
end;
$$;

-- ── commit: finalize a disable (target stays suspended, clear reservation) ────
create or replace function public.phoenix_lifecycle_commit(
  p_target_id      uuid,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_res   public.profile_lifecycle_reservations%rowtype;
begin
  if v_actor is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED', 'correlation_id', p_correlation_id);
  end if;
  perform pg_advisory_xact_lock(9314093001);

  select * into v_res from public.profile_lifecycle_reservations where profile_id = p_target_id;
  if v_res.profile_id is null then
    return jsonb_build_object('ok', false, 'error', 'NO_RESERVATION', 'correlation_id', p_correlation_id);
  end if;
  -- Only the actor who reserved may finalize.
  if v_res.actor_id is distinct from v_actor then
    return jsonb_build_object('ok', false, 'error', 'REQUEST_DENIED', 'correlation_id', p_correlation_id);
  end if;

  delete from public.profile_lifecycle_reservations where profile_id = p_target_id;

  insert into public.audit_logs
    (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
  values
    ((select organization_id from public.profiles where id = p_target_id),
     v_actor, (select role from public.profiles where id = v_actor),
     'user.disabled', 'profile', p_target_id,
     jsonb_build_object('correlation_id', p_correlation_id));

  return jsonb_build_object('ok', true, 'action', 'disabled', 'correlation_id', p_correlation_id);
end;
$$;

-- ── note_delete: audit a completed hard-delete (profile already cascaded) ─────
create or replace function public.phoenix_lifecycle_note_delete(
  p_target_id      uuid,
  p_target_role    text,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED', 'correlation_id', p_correlation_id);
  end if;
  -- The profile (and its reservation) no longer exist; this is audit-only.
  insert into public.audit_logs
    (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
  values
    ((select organization_id from public.profiles where id = v_actor),
     v_actor, (select role from public.profiles where id = v_actor),
     'user.deleted', 'profile', p_target_id,
     jsonb_build_object('target_role', p_target_role, 'correlation_id', p_correlation_id));
  return jsonb_build_object('ok', true, 'action', 'deleted', 'correlation_id', p_correlation_id);
end;
$$;

-- ── compensate: undo a reservation when the external Auth call failed ─────────
create or replace function public.phoenix_lifecycle_compensate(
  p_target_id      uuid,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_res   public.profile_lifecycle_reservations%rowtype;
begin
  if v_actor is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED', 'correlation_id', p_correlation_id);
  end if;
  perform pg_advisory_xact_lock(9314093001);

  select * into v_res from public.profile_lifecycle_reservations where profile_id = p_target_id;
  if v_res.profile_id is null then
    return jsonb_build_object('ok', false, 'error', 'NO_RESERVATION', 'correlation_id', p_correlation_id);
  end if;
  if v_res.actor_id is distinct from v_actor then
    return jsonb_build_object('ok', false, 'error', 'REQUEST_DENIED', 'correlation_id', p_correlation_id);
  end if;

  -- Restore the EXACT prior status; clear any disable audit columns we set.
  update public.profiles
     set status = v_res.prior_status, disabled_at = null, disabled_by = null, updated_at = now()
   where id = p_target_id;

  delete from public.profile_lifecycle_reservations where profile_id = p_target_id;

  insert into public.audit_logs
    (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
  values
    ((select organization_id from public.profiles where id = p_target_id),
     v_actor, (select role from public.profiles where id = v_actor),
     'user.lifecycle_compensated', 'profile', p_target_id,
     jsonb_build_object('restored_status', v_res.prior_status, 'reserved_action', v_res.action,
                        'correlation_id', p_correlation_id));

  return jsonb_build_object('ok', true, 'action', 'compensated',
                            'restored_status', v_res.prior_status, 'correlation_id', p_correlation_id);
end;
$$;

-- ── enable: suspended -> active (no invariant risk; still server-authorized) ──
create or replace function public.phoenix_lifecycle_enable(
  p_target_id      uuid,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_arole   text;
  v_aorg    uuid;
  v_astatus text;
  v_is_super boolean;
  v_is_inst  boolean;
  v_trole   text;
  v_torg    uuid;
begin
  if v_actor is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED', 'correlation_id', p_correlation_id);
  end if;
  perform pg_advisory_xact_lock(9314093001);

  select role, organization_id, status into v_arole, v_aorg, v_astatus
  from public.profiles where id = v_actor;
  v_is_super := (v_arole = 'super_admin' and v_astatus = 'active');
  v_is_inst  := (v_arole = 'institution_admin' and v_astatus = 'active');
  if not (v_is_super or v_is_inst) then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'actor_not_authorized', p_correlation_id);
  end if;
  if v_is_inst and coalesce(public.phoenix_profile_has_permission(v_actor, 'users.disable'), false) is not true then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'actor_missing_permission', p_correlation_id);
  end if;
  if p_target_id = v_actor then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'self_action', p_correlation_id);
  end if;

  select role, organization_id into v_trole, v_torg from public.profiles where id = p_target_id;
  if v_trole is null then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'target_not_found', p_correlation_id);
  end if;
  if v_is_inst then
    if v_trole in ('super_admin', 'institution_admin', 'central_warehouse_manager') then
      return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'target_platform_managed', p_correlation_id);
    end if;
    if v_aorg is distinct from v_torg then
      return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'cross_org', p_correlation_id);
    end if;
  end if;
  -- A target with an in-flight reservation must be committed/compensated first.
  if exists (select 1 from public.profile_lifecycle_reservations where profile_id = p_target_id) then
    return jsonb_build_object('ok', false, 'error', 'LIFECYCLE_IN_PROGRESS', 'correlation_id', p_correlation_id);
  end if;

  update public.profiles
     set status = 'active', disabled_at = null, disabled_by = null, updated_at = now()
   where id = p_target_id;

  insert into public.audit_logs
    (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
  values
    (coalesce(v_torg, v_aorg), v_actor, v_arole, 'user.enabled', 'profile', p_target_id,
     jsonb_build_object('correlation_id', p_correlation_id));

  return jsonb_build_object('ok', true, 'action', 'enabled', 'correlation_id', p_correlation_id);
end;
$$;

-- ── authorize_rotation: gate a password rotation, force change, audit ────────
-- The Edge Function performs the actual Auth password change + session revoke;
-- this function owns the authority decision and the must_change_password flag,
-- so the Edge never mutates profile state directly.
create or replace function public.phoenix_lifecycle_authorize_rotation(
  p_target_id      uuid,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_arole   text;
  v_aorg    uuid;
  v_astatus text;
  v_is_super boolean;
  v_is_inst  boolean;
  v_trole   text;
  v_torg    uuid;
begin
  if v_actor is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED', 'correlation_id', p_correlation_id);
  end if;
  perform pg_advisory_xact_lock(9314093001);

  select role, organization_id, status into v_arole, v_aorg, v_astatus
  from public.profiles where id = v_actor;
  v_is_super := (v_arole = 'super_admin' and v_astatus = 'active');
  v_is_inst  := (v_arole = 'institution_admin' and v_astatus = 'active');
  if not (v_is_super or v_is_inst) then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'actor_not_authorized', p_correlation_id);
  end if;
  if v_is_inst and coalesce(public.phoenix_profile_has_permission(v_actor, 'users.disable'), false) is not true then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'actor_missing_permission', p_correlation_id);
  end if;
  if p_target_id = v_actor then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'self_action', p_correlation_id);
  end if;

  select role, organization_id into v_trole, v_torg from public.profiles where id = p_target_id;
  if v_trole is null then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'target_not_found', p_correlation_id);
  end if;
  if v_is_inst then
    if v_trole in ('super_admin', 'institution_admin', 'central_warehouse_manager') then
      return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'target_platform_managed', p_correlation_id);
    end if;
    if v_aorg is distinct from v_torg then
      return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'cross_org', p_correlation_id);
    end if;
  end if;

  update public.profiles set must_change_password = true, updated_at = now()
   where id = p_target_id;

  insert into public.audit_logs
    (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
  values
    (coalesce(v_torg, v_aorg), v_actor, v_arole, 'user.password_rotated', 'profile', p_target_id,
     jsonb_build_object('target_role', v_trole, 'forced_password_change', true, 'correlation_id', p_correlation_id));

  return jsonb_build_object('ok', true, 'target_role', v_trole, 'correlation_id', p_correlation_id);
end;
$$;

-- ── provision_profile: create's profile row, server-authorized ───────────────
create or replace function public.phoenix_provision_profile(
  p_new_id         uuid,
  p_organization_id uuid,
  p_full_name      text,
  p_role           text,
  p_login_mode     text,
  p_username       text default null,
  p_contact_email  text default null,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_arole   text;
  v_aorg    uuid;
  v_astatus text;
  v_is_super boolean;
begin
  if v_actor is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED', 'correlation_id', p_correlation_id);
  end if;
  if p_role not in ('super_admin','institution_admin','central_warehouse_manager','warehouse_officer','outlet_officer') then
    return jsonb_build_object('ok', false, 'error', 'INVALID_ROLE', 'correlation_id', p_correlation_id);
  end if;

  select role, organization_id, status into v_arole, v_aorg, v_astatus
  from public.profiles where id = v_actor;
  v_is_super := (v_arole = 'super_admin' and v_astatus = 'active');

  -- Only super_admin may mint platform-managed identities.
  if p_role in ('super_admin','institution_admin','central_warehouse_manager') and not v_is_super then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_new_id, 'cannot_create_privileged_role', p_correlation_id);
  end if;
  if not v_is_super then
    if coalesce(public.phoenix_profile_has_permission(v_actor, 'users.create'), false) is not true then
      return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_new_id, 'actor_missing_permission', p_correlation_id);
    end if;
    if p_organization_id is distinct from v_aorg then
      return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_new_id, 'cross_org', p_correlation_id);
    end if;
  end if;

  insert into public.profiles (id, organization_id, full_name, role, status, login_mode,
                               username, contact_email, must_change_password)
  values (p_new_id, p_organization_id, p_full_name, p_role, 'active',
          coalesce(p_login_mode, 'local'),
          case when p_login_mode = 'local' then p_username else null end,
          case when p_login_mode = 'local' then p_contact_email else null end,
          case when p_login_mode = 'local' then true else false end)
  on conflict (id) do update
    set organization_id = excluded.organization_id,
        full_name = excluded.full_name,
        role = excluded.role,
        status = 'active',
        login_mode = excluded.login_mode,
        username = excluded.username,
        contact_email = excluded.contact_email,
        must_change_password = excluded.must_change_password,
        updated_at = now();

  insert into public.audit_logs
    (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
  values
    (p_organization_id, v_actor, v_arole, 'user.created', 'profile', p_new_id,
     jsonb_build_object('role', p_role, 'login_mode', coalesce(p_login_mode,'local'), 'correlation_id', p_correlation_id));

  return jsonb_build_object('ok', true, 'user_id', p_new_id, 'role', p_role, 'correlation_id', p_correlation_id);
end;
$$;

-- ── recycle_apply: recycle's whole DB transition, atomic + server-authorized ─
create or replace function public.phoenix_recycle_apply(
  p_target_id       uuid,
  p_new_full_name   text,
  p_new_role        text,
  p_new_org         uuid,
  p_login_mode      text,
  p_username        text,
  p_contact_email   text,
  p_new_email       text,
  p_expected_version integer,
  p_correlation_id  uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_arole   text;
  v_aorg    uuid;
  v_astatus text;
  v_is_super boolean;
  v_is_inst  boolean;
  v_trole   text;
  v_tstatus text;
  v_torg    uuid;
  v_tver    integer;
  v_newver  integer;
  v_efforg  uuid;
begin
  if v_actor is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED', 'correlation_id', p_correlation_id);
  end if;
  if p_new_role not in ('super_admin','institution_admin','central_warehouse_manager','warehouse_officer','outlet_officer') then
    return jsonb_build_object('ok', false, 'error', 'INVALID_ROLE', 'correlation_id', p_correlation_id);
  end if;
  perform pg_advisory_xact_lock(9314093001);

  select role, organization_id, status into v_arole, v_aorg, v_astatus
  from public.profiles where id = v_actor;
  v_is_super := (v_arole = 'super_admin' and v_astatus = 'active');
  v_is_inst  := (v_arole = 'institution_admin' and v_astatus = 'active');
  if not (v_is_super or v_is_inst) then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'actor_not_authorized', p_correlation_id);
  end if;
  if coalesce(public.phoenix_profile_has_permission(v_actor, 'users.recycle'), false) is not true then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'actor_missing_permission', p_correlation_id);
  end if;
  if p_target_id = v_actor then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'self_action', p_correlation_id);
  end if;

  select role, status, organization_id, identity_version
    into v_trole, v_tstatus, v_torg, v_tver
  from public.profiles where id = p_target_id;
  if v_trole is null then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'target_not_found', p_correlation_id);
  end if;
  if v_tstatus is distinct from 'suspended' then
    return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_SUSPENDED', 'correlation_id', p_correlation_id);
  end if;
  if v_trole = 'super_admin' then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'cannot_recycle_super_admin', p_correlation_id);
  end if;
  if v_is_inst then
    if v_trole in ('institution_admin', 'central_warehouse_manager') then
      return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'target_platform_managed', p_correlation_id);
    end if;
    if v_aorg is distinct from v_torg then
      return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'cross_org', p_correlation_id);
    end if;
    if p_new_role in ('super_admin','institution_admin','central_warehouse_manager') then
      return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'cannot_assign_elevated_role', p_correlation_id);
    end if;
    if p_new_org is not null then
      return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'cross_org', p_correlation_id);
    end if;
  end if;
  -- Optimistic concurrency: the caller acted on a specific identity version.
  if p_expected_version is not null and v_tver is distinct from p_expected_version then
    return jsonb_build_object('ok', false, 'error', 'LIFECYCLE_IN_PROGRESS', 'correlation_id', p_correlation_id);
  end if;
  if exists (select 1 from public.profile_lifecycle_reservations where profile_id = p_target_id) then
    return jsonb_build_object('ok', false, 'error', 'LIFECYCLE_IN_PROGRESS', 'correlation_id', p_correlation_id);
  end if;

  v_newver := v_tver + 1;
  v_efforg := case when v_is_super and p_new_org is not null then p_new_org else v_torg end;

  -- Close the current open identity-history row (matched by version).
  update public.user_identity_history
     set valid_until = now()
   where profile_id = p_target_id and identity_version = v_tver and valid_until is null;

  update public.profiles
     set identity_version = v_newver,
         full_name = p_new_full_name,
         role = p_new_role,
         status = 'active',
         login_mode = coalesce(p_login_mode, 'local'),
         username = case when p_login_mode = 'local' then p_username else null end,
         contact_email = case when p_login_mode = 'local' then p_contact_email else null end,
         must_change_password = (p_login_mode = 'local'),
         organization_id = v_efforg,
         disabled_at = null,
         disabled_by = null,
         updated_at = now()
   where id = p_target_id;

  insert into public.user_identity_history
    (profile_id, identity_version, full_name, email, role, organization_id,
     valid_from, valid_until, change_reason, recycled_by)
  values
    (p_target_id, v_newver, p_new_full_name, p_new_email, p_new_role, v_efforg,
     now(), null, 'account_recycled', v_actor);

  insert into public.audit_logs
    (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
  values
    (v_efforg, v_actor, v_arole, 'user.account_recycled', 'profile', p_target_id,
     jsonb_build_object('old_role', v_trole, 'new_role', p_new_role,
                        'new_identity_version', v_newver, 'correlation_id', p_correlation_id));

  return jsonb_build_object('ok', true, 'target_profile_id', p_target_id,
                            'new_identity_version', v_newver, 'correlation_id', p_correlation_id);
end;
$$;

-- ── Lock down execution: no PUBLIC/anon; only authenticated (Edge caller JWT) ─
do $$
declare
  fn text;
  fns text[] := array[
    '_phoenix_lifecycle_deny(uuid,text,uuid,uuid,text,uuid)',
    'phoenix_lifecycle_reserve(uuid,text,uuid)',
    'phoenix_lifecycle_commit(uuid,uuid)',
    'phoenix_lifecycle_note_delete(uuid,text,uuid)',
    'phoenix_lifecycle_compensate(uuid,uuid)',
    'phoenix_lifecycle_enable(uuid,uuid)',
    'phoenix_lifecycle_authorize_rotation(uuid,uuid)',
    'phoenix_provision_profile(uuid,uuid,text,text,text,text,text,uuid)',
    'phoenix_recycle_apply(uuid,text,text,uuid,text,text,text,text,integer,uuid)'
  ];
begin
  foreach fn in array fns loop
    execute format('revoke all on function public.%s from public', fn);
    execute format('revoke all on function public.%s from anon', fn);
  end loop;
  -- The internal deny helper is never called directly by clients.
  execute 'grant execute on function public.phoenix_lifecycle_reserve(uuid,text,uuid) to authenticated';
  execute 'grant execute on function public.phoenix_lifecycle_commit(uuid,uuid) to authenticated';
  execute 'grant execute on function public.phoenix_lifecycle_note_delete(uuid,text,uuid) to authenticated';
  execute 'grant execute on function public.phoenix_lifecycle_compensate(uuid,uuid) to authenticated';
  execute 'grant execute on function public.phoenix_lifecycle_enable(uuid,uuid) to authenticated';
  execute 'grant execute on function public.phoenix_lifecycle_authorize_rotation(uuid,uuid) to authenticated';
  execute 'grant execute on function public.phoenix_provision_profile(uuid,uuid,text,text,text,text,text,uuid) to authenticated';
  execute 'grant execute on function public.phoenix_recycle_apply(uuid,text,text,uuid,text,text,text,text,integer,uuid) to authenticated';
end;
$$;

commit;
