-- ============================================================================
-- MIGRATION 021 — Warehouse retirement: make warehouse_id nullable on ports
-- ============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`
-- Prerequisite: 001 (core schema with distribution_points table)
--
-- Purpose:
--   Retires the warehouse requirement from the port creation workflow.
--   Existing rows keep their warehouse_id value — we only stop requiring it
--   for new ports. The warehouses table is NOT dropped; it remains available
--   for any future use or reporting.
--
-- What this does:
--   1. Makes distribution_points.warehouse_id nullable (DROP NOT NULL)
--
-- Safety:
--   - Idempotent: safe to re-run
--   - Non-destructive: no drop-table, no data wipe, no cascade, no auth.users writes
--   - Existing data is untouched
-- ============================================================================

BEGIN;

-- Step 1: Make warehouse_id nullable on distribution_points
-- (idempotent — if already nullable, this is a no-op in effect)
ALTER TABLE public.distribution_points
  ALTER COLUMN warehouse_id drop not null;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- warehouse_id column must now be nullable (is_nullable = 'YES')
  ASSERT (
    SELECT is_nullable = 'YES'
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'distribution_points'
      AND column_name = 'warehouse_id'
  ), 'VERIFY FAILED: distribution_points.warehouse_id is still NOT NULL';

  RAISE NOTICE '021 ✓ distribution_points.warehouse_id is now nullable';
END $$;

COMMIT;
