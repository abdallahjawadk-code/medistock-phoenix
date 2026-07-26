-- ============================================================================
-- PHOENIX-DEMO-PROFILE-DETACH-142
--
-- Completes demo reversibility. 141 proved that demo ORGANIZATIONS can never
-- be removed while demo PROFILES reference them, and profiles are correctly
-- never purgeable (140 excludes them so actor snapshots and the
-- last-super-admin guard stay intact).
--
-- 142 resolves that WITHOUT deleting a profile and WITHOUT weakening any
-- account guarantee. A demo profile is DETACHED instead: disabled, archived,
-- and unlinked from its organization, while its identity row survives so
-- every historical audit entry it authored still resolves an actor. The
-- profile becomes an inactive audit tombstone, not a deletion.
--
-- WHAT MAY BE DETACHED -- both proofs required, exactly as 141
--   1. profiles.demo_dataset_id = 'PHOENIX_DEMO_V1' (write-once column,
--      CHECK-pinned to one value, settable only via phoenix_demo_mark_row)
--   2. registered in phoenix_demo_manifest under 'profiles'
--   3. its organization is ITSELF demo-created and manifest-registered
--   4. current_user = 'phoenix_demo_purger' (the 141 ownership boundary)
--   5. role <> 'super_admin' -- belt and braces, so the owner account and any
--      last-super-admin can never be reached even if 1-4 were somehow forged
-- A forged manifest entry alone is therefore useless: the marker can only be
-- applied to a profile whose organization is demo-owned, which a genuine
-- profile's real organization never is.
--
-- AUTH ACCOUNTS
--   This migration never writes to auth.users -- not to disable, not to
--   delete. Supabase Auth accounts can only be disabled through the Auth
--   Admin API, which is not reachable from SQL. The rule therefore is:
--   the PRODUCTION seeder must not create login-capable demo accounts. Demo
--   profiles are created with login_mode='local' and no usable credential,
--   and detachment additionally archives them, so a demo user cannot
--   authenticate after a purge. tools/phoenix-demo enforces this.
--
-- PRECONDITIONS: 140 (manifest), 141 (marker mechanism + purger role).
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.phoenix_demo_manifest') IS NULL THEN
    RAISE EXCEPTION '142 PRECONDITION FAILED: 140 manifest missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'phoenix_demo_purger') THEN
    RAISE EXCEPTION '142 PRECONDITION FAILED: 141 purger role missing';
  END IF;
  IF to_regprocedure('public.phoenix_demo_mark_row(text, text, uuid)') IS NULL THEN
    RAISE EXCEPTION '142 PRECONDITION FAILED: 141 marking function missing';
  END IF;
END;
$precond$;

-- ── A. The write-once marker on profiles ────────────────────────────────────

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS demo_dataset_id text;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_demo_dataset_chk;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_demo_dataset_chk
  CHECK (demo_dataset_id IS NULL OR demo_dataset_id = 'PHOENIX_DEMO_V1');
-- NOTE: `authenticated` holds TABLE-level UPDATE on profiles (a user edits
-- their own profile), so a column-level REVOKE cannot take it away. The real
-- boundary here is therefore the write-once TRIGGER below, which refuses ANY
-- change to demo_dataset_id from any caller regardless of grants, and is
-- strictly stronger than a column privilege. anon holds nothing on profiles.
REVOKE UPDATE (demo_dataset_id) ON public.profiles FROM anon;

DROP TRIGGER IF EXISTS profiles_demo_marker_write_once ON public.profiles;
CREATE TRIGGER profiles_demo_marker_write_once
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_demo_marker_is_write_once();

-- ── B. Marking: add 'profiles' to 141's hardcoded allow-list ────────────────

