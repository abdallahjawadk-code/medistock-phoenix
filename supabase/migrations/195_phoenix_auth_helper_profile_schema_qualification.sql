-- ============================================================================
-- AUTH-HELPER-PROFILE-SCHEMA-QUALIFICATION-195
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 194.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION IS FOR
-- ----------------------------------------------------------------------------
-- `public.phoenix_my_role()` and `public.phoenix_my_org()` are the two
-- foundational identity helpers. Almost every RLS policy in this database
-- calls one of them, and both are SECURITY DEFINER, so they execute with the
-- owner's authority rather than the caller's.
--
-- Both were written in migration 002 with an UNQUALIFIED relation reference:
--
--     select role from profiles where id = auth.uid();
--
-- They are not currently exploitable: each carries `SET search_path = public`,
-- so `profiles` resolves to `public.profiles` no matter what the caller's own
-- search_path is. That setting is the control that makes them safe, and this
-- migration does NOT touch it.
--
-- What this removes is the DEPENDENCE of a SECURITY DEFINER body on a
-- resolution step at all. Today the safety of these two functions rests on one
-- function-level setting continuing to be present and correct. After this
-- migration the relation is named absolutely, so the body resolves to the same
-- table even if the search_path contract were ever weakened, dropped by a
-- careless CREATE OR REPLACE, or overridden. Defense in depth for the two
-- functions the entire RLS surface is built on.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ----------------------------------------------------------------------------
-- It does NOT change `SET search_path = public` (not to `public, pg_temp`,
-- not to anything else). It does NOT REVOKE EXECUTE FROM PUBLIC. Both
-- functions are currently executable by PUBLIC, which is a real question, but
-- it is a GRANT question with its own blast radius and it is explicitly out of
-- scope here. This migration changes two tokens and nothing else.
--
-- ----------------------------------------------------------------------------
-- MEASURED PRE-STATE (live Production and canonical replay 001..194 agree)
-- ----------------------------------------------------------------------------
--   public.phoenix_my_role()  RETURNS text  LANGUAGE sql  STABLE
--                             SECURITY DEFINER  SET search_path TO 'public'
--     owner postgres, ACL {=X/postgres, postgres=X/postgres,
--                          service_role=X/postgres,
--                          phoenix_demo_purger=X/postgres}
--   public.phoenix_my_org()   RETURNS uuid  LANGUAGE sql  STABLE
--                             SECURITY DEFINER  SET search_path TO 'public'
--     owner postgres, ACL {=X/postgres, postgres=X/postgres,
--                          service_role=X/postgres}
--
-- CREATE OR REPLACE preserves owner and ACL; the VERIFY section proves that on
-- the live database rather than assuming it.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. BEFORE-IMAGE -- captured inside the transaction so VERIFY can prove, on
--    the live database rather than by assertion, that nothing moved except
--    the two relation tokens.
-- ============================================================================
CREATE TEMP TABLE _m195_before ON COMMIT DROP AS
SELECT p.oid,
       p.proname::text                                 AS proname,
       p.oid::regprocedure::text                       AS signature,
       pg_get_function_identity_arguments(p.oid)       AS ident_args,
       p.pronargs,
       p.prokind,
       l.lanname::text                                 AS language,
       pg_get_function_result(p.oid)                   AS result_type,
       p.provolatile,
       p.prosecdef,
       p.proisstrict,
       p.proparallel,
       p.proleakproof,
       COALESCE(array_to_string(p.proconfig, ','), '') AS cfg,
       pg_get_userbyid(p.proowner)::text               AS owner,
       COALESCE(p.proacl::text, '')                    AS acl,
       p.prosrc,
       -- CRLF-normalized body, so the reviewed-state comparison is portable
       -- across environments that differ only in line-ending representation.
       replace(p.prosrc, chr(13) || chr(10), chr(10))  AS body_lf
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language  l ON l.oid = p.prolang
 WHERE n.nspname = 'public'
   AND p.proname IN ('phoenix_my_role', 'phoenix_my_org');

-- ============================================================================
-- 1. PRECONDITIONS -- fail closed unless this is EXACTLY the reviewed state.
--
--    The body checks are EXACT EQUALITY against the measured pre-state, not a
--    pattern match. A regex loose enough to accept "some body mentioning
--    profiles" would happily bless a body that had gained a second relation,
--    an extra predicate, or a different column -- precisely the drift this
--    migration must refuse to run on top of. Exact equality also proves, for
--    free, that `profiles` is the ONLY relation token in each body, so a
--    two-token qualification is sufficient and cannot silently widen scope.
-- ============================================================================
DO $do$
DECLARE
  v_role   _m195_before%ROWTYPE;
  v_org    _m195_before%ROWTYPE;
  v_count  integer;
