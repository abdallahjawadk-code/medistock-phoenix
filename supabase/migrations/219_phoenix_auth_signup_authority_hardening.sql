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
--    forward-replaced with exactly three edits (section 3b). Its contract:
--    super_admin, or self, or another profile in the SAME NON-NULL
--    organization. The old predicate "v_target_org is distinct from v_org"
--    treated two NULL organizations as the same scope, so an organization-less
--    non-super actor (every pending profile) could read another
--    organization-less profile's effective permission map; the new predicate
--    "not coalesce(v_target_org = v_org, false)" fails closed whenever either
--    organization is NULL. HC1 (5b) adds the other two edits: the
--    profile-less actor denial (ACTOR_PROFILE_NOT_FOUND) right after the actor
--    lookup, and the NULL-safe super_admin test ("v_role is distinct from").
--    Nothing else in the body and no property of the function changes
--    (VERIFY proves both).
-- 5. M219-HC1 supersedes the first M219 artifact before any Production apply
--    (same file, same canonical number). It replaces four more routines —
--    assign_profile_role, phoenix_recycle_apply, assign_profile_permissions and
--    reset_profile_permissions — and, with the get_effective_permissions edits
--    above, makes the contract above true on every M219-relevant authority
--    path reachable by a client or service RPC:
--    a. Among client- and service-callable RPCs, the sentinel leaves its shape
--       ONLY through phoenix_admin_provision_profile. The generic RPCs that
--       could otherwise move it, or give it authority, are fenced on the
--       TARGET whoever the actor is (super_admin included), after their own
--       authority checks: assign_profile_role (TARGET_PENDING_PROVISIONING),
--       phoenix_recycle_apply (audited denial target_pending_provisioning) and
--       assign_profile_permissions, which never writes a permission override
--       for the sentinel (an override is authority even without a role
--       change). reset_profile_permissions carries no target fence: it can
--       only delete overrides, never grant. Every other client- or
--       service-callable RPC that writes profiles.role / status /
--       organization_id either cannot reach the sentinel or cannot take it out
--       of its shape (the shape CHECK above). Trusted direct DML by
--       service_role or postgres, and the postgres-only legacy
--       phoenix_provision_profile, are outside this RPC-level guarantee.
--    b. Authentication alone is not authority on these paths.
--       get_effective_permissions, assign_profile_permissions and
--       reset_profile_permissions deny a caller whose auth.uid() has no
--       profiles row (ACTOR_PROFILE_NOT_FOUND) before any role, organization
--       or permission state is used, and their super_admin / permission tests
--       are NULL-safe (IS DISTINCT FROM, coalesce(..., false) IS NOT TRUE).
--       phoenix_recycle_apply denies such a caller the same way (audited,
--       actor_profile_not_found) and coalesces its actor booleans.
--       assign_profile_role already denied it (unchanged).
--    Each replaced body is its predecessor with exactly these edits: the
--    prelude pins every predecessor, the static suite re-derives every result
--    from the migration that last defined it, and VERIFY pins it by sha256.
--
-- Out of scope (AUTH-2, separately mandated): phoenix_my_role() and
-- phoenix_my_org() are NOT changed here. Of the routines and policies the
-- AUTH-1 audit listed for suspended-account and NULL-safety hardening, HC1
-- changes ONLY what B3 requires: the actor-profile denial and the NULL-safe
-- super_admin / permission gates of get_effective_permissions,
-- assign_profile_permissions and reset_profile_permissions, and the coalesced
-- actor booleans of phoenix_recycle_apply. Everything else stays AUTH-2,
-- including the NULL-organization comparison (v_target_org is distinct from
-- v_org) that assign_profile_permissions and reset_profile_permissions keep: a
-- NULL-organization actor still needs users.manage_permissions, and the
-- sentinel is protected by the assign fence (reset only deletes). Open AUTH-2
-- findings, NOT closed here:
--   * AUTH2_PROFILELESS_LIFECYCLE_GATE_FINDING: phoenix_lifecycle_enable,
--     phoenix_lifecycle_authorize_rotation and phoenix_lifecycle_reserve admit
--     an actor with no profiles row past their gates; none of them can take the
--     sentinel out of its shape. In the same family,
--     phoenix_lifecycle_authorize_rotation accepts a sentinel target, so an
--     administrator can act on a pending account's Auth credential while its
--     profile keeps the sentinel shape.
--   * AUTH2_PROFILE_PERMISSION_INTROSPECTION_FINDING:
--     phoenix_profile_has_permission and the related assignment / scope
--     inspection helpers let any authenticated caller inspect another
--     profile's permission state. Closing the get_effective_permissions path
--     here does not close authorization reads globally.
--
-- Owner, SECURITY DEFINER, search_path and EXECUTE grants of the seven
-- replaced functions are preserved exactly as the prelude captures them
-- (CREATE OR REPLACE keeps ownership and ACL; VERIFY compares them with those
-- values). Of the seven, only phoenix_handle_new_user is among the functions
-- M197 (EXECUTE) and M198 (search_path) converged; the other six carry the
-- search_path and grants of the migrations that last defined or granted them.
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

  -- HC1: the four generic authority routines 5a/5b harden (below and in VERIFY
  -- "fenced routine" means these four: three carry the sentinel-target fence,
  -- reset_profile_permissions only the profile-less actor denial), each exactly
  -- its reviewed predecessor (assign_profile_role, assign_profile_permissions and
  -- reset_profile_permissions: M196; phoenix_recycle_apply: M093). The body is
  -- compared with CRLF normalised to LF, because Production carries two of them
  -- with CRLF line endings, a historical comment/whitespace-only drift.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
       WHERE p.oid IN (pg_catalog.to_regprocedure('public.assign_profile_role(uuid,text)'),
                       pg_catalog.to_regprocedure('public.phoenix_recycle_apply(uuid,text,text,uuid,text,text,text,text,integer,uuid)'),
                       pg_catalog.to_regprocedure('public.assign_profile_permissions(uuid,jsonb)'),
                       pg_catalog.to_regprocedure('public.reset_profile_permissions(uuid)'))
         AND p.prorettype = 'jsonb'::regtype AND l.lanname = 'plpgsql' AND p.provolatile = 'v'
         AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']
         AND pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) = CASE p.proname
               WHEN 'assign_profile_role' THEN '2560b42ba8d8afcf7b33c45bb71e68c4'
               WHEN 'phoenix_recycle_apply' THEN '35120783a910fcd29d463ccb7d9cd86e'
               WHEN 'assign_profile_permissions' THEN 'cdd271498787559b7be83e6f816c5586'
               WHEN 'reset_profile_permissions' THEN 'ef98ee9a7b589cf7fc1192e02bdfbe74' END) <> 4 THEN
    RAISE EXCEPTION '219_precondition_failed: assign_profile_role, phoenix_recycle_apply, assign_profile_permissions or reset_profile_permissions is not its reviewed predecessor';
  END IF;

  -- One definition per replaced routine: no overload can offer an unfenced path.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('phoenix_handle_new_user', 'phoenix_admin_provision_profile',
             'get_effective_permissions', 'assign_profile_role', 'phoenix_recycle_apply',
             'assign_profile_permissions', 'reset_profile_permissions')) <> 7 THEN
    RAISE EXCEPTION '219_precondition_failed: a replaced routine has an overload';
  END IF;

  IF EXISTS (SELECT 1 FROM public.role_permission_defaults d WHERE d.role = 'pending_provisioning')
     OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.role = 'pending_provisioning') THEN
    RAISE EXCEPTION '219_precondition_failed: pending_provisioning is already in use';
  END IF;

  IF NOT v_super AND (
       (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.profiles'::regclass) <> v_me
       OR (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.phoenix_handle_new_user()')) <> v_me
       OR (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.phoenix_admin_provision_profile(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid)')) <> v_me
       OR (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.get_effective_permissions(uuid)')) <> v_me
       OR (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.assign_profile_role(uuid,text)')) <> v_me
       OR (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.phoenix_recycle_apply(uuid,text,text,uuid,text,text,text,text,integer,uuid)')) <> v_me
       OR (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.assign_profile_permissions(uuid,jsonb)')) <> v_me
       OR (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.reset_profile_permissions(uuid)')) <> v_me) THEN
    RAISE EXCEPTION '219_precondition_failed: M219 must be applied by the owner of public.profiles and of every replaced function'
      USING DETAIL = format('role=%s', current_user);
  END IF;

  -- Baselines VERIFY compares: the ACL, owner, SECURITY DEFINER flag and
  -- configuration of phoenix_handle_new_user and phoenix_admin_provision_profile,
  -- the full identity/properties and body of get_effective_permissions, the
  -- bodies of the two authority helpers that AUTH-1 must NOT change, and (HC1,
  -- last) the full identity/properties of the four fenced routines.
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
  -- HC1: identity, owner, SECURITY DEFINER, configuration, ACL, return type,
  -- volatility and language of the four fenced routines.
  PERFORM set_config('phoenix_m219.hc1_meta', (SELECT string_agg(concat_ws('|', p.oid::regprocedure::text, p.proowner::regrole::text,
         p.prosecdef, p.proconfig::text, p.proacl::text, p.prorettype::regtype::text, p.provolatile, p.prolang), ';' ORDER BY p.proname)
     FROM pg_catalog.pg_proc p
    WHERE p.oid IN (pg_catalog.to_regprocedure('public.assign_profile_role(uuid,text)'),
                    pg_catalog.to_regprocedure('public.phoenix_recycle_apply(uuid,text,text,uuid,text,text,text,text,integer,uuid)'),
                    pg_catalog.to_regprocedure('public.assign_profile_permissions(uuid,jsonb)'),
                    pg_catalog.to_regprocedure('public.reset_profile_permissions(uuid)'))), true);
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
  'AUTH-1 (219): the six business roles plus pending_provisioning — an INTERNAL_ONLY, NON_ASSIGNABLE, NON_AUTHORIZED, NON_UI lifecycle value held only between Auth user creation and trusted provisioning. It has no role_permission_defaults, is on no assignment allowlist, and no generic role-assignment, recycle or permission-grant RPC accepts it as a target (HC1; reset_profile_permissions may only clear overrides).';
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
-- 3b. get_effective_permissions — the M196 body with exactly three edits:
--     "v_target_org is distinct from v_org" becomes
--     "not coalesce(v_target_org = v_org, false)": a NULL organization on
--     either side is never the same scope; HC1 (5b) denies a caller with no
--     profiles row (ACTOR_PROFILE_NOT_FOUND) right after the actor lookup and
--     makes the super_admin test NULL-safe ("v_role is distinct from").
--     Everything else is byte-identical.
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
 select role,organization_id into v_role,v_org from public.profiles where id=v_actor; if not found then return jsonb_build_object('ok',false,'error','ACTOR_PROFILE_NOT_FOUND'); end if;
 select organization_id into v_target_org from public.profiles where id=p_profile_id; if not found then return jsonb_build_object('ok',false,'error','TARGET_NOT_FOUND'); end if;
 if v_role is distinct from 'super_admin' and p_profile_id<>v_actor and not coalesce(v_target_org = v_org, false) then return jsonb_build_object('ok',false,'error','OUT_OF_SCOPE'); end if;
 if v_role='health_center_manager' and p_profile_id<>v_actor then return jsonb_build_object('ok',false,'error','OUT_OF_SCOPE'); end if;
 select coalesce(jsonb_object_agg(k.key,phoenix_profile_has_permission(p_profile_id,k.key)),'{}'::jsonb) into v_result from public.permission_keys k;
 return jsonb_build_object('ok',true,'permissions',v_result);
end;$function$;

-- ----------------------------------------------------------------------------
-- 3c. HC1 — sentinel fences (5a) and profile-less actor denial (5b) in the
--     generic authority routines. Each body is its pinned predecessor (M196 /
--     M093) with only the HC1 edits; signatures, defaults, owner, SECURITY
--     DEFINER, search_path and ACL are unchanged (CREATE OR REPLACE).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_profile_role(p_target_id uuid, p_new_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_id     uuid;
  v_actor_role   text;
  v_target       profiles%rowtype;
  v_allowed_roles text[] := array[
    'super_admin', 'central_warehouse_manager', 'institution_admin',
    'warehouse_officer', 'outlet_officer'
  ];
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  end if;

  select role into v_actor_role
  from public.profiles where id = v_actor_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'ACTOR_PROFILE_NOT_FOUND');
  end if;

  -- FIVE-ROLE-CUTOVER-091: only the platform admin may assign roles through
  -- this legacy RPC now (hospital_admin can no longer exist as an actor).
  if v_actor_role <> 'super_admin' then
    return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  end if;

  if p_new_role != all(v_allowed_roles) then
    return jsonb_build_object('ok', false, 'error', 'INVALID_ROLE', 'allowed', v_allowed_roles);
  end if;

  select * into v_target from public.profiles where id = p_target_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND');
  end if;

  -- AUTH-1 (219-HC1): the internal pending_provisioning sentinel is never the
  -- target of this generic role RPC, whoever the actor is. It leaves its shape
  -- only through phoenix_admin_provision_profile (nonce, actor binding,
  -- freshness, Auth identity, one-shot).
  if v_target.role = 'pending_provisioning' then
    return jsonb_build_object('ok', false, 'error', 'TARGET_PENDING_PROVISIONING');
  end if;

  if p_target_id = v_actor_id then
    return jsonb_build_object('ok', false, 'error', 'CANNOT_CHANGE_OWN_ROLE');
  end if;

  if p_new_role = 'super_admin' and v_actor_role <> 'super_admin' then
    return jsonb_build_object('ok', false, 'error', 'CANNOT_ESCALATE_TO_SUPER_ADMIN');
  end if;

  if v_target.role = p_new_role then
    return jsonb_build_object('ok', true, 'changed', false, 'reason', 'ALREADY_ASSIGNED');
  end if;

  update public.profiles set role = p_new_role, updated_at = now() where id = p_target_id;

  insert into public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
    values (v_target.organization_id, v_actor_id, v_actor_role, 'role_assigned', 'profile',
            p_target_id, v_target.full_name,
            jsonb_build_object('previous_role', v_target.role, 'new_role', p_new_role));

  return jsonb_build_object('ok', true, 'changed', true, 'previous_role', v_target.role, 'new_role', p_new_role);
end;
$function$;

CREATE OR REPLACE FUNCTION public.phoenix_recycle_apply(p_target_id uuid, p_new_full_name text, p_new_role text, p_new_org uuid, p_login_mode text, p_username text, p_contact_email text, p_new_email text, p_expected_version integer, p_correlation_id uuid DEFAULT gen_random_uuid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- AUTH-1 (219-HC1): authentication alone is not authority. A caller with no
  -- profiles row is denied here, before any role, organization or permission
  -- state is used; the denial is audited without an actor id, because that id
  -- may no longer exist in auth.users.
  if not found then
    return public._phoenix_lifecycle_deny(null, null, null, p_target_id, 'actor_profile_not_found', p_correlation_id);
  end if;
  v_is_super := coalesce(v_arole = 'super_admin' and v_astatus = 'active', false);
  v_is_inst  := coalesce(v_arole = 'institution_admin' and v_astatus = 'active', false);
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
  -- AUTH-1 (219-HC1): the internal pending_provisioning sentinel is never
  -- recycled; it leaves its shape only through phoenix_admin_provision_profile.
  if v_trole = 'pending_provisioning' then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'target_pending_provisioning', p_correlation_id);
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
$function$;

CREATE OR REPLACE FUNCTION public.assign_profile_permissions(p_profile_id uuid, p_permissions jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  select role, organization_id into v_role, v_org from public.profiles where id = v_actor;
  -- AUTH-1 (219-HC1): authentication alone is not authority. A caller with no
  -- profiles row is denied before any authority decision reads role or org.
  if not found then return jsonb_build_object('ok', false, 'error', 'ACTOR_PROFILE_NOT_FOUND'); end if;
  select organization_id into v_target_org from public.profiles where id = p_profile_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND'); end if;

  -- authority: super_admin, or holds users.manage_permissions within same org
  if v_role is distinct from 'super_admin' then
    if coalesce(phoenix_profile_has_permission(v_actor, 'users.manage_permissions'), false) is not true then
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

  -- AUTH-1 (219-HC1): the pending_provisioning sentinel holds no authority, so
  -- no permission override is ever written for it, whoever the actor is.
  if exists (select 1 from public.profiles where id = p_profile_id and role = 'pending_provisioning') then
    return jsonb_build_object('ok', false, 'error', 'TARGET_PENDING_PROVISIONING');
  end if;

  for v_key, v_val in select * from jsonb_each(p_permissions) loop
    -- unknown key
    if not exists (select 1 from public.permission_keys where key = v_key) then
      v_rejected := v_rejected || jsonb_build_object('key', v_key, 'error', 'UNKNOWN_PERMISSION');
      continue;
    end if;

    if jsonb_typeof(v_val) = 'null' then
      v_bool := null;
    else
      v_bool := v_val::text::boolean;
    end if;

    -- granting requires the actor to hold the permission (dangerous included)
    if v_bool is true and v_role is distinct from 'super_admin' then
      if coalesce(phoenix_profile_has_permission(v_actor, v_key), false) is not true then
        select is_dangerous into v_dangerous from public.permission_keys where key = v_key;
        v_rejected := v_rejected || jsonb_build_object(
          'key', v_key,
          'error', case when v_dangerous then 'NEEDS_AUTHORITY_FOR_DANGEROUS' else 'CANNOT_GRANT_UNHELD' end
        );
        continue;
      end if;
    end if;

    insert into public.profile_permission_overrides (profile_id, permission_key, allowed, created_by)
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
    insert into public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
      values (v_target_org, v_actor, v_role, 'permissions_assigned', 'profile', p_profile_id,
              jsonb_build_object('applied', v_applied, 'rejected', v_rejected));
  exception when others then
    v_audit_logged := false;
    raise warning 'assign_profile_permissions: audit_logs insert failed (permissions were still saved): %', sqlerrm;
  end;

  return jsonb_build_object('ok', true, 'applied', v_applied, 'rejected', v_rejected, 'audit_logged', v_audit_logged);
end;
$function$;

CREATE OR REPLACE FUNCTION public.reset_profile_permissions(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  select role, organization_id into v_role, v_org from public.profiles where id = v_actor;
  -- AUTH-1 (219-HC1): authentication alone is not authority. A caller with no
  -- profiles row is denied before any authority decision reads role or org.
  if not found then return jsonb_build_object('ok', false, 'error', 'ACTOR_PROFILE_NOT_FOUND'); end if;
  select organization_id into v_target_org from public.profiles where id = p_profile_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND'); end if;

  if v_role is distinct from 'super_admin' then
    if coalesce(phoenix_profile_has_permission(v_actor, 'users.manage_permissions'), false) is not true then
      return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_PERMISSION');
    end if;
    if v_target_org is distinct from v_org then
      return jsonb_build_object('ok', false, 'error', 'OUT_OF_SCOPE');
    end if;
  end if;

  delete from public.profile_permission_overrides where profile_id = p_profile_id;
  get diagnostics v_count = row_count;

  -- Same audit-logging safety as assign_profile_permissions above — never
  -- roll back a successful reset because of an audit_logs write failure.
  begin
    insert into public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
      values (v_target_org, v_actor, v_role, 'permissions_reset', 'profile', p_profile_id,
              jsonb_build_object('cleared', v_count));
  exception when others then
    v_audit_logged := false;
    raise warning 'reset_profile_permissions: audit_logs insert failed (reset was still applied): %', sqlerrm;
  end;

  return jsonb_build_object('ok', true, 'cleared', v_count, 'audit_logged', v_audit_logged);
end;
$function$;

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
  -- HC1 (5a/5b): each fenced routine (the four HC1 routines) is exactly its
  -- reviewed HC1 body — the pinned predecessor plus only its HC1 edits: the
  -- sentinel-target fence (assign_profile_role, phoenix_recycle_apply,
  -- assign_profile_permissions), the profile-less actor denial and the NULL-safe
  -- gates — and keeps every property it had. Their requested-role allowlists
  -- are unchanged, so the sentinel is named in them only as a refused TARGET.
  IF (SELECT string_agg(p.proname || ':' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex'), ';' ORDER BY p.proname)
        FROM pg_catalog.pg_proc p
       WHERE p.oid IN (pg_catalog.to_regprocedure('public.assign_profile_role(uuid,text)'),
                       pg_catalog.to_regprocedure('public.phoenix_recycle_apply(uuid,text,text,uuid,text,text,text,text,integer,uuid)'),
                       pg_catalog.to_regprocedure('public.assign_profile_permissions(uuid,jsonb)'),
                       pg_catalog.to_regprocedure('public.reset_profile_permissions(uuid)')))
     IS DISTINCT FROM 'assign_profile_permissions:96f4d9713c47d5291883fea8133c1028d45ceceb70adf6120157cf14559126a4;'
                   || 'assign_profile_role:27f0dfa0bcc85a2e160578b4e82a7fd64bb457c7792999aace30a43f40208e23;'
                   || 'phoenix_recycle_apply:c99d2e59d1209097ddbb3baa45746df36ccd2469089e835920e5f7f972adb277;'
                   || 'reset_profile_permissions:eefab1082f222a81e05c68517eaebc9157c9f2da3f21d1e9515b0799247b323c' THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): a fenced routine is not its reviewed HC1 body';
  END IF;
  IF (SELECT string_agg(concat_ws('|', p.oid::regprocedure::text, p.proowner::regrole::text,
             p.prosecdef, p.proconfig::text, p.proacl::text, p.prorettype::regtype::text, p.provolatile, p.prolang), ';' ORDER BY p.proname)
        FROM pg_catalog.pg_proc p
       WHERE p.oid IN (pg_catalog.to_regprocedure('public.assign_profile_role(uuid,text)'),
                       pg_catalog.to_regprocedure('public.phoenix_recycle_apply(uuid,text,text,uuid,text,text,text,text,integer,uuid)'),
                       pg_catalog.to_regprocedure('public.assign_profile_permissions(uuid,jsonb)'),
                       pg_catalog.to_regprocedure('public.reset_profile_permissions(uuid)')))
     IS DISTINCT FROM current_setting('phoenix_m219.hc1_meta', true) THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): identity, owner, security, configuration, grants, language, volatility or return type of a fenced routine changed';
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
  IF has_function_privilege('anon', 'public.get_effective_permissions(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.assign_profile_role(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.phoenix_recycle_apply(uuid,text,text,uuid,text,text,text,text,integer,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.assign_profile_permissions(uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reset_profile_permissions(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): anon can execute a replaced authority routine';
  END IF;

  -- The trigger binding is unchanged.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'on_auth_user_created'
                    AND t.tgfoid = pg_catalog.to_regprocedure('public.phoenix_handle_new_user()')
                    AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgtype = 5) THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): on_auth_user_created binding changed';
  END IF;

  -- get_effective_permissions: exactly the three 3b edits; every property kept.
  IF (SELECT concat_ws('|', p.proowner::regrole::text, p.prosecdef, p.proconfig::text, p.proacl::text,
             p.prorettype::regtype::text, p.provolatile, p.prolang, pg_catalog.pg_get_function_identity_arguments(p.oid))
        FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.get_effective_permissions(uuid)'))
     IS DISTINCT FROM current_setting('phoenix_m219.gep_meta', true) THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): get_effective_permissions identity, owner, security, configuration, grants, language, volatility or return type changed';
  END IF;
  IF (SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.get_effective_permissions(uuid)'))
       IS DISTINCT FROM replace(replace(replace(current_setting('phoenix_m219.gep_src', true),
                                'into v_role,v_org from public.profiles where id=v_actor;',
                                'into v_role,v_org from public.profiles where id=v_actor; if not found then return jsonb_build_object(''ok'',false,''error'',''ACTOR_PROFILE_NOT_FOUND''); end if;'),
                                'v_role<>''super_admin'' and p_profile_id<>v_actor', 'v_role is distinct from ''super_admin'' and p_profile_id<>v_actor'),
                                'v_target_org is distinct from v_org', 'not coalesce(v_target_org = v_org, false)')
     OR (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
           FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.get_effective_permissions(uuid)'))
       IS DISTINCT FROM '518141abbc8b9022a7cf0f76a721fdfab1192c07f5d496f2b667c9fb7d6254b0'
     OR (SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.get_effective_permissions(uuid)')) ~ 'is distinct from v_org' THEN
    RAISE EXCEPTION 'VERIFY FAILED (219): get_effective_permissions is not the M196 body with only the NULL-organization scope predicate and the profile-less actor denial';
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
