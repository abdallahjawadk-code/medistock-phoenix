-- LOCAL CANDIDATE ONLY. No Production apply is authorized by this file.
-- Forward migration: historical 001..231 are immutable.
BEGIN;

-- Bind every replaced authority routine to the exact predecessor body. A drift
-- refuses the whole transaction; no live function is silently overwritten.
DO $authority_pre$
DECLARE r record; actual text; matches integer;
BEGIN
 FOR r IN SELECT * FROM (VALUES
      ('public.phoenix_central_needs_open_plan_revision','09c71b200c071f90f26a6fbe0c44cdde'),
      ('public.phoenix_central_needs_approve_revision','d9dc08f1931ad820aecaf2940820965e'),
      ('public.phoenix_central_needs_reject_revision','788e8fe6a1bac05c0a880394d7cda9fc'),
      ('public._phoenix_central_needs_lock_plan_family_v1','388a4684322c0353a3a4e7007fdb4da0'),
      ('public.phoenix_central_needs_open_correction_revision','60c575e0b42fa879031c65c92900896b'),
      ('public.phoenix_central_needs_revision_lifecycle','7db9074dffbe7230a669922b594708c7'),
      ('public.phoenix_central_needs_open_manual_plan_revision','c350ffea9003dcfcb712642c08adb02b'),
      ('public.phoenix_central_needs_open_manual_correction_revision','9a5432d109dec8bbfeb81df06c4cdf6c'),
      ('public.phoenix_central_needs_carry_forward_manual_lines','bf3f799cf2e5849a497cd40d6242e17b'),
      ('public.phoenix_central_needs_add_manual_need_line','612586999135d85b0475f371db2937c8'),
      ('public.phoenix_central_needs_correct_manual_need_line','676cbeb1ebcf42a55ec08f5d40fb77d2'),
      ('public.phoenix_central_needs_void_manual_need_line','9adacbbf9be01aa1b012c29307614b7a'),
      ('public.phoenix_central_needs_withdraw_draft_revision','ce3b1e637f3b3bc41fd1281868ce520c'),
      ('public.phoenix_central_needs_acknowledge_manual_coverage','261625c9f1e49cda9b36153c2d6849f1'),
      ('public.phoenix_central_needs_feature_contract','ac31d9daaecf63ce7bd896c76a52ce9d'),
      ('phoenix_private.central_needs_capability_breaches_v1','a8c6414b17231d8133a0c08a541aa997')
 ) expected(name,body_md5) LOOP
   SELECT count(*), min(md5(p.prosrc)) INTO matches,actual
   FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname=split_part(r.name,'.',1) AND p.proname=split_part(r.name,'.',2);
   IF matches<>1 OR actual IS DISTINCT FROM r.body_md5 THEN
     RAISE EXCEPTION 'M234_authority_precondition_failed: %',r.name;
   END IF;
 END LOOP;
END $authority_pre$;
-- One annual workspace; reuse canonical plan/revision authority per dossier.
DO $pre$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.central_needs_plans'::regclass
                 AND conname='central_needs_plans_organization_id_plan_year_key')
    OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
               AND table_name='central_needs_plans' AND column_name='dossier_key') THEN
    RAISE EXCEPTION 'M234_precondition_failed';
 END IF;
END $pre$;
ALTER TABLE public.central_needs_plans ADD COLUMN dossier_key text NOT NULL DEFAULT '';
ALTER TABLE public.central_needs_plans ADD COLUMN dossier_name text NOT NULL DEFAULT 'عام / General';
ALTER TABLE public.central_needs_plans ADD CONSTRAINT central_needs_dossier_key_chk
 CHECK (dossier_key = '' OR dossier_key ~ '^[A-Za-z0-9_-]{1,64}$');
ALTER TABLE public.central_needs_plans ADD CONSTRAINT central_needs_dossier_name_chk
 CHECK (char_length(btrim(dossier_name)) BETWEEN 1 AND 120);
ALTER TABLE public.central_needs_plans DROP CONSTRAINT central_needs_plans_organization_id_plan_year_key;
ALTER TABLE public.central_needs_plans ADD CONSTRAINT central_needs_plan_dossier_key UNIQUE (organization_id, plan_year, dossier_key);
CREATE UNIQUE INDEX central_needs_dossier_name_key ON public.central_needs_plans (organization_id, plan_year, lower(btrim(dossier_name)));

CREATE POLICY r1_legacy_general_plan_read ON public.central_needs_plans AS RESTRICTIVE FOR SELECT TO authenticated
 USING (dossier_key='');
CREATE POLICY r1_legacy_general_revision_read ON public.central_needs_plan_revisions AS RESTRICTIVE FOR SELECT TO authenticated
 USING (EXISTS(SELECT 1 FROM public.central_needs_plans p WHERE p.id=plan_id AND p.dossier_key=''));

CREATE FUNCTION public.phoenix_central_needs_dossier_revisions(p_plan_id uuid)
RETURNS SETOF public.central_needs_plan_revisions LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$
DECLARE org uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE='28000'; END IF;
 SELECT organization_id INTO org FROM public.central_needs_plans WHERE id=p_plan_id
   AND organization_id=phoenix_cn_policy.actor_scope_org('central_needs.view');
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE='42501'; END IF;
 PERFORM public._phoenix_central_needs_guard_v1(org,'central_needs.view');
 RETURN QUERY SELECT * FROM public.central_needs_plan_revisions WHERE plan_id=p_plan_id ORDER BY revision_number DESC;
END $$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_dossier_revisions(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_dossier_revisions(uuid) TO authenticated;

CREATE FUNCTION phoenix_private.central_needs_lock_plan_id_v1(p_plan uuid)
RETURNS public.central_needs_plans LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE p public.central_needs_plans%ROWTYPE;
BEGIN
 SELECT * INTO p FROM public.central_needs_plans WHERE id=p_plan;
 IF NOT FOUND THEN RAISE EXCEPTION 'central_needs_plan_not_found' USING ERRCODE='P0002'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p.organization_id::text || ':' || p.plan_year::text, 210001));
 SELECT * INTO p FROM public.central_needs_plans WHERE id=p_plan FOR UPDATE;
 PERFORM 1 FROM public.central_needs_plan_revisions WHERE plan_id=p_plan ORDER BY revision_number FOR UPDATE;
 RETURN p;
