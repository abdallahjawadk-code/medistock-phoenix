-- ============================================================================
-- WAREHOUSE-SECOND-PERSON-CORRECTION-APPROVAL-101-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 100.
--
-- Extends 098's second-person approval gate to WAREHOUSE-side corrections
-- (065/078's phoenix_apply_warehouse_stock_movement(_guarded), movement_type
-- 'correction') — the FOLLOW-UP explicitly deferred at 098's authoring time.
-- Reuses 098's SAME `phoenix_variance_approval_policy` table (one threshold
-- per org covers both outlet and warehouse corrections — a single number a
-- central_warehouse_manager sets once, not two independent knobs to forget
-- to configure identically). Same fail-closed default (absent row = 0).
--
-- Same non-delegation reasoning as 098: the write is applied INLINE inside
-- the approve RPC rather than through phoenix_apply_warehouse_stock_movement_
-- guarded, because that RPC authorizes 'warehouse_stock.correct' against the
-- CURRENT caller (the approver) — and while central_warehouse_manager here
-- DOES also hold warehouse_stock.correct (066, unlike the outlet_stock.count
-- asymmetry in 098), coupling approval authority to correction authority
-- would be an accident of today's role defaults, not a designed invariant.
-- Keeping the same inline-apply shape as 098 means a future role change to
-- warehouse_stock.correct cannot silently break approval.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure('public.phoenix_apply_warehouse_stock_movement_guarded(uuid,uuid,text,integer,text,bigint,text,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 078 phoenix_apply_warehouse_stock_movement_guarded is missing';
  END IF;
  IF to_regclass('public.phoenix_variance_approval_policy') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 098 phoenix_variance_approval_policy is missing';
  END IF;
END;
$precond$;

-- ── A. New approval permission — mirrors 098's outlet_stock.approve_correction

INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous)
VALUES
  ('warehouse_stock.approve_correction', 'warehouse_stock', 'approve_correction',
   'Approve a large warehouse stock correction proposed by someone else',
   'اعتماد تصحيح مخزون مذخر كبير اقترحه شخص آخر', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
VALUES
  ('central_warehouse_manager', 'warehouse_stock.approve_correction', true)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ── B. Pending correction requests ──────────────────────────────────────────

CREATE TABLE public.phoenix_warehouse_correction_requests (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  warehouse_stock_id     uuid NOT NULL REFERENCES public.warehouse_stock(id) ON DELETE RESTRICT,
  on_hand_before         integer NOT NULL,
  new_quantity           integer NOT NULL,
  variance               integer NOT NULL,
  reason                 text NOT NULL,
  source_document_number text,
  notes                  text,
  status                 text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  proposed_by            uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  proposed_at            timestamptz NOT NULL DEFAULT now(),
  underlying_request_id  uuid NOT NULL UNIQUE,
  decided_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at             timestamptz,
  decision_reason        text,
  applied_movement_id    uuid REFERENCES public.warehouse_stock_movements(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.phoenix_warehouse_correction_requests IS
  'Pending second-person-approval WAREHOUSE stock corrections — the '
  'warehouse-side twin of phoenix_stock_correction_requests (098). Same '
  'proposer-cannot-equal-approver identity check.';

CREATE INDEX phoenix_warehouse_correction_requests_pending_idx
  ON public.phoenix_warehouse_correction_requests (organization_id, status);

ALTER TABLE public.phoenix_warehouse_correction_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY phoenix_warehouse_correction_requests_select_scoped
  ON public.phoenix_warehouse_correction_requests
  FOR SELECT TO authenticated
  USING (
    public.phoenix_my_role() = 'super_admin'
    OR organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid())
  );

REVOKE INSERT, UPDATE, DELETE ON TABLE public.phoenix_warehouse_correction_requests FROM authenticated;
GRANT SELECT ON TABLE public.phoenix_warehouse_correction_requests TO authenticated;

-- ── C. Request — applies immediately if within threshold, else queues ──────

CREATE OR REPLACE FUNCTION public.phoenix_request_warehouse_stock_correction(
  p_request_id             uuid,
  p_warehouse_stock_id     uuid,
  p_new_quantity           integer,
  p_reason                 text,
  p_expected_generation    bigint DEFAULT NULL,
  p_source_document_number text   DEFAULT NULL,
  p_notes                  text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $request$
DECLARE
  v_actor     uuid := auth.uid();
  v_stock     public.warehouse_stock%ROWTYPE;
  v_existing  public.phoenix_warehouse_correction_requests%ROWTYPE;
  v_threshold integer;
  v_variance  integer;
  v_reason    text := NULLIF(btrim(p_reason), '');
  v_req_id    uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_stock_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_new_quantity IS NULL OR p_new_quantity < 0 THEN
    RAISE EXCEPTION 'quantity_must_be_non_negative' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'warehouse_correction_reason_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 101101));

  SELECT * INTO v_existing
  FROM public.phoenix_warehouse_correction_requests WHERE underlying_request_id = p_request_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'correction_request_id', v_existing.id, 'status', v_existing.status, 'requires_approval', true
    );
  END IF;

  SELECT * INTO v_stock FROM public.warehouse_stock WHERE id = p_warehouse_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_stock.correct', v_stock.organization_id, v_stock.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_stock_movement' USING ERRCODE = '42501';
  END IF;

  v_variance := abs(p_new_quantity - v_stock.on_hand_quantity);

  SELECT threshold_quantity INTO v_threshold
    FROM public.phoenix_variance_approval_policy WHERE organization_id = v_stock.organization_id;
  v_threshold := COALESCE(v_threshold, 0);

  IF v_variance <= v_threshold THEN
    RETURN public.phoenix_apply_warehouse_stock_movement_guarded(
      p_request_id, p_warehouse_stock_id, 'correction', p_new_quantity, v_reason,
      p_expected_generation, p_source_document_number, p_notes
    ) || jsonb_build_object('requires_approval', false);
  END IF;

  INSERT INTO public.phoenix_warehouse_correction_requests (
    organization_id, warehouse_stock_id, on_hand_before, new_quantity, variance,
    reason, source_document_number, notes, proposed_by, underlying_request_id
  ) VALUES (
    v_stock.organization_id, v_stock.id, v_stock.on_hand_quantity, p_new_quantity, v_variance,
    v_reason, NULLIF(btrim(p_source_document_number), ''), NULLIF(btrim(p_notes), ''), v_actor, p_request_id
  )
  RETURNING id INTO v_req_id;

  RETURN jsonb_build_object(
    'ok', true, 'correction_request_id', v_req_id, 'status', 'pending',
    'requires_approval', true, 'variance', v_variance, 'threshold', v_threshold
  );
END;
$request$;

REVOKE ALL ON FUNCTION public.phoenix_request_warehouse_stock_correction(uuid, uuid, integer, text, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_request_warehouse_stock_correction(uuid, uuid, integer, text, bigint, text, text) TO authenticated;

-- ── D. Approve — a DIFFERENT authorized person, applies inline ─────────────

CREATE OR REPLACE FUNCTION public.phoenix_approve_warehouse_stock_correction(
  p_correction_request_id uuid,
  p_expected_generation   bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $approve$
DECLARE
  v_actor  uuid := auth.uid();
  v_req    public.phoenix_warehouse_correction_requests%ROWTYPE;
  v_stock  public.warehouse_stock%ROWTYPE;
  v_actor_role text;
  v_actor_name text;
  v_before integer;
  v_delta  integer;
  v_movement_id uuid;
  v_fp     text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_correction_request_id IS NULL THEN
    RAISE EXCEPTION 'correction_request_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_req
  FROM public.phoenix_warehouse_correction_requests WHERE id = p_correction_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correction_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'correction_request_not_pending' USING ERRCODE = '23514';
  END IF;
  IF v_req.proposed_by = v_actor THEN
    RAISE EXCEPTION 'proposer_cannot_approve_own_correction' USING ERRCODE = '42501';
  END IF;
  IF NOT public.phoenix_status_center_authorized(v_req.organization_id, 'warehouse_stock.approve_correction') THEN
    RAISE EXCEPTION 'forbidden_correction_approval' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_req.underlying_request_id::text, 65065));

  SELECT * INTO v_stock FROM public.warehouse_stock WHERE id = v_req.warehouse_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_expected_generation IS NOT NULL AND v_stock.movement_seq IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'warehouse_receipt_generation_conflict' USING ERRCODE = '40001',
      DETAIL = format('expected generation %s, canonical generation %s', p_expected_generation, v_stock.movement_seq);
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_delta  := v_req.new_quantity - v_before;
  IF v_req.new_quantity < 0 THEN
    RAISE EXCEPTION 'warehouse_quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;
  IF v_req.new_quantity < v_stock.reserved_quantity THEN
    RAISE EXCEPTION 'warehouse_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  v_fp := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'adjust', 'warehouse_stock_id', v_req.warehouse_stock_id, 'movement_type', 'correction',
    'amount', v_req.new_quantity, 'reason', v_req.reason,
    'source_document_number', v_req.source_document_number, 'notes', v_req.notes
  )::text, 'UTF8')), 'hex');

  UPDATE public.warehouse_stock
     SET on_hand_quantity = v_req.new_quantity,
         source_document_number = COALESCE(v_req.source_document_number, source_document_number),
         notes = COALESCE(v_req.notes, notes),
         updated_by = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id, movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot, dosage_form_snapshot,
    batch_number_snapshot, internal_batch_reference_snapshot
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'correction',
    v_before, v_delta, v_req.new_quantity,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    v_req.reason, 'warehouse_request', v_req.underlying_request_id, v_fp,
    v_req.source_document_number, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form,
    v_stock.batch_number, v_stock.internal_batch_reference
  )
  RETURNING id INTO v_movement_id;

  UPDATE public.phoenix_warehouse_correction_requests
     SET status = 'approved', decided_by = v_actor, decided_at = now(), applied_movement_id = v_movement_id
   WHERE id = v_req.id;

  RETURN jsonb_build_object(
    'ok', true, 'warehouse_stock_id', v_stock.id, 'movement_id', v_movement_id,
    'quantity_before', v_before, 'quantity_after', v_req.new_quantity,
    'correction_request_id', v_req.id, 'status', 'approved'
  );
