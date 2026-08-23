-- ============================================================================
-- STAGE-I-I5 / M198 — SECURITY DEFINER search_path CONVERGENCE
--
-- Applies after M197. Compatible with the pinned I-2 Production executor:
-- one exact migration, one exact hash, one exact ceiling.
--
-- Thirty first-party SECURITY DEFINER routines still carry a function-level
-- search_path of exactly `public`. Two hundred and ninety-one of their siblings
-- already carry `public, pg_temp`. M198 converges the remaining thirty onto the
-- setting the overwhelming majority already use.
--
-- WHY pg_temp MUST BE NAMED, AND NAMED LAST.
-- When a function's search_path does not mention pg_temp, PostgreSQL still
-- searches the temporary schema — and searches it FIRST. A caller who can
-- create a temporary object can therefore shadow a public table or function
-- that one of these routines resolves unqualified, and a SECURITY DEFINER
-- routine resolves it as the definer. Writing `public, pg_temp` moves the
-- temporary schema to LAST, so a temp object can no longer capture a name the
-- routine meant to read from public. This is a hardening, not a relaxation: it
-- removes an implicit privilege-escalation path.
--
-- NONE OF THE THIRTY TOUCH TEMPORARY OBJECTS. Their bodies were inspected for
-- any mention of TEMP/TEMPORARY/pg_temp and none matched, so moving pg_temp to
-- last cannot change what any of them resolves. CREATE TEMP would still work
-- regardless, because it targets pg_temp explicitly rather than by search order.
--
-- SEARCH_PATH ONLY. This migration issues no CREATE OR REPLACE. It alters no
-- body, no OID, no signature, no return type, no owner, no SECURITY DEFINER
-- flag, no language, no volatility, no strictness, no parallel safety, no
-- leakproof flag, no ACL, no table, view, sequence, schema, trigger, policy,
-- RLS state or default privilege, and it mutates no business data. ALTER
-- FUNCTION ... SET search_path rewrites exactly one pg_proc column, proconfig.
-- VERIFY proves every one of those on the live catalog rather than asserting it
-- here, including that M197's PUBLIC EXECUTE convergence is still intact.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. TARGETS — the exact thirty. Measured from a disposable replay of the
--    canonical chain 001->197 and cross-checked against a live read-only
--    Production measurement of the same population.
-- ============================================================================
CREATE TEMP TABLE _m198_targets (signature text PRIMARY KEY) ON COMMIT DROP;

INSERT INTO _m198_targets VALUES
  ('public.archive_entity(text,uuid,text)'),
  ('public.create_qr_for_target(text,uuid,text)'),
  ('public.disable_qr_token(uuid,text)'),
  ('public.get_entity_purge_impact(text,uuid)'),
  ('public.get_public_qr_payload(text)'),
  ('public.phoenix_ack_platform_broadcast(uuid)'),
  ('public.phoenix_apply_manual_availability_movement_internal(uuid,text,integer,text,text)'),
  ('public.phoenix_clean_availability_data(boolean,text)'),
  ('public.phoenix_create_inter_org_exchange_request(text,uuid,uuid,uuid,integer,text,text)'),
  ('public.phoenix_create_platform_broadcast(text,text,text,text,uuid[],timestamp with time zone,timestamp with time zone)'),
  ('public.phoenix_deactivate_platform_broadcast(uuid)'),
  ('public.phoenix_delete_platform_broadcast(uuid,text)'),
  ('public.phoenix_get_dashboard_condition_counts(uuid)'),
  ('public.phoenix_get_institution_condition_counts()'),
  ('public.phoenix_get_inter_org_alert_events(text)'),
  ('public.phoenix_get_inter_org_exchange_events(uuid)'),
  ('public.phoenix_get_inter_org_exchange_requests(text,integer,integer)'),
  ('public.phoenix_get_pending_platform_broadcasts()'),
  ('public.phoenix_get_platform_broadcast_ack_status(uuid)'),
  ('public.phoenix_handle_new_user()'),
  ('public.phoenix_list_platform_broadcasts_admin()'),
  ('public.phoenix_my_org()'),
  ('public.phoenix_my_role()'),
  ('public.phoenix_reopen_inter_org_alert(text,text,text)'),
  ('public.phoenix_set_my_org_whatsapp_contact(boolean)'),
  ('public.phoenix_update_inter_org_alert_state(text,text,text,text)'),
  ('public.phoenix_update_inter_org_exchange_status(uuid,text,integer,integer,text,text)'),
  ('public.phoenix_update_my_whatsapp_phone(text)'),
  ('public.phoenix_upsert_availability(uuid,text,text,text,text,integer,text,date,text,text,text,numeric,text)'),
  ('public.purge_entity_with_all_data(text,uuid,text)');

