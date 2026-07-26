-- ============================================================================
-- PHOENIX-DEMO-AVAILABILITY-PURGE-EXEMPTION-144
--
-- Found running the full seeder (all corridors, production scale) through
-- seed -> purge on a disposable rig, immediately after 143 fixed the
-- ordering/exception-handling defects it depends on.
--
-- item_availability rows with source_kind = 'warehouse_dispatch' are
-- protected by trg_guard_availability_source_kind (065): DELETE is refused
-- with warehouse_managed_availability_read_only unless the caller is BOTH
-- (a) running with the transaction-local phoenix.dispatch_write flag set,
-- AND (b) current_user = the item_availability TABLE OWNER — a genuine
-- ownership boundary, not a GUC any caller can forge, that exists so only
-- the one reviewed dispatch-acceptance RPC can write these rows.
--
-- phoenix_demo_purge is NOT that owner (it is owned by phoenix_demo_purger,
-- 141), so once a demo dataset actually exercises the dispatch corridor —
-- which 140-142 never did until the seeder covered it end-to-end — its
-- item_availability rows became permanently undeletable: no CASCADE exists
-- from warehouse_stock/warehouse_dispatch to item_availability, and nothing
-- else ever clears them.
--
-- THE FIX preserves the guarantee for every genuine row and adds exactly
-- one exemption, narrower than 141's marker-based one because it does not
-- need to be: item_availability is a server-computed PROJECTION, not an
-- audit trail like procurement history or a report snapshot, so it needs no
-- write-once marker or permanent-immutability story — only recognition of
-- the SAME ownership boundary 141 already established. A row qualifies only
-- when ALL of:
--   1. current_user = 'phoenix_demo_purger' -- reachable ONLY inside
--      phoenix_demo_purge, exactly 141's boundary, re-used unchanged.
--   2. the row id is registered in phoenix_demo_manifest under
--      'item_availability' for PHOENIX_DEMO_V1.
--   3. the row's organization_id is ITSELF a demo-created organization,
--      registered in the same manifest -- a genuine organization's rows
--      can therefore never qualify, whatever else is forged.
--   4. TG_OP = 'DELETE' -- every INSERT/UPDATE refusal, including the
--      warehouse-managed read-only UPDATE path, is preserved verbatim.
--
-- PRECONDITIONS: 140 (manifest), 141 (purger role), 065/067 (the guard
-- trigger this migration narrowly exempts).
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.phoenix_demo_manifest') IS NULL THEN
    RAISE EXCEPTION '144 PRECONDITION FAILED: 140 manifest missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'phoenix_demo_purger') THEN
    RAISE EXCEPTION '144 PRECONDITION FAILED: 141 purger role missing';
  END IF;
  IF to_regprocedure('public.phoenix_guard_availability_source_kind()') IS NULL THEN
    RAISE EXCEPTION '144 PRECONDITION FAILED: 065 availability guard trigger missing';
  END IF;
END;
$precond$;

-- A. The narrow predicate. SECURITY INVOKER on purpose, identically to
-- 141's phoenix_demo_row_is_purgeable: a SECURITY DEFINER here would rewrite
-- current_user to this function's own owner and silently defeat the check.
CREATE OR REPLACE FUNCTION public.phoenix_demo_availability_row_is_purgeable(
  p_row_id          uuid,
  p_organization_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $purgeable$
BEGIN
  IF current_user <> 'phoenix_demo_purger' THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.phoenix_demo_manifest m
     WHERE m.dataset_key = 'PHOENIX_DEMO_V1'
       AND m.table_name = 'item_availability'
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

REVOKE ALL ON FUNCTION public.phoenix_demo_availability_row_is_purgeable(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_demo_availability_row_is_purgeable(uuid, uuid) TO phoenix_demo_purger;

-- B. The trigger. Every original branch preserved byte-identical; the ONLY
-- change is one additional OR-condition on the DELETE-refusal path.
CREATE OR REPLACE FUNCTION public.phoenix_guard_availability_source_kind()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dispatch_flag boolean :=
    COALESCE(current_setting('phoenix.dispatch_write', true), '') = 'on';
  v_trusted_dispatch_write boolean := false;
BEGIN
  SELECT v_dispatch_flag
         AND current_user = pg_get_userbyid(c.relowner)
    INTO v_trusted_dispatch_write
  FROM pg_class c
  WHERE c.oid = 'public.item_availability'::regclass;

  IF TG_OP = 'INSERT' THEN
    IF NEW.source_kind = 'warehouse_dispatch' AND NOT v_trusted_dispatch_write THEN
      RAISE EXCEPTION 'warehouse_managed_availability_server_only'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- 144: the ONE new branch. Everything else in this trigger is 065's
    -- original body, unchanged.
    IF OLD.source_kind = 'warehouse_dispatch' AND NOT v_trusted_dispatch_write
       AND NOT public.phoenix_demo_availability_row_is_purgeable(OLD.id, OLD.organization_id) THEN
      RAISE EXCEPTION 'warehouse_managed_availability_read_only'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.source_kind IS DISTINCT FROM OLD.source_kind
     AND NOT v_trusted_dispatch_write THEN
    RAISE EXCEPTION 'availability_source_kind_immutable'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.source_kind = 'warehouse_dispatch'
     AND NOT v_trusted_dispatch_write THEN
    RAISE EXCEPTION 'warehouse_managed_availability_read_only'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_guard_availability_source_kind()
  FROM PUBLIC, anon, authenticated;

DO $verify$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(to_regprocedure('public.phoenix_guard_availability_source_kind()')) INTO v_src;
  IF position('warehouse_managed_availability_server_only' IN v_src) = 0
     OR position('availability_source_kind_immutable' IN v_src) = 0
     OR position('warehouse_managed_availability_read_only' IN v_src) = 0 THEN
    RAISE EXCEPTION '144 VERIFY FAILED: guard trigger lost an original refusal path';
  END IF;
  IF position('phoenix_demo_availability_row_is_purgeable' IN v_src) = 0 THEN
    RAISE EXCEPTION '144 VERIFY FAILED: DELETE branch missing the new exemption call';
  END IF;
  -- The exemption must be additive (AND NOT <predicate>), never a
  -- replacement of the original ownership check.
  IF position('NOT v_trusted_dispatch_write' IN v_src) = 0 THEN
    RAISE EXCEPTION '144 VERIFY FAILED: exemption is no longer additive to the ownership check';
  END IF;

  SELECT pg_get_functiondef(to_regprocedure(
    'public.phoenix_demo_availability_row_is_purgeable(uuid, uuid)')) INTO v_src;
  IF position('phoenix_demo_purger' IN v_src) = 0 THEN
    RAISE EXCEPTION '144 VERIFY FAILED: purgeability predicate does not require the ownership boundary';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = to_regprocedure('public.phoenix_demo_availability_row_is_purgeable(uuid, uuid)')
       AND prosecdef = true
  ) THEN
    RAISE EXCEPTION '144 VERIFY FAILED: purgeability predicate must be SECURITY INVOKER, not DEFINER';
  END IF;

  RAISE NOTICE 'PHOENIX-DEMO-AVAILABILITY-PURGE-EXEMPTION-144: verified.';
END;
$verify$;

COMMIT;
