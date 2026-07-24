-- ============================================================================
-- STATUS-CLASSIFICATION-BOUNDARY-CORRECTION-112   ***PREPARED - DO NOT APPLY
-- TO PRODUCTION***
--
-- MANUAL APPLY ONLY (SQL Editor), after owner review, AFTER 111. Never via
-- `supabase db push`. Replay 001->112 must be proven on the disposable rig
-- before this is considered ready.
--
-- WHY
-- functional-closure Section 3 audited 092's phoenix_status_prepare_report
-- classification math against the task brief's exact contract and found two
-- real, precise discrepancies (documented in
-- supabase/migrations/__tests__/092-threshold-boundary-semantics-static.test.ts):
--   1. surplus used STRICT `available > target_max`, not the required
--      inclusive `available >= target_max`.
--   2. there was no distinct `unavailable` classification at `available = 0`
--      — a zero balance fell into `scarce` (or `available` when no
--      threshold row exists), with no way to tell "counted zero" apart from
--      "scarce but present."
-- The user reviewed both and made an explicit product decision (this
-- migration implements it verbatim):
--   available = on_hand - reserved
--   available = 0                              -> unavailable
--   0 < available <= reorder_point              -> scarce
--   reorder_point < available < target_max      -> available
--   available >= target_max                     -> surplus
-- `reorder_point` / `target_max` remain the canonical column/param names —
-- NEITHER IS RENAMED. Only the comparison operators and the new branch are
-- corrected. "missing" is UNCHANGED and untouched by this migration: it can
-- only ever originate from the separate suspected_missing -> stocktake ->
-- warehouse_officer-confirmation path (098/101/092's
-- phoenix_status_confirm_missing), which this migration does not modify —
-- `unavailable` is a plain, always-computed classification of a zero
-- balance and is never conflated with, and never transitions into,
-- `missing`/`suspected_missing`.
--
-- HOW (092 IS NEVER EDITED — its file on disk is byte-for-byte unchanged)
--   * phoenix_status_prepare_report and phoenix_status_classify_lines are
--     both plain `CREATE OR REPLACE FUNCTION`, same exact parameter lists as
--     092 defined them — the established evolve-via-CREATE-OR-REPLACE-from-a-
--     later-migration idiom this codebase already uses (e.g. 106 replacing
--     097's phoenix_add_dispatch_line_fefo_guarded body without touching
--     097's file). Every line of both functions is reproduced verbatim from
--     092 EXCEPT the classification CASE block (prepare_report) and the
--     allowed-classification list (classify_lines), which is the whole
--     point of this migration.
--   * The two CHECK constraints on inventory_status_report_lines
--     (suggested_classification, classification) cannot be edited in place
--     either (092's CREATE TABLE is historical) — they are DROP CONSTRAINT
--     + ADD CONSTRAINT with an EXPANDED allowed-value list, the same
--     drop-then-re-add idiom 092 itself used for
--     inventory_thresholds_safety_stock_chk / _lead_time_chk when it added
--     those two columns. The constraint name is looked up dynamically from
--     pg_constraint rather than hard-coded, since 092 left both checks
--     unnamed (Postgres auto-names them) and guessing the generated name
--     wrong would silently no-op instead of failing loud. The lookup itself
--     identifies each constraint by TABLE+COLUMN IDENTITY via pg_attribute's
--     attnum and pg_constraint.conkey — a single-column CHECK constraint's
--     conkey is exactly ARRAY[that column's attnum] — never by matching text
--     inside pg_get_constraintdef(). A prior version of this migration tried
--     `... LIKE '%column%IN%'`, which is exactly the kind of fragile text
--     match this contract avoids: Postgres rewrites `x IN (a,b,c)` internally
--     into `x = ANY (ARRAY[a,b,c])` before it is ever stored, so the
--     definition reconstructed by pg_get_constraintdef() never contains a
--     literal "IN" token — the LIKE pattern silently matched nothing on a
--     real Postgres and aborted the whole replay (caught by the pg-rig CI
--     job this session added, which is exactly what it exists to catch).
--     Matching on conkey identity is immune to how Postgres chooses to print
--     the definition back, and a wrong-cardinality result (zero or more than
--     one CHECK constraint on that exact column) fails loud rather than
--     guessing.
--
-- PRECONDITIONS: 001..111 applied.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure('public.phoenix_status_prepare_report(uuid)') IS NULL THEN
    RAISE EXCEPTION '112 PRECONDITION FAILED: 092 phoenix_status_prepare_report is missing.';
  END IF;
  IF to_regprocedure('public.phoenix_status_classify_lines(uuid, jsonb)') IS NULL THEN
    RAISE EXCEPTION '112 PRECONDITION FAILED: 092 phoenix_status_classify_lines is missing.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.inventory_status_report_lines'::regclass
      AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%unavailable%'
  ) THEN
    RAISE EXCEPTION '112 PRECONDITION FAILED: already applied.';
  END IF;
END
$precond$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Widen both CHECK constraints to allow 'unavailable'.
--    Each constraint is located by TABLE+COLUMN IDENTITY (pg_attribute.attnum
--    vs pg_constraint.conkey), never by pattern-matching pg_get_constraintdef()
--    text — see the file header for why. A single-column CHECK constraint's
--    conkey is exactly a one-element array holding that column's attnum;
--    finding zero or more than one such constraint on the target column is a
--    hard, loud failure — never a silent guess.
-- ─────────────────────────────────────────────────────────────────────────────
DO $constraints$
DECLARE
  v_attnum  smallint;
  v_conname text;
  v_count   integer;
BEGIN
  SELECT attnum INTO v_attnum FROM pg_attribute
  WHERE attrelid = 'public.inventory_status_report_lines'::regclass
    AND attname = 'suggested_classification' AND NOT attisdropped;
  IF v_attnum IS NULL THEN
    RAISE EXCEPTION '112: column suggested_classification not found on inventory_status_report_lines';
  END IF;

  SELECT count(*), max(conname) INTO v_count, v_conname FROM pg_constraint
  WHERE conrelid = 'public.inventory_status_report_lines'::regclass
    AND contype = 'c' AND conkey = ARRAY[v_attnum];
  IF v_count <> 1 THEN
    RAISE EXCEPTION '112: expected exactly one single-column CHECK constraint on suggested_classification, found %', v_count;
  END IF;
  EXECUTE format('ALTER TABLE public.inventory_status_report_lines DROP CONSTRAINT %I', v_conname);

  SELECT attnum INTO v_attnum FROM pg_attribute
  WHERE attrelid = 'public.inventory_status_report_lines'::regclass
    AND attname = 'classification' AND NOT attisdropped;
  IF v_attnum IS NULL THEN
    RAISE EXCEPTION '112: column classification not found on inventory_status_report_lines';
  END IF;

  SELECT count(*), max(conname) INTO v_count, v_conname FROM pg_constraint
  WHERE conrelid = 'public.inventory_status_report_lines'::regclass
    AND contype = 'c' AND conkey = ARRAY[v_attnum];
  IF v_count <> 1 THEN
    RAISE EXCEPTION '112: expected exactly one single-column CHECK constraint on classification, found %', v_count;
  END IF;
  EXECUTE format('ALTER TABLE public.inventory_status_report_lines DROP CONSTRAINT %I', v_conname);
END
$constraints$;

-- NOT VALID + explicit VALIDATE (still inside this same migration's
-- transaction) rather than a plain ADD CONSTRAINT that validates implicitly —
-- makes the "does every existing row already satisfy the new list" check an
-- explicit, visible step rather than an implicit side effect of the ADD.
ALTER TABLE public.inventory_status_report_lines
  ADD CONSTRAINT inventory_status_report_lines_suggested_classification_check
  CHECK (suggested_classification IN ('available', 'unavailable', 'scarce', 'surplus')) NOT VALID;
ALTER TABLE public.inventory_status_report_lines
  VALIDATE CONSTRAINT inventory_status_report_lines_suggested_classification_check;

ALTER TABLE public.inventory_status_report_lines
  ADD CONSTRAINT inventory_status_report_lines_classification_check
  CHECK (classification IN ('available', 'unavailable', 'scarce', 'surplus', 'suspected_missing')) NOT VALID;
ALTER TABLE public.inventory_status_report_lines
  VALIDATE CONSTRAINT inventory_status_report_lines_classification_check;

COMMENT ON COLUMN public.inventory_status_report_lines.suggested_classification IS
  'Server-computed at prepare time (112): unavailable at available=0; scarce at '
  '0<available<=reorder_point; available at reorder_point<available<target_max; '
  'surplus at available>=target_max. Never "missing" — that classification only '
  'ever comes from the separate suspected_missing->stocktake->confirm path.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. phoenix_status_prepare_report — CREATE OR REPLACE, same signature as 092.
--    Every line is 092's own text EXCEPT the classification CASE block below.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_status_prepare_report(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor     uuid := auth.uid();
  v_report_id uuid;
  v_status    text;
  v_mat       record;
  v_line_id   uuid;
  v_existing  record;
  v_suggested text;
  v_thr_reorder_point integer;
  v_thr_target_max    integer;
  v_available integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.phoenix_status_center_authorized(p_organization_id, 'status_center.prepare_own') THEN
    RAISE EXCEPTION 'not_authorized_status_center_prepare_own';
  END IF;

  SELECT id, status INTO v_report_id, v_status
  FROM public.inventory_status_reports
  WHERE organization_id = p_organization_id AND status <> 'locked'
  ORDER BY created_at DESC LIMIT 1;

  IF v_report_id IS NULL THEN
    INSERT INTO public.inventory_status_reports (organization_id, status, prepared_by, prepared_at)
    VALUES (p_organization_id, 'draft', v_actor, now())
    RETURNING id INTO v_report_id;
  ELSIF v_status = 'returned' THEN
    -- Re-opening a returned report for another prepare/classify pass.
    UPDATE public.inventory_status_reports SET status = 'draft', updated_at = now() WHERE id = v_report_id;
  ELSIF v_status = 'submitted' THEN
    RAISE EXCEPTION 'report_already_submitted';
  END IF;

  -- Materials present across warehouse_stock + outlet_stock for this org.
  FOR v_mat IN
    SELECT scientific_name, national_code FROM public.warehouse_stock
    WHERE organization_id = p_organization_id
    UNION
    SELECT scientific_name, national_code FROM public.outlet_stock
    WHERE organization_id = p_organization_id
  LOOP
    SELECT id INTO v_existing
    FROM public.inventory_status_report_lines
    WHERE report_id = v_report_id
      AND lower(scientific_name) = lower(v_mat.scientific_name)
      AND coalesce(national_code, '') = coalesce(v_mat.national_code, '');

    DECLARE
      v_on_hand   integer;
      v_reserved  integer;
      v_in_transit integer;
      v_quarantine integer;
      v_central   integer;
      v_supp      integer;
      v_nearest   date;
    BEGIN
      SELECT COALESCE(SUM(on_hand_quantity), 0), COALESCE(SUM(reserved_quantity), 0),
             COALESCE(SUM(on_hand_quantity) FILTER (WHERE purchase_origin = 'central' OR supply_type IN ('aid','kimadia')), 0),
             COALESCE(SUM(on_hand_quantity) FILTER (WHERE purchase_origin = 'supplementary'), 0),
             MIN(expiry_date)
        INTO v_on_hand, v_reserved, v_central, v_supp, v_nearest
      FROM public.warehouse_stock
      WHERE organization_id = p_organization_id
        AND lower(scientific_name) = lower(v_mat.scientific_name)
        AND coalesce(national_code, '') = coalesce(v_mat.national_code, '');

      SELECT v_on_hand + COALESCE(SUM(os.on_hand_quantity), 0),
             v_reserved + COALESCE(SUM(os.reserved_quantity), 0),
             LEAST(COALESCE(v_nearest, MIN(os.expiry_date)), COALESCE(MIN(os.expiry_date), v_nearest))
        INTO v_on_hand, v_reserved, v_nearest
      FROM public.outlet_stock os
      WHERE os.organization_id = p_organization_id
        AND lower(os.scientific_name) = lower(v_mat.scientific_name)
        AND coalesce(os.national_code, '') = coalesce(v_mat.national_code, '');

      SELECT COALESCE(SUM(quantity), 0) INTO v_quarantine
      FROM public.warehouse_quarantine_stock
      WHERE organization_id = p_organization_id
        AND lower(scientific_name) = lower(v_mat.scientific_name)
        AND coalesce(national_code, '') = coalesce(v_mat.national_code, '');

      SELECT COALESCE(SUM(sent_quantity - COALESCE(received_quantity, 0)), 0) INTO v_in_transit
      FROM public.warehouse_dispatch_lines
      WHERE organization_id = p_organization_id
        AND status IN ('pending', 'sent', 'partially_accepted')
        AND lower(scientific_name) = lower(v_mat.scientific_name)
        AND coalesce(national_code, '') = coalesce(v_mat.national_code, '');

      -- Suggested classification from balances vs 072 thresholds. The report
      -- is org-level, but a per-warehouse/per-outlet threshold is more
      -- specific than an org-wide default when both exist for this material
      -- (scope_id NULLS LAST prefers the scoped row). Reset both scalars each
      -- iteration — a zero-row SELECT INTO otherwise leaves the prior
      -- material's values in place.
      v_thr_reorder_point := NULL;
      v_thr_target_max := NULL;
      SELECT reorder_point, target_max INTO v_thr_reorder_point, v_thr_target_max
      FROM public.inventory_signal_thresholds
      WHERE organization_id = p_organization_id AND is_active
        AND lower(scientific_name) = lower(v_mat.scientific_name)
        AND coalesce(national_code, '') = coalesce(v_mat.national_code, '')
      ORDER BY scope_id NULLS LAST, national_code NULLS LAST LIMIT 1;

      v_available := v_on_hand - v_reserved;
      -- 112: available=0 is ALWAYS 'unavailable' (checked first — a zero
      -- balance is unavailable regardless of whether a threshold row even
      -- exists for this material); surplus is now INCLUSIVE (>=target_max,
      -- was strict >); scarce keeps its inclusive upper bound
      -- (<=reorder_point) but is now genuinely only reached for
      -- available > 0, since available=0 is caught by the branch above.
      v_suggested := CASE
        WHEN v_available = 0 THEN 'unavailable'
        WHEN v_thr_target_max IS NOT NULL AND v_available >= v_thr_target_max THEN 'surplus'
        WHEN v_thr_reorder_point IS NOT NULL AND v_available <= v_thr_reorder_point THEN 'scarce'
        ELSE 'available'
      END;

      IF v_existing.id IS NULL THEN
        INSERT INTO public.inventory_status_report_lines (
          report_id, scientific_name, national_code,
          on_hand_qty, reserved_qty, in_transit_qty, quarantine_qty, central_qty, supplementary_qty,
          nearest_expiry_date, suggested_classification
        ) VALUES (
          v_report_id, v_mat.scientific_name, v_mat.national_code,
          v_on_hand, v_reserved, v_in_transit, v_quarantine, v_central, v_supp,
          v_nearest, v_suggested
        );
      ELSE
        UPDATE public.inventory_status_report_lines SET
          on_hand_qty = v_on_hand, reserved_qty = v_reserved, in_transit_qty = v_in_transit,
          quarantine_qty = v_quarantine, central_qty = v_central, supplementary_qty = v_supp,
          nearest_expiry_date = v_nearest, suggested_classification = v_suggested,
          updated_at = now()
        WHERE id = v_existing.id;
      END IF;
    END;
  END LOOP;

  UPDATE public.inventory_status_reports SET prepared_by = v_actor, prepared_at = now(), updated_at = now()
  WHERE id = v_report_id;

  RETURN jsonb_build_object('ok', true, 'report_id', v_report_id);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_status_prepare_report(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_prepare_report(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. phoenix_status_classify_lines — CREATE OR REPLACE, same signature as
--    092. Every line is 092's own text EXCEPT 'unavailable' being added to
--    the allowed-classification list (it is a plain, always-manually-
--    overridable value exactly like available/scarce/surplus — it carries
--    NO special evidence requirement, unlike suspected_missing, and this
--    function's suspected_missing evidence branch is completely untouched).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_status_classify_lines(
  p_report_id uuid,
  p_lines     jsonb  -- [{line_id, classification, reason, stocktake_count_line_id}]
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_report public.inventory_status_reports%ROWTYPE;
  v_item   jsonb;
  v_line   public.inventory_status_report_lines%ROWTYPE;
  v_class  text;
  v_reason text;
  v_stl_id uuid;
  v_stl    record;
  v_n      integer := 0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'lines_required';
  END IF;

  SELECT * INTO v_report FROM public.inventory_status_reports WHERE id = p_report_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'report_not_found'; END IF;
  IF v_report.status NOT IN ('draft', 'returned') THEN RAISE EXCEPTION 'report_not_editable'; END IF;

  IF NOT public.phoenix_status_center_authorized(v_report.organization_id, 'status_center.classify_own') THEN
    RAISE EXCEPTION 'not_authorized_status_center_classify_own';
  END IF;

  IF v_report.status = 'returned' THEN
    UPDATE public.inventory_status_reports SET status = 'draft', updated_at = now() WHERE id = p_report_id;
  END IF;

  -- Validate the WHOLE batch before applying ANY of it.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_class := v_item->>'classification';
    IF v_class NOT IN ('available', 'unavailable', 'scarce', 'surplus', 'suspected_missing') THEN
      RAISE EXCEPTION 'invalid_classification: %', v_class;
    END IF;
    SELECT * INTO v_line FROM public.inventory_status_report_lines
      WHERE id = (v_item->>'line_id')::uuid AND report_id = p_report_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'line_not_found: %', v_item->>'line_id'; END IF;

    IF v_class = 'suspected_missing' THEN
      v_reason := NULLIF(btrim(coalesce(v_item->>'reason', '')), '');
      v_stl_id := NULLIF(v_item->>'stocktake_count_line_id', '')::uuid;
      IF v_reason IS NULL THEN RAISE EXCEPTION 'reason_required_for_suspected_missing'; END IF;
      IF v_stl_id IS NULL THEN RAISE EXCEPTION 'stocktake_evidence_required'; END IF;

      SELECT scl.variance, s.organization_id, scl.scientific_name, scl.national_code
        INTO v_stl
      FROM public.stocktake_count_lines scl
      JOIN public.stocktakes s ON s.id = scl.stocktake_id
      WHERE scl.id = v_stl_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'stocktake_evidence_not_found'; END IF;
      IF v_stl.organization_id <> v_report.organization_id THEN RAISE EXCEPTION 'stocktake_evidence_wrong_organization'; END IF;
      IF lower(v_stl.scientific_name) <> lower(v_line.scientific_name)
         OR coalesce(v_stl.national_code,'') <> coalesce(v_line.national_code,'') THEN
        RAISE EXCEPTION 'stocktake_evidence_material_mismatch';
      END IF;
      IF v_stl.variance >= 0 THEN RAISE EXCEPTION 'stocktake_evidence_not_a_shortage'; END IF;
    END IF;
    v_n := v_n + 1;
  END LOOP;

  -- Apply.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_class := v_item->>'classification';
    SELECT * INTO v_line FROM public.inventory_status_report_lines WHERE id = (v_item->>'line_id')::uuid;
    v_reason := NULLIF(btrim(coalesce(v_item->>'reason', '')), '');
    v_stl_id := NULLIF(v_item->>'stocktake_count_line_id', '')::uuid;

    UPDATE public.inventory_status_report_lines SET
      classification = v_class,
      classification_reason = v_reason,
      classification_overridden = (v_class <> v_line.suggested_classification),
      stocktake_count_line_id = CASE WHEN v_class = 'suspected_missing' THEN v_stl_id ELSE NULL END,
      -- Reclassifying away from suspected_missing clears any prior confirmation.
      confirmed_missing = CASE WHEN v_class = 'suspected_missing' THEN v_line.confirmed_missing ELSE false END,
      confirmed_by = CASE WHEN v_class = 'suspected_missing' THEN v_line.confirmed_by ELSE NULL END,
      confirmed_at = CASE WHEN v_class = 'suspected_missing' THEN v_line.confirmed_at ELSE NULL END,
      first_confirmed_by = CASE WHEN v_class = 'suspected_missing' THEN v_line.first_confirmed_by ELSE NULL END,
      classified_by = v_actor, classified_at = now(), updated_at = now()
    WHERE id = v_line.id;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'classified', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_status_classify_lines(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_classify_lines(uuid, jsonb) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Verify
-- ─────────────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_suggested_attnum smallint;
  v_classification_attnum smallint;
  v_def text;
BEGIN
  SELECT attnum INTO v_suggested_attnum FROM pg_attribute
  WHERE attrelid = 'public.inventory_status_report_lines'::regclass
    AND attname = 'suggested_classification' AND NOT attisdropped;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
  WHERE conrelid = 'public.inventory_status_report_lines'::regclass
    AND contype = 'c' AND conkey = ARRAY[v_suggested_attnum];
  ASSERT v_def IS NOT NULL AND v_def LIKE '%available%' AND v_def LIKE '%unavailable%'
    AND v_def LIKE '%scarce%' AND v_def LIKE '%surplus%',
    'VERIFY FAILED (112): suggested_classification constraint missing a required canonical value';

  SELECT attnum INTO v_classification_attnum FROM pg_attribute
  WHERE attrelid = 'public.inventory_status_report_lines'::regclass
    AND attname = 'classification' AND NOT attisdropped;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
  WHERE conrelid = 'public.inventory_status_report_lines'::regclass
    AND contype = 'c' AND conkey = ARRAY[v_classification_attnum];
  ASSERT v_def IS NOT NULL AND v_def LIKE '%available%' AND v_def LIKE '%unavailable%'
    AND v_def LIKE '%scarce%' AND v_def LIKE '%surplus%' AND v_def LIKE '%suspected_missing%',
    'VERIFY FAILED (112): classification constraint missing a required canonical value';

  ASSERT to_regprocedure('public.phoenix_status_prepare_report(uuid)') IS NOT NULL,
    'VERIFY FAILED (112): phoenix_status_prepare_report missing';
  ASSERT to_regprocedure('public.phoenix_status_classify_lines(uuid, jsonb)') IS NOT NULL,
    'VERIFY FAILED (112): phoenix_status_classify_lines missing';
  RAISE NOTICE 'STATUS-CLASSIFICATION-BOUNDARY-CORRECTION-112: verified.';
END
$verify$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS (read-only, after apply):
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid='public.inventory_status_report_lines'::regclass AND contype='c';
--   -- both defs list 'unavailable' alongside the original values.
-- ROLLBACK (lossless if no report line has EVER classified as 'unavailable'
-- since apply — check first: SELECT count(*) FROM inventory_status_report_lines
-- WHERE 'unavailable' IN (suggested_classification, classification)):
--   -- restore 092's original two functions (copy their bodies from 092's file)
--   -- and 092's original two CHECK constraints (drop the 112 ones, re-add
--   -- the original 3-value / 4-value versions).
-- ============================================================================