-- The one setting every target must hold before, and the one it must hold after.
CREATE TEMP TABLE _m198_expect ON COMMIT DROP AS
  SELECT 'search_path=public'::text AS before_cfg,
         'search_path=public, pg_temp'::text AS after_cfg;

-- ============================================================================
-- 1. BEFORE-IMAGES — captured inside the transaction, so VERIFY compares
--    against what was really there rather than against what this file claims.
-- ============================================================================
CREATE TEMP TABLE _m198_before ON COMMIT DROP AS
SELECT t.signature,
       p.oid                                            AS fn_oid,
       pg_get_userbyid(p.proowner)                      AS owner,
       pg_get_function_identity_arguments(p.oid)        AS ident_args,
       pg_get_function_result(p.oid)                    AS result_type,
       p.prosecdef, p.prokind, l.lanname AS language, p.provolatile,
       p.proisstrict, p.proparallel, p.proleakproof, p.pronargs,
       coalesce(array_to_string(p.proconfig, '; '), '') AS cfg,
       md5(p.prosrc)                                    AS body_md5,
       (SELECT coalesce(string_agg(g || '=' || pr, ',' ORDER BY g COLLATE "C", pr COLLATE "C"), '')
          FROM (SELECT coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC') AS g,
                       a.privilege_type AS pr
                  FROM aclexplode(p.proacl) a) s)       AS acl
  FROM _m198_targets t
  JOIN pg_proc p ON p.oid = to_regprocedure(t.signature)
  JOIN pg_language l ON l.oid = p.prolang;

