-- LOCAL CANDIDATE ONLY. Owner-approved extension of manual entry, not the old
-- verified Excel pipeline. Parsed selections are HUMAN CONFIRMED assertions;
-- original bytes/hash and the complete captured write plan are kept verbatim.
BEGIN;

-- Bind every replaced authority routine to the exact predecessor body. A drift
-- refuses the whole transaction; no live function is silently overwritten.
DO $authority_pre$
DECLARE r record; actual text; matches integer;
BEGIN
 FOR r IN SELECT * FROM (VALUES
      ('public.phoenix_central_needs_feature_contract','b7478934ded2998f78a12c31c4de051a'),
      ('phoenix_private.central_needs_capability_breaches_v1','fe56867edf8c15e7c47778b159e9dc42')
 ) expected(name,body_md5) LOOP
   SELECT count(*), min(md5(p.prosrc)) INTO matches,actual
   FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname=split_part(r.name,'.',1) AND p.proname=split_part(r.name,'.',2);
   IF matches<>1 OR actual IS DISTINCT FROM r.body_md5 THEN
     RAISE EXCEPTION 'M235_authority_precondition_failed: %',r.name;
   END IF;
 END LOOP;
END $authority_pre$;

DO $pre$ BEGIN
 IF to_regprocedure('public.phoenix_central_needs_open_dossier(uuid,integer,text,text)') IS NULL
    OR to_regclass('public.central_needs_dossier_intakes') IS NOT NULL THEN
   RAISE EXCEPTION 'M235_precondition_failed';
 END IF;
END $pre$;

ALTER TABLE public.central_needs_plan_revisions ADD CONSTRAINT central_needs_revision_plan_org_key UNIQUE (id,plan_id,organization_id);
CREATE TABLE public.central_needs_dossier_intakes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 plan_id uuid NOT NULL,
 plan_revision_id uuid NOT NULL,
 filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255 AND filename !~ '[/\\[:cntrl:]]'),
 file_hash text NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
 original_bytes bytea NOT NULL CHECK (octet_length(original_bytes) BETWEEN 1 AND 3145728),
 write_plan jsonb NOT NULL CHECK (jsonb_typeof(write_plan)='array' AND jsonb_array_length(write_plan) BETWEEN 1 AND 100),
 intent_hash text NOT NULL,
 event_ids uuid[] NOT NULL,
 actor_id uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (plan_id, file_hash),
 FOREIGN KEY (plan_id, organization_id) REFERENCES public.central_needs_plans(id, organization_id),
 FOREIGN KEY (plan_revision_id,plan_id,organization_id) REFERENCES public.central_needs_plan_revisions(id,plan_id,organization_id),
 CHECK (encode(sha256(original_bytes), 'hex') = file_hash),
 CHECK (cardinality(event_ids)=jsonb_array_length(write_plan))
);
ALTER TABLE public.central_needs_dossier_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_needs_dossier_intakes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.central_needs_dossier_intakes FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY r1_actor_scope_restrictive ON public.central_needs_dossier_intakes AS RESTRICTIVE FOR SELECT TO authenticated
 USING (phoenix_cn_policy.actor_scope_org('central_needs.view')=organization_id);
CREATE TRIGGER dossier_intakes_immutable BEFORE UPDATE OR DELETE ON public.central_needs_dossier_intakes
 FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1();
CREATE TRIGGER dossier_intakes_no_truncate BEFORE TRUNCATE ON public.central_needs_dossier_intakes
 FOR EACH STATEMENT EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1();

