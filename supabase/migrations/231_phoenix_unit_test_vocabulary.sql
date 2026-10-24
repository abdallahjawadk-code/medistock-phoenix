-- ============================================================================
-- MIGRATION 231 — R1-UNIT-TEST-01: admit 'test' to the canonical unit vocabulary.
-- PREPARED / NOT APPLIED — candidate for owner decision and independent review.
-- ============================================================================
-- The owner's 2026 acceptance draft (plan b3a0b5be…, kept as draft #2) is a
-- screening reagent — "Screening test for HBS Ag (Elisa) test" — dosed in
-- `test` units, quantity 11520. The unit is outside the historical eight-unit
-- vocabulary that three CHECK constraints enforce:
--
--   * central_items.unit                          (M001, central_items_unit_check)
--   * central_needs_need_lines.approved_unit      (M212, central_needs_need_lines_unit_vocab_chk)
--   * central_needs_material_requests.unit        (M228, central_needs_material_requests_unit_chk)
--
-- Registration therefore cannot persist the material, and once it is registered,
-- the M226 manual writers would hit the same wall on approved_unit. This
-- migration widens exactly those three constraints, append-only, 'test' last;
-- no other column, constraint, ACL, RLS policy or routine is touched.
--
-- Fail-closed: a PRE block pins each constraint to its EXACT original definition
-- — the full pg_get_constraintdef text, compared RAW. No case-folding, no
-- whitespace stripping, no cast-stripping: those rewrite the contents of quoted
-- literals as well as SQL structure, so 'VIAL' would equal 'vial', 'vial '
-- would equal 'vial', and 'vial::text' (characters inside a string literal)
-- would equal 'vial' — three different unit values passing as "the pinned
-- original". The raw comparison refuses all of them. Any semantic drift — an
-- extra unit, an appended `OR true`, an extra conjunct, a lost unit, a changed
-- literal (case/space/cast-text), a partial previous application, or a NOT
-- VALID constraint — aborts before anything changes. A VERIFY block re-reads
-- the widened definitions with the same raw comparison and re-runs the M226
-- capability seal when present.
--
-- This migration performs NO data probes: no INSERT into and no DELETE from
-- business tables (a probe DELETE keyed by a non-unique name could erase a
-- pre-existing catalog row). Execution probes (accept 'test', refuse a
-- non-vocabulary unit, keep the historical eight, preserve the NULL semantics
-- of approved_unit) live in the disposable-rig dynamic test
-- supabase/migrations/__tests__/231-unit-test-vocabulary.dynamic.test.ts.
-- ============================================================================
BEGIN;

DO $pre$
DECLARE
  v_def            text;
  v_convalidated   bool;
  v_conkey_arr     smallint[];
  v_col            text;
  i                integer;

  -- Exact expected originals: the full pg_get_constraintdef rendering,
  -- lowercase literals, real spacing, ::text casts outside the literals.
  -- 'test' must NOT appear in any of them.
  EXPECTED_CONSTANTS CONSTANT text[] := ARRAY[
    'central_items', 'central_items_unit_check',
    'CHECK ((unit = ANY (ARRAY[''box''::text, ''vial''::text, ''ampoule''::text, ''tablet''::text, ''bottle''::text, ''tube''::text, ''sachet''::text, ''other''::text])))'
  ];
  EXPECTED_NEED_LINES CONSTANT text[] := ARRAY[
    'central_needs_need_lines', 'central_needs_need_lines_unit_vocab_chk',
    'CHECK (((approved_unit IS NULL) OR (approved_unit = ANY (ARRAY[''box''::text, ''vial''::text, ''ampoule''::text, ''tablet''::text, ''bottle''::text, ''tube''::text, ''sachet''::text, ''other''::text]))))'
  ];
  EXPECTED_REQUESTS CONSTANT text[] := ARRAY[
    'central_needs_material_requests', 'central_needs_material_requests_unit_chk',
    'CHECK ((unit = ANY (ARRAY[''box''::text, ''vial''::text, ''ampoule''::text, ''tablet''::text, ''bottle''::text, ''tube''::text, ''sachet''::text, ''other''::text])))'
  ];
