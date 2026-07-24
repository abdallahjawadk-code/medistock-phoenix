-- ============================================================================
-- CENTRAL-ITEMS-CATALOG-DETAIL-114   ***PREPARED - DO NOT APPLY TO PRODUCTION***
--
-- MANUAL APPLY ONLY (SQL Editor), after owner review, AFTER 113. Never via
-- `supabase db push`. Tested by replaying 001->114 on the disposable rig.
--
-- WHY
-- The supplementary-purchases redesign locks central (pharmacy-department)
-- warehouse intake to catalog-only material selection (115): an operator
-- picks a row from the unified drug catalog and can no longer hand-type a
-- competing scientific/trade name for that receipt. For that lock to be
-- meaningful, the catalog itself must be able to carry the identity detail a
-- receipt used to accept as free text: trade name, concentration, dosage
-- form. `central_items` (001) only ever had name/name_ar/barcode/unit — this
-- migration adds the missing columns, nullable (existing rows are
-- unaffected), writable only by super_admin (the existing "ci_write_superadmin"
-- RLS policy already covers `for all`, so no policy change is needed here).
--
-- `barcode` (already unique, already indexed) continues to serve as the
-- catalog's national-code identity — no duplicate column.
--
-- PRECONDITIONS: 001 applied (central_items exists). FORWARD-ONLY.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.central_items') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 001 central_items is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'central_items'
       AND column_name = 'trade_name'
  ) THEN
    RAISE EXCEPTION 'precondition failed: 114 already applied';
  END IF;
END;
$precond$;

ALTER TABLE public.central_items
  ADD COLUMN trade_name    text,
  ADD COLUMN concentration text,
  ADD COLUMN dosage_form   text;

COMMENT ON COLUMN public.central_items.trade_name IS
  'Optional catalog trade name, super_admin-maintained. Central-warehouse intake (115) derives its receipt trade name from THIS column only — never from free text.';
COMMENT ON COLUMN public.central_items.concentration IS
  'Optional catalog concentration, super_admin-maintained. See trade_name comment.';
COMMENT ON COLUMN public.central_items.dosage_form IS
  'Optional catalog dosage form, super_admin-maintained. See trade_name comment.';

COMMIT;

-- ============================================================================
-- POST-CONDITIONS (read-only, after apply):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='central_items'
--      AND column_name IN ('trade_name','concentration','dosage_form');  -- 3 rows
-- RECONCILIATION: nullable columns added to an existing table, no data
-- written, no RLS/grant change (existing "ci_write_superadmin"/"ci_select_auth"
-- policies already cover `for all`/`for select` on the whole row).
-- ROLLBACK: ALTER TABLE public.central_items
--   DROP COLUMN trade_name, DROP COLUMN concentration, DROP COLUMN dosage_form;
-- ============================================================================
