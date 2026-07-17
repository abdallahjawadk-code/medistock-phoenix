-- ============================================================================
-- INVENTORY-ONLY-AVAILABILITY-066-A
--
-- MANUAL APPLY ONLY. DO NOT use supabase db push or any automated runner.
--
-- Make the unified inventory (warehouse_stock) the ONLY source of availability.
-- After this migration there is no manual availability: no manual write path, no
-- alternate source, no client-chosen source, no fallback to a manual value.
--
-- Physical counting and human correction REMAIN possible — but only as audited
-- STOCK MOVEMENTS through the 065 RPCs, never as an independent availability
-- source. `item_availability` becomes a pure read projection.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- MODEL DECISION (derived from the live catalog, not assumed)
-- ─────────────────────────────────────────────────────────────────────────────
--   warehouse_stock            = CURRENT OPERATIONAL TRUTH.
--                                `available_quantity` is GENERATED STORED as
--                                (on_hand_quantity - reserved_quantity), so it
--                                cannot drift or be forged.
--   warehouse_stock_movements  = AUDIT TRAIL (on_hand_before/delta/after +
--                                reserved_before/delta/after).
--
--   This is deliberately NOT claimed to be full event sourcing: `warehouse_stock`
--   remains directly writable by `postgres`/`service_role`, so a movement-free
--   write is technically possible and the ledger cannot be *proven* gapless.
--   Movements are therefore the audit trail, not the authority.
--
--   Scope chain (all FKs verified live):
--       warehouse_stock.warehouse_id -> warehouses.id
--       distribution_points.warehouse_id -> warehouses.id
--       item_availability.distribution_point_id -> distribution_points.id
--   Availability is therefore scoped per (item, distribution point), and each
--   distribution point resolves to exactly one warehouse. There is no global sum.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS IS SAFE TO APPLY (verified live before authoring)
-- ─────────────────────────────────────────────────────────────────────────────
--   item_availability rows            = 0
--   item_availability source_kind=manual = 0
--   warehouse_stock rows              = 0
--   warehouse_stock_movements rows    = 0
--   warehouses rows                   = 0
--
--   There is NO manual data to convert, reclassify or migrate. The guards in
--   section 0 re-prove that at apply time and ABORT if any manual row has
--   appeared since — this migration must never silently reinterpret real data.
--
-- Deliberately NOT done here:
--   * `source_kind` column is KEPT (pinned to 'warehouse'), not dropped. Removing
--     it is a separate step, only after proving nothing depends on it.
--   * No data backfill, no deletes, no RBAC enforcement, no RLS change.
--   * No UI/permission wiring (that is the frontend phase).
-- ============================================================================

begin;

-- ============================================================================
-- 0. PRECONDITION GUARDS — abort rather than reinterpret real data
--
-- Everything below runs inside this single transaction, matching the 065
-- convention: any RAISE aborts the whole migration and nothing is left applied.
-- ============================================================================
DO $guard$
DECLARE
  v_manual   bigint;
  v_other    bigint;
