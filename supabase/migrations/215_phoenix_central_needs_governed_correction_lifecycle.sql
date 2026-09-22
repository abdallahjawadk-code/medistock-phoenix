-- ============================================================================
-- C2 / M215 — CENTRAL NEEDS GOVERNED CORRECTION LIFECYCLE (function-only)
--
-- THE DEFECT THIS CLOSES
--   M210's phoenix_central_needs_open_plan_revision(org, year, true) opened a
--   correction by moving the APPROVED revision to 'superseded' at the moment
--   the correction DRAFT was created. From that commit on the plan year had no
--   approved (effective) revision at all, although its replacement was only a
--   draft that might never be submitted, and would be rejected if it were.
--   A correction must not take the effective revision away before the
--   replacement is itself approved.
--
-- THE LIFECYCLE THIS MIGRATION ESTABLISHES
--   EFFECTIVE REVISION = the plan's single revision whose status is 'approved'.
--   'draft', 'submitted' and 'rejected' never replace it. 'superseded' means a
--   revision that was approved and has since been replaced by a later revision
--   that was itself successfully approved.
--
--     A. open correction   Rev1 APPROVED            -> Rev1 APPROVED, Rev2 DRAFT
--     B. reject correction Rev1 APPROVED, Rev2 SUBM -> Rev1 APPROVED, Rev2 REJECTED
--     C. approve correction                         -> in ONE transaction:
--                                                      Rev1 SUPERSEDED, Rev2 APPROVED
--     D. correction after a rejection               -> Rev1 APPROVED, Rev2 REJECTED, Rev3 DRAFT;
--                                                      approving Rev3 later ->
--                                                      Rev1 SUPERSEDED, Rev2 REJECTED, Rev3 APPROVED
--
-- WHAT THIS MIGRATION CHANGES (functions only)
--   1. phoenix_central_needs_open_plan_revision(uuid, integer, boolean) — same
--      signature; the NEW / current annual draft path is unchanged, and the
--      legacy correction path (p_open_next_revision true OR null) now fails
--      closed with `central_needs_governed_correction_required` before any
--      lock or write. The supersede-on-open branch no longer exists anywhere.
--   2. NEW phoenix_central_needs_open_correction_revision(org, year,
--      expected_latest_revision_id, reason) — the only way to open a
--      correction: authorized, stale-fenced, reason-mandatory, audited.
--   3. phoenix_central_needs_approve_revision(uuid) — same signature; approving
--      a correction switches predecessor APPROVED -> SUPERSEDED and target
--      SUBMITTED -> APPROVED inside the approval transaction, and fails closed
--      on any ambiguous lifecycle state instead of repairing it.
--   4. phoenix_central_needs_reject_revision(uuid, text) — same signature,
--      authority and mandatory reason; now taken under the same family lock,
--      and never touches the effective predecessor.
--   5. NEW phoenix_central_needs_revision_lifecycle(org, year) — a narrow,
--      authorized read of ONE plan's revisions and their lifecycle audit rows.
--      Not a generic audit_logs browser.
--   6. NEW internal helper _phoenix_central_needs_lock_plan_family_v1 — the one
--      lock order every lifecycle writer takes.
--   7. NEW internal helper _phoenix_central_needs_human_text_v1 — a reason is
--      the text left after trimming ALL whitespace (btrim() only removes
--      spaces); used by the correction reason and, strictly tightening M210,
--      by the rejection reason.
--
-- LOCK ORDER (identical in every lifecycle writer, so they cannot deadlock)
--   organization FOR KEY SHARE (inside the existing guard)
--   -> pg_advisory_xact_lock(org:year, 210001)   (M210's existing key)
--   -> central_needs_plans row FOR UPDATE
--   -> every central_needs_plan_revisions row of that plan FOR UPDATE,
--      in revision_number order.
--   Revision-scoped content RPCs (imports, mappings, need lines, submit) lock
--   only their own draft revision row and never wait on the plan row or the
--   advisory key, so they cannot close a cycle with this order.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   - No new table, column, enum, index, trigger, policy or permission key.
--     central_needs.edit (open), central_needs.approve (approve/reject) and
--     central_needs.view (history) are M209's existing keys.
--   - No change to M209-M214 files, to submit, import, mapping, disposition,
--     need-line or beneficiary-column behaviour.
--   - No stock, movement, allocation or transfer object of any kind.
--   - central_needs_plans.status is not read or written.
--   - Ambiguous historical state is never repaired automatically.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Preconditions — fail closed unless the reviewed M209-M214 surface is
--    present and the lifecycle data already satisfies the invariant this
--    migration relies on.
-- ----------------------------------------------------------------------------
DO $precondition$
DECLARE
  f text;
  v_bad record;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean)',
    'public.phoenix_central_needs_submit_revision(uuid)',
    'public.phoenix_central_needs_approve_revision(uuid)',
    'public.phoenix_central_needs_reject_revision(uuid, text)',
    'public._phoenix_central_needs_guard_v1(uuid, text)',
    'public._phoenix_central_needs_assert_org_live_v1(uuid)',
    'public.phoenix_status_center_authorized(uuid, text)'
  ] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION '215_precondition_failed: % is absent', f;
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['central_needs_plans', 'central_needs_plan_revisions', 'audit_logs'] LOOP
    IF to_regclass('public.' || f) IS NULL THEN
      RAISE EXCEPTION '215_precondition_failed: table % is absent', f;
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.phoenix_central_needs_open_correction_revision(uuid, integer, uuid, text)',
    'public.phoenix_central_needs_revision_lifecycle(uuid, integer)',
    'public._phoenix_central_needs_lock_plan_family_v1(uuid, integer)',
    'public._phoenix_central_needs_human_text_v1(text)'
  ] LOOP
    IF to_regprocedure(f) IS NOT NULL THEN
      RAISE EXCEPTION '215_precondition_failed: % already exists', f;
    END IF;
  END LOOP;

  -- The revision status vocabulary this migration writes must be M209's.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.central_needs_plan_revisions'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%superseded%'
       AND pg_get_constraintdef(c.oid) LIKE '%rejected%'
  ) THEN
    RAISE EXCEPTION '215_precondition_failed: the M209 revision status CHECK is not as reviewed';
  END IF;

  -- FAIL CLOSED ON AN ALREADY-AMBIGUOUS PLAN. Every rule below assumes at most
  -- one approved revision per plan; M210's writers could never produce two.
  -- If some unknown path did, choosing which one is "effective" would rewrite
  -- history by guess, so the migration refuses instead.
  SELECT plan_id, count(*) AS approved
    INTO v_bad
    FROM public.central_needs_plan_revisions
   WHERE status = 'approved'
   GROUP BY plan_id
  HAVING count(*) > 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '215_precondition_failed: plan % holds % approved revisions; the effective revision is ambiguous and is not repaired automatically',
      v_bad.plan_id, v_bad.approved;
  END IF;