BEGIN
  FOR i IN 1..3 LOOP
    DECLARE
      v_expect text[] := CASE i
        WHEN 1 THEN EXPECTED_CONSTANTS WHEN 2 THEN EXPECTED_NEED_LINES ELSE EXPECTED_REQUESTS END;
      v_attnum smallint;
      v_col text;
    BEGIN
      SELECT pg_get_constraintdef(c.oid), c.convalidated, c.conkey
        INTO v_def, v_convalidated, v_conkey_arr
        FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid = t.relnamespace
       WHERE ns.nspname = 'public' AND t.relname = v_expect[1]
         AND c.conname = v_expect[2] AND c.contype = 'c';
      -- existence + identity
      IF v_def IS NULL THEN
        RAISE EXCEPTION 'M231_precondition_failed: % missing (% not applied?)', v_expect[2], v_expect[1];
      END IF;
      IF NOT v_convalidated THEN
        RAISE EXCEPTION 'M231_precondition_failed: % is NOT VALID; refusing to replace a non-validated constraint', v_expect[2];
      END IF;
      IF v_conkey_arr IS NULL OR array_length(v_conkey_arr, 1) <> 1 THEN
        RAISE EXCEPTION 'M231_precondition_failed: % does not constrain exactly one column', v_expect[2];
      END IF;
      SELECT a.attname INTO v_col
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class t ON t.oid = a.attrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid = t.relnamespace
       WHERE ns.nspname = 'public' AND t.relname = v_expect[1] AND a.attnum = v_conkey_arr[1] AND NOT a.attisdropped;
      IF (i = 1 AND v_col <> 'unit') OR (i = 2 AND v_col <> 'approved_unit') OR (i = 3 AND v_col <> 'unit') THEN
        RAISE EXCEPTION 'M231_precondition_failed: % constrains %, not the expected unit column', v_expect[2], v_col;
      END IF;
      -- Partial application: the current definition must not already admit the
      -- 'test' literal. On a pg_get_constraintdef rendering the literal is
      -- exactly 'test'::text, so this text probe cannot match inside another
      -- unit name ('testtube' renders as 'testtube'::text).
      IF position('''' || 'test' || '''::text' IN v_def) > 0 THEN
        RAISE EXCEPTION 'M231_precondition_failed: % already admits test (partial application?)', v_expect[2];
      END IF;
      -- Exact meaning of the definition, compared RAW: no case-folding, no
      -- whitespace stripping, no cast-stripping — those rewrite quoted literals
      -- as well as SQL structure and would equate different unit values.
      IF v_def <> v_expect[3] THEN
        RAISE EXCEPTION 'M231_precondition_failed: % drifted from its M231-pinned original; definition is %', v_expect[2], v_def;
      END IF;
    END;
  END LOOP;
END
$pre$;

-- ---------------------------------------------------------------------------
-- The widening itself: append-only, 'test' last, nothing else changes.
-- ---------------------------------------------------------------------------
ALTER TABLE public.central_items DROP CONSTRAINT central_items_unit_check;
ALTER TABLE public.central_items ADD CONSTRAINT central_items_unit_check
  CHECK (unit IN ('box', 'vial', 'ampoule', 'tablet', 'bottle', 'tube', 'sachet', 'other', 'test'));

ALTER TABLE public.central_needs_need_lines DROP CONSTRAINT central_needs_need_lines_unit_vocab_chk;
ALTER TABLE public.central_needs_need_lines ADD CONSTRAINT central_needs_need_lines_unit_vocab_chk
  CHECK (approved_unit IS NULL OR approved_unit IN ('box', 'vial', 'ampoule', 'tablet', 'bottle', 'tube', 'sachet', 'other', 'test'));

ALTER TABLE public.central_needs_material_requests DROP CONSTRAINT central_needs_material_requests_unit_chk;
ALTER TABLE public.central_needs_material_requests ADD CONSTRAINT central_needs_material_requests_unit_chk
  CHECK (unit IN ('box', 'vial', 'ampoule', 'tablet', 'bottle', 'tube', 'sachet', 'other', 'test'));

DO $verify$
DECLARE
  v_def text;

  EXPECTED_CONSTANTS CONSTANT text :=
    'CHECK ((unit = ANY (ARRAY[''box''::text, ''vial''::text, ''ampoule''::text, ''tablet''::text, ''bottle''::text, ''tube''::text, ''sachet''::text, ''other''::text, ''test''::text])))';
  EXPECTED_NEED_LINES CONSTANT text :=
    'CHECK (((approved_unit IS NULL) OR (approved_unit = ANY (ARRAY[''box''::text, ''vial''::text, ''ampoule''::text, ''tablet''::text, ''bottle''::text, ''tube''::text, ''sachet''::text, ''other''::text, ''test''::text]))))';
  EXPECTED_REQUESTS CONSTANT text := EXPECTED_CONSTANTS;
BEGIN
  FOR i IN 1..3 LOOP
    DECLARE
      v_name   text := CASE i WHEN 1 THEN 'central_items_unit_check'
                              WHEN 2 THEN 'central_needs_need_lines_unit_vocab_chk'
                              ELSE 'central_needs_material_requests_unit_chk' END;
      v_expect text := CASE i WHEN 1 THEN EXPECTED_CONSTANTS
                              WHEN 2 THEN EXPECTED_NEED_LINES
                              ELSE EXPECTED_REQUESTS END;
    BEGIN
      SELECT pg_get_constraintdef(c.oid) INTO v_def
        FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid = t.relnamespace
       WHERE ns.nspname = 'public' AND c.conname = v_name AND c.contype = 'c'
         AND ((i = 1 AND t.relname = 'central_items')
           OR (i = 2 AND t.relname = 'central_needs_need_lines')
           OR (i = 3 AND t.relname = 'central_needs_material_requests'));
      IF v_def IS NULL THEN
        RAISE EXCEPTION 'VERIFY FAILED (M231): % missing after widening', v_name;
      END IF;
      -- Raw comparison: the widened definition must equal the pinned text
      -- exactly — literals, spacing, casts and all.
      IF v_def <> v_expect THEN
        RAISE EXCEPTION 'VERIFY FAILED (M231): % does not equal the pinned nine-unit definition; got %', v_name, v_def;
      END IF;
      -- Enumeration constraint: exactly nine quoted literals — a tenth unit can
      -- never be hiding in the list.
      IF (length(v_def) - length(replace(v_def, '''', ''))) / 2 <> 9 THEN
        RAISE EXCEPTION 'VERIFY FAILED (M231): expected 9 enumerated literals in %, got %', v_name,
          (length(v_def) - length(replace(v_def, '''', ''))) / 2;
      END IF;
    END;
  END LOOP;

  -- The M212 NULL semantics of approved_unit must survive the widening.
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = t.relnamespace
   WHERE ns.nspname = 'public' AND t.relname = 'central_needs_need_lines'
     AND c.conname = 'central_needs_need_lines_unit_vocab_chk' AND c.contype = 'c';
  IF position('approved_unit IS NULL' IN v_def) <= 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (M231): approved_unit NULL allowance lost: %', v_def;
  END IF;

  -- The M226 capability seal must still report a clean slate when it exists.
  IF to_regprocedure('phoenix_private.central_needs_capability_breaches_v1()') IS NOT NULL
     AND EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'VERIFY FAILED (M231): capability seal reports breaches';
  END IF;
END
$verify$;

COMMIT;