BEGIN
  -- 1a. Exactly one function of each name in `public` -- no overload ambiguity.
  SELECT count(*) INTO v_count FROM _m195_before WHERE proname = 'phoenix_my_role';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'M195 PRECONDITION: expected exactly 1 public.phoenix_my_role, found %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM _m195_before WHERE proname = 'phoenix_my_org';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'M195 PRECONDITION: expected exactly 1 public.phoenix_my_org, found %', v_count;
  END IF;

  SELECT * INTO v_role FROM _m195_before WHERE proname = 'phoenix_my_role';
  SELECT * INTO v_org  FROM _m195_before WHERE proname = 'phoenix_my_org';

  -- 1b. phoenix_my_role() -- every attribute this migration promises to keep.
  IF v_role.pronargs <> 0 THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_role must take 0 arguments, takes %', v_role.pronargs;
  END IF;
  IF v_role.prokind <> 'f' THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_role must be a plain function, prokind=%', v_role.prokind;
  END IF;
  IF v_role.language <> 'sql' THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_role must be LANGUAGE sql, is %', v_role.language;
  END IF;
  IF v_role.result_type <> 'text' THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_role must return text, returns %', v_role.result_type;
  END IF;
  IF v_role.provolatile <> 's' THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_role must be STABLE, provolatile=%', v_role.provolatile;
  END IF;
  IF NOT v_role.prosecdef THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_role must be SECURITY DEFINER';
  END IF;
  IF v_role.cfg <> 'search_path=public' THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_role search_path must be exactly search_path=public, is %', v_role.cfg;
  END IF;
  IF v_role.proisstrict THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_role must not be STRICT';
  END IF;
  IF v_role.proparallel <> 'u' THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_role parallel must be UNSAFE, is %', v_role.proparallel;
  END IF;
  IF v_role.proleakproof THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_role must not be LEAKPROOF';
  END IF;

  -- 1c. phoenix_my_org() -- same contract, uuid return.
  IF v_org.pronargs <> 0 THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_org must take 0 arguments, takes %', v_org.pronargs;
  END IF;
  IF v_org.prokind <> 'f' THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_org must be a plain function, prokind=%', v_org.prokind;
  END IF;
  IF v_org.language <> 'sql' THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_org must be LANGUAGE sql, is %', v_org.language;
  END IF;
  IF v_org.result_type <> 'uuid' THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_org must return uuid, returns %', v_org.result_type;
  END IF;
  IF v_org.provolatile <> 's' THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_org must be STABLE, provolatile=%', v_org.provolatile;
  END IF;
  IF NOT v_org.prosecdef THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_org must be SECURITY DEFINER';
  END IF;
  IF v_org.cfg <> 'search_path=public' THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_org search_path must be exactly search_path=public, is %', v_org.cfg;
  END IF;
  IF v_org.proisstrict THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_org must not be STRICT';
  END IF;
  IF v_org.proparallel <> 'u' THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_org parallel must be UNSAFE, is %', v_org.proparallel;
  END IF;
  IF v_org.proleakproof THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_org must not be LEAKPROOF';
  END IF;

  -- 1d. Not already qualified -- this migration must not be a silent no-op.
  IF position('public.profiles' in v_role.body_lf) > 0 THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_role body is ALREADY schema-qualified; refusing to run';
  END IF;
  IF position('public.profiles' in v_org.body_lf) > 0 THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_org body is ALREADY schema-qualified; refusing to run';
  END IF;

  -- 1e. EXACT reviewed body. Anything else and this is not the reviewed state.
  IF v_role.body_lf <> chr(10) || '  select role from profiles where id = auth.uid();' || chr(10) THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_role body is not the reviewed pre-U4 body. Found: %', v_role.body_lf;
  END IF;
  IF v_org.body_lf <> chr(10) || '  select organization_id from profiles where id = auth.uid();' || chr(10) THEN
    RAISE EXCEPTION 'M195 PRECONDITION: phoenix_my_org body is not the reviewed pre-U4 body. Found: %', v_org.body_lf;
  END IF;

  RAISE NOTICE 'M195: preconditions satisfied; both helpers match the reviewed pre-U4 state exactly.';
END
$do$;

-- ============================================================================
-- 2. public.phoenix_my_role() -- qualify the relation, change nothing else.
--
--    Every attribute is restated because CREATE OR REPLACE resets any
--    attribute it does not mention (volatility, security, search_path) to its
--    default. Owner and ACL are NOT restated: CREATE OR REPLACE preserves
--    both, and restating them would be a GRANT/ALTER this unit is not
--    authorized to perform. VERIFY proves they survived.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_my_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  select role from public.profiles where id = auth.uid();
$function$;