CREATE FUNCTION public.phoenix_central_needs_import_dossier_workbook(
 p_revision_id uuid, p_filename text, p_file_hash text, p_original_base64 text, p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 r public.central_needs_plan_revisions%ROWTYPE;
 p public.central_needs_plans%ROWTYPE;
 old public.central_needs_dossier_intakes%ROWTYPE;
 source_bytes bytea;
 intent text;
 entry jsonb;
 result jsonb;
 ids uuid[] := ARRAY[]::uuid[];
 intake_id uuid;
 item_unit text;
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN
   RAISE EXCEPTION 'manual_requires_read_committed' USING ERRCODE='25000';
 END IF;
 SELECT * INTO r FROM public.central_needs_plan_revisions WHERE id=p_revision_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE='P0002'; END IF;
 PERFORM public._phoenix_central_needs_guard_v1(r.organization_id, 'central_needs.view');
 PERFORM public._phoenix_central_needs_guard_v1(r.organization_id, 'central_needs.manual_need.set');
 p := phoenix_private.central_needs_lock_plan_id_v1(r.plan_id);
 SELECT * INTO r FROM public.central_needs_plan_revisions WHERE id=p_revision_id;
 IF p.dossier_key='' THEN RAISE EXCEPTION 'named_dossier_required' USING ERRCODE='23514'; END IF;
 IF p_filename IS NULL OR char_length(p_filename) NOT BETWEEN 1 AND 255 OR p_filename ~ '[/\\[:cntrl:]]'
    OR p_file_hash IS NULL OR p_file_hash !~ '^[0-9a-f]{64}$'
    OR p_original_base64 IS NULL OR char_length(p_original_base64)>4194304
    OR p_rows IS NULL OR jsonb_typeof(p_rows)<>'array'
    OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 100 THEN
   RAISE EXCEPTION 'dossier_intake_invalid' USING ERRCODE='23514';
 END IF;
 source_bytes := decode(p_original_base64, 'base64');
 IF octet_length(source_bytes) NOT BETWEEN 1 AND 3145728 OR encode(sha256(source_bytes),'hex')<>p_file_hash THEN
   RAISE EXCEPTION 'dossier_intake_hash_mismatch' USING ERRCODE='23514';
 END IF;
 intent := encode(sha256(convert_to(jsonb_build_array(p_revision_id,p_filename,p_file_hash,p_rows)::text,'UTF8')),'hex');
 SELECT * INTO old FROM public.central_needs_dossier_intakes WHERE plan_id=r.plan_id AND file_hash=p_file_hash;
 IF FOUND THEN
   IF old.intent_hash<>intent OR old.actor_id IS DISTINCT FROM auth.uid() THEN
     RAISE EXCEPTION 'dossier_file_already_imported' USING ERRCODE='23505';
   END IF;
   RETURN jsonb_build_object('ok',true,'idempotent_replay',true,'intake_id',old.id,'rows',cardinality(old.event_ids));
 END IF;
 PERFORM public._phoenix_central_needs_assert_draft_v1(r.id,r.status);
 IF r.source_mode<>'manual' THEN RAISE EXCEPTION 'manual_revision_required' USING ERRCODE='23514'; END IF;
 -- A physical row is selected once, and a business scope is never auto-summed.
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) e GROUP BY e->>'sheet',e->>'row' HAVING count(*)>1)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) e GROUP BY e->>'beneficiary_id',e->>'item_id' HAVING count(*)>1) THEN
   RAISE EXCEPTION 'dossier_duplicate_selection' USING ERRCODE='23505';
 END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
   IF jsonb_typeof(entry)<>'object' OR (entry - ARRAY['sheet','row','quantity_column','name_column','code_column','unit_column','item_id','beneficiary_id','quantity_text','unit','source_name','source_code'])<>'{}'::jsonb
      OR jsonb_typeof(entry->'quantity_text') IS DISTINCT FROM 'string'
      OR COALESCE(entry->>'sheet','') !~ '^[0-9]{1,3}$'
      OR COALESCE(entry->>'row','') !~ '^[1-9][0-9]{0,6}$'
      OR COALESCE(entry->>'quantity_column','') !~ '^[0-9]{1,5}$'
      OR (entry->>'sheet')::integer>199 OR (entry->>'row')::integer>1048576
      OR (entry->>'quantity_column')::integer>16383
      OR COALESCE(entry->>'name_column','') !~ '^[0-9]{1,5}$' OR COALESCE(entry->>'unit_column','') !~ '^[0-9]{1,5}$'
      OR (entry->>'name_column')::integer>16383 OR (entry->>'unit_column')::integer>16383
      OR (entry->>'code_column' IS NOT NULL AND (entry->>'code_column' !~ '^[0-9]{1,5}$' OR (entry->>'code_column')::integer>16383)) THEN
     RAISE EXCEPTION 'dossier_intake_row_invalid' USING ERRCODE='23514';
   END IF;
   SELECT unit INTO item_unit FROM public.central_items WHERE id=(entry->>'item_id')::uuid AND status='active';
   IF NOT FOUND OR item_unit IS DISTINCT FROM entry->>'unit' THEN
     RAISE EXCEPTION 'manual_line_unit_mismatch' USING ERRCODE='23514';
   END IF;
   IF entry->>'source_code' IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM public.central_items WHERE id=(entry->>'item_id')::uuid AND national_code=entry->>'source_code') THEN
     RAISE EXCEPTION 'national_code_assignment_conflict' USING ERRCODE='23514';
   END IF;
   result := public.phoenix_central_needs_add_manual_need_line(r.id,(entry->>'beneficiary_id')::uuid,
     (entry->>'item_id')::uuid,NULL,entry->>'quantity_text',
     'Human-confirmed workbook selection', 'intake:' || intent || ':' || cardinality(ids)::text,
     NULL, 'workbook:' || p_file_hash);
   ids := array_append(ids,(result->>'event_id')::uuid);
 END LOOP;
 INSERT INTO public.central_needs_dossier_intakes(organization_id,plan_id,plan_revision_id,filename,file_hash,
   original_bytes,write_plan,intent_hash,event_ids,actor_id)
 VALUES(r.organization_id,r.plan_id,r.id,p_filename,p_file_hash,source_bytes,p_rows,intent,ids,auth.uid()) RETURNING id INTO intake_id;
 INSERT INTO public.audit_logs(organization_id,actor_id,actor_role,action,entity_type,entity_id,payload)
 VALUES(r.organization_id,auth.uid(),public._phoenix_central_needs_guard_v1(r.organization_id,'central_needs.manual_need.set'),
   'central_needs.dossier.workbook_intake','central_needs_dossier_intake',intake_id,
   jsonb_build_object('plan_revision_id',r.id,'file_hash',p_file_hash,'rows',cardinality(ids),'source_authority','human_confirmed'));
 RETURN jsonb_build_object('ok',true,'idempotent_replay',false,'intake_id',intake_id,'rows',cardinality(ids));