-- 1b. Everything OUTSIDE the thirty that must be provably unchanged. Function
--     rows carry their proconfig here too, so a stray search_path change
--     anywhere else in public would be caught.
CREATE TEMP TABLE _m198_env_before ON COMMIT DROP AS
  SELECT 'fn' AS kind,
         p.oid::text || ' ' || coalesce(array_to_string(p.proconfig, '; '), '') || ' ' ||
         (SELECT coalesce(string_agg(coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC') || '=' || a.privilege_type,
                                     ',' ORDER BY (coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC') || '=' || a.privilege_type) COLLATE "C"), '')
            FROM aclexplode(p.proacl) a)                             AS item
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND p.oid NOT IN (SELECT fn_oid FROM _m198_before)
  UNION ALL
  SELECT 'rel_acl', c.oid::text || ' ' || coalesce(c.relacl::text, '')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p','f','S')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'rls', c.oid::text || ' ' || c.relrowsecurity::text || c.relforcerowsecurity::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
  UNION ALL
  SELECT 'schema_acl', n.oid::text || ' ' || coalesce(n.nspacl::text, '')
    FROM pg_namespace n WHERE n.nspname IN ('public','auth','extensions','storage')
  UNION ALL
  SELECT 'default_acl', d.oid::text || ' ' || coalesce(d.defaclacl::text, '')
    FROM pg_default_acl d
  UNION ALL
  SELECT 'policy', pol.schemaname || '.' || pol.tablename || '.' || pol.policyname || ' ' ||
         pol.permissive || ' ' || pol.roles::text || ' ' || pol.cmd || ' ' ||
         coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')
    FROM pg_policies pol WHERE pol.schemaname = 'public'
  UNION ALL
  SELECT 'trigger', tn.nspname || '.' || tc.relname || ':' || tg.tgname || ' -> ' || tp.proname
    FROM pg_trigger tg
    JOIN pg_proc tp ON tp.oid = tg.tgfoid
    JOIN pg_class tc ON tc.oid = tg.tgrelid
    JOIN pg_namespace tn ON tn.oid = tc.relnamespace
   WHERE NOT tg.tgisinternal
  UNION ALL
  SELECT 'role_attr', r.rolname || ' ' || r.rolsuper::text || r.rolinherit::text ||
         r.rolcreaterole::text || r.rolcreatedb::text || r.rolcanlogin::text || r.rolbypassrls::text
    FROM pg_roles r WHERE r.rolname NOT LIKE 'pg%';

-- ============================================================================
-- 2. PRECONDITIONS — fail closed unless this is EXACTLY the reviewed state.
-- ============================================================================
DO $m198_pre$
DECLARE
  v_missing text;
  v_count   integer;
  v_row     record;
  v_before  text := (SELECT before_cfg FROM _m198_expect);
BEGIN
  -- 2a. All thirty resolve, exactly once each, with no overload ambiguity.
  SELECT string_agg(t.signature, ', ' ORDER BY t.signature) INTO v_missing
    FROM _m198_targets t WHERE to_regprocedure(t.signature) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'M198 PRECONDITION: target routine(s) not found: %', v_missing;
  END IF;

  SELECT count(*) INTO v_count FROM _m198_before;
  IF v_count <> 30 THEN
    RAISE EXCEPTION 'M198 PRECONDITION: expected exactly 30 before-images, found %', v_count;
  END IF;

  FOR v_row IN SELECT signature FROM _m198_targets LOOP
    SELECT count(*) INTO v_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.oid = to_regprocedure(v_row.signature);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'M198 PRECONDITION: % resolves to % functions in public, expected exactly 1 (overload ambiguity)',
        v_row.signature, v_count;
    END IF;
  END LOOP;

  -- 2b. Every target is a plain SECURITY DEFINER function.
  SELECT string_agg(signature, ', ' ORDER BY signature) INTO v_missing
    FROM _m198_before WHERE NOT prosecdef;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'M198 PRECONDITION: not SECURITY DEFINER: %', v_missing;
  END IF;
  SELECT string_agg(signature, ', ' ORDER BY signature) INTO v_missing
    FROM _m198_before WHERE prokind <> 'f';
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'M198 PRECONDITION: not a plain function: %', v_missing;
  END IF;

  -- 2c. Every target's CURRENT search_path is exactly the reviewed one. This
  --     simultaneously proves none of them has already been converged.
  SELECT string_agg(signature || ' [' || cfg || ']', ', ' ORDER BY signature) INTO v_missing
    FROM _m198_before WHERE cfg <> v_before;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'M198 PRECONDITION: search_path is not [%] for: %', v_before, v_missing;
  END IF;

  -- 2d. The POPULATION check: `search_path = public` holds on EXACTLY these
  --     thirty first-party SECURITY DEFINER routines and no others. Without
  --     this, a routine added since the measurement could be silently left
  --     behind while this migration reported success.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND p.proconfig = ARRAY[v_before];
  IF v_count <> 30 THEN
    RAISE EXCEPTION 'M198 PRECONDITION: % first-party SECURITY DEFINER routines carry search_path=public, expected exactly 30', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND p.proconfig = ARRAY[v_before]
     AND p.oid NOT IN (SELECT fn_oid FROM _m198_before);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'M198 PRECONDITION: % routine(s) carry search_path=public but are outside the reviewed thirty', v_count;
  END IF;

  -- 2e. M197 must still hold. If PUBLIC EXECUTE has reappeared on a first-party
  --     SECURITY DEFINER routine, the database is not in the state I-5 was
  --     authorized against and this migration must not run.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'M198 PRECONDITION: % first-party SECURITY DEFINER routine(s) carry PUBLIC EXECUTE; M197 is not intact', v_count;
  END IF;

  RAISE NOTICE 'M198 preconditions PASS: thirty routines, all search_path=public, population exact, M197 intact.';
END
$m198_pre$;

-- ============================================================================
-- 3. CONVERGENCE — one ALTER per target. ALTER FUNCTION ... SET search_path
--    rewrites pg_proc.proconfig and nothing else: no new OID, no body reparse,
--    no ACL change. Order is irrelevant here, unlike M197's GRANT-before-REVOKE.
-- ============================================================================
ALTER FUNCTION public.archive_entity(text,uuid,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.create_qr_for_target(text,uuid,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.disable_qr_token(uuid,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_entity_purge_impact(text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_public_qr_payload(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_ack_platform_broadcast(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_apply_manual_availability_movement_internal(uuid,text,integer,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_clean_availability_data(boolean,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_create_inter_org_exchange_request(text,uuid,uuid,uuid,integer,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_create_platform_broadcast(text,text,text,text,uuid[],timestamp with time zone,timestamp with time zone) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_deactivate_platform_broadcast(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_delete_platform_broadcast(uuid,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_get_dashboard_condition_counts(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_get_institution_condition_counts() SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_get_inter_org_alert_events(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_get_inter_org_exchange_events(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_get_inter_org_exchange_requests(text,integer,integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_get_pending_platform_broadcasts() SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_get_platform_broadcast_ack_status(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_handle_new_user() SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_list_platform_broadcasts_admin() SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_my_org() SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_my_role() SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_reopen_inter_org_alert(text,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_set_my_org_whatsapp_contact(boolean) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_update_inter_org_alert_state(text,text,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_update_inter_org_exchange_status(uuid,text,integer,integer,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_update_my_whatsapp_phone(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.phoenix_upsert_availability(uuid,text,text,text,text,integer,text,date,text,text,text,numeric,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.purge_entity_with_all_data(text,uuid,text) SET search_path = public, pg_temp;

-- ============================================================================
-- 4. AFTER-IMAGES
-- ============================================================================
CREATE TEMP TABLE _m198_after ON COMMIT DROP AS
SELECT t.signature,
       p.oid                                            AS fn_oid,
       pg_get_userbyid(p.proowner)                      AS owner,
       pg_get_function_identity_arguments(p.oid)        AS ident_args,
       pg_get_function_result(p.oid)                    AS result_type,
       p.prosecdef, p.prokind, l.lanname AS language, p.provolatile,
       p.proisstrict, p.proparallel, p.proleakproof, p.pronargs,
       coalesce(array_to_string(p.proconfig, '; '), '') AS cfg,
       md5(p.prosrc)                                    AS body_md5,
       (SELECT coalesce(string_agg(g || '=' || pr, ',' ORDER BY g COLLATE "C", pr COLLATE "C"), '')
          FROM (SELECT coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC') AS g,
                       a.privilege_type AS pr
                  FROM aclexplode(p.proacl) a) s)       AS acl
  FROM _m198_targets t
  JOIN pg_proc p ON p.oid = to_regprocedure(t.signature)
  JOIN pg_language l ON l.oid = p.prolang;

CREATE TEMP TABLE _m198_env_after ON COMMIT DROP AS
  SELECT 'fn' AS kind,
         p.oid::text || ' ' || coalesce(array_to_string(p.proconfig, '; '), '') || ' ' ||
         (SELECT coalesce(string_agg(coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC') || '=' || a.privilege_type,
                                     ',' ORDER BY (coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC') || '=' || a.privilege_type) COLLATE "C"), '')
            FROM aclexplode(p.proacl) a)                             AS item
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND p.oid NOT IN (SELECT fn_oid FROM _m198_before)
  UNION ALL
  SELECT 'rel_acl', c.oid::text || ' ' || coalesce(c.relacl::text, '')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p','f','S')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'rls', c.oid::text || ' ' || c.relrowsecurity::text || c.relforcerowsecurity::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
  UNION ALL
  SELECT 'schema_acl', n.oid::text || ' ' || coalesce(n.nspacl::text, '')
    FROM pg_namespace n WHERE n.nspname IN ('public','auth','extensions','storage')
  UNION ALL
  SELECT 'default_acl', d.oid::text || ' ' || coalesce(d.defaclacl::text, '')
    FROM pg_default_acl d
  UNION ALL
  SELECT 'policy', pol.schemaname || '.' || pol.tablename || '.' || pol.policyname || ' ' ||
         pol.permissive || ' ' || pol.roles::text || ' ' || pol.cmd || ' ' ||
         coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')
    FROM pg_policies pol WHERE pol.schemaname = 'public'
  UNION ALL
  SELECT 'trigger', tn.nspname || '.' || tc.relname || ':' || tg.tgname || ' -> ' || tp.proname
    FROM pg_trigger tg
    JOIN pg_proc tp ON tp.oid = tg.tgfoid
    JOIN pg_class tc ON tc.oid = tg.tgrelid
    JOIN pg_namespace tn ON tn.oid = tc.relnamespace
   WHERE NOT tg.tgisinternal
  UNION ALL
  SELECT 'role_attr', r.rolname || ' ' || r.rolsuper::text || r.rolinherit::text ||
         r.rolcreaterole::text || r.rolcreatedb::text || r.rolcanlogin::text || r.rolbypassrls::text
    FROM pg_roles r WHERE r.rolname NOT LIKE 'pg%';

-- ============================================================================
-- 5. VERIFY — proved on the live catalog, not asserted.
-- ============================================================================
DO $m198_post$
DECLARE
  v_bad    text;
  v_count  integer;
  v_after  text := (SELECT after_cfg FROM _m198_expect);
  v_before text := (SELECT before_cfg FROM _m198_expect);
BEGIN
  -- 5a. NOTHING but search_path moved, for any target.
  SELECT string_agg(b.signature, ', ' ORDER BY b.signature) INTO v_bad
    FROM _m198_before b JOIN _m198_after a USING (signature)
   WHERE b.fn_oid IS DISTINCT FROM a.fn_oid
      OR b.owner IS DISTINCT FROM a.owner
      OR b.ident_args IS DISTINCT FROM a.ident_args
      OR b.result_type IS DISTINCT FROM a.result_type
      OR b.prosecdef IS DISTINCT FROM a.prosecdef
      OR b.prokind IS DISTINCT FROM a.prokind
      OR b.language IS DISTINCT FROM a.language
      OR b.provolatile IS DISTINCT FROM a.provolatile
      OR b.proisstrict IS DISTINCT FROM a.proisstrict
      OR b.proparallel IS DISTINCT FROM a.proparallel
      OR b.proleakproof IS DISTINCT FROM a.proleakproof
      OR b.pronargs IS DISTINCT FROM a.pronargs
      OR b.body_md5 IS DISTINCT FROM a.body_md5
      OR b.acl IS DISTINCT FROM a.acl;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'M198 VERIFY: % changed a non-search_path attribute (oid/owner/args/result/secdef/kind/lang/volatility/strictness/parallel/leakproof/nargs/body/acl)', v_bad;
  END IF;

  -- 5b. Every target now holds EXACTLY the converged setting.
  SELECT string_agg(signature || ' [' || cfg || ']', ', ' ORDER BY signature) INTO v_bad
    FROM _m198_after WHERE cfg <> v_after;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'M198 VERIFY: search_path is not [%] for: %', v_after, v_bad;
  END IF;

  SELECT count(*) INTO v_count FROM _m198_after;
  IF v_count <> 30 THEN
    RAISE EXCEPTION 'M198 VERIFY: expected exactly 30 after-images, found %', v_count;
  END IF;

  -- 5c. No first-party SECURITY DEFINER routine is left on bare `public`.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND p.proconfig = ARRAY[v_before];
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'M198 VERIFY: % first-party SECURITY DEFINER routine(s) still carry search_path=public, expected 0', v_count;
  END IF;

  -- 5d. M197 is still intact: PUBLIC EXECUTE has not reappeared.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'M198 VERIFY: % first-party SECURITY DEFINER routine(s) carry PUBLIC EXECUTE; M197 was disturbed', v_count;
  END IF;

  -- 5e. EVERYTHING outside the thirty is byte-identical: other functions'
  --     proconfig and ACLs, relation/schema/default ACLs, RLS flags, policies,
  --     triggers and role attributes.
  SELECT string_agg(kind || ': ' || item, ' | ' ORDER BY kind, item) INTO v_bad
    FROM ((SELECT kind, item FROM _m198_env_before EXCEPT SELECT kind, item FROM _m198_env_after)
          UNION ALL
          (SELECT kind, item FROM _m198_env_after EXCEPT SELECT kind, item FROM _m198_env_before)) d;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'M198 VERIFY: state outside the thirty targets changed: %', v_bad;
  END IF;

  RAISE NOTICE 'M198 VERIFY PASS: thirty routines converged to [%], none left on [%], M197 intact, nothing else moved.', v_after, v_before;
END
$m198_post$;

COMMIT;
