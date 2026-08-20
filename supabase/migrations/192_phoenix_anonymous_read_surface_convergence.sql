-- ═════════════════════════════════════════════════════════════════════════════
-- ANON-READ-SURFACE-192 — G5 ANONYMOUS READ SURFACE CONVERGENCE
-- ═════════════════════════════════════════════════════════════════════════════
-- Purely a PRIVILEGE convergence. This migration creates no table, no view, no
-- function and no policy, alters no policy, and changes no row of business data.
-- It closes one role's direct read surface completely and then proves it:
--
--   ANON_ALLOWED_DIRECT_RELATION_READS = { }
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- Production carried direct `anon` SELECT on 26 relations in `public`. Migration
-- 191's VERIFY block H refused to install while two of them (`warehouses`,
-- `distribution_points`) held it, which is how the drift was found at all.
--
-- The decisive fact is that NOTHING IN THIS REPOSITORY EVER GRANTED THEM. A grep
-- over every migration finds no `GRANT ... TO anon` on a relation; 113 and 154
-- only ASSERT that anon must not hold writes. Nor does a default-privilege rule
-- produce them: the live `public`-schema default ACL is
--
--   objtype=r owner=postgres acl={postgres=arwdDxtm, service_role=arwdDxtm}
--
-- with no `anon` in it, and the newest relations (`organization_facilities`,
-- `profile_delegated_scope_assignments`, `outlet_replenishment_routes`,
-- `phoenix_outbox_*`) carry no anon SELECT at all. The grants are therefore
-- LEGACY DRIFT with no source in the chain and no ongoing mechanism — a state a
-- clean replay can never reproduce, which is exactly why CI never saw it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE ALLOWLIST IS EMPTY — INCLUDING item_availability
-- ─────────────────────────────────────────────────────────────────────────────
-- `item_availability` looks like a public read: it is the one relation whose
-- policy list mentions `anon` at all (`avail_select_anon`, from 002). It is not.
--
-- Migration 027 fixed that policy as a CRITICAL defect. In its own words, the
-- old `using (true)` was "granting unrestricted direct SELECT on every column of
-- every row across all organisations", exposing `actor_name_snapshot` (staff
-- full name), `actor_email_snapshot` (staff email), `price`, `batch_number`,
-- `notes` and the whole actor-identity snapshot. 027 replaced it with
-- `using (false)` and stated the rule plainly:
--
--   "Anon role MUST go through the get_public_qr_payload() SECURITY DEFINER RPC.
--    Direct anon SELECT on this table is now denied at RLS level."
--
-- So 027 closed the POLICY lock and left the PRIVILEGE lock open — the grant
-- survived as drift. Re-granting it here would codify that half-open pair into
-- the chain forever and leave a single policy edit between the product and a
-- staff-PII leak. This migration closes the second lock instead. The allowlist
-- is empty because the correct number of relations anon may read directly is
-- zero.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY REVOKING IS SAFE
-- ─────────────────────────────────────────────────────────────────────────────
-- Every drifted relation has RLS enabled and no policy admitting `anon` — and
-- `item_availability`'s anon policy is `using (false)` — so an anonymous SELECT
-- already returned zero rows everywhere. Nothing functional could depend on
-- them; a dependent flow would already be broken.
--
-- The one anonymous surface this product exposes is the public QR page, which
-- calls `get_public_qr_payload(text)` — SECURITY DEFINER, owner `postgres`. It
-- reads `warehouses`, `distribution_points` AND `organization_facilities`, and
-- `organization_facilities` NEVER had an anon grant, yet the page works. That is
-- a controlled experiment already running in Production: the public flow rides
-- the function's definer rights, never anon's relation privileges. 027 says the
-- same thing about `item_availability` explicitly.
--
-- REVOKE of a privilege that was never granted is a no-op in PostgreSQL
-- (migration 025 states the same), so this migration is idempotent and is a
-- complete no-op on a clean rig — it changes only a Production that drifted.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DELIBERATELY NOT DONE HERE
-- ─────────────────────────────────────────────────────────────────────────────
-- `phoenix_get_live_inter_institution_alerts_with_state(integer)` keeps its
-- `authenticated` EXECUTE. Retiring that surface is a separate, separately
-- reviewed decision; this migration touches no routine privilege at all.
--
-- No `authenticated`, `service_role` or `postgres` privilege is altered.
-- No default privileges are altered. No policy is created, dropped or changed —
-- `avail_select_anon` is asserted to remain exactly as 027 left it.
--
-- MANUAL APPLY ONLY. NEVER `supabase db push`.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- PREFLIGHT
-- ─────────────────────────────────────────────────────────────────────────────
DO $preflight$
DECLARE v_qual text;
BEGIN
  IF to_regclass('public.item_availability') IS NULL THEN
    RAISE EXCEPTION '192_precondition_failed: public.item_availability is missing';
  END IF;

  -- 027's CRITICAL fix must still be in force BEFORE this migration runs. If the
  -- policy were open again, closing the grant alone would hide a live exposure
  -- behind a privilege change instead of surfacing it.
  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO v_qual
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'item_availability'
    AND pol.polname = 'avail_select_anon';
  IF v_qual IS NULL THEN
    RAISE EXCEPTION '192_precondition_failed: avail_select_anon policy is missing (002/027)';
  END IF;
  IF btrim(v_qual) <> 'false' THEN
    RAISE EXCEPTION '192_precondition_failed: avail_select_anon is not USING(false) but %, which 027 fixed as CRITICAL', v_qual;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relname='item_availability' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION '192_precondition_failed: RLS is not enabled on item_availability';
  END IF;

  -- 191 must already be in place: this migration is the follow-up its VERIFY
  -- block H demanded.
  IF to_regprocedure('public.phoenix_query_organization_scope_topology(uuid)') IS NULL THEN
    RAISE EXCEPTION '192_precondition_failed: phoenix_query_organization_scope_topology(uuid) is missing (191)';
  END IF;

  -- The public QR surface must exist and be anon-executable BEFORE and AFTER.
  IF to_regprocedure('public.get_public_qr_payload(text)') IS NULL THEN
    RAISE EXCEPTION '192_precondition_failed: get_public_qr_payload(text) is missing (177/188)';
  END IF;
  IF NOT has_function_privilege('anon', 'public.get_public_qr_payload(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '192_precondition_failed: anon cannot execute get_public_qr_payload before convergence';
  END IF;

  -- Refuse to run if anon somehow holds a WRITE privilege: this migration
  -- converges READS only, and silently leaving a write behind would be worse
  -- than failing here.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND grantee='anon' AND privilege_type <> 'SELECT'
  ) THEN
    RAISE EXCEPTION '192_precondition_failed: anon holds a non-SELECT relation privilege; converging reads alone would be misleading';
  END IF;
