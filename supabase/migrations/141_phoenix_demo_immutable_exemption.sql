-- ============================================================================
-- PHOENIX-DEMO-IMMUTABLE-EXEMPTION-141
--
-- A STRICTLY SCOPED deletion exemption for demo-owned rows in the two
-- immutable record families -- procurement history (087) and official report
-- snapshots (119). This is NOT a relaxation of either guarantee: for every
-- genuine row, UPDATE and DELETE remain refused exactly as before, with the
-- same error and the same errcode.
--
-- THE INVARIANT THAT MAKES THIS SAFE
-- A row becomes deletable only if ALL of these hold simultaneously:
--   1. OLD.demo_dataset_id = 'PHOENIX_DEMO_V1' (a column CHECK means no other
--      value is storable, so genuine rows are permanently NULL)
--   2. the row id is registered in phoenix_demo_manifest for that dataset
--   3. the row's organization_id is ITSELF a demo-created organization,
--      registered in the same manifest -- a genuine organization's records
--      can therefore never qualify, whatever else is forged
--   4. current_user = 'phoenix_demo_purger', a NOLOGIN role that owns
--      phoenix_demo_purge. That current_user is only reachable inside that
--      SECURITY DEFINER function; `authenticated` holds no membership, so it
--      can neither SET ROLE to it nor forge it. An ownership boundary, not a
--      GUC a caller could set.
--   5. the purge already validated super_admin and the dataset key
--   6. TG_OP = 'DELETE' -- UPDATE stays forbidden for demo rows too
--
-- Condition 3 is load-bearing. The marker is only settable by
-- phoenix_demo_mark_row, which refuses any row whose organization is not
-- demo-owned. "Insert a fake manifest row to make a real record purgeable"
-- therefore fails: the real record's real organization is not in the
-- manifest, so the marker can never be set and condition 1 fails forever.
--
-- The marker is write-once, so a genuine row can never be relabelled into
-- the demo dataset and a demo row can never be laundered into a genuine one.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.phoenix_demo_manifest') IS NULL THEN
    RAISE EXCEPTION '141 PRECONDITION FAILED: phoenix_demo_manifest missing -- apply 140 first';
  END IF;
  IF to_regprocedure('public.phoenix_procurement_forbid_mutation()') IS NULL THEN
    RAISE EXCEPTION '141 PRECONDITION FAILED: 087 procurement immutability trigger missing';
  END IF;
  IF to_regprocedure('public.phoenix_forbid_report_snapshot_mutation()') IS NULL THEN
    RAISE EXCEPTION '141 PRECONDITION FAILED: 119 snapshot immutability trigger missing';
  END IF;
END;
$precond$;

-- A. The dedicated ownership boundary. NOLOGIN, NOINHERIT, no membership
-- granted to any application role. Its only purpose is to own
-- phoenix_demo_purge so current_user inside it is a value no application
-- role can produce.

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'phoenix_demo_purger') THEN
    CREATE ROLE phoenix_demo_purger NOLOGIN NOINHERIT;
  END IF;
END;
$role$;

-- ALTER FUNCTION ... OWNER TO requires the CURRENT connecting role to either
-- be a literal Postgres superuser or hold membership in the target role.
-- Supabase's own "postgres" role is deliberately NOT a literal superuser
-- (true on the real platform, and `supabase start`'s local stack
-- intentionally mirrors it) -- only a self-hosted raw Postgres superuser
-- connection has unconditional SET ROLE to any role, which is why this
-- migration's ownership transfer below only ever worked against a
-- disposable rig connected as a genuine superuser and failed everywhere
-- closer to production shape with "must be able to SET ROLE
-- phoenix_demo_purger" (42501). Granting membership here -- to whichever
-- role is APPLYING this migration, never to authenticated/anon/
-- service_role, verified below and in this migration's own verify block --
-- is exactly what a normal admin/deploy role needs to manage this object's
-- ownership, now and in 142/143 which both re-assert it. This does not
-- weaken the ownership boundary: current_user = 'phoenix_demo_purger' is
-- still unreachable from any application-facing role, and whoever applies
-- migrations already has unrestricted authority over this database in
-- every other respect. No SUPERUSER/BYPASSRLS is granted anywhere, and
-- phoenix_demo_purger itself remains NOLOGIN/NOINHERIT.
GRANT phoenix_demo_purger TO CURRENT_USER;