CREATE OR REPLACE FUNCTION public.phoenix_demo_mark_row(
  p_dataset_key text,
  p_table_name  text,
  p_row_id      uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $mark$
DECLARE
  v_org  uuid;
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF public.phoenix_my_role() <> 'super_admin' THEN
    RAISE EXCEPTION 'forbidden_demo_marking' USING ERRCODE = '42501';
  END IF;
  IF p_dataset_key IS DISTINCT FROM 'PHOENIX_DEMO_V1' THEN
    RAISE EXCEPTION 'invalid_demo_dataset_key' USING ERRCODE = '22023';
  END IF;
  IF p_table_name NOT IN (
    'procurement_orders', 'procurement_order_lines', 'procurement_order_events',
    'procurement_receipts', 'procurement_receipt_lines', 'procurement_returns',
    'phoenix_report_snapshots', 'profiles'
  ) THEN
    RAISE EXCEPTION 'table_not_demo_markable' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.phoenix_demo_manifest m
     WHERE m.dataset_key = 'PHOENIX_DEMO_V1'
       AND m.table_name = p_table_name AND m.row_id = p_row_id
  ) THEN
    RAISE EXCEPTION 'row_not_demo_owned' USING ERRCODE = '42501';
  END IF;

  CASE p_table_name
    WHEN 'procurement_orders' THEN
      SELECT organization_id INTO v_org FROM public.procurement_orders WHERE id = p_row_id;
    WHEN 'procurement_order_lines' THEN
      SELECT organization_id INTO v_org FROM public.procurement_order_lines WHERE id = p_row_id;
    WHEN 'procurement_order_events' THEN
      SELECT organization_id INTO v_org FROM public.procurement_order_events WHERE id = p_row_id;
    WHEN 'procurement_receipts' THEN
      SELECT organization_id INTO v_org FROM public.procurement_receipts WHERE id = p_row_id;
    WHEN 'procurement_receipt_lines' THEN
      SELECT organization_id INTO v_org FROM public.procurement_receipt_lines WHERE id = p_row_id;
    WHEN 'procurement_returns' THEN
      SELECT organization_id INTO v_org FROM public.procurement_returns WHERE id = p_row_id;
    WHEN 'phoenix_report_snapshots' THEN
      SELECT organization_id INTO v_org FROM public.phoenix_report_snapshots WHERE id = p_row_id;
    WHEN 'profiles' THEN
      SELECT organization_id, role INTO v_org, v_role FROM public.profiles WHERE id = p_row_id;
      -- A super_admin profile is NEVER demo-markable, so the owner account and
      -- any last-super-admin can never enter the demo lifecycle at all.
      IF v_role = 'super_admin' THEN
        RAISE EXCEPTION 'super_admin_profile_not_demo_markable' USING ERRCODE = '42501';
      END IF;
  END CASE;

  IF v_org IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.phoenix_demo_manifest m
     WHERE m.dataset_key = 'PHOENIX_DEMO_V1'
       AND m.table_name = 'organizations' AND m.row_id = v_org
  ) THEN
    RAISE EXCEPTION 'organization_not_demo_owned' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('phoenix.demo_marking', 'on', true);

  CASE p_table_name
    WHEN 'procurement_orders' THEN
      UPDATE public.procurement_orders SET demo_dataset_id = 'PHOENIX_DEMO_V1'
       WHERE id = p_row_id AND demo_dataset_id IS NULL;
    WHEN 'procurement_order_lines' THEN
      UPDATE public.procurement_order_lines SET demo_dataset_id = 'PHOENIX_DEMO_V1'
       WHERE id = p_row_id AND demo_dataset_id IS NULL;
    WHEN 'procurement_order_events' THEN
      UPDATE public.procurement_order_events SET demo_dataset_id = 'PHOENIX_DEMO_V1'
       WHERE id = p_row_id AND demo_dataset_id IS NULL;
    WHEN 'procurement_receipts' THEN
      UPDATE public.procurement_receipts SET demo_dataset_id = 'PHOENIX_DEMO_V1'
       WHERE id = p_row_id AND demo_dataset_id IS NULL;
    WHEN 'procurement_receipt_lines' THEN
      UPDATE public.procurement_receipt_lines SET demo_dataset_id = 'PHOENIX_DEMO_V1'
       WHERE id = p_row_id AND demo_dataset_id IS NULL;
    WHEN 'procurement_returns' THEN
      UPDATE public.procurement_returns SET demo_dataset_id = 'PHOENIX_DEMO_V1'
       WHERE id = p_row_id AND demo_dataset_id IS NULL;
    WHEN 'phoenix_report_snapshots' THEN
      UPDATE public.phoenix_report_snapshots SET demo_dataset_id = 'PHOENIX_DEMO_V1'
       WHERE id = p_row_id AND demo_dataset_id IS NULL;
    WHEN 'profiles' THEN
      UPDATE public.profiles SET demo_dataset_id = 'PHOENIX_DEMO_V1'
       WHERE id = p_row_id AND demo_dataset_id IS NULL;
  END CASE;

  PERFORM set_config('phoenix.demo_marking', 'off', true);
  RETURN true;
