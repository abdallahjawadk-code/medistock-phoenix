-- ============================================================================
-- FF1 - R1 forward-fix package (D18, ADR 14.3). UNNUMBERED. NOT APPLIED anywhere. PROPOSAL FOR OWNER DECISION.
-- There are no down-migrations: R1-b (M229/M230) is irreversible except by a pre-authored, rig-tested forward-fix. This is that fix.
-- Its number is reserved only when the Owner decides to apply it (after R1-b is observed). It never edits M223-M230.
--
--  1. Re-revokes EXECUTE on the 18 manual / material-registration writers from `authenticated` (kill switch; activation markers,
--     inventory, events and withdrawals are NOT touched).
--  2. FF-05: an append-only, owner-only exception list of NAMED plan-revision ids. For a named, existing, DRAFT, source_mode='excel'
--     revision of an ACTIVATED organization it lets Excel intake rows (source file / import session / import batch) be inserted again.
--     It never lets a NEW Excel revision be created, never reopens an organization, and my_capabilities(org, NULL).excel_import_open
--     stays false: only my_capabilities(org, <named revision>).excel_import_open becomes true, which is what the W0 API gate reads.
--  3. Leaves phoenix_cn_policy.actor_scope_org (final body from M228) UNTOUCHED. No `super_admin` early return, no cross-org permit.
--     Staffing / grants are recovered only through the governed route public.assign_profile_permissions; no DML on profiles or
--     profile_permission_overrides here.
-- Order of use: Owner decision -> backup (D24) -> apply -> VERIFY (inside) -> owner-only exemption routine per named revision.
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
  IF to_regclass('phoenix_private.central_needs_excel_unfreeze_exceptions') IS NOT NULL THEN
    RAISE EXCEPTION 'FF1_precondition_failed: already applied';
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

-- 2. FF-05 named-revision exception list (append-only, owner-only)
CREATE TABLE phoenix_private.central_needs_excel_unfreeze_exceptions (
  plan_revision_id uuid PRIMARY KEY,                 -- validated by the owner-only routine (no foreign key: the R1 capability seal lists every relation that references plan revisions)
  organization_id  uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  reason           text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text NOT NULL DEFAULT current_user
);
ALTER TABLE phoenix_private.central_needs_excel_unfreeze_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE phoenix_private.central_needs_excel_unfreeze_exceptions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON phoenix_private.central_needs_excel_unfreeze_exceptions FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION phoenix_private.central_needs_unfreeze_exceptions_append_only_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'central_needs_unfreeze_exceptions_append_only' USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_unfreeze_exceptions_append_only_v1() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER central_needs_unfreeze_exceptions_append_only BEFORE UPDATE OR DELETE ON phoenix_private.central_needs_excel_unfreeze_exceptions
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_unfreeze_exceptions_append_only_v1();
CREATE TRIGGER central_needs_unfreeze_exceptions_no_truncate BEFORE TRUNCATE ON phoenix_private.central_needs_excel_unfreeze_exceptions
  FOR EACH STATEMENT EXECUTE FUNCTION phoenix_private.central_needs_unfreeze_exceptions_append_only_v1();

