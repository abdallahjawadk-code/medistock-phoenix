-- LOCAL CANDIDATE ONLY. No Production apply is authorized by this file.
-- Forward migration: historical 001..231 are immutable.
BEGIN;

-- Bind every replaced authority routine to the exact predecessor body. A drift
-- refuses the whole transaction; no live function is silently overwritten.
DO $authority_pre$
DECLARE r record; actual text; matches integer;
BEGIN
 FOR r IN SELECT * FROM (VALUES
      ('phoenix_private.central_material_transition_guard_v1','3bf02b259f53f1a1b59b0c77d97852c5'),
      ('public.phoenix_central_needs_approve_new_material','7a23c7a319ef278b622cb71b7f036793'),
      ('public.phoenix_central_needs_resolve_material_existing','155adef7f060e593322652f6044f4953'),
      ('public.phoenix_central_needs_update_material_request_draft','d4e5b98e00120b38c92665c9f3f3fbcb'),
      ('phoenix_private.central_needs_capability_breaches_v1','6ac027f121badae464fb673d8861fadc')
 ) expected(name,body_md5) LOOP
   SELECT count(*), min(md5(p.prosrc)) INTO matches,actual
   FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname=split_part(r.name,'.',1) AND p.proname=split_part(r.name,'.',2);
   IF matches<>1 OR actual IS DISTINCT FROM r.body_md5 THEN
     RAISE EXCEPTION 'M233_authority_precondition_failed: %',r.name;
   END IF;
 END LOOP;
END $authority_pre$;
-- No backfill from barcode: old values are historical evidence, not proven national codes.
DO $pre$ BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
            AND table_name='central_items' AND column_name='national_code') THEN
   RAISE EXCEPTION 'M233_precondition_failed';
 END IF;
END $pre$;
ALTER TABLE public.central_items ADD COLUMN national_code text;
ALTER TABLE public.central_needs_material_requests ADD COLUMN national_code text;
ALTER TABLE public.central_items ADD CONSTRAINT central_items_national_code_chk
 CHECK (national_code IS NULL OR (national_code = btrim(national_code) AND char_length(national_code) BETWEEN 1 AND 64 AND national_code !~ '[[:cntrl:]]'));
ALTER TABLE public.central_needs_material_requests ADD CONSTRAINT material_requests_national_code_chk
 CHECK (national_code IS NULL OR (national_code = btrim(national_code) AND char_length(national_code) BETWEEN 1 AND 64 AND national_code !~ '[[:cntrl:]]'));