END $$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_import_dossier_workbook(uuid,text,text,text,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_import_dossier_workbook(uuid,text,text,text,jsonb) TO authenticated;

CREATE FUNCTION public.phoenix_central_needs_dossier_sources(p_plan_id uuid)
RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE org uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE='28000'; END IF;
 SELECT organization_id INTO org FROM public.central_needs_plans WHERE id=p_plan_id
   AND organization_id=phoenix_cn_policy.actor_scope_org('central_needs.view');
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE='42501'; END IF;
 PERFORM public._phoenix_central_needs_guard_v1(org,'central_needs.view');
 RETURN QUERY SELECT jsonb_build_object('id',id,'filename',filename,'file_hash',file_hash,'revision_id',plan_revision_id,
   'rows',cardinality(event_ids),'actor_id',actor_id,'created_at',created_at)
 FROM public.central_needs_dossier_intakes WHERE plan_id=p_plan_id ORDER BY created_at,id;
END $$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_dossier_sources(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_dossier_sources(uuid) TO authenticated;

CREATE FUNCTION public.phoenix_central_needs_download_dossier_source(p_intake_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE s public.central_needs_dossier_intakes%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE='28000'; END IF;
 SELECT * INTO s FROM public.central_needs_dossier_intakes WHERE id=p_intake_id
   AND organization_id=phoenix_cn_policy.actor_scope_org('central_needs.view');
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE='42501'; END IF;
 PERFORM public._phoenix_central_needs_guard_v1(s.organization_id,'central_needs.view');
 RETURN jsonb_build_object('filename',s.filename,'file_hash',s.file_hash,'base64',encode(s.original_bytes,'base64'),
                          'write_plan',s.write_plan,'event_ids',s.event_ids,'source_authority','human_confirmed');
END $$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_download_dossier_source(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_download_dossier_source(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_feature_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('national_code',true,'same_actor_manual',true,'dossiers',true,'workbook_intake',true)
$$;

-- The complete seal is restated below by the candidate assembly, with exactly
-- this relation and these three RPCs added. No old manifest member is removed.

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
           ('central_needs_material_requests'), ('central_needs_material_request_events'), ('central_needs_material_request_links'), ('central_needs_dossier_intakes')
  ),
  cn AS (
    SELECT c.oid, c.relowner, n.nspname, c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE (n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central\_needs\_%')
        OR (n.nspname = 'phoenix_private' AND c.relname = 'central_needs_lifecycle_attestations')
  ),
  acl_manifest(sig) AS (
    VALUES ('public.phoenix_central_needs_import_dossier_workbook(uuid,text,text,text,jsonb)'),
           ('public.phoenix_central_needs_dossier_sources(uuid)'),
           ('public.phoenix_central_needs_download_dossier_source(uuid)'),
           ('public.phoenix_central_needs_open_dossier_correction(uuid,integer,uuid,text)'),
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
