-- ============================================================================
-- R1-a CANDIDATE 04 — the manual annual-needs routines, shipped INERT.
-- PLACEHOLDER (no migration number): NOT part of the numbered chain, NOT approved
-- for apply. Requires candidates 01–03.
--
-- Every writer is created with EXECUTE for the owner ONLY (never PUBLIC, anon,
-- authenticated or service_role). R1-b grants EXECUTE to authenticated; until then
-- nothing can call them through the Data API. The three readers are INVOKER and
-- granted to authenticated now (they confer nothing beyond RLS / constants).
--
-- Writer census delta (ADR §4.7): exactly eight new writers
--   open_manual_plan_revision, open_manual_correction_revision, carry_forward_manual_lines,
--   add_manual_need_line, correct_manual_need_line, void_manual_need_line,
--   withdraw_draft_revision, acknowledge_manual_coverage.
-- DML on central_needs_* lives IN each of them (no shared DML helper), so the census is
-- exactly 15 -> 23 and restated by the R1-a VERIFY.
--
-- Contract: R1-0 ADR rev4d §4.7, §10 (MO-7), §10.1 (XD-3), §11, §12, §13.
-- ============================================================================
BEGIN;

DO $pre$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'R1a04_requires_read_committed';
  END IF;
  IF to_regclass('public.central_needs_cutover_inventory') IS NULL
     OR to_regprocedure('phoenix_cn_policy.excel_sod_enabled()') IS NULL THEN
    RAISE EXCEPTION 'R1a04_precondition_failed: candidates 01-03 must be applied first';
  END IF;
  IF to_regprocedure('public.phoenix_central_needs_add_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'R1a04_precondition_failed: R1-a routines already present';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 0. Non-writer helpers (no DML on central_needs_*)
-- ---------------------------------------------------------------------------
-- Canonical quantity grammar (ADR §4.11): ASCII only, server never normalizes.
CREATE FUNCTION phoenix_private.central_needs_manual_quantity_v1(p_text text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_text IS NULL THEN
    RAISE EXCEPTION 'manual_quantity_required' USING ERRCODE = '23514';
  END IF;
  IF p_text ~ E'[٠-٩۰-۹٫٬]' THEN
    RAISE EXCEPTION 'manual_quantity_non_ascii' USING ERRCODE = '23514',
      HINT = 'The server never normalizes digits; the client must send canonical ASCII text.';
  END IF;
  IF char_length(p_text) > 256 OR p_text !~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$' THEN
    RAISE EXCEPTION 'manual_quantity_not_canonical' USING ERRCODE = '23514';
  END IF;
  RETURN p_text;
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_manual_quantity_v1(text) FROM PUBLIC, anon, authenticated, service_role;

-- Scope validation shared by add/correct/void: raises, returns the item's canonical unit.
CREATE FUNCTION phoenix_private.central_needs_manual_scope_v1(p_beneficiary uuid, p_item uuid, p_warehouse uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_unit text;
BEGIN
  IF p_beneficiary IS NULL OR p_item IS NULL THEN
    RAISE EXCEPTION 'manual_scope_required' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o
                  WHERE o.id = p_beneficiary AND o.organization_kind = 'care_institution' AND o.status = 'active' AND o.archived_at IS NULL) THEN
    RAISE EXCEPTION 'manual_beneficiary_ineligible' USING ERRCODE = '23514', DETAIL = format('beneficiary=%s', p_beneficiary);
  END IF;
  SELECT i.unit INTO v_unit FROM public.central_items i WHERE i.id = p_item AND i.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'central_item_not_active' USING ERRCODE = '23514', DETAIL = format('item=%s', p_item);
  END IF;
  IF p_warehouse IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.warehouses w
        WHERE w.id = p_warehouse AND w.organization_id = p_beneficiary AND w.status = 'active') THEN
    RAISE EXCEPTION 'manual_warehouse_ineligible' USING ERRCODE = '23514', DETAIL = format('warehouse=%s', p_warehouse);
  END IF;
  RETURN v_unit;
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_manual_scope_v1(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Coverage digest (coverage-v1, ADR §13 FM-8): the scopes of the effective predecessor that the
-- revision does not (yet) contain. Scope identities only; no quantity is read.
CREATE FUNCTION phoenix_private.central_needs_coverage_digest_v1(p_revision uuid, p_predecessor uuid)
RETURNS TABLE(omitted_scope_digest text, omitted_scope_count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH e_scopes AS (
    SELECT DISTINCT n.beneficiary_organization_id AS b, n.central_item_id AS i, n.target_warehouse_id AS w
      FROM public.central_needs_need_lines n WHERE n.plan_revision_id = p_predecessor
  ), live AS (
    SELECT DISTINCT n.beneficiary_organization_id AS b, n.central_item_id AS i, n.target_warehouse_id AS w
      FROM public.central_needs_need_lines n WHERE n.plan_revision_id = p_revision
  ), omitted AS (
    SELECT s.b, s.i, s.w FROM e_scopes s
     WHERE NOT EXISTS (SELECT 1 FROM live l WHERE l.b = s.b AND l.i = s.i AND l.w IS NOT DISTINCT FROM s.w)
  )
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           jsonb_build_array('coverage-v1', p_predecessor,
             COALESCE((SELECT jsonb_agg(jsonb_build_array(o.b::text, o.i::text, o.w::text)
                         ORDER BY o.b::text COLLATE "C", o.i::text COLLATE "C", o.w::text COLLATE "C" NULLS FIRST) FROM omitted o), '[]'::jsonb))::text,
           'UTF8')), 'hex'),
         (SELECT count(*)::int FROM omitted)
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_coverage_digest_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- The effective approved predecessor of a revision's plan (any source mode), NULL if none or ambiguous
CREATE FUNCTION phoenix_private.central_needs_effective_predecessor_v1(p_revision uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(e.id))[1] ELSE NULL END
    FROM public.central_needs_plan_revisions r
    JOIN public.central_needs_plan_revisions e ON e.plan_id = r.plan_id AND e.status = 'approved' AND e.id <> r.id
   WHERE r.id = p_revision
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_effective_predecessor_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. open_manual_plan_revision (FM-1, FM-2, XD-5)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.phoenix_central_needs_open_manual_plan_revision(p_organization_id uuid, p_plan_year integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role  text;
  v_plan  public.central_needs_plans%ROWTYPE;
  v_cur   public.central_needs_plan_revisions%ROWTYPE;
  v_new   public.central_needs_plan_revisions%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'manual_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_role := public._phoenix_central_needs_guard_v1(p_organization_id, 'central_needs.edit');
  IF p_plan_year IS NULL THEN
    RAISE EXCEPTION 'plan_year_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_plan_year::text, 210001));
  SELECT * INTO v_plan FROM public.central_needs_plans
   WHERE organization_id = p_organization_id AND plan_year = p_plan_year FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.central_needs_plans (organization_id, plan_year, created_by)
    VALUES (p_organization_id, p_plan_year, v_actor) RETURNING * INTO v_plan;
  END IF;

  SELECT * INTO v_cur FROM public.central_needs_plan_revisions
   WHERE plan_id = v_plan.id ORDER BY revision_number DESC LIMIT 1 FOR UPDATE;

  IF FOUND THEN
    IF v_cur.source_mode = 'excel' AND v_cur.status IN ('draft', 'submitted') THEN
      RAISE EXCEPTION 'excel_revision_pending_resolution' USING ERRCODE = '23514',
        DETAIL = format('revision=%s status=%s', v_cur.id, v_cur.status);
    END IF;
    IF v_cur.status = 'draft' THEN   -- manual draft: idempotent
      RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'plan_id', v_plan.id,
        'plan_revision_id', v_cur.id, 'revision_number', v_cur.revision_number, 'status', v_cur.status, 'source_mode', v_cur.source_mode);
    END IF;
    IF v_cur.status = 'submitted' THEN
      RAISE EXCEPTION 'plan_revision_still_in_review' USING ERRCODE = '23514', DETAIL = format('revision=%s', v_cur.id);
    END IF;
    RAISE EXCEPTION 'central_needs_governed_correction_required' USING ERRCODE = '23514',
      DETAIL = format('newest revision=%s status=%s', v_cur.id, v_cur.status),
      HINT = 'Use open_manual_correction_revision with the expected latest revision.';
  END IF;

  INSERT INTO public.central_needs_plan_revisions (plan_id, organization_id, revision_number, status, source_mode, created_by)
  VALUES (v_plan.id, p_organization_id, 1, 'draft', 'manual', v_actor) RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (p_organization_id, v_actor, v_role, 'central_needs.manual_revision.open', 'central_needs_plan_revision', v_new.id,
          format('plan %s revision %s', p_plan_year, v_new.revision_number),
          jsonb_build_object('plan_id', v_plan.id, 'plan_year', p_plan_year, 'revision_number', 1, 'source_mode', 'manual'));

  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'plan_id', v_plan.id, 'plan_revision_id', v_new.id,
    'revision_number', v_new.revision_number, 'status', v_new.status, 'source_mode', v_new.source_mode);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_open_manual_plan_revision(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. open_manual_correction_revision (FM-3…FM-5a, XD-5)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.phoenix_central_needs_open_manual_correction_revision(
  p_organization_id uuid, p_plan_year integer, p_expected_latest_revision_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_role     text;
  v_reason   text := public._phoenix_central_needs_human_text_v1(p_reason);
  v_plan     public.central_needs_plans%ROWTYPE;
  v_latest   public.central_needs_plan_revisions%ROWTYPE;
  v_expected public.central_needs_plan_revisions%ROWTYPE;
  v_new      public.central_needs_plan_revisions%ROWTYPE;
  v_approved integer;
  v_eff      uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'manual_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_role := public._phoenix_central_needs_guard_v1(p_organization_id, 'central_needs.edit');
  IF p_plan_year IS NULL THEN RAISE EXCEPTION 'plan_year_required' USING ERRCODE = '23514'; END IF;
  IF p_expected_latest_revision_id IS NULL THEN RAISE EXCEPTION 'expected_latest_revision_id_required' USING ERRCODE = '23514'; END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 2000 THEN RAISE EXCEPTION 'correction_reason_required' USING ERRCODE = '23514'; END IF;

  v_plan := public._phoenix_central_needs_lock_plan_family_v1(p_organization_id, p_plan_year);
  SELECT * INTO v_expected FROM public.central_needs_plan_revisions WHERE id = p_expected_latest_revision_id;
  IF NOT FOUND OR v_expected.plan_id <> v_plan.id THEN
    RAISE EXCEPTION 'central_needs_correction_plan_mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_latest FROM public.central_needs_plan_revisions WHERE plan_id = v_plan.id ORDER BY revision_number DESC LIMIT 1;
  IF v_latest.id <> p_expected_latest_revision_id THEN
    RAISE EXCEPTION 'central_needs_revision_stale' USING ERRCODE = '23514',
      DETAIL = format('expected_latest=%s actual_latest=%s (%s)', p_expected_latest_revision_id, v_latest.id, v_latest.status);
  END IF;
  IF v_latest.source_mode = 'excel' AND v_latest.status IN ('draft', 'submitted') THEN
    RAISE EXCEPTION 'excel_revision_pending_resolution' USING ERRCODE = '23514', DETAIL = format('revision=%s', v_latest.id);
  END IF;
  IF v_latest.status = 'draft' THEN RAISE EXCEPTION 'plan_revision_draft_already_open' USING ERRCODE = '23514'; END IF;
  IF v_latest.status = 'submitted' THEN RAISE EXCEPTION 'plan_revision_still_in_review' USING ERRCODE = '23514'; END IF;
  IF v_latest.status NOT IN ('approved', 'rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
      DETAIL = format('newest revision=%s has status=%s', v_latest.id, v_latest.status);
  END IF;
  SELECT count(*) INTO v_approved FROM public.central_needs_plan_revisions WHERE plan_id = v_plan.id AND status = 'approved';
  IF v_approved > 1 THEN RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514'; END IF;
  IF v_approved = 1 THEN SELECT id INTO v_eff FROM public.central_needs_plan_revisions WHERE plan_id = v_plan.id AND status = 'approved'; END IF;

  INSERT INTO public.central_needs_plan_revisions (plan_id, organization_id, revision_number, status, source_mode, created_by)
  VALUES (v_plan.id, p_organization_id, v_latest.revision_number + 1, 'draft', 'manual', v_actor) RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (p_organization_id, v_actor, v_role, 'central_needs.manual_revision.open_correction', 'central_needs_plan_revision', v_new.id,
          format('plan %s correction revision %s', p_plan_year, v_new.revision_number),
          jsonb_build_object('plan_id', v_plan.id, 'plan_year', p_plan_year, 'revision_number', v_new.revision_number,
            'opened_after_revision_id', v_latest.id, 'opened_after_status', v_latest.status,
            'effective_approved_revision_id', v_eff, 'correction_reason', v_reason));

  RETURN jsonb_build_object('ok', true, 'plan_id', v_plan.id, 'plan_year', p_plan_year, 'plan_revision_id', v_new.id,
    'revision_number', v_new.revision_number, 'status', v_new.status, 'source_mode', 'manual',
    'opened_after_revision_id', v_latest.id, 'effective_approved_revision_id', v_eff);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_open_manual_correction_revision(uuid, integer, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. carry_forward_manual_lines (VC-7, VC-8) — F2 order: lock -> LOAD -> DRAFT -> write
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.phoenix_central_needs_carry_forward_manual_lines(p_plan_revision_id uuid, p_expected_source_revision_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_role   text;
  v_org    uuid;
  v_year   integer;
  v_rev    public.central_needs_plan_revisions%ROWTYPE;
  v_src    public.central_needs_plan_revisions%ROWTYPE;
  v_n      integer := 0;
  v_existing integer;
  r        record;
  v_line   uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'manual_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  IF p_plan_revision_id IS NULL OR p_expected_source_revision_id IS NULL THEN
    RAISE EXCEPTION 'manual_carry_arguments_required' USING ERRCODE = '23514';
  END IF;
  SELECT r1.organization_id, p.plan_year INTO v_org, v_year
    FROM public.central_needs_plan_revisions r1 JOIN public.central_needs_plans p ON p.id = r1.plan_id
   WHERE r1.id = p_plan_revision_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002'; END IF;
  v_role := public._phoenix_central_needs_guard_v1(v_org, 'central_needs.edit');

  PERFORM public._phoenix_central_needs_lock_plan_family_v1(v_org, v_year);
  v_rev := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);
  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_rev.status);
  IF v_rev.source_mode <> 'manual' THEN
    RAISE EXCEPTION 'manual_revision_required' USING ERRCODE = '23514', DETAIL = format('revision=%s', v_rev.id);
  END IF;

  SELECT count(*) INTO v_existing FROM public.central_needs_manual_need_events WHERE plan_revision_id = p_plan_revision_id;
  IF v_existing > 0 THEN
    IF EXISTS (SELECT 1 FROM public.central_needs_manual_need_events e
                 JOIN public.central_needs_manual_need_events c ON c.id = e.carried_from_event_id
                WHERE e.plan_revision_id = p_plan_revision_id AND e.event_kind = 'carried_forward' AND c.plan_revision_id = p_expected_source_revision_id)
       AND NOT EXISTS (SELECT 1 FROM public.central_needs_manual_need_events e WHERE e.plan_revision_id = p_plan_revision_id AND e.event_kind <> 'carried_forward' AND e.event_seq = 1) THEN
      RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'plan_revision_id', p_plan_revision_id,
        'source_revision_id', p_expected_source_revision_id,
        'carried_count', (SELECT count(*) FROM public.central_needs_manual_need_events WHERE plan_revision_id = p_plan_revision_id AND event_kind = 'carried_forward'));
    END IF;
    RAISE EXCEPTION 'manual_carry_requires_empty_revision' USING ERRCODE = '23514', DETAIL = format('revision=%s events=%s', p_plan_revision_id, v_existing);
  END IF;

  -- the source must be the plan's single approved MANUAL revision and equal the expected one
  SELECT * INTO v_src FROM public.central_needs_plan_revisions
   WHERE plan_id = v_rev.plan_id AND status = 'approved' AND id <> p_plan_revision_id;
  IF NOT FOUND OR v_src.id <> p_expected_source_revision_id THEN
    RAISE EXCEPTION 'manual_carry_source_stale' USING ERRCODE = '23514', DETAIL = format('expected=%s', p_expected_source_revision_id);
  END IF;
  IF v_src.source_mode <> 'manual' THEN
    RAISE EXCEPTION 'manual_carry_source_not_manual' USING ERRCODE = '23514',
      DETAIL = format('source=%s source_mode=%s', v_src.id, v_src.source_mode),
      HINT = 'Excel quantities are never carried into a manual revision (D27).';
  END IF;

  FOR r IN
    SELECT e.* FROM public.central_needs_manual_need_events e
     WHERE e.plan_revision_id = v_src.id
       AND e.event_seq = (SELECT max(e2.event_seq) FROM public.central_needs_manual_need_events e2
                           WHERE e2.plan_revision_id = e.plan_revision_id AND e2.beneficiary_organization_id = e.beneficiary_organization_id
                             AND e2.central_item_id = e.central_item_id AND e2.target_warehouse_id IS NOT DISTINCT FROM e.target_warehouse_id)
       AND e.event_kind <> 'void'
     ORDER BY e.beneficiary_organization_id, e.central_item_id, e.target_warehouse_id NULLS FIRST
  LOOP
    v_line := gen_random_uuid();
    INSERT INTO public.central_needs_manual_need_events (
      organization_id, plan_id, plan_revision_id, beneficiary_organization_id, central_item_id, target_warehouse_id,
      event_seq, event_kind, quantity_text, approved_unit, carried_from_event_id, reason, actor_id, actor_role, idempotency_key, need_line_id)
    VALUES (v_org, v_rev.plan_id, p_plan_revision_id, r.beneficiary_organization_id, r.central_item_id, r.target_warehouse_id,
      1, 'carried_forward', r.quantity_text, r.approved_unit, r.id,
      format('carried forward from revision %s', v_src.revision_number), v_actor, v_role,
      'carry:' || p_plan_revision_id::text || ':' || r.id::text, v_line);
    INSERT INTO public.central_needs_need_lines (
      id, plan_revision_id, organization_id, beneficiary_organization_id, target_warehouse_id, central_item_id,
      approved_quantity, approved_unit, unit_conversion_state, mapping_reason, mapped_by)
    VALUES (v_line, p_plan_revision_id, v_org, r.beneficiary_organization_id, r.target_warehouse_id, r.central_item_id,
      r.quantity_text::numeric, r.approved_unit, 'canonical', format('carried forward from revision %s', v_src.revision_number), v_actor);
    v_n := v_n + 1;
  END LOOP;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_org, v_actor, v_role, 'central_needs.manual_need.carry_forward', 'central_needs_plan_revision', p_plan_revision_id,
          format('carry from revision %s', v_src.revision_number),
          jsonb_build_object('source_revision_id', v_src.id, 'carried_count', v_n));

  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'plan_revision_id', p_plan_revision_id,
    'source_revision_id', v_src.id, 'carried_count', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_carry_forward_manual_lines(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. add / correct / void (VC-1…VC-6, VC-9, VC-10) — DML inside each routine (census)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.phoenix_central_needs_add_manual_need_line(
  p_plan_revision_id uuid, p_beneficiary_organization_id uuid, p_central_item_id uuid, p_target_warehouse_id uuid,
  p_quantity_text text, p_reason text, p_idempotency_key text, p_expected_last_event_id uuid DEFAULT NULL, p_reference text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_role   text;
  v_org    uuid;
  v_year   integer;
  v_rev    public.central_needs_plan_revisions%ROWTYPE;
  v_qty    text;
  v_reason text := public._phoenix_central_needs_human_text_v1(p_reason);
  v_ref    text := public._phoenix_central_needs_human_text_v1(p_reference);
  v_unit   text;
  v_prior  public.central_needs_manual_need_events%ROWTYPE;
  v_last   public.central_needs_manual_need_events%ROWTYPE;
  v_line   uuid := gen_random_uuid();
  v_event  uuid;
  v_seq    integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'manual_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_qty := phoenix_private.central_needs_manual_quantity_v1(p_quantity_text);
  IF v_reason IS NULL OR char_length(v_reason) > 2000 THEN RAISE EXCEPTION 'manual_reason_required' USING ERRCODE = '23514'; END IF;
  IF v_ref IS NOT NULL AND char_length(v_ref) > 200 THEN RAISE EXCEPTION 'manual_reference_too_long' USING ERRCODE = '23514'; END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'manual_idempotency_key_invalid' USING ERRCODE = '23514';
  END IF;
  SELECT r1.organization_id, p.plan_year INTO v_org, v_year
    FROM public.central_needs_plan_revisions r1 JOIN public.central_needs_plans p ON p.id = r1.plan_id WHERE r1.id = p_plan_revision_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002'; END IF;
  v_role := public._phoenix_central_needs_guard_v1(v_org, 'central_needs.manual_need.set');

  PERFORM public._phoenix_central_needs_lock_plan_family_v1(v_org, v_year);
  v_rev := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);

  -- replay check precedes the stale fence and assert_draft (C11)
  SELECT * INTO v_prior FROM public.central_needs_manual_need_events WHERE plan_id = v_rev.plan_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior.event_kind = 'add' AND v_prior.plan_revision_id = p_plan_revision_id
       AND v_prior.beneficiary_organization_id = p_beneficiary_organization_id AND v_prior.central_item_id = p_central_item_id
       AND v_prior.target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id AND v_prior.quantity_text = v_qty
       AND v_prior.reason = v_reason AND v_prior.reference IS NOT DISTINCT FROM v_ref THEN
      RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'event_id', v_prior.id, 'event_seq', v_prior.event_seq,
        'need_line_id', v_prior.need_line_id, 'event_kind', v_prior.event_kind, 'quantity_text', v_prior.quantity_text);
    END IF;
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505', DETAIL = format('key=%s', p_idempotency_key);
  END IF;

  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_rev.status);
  IF v_rev.source_mode <> 'manual' THEN
    RAISE EXCEPTION 'manual_revision_required' USING ERRCODE = '23514', DETAIL = format('revision=%s', v_rev.id);
  END IF;
  v_unit := phoenix_private.central_needs_manual_scope_v1(p_beneficiary_organization_id, p_central_item_id, p_target_warehouse_id);

  SELECT * INTO v_last FROM public.central_needs_manual_need_events e
   WHERE e.plan_revision_id = p_plan_revision_id AND e.beneficiary_organization_id = p_beneficiary_organization_id
     AND e.central_item_id = p_central_item_id AND e.target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id
   ORDER BY e.event_seq DESC LIMIT 1;
  IF FOUND THEN
    IF p_expected_last_event_id IS DISTINCT FROM v_last.id THEN
      RAISE EXCEPTION 'manual_need_line_stale' USING ERRCODE = '23514', DETAIL = format('last=%s', v_last.id);
    END IF;
    IF v_last.event_kind <> 'void' THEN
      RAISE EXCEPTION 'manual_need_line_already_live' USING ERRCODE = '23514', DETAIL = format('last=%s', v_last.id);
    END IF;
  ELSIF p_expected_last_event_id IS NOT NULL THEN
    RAISE EXCEPTION 'manual_need_line_stale' USING ERRCODE = '23514', DETAIL = 'no event exists for this line';
  END IF;
  v_seq := COALESCE(v_last.event_seq, 0) + 1;

  -- EVENT FIRST, then the projection (the BEFORE trigger needs the event)
  INSERT INTO public.central_needs_manual_need_events (
    organization_id, plan_id, plan_revision_id, beneficiary_organization_id, central_item_id, target_warehouse_id,
    event_seq, event_kind, quantity_text, approved_unit, supersedes_event_id, reason, reference, actor_id, actor_role, idempotency_key, need_line_id)
  VALUES (v_org, v_rev.plan_id, p_plan_revision_id, p_beneficiary_organization_id, p_central_item_id, p_target_warehouse_id,
    v_seq, 'add', v_qty, v_unit, v_last.id, v_reason, v_ref, v_actor, v_role, p_idempotency_key, v_line)
  RETURNING id INTO v_event;
  INSERT INTO public.central_needs_need_lines (
    id, plan_revision_id, organization_id, beneficiary_organization_id, target_warehouse_id, central_item_id,
    approved_quantity, approved_unit, unit_conversion_state, mapping_reason, mapped_by)
  VALUES (v_line, p_plan_revision_id, v_org, p_beneficiary_organization_id, p_target_warehouse_id, p_central_item_id,
    v_qty::numeric, v_unit, 'canonical', v_reason, v_actor);

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_org, v_actor, v_role, 'central_needs.manual_need.add', 'central_needs_plan_revision', p_plan_revision_id, format('event %s', v_seq),
          jsonb_build_object('event_id', v_event, 'beneficiary_organization_id', p_beneficiary_organization_id, 'central_item_id', p_central_item_id,
            'target_warehouse_id', p_target_warehouse_id, 'quantity_before', NULL, 'quantity_after', v_qty, 'reason', v_reason));

  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'event_id', v_event, 'event_seq', v_seq,
    'need_line_id', v_line, 'event_kind', 'add', 'quantity_text', v_qty);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_add_manual_need_line(uuid, uuid, uuid, uuid, text, text, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.phoenix_central_needs_correct_manual_need_line(
  p_plan_revision_id uuid, p_beneficiary_organization_id uuid, p_central_item_id uuid, p_target_warehouse_id uuid,
  p_quantity_text text, p_reason text, p_idempotency_key text, p_expected_last_event_id uuid, p_reference text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_role   text;
  v_org    uuid;
  v_year   integer;
  v_rev    public.central_needs_plan_revisions%ROWTYPE;
  v_qty    text;
  v_reason text := public._phoenix_central_needs_human_text_v1(p_reason);
  v_ref    text := public._phoenix_central_needs_human_text_v1(p_reference);
  v_prior  public.central_needs_manual_need_events%ROWTYPE;
  v_last   public.central_needs_manual_need_events%ROWTYPE;
  v_event  uuid;
  v_seq    integer;
  v_rows   integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'manual_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_qty := phoenix_private.central_needs_manual_quantity_v1(p_quantity_text);
  IF v_reason IS NULL OR char_length(v_reason) > 2000 THEN RAISE EXCEPTION 'manual_reason_required' USING ERRCODE = '23514'; END IF;
  IF v_ref IS NOT NULL AND char_length(v_ref) > 200 THEN RAISE EXCEPTION 'manual_reference_too_long' USING ERRCODE = '23514'; END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'manual_idempotency_key_invalid' USING ERRCODE = '23514';
  END IF;
  IF p_expected_last_event_id IS NULL THEN RAISE EXCEPTION 'manual_expected_last_event_required' USING ERRCODE = '23514'; END IF;
  SELECT r1.organization_id, p.plan_year INTO v_org, v_year
    FROM public.central_needs_plan_revisions r1 JOIN public.central_needs_plans p ON p.id = r1.plan_id WHERE r1.id = p_plan_revision_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002'; END IF;
  v_role := public._phoenix_central_needs_guard_v1(v_org, 'central_needs.manual_need.set');

  PERFORM public._phoenix_central_needs_lock_plan_family_v1(v_org, v_year);
  v_rev := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);

  SELECT * INTO v_prior FROM public.central_needs_manual_need_events WHERE plan_id = v_rev.plan_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior.event_kind = 'correct' AND v_prior.plan_revision_id = p_plan_revision_id
       AND v_prior.beneficiary_organization_id = p_beneficiary_organization_id AND v_prior.central_item_id = p_central_item_id
       AND v_prior.target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id AND v_prior.quantity_text = v_qty
       AND v_prior.reason = v_reason AND v_prior.reference IS NOT DISTINCT FROM v_ref THEN
      RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'event_id', v_prior.id, 'event_seq', v_prior.event_seq,
        'need_line_id', v_prior.need_line_id, 'event_kind', v_prior.event_kind, 'quantity_text', v_prior.quantity_text);
    END IF;
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505', DETAIL = format('key=%s', p_idempotency_key);
  END IF;

  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_rev.status);
  IF v_rev.source_mode <> 'manual' THEN
    RAISE EXCEPTION 'manual_revision_required' USING ERRCODE = '23514', DETAIL = format('revision=%s', v_rev.id);
  END IF;
  PERFORM phoenix_private.central_needs_manual_scope_v1(p_beneficiary_organization_id, p_central_item_id, p_target_warehouse_id);

  SELECT * INTO v_last FROM public.central_needs_manual_need_events e
   WHERE e.plan_revision_id = p_plan_revision_id AND e.beneficiary_organization_id = p_beneficiary_organization_id
     AND e.central_item_id = p_central_item_id AND e.target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id
   ORDER BY e.event_seq DESC LIMIT 1;
  IF NOT FOUND OR v_last.event_kind = 'void' THEN
    RAISE EXCEPTION 'manual_need_line_not_live' USING ERRCODE = '23514';
  END IF;
  IF v_last.id <> p_expected_last_event_id THEN
    RAISE EXCEPTION 'manual_need_line_stale' USING ERRCODE = '23514', DETAIL = format('last=%s', v_last.id);
  END IF;
  IF v_last.quantity_text = v_qty THEN
    RAISE EXCEPTION 'manual_need_line_no_change' USING ERRCODE = '23514', DETAIL = format('quantity=%s', v_qty);
  END IF;
  v_seq := v_last.event_seq + 1;

  INSERT INTO public.central_needs_manual_need_events (
    organization_id, plan_id, plan_revision_id, beneficiary_organization_id, central_item_id, target_warehouse_id,
    event_seq, event_kind, quantity_text, approved_unit, supersedes_event_id, reason, reference, actor_id, actor_role, idempotency_key, need_line_id)
  VALUES (v_org, v_rev.plan_id, p_plan_revision_id, p_beneficiary_organization_id, p_central_item_id, p_target_warehouse_id,
    v_seq, 'correct', v_qty, v_last.approved_unit, v_last.id, v_reason, v_ref, v_actor, v_role, p_idempotency_key, v_last.need_line_id)
  RETURNING id INTO v_event;
  UPDATE public.central_needs_need_lines
     SET approved_quantity = v_qty::numeric, mapping_reason = v_reason, mapped_by = v_actor
   WHERE plan_revision_id = p_plan_revision_id AND beneficiary_organization_id = p_beneficiary_organization_id
     AND central_item_id = p_central_item_id AND target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'manual_projection_row_missing' USING ERRCODE = '23514', DETAIL = format('rows=%s', v_rows);
  END IF;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_org, v_actor, v_role, 'central_needs.manual_need.correct', 'central_needs_plan_revision', p_plan_revision_id, format('event %s', v_seq),
          jsonb_build_object('event_id', v_event, 'beneficiary_organization_id', p_beneficiary_organization_id, 'central_item_id', p_central_item_id,
            'target_warehouse_id', p_target_warehouse_id, 'quantity_before', v_last.quantity_text, 'quantity_after', v_qty, 'reason', v_reason));

  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'event_id', v_event, 'event_seq', v_seq,
    'need_line_id', v_last.need_line_id, 'event_kind', 'correct', 'quantity_text', v_qty);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_correct_manual_need_line(uuid, uuid, uuid, uuid, text, text, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.phoenix_central_needs_void_manual_need_line(
  p_plan_revision_id uuid, p_beneficiary_organization_id uuid, p_central_item_id uuid, p_target_warehouse_id uuid,
  p_reason text, p_idempotency_key text, p_expected_last_event_id uuid, p_reference text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_role   text;
  v_org    uuid;
  v_year   integer;
  v_rev    public.central_needs_plan_revisions%ROWTYPE;
  v_reason text := public._phoenix_central_needs_human_text_v1(p_reason);
  v_ref    text := public._phoenix_central_needs_human_text_v1(p_reference);
  v_prior  public.central_needs_manual_need_events%ROWTYPE;
  v_last   public.central_needs_manual_need_events%ROWTYPE;
  v_event  uuid;
  v_seq    integer;
  v_rows   integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'manual_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 2000 THEN RAISE EXCEPTION 'manual_reason_required' USING ERRCODE = '23514'; END IF;
  IF v_ref IS NOT NULL AND char_length(v_ref) > 200 THEN RAISE EXCEPTION 'manual_reference_too_long' USING ERRCODE = '23514'; END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'manual_idempotency_key_invalid' USING ERRCODE = '23514';
  END IF;
  IF p_expected_last_event_id IS NULL THEN RAISE EXCEPTION 'manual_expected_last_event_required' USING ERRCODE = '23514'; END IF;
  SELECT r1.organization_id, p.plan_year INTO v_org, v_year
    FROM public.central_needs_plan_revisions r1 JOIN public.central_needs_plans p ON p.id = r1.plan_id WHERE r1.id = p_plan_revision_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002'; END IF;
  v_role := public._phoenix_central_needs_guard_v1(v_org, 'central_needs.manual_need.set');

  PERFORM public._phoenix_central_needs_lock_plan_family_v1(v_org, v_year);
  v_rev := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);

  SELECT * INTO v_prior FROM public.central_needs_manual_need_events WHERE plan_id = v_rev.plan_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior.event_kind = 'void' AND v_prior.plan_revision_id = p_plan_revision_id
       AND v_prior.beneficiary_organization_id = p_beneficiary_organization_id AND v_prior.central_item_id = p_central_item_id
       AND v_prior.target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id
       AND v_prior.reason = v_reason AND v_prior.reference IS NOT DISTINCT FROM v_ref THEN
      RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'event_id', v_prior.id, 'event_seq', v_prior.event_seq,
        'event_kind', v_prior.event_kind);
    END IF;
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505', DETAIL = format('key=%s', p_idempotency_key);
  END IF;

  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_rev.status);
  IF v_rev.source_mode <> 'manual' THEN
    RAISE EXCEPTION 'manual_revision_required' USING ERRCODE = '23514', DETAIL = format('revision=%s', v_rev.id);
  END IF;

  SELECT * INTO v_last FROM public.central_needs_manual_need_events e
   WHERE e.plan_revision_id = p_plan_revision_id AND e.beneficiary_organization_id = p_beneficiary_organization_id
     AND e.central_item_id = p_central_item_id AND e.target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id
   ORDER BY e.event_seq DESC LIMIT 1;
  IF NOT FOUND OR v_last.event_kind = 'void' THEN
    RAISE EXCEPTION 'manual_need_line_not_live' USING ERRCODE = '23514';
  END IF;
  IF v_last.id <> p_expected_last_event_id THEN
    RAISE EXCEPTION 'manual_need_line_stale' USING ERRCODE = '23514', DETAIL = format('last=%s', v_last.id);
  END IF;
  v_seq := v_last.event_seq + 1;

  INSERT INTO public.central_needs_manual_need_events (
    organization_id, plan_id, plan_revision_id, beneficiary_organization_id, central_item_id, target_warehouse_id,
    event_seq, event_kind, quantity_text, approved_unit, supersedes_event_id, reason, reference, actor_id, actor_role, idempotency_key, need_line_id)
  VALUES (v_org, v_rev.plan_id, p_plan_revision_id, p_beneficiary_organization_id, p_central_item_id, p_target_warehouse_id,
    v_seq, 'void', NULL, NULL, v_last.id, v_reason, v_ref, v_actor, v_role, p_idempotency_key, NULL)
  RETURNING id INTO v_event;
  DELETE FROM public.central_needs_need_lines
   WHERE plan_revision_id = p_plan_revision_id AND beneficiary_organization_id = p_beneficiary_organization_id
     AND central_item_id = p_central_item_id AND target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'manual_projection_row_missing' USING ERRCODE = '23514', DETAIL = format('rows=%s', v_rows);
  END IF;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_org, v_actor, v_role, 'central_needs.manual_need.void', 'central_needs_plan_revision', p_plan_revision_id, format('event %s', v_seq),
          jsonb_build_object('event_id', v_event, 'beneficiary_organization_id', p_beneficiary_organization_id, 'central_item_id', p_central_item_id,
            'target_warehouse_id', p_target_warehouse_id, 'quantity_before', v_last.quantity_text, 'quantity_after', NULL, 'reason', v_reason));

  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'event_id', v_event, 'event_seq', v_seq, 'event_kind', 'void');
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_void_manual_need_line(uuid, uuid, uuid, uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. withdraw_draft_revision (XD-3, SOD-9). The authority gate enforces key, opener != actor,
--    and the same-transaction withdrawal record; nothing is deleted.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.phoenix_central_needs_withdraw_draft_revision(
  p_plan_revision_id uuid, p_expected_latest_revision_id uuid, p_reason text, p_reference text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_role   text;
  v_org    uuid;
  v_year   integer;
  v_rev    public.central_needs_plan_revisions%ROWTYPE;
  v_latest uuid;
  v_reason text := public._phoenix_central_needs_human_text_v1(p_reason);
  v_ref    text := public._phoenix_central_needs_human_text_v1(p_reference);
  v_sessions jsonb;
  v_counts   jsonb;
  v_digest   text;
  v_id       uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'manual_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  IF p_plan_revision_id IS NULL OR p_expected_latest_revision_id IS NULL THEN
    RAISE EXCEPTION 'withdraw_arguments_required' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 2000 THEN RAISE EXCEPTION 'withdraw_reason_required' USING ERRCODE = '23514'; END IF;
  IF v_ref IS NOT NULL AND char_length(v_ref) > 200 THEN RAISE EXCEPTION 'manual_reference_too_long' USING ERRCODE = '23514'; END IF;
  SELECT r1.organization_id, p.plan_year INTO v_org, v_year
    FROM public.central_needs_plan_revisions r1 JOIN public.central_needs_plans p ON p.id = r1.plan_id WHERE r1.id = p_plan_revision_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002'; END IF;
  v_role := public._phoenix_central_needs_guard_v1(v_org, 'central_needs.approve');

  PERFORM public._phoenix_central_needs_lock_plan_family_v1(v_org, v_year);
  v_rev := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);
  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_rev.status);
  SELECT id INTO v_latest FROM public.central_needs_plan_revisions WHERE plan_id = v_rev.plan_id ORDER BY revision_number DESC LIMIT 1;
  IF v_latest <> p_expected_latest_revision_id OR v_latest <> p_plan_revision_id THEN
    RAISE EXCEPTION 'central_needs_revision_stale' USING ERRCODE = '23514',
      DETAIL = format('expected_latest=%s actual_latest=%s', p_expected_latest_revision_id, v_latest);
  END IF;
  IF v_rev.created_by IS NOT DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'central_needs_separation_of_duties_violation' USING ERRCODE = '42501', DETAIL = 'the withdrawer is the opener';
  END IF;

  SELECT COALESCE(jsonb_object_agg(s.status, s.n), '{}'::jsonb) INTO v_sessions
    FROM (SELECT status, count(*) AS n FROM public.central_needs_import_sessions WHERE plan_revision_id = p_plan_revision_id GROUP BY status) s;
  v_counts := jsonb_build_object(
    'sessions', (SELECT count(*) FROM public.central_needs_import_sessions WHERE plan_revision_id = p_plan_revision_id),
    'source_records', (SELECT count(*) FROM public.central_needs_source_records r JOIN public.central_needs_import_sessions s ON s.id = r.import_session_id WHERE s.plan_revision_id = p_plan_revision_id),
    'mappings', (SELECT count(*) FROM public.central_needs_record_mappings m JOIN public.central_needs_import_sessions s ON s.id = m.import_session_id WHERE s.plan_revision_id = p_plan_revision_id),
    'need_lines', (SELECT count(*) FROM public.central_needs_need_lines WHERE plan_revision_id = p_plan_revision_id),
    'manual_events', (SELECT count(*) FROM public.central_needs_manual_need_events WHERE plan_revision_id = p_plan_revision_id));
  v_digest := phoenix_private.central_needs_submission_state_digest_v1(p_plan_revision_id);

  INSERT INTO public.central_needs_revision_withdrawals (organization_id, plan_id, plan_revision_id, actor_id, actor_role, reason, reference, state_digest, session_counts, row_counts)
  VALUES (v_org, v_rev.plan_id, p_plan_revision_id, v_actor, v_role, v_reason, v_ref, v_digest, v_sessions, v_counts)
  RETURNING id INTO v_id;

  UPDATE public.central_needs_plan_revisions SET status = 'withdrawn' WHERE id = p_plan_revision_id AND status = 'draft';

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_org, v_actor, v_role, 'central_needs.plan_revision.withdraw', 'central_needs_plan_revision', p_plan_revision_id,
          format('revision %s withdrawn', v_rev.revision_number),
          jsonb_build_object('withdrawal_id', v_id, 'source_mode', v_rev.source_mode, 'state_digest', v_digest, 'reason', v_reason, 'reference', v_ref));

  RETURN jsonb_build_object('ok', true, 'withdrawal_id', v_id, 'plan_revision_id', p_plan_revision_id, 'status', 'withdrawn', 'state_digest', v_digest);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_withdraw_draft_revision(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. acknowledge_manual_coverage (FM-8, C18)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.phoenix_central_needs_acknowledge_manual_coverage(
  p_plan_revision_id uuid, p_expected_omitted_scope_digest text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_role   text;
  v_org    uuid;
  v_year   integer;
  v_rev    public.central_needs_plan_revisions%ROWTYPE;
  v_pred   uuid;
  v_digest text;
  v_count  integer;
  v_reason text := public._phoenix_central_needs_human_text_v1(p_reason);
  v_id     uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'manual_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  IF p_plan_revision_id IS NULL OR p_expected_omitted_scope_digest IS NULL OR p_expected_omitted_scope_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'manual_coverage_arguments_invalid' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 2000 THEN RAISE EXCEPTION 'manual_reason_required' USING ERRCODE = '23514'; END IF;
  SELECT r1.organization_id, p.plan_year INTO v_org, v_year
    FROM public.central_needs_plan_revisions r1 JOIN public.central_needs_plans p ON p.id = r1.plan_id WHERE r1.id = p_plan_revision_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002'; END IF;
  v_role := public._phoenix_central_needs_guard_v1(v_org, 'central_needs.edit');

  PERFORM public._phoenix_central_needs_lock_plan_family_v1(v_org, v_year);
  v_rev := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);
  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_rev.status);
  IF v_rev.source_mode <> 'manual' THEN
    RAISE EXCEPTION 'manual_revision_required' USING ERRCODE = '23514', DETAIL = format('revision=%s', v_rev.id);
  END IF;
  v_pred := phoenix_private.central_needs_effective_predecessor_v1(p_plan_revision_id);
  IF v_pred IS NULL THEN
    RAISE EXCEPTION 'manual_coverage_nothing_to_acknowledge' USING ERRCODE = '23514', DETAIL = 'no effective predecessor';
  END IF;
  SELECT c.omitted_scope_digest, c.omitted_scope_count INTO v_digest, v_count FROM phoenix_private.central_needs_coverage_digest_v1(p_plan_revision_id, v_pred) c;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'manual_coverage_nothing_to_acknowledge' USING ERRCODE = '23514', DETAIL = 'no omitted scope';
  END IF;
  IF v_digest <> p_expected_omitted_scope_digest THEN
    RAISE EXCEPTION 'manual_coverage_stale' USING ERRCODE = '23514', DETAIL = format('omitted=%s', v_count);
  END IF;
  SELECT id INTO v_id FROM public.central_needs_manual_coverage_acknowledgements
   WHERE plan_revision_id = p_plan_revision_id AND omitted_scope_digest = v_digest;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'acknowledgement_id', v_id, 'omitted_scope_count', v_count);
  END IF;
  INSERT INTO public.central_needs_manual_coverage_acknowledgements (organization_id, plan_id, plan_revision_id, predecessor_revision_id,
    omitted_scope_digest, omitted_scope_count, reason, actor_id, actor_role)
  VALUES (v_org, v_rev.plan_id, p_plan_revision_id, v_pred, v_digest, v_count, v_reason, v_actor, v_role) RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_org, v_actor, v_role, 'central_needs.manual_coverage.acknowledge', 'central_needs_plan_revision', p_plan_revision_id, 'coverage',
          jsonb_build_object('acknowledgement_id', v_id, 'predecessor_revision_id', v_pred, 'omitted_scope_count', v_count, 'omitted_scope_digest', v_digest));
  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'acknowledgement_id', v_id, 'omitted_scope_count', v_count, 'omitted_scope_digest', v_digest);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_acknowledge_manual_coverage(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Readers (INVOKER) — granted to authenticated now; they confer nothing beyond RLS / constants
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.phoenix_central_needs_list_manual_need_events(p_plan_revision_id uuid)
RETURNS SETOF public.central_needs_manual_need_events
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT e.* FROM public.central_needs_manual_need_events e
   WHERE e.plan_revision_id = p_plan_revision_id
   ORDER BY e.beneficiary_organization_id, e.central_item_id, e.target_warehouse_id NULLS FIRST, e.event_seq
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_list_manual_need_events(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_list_manual_need_events(uuid) TO authenticated;

-- caller-scoped SoD exclusion: false for anyone without view over the revision's organization (no oracle)
CREATE FUNCTION phoenix_cn_policy.approve_excluded_for_caller(p_plan_revision_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE((
    SELECT phoenix_private.central_needs_sod_excluded_v1(r.id, auth.uid())
      FROM public.central_needs_plan_revisions r
     WHERE r.id = p_plan_revision_id
       AND phoenix_cn_policy.actor_scope_org('central_needs.view') = r.organization_id
       AND (r.source_mode = 'manual' OR phoenix_cn_policy.excel_sod_enabled())), false)
$$;
REVOKE ALL ON FUNCTION phoenix_cn_policy.approve_excluded_for_caller(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION phoenix_cn_policy.approve_excluded_for_caller(uuid) TO authenticated;

-- my_capabilities: R1-a body = constants for manual_set (false) and excel_import_open (true); R1-b replaces the body
CREATE FUNCTION public.phoenix_central_needs_my_capabilities(p_organization_id uuid, p_plan_revision_id uuid DEFAULT NULL)
RETURNS TABLE(view boolean, edit boolean, approve boolean, manual_set boolean, excel_import_open boolean, approve_excluded_for_revision boolean)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(phoenix_cn_policy.actor_scope_org('central_needs.view') = p_organization_id, false),
         COALESCE(phoenix_cn_policy.actor_scope_org('central_needs.edit') = p_organization_id, false),
         COALESCE(phoenix_cn_policy.actor_scope_org('central_needs.approve') = p_organization_id, false),
         false,
         true,
         CASE WHEN p_plan_revision_id IS NULL THEN false ELSE phoenix_cn_policy.approve_excluded_for_caller(p_plan_revision_id) END
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_my_capabilities(uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_my_capabilities(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Seal ACL manifest restated with every new routine
-- ---------------------------------------------------------------------------
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
           ('central_needs_revision_withdrawals'), ('central_needs_manual_coverage_acknowledgements'), ('central_needs_cutover_inventory')
  ),
  cn AS (
    SELECT c.oid, c.relowner, n.nspname, c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE (n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central\_needs\_%')
        OR (n.nspname = 'phoenix_private' AND c.relname = 'central_needs_lifecycle_attestations')
  ),
  acl_manifest(sig) AS (
    VALUES ('phoenix_cn_policy.actor_scope_org(text)'),
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
           ('public.phoenix_central_needs_acknowledge_manual_coverage(uuid,text,text)')
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
$$;

-- ---------------------------------------------------------------------------
-- VERIFY: writer census (15 -> 23), explicit ACLs, no EXECUTE for API roles on writers
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_census text[];
BEGIN
  SELECT array_agg(p.proname::text ORDER BY p.proname::text COLLATE "C") INTO v_census
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema')
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
         ~* '(insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+(only\s+)?(table\s+)?("?public"?\.|"?phoenix_private"?\.)?"?central_needs_[a-z_]+';
  IF v_census IS DISTINCT FROM ARRAY['phoenix_central_needs_abandon_import_session', 'phoenix_central_needs_acknowledge_manual_coverage',
      'phoenix_central_needs_add_manual_need_line', 'phoenix_central_needs_apply_authoritative_replay', 'phoenix_central_needs_approve_revision',
      'phoenix_central_needs_carry_forward_manual_lines', 'phoenix_central_needs_correct_manual_need_line', 'phoenix_central_needs_delete_need_line',
      'phoenix_central_needs_open_correction_revision', 'phoenix_central_needs_open_manual_correction_revision',
      'phoenix_central_needs_open_manual_plan_revision', 'phoenix_central_needs_open_plan_revision',
      'phoenix_central_needs_record_field_override', 'phoenix_central_needs_register_import_batch', 'phoenix_central_needs_reject_revision',
      'phoenix_central_needs_set_beneficiary_columns', 'phoenix_central_needs_set_beneficiary_regions', 'phoenix_central_needs_set_need_line',
      'phoenix_central_needs_set_record_disposition', 'phoenix_central_needs_start_import_entry_session', 'phoenix_central_needs_submit_revision',
      'phoenix_central_needs_void_manual_need_line', 'phoenix_central_needs_withdraw_draft_revision'] THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a04): the writer census is not exactly the 23 expected routines: %', v_census;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.oid IN (
                'public.phoenix_central_needs_open_manual_plan_revision(uuid,integer)'::regprocedure,
                'public.phoenix_central_needs_open_manual_correction_revision(uuid,integer,uuid,text)'::regprocedure,
                'public.phoenix_central_needs_carry_forward_manual_lines(uuid,uuid)'::regprocedure,
                'public.phoenix_central_needs_add_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)'::regprocedure,
                'public.phoenix_central_needs_correct_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)'::regprocedure,
                'public.phoenix_central_needs_void_manual_need_line(uuid,uuid,uuid,uuid,text,text,uuid,text)'::regprocedure,
                'public.phoenix_central_needs_withdraw_draft_revision(uuid,uuid,text,text)'::regprocedure,
                'public.phoenix_central_needs_acknowledge_manual_coverage(uuid,text,text)'::regprocedure)
                AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                     OR has_function_privilege('service_role', p.oid, 'EXECUTE')
                     OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a WHERE a.grantee = 0))) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a04): a manual writer is executable by an API role (must be owner only in R1-a)';
  END IF;
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a04): capability seal reports breaches: %',
      (SELECT string_agg(b, '; ') FROM phoenix_private.central_needs_capability_breaches_v1() AS b);
  END IF;
END
$verify$;

COMMIT;
