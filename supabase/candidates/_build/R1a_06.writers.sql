-- ---------------------------------------------------------------------------
-- 5. The eleven writers (owner-only EXECUTE). DML on central_needs_material_* / central_items lives IN each of them.
-- ---------------------------------------------------------------------------

-- 5.1 create draft (requester = central_needs.edit, per PRE3-C v1.1 "requester: central_needs.edit")
CREATE FUNCTION public.phoenix_central_needs_create_material_request_draft(
  p_organization_id uuid, p_scientific_name text, p_name_ar text, p_trade_name text, p_strength text, p_dosage_form text,
  p_unit text, p_barcode text, p_note text, p_provenance_kind text, p_provenance jsonb, p_plan_revision_id uuid, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role  text;
  v_sci   text := public._phoenix_central_needs_human_text_v1(p_scientific_name);
  v_ar    text := public._phoenix_central_needs_human_text_v1(p_name_ar);
  v_trade text := public._phoenix_central_needs_human_text_v1(p_trade_name);
  v_str   text := public._phoenix_central_needs_human_text_v1(p_strength);
  v_form  text := public._phoenix_central_needs_human_text_v1(p_dosage_form);
  v_bar   text := NULLIF(btrim(p_barcode), '');
  v_note  text := public._phoenix_central_needs_human_text_v1(p_note);
  v_prov  jsonb := COALESCE(p_provenance, '{}'::jsonb);
  v_prior public.central_needs_material_requests%ROWTYPE;
  v_new   public.central_needs_material_requests%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_role := public._phoenix_central_needs_guard_v1(p_organization_id, 'central_needs.edit');
  IF v_sci IS NULL THEN RAISE EXCEPTION 'material_scientific_name_required' USING ERRCODE = '23514'; END IF;
  IF p_unit IS NULL THEN RAISE EXCEPTION 'material_unit_required' USING ERRCODE = '23514'; END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'material_idempotency_key_invalid' USING ERRCODE = '23514';
  END IF;
  IF p_provenance_kind IS NULL OR p_provenance_kind NOT IN ('manual_typed', 'excel_assist') THEN
    RAISE EXCEPTION 'material_provenance_invalid' USING ERRCODE = '23514';
  END IF;
  IF p_plan_revision_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.central_needs_plan_revisions r
        WHERE r.id = p_plan_revision_id AND r.organization_id = p_organization_id AND r.source_mode = 'manual' AND r.status = 'draft') THEN
    RAISE EXCEPTION 'material_context_revision_ineligible' USING ERRCODE = '23514';
  END IF;

  -- Concurrent retries of ONE intent serialize here: the second waits for the first to commit, then finds it (replay) instead of
  -- racing the unique index. A different content under the same key is still refused below.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || v_actor::text || ':' || p_idempotency_key, 210005));
  SELECT * INTO v_prior FROM public.central_needs_material_requests
   WHERE organization_id = p_organization_id AND requester_id = v_actor AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF (v_prior.scientific_name, v_prior.name_ar, v_prior.trade_name, v_prior.strength, v_prior.dosage_form, v_prior.unit, v_prior.barcode, v_prior.note,
        v_prior.provenance_kind, v_prior.provenance, v_prior.plan_revision_id)
       IS NOT DISTINCT FROM (v_sci, v_ar, v_trade, v_str, v_form, p_unit, v_bar, v_note, p_provenance_kind, v_prov, p_plan_revision_id) THEN
      RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'request_id', v_prior.id, 'status', v_prior.status, 'version', v_prior.version);
    END IF;
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505', DETAIL = format('key=%s', p_idempotency_key);
  END IF;

  INSERT INTO public.central_needs_material_requests (organization_id, requester_id, requester_role, scientific_name, name_ar, trade_name, strength,
    dosage_form, unit, barcode, note, identity_key, provenance_kind, provenance, plan_revision_id, idempotency_key)
  VALUES (p_organization_id, v_actor, v_role, v_sci, v_ar, v_trade, v_str, v_form, p_unit, v_bar, v_note,
          phoenix_private.central_material_identity_key_v1(v_sci, v_str, v_form, p_unit, v_bar),
          p_provenance_kind, v_prov, p_plan_revision_id, p_idempotency_key)
  RETURNING * INTO v_new;
  PERFORM phoenix_private.central_material_event_v1(v_new.id, 'draft_created', NULL, jsonb_build_object('provenance_kind', p_provenance_kind));
  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'request_id', v_new.id, 'status', v_new.status, 'version', v_new.version);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_create_material_request_draft(uuid, text, text, text, text, text, text, text, text, text, jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- 5.2 edit draft / needs_info (requester only)
CREATE FUNCTION public.phoenix_central_needs_update_material_request_draft(
  p_request_id uuid, p_expected_version integer, p_scientific_name text, p_name_ar text, p_trade_name text, p_strength text,
  p_dosage_form text, p_unit text, p_barcode text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_req   public.central_needs_material_requests%ROWTYPE;
  v_sci   text := public._phoenix_central_needs_human_text_v1(p_scientific_name);
  v_ar    text := public._phoenix_central_needs_human_text_v1(p_name_ar);
  v_trade text := public._phoenix_central_needs_human_text_v1(p_trade_name);
  v_str   text := public._phoenix_central_needs_human_text_v1(p_strength);
  v_form  text := public._phoenix_central_needs_human_text_v1(p_dosage_form);
  v_bar   text := NULLIF(btrim(p_barcode), '');
  v_note  text := public._phoenix_central_needs_human_text_v1(p_note);
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_req := phoenix_private.central_material_load_v1(p_request_id, p_expected_version);
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.edit');
  IF v_req.requester_id <> v_actor THEN RAISE EXCEPTION 'material_request_requester_only' USING ERRCODE = '42501'; END IF;
  IF v_req.status NOT IN ('draft', 'needs_info') THEN
    RAISE EXCEPTION 'material_request_not_editable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  IF v_sci IS NULL OR p_unit IS NULL THEN RAISE EXCEPTION 'material_scientific_name_required' USING ERRCODE = '23514'; END IF;
  UPDATE public.central_needs_material_requests
     SET scientific_name = v_sci, name_ar = v_ar, trade_name = v_trade, strength = v_str, dosage_form = v_form, unit = p_unit,
         barcode = v_bar, note = v_note, identity_key = phoenix_private.central_material_identity_key_v1(v_sci, v_str, v_form, p_unit, v_bar),
         version = v_req.version + 1
   WHERE id = v_req.id RETURNING * INTO v_req;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'edited', NULL, '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_update_material_request_draft(uuid, integer, text, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;

-- 5.3 submit (draft -> submitted) / answer more-info (needs_info -> under_review). Server-scoped duplicate review is recorded.
CREATE FUNCTION public.phoenix_central_needs_submit_material_request(p_request_id uuid, p_expected_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_req   public.central_needs_material_requests%ROWTYPE;
  v_strong integer;
  v_adv    integer;
  v_target text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_req := phoenix_private.central_material_load_v1(p_request_id, p_expected_version);
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.edit');
  IF v_req.requester_id <> v_actor THEN RAISE EXCEPTION 'material_request_requester_only' USING ERRCODE = '42501'; END IF;
  IF v_req.status NOT IN ('draft', 'needs_info') THEN
    RAISE EXCEPTION 'material_request_not_submittable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_req.organization_id::text || ':' || v_req.identity_key, 210003));
  SELECT count(*) FILTER (WHERE c.grade = 'strong'), count(*) FILTER (WHERE c.grade = 'advisory') INTO v_strong, v_adv
    FROM phoenix_private.central_material_candidates_v1(v_req.scientific_name, v_req.strength, v_req.dosage_form, v_req.unit, v_req.barcode) c;
  v_target := CASE WHEN v_req.status = 'draft' THEN 'submitted' ELSE 'under_review' END;
  BEGIN
    UPDATE public.central_needs_material_requests SET status = v_target, version = v_req.version + 1 WHERE id = v_req.id RETURNING * INTO v_req;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'material_request_duplicate_open' USING ERRCODE = '23505',
      DETAIL = format('another open request exists for identity %s', v_req.identity_key);
  END;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, CASE WHEN v_target = 'submitted' THEN 'submitted' ELSE 'info_provided' END, NULL,
    jsonb_build_object('strong_matches', v_strong, 'advisory_matches', v_adv));
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version,
                            'strong_matches', v_strong, 'advisory_matches', v_adv);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_submit_material_request(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;

-- 5.4 start review (submitted -> under_review): assigns the independent reviewer
CREATE FUNCTION public.phoenix_central_needs_start_material_review(p_request_id uuid, p_expected_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req public.central_needs_material_requests%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_req := phoenix_private.central_material_load_v1(p_request_id, p_expected_version);
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.view');
  PERFORM phoenix_private.central_material_assert_reviewer_v1(v_req.organization_id, v_req.requester_id, NULL, false);
  IF v_req.status <> 'submitted' THEN
    RAISE EXCEPTION 'material_request_not_reviewable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  UPDATE public.central_needs_material_requests
     SET status = 'under_review', reviewer_id = auth.uid(), review_started_at = clock_timestamp(), version = v_req.version + 1
   WHERE id = v_req.id RETURNING * INTO v_req;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'review_started', NULL, '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_start_material_review(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;

-- 5.5 ask for more information (under_review -> needs_info)
CREATE FUNCTION public.phoenix_central_needs_request_material_info(p_request_id uuid, p_expected_version integer, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req  public.central_needs_material_requests%ROWTYPE;
  v_note text := public._phoenix_central_needs_human_text_v1(p_note);
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_req := phoenix_private.central_material_load_v1(p_request_id, p_expected_version);
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.view');
  PERFORM phoenix_private.central_material_assert_reviewer_v1(v_req.organization_id, v_req.requester_id, v_req.reviewer_id, true);
  IF v_req.status <> 'under_review' THEN
    RAISE EXCEPTION 'material_request_not_reviewable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  IF v_note IS NULL OR char_length(v_note) > 2000 THEN RAISE EXCEPTION 'material_note_required' USING ERRCODE = '23514'; END IF;
  UPDATE public.central_needs_material_requests SET status = 'needs_info', version = v_req.version + 1 WHERE id = v_req.id RETURNING * INTO v_req;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'info_requested', v_note, '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_request_material_info(uuid, integer, text) FROM PUBLIC, anon, authenticated, service_role;

-- 5.6 resolve to an EXISTING item (terminal)
CREATE FUNCTION public.phoenix_central_needs_resolve_material_existing(p_request_id uuid, p_expected_version integer, p_item_id uuid, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req    public.central_needs_material_requests%ROWTYPE;
  v_note   text := public._phoenix_central_needs_human_text_v1(p_note);
  v_strong uuid[];
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_req := phoenix_private.central_material_load_v1(p_request_id, p_expected_version);
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.view');
  PERFORM phoenix_private.central_material_assert_reviewer_v1(v_req.organization_id, v_req.requester_id, v_req.reviewer_id, true);
  IF v_req.status <> 'under_review' THEN
    RAISE EXCEPTION 'material_request_not_reviewable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  IF p_item_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.central_items i WHERE i.id = p_item_id AND i.status = 'active') THEN
    RAISE EXCEPTION 'material_resolution_item_not_active' USING ERRCODE = '23514';
  END IF;
  PERFORM phoenix_private.central_material_lock_catalog_v1(v_req.scientific_name, v_req.strength, v_req.dosage_form, v_req.unit, v_req.barcode);
  SELECT array_agg(c.central_item_id) INTO v_strong
    FROM phoenix_private.central_material_candidates_v1(v_req.scientific_name, v_req.strength, v_req.dosage_form, v_req.unit, v_req.barcode) c
   WHERE c.grade = 'strong';
  IF v_strong IS NOT NULL AND NOT (p_item_id = ANY (v_strong)) THEN
    RAISE EXCEPTION 'material_resolution_must_match_strong' USING ERRCODE = '23514', DETAIL = format('strong_matches=%s', cardinality(v_strong));
  END IF;
  UPDATE public.central_needs_material_requests
     SET status = 'resolved_existing', resolved_item_id = p_item_id, decision_reason = v_note, decided_at = clock_timestamp(), version = v_req.version + 1
   WHERE id = v_req.id RETURNING * INTO v_req;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'resolved_existing', v_note, jsonb_build_object('central_item_id', p_item_id));
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version, 'central_item_id', p_item_id);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_resolve_material_existing(uuid, integer, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- 5.7 approve a NEW canonical item (terminal). THE ONLY routine that writes central_items.
CREATE FUNCTION public.phoenix_central_needs_approve_new_material(p_request_id uuid, p_expected_version integer, p_acknowledged_candidates uuid[], p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req   public.central_needs_material_requests%ROWTYPE;
  v_note  text := public._phoenix_central_needs_human_text_v1(p_note);
  v_ack   uuid[] := COALESCE(p_acknowledged_candidates, ARRAY[]::uuid[]);
  v_strong integer;
  v_advisory integer;
  v_missing integer;
  v_review_cap constant integer := 50;
  v_item  uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_req := phoenix_private.central_material_load_v1(p_request_id, p_expected_version);
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.view');
  PERFORM phoenix_private.central_material_assert_reviewer_v1(v_req.organization_id, v_req.requester_id, v_req.reviewer_id, true);
  IF v_req.status <> 'under_review' THEN
    RAISE EXCEPTION 'material_request_not_reviewable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  -- serialize every decision on the same CATALOG identity (not on the organization), then RE-CHECK the catalog under the locks
  -- (server-side, never client-trusted)
  PERFORM phoenix_private.central_material_lock_catalog_v1(v_req.scientific_name, v_req.strength, v_req.dosage_form, v_req.unit, v_req.barcode);
  SELECT count(*) FILTER (WHERE c.grade = 'strong'),
         count(*) FILTER (WHERE c.grade = 'advisory'),
         count(*) FILTER (WHERE c.grade = 'advisory' AND NOT (c.central_item_id = ANY (v_ack)))
    INTO v_strong, v_advisory, v_missing
    FROM phoenix_private.central_material_candidates_v1(v_req.scientific_name, v_req.strength, v_req.dosage_form, v_req.unit, v_req.barcode) c;
  IF v_strong > 0 THEN
    RAISE EXCEPTION 'material_duplicate_strong_match' USING ERRCODE = '23505', DETAIL = format('strong_matches=%s', v_strong),
      HINT = 'Resolve the request to the existing item instead.';
  END IF;
  -- A human cannot responsibly confirm an unbounded list: above the cap the approval is REFUSED (safe) until the request is narrowed
  -- (resolve to an existing item, ask for more information, or reject). The similarity threshold is not touched.
  IF v_advisory > v_review_cap THEN
    RAISE EXCEPTION 'material_duplicate_review_too_large' USING ERRCODE = '23514', DETAIL = format('advisory_candidates=%s cap=%s', v_advisory, v_review_cap),
      HINT = 'Too many similar catalog items to confirm safely; narrow the request or resolve it to an existing item.';
  END IF;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'material_duplicate_review_required' USING ERRCODE = '23514', DETAIL = format('unacknowledged_advisory_candidates=%s', v_missing),
      HINT = 'A human must confirm that each similar catalog item is not the same material.';
  END IF;
  BEGIN
    INSERT INTO public.central_items (name, name_ar, trade_name, concentration, dosage_form, unit, barcode, status, created_by)
    VALUES (v_req.scientific_name, COALESCE(v_req.name_ar, v_req.scientific_name), v_req.trade_name, v_req.strength, v_req.dosage_form,
            v_req.unit, v_req.barcode, 'active', auth.uid())
    RETURNING id INTO v_item;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'material_duplicate_strong_match' USING ERRCODE = '23505', DETAIL = 'barcode already registered';
  END;
  UPDATE public.central_needs_material_requests
     SET status = 'approved_new', resolved_item_id = v_item, decision_reason = v_note, decided_at = clock_timestamp(), version = v_req.version + 1
   WHERE id = v_req.id RETURNING * INTO v_req;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'approved_new', v_note,
    jsonb_build_object('central_item_id', v_item, 'acknowledged_candidates', to_jsonb(v_ack)));
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version, 'central_item_id', v_item);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_approve_new_material(uuid, integer, uuid[], text) FROM PUBLIC, anon, authenticated, service_role;

-- 5.8 reject (terminal)
CREATE FUNCTION public.phoenix_central_needs_reject_material_request(p_request_id uuid, p_expected_version integer, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req    public.central_needs_material_requests%ROWTYPE;
  v_reason text := public._phoenix_central_needs_human_text_v1(p_reason);
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_req := phoenix_private.central_material_load_v1(p_request_id, p_expected_version);
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.view');
  PERFORM phoenix_private.central_material_assert_reviewer_v1(v_req.organization_id, v_req.requester_id, v_req.reviewer_id, true);
  IF v_req.status <> 'under_review' THEN
    RAISE EXCEPTION 'material_request_not_reviewable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 2000 THEN RAISE EXCEPTION 'material_reason_required' USING ERRCODE = '23514'; END IF;
  UPDATE public.central_needs_material_requests
     SET status = 'rejected', decision_reason = v_reason, decided_at = clock_timestamp(), version = v_req.version + 1
   WHERE id = v_req.id RETURNING * INTO v_req;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'rejected', v_reason, '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_reject_material_request(uuid, integer, text) FROM PUBLIC, anon, authenticated, service_role;

-- 5.9 cancel (requester; draft / submitted / needs_info -> cancelled)
CREATE FUNCTION public.phoenix_central_needs_cancel_material_request(p_request_id uuid, p_expected_version integer, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_req    public.central_needs_material_requests%ROWTYPE;
  v_reason text := public._phoenix_central_needs_human_text_v1(p_reason);
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_req := phoenix_private.central_material_load_v1(p_request_id, p_expected_version);
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.edit');
  IF v_req.requester_id <> v_actor THEN RAISE EXCEPTION 'material_request_requester_only' USING ERRCODE = '42501'; END IF;
  IF v_req.status NOT IN ('draft', 'submitted', 'needs_info') THEN
    RAISE EXCEPTION 'material_request_not_cancellable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 2000 THEN RAISE EXCEPTION 'material_reason_required' USING ERRCODE = '23514'; END IF;
  UPDATE public.central_needs_material_requests
     SET status = 'cancelled', decision_reason = v_reason, decided_at = clock_timestamp(), version = v_req.version + 1
   WHERE id = v_req.id RETURNING * INTO v_req;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'cancelled', v_reason, '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_cancel_material_request(uuid, integer, text) FROM PUBLIC, anon, authenticated, service_role;

-- 5.10 explicit linkage of a RESOLVED material to a manual DRAFT revision (M2). Writes the link only - never a need line.
CREATE FUNCTION public.phoenix_central_needs_link_material_request_to_draft(p_request_id uuid, p_plan_revision_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req  public.central_needs_material_requests%ROWTYPE;
  v_link uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'material_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  IF p_request_id IS NULL OR p_plan_revision_id IS NULL THEN RAISE EXCEPTION 'material_request_arguments_required' USING ERRCODE = '23514'; END IF;
  SELECT * INTO v_req FROM public.central_needs_material_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'material_request_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._phoenix_central_needs_guard_v1(v_req.organization_id, 'central_needs.manual_need.set');
  IF v_req.status NOT IN ('resolved_existing', 'approved_new') OR v_req.resolved_item_id IS NULL THEN
    RAISE EXCEPTION 'material_request_not_resolved' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.central_items i WHERE i.id = v_req.resolved_item_id AND i.status = 'active') THEN
    RAISE EXCEPTION 'material_resolution_item_not_active' USING ERRCODE = '23514';
  END IF;
  -- only a manual DRAFT of the SAME organization: a submitted / approved revision is never touched or linked into
  PERFORM 1 FROM public.central_needs_plan_revisions r
   WHERE r.id = p_plan_revision_id AND r.organization_id = v_req.organization_id AND r.source_mode = 'manual' AND r.status = 'draft' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'material_link_revision_ineligible' USING ERRCODE = '23514'; END IF;
  SELECT id INTO v_link FROM public.central_needs_material_request_links WHERE request_id = p_request_id AND plan_revision_id = p_plan_revision_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'link_id', v_link, 'central_item_id', v_req.resolved_item_id);
  END IF;
  INSERT INTO public.central_needs_material_request_links (request_id, organization_id, plan_revision_id, central_item_id, actor_id)
  VALUES (v_req.id, v_req.organization_id, p_plan_revision_id, v_req.resolved_item_id, auth.uid()) RETURNING id INTO v_link;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'linked', NULL, jsonb_build_object('plan_revision_id', p_plan_revision_id));
  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'link_id', v_link, 'central_item_id', v_req.resolved_item_id);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_link_material_request_to_draft(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
