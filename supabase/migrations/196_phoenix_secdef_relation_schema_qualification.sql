-- ============================================================================
-- STAGE-I-I3 / M196 — SECURITY DEFINER RELATION SCHEMA QUALIFICATION
--
-- Applies after M195. Compatible with the pinned I-2 Production executor:
-- one exact migration, one exact hash, one exact ceiling.
--
-- Exactly 22 first-party SECURITY DEFINER functions still resolve 106 relation
-- references through search_path. Their present search_path settings prevent a
-- demonstrated exploit, but the bodies still depend on those settings remaining
-- present and correct. M196 changes only those 106 tokens to public.<relation>.
--
-- No ACL, owner, RLS, policy, signature, return type, volatility, strictness,
-- parallel-safety, leakproof, language or search_path convergence is authorized.
-- The five search_path=public functions remain so; the other seventeen retain
-- public,pg_temp. PUBLIC EXECUTE belongs to I-4; search_path convergence to I-5.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _m196_targets (
  proname text PRIMARY KEY,
  expected_definition_sha256 text NOT NULL,
  expected_before_body_sha256 text NOT NULL,
  expected_after_body_sha256 text NOT NULL,
  expected_acl text NOT NULL,
  expected_cfg text NOT NULL,
  expected_token_count integer NOT NULL
) ON COMMIT DROP;