GRANT USAGE ON SCHEMA public TO phoenix_demo_purger;
-- phoenix_demo_purge re-validates auth.uid() and phoenix_my_role() inside its
-- own body, so the owning role needs to resolve those. This grants schema
-- traversal only -- no table privileges in auth are granted anywhere.
GRANT USAGE ON SCHEMA auth TO phoenix_demo_purger;

-- B. The write-once demo marker.

DO $cols$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'procurement_orders', 'procurement_order_lines', 'procurement_order_events',
    'procurement_receipts', 'procurement_receipt_lines', 'procurement_returns',
    'phoenix_report_snapshots'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS demo_dataset_id text', t);
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_demo_dataset_chk');
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (demo_dataset_id IS NULL OR demo_dataset_id = ''PHOENIX_DEMO_V1'')',
      t, t || '_demo_dataset_chk');
    EXECUTE format('REVOKE UPDATE (demo_dataset_id) ON public.%I FROM authenticated', t);
    EXECUTE format('REVOKE UPDATE (demo_dataset_id) ON public.%I FROM anon', t);
  END LOOP;
END;
$cols$;

CREATE OR REPLACE FUNCTION public.phoenix_demo_marker_is_write_once()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $marker$
BEGIN
  IF NEW.demo_dataset_id IS DISTINCT FROM OLD.demo_dataset_id THEN
    -- The ONLY permitted transition: NULL -> the one legal value, performed
    -- inside phoenix_demo_mark_row (which requires super_admin + manifest
    -- membership + a demo-owned organization). The flag is transaction-local
    -- and set nowhere else.
    IF OLD.demo_dataset_id IS NULL
       AND NEW.demo_dataset_id = 'PHOENIX_DEMO_V1'
       AND current_setting('phoenix.demo_marking', true) = 'on' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'demo_dataset_marker_is_write_once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$marker$;

REVOKE ALL ON FUNCTION public.phoenix_demo_marker_is_write_once() FROM PUBLIC;

DO $mtrig$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'procurement_orders', 'procurement_order_lines', 'procurement_order_events',
    'procurement_receipts', 'procurement_receipt_lines', 'procurement_returns',
    'phoenix_report_snapshots'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_demo_marker_write_once', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.phoenix_demo_marker_is_write_once()',
      t || '_demo_marker_write_once', t);
  END LOOP;
END;
$mtrig$;

-- C. The single predicate both immutability triggers consult.

CREATE OR REPLACE FUNCTION public.phoenix_demo_row_is_purgeable(
  p_table text,
  p_row_id uuid,
  p_marker text,
  p_organization_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
-- SECURITY INVOKER ON PURPOSE. The whole check rests on current_user being
-- 'phoenix_demo_purger', which is only true when the caller is
-- phoenix_demo_purge. A SECURITY DEFINER here would rewrite current_user to
-- this function's own owner and silently defeat the boundary.
SECURITY INVOKER
SET search_path = public, pg_temp
AS $purgeable$
BEGIN
  IF current_user <> 'phoenix_demo_purger' THEN
    RETURN false;
  END IF;
  IF p_marker IS DISTINCT FROM 'PHOENIX_DEMO_V1' THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.phoenix_demo_manifest m
     WHERE m.dataset_key = 'PHOENIX_DEMO_V1'
       AND m.table_name = p_table
       AND m.row_id = p_row_id
  ) THEN
    RETURN false;
  END IF;
  IF p_organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.phoenix_demo_manifest m
     WHERE m.dataset_key = 'PHOENIX_DEMO_V1'
       AND m.table_name = 'organizations'
       AND m.row_id = p_organization_id
  ) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$purgeable$;