END;
$precondition$;

-- ----------------------------------------------------------------------------
-- 1. The one lock order for a plan's revision family (internal).
--
--    Called only AFTER the caller has been authorized for the organization, so
--    lock acquisition never discloses anything to an unauthorized caller.
--    Raises central_needs_plan_not_found when the plan does not exist; the
--    new/current-draft path, which may create the plan, keeps its own M210
--    sequence (same advisory key, same order) instead.
-- ----------------------------------------------------------------------------
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
   WHERE organization_id = p_organization_id AND plan_year = p_plan_year
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

REVOKE ALL ON FUNCTION public._phoenix_central_needs_lock_plan_family_v1(uuid, integer) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_lock_plan_family_v1(uuid, integer) IS
  'C2 internal: advisory key (org:year, 210001) -> plan row FOR UPDATE -> every revision of the plan FOR UPDATE in revision_number order. The single lock order of every Central Needs lifecycle writer. Not client-callable.';

-- ----------------------------------------------------------------------------
-- 1b. Human reason text (internal).
--
--     btrim() removes only U+0020, so a tab/newline-only "reason" passed M210's
--     rejection check and would pass a correction reason check too. A human
--     reason is the text left after removing ALL leading/trailing whitespace —
--     ASCII controls, Unicode spaces, and the invisible zero-width/direction
--     marks an Arabic keyboard can produce — and it is NULL when nothing is
--     left. The accepted reason is stored exactly as this trimmed text.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_human_text_v1(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT NULLIF(
    regexp_replace(
      p_text,
      '^[\s   -‏    　﻿]+|[\s   -‏    　﻿]+$',
      '', 'g'),
    '');
$$;

REVOKE ALL ON FUNCTION public._phoenix_central_needs_human_text_v1(text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_central_needs_human_text_v1(text) IS
  'C2 internal: trims all leading/trailing whitespace (ASCII, Unicode spaces, zero-width and direction marks) and returns NULL when no human text remains. Used for the mandatory correction and rejection reasons.';

-- ----------------------------------------------------------------------------
-- 2. open_plan_revision — NEW / current annual draft only.
--
--    Byte-for-byte M210 behaviour for p_open_next_revision = false. The legacy
--    correction path is closed: true (and NULL, which M210's `IF NOT` test
--    treated as true) now fails before any lock or write.
-- ----------------------------------------------------------------------------
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
   WHERE organization_id = p_organization_id AND plan_year = p_plan_year
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

REVOKE ALL ON FUNCTION public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean) IS
  'C2: opens (or idempotently returns) the NEW / current annual draft of a plan year. The legacy correction path is closed: p_open_next_revision true or null raises central_needs_governed_correction_required before any lock or write. Corrections go through phoenix_central_needs_open_correction_revision.';

-- ----------------------------------------------------------------------------
-- 3. open_correction_revision — the ONLY way to open a correction.
--
--    * existing authorization: central_needs.edit through the canonical guard
--      (role class + capability + live organization);
--    * p_reason is mandatory, trimmed, and audited exactly as accepted;
--    * STALE FENCE: under the family lock the plan's actual newest revision
--      must be exactly p_expected_latest_revision_id, otherwise
--      central_needs_revision_stale with ZERO writes — never refreshed and
--      retried here, never last-writer-wins;
--    * the expected revision must belong to THIS plan year
--      (central_needs_correction_plan_mismatch otherwise);
--    * the newest revision must be closed (approved or rejected);
--    * the effective approved revision, if any, stays approved; rejected
--      history is untouched; the new revision is the next number, a DRAFT.
--
--    Two concurrent requests from the same expected revision serialize on the
--    advisory key: the second sees the first one's draft as the newest
--    revision and is refused as stale, so exactly one successor can exist.
-- ----------------------------------------------------------------------------
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

  v_plan := public._phoenix_central_needs_lock_plan_family_v1(p_organization_id, p_plan_year);

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

REVOKE ALL ON FUNCTION public.phoenix_central_needs_open_correction_revision(uuid, integer, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_open_correction_revision(uuid, integer, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_open_correction_revision(uuid, integer, uuid, text) IS
  'C2: opens a correction DRAFT after the closed newest revision of a plan year. Requires central_needs.edit, a non-blank reason and the expected newest revision (stale fence: central_needs_revision_stale with zero writes). The effective approved revision stays approved until the correction itself is approved. Audited as central_needs.plan_revision.open_correction.';

-- ----------------------------------------------------------------------------
-- 4. approve_revision — atomic approval switch.
--
--    Authorize first (before disclosing state), then take the family lock and
--    re-read the target under it. A correction is approved in ONE transaction:
--    the effective predecessor APPROVED -> SUPERSEDED and the target
--    SUBMITTED -> APPROVED, with both audit rows, or nothing at all.
--    Ambiguous state (two approved, a submitted revision that is not the
--    newest) fails closed and is never repaired.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_approve_revision(
  p_plan_revision_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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

  SELECT * INTO v_plan FROM public.central_needs_plans WHERE id = v_revision.plan_id;
  v_plan := public._phoenix_central_needs_lock_plan_family_v1(v_plan.organization_id, v_plan.plan_year);

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

  IF v_approved = 1 THEN
    SELECT * INTO v_predecessor
      FROM public.central_needs_plan_revisions
     WHERE plan_id = v_plan.id AND status = 'approved';

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
      'predecessor_to_status', CASE WHEN v_predecessor.id IS NULL THEN NULL ELSE 'superseded' END
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

REVOKE ALL ON FUNCTION public.phoenix_central_needs_approve_revision(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_approve_revision(uuid) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_approve_revision(uuid) IS
  'C2: approves a submitted revision (central_needs.approve). Approving a correction supersedes the effective predecessor in the SAME transaction (predecessor APPROVED -> SUPERSEDED, target SUBMITTED -> APPROVED, both audited), so no committed state ever has zero or two effective revisions. Ambiguous state fails closed and is never repaired.';

-- ----------------------------------------------------------------------------
-- 5. reject_revision — the effective predecessor is never touched.
--
--    Same signature and central_needs.approve authority as M210. The mandatory
--    reason is only TIGHTENED: whitespace-only text (tabs, newlines, Unicode
--    spaces), which M210's btrim() let through, is now refused too. Taken
--    under the family lock so it is ordered against an approval of the same
--    revision.
-- ----------------------------------------------------------------------------
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
  v_plan := public._phoenix_central_needs_lock_plan_family_v1(v_plan.organization_id, v_plan.plan_year);

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

REVOKE ALL ON FUNCTION public.phoenix_central_needs_reject_revision(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_reject_revision(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_reject_revision(uuid, text) IS
  'C2: rejects a submitted revision (central_needs.approve, mandatory reason). The effective approved revision, if any, stays approved and is recorded in the audit row.';

-- ----------------------------------------------------------------------------
-- 6. revision_lifecycle — narrow, authorized lifecycle history of ONE plan.
--
--    Returns only the plan's own revisions and the fixed set of lifecycle
--    audit actions whose entity is one of those revisions, in this
--    organization. It is not a generic audit_logs reader: no other action,
--    entity type, organization or plan can appear. Requires central_needs.view
--    through the same guard as every other Central Needs RPC.
--
--    VOLATILE on purpose: the guard takes SELECT ... FOR KEY SHARE, and M214
--    showed that a STABLE declaration makes PostgREST run it read-only and
--    fail with SQLSTATE 25006.
-- ----------------------------------------------------------------------------
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
   WHERE organization_id = p_organization_id AND plan_year = p_plan_year;
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

REVOKE ALL ON FUNCTION public.phoenix_central_needs_revision_lifecycle(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_revision_lifecycle(uuid, integer) TO authenticated;

COMMENT ON FUNCTION public.phoenix_central_needs_revision_lifecycle(uuid, integer) IS
  'C2: read-only lifecycle history of ONE plan year (its revisions and the fixed central_needs.plan_revision.* audit actions on them). Requires central_needs.view through the canonical guard. Not a generic audit_logs reader. VOLATILE because the guard takes FOR KEY SHARE (M214).';

-- ----------------------------------------------------------------------------
-- VERIFY
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_sig    text;
  v_def    text;
  v_client text[] := ARRAY[
    'public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean)',
    'public.phoenix_central_needs_open_correction_revision(uuid, integer, uuid, text)',
    'public.phoenix_central_needs_approve_revision(uuid)',
    'public.phoenix_central_needs_reject_revision(uuid, text)',
    'public.phoenix_central_needs_revision_lifecycle(uuid, integer)'
  ];
BEGIN
  FOREACH v_sig IN ARRAY v_client || ARRAY['public._phoenix_central_needs_lock_plan_family_v1(uuid, integer)'] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED (215): % is missing', v_sig;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) THEN
      RAISE EXCEPTION 'VERIFY FAILED (215): % is not SECURITY DEFINER', v_sig;
    END IF;
    IF NOT COALESCE((SELECT 'search_path=public, pg_temp' = ANY (p.proconfig) FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)), false) THEN
      RAISE EXCEPTION 'VERIFY FAILED (215): % does not pin search_path = public, pg_temp', v_sig;
    END IF;
    IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED (215): anon can execute %', v_sig;
    END IF;
  END LOOP;

  FOREACH v_sig IN ARRAY v_client LOOP
    IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED (215): authenticated cannot execute %', v_sig;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public._phoenix_central_needs_lock_plan_family_v1(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (215): the internal family lock is client-callable';
  END IF;
  IF to_regprocedure('public._phoenix_central_needs_human_text_v1(text)') IS NULL
     OR has_function_privilege('authenticated', 'public._phoenix_central_needs_human_text_v1(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._phoenix_central_needs_human_text_v1(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (215): the reason helper is missing or client-callable';
  END IF;
  IF public._phoenix_central_needs_human_text_v1(E' \t\n\r' || chr(160) || chr(8203) || chr(8207) || ' ') IS NOT NULL
     OR public._phoenix_central_needs_human_text_v1(E'\t  keep  me \n') <> 'keep  me' THEN
    RAISE EXCEPTION 'VERIFY FAILED (215): the reason helper does not trim whitespace-only text to NULL';
  END IF;

  IF (SELECT p.provolatile FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.phoenix_central_needs_revision_lifecycle(uuid, integer)')) <> 'v' THEN
    RAISE EXCEPTION 'VERIFY FAILED (215): the lifecycle read must be VOLATILE (the guard takes FOR KEY SHARE)';
  END IF;

  v_def := pg_get_functiondef(to_regprocedure('public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean)'));
  IF position('central_needs_governed_correction_required' IN v_def) = 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (215): open_plan_revision does not refuse the legacy correction path';
  END IF;
  IF position('''superseded''' IN v_def) > 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (215): open_plan_revision still writes superseded';
  END IF;

  v_def := pg_get_functiondef(to_regprocedure('public.phoenix_central_needs_approve_revision(uuid)'));
  IF position('_phoenix_central_needs_lock_plan_family_v1' IN v_def) = 0
     OR position('''superseded''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (215): approve_revision is not the atomic family-locked switch';
  END IF;

  v_def := pg_get_functiondef(to_regprocedure('public.phoenix_central_needs_reject_revision(uuid, text)'));
  IF position('''superseded''' IN v_def) > 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (215): reject_revision must never supersede';
  END IF;
END;
$verify$;

COMMIT;
