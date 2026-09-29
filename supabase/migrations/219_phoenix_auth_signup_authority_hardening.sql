-- ============================================================================
-- 219_phoenix_auth_signup_authority_hardening.sql
-- MediStock Phoenix — AUTH-1
--
-- Root cause (CONFIRMED HIGH). phoenix_handle_new_user (091) copied
-- auth.users.raw_user_meta_data->>'role' into profiles.role. Supabase user
-- metadata is written by the client at sign-up, so the client chose its own
-- authoritative RBAC role. Invariant restored here:
--
--   UNTRUSTED USER METADATA IS NEVER AN AUTHORIZATION AUTHORITY.
--
-- 1. New internal lifecycle value 'pending_provisioning' for profiles.role.
--    It is INTERNAL_ONLY, NON_ASSIGNABLE, NON_AUTHORIZED and NON_UI_ROLE: it is
--    not a business role, has zero role_permission_defaults (verified below),
--    is absent from every role-assignment allowlist (phoenix_admin_provision_
--    profile, assign_profile_role, phoenix_recycle_apply — verified below) and
--    from every frontend role list. It is deliberately NON-NULL: the AUTH-1
--    audit found existing deny checks written as role <> 'x', role NOT IN (..)
--    and NOT (..) that a NULL would skip; a non-NULL unknown role makes every
--    such comparison a definite BOOLEAN and fails closed.
--    A new CHECK pins its shape: a pending_provisioning profile is always
--    status 'suspended' with no organization.
-- 2. phoenix_handle_new_user ignores every authorization-shaped metadata key
--    (role, status, organization_id, permissions, is_admin, ...). Every new
--    auth user gets role 'pending_provisioning', status 'suspended',
--    organization_id NULL. Only a validated full_name (a JSON string, trimmed,
--    1-200 characters) is copied; otherwise the e-mail or 'Unknown'.
-- 3. phoenix_admin_provision_profile (182 body, forward-replaced; 146 and 182
--    are not edited) now accepts ONLY that exact pending placeholder. Every
--    other 182 check is unchanged: freshness, nonce and actor bound in
--    raw_app_meta_data, full_name identity, login identity, actor role, status
--    and permissions, organization and privileged-role restrictions, advisory
--    lock, UPDATE-only one-shot. Only after all of them does it set the
--    requested business role, status 'active' and the organization.
-- 4. get_effective_permissions (current body = M196, sha256 2b3bbd87...) is
--    forward-replaced with ONE predicate changed. Its contract: super_admin, or
--    self, or another profile in the SAME NON-NULL organization. The old test
--    "v_target_org is distinct from v_org" treated two NULL organizations as
--    the same scope, so an organization-less non-super actor (every pending
--    profile) could read another organization-less profile's effective
--    permission map. The new test "not coalesce(v_target_org = v_org, false)"
--    fails closed whenever either organization is NULL. Nothing else in the
--    body and no property of the function changes (VERIFY proves both).
--
-- Out of scope (AUTH-2, separately mandated): phoenix_my_role() and
-- phoenix_my_org() are NOT changed here, nor are the routines and policies the
-- AUTH-1 audit listed for suspended-account and NULL-safety hardening
-- (assign_profile_permissions and reset_profile_permissions keep their
-- NULL-organization comparison: their permission gate denies first).
--
-- Owner, SECURITY DEFINER, search_path (M198) and EXECUTE grants (M197) of the
-- three replaced functions are preserved (CREATE OR REPLACE keeps ownership and
-- ACL; VERIFY compares them with the values captured before the change).
-- ============================================================================

BEGIN;

SET LOCAL search_path = pg_catalog, pg_temp;

-- ----------------------------------------------------------------------------
-- 0. Preconditions — catalog reads only, before any lock. Fail closed on drift.
-- ----------------------------------------------------------------------------
DO $prelude$
DECLARE
  v_me    oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user);
  v_super boolean := (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user);
  v_src   text;