CREATE INDEX central_items_national_code_idx ON public.central_items(national_code) WHERE national_code IS NOT NULL;
COMMENT ON COLUMN public.central_items.national_code IS 'Owner amendment: distinct national code, text preserving zeros and hyphens. Never a barcode alias.';
CREATE FUNCTION phoenix_private.central_needs_national_code_v1(p_code text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_code IS NOT NULL AND (p_code <> btrim(p_code) OR char_length(p_code) NOT BETWEEN 1 AND 64 OR p_code ~ '[[:cntrl:]]') THEN
   RAISE EXCEPTION 'national_code_invalid' USING ERRCODE='23514';
 END IF;
 RETURN p_code;
END $$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_national_code_v1(text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.phoenix_central_needs_feature_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT jsonb_build_object('national_code', true, 'same_actor_manual', true, 'dossiers', false, 'workbook_intake', false)
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_feature_contract() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_feature_contract() TO authenticated;
CREATE FUNCTION public.phoenix_central_needs_create_material_request_with_code(
  p_organization_id uuid, p_scientific_name text, p_name_ar text, p_trade_name text, p_strength text, p_dosage_form text,
  p_unit text, p_barcode text, p_national_code text, p_note text, p_provenance_kind text, p_provenance jsonb, p_plan_revision_id uuid, p_idempotency_key text)
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
  v_code  text := phoenix_private.central_needs_national_code_v1(p_national_code);
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
    IF (v_prior.scientific_name, v_prior.name_ar, v_prior.trade_name, v_prior.strength, v_prior.dosage_form, v_prior.unit, v_prior.barcode, v_prior.national_code, v_prior.note,
        v_prior.provenance_kind, v_prior.provenance, v_prior.plan_revision_id)
       IS NOT DISTINCT FROM (v_sci, v_ar, v_trade, v_str, v_form, p_unit, v_bar, v_code, v_note, p_provenance_kind, v_prov, p_plan_revision_id) THEN
      RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'request_id', v_prior.id, 'status', v_prior.status, 'version', v_prior.version);
    END IF;
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505', DETAIL = format('key=%s', p_idempotency_key);
  END IF;

  INSERT INTO public.central_needs_material_requests (organization_id, requester_id, requester_role, scientific_name, name_ar, trade_name, strength,
    dosage_form, unit, barcode, national_code, note, identity_key, provenance_kind, provenance, plan_revision_id, idempotency_key)
  VALUES (p_organization_id, v_actor, v_role, v_sci, v_ar, v_trade, v_str, v_form, p_unit, v_bar, v_code, v_note,
          phoenix_private.central_material_identity_key_v1(v_sci, v_str, v_form, p_unit, v_bar),
          p_provenance_kind, v_prov, p_plan_revision_id, p_idempotency_key)
  RETURNING * INTO v_new;
  PERFORM phoenix_private.central_material_event_v1(v_new.id, 'draft_created', NULL, jsonb_build_object('provenance_kind', p_provenance_kind));
  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'request_id', v_new.id, 'status', v_new.status, 'version', v_new.version);
END;
$$;

CREATE FUNCTION public.phoenix_central_needs_update_material_request_with_code(
  p_request_id uuid, p_expected_version integer, p_scientific_name text, p_name_ar text, p_trade_name text, p_strength text,
  p_dosage_form text, p_unit text, p_barcode text, p_national_code text, p_note text)
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
  v_code  text := phoenix_private.central_needs_national_code_v1(p_national_code);
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
         barcode = v_bar, national_code = v_code, note = v_note, identity_key = phoenix_private.central_material_identity_key_v1(v_sci, v_str, v_form, p_unit, v_bar),
         version = v_req.version + 1
   WHERE id = v_req.id RETURNING * INTO v_req;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'edited', NULL, '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version);
END;
$$;

