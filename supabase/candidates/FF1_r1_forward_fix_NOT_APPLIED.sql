-- ============================================================================
-- FF1 - R1 forward-fix package (D18, ADR 14.3): KILL-SWITCH ONLY. UNNUMBERED. NOT APPLIED anywhere. PROPOSAL FOR OWNER DECISION.
-- There are no down-migrations: R1-b (M229/M230) is irreversible except by a pre-authored, rig-tested forward-fix. This is that fix, deliberately minimal.
-- Its number is reserved only when the Owner decides to apply it (after R1-b is observed). It never edits M223-M230.
--
--  1. Re-revokes EXECUTE on the 18 manual / material-registration writers from every API role.
--     Activation markers, the cutover inventory, manual events, withdrawals, acknowledgements and attestations are NOT touched.
--  2. Leaves phoenix_cn_policy.actor_scope_org (final body from M228) UNTOUCHED, adds no permission and no grant: no cross-organization
--     permit and no administrator branch. Staffing is recovered only through the governed route public.assign_profile_permissions.
--  3. Does NOT restore Excel ingestion in any form. The Excel freeze triggers (M229) and the activation markers stay exactly as they are.
--     The earlier idea of an owner-only "named draft Excel revision" exception (historical FF-05) was withdrawn: under the real M229 gate an
--     activated organization cannot retain an Excel draft/submitted revision, so that path is not reachable in a normal Production sequence.
--     Any exceptional Excel unfreeze is a separate product-policy / Production decision with its own independent review (see FF1-PLAN.md).
-- Order of use: Owner decision -> backup + isolated restore proof (D24) -> apply -> VERIFY (inside).
-- ============================================================================
BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('phoenix_private.central_needs_activate_manual_cutover_v1(uuid)') IS NULL
     OR to_regprocedure('phoenix_private.central_needs_excel_freeze_guard_v1()') IS NULL THEN
    RAISE EXCEPTION 'FF1_precondition_failed: R1-b (M229) must be applied first';
  END IF;
  IF to_regprocedure('phoenix_cn_policy.actor_scope_org(text)') IS NULL THEN
    RAISE EXCEPTION 'FF1_precondition_failed: phoenix_cn_policy.actor_scope_org(text) is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                  AND p.proname ~ '^phoenix_central_needs_(open_manual|add_manual)'
                  AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'FF1_precondition_failed: the manual writers are not executable by authenticated (already locked down or never opened)';
  END IF;
  -- the final actor_scope_org must stay byte-identical: remember its definition for the closing VERIFY
  PERFORM set_config('ff1.actor_scope_org_md5', md5(pg_get_functiondef('phoenix_cn_policy.actor_scope_org(text)'::regprocedure)), true);
END
$pre$;

-- 1. kill switch: the manual and material-registration writers are callable by the owner only again
DO $rev$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig
             FROM pg_catalog.pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname ~ '^phoenix_central_needs_(open_manual|carry_forward|add_manual|correct_manual|void_manual|withdraw_draft|acknowledge_manual|create_material|update_material|submit_material|start_material|request_material|resolve_material|approve_new|reject_material|cancel_material|link_material)'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', r.sig);
  END LOOP;
END
$rev$;

DO $verify$
BEGIN
  IF md5(pg_get_functiondef('phoenix_cn_policy.actor_scope_org(text)'::regprocedure)) IS DISTINCT FROM current_setting('ff1.actor_scope_org_md5', true) THEN
    RAISE EXCEPTION 'VERIFY FAILED (FF1): actor_scope_org changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname ~ '^phoenix_central_needs_(open_manual|carry_forward|add_manual|correct_manual|void_manual|withdraw_draft|acknowledge_manual|create_material|update_material|submit_material|start_material|request_material|resolve_material|approve_new|reject_material|cancel_material|link_material)'
              AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'VERIFY FAILED (FF1): a manual / material writer is still executable by an API role';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgname LIKE '%\_r1\_05\_excel\_freeze') <> 4 THEN
    RAISE EXCEPTION 'VERIFY FAILED (FF1): the 4 Excel freeze triggers must remain';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgname LIKE '%\_r1\_06\_manual\_activation%') < 5 THEN
    RAISE EXCEPTION 'VERIFY FAILED (FF1): the manual activation guard triggers (at least the 5 of M229) must remain';
  END IF;
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'VERIFY FAILED (FF1): capability seal reports breaches';
  END IF;
END
$verify$;

COMMIT;
