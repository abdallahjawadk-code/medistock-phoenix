-- ============================================================================
-- DISPENSE-WITH-CONTEXT-ATOMIC-136
--
-- Makes 134's dispense-context contract operationally creatable from the real
-- outlet dispense workflow, atomically.
--
-- WHY AN ORCHESTRATION RPC AND NOT TWO CLIENT CALLS
-- --------------------------------------------------
-- Dispensing and recording who it was for are ONE clinical act. Two separate
-- client RPC calls are two transactions: if the second fails (network drop,
-- tab close, permission edge) the quantity has already left the outlet with
-- no beneficiary recorded, and no amount of client retry logic can make that
-- atomic — the browser cannot hold a database transaction. So the composition
-- happens INSIDE one SECURITY DEFINER function, where a failure at any step
-- rolls the whole act back.
--
-- It composes the two ALREADY-REVIEWED writers rather than reimplementing
-- either: phoenix_dispense_outlet_stock (Group F / 131) still performs every
-- quantity check, permission check, FEFO/expiry guard, ledger write and audit
-- entry; phoenix_record_movement_dispense_context (134) still performs every
-- beneficiary validation and its own permission check. This function adds no
-- new authority — a caller who lacks EITHER outlet_stock.dispense on the
-- outlet OR movement_context.record on the same outlet is refused, because
-- both underlying functions re-check independently. It is therefore strictly
-- MORE restrictive than calling the dispense RPC alone.
--
-- IDEMPOTENCY: one client request id drives both halves. The dispense half is
-- idempotent on its own (reference_type='outlet_request', reference_id=
-- p_request_id) and the context half is idempotent on movement_id, so a
-- retried request replays to the same movement AND the same context row
-- rather than double-dispensing or conflicting.
--
-- PATIENT REFERENCE TYPE: the operational contract for a patient dispense is
-- name + WHICH document the reference number came from + the number itself.
-- 134 modelled the name and the number but not the document type, so this
-- migration adds patient_reference_type as a closed 3-value vocabulary
-- (chart, card, pass). It is NOT sensitive on its own — it identifies a
-- document kind, never a person — so it is never masked; the number
-- (patient_identifier) and the name remain the only masked fields.
--
-- PRECONDITIONS: 135 applied.
-- ============================================================================

DO $precond$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='outlet_return_shipment_lines'
       AND column_name='source_movement_id'
  ) THEN
    RAISE EXCEPTION '136 PRECONDITION FAILED: 135 (Group I) missing — apply 135 first';
  END IF;
END;
$precond$;

-- ── A. patient_reference_type — closed vocabulary, non-sensitive ───────────

ALTER TABLE public.phoenix_movement_dispense_context
  ADD COLUMN IF NOT EXISTS patient_reference_type text;

DO $chk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'phoenix_movement_dispense_context_patient_ref_type_chk'
  ) THEN
    ALTER TABLE public.phoenix_movement_dispense_context
      ADD CONSTRAINT phoenix_movement_dispense_context_patient_ref_type_chk
      CHECK (
        -- Only a patient context may carry a reference type, and when it does
        -- the value comes from the closed vocabulary.
        (beneficiary_type = 'patient' AND (patient_reference_type IS NULL
           OR patient_reference_type IN ('chart', 'card', 'pass')))
        OR (beneficiary_type <> 'patient' AND patient_reference_type IS NULL)
      );
  END IF;
END;
$chk$;

COMMENT ON COLUMN public.phoenix_movement_dispense_context.patient_reference_type IS
  'DISPENSE-WITH-CONTEXT-136: which document the patient reference number was '
  'read from — chart (file), card, or pass. A document KIND, never an '
  'identifier: it is deliberately NOT masked, unlike patient_identifier and '
  'patient_name. NULL for non-patient beneficiaries (enforced by CHECK) and '
  'for pre-136 patient rows.';

-- ── B. Record — accept and validate the new field ──────────────────────────
-- The argument list changes, so the OLD overload must be dropped explicitly:
-- CREATE OR REPLACE does NOT replace a function whose signature differs, it
-- silently creates a second callable overload (the defect migration 126 found
-- and documented). Its ACL is re-established below.

DROP FUNCTION IF EXISTS public.phoenix_record_movement_dispense_context(
  uuid, uuid, text, text, text, text, text, text
);

