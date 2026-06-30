-- ============================================================================
-- 029_phoenix_availability_scientific_name_unique.sql
--
-- Fix availability upsert (42P10): add missing unique index for the
-- scientific_name path so upsertAvailability can use a 4-column onConflict.
--
-- MANUAL APPLY ONLY — applied via Supabase SQL Editor.
-- DO NOT use `supabase db push` — this project manages migrations manually.
--
-- Root cause:
--   upsertAvailability called .upsert(row, { onConflict: '...4 columns...' })
--   but only the 2-column index item_avail_point_sciname_idx existed from
--   migration 020.  Postgres raised 42P10 ("no unique or exclusion constraint
--   matching the ON CONFLICT specification") on every save.
--
-- Fix:
--   Create a partial unique index on the 4-column key
--   (distribution_point_id, scientific_name, concentration, dosage_form)
--   restricted to rows WHERE scientific_name IS NOT NULL.
--   COALESCE wraps concentration/dosage_form so that NULL values and ''
--   are treated identically by the index — matching the '' values the
--   service layer now sends when those fields are absent.
--
-- Side-effects: none.  No table, column, policy, trigger, or RLS is changed.
-- The legacy local_item_id path is untouched.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS item_availability_dp_sci_conc_form_uniq
ON public.item_availability (
  distribution_point_id,
  scientific_name,
  COALESCE(concentration, ''),
  COALESCE(dosage_form, '')
)
WHERE scientific_name IS NOT NULL;

-- ============================================================================
-- VERIFY
-- ============================================================================
DO $$
DECLARE
  v_idx_count int;
BEGIN
  SELECT count(*) INTO v_idx_count
  FROM   pg_indexes
  WHERE  tablename  = 'item_availability'
    AND  indexname  = 'item_availability_dp_sci_conc_form_uniq';

  ASSERT v_idx_count = 1,
    '029: item_availability_dp_sci_conc_form_uniq index not found';
END $$;