END;
$preflight$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CONVERGE — revoke every direct anon read. Nothing is granted back.
-- ─────────────────────────────────────────────────────────────────────────────
-- An explicit relkind loop rather than `ON ALL TABLES`: `ALL TABLES` covers
-- ordinary tables, views and foreign tables but NOT materialized views, and the
-- VERIFY below asserts over matviews and partitioned tables too. Looping makes
-- the statement and the assertion cover exactly the same object set, so the
-- proof cannot drift from the action.
DO $converge$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass::text AS ident
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p','v','m','f')
    ORDER BY 1
  LOOP
    EXECUTE format('REVOKE SELECT ON %s FROM anon', r.ident);
  END LOOP;
END;
$converge$;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY — the closed surface must be real, not merely intended.
-- ─────────────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_bad  text;
  v_qual text;
  v_n    integer;
BEGIN
  -- A. THE ALLOWLIST IS EMPTY. No relation of any kind, with no exceptions.
  SELECT string_agg(c.relname || '(' || c.relkind::text || ')', ', ' ORDER BY c.relname)
    INTO v_bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r','p','v','m','f')
    AND has_table_privilege('anon', c.oid, 'SELECT');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (192): anon still holds direct SELECT on: %', v_bad;
  END IF;

  -- B. item_availability IS CLOSED TOO — named explicitly, because it is the one
  --    relation a future reader might assume was kept open.
  IF has_table_privilege('anon', 'public.item_availability', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY FAILED (192): anon still holds direct SELECT on item_availability';
  END IF;

  -- C. 027 IS INTACT. The policy still exists and still denies every row.
  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO v_qual
  FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND c.relname='item_availability'
    AND pol.polname='avail_select_anon';
  IF v_qual IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (192): avail_select_anon policy disappeared';
  END IF;
  IF btrim(v_qual) <> 'false' THEN
    RAISE EXCEPTION 'VERIFY FAILED (192): avail_select_anon is no longer USING(false) but %', v_qual;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='item_availability' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (192): RLS is no longer enabled on item_availability';
  END IF;

  -- D. NO WRITE WIDENING of any shape.
  SELECT string_agg(DISTINCT table_name || ':' || privilege_type, ', ') INTO v_bad
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND grantee = 'anon' AND privilege_type <> 'SELECT';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (192): anon holds non-SELECT relation privileges: %', v_bad;
  END IF;

  -- E. THE DRIFT CANNOT SILENTLY RETURN through default privileges.
  IF EXISTS (
    SELECT 1
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) AS a
    WHERE n.nspname = 'public'
      AND d.defaclobjtype = 'r'
      AND a.grantee <> 0
      AND pg_get_userbyid(a.grantee) = 'anon'
      AND a.privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (192): a default privilege grants anon SELECT on future relations';
  END IF;

  -- F. THE PUBLIC QR SURFACE IS UNTOUCHED — this is what makes an empty
  --    allowlist safe rather than merely strict.
  IF NOT has_function_privilege('anon', 'public.get_public_qr_payload(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (192): anon lost EXECUTE on get_public_qr_payload';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='get_public_qr_payload' AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (192): get_public_qr_payload is no longer SECURITY DEFINER';
  END IF;

  -- G. NO ANON-REACHABLE INVOKER PATH INTO THE DATA. Every FIRST-PARTY routine
  --    anon may execute must be SECURITY DEFINER, so none of them can depend on
  --    the relation grants this migration just removed.
  --
  --    EXTENSION-OWNED functions are excluded via pg_depend, not by name: a
  --    hosted project installs pgcrypto/pg_trgm into the extensions schema,
  --    while the disposable rig installs them into public, where their utilities
  --    (digest, gen_random_uuid, similarity, ...) are PUBLIC-executable by
  --    design. They read no application relation, and policing them here would
  --    assert an environment's extension placement rather than this product's
  --    read surface. Trigger functions are excluded too: they are not callable
  --    as RPCs.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND has_function_privilege('anon', p.oid, 'EXECUTE')
    AND NOT p.prosecdef
    AND pg_get_function_result(p.oid) <> 'trigger'
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_proc'::regclass
        AND d.objid = p.oid
        AND d.deptype = 'e'
    );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (192): anon can execute non-DEFINER first-party routines: %', v_bad;
  END IF;

  -- H. 191 IS UNTOUCHED and remains closed to anon.
  IF to_regprocedure('public.phoenix_query_organization_scope_topology(uuid)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (192): 191''s topology query disappeared';
  END IF;
  IF has_function_privilege('anon',
       'public.phoenix_query_organization_scope_topology(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (192): anon gained EXECUTE on the topology query';
  END IF;

  -- I. AUTHENTICATED KEEPS ITS READS. A convergence that silently locked out the
  --    application would pass every anon assertion above and still be a failure.
  SELECT count(*) INTO v_n
  FROM information_schema.role_table_grants
  WHERE table_schema='public' AND grantee='authenticated' AND privilege_type='SELECT';
  IF v_n < 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED (192): authenticated holds no SELECT privileges at all';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.item_availability', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY FAILED (192): authenticated lost SELECT on item_availability';
  END IF;

  -- J. NO M193+. Where migration bookkeeping exists (Production; the disposable
  --    rig has no such schema), no migration beyond this one may be recorded.
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT string_agg(name, ', ') FROM supabase_migrations.schema_migrations
               WHERE name ~ '^(19[3-9]|[2-9][0-9][0-9])_'$q$ INTO v_bad;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED (192): a migration beyond 192 is already recorded: %', v_bad;
    END IF;
  END IF;
END;
$verify$;

COMMIT;