CREATE OR REPLACE FUNCTION phoenix_private.central_material_transition_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('resolved_existing', 'approved_new', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'material_request_terminal_immutable' USING ERRCODE = '23514', DETAIL = format('request=%s status=%s', OLD.id, OLD.status);
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'material_request_version_must_advance' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.requester_id IS DISTINCT FROM OLD.requester_id
     OR NEW.requester_role IS DISTINCT FROM OLD.requester_role OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.provenance_kind IS DISTINCT FROM OLD.provenance_kind
     OR NEW.provenance IS DISTINCT FROM OLD.provenance OR NEW.plan_revision_id IS DISTINCT FROM OLD.plan_revision_id THEN
    RAISE EXCEPTION 'material_request_identity_immutable' USING ERRCODE = '23514';
  END IF;
  IF (NEW.scientific_name, NEW.name_ar, NEW.trade_name, NEW.strength, NEW.dosage_form, NEW.unit, NEW.barcode, NEW.national_code, NEW.note, NEW.identity_key)
       IS DISTINCT FROM (OLD.scientific_name, OLD.name_ar, OLD.trade_name, OLD.strength, OLD.dosage_form, OLD.unit, OLD.barcode, OLD.national_code, OLD.note, OLD.identity_key)
     AND OLD.status NOT IN ('draft', 'needs_info') THEN
    RAISE EXCEPTION 'material_request_descriptor_frozen' USING ERRCODE = '23514', DETAIL = format('status=%s', OLD.status);
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft'        AND NEW.status IN ('submitted', 'cancelled'))
    OR (OLD.status = 'submitted'    AND NEW.status IN ('under_review', 'cancelled'))
    OR (OLD.status = 'under_review' AND NEW.status IN ('needs_info', 'resolved_existing', 'approved_new', 'rejected'))
    OR (OLD.status = 'needs_info'   AND NEW.status IN ('under_review', 'cancelled'))) THEN
    RAISE EXCEPTION 'material_request_invalid_transition' USING ERRCODE = '23514', DETAIL = format('%s -> %s', OLD.status, NEW.status);
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_approve_new_material(p_request_id uuid, p_expected_version integer, p_acknowledged_candidates uuid[], p_note text)
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
  IF v_req.national_code IS NOT NULL THEN
    RAISE EXCEPTION 'material_code_review_confirmation_required' USING ERRCODE='23514';
  END IF;
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
CREATE FUNCTION public.phoenix_central_needs_approve_material_with_code(p_request_id uuid, p_expected_version integer, p_acknowledged_candidates uuid[], p_note text, p_expected_national_code text)
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
  IF v_req.national_code IS DISTINCT FROM p_expected_national_code THEN
    RAISE EXCEPTION 'material_code_review_confirmation_required' USING ERRCODE='23514';
  END IF;
  IF v_req.status <> 'under_review' THEN
    RAISE EXCEPTION 'material_request_not_reviewable' USING ERRCODE = '23514', DETAIL = format('status=%s', v_req.status);
  END IF;
  -- National code is distinct from barcode. Serialize/recheck its exact spelling;
  -- ambiguous codes are rejected for a new registration, never auto-merged.
  IF v_req.national_code IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('national:' || v_req.national_code, 210004));
    IF EXISTS (SELECT 1 FROM public.central_items WHERE national_code = v_req.national_code AND status = 'active') THEN
      RAISE EXCEPTION 'material_duplicate_national_code' USING ERRCODE = '23505';
    END IF;
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
    INSERT INTO public.central_items (name, name_ar, trade_name, concentration, dosage_form, unit, barcode, national_code, status, created_by)
    VALUES (v_req.scientific_name, COALESCE(v_req.name_ar, v_req.scientific_name), v_req.trade_name, v_req.strength, v_req.dosage_form,
            v_req.unit, v_req.barcode, v_req.national_code, 'active', auth.uid())
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
REVOKE ALL ON FUNCTION public.phoenix_central_needs_approve_material_with_code(uuid,integer,uuid[],text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_approve_material_with_code(uuid,integer,uuid[],text,text) TO authenticated;



CREATE FUNCTION public.phoenix_central_needs_material_request_code_candidates(p_request_id uuid)
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH request AS (
   SELECT * FROM public.central_needs_material_requests r WHERE r.id=p_request_id
     AND phoenix_cn_policy.actor_scope_org('central_needs.view')=r.organization_id
 ), candidates AS (
   SELECT c.central_item_id,c.grade,c.score FROM request r CROSS JOIN LATERAL
     phoenix_private.central_material_candidates_v1(r.scientific_name,r.strength,r.dosage_form,r.unit,r.barcode) c
   UNION ALL
   SELECT ci.id,'strong'::text,1::real FROM request r JOIN public.central_items ci
     ON r.national_code IS NOT NULL AND ci.national_code=r.national_code AND ci.status='active'
 ), picked AS (
   SELECT DISTINCT ON (central_item_id) * FROM candidates
   ORDER BY central_item_id,(grade='strong') DESC,score DESC
 )
 SELECT jsonb_build_object('central_item_id',ci.id,'grade',c.grade,'score',c.score,
   'name',ci.name,'name_ar',ci.name_ar,'concentration',ci.concentration,'dosage_form',ci.dosage_form,
   'unit',ci.unit,'barcode',ci.barcode,'national_code',ci.national_code,'status',ci.status)
 FROM picked c JOIN public.central_items ci ON ci.id=c.central_item_id
 ORDER BY (c.grade='strong') DESC,c.score DESC,ci.id
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_material_request_code_candidates(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_material_request_code_candidates(uuid) TO authenticated;

CREATE FUNCTION public.phoenix_central_needs_resolve_material_existing_with_code(p_request_id uuid, p_expected_version integer, p_item_id uuid, p_note text, p_expected_code text, p_confirm_code boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req    public.central_needs_material_requests%ROWTYPE;
  v_note   text := public._phoenix_central_needs_human_text_v1(p_note);
  v_strong uuid[];
  v_item public.central_items%ROWTYPE;
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
  IF p_confirm_code IS DISTINCT FROM true OR v_req.national_code IS NULL OR v_note IS NULL THEN
    RAISE EXCEPTION 'national_code_assignment_confirmation_required' USING ERRCODE='23514';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('national:' || v_req.national_code,210004));
  PERFORM phoenix_private.central_material_lock_catalog_v1(v_req.scientific_name, v_req.strength, v_req.dosage_form, v_req.unit, v_req.barcode);
  SELECT array_agg(c.central_item_id) INTO v_strong
    FROM phoenix_private.central_material_candidates_v1(v_req.scientific_name, v_req.strength, v_req.dosage_form, v_req.unit, v_req.barcode) c
   WHERE c.grade = 'strong';
  IF v_strong IS NOT NULL AND NOT (p_item_id = ANY (v_strong)) THEN
    RAISE EXCEPTION 'material_resolution_must_match_strong' USING ERRCODE = '23514', DETAIL = format('strong_matches=%s', cardinality(v_strong));
  END IF;
  SELECT * INTO v_item FROM public.central_items WHERE id=p_item_id FOR UPDATE;
  -- A catalog administrator can suspend/delete the item while this decision
  -- waits for its row lock. Judge the locked version, not the earlier snapshot.
  IF NOT FOUND OR v_item.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'material_resolution_item_not_active' USING ERRCODE='23514';
  END IF;
  IF v_item.national_code IS DISTINCT FROM p_expected_code THEN
    RAISE EXCEPTION 'national_code_assignment_stale' USING ERRCODE='23514';
  END IF;
  IF v_item.unit IS DISTINCT FROM v_req.unit OR (v_item.national_code IS NOT NULL AND v_item.national_code<>v_req.national_code) THEN
    RAISE EXCEPTION 'national_code_assignment_conflict' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM public.central_items WHERE national_code=v_req.national_code AND status='active' AND id<>p_item_id) THEN
    RAISE EXCEPTION 'material_duplicate_national_code' USING ERRCODE='23505';
  END IF;
  IF v_item.national_code IS NULL THEN
    UPDATE public.central_items SET national_code=v_req.national_code WHERE id=p_item_id;
    INSERT INTO public.audit_logs(organization_id,actor_id,actor_role,action,entity_type,entity_id,payload)
    VALUES(v_req.organization_id,auth.uid(),public._phoenix_central_needs_guard_v1(v_req.organization_id,'central_needs.view'),
      'central_needs.material.national_code_assigned','central_item',p_item_id,
      jsonb_build_object('request_id',v_req.id,'previous_code',v_item.national_code,'national_code',v_req.national_code));
  END IF;
  UPDATE public.central_needs_material_requests
     SET status = 'resolved_existing', resolved_item_id = p_item_id, decision_reason = v_note, decided_at = clock_timestamp(), version = v_req.version + 1
   WHERE id = v_req.id RETURNING * INTO v_req;
  PERFORM phoenix_private.central_material_event_v1(v_req.id, 'resolved_existing', v_note, jsonb_build_object('central_item_id', p_item_id));
  RETURN jsonb_build_object('ok', true, 'request_id', v_req.id, 'status', v_req.status, 'version', v_req.version, 'central_item_id', p_item_id);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_resolve_material_existing_with_code(uuid,integer,uuid,text,text,boolean) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_resolve_material_existing_with_code(uuid,integer,uuid,text,text,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_resolve_material_existing(p_request_id uuid, p_expected_version integer, p_item_id uuid, p_note text)
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
  IF v_req.national_code IS NOT NULL THEN
    RAISE EXCEPTION 'material_code_review_confirmation_required' USING ERRCODE='23514';
  END IF;
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

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_update_material_request_draft(
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
  IF v_req.national_code IS NOT NULL THEN
    RAISE EXCEPTION 'material_code_review_confirmation_required' USING ERRCODE='23514';
  END IF;
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

CREATE OR REPLACE FUNCTION phoenix_private.central_needs_capability_breaches_v1()
RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH
  nonroot AS (
    SELECT r.oid, r.rolname
      FROM pg_catalog.pg_roles r
     WHERE NOT r.rolsuper
       AND r.rolname !~ '^pg_'
       AND r.oid <> (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
  ),
  guarded_schema AS (
    SELECT n.oid, n.nspname, n.nspowner
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname IN ('public', 'phoenix_private', 'phoenix_cn_policy')
  ),
  manifest(relname) AS (
    VALUES ('central_needs_plans'), ('central_needs_plan_revisions'), ('central_needs_source_files'),
           ('central_needs_import_sessions'), ('central_needs_source_records'), ('central_needs_record_mappings'),
           ('central_needs_field_overrides'), ('central_needs_import_batches'), ('central_needs_import_batch_entries'),
           ('central_needs_beneficiary_column_mappings'), ('central_needs_beneficiary_regions'),
           ('central_needs_need_lines'), ('central_needs_need_line_sources'), ('central_needs_manual_need_events'),
           ('central_needs_revision_withdrawals'), ('central_needs_manual_coverage_acknowledgements'), ('central_needs_cutover_inventory'),
           ('central_needs_material_requests'), ('central_needs_material_request_events'), ('central_needs_material_request_links')
  ),
  cn AS (
    SELECT c.oid, c.relowner, n.nspname, c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE (n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central\_needs\_%')
        OR (n.nspname = 'phoenix_private' AND c.relname = 'central_needs_lifecycle_attestations')
  ),
  acl_manifest(sig) AS (
    VALUES ('public.phoenix_central_needs_create_material_request_with_code(uuid,text,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)'),
           ('public.phoenix_central_needs_update_material_request_with_code(uuid,integer,text,text,text,text,text,text,text,text,text)'),
           ('phoenix_private.central_needs_national_code_v1(text)'),
           ('public.phoenix_central_needs_feature_contract()'),
           ('public.phoenix_central_needs_resolve_material_existing_with_code(uuid,integer,uuid,text,text,boolean)'),
           ('public.phoenix_central_needs_approve_material_with_code(uuid,integer,uuid[],text,text)'),
           ('public.phoenix_central_needs_material_request_code_candidates(uuid)'),
           ('phoenix_cn_policy.actor_scope_org(text)'),
           ('public.phoenix_central_needs_actor_authorized(uuid,text)'),
           ('phoenix_private.central_needs_source_mode_immutable_v1()'),
           ('phoenix_private.central_needs_lineage_mode_v1()'),
           ('phoenix_private.central_needs_manual_event_guard_v1()'),
           ('phoenix_private.central_needs_manual_projection_guard_v1()'),
           ('phoenix_private.central_needs_revision_authority_gate_v1()'),
           ('public._phoenix_central_needs_assert_manual_projection_v1()'),
           ('phoenix_cn_policy.excel_sod_enabled()'),
           ('phoenix_private.central_needs_append_only_v1()'),
           ('phoenix_private.central_needs_sod_excluded_v1(uuid,uuid)'),
           ('phoenix_private.central_needs_manual_quantity_v1(text)'),
           ('phoenix_private.central_needs_manual_scope_v1(uuid,uuid,uuid)'),
           ('phoenix_private.central_needs_coverage_digest_v1(uuid,uuid)'),
           ('phoenix_private.central_needs_effective_predecessor_v1(uuid)'),
           ('public.phoenix_central_needs_open_manual_plan_revision(uuid,integer)'),
           ('public.phoenix_central_needs_open_manual_correction_revision(uuid,integer,uuid,text)'),
           ('public.phoenix_central_needs_carry_forward_manual_lines(uuid,uuid)'),
           ('public.phoenix_central_needs_add_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)'),
           ('public.phoenix_central_needs_correct_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)'),
           ('public.phoenix_central_needs_void_manual_need_line(uuid,uuid,uuid,uuid,text,text,uuid,text)'),
           ('public.phoenix_central_needs_withdraw_draft_revision(uuid,uuid,text,text)'),
           ('public.phoenix_central_needs_acknowledge_manual_coverage(uuid,text,text)'),
           ('phoenix_private.central_needs_excel_review_blockers_v1(uuid)'),
           ('phoenix_private.central_needs_submission_state_digest_v1(uuid)'),
           ('public._phoenix_central_needs_review_blockers_v1(uuid)'),
           ('phoenix_cn_policy.material_reviewer_org()'),
           ('phoenix_private.central_material_norm_v1(text)'),
           ('phoenix_private.central_material_name_key_v1(text,text,text,text)'),
           ('phoenix_private.central_material_identity_key_v1(text,text,text,text,text)'),
           ('phoenix_private.central_material_lock_catalog_v1(text,text,text,text,text)'),
           ('phoenix_private.central_material_candidates_v1(text,text,text,text,text)'),
           ('phoenix_private.central_material_transition_guard_v1()'),
           ('phoenix_private.central_material_load_v1(uuid,integer)'),
           ('phoenix_private.central_material_event_v1(uuid,text,text,jsonb)'),
           ('phoenix_private.central_material_assert_reviewer_v1(uuid,uuid,uuid,boolean)'),
           ('public.phoenix_central_needs_create_material_request_draft(uuid,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)'),
           ('public.phoenix_central_needs_update_material_request_draft(uuid,integer,text,text,text,text,text,text,text,text)'),
           ('public.phoenix_central_needs_submit_material_request(uuid,integer)'),
           ('public.phoenix_central_needs_start_material_review(uuid,integer)'),
           ('public.phoenix_central_needs_request_material_info(uuid,integer,text)'),
           ('public.phoenix_central_needs_resolve_material_existing(uuid,integer,uuid,text)'),
           ('public.phoenix_central_needs_approve_new_material(uuid,integer,uuid[],text)'),
           ('public.phoenix_central_needs_reject_material_request(uuid,integer,text)'),
           ('public.phoenix_central_needs_cancel_material_request(uuid,integer,text)'),
           ('public.phoenix_central_needs_link_material_request_to_draft(uuid,uuid)'),
           ('public.phoenix_central_needs_list_material_requests(uuid)'),
           ('public.phoenix_central_needs_list_material_request_events(uuid)'),
           ('public.phoenix_central_needs_material_request_candidates(uuid)'),
           ('public.phoenix_central_needs_my_material_capabilities(uuid)')
  ),
  expected_catalog_writers(proname) AS (
    VALUES
      ('phoenix_central_needs_resolve_material_existing_with_code'),
           ('phoenix_central_needs_approve_material_with_code'),
           ('phoenix_central_needs_create_material_request_with_code'),
           ('phoenix_central_needs_update_material_request_with_code'),
           ('phoenix_central_needs_create_material_request_draft'),
           ('phoenix_central_needs_update_material_request_draft'),
           ('phoenix_central_needs_submit_material_request'),
           ('phoenix_central_needs_start_material_review'),
           ('phoenix_central_needs_request_material_info'),
           ('phoenix_central_needs_resolve_material_existing'),
           ('phoenix_central_needs_approve_new_material'),
           ('phoenix_central_needs_reject_material_request'),
           ('phoenix_central_needs_cancel_material_request'),
           ('phoenix_central_needs_link_material_request_to_draft'),
           ('central_material_event_v1')
  )
  -- (a) no non-root write, TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on any
  --     Central Needs relation or on the private store
  SELECT pg_catalog.format('%s holds %s on %I.%I', u.rolname, p.priv, cn.nspname, cn.relname)
    FROM nonroot u
   CROSS JOIN cn
   CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) AS p(priv)
   WHERE u.oid <> cn.relowner
     AND pg_catalog.has_table_privilege(u.oid, cn.oid, p.priv)
  UNION ALL
  SELECT pg_catalog.format('%s holds a column-level %s on %I.%I', u.rolname, p.priv, cn.nspname, cn.relname)
    FROM nonroot u
   CROSS JOIN cn
   CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(priv)
   WHERE u.oid <> cn.relowner
     AND NOT pg_catalog.has_table_privilege(u.oid, cn.oid, p.priv)
     AND pg_catalog.has_any_column_privilege(u.oid, cn.oid, p.priv)
  UNION ALL
  -- (b) no non-root TRIGGER on any relation of the application schema
  SELECT pg_catalog.format('%s holds TRIGGER on public.%I', u.rolname, c.relname)
    FROM nonroot u
   CROSS JOIN pg_catalog.pg_class c
    JOIN guarded_schema s ON s.oid = c.relnamespace AND s.nspname = 'public'
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND u.oid <> c.relowner
     AND pg_catalog.has_table_privilege(u.oid, c.oid, 'TRIGGER')
  UNION ALL
  -- (c) no non-root CREATE on public, the private schema or the policy schema
  SELECT pg_catalog.format('%s holds %s on schema %I', u.rolname, p.priv, s.nspname)
    FROM nonroot u
   CROSS JOIN guarded_schema s
   CROSS JOIN (VALUES ('CREATE')) AS p(priv)
   WHERE u.oid <> s.nspowner
     AND pg_catalog.has_schema_privilege(u.oid, s.oid, p.priv)
  UNION ALL
  -- (d) no object in a guarded schema owned by an API role
  SELECT pg_catalog.format('%s owns %s %I.%I', r.rolname, o.kind, s.nspname, o.name)
    FROM (SELECT c.relowner AS owner, 'relation' AS kind, c.relname::text AS name, c.relnamespace AS ns FROM pg_catalog.pg_class c
          UNION ALL
          SELECT p.proowner, 'routine', p.proname::text, p.pronamespace FROM pg_catalog.pg_proc p
          UNION ALL
          SELECT t.typowner, 'type', t.typname::text, t.typnamespace FROM pg_catalog.pg_type t
          UNION ALL
          SELECT o.oprowner, 'operator', o.oprname::text, o.oprnamespace FROM pg_catalog.pg_operator o) AS o
    JOIN guarded_schema s ON s.oid = o.ns
    JOIN pg_catalog.pg_roles r ON r.oid = o.owner
   WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
  UNION ALL
  -- (e1) the catalog-derived relation set must equal the manifest
  SELECT pg_catalog.format('unlisted_central_needs_relation %I', c.relname)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central\_needs\_%'
     AND c.relname NOT IN (SELECT relname FROM manifest)
  UNION ALL
  SELECT pg_catalog.format('missing_central_needs_relation %I', m.relname)
    FROM manifest m
   WHERE pg_catalog.to_regclass(pg_catalog.format('public.%I', m.relname)) IS NULL
  UNION ALL
  -- (e2) the explicit ACL manifest: PUBLIC, anon or service_role must not EXECUTE
  SELECT pg_catalog.format('routine %s is executable by %s', m.sig, w.who)
    FROM acl_manifest m
   CROSS JOIN LATERAL (SELECT pg_catalog.to_regprocedure(m.sig) AS oid) r
   CROSS JOIN (VALUES ('anon'), ('service_role')) AS w(who)
   WHERE r.oid IS NOT NULL AND pg_catalog.has_function_privilege(w.who, r.oid, 'EXECUTE')
  UNION ALL
  SELECT pg_catalog.format('routine %s is executable by PUBLIC', m.sig)
    FROM acl_manifest m
   CROSS JOIN LATERAL (SELECT pg_catalog.to_regprocedure(m.sig) AS oid) r
   JOIN pg_catalog.pg_proc p ON p.oid = r.oid
   WHERE EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a WHERE a.grantee = 0)
  UNION ALL
  SELECT pg_catalog.format('manifest routine %s is missing', m.sig)
    FROM acl_manifest m
   WHERE pg_catalog.to_regprocedure(m.sig) IS NULL
  UNION ALL
  -- (e3) the policy schema: USAGE for authenticated only
  SELECT pg_catalog.format('%s holds USAGE on schema phoenix_cn_policy', w.who)
    FROM (VALUES ('anon'), ('service_role')) AS w(who)
   WHERE pg_catalog.to_regnamespace('phoenix_cn_policy') IS NOT NULL
     AND pg_catalog.has_schema_privilege(w.who, 'phoenix_cn_policy', 'USAGE')
  UNION ALL
  SELECT 'PUBLIC holds a privilege on schema phoenix_cn_policy'
   WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n,
                        pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
                  WHERE n.nspname = 'phoenix_cn_policy' AND a.grantee = 0)
  UNION ALL
  -- M4' (t1): every manifest relation has FORCED row level security
  SELECT pg_catalog.format('relation %I lacks forced row level security', m.relname)
    FROM manifest m JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(pg_catalog.format('public.%I', m.relname))
   WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity)
  UNION ALL
  -- M4' (t2): ... and the restrictive actor-scope policy
  SELECT pg_catalog.format('relation %I lacks the restrictive actor-scope policy', m.relname)
    FROM manifest m JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(pg_catalog.format('public.%I', m.relname))
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy po WHERE po.polrelid = c.oid AND po.polname = 'r1_actor_scope_restrictive' AND NOT po.polpermissive)
  UNION ALL
  -- M4' (t3): every SECURITY DEFINER routine of the ACL manifest pins its search_path
  SELECT pg_catalog.format('manifest routine %s has no pinned search_path', m.sig)
    FROM acl_manifest m JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(m.sig)
   WHERE p.prosecdef AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(COALESCE(p.proconfig, ARRAY[]::text[])) cfg WHERE cfg LIKE 'search_path=%')
  UNION ALL
  -- M4' (t4): STRUCTURAL - a relation with a foreign key to the plan revisions or to the request relations must be in the manifest, whatever its name
  SELECT pg_catalog.format('unlisted_fk_dependent_relation %I', t.relname)
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
   WHERE con.contype = 'f' AND n.nspname = 'public'
     AND con.confrelid IN (pg_catalog.to_regclass('public.central_needs_plan_revisions'), pg_catalog.to_regclass('public.central_needs_material_requests'))
     AND t.relname NOT IN (SELECT relname FROM manifest)
  UNION ALL
  -- M4' (t5): STRUCTURAL - a routine that writes central_items or the request relations must be on the expected list, whatever its name
  SELECT pg_catalog.format('unlisted_catalog_writer %s.%s', n.nspname, p.proname)
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND pg_catalog.regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
         ~* '(insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+(only\s+)?(table\s+)?("?public"?\.)?"?(central_items|central_needs_material_[a-z_]+)\y'
     AND p.proname NOT IN (SELECT proname FROM expected_catalog_writers)
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_create_material_request_with_code(uuid,text,text,text,text,text,text,text,text,text,text,jsonb,uuid,text) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_update_material_request_with_code(uuid,integer,text,text,text,text,text,text,text,text,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_create_material_request_with_code(uuid,text,text,text,text,text,text,text,text,text,text,jsonb,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_update_material_request_with_code(uuid,integer,text,text,text,text,text,text,text,text,text) TO authenticated;

DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'central_needs_capability_seal_breached';
  END IF;
END $verify$;
COMMIT;