CREATE OR REPLACE FUNCTION public.phoenix_record_movement_dispense_context(
  p_request_id                 uuid,
  p_movement_id                uuid,
  p_beneficiary_type           text,
  p_patient_identifier         text DEFAULT NULL,
  p_patient_name               text DEFAULT NULL,
  p_crash_cart_reference       text DEFAULT NULL,
  p_internal_order_reference   text DEFAULT NULL,
  p_notes                      text DEFAULT NULL,
  p_patient_reference_type     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $record$
DECLARE
  v_actor      uuid := auth.uid();
  v_mv         public.outlet_stock_movements%ROWTYPE;
  v_existing   public.phoenix_movement_dispense_context%ROWTYPE;
  v_patient_identifier text := NULLIF(btrim(p_patient_identifier), '');
  v_patient_name       text := NULLIF(btrim(p_patient_name), '');
  v_patient_ref_type   text := NULLIF(btrim(p_patient_reference_type), '');
  v_crash_cart_ref     text := NULLIF(btrim(p_crash_cart_reference), '');
  v_internal_order_ref text := NULLIF(btrim(p_internal_order_reference), '');
  v_notes              text := NULLIF(btrim(p_notes), '');
  v_fp         text;
  v_id         uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_movement_id IS NULL THEN
    RAISE EXCEPTION 'movement_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_beneficiary_type IS NULL OR p_beneficiary_type NOT IN ('patient', 'crash_cart', 'internal_order') THEN
    RAISE EXCEPTION 'invalid_beneficiary_type' USING ERRCODE = '23514';
  END IF;

  IF p_beneficiary_type = 'patient' THEN
    IF v_patient_identifier IS NULL AND v_patient_name IS NULL THEN
      RAISE EXCEPTION 'patient_identifier_or_name_required' USING ERRCODE = '23514';
    END IF;
    -- The reference TYPE and the reference NUMBER are meaningless apart: a
    -- number with no stated document, or a document with no number, is not a
    -- traceable reference. Require them together or not at all.
    IF v_patient_ref_type IS NOT NULL AND v_patient_ref_type NOT IN ('chart', 'card', 'pass') THEN
      RAISE EXCEPTION 'invalid_patient_reference_type' USING ERRCODE = '23514';
    END IF;
    IF v_patient_identifier IS NOT NULL AND v_patient_ref_type IS NULL THEN
      RAISE EXCEPTION 'patient_reference_type_required' USING ERRCODE = '23514';
    END IF;
    IF v_patient_ref_type IS NOT NULL AND v_patient_identifier IS NULL THEN
      RAISE EXCEPTION 'patient_identifier_required_for_reference_type' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF v_patient_ref_type IS NOT NULL THEN
      RAISE EXCEPTION 'patient_reference_type_not_applicable' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF p_beneficiary_type = 'crash_cart' AND v_crash_cart_ref IS NULL THEN
    RAISE EXCEPTION 'crash_cart_reference_required' USING ERRCODE = '23514';
  END IF;
  IF p_beneficiary_type = 'internal_order' AND v_internal_order_ref IS NULL THEN
    RAISE EXCEPTION 'internal_order_reference_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 134134));

  SELECT * INTO v_mv FROM public.outlet_stock_movements WHERE id = p_movement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'movement_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_mv.reason_code <> 'dispensed' THEN
    RAISE EXCEPTION 'movement_not_a_dispense' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'movement_context.record', v_mv.organization_id, NULL, v_mv.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_movement_context_record' USING ERRCODE = '42501';
  END IF;

  v_fp := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'record_dispense_context', 'movement_id', p_movement_id,
    'beneficiary_type', p_beneficiary_type,
    'patient_identifier', v_patient_identifier, 'patient_name', v_patient_name,
    'patient_reference_type', v_patient_ref_type,
    'crash_cart_reference', v_crash_cart_ref, 'internal_order_reference', v_internal_order_ref,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  SELECT * INTO v_existing FROM public.phoenix_movement_dispense_context WHERE movement_id = p_movement_id;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'movement_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'id', v_existing.id);
  END IF;

  INSERT INTO public.phoenix_movement_dispense_context (
    movement_id, organization_id, distribution_point_id, beneficiary_type,
    patient_identifier, patient_name, patient_reference_type,
    crash_cart_reference, internal_order_reference,
    notes, recorded_by, request_fingerprint
  ) VALUES (
    p_movement_id, v_mv.organization_id, v_mv.distribution_point_id, p_beneficiary_type,
    v_patient_identifier, v_patient_name, v_patient_ref_type,
    v_crash_cart_ref, v_internal_order_ref,
    v_notes, v_actor, v_fp
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'movement_id', p_movement_id, 'beneficiary_type', p_beneficiary_type);
END;
$record$;

REVOKE ALL ON FUNCTION public.phoenix_record_movement_dispense_context(uuid, uuid, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_record_movement_dispense_context(uuid, uuid, text, text, text, text, text, text, text) TO authenticated;

-- ── C. Get — expose the new field; masking rules unchanged ─────────────────

CREATE OR REPLACE FUNCTION public.phoenix_get_movement_dispense_context(
  p_movement_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $get$
DECLARE
  v_actor  uuid := auth.uid();
  v_row    public.phoenix_movement_dispense_context%ROWTYPE;
  v_can_view_sensitive boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_movement_id IS NULL THEN
    RAISE EXCEPTION 'movement_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_row FROM public.phoenix_movement_dispense_context WHERE movement_id = p_movement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'movement_context_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR v_row.organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = v_actor)
  ) THEN
    RAISE EXCEPTION 'forbidden_cross_org_access' USING ERRCODE = '42501';
  END IF;

  v_can_view_sensitive := public.phoenix_status_center_authorized(v_row.organization_id, 'movement_context.view_sensitive');

  RETURN jsonb_build_object(
    'id', v_row.id,
    'movement_id', v_row.movement_id,
    'beneficiary_type', v_row.beneficiary_type,
    'patient_identifier', CASE WHEN v_can_view_sensitive THEN v_row.patient_identifier ELSE NULL END,
    'patient_name', CASE WHEN v_can_view_sensitive THEN v_row.patient_name ELSE NULL END,
    -- A document KIND is not an identity: never masked.
    'patient_reference_type', v_row.patient_reference_type,
    'patient_identity_masked', v_row.beneficiary_type = 'patient' AND NOT v_can_view_sensitive,
    'crash_cart_reference', v_row.crash_cart_reference,
    'internal_order_reference', v_row.internal_order_reference,
    'notes', v_row.notes,
    'recorded_by', v_row.recorded_by,
    'recorded_at', v_row.recorded_at
  );
END;
$get$;

REVOKE ALL ON FUNCTION public.phoenix_get_movement_dispense_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_get_movement_dispense_context(uuid) TO authenticated;

-- ── D. Export — expose the new field, same export_sensitive gate ───────────

DROP FUNCTION IF EXISTS public.phoenix_export_movement_dispense_context(uuid, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.phoenix_export_movement_dispense_context(
  p_organization_id uuid,
  p_from            timestamptz,
  p_to              timestamptz
)
RETURNS TABLE (
  id                        uuid,
  movement_id               uuid,
  distribution_point_id     uuid,
  beneficiary_type          text,
  patient_identifier        text,
  patient_name              text,
  patient_reference_type    text,
  crash_cart_reference      text,
  internal_order_reference  text,
  notes                     text,
  recorded_by               uuid,
  recorded_at               timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $export$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL OR p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'organization_id_and_range_required' USING ERRCODE = '23514';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'invalid_date_range' USING ERRCODE = '23514';
  END IF;
  IF NOT public.phoenix_status_center_authorized(p_organization_id, 'movement_context.export_sensitive') THEN
    RAISE EXCEPTION 'forbidden_movement_context_export' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT c.id, c.movement_id, c.distribution_point_id, c.beneficiary_type,
         c.patient_identifier, c.patient_name, c.patient_reference_type,
         c.crash_cart_reference, c.internal_order_reference,
         c.notes, c.recorded_by, c.recorded_at
  FROM public.phoenix_movement_dispense_context c
  WHERE c.organization_id = p_organization_id
    AND c.recorded_at >= p_from
    AND c.recorded_at <= p_to
  ORDER BY c.recorded_at;
END;
$export$;

REVOKE ALL ON FUNCTION public.phoenix_export_movement_dispense_context(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_export_movement_dispense_context(uuid, timestamptz, timestamptz) TO authenticated;

-- ── E. The atomic composition ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.phoenix_dispense_outlet_stock_with_context(
  p_request_id               uuid,
  p_outlet_stock_id          uuid,
  p_quantity                 integer,
  p_beneficiary_type         text,
  p_patient_identifier       text DEFAULT NULL,
  p_patient_name             text DEFAULT NULL,
  p_patient_reference_type   text DEFAULT NULL,
  p_crash_cart_reference     text DEFAULT NULL,
  p_internal_order_reference text DEFAULT NULL,
  p_reason                   text DEFAULT NULL,
  p_notes                    text DEFAULT NULL,
  p_context_notes            text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $compose$
DECLARE
  v_dispense jsonb;
  v_context  jsonb;
  v_movement_id uuid;
BEGIN
  -- Both callees independently re-check authentication, the caller's scoped
  -- permission, quantities and vocabularies. Nothing is re-implemented here
  -- and no authority is added: this function is exactly as restrictive as
  -- the STRICTER of the two, because either can still refuse.
  --
  -- Validate the beneficiary shape BEFORE moving any quantity, so an
  -- obviously malformed context never costs a dispense + rollback cycle.
  IF p_beneficiary_type IS NULL OR p_beneficiary_type NOT IN ('patient', 'crash_cart', 'internal_order') THEN
    RAISE EXCEPTION 'invalid_beneficiary_type' USING ERRCODE = '23514';
  END IF;

  v_dispense := public.phoenix_dispense_outlet_stock(
    p_request_id, p_outlet_stock_id, p_quantity, p_reason, p_notes
  );

  v_movement_id := NULLIF(v_dispense ->> 'movement_id', '')::uuid;
  IF v_movement_id IS NULL THEN
    -- The dispense RPC always returns a movement_id on success, including on
    -- an idempotent replay. A NULL here means the contract changed under us;
    -- fail closed rather than record a context against nothing.
    RAISE EXCEPTION 'dispense_returned_no_movement' USING ERRCODE = 'P0002';
  END IF;

  -- Same request id: the context half is idempotent on movement_id, so a
  -- retry of the whole call replays to the same movement AND the same
  -- context row. A DIFFERENT beneficiary for an already-recorded movement is
  -- still refused (movement_id_conflict) — retries are safe, edits are not.
  v_context := public.phoenix_record_movement_dispense_context(
    p_request_id, v_movement_id, p_beneficiary_type,
    p_patient_identifier, p_patient_name,
    p_crash_cart_reference, p_internal_order_reference,
    p_context_notes, p_patient_reference_type
  );

  RETURN v_dispense
      || jsonb_build_object(
           'dispense_context_id', v_context ->> 'id',
           'beneficiary_type', p_beneficiary_type,
           'context_idempotent_replay', COALESCE((v_context ->> 'idempotent_replay')::boolean, false)
         );
END;
$compose$;

REVOKE ALL ON FUNCTION public.phoenix_dispense_outlet_stock_with_context(
  uuid, uuid, integer, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_dispense_outlet_stock_with_context(
  uuid, uuid, integer, text, text, text, text, text, text, text, text, text
) TO authenticated;

COMMENT ON FUNCTION public.phoenix_dispense_outlet_stock_with_context(
  uuid, uuid, integer, text, text, text, text, text, text, text, text, text
) IS
  'DISPENSE-WITH-CONTEXT-136: dispenses outlet stock AND records the '
  'beneficiary context in ONE transaction. Composes the reviewed Group F '
  'dispense writer and 134''s context writer; adds no authority (both '
  're-check independently) and no new quantity logic. A failure at either '
  'step rolls back both — the browser can never hold that guarantee itself.';

DO $verify$
DECLARE
  v_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='phoenix_movement_dispense_context'
       AND column_name='patient_reference_type'
  ) THEN
    RAISE EXCEPTION '136 VERIFY FAILED: patient_reference_type missing';
  END IF;

  -- The old 8-arg record overload must be GONE, not shadowed.
  SELECT count(*) INTO v_count FROM pg_proc p
   WHERE p.proname='phoenix_record_movement_dispense_context'
     AND p.pronamespace='public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION '136 VERIFY FAILED: expected exactly 1 record overload, found %', v_count;
  END IF;

  IF to_regprocedure(
       'public.phoenix_dispense_outlet_stock_with_context(uuid,uuid,integer,text,text,text,text,text,text,text,text,text)'
     ) IS NULL THEN
    RAISE EXCEPTION '136 VERIFY FAILED: atomic composition function missing';
  END IF;

  RAISE NOTICE 'DISPENSE-WITH-CONTEXT-ATOMIC-136: verified.';
END;
$verify$;
