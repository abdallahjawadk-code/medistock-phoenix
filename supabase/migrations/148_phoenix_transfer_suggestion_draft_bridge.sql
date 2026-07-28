-- =============================================================================
-- MediStock Phoenix — Migration 148: Transfer Suggestion Draft Bridge
-- MANUAL APPLY ONLY. DO NOT use `npx supabase db push` or any automated runner.
-- Apply after 145. Forward-only — no applied migration is edited.
-- =============================================================================
--
-- WHAT THIS CLOSES
-- -----------------------------------------------------------------------------
-- Migration 072 built a real, FEFO-guarded, conservation-checked transfer
-- recommendation engine (inventory_transfer_suggestions), but structurally
-- forbade acting on it: `inventory_suggestions_no_accept_chk` makes
-- status='accepted' impossible for ANY writer, including service_role, and
-- `phoenix_accept_inventory_transfer_suggestion` unconditionally raised
-- 'acceptance_disabled_recommendation_only'. Separately, three real, live,
-- hardened execution corridors already exist and were never connected to any
-- suggestion: warehouse_transfer_requests (068/077, central<->institution),
-- warehouse_dispatches (070, warehouse->outlet), outlet_return_requests (071,
-- outlet->warehouse).
--
-- This migration bridges ONE suggestion to ONE real draft document in its own
-- corridor's existing RPCs, per route_kind:
--   central_to_institution -> phoenix_create_direct_warehouse_transfer_request
--                              + phoenix_add_warehouse_transfer_request_line  (068/077)
--   warehouse_to_outlet    -> phoenix_create_warehouse_dispatch
--                              + phoenix_add_dispatch_line_fefo_guarded        (070/107)
--   outlet_to_warehouse    -> phoenix_request_outlet_return
--                              + phoenix_add_outlet_return_request_line       (071)
--
-- No fourth movement engine is introduced. inter_org_exchange_requests
-- (migrations 040/041) is NOT resurrected — it remains in the database,
-- unused, as it was before this migration (no runtime caller then or now).
--
-- NAMING (reviewer requirement): the new RPC is named
-- `phoenix_create_transfer_draft_from_suggestion`, not "accept" — its result
-- is a DRAFT document in the normal submit/review/send/receive lifecycle of
-- its corridor, never a stock movement by itself. `inventory_transfer_
-- suggestions.status` keeps its existing 'accepted' enum spelling (renaming
-- it would require re-deriving ~20 call sites inside the large, already-
-- applied allocator/guard functions in 072/077 solely for a cosmetic rename,
-- for no safety benefit — those functions are untouched by this migration).
-- Every user-facing surface (RPC name, audit log, UI copy, tests) says
-- "draft", never "accept"/"execute". What DOES change, and is the actual
-- safety fix: status='accepted' now REQUIRES a real foreign key to one of the
-- three document tables above (enforced by
-- inventory_suggestions_draft_fk_matches_route_chk below) — a bare UUID can
-- no longer stand in for proof a document exists.
--
-- DEPRECATION NOTE (reviewer requirement, no deletion in this migration):
-- src/features/alerts/inter-institution-alerts.service.ts + .ts (migration
-- 009 legacy RPC wrapper) are marked @deprecated in a prior commit on this
-- branch. Neither this migration nor this branch drops the 009 RPC or the
-- 040/041 tables/RPCs — physical removal is deferred to an independent
-- cleanup PR after a monitoring window, per review guidance on this
-- high-risk change.
-- =============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.inventory_transfer_suggestions') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 072 inventory_transfer_suggestions is missing';
  END IF;
  IF to_regclass('public.warehouse_transfer_requests') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 068 warehouse_transfer_requests is missing';
  END IF;
  IF to_regclass('public.warehouse_dispatches') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 061 warehouse_dispatches is missing';
  END IF;
  IF to_regclass('public.outlet_return_requests') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 071 outlet_return_requests is missing';
  END IF;
  IF to_regprocedure('public.phoenix_create_direct_warehouse_transfer_request(uuid,uuid,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 077 phoenix_create_direct_warehouse_transfer_request is missing';
  END IF;
  IF to_regprocedure('public.phoenix_add_warehouse_transfer_request_line(uuid,text,integer,uuid,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 077 phoenix_add_warehouse_transfer_request_line is missing';
  END IF;
  IF to_regprocedure('public.phoenix_create_warehouse_dispatch(uuid,uuid,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 070 phoenix_create_warehouse_dispatch is missing';
  END IF;
  IF to_regprocedure('public.phoenix_add_dispatch_line_fefo_guarded(uuid,uuid,integer,boolean,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 107 phoenix_add_dispatch_line_fefo_guarded is missing';
  END IF;
  IF to_regprocedure('public.phoenix_request_outlet_return(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 071 phoenix_request_outlet_return is missing';
  END IF;
  IF to_regprocedure('public.phoenix_add_outlet_return_request_line(uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 071 phoenix_add_outlet_return_request_line is missing';
  END IF;
  IF to_regprocedure('public.phoenix_get_live_inter_institution_alerts_with_state(integer)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 039 phoenix_get_live_inter_institution_alerts_with_state is missing';
  END IF;
END;
$precond$;

-- ============================================================================
-- 1. STRUCTURAL PROOF — three real FK columns, no polymorphic UUID.
-- ============================================================================
ALTER TABLE public.inventory_transfer_suggestions
  ADD COLUMN IF NOT EXISTS draft_warehouse_transfer_request_id uuid
    REFERENCES public.warehouse_transfer_requests(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS draft_warehouse_dispatch_id uuid
    REFERENCES public.warehouse_dispatches(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS draft_outlet_return_request_id uuid
    REFERENCES public.outlet_return_requests(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS draft_document_number text;

COMMENT ON COLUMN public.inventory_transfer_suggestions.draft_warehouse_transfer_request_id IS
  'Set only when route_kind=central_to_institution and status=accepted. Real FK — '
  'proves a warehouse_transfer_requests draft exists; never a bare id.';
COMMENT ON COLUMN public.inventory_transfer_suggestions.draft_warehouse_dispatch_id IS
  'Set only when route_kind=warehouse_to_outlet and status=accepted. Real FK — '
  'proves a warehouse_dispatches draft exists; never a bare id.';
COMMENT ON COLUMN public.inventory_transfer_suggestions.draft_outlet_return_request_id IS
  'Set only when route_kind=outlet_to_warehouse and status=accepted. Real FK — '
  'proves an outlet_return_requests draft exists; never a bare id.';
COMMENT ON COLUMN public.inventory_transfer_suggestions.accepted_at IS
  '148: timestamps when phoenix_create_transfer_draft_from_suggestion created a '
  'real draft document in the corridor matching route_kind — NOT an execution, '
  'acceptance, or stock movement. The stock movement happens later, only via the '
  'draft document''s own send/receive RPCs.';
COMMENT ON COLUMN public.inventory_transfer_suggestions.accepted_by IS
  '148: actor who created the draft document (see accepted_at). Reserved column '
  'name kept from 072 for schema stability; semantics documented here.';

-- Drop the Round-5 total prohibition — replaced below by a narrower rule that
-- permits status='accepted' ONLY when a real, FK-proven draft document for the
-- matching route_kind exists (never a bare id, never any other route_kind).
ALTER TABLE public.inventory_transfer_suggestions
  DROP CONSTRAINT IF EXISTS inventory_suggestions_no_accept_chk,
  DROP CONSTRAINT IF EXISTS inventory_suggestions_no_accept_fields_chk;

ALTER TABLE public.inventory_transfer_suggestions
  ADD CONSTRAINT inventory_suggestions_draft_fk_matches_route_chk CHECK (
    CASE
      WHEN status <> 'accepted' THEN
        draft_warehouse_transfer_request_id IS NULL
        AND draft_warehouse_dispatch_id IS NULL
        AND draft_outlet_return_request_id IS NULL
      WHEN route_kind = 'central_to_institution' THEN
        draft_warehouse_transfer_request_id IS NOT NULL
        AND draft_warehouse_dispatch_id IS NULL
        AND draft_outlet_return_request_id IS NULL
      WHEN route_kind = 'warehouse_to_outlet' THEN
        draft_warehouse_dispatch_id IS NOT NULL
        AND draft_warehouse_transfer_request_id IS NULL
        AND draft_outlet_return_request_id IS NULL
      WHEN route_kind = 'outlet_to_warehouse' THEN
        draft_outlet_return_request_id IS NOT NULL
        AND draft_warehouse_transfer_request_id IS NULL
        AND draft_warehouse_dispatch_id IS NULL
      ELSE false
    END
  );

ALTER TABLE public.inventory_transfer_suggestions
  ADD CONSTRAINT inventory_suggestions_accept_fields_chk CHECK (
    (status = 'accepted') = (
      accepted_at IS NOT NULL AND accepted_by IS NOT NULL
      AND draft_document_number IS NOT NULL AND btrim(draft_document_number) <> ''
    )
  );

-- The old stub never had a real caller (it only ever raised an exception) and
-- is fully superseded by phoenix_create_transfer_draft_from_suggestion below.
DROP FUNCTION IF EXISTS public.phoenix_accept_inventory_transfer_suggestion(uuid);

-- ============================================================================
-- 2. STALENESS POLICY — admin-configurable, documented default, never a
--    silent literal inside the draft-creation RPC.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.inventory_suggestion_policy (
  organization_id   uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  staleness_minutes integer NOT NULL DEFAULT 30
    CONSTRAINT inventory_suggestion_policy_staleness_chk CHECK (staleness_minutes BETWEEN 1 AND 1440),
  updated_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.inventory_suggestion_policy IS
  '148: per-organization override of how long a suggestion''s last_validated_at '
  'may age before phoenix_create_transfer_draft_from_suggestion refuses it and '
  'requires re-validation. No row = 30-minute documented default.';

ALTER TABLE public.inventory_suggestion_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.inventory_suggestion_policy FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.inventory_suggestion_policy TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.inventory_suggestion_policy FROM authenticated;

DROP POLICY IF EXISTS inventory_suggestion_policy_select_scoped ON public.inventory_suggestion_policy;
CREATE POLICY inventory_suggestion_policy_select_scoped
  ON public.inventory_suggestion_policy FOR SELECT TO authenticated
  USING (
    public.phoenix_my_role() = 'super_admin'
    OR organization_id = public.phoenix_my_org()
  );

CREATE OR REPLACE FUNCTION public.phoenix_upsert_inventory_suggestion_policy(
  p_organization_id   uuid,
  p_staleness_minutes integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_organization_id IS NULL THEN RAISE EXCEPTION 'organization_id_required'; END IF;
  IF p_staleness_minutes IS NULL OR p_staleness_minutes < 1 OR p_staleness_minutes > 1440 THEN
    RAISE EXCEPTION 'staleness_minutes_out_of_range';
  END IF;
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_permission(v_actor, 'inventory.manage_thresholds')
  ) THEN
    RAISE EXCEPTION 'not_authorized_inventory_manage_thresholds';
  END IF;

  INSERT INTO public.inventory_suggestion_policy (organization_id, staleness_minutes, updated_by, updated_at)
  VALUES (p_organization_id, p_staleness_minutes, v_actor, now())
  ON CONFLICT (organization_id) DO UPDATE SET
    staleness_minutes = EXCLUDED.staleness_minutes,
    updated_by = EXCLUDED.updated_by,
    updated_at = EXCLUDED.updated_at;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (p_organization_id, v_actor, public.phoenix_my_role(), 'update', 'inventory_suggestion_policy',
          p_organization_id, 'staleness_minutes', jsonb_build_object('staleness_minutes', p_staleness_minutes));

  RETURN jsonb_build_object('ok', true, 'organization_id', p_organization_id, 'staleness_minutes', p_staleness_minutes);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_upsert_inventory_suggestion_policy(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_upsert_inventory_suggestion_policy(uuid, integer) TO authenticated;

-- ============================================================================
-- 3. THE BRIDGE — one suggestion, full re-verification, one real draft.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_create_transfer_draft_from_suggestion(
  p_suggestion_id    uuid,
  p_document_number  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor               uuid := auth.uid();
  v_doc                 text := NULLIF(btrim(p_document_number), '');
  v_s                   public.inventory_transfer_suggestions%ROWTYPE;
  v_policy_minutes      integer;
  v_lock_a              text;
  v_lock_b              text;
  v_headroom            integer;
  v_deficit             integer;
  v_batch_available     integer;
  v_batch_committed     integer;
  v_batch_remaining     integer;
  v_returnable          integer;
  v_eligible            integer;
  v_src_central_item_id uuid;
  v_src_concentration   text;
  v_src_dosage_form     text;
  v_src_unit            text;
  v_src_scientific_name text;
  v_create_result       jsonb;
  v_request_id          uuid;
  v_dispatch_id         uuid;
  v_return_request_id   uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF v_doc IS NULL THEN RAISE EXCEPTION 'document_number_required'; END IF;

  SELECT * INTO v_s FROM public.inventory_transfer_suggestions WHERE id = p_suggestion_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found'; END IF;

  -- Idempotent replay: the SAME actor re-submitting an already-drafted
  -- suggestion (e.g. after a client-side timeout on an already-committed
  -- call) gets the same result back instead of an error. A DIFFERENT actor
  -- retrying a suggestion someone else already drafted is refused.
  IF v_s.status = 'accepted' THEN
    IF v_s.accepted_by = v_actor THEN
      RETURN jsonb_build_object(
        'ok', true, 'suggestion_id', v_s.id, 'idempotent_replay', true,
        'route_kind', v_s.route_kind, 'quantity', v_s.suggested_quantity,
        'document_number', v_s.draft_document_number,
        'warehouse_transfer_request_id', v_s.draft_warehouse_transfer_request_id,
        'warehouse_dispatch_id', v_s.draft_warehouse_dispatch_id,
        'outlet_return_request_id', v_s.draft_outlet_return_request_id
      );
    END IF;
    RAISE EXCEPTION 'suggestion_already_drafted';
  END IF;
  IF v_s.status <> 'open' THEN RAISE EXCEPTION 'suggestion_not_open'; END IF;

  -- Gate 1 of 2: caller may interact with the suggestion queue at either
  -- endpoint (same permission phoenix_reject_inventory_transfer_suggestion
  -- already uses). This is NOT sufficient authority to create the real
  -- document — gate 2 is enforced by delegation below.
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR (v_s.source_scope_kind = 'warehouse' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions', v_s.source_organization_id, v_s.source_scope_id, NULL))
    OR (v_s.source_scope_kind = 'outlet' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions', v_s.source_organization_id, NULL, v_s.source_scope_id))
    OR (v_s.target_scope_kind = 'warehouse' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions', v_s.target_organization_id, v_s.target_scope_id, NULL))
    OR (v_s.target_scope_kind = 'outlet' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions', v_s.target_organization_id, NULL, v_s.target_scope_id))
  ) THEN RAISE EXCEPTION 'not_authorized_inventory_act'; END IF;

  SELECT staleness_minutes INTO v_policy_minutes
  FROM public.inventory_suggestion_policy WHERE organization_id = v_s.source_organization_id;
  IF v_s.last_validated_at < now() - make_interval(mins => COALESCE(v_policy_minutes, 30)) THEN
    RAISE EXCEPTION 'suggestion_stale_revalidate_required';
  END IF;

  -- Fixed lock order (lexicographic on the two ids involved) so a concurrent
  -- draft-creation touching the same source/target pair from the other
  -- direction can never deadlock against this one.
  v_lock_a := LEAST(v_s.source_stock_id::text, v_s.target_scope_id::text);
  v_lock_b := GREATEST(v_s.source_stock_id::text, v_s.target_scope_id::text);
  PERFORM pg_advisory_xact_lock(hashtextextended('inv_suggestion_draft:' || v_lock_a, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('inv_suggestion_draft:' || v_lock_b, 0));

  -- ── FULL re-verification, not LEAST(snapshot, current_available) ─────────
  -- Re-derives the exact same live numbers phoenix_suggest_inventory_transfers
  -- / phoenix_suggest_cross_org_inventory_transfer would compute right now,
  -- scoped to this one suggestion, inside this transaction, under the locks
  -- above — so nothing here can be beaten by a concurrent draft on the same
  -- surplus or the same batch.

  -- Source surplus (live), minus every OTHER open/accepted suggestion drawing
  -- on the same source scope+material.
  SELECT GREATEST(COALESCE(a.observed_available, 0) - COALESCE(a.threshold_target_max, 0), 0)
    INTO v_headroom
  FROM public.inventory_alerts a
  WHERE a.organization_id = v_s.source_organization_id
    AND a.scope_kind = v_s.source_scope_kind AND a.scope_id = v_s.source_scope_id
    AND a.signal_type = 'surplus'
    AND a.status IN ('open', 'acknowledged', 'in_progress')
    AND lower(a.scientific_name) = lower(v_s.scientific_name)
    AND a.national_code IS NOT DISTINCT FROM v_s.national_code
  ORDER BY a.last_observed_at DESC LIMIT 1;
  IF v_headroom IS NULL OR v_headroom <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: no_source_surplus';
  END IF;
  v_headroom := v_headroom - COALESCE((
    SELECT SUM(s.suggested_quantity) FROM public.inventory_transfer_suggestions s
    WHERE s.source_scope_kind = v_s.source_scope_kind AND s.source_scope_id = v_s.source_scope_id
      AND s.source_organization_id = v_s.source_organization_id
      AND lower(s.scientific_name) = lower(v_s.scientific_name)
      AND s.national_code IS NOT DISTINCT FROM v_s.national_code
      AND s.status IN ('open', 'accepted') AND s.id <> v_s.id
  ), 0);
  IF v_headroom <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: source_surplus_committed';
  END IF;

  -- Target deficit (live), minus every OTHER open/accepted suggestion.
  SELECT GREATEST(COALESCE(a.threshold_reorder_point, 0) - COALESCE(a.observed_available, 0), 1)
    INTO v_deficit
  FROM public.inventory_alerts a
  WHERE a.organization_id = v_s.target_organization_id
    AND a.scope_kind = v_s.target_scope_kind AND a.scope_id = v_s.target_scope_id
    AND a.signal_type IN ('missing', 'low_stock')
    AND a.status IN ('open', 'acknowledged', 'in_progress')
    AND lower(a.scientific_name) = lower(v_s.scientific_name)
    AND a.national_code IS NOT DISTINCT FROM v_s.national_code
  ORDER BY a.last_observed_at DESC LIMIT 1;
  IF v_deficit IS NULL OR v_deficit <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: no_target_shortfall';
  END IF;
  v_deficit := v_deficit - COALESCE((
    SELECT SUM(s.suggested_quantity) FROM public.inventory_transfer_suggestions s
    WHERE s.target_scope_kind = v_s.target_scope_kind AND s.target_scope_id = v_s.target_scope_id
      AND s.target_organization_id = v_s.target_organization_id
      AND lower(s.scientific_name) = lower(v_s.scientific_name)
      AND s.national_code IS NOT DISTINCT FROM v_s.national_code
      AND s.status IN ('open', 'accepted') AND s.id <> v_s.id
  ), 0);
  IF v_deficit <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: target_shortfall_committed';
  END IF;

  -- Batch: live availability, FRESH identity read (this doubles as the
  -- identity re-check — every field handed to the downstream add-line RPC
  -- below is read here, live, never copied from a possibly-stale snapshot on
  -- the suggestion row itself), unexpired, still matching org/scope/material.
  IF v_s.source_scope_kind = 'warehouse' THEN
    SELECT ws.available_quantity, ws.central_item_id, ws.concentration, ws.dosage_form,
           ws.unit, ws.scientific_name
      INTO v_batch_available, v_src_central_item_id, v_src_concentration, v_src_dosage_form,
           v_src_unit, v_src_scientific_name
    FROM public.warehouse_stock ws
    WHERE ws.id = v_s.source_stock_id
      AND ws.warehouse_id = v_s.source_scope_id
      AND ws.organization_id = v_s.source_organization_id
      AND lower(ws.scientific_name) = lower(v_s.scientific_name)
      AND (v_s.national_code IS NULL OR ws.national_code = v_s.national_code)
      AND (ws.expiry_date IS NULL OR ws.expiry_date >= current_date)
    FOR UPDATE;
  ELSE
    SELECT os.available_quantity, os.central_item_id, os.concentration, os.dosage_form,
           os.unit, os.scientific_name
      INTO v_batch_available, v_src_central_item_id, v_src_concentration, v_src_dosage_form,
           v_src_unit, v_src_scientific_name
    FROM public.outlet_stock os
    WHERE os.id = v_s.source_stock_id
      AND os.distribution_point_id = v_s.source_scope_id
      AND os.organization_id = v_s.source_organization_id
      AND lower(os.scientific_name) = lower(v_s.scientific_name)
      AND (v_s.national_code IS NULL OR os.national_code = v_s.national_code)
      AND (os.expiry_date IS NULL OR os.expiry_date >= current_date)
    FOR UPDATE;
  END IF;
  IF v_batch_available IS NULL THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: batch_gone_or_identity_mismatch';
  END IF;

  v_batch_committed := COALESCE((
    SELECT SUM(s.suggested_quantity) FROM public.inventory_transfer_suggestions s
    WHERE s.source_stock_id = v_s.source_stock_id AND s.status IN ('open', 'accepted') AND s.id <> v_s.id
  ), 0);
  v_batch_remaining := v_batch_available - v_batch_committed;

  IF v_s.route_kind = 'outlet_to_warehouse' THEN
    SELECT COALESCE(wdl.received_quantity, 0) - wdl.returned_quantity INTO v_returnable
    FROM public.warehouse_dispatch_lines wdl
    WHERE wdl.id = v_s.provenance_dispatch_line_id
      AND wdl.status IN ('accepted', 'accepted_with_difference')
    FOR SHARE;
    IF v_returnable IS NULL THEN
      RAISE EXCEPTION 'suggestion_no_longer_available: provenance_gone';
    END IF;
    v_batch_remaining := LEAST(v_batch_remaining, v_returnable - COALESCE((
      SELECT SUM(s.suggested_quantity) FROM public.inventory_transfer_suggestions s
      WHERE s.provenance_dispatch_line_id = v_s.provenance_dispatch_line_id
        AND s.status IN ('open', 'accepted') AND s.id <> v_s.id
    ), 0));
  END IF;

  -- Final quantity: never exceeds what the reviewer was shown, and never
  -- exceeds any live constraint just re-derived above.
  v_eligible := LEAST(v_s.suggested_quantity, v_headroom, v_deficit, v_batch_remaining);
  IF v_eligible IS NULL OR v_eligible <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: eligible_quantity_zero';
  END IF;

  -- ── Delegate document creation to the EXISTING, already-permission-
  -- checked RPCs for the real corridor. auth.uid() is unaffected by nested
  -- SECURITY DEFINER calls, so each callee's own internal route-specific
  -- permission check (warehouse_transfer.send / warehouse_dispatch.create /
  -- outlet_stock.return_request) runs for real against this same actor —
  -- inventory.act_on_suggestions above is a queue gate, not a substitute for
  -- it, and a missing route permission fails this whole call closed.
  IF v_s.route_kind = 'central_to_institution' THEN
    v_create_result := public.phoenix_create_direct_warehouse_transfer_request(
      v_s.source_scope_id, v_s.target_organization_id, v_s.target_scope_id, v_doc,
      'Auto-drafted from inventory suggestion ' || v_s.id::text);
    v_request_id := (v_create_result->>'transfer_request_id')::uuid;
    PERFORM public.phoenix_add_warehouse_transfer_request_line(
      v_request_id, v_src_scientific_name, v_eligible, v_src_central_item_id,
      v_src_concentration, v_src_dosage_form, v_src_unit, NULL);

  ELSIF v_s.route_kind = 'warehouse_to_outlet' THEN
    v_create_result := public.phoenix_create_warehouse_dispatch(
      v_s.source_scope_id, v_s.target_scope_id, v_doc, NULL, NULL, NULL);
    v_dispatch_id := (v_create_result->>'dispatch_id')::uuid;
    PERFORM public.phoenix_add_dispatch_line_fefo_guarded(
      v_dispatch_id, v_s.source_stock_id, v_eligible, false, NULL, p_suggestion_id);

  ELSIF v_s.route_kind = 'outlet_to_warehouse' THEN
    v_create_result := public.phoenix_request_outlet_return(
      v_s.source_scope_id, v_doc, 'Auto-drafted from inventory suggestion ' || v_s.id::text);
    v_return_request_id := (v_create_result->>'return_request_id')::uuid;
    PERFORM public.phoenix_add_outlet_return_request_line(
      v_return_request_id, v_s.provenance_dispatch_line_id, v_eligible,
      'excess', 'Auto-drafted from inventory suggestion ' || v_s.id::text);

  ELSE
    RAISE EXCEPTION 'unsupported_route_kind: %', v_s.route_kind;
  END IF;

  UPDATE public.inventory_transfer_suggestions
  SET status = 'accepted',
      accepted_at = now(),
      accepted_by = v_actor,
      draft_document_number = v_doc,
      draft_warehouse_transfer_request_id = v_request_id,
      draft_warehouse_dispatch_id = v_dispatch_id,
      draft_outlet_return_request_id = v_return_request_id,
      suggested_quantity = v_eligible,
      updated_at = now()
  WHERE id = p_suggestion_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_s.target_organization_id, v_actor, public.phoenix_my_role(), 'update', 'inventory_transfer_suggestion',
          p_suggestion_id, v_s.route_kind || ':' || v_s.scientific_name,
          jsonb_build_object('lifecycle', 'draft_created', 'document_number', v_doc,
                              'quantity', v_eligible, 'route_kind', v_s.route_kind));

  RETURN jsonb_build_object(
    'ok', true, 'suggestion_id', p_suggestion_id, 'status', 'accepted', 'quantity', v_eligible,
    'route_kind', v_s.route_kind, 'document_number', v_doc,
    'warehouse_transfer_request_id', v_request_id,
    'warehouse_dispatch_id', v_dispatch_id,
    'outlet_return_request_id', v_return_request_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_create_transfer_draft_from_suggestion(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_create_transfer_draft_from_suggestion(uuid, text) TO authenticated;

-- ============================================================================
-- 4. REAL PAGINATION for 036/039 discovery alerts (peer-institution, always
--    executable=false — see header of this migration and the plan doc for
--    why no execution corridor exists for this route today).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state_page(
  p_limit  integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_full   jsonb;
  v_all    jsonb;
  v_total  integer;
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_page   jsonb;
BEGIN
  -- Reuses the existing discovery query UNCHANGED, at its own safety ceiling
  -- (500), so pagination never requires a second copy of the cross-org
  -- matching logic. 500 is this feed's real universe cap by design (036/037/
  -- 039 have always capped at 500) — this wrapper makes that ceiling honest
  -- with a real total_count instead of a silent truncation at 200.
  v_full := public.phoenix_get_live_inter_institution_alerts_with_state(500);
  IF NOT COALESCE((v_full->>'ok')::boolean, false) THEN
    RETURN v_full;
  END IF;
  v_all := COALESCE(v_full->'alerts', '[]'::jsonb);
  v_total := jsonb_array_length(v_all);

  SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
    INTO v_page
  FROM (
    SELECT (elem || jsonb_build_object('executable', false)) AS elem, ord
    FROM jsonb_array_elements(v_all) WITH ORDINALITY AS t(elem, ord)
    WHERE ord > v_offset AND ord <= v_offset + v_limit
  ) x;

  RETURN jsonb_build_object(
    'ok', true,
    'alerts', v_page,
    'total_count', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'computed_at', v_full->'computed_at'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state_page(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state_page(integer, integer) TO authenticated;

-- ============================================================================
-- 5. SELF-CHECK
-- ============================================================================
DO $selfcheck$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_suggestions_draft_fk_matches_route_chk'
  ) THEN
    RAISE EXCEPTION 'ABORT 148: inventory_suggestions_draft_fk_matches_route_chk was not created.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_suggestions_no_accept_chk'
  ) THEN
    RAISE EXCEPTION 'ABORT 148: inventory_suggestions_no_accept_chk was not dropped.';
  END IF;
  IF to_regprocedure('public.phoenix_accept_inventory_transfer_suggestion(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT 148: the old accept stub still exists.';
  END IF;
  IF to_regprocedure('public.phoenix_create_transfer_draft_from_suggestion(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 148: phoenix_create_transfer_draft_from_suggestion was not created.';
  END IF;
  IF to_regprocedure('public.phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 148: the paginated alerts RPC was not created.';
  END IF;
  IF to_regclass('public.inventory_suggestion_policy') IS NULL THEN
    RAISE EXCEPTION 'ABORT 148: inventory_suggestion_policy was not created.';
  END IF;
  IF has_table_privilege('anon', 'public.inventory_suggestion_policy', 'SELECT') THEN
    RAISE EXCEPTION 'ABORT 148: anon can read inventory_suggestion_policy.';
  END IF;
END;
$selfcheck$;

COMMIT;