BEGIN
  SELECT count(*) INTO v_manual
  FROM public.item_availability WHERE source_kind = 'manual';

  IF v_manual > 0 THEN
    RAISE EXCEPTION
      'ABORT 066: % manual availability row(s) exist. This migration must not silently convert them. Classify and migrate them under an explicit plan first.',
      v_manual;
  END IF;

  SELECT count(*) INTO v_other
  FROM public.item_availability WHERE source_kind NOT IN ('manual', 'warehouse');

  IF v_other > 0 THEN
    RAISE EXCEPTION
      'ABORT 066: % availability row(s) carry an unrecognised source_kind. Review before enforcing warehouse-only.',
      v_other;
  END IF;

  -- The 065 contract must be in place; 066 tightens it rather than replacing it.
  IF to_regprocedure('public.phoenix_receive_warehouse_stock(uuid,uuid,text,integer,boolean,boolean,uuid,text,text,text,text,text,text,date,numeric,text,text,text,text,text)') IS NULL
     OR to_regprocedure('public.phoenix_apply_warehouse_stock_movement(uuid,uuid,text,integer,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 066: migration 065 stock RPCs are absent. Apply 065 first.';
  END IF;

  RAISE NOTICE '066 preconditions OK: no manual availability rows; 065 contract present.';
END;
$guard$;

-- ============================================================================
-- 1. source_kind: default becomes 'warehouse'; 'manual' becomes impossible
-- ============================================================================
ALTER TABLE public.item_availability
  ALTER COLUMN source_kind SET DEFAULT 'warehouse';

-- Pin any pre-existing rows (there are none; this is a no-op that keeps the
-- CHECK below provably satisfiable rather than relying on the count above alone).
UPDATE public.item_availability
   SET source_kind = 'warehouse'
 WHERE source_kind <> 'warehouse';

ALTER TABLE public.item_availability
  DROP CONSTRAINT IF EXISTS item_availability_source_kind_warehouse_only_chk;

ALTER TABLE public.item_availability
  ADD CONSTRAINT item_availability_source_kind_warehouse_only_chk
  CHECK (source_kind = 'warehouse');

COMMENT ON COLUMN public.item_availability.source_kind IS
  'INVENTORY-ONLY-AVAILABILITY-066-A: always ''warehouse''. Availability is derived from the unified inventory only. Column retained for compatibility; removal is a separate, later step once no dependency remains.';

COMMENT ON TABLE public.item_availability IS
  'READ PROJECTION of the unified inventory. Never written by clients. Rows are produced only by server-side stock operations (065 RPCs). Scoped per (item, distribution_point); each distribution point resolves to exactly one warehouse.';

-- ============================================================================
-- 2. Remove every client-callable manual availability write path
--
-- Verified live: these are the ONLY functions that write item_availability and
-- are callable by `authenticated`. Each is revoked from PUBLIC/anon/authenticated.
-- They remain callable by postgres/service_role for server-side operations, so
-- no internal call graph breaks.
-- ============================================================================

-- 2a. The primary manual availability write path.
REVOKE ALL ON FUNCTION public.phoenix_upsert_availability(
  uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text
) FROM PUBLIC, anon, authenticated;

-- 2b. Bulk availability clearing for a distribution point.
REVOKE ALL ON FUNCTION public.clear_port_availability(uuid, text)
  FROM PUBLIC, anon, authenticated;

-- 2c. Data-cleaning entry point (055). Never a client concern.
REVOKE ALL ON FUNCTION public.phoenix_clean_availability_data(boolean, text)
  FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 3. Direct table writes stay impossible for clients
--
-- Verified live: `authenticated` already holds only `r` (SELECT) and `anon` only
-- `r` on item_availability, so these REVOKEs are defensive no-ops that cannot
-- reduce access below the current state. They are stated explicitly so the
-- invariant survives any future GRANT.
-- ============================================================================
REVOKE INSERT, UPDATE, DELETE ON TABLE public.item_availability FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_stock FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_stock_movements FROM anon, authenticated;

-- anon must never gain write anywhere in this domain.
REVOKE ALL ON TABLE public.warehouse_stock FROM anon;
REVOKE ALL ON TABLE public.warehouse_stock_movements FROM anon;

-- ============================================================================
-- 4. search_path hardening for the internal manual-movement function
--
-- Live state: SECURITY DEFINER with `SET search_path = public` (inherited from
-- its pre-065 definition, where it was named phoenix_apply_availability_movement).
-- When pg_temp is not listed explicitly, PostgreSQL searches it FIRST, which is
-- the classic SECURITY DEFINER shadowing vector.
--
-- Verified live, this is NOT currently exploitable:
--   * public schema ACL = {postgres=UC, anon=U, authenticated=U, service_role=UC}
--     -> anon/authenticated/PUBLIC cannot CREATE in public.
--   * EXECUTE on this function is already revoked from PUBLIC/anon/authenticated.
-- It is hardened here anyway as defence in depth: appending pg_temp LAST removes
-- the implicit-first-search behaviour without altering the call graph.
-- ============================================================================
ALTER FUNCTION public.phoenix_apply_manual_availability_movement_internal(
  uuid, text, integer, text, text
) SET search_path = public, pg_temp;

-- ============================================================================
-- 5. Post-conditions — the migration proves its own effect or rolls back
-- ============================================================================
DO $verify$
DECLARE
  v_bad bigint;
BEGIN
  -- 5a. The CHECK exists and forbids 'manual'.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'item_availability'
      AND con.conname = 'item_availability_source_kind_warehouse_only_chk'
  ) THEN
    RAISE EXCEPTION 'ABORT 066: warehouse-only CHECK constraint is missing.';
  END IF;

  -- 5b. Default is 'warehouse'.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attrdef d
    JOIN pg_class c ON c.oid = d.adrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.adnum
    WHERE n.nspname = 'public' AND c.relname = 'item_availability'
      AND a.attname = 'source_kind'
      AND pg_get_expr(d.adbin, d.adrelid) ILIKE '%warehouse%'
  ) THEN
    RAISE EXCEPTION 'ABORT 066: source_kind default is not ''warehouse''.';
  END IF;

  -- 5c. No client-callable manual availability write path survives.
  SELECT count(*) INTO v_bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND p.proname IN ('phoenix_upsert_availability', 'clear_port_availability',
                      'phoenix_clean_availability_data',
                      'phoenix_apply_manual_availability_movement_internal')
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'ABORT 066: % manual availability write path(s) are still client-callable.', v_bad;
  END IF;

  -- 5d. Clients cannot write the projection or the stock tables directly.
  IF has_table_privilege('authenticated', 'public.item_availability', 'INSERT')
     OR has_table_privilege('authenticated', 'public.item_availability', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.item_availability', 'DELETE')
     OR has_table_privilege('anon', 'public.item_availability', 'INSERT')
     OR has_table_privilege('authenticated', 'public.warehouse_stock', 'INSERT')
     OR has_table_privilege('authenticated', 'public.warehouse_stock', 'UPDATE') THEN
    RAISE EXCEPTION 'ABORT 066: a client role can still write the inventory or its projection.';
  END IF;

  -- 5e. The stock RPCs clients legitimately need must survive.
  IF NOT has_function_privilege('authenticated',
        'public.phoenix_receive_warehouse_stock(uuid,uuid,text,integer,boolean,boolean,uuid,text,text,text,text,text,text,date,numeric,text,text,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
        'public.phoenix_apply_warehouse_stock_movement(uuid,uuid,text,integer,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORT 066: the receive/movement RPCs are no longer callable by authenticated. Inventory operations would be impossible.';
  END IF;

  -- 5f. RLS must remain enabled on all three tables.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('item_availability', 'warehouse_stock', 'warehouse_stock_movements')
      AND c.relrowsecurity = false
  ) THEN
    RAISE EXCEPTION 'ABORT 066: row level security was weakened.';
  END IF;

  -- 5g. The internal function keeps a pinned search_path including pg_temp.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'phoenix_apply_manual_availability_movement_internal'
      AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'ABORT 066: internal function search_path hardening did not take.';
  END IF;

  RAISE NOTICE '066 verified: availability is inventory-only; no client manual write path remains.';
END;
$verify$;

commit;