-- ============================================================================
-- 3. public.phoenix_my_org() -- identical treatment.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_my_org()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  select organization_id from public.profiles where id = auth.uid();
$function$;

-- ============================================================================
-- 4. VERIFY -- inside the transaction; any failure rolls back all of 195.
-- ============================================================================
CREATE TEMP TABLE _m195_after ON COMMIT DROP AS
SELECT p.oid,
       p.proname::text                                 AS proname,
       p.oid::regprocedure::text                       AS signature,
       pg_get_function_identity_arguments(p.oid)       AS ident_args,
       p.pronargs,
       p.prokind,
       l.lanname::text                                 AS language,
       pg_get_function_result(p.oid)                   AS result_type,
       p.provolatile,
       p.prosecdef,
       p.proisstrict,
       p.proparallel,
       p.proleakproof,
       COALESCE(array_to_string(p.proconfig, ','), '') AS cfg,
       pg_get_userbyid(p.proowner)::text               AS owner,
       COALESCE(p.proacl::text, '')                    AS acl,
       p.prosrc,
       replace(p.prosrc, chr(13) || chr(10), chr(10))  AS body_lf
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language  l ON l.oid = p.prolang
 WHERE n.nspname = 'public'
   AND p.proname IN ('phoenix_my_role', 'phoenix_my_org');

DO $do$
DECLARE
  r        record;
  v_count  integer;
