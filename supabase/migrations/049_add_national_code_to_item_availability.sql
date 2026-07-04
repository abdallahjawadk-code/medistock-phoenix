-- ============================================================================
-- 049_add_national_code_to_item_availability.sql
-- MediStock Phoenix V2
--
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Review then apply manually in Supabase Dashboard → SQL Editor.
--
-- Task: DATA-MODEL-NATIONAL-CODE-SEPARATION-A
--
-- Background:
--   Two prior investigation phases (DATA-QUALITY-MATERIAL-BATCH-IDENTITY-A,
--   DATA-MODEL-NATIONAL-CODE-BATCH-DECISION-A) found that item_availability
--   has never had a dedicated "official product/national code" column — only
--   `batch_number text` (added in migration 001). That single column has been
--   displayed inconsistently to users:
--     - The availability Editor (src/features/editor/EditorScreen.tsx) labeled
--       it "National code" / "الرمز الوطني" (an official/regulatory-code
--       framing), while still writing to the batch_number column
--       (comment: "renamed from Batch No.; storage unchanged: batch_number
--       column").
--     - The Status Editor report screen (StatusEditorScreen.tsx) labeled the
--       same column "Batch No." / "رقم الدفعة" (a production/procurement
--       batch-number framing).
--   This is a genuine, evidence-backed ambiguity, not merely an absent field.
--   The data-owner decision for DATA-MODEL-NATIONAL-CODE-SEPARATION-A is
--   Option A: stop overloading one column for both meanings. Add a real,
--   separate `national_code` column for the official product code, and treat
--   `batch_number` going forward as the true batch/lot identifier.
--
--   Because the Editor (the primary data-entry surface) has been asking users
--   for "national code" while storing their answer in batch_number, existing
--   batch_number values are more likely to already BE national-code-like data
--   than true lot numbers. So this migration backfills the new national_code
--   column from existing batch_number values (trimmed, empty-string treated
--   as NULL) rather than leaving it null — without touching batch_number
--   itself. No data is deleted, moved, or destructively cleaned up; both
--   columns end this migration containing the same historical value, and
--   diverge naturally from this point forward as separately wired UI/RPC
--   phases update them independently.
--
-- What this migration does:
--   A. Adds item_availability.national_code (nullable text).
--   B. Backfills national_code = NULLIF(BTRIM(batch_number), '') only where
--      national_code IS NULL (idempotent — safe to re-run; never overwrites
--      a national_code value already set by a future write path).
--   C. Verification block.
--
-- What this migration does NOT do:
--   - Does NOT modify migrations 001-048 in any way.
--   - Does NOT clear, rename, or otherwise alter batch_number — it is
--     preserved exactly as-is, for every existing row.
--   - Does NOT change any unique index/constraint on item_availability
--     (item_availability_dp_sci_conc_form_uniq from migration 029,
--     item_availability_local_item_id_distribution_point_id_key from
--     migration 001 — both untouched).
--   - Does NOT change phoenix_upsert_availability's matching/WHERE clause
--     (migration 035) — it still matches on
--     (distribution_point_id, scientific_name, concentration, dosage_form)
--     exactly as before, and does not read or write national_code at all.
--     Wiring the RPC to accept/return national_code is explicitly deferred
--     to a later, separately reviewed phase
--     (AVAILABILITY-EDITOR-NATIONAL-CODE-WIRING-A).
--   - Does NOT change item_availability's overall batch/availability
--     uniqueness key — that remains out of scope for
--     DB-MATERIAL-BATCH-IDENTITY-049-A-or-later, not this migration.
--   - Does NOT change alert matching or alert_key
--     (phoenix_get_live_inter_institution_alerts_with_state, migrations
--     036/037/039/047/048) — none of those functions reference batch_number
--     or national_code today, and this migration adds no reference either.
--   - Does NOT change item_availability_movements (migration 033/034) or any
--     movement-history row — movements are keyed by item_availability.id and
--     are entirely unaffected by adding a new nullable column to their
--     parent table.
--   - Does NOT change any RLS policy — item_availability's existing RLS
--     (migration 002) is row-scoped, not column-scoped, so it already covers
--     the new column with zero policy changes required (same reasoning as
--     migration 044's whatsapp_phone addition).
--   - Does NOT add any table grant. No GRANT/REVOKE statement appears in this
--     migration at all.
--   - Does NOT use service_role or auth.admin.
--   - Does NOT add any WhatsApp Cloud/Graph API call, token, Bearer header,
--     or automated send.
--   - Does NOT apply migration 048.
--   - Does NOT create migration 050 or any migration beyond 049.
--   - Does NOT touch QR generation, export/print, or user-management logic.
--   - Does NOT modify any frontend production RPC-calling code — the
--     frontend's upsertAvailability() (availability.service.ts) and its
--     phoenix_upsert_availability payload are unchanged; no frontend type or
--     service reads/writes national_code yet. A small, allowed label-only UI
--     change accompanies this migration (EditorScreen.tsx no longer labels
--     the batch_number field "National code", to avoid claiming a save
--     behavior that does not exist yet) — see this phase's final report.
--
-- MANUAL APPLY ONLY — paste into Supabase Dashboard → SQL Editor and run.
-- DO NOT use "supabase db push" — this project manages migrations manually.
--
-- Prerequisites:
--   Migrations 001-048 must be applied. Migration 048 itself does NOT need
--   to be applied before this one — the two are independent (048 touches
--   only the live inter-institution alerts RPC; 049 touches only
--   item_availability's schema). This migration has no ordering dependency
--   on 048 in either direction.
--
-- Safety:
--   - ADD COLUMN IF NOT EXISTS — idempotent.
--   - Backfill UPDATE only touches rows WHERE national_code IS NULL — safe
--     to re-run; never overwrites a value once set.
--   - No DROP, TRUNCATE, RENAME, or destructive CASCADE anywhere in this
--     migration.
--   - No data deleted or moved — batch_number is read-only in this
--     migration, never written.
--
-- After applying, verify with:
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'item_availability' AND column_name = 'national_code';
--   -- expect: 1 row, is_nullable = 'YES', column_default = NULL
--
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'item_availability' AND column_name = 'batch_number';
--   -- expect: 1 row (unchanged, still present)
--
--   SELECT count(*) FROM item_availability
--   WHERE batch_number IS NOT NULL AND btrim(batch_number) <> ''
--     AND national_code IS DISTINCT FROM NULLIF(btrim(batch_number), '');
--   -- expect: 0 (every non-blank batch_number was backfilled into
--   -- national_code by this migration)
-- ============================================================================

-- ============================================================================
-- A. New nullable item_availability column
-- ============================================================================

ALTER TABLE public.item_availability ADD COLUMN IF NOT EXISTS national_code text;

-- ============================================================================
-- B. One-time backfill from existing batch_number values. Only fills rows
--    where national_code is still NULL, so this is safe to re-run and will
--    never clobber a value written by a later, separately reviewed phase.
--    batch_number itself is never modified.
-- ============================================================================

UPDATE public.item_availability
   SET national_code = NULLIF(btrim(batch_number), '')
 WHERE national_code IS NULL
   AND batch_number IS NOT NULL
   AND btrim(batch_number) <> '';

-- ============================================================================
-- C. Verification
-- ============================================================================

DO $$
DECLARE
  v_national_code_exists boolean;
  v_national_code_nullable text;
  v_batch_number_exists   boolean;
  v_unbackfilled_count    bigint;
BEGIN
  SELECT true, is_nullable INTO v_national_code_exists, v_national_code_nullable
  FROM information_schema.columns
  WHERE table_name = 'item_availability' AND column_name = 'national_code';

  ASSERT v_national_code_exists IS TRUE, 'item_availability.national_code column was not created';
  ASSERT v_national_code_nullable = 'YES', 'item_availability.national_code must remain nullable (no NOT NULL)';

  SELECT true INTO v_batch_number_exists
  FROM information_schema.columns
  WHERE table_name = 'item_availability' AND column_name = 'batch_number';

  ASSERT v_batch_number_exists IS TRUE, 'item_availability.batch_number must remain present (not renamed/dropped)';

  SELECT count(*) INTO v_unbackfilled_count
  FROM public.item_availability
  WHERE batch_number IS NOT NULL AND btrim(batch_number) <> ''
    AND national_code IS DISTINCT FROM NULLIF(btrim(batch_number), '');

  ASSERT v_unbackfilled_count = 0, 'every non-blank batch_number value must be backfilled into national_code';
END $$;

-- ============================================================================
-- END OF MIGRATION 049
-- ============================================================================
