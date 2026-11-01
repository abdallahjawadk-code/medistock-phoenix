-- R21 / NOT_APPLIED: year-to-year material IDENTITY only.
-- This is a review candidate, not an authorized migration or a verified production writer.
-- Requires accepted P3-A1 + P3-B, the original A1 helper body/seals, and independent
-- authenticated/hosted PG17/18 security, concurrency, negative, and compatibility proofs.
-- No need quantity, monthly allotment, SEND, RECEIVE, stock or old-year changes.
BEGIN;
DO $pre$
BEGIN
 IF to_regclass('public.central_needs_annual_items') IS NULL
 OR to_regclass('public.central_needs_annual_versions') IS NULL
 OR to_regclass('public.central_needs_annual_occurrences') IS NULL
 OR to_regclass('public.central_needs_annual_catalog_changes') IS NULL
 OR to_regprocedure('phoenix_private.annual_catalog_guard_v1(uuid,integer,boolean)') IS NULL
 OR to_regprocedure('phoenix_private.annual_catalog_write_item_v1(uuid,integer,uuid,uuid,uuid,text,jsonb,text)') IS NULL
 OR to_regprocedure('phoenix_private.annual_catalog_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text,uuid)') IS NULL
 OR to_regprocedure('phoenix_private.annual_catalog_replay_v1(uuid,integer,text,text,jsonb)') IS NULL
 THEN RAISE EXCEPTION 'R21_precondition_missing_P3A1_P3B' USING ERRCODE='P0002'; END IF;
END $pre$;

-- Separate names avoid mutating the historical central_needs_* manifest.
-- Never expose these tables through direct SELECT/DML to browser roles.
CREATE TABLE public.phoenix_year_rollover_source_approvals (
 organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
 source_year integer NOT NULL CHECK(source_year BETWEEN 2000 AND 2100),
 source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
 approved_by uuid NOT NULL,
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 approval_reason text NOT NULL CHECK(length(btrim(approval_reason)) BETWEEN 1 AND 2000),
 PRIMARY KEY(organization_id,source_year),
 FOREIGN KEY(organization_id,source_year)
   REFERENCES public.central_needs_catalog_years(organization_id,planning_year) ON DELETE RESTRICT
);
CREATE TABLE public.phoenix_year_rollover_links (
 organization_id uuid NOT NULL,
 target_year integer NOT NULL CHECK(target_year BETWEEN 2000 AND 2100),
 target_annual_item_id uuid NOT NULL,
 canonical_item_id uuid NOT NULL REFERENCES public.central_items(id) ON DELETE RESTRICT,
 source_year integer NOT NULL CHECK(source_year BETWEEN 2000 AND 2100),
 source_annual_item_id uuid NOT NULL,
 source_field_version_id uuid NOT NULL,
 source_canonical_fingerprint text NOT NULL CHECK(source_canonical_fingerprint ~ '^[0-9a-f]{64}$'),
 original_classifications jsonb NOT NULL
  CHECK(jsonb_typeof(original_classifications)='array' AND jsonb_array_length(original_classifications)>0),
 copied_by uuid NOT NULL,
 copied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,target_year,target_annual_item_id),
 UNIQUE(organization_id,target_year,canonical_item_id),
 CHECK(source_year < target_year),
 FOREIGN KEY(organization_id,target_year,target_annual_item_id)
   REFERENCES public.central_needs_annual_items(organization_id,planning_year,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,source_year,source_annual_item_id,source_field_version_id)
   REFERENCES public.central_needs_annual_versions(organization_id,planning_year,annual_item_id,id) ON DELETE RESTRICT
);