BEGIN
  -- 4a. Still exactly one of each, and no new overload appeared.
  SELECT count(*) INTO v_count FROM _m195_after;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'M195 VERIFY: expected exactly 2 helper functions after replacement, found %', v_count;
  END IF;

  -- 4b. Identity is stable: the SAME pg_proc rows, not new objects. A dropped
  --     and recreated function would take a new oid and silently lose its ACL.
  IF EXISTS (SELECT 1 FROM _m195_before b FULL JOIN _m195_after a USING (oid)
              WHERE b.oid IS NULL OR a.oid IS NULL) THEN
    RAISE EXCEPTION 'M195 VERIFY: function identity (oid) changed -- the helper was replaced as a NEW object, which would discard its ACL';
  END IF;

  -- 4c. Every contracted attribute is identical to the before-image. ACL and
  --     owner included: this is the proof that CREATE OR REPLACE preserved the
  --     grant surface, including PUBLIC, service_role and phoenix_demo_purger.
  FOR r IN
    SELECT b.proname,
           b.signature    AS b_sig,    a.signature    AS a_sig,
           b.ident_args   AS b_args,   a.ident_args   AS a_args,
           b.result_type  AS b_ret,    a.result_type  AS a_ret,
           b.language     AS b_lang,   a.language     AS a_lang,
           b.provolatile  AS b_vol,    a.provolatile  AS a_vol,
           b.prosecdef    AS b_sec,    a.prosecdef    AS a_sec,
           b.proisstrict  AS b_str,    a.proisstrict  AS a_str,
           b.proparallel  AS b_par,    a.proparallel  AS a_par,
           b.proleakproof AS b_leak,   a.proleakproof AS a_leak,
           b.cfg          AS b_cfg,    a.cfg          AS a_cfg,
           b.owner        AS b_owner,  a.owner        AS a_owner,
           b.acl          AS b_acl,    a.acl          AS a_acl,
           b.pronargs     AS b_nargs,  a.pronargs     AS a_nargs,
           b.prokind      AS b_kind,   a.prokind      AS a_kind
      FROM _m195_before b JOIN _m195_after a USING (oid)
  LOOP
    IF r.b_sig   <> r.a_sig   THEN RAISE EXCEPTION 'M195 VERIFY: % signature changed: % -> %',        r.proname, r.b_sig,   r.a_sig;   END IF;
    IF r.b_args  <> r.a_args  THEN RAISE EXCEPTION 'M195 VERIFY: % identity args changed: % -> %',    r.proname, r.b_args,  r.a_args;  END IF;
    IF r.b_ret   <> r.a_ret   THEN RAISE EXCEPTION 'M195 VERIFY: % return type changed: % -> %',      r.proname, r.b_ret,   r.a_ret;   END IF;
    IF r.b_lang  <> r.a_lang  THEN RAISE EXCEPTION 'M195 VERIFY: % language changed: % -> %',         r.proname, r.b_lang,  r.a_lang;  END IF;
    IF r.b_vol   <> r.a_vol   THEN RAISE EXCEPTION 'M195 VERIFY: % volatility changed: % -> %',       r.proname, r.b_vol,   r.a_vol;   END IF;
    IF r.b_sec   <> r.a_sec   THEN RAISE EXCEPTION 'M195 VERIFY: % SECURITY DEFINER changed: % -> %', r.proname, r.b_sec,   r.a_sec;   END IF;
    IF r.b_str   <> r.a_str   THEN RAISE EXCEPTION 'M195 VERIFY: % strictness changed: % -> %',       r.proname, r.b_str,   r.a_str;   END IF;
    IF r.b_par   <> r.a_par   THEN RAISE EXCEPTION 'M195 VERIFY: % parallel safety changed: % -> %',  r.proname, r.b_par,   r.a_par;   END IF;
    IF r.b_leak  <> r.a_leak  THEN RAISE EXCEPTION 'M195 VERIFY: % leakproof changed: % -> %',        r.proname, r.b_leak,  r.a_leak;  END IF;
    IF r.b_cfg   <> r.a_cfg   THEN RAISE EXCEPTION 'M195 VERIFY: % search_path changed: % -> %',      r.proname, r.b_cfg,   r.a_cfg;   END IF;
    IF r.b_owner <> r.a_owner THEN RAISE EXCEPTION 'M195 VERIFY: % owner changed: % -> %',            r.proname, r.b_owner, r.a_owner; END IF;
    IF r.b_acl   <> r.a_acl   THEN RAISE EXCEPTION 'M195 VERIFY: % ACL changed: % -> %',              r.proname, r.b_acl,   r.a_acl;   END IF;
    IF r.b_nargs <> r.a_nargs THEN RAISE EXCEPTION 'M195 VERIFY: % arg count changed: % -> %',        r.proname, r.b_nargs, r.a_nargs; END IF;
    IF r.b_kind  <> r.a_kind  THEN RAISE EXCEPTION 'M195 VERIFY: % prokind changed: % -> %',          r.proname, r.b_kind,  r.a_kind;  END IF;
  END LOOP;

  -- 4d. The intended delta actually happened.
  FOR r IN SELECT proname, body_lf FROM _m195_after LOOP
    IF position('public.profiles' in r.body_lf) = 0 THEN
      RAISE EXCEPTION 'M195 VERIFY: % body is not schema-qualified after replacement', r.proname;
    END IF;
    -- No BARE `profiles` remains. Removing the qualified occurrences first is
    -- what makes this check meaningful: a naive search for "profiles" would
    -- match inside "public.profiles" and always pass.
    IF position('profiles' in replace(r.body_lf, 'public.profiles', '')) > 0 THEN
      RAISE EXCEPTION 'M195 VERIFY: % body still contains an unqualified profiles reference', r.proname;
    END IF;
    IF position('auth.uid()' in r.body_lf) = 0 THEN
      RAISE EXCEPTION 'M195 VERIFY: % body lost its auth.uid() caller binding', r.proname;
    END IF;
  END LOOP;

  -- 4e. BODY-DIFF PROOF: undoing the qualification must reproduce the
  --     before-image EXACTLY. This is the assertion that there is no other
  --     body delta of any kind -- not a column, predicate, alias, or space.
  FOR r IN
    SELECT b.proname, b.body_lf AS before_body, a.body_lf AS after_body
      FROM _m195_before b JOIN _m195_after a USING (oid)
  LOOP
    IF replace(r.after_body, 'public.profiles', 'profiles') <> r.before_body THEN
      RAISE EXCEPTION 'M195 VERIFY: % has a body delta beyond the relation qualification. before=% after=%',
        r.proname, r.before_body, r.after_body;
    END IF;
  END LOOP;

  RAISE NOTICE 'M195: verified. Both helpers qualified to public.profiles; signature, return type, language, volatility, SECURITY DEFINER, search_path, strictness, parallel safety, leakproof, owner and ACL all unchanged.';
END
$do$;

COMMIT;

-- ============================================================================
-- 5. RECONCILIATION: this migration writes no data and changes no privilege.
--    Nothing to reconcile.
-- ============================================================================
-- ROLLBACK -- definition-only, instant and lossless. There is no good reason
-- to do this; it reintroduces a SECURITY DEFINER body that depends on
-- search_path resolution:
--   CREATE OR REPLACE FUNCTION public.phoenix_my_role()
--   RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
--   AS $function$
--     select role from profiles where id = auth.uid();
--   $function$;
--   CREATE OR REPLACE FUNCTION public.phoenix_my_org()
--   RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
--   AS $function$
--     select organization_id from profiles where id = auth.uid();
--   $function$;
-- ============================================================================