END;
$mark$;

REVOKE ALL ON FUNCTION public.phoenix_demo_mark_row(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_demo_mark_row(text, text, uuid) TO authenticated;

-- ── C. Detachment ───────────────────────────────────────────────────────────
-- Runs inside phoenix_demo_purge, before the organization pass. Deletes only
-- demo-owned auxiliary access rows, then archives + unlinks the profile.
-- The identity row (id, full_name, role) is deliberately preserved so
-- historical audit attribution stays readable, and user_identity_history is
-- never touched.

CREATE OR REPLACE FUNCTION public.phoenix_demo_detach_profiles(p_dry_run boolean)
RETURNS bigint
LANGUAGE plpgsql
-- SECURITY INVOKER ON PURPOSE, exactly as 141's purgeability predicate. The
-- whole boundary rests on current_user being 'phoenix_demo_purger', which is
-- true only when phoenix_demo_purge is the caller. SECURITY DEFINER here
-- would rewrite current_user to this function's own owner and silently
-- defeat the check -- the same defect 141 already had to fix once.
SECURITY INVOKER
SET search_path = public, pg_temp
AS $detach$
DECLARE
  v_ids   uuid[];
  v_count bigint := 0;
BEGIN
  -- The 141 ownership boundary. Unreachable outside phoenix_demo_purge.
  IF current_user <> 'phoenix_demo_purger' THEN
    RAISE EXCEPTION 'forbidden_demo_detach' USING ERRCODE = '42501';
  END IF;

  -- BOTH proofs, plus the demo-owned organization, plus the super_admin
  -- exclusion. A genuine profile can satisfy none of these.
  SELECT coalesce(array_agg(p.id), ARRAY[]::uuid[]) INTO v_ids
    FROM public.profiles p
    JOIN public.phoenix_demo_manifest m
      ON m.dataset_key = 'PHOENIX_DEMO_V1' AND m.table_name = 'profiles' AND m.row_id = p.id
   WHERE p.demo_dataset_id = 'PHOENIX_DEMO_V1'
     AND p.role <> 'super_admin'
     AND p.organization_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.phoenix_demo_manifest o
        WHERE o.dataset_key = 'PHOENIX_DEMO_V1'
          AND o.table_name = 'organizations'
          AND o.row_id = p.organization_id);

  v_count := coalesce(array_length(v_ids, 1), 0);
  IF v_count = 0 OR p_dry_run THEN
    RETURN v_count;
  END IF;

  -- 1. Auxiliary access rows, demo-owned only.
  DELETE FROM public.profile_scope_assignments a WHERE a.profile_id = ANY (v_ids);
  DELETE FROM public.profile_permission_overrides o WHERE o.profile_id = ANY (v_ids);

  -- 2 + 3. Disable, archive and unlink. full_name/role/id are preserved so
  -- every audit row this profile authored still resolves its actor.
  UPDATE public.profiles p
     SET status          = 'archived',
         disabled_at     = COALESCE(p.disabled_at, now()),
         organization_id = NULL
   WHERE p.id = ANY (v_ids);

  RETURN v_count;
END;
$detach$;

REVOKE ALL ON FUNCTION public.phoenix_demo_detach_profiles(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_demo_detach_profiles(boolean) TO phoenix_demo_purger;

GRANT SELECT, UPDATE ON public.profiles TO phoenix_demo_purger;
GRANT SELECT, DELETE ON public.profile_scope_assignments TO phoenix_demo_purger;
GRANT SELECT, DELETE ON public.profile_permission_overrides TO phoenix_demo_purger;

-- The purger is not the owner of these tables, so RLS applies to it. Each
-- policy is scoped so the role can only ever SEE or TOUCH a row belonging to
-- a demo-MARKED profile. A genuine profile is invisible to the purge role
-- entirely, so it cannot be read, counted, or modified even in principle.
-- No BYPASSRLS, no broad grants.
DROP POLICY IF EXISTS profiles_demo_purger_select ON public.profiles;
CREATE POLICY profiles_demo_purger_select
  ON public.profiles FOR SELECT TO phoenix_demo_purger
  USING (demo_dataset_id = 'PHOENIX_DEMO_V1' AND role <> 'super_admin');

DROP POLICY IF EXISTS profiles_demo_purger_update ON public.profiles;
CREATE POLICY profiles_demo_purger_update
  ON public.profiles FOR UPDATE TO phoenix_demo_purger
  USING (demo_dataset_id = 'PHOENIX_DEMO_V1' AND role <> 'super_admin')
  WITH CHECK (demo_dataset_id = 'PHOENIX_DEMO_V1' AND role <> 'super_admin');

DROP POLICY IF EXISTS psa_demo_purger_all ON public.profile_scope_assignments;
CREATE POLICY psa_demo_purger_all
  ON public.profile_scope_assignments FOR ALL TO phoenix_demo_purger
  USING (EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = profile_scope_assignments.profile_id
                    AND p.demo_dataset_id = 'PHOENIX_DEMO_V1'));