CREATE FUNCTION phoenix_private.central_needs_unfreeze_named_revision_v1(p_revision uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rev public.central_needs_plan_revisions%ROWTYPE;
BEGIN
  SELECT * INTO v_rev FROM public.central_needs_plan_revisions WHERE id = p_revision FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ff1_revision_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_rev.source_mode IS DISTINCT FROM 'excel' THEN RAISE EXCEPTION 'ff1_revision_not_excel' USING ERRCODE = '23514'; END IF;
  IF v_rev.status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'ff1_revision_not_draft' USING ERRCODE = '23514', DETAIL = v_rev.status; END IF;
  IF phoenix_cn_policy.excel_read_restriction_state(v_rev.organization_id) IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'ff1_organization_not_frozen' USING ERRCODE = '23514';
  END IF;
  INSERT INTO phoenix_private.central_needs_excel_unfreeze_exceptions (plan_revision_id, organization_id, reason) VALUES (v_rev.id, v_rev.organization_id, p_reason);
  RETURN jsonb_build_object('ok', true, 'plan_revision_id', v_rev.id, 'organization_id', v_rev.organization_id);
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_unfreeze_named_revision_v1(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- 3. freeze guard: identical to M229 except that, for a NAMED revision, Excel intake rows (not revisions) are admitted
CREATE OR REPLACE FUNCTION phoenix_private.central_needs_excel_freeze_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'central_needs_plan_revisions' THEN
    IF NEW.source_mode IS NOT DISTINCT FROM 'manual' THEN
      RETURN NEW;
    END IF;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(NEW.organization_id::text, 210002));
  IF phoenix_cn_policy.excel_read_restriction_state(NEW.organization_id) = 'active' THEN
    IF TG_TABLE_NAME <> 'central_needs_plan_revisions' THEN
      IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_excel_unfreeze_exceptions e
                  WHERE e.plan_revision_id = NEW.plan_revision_id AND e.organization_id = NEW.organization_id) THEN
        RETURN NEW;                          -- a NAMED revision only; a new Excel revision is never admitted
      END IF;
    END IF;
    RAISE EXCEPTION 'excel_intake_closed_after_activation' USING ERRCODE = '23514',
      DETAIL = format('organization=%s relation=%s', NEW.organization_id, TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END;
$$;

-- 3b. is Excel intake open for THIS named revision? (a boolean for an authorized viewer of the organization; read by my_capabilities)
CREATE FUNCTION phoenix_cn_policy.excel_unfreeze_open(p_org uuid, p_rev uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_rev IS NOT NULL
     AND phoenix_cn_policy.actor_scope_org('central_needs.view') = p_org
     AND EXISTS (SELECT 1 FROM phoenix_private.central_needs_excel_unfreeze_exceptions e
                   JOIN public.central_needs_plan_revisions r ON r.id = e.plan_revision_id
                  WHERE e.plan_revision_id = p_rev AND e.organization_id = p_org AND r.status = 'draft' AND r.source_mode = 'excel')
$$;
REVOKE ALL ON FUNCTION phoenix_cn_policy.excel_unfreeze_open(uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION phoenix_cn_policy.excel_unfreeze_open(uuid, uuid) TO authenticated;

-- 4. my_capabilities: the M229 body, with excel_import_open true for a named draft Excel revision only
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
         (phoenix_cn_policy.excel_read_restriction_state(p_organization_id) = 'inactive')
           OR COALESCE(phoenix_cn_policy.excel_unfreeze_open(p_organization_id, p_plan_revision_id), false),
         CASE WHEN p_plan_revision_id IS NULL THEN false ELSE phoenix_cn_policy.approve_excluded_for_caller(p_plan_revision_id) END
$$;

DO $verify$
BEGIN
  IF md5(pg_get_functiondef('phoenix_cn_policy.actor_scope_org(text)'::regprocedure)) IS DISTINCT FROM current_setting('ff1.actor_scope_org_md5', true) THEN
    RAISE EXCEPTION 'VERIFY FAILED (FF1): actor_scope_org changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proname IN ('central_needs_excel_freeze_guard_v1', 'central_needs_unfreeze_named_revision_v1')
              AND p.pronamespace = 'phoenix_private'::regnamespace AND pg_get_functiondef(p.oid) ~* ('super' || '_admin')) THEN
    RAISE EXCEPTION 'VERIFY FAILED (FF1): a replaced function carries a super-admin branch';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname ~ '^phoenix_central_needs_(open_manual|carry_forward|add_manual|correct_manual|void_manual|withdraw_draft|acknowledge_manual|create_material|update_material|submit_material|start_material|request_material|resolve_material|approve_new|reject_material|cancel_material|link_material)'
              AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'VERIFY FAILED (FF1): a manual / material writer is still executable by an API role';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgname LIKE '%\_r1\_05\_excel\_freeze') <> 4 THEN
    RAISE EXCEPTION 'VERIFY FAILED (FF1): expected 4 freeze triggers';
  END IF;
  IF has_table_privilege('authenticated', 'phoenix_private.central_needs_excel_unfreeze_exceptions', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_function_privilege('authenticated', 'phoenix_private.central_needs_unfreeze_named_revision_v1(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (FF1): the exception list or its routine is reachable by an API role';
  END IF;
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'VERIFY FAILED (FF1): capability seal reports breaches';
  END IF;
END
$verify$;

COMMIT;