BEGIN
  IF (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = 'public.profiles'::regclass AND c.conname = 'profiles_role_check')
     ~ 'pending_provisioning' THEN
    RAISE EXCEPTION '219_already_applied';
  END IF;

  IF (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = 'public.profiles'::regclass AND c.conname = 'profiles_role_check')
     IS DISTINCT FROM 'CHECK ((role = ANY (ARRAY[''super_admin''::text, ''central_warehouse_manager''::text, ''institution_admin''::text, ''warehouse_officer''::text, ''outlet_officer''::text, ''health_center_manager''::text])))' THEN
    RAISE EXCEPTION '219_precondition_failed: profiles_role_check is not the six-role 182 definition';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
              WHERE c.conrelid = 'public.profiles'::regclass AND c.conname = 'profiles_pending_provisioning_shape_chk') THEN
    RAISE EXCEPTION '219_precondition_failed: profiles_pending_provisioning_shape_chk already exists';
  END IF;

  IF (SELECT pg_catalog.md5(p.prosrc) FROM pg_catalog.pg_proc p
       WHERE p.oid = pg_catalog.to_regprocedure('public.phoenix_handle_new_user()'))
     IS DISTINCT FROM '4c34bbc7cd5fb01205418c6287086365' THEN
    RAISE EXCEPTION '219_precondition_failed: phoenix_handle_new_user is not the 091 body';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'on_auth_user_created'
                    AND t.tgfoid = pg_catalog.to_regprocedure('public.phoenix_handle_new_user()')
                    AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgtype = 5) THEN
    RAISE EXCEPTION '219_precondition_failed: on_auth_user_created is not the AFTER INSERT row trigger bound to phoenix_handle_new_user';
  END IF;

  SELECT regexp_replace(p.prosrc, '\s+', ' ', 'g') INTO v_src FROM pg_catalog.pg_proc p
   WHERE p.oid = pg_catalog.to_regprocedure('public.phoenix_admin_provision_profile(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid)')
     AND p.prosecdef
     AND p.proconfig = ARRAY['search_path=public, pg_temp'];
  IF v_src IS NULL
     OR position('or v_target_role is distinct from ''outlet_officer'' or v_target_status is distinct from ''active''' IN v_src) = 0
     OR position('''provisioning_contract'', ''service_only_v146''' IN v_src) = 0 THEN
    RAISE EXCEPTION '219_precondition_failed: phoenix_admin_provision_profile is not the 182 contract';
  END IF;

  -- get_effective_permissions: exactly the reviewed current (M196) definition.
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
        WHERE p.oid = pg_catalog.to_regprocedure('public.get_effective_permissions(uuid)')
          AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
              = '2b3bbd879c22b8ea578532dee65ee7922163cbe925c2ae2093bfa48b3bacff96'
          AND p.prorettype = 'jsonb'::regtype AND l.lanname = 'plpgsql' AND p.provolatile = 'v'
          AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION '219_precondition_failed: get_effective_permissions is not the reviewed M196 definition';
  END IF;

  IF EXISTS (SELECT 1 FROM public.role_permission_defaults d WHERE d.role = 'pending_provisioning')
     OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.role = 'pending_provisioning') THEN
    RAISE EXCEPTION '219_precondition_failed: pending_provisioning is already in use';
  END IF;

  IF NOT v_super AND (
       (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.profiles'::regclass) <> v_me
       OR (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.phoenix_handle_new_user()')) <> v_me
       OR (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.phoenix_admin_provision_profile(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid)')) <> v_me
       OR (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.get_effective_permissions(uuid)')) <> v_me) THEN
    RAISE EXCEPTION '219_precondition_failed: M219 must be applied by the owner of public.profiles and of every replaced function'
      USING DETAIL = format('role=%s', current_user);
  END IF;

  -- Baselines VERIFY compares: the ACL, owner, SECURITY DEFINER flag and
  -- configuration of both replaced functions, and the bodies of the two
  -- authority helpers that AUTH-1 must NOT change.
  PERFORM set_config('phoenix_m219.handle_meta', (SELECT concat_ws('|', p.proowner::regrole::text, p.prosecdef, p.proconfig::text, p.proacl::text)
     FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.phoenix_handle_new_user()')), true);
  PERFORM set_config('phoenix_m219.provision_meta', (SELECT concat_ws('|', p.proowner::regrole::text, p.prosecdef, p.proconfig::text, p.proacl::text)
     FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.phoenix_admin_provision_profile(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid)')), true);
  PERFORM set_config('phoenix_m219.gep_meta', (SELECT concat_ws('|', p.proowner::regrole::text, p.prosecdef, p.proconfig::text, p.proacl::text,
         p.prorettype::regtype::text, p.provolatile, p.prolang, pg_catalog.pg_get_function_identity_arguments(p.oid))
     FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.get_effective_permissions(uuid)')), true);
  PERFORM set_config('phoenix_m219.gep_src', (SELECT p.prosrc FROM pg_catalog.pg_proc p
    WHERE p.oid = pg_catalog.to_regprocedure('public.get_effective_permissions(uuid)')), true);
  PERFORM set_config('phoenix_m219.helpers', (SELECT string_agg(p.proname || ':' || pg_catalog.md5(p.prosrc) || ':' || p.proacl::text, ';' ORDER BY p.proname)
     FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('phoenix_my_role', 'phoenix_my_org')), true);
END
$prelude$;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '60s';

-- profiles is tiny and hot (every request reads it through phoenix_my_role);
-- the lock is taken once, up front, and held only for this short transaction.
LOCK TABLE public.profiles IN ACCESS EXCLUSIVE MODE;

-- ----------------------------------------------------------------------------
-- 1. The internal lifecycle value and its shape.
-- ----------------------------------------------------------------------------
ALTER TABLE public.profiles
  DROP CONSTRAINT profiles_role_check,
  ADD CONSTRAINT profiles_role_check CHECK (role = ANY (ARRAY[
    'super_admin'::text, 'central_warehouse_manager'::text, 'institution_admin'::text,
    'warehouse_officer'::text, 'outlet_officer'::text, 'health_center_manager'::text,
    'pending_provisioning'::text])),
  ADD CONSTRAINT profiles_pending_provisioning_shape_chk CHECK (
    role <> 'pending_provisioning' OR (status = 'suspended' AND organization_id IS NULL));

COMMENT ON CONSTRAINT profiles_role_check ON public.profiles IS
  'AUTH-1 (219): the six business roles plus pending_provisioning — an INTERNAL_ONLY, NON_ASSIGNABLE, NON_AUTHORIZED, NON_UI lifecycle value held only between Auth user creation and trusted provisioning. It has no role_permission_defaults and is on no assignment allowlist.';
COMMENT ON CONSTRAINT profiles_pending_provisioning_shape_chk ON public.profiles IS
  'AUTH-1 (219): a pending_provisioning profile is always suspended and bound to no organization.';

-- ----------------------------------------------------------------------------
-- 2. phoenix_handle_new_user — no authority from user metadata.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_full_name text;
begin
  -- Display name only. Every authorization field below is server-fixed; no
  -- other raw_user_meta_data key is read.
  if pg_catalog.jsonb_typeof(new.raw_user_meta_data -> 'full_name') = 'string' then
    v_full_name := pg_catalog.btrim(new.raw_user_meta_data ->> 'full_name');
  end if;
  if v_full_name is null or v_full_name = '' or pg_catalog.length(v_full_name) > 200 then
    v_full_name := coalesce(nullif(pg_catalog.btrim(new.email), ''), 'Unknown');
  end if;

  insert into public.profiles (id, full_name, role, status, organization_id)
  values (new.id, v_full_name, 'pending_provisioning', 'suspended', null)
  on conflict (id) do nothing;
  return new;
end;
$function$;

COMMENT ON FUNCTION public.phoenix_handle_new_user() IS
  'AUTH-1 (219): AFTER INSERT on auth.users. Creates the non-authoritative placeholder profile (pending_provisioning, suspended, no organization). Reads only a validated display full_name from user metadata; never role, status, organization or permissions.';

-- ----------------------------------------------------------------------------
-- 3. phoenix_admin_provision_profile — accepts only the pending placeholder.
--    The body is the 182 body; the placeholder test is the only change.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_admin_provision_profile(p_actor_id uuid, p_new_id uuid, p_provisioning_nonce uuid, p_organization_id uuid, p_full_name text, p_role text, p_login_mode text, p_username text DEFAULT NULL::text, p_contact_email text DEFAULT NULL::text, p_correlation_id uuid DEFAULT gen_random_uuid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- AUTH-1 (219): pending_provisioning is an internal lifecycle value and is
  -- deliberately absent from this business-role allowlist.
  if p_role not in (
    'super_admin',
    'institution_admin',
    'central_warehouse_manager',
    'warehouse_officer',
    'outlet_officer',
    'health_center_manager'
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

  -- R1.1-U: a facility-scoped role exists only inside a health sector. Applied
  -- to EVERY caller, super_admin included, so the identity can never be created
  -- somewhere its facility scope could not be granted. A hospital or
  -- specialized-centre institution_admin is refused here, not merely in the UI.
  if p_role = 'health_center_manager' then
    if not exists (
      select 1 from public.organizations o
      where o.id = p_organization_id
        and o.status = 'active'
        and o.organization_kind = 'care_institution'
        and o.institution_class = 'health_sector'
    ) then
      return public._phoenix_lifecycle_deny(
        p_actor_id,
        v_actor_role,
        v_actor_org,
        p_new_id,
        'health_center_manager_requires_health_sector',
        v_correlation
      );
    end if;
  end if;

  -- Auth Admin creates the user first. phoenix_handle_new_user (219) then
  -- inserts the non-authoritative pending_provisioning placeholder (suspended,
  -- no organization). Lock and inspect that exact pair.
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
     or v_target_role is distinct from 'pending_provisioning'
     or v_target_status is distinct from 'suspended'
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
  -- The business role, the organization and status 'active' are written
  -- together, only here, after every check above has passed.
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
$function$;

-- ----------------------------------------------------------------------------
-- 3b. get_effective_permissions — the M196 body with ONE predicate changed:
--     "v_target_org is distinct from v_org" becomes
--     "not coalesce(v_target_org = v_org, false)": a NULL organization on
--     either side is never the same scope. Everything else is byte-identical.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_effective_permissions(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_actor uuid;v_role text;v_org uuid;v_target_org uuid;v_result jsonb;
begin
 v_actor:=auth.uid(); if v_actor is null then return jsonb_build_object('ok',false,'error','NOT_AUTHENTICATED'); end if;
 select role,organization_id into v_role,v_org from public.profiles where id=v_actor;
 select organization_id into v_target_org from public.profiles where id=p_profile_id; if not found then return jsonb_build_object('ok',false,'error','TARGET_NOT_FOUND'); end if;
 if v_role<>'super_admin' and p_profile_id<>v_actor and not coalesce(v_target_org = v_org, false) then return jsonb_build_object('ok',false,'error','OUT_OF_SCOPE'); end if;
 if v_role='health_center_manager' and p_profile_id<>v_actor then return jsonb_build_object('ok',false,'error','OUT_OF_SCOPE'); end if;
 select coalesce(jsonb_object_agg(k.key,phoenix_profile_has_permission(p_profile_id,k.key)),'{}'::jsonb) into v_result from public.permission_keys k;
 return jsonb_build_object('ok',true,'permissions',v_result);
end;$function$;

-- ----------------------------------------------------------------------------
-- 4. VERIFY — catalog reads only.
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_handle text;
  v_prov   text;
BEGIN
  IF (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = 'public.profiles'::regclass AND c.conname = 'profiles_role_check')
     IS DISTINCT FROM 'CHECK ((role = ANY (ARRAY[''super_admin''::text, ''central_warehouse_manager''::text, ''institution_admin''::text, ''warehouse_officer''::text, ''outlet_officer''::text, ''health_center_manager''::text, ''pending_provisioning''::text])))' THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): profiles_role_check is not the six business roles plus pending_provisioning';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                  WHERE c.conrelid = 'public.profiles'::regclass AND c.conname = 'profiles_pending_provisioning_shape_chk'
                    AND c.contype = 'c' AND c.convalidated
                    AND pg_catalog.pg_get_constraintdef(c.oid) = 'CHECK (((role <> ''pending_provisioning''::text) OR ((status = ''suspended''::text) AND (organization_id IS NULL))))') THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): profiles_pending_provisioning_shape_chk is missing, unvalidated or not the frozen shape';
  END IF;

  -- Zero authority for the sentinel.
  IF EXISTS (SELECT 1 FROM public.role_permission_defaults d WHERE d.role = 'pending_provisioning') THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): pending_provisioning has role_permission_defaults';
  END IF;

  -- The trigger function: server-fixed placeholder, no authority from metadata.
  SELECT regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', ' ', 'g') INTO v_handle
    FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.phoenix_handle_new_user()');
  IF v_handle ~* 'raw_user_meta_data\s*->>?\s*''(role|status|organization_id|permissions|is_admin|is_super_admin|app_role)'''
     OR v_handle ~* 'raw_app_meta_data'
     OR position('values (new.id, v_full_name, ''pending_provisioning'', ''suspended'', null)' IN v_handle) = 0
     OR (SELECT count(*) FROM regexp_matches(v_handle, 'raw_user_meta_data', 'g')) <> 2 THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): phoenix_handle_new_user must read only full_name from user metadata and insert the pending placeholder';
  END IF;

  -- The provisioning contract: only the pending placeholder is accepted, and
  -- the sentinel is on no assignment allowlist.
  SELECT regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', ' ', 'g') INTO v_prov
    FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.phoenix_admin_provision_profile(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid)');
  IF position('or v_target_role is distinct from ''pending_provisioning'' or v_target_status is distinct from ''suspended''' IN v_prov) = 0
     OR position('is distinct from ''outlet_officer''' IN v_prov) > 0
     OR (SELECT count(*) FROM regexp_matches(v_prov, 'pending_provisioning', 'g')) <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): phoenix_admin_provision_profile must accept only the pending_provisioning/suspended placeholder';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname IN ('assign_profile_role', 'phoenix_recycle_apply')
                AND p.prosrc ~ 'pending_provisioning') THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): a role-assignment routine mentions pending_provisioning';
  END IF;

  -- Owner, SECURITY DEFINER, configuration and EXECUTE grants unchanged.
  IF (SELECT concat_ws('|', p.proowner::regrole::text, p.prosecdef, p.proconfig::text, p.proacl::text)
        FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.phoenix_handle_new_user()'))
     IS DISTINCT FROM current_setting('phoenix_m219.handle_meta', true)
     OR (SELECT concat_ws('|', p.proowner::regrole::text, p.prosecdef, p.proconfig::text, p.proacl::text)
        FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.phoenix_admin_provision_profile(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid)'))
     IS DISTINCT FROM current_setting('phoenix_m219.provision_meta', true) THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): owner, SECURITY DEFINER, configuration or grants of a replaced function changed';
  END IF;
  IF has_function_privilege('anon', 'public.phoenix_handle_new_user()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.phoenix_handle_new_user()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.phoenix_admin_provision_profile(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.phoenix_admin_provision_profile(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): a client role can execute a replaced function';
  END IF;

  -- The trigger binding is unchanged.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'on_auth_user_created'
                    AND t.tgfoid = pg_catalog.to_regprocedure('public.phoenix_handle_new_user()')
                    AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgtype = 5) THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): on_auth_user_created binding changed';
  END IF;

  -- get_effective_permissions: exactly one predicate changed; every property kept.
  IF (SELECT concat_ws('|', p.proowner::regrole::text, p.prosecdef, p.proconfig::text, p.proacl::text,
             p.prorettype::regtype::text, p.provolatile, p.prolang, pg_catalog.pg_get_function_identity_arguments(p.oid))
        FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.get_effective_permissions(uuid)'))
     IS DISTINCT FROM current_setting('phoenix_m219.gep_meta', true) THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): get_effective_permissions identity, owner, security, configuration, grants, language, volatility or return type changed';
  END IF;
  IF (SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.get_effective_permissions(uuid)'))
       IS DISTINCT FROM replace(current_setting('phoenix_m219.gep_src', true),
                                'v_target_org is distinct from v_org', 'not coalesce(v_target_org = v_org, false)')
     OR (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
           FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.get_effective_permissions(uuid)'))
       IS DISTINCT FROM '8b891cb4b76947517c8d9c0ade96f8f0b0cb893d0c1730f7764c275d14ac09ec'
     OR (SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.get_effective_permissions(uuid)')) ~ 'is distinct from v_org' THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): get_effective_permissions is not the M196 body with only the NULL-organization scope predicate corrected';
  END IF;

  -- AUTH-1 scope: the authority helpers are untouched (AUTH-2).
  IF (SELECT string_agg(p.proname || ':' || pg_catalog.md5(p.prosrc) || ':' || p.proacl::text, ';' ORDER BY p.proname)
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('phoenix_my_role', 'phoenix_my_org'))
     IS DISTINCT FROM current_setting('phoenix_m219.helpers', true) THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): phoenix_my_role or phoenix_my_org changed (out of AUTH-1 scope)';
  END IF;
END
$verify$;

COMMIT;