REVOKE ALL ON FUNCTION public.phoenix_demo_row_is_purgeable(text, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_demo_row_is_purgeable(text, uuid, text, uuid) TO phoenix_demo_purger;
GRANT EXECUTE ON FUNCTION public.phoenix_demo_purgeable_tables() TO phoenix_demo_purger;
GRANT EXECUTE ON FUNCTION public.phoenix_my_role() TO phoenix_demo_purger;

-- D. Procurement history (087). The ONLY change is the DELETE branch; every
-- other path, including every UPDATE path, is preserved verbatim.

CREATE OR REPLACE FUNCTION public.phoenix_procurement_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $immutable$
BEGIN
  -- 141 ADDITION 1: the write-once marking transition (NULL -> the one legal
  -- value). Everything else about the row must be byte-identical, so this can
  -- never smuggle a content edit through.
  IF TG_OP = 'UPDATE'
     AND current_setting('phoenix.demo_marking', true) = 'on'
     AND OLD.demo_dataset_id IS NULL
     AND NEW.demo_dataset_id = 'PHOENIX_DEMO_V1'
     AND to_jsonb(NEW) - 'demo_dataset_id' = to_jsonb(OLD) - 'demo_dataset_id' THEN
    RETURN NEW;
  END IF;

  -- 141 ADDITION 2: the narrow DELETE-only demo exemption.
  IF TG_OP = 'DELETE'
     AND public.phoenix_demo_row_is_purgeable(
           TG_TABLE_NAME, OLD.id, OLD.demo_dataset_id, OLD.organization_id) THEN
    RETURN OLD;
  END IF;

  -- ---- 087's ORIGINAL BODY BELOW, VERBATIM --------------------------------
  -- The ONE sanctioned update: the write RPC stamps ledger pointers onto a
  -- history row it created in the same transaction -- receipt lines get their
  -- warehouse_stock_id + movement_id, returns get their movement_id. The
  -- pointer may only be FILLED (NULL -> value), never changed afterwards.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'procurement_receipt_lines' THEN
    IF NEW.id = OLD.id
       AND to_jsonb(NEW) - 'warehouse_stock_id' - 'movement_id'
           = to_jsonb(OLD) - 'warehouse_stock_id' - 'movement_id'
       AND OLD.warehouse_stock_id IS NULL AND OLD.movement_id IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'procurement_returns' THEN
    IF NEW.id = OLD.id
       AND to_jsonb(NEW) - 'movement_id' = to_jsonb(OLD) - 'movement_id'
       AND OLD.movement_id IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'procurement_history_is_immutable' USING ERRCODE = '42501';
END;
$immutable$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_forbid_mutation() FROM PUBLIC;

-- NOTE: procurement_order_events deliberately does NOT get an immutability
-- trigger here. 087 never made that table immutable, and 141's job is to
-- EXEMPT demo rows from existing guarantees -- never to extend immutability to
-- a table that did not have it. Adding one broke a legitimate existing flow
-- (117's sub-purchase duplicate-candidate test) and was reverted. The table is
-- still purge-safe: it sits ahead of procurement_orders in the allow-list, so
-- its rows are removed before the parent they RESTRICT.

-- E. Official report snapshots (119).

CREATE OR REPLACE FUNCTION public.phoenix_forbid_report_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $snap$
BEGIN
  -- The marking transition (NULL -> the one legal value) must pass, or the
  -- row could never be marked at all. Everything else about the row must be
  -- byte-identical, so this can never smuggle a content edit through.
  IF TG_OP = 'UPDATE'
     AND current_setting('phoenix.demo_marking', true) = 'on'
     AND OLD.demo_dataset_id IS NULL
     AND NEW.demo_dataset_id = 'PHOENIX_DEMO_V1'
     AND to_jsonb(NEW) - 'demo_dataset_id' = to_jsonb(OLD) - 'demo_dataset_id' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE'
     AND public.phoenix_demo_row_is_purgeable(
           TG_TABLE_NAME, OLD.id, OLD.demo_dataset_id, OLD.organization_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'report_snapshot_is_immutable' USING ERRCODE = '42501';
END;
$snap$;

REVOKE ALL ON FUNCTION public.phoenix_forbid_report_snapshot_mutation() FROM PUBLIC;

-- F. Marking: super_admin only, demo-owned organizations only, hardcoded
-- allow-list, no dynamic table name in any statement.

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
  v_org uuid;
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
    'phoenix_report_snapshots'
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
  END CASE;

  PERFORM set_config('phoenix.demo_marking', 'off', true);
  RETURN true;
END;
$mark$;

REVOKE ALL ON FUNCTION public.phoenix_demo_mark_row(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_demo_mark_row(text, text, uuid) TO authenticated;

-- G. Hand phoenix_demo_purge the ownership boundary. Its body (hardcoded
-- allow-list, super_admin check, dry-run default) is unchanged from 140;
-- only its OWNER changes, which is what makes current_user =
-- 'phoenix_demo_purger' true inside it and nowhere else.

ALTER FUNCTION public.phoenix_demo_purge(text, boolean) OWNER TO phoenix_demo_purger;

-- The purge now executes as phoenix_demo_purger rather than as the migration
-- owner, so it needs SELECT+DELETE on exactly the tables its own hardcoded
-- allow-list names -- derived from that list so the two can never drift.
DO $grants$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY public.phoenix_demo_purgeable_tables() LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, DELETE ON public.%I TO phoenix_demo_purger', t);
    END IF;
  END LOOP;
END;
$grants$;

GRANT SELECT, DELETE ON public.procurement_orders TO phoenix_demo_purger;
GRANT SELECT, DELETE ON public.procurement_order_lines TO phoenix_demo_purger;
GRANT SELECT, DELETE ON public.procurement_order_events TO phoenix_demo_purger;
GRANT SELECT, DELETE ON public.procurement_receipts TO phoenix_demo_purger;
GRANT SELECT, DELETE ON public.procurement_receipt_lines TO phoenix_demo_purger;
GRANT SELECT, DELETE ON public.procurement_returns TO phoenix_demo_purger;
GRANT SELECT, DELETE ON public.phoenix_report_snapshots TO phoenix_demo_purger;
GRANT SELECT, DELETE ON public.phoenix_demo_manifest TO phoenix_demo_purger;

-- phoenix_demo_purge no longer runs as the manifest's owner, so RLS now
-- applies to it. 140's only policy targets `authenticated`, which this role
-- is not, so without a policy of its own the purge would silently see zero
-- manifest rows and delete nothing. Scoped to the one dataset key, and the
-- role is unreachable by any application user.
DROP POLICY IF EXISTS phoenix_demo_manifest_purger_read ON public.phoenix_demo_manifest;
CREATE POLICY phoenix_demo_manifest_purger_read
  ON public.phoenix_demo_manifest
  FOR SELECT TO phoenix_demo_purger
  USING (dataset_key = 'PHOENIX_DEMO_V1');

DROP POLICY IF EXISTS phoenix_demo_manifest_purger_delete ON public.phoenix_demo_manifest;
CREATE POLICY phoenix_demo_manifest_purger_delete
  ON public.phoenix_demo_manifest
  FOR DELETE TO phoenix_demo_purger
  USING (dataset_key = 'PHOENIX_DEMO_V1');
GRANT SELECT ON public.profiles TO phoenix_demo_purger;


-- The purge no longer runs as the manifest's owner, so its manifest reads are
-- subject to RLS. Rather than widen the manifest's policies (which would
-- expand what the purger role can see generally), the purge reads ownership
-- through this narrow SECURITY DEFINER accessor: it returns only row ids, only
-- for the one dataset key, only for a table on the hardcoded allow-list.
-- current_user is unaffected, so the immutability triggers still see
-- 'phoenix_demo_purger' and the ownership boundary is untouched.
CREATE OR REPLACE FUNCTION public.phoenix_demo_manifest_row_ids(p_table text)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $ids$
  SELECT COALESCE(array_agg(m.row_id), ARRAY[]::uuid[])
    FROM public.phoenix_demo_manifest m
   WHERE m.dataset_key = 'PHOENIX_DEMO_V1'
     AND m.table_name = p_table
     AND p_table = ANY (public.phoenix_demo_purgeable_tables());
$ids$;

REVOKE ALL ON FUNCTION public.phoenix_demo_manifest_row_ids(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_demo_manifest_row_ids(text) TO phoenix_demo_purger;

-- Rewrite phoenix_demo_purge's two row-set queries to use that accessor. The
-- hardcoded allow-list, the super_admin check and the dry-run default are all
-- unchanged from 140.
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

  RETURN QUERY
  SELECT m.table_name, count(*)::bigint, false
    FROM public.phoenix_demo_manifest m
   WHERE m.dataset_key = p_dataset_key
     AND NOT (m.table_name = ANY (v_tables))
   GROUP BY m.table_name;

  FOREACH v_table IN ARRAY v_tables LOOP
    IF to_regclass('public.' || quote_ident(v_table)) IS NULL THEN
      CONTINUE;
    END IF;
    v_ids := public.phoenix_demo_manifest_row_ids(v_table);
    IF array_length(v_ids, 1) IS NULL THEN
      CONTINUE;
    END IF;

    -- ORGANIZATIONS are handled one at a time, behind the reviewed FK
    -- preflight. Anything still referencing an org blocks that org only --
    -- every other organization in the dataset is still purged.
    IF v_table = 'organizations' THEN
      v_org_deleted := 0;
      FOREACH v_org IN ARRAY v_ids LOOP
        SELECT coalesce(sum(b.reference_count), 0), count(*)
          INTO v_block_rows, v_block_tables
          FROM public.phoenix_demo_org_blockers(v_org) b;

        IF v_block_tables > 0 THEN
          IF NOT v_dry THEN
            -- Keep the manifest entry so the purge stays resumable: a later
            -- run finishes the job once the blocking child is gone.
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
          v_org_deleted := v_org_deleted + 1;
        ELSE
          v_org_deleted := v_org_deleted + 1;
        END IF;
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
      -- A parent the dataset owns can still be pinned by a child it does NOT
      -- own (a genuine row, or a demo row a previous partial run left behind).
      -- That refusal is correct and must be preserved -- but it must be
      -- REPORTED, not allowed to abort the whole purge, or one blocked table
      -- would silently roll back every other table's legitimate deletion.
      BEGIN
        EXECUTE format(
          'WITH deleted AS (DELETE FROM public.%I t WHERE t.id = ANY($1) RETURNING 1)
           SELECT count(*)::bigint FROM deleted', v_table)
          INTO v_count USING v_ids;
      EXCEPTION
        WHEN foreign_key_violation THEN
          -- Surface it as a blocked table with zero affected rows.
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
    -- Only forget ownership of rows that are genuinely gone. A row still
    -- present (because its table was blocked) keeps its manifest entry, so a
    -- later purge can finish the job and `verify` still reports it honestly.
    -- Forget ownership only of rows that are genuinely gone. A blocked
    -- organization keeps its entry so the purge is resumable and `verify`
    -- keeps reporting it honestly.
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


-- ── H. Row visibility for the purger, scoped to demo-owned rows only ────────
-- phoenix_demo_purge no longer runs as the tables' owner, so RLS now applies
-- to it. Without a policy it sees ZERO rows and silently deletes nothing
-- (exactly the symptom the positive-case test caught). The fix is deliberately
-- the narrowest possible one, and is strictly SAFER than the previous
-- owner-bypass behaviour:
--
--   * NO BYPASSRLS is granted anywhere.
--   * NO broad table privilege is granted: the role already has only
--     SELECT+DELETE on the allow-listed tables.
--   * Each policy is scoped so the purger can only ever SEE a row that this
--     dataset owns. A genuine row is invisible to the purge role entirely,
--     so it cannot be counted, reported, or deleted even in principle.
--   * For the seven immutable tables the scope ALSO requires the write-once
--     demo marker, so those need both marker and manifest ownership.
--
-- The DELETE itself still executes as phoenix_demo_purger, so the 087/119
-- immutability triggers remain the authoritative check.
DO $policies$
DECLARE
  t          text;
  has_marker boolean;
  using_expr text;
BEGIN
  FOREACH t IN ARRAY public.phoenix_demo_purgeable_tables() LOOP
    CONTINUE WHEN to_regclass('public.' || quote_ident(t)) IS NULL;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t AND column_name = 'demo_dataset_id'
    ) INTO has_marker;

    using_expr := format(
      'EXISTS (SELECT 1 FROM public.phoenix_demo_manifest m
                WHERE m.dataset_key = ''PHOENIX_DEMO_V1''
                  AND m.table_name = %L
                  AND m.row_id = %I.id)', t, t);

    IF has_marker THEN
      using_expr := using_expr || format(' AND %I.demo_dataset_id = ''PHOENIX_DEMO_V1''', t);
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_demo_purger_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_demo_purger_delete', t);

    -- Only meaningful where RLS is actually enabled; harmless otherwise.
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO phoenix_demo_purger USING (%s)',
      t || '_demo_purger_select', t, using_expr);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO phoenix_demo_purger USING (%s)',
      t || '_demo_purger_delete', t, using_expr);
  END LOOP;
END;
$policies$;


-- ── I. Organization deletion preflight ──────────────────────────────────────
-- Derived during development from pg_constraint (every FK whose confrelid is
-- public.organizations) and then FROZEN here as a reviewed, hardcoded list.
-- There is no dynamic table discovery at run time: each statement below names
-- exactly one relation and one column, both literals.
--
-- THE RULE: after every child-table purge pass has run, an organization is
-- deleted only if NOTHING references it -- manifest-owned or not. An owned
-- child that is still present is itself evidence the purge is incomplete, so
-- it must block its parent rather than be ignored. Deferred FK behaviour is
-- never relied upon: the check happens BEFORE the delete is attempted.
CREATE OR REPLACE FUNCTION public.phoenix_demo_org_blockers(p_org_id uuid)
RETURNS TABLE (referencing_table text, reference_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $blockers$
DECLARE
  v_n bigint;
BEGIN
  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.audit_logs WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'audit_logs'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.distribution_points') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.distribution_points WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'distribution_points'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.institution_item_status_reports') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.institution_item_status_reports WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'institution_item_status_reports'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.inter_org_alert_states') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.inter_org_alert_states WHERE source_organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'inter_org_alert_states'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.inter_org_alert_states') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.inter_org_alert_states WHERE target_organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'inter_org_alert_states'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.inter_org_exchange_events') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.inter_org_exchange_events WHERE actor_org_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'inter_org_exchange_events'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.inter_org_exchange_requests') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.inter_org_exchange_requests WHERE source_organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'inter_org_exchange_requests'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.inter_org_exchange_requests') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.inter_org_exchange_requests WHERE target_organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'inter_org_exchange_requests'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.inventory_alerts') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.inventory_alerts WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'inventory_alerts'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.inventory_signal_thresholds') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.inventory_signal_thresholds WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'inventory_signal_thresholds'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.inventory_status_reports') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.inventory_status_reports WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'inventory_status_reports'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.inventory_transfer_suggestions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.inventory_transfer_suggestions WHERE source_organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'inventory_transfer_suggestions'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.inventory_transfer_suggestions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.inventory_transfer_suggestions WHERE target_organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'inventory_transfer_suggestions'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.item_availability') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.item_availability WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'item_availability'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.item_availability_movements') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.item_availability_movements WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'item_availability_movements'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.local_items') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.local_items WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'local_items'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.organization_status_contacts') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.organization_status_contacts WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'organization_status_contacts'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.outlet_stock') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.outlet_stock WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'outlet_stock'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.phoenix_dispatch_line_requests') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.phoenix_dispatch_line_requests WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'phoenix_dispatch_line_requests'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.phoenix_movement_dispense_context') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.phoenix_movement_dispense_context WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'phoenix_movement_dispense_context'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.phoenix_movement_events') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.phoenix_movement_events WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'phoenix_movement_events'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.phoenix_notifications') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.phoenix_notifications WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'phoenix_notifications'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.phoenix_paper_references') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.phoenix_paper_references WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'phoenix_paper_references'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.phoenix_report_snapshots') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.phoenix_report_snapshots WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'phoenix_report_snapshots'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.phoenix_stock_correction_requests') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.phoenix_stock_correction_requests WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'phoenix_stock_correction_requests'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.phoenix_variance_approval_policy') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.phoenix_variance_approval_policy WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'phoenix_variance_approval_policy'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.phoenix_warehouse_correction_requests') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.phoenix_warehouse_correction_requests WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'phoenix_warehouse_correction_requests'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.platform_broadcast_acknowledgements') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.platform_broadcast_acknowledgements WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'platform_broadcast_acknowledgements'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.platform_broadcast_targets') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.platform_broadcast_targets WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'platform_broadcast_targets'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.procurement_suppliers') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.procurement_suppliers WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'procurement_suppliers'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.profile_permission_overrides') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.profile_permission_overrides WHERE scope_organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'profile_permission_overrides'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.profile_scope_assignments') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.profile_scope_assignments WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'profile_scope_assignments'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.profiles') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.profiles WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'profiles'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.qr_targets') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.qr_targets WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'qr_targets'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.qr_tokens') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.qr_tokens WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'qr_tokens'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.stocktakes') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.stocktakes WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'stocktakes'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.user_identity_history') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.user_identity_history WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'user_identity_history'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.warehouse_dispatches') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.warehouse_dispatches WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'warehouse_dispatches'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.warehouse_stock') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.warehouse_stock WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'warehouse_stock'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
  IF to_regclass('public.warehouses') IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::bigint FROM public.warehouses WHERE organization_id = $1' INTO v_n USING p_org_id;
    IF v_n > 0 THEN referencing_table := 'warehouses'; reference_count := v_n; RETURN NEXT; END IF;
  END IF;