END $$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_lock_plan_id_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_open_plan_revision(
  p_organization_id    uuid,
  p_plan_year          integer,
  p_open_next_revision boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_plan       public.central_needs_plans%ROWTYPE;
  v_current    public.central_needs_plan_revisions%ROWTYPE;
  v_new        public.central_needs_plan_revisions%ROWTYPE;
BEGIN
  v_actor_role := public._phoenix_central_needs_guard_v1(p_organization_id, 'central_needs.edit');

  IF p_open_next_revision IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'central_needs_governed_correction_required' USING ERRCODE = '23514',
      DETAIL = format('organization=%s plan_year=%s p_open_next_revision=%s',
                      p_organization_id, p_plan_year, COALESCE(p_open_next_revision::text, 'null')),
      HINT = 'Open a correction with phoenix_central_needs_open_correction_revision(organization, plan year, expected latest revision, reason).';
  END IF;

  IF p_plan_year IS NULL THEN
    RAISE EXCEPTION 'plan_year_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_plan_year::text, 210001));

  SELECT * INTO v_plan
    FROM public.central_needs_plans
   WHERE organization_id = p_organization_id AND plan_year = p_plan_year AND dossier_key = ''
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.central_needs_plans (organization_id, plan_year, created_by)
    VALUES (p_organization_id, p_plan_year, v_actor)
    RETURNING * INTO v_plan;
  END IF;

  SELECT * INTO v_current
    FROM public.central_needs_plan_revisions
   WHERE plan_id = v_plan.id
   ORDER BY revision_number DESC
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    IF v_current.status = 'draft' THEN
      RETURN jsonb_build_object(
        'ok', true, 'idempotent_replay', true,
        'plan_id', v_plan.id, 'plan_revision_id', v_current.id,
        'revision_number', v_current.revision_number, 'status', v_current.status
      );
    END IF;

    IF v_current.status NOT IN ('approved', 'rejected') THEN
      RAISE EXCEPTION 'plan_revision_still_in_review' USING ERRCODE = '23514',
        DETAIL = format('revision=%s status=%s', v_current.id, v_current.status),
        HINT = 'Approve or reject the current revision before opening the next one.';
    END IF;

    RAISE EXCEPTION 'plan_revision_already_closed' USING ERRCODE = '23514',
      DETAIL = format('revision=%s status=%s', v_current.id, v_current.status),
      HINT = 'Open a correction with phoenix_central_needs_open_correction_revision; it keeps the approved revision effective until the correction is approved.';
  END IF;

  INSERT INTO public.central_needs_plan_revisions (
    plan_id, organization_id, revision_number, status, created_by
  ) VALUES (
    v_plan.id, p_organization_id, 1, 'draft', v_actor
  )
  RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    p_organization_id, v_actor, v_actor_role,
    'central_needs.plan_revision.open', 'central_needs_plan_revision', v_new.id,
    format('plan %s revision %s', p_plan_year, v_new.revision_number),
    jsonb_build_object(
      'plan_id', v_plan.id,
      'plan_year', p_plan_year,
      'revision_number', v_new.revision_number,
      'previous_revision_id', NULL,
      'previous_revision_closed_as', NULL
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'plan_id', v_plan.id, 'plan_revision_id', v_new.id,
    'revision_number', v_new.revision_number, 'status', v_new.status,
    'previous_revision_id', NULL,
    'previous_revision_closed_as', NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_approve_revision(
  p_plan_revision_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_revision    public.central_needs_plan_revisions%ROWTYPE;
  v_plan        public.central_needs_plans%ROWTYPE;
  v_latest      public.central_needs_plan_revisions%ROWTYPE;
  v_predecessor public.central_needs_plan_revisions%ROWTYPE;
  v_approved    integer;
  v_rows        integer;
  -- 217 (C5 §3/§4)
  v_line        record;
  v_ben         record;
  v_wh          record;
  v_reason      text;
  v_blocker     text;
  -- 218 (C6-F1)
  v_submitted_digest text;
  v_breach           text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_revision_id IS NULL THEN
    RAISE EXCEPTION 'plan_revision_id_required' USING ERRCODE = '23514';
  END IF;

  -- Unlocked resolution: only the organization is needed to authorize, and the
  -- family lock below is always taken in the same order by every writer.
  SELECT * INTO v_revision
    FROM public.central_needs_plan_revisions
   WHERE id = p_plan_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.approve');

  -- 217 (C5 §3) — the plan owner organization FOR SHARE, and live, BEFORE the
  -- family lock: the one order every approver takes.
  PERFORM 1 FROM public.organizations WHERE id = v_revision.organization_id FOR SHARE;
  PERFORM public._phoenix_central_needs_assert_org_live_v1(v_revision.organization_id);

  SELECT * INTO v_plan FROM public.central_needs_plans WHERE id = v_revision.plan_id;
  v_plan := phoenix_private.central_needs_lock_plan_id_v1(v_plan.id);

  -- Re-read under the lock: this is the state the decision is made on.
  SELECT * INTO v_revision
    FROM public.central_needs_plan_revisions
   WHERE id = p_plan_revision_id;

  IF v_revision.status = 'approved' THEN
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'plan_revision_id', p_plan_revision_id, 'status', 'approved'
    );
  END IF;

  IF v_revision.status <> 'submitted' THEN
    RAISE EXCEPTION 'plan_revision_not_submitted' USING ERRCODE = '23514',
      DETAIL = format('revision=%s status=%s', p_plan_revision_id, v_revision.status),
      HINT = 'Only a submitted revision can be approved.';
  END IF;

  SELECT * INTO v_latest
    FROM public.central_needs_plan_revisions
   WHERE plan_id = v_plan.id
   ORDER BY revision_number DESC
   LIMIT 1;
  IF v_latest.id <> v_revision.id THEN
    RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
      DETAIL = format('submitted revision=%s (revision %s) is not the newest revision of plan=%s (newest %s)',
                      v_revision.id, v_revision.revision_number, v_plan.id, v_latest.revision_number);
  END IF;

  SELECT count(*) INTO v_approved
    FROM public.central_needs_plan_revisions
   WHERE plan_id = v_plan.id AND status = 'approved';
  IF v_approved > 1 THEN
    RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
      DETAIL = format('plan=%s holds %s approved revisions', v_plan.id, v_approved);
  END IF;

  -- 218 (C6-F1) — canonical submission provenance: the PRIVATE SUBMIT
  -- attestation of this revision and owner whose row version (xmin) is the
  -- revision row's CURRENT xmin and whose created_at is the updated_at the
  -- canonical transition stamped. A revision made SUBMITTED any other way,
  -- re-created, moved back from rejected, or touched after its canonical
  -- submit, has none; nothing is repaired.
  SELECT a.state_digest INTO v_submitted_digest
    FROM phoenix_private.central_needs_lifecycle_attestations a
    JOIN public.central_needs_plan_revisions r ON r.id = a.plan_revision_id
   WHERE a.plan_revision_id = v_revision.id
     AND a.organization_id  = v_revision.organization_id
     AND a.phase            = 'submit'
     AND a.contract         = 'c6-f1-final-v1'
     AND a.xmin             = r.xmin
     AND a.created_at       = v_revision.updated_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'central_needs_submission_provenance_missing' USING ERRCODE = '23514',
      DETAIL = format('revision=%s', p_plan_revision_id),
      HINT = 'A revision is approvable only in the submitted state phoenix_central_needs_submit_revision produced. Reject it and correct it through a new draft.';
  END IF;

  -- 218 (C6-F1 FINAL) — the seal predicate. The submitted state is the
  -- attested state because no non-root path can have changed it: every
  -- canonical mutator is DRAFT-only and no non-root role holds a capability
  -- that writes it or injects code into an owner-run transaction. That is
  -- re-checked here instead of re-hashing the submitted corpus; the digest is
  -- never recomputed or refreshed at approve.
  SELECT x.breach INTO v_breach
    FROM phoenix_private.central_needs_capability_breaches_v1() AS x(breach)
   ORDER BY x.breach
   LIMIT 1;
  IF v_breach IS NOT NULL THEN
    RAISE EXCEPTION 'central_needs_capability_seal_breached' USING ERRCODE = '55000',
      DETAIL = v_breach,
      HINT = 'A non-root role holds a capability M218 revokes. Converge the grants (a root-of-trust action) before approving.';
  END IF;

  -- 217 (C5 §3) — E: identify the single effective predecessor ONLY. Nothing is
  -- mutated before A2 PASS.
  IF v_approved = 1 THEN
    SELECT * INTO v_predecessor
      FROM public.central_needs_plan_revisions
     WHERE plan_id = v_plan.id AND status = 'approved';
  END IF;

  -- 217 (C5 §3) — only after A-E: the distinct beneficiary organizations, then
  -- the distinct non-null target warehouses, each FOR SHARE ORDER BY id, so the
  -- eligibility judged below cannot change until this transaction ends.
  PERFORM 1
    FROM public.organizations o
   WHERE o.id IN (SELECT n.beneficiary_organization_id
                    FROM public.central_needs_need_lines n
                   WHERE n.plan_revision_id = p_plan_revision_id)
   ORDER BY o.id
   FOR SHARE;
  PERFORM 1
    FROM public.warehouses w
   WHERE w.id IN (SELECT n.target_warehouse_id
                    FROM public.central_needs_need_lines n
                   WHERE n.plan_revision_id = p_plan_revision_id
                     AND n.target_warehouse_id IS NOT NULL)
   ORDER BY w.id
   FOR SHARE;

  -- 217 (C5 §4) — A2: approval-time eligibility. Lines by id ASC; for each,
  -- the beneficiary before the warehouse; inactive wins over archived and
  -- not_owned over not_active. The first failure refuses the approval with
  -- the readiness blocker it corresponds to; nothing has been written yet.
  FOR v_line IN
    SELECT n.id, n.beneficiary_organization_id, n.target_warehouse_id
      FROM public.central_needs_need_lines n
     WHERE n.plan_revision_id = p_plan_revision_id
     ORDER BY n.id
  LOOP
    v_reason := NULL;
    SELECT o.organization_kind, o.status, o.archived_at INTO v_ben
      FROM public.organizations o
     WHERE o.id = v_line.beneficiary_organization_id;
    IF NOT FOUND THEN
      v_reason := 'not_found';
    ELSIF v_ben.organization_kind IS DISTINCT FROM 'care_institution' THEN
      v_reason := 'not_care_institution';
    ELSIF v_ben.status IS DISTINCT FROM 'active' THEN
      v_reason := 'inactive';
    ELSIF v_ben.archived_at IS NOT NULL THEN
      v_reason := 'archived';
    END IF;
    IF v_reason IS NOT NULL THEN
      RAISE EXCEPTION 'central_needs_approval_eligibility_changed' USING ERRCODE = '23514',
        DETAIL = format('blocker=need_line_beneficiary_ineligible need_line=%s beneficiary=%s reason=%s',
                        v_line.id, v_line.beneficiary_organization_id, v_reason),
        HINT = 'A beneficiary became ineligible after submission. Reject the revision and correct it through a new draft.';
    END IF;

    IF v_line.target_warehouse_id IS NOT NULL THEN
      SELECT w.organization_id, w.status INTO v_wh
        FROM public.warehouses w
       WHERE w.id = v_line.target_warehouse_id;
      IF NOT FOUND THEN
        v_reason := 'not_found';
        v_blocker := 'need_line_warehouse_org_mismatch';
      ELSIF v_wh.organization_id IS DISTINCT FROM v_line.beneficiary_organization_id THEN
        v_reason := 'not_owned';
        v_blocker := 'need_line_warehouse_org_mismatch';
      ELSIF v_wh.status IS DISTINCT FROM 'active' THEN
        v_reason := 'not_active';
        v_blocker := 'need_line_target_warehouse_not_active';
      END IF;
      IF v_reason IS NOT NULL THEN
        RAISE EXCEPTION 'central_needs_approval_eligibility_changed' USING ERRCODE = '23514',
          DETAIL = format('blocker=%s need_line=%s beneficiary=%s warehouse=%s reason=%s',
                          v_blocker, v_line.id, v_line.beneficiary_organization_id,
                          v_line.target_warehouse_id, v_reason),
          HINT = 'A target warehouse became ineligible after submission. Reject the revision and correct it through a new draft.';
      END IF;
    END IF;
  END LOOP;

  -- 218 (C6-F1) — the PRIVATE APPROVE attestation, written only after
  -- provenance, the seal predicate and A2 PASS, in THIS transaction: the only
  -- authority the approval fence accepts for the APPROVED transition below.
  -- It carries the sealed digest attested at submit.
  INSERT INTO phoenix_private.central_needs_lifecycle_attestations (
    plan_revision_id, organization_id, phase, contract, actor_id, txid, state_digest
  ) VALUES (
    p_plan_revision_id, v_revision.organization_id, 'approve', 'c6-f1-final-v1', v_actor, txid_current(), v_submitted_digest
  );

  -- 217 (C5 §16) — the approval-gate audit event, written only after lifecycle
  -- A-E and A2 PASS, in THIS transaction. 218: forensic history only — the
  -- fence admits the APPROVED transition below against the private APPROVE
  -- attestation above, never against this row.
  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.plan_revision.approval_gate', 'central_needs_plan_revision', p_plan_revision_id,
    format('revision %s', v_revision.revision_number),
    jsonb_build_object(
      'contract', 'c5-v1',
      'txid', txid_current()::text,
      'plan_id', v_plan.id,
      'revision_number', v_revision.revision_number
    )
  );

  IF v_predecessor.id IS NOT NULL THEN
    -- APPROVED -> SUPERSEDED keeps approved_by/approved_at (M209's pair CHECK
    -- allows exactly that), so the historical approval stays traceable.
    UPDATE public.central_needs_plan_revisions
       SET status = 'superseded'
     WHERE id = v_predecessor.id AND status = 'approved';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
        DETAIL = format('predecessor=%s could not be superseded', v_predecessor.id);
    END IF;
  END IF;

  UPDATE public.central_needs_plan_revisions
     SET status = 'approved', approved_by = v_actor, approved_at = now()
   WHERE id = p_plan_revision_id AND status = 'submitted';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
      DETAIL = format('revision=%s could not be approved', p_plan_revision_id);
  END IF;

  -- Postcondition: exactly one effective revision. Anything else rolls the
  -- whole switch back.
  SELECT count(*) INTO v_approved
    FROM public.central_needs_plan_revisions
   WHERE plan_id = v_plan.id AND status = 'approved';
  IF v_approved <> 1 THEN
    RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
      DETAIL = format('plan=%s would hold %s approved revisions', v_plan.id, v_approved);
  END IF;

  IF v_predecessor.id IS NOT NULL THEN
    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_revision.organization_id, v_actor, v_actor_role,
      'central_needs.plan_revision.supersede', 'central_needs_plan_revision', v_predecessor.id,
      format('plan %s revision %s', v_plan.plan_year, v_predecessor.revision_number),
      jsonb_build_object(
        'plan_id', v_plan.id,
        'plan_year', v_plan.plan_year,
        'revision_number', v_predecessor.revision_number,
        'from_status', 'approved', 'to_status', 'superseded',
        'superseded_by_revision_id', p_plan_revision_id,
        'superseded_by_revision_number', v_revision.revision_number
      )
    );
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.plan_revision.approve', 'central_needs_plan_revision', p_plan_revision_id,
    format('revision %s', v_revision.revision_number),
    jsonb_build_object(
      'plan_id', v_plan.id,
      'plan_year', v_plan.plan_year,
      'revision_number', v_revision.revision_number,
      'from_status', 'submitted', 'to_status', 'approved',
      'predecessor_revision_id', v_predecessor.id,
      'predecessor_revision_number', v_predecessor.revision_number,
      'predecessor_from_status', CASE WHEN v_predecessor.id IS NULL THEN NULL ELSE 'approved' END,
      'predecessor_to_status', CASE WHEN v_predecessor.id IS NULL THEN NULL ELSE 'superseded' END,
      -- 217 (C5 §2.5/§16): correlates this approval with its same-transaction gate.
      'approval_gate_txid', txid_current()::text
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'plan_revision_id', p_plan_revision_id, 'status', 'approved',
    'plan_id', v_plan.id, 'revision_number', v_revision.revision_number,
    'superseded_revision_id', v_predecessor.id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_reject_revision(
  p_plan_revision_id uuid,
  p_reason           text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_revision   public.central_needs_plan_revisions%ROWTYPE;
  v_plan       public.central_needs_plans%ROWTYPE;
  v_effective  public.central_needs_plan_revisions%ROWTYPE;
  v_reason     text := public._phoenix_central_needs_human_text_v1(p_reason);
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'rejection_reason_required' USING ERRCODE = '23514';
  END IF;
  IF p_plan_revision_id IS NULL THEN
    RAISE EXCEPTION 'plan_revision_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_revision
    FROM public.central_needs_plan_revisions
   WHERE id = p_plan_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_actor_role := public._phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.approve');

  SELECT * INTO v_plan FROM public.central_needs_plans WHERE id = v_revision.plan_id;
  v_plan := phoenix_private.central_needs_lock_plan_id_v1(v_plan.id);

  SELECT * INTO v_revision
    FROM public.central_needs_plan_revisions
   WHERE id = p_plan_revision_id;

  IF v_revision.status <> 'submitted' THEN
    RAISE EXCEPTION 'plan_revision_not_submitted' USING ERRCODE = '23514',
      DETAIL = format('revision=%s status=%s', p_plan_revision_id, v_revision.status),
      HINT = 'Only a submitted revision can be rejected.';
  END IF;

  SELECT * INTO v_effective
    FROM public.central_needs_plan_revisions
   WHERE plan_id = v_plan.id AND status = 'approved'
   ORDER BY revision_number DESC
   LIMIT 1;

  UPDATE public.central_needs_plan_revisions
     SET status = 'rejected'
   WHERE id = p_plan_revision_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_revision.organization_id, v_actor, v_actor_role,
    'central_needs.plan_revision.reject', 'central_needs_plan_revision', p_plan_revision_id,
    format('revision %s', v_revision.revision_number),
    jsonb_build_object(
      'plan_id', v_revision.plan_id,
      'plan_year', v_plan.plan_year,
      'revision_number', v_revision.revision_number,
      'from_status', 'submitted', 'to_status', 'rejected',
      'reason', v_reason,
      'effective_approved_revision_id', v_effective.id,
      'effective_approved_revision_number', v_effective.revision_number
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'plan_revision_id', p_plan_revision_id, 'status', 'rejected',
    'effective_approved_revision_id', v_effective.id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._phoenix_central_needs_lock_plan_family_v1(
  p_organization_id uuid,
  p_plan_year       integer
)
RETURNS public.central_needs_plans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_plan public.central_needs_plans%ROWTYPE;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_plan_year IS NULL THEN
    RAISE EXCEPTION 'plan_year_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_plan_year::text, 210001));

  SELECT * INTO v_plan
    FROM public.central_needs_plans
   WHERE organization_id = p_organization_id AND plan_year = p_plan_year AND dossier_key = ''
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'central_needs_plan_not_found' USING ERRCODE = 'P0002',
      DETAIL = format('organization=%s plan_year=%s', p_organization_id, p_plan_year);
  END IF;

  PERFORM 1
    FROM public.central_needs_plan_revisions
   WHERE plan_id = v_plan.id
   ORDER BY revision_number
   FOR UPDATE;

  RETURN v_plan;
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_open_correction_revision(
  p_organization_id             uuid,
  p_plan_year                   integer,
  p_expected_latest_revision_id uuid,
  p_reason                      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_reason      text := public._phoenix_central_needs_human_text_v1(p_reason);
  v_plan        public.central_needs_plans%ROWTYPE;
  v_latest      public.central_needs_plan_revisions%ROWTYPE;
  v_expected    public.central_needs_plan_revisions%ROWTYPE;
  v_effective   public.central_needs_plan_revisions%ROWTYPE;
  v_new         public.central_needs_plan_revisions%ROWTYPE;
  v_approved    integer;
BEGIN
  v_actor_role := public._phoenix_central_needs_guard_v1(p_organization_id, 'central_needs.edit');

  -- Input refusals come before any lock or write.
  IF p_plan_year IS NULL THEN
    RAISE EXCEPTION 'plan_year_required' USING ERRCODE = '23514';
  END IF;
  IF p_expected_latest_revision_id IS NULL THEN
    RAISE EXCEPTION 'expected_latest_revision_id_required' USING ERRCODE = '23514',
      HINT = 'Pass the id of the newest revision this correction was opened from.';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'correction_reason_required' USING ERRCODE = '23514',
      HINT = 'A correction needs a human reason; blank or whitespace-only text is refused.';
  END IF;

  v_plan := phoenix_private.central_needs_lock_plan_id_v1(
    (SELECT r.plan_id FROM public.central_needs_plan_revisions r JOIN public.central_needs_plans p ON p.id=r.plan_id
      WHERE r.id=p_expected_latest_revision_id AND p.organization_id=p_organization_id AND p.plan_year=p_plan_year));
  IF v_plan.organization_id IS DISTINCT FROM p_organization_id OR v_plan.plan_year IS DISTINCT FROM p_plan_year THEN
    RAISE EXCEPTION 'central_needs_correction_plan_mismatch' USING ERRCODE = '23514';
  END IF;

  -- The correction year must belong to the selected plan.
  SELECT * INTO v_expected
    FROM public.central_needs_plan_revisions
   WHERE id = p_expected_latest_revision_id;
  IF NOT FOUND OR v_expected.plan_id <> v_plan.id THEN
    RAISE EXCEPTION 'central_needs_correction_plan_mismatch' USING ERRCODE = '23514',
      DETAIL = format('expected_revision=%s is not a revision of organization=%s plan_year=%s',
                      p_expected_latest_revision_id, p_organization_id, p_plan_year);
  END IF;

  SELECT * INTO v_latest
    FROM public.central_needs_plan_revisions
   WHERE plan_id = v_plan.id
   ORDER BY revision_number DESC
   LIMIT 1;

  -- STALE FENCE — zero writes on mismatch.
  IF v_latest.id <> p_expected_latest_revision_id THEN
    RAISE EXCEPTION 'central_needs_revision_stale' USING ERRCODE = '23514',
      DETAIL = format('expected_latest=%s (revision %s) actual_latest=%s (revision %s, %s)',
                      p_expected_latest_revision_id, v_expected.revision_number,
                      v_latest.id, v_latest.revision_number, v_latest.status),
      HINT = 'Another revision was opened after the one you selected. Reload the registry and decide again.';
  END IF;

  IF v_latest.status = 'draft' THEN
    RAISE EXCEPTION 'plan_revision_draft_already_open' USING ERRCODE = '23514',
      DETAIL = format('revision=%s', v_latest.id);
  END IF;
  IF v_latest.status = 'submitted' THEN
    RAISE EXCEPTION 'plan_revision_still_in_review' USING ERRCODE = '23514',
      DETAIL = format('revision=%s status=%s', v_latest.id, v_latest.status),
      HINT = 'Approve or reject the current revision before opening a correction.';
  END IF;
  IF v_latest.status NOT IN ('approved', 'rejected') THEN
    -- A superseded revision always has an approved successor, so it can never
    -- be the newest one. Refuse rather than guess.
    RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
      DETAIL = format('newest revision=%s has status=%s', v_latest.id, v_latest.status);
  END IF;

  SELECT count(*) INTO v_approved
    FROM public.central_needs_plan_revisions
   WHERE plan_id = v_plan.id AND status = 'approved';
  IF v_approved > 1 THEN
    RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE = '23514',
      DETAIL = format('plan=%s holds %s approved revisions', v_plan.id, v_approved);
  END IF;
  IF v_approved = 1 THEN
    SELECT * INTO v_effective
      FROM public.central_needs_plan_revisions
     WHERE plan_id = v_plan.id AND status = 'approved';
  END IF;

  INSERT INTO public.central_needs_plan_revisions (
    plan_id, organization_id, revision_number, status, created_by
  ) VALUES (
    v_plan.id, p_organization_id, v_latest.revision_number + 1, 'draft', v_actor
  )
  RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    p_organization_id, v_actor, v_actor_role,
    'central_needs.plan_revision.open_correction', 'central_needs_plan_revision', v_new.id,
    format('plan %s correction revision %s', p_plan_year, v_new.revision_number),
    jsonb_build_object(
      'organization_id', p_organization_id,
      'plan_id', v_plan.id,
      'plan_year', p_plan_year,
      'revision_number', v_new.revision_number,
      'new_revision_id', v_new.id,
      'opened_after_revision_id', v_latest.id,
      'opened_after_revision_number', v_latest.revision_number,
      'opened_after_status', v_latest.status,
      'effective_approved_revision_id', v_effective.id,
      'effective_approved_revision_number', v_effective.revision_number,
      'correction_reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'plan_id', v_plan.id,
    'plan_year', p_plan_year,
    'plan_revision_id', v_new.id,
    'revision_number', v_new.revision_number,
    'status', v_new.status,
    'opened_after_revision_id', v_latest.id,
    'opened_after_status', v_latest.status,
    'effective_approved_revision_id', v_effective.id,
    'correction_reason', v_reason
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_revision_lifecycle(
  p_organization_id uuid,
  p_plan_year       integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_plan      public.central_needs_plans%ROWTYPE;
  v_revisions jsonb;
  v_events    jsonb;
  v_effective uuid;
BEGIN
  PERFORM public._phoenix_central_needs_guard_v1(p_organization_id, 'central_needs.view');

  IF p_plan_year IS NULL THEN
    RAISE EXCEPTION 'plan_year_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_plan
    FROM public.central_needs_plans
   WHERE organization_id = p_organization_id AND plan_year = p_plan_year AND dossier_key = '';
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'organization_id', p_organization_id, 'plan_year', p_plan_year,
      'plan_id', NULL, 'effective_revision_id', NULL,
      'revisions', '[]'::jsonb, 'events', '[]'::jsonb
    );
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', r.id,
           'revision_number', r.revision_number,
           'status', r.status,
           'effective', r.status = 'approved',
           'created_at', r.created_at,
           'approved_at', r.approved_at
         ) ORDER BY r.revision_number), '[]'::jsonb)
    INTO v_revisions
    FROM public.central_needs_plan_revisions r
   WHERE r.plan_id = v_plan.id;

  SELECT r.id INTO v_effective
    FROM public.central_needs_plan_revisions r
   WHERE r.plan_id = v_plan.id AND r.status = 'approved'
   ORDER BY r.revision_number DESC
   LIMIT 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'action', a.action,
           'revision_id', a.entity_id,
           'revision_number', (a.payload->>'revision_number')::integer,
           'occurred_at', a.created_at,
           'actor_id', a.actor_id,
           'actor_role', a.actor_role,
           'from_status', a.payload->>'from_status',
           'to_status', a.payload->>'to_status',
           'reason', CASE a.action
                       WHEN 'central_needs.plan_revision.reject'          THEN a.payload->>'reason'
                       WHEN 'central_needs.plan_revision.open_correction' THEN a.payload->>'correction_reason'
                     END,
           'opened_after_revision_id', a.payload->>'opened_after_revision_id',
           'effective_approved_revision_id', a.payload->>'effective_approved_revision_id',
           'predecessor_revision_id', a.payload->>'predecessor_revision_id',
           'superseded_by_revision_id', a.payload->>'superseded_by_revision_id'
         ) ORDER BY a.created_at,
                    CASE a.action
                      WHEN 'central_needs.plan_revision.open'            THEN 1
                      WHEN 'central_needs.plan_revision.open_correction' THEN 1
                      WHEN 'central_needs.plan_revision.submit'          THEN 2
                      WHEN 'central_needs.plan_revision.supersede'       THEN 3
                      WHEN 'central_needs.plan_revision.approve'         THEN 4
                      WHEN 'central_needs.plan_revision.reject'          THEN 4
                    END,
                    a.id), '[]'::jsonb)
    INTO v_events
    FROM public.audit_logs a
   WHERE a.organization_id = p_organization_id
     AND a.entity_type = 'central_needs_plan_revision'
     AND a.entity_id IN (SELECT r.id FROM public.central_needs_plan_revisions r WHERE r.plan_id = v_plan.id)
     AND a.action IN (
       'central_needs.plan_revision.open',
       'central_needs.plan_revision.open_correction',
       'central_needs.plan_revision.submit',
       'central_needs.plan_revision.approve',
       'central_needs.plan_revision.reject',
       'central_needs.plan_revision.supersede'
     );

  RETURN jsonb_build_object(
    'ok', true,
    'organization_id', p_organization_id,
    'plan_id', v_plan.id,
    'plan_year', v_plan.plan_year,
    'effective_revision_id', v_effective,
    'revisions', v_revisions,
    'events', v_events
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_open_manual_plan_revision(p_organization_id uuid, p_plan_year integer)
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
   WHERE organization_id = p_organization_id AND plan_year = p_plan_year AND dossier_key = '' FOR UPDATE;
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

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_open_manual_correction_revision(
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

  v_plan := phoenix_private.central_needs_lock_plan_id_v1(
    (SELECT r.plan_id FROM public.central_needs_plan_revisions r JOIN public.central_needs_plans p ON p.id=r.plan_id
      WHERE r.id=p_expected_latest_revision_id AND p.organization_id=p_organization_id AND p.plan_year=p_plan_year));
  IF v_plan.organization_id IS DISTINCT FROM p_organization_id OR v_plan.plan_year IS DISTINCT FROM p_plan_year THEN
    RAISE EXCEPTION 'central_needs_correction_plan_mismatch' USING ERRCODE = '23514';
  END IF;
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

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_carry_forward_manual_lines(p_plan_revision_id uuid, p_expected_source_revision_id uuid)
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

  PERFORM phoenix_private.central_needs_lock_plan_id_v1(
    (SELECT plan_id FROM public.central_needs_plan_revisions WHERE id = p_plan_revision_id));
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

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_add_manual_need_line(
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

  PERFORM phoenix_private.central_needs_lock_plan_id_v1(
    (SELECT plan_id FROM public.central_needs_plan_revisions WHERE id = p_plan_revision_id));
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

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_correct_manual_need_line(
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

  PERFORM phoenix_private.central_needs_lock_plan_id_v1(
    (SELECT plan_id FROM public.central_needs_plan_revisions WHERE id = p_plan_revision_id));
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

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_void_manual_need_line(
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

  PERFORM phoenix_private.central_needs_lock_plan_id_v1(
    (SELECT plan_id FROM public.central_needs_plan_revisions WHERE id = p_plan_revision_id));
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

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_withdraw_draft_revision(
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

  PERFORM phoenix_private.central_needs_lock_plan_id_v1(
    (SELECT plan_id FROM public.central_needs_plan_revisions WHERE id = p_plan_revision_id));
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

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_acknowledge_manual_coverage(
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

  PERFORM phoenix_private.central_needs_lock_plan_id_v1(
    (SELECT plan_id FROM public.central_needs_plan_revisions WHERE id = p_plan_revision_id));
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

CREATE FUNCTION public.phoenix_central_needs_open_dossier(p_organization_id uuid, p_plan_year integer, p_dossier_key text, p_dossier_name text)
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
  PERFORM public._phoenix_central_needs_guard_v1(p_organization_id, 'central_needs.manual_need.set');
  IF p_dossier_key IS NULL OR p_dossier_key !~ '^[A-Za-z0-9_-]{1,64}$'
     OR p_dossier_name IS NULL OR char_length(btrim(p_dossier_name)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'dossier_identity_required' USING ERRCODE = '23514';
  END IF;
  IF p_plan_year IS NULL THEN
    RAISE EXCEPTION 'plan_year_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_plan_year::text, 210001));
  SELECT * INTO v_plan FROM public.central_needs_plans
   WHERE organization_id = p_organization_id AND plan_year = p_plan_year AND dossier_key = p_dossier_key FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.central_needs_plans (organization_id, plan_year, created_by, dossier_key, dossier_name)
    VALUES (p_organization_id, p_plan_year, v_actor, p_dossier_key, btrim(p_dossier_name)) RETURNING * INTO v_plan;
  END IF;

  IF v_plan.dossier_name IS DISTINCT FROM btrim(p_dossier_name) THEN
    RAISE EXCEPTION 'dossier_key_already_used' USING ERRCODE = '23505';
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
REVOKE ALL ON FUNCTION public.phoenix_central_needs_open_dossier(uuid,integer,text,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_open_dossier(uuid,integer,text,text) TO authenticated;

CREATE FUNCTION public.phoenix_central_needs_list_dossiers(p_organization_id uuid, p_plan_year integer)
RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public._phoenix_central_needs_guard_v1(p_organization_id, 'central_needs.view');
 RETURN QUERY
 SELECT jsonb_build_object('id', p.id, 'key', p.dossier_key, 'name', p.dossier_name,
   'latest_revision_id', l.id, 'latest_status', l.status, 'latest_number', l.revision_number,
   'approved_revision_id', a.id, 'approved_number', a.revision_number)
 FROM public.central_needs_plans p
 LEFT JOIN LATERAL (SELECT r.* FROM public.central_needs_plan_revisions r WHERE r.plan_id=p.id ORDER BY r.revision_number DESC LIMIT 1) l ON true
 LEFT JOIN LATERAL (SELECT r.* FROM public.central_needs_plan_revisions r WHERE r.plan_id=p.id AND r.status='approved' ORDER BY r.revision_number DESC LIMIT 1) a ON true
 WHERE p.organization_id=p_organization_id AND p.plan_year=p_plan_year
 ORDER BY p.dossier_key COLLATE "C", p.id;
END $$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_list_dossiers(uuid,integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_list_dossiers(uuid,integer) TO authenticated;

-- Trigger runs inside the existing approval's year advisory lock. It never
-- approves anything and cannot turn a draft into an effective annual quantity.
CREATE FUNCTION phoenix_private.central_needs_dossier_approval_guard_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE p public.central_needs_plans%ROWTYPE;
BEGIN
 IF NEW.status <> 'approved' OR OLD.status = 'approved' THEN RETURN NEW; END IF;
 SELECT * INTO p FROM public.central_needs_plans WHERE id=NEW.plan_id;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p.organization_id::text || ':' || p.plan_year::text, 210001));
 IF EXISTS (
   SELECT 1 FROM public.central_needs_need_lines n
   JOIN public.central_needs_need_lines other ON other.beneficiary_organization_id=n.beneficiary_organization_id
     AND other.central_item_id=n.central_item_id
   JOIN public.central_needs_plan_revisions r ON r.id=other.plan_revision_id AND r.status='approved'
   JOIN public.central_needs_plans q ON q.id=r.plan_id
   WHERE n.plan_revision_id=NEW.id AND q.organization_id=p.organization_id AND q.plan_year=p.plan_year AND q.id<>p.id
 ) THEN RAISE EXCEPTION 'annual_need_duplicate_dossier_scope' USING ERRCODE='23505'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_dossier_approval_guard_v1() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER central_needs_dossier_approval_guard BEFORE UPDATE ON public.central_needs_plan_revisions
 FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_dossier_approval_guard_v1();

CREATE FUNCTION public.phoenix_central_needs_annual_summary(p_organization_id uuid, p_plan_year integer)
RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM public._phoenix_central_needs_guard_v1(p_organization_id, 'central_needs.view');
 IF EXISTS (SELECT 1 FROM public.central_needs_plan_revisions r JOIN public.central_needs_plans p ON p.id=r.plan_id
   WHERE p.organization_id=p_organization_id AND p.plan_year=p_plan_year AND r.status='approved'
   GROUP BY p.id HAVING count(*)<>1) THEN RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE='23514'; END IF;
 RETURN QUERY SELECT jsonb_build_object('dossier_id', p.id, 'dossier_name', p.dossier_name, 'revision_id', r.id,
   'beneficiary_id', n.beneficiary_organization_id, 'item_id', n.central_item_id,
   'name', i.name, 'name_ar', i.name_ar, 'national_code', i.national_code,
   'quantity_text', n.approved_quantity::text, 'unit', n.approved_unit, 'warehouse_id', n.target_warehouse_id)
 FROM public.central_needs_plans p JOIN public.central_needs_plan_revisions r ON r.plan_id=p.id AND r.status='approved'
 JOIN public.central_needs_need_lines n ON n.plan_revision_id=r.id JOIN public.central_items i ON i.id=n.central_item_id
 WHERE p.organization_id=p_organization_id AND p.plan_year=p_plan_year
 ORDER BY p.dossier_key, n.beneficiary_organization_id, n.central_item_id, n.id;
END $$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_annual_summary(uuid,integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_annual_summary(uuid,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_feature_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT jsonb_build_object('national_code', true, 'same_actor_manual', true, 'dossiers', true, 'workbook_intake', false)
$$;
CREATE FUNCTION public.phoenix_central_needs_dossier_lifecycle(
  p_organization_id uuid,
  p_plan_year       integer, p_plan_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_plan      public.central_needs_plans%ROWTYPE;
  v_revisions jsonb;
  v_events    jsonb;
  v_effective uuid;
BEGIN
  PERFORM public._phoenix_central_needs_guard_v1(p_organization_id, 'central_needs.view');

  IF p_plan_year IS NULL THEN
    RAISE EXCEPTION 'plan_year_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_plan
    FROM public.central_needs_plans
   WHERE organization_id = p_organization_id AND plan_year = p_plan_year AND id = p_plan_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'organization_id', p_organization_id, 'plan_year', p_plan_year,
      'plan_id', NULL, 'effective_revision_id', NULL,
      'revisions', '[]'::jsonb, 'events', '[]'::jsonb
    );
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', r.id,
           'revision_number', r.revision_number,
           'status', r.status,
           'effective', r.status = 'approved',
           'created_at', r.created_at,
           'approved_at', r.approved_at
         ) ORDER BY r.revision_number), '[]'::jsonb)
    INTO v_revisions
    FROM public.central_needs_plan_revisions r
   WHERE r.plan_id = v_plan.id;

  SELECT r.id INTO v_effective
    FROM public.central_needs_plan_revisions r
   WHERE r.plan_id = v_plan.id AND r.status = 'approved'
   ORDER BY r.revision_number DESC
   LIMIT 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'action', a.display_action,
           'revision_id', a.entity_id,
           'revision_number', (a.payload->>'revision_number')::integer,
           'occurred_at', a.created_at,
           'actor_id', a.actor_id,
           'actor_role', a.actor_role,
           'from_status', a.payload->>'from_status',
           'to_status', a.payload->>'to_status',
           'reason', CASE a.display_action
                       WHEN 'central_needs.plan_revision.reject'          THEN a.payload->>'reason'
                       WHEN 'central_needs.plan_revision.open_correction' THEN a.payload->>'correction_reason'
                     END,
           'opened_after_revision_id', a.payload->>'opened_after_revision_id',
           'effective_approved_revision_id', a.payload->>'effective_approved_revision_id',
           'predecessor_revision_id', a.payload->>'predecessor_revision_id',
           'superseded_by_revision_id', a.payload->>'superseded_by_revision_id'
         ) ORDER BY a.created_at,
                    CASE a.display_action
                      WHEN 'central_needs.plan_revision.open'            THEN 1
                      WHEN 'central_needs.plan_revision.open_correction' THEN 1
                      WHEN 'central_needs.plan_revision.submit'          THEN 2
                      WHEN 'central_needs.plan_revision.supersede'       THEN 3
                      WHEN 'central_needs.plan_revision.approve'         THEN 4
                      WHEN 'central_needs.plan_revision.reject'          THEN 4
                    END,
                    a.id), '[]'::jsonb)
    INTO v_events
    FROM (SELECT raw.*, CASE raw.action
       WHEN 'central_needs.manual_revision.open' THEN 'central_needs.plan_revision.open'
       WHEN 'central_needs.manual_revision.open_correction' THEN 'central_needs.plan_revision.open_correction'
       ELSE raw.action END AS display_action FROM public.audit_logs raw) a
   WHERE a.organization_id = p_organization_id
     AND a.entity_type = 'central_needs_plan_revision'
     AND a.entity_id IN (SELECT r.id FROM public.central_needs_plan_revisions r WHERE r.plan_id = v_plan.id)
     AND a.display_action IN (
       'central_needs.plan_revision.open',
       'central_needs.plan_revision.open_correction',
       'central_needs.plan_revision.submit',
       'central_needs.plan_revision.approve',
       'central_needs.plan_revision.reject',
       'central_needs.plan_revision.supersede'
     );

  RETURN jsonb_build_object(
    'ok', true,
    'organization_id', p_organization_id,
    'plan_id', v_plan.id,
    'plan_year', v_plan.plan_year,
    'effective_revision_id', v_effective,
    'revisions', v_revisions,
    'events', v_events
  );
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_dossier_lifecycle(uuid,integer,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_dossier_lifecycle(uuid,integer,uuid) TO authenticated;

CREATE FUNCTION public.phoenix_central_needs_open_dossier_correction(
 p_organization_id uuid,p_plan_year integer,p_expected_latest_revision_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r jsonb; p public.central_needs_plans%ROWTYPE; predecessor uuid;
BEGIN
 PERFORM public._phoenix_central_needs_guard_v1(p_organization_id,'central_needs.manual_need.set');
 SELECT cp.* INTO p FROM public.central_needs_plans cp
 JOIN public.central_needs_plan_revisions cr ON cr.plan_id=cp.id
 WHERE cr.id=p_expected_latest_revision_id AND cp.organization_id=p_organization_id AND cp.plan_year=p_plan_year;
 IF NOT FOUND OR p.dossier_key='' THEN RAISE EXCEPTION 'named_dossier_required' USING ERRCODE='23514'; END IF;
 r := public.phoenix_central_needs_open_manual_correction_revision(p_organization_id,p_plan_year,p_expected_latest_revision_id,p_reason);
 predecessor := (r->>'effective_approved_revision_id')::uuid;
 IF predecessor IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM public.central_needs_plan_revisions WHERE id=predecessor AND source_mode='manual') THEN
     RAISE EXCEPTION 'manual_carry_source_required' USING ERRCODE='23514';
   END IF;
   PERFORM public.phoenix_central_needs_carry_forward_manual_lines((r->>'plan_revision_id')::uuid,predecessor);
 END IF;
 RETURN r || jsonb_build_object('copied_approved_predecessor',predecessor);
END $$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_open_dossier_correction(uuid,integer,uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_open_dossier_correction(uuid,integer,uuid,text) TO authenticated;

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
    VALUES ('public.phoenix_central_needs_open_dossier_correction(uuid,integer,uuid,text)'),
           ('public.phoenix_central_needs_dossier_revisions(uuid)'),
           ('public.phoenix_central_needs_dossier_lifecycle(uuid,integer,uuid)'),
           ('phoenix_private.central_needs_lock_plan_id_v1(uuid)'),
           ('public.phoenix_central_needs_open_dossier(uuid,integer,text,text)'),
           ('public.phoenix_central_needs_list_dossiers(uuid,integer)'),
           ('public.phoenix_central_needs_annual_summary(uuid,integer)'),
           ('phoenix_private.central_needs_dossier_approval_guard_v1()'),
           ('public.phoenix_central_needs_create_material_request_with_code(uuid,text,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)'),
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
DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'central_needs_capability_seal_breached';
  END IF;
END $verify$;
COMMIT;
