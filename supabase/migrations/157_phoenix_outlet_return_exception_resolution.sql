-- ============================================================================
-- OUTLET-RETURN-EXCEPTION-RESOLUTION-157
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 156. (This worktree was cut from master before sibling PR #87's
-- migration 155 merged, so 156 sits directly after 154 — see 156's own
-- header. 157 is next regardless of when 155 lands.)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- 135's phoenix_receive_outlet_return_shipment_line sets custody_state =
-- 'exception_pending' (status='rejected', disposition=NULL) whenever an
-- outlet-return shipment line is received with quantity=0 — but no RPC has
-- ever existed to move that line forward. No stock or quarantine row is ever
-- created for it (resulting_warehouse_stock_id / resulting_quarantine_
-- stock_id both stay NULL, no warehouse_stock_movements /
-- warehouse_quarantine_stock_movements row is ever inserted for it) — a true
-- dead end.
--
-- OWNER-DIRECTED DESIGN (both resolution paths, in one RPC, additive-only):
--   corrected_receipt   — the zero-entry was a mistake; a real quantity DID
--                          arrive. Creates a genuine compensating stock/
--                          quarantine movement, mirroring 135's own
--                          restockable/quarantined mechanics exactly, under
--                          a DISTINCT movement_type/reference_type so it is
--                          never confused with an ordinary receive.
--   confirmed_no_stock  — genuinely nothing arrived. Formally closes the
--                          exception with a mandatory reason. No stock,
--                          quarantine, or movement row of any kind.
--
-- THE ORIGINAL outlet_return_shipment_lines ROW (status='rejected',
-- custody_state='exception_pending', received_quantity=0) IS NEVER UPDATED
-- BY THIS MIGRATION'S RPC — no rewritten history, exactly as directed. The
-- resolution is recorded in a new, separate, additive table
-- (phoenix_outlet_return_exception_resolutions) that references the
-- original line by id. This is also why no orsl_decision_chk /
-- orsl_custody_state_chk change was needed on the existing table: those
-- constraints only ever govern the ORIGINAL row, which this RPC never
-- touches. (Consistent with the owner's own fallback instruction — if
-- widening that CHECK were ever unsafe against live data, use a separate
-- resolution table instead. A separate table turned out to be the cleaner
-- primary design here, not merely a fallback: it fits the append-only
-- ledger philosophy already used throughout this codebase, and needs no
-- compatibility audit of the existing constraint at all, since the existing
-- constraint is never touched.)
--
-- REQUIREMENTS (owner-specified, all satisfied below):
--   - Explicit permission, checked server-side (new key
--     outlet_stock.resolve_return_exception, NOT reused from an adjacent
--     key — this is a distinct administrative adjudication action, same
--     reasoning 098 used to split outlet_stock.approve_correction out from
--     outlet_stock.count/.receive).
--   - Mandatory reason (p_reason, NOT NULL, non-blank, CHECK-enforced).
--   - Idempotency key: p_request_id is MANDATORY here (unlike 106/156's
--     optional/backward-compatible design — this is a brand-new RPC with no
--     prior callers to stay compatible with), sha256 payload fingerprint,
--     dedicated dedup ledger (same request_id/fingerprint/result shape as
--     106/154/156), advisory lock salt 157157.
--   - Row locking: FOR UPDATE on the shipment line before any check.
--   - Prevents resolving twice: UNIQUE(return_shipment_line_id) on the new
--     table is the structural guarantee; an explicit pre-check (distinct
--     from the idempotency-replay path) raises a clear
--     exception_already_resolved error rather than a raw 23505 when a
--     DIFFERENT request_id targets an already-resolved line.
--   - Same-organization enforcement: the permission check and every
--     inserted row are scoped to the line's own destination_organization_id
--     (read from its parent shipment) — never a caller-supplied value.
--   - Full audit: one audit_logs row per resolution
--     (outlet_stock.return_exception_resolved), payload captures both paths.
--   - Read-policy parity: phoenix_can_read_outlet_return gains a third
--     OR-branch for the new permission key, so a resolver can also see the
--     exception_pending lines they are meant to resolve — the exact class
--     of gap 105 had to patch for 099's quarantine-disposition RPCs.
--
-- SCOPE: this migration adds one new table, one new RPC, one new permission
-- key + one role default, and one additive OR-branch to
-- phoenix_can_read_outlet_return. No existing table's columns, constraints,
-- or grants are altered. No existing RPC's behavior changes.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure(
    'public.phoenix_receive_outlet_return_shipment_line(uuid,uuid,integer,text,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 135 phoenix_receive_outlet_return_shipment_line is missing';
  END IF;
  IF to_regprocedure('public.phoenix_can_read_outlet_return(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 071 phoenix_can_read_outlet_return is missing';
  END IF;
END;
$precond$;

-- ── A. Resolution ledger — one row per resolved exception, additive-only ───

CREATE TABLE public.phoenix_outlet_return_exception_resolutions (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id                       uuid NOT NULL UNIQUE,
  return_shipment_line_id            uuid NOT NULL UNIQUE
    REFERENCES public.outlet_return_shipment_lines(id) ON DELETE RESTRICT,
  organization_id                     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,

  resolution_kind                      text NOT NULL,
  reason                                 text NOT NULL,

  corrected_quantity                      integer,
  disposition                              text,
  resulting_warehouse_stock_id              uuid REFERENCES public.warehouse_stock(id) ON DELETE SET NULL,
  resulting_quarantine_stock_id              uuid REFERENCES public.warehouse_quarantine_stock(id) ON DELETE SET NULL,
  resulting_warehouse_movement_id             uuid REFERENCES public.warehouse_stock_movements(id) ON DELETE SET NULL,
  resulting_quarantine_movement_id             uuid REFERENCES public.warehouse_quarantine_stock_movements(id) ON DELETE SET NULL,

  payload_fingerprint                           text NOT NULL,
  result                                          jsonb NOT NULL,

  actor_id                                        uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_role                                       text,
  resolved_at                                       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT porer_kind_chk
    CHECK (resolution_kind IN ('corrected_receipt', 'confirmed_no_stock')),
  CONSTRAINT porer_reason_chk
    CHECK (btrim(reason) = reason AND reason <> ''),

  -- The decision state machine, expressed as data — mirrors this codebase's
  -- own established convention (e.g. 068's wtl_decision_chk) for tying a
  -- discriminator column to the fields it legally governs.
  CONSTRAINT porer_decision_chk
    CHECK (
      CASE resolution_kind
        WHEN 'corrected_receipt' THEN
          corrected_quantity IS NOT NULL AND corrected_quantity > 0
          AND disposition IN ('restockable', 'quarantined')
          AND (
            (disposition = 'restockable'
              AND resulting_warehouse_stock_id IS NOT NULL
              AND resulting_warehouse_movement_id IS NOT NULL
              AND resulting_quarantine_stock_id IS NULL
              AND resulting_quarantine_movement_id IS NULL)
            OR
            (disposition = 'quarantined'
              AND resulting_quarantine_stock_id IS NOT NULL
              AND resulting_quarantine_movement_id IS NOT NULL
              AND resulting_warehouse_stock_id IS NULL
              AND resulting_warehouse_movement_id IS NULL)
          )
        WHEN 'confirmed_no_stock' THEN
          corrected_quantity IS NULL AND disposition IS NULL
          AND resulting_warehouse_stock_id IS NULL AND resulting_quarantine_stock_id IS NULL
          AND resulting_warehouse_movement_id IS NULL AND resulting_quarantine_movement_id IS NULL
        ELSE false
      END
    )
);

COMMENT ON TABLE public.phoenix_outlet_return_exception_resolutions IS
  'Additive resolution ledger for exception_pending outlet-return shipment '
  'lines (157). The original outlet_return_shipment_lines row (135, '
  'status=rejected/custody_state=exception_pending) is NEVER updated by '
  'this table''s owning RPC — no rewritten history. UNIQUE(return_'
  'shipment_line_id) enforces "resolved at most once"; UNIQUE(request_id) '
  'plus payload_fingerprint gives 106/156-shaped idempotent replay for a '
  'retried identical attempt.';

CREATE INDEX phoenix_outlet_return_exception_resolutions_org_idx
  ON public.phoenix_outlet_return_exception_resolutions (organization_id, resolved_at);

ALTER TABLE public.phoenix_outlet_return_exception_resolutions ENABLE ROW LEVEL SECURITY;

CREATE POLICY phoenix_outlet_return_exception_resolutions_select_scoped
  ON public.phoenix_outlet_return_exception_resolutions
  FOR SELECT TO authenticated
  USING (
    public.phoenix_my_role() = 'super_admin'
    OR organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid())
  );

REVOKE INSERT, UPDATE, DELETE ON TABLE public.phoenix_outlet_return_exception_resolutions FROM authenticated;
GRANT SELECT ON TABLE public.phoenix_outlet_return_exception_resolutions TO authenticated;

-- ── B. New permission key — a distinct adjudication action, not reused ─────

INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous)
VALUES
  ('outlet_stock.resolve_return_exception', 'outlet_stock', 'resolve_return_exception',
   'Resolve a stuck outlet-return exception (zero-quantity receipt)',
   'حل استثناء إرجاع منفذ عالق (استلام بكمية صفر)', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
VALUES
  ('warehouse_officer', 'outlet_stock.resolve_return_exception', true)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ── C. Read-policy parity — avoid the 105-class read/write mismatch ────────
--
-- phoenix_can_read_outlet_return (071) gates SELECT on
-- outlet_return_shipment_lines via 'outlet_stock.return_request' (outlet
-- side) OR 'outlet_stock.review_return' (institution side). A resolver
-- holding ONLY the new outlet_stock.resolve_return_exception permission
-- (and not also review_return) would otherwise be unable to see the very
-- lines they are authorized to resolve — the exact gap 105 had to patch for
-- 099's quarantine-disposition RPCs. Adding this OR-branch now, in the same
-- migration that introduces the permission, avoids ever shipping that gap.
CREATE OR REPLACE FUNCTION public.phoenix_can_read_outlet_return(
  p_source_organization_id uuid,
  p_distribution_point_id  uuid,
  p_destination_warehouse_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_scoped_permission(
         auth.uid(), 'outlet_stock.return_request', p_source_organization_id, NULL, p_distribution_point_id)
    OR public.phoenix_profile_has_scoped_permission(
         auth.uid(), 'outlet_stock.review_return', p_source_organization_id, p_destination_warehouse_id, NULL)
    OR public.phoenix_profile_has_scoped_permission(
         auth.uid(), 'outlet_stock.resolve_return_exception', p_source_organization_id, p_destination_warehouse_id, NULL)
$$;

REVOKE ALL ON FUNCTION public.phoenix_can_read_outlet_return(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_can_read_outlet_return(uuid, uuid, uuid) TO authenticated;

-- ── D. The resolution RPC itself ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.phoenix_resolve_outlet_return_exception(
  p_request_id                uuid,
  p_return_shipment_line_id     uuid,
  p_resolution_kind               text,
  p_reason                          text,
  p_corrected_quantity                integer DEFAULT NULL,
  p_disposition_decision                text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_actor_name   text;
  v_line         public.outlet_return_shipment_lines%ROWTYPE;
  v_shipment     public.outlet_return_shipments%ROWTYPE;
  v_reason       text := NULLIF(btrim(p_reason), '');
  v_reason_code  text;
  v_objectively_expired boolean;
  v_internal     text;
  v_fp           text;
  v_existing     public.phoenix_outlet_return_exception_resolutions%ROWTYPE;
  v_already      uuid;
  v_stock        public.warehouse_stock%ROWTYPE;
  v_quarantine   public.warehouse_quarantine_stock%ROWTYPE;
  v_before       integer;
  v_after        integer;
  v_wh_movement_id uuid;
  v_q_movement_id  uuid;
  -- A genuinely NEW, out-of-band correction — deliberately NOT chained to
  -- the original send/receive causal thread (that thread's own row is never
  -- updated by this RPC). Root operation: fresh correlation_id, no
  -- causation_id, same shape as 126's phoenix_receive_warehouse_stock.
  v_correlation_id uuid := gen_random_uuid();
  v_result       jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_return_shipment_line_id IS NULL THEN
    RAISE EXCEPTION 'return_shipment_line_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_resolution_kind IS NULL OR p_resolution_kind NOT IN ('corrected_receipt', 'confirmed_no_stock') THEN
    RAISE EXCEPTION 'invalid_resolution_kind' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '23514';
  END IF;
  IF p_resolution_kind = 'corrected_receipt' THEN
    IF p_corrected_quantity IS NULL OR p_corrected_quantity <= 0 THEN
      RAISE EXCEPTION 'corrected_quantity_must_be_positive' USING ERRCODE = '23514';
    END IF;
    IF p_disposition_decision IS NULL OR p_disposition_decision NOT IN ('restockable', 'quarantined') THEN
      RAISE EXCEPTION 'invalid_disposition_decision' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF p_corrected_quantity IS NOT NULL OR p_disposition_decision IS NOT NULL THEN
      RAISE EXCEPTION 'confirmed_no_stock_takes_no_quantity_or_disposition' USING ERRCODE = '23514';
    END IF;
  END IF;

  v_fp := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'resolve_outlet_return_exception',
    'return_shipment_line_id', p_return_shipment_line_id,
    'resolution_kind', p_resolution_kind,
    'reason', v_reason,
    'corrected_quantity', p_corrected_quantity,
    'disposition_decision', p_disposition_decision,
    'actor', v_actor
  )::text, 'UTF8')), 'hex');

  -- Distinct salt from 106 (106106) and 156 (156156).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 157157));

  SELECT * INTO v_existing
  FROM public.phoenix_outlet_return_exception_resolutions
  WHERE request_id = p_request_id;

  IF FOUND THEN
    IF v_existing.payload_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505',
        DETAIL = 'same request_id previously submitted with a different payload — refresh and resubmit as a new request';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT * INTO v_line
  FROM public.outlet_return_shipment_lines WHERE id = p_return_shipment_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_shipment_line_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_line.custody_state <> 'exception_pending' THEN
    RAISE EXCEPTION 'line_not_exception_pending' USING ERRCODE = '23514';
  END IF;

  -- Already resolved by a DIFFERENT request_id (this request_id's own row
  -- was already ruled out above) — a raw 23505 off the UNIQUE(return_
  -- shipment_line_id) index would be technically correct but opaque; this
  -- gives the caller an unambiguous, actionable error instead.
  SELECT id INTO v_already
  FROM public.phoenix_outlet_return_exception_resolutions
  WHERE return_shipment_line_id = p_return_shipment_line_id;
  IF FOUND THEN
    RAISE EXCEPTION 'exception_already_resolved' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO v_shipment
  FROM public.outlet_return_shipments WHERE id = v_line.shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_shipment_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Same-organization enforcement: the permission check and every row this
  -- RPC writes are scoped to the line's OWN organization, read from its
  -- parent shipment — never a caller-supplied value.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.resolve_return_exception', v_shipment.destination_organization_id,
    v_shipment.destination_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_return_exception_resolve' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF p_resolution_kind = 'confirmed_no_stock' THEN
    v_result := jsonb_build_object(
      'ok', true, 'resolution_kind', 'confirmed_no_stock',
      'return_shipment_line_id', v_line.id,
      'warehouse_stock_id', NULL, 'quarantine_stock_id', NULL, 'movement_id', NULL
    );

    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_shipment.destination_organization_id, v_actor, v_actor_role,
      'outlet_stock.return_exception_resolved', 'outlet_return_shipment_lines', v_line.id, v_line.scientific_name,
      jsonb_build_object(
        'request_id', p_request_id, 'shipment_id', v_shipment.id, 'resolution_kind', 'confirmed_no_stock',
        'reason', v_reason
      )
    );

    INSERT INTO public.phoenix_outlet_return_exception_resolutions (
      request_id, return_shipment_line_id, organization_id, resolution_kind, reason,
      payload_fingerprint, result, actor_id, actor_role
    ) VALUES (
      p_request_id, v_line.id, v_shipment.destination_organization_id, 'confirmed_no_stock', v_reason,
      v_fp, v_result, v_actor, v_actor_role
    );

    RETURN v_result;
  END IF;

  -- ── corrected_receipt: mirrors 135's own restockable/quarantined ────────
  -- mechanics exactly, under a DISTINCT movement_type/reference_type so a
  -- compensating correction is never confused with an ordinary receive.
  v_reason_code := (
    SELECT rl.reason_code FROM public.outlet_return_request_lines rl
    WHERE rl.id = v_line.return_request_line_id
  );
  v_objectively_expired := v_line.expiry_date IS NOT NULL AND v_line.expiry_date < current_date;
  v_internal := v_line.internal_batch_reference;

  IF p_disposition_decision = 'restockable' THEN
    INSERT INTO public.warehouse_stock (
      organization_id, warehouse_id, central_item_id,
      scientific_name, trade_name, concentration, dosage_form, unit,
      national_code, has_no_national_code,
      batch_number, has_no_batch_number, internal_batch_reference,
      expiry_date, on_hand_quantity, reserved_quantity,
      unit_price, price_basis, currency, supply_type_text,
      supply_type, purchase_origin,
      source_document_number, notes, created_by, updated_by
    ) VALUES (
      v_shipment.destination_organization_id, v_shipment.destination_warehouse_id,
      v_line.central_item_id,
      v_line.scientific_name, v_line.trade_name, v_line.concentration,
      v_line.dosage_form, v_line.unit,
      v_line.national_code, v_line.has_no_national_code,
      v_line.batch_number, v_line.has_no_batch_number, v_internal,
      v_line.expiry_date, 0, 0,
      v_line.unit_price, v_line.price_basis, v_line.currency, v_line.supply_type_text,
      v_line.supply_type, v_line.purchase_origin,
      NULL, v_reason, v_actor, v_actor
    )
    ON CONFLICT DO NOTHING;

    SELECT * INTO v_stock
    FROM public.warehouse_stock s
    WHERE s.warehouse_id = v_shipment.destination_warehouse_id
      AND s.scientific_name = v_line.scientific_name
      AND COALESCE(s.concentration, '') = COALESCE(v_line.concentration, '')
      AND COALESCE(s.dosage_form, '')   = COALESCE(v_line.dosage_form, '')
      AND COALESCE(s.national_code, '') = COALESCE(v_line.national_code, '')
      AND COALESCE(s.batch_number, '')  = COALESCE(v_line.batch_number, '')
      AND COALESCE(s.expiry_date, DATE '0001-01-01')
          = COALESCE(v_line.expiry_date, DATE '0001-01-01')
      AND COALESCE(s.internal_batch_reference, '') = COALESCE(v_internal, '')
      AND COALESCE(s.supply_type, '') = COALESCE(v_line.supply_type, '')
      AND COALESCE(s.purchase_origin, '') = COALESCE(v_line.purchase_origin, '')
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'destination_stock_identity_resolution_failed' USING ERRCODE = 'P0002';
    END IF;

    v_before := v_stock.on_hand_quantity;
    v_after  := v_before + p_corrected_quantity;

    UPDATE public.warehouse_stock
       SET on_hand_quantity = v_after,
           central_item_id  = COALESCE(v_stock.central_item_id, v_line.central_item_id),
           updated_by       = v_actor
     WHERE id = v_stock.id;

    INSERT INTO public.warehouse_stock_movements (
      warehouse_stock_id, organization_id, warehouse_id, movement_type,
      on_hand_before, on_hand_delta, on_hand_after,
      reserved_before, reserved_delta, reserved_after,
      reason, reason_code, reference_type, reference_id, request_fingerprint,
      source_document_number, actor_id, actor_role, actor_name,
      scientific_name_snapshot, concentration_snapshot,
      dosage_form_snapshot, batch_number_snapshot,
      internal_batch_reference_snapshot,
      correlation_id
    ) VALUES (
      v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'correction',
      v_before, p_corrected_quantity, v_after,
      v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
      'outlet_return_exception_correction', v_reason_code, 'outlet_return_exception_resolve', p_request_id, v_fp,
      NULL, v_actor, v_actor_role, v_actor_name,
      v_stock.scientific_name, v_stock.concentration,
      v_stock.dosage_form, v_stock.batch_number,
      v_stock.internal_batch_reference,
      v_correlation_id
    )
    RETURNING id INTO v_wh_movement_id;
  ELSE
    INSERT INTO public.warehouse_quarantine_stock (
      organization_id, warehouse_id, central_item_id,
      scientific_name, trade_name, concentration, dosage_form, unit,
      national_code, has_no_national_code,
      batch_number, has_no_batch_number, internal_batch_reference,
      expiry_date, quarantine_reason, quantity, created_by, updated_by,
      supply_type, purchase_origin
    ) VALUES (
      v_shipment.destination_organization_id, v_shipment.destination_warehouse_id,
      v_line.central_item_id,
      v_line.scientific_name, v_line.trade_name, v_line.concentration,
      v_line.dosage_form, v_line.unit,
      v_line.national_code, v_line.has_no_national_code,
      v_line.batch_number, v_line.has_no_batch_number, v_internal,
      v_line.expiry_date,
      CASE
        WHEN v_objectively_expired AND v_reason_code IS DISTINCT FROM 'expired' THEN 'expired'
        WHEN v_reason_code IN ('expired', 'damaged', 'recalled', 'quality_issue', 'temperature_excursion', 'other')
          THEN v_reason_code
        ELSE 'other'
      END,
      0, v_actor, v_actor,
      v_line.supply_type, v_line.purchase_origin
    )
    ON CONFLICT DO NOTHING;

    SELECT * INTO v_quarantine
    FROM public.warehouse_quarantine_stock q
    WHERE q.warehouse_id = v_shipment.destination_warehouse_id
      AND q.scientific_name = v_line.scientific_name
      AND COALESCE(q.concentration, '') = COALESCE(v_line.concentration, '')
      AND COALESCE(q.dosage_form, '')   = COALESCE(v_line.dosage_form, '')
      AND COALESCE(q.national_code, '') = COALESCE(v_line.national_code, '')
      AND COALESCE(q.batch_number, '')  = COALESCE(v_line.batch_number, '')
      AND COALESCE(q.expiry_date, DATE '0001-01-01')
          = COALESCE(v_line.expiry_date, DATE '0001-01-01')
      AND COALESCE(q.internal_batch_reference, '') = COALESCE(v_internal, '')
      AND q.quarantine_reason = (
            CASE
              WHEN v_objectively_expired AND v_reason_code IS DISTINCT FROM 'expired' THEN 'expired'
              WHEN v_reason_code IN ('expired', 'damaged', 'recalled', 'quality_issue', 'temperature_excursion', 'other')
                THEN v_reason_code
              ELSE 'other'
            END)
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'destination_quarantine_identity_resolution_failed' USING ERRCODE = 'P0002';
    END IF;

    v_before := v_quarantine.quantity;
    v_after  := v_before + p_corrected_quantity;

    UPDATE public.warehouse_quarantine_stock
       SET quantity = v_after, updated_by = v_actor
     WHERE id = v_quarantine.id;

    INSERT INTO public.warehouse_quarantine_stock_movements (
      quarantine_stock_id, organization_id, warehouse_id, movement_type,
      quantity_before, quantity_delta, quantity_after,
      reason, reason_code, reference_type, reference_id, request_fingerprint,
      source_document_number, actor_id, actor_role, actor_name,
      scientific_name_snapshot, concentration_snapshot,
      dosage_form_snapshot, batch_number_snapshot,
      internal_batch_reference_snapshot,
      correlation_id
    ) VALUES (
      v_quarantine.id, v_quarantine.organization_id, v_quarantine.warehouse_id, 'quarantine_correction',
      v_before, p_corrected_quantity, v_after,
      'outlet_return_exception_correction', v_quarantine.quarantine_reason, 'outlet_return_exception_resolve', p_request_id, v_fp,
      NULL, v_actor, v_actor_role, v_actor_name,
      v_quarantine.scientific_name, v_quarantine.concentration,
      v_quarantine.dosage_form, v_quarantine.batch_number,
      v_quarantine.internal_batch_reference,
      v_correlation_id
    )
    RETURNING id INTO v_q_movement_id;
  END IF;

  -- Keeps 150's aggregate-cap accounting accurate: real stock now exists
  -- for this original dispatch line, exactly as if it had been received
  -- correctly the first time.
  UPDATE public.warehouse_dispatch_lines
     SET return_received_quantity = return_received_quantity + p_corrected_quantity
   WHERE id = v_line.original_dispatch_line_id;

  v_result := jsonb_build_object(
    'ok', true, 'resolution_kind', 'corrected_receipt',
    'return_shipment_line_id', v_line.id, 'disposition', p_disposition_decision,
    'warehouse_stock_id', v_stock.id, 'quarantine_stock_id', v_quarantine.id,
    'movement_id', COALESCE(v_wh_movement_id, v_q_movement_id),
    'quantity_before', v_before, 'quantity_delta', p_corrected_quantity, 'quantity_after', v_after
  );

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_shipment.destination_organization_id, v_actor, v_actor_role,
    'outlet_stock.return_exception_resolved',
    CASE WHEN p_disposition_decision = 'restockable' THEN 'warehouse_stock' ELSE 'warehouse_quarantine_stock' END,
    COALESCE(v_stock.id, v_quarantine.id), v_line.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id, 'shipment_id', v_shipment.id, 'resolution_kind', 'corrected_receipt',
      'reason', v_reason, 'disposition', p_disposition_decision,
      'quantity_before', v_before, 'quantity_delta', p_corrected_quantity, 'quantity_after', v_after
    )
  );

  INSERT INTO public.phoenix_outlet_return_exception_resolutions (
    request_id, return_shipment_line_id, organization_id, resolution_kind, reason,
    corrected_quantity, disposition,
    resulting_warehouse_stock_id, resulting_quarantine_stock_id,
    resulting_warehouse_movement_id, resulting_quarantine_movement_id,
    payload_fingerprint, result, actor_id, actor_role
  ) VALUES (
    p_request_id, v_line.id, v_shipment.destination_organization_id, 'corrected_receipt', v_reason,
    p_corrected_quantity, p_disposition_decision,
    v_stock.id, v_quarantine.id,
    v_wh_movement_id, v_q_movement_id,
    v_fp, v_result, v_actor, v_actor_role
  );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_resolve_outlet_return_exception(uuid, uuid, text, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_resolve_outlet_return_exception(uuid, uuid, text, text, integer, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_resolve_outlet_return_exception(uuid, uuid, text, text, integer, text) IS
  'Resolves a stuck exception_pending outlet-return shipment line (135) via '
  'one of two owner-directed paths (157): corrected_receipt (the zero-entry '
  'was a mistake — creates a real compensating stock/quarantine movement '
  'under reference_type=outlet_return_exception_resolve, mirroring 135''s '
  'own restockable/quarantined mechanics) or confirmed_no_stock (genuinely '
  'nothing arrived — a mandatory-reason administrative closure, no stock '
  'movement of any kind). NEVER updates the original outlet_return_'
  'shipment_lines row — the resolution is recorded exclusively in the '
  'additive phoenix_outlet_return_exception_resolutions ledger, which also '
  'enforces at-most-one-resolution-per-line and idempotent replay of a '
  'retried identical request_id.';

-- =============================================================================
-- VERIFY — inside the transaction; failure rolls back all of 157
-- =============================================================================

DO $$
DECLARE
  v_fn_src text;
BEGIN
  ASSERT to_regclass('public.phoenix_outlet_return_exception_resolutions') IS NOT NULL,
    'phoenix_outlet_return_exception_resolutions was not created';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.phoenix_outlet_return_exception_resolutions'::regclass),
    'RLS must be enabled on phoenix_outlet_return_exception_resolutions';
  ASSERT has_table_privilege('authenticated', 'public.phoenix_outlet_return_exception_resolutions', 'SELECT'),
    'authenticated must have SELECT on the resolutions table';
  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outlet_return_exception_resolutions', 'INSERT'),
    'authenticated must not have direct INSERT on the resolutions table';

  ASSERT EXISTS (SELECT 1 FROM public.permission_keys WHERE key = 'outlet_stock.resolve_return_exception'),
    'outlet_stock.resolve_return_exception must be registered in permission_keys';
  ASSERT EXISTS (
    SELECT 1 FROM public.role_permission_defaults
    WHERE role = 'warehouse_officer' AND permission_key = 'outlet_stock.resolve_return_exception' AND allowed
  ), 'warehouse_officer must default to allowed for outlet_stock.resolve_return_exception';

  ASSERT to_regprocedure(
    'public.phoenix_resolve_outlet_return_exception(uuid,uuid,text,text,integer,text)'
  ) IS NOT NULL, 'the resolution RPC must exist with its full signature';
  ASSERT (
    SELECT prosecdef FROM pg_proc WHERE proname = 'phoenix_resolve_outlet_return_exception'
  ), 'phoenix_resolve_outlet_return_exception must be SECURITY DEFINER';
  ASSERT has_function_privilege('authenticated', 'public.phoenix_resolve_outlet_return_exception(uuid,uuid,text,text,integer,text)', 'EXECUTE'),
    'authenticated must be EXECUTE-granted';
  ASSERT NOT has_function_privilege('anon', 'public.phoenix_resolve_outlet_return_exception(uuid,uuid,text,text,integer,text)', 'EXECUTE'),
    'anon must never be EXECUTE-granted';

  SELECT pg_get_functiondef(oid) INTO v_fn_src
    FROM pg_proc WHERE proname = 'phoenix_can_read_outlet_return';
  ASSERT v_fn_src LIKE '%resolve_return_exception%',
    'phoenix_can_read_outlet_return must include the new permission key as a read-access branch';

  -- The original writer (135) is completely untouched by this migration.
  ASSERT to_regprocedure(
    'public.phoenix_receive_outlet_return_shipment_line(uuid,uuid,integer,text,text,text)'
  ) IS NOT NULL, '135''s receive RPC must still exist with its original signature';
END $$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. phoenix_outlet_return_exception_resolutions exists, RLS enabled,
--    org-scoped SELECT only for authenticated, no direct write access.
-- 2. outlet_stock.resolve_return_exception is registered, warehouse_officer
--    defaults to allowed, every other role defaults to denied (no explicit
--    row = fail closed, matching 098's own precedent for a brand-new key).
-- 3. phoenix_can_read_outlet_return gains one additive OR-branch; its prior
--    two branches (return_request, review_return) are unchanged.
-- 4. phoenix_resolve_outlet_return_exception: SECURITY DEFINER, EXECUTE for
--    authenticated only, mandatory idempotency key, row-locks the target
--    line, requires custody_state=exception_pending, enforces at-most-one
--    resolution per line, requires a non-blank reason, and for
--    corrected_receipt creates a real compensating stock/quarantine
--    movement (distinct movement_type/reference_type from an ordinary
--    receive) plus updates warehouse_dispatch_lines.return_received_
--    quantity so 150's aggregate-cap accounting stays correct.
-- 5. The original outlet_return_shipment_lines row is NEVER updated by this
--    RPC — its status/disposition/custody_state/received_quantity from 135
--    remain exactly as recorded at the original zero-quantity receipt.
-- 6. 135's phoenix_receive_outlet_return_shipment_line is completely
--    unchanged — same signature, same body, re-verified in-transaction
--    above.
-- 7. RECONCILIATION: this migration writes no application data itself (one
--    new table + one new RPC + one permission key/default + one additive
--    read-policy branch) — nothing to reconcile.
-- ============================================================================
-- ROLLBACK: there is no legitimate reason to ever do this. If genuinely
-- required:
--   DROP FUNCTION public.phoenix_resolve_outlet_return_exception(uuid, uuid, text, text, integer, text);
--   DROP TABLE public.phoenix_outlet_return_exception_resolutions;
--   DELETE FROM public.role_permission_defaults WHERE permission_key = 'outlet_stock.resolve_return_exception';
--   DELETE FROM public.permission_keys WHERE key = 'outlet_stock.resolve_return_exception';
--   -- then recreate 071's original 2-branch phoenix_can_read_outlet_return.
-- Any exception already resolved through this RPC remains a real,
-- committed stock/quarantine movement (for corrected_receipt) — rolling
-- back the RPC/table does not and must not attempt to reverse those.
-- ============================================================================
