-- ============================================================================
-- PATIENT-DISPENSING-CONTRACT-172  (Stage F · F1)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 171, via the Supabase SQL Editor, after reading this file in
-- full.
--
-- NOT APPLIED BY THIS PR. Authored and replayed on a disposable PostgreSQL rig
-- only. Migrations 001-171 are immutable and are NOT edited here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE THREE GAPS THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- Stage E delivered the legal emergency-inventory corridor (164/168/169):
-- Rescue Carts and Shock Cabinets are real outlets holding real outlet_stock,
-- replenished through routed, atomic, provenance-safe RPCs. Three things were
-- left open, and Stage F closes exactly those and nothing more.
--
--   A. LEGACY crash_cart BENEFICIARY IS STILL A LIVE STOCK HANDOFF.
--      134 introduced beneficiary_type='crash_cart' with a FREE-TEXT
--      crash_cart_reference and no FK to anything. It debits the pharmacy and
--      credits NOTHING: the cart never gains the stock, because in 134's world
--      no cart outlet existed to gain it. 164's own header lists "the
--      crash_cart forward guards" under "Deliberately NOT here (later
--      subphases own them)" — and no later Stage-E subphase delivered them.
--      Now that pharmacy->cart is a real routed corridor, that path is a
--      parallel, unaudited handoff. This migration closes it FORWARD ONLY.
--
--   B. NO SOURCE ELIGIBILITY AT DISPENSE TIME.
--      Stage E's shape rules (rescue_cart requires hospital + emergency,
--      health-centre rescue carts forbidden, cabinet placement) are enforced
--      when a REPLENISHMENT ROUTE is created — they are never consulted when
--      stock is dispensed to a patient. Any outlet the actor happens to be
--      scoped to can currently be debited with beneficiary_type='patient'.
--
--   C. THE PATIENT DOCUMENT TYPE IS UNCONSTRAINED AND UNCAPTURED.
--      136 added patient_reference_type CHECK ('chart','card','pass'). The
--      value is validated for MEMBERSHIP but never against the clinical
--      context it is claimed for, and the product never captures it at all —
--      it has always arrived NULL.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
--   * No patient table. No encounter table. No admission, bed, episode,
--     ward, clinic or prescription entity. Patient identity remains a TYPED
--     REFERENCE on the existing 134 movement context, exactly as owner-decided.
--   * No third inventory truth. Patient dispensing stays an outlet_stock debit
--     through the reviewed Group F writer. The patient is not an inventory node.
--   * No patient -> outlet return corridor. Explicitly out of scope.
--   * No new permission key. outlet_stock.dispense (066) and
--     movement_context.record (134) already express exactly this authority;
--     renaming the same authority would be permission inflation.
--   * No role-default change. No RLS change. No grant widening.
--   * No edit to the 134 table CHECK: 'crash_cart' and 'pass' remain LEGAL
--     STORED VALUES so every historical row stays readable and exportable
--     through the unchanged masked getters. Only NEW writes are refused.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE CARD / CHART CONTRACT, AND WHY IT IS SHAPED THIS WAY
-- ─────────────────────────────────────────────────────────────────────────────
-- Owner rules: ER -> card; hospital outpatient/specialty outpatient -> card;
-- hospital inpatient/ward -> chart; Health Centre -> card always; specialized
-- centre -> card unless inpatient context is PROVABLE; never guess.
--
-- The only canonical clinical discriminator this schema owns is
-- distribution_points.clinical_location_kind ('emergency' | 'non_emergency'),
-- added by 164. Combined with organizations.institution_class and the outlet's
-- own point_type, that is enough to PROVE the following and nothing more:
--
--   rescue_cart      -> hospital + emergency. It IS the ER. Therefore: card.
--   crash_cabinet    -> a cabinet sits in a WARD (164/Stage-E placement:
--                       non_emergency for hospital and specialized centre).
--                       Ward care is inpatient care. Therefore: chart.
--                       In a health sector the cabinet may sit in the approved
--                       emergency location instead, but a health centre has no
--                       inpatient ward at all. Therefore: card.
--   pharmacy         -> emergency clinical context is the ER pharmacy: card.
--                       In a health sector: card (no inpatient ward exists).
--                       In a specialized centre: card — inpatient use is NOT
--                       provable from any canonical field, and owner rule 7
--                       forbids assuming it, so 'chart' is refused there.
--                       In a hospital, a non-emergency pharmacy legitimately
--                       serves BOTH outpatient clinics (card) and wards
--                       (chart) — the owner's own model lists both as real
--                       uses of that one outlet. Accepting either is not a
--                       guess; REQUIRING one would be. The operator states the
--                       document actually read, and both are traceable.
--
-- Where the context cannot yield any allowed set at all, the dispense is
-- REFUSED (patient_dispense_context_indeterminate) rather than defaulted.
--
-- If the owner later wants outpatient-clinic and ward separated for a hospital
-- pharmacy, that needs a new canonical clinical-context value — deliberately
-- NOT invented here.
-- ============================================================================

