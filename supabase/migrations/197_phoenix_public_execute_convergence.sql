-- ============================================================================
-- STAGE-I-I4 / M197 — POSTGRESQL PUBLIC EXECUTE CONVERGENCE
--
-- Applies after M196. Compatible with the pinned I-2 Production executor:
-- one exact migration, one exact hash, one exact ceiling.
--
-- Six first-party SECURITY DEFINER routines still carry an EXECUTE grant to
-- the PostgreSQL PUBLIC pseudo-role. PUBLIC is inherited by every role in the
-- cluster, so it is the widest possible grant and it hides which roles a
-- routine is actually meant for. M197 replaces that inheritance with explicit
-- role grants, and removes it.
--
-- PUBLIC-FACING PRODUCT BEHAVIOUR IS NOT THE POSTGRESQL PUBLIC PSEUDO-ROLE.
-- The anonymous QR portal keeps working because get_public_qr_payload(text)
-- already holds an EXPLICIT anon grant (migrations 059/177/188). Revoking
-- PUBLIC removes an inheritance path, not the product capability. The
-- preconditions below refuse to run unless that explicit anon grant is
-- present FIRST, so the revoke can never be the thing that takes QR down.
--
-- ORDER IS LOAD-BEARING for the two identity helpers. phoenix_my_org() and
-- phoenix_my_role() are reached by 80 distinct RLS policies (51 and 76
-- respectively). Today authenticated reaches them ONLY through PUBLIC.
-- Revoking PUBLIC before granting authenticated would, for the width of this
-- transaction, strip the privilege every one of those policies depends on.
-- Each GRANT therefore precedes its REVOKE, and VERIFY re-proves the result.
--
-- ACL-ONLY. This migration issues no CREATE OR REPLACE, alters no body, no
-- OID, no signature, no return type, no owner, no SECURITY DEFINER flag, no
-- language, no volatility, no strictness, no parallel safety, no leakproof
-- flag, no search_path, no table, view, sequence, schema, trigger, policy or
-- RLS state, no default privilege, and mutates no business data. VERIFY proves
-- each of those on the live catalog rather than asserting it here.
--
-- search_path convergence is NOT in scope: that is I-5 / M198.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. TARGETS — the exact six, with their exact expected before/after ACLs.
--    ACLs are compared as a normalized, C-collated, sorted "grantee=priv"
--    list so the comparison cannot drift with locale or catalog ordering.
-- ============================================================================
CREATE TEMP TABLE _m197_targets (
  signature           text PRIMARY KEY,
  kind                text NOT NULL,
  expected_acl_before text NOT NULL,
  expected_acl_after  text NOT NULL
) ON COMMIT DROP;

INSERT INTO _m197_targets VALUES
  ('public.get_public_qr_payload(text)', 'public_product',
   'PUBLIC=EXECUTE,anon=EXECUTE,authenticated=EXECUTE,postgres=EXECUTE,service_role=EXECUTE',
   'anon=EXECUTE,authenticated=EXECUTE,postgres=EXECUTE,service_role=EXECUTE'),
  ('public.phoenix_my_org()', 'identity_helper',
   'PUBLIC=EXECUTE,postgres=EXECUTE,service_role=EXECUTE',
   'authenticated=EXECUTE,postgres=EXECUTE,service_role=EXECUTE'),
  ('public.phoenix_my_role()', 'identity_helper',
   'PUBLIC=EXECUTE,phoenix_demo_purger=EXECUTE,postgres=EXECUTE,service_role=EXECUTE',
   'authenticated=EXECUTE,phoenix_demo_purger=EXECUTE,postgres=EXECUTE,service_role=EXECUTE'),
  ('public.phoenix_guard_dp_archive_update()', 'trigger_only',
   'PUBLIC=EXECUTE,postgres=EXECUTE,service_role=EXECUTE',
   'postgres=EXECUTE,service_role=EXECUTE'),
  ('public.phoenix_handle_new_user()', 'trigger_only',
   'PUBLIC=EXECUTE,postgres=EXECUTE,service_role=EXECUTE',
   'postgres=EXECUTE,service_role=EXECUTE'),
  ('public.phoenix_populate_actor_snapshot()', 'trigger_only',
   'PUBLIC=EXECUTE,postgres=EXECUTE,service_role=EXECUTE',
   'postgres=EXECUTE,service_role=EXECUTE');