INSERT INTO _m196_targets VALUES
  ('archive_entity', 'e0de9642227a3f6a7b1dd2aec78112a45a72b72482525f228f59f47d6b81a675', '671b7d437ab036a73cec7f98dc33f74933a9b3ed1eef04b8e113c3cd822fefe2', 'eed7ad60346aa517d91fe2c9e46a8384bebcfa29ef39b1dd6c68140761a22fb2', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public', 4),
  ('assign_profile_permissions', '58fc49d11f5f8aaddaed76a580b52a4dc8a354841a5a46cbec97a0c4087f3594', '62593dc55c1beee446f667d41fb169a06de441498a4b79291a81466fd1ebbb36', '9a1966eb2bb94ddf3e105e8ca4f9a26e667262ad065a1ca22fc1450c99c6caad', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public, pg_temp', 6),
  ('assign_profile_role', '7fb93f8d46f547676b73e8c5c68c0d466fd321134491a056bb100abdfcfa760d', '539aa64934ada27785eade917726074afb16525fc2f5db302012d7b19712392c', 'eab65fc2c7b09be4655dd5ac07dad08abfeacd34264dfbf378f4f2c20f4179d4', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public, pg_temp', 4),
  ('clear_port_availability', '77c56972a97ca6504c53f69fbcecbac3311cbf9dfadbf8a008ecf1a490c969c4', '92e306358921298d2babe0eed4247afb9793c2d80ca6fbd3bb9bacac05f4b87b', '24106ec1c8abb3a4be5c2ffc3497953d73c087380418012f97622910c5c09c77', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public, pg_temp', 7),
  ('create_qr_for_target', '97e46de6bad0c2b9a8b04e38985b6b93622b2407e3bfab76f79ef805924f09ca', '19edf735465dcef1aa279cbc2b48d63c4392777e535f06f841ea9296d84dc4dc', '1fbe9b42623e0a1efedc05eddc0525d43439e9b801c46b82d74409d832a81cab', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public', 11),
  ('disable_qr_token', '3a0fdcd393bf49562a626daf05d330de56e7fc6a047af3fd46211c352069333c', 'ff74e6bb9237e6b0defa81b5528b31e06561fdb9bf55e50d832131f2499daf05', 'dd80b87c065b658bfefe6420ad7bd6b6faace1dd171d54d613d75a1500049bb0', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public', 3),
  ('get_effective_permissions', 'aaf22607a582088043065f3d7d6b7650815e6dad9f7e200542afd73a2df3d0b9', 'c7c67a94feaef3e8dd7efe8b86db32e93ab949418f18dafc90bc91a3936f3406', '2b3bbd879c22b8ea578532dee65ee7922163cbe925c2ae2093bfa48b3bacff96', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public, pg_temp', 3),
  ('get_entity_purge_impact', 'dc5c2918ae3660c044525e544397964e2906d3b81f8d2fd140d9174284c6d9f0', '93b013ce2f38eabb6f784e82d6c64f70e77f57c03d2472610e78680690bd3968', '81b4aea779f3c5e1bbd172751c5fc45375541b0bd9408ce816454c6716a8e86e', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public', 18),
  ('get_scoped_inter_institution_alerts', '22f7fdfb93541b69baf27f032b6459fb854bc952ae838fbd8029807484051e6e', '438e973cda4abf7cb505a82f2c10c2fe183aa26b4dce2a580b98876789638c0b', '45394ba8b24733ed227a14ba13b4de602a81d1c6843a95f8093492fc24d82279', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public, pg_temp', 6),
  ('phoenix_admin_assign_facility_scopes', 'b8b0234510b60ee12fc840a2ce7728598cf1b26c14255b399c2ed8935135765b', 'bfb6ce585a7e6759a88b6ded5faf8a196bf1564f17f16f39fadbe21be93241b5', '8f4fc3ce4de56dac190ff64c83ab88afce3cfe21389d8c57d5bbefaac47e52bb', '{postgres=X/postgres,service_role=X/postgres}', 'search_path=public, pg_temp', 1),
  ('phoenix_assign_profile_scope', 'd292a218d4b92739101ace820928138c607126500e4f16bb528628a3b3377014', '4dc5e5605ea5aa44cabbae8d164fc4b42f29306c0e6124da1e9e95b3538c771f', '5f51621e7135498afa02e84973d7f7f545edf009a1f87f9b469a8ef9eb0aabc6', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public, pg_temp', 1),
  ('phoenix_create_supply_route', 'bb3f2eab4535aa6ff8afef9e74fa5dac10b507554d55dddec120a915f1cc2cfb', '85a88c099b70a34e64eedc5bebaa492b52aea6dfa124be526181fe4fbaec28f9', '1967f891a49ab0c2f3e27617e46685242ee84beec44ef88c2ecfdcfdc5979677', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public, pg_temp', 1),
  ('phoenix_create_warehouse', '675cdf5bdc4ab34009f0de68d5a82e3cb101250f9d14d6731c12b96e9c2b62e0', '3a203ccb4fa35c047e795a3e950f58323b9ef104d1281f4cea6c95b8b6e09082', 'c75094e77796fbc57de8ae556c57887b114e8593350b381efc4dc69f2a6d6525', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public, pg_temp', 1),
  ('phoenix_mark_password_changed', '0f14f85232e10539011be71f50ff8ebdb3302c2e64867a174192677f00773174', '35ca44270346fc6b5673a6571c626ed899ee6092596ddf45a0e7d771984a9e9f', '0a07672d1093c80f1c3c6b971c80d2b999b6d80dba1618c1013aa43d801f95e1', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public, pg_temp', 1),
  ('phoenix_profile_has_permission', '4a83652049373ff9ad9d118b1854637d72953ddc2507201d8eb76cf7d978bf45', '7fb2f8b311ab181b0189fb3ec6e13f2b068bc3ec588343a56be8c4df672f5188', '76ed65758ed5bdc389086f090b6907df85255852acff47968369111df1287f42', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public, pg_temp', 3),
  ('phoenix_revoke_profile_scope', '9028a7dca85da049c51e2a962cee1d0ac2ad97f48f30bc57db1da742d2d5d9b8', 'a2ba22b4bf66935cd50feb37cd627aa32f8d7cdb91fa0899bfc78bf4a80ff979', '68797a45601ed6405c6a07d0dd885b185588bf19e52afa6d8df7076e04662666', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public, pg_temp', 1),
  ('phoenix_set_supply_route_active', '87824343d3e091fa285e2702fb05f1302a888ea251d6d554bc2aba947939d601', '7713ce7adad8cba19c887ca003344dc1652cc55b74b1801cc73ce50d04150337', '66ff526db92169b4aea6e039ffcad4992976dc23121485590655c116e4c7fe5a', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public, pg_temp', 1),
  ('phoenix_set_warehouse_active', '4166790259e16a149eefdbee7a7eac0e3fcf2ce864887478790617c138a83602', 'f5f183392d2d7b49414be5667f7c605ec64e7dc49f12852b188289e369003c35', '6267a6b2d44c73b6d96410ec55c251c4c52143d1e7617e3d136a579b1b20db30', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public, pg_temp', 1),
  ('phoenix_update_supply_route', '36da4ce566a7f3a6010bdf041b403da3f2c223db8f10a55645464bc9919e4015', '7ad3897a76bdc861bd1d26efd9a1a0696e5ad60ba12c0529c7a4293379e0bad9', 'eaa63b1261d75c2af7d9d48d079c046feeb71072516152df37a546060a2c462d', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public, pg_temp', 1),
  ('phoenix_update_warehouse', 'b97ad58d8aeb7b96c612b575d723f99f3be581e3df38aee3a600ddbffbc4c25e', 'c4bc135efa34933035373e459cfa79bd40a189e07c146cee196bcb3b444e9cc5', 'dfb3d264469bc83222b9deacd52997a1e1eda7a02d9d6cf95f9652868782741a', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public, pg_temp', 2),
  ('purge_entity_with_all_data', '29c1700c1c8cb866066facfcc47d6da4536950cdcfc2b5ca5deb76fa62e3de43', '014d68c684f68b6ee426259c59b3088a0d7f9aa274a31d56715178adb6dc1350', '24cb92c70131aaa6e5c0b527d66851f1813c4b3c976aa8c84c90c2d3841c361f', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public', 26),
  ('reset_profile_permissions', 'c75ed6ce2b15c6e6c0bbc678aec7dbb27eb74becb0f8a535e0cb3198d5b04fbe', 'c17c833a5be33bcd9b0a0d1d3952edc4f879c35c2ed1006fc575e1d973dc8489', '03e9b611be1291e51270d7cc03a60bfe7c2e9418a96b3e3de4595064249f176a', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}', 'search_path=public, pg_temp', 4);

CREATE TEMP TABLE _m196_before ON COMMIT DROP AS
SELECT p.oid,
       p.proname::text AS proname,
       p.oid::regprocedure::text AS signature,
       pg_get_function_identity_arguments(p.oid) AS ident_args,
       p.pronargs,
       p.prokind,
       l.lanname::text AS language,
       pg_get_function_result(p.oid) AS result_type,
       p.provolatile,
       p.prosecdef,
       p.proisstrict,
       p.proparallel,
       p.proleakproof,
       COALESCE(array_to_string(p.proconfig, ','), '') AS cfg,
       pg_get_userbyid(p.proowner)::text AS owner,
       COALESCE(p.proacl::text, '') AS acl,
       replace(pg_get_functiondef(p.oid), chr(13) || chr(10), chr(10)) AS definition_lf,
       replace(p.prosrc, chr(13) || chr(10), chr(10)) AS body_lf,
       encode(extensions.digest(replace(pg_get_functiondef(p.oid), chr(13) || chr(10), chr(10)), 'sha256'), 'hex') AS definition_sha256,
       encode(extensions.digest(replace(p.prosrc, chr(13) || chr(10), chr(10)), 'sha256'), 'hex') AS body_sha256
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
JOIN _m196_targets t ON t.proname = p.proname
WHERE n.nspname = 'public';

DO $m196_pre$
DECLARE
  v_count integer;
  r record;
BEGIN
  SELECT count(*) INTO v_count FROM _m196_before;
  IF v_count <> 22 THEN
    RAISE EXCEPTION 'M196 PRECONDITION: expected exactly 22 target functions, found %', v_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM _m196_targets t
    LEFT JOIN _m196_before b USING (proname)
    WHERE b.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'M196 PRECONDITION: one or more exact target functions are missing';
  END IF;

  FOR r IN
    SELECT t.*, b.signature, b.definition_sha256, b.body_sha256,
           b.prokind, b.prosecdef, b.proisstrict, b.proparallel,
           b.proleakproof, b.cfg, b.owner, b.acl
    FROM _m196_targets t JOIN _m196_before b USING (proname)
  LOOP
    IF r.definition_sha256 <> r.expected_definition_sha256 THEN
      RAISE EXCEPTION 'M196 PRECONDITION: % definition drifted. expected %, found %',
        r.proname, r.expected_definition_sha256, r.definition_sha256;
    END IF;
    IF r.body_sha256 <> r.expected_before_body_sha256 THEN
      RAISE EXCEPTION 'M196 PRECONDITION: % body drifted. expected %, found %',
        r.proname, r.expected_before_body_sha256, r.body_sha256;
    END IF;
    IF r.prokind <> 'f' OR NOT r.prosecdef OR r.proisstrict
       OR r.proparallel <> 'u' OR r.proleakproof THEN
      RAISE EXCEPTION 'M196 PRECONDITION: % function security attributes drifted', r.proname;
    END IF;
    IF r.owner <> 'postgres' THEN
      RAISE EXCEPTION 'M196 PRECONDITION: % owner must remain postgres, found %', r.proname, r.owner;
    END IF;
    IF r.cfg <> r.expected_cfg THEN
      RAISE EXCEPTION 'M196 PRECONDITION: % search_path drifted. expected %, found %',
        r.proname, r.expected_cfg, r.cfg;
    END IF;
    IF r.acl <> r.expected_acl THEN
      RAISE EXCEPTION 'M196 PRECONDITION: % ACL drifted. expected %, found %',
        r.proname, r.expected_acl, r.acl;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM _m196_before WHERE cfg = 'search_path=public') <> 5
     OR (SELECT count(*) FROM _m196_before WHERE cfg = 'search_path=public, pg_temp') <> 17 THEN
    RAISE EXCEPTION 'M196 PRECONDITION: expected search_path split 5 public-only / 17 public,pg_temp';
  END IF;

  IF has_function_privilege(
       'authenticated',
       'public.phoenix_admin_assign_facility_scopes(uuid,uuid,uuid[])',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'M196 PRECONDITION: facility-scope function unexpectedly executable by authenticated';
  END IF;

  IF (SELECT sum(expected_token_count) FROM _m196_targets) <> 106 THEN
    RAISE EXCEPTION 'M196 PRECONDITION: reviewed token total is not 106';
  END IF;

  RAISE NOTICE 'M196: exact 22-function, 106-token reviewed pre-state confirmed.';
END
$m196_pre$;

-- M196_REPLACEMENTS_BEGIN
CREATE OR REPLACE FUNCTION public.archive_entity(p_entity_type text, p_entity_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role    text;
  v_org_id  uuid;
  v_allowed text[] := array['warehouse', 'distribution_point', 'local_item'];
  v_rows    int;
BEGIN
  v_role   := phoenix_my_role();
  v_org_id := phoenix_my_org();

  IF p_entity_type != ALL(v_allowed) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ENTITY_TYPE_NOT_ALLOWLISTED');
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED');
  END IF;

  -- Authorization: per-entity-type permission check
  CASE p_entity_type
    WHEN 'distribution_point' THEN
      -- Permission-based: requires ports.archive
      IF v_role <> 'super_admin'
         AND NOT phoenix_profile_has_permission(auth.uid(), 'ports.archive') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_PERMISSION');
      END IF;
    ELSE
      -- Warehouse / local_item: keep original role-based check
      IF v_role NOT IN ('super_admin', 'hospital_admin') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
      END IF;
  END CASE;

  CASE p_entity_type
    WHEN 'warehouse' THEN
      UPDATE public.warehouses
      SET status = 'archived', archived_at = now(), archived_by = auth.uid(), archive_reason = p_reason
      WHERE id = p_entity_id
        AND (v_role = 'super_admin' OR organization_id = v_org_id)
        AND archived_at IS NULL;
      GET DIAGNOSTICS v_rows = ROW_COUNT;

    WHEN 'distribution_point' THEN
      PERFORM set_config('phoenix.archive_bypass', 'true', true);
      UPDATE public.distribution_points
      SET status = 'archived', archived_at = now(), archived_by = auth.uid(), archive_reason = p_reason
      WHERE id = p_entity_id
        AND (v_role = 'super_admin' OR organization_id = v_org_id)
        AND archived_at IS NULL;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      PERFORM set_config('phoenix.archive_bypass', '', true);

    WHEN 'local_item' THEN
      UPDATE public.local_items
      SET status = 'archived', archived_at = now(), archived_by = auth.uid(), archive_reason = p_reason
      WHERE id = p_entity_id
        AND (v_role = 'super_admin' OR organization_id = v_org_id)
        AND archived_at IS NULL;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
  END CASE;

  IF v_rows = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND_OR_ALREADY_ARCHIVED');
  END IF;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
  VALUES (v_org_id, auth.uid(), v_role, 'archived', p_entity_type, p_entity_id,
          jsonb_build_object('reason', p_reason));

  RETURN jsonb_build_object('ok', true, 'archived', true);
END;
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
  select organization_id into v_target_org from public.profiles where id = p_profile_id;
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
    if v_bool is true and v_role <> 'super_admin' then
      if not phoenix_profile_has_permission(v_actor, v_key) then
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

CREATE OR REPLACE FUNCTION public.clear_port_availability(p_point_id uuid, p_confirmation text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor_id     uuid;
  v_role         text;
  v_org_id       uuid;
  v_point_org    uuid;
  v_total_count  int;
  v_with_history int;
  v_required     text;
BEGIN
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  SELECT role, organization_id INTO v_role, v_org_id
  FROM public.profiles WHERE id = v_actor_id;

  IF v_role NOT IN ('super_admin', 'hospital_admin', 'warehouse_manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  END IF;

  SELECT organization_id INTO v_point_org
  FROM public.distribution_points WHERE id = p_point_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'POINT_NOT_FOUND');
  END IF;

  IF v_role != 'super_admin' AND v_point_org != v_org_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN_ORG');
  END IF;

  v_required := 'CLEAR_PORT_ITEMS_' || p_point_id::text;
  IF p_confirmation IS DISTINCT FROM v_required THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'CONFIRMATION_MISMATCH',
      'required', v_required
    );
  END IF;

  -- Counts are for the response/audit payload only — both groups below are
  -- handled identically (UPDATE, never DELETE). See the migration header for
  -- why "no movement history" does not imply "safe to hard-delete".
  SELECT count(*) INTO v_total_count
  FROM public.item_availability WHERE distribution_point_id = p_point_id;

  SELECT count(*) INTO v_with_history
  FROM public.item_availability ia
  WHERE ia.distribution_point_id = p_point_id
    AND EXISTS (
      SELECT 1 FROM public.item_availability_movements m
      WHERE m.item_availability_id = ia.id
    );

  -- QR-REMOVED-MARKER-053-A: every row this UPDATE actually touches (the
  -- idempotency guard below is unchanged from migration 042 — a row already
  -- at quantity=0/condition='missing' is left alone, so a repeat call never
  -- re-marks or re-timestamps an already-cleared row) is now also marked
  -- removed, giving bulk-cleared rows the same removal signal the single-item
  -- "remove from outlet" flow gets.
  UPDATE public.item_availability
     SET quantity        = 0,
         condition        = 'missing',
         removed_at       = now(),
         removed_by       = v_actor_id,
         removal_reason   = 'clear_port_availability',
         last_updated_by  = v_actor_id
   WHERE distribution_point_id = p_point_id
     AND (quantity <> 0 OR condition IS DISTINCT FROM 'missing');

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action,
    entity_type, entity_id, payload
  ) VALUES (
    v_point_org, v_actor_id, v_role, 'port_items_cleared',
    'distribution_point', p_point_id,
    jsonb_build_object(
      'items_cleared', v_total_count,
      'items_with_movement_history', v_with_history,
      'mode', 'zeroed_not_deleted'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'cleared', v_total_count,
    'items_with_movement_history', v_with_history,
    'mode', 'zeroed_not_deleted'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_qr_for_target(p_target_type text, p_target_id uuid, p_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role          text;
  v_org_id        uuid;
  v_target_id     uuid;
  v_token_id      uuid;
  v_public_id     text;
  v_plain_token   text;
  v_token_hash    text;
  v_allowed_types text[] := ARRAY['warehouse', 'distribution_point', 'local_item'];
BEGIN
  v_role   := phoenix_my_role();
  v_org_id := phoenix_my_org();

  -- Permission-based: super_admin always allowed; others need qr.generate
  IF v_role <> 'super_admin'
     AND NOT phoenix_profile_has_permission(auth.uid(), 'qr.generate') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_PERMISSION');
  END IF;

  -- enforce allowlist
  IF p_target_type != ALL(v_allowed_types) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'TARGET_TYPE_NOT_ALLOWLISTED',
      'allowed', v_allowed_types
    );
  END IF;

  -- verify target belongs to caller's org (or caller is super_admin)
  CASE p_target_type
    WHEN 'warehouse' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.warehouses
        WHERE id = p_target_id
          AND (v_role = 'super_admin' OR organization_id = v_org_id)
      ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND_OR_FORBIDDEN');
      END IF;
      SELECT organization_id INTO v_org_id FROM public.warehouses WHERE id = p_target_id;

    WHEN 'distribution_point' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.distribution_points
        WHERE id = p_target_id
          AND (v_role = 'super_admin' OR organization_id = v_org_id)
      ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND_OR_FORBIDDEN');
      END IF;
      SELECT organization_id INTO v_org_id FROM public.distribution_points WHERE id = p_target_id;

    WHEN 'local_item' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.local_items
        WHERE id = p_target_id
          AND (v_role = 'super_admin' OR organization_id = v_org_id)
      ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND_OR_FORBIDDEN');
      END IF;
      SELECT organization_id INTO v_org_id FROM public.local_items WHERE id = p_target_id;
  END CASE;

  -- idempotent: return existing active token if present
  SELECT qt.id, qt.public_id INTO v_token_id, v_public_id
  FROM public.qr_tokens qt
  JOIN public.qr_targets qtr ON qtr.id = qt.qr_target_id
  WHERE qtr.target_type = p_target_type::qr_target_type
    AND qtr.target_id = p_target_id
    AND qt.status = 'active'
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok',        true,
      'created',   false,
      'token_id',  v_token_id,
      'public_id', v_public_id
    );
  END IF;

  -- upsert qr_target
  INSERT INTO public.qr_targets (organization_id, target_type, target_id, label)
  VALUES (v_org_id, p_target_type::qr_target_type, p_target_id, p_label)
  ON CONFLICT (target_type, target_id) DO UPDATE SET label = EXCLUDED.label
  RETURNING id INTO v_target_id;

  -- FIX (026): fully qualify pgcrypto calls — gen_random_bytes and digest live in
  -- the `extensions` schema in Supabase; SET search_path = public makes them
  -- invisible without the schema prefix, causing 42883.
  v_plain_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash  := encode(extensions.digest(v_plain_token, 'sha256'), 'hex');
  v_public_id   := encode(extensions.gen_random_bytes(12), 'hex');

  INSERT INTO public.qr_tokens (qr_target_id, organization_id, public_id, token_hash, created_by)
  VALUES (v_target_id, v_org_id, v_public_id, v_token_hash, auth.uid())
  RETURNING id INTO v_token_id;

  -- audit
  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label)
  VALUES (v_org_id, auth.uid(), v_role, 'qr_created', p_target_type, p_target_id, p_label);

  RETURN jsonb_build_object(
    'ok',        true,
    'created',   true,
    'token_id',  v_token_id,
    'public_id', v_public_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.disable_qr_token(p_token_id uuid, p_reason text DEFAULT 'manual_disable'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role   text;
  v_org_id uuid;
  v_token  qr_tokens%ROWTYPE;
BEGIN
  v_role   := phoenix_my_role();
  v_org_id := phoenix_my_org();

  -- Permission-based: super_admin always allowed; others need qr.revoke
  IF v_role <> 'super_admin'
     AND NOT phoenix_profile_has_permission(auth.uid(), 'qr.revoke') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_PERMISSION');
  END IF;

  SELECT * INTO v_token FROM public.qr_tokens WHERE id = p_token_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'TOKEN_NOT_FOUND');
  END IF;

  IF v_role <> 'super_admin' AND v_token.organization_id <> v_org_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN_ORG');
  END IF;

  IF v_token.status = 'disabled' THEN
    RETURN jsonb_build_object('ok', true, 'already_disabled', true);
  END IF;

  UPDATE public.qr_tokens
  SET status         = 'disabled',
      disabled_at    = now(),
      disabled_by    = auth.uid(),
      disable_reason = p_reason
  WHERE id = p_token_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id)
  VALUES (v_token.organization_id, auth.uid(), v_role, 'qr_disabled', 'qr_token', p_token_id);

  RETURN jsonb_build_object('ok', true, 'disabled', true);
END;
$function$;

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
 if v_role<>'super_admin' and p_profile_id<>v_actor and v_target_org is distinct from v_org then return jsonb_build_object('ok',false,'error','OUT_OF_SCOPE'); end if;
 if v_role='health_center_manager' and p_profile_id<>v_actor then return jsonb_build_object('ok',false,'error','OUT_OF_SCOPE'); end if;
 select coalesce(jsonb_object_agg(k.key,phoenix_profile_has_permission(p_profile_id,k.key)),'{}'::jsonb) into v_result from public.permission_keys k;
 return jsonb_build_object('ok',true,'permissions',v_result);
end;$function$;

CREATE OR REPLACE FUNCTION public.get_entity_purge_impact(p_entity_type text, p_entity_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role    text;
  v_org_id  uuid;
  v_allowed text[] := array['warehouse', 'distribution_point', 'local_item'];
  v_impact  jsonb;
begin
  v_role   := phoenix_my_role();
  v_org_id := phoenix_my_org();

  if v_role not in ('super_admin', 'hospital_admin') then
    return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  end if;

  if p_entity_type != all(v_allowed) then
    return jsonb_build_object('ok', false, 'error', 'ENTITY_TYPE_NOT_ALLOWLISTED');
  end if;

  case p_entity_type
    when 'warehouse' then
      -- guard: must exist and belong to caller's org
      if not exists (
        select 1 from public.warehouses
        where id = p_entity_id
          and (v_role = 'super_admin' or organization_id = v_org_id)
      ) then
        return jsonb_build_object('ok', false, 'error', 'NOT_FOUND_OR_FORBIDDEN');
      end if;

      select jsonb_build_object(
        'ok',                   true,
        'entity_type',          'warehouse',
        'entity_id',            p_entity_id,
        'distribution_points',  (select count(*) from public.distribution_points where warehouse_id = p_entity_id),
        'item_availability',    (
          select count(*) from public.item_availability ia
          join public.distribution_points dp on dp.id = ia.distribution_point_id
          where dp.warehouse_id = p_entity_id
        ),
        'qr_tokens',            (
          select count(*) from public.qr_tokens qt
          join public.qr_targets qtr on qtr.id = qt.qr_target_id
          where (qtr.target_type = 'warehouse' and qtr.target_id = p_entity_id)
             or (qtr.target_type = 'distribution_point' and qtr.target_id in (
               select id from public.distribution_points where warehouse_id = p_entity_id
             ))
        ),
        'audit_logs',           (select count(*) from public.audit_logs where entity_id = p_entity_id)
      ) into v_impact;

    when 'distribution_point' then
      if not exists (
        select 1 from public.distribution_points
        where id = p_entity_id
          and (v_role = 'super_admin' or organization_id = v_org_id)
      ) then
        return jsonb_build_object('ok', false, 'error', 'NOT_FOUND_OR_FORBIDDEN');
      end if;

      select jsonb_build_object(
        'ok',                true,
        'entity_type',       'distribution_point',
        'entity_id',         p_entity_id,
        'item_availability', (select count(*) from public.item_availability where distribution_point_id = p_entity_id),
        'qr_tokens',         (
          select count(*) from public.qr_tokens qt
          join public.qr_targets qtr on qtr.id = qt.qr_target_id
          where qtr.target_type = 'distribution_point' and qtr.target_id = p_entity_id
        ),
        'audit_logs',        (select count(*) from public.audit_logs where entity_id = p_entity_id)
      ) into v_impact;

    when 'local_item' then
      if not exists (
        select 1 from public.local_items
        where id = p_entity_id
          and (v_role = 'super_admin' or organization_id = v_org_id)
      ) then
        return jsonb_build_object('ok', false, 'error', 'NOT_FOUND_OR_FORBIDDEN');
      end if;

      select jsonb_build_object(
        'ok',                true,
        'entity_type',       'local_item',
        'entity_id',         p_entity_id,
        'item_availability', (select count(*) from public.item_availability where local_item_id = p_entity_id),
        'qr_tokens',         (
          select count(*) from public.qr_tokens qt
          join public.qr_targets qtr on qtr.id = qt.qr_target_id
          where qtr.target_type = 'local_item' and qtr.target_id = p_entity_id
        ),
        'audit_logs',        (select count(*) from public.audit_logs where entity_id = p_entity_id)
      ) into v_impact;
  end case;

  return v_impact;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_scoped_inter_institution_alerts()
 RETURNS TABLE(alert_id text, priority text, item_name text, item_name_ar text, source_organization_id uuid, source_organization_name text, source_organization_name_ar text, target_organization_id uuid, target_organization_name text, target_organization_name_ar text, source_status_type text, target_status_type text, source_quantity numeric, source_unit text, source_expiry_date date, target_quantity numeric, target_unit text, source_contact_name text, source_contact_phone text, target_contact_name text, target_contact_phone text, recommendation_kind text, manual_action_required boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_id   uuid;
  v_role       text;
  v_org_id     uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select role, organization_id into v_role, v_org_id
  from public.profiles where id = v_actor_id;

  if v_role is null then
    raise exception 'ACTOR_PROFILE_NOT_FOUND';
  end if;

  return query
  with active_reports as (
    select r.id, r.organization_id, r.item_id, r.item_name, r.item_name_ar,
           r.status_type, r.quantity, r.unit, r.expiry_date
    from public.institution_item_status_reports r
    where r.is_active = true
  ),
  sources as (
    select * from active_reports where status_type in ('surplus', 'near_expiry')
  ),
  targets as (
    select * from active_reports where status_type in ('scarce', 'missing')
  ),
  matched as (
    select
      s.id   as src_id,
      t.id   as tgt_id,
      s.organization_id as src_org,
      t.organization_id as tgt_org,
      s.status_type as src_status,
      t.status_type as tgt_status,
      coalesce(s.item_name, t.item_name)       as m_item_name,
      coalesce(s.item_name_ar, t.item_name_ar) as m_item_name_ar,
      s.quantity   as src_qty,
      s.unit       as src_unit,
      s.expiry_date as src_expiry,
      t.quantity   as tgt_qty,
      t.unit       as tgt_unit,
      case
        when s.status_type = 'near_expiry' and t.status_type = 'missing' then 'high'
        when s.status_type = 'surplus' and t.status_type = 'missing' and s.quantity is not null then 'high'
        when s.status_type = 'surplus' and t.status_type = 'scarce' then 'medium'
        when s.status_type = 'near_expiry' and t.status_type = 'scarce' then 'medium'
        when s.status_type = 'surplus' and t.status_type = 'missing' and s.quantity is null then 'low'
        else null
      end as m_priority
    from sources s
    join targets t
      on s.organization_id <> t.organization_id
     and (
          (s.item_id is not null and s.item_id = t.item_id)
       or (nullif(btrim(lower(s.item_name)), '') is not null
            and btrim(lower(s.item_name)) = btrim(lower(t.item_name)))
       or (nullif(btrim(lower(s.item_name_ar)), '') is not null
            and btrim(lower(s.item_name_ar)) = btrim(lower(t.item_name_ar)))
         )
  )
  select
    m.src_id || ':' || m.tgt_id                       as alert_id,
    m.m_priority                                       as priority,
    m.m_item_name                                      as item_name,
    m.m_item_name_ar                                   as item_name_ar,
    m.src_org                                          as source_organization_id,
    so.name                                            as source_organization_name,
    so.name_ar                                         as source_organization_name_ar,
    m.tgt_org                                          as target_organization_id,
    to_.name                                           as target_organization_name,
    to_.name_ar                                        as target_organization_name_ar,
    m.src_status                                       as source_status_type,
    m.tgt_status                                       as target_status_type,
    m.src_qty                                          as source_quantity,
    m.src_unit                                         as source_unit,
    m.src_expiry                                       as source_expiry_date,
    m.tgt_qty                                          as target_quantity,
    m.tgt_unit                                         as target_unit,
    sc.display_name                                    as source_contact_name,
    sc.phone                                           as source_contact_phone,
    tc.display_name                                    as target_contact_name,
    tc.phone                                           as target_contact_phone,
    case when m.src_status = 'near_expiry' then 'expiry_match' else 'surplus_match' end as recommendation_kind,
    true                                               as manual_action_required
  from matched m
  join public.organizations so on so.id = m.src_org
  join public.organizations to_ on to_.id = m.tgt_org
  left join lateral (
    select c.display_name, c.phone
    from public.organization_status_contacts c
    where c.organization_id = m.src_org and c.is_active = true
    order by c.is_primary desc, c.created_at asc
    limit 1
  ) sc on true
  left join lateral (
    select c.display_name, c.phone
    from public.organization_status_contacts c
    where c.organization_id = m.tgt_org and c.is_active = true
    order by c.is_primary desc, c.created_at asc
    limit 1
  ) tc on true
  where m.m_priority is not null
    and (
      v_role = 'super_admin'
      or m.src_org = v_org_id
      or m.tgt_org = v_org_id
    )
  order by
    case m.m_priority when 'high' then 3 when 'medium' then 2 else 1 end desc;
end;
$function$;

CREATE OR REPLACE FUNCTION public.phoenix_admin_assign_facility_scopes(p_actor_id uuid, p_profile_id uuid, p_facility_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor_role   text;
  v_actor_org    uuid;
  v_actor_status text;
  v_profile_org  uuid;
  v_profile_role text;
  v_org_kind     text;
  v_org_class    text;
  v_org_status   text;
  v_ids          uuid[];
  v_fid          uuid;
  v_facility     public.organization_facilities%ROWTYPE;
  v_created      uuid[] := ARRAY[]::uuid[];
  v_id           uuid;
BEGIN
  IF p_actor_id IS NULL OR p_profile_id IS NULL THEN
    RAISE EXCEPTION 'FACILITY_SCOPE_ARGUMENTS_REQUIRED' USING ERRCODE = '23514';
  END IF;

  -- De-duplicate and reject an empty set: a health_center_manager with no
  -- facility is unusable by design, and silently creating one hides the error.
  SELECT array_agg(DISTINCT x) INTO v_ids
  FROM unnest(coalesce(p_facility_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'FACILITY_SCOPE_SET_EMPTY: at least one health-center facility is required'
      USING ERRCODE = '23514';
  END IF;
  IF array_length(v_ids, 1) > 64 THEN
    RAISE EXCEPTION 'FACILITY_SCOPE_SET_TOO_LARGE: % facilities requested', array_length(v_ids, 1)
      USING ERRCODE = '23514';
  END IF;

  -- ACTOR — re-verified, never trusted from the caller's claim.
  SELECT p.role, p.organization_id, p.status
    INTO v_actor_role, v_actor_org, v_actor_status
  FROM public.profiles p WHERE p.id = p_actor_id;
  IF NOT FOUND OR v_actor_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'FACILITY_SCOPE_ACTOR_INELIGIBLE' USING ERRCODE = '42501';
  END IF;

  -- TARGET.
  SELECT p.organization_id, p.role INTO v_profile_org, v_profile_role
  FROM public.profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND OR v_profile_org IS NULL THEN
    RAISE EXCEPTION 'FACILITY_SCOPE_PROFILE_INELIGIBLE' USING ERRCODE = '23514';
  END IF;
  IF v_profile_role IS DISTINCT FROM 'health_center_manager' THEN
    RAISE EXCEPTION 'FACILITY_SCOPE_ROLE_INELIGIBLE: target role is %', v_profile_role USING ERRCODE = '23514';
  END IF;

  IF v_actor_role IS DISTINCT FROM 'super_admin' THEN
    IF v_actor_role IS DISTINCT FROM 'institution_admin' THEN
      RAISE EXCEPTION 'NOT_AUTHORIZED_FACILITY_SCOPE_ASSIGN' USING ERRCODE = '42501';
    END IF;
    IF v_actor_org IS DISTINCT FROM v_profile_org THEN
      RAISE EXCEPTION 'NOT_AUTHORIZED_FACILITY_SCOPE_CROSS_ORG' USING ERRCODE = '42501';
    END IF;
    IF NOT public.phoenix_profile_has_permission(p_actor_id, 'users.edit_scope') THEN
      RAISE EXCEPTION 'NOT_AUTHORIZED_FACILITY_SCOPE_ASSIGN: requires users.edit_scope' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT o.organization_kind, o.institution_class, o.status
    INTO v_org_kind, v_org_class, v_org_status
  FROM public.organizations o WHERE o.id = v_profile_org;
  IF v_org_status IS DISTINCT FROM 'active'
     OR v_org_kind IS DISTINCT FROM 'care_institution'
     OR v_org_class IS DISTINCT FROM 'health_sector' THEN
    RAISE EXCEPTION 'FACILITY_SCOPE_ORGANIZATION_NOT_HEALTH_SECTOR' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('phoenix_scope_assign:' || p_profile_id::text));

  -- VALIDATE EVERY id BEFORE writing ANY row.
  FOREACH v_fid IN ARRAY v_ids LOOP
    SELECT * INTO v_facility FROM public.organization_facilities WHERE id = v_fid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'FACILITY_SCOPE_FACILITY_NOT_FOUND: %', v_fid USING ERRCODE = '23503';
    END IF;
    IF v_facility.organization_id IS DISTINCT FROM v_profile_org THEN
      RAISE EXCEPTION 'FACILITY_SCOPE_FACILITY_FOREIGN: % does not belong to organization %', v_fid, v_profile_org
        USING ERRCODE = '42501';
    END IF;
    IF v_facility.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'FACILITY_SCOPE_FACILITY_INACTIVE: %', v_fid USING ERRCODE = '23514';
    END IF;
    IF v_facility.facility_class NOT IN ('primary_health_center', 'subordinate_health_center') THEN
      RAISE EXCEPTION 'FACILITY_SCOPE_FACILITY_CLASS_INVALID: %', v_facility.facility_class USING ERRCODE = '23514';
    END IF;
  END LOOP;

  -- WRITE. Same transaction, so any failure above left zero rows behind.
  FOREACH v_fid IN ARRAY v_ids LOOP
    SELECT id INTO v_id FROM public.profile_scope_assignments
    WHERE profile_id = p_profile_id AND scope_type = 'facility'
      AND facility_id = v_fid AND is_active = true;

    IF v_id IS NULL THEN
      INSERT INTO public.profile_scope_assignments
        (profile_id, organization_id, scope_type, facility_id, is_active, assigned_by)
      VALUES (p_profile_id, v_profile_org, 'facility', v_fid, true, p_actor_id)
      RETURNING id INTO v_id;

      INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
      VALUES (v_profile_org, p_actor_id, v_actor_role, 'scope_assigned', 'profile_scope_assignment', v_id, NULL,
              jsonb_build_object(
                'profile_id', p_profile_id, 'scope_type', 'facility', 'target_id', v_fid,
                'facility_id', v_fid, 'organization_id', v_profile_org, 'provisioning', true));
    END IF;

    v_created := v_created || v_id;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'profile_id', p_profile_id, 'assignment_ids', to_jsonb(v_created));
END;
$function$;

CREATE OR REPLACE FUNCTION public.phoenix_assign_profile_scope(p_profile_id uuid, p_scope_type text, p_target_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role         text := public.phoenix_my_role();
  v_actor        uuid := auth.uid();
  v_is_super     boolean := (v_role = 'super_admin');
  v_profile_org  uuid;
  v_profile_role text;
  v_existing     uuid;
  v_id           uuid;
  v_org_kind     text;
  v_org_class    text;
  v_org_status   text;
BEGIN
  IF p_scope_type NOT IN ('warehouse', 'distribution_point', 'facility') THEN
    RAISE EXCEPTION 'SCOPE_TYPE_INVALID: % (expected warehouse|distribution_point|facility)', p_scope_type USING ERRCODE = '23514';
  END IF;

  -- Authority: super_admin, or users.edit_scope holder. Non-super callers are
  -- constrained to their own org below (the IDOR guard).
  IF NOT v_is_super AND NOT public.phoenix_profile_has_permission(v_actor, 'users.edit_scope') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_SCOPE_ASSIGN: requires super_admin or users.edit_scope' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id, role INTO v_profile_org, v_profile_role
  FROM public.profiles WHERE id = p_profile_id;
  IF v_profile_org IS NULL THEN
    -- Either the profile does not exist, or it is a platform profile (super_admin)
    -- with no org; neither can hold a scope. The trigger would also reject this.
    RAISE EXCEPTION 'SCOPE_ASSIGN_PROFILE_INELIGIBLE: profile % has no organization', p_profile_id USING ERRCODE = '23514';
  END IF;

  -- IDOR / cross-org guard for non-super callers: you may only assign within
  -- your own organization. super_admin is exempt (platform role).
  IF NOT v_is_super AND public.phoenix_my_org() IS DISTINCT FROM v_profile_org THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_SCOPE_ASSIGN_CROSS_ORG: caller may only assign within its own organization' USING ERRCODE = '42501';
  END IF;

  -- R1.1-U (U-C corrective) — THE DIRECT-SCOPE INVARIANT, the inverse of the
  -- check below and the reason it is not sufficient on its own.
  --
  -- The facility branch already refuses a facility scope to any role but this
  -- one. Nothing refused the OPPOSITE, so an institution_admin holding
  -- users.edit_scope could hand a health_center_manager a DIRECT warehouse
  -- scope — including on the SECTOR MAIN, whose whole exclusion is that no
  -- facility assignment can ever reach it. Reproduced end to end: the grant
  -- succeeded and the manager then read sector-main stock.
  --
  -- The manager cannot do this to itself (it holds no users.* key), so this is
  -- an over-grant by an otherwise authorized administrator rather than a
  -- privilege escalation. That is exactly why it must be closed here: a
  -- facility-scoped role's isolation cannot depend on every administrator
  -- remembering not to create a scope row the model never intended.
  --
  -- The invariant is stated positively and structurally, not as a blocklist of
  -- the sector main's id: for this role the ONLY assignable operational scope
  -- is 'facility'. Its depot, pharmacy and crash cabinets are DERIVED from that
  -- assignment by 5b/5c, never granted directly, so a direct warehouse or point
  -- row is not a stronger grant — it is a row the model has no meaning for.
  --
  -- Legacy roles are untouched: the guard keys on the TARGET's role, and no
  -- pre-182 profile can hold this one.
  IF v_profile_role = 'health_center_manager' AND p_scope_type <> 'facility' THEN
    RAISE EXCEPTION
      'SCOPE_ASSIGN_ROLE_REQUIRES_FACILITY_SCOPE: health_center_manager may hold facility scope only; % authority is derived from its assigned health centres', p_scope_type
      USING ERRCODE = '23514';
  END IF;

  -- R1.1-U: a FACILITY assignment carries additional authority requirements.
  IF p_scope_type = 'facility' THEN
    IF v_profile_role IS DISTINCT FROM 'health_center_manager' THEN
      RAISE EXCEPTION 'SCOPE_ASSIGN_ROLE_INELIGIBLE: facility scope requires role health_center_manager' USING ERRCODE = '23514';
    END IF;

    SELECT o.organization_kind, o.institution_class, o.status
      INTO v_org_kind, v_org_class, v_org_status
    FROM public.organizations o WHERE o.id = v_profile_org;
    IF v_org_status IS DISTINCT FROM 'active'
       OR v_org_kind IS DISTINCT FROM 'care_institution'
       OR v_org_class IS DISTINCT FROM 'health_sector' THEN
      RAISE EXCEPTION 'SCOPE_ASSIGN_ORGANIZATION_NOT_HEALTH_SECTOR: organization % is not an active care_institution health sector', v_profile_org
        USING ERRCODE = '23514';
    END IF;

    -- A non-super caller assigning facility scope must be the sector's own
    -- institution_admin. users.edit_scope alone is not enough for this role.
    IF NOT v_is_super AND v_role IS DISTINCT FROM 'institution_admin' THEN
      RAISE EXCEPTION 'NOT_AUTHORIZED_FACILITY_SCOPE_ASSIGN: requires super_admin or the sector institution_admin' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Idempotent: an existing ACTIVE assignment for this (profile, target) is a
  -- no-op, not an error (double-submit / retry safe). Serialize per profile so a
  -- concurrent duplicate cannot slip past the check-then-insert.
  PERFORM pg_advisory_xact_lock(hashtext('phoenix_scope_assign:' || p_profile_id::text));

  IF p_scope_type = 'warehouse' THEN
    SELECT id INTO v_existing FROM public.profile_scope_assignments
    WHERE profile_id = p_profile_id AND scope_type = 'warehouse' AND warehouse_id = p_target_id AND is_active = true;
  ELSIF p_scope_type = 'distribution_point' THEN
    SELECT id INTO v_existing FROM public.profile_scope_assignments
    WHERE profile_id = p_profile_id AND scope_type = 'distribution_point' AND distribution_point_id = p_target_id AND is_active = true;
  ELSE
    SELECT id INTO v_existing FROM public.profile_scope_assignments
    WHERE profile_id = p_profile_id AND scope_type = 'facility' AND facility_id = p_target_id AND is_active = true;
  END IF;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'assignment_id', v_existing, 'idempotent_replay', true);
  END IF;

  -- Insert. organization_id is taken from the profile so it can never disagree
  -- with it; the 062/182 trigger re-proves org-match + target-active fail-closed.
  INSERT INTO public.profile_scope_assignments
    (profile_id, organization_id, scope_type, warehouse_id, distribution_point_id, facility_id, is_active, assigned_by)
  VALUES (
    p_profile_id, v_profile_org, p_scope_type,
    CASE WHEN p_scope_type = 'warehouse'          THEN p_target_id ELSE NULL END,
    CASE WHEN p_scope_type = 'distribution_point' THEN p_target_id ELSE NULL END,
    CASE WHEN p_scope_type = 'facility'           THEN p_target_id ELSE NULL END,
    true, v_actor
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_profile_org, v_actor, v_role, 'scope_assigned', 'profile_scope_assignment', v_id, NULL,
          jsonb_build_object(
            'profile_id', p_profile_id, 'scope_type', p_scope_type, 'target_id', p_target_id,
            'facility_id', CASE WHEN p_scope_type = 'facility' THEN p_target_id ELSE NULL END,
            'organization_id', v_profile_org));

  RETURN jsonb_build_object('ok', true, 'assignment_id', v_id, 'idempotent_replay', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.phoenix_create_supply_route(p_source_warehouse_id uuid, p_target_warehouse_id uuid, p_priority integer DEFAULT 1, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role  text := public.phoenix_my_role();
  v_actor uuid := auth.uid();
  v_priority integer := coalesce(p_priority, 1);
  v_id    uuid;
BEGIN
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_SUPPLY_ROUTE: only super_admin may manage supply routes' USING ERRCODE = '42501';
  END IF;
  IF v_priority < 1 THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_PRIORITY_INVALID: priority must be >= 1' USING ERRCODE = '23514';
  END IF;
  PERFORM public.phoenix_supply_route_assert_endpoints(p_source_warehouse_id, p_target_warehouse_id);

  -- Serialize per target so the single active-primary slot and the active pair
  -- cannot be double-claimed by a concurrent create (indexes are the hard
  -- guarantee; this makes the race an ordered wait and a clean message).
  PERFORM pg_advisory_xact_lock(hashtext('phoenix_supply_route:' || p_target_warehouse_id::text));

  IF EXISTS (
    SELECT 1 FROM public.warehouse_supply_routes
    WHERE source_warehouse_id = p_source_warehouse_id AND target_warehouse_id = p_target_warehouse_id AND is_active
  ) THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_EXISTS: an active route already links this source and target' USING ERRCODE = '23505';
  END IF;
  IF v_priority = 1 AND EXISTS (
    SELECT 1 FROM public.warehouse_supply_routes
    WHERE target_warehouse_id = p_target_warehouse_id AND is_active AND priority = 1
  ) THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_PRIMARY_EXISTS: target % already has an active primary route (use priority >= 2)', p_target_warehouse_id USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.warehouse_supply_routes
    (source_warehouse_id, target_warehouse_id, priority, is_active, notes, created_by)
  VALUES (p_source_warehouse_id, p_target_warehouse_id, v_priority, true,
          nullif(btrim(coalesce(p_notes, '')), ''), v_actor)
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (NULL, v_actor, v_role, 'create', 'warehouse_supply_route', v_id, NULL,
          jsonb_build_object('source_warehouse_id', p_source_warehouse_id,
                             'target_warehouse_id', p_target_warehouse_id, 'priority', v_priority));

  RETURN jsonb_build_object('ok', true, 'supply_route_id', v_id, 'priority', v_priority);
END;
$function$;

CREATE OR REPLACE FUNCTION public.phoenix_create_warehouse(p_organization_id uuid, p_name text, p_name_ar text, p_warehouse_kind text, p_code text DEFAULT NULL::text, p_is_main boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role  text := public.phoenix_my_role();
  v_actor uuid := auth.uid();
  v_name    text := btrim(coalesce(p_name, ''));
  v_name_ar text := btrim(coalesce(p_name_ar, ''));
  v_code    text := nullif(btrim(coalesce(p_code, '')), '');
  v_is_main boolean := coalesce(p_is_main, false);
  v_id    uuid;
BEGIN
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_WAREHOUSE_MANAGE: only super_admin may create warehouses' USING ERRCODE = '42501';
  END IF;
  IF p_warehouse_kind NOT IN ('central', 'institution') THEN
    RAISE EXCEPTION 'INVALID_WAREHOUSE_KIND: % (expected central|institution)', p_warehouse_kind USING ERRCODE = '23514';
  END IF;
  IF v_name = '' OR v_name_ar = '' THEN
    RAISE EXCEPTION 'WAREHOUSE_NAME_REQUIRED: name and name_ar must be non-empty' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id) THEN
    RAISE EXCEPTION 'ORGANIZATION_NOT_FOUND: %', p_organization_id USING ERRCODE = '23503';
  END IF;

  -- Serialize main-warehouse arbitration per org: the partial unique index
  -- warehouses_one_active_main_per_org_uniq is the hard guarantee, this advisory
  -- lock turns a concurrent race into an ordered wait and a clean error.
  IF v_is_main THEN
    PERFORM pg_advisory_xact_lock(hashtext('phoenix_warehouse_main:' || p_organization_id::text));
    IF EXISTS (
      SELECT 1 FROM public.warehouses w
      WHERE w.organization_id = p_organization_id AND w.is_main = true AND w.status = 'active'
    ) THEN
      RAISE EXCEPTION 'WAREHOUSE_MAIN_EXISTS: organization % already has an active main warehouse', p_organization_id USING ERRCODE = '23505';
    END IF;
  END IF;

  IF v_code IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.warehouses w
    WHERE w.organization_id = p_organization_id AND btrim(w.code) = v_code
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_CODE_EXISTS: code % already used in organization %', v_code, p_organization_id USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.warehouses (organization_id, name, name_ar, warehouse_kind, is_main, code, status)
  VALUES (p_organization_id, v_name, v_name_ar, p_warehouse_kind, v_is_main, v_code, 'active')
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (p_organization_id, v_actor, v_role, 'create', 'warehouse', v_id, v_name,
          jsonb_build_object('warehouse_kind', p_warehouse_kind, 'is_main', v_is_main, 'code', v_code));

  RETURN jsonb_build_object('ok', true, 'warehouse_id', v_id, 'warehouse_kind', p_warehouse_kind, 'is_main', v_is_main);
END;
$function$;

CREATE OR REPLACE FUNCTION public.phoenix_mark_password_changed()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  UPDATE public.profiles
  SET must_change_password = false,
      password_changed_at = now()
  WHERE id = v_uid;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.phoenix_profile_has_permission(p_profile_id uuid, p_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT CASE WHEN public.phoenix_my_role()='health_center_manager' AND p_profile_id IS DISTINCT FROM auth.uid() THEN false ELSE coalesce(
 (SELECT o.allowed FROM public.profile_permission_overrides o WHERE o.profile_id=p_profile_id AND o.permission_key=p_key AND o.allowed IS NOT NULL),
 (SELECT d.allowed FROM public.role_permission_defaults d JOIN public.profiles pr ON pr.id=p_profile_id WHERE d.role=pr.role AND d.permission_key=p_key),false) END;
$function$;

CREATE OR REPLACE FUNCTION public.phoenix_revoke_profile_scope(p_assignment_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role     text := public.phoenix_my_role();
  v_actor    uuid := auth.uid();
  v_is_super boolean := (v_role = 'super_admin');
  v_org      uuid;
  v_active   boolean;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'SCOPE_REVOKE_REASON_REQUIRED: a non-empty reason is mandatory' USING ERRCODE = '23514';
  END IF;
  IF NOT v_is_super AND NOT public.phoenix_profile_has_permission(v_actor, 'users.edit_scope') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_SCOPE_REVOKE: requires super_admin or users.edit_scope' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id, is_active INTO v_org, v_active
  FROM public.profile_scope_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'SCOPE_ASSIGNMENT_NOT_FOUND: %', p_assignment_id USING ERRCODE = '23503';
  END IF;

  IF NOT v_is_super AND public.phoenix_my_org() IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_SCOPE_REVOKE_CROSS_ORG: caller may only revoke within its own organization' USING ERRCODE = '42501';
  END IF;

  -- Idempotent: revoking an already-revoked assignment is a no-op.
  IF NOT v_active THEN
    RETURN jsonb_build_object('ok', true, 'assignment_id', p_assignment_id, 'idempotent_replay', true);
  END IF;

  UPDATE public.profile_scope_assignments
  SET is_active = false, revoked_by = v_actor, revoked_at = now(), revoke_reason = v_reason
  WHERE id = p_assignment_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_org, v_actor, v_role, 'scope_revoked', 'profile_scope_assignment', p_assignment_id, NULL,
          jsonb_build_object('reason', v_reason));

  RETURN jsonb_build_object('ok', true, 'assignment_id', p_assignment_id, 'idempotent_replay', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.phoenix_set_supply_route_active(p_route_id uuid, p_active boolean, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role   text := public.phoenix_my_role();
  v_actor  uuid := auth.uid();
  v_source uuid; v_target uuid; v_priority integer; v_was_active boolean;
BEGIN
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_SUPPLY_ROUTE: only super_admin may manage supply routes' USING ERRCODE = '42501';
  END IF;

  SELECT source_warehouse_id, target_warehouse_id, priority, is_active
    INTO v_source, v_target, v_priority, v_was_active
  FROM public.warehouse_supply_routes WHERE id = p_route_id FOR UPDATE;
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_NOT_FOUND: %', p_route_id USING ERRCODE = '23503';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('phoenix_supply_route:' || v_target::text));

  IF p_active THEN
    -- Reactivation must re-verify the endpoints and not collide with a live pair
    -- or a live primary — the partial unique indexes only see active rows.
    PERFORM public.phoenix_supply_route_assert_endpoints(v_source, v_target);
    IF EXISTS (
      SELECT 1 FROM public.warehouse_supply_routes
      WHERE source_warehouse_id = v_source AND target_warehouse_id = v_target AND is_active AND id <> p_route_id
    ) THEN
      RAISE EXCEPTION 'SUPPLY_ROUTE_EXISTS: an active route already links this source and target' USING ERRCODE = '23505';
    END IF;
    IF v_priority = 1 AND EXISTS (
      SELECT 1 FROM public.warehouse_supply_routes
      WHERE target_warehouse_id = v_target AND is_active AND priority = 1 AND id <> p_route_id
    ) THEN
      RAISE EXCEPTION 'SUPPLY_ROUTE_PRIMARY_EXISTS: target % already has an active primary route', v_target USING ERRCODE = '23505';
    END IF;
  END IF;

  UPDATE public.warehouse_supply_routes
  SET is_active = p_active, updated_at = now()
  WHERE id = p_route_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (NULL, v_actor, v_role, 'update', 'warehouse_supply_route', p_route_id, NULL,
          jsonb_build_object('active_from', v_was_active, 'active_to', p_active,
                             'reason', nullif(btrim(coalesce(p_reason, '')), '')));

  RETURN jsonb_build_object('ok', true, 'supply_route_id', p_route_id, 'is_active', p_active);
END;
$function$;

CREATE OR REPLACE FUNCTION public.phoenix_set_warehouse_active(p_warehouse_id uuid, p_active boolean, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role    text := public.phoenix_my_role();
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_status  text;
  v_new     text := CASE WHEN p_active THEN 'active' ELSE 'inactive' END;
BEGIN
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_WAREHOUSE_MANAGE: only super_admin may (de)activate warehouses' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id, status INTO v_org, v_status
  FROM public.warehouses WHERE id = p_warehouse_id FOR UPDATE;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'WAREHOUSE_NOT_FOUND: %', p_warehouse_id USING ERRCODE = '23503';
  END IF;
  IF v_status = 'archived' THEN
    RAISE EXCEPTION 'WAREHOUSE_ARCHIVED: % is archived — use the archive path, not (de)activation', p_warehouse_id USING ERRCODE = '23514';
  END IF;

  UPDATE public.warehouses
  SET status  = v_new,
      is_main = CASE WHEN p_active THEN is_main ELSE false END
  WHERE id = p_warehouse_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_org, v_actor, v_role, 'update', 'warehouse', p_warehouse_id, NULL,
          jsonb_build_object('status_from', v_status, 'status_to', v_new,
                             'reason', nullif(btrim(coalesce(p_reason, '')), '')));

  RETURN jsonb_build_object('ok', true, 'warehouse_id', p_warehouse_id, 'status', v_new);
END;
$function$;

CREATE OR REPLACE FUNCTION public.phoenix_update_supply_route(p_route_id uuid, p_priority integer DEFAULT NULL::integer, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role   text := public.phoenix_my_role();
  v_actor  uuid := auth.uid();
  v_target uuid; v_active boolean; v_cur_priority integer;
  v_new_priority integer;
BEGIN
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_SUPPLY_ROUTE: only super_admin may manage supply routes' USING ERRCODE = '42501';
  END IF;

  SELECT target_warehouse_id, is_active, priority INTO v_target, v_active, v_cur_priority
  FROM public.warehouse_supply_routes WHERE id = p_route_id FOR UPDATE;
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_NOT_FOUND: %', p_route_id USING ERRCODE = '23503';
  END IF;

  v_new_priority := coalesce(p_priority, v_cur_priority);
  IF v_new_priority < 1 THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_PRIORITY_INVALID: priority must be >= 1' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('phoenix_supply_route:' || v_target::text));
  IF v_active AND v_new_priority = 1 AND v_cur_priority <> 1 AND EXISTS (
    SELECT 1 FROM public.warehouse_supply_routes
    WHERE target_warehouse_id = v_target AND is_active AND priority = 1 AND id <> p_route_id
  ) THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_PRIMARY_EXISTS: target % already has an active primary route', v_target USING ERRCODE = '23505';
  END IF;

  UPDATE public.warehouse_supply_routes
  SET priority = v_new_priority,
      notes    = CASE WHEN p_notes IS NULL THEN notes ELSE nullif(btrim(p_notes), '') END,
      updated_at = now()
  WHERE id = p_route_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (NULL, v_actor, v_role, 'update', 'warehouse_supply_route', p_route_id, NULL,
          jsonb_build_object('priority_from', v_cur_priority, 'priority_to', v_new_priority,
                             'notes_changed', (p_notes IS NOT NULL)));

  RETURN jsonb_build_object('ok', true, 'supply_route_id', p_route_id, 'priority', v_new_priority);
END;
$function$;

CREATE OR REPLACE FUNCTION public.phoenix_update_warehouse(p_warehouse_id uuid, p_name text DEFAULT NULL::text, p_name_ar text DEFAULT NULL::text, p_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role   text := public.phoenix_my_role();
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_new_name    text;
  v_new_name_ar text;
  v_new_code    text;
  v_clear_code  boolean := (p_code IS NOT NULL AND btrim(p_code) = '');
BEGIN
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_WAREHOUSE_MANAGE: only super_admin may update public.warehouses' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_org FROM public.warehouses WHERE id = p_warehouse_id FOR UPDATE;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'WAREHOUSE_NOT_FOUND: %', p_warehouse_id USING ERRCODE = '23503';
  END IF;

  v_new_name    := CASE WHEN p_name    IS NULL THEN NULL ELSE btrim(p_name)    END;
  v_new_name_ar := CASE WHEN p_name_ar IS NULL THEN NULL ELSE btrim(p_name_ar) END;
  IF v_new_name    = '' THEN RAISE EXCEPTION 'WAREHOUSE_NAME_REQUIRED'    USING ERRCODE = '23514'; END IF;
  IF v_new_name_ar = '' THEN RAISE EXCEPTION 'WAREHOUSE_NAME_AR_REQUIRED' USING ERRCODE = '23514'; END IF;

  v_new_code := CASE WHEN v_clear_code THEN NULL
                     WHEN p_code IS NULL THEN NULL
                     ELSE nullif(btrim(p_code), '') END;
  IF v_new_code IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.warehouses w
    WHERE w.organization_id = v_org AND btrim(w.code) = v_new_code AND w.id <> p_warehouse_id
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_CODE_EXISTS: code % already used in organization %', v_new_code, v_org USING ERRCODE = '23505';
  END IF;

  UPDATE public.warehouses
  SET name    = COALESCE(v_new_name, name),
      name_ar = COALESCE(v_new_name_ar, name_ar),
      code    = CASE WHEN v_clear_code THEN NULL
                     WHEN p_code IS NULL THEN code
                     ELSE v_new_code END
  WHERE id = p_warehouse_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_org, v_actor, v_role, 'update', 'warehouse', p_warehouse_id, COALESCE(v_new_name, ''),
          jsonb_build_object('name', v_new_name, 'name_ar', v_new_name_ar,
                             'code_changed', (p_code IS NOT NULL), 'code_cleared', v_clear_code));

  RETURN jsonb_build_object('ok', true, 'warehouse_id', p_warehouse_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.purge_entity_with_all_data(p_entity_type text, p_entity_id uuid, p_confirmation text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role          text;
  v_org_id        uuid;
  v_allowed       text[] := array['warehouse', 'distribution_point', 'local_item'];
  v_required_conf text;
  v_entity_org_id uuid;
  v_impact        jsonb;
begin
  -- MEDISTOCK_PHOENIX_PURGE_V1
  v_role   := phoenix_my_role();
  v_org_id := phoenix_my_org();

  -- only super_admin may hard-delete
  if v_role != 'super_admin' then
    return jsonb_build_object('ok', false, 'error', 'SUPER_ADMIN_ONLY');
  end if;

  -- enforce allowlist
  if p_entity_type != all(v_allowed) then
    return jsonb_build_object('ok', false, 'error', 'ENTITY_TYPE_NOT_ALLOWLISTED');
  end if;

  -- require exact confirmation phrase to prevent accidental calls
  v_required_conf := 'CONFIRM_PURGE_' || p_entity_id::text;
  if p_confirmation is distinct from v_required_conf then
    return jsonb_build_object(
      'ok', false,
      'error', 'CONFIRMATION_MISMATCH',
      'required', v_required_conf
    );
  end if;

  -- resolve and validate entity
  case p_entity_type
    when 'warehouse' then
      select organization_id into v_entity_org_id
      from public.warehouses where id = p_entity_id;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'ENTITY_NOT_FOUND');
      end if;

    when 'distribution_point' then
      select organization_id into v_entity_org_id
      from public.distribution_points where id = p_entity_id;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'ENTITY_NOT_FOUND');
      end if;

    when 'local_item' then
      select organization_id into v_entity_org_id
      from public.local_items where id = p_entity_id;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'ENTITY_NOT_FOUND');
      end if;
  end case;

  -- get impact for audit snapshot
  v_impact := get_entity_purge_impact(p_entity_type, p_entity_id);

  -- ===== SAFE DELETE ORDER =====

  case p_entity_type

    when 'warehouse' then
      -- 1. Disable+delete QR tokens for all child distribution_points
      update public.qr_tokens set status = 'disabled', disabled_at = now(), disabled_by = auth.uid(),
        disable_reason = 'parent_warehouse_purged'
      where qr_target_id in (
        select qtr.id from public.qr_targets qtr
        where qtr.target_type = 'distribution_point'
          and qtr.target_id in (select id from public.distribution_points where warehouse_id = p_entity_id)
      );
      delete from public.qr_targets
      where target_type = 'distribution_point'
        and target_id in (select id from public.distribution_points where warehouse_id = p_entity_id);

      -- 2. Disable+delete QR tokens for the warehouse itself
      update public.qr_tokens set status = 'disabled', disabled_at = now(), disabled_by = auth.uid(),
        disable_reason = 'warehouse_purged'
      where qr_target_id in (
        select id from public.qr_targets where target_type = 'warehouse' and target_id = p_entity_id
      );
      delete from public.qr_targets where target_type = 'warehouse' and target_id = p_entity_id;

      -- 3. Delete item_availability for all distribution_points
      delete from public.item_availability
      where distribution_point_id in (
        select id from public.distribution_points where warehouse_id = p_entity_id
      );

      -- 4. Delete distribution_points
      delete from public.distribution_points where warehouse_id = p_entity_id;

      -- 5. Delete warehouse (parent last)
      delete from public.warehouses where id = p_entity_id;

    when 'distribution_point' then
      -- 1. Disable+delete QR tokens for this point
      update public.qr_tokens set status = 'disabled', disabled_at = now(), disabled_by = auth.uid(),
        disable_reason = 'distribution_point_purged'
      where qr_target_id in (
        select id from public.qr_targets
        where target_type = 'distribution_point' and target_id = p_entity_id
      );
      delete from public.qr_targets
      where target_type = 'distribution_point' and target_id = p_entity_id;

      -- 2. Delete item_availability
      delete from public.item_availability where distribution_point_id = p_entity_id;

      -- 3. Delete parent (point)
      delete from public.distribution_points where id = p_entity_id;

    when 'local_item' then
      -- 1. Disable+delete QR tokens for this local_item
      update public.qr_tokens set status = 'disabled', disabled_at = now(), disabled_by = auth.uid(),
        disable_reason = 'local_item_purged'
      where qr_target_id in (
        select id from public.qr_targets
        where target_type = 'local_item' and target_id = p_entity_id
      );
      delete from public.qr_targets
      where target_type = 'local_item' and target_id = p_entity_id;

      -- 2. Delete item_availability records for this local_item
      delete from public.item_availability where local_item_id = p_entity_id;

      -- 3. Delete local_item (parent last)
      delete from public.local_items where id = p_entity_id;

  end case;

  -- audit (written after purge so entity_id refers to what was deleted)
  insert into public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, payload
  ) values (
    v_entity_org_id, auth.uid(), v_role, 'purged', p_entity_type, p_entity_id,
    v_impact
  );

  return jsonb_build_object(
    'ok',          true,
    'purged',      true,
    'entity_type', p_entity_type,
    'entity_id',   p_entity_id,
    'impact',      v_impact
  );
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
  select organization_id into v_target_org from public.profiles where id = p_profile_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND'); end if;

  if v_role <> 'super_admin' then
    if not phoenix_profile_has_permission(v_actor, 'users.manage_permissions') then
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
-- M196_REPLACEMENTS_END

CREATE TEMP TABLE _m196_after ON COMMIT DROP AS
SELECT p.oid,
       p.proname::text AS proname,
       p.oid::regprocedure::text AS signature,
       pg_get_function_identity_arguments(p.oid) AS ident_args,
       p.pronargs,
       p.prokind,
       l.lanname::text AS language,
       pg_get_function_result(p.oid) AS result_type,
       p.provolatile,
       p.prosecdef,
       p.proisstrict,
       p.proparallel,
       p.proleakproof,
       COALESCE(array_to_string(p.proconfig, ','), '') AS cfg,
       pg_get_userbyid(p.proowner)::text AS owner,
       COALESCE(p.proacl::text, '') AS acl,
       replace(p.prosrc, chr(13) || chr(10), chr(10)) AS body_lf,
       encode(extensions.digest(replace(p.prosrc, chr(13) || chr(10), chr(10)), 'sha256'), 'hex') AS body_sha256
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
JOIN _m196_targets t ON t.proname = p.proname
WHERE n.nspname = 'public';

DO $m196_verify$
DECLARE
  v_count integer;
  r record;
BEGIN
  SELECT count(*) INTO v_count FROM _m196_after;
  IF v_count <> 22 THEN
    RAISE EXCEPTION 'M196 VERIFY: expected exactly 22 target functions after replacement, found %', v_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM _m196_before b
    FULL JOIN _m196_after a USING (oid)
    WHERE b.oid IS NULL OR a.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'M196 VERIFY: function OID identity changed';
  END IF;

  FOR r IN
    SELECT t.proname, t.expected_after_body_sha256,
           b.signature b_sig, a.signature a_sig,
           b.ident_args b_args, a.ident_args a_args,
           b.pronargs b_nargs, a.pronargs a_nargs,
           b.prokind b_kind, a.prokind a_kind,
           b.language b_lang, a.language a_lang,
           b.result_type b_result, a.result_type a_result,
           b.provolatile b_vol, a.provolatile a_vol,
           b.prosecdef b_sec, a.prosecdef a_sec,
           b.proisstrict b_strict, a.proisstrict a_strict,
           b.proparallel b_parallel, a.proparallel a_parallel,
           b.proleakproof b_leak, a.proleakproof a_leak,
           b.cfg b_cfg, a.cfg a_cfg,
           b.owner b_owner, a.owner a_owner,
           b.acl b_acl, a.acl a_acl,
           a.body_sha256
    FROM _m196_targets t
    JOIN _m196_before b USING (proname)
    JOIN _m196_after a USING (oid, proname)
  LOOP
    IF r.b_sig IS DISTINCT FROM r.a_sig
       OR r.b_args IS DISTINCT FROM r.a_args
       OR r.b_nargs IS DISTINCT FROM r.a_nargs
       OR r.b_kind IS DISTINCT FROM r.a_kind
       OR r.b_lang IS DISTINCT FROM r.a_lang
       OR r.b_result IS DISTINCT FROM r.a_result
       OR r.b_vol IS DISTINCT FROM r.a_vol
       OR r.b_sec IS DISTINCT FROM r.a_sec
       OR r.b_strict IS DISTINCT FROM r.a_strict
       OR r.b_parallel IS DISTINCT FROM r.a_parallel
       OR r.b_leak IS DISTINCT FROM r.a_leak
       OR r.b_cfg IS DISTINCT FROM r.a_cfg
       OR r.b_owner IS DISTINCT FROM r.a_owner
       OR r.b_acl IS DISTINCT FROM r.a_acl THEN
      RAISE EXCEPTION 'M196 VERIFY: non-body contract drifted for %', r.proname;
    END IF;

    IF r.body_sha256 <> r.expected_after_body_sha256 THEN
      RAISE EXCEPTION 'M196 VERIFY: % body differs from exact reviewed qualified body. expected %, found %',
        r.proname, r.expected_after_body_sha256, r.body_sha256;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM _m196_after WHERE cfg = 'search_path=public') <> 5
     OR (SELECT count(*) FROM _m196_after WHERE cfg = 'search_path=public, pg_temp') <> 17 THEN
    RAISE EXCEPTION 'M196 VERIFY: search_path split changed';
  END IF;

  IF has_function_privilege(
       'authenticated',
       'public.phoenix_admin_assign_facility_scopes(uuid,uuid,uuid[])',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'M196 VERIFY: narrower facility-scope ACL widened';
  END IF;

  RAISE NOTICE 'M196: verified exact 106-token qualification; OID, signature, result, language, volatility, SECURITY DEFINER, search_path, strictness, parallel safety, leakproof, owner and ACL unchanged.';
END
$m196_verify$;

COMMIT;

-- Reconciliation: definition-only migration; no business data is written.
-- Rollback is intentionally not automated: reversing it would reintroduce the
-- SECURITY DEFINER name-resolution dependency that this unit removes.
