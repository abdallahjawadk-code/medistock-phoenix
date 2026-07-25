-- ============================================================================
-- MOVEMENT-DISPENSE-CONTEXT-134
--
-- Unified Movements & Outlet Operations (PR #57, item 3). Adds a normalized,
-- permission-gated contract recording WHO/WHAT an outlet dispense movement
-- was for -- patient, crash cart, or internal order -- immutably linked to
-- the canonical outlet_stock_movements row.
--
-- GREENFIELD: no table, column, enum, or permission key for this concept
-- exists anywhere in the schema today (checked before writing this file).
-- phoenix_dispense_outlet_stock (067, reason_code wired in 131) only ever
-- took free-text p_reason/p_notes -- no beneficiary identity, no structure.
-- This migration adds a SEPARATE table linked by movement_id, not a change
-- to phoenix_dispense_outlet_stock's signature: dispense-context recording
-- is a follow-up act by (usually) the same actor, after the movement
-- already exists, exactly like Group H's correction-approval chaining
-- pattern of "the real predecessor already exists, reference it, don't
-- invent a parallel writer path."
--
-- PRIVACY DESIGN:
--   * patient_identifier / patient_name are the only SENSITIVE fields.
--     crash_cart_reference / internal_order_reference are operational
--     identifiers (a cart label, a requisition number), not personal data.
--   * The table itself has NO SELECT/INSERT/UPDATE/DELETE grant to
--     `authenticated` at all -- every read and write goes through a
--     SECURITY DEFINER RPC. This is the strongest posture available (even
--     stronger than 098's variance-policy table, which at least grants
--     SELECT): a client can never run an ad-hoc query that leaks patient
--     identity through a join, a REST filter, or a realtime subscription.
--   * phoenix_get_movement_dispense_context MASKS patient_identifier/
--     patient_name to NULL unless the caller holds movement_context.
--     view_sensitive for the row's organization -- privacy-safe by
--     default, unmasked only for an explicitly permissioned oversight
--     role.
--   * phoenix_export_movement_dispense_context is a SEPARATE bulk RPC
--     gated by the stronger movement_context.export_sensitive permission,
--     for compliance/audit pulls -- distinct from the single-row "view"
--     permission so a role can see one patient's context in the normal
--     UI flow without also being able to bulk-export every patient in the
--     organization.
--
-- IMMUTABILITY: movement_id is UNIQUE and the record RPC is idempotent on
-- (movement_id, request_fingerprint) -- same request replays the same
-- result; a genuinely different payload for an already-recorded movement
-- is refused (movement_id_conflict), never silently overwritten. No
-- UPDATE/DELETE path exists anywhere, for any role, including the
-- SECURITY DEFINER RPCs themselves -- append-only, exactly like the three
-- quantity ledgers.
--
-- STRICT ORG/ROLE PERMISSIONS: movement_context.record is granted only to
-- outlet_officer (the role that already holds outlet_stock.dispense --
-- 066/067) scoped to the exact distribution_point of the movement being
-- annotated. movement_context.view_sensitive / .export_sensitive are
-- granted only to institution_admin (the org-wide oversight role since
-- 091's five-role cutover), checked via phoenix_status_center_authorized
-- exactly like 098's approve_correction gate.
--
-- PRECONDITIONS: 133 applied (Group H slice, the last reason_code/
-- correlation domain slice) and outlet_stock_movements.reason_code exists
-- (125).
-- ============================================================================

DO $precond$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'phoenix_approve_outlet_stock_correction'
       AND p.pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION '134 PRECONDITION FAILED: 133 (Group H slice) missing — apply 133 first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'outlet_stock_movements'
       AND column_name = 'reason_code'
  ) THEN
    RAISE EXCEPTION '134 PRECONDITION FAILED: outlet_stock_movements.reason_code (125) missing';
  END IF;
END;
$precond$;

-- ── A. The contract table ───────────────────────────────────────────────────

CREATE TABLE public.phoenix_movement_dispense_context (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_id              uuid NOT NULL UNIQUE REFERENCES public.outlet_stock_movements(id) ON DELETE CASCADE,
  organization_id          uuid NOT NULL REFERENCES public.organizations(id),
  distribution_point_id    uuid NOT NULL REFERENCES public.distribution_points(id),
  beneficiary_type         text NOT NULL CHECK (beneficiary_type IN ('patient', 'crash_cart', 'internal_order')),
  -- SENSITIVE — masked by default in phoenix_get_movement_dispense_context.
  patient_identifier       text,
  patient_name             text,
  -- Operational identifiers, not personal data — never masked.
  crash_cart_reference     text,
  internal_order_reference text,
  notes                    text,
  recorded_by              uuid NOT NULL REFERENCES auth.users(id),
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  request_fingerprint      text NOT NULL,
  CONSTRAINT phoenix_movement_dispense_context_type_fields_chk CHECK (
    (beneficiary_type = 'patient'
       AND (patient_identifier IS NOT NULL OR patient_name IS NOT NULL)
       AND crash_cart_reference IS NULL AND internal_order_reference IS NULL)
    OR (beneficiary_type = 'crash_cart'
       AND crash_cart_reference IS NOT NULL
       AND patient_identifier IS NULL AND patient_name IS NULL AND internal_order_reference IS NULL)
    OR (beneficiary_type = 'internal_order'
       AND internal_order_reference IS NOT NULL
       AND patient_identifier IS NULL AND patient_name IS NULL AND crash_cart_reference IS NULL)
  )
);

CREATE INDEX phoenix_movement_dispense_context_org_idx
  ON public.phoenix_movement_dispense_context (organization_id, recorded_at);

COMMENT ON TABLE public.phoenix_movement_dispense_context IS
  'MOVEMENT-DISPENSE-CONTEXT-134: one immutable row per dispense movement, '
  'recording the beneficiary (patient/crash_cart/internal_order). No direct '
  'grant to authenticated at all -- every read and write is through a '
  'SECURITY DEFINER RPC that enforces org isolation, role permission, and '
  '(for patient identity) sensitive-field masking.';

ALTER TABLE public.phoenix_movement_dispense_context ENABLE ROW LEVEL SECURITY;

-- No policies at all: RLS with zero policies denies every row to every
-- role except the table owner / SECURITY DEFINER functions running as the
-- function owner. This is deliberately stricter than a USING-true policy
-- gated only by grants -- there is no direct query path to this table for
-- `authenticated`, full stop.
REVOKE ALL ON TABLE public.phoenix_movement_dispense_context FROM PUBLIC, authenticated, anon;

-- ── B. Permission keys ──────────────────────────────────────────────────────

INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous) VALUES
  ('movement_context.record',          'movement_context', 'record',          'Record dispense beneficiary context',              'تسجيل سياق الجهة المستفيدة من الصرف',        false),
  ('movement_context.view_sensitive',  'movement_context', 'view_sensitive',  'View sensitive patient identity in dispense context', 'عرض هوية المريض الحساسة في سياق الصرف',   true),
  ('movement_context.export_sensitive','movement_context', 'export_sensitive','Bulk-export sensitive dispense context for compliance', 'تصدير سياق الصرف الحساس بالجملة للامتثال', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
SELECT 'super_admin', k.key, true
FROM public.permission_keys k
WHERE k.key IN ('movement_context.record', 'movement_context.view_sensitive', 'movement_context.export_sensitive')
ON CONFLICT (role, permission_key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  -- The role that already holds outlet_stock.dispense (066/067) is the only
  -- one that records beneficiary context — it happens at the moment of
  -- dispensing, by the same actor.
  ('outlet_officer',           'movement_context.record',           true),
  ('outlet_officer',           'movement_context.view_sensitive',   false),
  ('outlet_officer',           'movement_context.export_sensitive', false),
  -- institution_admin: org-wide oversight (091's org-wide-roles list), can
  -- view and export but never records — it did not perform the dispense.
  ('institution_admin',        'movement_context.record',           false),
  ('institution_admin',        'movement_context.view_sensitive',   true),
  ('institution_admin',        'movement_context.export_sensitive', true),
  ('central_warehouse_manager','movement_context.record',           false),
  ('central_warehouse_manager','movement_context.view_sensitive',   false),
  ('central_warehouse_manager','movement_context.export_sensitive', false),
  ('warehouse_officer',        'movement_context.record',           false),
  ('warehouse_officer',        'movement_context.view_sensitive',   false),
  ('warehouse_officer',        'movement_context.export_sensitive', false)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ── C. Record — the only writer, insert-only, idempotent, immutable ────────

CREATE OR REPLACE FUNCTION public.phoenix_record_movement_dispense_context(
  p_request_id                uuid,
  p_movement_id                uuid,
  p_beneficiary_type           text,
  p_patient_identifier         text DEFAULT NULL,
  p_patient_name                text DEFAULT NULL,
  p_crash_cart_reference        text DEFAULT NULL,
  p_internal_order_reference    text DEFAULT NULL,
  p_notes                       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $record$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_mv         public.outlet_stock_movements%ROWTYPE;
  v_existing   public.phoenix_movement_dispense_context%ROWTYPE;
  v_patient_identifier text := NULLIF(btrim(p_patient_identifier), '');
  v_patient_name       text := NULLIF(btrim(p_patient_name), '');
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
  IF p_beneficiary_type = 'patient' AND v_patient_identifier IS NULL AND v_patient_name IS NULL THEN
    RAISE EXCEPTION 'patient_identifier_or_name_required' USING ERRCODE = '23514';
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
    'crash_cart_reference', v_crash_cart_ref, 'internal_order_reference', v_internal_order_ref,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  -- movement_id is UNIQUE: a second, DIFFERENT payload for an
  -- already-recorded movement is refused, never silently overwritten
  -- (append-only, no UPDATE path exists for this table at all).
  SELECT * INTO v_existing FROM public.phoenix_movement_dispense_context WHERE movement_id = p_movement_id;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'movement_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'id', v_existing.id);
  END IF;

  INSERT INTO public.phoenix_movement_dispense_context (
    movement_id, organization_id, distribution_point_id, beneficiary_type,
    patient_identifier, patient_name, crash_cart_reference, internal_order_reference,
    notes, recorded_by, request_fingerprint
  ) VALUES (
    p_movement_id, v_mv.organization_id, v_mv.distribution_point_id, p_beneficiary_type,
    v_patient_identifier, v_patient_name, v_crash_cart_ref, v_internal_order_ref,
    v_notes, v_actor, v_fp
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'movement_id', p_movement_id, 'beneficiary_type', p_beneficiary_type);
END;
$record$;

REVOKE ALL ON FUNCTION public.phoenix_record_movement_dispense_context(uuid, uuid, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_record_movement_dispense_context(uuid, uuid, text, text, text, text, text, text) TO authenticated;

-- ── D. Get — single row, masked unless view_sensitive ──────────────────────

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

  -- Cross-org denial: no organization scoping on the base RPC lookup above,
  -- so this check is the ONLY thing standing between orgs — fail closed and
  -- explicit, not folded into the NOT FOUND branch (an oracle either way is
  -- an acceptable tradeoff here since movement_id is an opaque uuid, not a
  -- guessable sequence).
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR v_row.organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = v_actor)
  ) THEN
    RAISE EXCEPTION 'forbidden_cross_org_access' USING ERRCODE = '42501';
  END IF;

  -- Baseline visibility: the caller must be able to see outlet stock
  -- movements in this org at all (the same key phoenix_dispense_outlet_stock
  -- itself is authorized under one hop up — outlet_stock.view — is
  -- deliberately NOT required here: recording context already proved the
  -- actor's standing at write time, and read access to the NON-sensitive
  -- shape is org-membership-level, matching how movement history in general
  -- is visible to any active org member).
  v_can_view_sensitive := public.phoenix_status_center_authorized(v_row.organization_id, 'movement_context.view_sensitive');

  RETURN jsonb_build_object(
    'id', v_row.id,
    'movement_id', v_row.movement_id,
    'beneficiary_type', v_row.beneficiary_type,
    'patient_identifier', CASE WHEN v_can_view_sensitive THEN v_row.patient_identifier ELSE NULL END,
    'patient_name', CASE WHEN v_can_view_sensitive THEN v_row.patient_name ELSE NULL END,
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

-- ── E. Export — bulk, unmasked, gated by the STRONGER export permission ────

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
         c.patient_identifier, c.patient_name, c.crash_cart_reference, c.internal_order_reference,
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

DO $verify$
DECLARE
  v_count integer;
BEGIN
  IF to_regclass('public.phoenix_movement_dispense_context') IS NULL THEN
    RAISE EXCEPTION '134 VERIFY FAILED: phoenix_movement_dispense_context table missing';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.proname IN (
    'phoenix_record_movement_dispense_context',
    'phoenix_get_movement_dispense_context',
    'phoenix_export_movement_dispense_context'
  ) AND p.pronamespace = 'public'::regnamespace;
  IF v_count <> 3 THEN
    RAISE EXCEPTION '134 VERIFY FAILED: expected exactly 3 dispense-context functions, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.permission_keys
  WHERE key IN ('movement_context.record', 'movement_context.view_sensitive', 'movement_context.export_sensitive');
  IF v_count <> 3 THEN
    RAISE EXCEPTION '134 VERIFY FAILED: expected exactly 3 movement_context permission keys, found %', v_count;
  END IF;

  RAISE NOTICE 'MOVEMENT-DISPENSE-CONTEXT-134: verified.';
END;
$verify$;