-- ============================================================================
-- 1. BEFORE-IMAGES — captured inside the transaction so VERIFY compares
--    against what was really there, not against what this file claims.
-- ============================================================================

-- 1a. Every attribute of the six that M197 promises not to touch.
CREATE TEMP TABLE _m197_before ON COMMIT DROP AS
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
  FROM _m197_targets t
  JOIN pg_proc p ON p.oid = to_regprocedure(t.signature)
  JOIN pg_language l ON l.oid = p.prolang;

-- 1b. Everything OUTSIDE the six that must be provably unchanged.
CREATE TEMP TABLE _m197_env_before ON COMMIT DROP AS
  SELECT 'fn_acl' AS kind,
         p.oid::text || ' ' ||
         (SELECT coalesce(string_agg(coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC') || '=' || a.privilege_type,
                                     ',' ORDER BY (coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC') || '=' || a.privilege_type) COLLATE "C"), '')
            FROM aclexplode(p.proacl) a)                             AS item
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND p.oid NOT IN (SELECT fn_oid FROM _m197_before)
  UNION ALL
  SELECT 'rel_acl', c.oid::text || ' ' || coalesce(c.relacl::text, '')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p','f','S')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
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
DO $m197_pre$
DECLARE
  v_missing text;
  v_count   integer;
  v_row     record;
  v_actual  text;
BEGIN
  -- 2a. All six resolve, exactly once each, with no overload ambiguity.
  SELECT string_agg(t.signature, ', ') INTO v_missing
    FROM _m197_targets t WHERE to_regprocedure(t.signature) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'M197 PRECONDITION: target routine(s) not found: %', v_missing;
  END IF;

  SELECT count(*) INTO v_count FROM _m197_before;
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'M197 PRECONDITION: expected exactly 6 before-images, found %', v_count;
  END IF;

  FOR v_row IN SELECT t.signature FROM _m197_targets t LOOP
    SELECT count(*) INTO v_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = split_part(split_part(v_row.signature, '.', 2), '(', 1);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'M197 PRECONDITION: % resolves to % functions in public, expected exactly 1 (overload ambiguity)',
        v_row.signature, v_count;
    END IF;
  END LOOP;

  -- 2b. All six are SECURITY DEFINER, and all six are plain functions.
  SELECT string_agg(signature, ', ') INTO v_missing FROM _m197_before WHERE NOT prosecdef;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'M197 PRECONDITION: not SECURITY DEFINER: %', v_missing;
  END IF;
  SELECT string_agg(signature, ', ') INTO v_missing FROM _m197_before WHERE prokind <> 'f';
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'M197 PRECONDITION: not a plain function: %', v_missing;
  END IF;

  -- 2c. Every before ACL is EXACTLY the reviewed one. This simultaneously
  --     proves PUBLIC is present on all six and that the explicit grants the
  --     revokes depend on (anon/authenticated on QR, phoenix_demo_purger on
  --     phoenix_my_role, service_role throughout) are already there.
  FOR v_row IN SELECT b.signature, b.acl, t.expected_acl_before
                 FROM _m197_before b JOIN _m197_targets t USING (signature) LOOP
    IF v_row.acl <> v_row.expected_acl_before THEN
      RAISE EXCEPTION 'M197 PRECONDITION: % ACL is [%], expected [%]',
        v_row.signature, v_row.acl, v_row.expected_acl_before;
    END IF;
  END LOOP;

  -- 2d. The QR revoke may only proceed on proof of the explicit grants that
  --     keep the product working. Stated separately from 2c so the intent is
  --     unmistakable to a reviewer.
  SELECT b.acl INTO v_actual FROM _m197_before b
   WHERE b.signature = 'public.get_public_qr_payload(text)';
  IF position('anon=EXECUTE' in v_actual) = 0 THEN
    RAISE EXCEPTION 'M197 PRECONDITION: get_public_qr_payload(text) has no EXPLICIT anon grant; revoking PUBLIC would break the anonymous QR portal';
  END IF;
  IF position('authenticated=EXECUTE' in v_actual) = 0 THEN
    RAISE EXCEPTION 'M197 PRECONDITION: get_public_qr_payload(text) has no EXPLICIT authenticated grant';
  END IF;
  IF position('service_role=EXECUTE' in v_actual) = 0 THEN
    RAISE EXCEPTION 'M197 PRECONDITION: get_public_qr_payload(text) has no EXPLICIT service_role grant';
  END IF;

  -- 2e. PUBLIC holds EXECUTE on EXACTLY these six first-party SECURITY DEFINER
  --     routines and no others. A seventh would mean the reviewed scope is
  --     stale and this migration would leave it behind.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE');
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'M197 PRECONDITION: % first-party SECURITY DEFINER routines carry PUBLIC EXECUTE, expected exactly 6', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
     AND p.oid NOT IN (SELECT fn_oid FROM _m197_before);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'M197 PRECONDITION: % PUBLIC-executable SECURITY DEFINER routine(s) are outside the reviewed six', v_count;
  END IF;

  -- 2f. The identity helpers really do reach the RLS surface this migration
  --     claims, so the GRANT-before-REVOKE ordering is provably necessary.
  SELECT count(*) INTO v_count FROM pg_policies
   WHERE schemaname = 'public'
     AND (coalesce(qual,'') || ' ' || coalesce(with_check,'')) LIKE '%phoenix_my_org%';
  IF v_count <> 51 THEN
    RAISE EXCEPTION 'M197 PRECONDITION: phoenix_my_org() is referenced by % policies, expected 51', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM pg_policies
   WHERE schemaname = 'public'
     AND (coalesce(qual,'') || ' ' || coalesce(with_check,'')) LIKE '%phoenix_my_role%';
  IF v_count <> 76 THEN
    RAISE EXCEPTION 'M197 PRECONDITION: phoenix_my_role() is referenced by % policies, expected 76', v_count;
  END IF;

  -- 2g. Trigger bindings the three trigger-only routines must keep.
  SELECT count(*) INTO v_count
    FROM pg_trigger tg JOIN pg_proc tp ON tp.oid = tg.tgfoid
   WHERE NOT tg.tgisinternal
     AND tp.oid IN (SELECT b.fn_oid FROM _m197_before b JOIN _m197_targets t USING (signature)
                     WHERE t.kind = 'trigger_only');
  IF v_count <> 8 THEN
    RAISE EXCEPTION 'M197 PRECONDITION: trigger-only routines have % trigger bindings, expected 8', v_count;
  END IF;

  RAISE NOTICE 'M197 preconditions PASS: six routines, exact ACLs, PUBLIC on exactly six, 51/76 policies, 8 trigger bindings.';
END
$m197_pre$;

-- ============================================================================
-- 3. CONVERGENCE — GRANT before REVOKE for both identity helpers. The order of
--    these eight statements is the security contract, not a formatting choice.
-- ============================================================================

-- 3a. phoenix_my_org() — authenticated FIRST, so no instant of this
--     transaction leaves the 51 policies that call it without the privilege.
GRANT EXECUTE ON FUNCTION public.phoenix_my_org() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.phoenix_my_org() FROM PUBLIC;

-- 3b. phoenix_my_role() — same order, 76 policies. service_role and
--     phoenix_demo_purger keep their explicit grants untouched.
GRANT EXECUTE ON FUNCTION public.phoenix_my_role() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.phoenix_my_role() FROM PUBLIC;

-- 3c. get_public_qr_payload(text) — no GRANT needed: anon, authenticated and
--     service_role already hold EXPLICIT grants, proven in 2c/2d above. This
--     removes an inheritance path only; the anonymous QR portal is unaffected.
REVOKE EXECUTE ON FUNCTION public.get_public_qr_payload(text) FROM PUBLIC;

-- 3d. Trigger-only routines. A trigger fires with the privileges established
--     at CREATE TRIGGER time and does not re-check EXECUTE against the writing
--     role, so removing PUBLIC cannot stop the eight bindings from firing.
--     No compensating grant to anon or authenticated is issued: these are not
--     client RPC endpoints and must not become ones.
REVOKE EXECUTE ON FUNCTION public.phoenix_guard_dp_archive_update() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.phoenix_handle_new_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.phoenix_populate_actor_snapshot() FROM PUBLIC;

-- ============================================================================
-- 4. AFTER-IMAGES
-- ============================================================================
CREATE TEMP TABLE _m197_after ON COMMIT DROP AS
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
  FROM _m197_targets t
  JOIN pg_proc p ON p.oid = to_regprocedure(t.signature)
  JOIN pg_language l ON l.oid = p.prolang;

CREATE TEMP TABLE _m197_env_after ON COMMIT DROP AS
  SELECT 'fn_acl' AS kind,
         p.oid::text || ' ' ||
         (SELECT coalesce(string_agg(coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC') || '=' || a.privilege_type,
                                     ',' ORDER BY (coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC') || '=' || a.privilege_type) COLLATE "C"), '')
            FROM aclexplode(p.proacl) a)                             AS item
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND p.oid NOT IN (SELECT fn_oid FROM _m197_after)
  UNION ALL
  SELECT 'rel_acl', c.oid::text || ' ' || coalesce(c.relacl::text, '')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p','f','S')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
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
-- 5. VERIFY — inside the transaction; any failure rolls back all of M197.
-- ============================================================================
DO $m197_verify$
DECLARE
  v_row    record;
  v_count  integer;
  v_extra  text;
BEGIN
  -- 5a. Every non-ACL attribute of the six is byte-identical.
  FOR v_row IN
    SELECT b.signature,
           b.fn_oid       <> a.fn_oid       AS d_oid,
           b.owner        <> a.owner        AS d_owner,
           b.ident_args   <> a.ident_args   AS d_args,
           b.result_type  <> a.result_type  AS d_result,
           b.prosecdef    <> a.prosecdef    AS d_secdef,
           b.prokind      <> a.prokind      AS d_kind,
           b.language     <> a.language     AS d_lang,
           b.provolatile  <> a.provolatile  AS d_vol,
           b.proisstrict  <> a.proisstrict  AS d_strict,
           b.proparallel  <> a.proparallel  AS d_par,
           b.proleakproof <> a.proleakproof AS d_leak,
           b.pronargs     <> a.pronargs     AS d_nargs,
           b.cfg          <> a.cfg          AS d_cfg,
           b.body_md5     <> a.body_md5     AS d_body
      FROM _m197_before b JOIN _m197_after a USING (signature)
  LOOP
    IF v_row.d_oid OR v_row.d_owner OR v_row.d_args OR v_row.d_result OR v_row.d_secdef
       OR v_row.d_kind OR v_row.d_lang OR v_row.d_vol OR v_row.d_strict OR v_row.d_par
       OR v_row.d_leak OR v_row.d_nargs OR v_row.d_cfg OR v_row.d_body THEN
      RAISE EXCEPTION 'M197 VERIFY: % changed a non-ACL attribute (oid=% owner=% args=% result=% secdef=% kind=% lang=% vol=% strict=% par=% leak=% nargs=% cfg=% body=%)',
        v_row.signature, v_row.d_oid, v_row.d_owner, v_row.d_args, v_row.d_result,
        v_row.d_secdef, v_row.d_kind, v_row.d_lang, v_row.d_vol, v_row.d_strict,
        v_row.d_par, v_row.d_leak, v_row.d_nargs, v_row.d_cfg, v_row.d_body;
    END IF;
  END LOOP;

  -- 5b. Every after ACL is EXACTLY the reviewed target.
  FOR v_row IN SELECT a.signature, a.acl, t.expected_acl_after
                 FROM _m197_after a JOIN _m197_targets t USING (signature) LOOP
    IF v_row.acl <> v_row.expected_acl_after THEN
      RAISE EXCEPTION 'M197 VERIFY: % ACL is [%], expected [%]',
        v_row.signature, v_row.acl, v_row.expected_acl_after;
    END IF;
  END LOOP;

  -- 5c. No first-party SECURITY DEFINER routine carries PUBLIC EXECUTE.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'M197 VERIFY: % first-party SECURITY DEFINER routine(s) still carry PUBLIC EXECUTE, expected 0', v_count;
  END IF;

  -- 5d. The explicit grants the product depends on are real and EXPLICIT,
  --     not effective-by-inheritance. aclexplode reads the stored ACL, so a
  --     privilege that only existed through PUBLIC cannot satisfy this.
  IF NOT EXISTS (SELECT 1 FROM _m197_after WHERE signature = 'public.get_public_qr_payload(text)'
                   AND position('anon=EXECUTE' in acl) > 0) THEN
    RAISE EXCEPTION 'M197 VERIFY: anonymous QR lost its explicit anon EXECUTE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM _m197_after WHERE signature = 'public.phoenix_my_org()'
                   AND position('authenticated=EXECUTE' in acl) > 0) THEN
    RAISE EXCEPTION 'M197 VERIFY: phoenix_my_org() has no explicit authenticated EXECUTE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM _m197_after WHERE signature = 'public.phoenix_my_role()'
                   AND position('authenticated=EXECUTE' in acl) > 0
                   AND position('phoenix_demo_purger=EXECUTE' in acl) > 0) THEN
    RAISE EXCEPTION 'M197 VERIFY: phoenix_my_role() lost authenticated or phoenix_demo_purger EXECUTE';
  END IF;

  -- 5e. Trigger-only routines gained nothing. They must not become client RPCs.
  SELECT string_agg(a.signature, ', ') INTO v_extra
    FROM _m197_after a JOIN _m197_targets t USING (signature)
   WHERE t.kind = 'trigger_only'
     AND (position('anon=EXECUTE' in a.acl) > 0 OR position('authenticated=EXECUTE' in a.acl) > 0);
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'M197 VERIFY: trigger-only routine(s) gained a client grant: %', v_extra;
  END IF;

  -- 5f. Effective-privilege cross-check: anon must NOT reach the identity
  --     helpers now that PUBLIC is gone, and authenticated must.
  IF has_function_privilege('anon', to_regprocedure('public.phoenix_my_org()'), 'EXECUTE') THEN
    RAISE EXCEPTION 'M197 VERIFY: anon can still EXECUTE phoenix_my_org()';
  END IF;
  IF has_function_privilege('anon', to_regprocedure('public.phoenix_my_role()'), 'EXECUTE') THEN
    RAISE EXCEPTION 'M197 VERIFY: anon can still EXECUTE phoenix_my_role()';
  END IF;
  IF NOT has_function_privilege('authenticated', to_regprocedure('public.phoenix_my_org()'), 'EXECUTE') THEN
    RAISE EXCEPTION 'M197 VERIFY: authenticated lost EXECUTE on phoenix_my_org()';
  END IF;
  IF NOT has_function_privilege('authenticated', to_regprocedure('public.phoenix_my_role()'), 'EXECUTE') THEN
    RAISE EXCEPTION 'M197 VERIFY: authenticated lost EXECUTE on phoenix_my_role()';
  END IF;
  IF NOT has_function_privilege('anon', to_regprocedure('public.get_public_qr_payload(text)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'M197 VERIFY: anon lost EXECUTE on get_public_qr_payload(text) — anonymous QR is broken';
  END IF;
  IF has_function_privilege('anon', to_regprocedure('public.phoenix_populate_actor_snapshot()'), 'EXECUTE')
     OR has_function_privilege('authenticated', to_regprocedure('public.phoenix_populate_actor_snapshot()'), 'EXECUTE')
     OR has_function_privilege('anon', to_regprocedure('public.phoenix_handle_new_user()'), 'EXECUTE')
     OR has_function_privilege('authenticated', to_regprocedure('public.phoenix_handle_new_user()'), 'EXECUTE')
     OR has_function_privilege('anon', to_regprocedure('public.phoenix_guard_dp_archive_update()'), 'EXECUTE')
     OR has_function_privilege('authenticated', to_regprocedure('public.phoenix_guard_dp_archive_update()'), 'EXECUTE') THEN
    RAISE EXCEPTION 'M197 VERIFY: a client role still reaches a trigger-only routine directly';
  END IF;

  -- 5g. Nothing outside the six moved, in either direction.
  SELECT string_agg(kind || ': ' || item, ' | ') INTO v_extra FROM (
    SELECT kind, item FROM _m197_env_before EXCEPT ALL SELECT kind, item FROM _m197_env_after
    UNION ALL
    SELECT kind, item FROM _m197_env_after EXCEPT ALL SELECT kind, item FROM _m197_env_before
  ) d;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'M197 VERIFY: out-of-scope catalog delta: %', left(v_extra, 900);
  END IF;

  -- 5h. Trigger bindings survived the revokes.
  SELECT count(*) INTO v_count
    FROM pg_trigger tg JOIN pg_proc tp ON tp.oid = tg.tgfoid
   WHERE NOT tg.tgisinternal
     AND tp.oid IN (SELECT a.fn_oid FROM _m197_after a JOIN _m197_targets t USING (signature)
                     WHERE t.kind = 'trigger_only');
  IF v_count <> 8 THEN
    RAISE EXCEPTION 'M197 VERIFY: trigger-only routines now have % bindings, expected 8', v_count;
  END IF;

  RAISE NOTICE 'M197 VERIFY PASS: PUBLIC EXECUTE = 0 across first-party SECURITY DEFINER, explicit grants intact, 8 trigger bindings, zero out-of-scope delta.';
END
$m197_verify$;

COMMIT;

-- ============================================================================
-- 6. RECONCILIATION — M197 writes no data and changes no object definition.
--    It removes six PUBLIC EXECUTE grants and adds two explicit authenticated
--    grants. Reversal is a privilege statement, not a restore:
--
--      GRANT EXECUTE ON FUNCTION public.phoenix_my_org() TO PUBLIC;
--      GRANT EXECUTE ON FUNCTION public.phoenix_my_role() TO PUBLIC;
--      GRANT EXECUTE ON FUNCTION public.get_public_qr_payload(text) TO PUBLIC;
--      GRANT EXECUTE ON FUNCTION public.phoenix_guard_dp_archive_update() TO PUBLIC;
--      GRANT EXECUTE ON FUNCTION public.phoenix_handle_new_user() TO PUBLIC;
--      GRANT EXECUTE ON FUNCTION public.phoenix_populate_actor_snapshot() TO PUBLIC;
--      REVOKE EXECUTE ON FUNCTION public.phoenix_my_org() FROM authenticated;
--      REVOKE EXECUTE ON FUNCTION public.phoenix_my_role() FROM authenticated;
--
--    Reversing would restore the widest grant in the cluster; it is recorded
--    here as documented history, not as a recommendation.
-- ============================================================================
