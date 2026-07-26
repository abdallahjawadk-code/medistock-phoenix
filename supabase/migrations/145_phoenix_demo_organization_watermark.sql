-- ============================================================================
-- PHOENIX-DEMO-ORGANIZATION-WATERMARK-145
--
-- Mission requirement (PHOENIX_DEMO_V1 dataset contract): "Keep demo report
-- snapshots visibly watermarked: تجريبي — غير رسمي. Remain excluded from
-- official totals unless explicitly selected." Nothing in the schema or the
-- frontend currently lets a report screen ask "is this organization part of
-- the demo dataset?" — the 140-144 demo-manifest machinery is entirely
-- super_admin-scoped (register/summary/purge), so an ordinary authenticated
-- user viewing their own org's Report Library has no way to know.
--
-- This migration adds exactly ONE narrow, read-only, non-sensitive check:
-- whether a given organization id is registered in the demo manifest under
-- PHOENIX_DEMO_V1. It reveals nothing about the manifest's contents beyond
-- that single boolean (no row ids, no seed keys, no table names), and demo
-- organizations already carry a self-describing name/code
-- (`name_ar` contains 'تجريبي', `code` matches 'demo-org-%') visible to
-- anyone who can already see the organization at all — this RPC only saves
-- the frontend from re-deriving that from string matching.
--
-- PRECONDITIONS: 140 (manifest).
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.phoenix_demo_manifest') IS NULL THEN
    RAISE EXCEPTION '145 PRECONDITION FAILED: 140 manifest missing';
  END IF;
END;
$precond$;

CREATE OR REPLACE FUNCTION public.phoenix_is_demo_organization(p_organization_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $is_demo$
BEGIN
  -- Same belt-and-suspenders convention as every other SECURITY DEFINER RPC
  -- in this codebase: the REVOKE FROM anon/PUBLIC already blocks an
  -- unauthenticated caller at the grant layer, but a genuine caller context
  -- is required explicitly too, never assumed from role membership alone.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.phoenix_demo_manifest m
     WHERE m.dataset_key = 'PHOENIX_DEMO_V1'
       AND m.table_name = 'organizations'
       AND m.row_id = p_organization_id
  );
END;
$is_demo$;

REVOKE ALL ON FUNCTION public.phoenix_is_demo_organization(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_is_demo_organization(uuid) TO authenticated;

DO $verify$
DECLARE
  v_n integer;
BEGIN
  -- authenticated may call it; anon must not.
  SELECT count(*) INTO v_n FROM information_schema.role_routine_grants
   WHERE routine_name = 'phoenix_is_demo_organization' AND grantee = 'authenticated' AND privilege_type = 'EXECUTE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '145 VERIFY FAILED: authenticated must hold EXECUTE on phoenix_is_demo_organization';
  END IF;
  SELECT count(*) INTO v_n FROM information_schema.role_routine_grants
   WHERE routine_name = 'phoenix_is_demo_organization' AND grantee IN ('anon', 'PUBLIC') AND privilege_type = 'EXECUTE';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '145 VERIFY FAILED: anon/PUBLIC must not hold EXECUTE on phoenix_is_demo_organization';
  END IF;

  -- A fake local auth context so this verify block can exercise the actual
  -- runtime behaviour (not just grants/source text) without leaving the
  -- migration's own session authenticated afterwards — request.jwt.claim.sub
  -- is session-local via set_config(..., true) and this whole DO block runs
  -- inside the migration's single transaction.
  PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);

  -- A random, never-registered id must read as false, not error.
  IF public.phoenix_is_demo_organization(gen_random_uuid()) IS DISTINCT FROM false THEN
    RAISE EXCEPTION '145 VERIFY FAILED: an unregistered organization id must read as false';
  END IF;
  IF public.phoenix_is_demo_organization(NULL) IS DISTINCT FROM false THEN
    RAISE EXCEPTION '145 VERIFY FAILED: NULL must read as false, not error or NULL';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.phoenix_is_demo_organization(gen_random_uuid());
    RAISE EXCEPTION '145 VERIFY FAILED: an unauthenticated caller must be refused, not silently answered';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE <> '28000' THEN
        RAISE;
      END IF;
  END;

  RAISE NOTICE 'PHOENIX-DEMO-ORGANIZATION-WATERMARK-145: verified.';
END;
$verify$;

COMMIT;
