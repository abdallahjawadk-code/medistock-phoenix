-- ============================================================================
-- MIGRATION 043 — item_availability: drop wrong legacy unique indexes
-- ============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard > SQL Editor after a verified backup.
--
-- Prerequisites: 001 (item_availability table + local_item_id/distribution_point_id
-- unique constraint), 019 (item_avail_point_port_idx — REMOVED by this
-- migration), 020 (item_avail_point_sciname_idx — REMOVED by this migration),
-- 029 (item_availability_dp_sci_conc_form_uniq — the correct index, PRESERVED),
-- 030/032/035 (phoenix_upsert_availability — unchanged by this migration).
--
-- Task: BUGFIX-AVAILABILITY-DUPLICATE-PORT-INDEX-B
--
-- -----------------------------------------------------------------------------
-- Root cause (confirmed via live Supabase browser error + live index inspection):
-- -----------------------------------------------------------------------------
--   Adding a second material to any outlet failed with:
--
--     POST /rest/v1/rpc/phoenix_upsert_availability
--     409 Conflict — code 23505
--     duplicate key value violates unique constraint "item_avail_point_port_idx"
--     Key (distribution_point_id, port_name) already exists.
--
--   item_avail_point_port_idx (migration 019) is a UNIQUE index on
--   (distribution_point_id, port_name) alone. In the current product model
--   every material row for a given outlet shares the SAME port_name (the
--   outlet's own display name — see phoenix_upsert_availability's v_port_name
--   derivation), so this index allows AT MOST ONE item_availability row per
--   outlet, total — it silently blocks every second-or-later material add.
--   It was correct only in migration 019's original, now-superseded design
--   (one free-text "port" entry per row, before scientific_name/concentration/
--   dosage_form existed as identity columns).
--
--   A second, narrower problem: item_avail_point_sciname_idx (migration 020)
--   is a UNIQUE index on (distribution_point_id, scientific_name) alone
--   (partial, WHERE scientific_name IS NOT NULL). Migration 029 added the
--   correct 4-column replacement, item_availability_dp_sci_conc_form_uniq —
--   (distribution_point_id, scientific_name, COALESCE(concentration,''),
--   COALESCE(dosage_form,'')), which exactly matches
--   phoenix_upsert_availability's own existing-row lookup (migrations 030/032/
--   035) — but 029 never dropped the old 2-column index. With both indexes
--   live, the OLDER, STRICTER one still blocks a legitimate case the newer
--   one is designed to allow: the same scientific_name at the same outlet
--   with a DIFFERENT concentration or dosage_form (e.g. "Paracetamol 500mg"
--   and "Paracetamol 250mg" as two separate rows for the same port).
--
-- -----------------------------------------------------------------------------
-- Fix — what this migration does:
-- -----------------------------------------------------------------------------
--   Drops exactly the two wrong/superseded legacy indexes:
--     - item_avail_point_port_idx      (migration 019 — wrong model entirely)
--     - item_avail_point_sciname_idx   (migration 020 — superseded by 029)
--
--   Index-only change. No table, column, row, trigger, RLS policy, or RPC is
--   touched. The correct material-identity uniqueness is already fully
--   enforced by the two indexes this migration PRESERVES (untouched, not
--   even referenced by a DROP statement):
--     - item_availability_dp_sci_conc_form_uniq (migration 029 — the
--       intended 4-column identity: distribution_point_id + scientific_name +
--       COALESCE(concentration,'') + COALESCE(dosage_form,''), matching
--       phoenix_upsert_availability's own lookup exactly)
--     - item_availability_local_item_id_distribution_point_id_key (migration
--       001's original `unique (local_item_id, distribution_point_id)` table
--       constraint, auto-named by Postgres — the legacy local_item_id-based
--       identity path, still valid for any row created through it)
--
--   phoenix_upsert_availability is NOT modified — its existing-row lookup
--   already matches item_availability_dp_sci_conc_form_uniq's exact column
--   set (see migration 035's UPDATE-path SELECT), so no RPC change is
--   necessary or made.
--
-- What this migration does NOT do:
--   - Does NOT modify migrations 001-042 in any way.
--   - Does NOT DELETE, TRUNCATE, or otherwise alter any item_availability row.
--   - Does NOT touch item_availability_movements or audit_logs.
--   - Does NOT touch item_availability_dp_sci_conc_form_uniq or
--     item_availability_local_item_id_distribution_point_id_key.
--   - Does NOT modify phoenix_upsert_availability, phoenix_apply_availability_movement,
--     clear_port_availability, or any other RPC.
--   - Does NOT weaken any RLS policy — this migration contains no CREATE/ALTER
--     POLICY statement at all.
--   - Does NOT use any elevated/admin API key — this is a plain SQL migration.
--   - Does NOT touch inter_org_exchange_* or inter_org_alert_* tables/RPCs.
--
-- Safe diagnostics to run BEFORE applying (read-only; confirm current state):
--
--   SELECT indexname, indexdef FROM pg_indexes
--   WHERE schemaname = 'public' AND tablename = 'item_availability'
--   ORDER BY indexname;
--
-- Post-apply manual verification (run in Supabase SQL Editor):
--
--   1. Confirm the two wrong indexes are gone and the two correct ones remain
--      (same query as above — expect item_avail_point_port_idx and
--      item_avail_point_sciname_idx absent; item_availability_dp_sci_conc_form_uniq
--      and item_availability_local_item_id_distribution_point_id_key present).
--   2. In the app (or via phoenix_upsert_availability directly), add a SECOND
--      material to an outlet that already has one — expect success, not 23505.
--   3. Add the same scientific_name at the same outlet with a different
--      concentration (e.g. same name, "500mg" vs "250mg") — expect two
--      separate rows, not 23505.
--   4. Attempt to add the exact same (distribution_point_id, scientific_name,
--      concentration, dosage_form) combination twice — expect the SECOND call
--      to UPDATE the existing row (phoenix_upsert_availability's own
--      existing-row branch), not a raw 23505 — the correct index still
--      enforces this identity.
--   5. SELECT count(*) FROM item_availability_movements; — before and after,
--      confirm unchanged (this migration never touches that table).
-- ============================================================================

DROP INDEX IF EXISTS public.item_avail_point_port_idx;
DROP INDEX IF EXISTS public.item_avail_point_sciname_idx;

-- Ask PostgREST to reload its schema cache now that the index shape changed.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFY
-- ============================================================================

DO $$
BEGIN
  -- A. Wrong indexes are gone
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'item_availability'
      AND indexname = 'item_avail_point_port_idx'
  ), 'VERIFY FAILED: item_avail_point_port_idx still exists';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'item_availability'
      AND indexname = 'item_avail_point_sciname_idx'
  ), 'VERIFY FAILED: item_avail_point_sciname_idx still exists';

  -- B. Correct indexes are preserved
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'item_availability'
      AND indexname = 'item_availability_dp_sci_conc_form_uniq'
  ), 'VERIFY FAILED: item_availability_dp_sci_conc_form_uniq is missing — it must be preserved';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'item_availability'
      AND indexname = 'item_availability_local_item_id_distribution_point_id_key'
  ), 'VERIFY FAILED: item_availability_local_item_id_distribution_point_id_key is missing — it must be preserved';

  -- C. Table itself, and the row count, are untouched by this migration
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'item_availability'
  ), 'VERIFY FAILED: item_availability table is missing';

  -- D. item_availability_movements and audit_logs are untouched — table and
  --    RLS/grant shape unchanged, no row was deleted by this migration (a
  --    pure DROP INDEX cannot remove rows from any table, but this asserts
  --    the tables themselves were not dropped/renamed either).
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'item_availability_movements'
  ), 'VERIFY FAILED: item_availability_movements table is missing';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'audit_logs'
  ), 'VERIFY FAILED: audit_logs table is missing';

  RAISE NOTICE '043 OK: item_avail_point_port_idx and item_avail_point_sciname_idx dropped; item_availability_dp_sci_conc_form_uniq and item_availability_local_item_id_distribution_point_id_key preserved. No data touched.';
END $$;

-- ============================================================================
-- END OF MIGRATION 043
-- ============================================================================
