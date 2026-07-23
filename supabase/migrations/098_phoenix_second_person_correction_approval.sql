-- ============================================================================
-- SECOND-PERSON-CORRECTION-APPROVAL-098-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 097.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS ADDS — Phase 2 contract: second-person approval for large stock
-- variances, fail-closed, server-configurable threshold (no invented number)
-- ─────────────────────────────────────────────────────────────────────────────
-- A canonical "sensitive material" flag does not exist anywhere in this
-- schema (checked before writing this file) — 072's inventory_signal_
-- thresholds is a reorder/near-expiry PLANNING threshold, unrelated to
-- approval gating, and 092's four-eyes confirm_missing is scoped to
-- suspected_missing classification only (explicitly excluded from this
-- item). So this migration gates on VARIANCE MAGNITUDE only, the one
-- dimension the schema actually has: |counted - on_hand| on an outlet stock
-- count/correction (067/086's phoenix_count_outlet_stock(_guarded)).
--
-- FAIL-CLOSED, NOT A CHOSEN NUMBER: the policy threshold DEFAULTS TO 0 per
-- organization (an explicit row is never required to exist — absence of a
-- row means threshold 0, not "no gate"). At threshold 0, EVERY nonzero
-- variance requires a second person; the org's own central_warehouse_manager
-- must explicitly raise the bar via phoenix_set_variance_approval_policy if
-- self-approved small corrections are wanted. No default was invented here
-- beyond "maximally strict until configured otherwise".
--
-- The proposer can never be the approver (checked by profile id, not role —
-- two different central_warehouse_managers still satisfies it; the SAME
-- person proposing and approving never does, regardless of role).
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure(
    'public.phoenix_count_outlet_stock_guarded(uuid,uuid,integer,text,bigint,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 086 phoenix_count_outlet_stock_guarded is missing';
  END IF;
  IF to_regclass('public.outlet_stock') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: public.outlet_stock is missing';
  END IF;
END;
$precond$;

-- ── A. Server-configurable, fail-closed policy ──────────────────────────────

CREATE TABLE public.phoenix_variance_approval_policy (
  organization_id     uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  threshold_quantity  integer NOT NULL DEFAULT 0 CHECK (threshold_quantity >= 0),
  updated_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.phoenix_variance_approval_policy IS
  'Per-organization second-person-approval threshold for outlet stock '
  'corrections. ABSENCE of a row for an org means threshold 0 (fail-closed: '
  'every nonzero variance requires a second person) — a row must be '
  'EXPLICITLY inserted to relax this, never implicitly assumed permissive.';

ALTER TABLE public.phoenix_variance_approval_policy ENABLE ROW LEVEL SECURITY;

CREATE POLICY phoenix_variance_approval_policy_select_scoped
  ON public.phoenix_variance_approval_policy
  FOR SELECT TO authenticated
  USING (
    public.phoenix_my_role() = 'super_admin'
    OR organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid())
  );

REVOKE INSERT, UPDATE, DELETE ON TABLE public.phoenix_variance_approval_policy FROM authenticated;
GRANT SELECT ON TABLE public.phoenix_variance_approval_policy TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_set_variance_approval_policy(
  p_organization_id    uuid,
  p_threshold_quantity integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $set_policy$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_threshold_quantity IS NULL OR p_threshold_quantity < 0 THEN
    RAISE EXCEPTION 'threshold_must_be_non_negative' USING ERRCODE = '23514';
  END IF;

  -- Reuses the EXISTING inventory.manage_thresholds key (092/072) —
  -- central_warehouse_manager-only, already the org's threshold owner. No
  -- new "who may configure this" permission is invented. Uses 092's OWN
  -- phoenix_status_center_authorized(org, key) helper, NOT
  -- phoenix_profile_has_scoped_permission(...,NULL,NULL) directly — 092's own
  -- history documents that both-NULL branch resolving true only for
  -- org-wide roles (institution_admin) silently locks out
  -- central_warehouse_manager regardless of the permission it actually
  -- holds. Repeating that exact bug here would be the same defect.
  IF NOT public.phoenix_status_center_authorized(p_organization_id, 'inventory.manage_thresholds') THEN
    RAISE EXCEPTION 'forbidden_variance_policy_set' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.phoenix_variance_approval_policy (organization_id, threshold_quantity, updated_by, updated_at)
  VALUES (p_organization_id, p_threshold_quantity, v_actor, now())
  ON CONFLICT (organization_id) DO UPDATE
    SET threshold_quantity = EXCLUDED.threshold_quantity,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;

  RETURN jsonb_build_object('ok', true, 'organization_id', p_organization_id, 'threshold_quantity', p_threshold_quantity);
END;
$set_policy$;

REVOKE ALL ON FUNCTION public.phoenix_set_variance_approval_policy(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_set_variance_approval_policy(uuid, integer) TO authenticated;

-- ── B. Pending correction requests (the gate itself) ────────────────────────

CREATE TABLE public.phoenix_stock_correction_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  outlet_stock_id     uuid NOT NULL REFERENCES public.outlet_stock(id) ON DELETE RESTRICT,
  on_hand_before      integer NOT NULL,
  counted_quantity    integer NOT NULL,
  variance            integer NOT NULL,
  reason              text NOT NULL,
  notes               text,
  status              text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  proposed_by         uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  proposed_at         timestamptz NOT NULL DEFAULT now(),
  underlying_request_id uuid NOT NULL UNIQUE,
  decided_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at          timestamptz,
  decision_reason     text,
  applied_movement_id uuid REFERENCES public.outlet_stock_movements(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.phoenix_stock_correction_requests IS
  'Pending second-person-approval outlet stock corrections. NEVER applies '
  'the correction itself — phoenix_approve_outlet_stock_correction delegates '
  'to the existing guarded RPC (086) once approved. proposed_by can never '
  'equal decided_by, enforced in the approve RPC, not just by convention.';

CREATE INDEX phoenix_stock_correction_requests_pending_idx
  ON public.phoenix_stock_correction_requests (organization_id, status);

ALTER TABLE public.phoenix_stock_correction_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY phoenix_stock_correction_requests_select_scoped
  ON public.phoenix_stock_correction_requests
  FOR SELECT TO authenticated
  USING (
    public.phoenix_my_role() = 'super_admin'
    OR organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid())
  );

REVOKE INSERT, UPDATE, DELETE ON TABLE public.phoenix_stock_correction_requests FROM authenticated;
GRANT SELECT ON TABLE public.phoenix_stock_correction_requests TO authenticated;

-- ── C. New approval permission — distinct from outlet_stock.count ──────────

INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous)
VALUES
  ('outlet_stock.approve_correction', 'outlet_stock', 'approve_correction',
   'Approve a large outlet stock correction proposed by someone else',
   'اعتماد تصحيح مخزون منفذ كبير اقترحه شخص آخر', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
VALUES
  ('central_warehouse_manager', 'outlet_stock.approve_correction', true)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ── D. Request — applies immediately if within threshold, else queues ──────

CREATE OR REPLACE FUNCTION public.phoenix_request_outlet_stock_correction(
  p_request_id          uuid,
  p_outlet_stock_id     uuid,
  p_counted_quantity    integer,
  p_reason              text,
  p_expected_generation bigint DEFAULT NULL,
  p_notes               text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $request$
DECLARE
  v_actor     uuid := auth.uid();
  v_stock     public.outlet_stock%ROWTYPE;
  v_existing  public.phoenix_stock_correction_requests%ROWTYPE;
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
  IF p_outlet_stock_id IS NULL THEN
    RAISE EXCEPTION 'outlet_stock_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_counted_quantity IS NULL OR p_counted_quantity < 0 THEN
    RAISE EXCEPTION 'counted_quantity_must_be_non_negative' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'outlet_count_reason_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 98098));

  -- Replay of a request id already queued or already applied.
  SELECT * INTO v_existing
  FROM public.phoenix_stock_correction_requests WHERE underlying_request_id = p_request_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'correction_request_id', v_existing.id, 'status', v_existing.status,
      'requires_approval', true
    );
  END IF;

  SELECT * INTO v_stock FROM public.outlet_stock WHERE id = p_outlet_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outlet_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.count', v_stock.organization_id, NULL, v_stock.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_stock_count' USING ERRCODE = '42501';
  END IF;

  v_variance := abs(p_counted_quantity - v_stock.on_hand_quantity);

  SELECT threshold_quantity INTO v_threshold
    FROM public.phoenix_variance_approval_policy WHERE organization_id = v_stock.organization_id;
  v_threshold := COALESCE(v_threshold, 0); -- fail-closed: no row = strictest

  IF v_variance <= v_threshold THEN
    -- Within policy: apply directly through the existing guarded RPC. No
    -- new pending row, no behavior change from before this migration.
    RETURN public.phoenix_count_outlet_stock_guarded(
      p_request_id, p_outlet_stock_id, p_counted_quantity, v_reason, p_expected_generation, p_notes
    ) || jsonb_build_object('requires_approval', false);
  END IF;

  -- Large variance: queue, do NOT touch outlet_stock.
  INSERT INTO public.phoenix_stock_correction_requests (
    organization_id, outlet_stock_id, on_hand_before, counted_quantity, variance,
    reason, notes, proposed_by, underlying_request_id
  ) VALUES (
    v_stock.organization_id, v_stock.id, v_stock.on_hand_quantity, p_counted_quantity, v_variance,
    v_reason, NULLIF(btrim(p_notes), ''), v_actor, p_request_id
  )
  RETURNING id INTO v_req_id;

  RETURN jsonb_build_object(
    'ok', true, 'correction_request_id', v_req_id, 'status', 'pending',
    'requires_approval', true, 'variance', v_variance, 'threshold', v_threshold
  );
END;
$request$;

REVOKE ALL ON FUNCTION public.phoenix_request_outlet_stock_correction(uuid, uuid, integer, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_request_outlet_stock_correction(uuid, uuid, integer, text, bigint, text) TO authenticated;

-- ── E. Approve — a DIFFERENT authorized person, applies via the same guarded RPC

CREATE OR REPLACE FUNCTION public.phoenix_approve_outlet_stock_correction(
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
  v_req    public.phoenix_stock_correction_requests%ROWTYPE;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_correction_request_id IS NULL THEN
    RAISE EXCEPTION 'correction_request_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_req
  FROM public.phoenix_stock_correction_requests WHERE id = p_correction_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correction_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'correction_request_not_pending' USING ERRCODE = '23514';
  END IF;

  -- THE gate: the proposer can never be their own approver, by identity, not
  -- by role — checked BEFORE the permission check so a proposer who also
  -- happens to hold the approval permission is still refused.
  IF v_req.proposed_by = v_actor THEN
    RAISE EXCEPTION 'proposer_cannot_approve_own_correction' USING ERRCODE = '42501';
  END IF;

  IF NOT public.phoenix_status_center_authorized(v_req.organization_id, 'outlet_stock.approve_correction') THEN
    RAISE EXCEPTION 'forbidden_correction_approval' USING ERRCODE = '42501';
  END IF;

  -- NOT delegated to phoenix_count_outlet_stock_guarded: that RPC
  -- authorizes against outlet_stock.count of the CURRENT caller, which
  -- would require the APPROVER to also hold counting authority —
  -- central_warehouse_manager (the only role granted approve_correction)
  -- deliberately does NOT hold outlet_stock.count (067), and it must not
  -- need to: approval authority is a stronger, independent gate already
  -- checked above, not a substitute for counting authority nor something
  -- that should require it. The write is therefore applied directly here,
  -- reusing 086/067's exact generation-guard + movement shape.
  DECLARE
    v_stock  public.outlet_stock%ROWTYPE;
    v_actor_role text;
    v_actor_name text;
    v_movement_id uuid;
    v_avail_id    uuid;
    v_fp          text;
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_req.underlying_request_id::text, 67067));

    SELECT * INTO v_stock FROM public.outlet_stock WHERE id = v_req.outlet_stock_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'outlet_stock_not_found' USING ERRCODE = 'P0002';
    END IF;

    IF p_expected_generation IS NOT NULL AND v_stock.movement_seq IS DISTINCT FROM p_expected_generation THEN
      RAISE EXCEPTION 'outlet_stock_generation_conflict' USING ERRCODE = '40001',
        DETAIL = format('expected generation %s, canonical generation %s', p_expected_generation, v_stock.movement_seq);
    END IF;
    IF v_req.counted_quantity < v_stock.reserved_quantity THEN
      RAISE EXCEPTION 'outlet_quantity_below_reserved' USING ERRCODE = '23514';
    END IF;

    SELECT p.role, p.full_name INTO v_actor_role, v_actor_name FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

    v_fp := encode(sha256(convert_to(jsonb_build_object(
      'operation', 'count', 'outlet_stock_id', v_req.outlet_stock_id,
      'counted_quantity', v_req.counted_quantity, 'reason', v_req.reason, 'notes', v_req.notes
    )::text, 'UTF8')), 'hex');

    UPDATE public.outlet_stock
       SET on_hand_quantity = v_req.counted_quantity, notes = COALESCE(v_req.notes, notes), updated_by = v_actor
     WHERE id = v_stock.id;

    INSERT INTO public.outlet_stock_movements (
      outlet_stock_id, organization_id, distribution_point_id, movement_type,
      on_hand_before, on_hand_delta, on_hand_after,
      reserved_before, reserved_delta, reserved_after,
      reason, reference_type, reference_id, request_fingerprint,
      actor_id, actor_role, actor_name,
      scientific_name_snapshot, concentration_snapshot, dosage_form_snapshot,
      batch_number_snapshot, internal_batch_reference_snapshot, expiry_date_snapshot
    ) VALUES (
      v_stock.id, v_stock.organization_id, v_stock.distribution_point_id, 'correction',
      v_stock.on_hand_quantity, v_req.counted_quantity - v_stock.on_hand_quantity, v_req.counted_quantity,
      v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
      v_req.reason, 'outlet_request', v_req.underlying_request_id, v_fp,
      v_actor, v_actor_role, v_actor_name,
      v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form,
      v_stock.batch_number, v_stock.internal_batch_reference, v_stock.expiry_date
    )
    RETURNING id INTO v_movement_id;

    v_avail_id := public.phoenix_project_outlet_availability(v_stock.id);

    v_result := jsonb_build_object(
      'ok', true, 'outlet_stock_id', v_stock.id, 'movement_id', v_movement_id,
      'quantity_before', v_stock.on_hand_quantity, 'quantity_after', v_req.counted_quantity
    );
  END;

  UPDATE public.phoenix_stock_correction_requests
     SET status = 'approved', decided_by = v_actor, decided_at = now(),
         applied_movement_id = NULLIF(v_result ->> 'movement_id', '')::uuid
   WHERE id = v_req.id;

  RETURN v_result || jsonb_build_object('correction_request_id', v_req.id, 'status', 'approved');
END;
$approve$;

REVOKE ALL ON FUNCTION public.phoenix_approve_outlet_stock_correction(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_approve_outlet_stock_correction(uuid, bigint) TO authenticated;

-- ── F. Reject — same non-self, same permission, no stock write at all ──────

CREATE OR REPLACE FUNCTION public.phoenix_reject_outlet_stock_correction(
  p_correction_request_id uuid,
  p_decision_reason        text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $reject$
DECLARE
  v_actor uuid := auth.uid();
  v_req   public.phoenix_stock_correction_requests%ROWTYPE;
  v_reason text := NULLIF(btrim(p_decision_reason), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'decision_reason_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_req
  FROM public.phoenix_stock_correction_requests WHERE id = p_correction_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correction_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'correction_request_not_pending' USING ERRCODE = '23514';
  END IF;
  IF v_req.proposed_by = v_actor THEN
    RAISE EXCEPTION 'proposer_cannot_approve_own_correction' USING ERRCODE = '42501';
  END IF;
  IF NOT public.phoenix_status_center_authorized(v_req.organization_id, 'outlet_stock.approve_correction') THEN
    RAISE EXCEPTION 'forbidden_correction_approval' USING ERRCODE = '42501';
  END IF;

  UPDATE public.phoenix_stock_correction_requests
     SET status = 'rejected', decided_by = v_actor, decided_at = now(), decision_reason = v_reason
   WHERE id = v_req.id;

  RETURN jsonb_build_object('ok', true, 'correction_request_id', v_req.id, 'status', 'rejected');
END;
$reject$;

REVOKE ALL ON FUNCTION public.phoenix_reject_outlet_stock_correction(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_reject_outlet_stock_correction(uuid, text) TO authenticated;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. phoenix_variance_approval_policy has zero rows post-apply (fail-closed
--    by absence): SELECT count(*) FROM phoenix_variance_approval_policy; -- 0
-- 2. outlet_stock.approve_correction granted ONLY to central_warehouse_manager.
-- 3. All four new RPCs exist exactly once, SECURITY DEFINER, pinned search_path.
-- ============================================================================
-- ROLLBACK: DROP the four new functions, DROP TABLE
--   phoenix_stock_correction_requests, DROP TABLE
--   phoenix_variance_approval_policy, remove the two new permission_keys/
--   role_permission_defaults rows. 086/067's guarded count RPC is completely
-- untouched, so direct (ungated) counting keeps working if this is rolled
-- back and the frontend is pointed back at it.
-- ============================================================================
-- FOLLOW-UP (NOT part of this migration)
-- ============================================================================
-- The same fail-closed/second-person pattern for WAREHOUSE-side corrections
-- (078's phoenix_apply_warehouse_stock_movement_guarded) is deferred —
-- proportional dynamic-test coverage, same reasoning as 096's FOLLOW-UP.
-- ============================================================================