END;
$blockers$;

REVOKE ALL ON FUNCTION public.phoenix_demo_org_blockers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_demo_org_blockers(uuid) TO phoenix_demo_purger;

DO $verify$
DECLARE
  v_src text;
  v_n   integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='phoenix_demo_purger' AND rolcanlogin = false AND rolinherit = false) THEN
    RAISE EXCEPTION '141 VERIFY FAILED: phoenix_demo_purger must exist and be NOLOGIN/NOINHERIT';
  END IF;

  SELECT count(*) INTO v_n FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.roleid
    JOIN pg_roles g ON g.oid = m.member
   WHERE r.rolname = 'phoenix_demo_purger' AND g.rolname IN ('authenticated','anon','service_role');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '141 VERIFY FAILED: authenticated/anon/service_role must not be members of phoenix_demo_purger';
  END IF;

  -- The migration-applying role must now be a member -- this is the exact
  -- fix: without it, the ALTER FUNCTION ... OWNER TO below is what fails
  -- with "must be able to SET ROLE phoenix_demo_purger" against any
  -- connecting role that is not a literal Postgres superuser (Supabase's
  -- own "postgres" role included).
  IF NOT pg_has_role(current_user, 'phoenix_demo_purger', 'member') THEN
    RAISE EXCEPTION '141 VERIFY FAILED: the migration-applying role must hold membership in phoenix_demo_purger (the ownership-transfer fix did not take effect)';
  END IF;

  -- phoenix_demo_purger itself must never have been granted anything
  -- broader than schema traversal + the narrow object grants this
  -- migration issues elsewhere -- no SUPERUSER/BYPASSRLS/CREATEROLE, ever.
  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'phoenix_demo_purger'
       AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
  ) THEN
    RAISE EXCEPTION '141 VERIFY FAILED: phoenix_demo_purger must never hold SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION';
  END IF;

  IF (SELECT pg_get_userbyid(proowner) FROM pg_proc
       WHERE oid = to_regprocedure('public.phoenix_demo_purge(text, boolean)')) <> 'phoenix_demo_purger' THEN
    RAISE EXCEPTION '141 VERIFY FAILED: phoenix_demo_purge must be owned by phoenix_demo_purger';
  END IF;

  SELECT pg_get_functiondef(to_regprocedure('public.phoenix_procurement_forbid_mutation()')) INTO v_src;
  IF position('TG_OP = ''DELETE''' IN v_src) = 0
     OR position('phoenix_demo_row_is_purgeable' IN v_src) = 0
     OR position('procurement_history_is_immutable' IN v_src) = 0 THEN
    RAISE EXCEPTION '141 VERIFY FAILED: procurement trigger lost its exemption guard or its original refusal';
  END IF;

  SELECT pg_get_functiondef(to_regprocedure('public.phoenix_forbid_report_snapshot_mutation()')) INTO v_src;
  IF position('TG_OP = ''DELETE''' IN v_src) = 0
     OR position('report_snapshot_is_immutable' IN v_src) = 0 THEN
    RAISE EXCEPTION '141 VERIFY FAILED: snapshot trigger lost its exemption guard or its original refusal';
  END IF;

  SELECT pg_get_functiondef(to_regprocedure('public.phoenix_demo_row_is_purgeable(text, uuid, text, uuid)')) INTO v_src;
  IF position('phoenix_demo_purger' IN v_src) = 0 THEN
    RAISE EXCEPTION '141 VERIFY FAILED: purgeability predicate does not require the ownership boundary';
  END IF;

  SELECT count(*) INTO v_n FROM information_schema.column_privileges
   WHERE table_schema='public' AND column_name='demo_dataset_id'
     AND grantee IN ('authenticated','anon') AND privilege_type='UPDATE';
  IF v_n <> 0 THEN
    RAISE EXCEPTION '141 VERIFY FAILED: authenticated/anon retain UPDATE on a demo marker column';
  END IF;

  RAISE NOTICE 'PHOENIX-DEMO-IMMUTABLE-EXEMPTION-141: verified.';
END;
$verify$;

COMMIT;
