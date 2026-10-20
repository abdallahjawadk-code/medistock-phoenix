-- ============================================================================
-- R1-a CANDIDATE 05 — mode-gated review blockers, manual submission digest section,
-- and the D27 Excel-history read restriction (INERT until an activation marker exists).
-- PLACEHOLDER (no migration number): NOT part of the numbered chain, NOT approved for apply.
-- Requires candidates 01–04.
--
--  * The M217 Excel blocker body is moved BYTE-FOR-BYTE into a private function; the public
--    _phoenix_central_needs_review_blockers_v1 keeps its signature/attributes and returns that
--    body for Excel (and unknown) revisions, the manual blockers for manual revisions.
--  * The M218 digest is re-created unchanged for Excel revisions (identical bytes); a manual
--    revision additionally commits its event chain and coverage acknowledgements.
--  * D27 (7 relations: source files/records/overrides/need lines/need-line sources + import batches/entries, the gateway of the
--    signed-URL download): while NO activation marker exists for the organization, every new policy passes
--    (behaviour unchanged). After a marker exists, EXCEL-mode quantity-bearing rows are readable
--    only by holders of central_needs.approve / central_needs.import (Q-K placeholder keys).
--    authorize_excel_download_v1 and the promotion RPC are NOT defined here (Q-ST/Q-W0 open).
-- ============================================================================
BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.phoenix_central_needs_add_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'R1a05_precondition_failed: candidates 01-04 must be applied first';
  END IF;
  IF to_regprocedure('phoenix_private.central_needs_excel_review_blockers_v1(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'R1a05_precondition_failed: already applied';
  END IF;
END
$pre$;

-- 1. Excel blockers: the M217 body, unchanged, in a private function
CREATE FUNCTION phoenix_private.central_needs_excel_review_blockers_v1(
  p_plan_revision_id uuid
)
RETURNS TABLE (blocker text, detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
--@@EXCEL_BLOCKERS_BODY@@
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_excel_review_blockers_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 2. The public single definition of review completeness, mode-gated
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_review_blockers_v1(
  p_plan_revision_id uuid
)
RETURNS TABLE (blocker text, detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT x.blocker, x.detail
    FROM phoenix_private.central_needs_excel_review_blockers_v1(p_plan_revision_id) x
   WHERE COALESCE((SELECT r.source_mode FROM public.central_needs_plan_revisions r WHERE r.id = p_plan_revision_id), 'excel') = 'excel'

  UNION ALL
  SELECT 'manual_revision_has_no_lines'::text, NULL::text
    FROM public.central_needs_plan_revisions r
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual'
     AND NOT EXISTS (SELECT 1 FROM public.central_needs_need_lines n WHERE n.plan_revision_id = r.id)

  UNION ALL
  SELECT 'manual_revision_has_import_evidence', format('session=%s', s.id)
    FROM public.central_needs_plan_revisions r
    JOIN public.central_needs_import_sessions s ON s.plan_revision_id = r.id
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual'

  UNION ALL
  -- projection must equal the last non-void event of its scope
  SELECT 'manual_projection_event_divergence', format('need_line=%s', n.id)
    FROM public.central_needs_plan_revisions r
    JOIN public.central_needs_need_lines n ON n.plan_revision_id = r.id
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual'
     AND NOT EXISTS (
       SELECT 1 FROM public.central_needs_manual_need_events e
        WHERE e.plan_revision_id = n.plan_revision_id AND e.beneficiary_organization_id = n.beneficiary_organization_id
          AND e.central_item_id = n.central_item_id AND e.target_warehouse_id IS NOT DISTINCT FROM n.target_warehouse_id
          AND e.event_kind <> 'void' AND e.quantity_text = n.approved_quantity::text AND e.approved_unit IS NOT DISTINCT FROM n.approved_unit
          AND e.event_seq = (SELECT max(e2.event_seq) FROM public.central_needs_manual_need_events e2
                              WHERE e2.plan_revision_id = e.plan_revision_id AND e2.beneficiary_organization_id = e.beneficiary_organization_id
                                AND e2.central_item_id = e.central_item_id AND e2.target_warehouse_id IS NOT DISTINCT FROM e.target_warehouse_id))

  UNION ALL
  SELECT 'manual_event_without_line', format('event=%s', e.id)
    FROM public.central_needs_plan_revisions r
    JOIN public.central_needs_manual_need_events e ON e.plan_revision_id = r.id
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual' AND e.event_kind <> 'void'
     AND e.event_seq = (SELECT max(e2.event_seq) FROM public.central_needs_manual_need_events e2
                         WHERE e2.plan_revision_id = e.plan_revision_id AND e2.beneficiary_organization_id = e.beneficiary_organization_id
                           AND e2.central_item_id = e.central_item_id AND e2.target_warehouse_id IS NOT DISTINCT FROM e.target_warehouse_id)
     AND NOT EXISTS (SELECT 1 FROM public.central_needs_need_lines n
                      WHERE n.plan_revision_id = e.plan_revision_id AND n.beneficiary_organization_id = e.beneficiary_organization_id
                        AND n.central_item_id = e.central_item_id AND n.target_warehouse_id IS NOT DISTINCT FROM e.target_warehouse_id)

  UNION ALL
  SELECT 'manual_line_beneficiary_ineligible',
         format('need_line=%s beneficiary=%s reason=%s', n.id, n.beneficiary_organization_id,
                CASE WHEN o.organization_kind IS DISTINCT FROM 'care_institution' THEN 'not_care_institution'
                     WHEN o.status IS DISTINCT FROM 'active' THEN 'inactive' ELSE 'archived' END)
    FROM public.central_needs_plan_revisions r
    JOIN public.central_needs_need_lines n ON n.plan_revision_id = r.id
    JOIN public.organizations o ON o.id = n.beneficiary_organization_id
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual'
     AND (o.organization_kind IS DISTINCT FROM 'care_institution' OR o.status IS DISTINCT FROM 'active' OR o.archived_at IS NOT NULL)

  UNION ALL
  SELECT 'manual_line_item_not_active', format('need_line=%s item=%s status=%s', n.id, n.central_item_id, i.status)
    FROM public.central_needs_plan_revisions r
    JOIN public.central_needs_need_lines n ON n.plan_revision_id = r.id
    JOIN public.central_items i ON i.id = n.central_item_id
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual' AND i.status IS DISTINCT FROM 'active'

  UNION ALL
  SELECT 'manual_line_unit_mismatch', format('need_line=%s item=%s unit=%s catalog_unit=%s', n.id, n.central_item_id, n.approved_unit, i.unit)
    FROM public.central_needs_plan_revisions r
    JOIN public.central_needs_need_lines n ON n.plan_revision_id = r.id
    JOIN public.central_items i ON i.id = n.central_item_id
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual' AND n.approved_unit IS DISTINCT FROM i.unit

  UNION ALL
  SELECT 'manual_line_warehouse_ineligible', format('need_line=%s warehouse=%s', n.id, n.target_warehouse_id)
    FROM public.central_needs_plan_revisions r
    JOIN public.central_needs_need_lines n ON n.plan_revision_id = r.id AND n.target_warehouse_id IS NOT NULL
    JOIN public.warehouses w ON w.id = n.target_warehouse_id
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual'
     AND (w.organization_id IS DISTINCT FROM n.beneficiary_organization_id OR w.status IS DISTINCT FROM 'active')

  UNION ALL
  -- coverage-v1: scopes of the effective predecessor missing from this revision need an acknowledgement
  SELECT 'manual_coverage_unacknowledged', format('predecessor=%s omitted_scopes=%s', p.id, c.omitted_scope_count)
    FROM public.central_needs_plan_revisions r
    CROSS JOIN LATERAL (SELECT phoenix_private.central_needs_effective_predecessor_v1(r.id) AS id) p
    CROSS JOIN LATERAL phoenix_private.central_needs_coverage_digest_v1(r.id, p.id) c
   WHERE r.id = p_plan_revision_id AND r.source_mode = 'manual' AND p.id IS NOT NULL AND c.omitted_scope_count > 0
     AND NOT EXISTS (SELECT 1 FROM public.central_needs_manual_coverage_acknowledgements a
                      WHERE a.plan_revision_id = r.id AND a.omitted_scope_digest = c.omitted_scope_digest);
$$;
REVOKE ALL ON FUNCTION public._phoenix_central_needs_review_blockers_v1(uuid) FROM PUBLIC, anon, authenticated;

-- 3. Submission digest: Excel bytes identical; a manual revision also commits events + acknowledgements
--@@DIGEST_FUNCTION@@

-- 4. D27 — Excel-history read restriction (inert while no activation marker exists)
CREATE FUNCTION phoenix_cn_policy.excel_read_restriction_state(p_org uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.central_needs_cutover_inventory i
                            WHERE i.organization_id = p_org AND i.entry_kind = 'activation_marker')
              THEN 'active' ELSE 'inactive' END
$$;
REVOKE ALL ON FUNCTION phoenix_cn_policy.excel_read_restriction_state(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION phoenix_cn_policy.excel_read_restriction_state(uuid) TO authenticated;

-- decision for one revision: allowed_manual | allowed_inactive | allowed_authorized | denied
CREATE FUNCTION phoenix_cn_policy.excel_history_decision(p_revision uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
           WHEN r.id IS NULL THEN 'denied'
           WHEN r.source_mode = 'manual' THEN 'allowed_manual'
           WHEN phoenix_cn_policy.excel_read_restriction_state(r.organization_id) = 'inactive' THEN 'allowed_inactive'
           WHEN phoenix_cn_policy.actor_scope_org('central_needs.approve') = r.organization_id
             OR phoenix_cn_policy.actor_scope_org('central_needs.import') = r.organization_id THEN 'allowed_authorized'
           ELSE 'denied' END
    FROM (SELECT p_revision AS rid) q
    LEFT JOIN public.central_needs_plan_revisions r ON r.id = q.rid
$$;
REVOKE ALL ON FUNCTION phoenix_cn_policy.excel_history_decision(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION phoenix_cn_policy.excel_history_decision(uuid) TO authenticated;

CREATE FUNCTION phoenix_cn_policy.may_read_excel_history(p_revision uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT phoenix_cn_policy.excel_history_decision(p_revision) <> 'denied' $$;
REVOKE ALL ON FUNCTION phoenix_cn_policy.may_read_excel_history(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION phoenix_cn_policy.may_read_excel_history(uuid) TO authenticated;

CREATE FUNCTION phoenix_cn_policy.revision_of_session(p_session uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT s.plan_revision_id FROM public.central_needs_import_sessions s WHERE s.id = p_session $$;
REVOKE ALL ON FUNCTION phoenix_cn_policy.revision_of_session(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION phoenix_cn_policy.revision_of_session(uuid) TO authenticated;

CREATE FUNCTION phoenix_cn_policy.revision_of_need_line(p_line uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT n.plan_revision_id FROM public.central_needs_need_lines n WHERE n.id = p_line $$;
REVOKE ALL ON FUNCTION phoenix_cn_policy.revision_of_need_line(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION phoenix_cn_policy.revision_of_need_line(uuid) TO authenticated;

CREATE POLICY excel_history_read_restrictive ON public.central_needs_source_files AS RESTRICTIVE FOR SELECT
  USING (phoenix_cn_policy.may_read_excel_history(plan_revision_id));
CREATE POLICY excel_history_read_restrictive ON public.central_needs_source_records AS RESTRICTIVE FOR SELECT
  USING (phoenix_cn_policy.may_read_excel_history(phoenix_cn_policy.revision_of_session(import_session_id)));
CREATE POLICY excel_history_read_restrictive ON public.central_needs_field_overrides AS RESTRICTIVE FOR SELECT
  USING (phoenix_cn_policy.may_read_excel_history(plan_revision_id));
CREATE POLICY excel_history_read_restrictive ON public.central_needs_need_lines AS RESTRICTIVE FOR SELECT
  USING (phoenix_cn_policy.may_read_excel_history(plan_revision_id));
CREATE POLICY excel_history_read_restrictive ON public.central_needs_need_line_sources AS RESTRICTIVE FOR SELECT
  USING (phoenix_cn_policy.may_read_excel_history(phoenix_cn_policy.revision_of_need_line(need_line_id)));

-- F02 (Director review): the historical-source download path reads central_needs_import_batches AS THE CALLER and then
-- authorizes only central_needs.view before minting a signed URL. The batch row (storage_locator, container_sha256) and
-- its entries are therefore the gateway to the Excel bytes and carry the same D27 restriction. Still inert until a marker.
CREATE POLICY excel_history_read_restrictive ON public.central_needs_import_batches AS RESTRICTIVE FOR SELECT
  USING (phoenix_cn_policy.may_read_excel_history(plan_revision_id));
CREATE POLICY excel_history_read_restrictive ON public.central_needs_import_batch_entries AS RESTRICTIVE FOR SELECT
  USING (phoenix_cn_policy.may_read_excel_history(phoenix_cn_policy.revision_of_session(import_session_id)));

-- 5. Seal ACL manifest restated
--@@SEAL_FUNCTION@@

DO $verify$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_policy WHERE polname = 'excel_history_read_restrictive' AND NOT polpermissive AND polcmd = 'r') <> 7 THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a05): expected 7 excel_history_read_restrictive policies';
  END IF;
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a05): capability seal reports breaches: %',
      (SELECT string_agg(b, '; ') FROM phoenix_private.central_needs_capability_breaches_v1() AS b);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = 'phoenix_private.central_needs_excel_review_blockers_v1(uuid)'::regprocedure
               AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a05): the private Excel blockers function is reachable';
  END IF;
END
$verify$;

COMMIT;