-- ============================================================================
-- PREFLIGHT — every precondition fails closed, inside the transaction
-- ============================================================================
DO $preflight$
DECLARE
  v_chk_def text;
BEGIN
  IF to_regclass('public.phoenix_movement_dispense_context') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (172): phoenix_movement_dispense_context (134) is absent';
  END IF;
  IF to_regclass('public.distribution_points') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (172): public.distribution_points is absent';
  END IF;
  IF to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (172): public.organizations is absent';
  END IF;

  IF to_regprocedure('public.phoenix_record_movement_dispense_context(uuid,uuid,text,text,text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (172): phoenix_record_movement_dispense_context (136) is absent';
  END IF;
  IF to_regprocedure('public.phoenix_dispense_outlet_stock_with_context(uuid,uuid,integer,text,text,text,text,text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (172): phoenix_dispense_outlet_stock_with_context (136) is absent';
  END IF;
  IF to_regprocedure('public.phoenix_dispense_outlet_stock(uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (172): phoenix_dispense_outlet_stock (Group F) is absent';
  END IF;

  -- 164's clinical discriminator is the whole basis of the card/chart contract.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'distribution_points'
      AND column_name = 'clinical_location_kind'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (172): distribution_points.clinical_location_kind (164) is absent';
  END IF;

  -- 171's organization_kind is required to refuse authority-owned dispensing.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'organizations'
      AND column_name = 'organization_kind'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (172): organizations.organization_kind (171) is absent — apply 171 first';
  END IF;

  -- The 3-value institution_class vocabulary must still be exactly 164's.
  SELECT pg_get_constraintdef(oid) INTO v_chk_def
  FROM pg_constraint WHERE conname = 'organizations_institution_class_chk';
  IF v_chk_def IS NULL
     OR v_chk_def NOT LIKE '%hospital%'
     OR v_chk_def NOT LIKE '%specialized_center%'
     OR v_chk_def NOT LIKE '%health_sector%' THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (172): organizations_institution_class_chk (164) missing or no longer the expected 3 values';
  END IF;

  -- 134's stored vocabulary must still admit the historical values we are
  -- preserving for readability. If it no longer does, someone already edited
  -- history and this migration's compatibility promise is void.
  SELECT pg_get_constraintdef(oid) INTO v_chk_def
  FROM pg_constraint WHERE conname = 'phoenix_movement_dispense_context_beneficiary_type_check';
  IF v_chk_def IS NOT NULL AND v_chk_def NOT LIKE '%crash_cart%' THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (172): 134 beneficiary_type CHECK no longer admits crash_cart — historical rows cannot be preserved';
  END IF;

  IF to_regprocedure('public._phoenix_patient_dispense_reference_types_v1(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (172): _phoenix_patient_dispense_reference_types_v1 already exists (172 already applied?)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'phoenix_movement_dispense_context'
      AND t.tgname = 'phoenix_dispense_context_forward_contract_trg'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (172): phoenix_dispense_context_forward_contract_trg already exists (172 already applied?)';
  END IF;
END;
$preflight$;

-- ============================================================================
-- A. THE ELIGIBILITY + DOCUMENT-TYPE ORACLE
--
-- One function answers both Stage-F questions for a distribution point:
-- "may this outlet dispense to a patient at all?" and "which patient document
-- types are legal here?". Returning the allowed SET (rather than a single
-- required value) is what lets the hospital-pharmacy both-uses case be
-- expressed honestly instead of guessed.
--
-- Raises on ineligibility rather than returning empty: an ineligible outlet is
-- a refusal with a reason, never a silent no-op.
-- ============================================================================
CREATE FUNCTION public._phoenix_patient_dispense_reference_types_v1(
  p_distribution_point_id uuid
)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $oracle$
DECLARE
  v_point_type   text;
  v_clinical     text;
  v_status       text;
  v_org_kind     text;
  v_inst_class   text;
BEGIN
  IF p_distribution_point_id IS NULL THEN
    RAISE EXCEPTION 'distribution_point_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT dp.point_type, dp.clinical_location_kind, dp.status,
         o.organization_kind, o.institution_class
    INTO v_point_type, v_clinical, v_status, v_org_kind, v_inst_class
  FROM public.distribution_points dp
  JOIN public.organizations o ON o.id = dp.organization_id
  WHERE dp.id = p_distribution_point_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'distribution_point_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'source_outlet_inactive' USING ERRCODE = '23514';
  END IF;

  -- 171: an authority owns central warehouses and no outlets at all. If one
  -- ever appears, it is a contract violation, not a dispensing source.
  IF v_org_kind = 'pharmacy_department_authority' THEN
    RAISE EXCEPTION 'patient_dispense_forbidden_for_authority' USING ERRCODE = '23514';
  END IF;

  IF v_point_type = 'rescue_cart' THEN
    -- Stage E shape, re-asserted at dispense time: hospital ER only, never a
    -- health centre. 164 enforces this for routes; nothing enforced it here.
    IF v_inst_class IS DISTINCT FROM 'hospital' THEN
      RAISE EXCEPTION 'rescue_cart_patient_dispense_requires_hospital' USING ERRCODE = '23514';
    END IF;
    IF v_clinical IS DISTINCT FROM 'emergency' THEN
      RAISE EXCEPTION 'rescue_cart_patient_dispense_requires_emergency_context' USING ERRCODE = '23514';
    END IF;
    RETURN ARRAY['card'];

  ELSIF v_point_type = 'crash_cabinet' THEN
    IF v_inst_class = 'health_sector' THEN
      -- A health centre has no inpatient ward, including in its approved
      -- emergency-location exception.
      RETURN ARRAY['card'];
    ELSIF v_inst_class IN ('hospital', 'specialized_center') THEN
      IF v_clinical IS DISTINCT FROM 'non_emergency' THEN
        RAISE EXCEPTION 'crash_cabinet_patient_dispense_requires_non_emergency_context' USING ERRCODE = '23514';
      END IF;
      -- A cabinet in a non-emergency ward is ward (inpatient) care: provable.
      RETURN ARRAY['chart'];
    ELSE
      RAISE EXCEPTION 'patient_dispense_context_indeterminate' USING ERRCODE = '23514';
    END IF;

  ELSIF v_point_type = 'pharmacy' THEN
    IF v_inst_class = 'health_sector' THEN
      RETURN ARRAY['card'];
    ELSIF v_inst_class = 'specialized_center' THEN
      -- Owner rule 7: chart only when inpatient context is provable. It is not
      -- provable for a pharmacy outlet, so it is refused rather than assumed.
      RETURN ARRAY['card'];
    ELSIF v_inst_class = 'hospital' THEN
      IF v_clinical = 'emergency' THEN
        RETURN ARRAY['card'];                 -- ER pharmacy
      ELSIF v_clinical = 'non_emergency' THEN
        RETURN ARRAY['card', 'chart'];        -- outpatient clinics AND wards
      ELSE
        RAISE EXCEPTION 'patient_dispense_context_indeterminate' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'patient_dispense_context_indeterminate' USING ERRCODE = '23514';
    END IF;
  END IF;

  RAISE EXCEPTION 'patient_dispense_forbidden_outlet_type' USING ERRCODE = '23514';
END;
$oracle$;

REVOKE ALL ON FUNCTION public._phoenix_patient_dispense_reference_types_v1(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_patient_dispense_reference_types_v1(uuid) IS
  'STAGE-F-172 internal oracle: may this outlet dispense to a patient, and '
  'which patient document types are legal there. Derived ONLY from canonical '
  'fields (point_type, clinical_location_kind, institution_class, '
  'organization_kind). Raises with a reason on ineligibility; never returns '
  'an empty set. Not a writer, not granted to any client role.';

-- Read-only projection for the UI, so the product can offer the right document
-- choices without duplicating the rule client-side. Advisory only: the writer
-- below re-derives the same answer under its own transaction.
CREATE FUNCTION public.phoenix_patient_dispense_options(
  p_distribution_point_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $options$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_types text[];
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_distribution_point_id IS NULL THEN
    RAISE EXCEPTION 'distribution_point_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT dp.organization_id INTO v_org
  FROM public.distribution_points dp WHERE dp.id = p_distribution_point_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'distribution_point_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Same authority the write requires: this must never become a way to probe
  -- outlets the caller cannot dispense from.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.dispense', v_org, NULL, p_distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_stock_dispense' USING ERRCODE = '42501';
  END IF;

  v_types := public._phoenix_patient_dispense_reference_types_v1(p_distribution_point_id);

  RETURN jsonb_build_object(
    'ok', true,
    'distribution_point_id', p_distribution_point_id,
    'patient_dispense_allowed', true,
    'allowed_patient_reference_types', to_jsonb(v_types)
  );
END;
$options$;

REVOKE ALL ON FUNCTION public.phoenix_patient_dispense_options(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_patient_dispense_options(uuid) TO authenticated;

COMMENT ON FUNCTION public.phoenix_patient_dispense_options(uuid) IS
  'STAGE-F-172: read-only advisory telling the UI which patient document '
  'types are legal for one outlet. Gated by the same outlet_stock.dispense '
  'scope the write requires. Never authoritative — the dispense writer '
  're-derives the same answer.';

-- ============================================================================
-- B. CONTEXT WRITER — forward contract enforcement
--
-- Signature, permission, fingerprint and replay semantics are unchanged. Three
-- refusals are ADDED, all of them forward-only.
-- ============================================================================
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
  v_allowed_types      text[];
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

  -- STAGE-F-172 (A): the legacy cart handoff is closed FORWARD. Historical
  -- rows keep their value and stay readable; no new one may be written. The
  -- legal path is now pharmacy -> cart/cabinet through 168's routed corridor,
  -- which credits the destination outlet instead of debiting into free text.
  IF p_beneficiary_type = 'crash_cart' THEN
    RAISE EXCEPTION 'crash_cart_beneficiary_retired' USING ERRCODE = '23514',
      DETAIL = 'Use the Migration-168 pharmacy->emergency-outlet replenishment corridor; the cart holds real outlet_stock.';
  END IF;

  IF p_beneficiary_type = 'patient' THEN
    IF v_patient_identifier IS NULL AND v_patient_name IS NULL THEN
      RAISE EXCEPTION 'patient_identifier_or_name_required' USING ERRCODE = '23514';
    END IF;
    IF v_patient_ref_type IS NOT NULL AND v_patient_ref_type NOT IN ('chart', 'card', 'pass') THEN
      RAISE EXCEPTION 'invalid_patient_reference_type' USING ERRCODE = '23514';
    END IF;
    -- STAGE-F-172 (C): 'pass' is retired for new patient dispensing. It maps to
    -- no owner-approved care context. Historical rows remain readable.
    IF v_patient_ref_type = 'pass' THEN
      RAISE EXCEPTION 'patient_reference_type_pass_retired' USING ERRCODE = '23514',
        DETAIL = 'Stage F recognises only card (Visit Card) and chart (Patient Chart).';
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

  -- STAGE-F-172 (B + C): source eligibility and the document contract, both
  -- derived server-side from the movement's OWN outlet. The client never
  -- supplies the clinical context, so it cannot widen it.
  IF p_beneficiary_type = 'patient' THEN
    v_allowed_types := public._phoenix_patient_dispense_reference_types_v1(v_mv.distribution_point_id);

    IF v_patient_ref_type IS NULL THEN
      RAISE EXCEPTION 'patient_reference_type_required' USING ERRCODE = '23514';
    END IF;
    IF NOT (v_patient_ref_type = ANY (v_allowed_types)) THEN
      RAISE EXCEPTION 'patient_reference_type_not_valid_for_clinical_context' USING ERRCODE = '23514',
        DETAIL = format('outlet allows %s, got %s', array_to_string(v_allowed_types, '/'), v_patient_ref_type);
    END IF;
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

REVOKE ALL ON FUNCTION public.phoenix_record_movement_dispense_context(uuid, uuid, text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_record_movement_dispense_context(uuid, uuid, text, text, text, text, text, text, text) TO authenticated;

-- ============================================================================
-- C. ATOMIC WRAPPER — refuse before any quantity moves
--
-- Composition, delegation and idempotency are unchanged. The retired
-- beneficiary and the patient contract are checked BEFORE the debit so a
-- refused call never costs a dispense + rollback cycle.
-- ============================================================================
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
  v_dp       uuid;
  v_allowed  text[];
  v_ref_type text := NULLIF(btrim(p_patient_reference_type), '');
BEGIN
  IF p_beneficiary_type IS NULL OR p_beneficiary_type NOT IN ('patient', 'crash_cart', 'internal_order') THEN
    RAISE EXCEPTION 'invalid_beneficiary_type' USING ERRCODE = '23514';
  END IF;

  -- STAGE-F-172 (A)
  IF p_beneficiary_type = 'crash_cart' THEN
    RAISE EXCEPTION 'crash_cart_beneficiary_retired' USING ERRCODE = '23514',
      DETAIL = 'Use the Migration-168 pharmacy->emergency-outlet replenishment corridor; the cart holds real outlet_stock.';
  END IF;

  -- STAGE-F-172 (B + C) pre-check. The context writer re-checks all of this
  -- against the movement's own outlet afterwards; this early copy exists only
  -- so an illegal request is refused before stock moves.
  IF p_beneficiary_type = 'patient' THEN
    IF v_ref_type = 'pass' THEN
      RAISE EXCEPTION 'patient_reference_type_pass_retired' USING ERRCODE = '23514',
        DETAIL = 'Stage F recognises only card (Visit Card) and chart (Patient Chart).';
    END IF;

    SELECT os.distribution_point_id INTO v_dp
    FROM public.outlet_stock os WHERE os.id = p_outlet_stock_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'outlet_stock_not_found' USING ERRCODE = 'P0002';
    END IF;

    v_allowed := public._phoenix_patient_dispense_reference_types_v1(v_dp);

    IF v_ref_type IS NULL THEN
      RAISE EXCEPTION 'patient_reference_type_required' USING ERRCODE = '23514';
    END IF;
    IF NOT (v_ref_type = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'patient_reference_type_not_valid_for_clinical_context' USING ERRCODE = '23514',
        DETAIL = format('outlet allows %s, got %s', array_to_string(v_allowed, '/'), v_ref_type);
    END IF;
  END IF;

  v_dispense := public.phoenix_dispense_outlet_stock(
    p_request_id, p_outlet_stock_id, p_quantity, p_reason, p_notes
  );

  v_movement_id := NULLIF(v_dispense ->> 'movement_id', '')::uuid;
  IF v_movement_id IS NULL THEN
    RAISE EXCEPTION 'dispense_returned_no_movement' USING ERRCODE = 'P0002';
  END IF;

  v_context := public.phoenix_record_movement_dispense_context(
    p_request_id, v_movement_id, p_beneficiary_type,
    p_patient_identifier, p_patient_name,
    p_crash_cart_reference, p_internal_order_reference,
    p_context_notes, p_patient_reference_type
  );

  RETURN v_dispense
      || jsonb_build_object(
           'dispense_context_id', v_context ->> 'id',
           'dispense_context_replay', COALESCE((v_context ->> 'idempotent_replay')::boolean, false)
         );
END;
$compose$;

REVOKE ALL ON FUNCTION public.phoenix_dispense_outlet_stock_with_context(
  uuid, uuid, integer, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_dispense_outlet_stock_with_context(
  uuid, uuid, integer, text, text, text, text, text, text, text, text, text
) TO authenticated;

-- ============================================================================
-- D. DEFENSE IN DEPTH — the contract at the table, not only in the writers
--
-- The context table is REVOKEd from every client role, so today only the
-- SECURITY DEFINER writers above can insert. This trigger means a FUTURE
-- writer cannot reintroduce a retired path by forgetting a check. It fires on
-- INSERT only: UPDATE and SELECT of historical rows are untouched, which is
-- exactly how 'crash_cart' and 'pass' history stays readable.
-- ============================================================================
CREATE FUNCTION public._phoenix_dispense_context_forward_contract_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
DECLARE
  v_allowed text[];
BEGIN
  IF NEW.beneficiary_type = 'crash_cart' THEN
    RAISE EXCEPTION 'crash_cart_beneficiary_retired' USING ERRCODE = '23514';
  END IF;

  IF NEW.beneficiary_type = 'patient' THEN
    IF NEW.patient_reference_type = 'pass' THEN
      RAISE EXCEPTION 'patient_reference_type_pass_retired' USING ERRCODE = '23514';
    END IF;
    IF NEW.patient_reference_type IS NULL THEN
      RAISE EXCEPTION 'patient_reference_type_required' USING ERRCODE = '23514';
    END IF;

    v_allowed := public._phoenix_patient_dispense_reference_types_v1(NEW.distribution_point_id);
    IF NOT (NEW.patient_reference_type = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'patient_reference_type_not_valid_for_clinical_context' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$guard$;

CREATE TRIGGER phoenix_dispense_context_forward_contract_trg
  BEFORE INSERT ON public.phoenix_movement_dispense_context
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_dispense_context_forward_contract_v1();

COMMENT ON FUNCTION public._phoenix_dispense_context_forward_contract_v1() IS
  'STAGE-F-172 forward guard: refuses NEW crash_cart beneficiaries, NEW '
  'pass patient references, and any patient document type illegal for the '
  'outlet''s clinical context. INSERT only — historical rows remain readable '
  'and exportable through 136''s unchanged masked getters.';

-- ============================================================================
-- VERIFY (in-transaction) — abort the whole migration on any failure
-- ============================================================================
DO $verify$
DECLARE
  v_def text;
BEGIN
  IF to_regprocedure('public._phoenix_patient_dispense_reference_types_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (172): eligibility oracle missing';
  END IF;
  IF to_regprocedure('public.phoenix_patient_dispense_options(uuid)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (172): phoenix_patient_dispense_options missing';
  END IF;

  -- The oracle must stay unreachable from clients; only the advisory is granted.
  IF has_function_privilege('authenticated',
       'public._phoenix_patient_dispense_reference_types_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (172): internal oracle must not be executable by authenticated';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.phoenix_patient_dispense_options(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (172): authenticated must EXECUTE phoenix_patient_dispense_options';
  END IF;
  IF has_function_privilege('anon', 'public.phoenix_patient_dispense_options(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (172): anon must never reach patient dispense options';
  END IF;

  -- Both writers must now carry the retirements.
  v_def := pg_get_functiondef('public.phoenix_record_movement_dispense_context(uuid,uuid,text,text,text,text,text,text,text)'::regprocedure);
  IF v_def NOT LIKE '%crash_cart_beneficiary_retired%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (172): context writer does not retire crash_cart';
  END IF;
  IF v_def NOT LIKE '%patient_reference_type_pass_retired%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (172): context writer does not retire pass';
  END IF;
  IF v_def NOT LIKE '%_phoenix_patient_dispense_reference_types_v1%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (172): context writer does not enforce clinical context';
  END IF;

  v_def := pg_get_functiondef('public.phoenix_dispense_outlet_stock_with_context(uuid,uuid,integer,text,text,text,text,text,text,text,text,text)'::regprocedure);
  IF v_def NOT LIKE '%crash_cart_beneficiary_retired%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (172): atomic wrapper does not retire crash_cart';
  END IF;
  IF v_def NOT LIKE '%_phoenix_patient_dispense_reference_types_v1%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (172): atomic wrapper does not pre-check clinical context';
  END IF;
  -- The wrapper must still delegate, never re-implement, the debit.
  IF v_def NOT LIKE '%phoenix_dispense_outlet_stock(%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (172): atomic wrapper no longer delegates to the Group F debit writer';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'phoenix_movement_dispense_context'
      AND t.tgname = 'phoenix_dispense_context_forward_contract_trg'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (172): forward-contract trigger absent';
  END IF;

  -- HISTORY MUST REMAIN READABLE: 134's stored vocabulary is untouched.
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint WHERE conname = 'phoenix_movement_dispense_context_beneficiary_type_check';
  IF v_def IS NOT NULL AND v_def NOT LIKE '%crash_cart%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (172): 134 beneficiary_type CHECK was modified — historical rows must stay valid';
  END IF;

  -- The masked getter must not have been touched by this migration.
  v_def := pg_get_functiondef('public.phoenix_get_movement_dispense_context(uuid)'::regprocedure);
  IF v_def NOT LIKE '%patient_identity_masked%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (172): 136 masking contract is no longer intact';
  END IF;

  -- No second inventory truth may have appeared.
  IF to_regclass('public.patient_stock') IS NOT NULL
     OR to_regclass('public.rescue_cart_stock') IS NOT NULL
     OR to_regclass('public.crash_cabinet_stock') IS NOT NULL
     OR to_regclass('public.pharmacy_stock') IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (172): a parallel stock truth exists';
  END IF;
END;
$verify$;

-- ============================================================================
-- ROLLBACK GUIDANCE (documentation only — deliberately not executed)
--
-- This migration adds two functions, one trigger + its function, and replaces
-- two function bodies. It writes NO data and alters NO table structure, so a
-- pre-apply failure leaves nothing behind (the whole file is one transaction).
--
-- To reverse a successful apply:
--   DROP TRIGGER  phoenix_dispense_context_forward_contract_trg ON public.phoenix_movement_dispense_context;
--   DROP FUNCTION public._phoenix_dispense_context_forward_contract_v1();
--   DROP FUNCTION public.phoenix_patient_dispense_options(uuid);
--   DROP FUNCTION public._phoenix_patient_dispense_reference_types_v1(uuid);
--   -- then re-apply 136's section B and E bodies to restore the previous
--   -- writers verbatim.
--
-- Reversal restores the PERMISSIVE pre-Stage-F behaviour, including the legacy
-- crash_cart handoff. Any context rows written while 172 was live remain valid
-- under the older, weaker rules — nothing needs to be deleted or rewritten.
-- ============================================================================
