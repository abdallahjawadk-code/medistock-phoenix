-- MIGRATION 229 (R1-b 01). D9 CLOSED: numbered from supabase/candidates/R1b_01_manual_activation_NOT_APPLIED.sql WITHOUT any change to the SQL below.
-- The bytes after this prelude are exactly the candidate (SHA-256 bc251ee3fcc5a2d06eaef4b7671b135bb0f0385a5b86cfec6ef070117e0e4392) that Staging already carries in its ledger;
-- wording below that says "PLACEHOLDER", "NOT part of the numbered chain" or "D9 open" predates this numbering and is superseded by this prelude.
-- ============================================================================
-- R1-b CANDIDATE 01 — manual activation (NOT APPLIED; PROPOSAL FOR OWNER DECISION)
-- PLACEHOLDER (no migration number, D9). Requires R1a_01..R1a_05.
-- Distinct from R1-a (ADR: R1-a and R1-b are separate deliveries). Applying this file
-- is the cutover from Excel intake to manual intake; it is irreversible by design
-- (the activation marker is append-only). Not to be applied without the owner's
-- decisions: Q-W0 (cutover window), Q-E (Excel SoD stays DISABLED here), Q-K (key
-- strings are placeholders), D9 (migration numbering).
--
--  1. EXECUTE on the eight manual writers is granted to authenticated (they remain gated
--     inside by the single authority predicate, key central_needs.manual_need.set / .edit / .approve).
--  2. MO-1/MO-3: once an organization carries an activation marker, a plan revision whose
--     source_mode is not 'manual', and any new Excel source file / import session / import
--     batch, is refused by BEFORE INSERT triggers.
--  2b. F01: BEFORE INSERT guards (plan revision [manual], manual events, coverage acknowledgements) refuse
--      unless THE ROW'S OWN organization carries an activation marker (fail-closed). The global GRANT is not activation.
--  3. phoenix_private.central_needs_activate_manual_cutover_v1(org): owner-only (never exposed).
--     Refuses while an Excel draft/submitted revision exists; inventories every revision of the
--     organization (status, state digest, counts, actor sets) and then writes the marker.
--  4. my_capabilities gets its R1-b body (manual_set and excel_import_open become real).
-- Writer census after this candidate: 24 (the owner-only activation routine is the 24th).
-- ============================================================================
BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('phoenix_cn_policy.excel_read_restriction_state(uuid)') IS NULL THEN
    RAISE EXCEPTION 'R1b01_precondition_failed: R1a_01..R1a_05 must be applied first';
  END IF;
  IF to_regprocedure('phoenix_private.central_needs_activate_manual_cutover_v1(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'R1b01_precondition_failed: already applied';
  END IF;
END
$pre$;

-- 1. freeze triggers (MO-1 / MO-3)
CREATE FUNCTION phoenix_private.central_needs_excel_freeze_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'central_needs_plan_revisions' THEN
    IF NEW.source_mode IS NOT DISTINCT FROM 'manual' THEN
      RETURN NEW;                            -- manual revisions are governed by the manual activation guard
    END IF;
  END IF;
  -- F01B (Director review) — the cutover fence. The activation routine takes the EXCLUSIVE advisory lock of
  -- (organization, 210002) for its whole transaction; every Excel intake insert takes the SHARED lock of the same
  -- key BEFORE it reads the activation state and holds it to its own commit. Therefore either
  --   (a) the Excel insert got there first: activation waits for it to commit, then its pending-Excel check SEES the
  --       committed draft and refuses; or
  --   (b) activation got there first: the Excel insert waits for the marker to commit, then reads `active` and refuses.
  -- The activation routine never takes the plan-family lock (210001) that Excel flows hold, so there is no lock cycle.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(NEW.organization_id::text, 210002));
  IF phoenix_cn_policy.excel_read_restriction_state(NEW.organization_id) = 'active' THEN
    RAISE EXCEPTION 'excel_intake_closed_after_activation' USING ERRCODE = '23514',
      DETAIL = format('organization=%s relation=%s', NEW.organization_id, TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_excel_freeze_guard_v1() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER central_needs_plan_revisions_r1_05_excel_freeze BEFORE INSERT ON public.central_needs_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_excel_freeze_guard_v1();
CREATE TRIGGER central_needs_source_files_r1_05_excel_freeze BEFORE INSERT ON public.central_needs_source_files
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_excel_freeze_guard_v1();
CREATE TRIGGER central_needs_import_sessions_r1_05_excel_freeze BEFORE INSERT ON public.central_needs_import_sessions
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_excel_freeze_guard_v1();
CREATE TRIGGER central_needs_import_batches_r1_05_excel_freeze BEFORE INSERT ON public.central_needs_import_batches
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_excel_freeze_guard_v1();

-- 1b. F01 — per-organization activation guard (fail-closed, server-side). The GLOBAL grant below makes the
--     writers callable by authenticated; it is NOT an activation. Every manual entry DML therefore re-checks,
--     for the ROW's own organization, that an activation marker exists. No marker, a marker of ANOTHER
--     organization, or any error in the state function => refused. One mechanism covers all eight writers
--     (each one reaches one of the guarded DML points: manual revision insert, manual event insert, coverage-ack insert,
--     withdrawal-row insert, or a manual revision status transition) and any future writer. The withdrawal of an EXCEL
--     draft is deliberately NOT guarded (W0 needs it).
CREATE FUNCTION phoenix_private.central_needs_manual_activation_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'central_needs_plan_revisions' THEN
    IF NEW.source_mode IS DISTINCT FROM 'manual' THEN
      RETURN NEW;                            -- Excel revisions are governed by the freeze guard, not by this one
    END IF;
    IF TG_OP = 'UPDATE' THEN
      IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;                          -- not a lifecycle transition
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'central_needs_revision_withdrawals' THEN
    -- F01A (Director review): a withdrawal writes this row BEFORE it updates the status, and neither of the other
    -- inserts is on its path. Only the withdrawal of a MANUAL revision is guarded; the withdrawal of an EXCEL draft
    -- stays possible before the cutover (it is how a pending Excel draft is cleared so the cutover can proceed).
    IF NOT EXISTS (SELECT 1 FROM public.central_needs_plan_revisions r
                    WHERE r.id = NEW.plan_revision_id AND r.source_mode = 'manual') THEN
      RETURN NEW;
    END IF;
  END IF;
  IF phoenix_cn_policy.excel_read_restriction_state(NEW.organization_id) IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'manual_intake_not_activated' USING ERRCODE = '23514',
      DETAIL = format('organization=%s relation=%s', NEW.organization_id, TG_TABLE_NAME),
      HINT = 'Manual annual-needs intake opens per organization at its activation; it is not open yet.';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_manual_activation_guard_v1() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER central_needs_plan_revisions_r1_06_manual_activation BEFORE INSERT ON public.central_needs_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_manual_activation_guard_v1();
CREATE TRIGGER central_needs_manual_need_events_r1_06_manual_activation BEFORE INSERT ON public.central_needs_manual_need_events
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_manual_activation_guard_v1();
CREATE TRIGGER central_needs_manual_coverage_acks_r1_06_manual_activation BEFORE INSERT ON public.central_needs_manual_coverage_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_manual_activation_guard_v1();
CREATE TRIGGER central_needs_revision_withdrawals_r1_06_manual_activation BEFORE INSERT ON public.central_needs_revision_withdrawals
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_manual_activation_guard_v1();
CREATE TRIGGER central_needs_plan_revisions_r1_06_manual_activation_status BEFORE UPDATE OF status ON public.central_needs_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_manual_activation_guard_v1();

-- 2. owner-only activation routine
CREATE FUNCTION phoenix_private.central_needs_activate_manual_cutover_v1(p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pending integer;
  v_n integer := 0;
  r record;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'activation_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND o.organization_kind = 'pharmacy_department_authority' AND o.archived_at IS NULL) THEN
    RAISE EXCEPTION 'activation_organization_ineligible' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_org::text, 210002));
  IF phoenix_cn_policy.excel_read_restriction_state(p_org) = 'active' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'organization_id', p_org);
  END IF;
  SELECT count(*) INTO v_pending FROM public.central_needs_plan_revisions
   WHERE organization_id = p_org AND source_mode = 'excel' AND status IN ('draft', 'submitted');
  IF v_pending > 0 THEN
    RAISE EXCEPTION 'activation_blocked_pending_excel_revisions' USING ERRCODE = '23514', DETAIL = format('pending=%s', v_pending);
  END IF;

  FOR r IN SELECT rv.id, rv.plan_id, rv.status FROM public.central_needs_plan_revisions rv WHERE rv.organization_id = p_org ORDER BY rv.id LOOP
    INSERT INTO public.central_needs_cutover_inventory (organization_id, entry_kind, plan_id, plan_revision_id, status_at_cutover, state_digest, counts, first_blocker, actor_sets)
    VALUES (p_org, 'revision', r.plan_id, r.id, r.status,
            phoenix_private.central_needs_submission_state_digest_v1(r.id),
            jsonb_build_object(
              'need_lines', (SELECT count(*) FROM public.central_needs_need_lines n WHERE n.plan_revision_id = r.id),
              'import_sessions', (SELECT count(*) FROM public.central_needs_import_sessions s WHERE s.plan_revision_id = r.id),
              'manual_events', (SELECT count(*) FROM public.central_needs_manual_need_events e WHERE e.plan_revision_id = r.id)),
            (SELECT b.blocker FROM public._phoenix_central_needs_review_blockers_v1(r.id) b ORDER BY b.blocker LIMIT 1),
            jsonb_build_object(
              'created_by', (SELECT rv2.created_by FROM public.central_needs_plan_revisions rv2 WHERE rv2.id = r.id),
              'approved_by', (SELECT rv2.approved_by FROM public.central_needs_plan_revisions rv2 WHERE rv2.id = r.id)));
    v_n := v_n + 1;
  END LOOP;
  INSERT INTO public.central_needs_cutover_inventory (organization_id, entry_kind) VALUES (p_org, 'activation_marker');
  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'organization_id', p_org, 'inventoried_revisions', v_n);
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_activate_manual_cutover_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 3. open the eight writers to authenticated (each re-authorizes inside)
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_open_manual_plan_revision(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_open_manual_correction_revision(uuid, integer, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_carry_forward_manual_lines(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_add_manual_need_line(uuid, uuid, uuid, uuid, text, text, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_correct_manual_need_line(uuid, uuid, uuid, uuid, text, text, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_void_manual_need_line(uuid, uuid, uuid, uuid, text, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_withdraw_draft_revision(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_acknowledge_manual_coverage(uuid, text, text) TO authenticated;

-- 4. my_capabilities: R1-b body
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_my_capabilities(p_organization_id uuid, p_plan_revision_id uuid DEFAULT NULL)
RETURNS TABLE(view boolean, edit boolean, approve boolean, manual_set boolean, excel_import_open boolean, approve_excluded_for_revision boolean)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(phoenix_cn_policy.actor_scope_org('central_needs.view') = p_organization_id, false),
         COALESCE(phoenix_cn_policy.actor_scope_org('central_needs.edit') = p_organization_id, false),
         COALESCE(phoenix_cn_policy.actor_scope_org('central_needs.approve') = p_organization_id, false),
         COALESCE(phoenix_cn_policy.actor_scope_org('central_needs.manual_need.set') = p_organization_id, false),
         phoenix_cn_policy.excel_read_restriction_state(p_organization_id) = 'inactive',
         CASE WHEN p_plan_revision_id IS NULL THEN false ELSE phoenix_cn_policy.approve_excluded_for_caller(p_plan_revision_id) END
$$;

DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = 'phoenix_private.central_needs_activate_manual_cutover_v1(uuid)'::regprocedure
              AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')
                   OR has_function_privilege('service_role', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1b01): the activation routine is reachable by an API role';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgname LIKE '%\_r1\_05\_excel\_freeze') <> 4 THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1b01): expected 4 freeze triggers';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgname LIKE '%\_r1\_06\_manual\_activation%') <> 5 THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1b01): expected 5 manual activation guard triggers';
  END IF;
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1b01): capability seal reports breaches';
  END IF;
END
$verify$;

COMMIT;
