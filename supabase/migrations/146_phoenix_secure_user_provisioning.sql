-- =============================================================================
-- 146_phoenix_secure_user_provisioning.sql
-- MediStock Phoenix V2
--
-- Purpose
-- -------
-- Close the account-provisioning IDOR/overwrite surface left by migration 093
-- and introduce the service-only contract used by admin-create-user.
--
-- The legacy phoenix_provision_profile RPC was executable by `authenticated`
-- and used INSERT ... ON CONFLICT DO UPDATE. A caller holding users.create
-- could therefore supply the UUID of an existing profile and overwrite its
-- organization, role, status and identity fields. This migration:
--
--   1. Revokes the legacy RPC from every client/API role.
--   2. Adds phoenix_admin_provision_profile, executable by service_role only.
--   3. Requires a fresh Auth user created by the Edge function, proved by an
--      unguessable provisioning nonce in auth.users.raw_app_meta_data.
--   4. Accepts only the exact fail-closed placeholder row created by
--      phoenix_handle_new_user; it never UPSERTs and can never modify a
--      previously provisioned profile.
--   5. Re-derives actor status, role, permissions and organization scope in
--      the database before any profile mutation.
--
-- Passwords are never accepted, stored or logged by this RPC.
-- =============================================================================

begin;

create or replace function public.phoenix_admin_provision_profile(
  p_actor_id          uuid,
  p_new_id            uuid,
  p_provisioning_nonce uuid,
  p_organization_id   uuid,
  p_full_name         text,
  p_role              text,
  p_login_mode        text,
  p_username          text default null,
  p_contact_email     text default null,
  p_correlation_id    uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_correlation      uuid := coalesce(p_correlation_id, gen_random_uuid());
  v_actor_role       text;
  v_actor_org        uuid;
  v_actor_status     text;
  v_actor_auth_exists boolean := false;
  v_is_super         boolean := false;
  v_is_institution   boolean := false;
  v_org_status       text;
  v_auth_created_at  timestamptz;
  v_auth_email       text;
  v_auth_app_meta    jsonb;
  v_auth_user_meta   jsonb;
  v_target_org       uuid;
  v_target_name      text;
  v_target_role      text;
  v_target_status    text;
  v_target_login     text;
  v_target_username  text;
  v_target_contact   text;
  v_target_must_change boolean;
  v_username         text := nullif(lower(btrim(coalesce(p_username, ''))), '');
begin
  -- Shape checks are non-sensitive and may return actionable error codes.
  if p_actor_id is null or p_new_id is null or p_provisioning_nonce is null
     or p_organization_id is null then
    return jsonb_build_object(
      'ok', false, 'error', 'INVALID_INPUT', 'correlation_id', v_correlation
    );
  end if;

  if p_actor_id = p_new_id then
    return jsonb_build_object(
      'ok', false,
      'error', 'REQUEST_DENIED',
      'correlation_id', v_correlation
    );
  end if;

  if nullif(btrim(coalesce(p_full_name, '')), '') is null
     or length(btrim(p_full_name)) > 200 then
    return jsonb_build_object(
      'ok', false, 'error', 'INVALID_FULL_NAME', 'correlation_id', v_correlation
    );
  end if;

  if p_role not in (
    'super_admin',
    'institution_admin',
    'central_warehouse_manager',
    'warehouse_officer',
    'outlet_officer'
  ) then
    return jsonb_build_object(
      'ok', false, 'error', 'INVALID_ROLE', 'correlation_id', v_correlation
    );
  end if;

  if p_login_mode not in ('local', 'email') then
    return jsonb_build_object(
      'ok', false, 'error', 'INVALID_LOGIN_MODE', 'correlation_id', v_correlation
    );
  end if;

  if p_login_mode = 'local' then
    if v_username is null or v_username !~ '^[a-z0-9._-]{3,32}$' then
      return jsonb_build_object(
        'ok', false, 'error', 'INVALID_USERNAME', 'correlation_id', v_correlation
      );
    end if;
  elsif p_username is not null or p_contact_email is not null then
    return jsonb_build_object(
      'ok', false, 'error', 'INVALID_IDENTITY_FIELDS', 'correlation_id', v_correlation
    );
  end if;

  -- Serialize all attempts for this target. This makes duplicate/replayed
  -- provisioning deterministic even when two Edge invocations race.
  perform pg_advisory_xact_lock(
    hashtextextended('phoenix-user-provision:' || p_new_id::text, 146)
  );

  select exists(select 1 from auth.users where id = p_actor_id)
    into v_actor_auth_exists;

  select role, organization_id, status
    into v_actor_role, v_actor_org, v_actor_status
  from public.profiles
  where id = p_actor_id;

  v_is_super := (
    v_actor_role = 'super_admin'
    and v_actor_status = 'active'
  );
  v_is_institution := (
    v_actor_role = 'institution_admin'
    and v_actor_status = 'active'
  );

  if not (v_is_super or v_is_institution) then
    return public._phoenix_lifecycle_deny(
      case when v_actor_auth_exists then p_actor_id else null end,
      v_actor_role,
      v_actor_org,
      p_new_id,
      'actor_not_authorized',
      v_correlation
    );
  end if;

  if v_is_institution then
    if coalesce(
         public.phoenix_profile_has_permission(p_actor_id, 'users.create'),
         false
       ) is not true
       or coalesce(
         public.phoenix_profile_has_permission(p_actor_id, 'users.assign_role'),
         false
       ) is not true then
      return public._phoenix_lifecycle_deny(
        p_actor_id,
        v_actor_role,
        v_actor_org,
        p_new_id,
        'actor_missing_permission',
        v_correlation
      );
    end if;

    if p_organization_id is distinct from v_actor_org then
      return public._phoenix_lifecycle_deny(
        p_actor_id,
        v_actor_role,
        v_actor_org,
        p_new_id,
        'cross_org',
        v_correlation
      );
    end if;

    if p_role in (
      'super_admin',
      'institution_admin',
      'central_warehouse_manager'
    ) then
      return public._phoenix_lifecycle_deny(
        p_actor_id,
        v_actor_role,
        v_actor_org,
        p_new_id,
        'cannot_create_privileged_role',
        v_correlation
      );
    end if;
  end if;

  select status into v_org_status
  from public.organizations
  where id = p_organization_id;

  if v_org_status is distinct from 'active' then
    return public._phoenix_lifecycle_deny(
      p_actor_id,
      v_actor_role,
      v_actor_org,
      p_new_id,
      'organization_not_active',
      v_correlation
    );
  end if;

  -- Auth Admin creates the user first. phoenix_handle_new_user then inserts a
  -- fail-closed outlet_officer placeholder. Lock and inspect that exact pair.
  select
    u.created_at,
    u.email,
    coalesce(u.raw_app_meta_data, '{}'::jsonb),
    coalesce(u.raw_user_meta_data, '{}'::jsonb),
    p.organization_id,
    p.full_name,
    p.role,
    p.status,
    p.login_mode,
    p.username,
    p.contact_email,
    p.must_change_password
  into
    v_auth_created_at,
    v_auth_email,
    v_auth_app_meta,
    v_auth_user_meta,
    v_target_org,
    v_target_name,
    v_target_role,
    v_target_status,
    v_target_login,
    v_target_username,
    v_target_contact,
    v_target_must_change
  from auth.users u
  join public.profiles p on p.id = u.id
  where u.id = p_new_id
  for update of p;

  if v_auth_created_at is null
     or v_auth_created_at < now() - interval '10 minutes'
     or v_auth_app_meta->>'phoenix_provisioning_nonce'
          is distinct from p_provisioning_nonce::text
     or v_auth_app_meta->>'phoenix_provisioning_actor_id'
          is distinct from p_actor_id::text
     or v_auth_user_meta->>'full_name'
          is distinct from btrim(p_full_name)
     or v_target_org is not null
     or v_target_name is distinct from btrim(p_full_name)
     or v_target_role is distinct from 'outlet_officer'
     or v_target_status is distinct from 'active'
     or v_target_login is distinct from 'email'
     or v_target_username is not null
     or v_target_contact is not null
     or v_target_must_change is distinct from false then
    return public._phoenix_lifecycle_deny(
      p_actor_id,
      v_actor_role,
      v_actor_org,
      p_new_id,
      'target_not_fresh_placeholder',
      v_correlation
    );
  end if;

  if p_login_mode = 'local'
     and lower(coalesce(v_auth_email, ''))
          is distinct from v_username || '@local.medistock.invalid' then
    return public._phoenix_lifecycle_deny(
      p_actor_id,
      v_actor_role,
      v_actor_org,
      p_new_id,
      'auth_identity_mismatch',
      v_correlation
    );
  end if;

  -- Deliberately UPDATE-only and one-shot. There is no ON CONFLICT branch:
  -- a pre-existing real profile can never be repurposed by this contract.
  update public.profiles
  set organization_id = p_organization_id,
      full_name = btrim(p_full_name),
      role = p_role,
      status = 'active',
      login_mode = p_login_mode,
      username = case when p_login_mode = 'local' then v_username else null end,
      contact_email = case
        when p_login_mode = 'local'
        then nullif(btrim(coalesce(p_contact_email, '')), '')
        else null
      end,
      must_change_password = (p_login_mode = 'local'),
      updated_at = now()
  where id = p_new_id;

  insert into public.audit_logs (
    organization_id,
    actor_id,
    actor_role,
    action,
    entity_type,
    entity_id,
    payload
  )
  values (
    p_organization_id,
    p_actor_id,
    v_actor_role,
    'user.created',
    'profile',
    p_new_id,
    jsonb_build_object(
      'role', p_role,
      'login_mode', p_login_mode,
      'provisioning_contract', 'service_only_v146',
      'correlation_id', v_correlation
    )
  );

  return jsonb_build_object(
    'ok', true,
    'user_id', p_new_id,
    'role', p_role,
    'correlation_id', v_correlation
  );
end;
$$;

comment on function public.phoenix_admin_provision_profile(
  uuid,uuid,uuid,uuid,text,text,text,text,text,uuid
) is
  'SECURE-USER-PROVISIONING-146: service-role-only, nonce-bound, one-shot '
  'conversion of a fresh auth-trigger placeholder into an authorized profile.';

-- Function creation grants EXECUTE to PUBLIC by default. Remove every client
-- path explicitly, including the legacy 093 RPC, before granting service_role
-- the sole API execution right on the replacement contract.
revoke all on function public.phoenix_admin_provision_profile(
  uuid,uuid,uuid,uuid,text,text,text,text,text,uuid
) from public;
revoke all on function public.phoenix_admin_provision_profile(
  uuid,uuid,uuid,uuid,text,text,text,text,text,uuid
) from anon;
revoke all on function public.phoenix_admin_provision_profile(
  uuid,uuid,uuid,uuid,text,text,text,text,text,uuid
) from authenticated;

grant execute on function public.phoenix_admin_provision_profile(
  uuid,uuid,uuid,uuid,text,text,text,text,text,uuid
) to service_role;

revoke all on function public.phoenix_provision_profile(
  uuid,uuid,text,text,text,text,text,uuid
) from public;
revoke all on function public.phoenix_provision_profile(
  uuid,uuid,text,text,text,text,text,uuid
) from anon;
revoke all on function public.phoenix_provision_profile(
  uuid,uuid,text,text,text,text,text,uuid
) from authenticated;
revoke all on function public.phoenix_provision_profile(
  uuid,uuid,text,text,text,text,text,uuid
) from service_role;

-- Migration-level structural verification. Behavioral/adversarial cases live
-- in 146-secure-user-provisioning.dynamic.test.ts.
do $$
declare
  v_new_oid regprocedure :=
    'public.phoenix_admin_provision_profile(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid)'::regprocedure;
  v_legacy_oid regprocedure :=
    'public.phoenix_provision_profile(uuid,uuid,text,text,text,text,text,uuid)'::regprocedure;
  v_is_definer boolean;
  v_config text[];
begin
  select p.prosecdef, p.proconfig
    into v_is_definer, v_config
  from pg_proc p
  where p.oid = v_new_oid;

  assert v_is_definer,
    'VERIFY FAILED (146): replacement provisioning RPC must be SECURITY DEFINER';
  assert 'search_path=public, pg_temp' = any(v_config),
    'VERIFY FAILED (146): replacement provisioning RPC search_path is not pinned';

  assert has_function_privilege(
    'service_role', v_new_oid, 'EXECUTE'
  ), 'VERIFY FAILED (146): service_role cannot execute replacement RPC';
  assert not has_function_privilege(
    'authenticated', v_new_oid, 'EXECUTE'
  ), 'VERIFY FAILED (146): authenticated can execute replacement RPC';
  assert not has_function_privilege(
    'anon', v_new_oid, 'EXECUTE'
  ), 'VERIFY FAILED (146): anon can execute replacement RPC';

  assert not exists (
    select 1
    from pg_proc p
    cross join lateral aclexplode(
      coalesce(p.proacl, acldefault('f', p.proowner))
    ) a
    where p.oid = v_new_oid
      and a.grantee = 0
      and a.privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED (146): PUBLIC can execute replacement RPC';

  assert not has_function_privilege(
    'authenticated', v_legacy_oid, 'EXECUTE'
  ), 'VERIFY FAILED (146): authenticated still executes legacy provisioning RPC';
  assert not has_function_privilege(
    'anon', v_legacy_oid, 'EXECUTE'
  ), 'VERIFY FAILED (146): anon still executes legacy provisioning RPC';
  assert not has_function_privilege(
    'service_role', v_legacy_oid, 'EXECUTE'
  ), 'VERIFY FAILED (146): service_role still executes legacy provisioning RPC';

  raise notice
    'SECURE-USER-PROVISIONING-146 verified: service-only replacement active; legacy client writer revoked.';
end;
$$;

commit;
