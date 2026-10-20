-- MIGRATION 230 (R1-b 02). D9 CLOSED: numbered from supabase/candidates/R1b_02_material_registration_activation_NOT_APPLIED.sql WITHOUT any change to the SQL below.
-- The bytes after this prelude are exactly the candidate (SHA-256 71e87396f8a254c96980b26165520cc8054154fe1f43db5c43ccf91143315786) that Staging already carries in its ledger;
-- wording below that says "PLACEHOLDER", "NOT part of the numbered chain" or "D9 open" predates this numbering and is superseded by this prelude.
-- ============================================================================
-- R1-b CANDIDATE 02 — material-registration activation (NOT APPLIED; PROPOSAL FOR OWNER DECISION)
-- PLACEHOLDER (no migration number; D9 open, M5: no M222 reservation). Requires R1a_01..R1a_06 and R1b_01.
-- Distinct from R1-a: this is the step that makes the ten registration writers callable by `authenticated`. The GLOBAL grant is
-- NOT an activation: every registration DML re-checks, for the ROW's own organization, that the manual-intake activation marker
-- exists (same fail-closed guard function as R1b_01). No marker / a marker of ANOTHER organization / any error => refused.
-- Final key strings (Q-K) and who may run the cutover (Q-W0) remain owner decisions; this file decides neither.
-- ============================================================================
BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.central_needs_material_requests') IS NULL
     OR to_regprocedure('phoenix_private.central_needs_manual_activation_guard_v1()') IS NULL THEN
    RAISE EXCEPTION 'R1b02_precondition_failed: R1a_01..06 and R1b_01 must be applied first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgname = 'central_needs_material_requests_r1_06_manual_activation') THEN
    RAISE EXCEPTION 'R1b02_precondition_failed: already applied';
  END IF;
END
$pre$;

CREATE TRIGGER central_needs_material_requests_r1_06_manual_activation BEFORE INSERT ON public.central_needs_material_requests
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_manual_activation_guard_v1();
CREATE TRIGGER central_needs_material_requests_r1_06_manual_activation_status BEFORE UPDATE OF status ON public.central_needs_material_requests
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_manual_activation_guard_v1();
CREATE TRIGGER central_needs_material_request_links_r1_06_manual_activation BEFORE INSERT ON public.central_needs_material_request_links
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_manual_activation_guard_v1();

GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_create_material_request_draft(uuid, text, text, text, text, text, text, text, text, text, jsonb, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_update_material_request_draft(uuid, integer, text, text, text, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_submit_material_request(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_start_material_review(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_request_material_info(uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_resolve_material_existing(uuid, integer, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_approve_new_material(uuid, integer, uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_reject_material_request(uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_cancel_material_request(uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_link_material_request_to_draft(uuid, uuid) TO authenticated;

DO $verify$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgname LIKE 'central\_needs\_material\_request%\_r1\_06\_manual\_activation%') <> 3 THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1b02): expected 3 material-registration activation guard triggers';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
              WHERE ns.nspname = 'public' AND p.proname ~ '^phoenix_central_needs_(create_material_request_draft|update_material_request_draft|submit_material_request|start_material_review|request_material_info|resolve_material_existing|approve_new_material|reject_material_request|cancel_material_request|link_material_request_to_draft)$'
                AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE')
                     OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a WHERE a.grantee = 0))) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1b02): a registration writer is executable by PUBLIC, anon or service_role';
  END IF;
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1b02): capability seal reports breaches';
  END IF;
END
$verify$;

COMMIT;