DROP POLICY IF EXISTS ppo_demo_purger_all ON public.profile_permission_overrides;
CREATE POLICY ppo_demo_purger_all
  ON public.profile_permission_overrides FOR ALL TO phoenix_demo_purger
  USING (EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = profile_permission_overrides.profile_id
                    AND p.demo_dataset_id = 'PHOENIX_DEMO_V1'));

-- ── D. Wire detachment into the purge, before the organization pass ─────────

CREATE OR REPLACE FUNCTION public.phoenix_demo_purge(
  p_dataset_key text,
  p_dry_run     boolean DEFAULT true
)
RETURNS TABLE (table_name text, affected bigint, executed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $purge$
DECLARE
  v_tables text[] := public.phoenix_demo_purgeable_tables();
  v_table  text;
  v_count  bigint;
  v_ids    uuid[];
  v_org           uuid;
  v_org_deleted   bigint;
  v_block_rows    bigint;
  v_block_tables  bigint;
  v_blocked_orgs  uuid[] := ARRAY[]::uuid[];
  v_detached      bigint;
  v_dry    boolean := COALESCE(p_dry_run, true);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF public.phoenix_my_role() <> 'super_admin' THEN
    RAISE EXCEPTION 'forbidden_demo_purge' USING ERRCODE = '42501';
  END IF;
  IF p_dataset_key IS NULL OR btrim(p_dataset_key) = '' THEN
    RAISE EXCEPTION 'dataset_key_required' USING ERRCODE = '23514';
  END IF;
  IF p_dataset_key <> 'PHOENIX_DEMO_V1' THEN
    RAISE EXCEPTION 'invalid_demo_dataset_key' USING ERRCODE = '22023';
  END IF;

  -- Owned rows in a table that is not purgeable at all: reported, never hidden.
  RETURN QUERY
  SELECT m.table_name, count(*)::bigint, false
    FROM public.phoenix_demo_manifest m
   WHERE m.dataset_key = p_dataset_key
     AND NOT (m.table_name = ANY (v_tables))
     AND m.table_name <> 'profiles'
   GROUP BY m.table_name;

  FOREACH v_table IN ARRAY v_tables LOOP
    IF to_regclass('public.' || quote_ident(v_table)) IS NULL THEN
      CONTINUE;
    END IF;
    v_ids := public.phoenix_demo_manifest_row_ids(v_table);
    IF array_length(v_ids, 1) IS NULL THEN
      CONTINUE;
    END IF;

    IF v_table = 'organizations' THEN
      -- 142: detach demo profiles FIRST, so the preflight below can succeed.
      v_detached := public.phoenix_demo_detach_profiles(v_dry);
      IF v_detached > 0 THEN
        table_name := 'profiles:detached';
        affected   := v_detached;
        executed   := NOT v_dry;
        RETURN NEXT;
      END IF;

      v_org_deleted := 0;
      FOREACH v_org IN ARRAY v_ids LOOP
        -- Re-run the COMPLETE 40-FK preflight AFTER detachment.
        SELECT coalesce(sum(b.reference_count), 0), count(*)
          INTO v_block_rows, v_block_tables
          FROM public.phoenix_demo_org_blockers(v_org) b;

        IF v_block_tables > 0 THEN
          IF NOT v_dry THEN
            table_name := 'organizations:blocked';
            affected   := v_block_rows;
            executed   := false;
            RETURN NEXT;
          END IF;
          v_blocked_orgs := array_append(v_blocked_orgs, v_org);
          CONTINUE;
        END IF;

        IF NOT v_dry THEN
          DELETE FROM public.organizations o WHERE o.id = v_org;
        END IF;
        v_org_deleted := v_org_deleted + 1;
      END LOOP;

      IF v_org_deleted > 0 THEN
        table_name := 'organizations';
        affected   := v_org_deleted;
        executed   := NOT v_dry;
        RETURN NEXT;
      END IF;
      CONTINUE;
    END IF;

    IF v_dry THEN
      EXECUTE format('SELECT count(*)::bigint FROM public.%I t WHERE t.id = ANY($1)', v_table)
        INTO v_count USING v_ids;
    ELSE
      BEGIN
        EXECUTE format(
          'WITH deleted AS (DELETE FROM public.%I t WHERE t.id = ANY($1) RETURNING 1)
           SELECT count(*)::bigint FROM deleted', v_table)
          INTO v_count USING v_ids;
      EXCEPTION
        WHEN foreign_key_violation THEN
          table_name := v_table;
          affected   := 0;
          executed   := false;
          RETURN NEXT;
          CONTINUE;
      END;
    END IF;

    IF v_count > 0 THEN
      table_name := v_table;
      affected   := v_count;
      executed   := NOT v_dry;
      RETURN NEXT;
    END IF;
  END LOOP;

  IF NOT v_dry THEN
    -- Forget ownership only of rows genuinely gone. Blocked organizations keep
    -- their entry so the purge stays resumable. Detached profiles keep theirs
    -- too: the tombstone still belongs to the dataset and must stay auditable.
    DELETE FROM public.phoenix_demo_manifest m
     WHERE m.dataset_key = p_dataset_key
       AND m.table_name = ANY (v_tables)
       AND NOT (m.table_name = 'organizations' AND m.row_id = ANY (v_blocked_orgs));
  END IF;
END;
$purge$;

ALTER FUNCTION public.phoenix_demo_purge(text, boolean) OWNER TO phoenix_demo_purger;
REVOKE ALL ON FUNCTION public.phoenix_demo_purge(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_demo_purge(text, boolean) TO authenticated;

DO $verify$
DECLARE
  v_src text;
  v_n   integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='profiles' AND column_name='demo_dataset_id'
  ) THEN
    RAISE EXCEPTION '142 VERIFY FAILED: profiles.demo_dataset_id missing';
  END IF;

  -- The marker's protection is the write-once trigger, not a column grant
  -- (see the note above). Assert the trigger is actually attached.
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.profiles'::regclass
     AND tgname = 'profiles_demo_marker_write_once'
     AND NOT tgisinternal;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '142 VERIFY FAILED: profiles write-once marker trigger missing';
  END IF;

  SELECT pg_get_functiondef(to_regprocedure('public.phoenix_demo_detach_profiles(boolean)')) INTO v_src;
  IF position('phoenix_demo_purger' IN v_src) = 0
     OR position('super_admin' IN v_src) = 0
     OR position('demo_dataset_id' IN v_src) = 0 THEN
    RAISE EXCEPTION '142 VERIFY FAILED: detach lost the ownership boundary, the super_admin exclusion, or the marker requirement';
  END IF;
  -- Detachment must never DELETE a profile, and never touch identity history.
  IF v_src ~* 'DELETE\s+FROM\s+public\.profiles'
     OR v_src ~* 'user_identity_history' THEN
    RAISE EXCEPTION '142 VERIFY FAILED: detach must not delete profiles or touch identity history';
  END IF;
  -- Never write to auth.users from SQL.
  IF v_src ~* 'auth\.users' THEN
    RAISE EXCEPTION '142 VERIFY FAILED: detach must never write to auth.users';
  END IF;

  SELECT pg_get_functiondef(to_regprocedure('public.phoenix_demo_mark_row(text, text, uuid)')) INTO v_src;
  IF position('super_admin_profile_not_demo_markable' IN v_src) = 0 THEN
    RAISE EXCEPTION '142 VERIFY FAILED: marking must refuse super_admin profiles';
  END IF;

  SELECT pg_get_functiondef(to_regprocedure('public.phoenix_demo_purge(text, boolean)')) INTO v_src;
  IF position('profiles:detached' IN v_src) = 0
     OR position('organizations:blocked' IN v_src) = 0 THEN
    RAISE EXCEPTION '142 VERIFY FAILED: purge output must distinguish detached and blocked outcomes';
  END IF;

  RAISE NOTICE 'PHOENIX-DEMO-PROFILE-DETACH-142: verified.';
END;
$verify$;

COMMIT;
