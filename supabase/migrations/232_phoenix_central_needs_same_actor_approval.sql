-- LOCAL CANDIDATE ONLY. No Production apply is authorized by this file.
-- Forward migration: historical 001..231 are immutable.
BEGIN;

-- Bind every replaced authority routine to the exact predecessor body. A drift
-- refuses the whole transaction; no live function is silently overwritten.
DO $authority_pre$
DECLARE r record; actual text; matches integer;
BEGIN
 FOR r IN SELECT * FROM (VALUES
      ('phoenix_private.central_needs_sod_excluded_v1','1b179e1da2075816a072c1f6a9935167'),
      ('phoenix_private.central_material_assert_reviewer_v1','75f420c1cf7b80d2bffdb07609ee7b76'),
      ('phoenix_private.central_needs_staffing_readiness_v1','401791829f66ce810a1cb77cedf5aa5a')
 ) expected(name,body_md5) LOOP
   SELECT count(*), min(md5(p.prosrc)) INTO matches,actual
   FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname=split_part(r.name,'.',1) AND p.proname=split_part(r.name,'.',2);
   IF matches<>1 OR actual IS DISTINCT FROM r.body_md5 THEN
     RAISE EXCEPTION 'M232_authority_precondition_failed: %',r.name;
   END IF;
 END LOOP;
END $authority_pre$;
-- Owner amendment: same actor is permitted for MANUAL Central Needs and material review
-- only with each existing effective capability. Excel withdrawal, stock SoD, lifecycle
-- attestations, RLS and audit identities remain unchanged. No grant/default is added.
DO $pre$
BEGIN
 IF to_regprocedure('phoenix_private.central_material_assert_reviewer_v1(uuid,uuid,uuid,boolean)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.central_needs_material_requests'::regclass
                   AND conname = 'central_needs_material_requests_sod_chk') THEN
   RAISE EXCEPTION 'M232_precondition_failed';
 END IF;
END $pre$;
ALTER TABLE public.central_needs_material_requests DROP CONSTRAINT central_needs_material_requests_sod_chk;
CREATE OR REPLACE FUNCTION phoenix_private.central_needs_sod_excluded_v1(p_plan_revision_id uuid, p_actor uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_actor IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.central_needs_plan_revisions r
                 WHERE r.id = p_plan_revision_id AND r.source_mode = 'excel')
    AND (
       EXISTS (SELECT 1 FROM public.central_needs_plan_revisions r WHERE r.id = p_plan_revision_id AND r.created_by = p_actor)
    OR EXISTS (SELECT 1 FROM public.central_needs_manual_need_events e WHERE e.plan_revision_id = p_plan_revision_id AND e.actor_id = p_actor)
    OR EXISTS (SELECT 1 FROM phoenix_private.central_needs_lifecycle_attestations a
                WHERE a.plan_revision_id = p_plan_revision_id AND a.phase = 'submit' AND a.actor_id = p_actor)
    OR EXISTS (SELECT 1 FROM public.central_needs_manual_coverage_acknowledgements k
                WHERE k.plan_revision_id = p_plan_revision_id AND k.actor_id = p_actor)
    OR (phoenix_cn_policy.excel_sod_enabled()
        AND (EXISTS (SELECT 1 FROM public.central_needs_need_lines n WHERE n.plan_revision_id = p_plan_revision_id AND n.mapped_by = p_actor)
          OR EXISTS (SELECT 1 FROM public.central_needs_need_line_sources s
                       JOIN public.central_needs_need_lines n ON n.id = s.need_line_id
                      WHERE n.plan_revision_id = p_plan_revision_id AND s.linked_by = p_actor))));
$$;

CREATE OR REPLACE FUNCTION phoenix_private.central_material_assert_reviewer_v1(p_org uuid, p_requester uuid, p_assigned uuid, p_require_assigned boolean)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000'; END IF;
  IF phoenix_cn_policy.material_reviewer_org() IS DISTINCT FROM p_org THEN
    RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE = '42501', DETAIL = 'permission=central_needs.material_review';
  END IF;
  IF p_require_assigned AND p_assigned IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'material_request_not_assigned_reviewer' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION phoenix_private.central_needs_staffing_readiness_v1(p_org uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH members AS (
    SELECT p.id,
           COALESCE(public.phoenix_profile_has_permission(p.id, 'central_needs.view'), false)            AS v,
           COALESCE(public.phoenix_profile_has_permission(p.id, 'central_needs.edit'), false)            AS e,
           COALESCE(public.phoenix_profile_has_permission(p.id, 'central_needs.manual_need.set'), false) AS m,
           COALESCE(public.phoenix_profile_has_permission(p.id, 'central_needs.approve'), false)         AS a
      FROM public.profiles p
      JOIN public.organizations o ON o.id = p.organization_id
     WHERE p.organization_id = p_org
       AND p.status = 'active'
       AND o.organization_kind = 'pharmacy_department_authority'
       AND o.archived_at IS NULL
  ),
  makers AS (SELECT id FROM members WHERE v AND e AND m),
  checkers AS (SELECT id FROM members WHERE v AND a)
  SELECT jsonb_build_object(
           'organization_id', p_org,
           'active_members', (SELECT count(*) FROM members),
           'makers', (SELECT count(*) FROM makers),
           'checkers', (SELECT count(*) FROM checkers),
           'ready', EXISTS (SELECT 1 FROM makers mk CROSS JOIN checkers ck))
$$;
DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'central_needs_capability_seal_breached';
  END IF;
END $verify$;
COMMIT;