DO $bound$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['phoenix_year_rollover_source_approvals','phoenix_year_rollover_links'] LOOP
   EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
   EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',t);
   EXECUTE format('CREATE POLICY owner_scope_restrictive ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
     USING(organization_id=(SELECT phoenix_cn_policy.actor_scope_org(''central_needs.view'')))
     WITH CHECK(false)',t);
   EXECUTE format('CREATE TRIGGER rollover_append_only BEFORE UPDATE OR DELETE ON public.%I
     FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1()',t);
   EXECUTE format('CREATE TRIGGER rollover_no_truncate BEFORE TRUNCATE ON public.%I
     FOR EACH STATEMENT EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1()',t);
 END LOOP;
END $bound$;

-- Source snapshot includes ONLY membership/field-version and original classification
-- evidence. No annual/manual need, allocation, warehouse, price, lot or stock table.
-- Caller must first acquire a SHARE lock on the source year to freeze A1 membership writers.
CREATE FUNCTION phoenix_private.year_rollover_source_digest_v1(p_org uuid,p_year integer)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $digest$
 SELECT encode(sha256(convert_to(coalesce((
 SELECT jsonb_agg(jsonb_build_object(
  'item',i.id, 'canonical',i.central_item_id, 'status',i.status,
  'fieldVersion',i.current_field_version_id,
  'fingerprint',v.canonical_fingerprint, 'fields',v.fields,
  'classes',(SELECT coalesce(jsonb_agg(
      jsonb_build_object('id',o.id,'classification',o.classification)
      ORDER BY o.id),'[]'::jsonb)
      FROM public.central_needs_annual_occurrences o
     WHERE o.organization_id=i.organization_id AND o.planning_year=i.planning_year
       AND o.annual_item_id=i.id)
 ) ORDER BY i.central_item_id,i.id)::text
 FROM public.central_needs_annual_items i
 JOIN public.central_needs_annual_versions v
  ON v.organization_id=i.organization_id AND v.planning_year=i.planning_year
  AND v.annual_item_id=i.id AND v.id=i.current_field_version_id
 WHERE i.organization_id=p_org AND i.planning_year=p_year
 ),'[]'),'UTF8')),'hex')
$digest$;

-- This approval is an explicit approval of the IDENTITY source snapshot, distinct
-- from approval of need quantities; ordinary 'active' does not count as approval.
-- Existing central_needs.approve authorizes the checker, not the eventual copy.
CREATE FUNCTION public.phoenix_central_needs_approve_rollover_source(
 p_organization_id uuid,p_source_year integer,p_reason text,p_idempotency_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $approve$
DECLARE actor_role text; intent jsonb; previous jsonb; result jsonb;
        y public.central_needs_catalog_years%ROWTYPE; digest text;
BEGIN
 PERFORM phoenix_private.annual_catalog_guard_v1(p_organization_id,p_source_year,false);
 actor_role:=public._phoenix_central_needs_guard_v1(p_organization_id,'central_needs.approve');
 IF p_reason IS NULL THEN RAISE EXCEPTION 'rollover_approval_reason_required' USING ERRCODE='23514'; END IF;
 PERFORM phoenix_private.annual_catalog_reason_v1(p_reason);
 intent:=jsonb_build_object('organizationId',p_organization_id,'sourceYear',p_source_year,'reason',p_reason);
 previous:=phoenix_private.annual_catalog_replay_v1(p_organization_id,p_source_year,
     p_idempotency_key,'rollover_source_approval',intent);
 IF previous IS NOT NULL THEN RETURN previous; END IF;
 -- A1 writers take FOR UPDATE on this same year row; SHARE holds their updates.
 SELECT * INTO y FROM public.central_needs_catalog_years
  WHERE organization_id=p_organization_id AND planning_year=p_source_year FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'rollover_source_year_missing' USING ERRCODE='P0002'; END IF;
 -- Reject an empty or unreviewed source; all original identities need a checker.
 IF NOT EXISTS (SELECT 1 FROM public.central_needs_annual_items i
    WHERE i.organization_id=p_organization_id AND i.planning_year=p_source_year AND i.status='active')
    THEN RAISE EXCEPTION 'rollover_source_no_active_identity' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM public.central_needs_annual_items i
     JOIN public.central_needs_annual_versions v ON v.organization_id=i.organization_id
       AND v.planning_year=i.planning_year AND v.annual_item_id=i.id AND v.id=i.current_field_version_id
     WHERE i.organization_id=p_organization_id AND i.planning_year=p_source_year
       AND (i.created_by=auth.uid() OR v.created_by=auth.uid()))
    THEN RAISE EXCEPTION 'rollover_source_maker_checker_conflict' USING ERRCODE='42501'; END IF;
 -- A subsequent same-year source edit invalidates this digest; the copier fails
 -- closed. A re-approval is a future separately governed versioned workflow.
 IF EXISTS(SELECT 1 FROM public.phoenix_year_rollover_source_approvals
     WHERE organization_id=p_organization_id AND source_year=p_source_year)
    THEN RAISE EXCEPTION 'rollover_source_already_approved' USING ERRCODE='23505'; END IF;
 digest:=phoenix_private.year_rollover_source_digest_v1(p_organization_id,p_source_year);
 INSERT INTO public.phoenix_year_rollover_source_approvals
   (organization_id,source_year,source_digest,approved_by,approval_reason)
   VALUES (p_organization_id,p_source_year,digest,auth.uid(),p_reason);
 result:=jsonb_build_object('scope',jsonb_build_object('ownerOrgId',p_organization_id,
    'planningYear',p_source_year),'sourceDigest',digest,'approvalStatus','identity_source_approved');
 RETURN phoenix_private.annual_catalog_receipt_v1(p_organization_id,p_source_year,p_idempotency_key,
    'rollover_source_approval',intent,result,actor_role,NULL);
END $approve$;

CREATE FUNCTION public.phoenix_central_needs_rollover_catalog_page(
 p_organization_id uuid,p_target_year integer,p_source_year integer,
 p_after_canonical_id uuid,p_limit integer,p_reason text,p_idempotency_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $carry$
DECLARE role_name text; intent jsonb; previous jsonb; result jsonb;
        y public.central_needs_catalog_years%ROWTYPE;
        source_item public.central_needs_annual_items%ROWTYPE;
        v public.central_needs_annual_versions%ROWTYPE;
        legal jsonb; classes jsonb; approval_digest text; snapshot_digest text;
        target_item uuid; field text; oldstate jsonb; legaltext text;
        source_count integer; valid_sources integer; processed integer:=0;
        created jsonb:='[]'::jsonb; held jsonb:='[]'::jsonb;
        last_id uuid:=NULL; next_after uuid:=NULL; reason_code text;
BEGIN
 IF p_target_year IS NULL OR p_source_year IS NULL
    OR p_source_year>=p_target_year OR p_source_year<2000 OR p_target_year>2100
    THEN RAISE EXCEPTION 'rollover_year_scope_invalid' USING ERRCODE='23514'; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
    THEN RAISE EXCEPTION 'rollover_page_limit_invalid' USING ERRCODE='23514'; END IF;
 PERFORM phoenix_private.annual_catalog_reason_v1(p_reason);
 -- The target-version reason includes an immutable source reference prefix.
 IF length(p_reason)>1700 THEN
   RAISE EXCEPTION 'rollover_reason_too_long' USING ERRCODE='23514';
 END IF;
 role_name:=phoenix_private.annual_catalog_guard_v1(p_organization_id,p_target_year,true);
 PERFORM phoenix_private.annual_catalog_guard_v1(p_organization_id,p_source_year,false);
 intent:=jsonb_build_object('organizationId',p_organization_id,'targetYear',p_target_year,
     'sourceYear',p_source_year,'afterCanonicalId',p_after_canonical_id,'limit',p_limit,'reason',p_reason);
 previous:=phoenix_private.annual_catalog_replay_v1(p_organization_id,p_target_year,
     p_idempotency_key,'year_rollover_page',intent);
 IF previous IS NOT NULL THEN RETURN previous; END IF;
 -- Same advisory namespace as P3-A1 open-year, prevents interleaving same-owner
 -- target-year pages and other A1 writers' target-year row lock.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_target_year::text,310002));
 y:=phoenix_private.annual_catalog_year_v1(p_organization_id,p_target_year,true);
 PERFORM 1 FROM public.central_needs_catalog_years
  WHERE organization_id=p_organization_id AND planning_year=p_source_year FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'rollover_source_year_missing' USING ERRCODE='P0002'; END IF;
 SELECT source_digest INTO approval_digest FROM public.phoenix_year_rollover_source_approvals
    WHERE organization_id=p_organization_id AND source_year=p_source_year FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'rollover_source_unapproved' USING ERRCODE='42501'; END IF;
 snapshot_digest:=phoenix_private.year_rollover_source_digest_v1(p_organization_id,p_source_year);
 IF snapshot_digest<>approval_digest THEN
   RAISE EXCEPTION 'rollover_source_approval_stale' USING ERRCODE='23514'; END IF;
 -- A newer independently approved annual catalog supersedes an older source.
 IF EXISTS(SELECT 1 FROM public.phoenix_year_rollover_source_approvals a
    WHERE a.organization_id=p_organization_id AND a.source_year>p_source_year
      AND a.source_year<p_target_year)
   THEN RAISE EXCEPTION 'rollover_source_not_latest_approved' USING ERRCODE='23514'; END IF;

 FOR source_item IN SELECT * FROM public.central_needs_annual_items i
    WHERE i.organization_id=p_organization_id AND i.planning_year=p_source_year
      AND (p_after_canonical_id IS NULL OR i.central_item_id>p_after_canonical_id)
    ORDER BY i.central_item_id LIMIT p_limit+1 FOR SHARE
 LOOP
   IF processed=p_limit THEN next_after:=last_id; EXIT; END IF;
   processed:=processed+1; last_id:=source_item.central_item_id; reason_code:=NULL;
   SELECT * INTO v FROM public.central_needs_annual_versions v0
    WHERE v0.organization_id=p_organization_id AND v0.planning_year=p_source_year
      AND v0.annual_item_id=source_item.id AND v0.id=source_item.current_field_version_id FOR SHARE;
   IF NOT FOUND THEN reason_code:='source_version_missing'; END IF;
   IF source_item.status<>'active' THEN reason_code:='source_not_active'; END IF;
   IF reason_code IS NULL THEN
     legal:=phoenix_private.annual_catalog_canonical_v1(source_item.central_item_id,true);
     IF legal IS NULL OR legal->>'status'<>'active'
       THEN reason_code:='canonical_inactive';
     ELSIF phoenix_private.annual_catalog_hash_v1(legal)<>v.canonical_fingerprint
       THEN reason_code:='canonical_drift';
     ELSIF cardinality(phoenix_private.annual_catalog_missing_v1(legal))>0
       THEN reason_code:='canonical_identity_incomplete';
     ELSE
       -- A legal human edit in the source year may differ from canonical.
       -- NEVER mislabel that value as inherited canonical provenance.
       FOREACH field IN ARRAY ARRAY['scientificName','nameAr','nationalCode',
               'barcode','dosageForm','concentration','unit'] LOOP
         oldstate:=v.fields->field; legaltext:=legal->>field;
         IF (oldstate->>'state'='known' AND oldstate->>'value' IS NOT DISTINCT FROM legaltext)
           OR (oldstate->>'state'='missing' AND NULLIF(legaltext,'') IS NULL)
           THEN CONTINUE; END IF;
         reason_code:='source_fields_need_legal_review'; EXIT;
       END LOOP;
     END IF;
   END IF;
   SELECT count(*)::integer,
       count(*) FILTER(WHERE jsonb_typeof(o.classification)='object'
         AND o.classification->>'origin'='source'
         AND NULLIF(btrim(o.classification->>'label'),'') IS NOT NULL
         AND NULLIF(btrim(o.classification->>'reference'),'') IS NOT NULL)::integer,
       coalesce(jsonb_agg(DISTINCT o.classification) FILTER(
          WHERE o.classification IS NOT NULL),'[]'::jsonb)
     INTO source_count,valid_sources,classes
     FROM public.central_needs_annual_occurrences o
    WHERE o.organization_id=p_organization_id AND o.planning_year=p_source_year
      AND o.annual_item_id=source_item.id;
   IF reason_code IS NULL AND (source_count=0 OR source_count<>valid_sources)
      THEN reason_code:='source_classification_unreviewed'; END IF;
   IF reason_code IS NULL AND EXISTS (SELECT 1 FROM public.central_needs_annual_catalog_changes x
      WHERE x.organization_id=p_organization_id AND x.planning_year=p_source_year
      AND x.to_field_version_id=v.id AND cardinality(x.requires_legal_review)>0)
      THEN reason_code:='source_legal_review_pending'; END IF;
   IF reason_code IS NULL AND EXISTS (SELECT 1 FROM public.central_needs_annual_items x
     WHERE x.organization_id=p_organization_id AND x.planning_year=p_target_year
       AND x.central_item_id=source_item.central_item_id)
      THEN reason_code:='target_already_contains_material'; END IF;
   IF reason_code IS NOT NULL THEN
     held:=held||jsonb_build_array(jsonb_build_object('sourceAnnualItemId',source_item.id,
       'canonicalItemId',source_item.central_item_id,'reason',reason_code));
     CONTINUE;
   END IF;
   -- Existing tested P3-A1 helper is the ONLY central_needs_annual_* writer used.
   target_item:=phoenix_private.annual_catalog_write_item_v1(p_organization_id,p_target_year,
      NULL,source_item.central_item_id,NULL,v.canonical_fingerprint,'[]'::jsonb,
      'Identity-only rollover from '||p_source_year::text||'/'||source_item.id::text||'/'||v.id::text||': '||p_reason);
   INSERT INTO public.phoenix_year_rollover_links(organization_id,target_year,target_annual_item_id,
      canonical_item_id,source_year,source_annual_item_id,source_field_version_id,
      source_canonical_fingerprint,original_classifications,copied_by)
    VALUES (p_organization_id,p_target_year,target_item,source_item.central_item_id,
       p_source_year,source_item.id,v.id,v.canonical_fingerprint,classes,auth.uid());
   created:=created||jsonb_build_array(jsonb_build_object('sourceAnnualItemId',source_item.id,
      'targetAnnualItemId',target_item,'canonicalItemId',source_item.central_item_id));
 END LOOP;
 result:=jsonb_build_object('scope',jsonb_build_object('ownerOrgId',p_organization_id,
      'planningYear',p_target_year),'sourceYear',p_source_year,
     'carried',created,'held',held,'nextAfterCanonicalItemId',next_after);
 RETURN phoenix_private.annual_catalog_receipt_v1(p_organization_id,p_target_year,
    p_idempotency_key,'year_rollover_page',intent,result,role_name,NULL);
END $carry$;

-- No direct SELECT/DML access; only existing authorized employee JWT can call
-- the two exact bounded RPCs. Service-role keys NEVER appear in client code.
REVOKE ALL ON FUNCTION phoenix_private.year_rollover_source_digest_v1(uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_approve_rollover_source(uuid,integer,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_rollover_catalog_page(uuid,integer,integer,uuid,integer,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_approve_rollover_source(uuid,integer,text,text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_rollover_catalog_page(uuid,integer,integer,uuid,integer,text,text)
  TO authenticated;

DO $verify$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['phoenix_year_rollover_source_approvals','phoenix_year_rollover_links'] LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
     WHERE c.oid=pg_catalog.to_regclass('public.'||t)
       AND c.relrowsecurity AND c.relforcerowsecurity) THEN
      RAISE EXCEPTION 'R21_RLS_not_forced: %',t; END IF;
   IF pg_catalog.has_table_privilege('authenticated','public.'||t,'SELECT')
     OR pg_catalog.has_table_privilege('anon','public.'||t,'SELECT')
     OR pg_catalog.has_table_privilege('service_role','public.'||t,'INSERT')
     THEN RAISE EXCEPTION 'R21_direct_access_breach: %',t; END IF;
 END LOOP;
 IF pg_catalog.has_function_privilege('anon',
    'public.phoenix_central_needs_rollover_catalog_page(uuid,integer,integer,uuid,integer,text,text)','EXECUTE')
   OR pg_catalog.has_function_privilege('service_role',
    'public.phoenix_central_needs_approve_rollover_source(uuid,integer,text,text)','EXECUTE')
   THEN RAISE EXCEPTION 'R21_RPC_ACL_breach'; END IF;
END $verify$;
COMMIT;