END;
$approve$;

REVOKE ALL ON FUNCTION public.phoenix_approve_warehouse_stock_correction(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_approve_warehouse_stock_correction(uuid, bigint) TO authenticated;

-- ── E. Reject ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.phoenix_reject_warehouse_stock_correction(
  p_correction_request_id uuid,
  p_decision_reason       text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $reject$
DECLARE
  v_actor  uuid := auth.uid();
  v_req    public.phoenix_warehouse_correction_requests%ROWTYPE;
  v_reason text := NULLIF(btrim(p_decision_reason), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'decision_reason_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_req
  FROM public.phoenix_warehouse_correction_requests WHERE id = p_correction_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correction_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'correction_request_not_pending' USING ERRCODE = '23514';
  END IF;
  IF v_req.proposed_by = v_actor THEN
    RAISE EXCEPTION 'proposer_cannot_approve_own_correction' USING ERRCODE = '42501';
  END IF;
  IF NOT public.phoenix_status_center_authorized(v_req.organization_id, 'warehouse_stock.approve_correction') THEN
    RAISE EXCEPTION 'forbidden_correction_approval' USING ERRCODE = '42501';
  END IF;

  UPDATE public.phoenix_warehouse_correction_requests
     SET status = 'rejected', decided_by = v_actor, decided_at = now(), decision_reason = v_reason
   WHERE id = v_req.id;

  RETURN jsonb_build_object('ok', true, 'correction_request_id', v_req.id, 'status', 'rejected');
END;
$reject$;

REVOKE ALL ON FUNCTION public.phoenix_reject_warehouse_stock_correction(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_reject_warehouse_stock_correction(uuid, text) TO authenticated;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. warehouse_stock.approve_correction granted ONLY to central_warehouse_manager.
-- 2. phoenix_warehouse_correction_requests has zero rows post-apply.
-- 3. All three new RPCs exist exactly once, SECURITY DEFINER, pinned search_path.
-- ============================================================================
-- ROLLBACK: DROP the three functions, DROP TABLE
--   phoenix_warehouse_correction_requests, remove the new permission_keys/
--   role_permission_defaults row. 065/078's own RPCs are untouched.
-- ============================================================================
