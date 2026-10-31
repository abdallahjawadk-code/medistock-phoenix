-- FF2: reviewed annual-dossier kill switch. UNNUMBERED, NOT APPLIED.
-- Supersedes FF1 after M232..235 matrix-v2 and the P1 reservation candidate.
-- Pins the sealed private implementation as well as all public entry points.
-- Revokes all 27 manual/material/intake entry points, including definer wrappers.
-- Leaves generic historical lifecycle APIs, read APIs, staffing, activation,
-- original evidence and Excel freeze untouched. No GRANT, DML, or new objects.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
DO $pre$
DECLARE actual text[]; r record; v_oid regprocedure;
BEGIN
 IF NOT coalesce((public.phoenix_central_needs_feature_contract()->>'workbook_matrix_v2')::boolean,false) THEN RAISE EXCEPTION 'FF2_precondition_failed: matrix-v2 required'; END IF;
 SELECT array_agg(sig ORDER BY sig COLLATE "C") INTO actual FROM (
  SELECT p.proname||'('||replace(oidvectortypes(p.proargtypes),', ',',')||')' sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname LIKE 'phoenix_central_needs_%')q;
 IF actual IS DISTINCT FROM ARRAY['phoenix_central_needs_abandon_import_session(uuid,text)',
   'phoenix_central_needs_acknowledge_manual_coverage(uuid,text,text)',
   'phoenix_central_needs_actor_authorized(uuid,text)',
   'phoenix_central_needs_add_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)',
   'phoenix_central_needs_annual_summary(uuid,integer)',
   'phoenix_central_needs_apply_authoritative_replay(uuid,text,jsonb,jsonb)',
   'phoenix_central_needs_apply_dossier_workbook_batch(uuid,integer)',
   'phoenix_central_needs_approve_material_with_code(uuid,integer,uuid[],text,text)',
   'phoenix_central_needs_approve_new_material(uuid,integer,uuid[],text)',
   'phoenix_central_needs_approve_revision(uuid)',
   'phoenix_central_needs_begin_dossier_workbook(uuid,text,text,text,jsonb,jsonb,jsonb,uuid)',
   'phoenix_central_needs_cancel_material_request(uuid,integer,text)',
   'phoenix_central_needs_carry_forward_manual_lines(uuid,uuid)',
   'phoenix_central_needs_correct_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)',
   'phoenix_central_needs_create_material_request_draft(uuid,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)',
   'phoenix_central_needs_create_material_request_with_code(uuid,text,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)',
   'phoenix_central_needs_delete_need_line(uuid,text,uuid[])',
   'phoenix_central_needs_dossier_lifecycle(uuid,integer,uuid)',
   'phoenix_central_needs_dossier_revisions(uuid)',
   'phoenix_central_needs_dossier_sources(uuid)',
   'phoenix_central_needs_download_dossier_source(uuid)',
   'phoenix_central_needs_feature_contract()',
   'phoenix_central_needs_import_dossier_workbook(uuid,text,text,text,jsonb)',
   'phoenix_central_needs_link_material_request_to_draft(uuid,uuid)',
   'phoenix_central_needs_list_beneficiary_columns(uuid)',
   'phoenix_central_needs_list_dossiers(uuid,integer)',
   'phoenix_central_needs_list_manual_need_events(uuid)',
   'phoenix_central_needs_list_material_request_events(uuid)',
   'phoenix_central_needs_list_material_requests(uuid)',
   'phoenix_central_needs_list_need_lines(uuid)',
   'phoenix_central_needs_material_request_candidates(uuid)',
   'phoenix_central_needs_material_request_code_candidates(uuid)',
   'phoenix_central_needs_my_capabilities(uuid,uuid)',
   'phoenix_central_needs_my_material_capabilities(uuid)',
   'phoenix_central_needs_open_correction_revision(uuid,integer,uuid,text)',
   'phoenix_central_needs_open_dossier(uuid,integer,text,text)',
   'phoenix_central_needs_open_dossier_correction(uuid,integer,uuid,text)',
   'phoenix_central_needs_open_manual_correction_revision(uuid,integer,uuid,text)',
   'phoenix_central_needs_open_manual_plan_revision(uuid,integer)',
   'phoenix_central_needs_open_plan_revision(uuid,integer,boolean)',
   'phoenix_central_needs_record_field_override(uuid,jsonb,text,text,text)',
   'phoenix_central_needs_register_import_batch(uuid,text,text,text,text,jsonb,jsonb,bigint,integer,jsonb)',
   'phoenix_central_needs_reject_material_request(uuid,integer,text)',
   'phoenix_central_needs_reject_revision(uuid,text)',
   'phoenix_central_needs_request_material_info(uuid,integer,text)',
   'phoenix_central_needs_resolve_material_existing(uuid,integer,uuid,text)',
   'phoenix_central_needs_resolve_material_existing_with_code(uuid,integer,uuid,text,text,boolean)',
   'phoenix_central_needs_review_readiness(uuid)',
   'phoenix_central_needs_revision_lifecycle(uuid,integer)',
   'phoenix_central_needs_set_beneficiary_columns(uuid,jsonb,text)',
   'phoenix_central_needs_set_beneficiary_regions(uuid,uuid,numeric,jsonb,text,uuid[],jsonb,text)',
   'phoenix_central_needs_set_need_line(uuid,uuid,uuid,numeric,text,jsonb,uuid[],text,text,uuid,text)',
   'phoenix_central_needs_set_record_disposition(uuid,text,text,uuid,text)',
   'phoenix_central_needs_set_record_mapping(uuid,text,uuid)',
   'phoenix_central_needs_start_import_entry_session(uuid,text,text,text,jsonb,bigint,text,text)',
   'phoenix_central_needs_start_import_session(uuid,text,text,text,jsonb,bigint,text)',
   'phoenix_central_needs_start_material_review(uuid,integer)',
   'phoenix_central_needs_submit_material_request(uuid,integer)',
   'phoenix_central_needs_submit_revision(uuid)',
   'phoenix_central_needs_update_material_request_draft(uuid,integer,text,text,text,text,text,text,text,text)',
   'phoenix_central_needs_update_material_request_with_code(uuid,integer,text,text,text,text,text,text,text,text,text)',
   'phoenix_central_needs_void_manual_need_line(uuid,uuid,uuid,uuid,text,text,uuid,text)',
   'phoenix_central_needs_withdraw_draft_revision(uuid,uuid,text,text)']::text[] THEN RAISE EXCEPTION 'FF2_precondition_failed: unexpected RPC census'; END IF;
 -- The extracted implementation is an internal writer, never an API bypass.
 v_oid:=to_regprocedure('phoenix_private.central_needs_add_manual_need_line_reserved_v1(boolean,uuid,uuid,uuid,uuid,text,text,text,uuid,text)');
 IF v_oid IS NULL OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid::oid) IS DISTINCT FROM '5bb5dad892e8316e7c3393d9d379d346' THEN
  RAISE EXCEPTION 'FF2_precondition_failed: private reservation writer body drift';
 END IF;
 IF EXISTS(SELECT 1 FROM (VALUES('anon'),('authenticated'),('service_role'))roles(who)
  WHERE has_function_privilege(roles.who,v_oid,'EXECUTE'))
 OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid=v_oid::oid AND a.grantee=0) THEN
  RAISE EXCEPTION 'FF2_precondition_failed: private reservation writer callable';
 END IF;
 FOR r IN SELECT * FROM (VALUES ('phoenix_central_needs_acknowledge_manual_coverage(uuid,text,text)','bf171c5b9ebf1e01ff26f0877f9ab33d'),
  ('phoenix_central_needs_add_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)','9bd3b60bb45b91c13ded442abe4294f4'),
  ('phoenix_central_needs_apply_dossier_workbook_batch(uuid,integer)','606b479f63c3a12f21b6e759e7707ce0'),
  ('phoenix_central_needs_approve_material_with_code(uuid,integer,uuid[],text,text)','a20b3dcda4b2c8992dae3aa42762e0fe'),
  ('phoenix_central_needs_approve_new_material(uuid,integer,uuid[],text)','e7253fd03ab578cd57c3ec96c70b9824'),
  ('phoenix_central_needs_begin_dossier_workbook(uuid,text,text,text,jsonb,jsonb,jsonb,uuid)','bf12f892ec397bda49b100a8dfdf4aa6'),
  ('phoenix_central_needs_cancel_material_request(uuid,integer,text)','2919c40c84dcabf347ec777e122c1598'),
  ('phoenix_central_needs_carry_forward_manual_lines(uuid,uuid)','565a5437c6f2d67ba8a956f850d4318d'),
  ('phoenix_central_needs_correct_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)','f371e6824c114e983df0a9b2c7736456'),
  ('phoenix_central_needs_create_material_request_draft(uuid,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)','86e8652d08d32b3ea3ff415c1b5fc66b'),
  ('phoenix_central_needs_create_material_request_with_code(uuid,text,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)','c84425b838b9f2323943180a957f8524'),
  ('phoenix_central_needs_import_dossier_workbook(uuid,text,text,text,jsonb)','809055bb346596d99efaf9674c1c4c93'),
  ('phoenix_central_needs_link_material_request_to_draft(uuid,uuid)','462c08dd2c7a7f4abc93d56cd955b659'),
  ('phoenix_central_needs_open_dossier(uuid,integer,text,text)','0568d4753aaf543f8555e86836c60e1d'),
  ('phoenix_central_needs_open_dossier_correction(uuid,integer,uuid,text)','a3809a94b8a8369e62e43c6e7abea53e'),
  ('phoenix_central_needs_open_manual_correction_revision(uuid,integer,uuid,text)','04a904bbea12f65b6e9088d15dc59cce'),
  ('phoenix_central_needs_open_manual_plan_revision(uuid,integer)','f5e6ba008262bfd6a8c9282687d4ca57'),
  ('phoenix_central_needs_reject_material_request(uuid,integer,text)','09bbf9719d01f879e844e14ddb904373'),
  ('phoenix_central_needs_request_material_info(uuid,integer,text)','b5afb8df3eb384f76360ba0a1c77d55e'),
  ('phoenix_central_needs_resolve_material_existing(uuid,integer,uuid,text)','f650fa911062c8a9a9210a42614b0365'),
  ('phoenix_central_needs_resolve_material_existing_with_code(uuid,integer,uuid,text,text,boolean)','d66dbfc322bf0d5a49982187b9a3eb61'),
  ('phoenix_central_needs_start_material_review(uuid,integer)','46d827a06e161f24e3f03e1a533b151b'),
  ('phoenix_central_needs_submit_material_request(uuid,integer)','30e3ea73087b1a976cabbe1f5970832d'),
  ('phoenix_central_needs_update_material_request_draft(uuid,integer,text,text,text,text,text,text,text,text)','3eb1d721edc185ffb9e2b4cb8bb53c6c'),
  ('phoenix_central_needs_update_material_request_with_code(uuid,integer,text,text,text,text,text,text,text,text,text)','208626de07de575d022ecaa9acc4d0cd'),
  ('phoenix_central_needs_void_manual_need_line(uuid,uuid,uuid,uuid,text,text,uuid,text)','d7d03c4118d0640fc48c8de9f57fc99d'),
  ('phoenix_central_needs_withdraw_draft_revision(uuid,uuid,text,text)','b6e71e1eb8c72fa41e05f2fae4c0e694'))expected(sig,body_md5) LOOP
  v_oid:=to_regprocedure('public.'||r.sig);
  IF v_oid IS NULL OR (SELECT md5(prosrc) FROM pg_proc WHERE pg_proc.oid=v_oid::oid) IS DISTINCT FROM r.body_md5 THEN RAISE EXCEPTION 'FF2_precondition_failed: body drift %',r.sig; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM (VALUES ('phoenix_central_needs_acknowledge_manual_coverage(uuid,text,text)','bf171c5b9ebf1e01ff26f0877f9ab33d'),
  ('phoenix_central_needs_add_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)','9bd3b60bb45b91c13ded442abe4294f4'),
  ('phoenix_central_needs_apply_dossier_workbook_batch(uuid,integer)','606b479f63c3a12f21b6e759e7707ce0'),
  ('phoenix_central_needs_approve_material_with_code(uuid,integer,uuid[],text,text)','a20b3dcda4b2c8992dae3aa42762e0fe'),
  ('phoenix_central_needs_approve_new_material(uuid,integer,uuid[],text)','e7253fd03ab578cd57c3ec96c70b9824'),
  ('phoenix_central_needs_begin_dossier_workbook(uuid,text,text,text,jsonb,jsonb,jsonb,uuid)','bf12f892ec397bda49b100a8dfdf4aa6'),
  ('phoenix_central_needs_cancel_material_request(uuid,integer,text)','2919c40c84dcabf347ec777e122c1598'),
  ('phoenix_central_needs_carry_forward_manual_lines(uuid,uuid)','565a5437c6f2d67ba8a956f850d4318d'),
  ('phoenix_central_needs_correct_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)','f371e6824c114e983df0a9b2c7736456'),
  ('phoenix_central_needs_create_material_request_draft(uuid,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)','86e8652d08d32b3ea3ff415c1b5fc66b'),
  ('phoenix_central_needs_create_material_request_with_code(uuid,text,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)','c84425b838b9f2323943180a957f8524'),
  ('phoenix_central_needs_import_dossier_workbook(uuid,text,text,text,jsonb)','809055bb346596d99efaf9674c1c4c93'),
  ('phoenix_central_needs_link_material_request_to_draft(uuid,uuid)','462c08dd2c7a7f4abc93d56cd955b659'),
  ('phoenix_central_needs_open_dossier(uuid,integer,text,text)','0568d4753aaf543f8555e86836c60e1d'),
  ('phoenix_central_needs_open_dossier_correction(uuid,integer,uuid,text)','a3809a94b8a8369e62e43c6e7abea53e'),
  ('phoenix_central_needs_open_manual_correction_revision(uuid,integer,uuid,text)','04a904bbea12f65b6e9088d15dc59cce'),
  ('phoenix_central_needs_open_manual_plan_revision(uuid,integer)','f5e6ba008262bfd6a8c9282687d4ca57'),
  ('phoenix_central_needs_reject_material_request(uuid,integer,text)','09bbf9719d01f879e844e14ddb904373'),
  ('phoenix_central_needs_request_material_info(uuid,integer,text)','b5afb8df3eb384f76360ba0a1c77d55e'),
  ('phoenix_central_needs_resolve_material_existing(uuid,integer,uuid,text)','f650fa911062c8a9a9210a42614b0365'),
  ('phoenix_central_needs_resolve_material_existing_with_code(uuid,integer,uuid,text,text,boolean)','d66dbfc322bf0d5a49982187b9a3eb61'),
  ('phoenix_central_needs_start_material_review(uuid,integer)','46d827a06e161f24e3f03e1a533b151b'),
  ('phoenix_central_needs_submit_material_request(uuid,integer)','30e3ea73087b1a976cabbe1f5970832d'),
  ('phoenix_central_needs_update_material_request_draft(uuid,integer,text,text,text,text,text,text,text,text)','3eb1d721edc185ffb9e2b4cb8bb53c6c'),
  ('phoenix_central_needs_update_material_request_with_code(uuid,integer,text,text,text,text,text,text,text,text,text)','208626de07de575d022ecaa9acc4d0cd'),
  ('phoenix_central_needs_void_manual_need_line(uuid,uuid,uuid,uuid,text,text,uuid,text)','d7d03c4118d0640fc48c8de9f57fc99d'),
  ('phoenix_central_needs_withdraw_draft_revision(uuid,uuid,text,text)','b6e71e1eb8c72fa41e05f2fae4c0e694'))expected(sig,body_md5) CROSS JOIN (VALUES('anon'),('authenticated'),('service_role'))roles(who)
  WHERE has_function_privilege(roles.who,to_regprocedure('public.'||expected.sig),'EXECUTE')) THEN RAISE EXCEPTION 'FF2_precondition_failed: already locked'; END IF;
 PERFORM set_config('ff2.actor_scope_md5',md5(pg_get_functiondef('phoenix_cn_policy.actor_scope_org(text)'::regprocedure)),true);
END $pre$;
DO $revoke$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES ('phoenix_central_needs_acknowledge_manual_coverage(uuid,text,text)','bf171c5b9ebf1e01ff26f0877f9ab33d'),
  ('phoenix_central_needs_add_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)','9bd3b60bb45b91c13ded442abe4294f4'),
  ('phoenix_central_needs_apply_dossier_workbook_batch(uuid,integer)','606b479f63c3a12f21b6e759e7707ce0'),
  ('phoenix_central_needs_approve_material_with_code(uuid,integer,uuid[],text,text)','a20b3dcda4b2c8992dae3aa42762e0fe'),
  ('phoenix_central_needs_approve_new_material(uuid,integer,uuid[],text)','e7253fd03ab578cd57c3ec96c70b9824'),
  ('phoenix_central_needs_begin_dossier_workbook(uuid,text,text,text,jsonb,jsonb,jsonb,uuid)','bf12f892ec397bda49b100a8dfdf4aa6'),
  ('phoenix_central_needs_cancel_material_request(uuid,integer,text)','2919c40c84dcabf347ec777e122c1598'),
  ('phoenix_central_needs_carry_forward_manual_lines(uuid,uuid)','565a5437c6f2d67ba8a956f850d4318d'),
  ('phoenix_central_needs_correct_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)','f371e6824c114e983df0a9b2c7736456'),
  ('phoenix_central_needs_create_material_request_draft(uuid,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)','86e8652d08d32b3ea3ff415c1b5fc66b'),
  ('phoenix_central_needs_create_material_request_with_code(uuid,text,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)','c84425b838b9f2323943180a957f8524'),
  ('phoenix_central_needs_import_dossier_workbook(uuid,text,text,text,jsonb)','809055bb346596d99efaf9674c1c4c93'),
  ('phoenix_central_needs_link_material_request_to_draft(uuid,uuid)','462c08dd2c7a7f4abc93d56cd955b659'),
  ('phoenix_central_needs_open_dossier(uuid,integer,text,text)','0568d4753aaf543f8555e86836c60e1d'),
  ('phoenix_central_needs_open_dossier_correction(uuid,integer,uuid,text)','a3809a94b8a8369e62e43c6e7abea53e'),
  ('phoenix_central_needs_open_manual_correction_revision(uuid,integer,uuid,text)','04a904bbea12f65b6e9088d15dc59cce'),
  ('phoenix_central_needs_open_manual_plan_revision(uuid,integer)','f5e6ba008262bfd6a8c9282687d4ca57'),
  ('phoenix_central_needs_reject_material_request(uuid,integer,text)','09bbf9719d01f879e844e14ddb904373'),
  ('phoenix_central_needs_request_material_info(uuid,integer,text)','b5afb8df3eb384f76360ba0a1c77d55e'),
  ('phoenix_central_needs_resolve_material_existing(uuid,integer,uuid,text)','f650fa911062c8a9a9210a42614b0365'),
  ('phoenix_central_needs_resolve_material_existing_with_code(uuid,integer,uuid,text,text,boolean)','d66dbfc322bf0d5a49982187b9a3eb61'),
  ('phoenix_central_needs_start_material_review(uuid,integer)','46d827a06e161f24e3f03e1a533b151b'),
  ('phoenix_central_needs_submit_material_request(uuid,integer)','30e3ea73087b1a976cabbe1f5970832d'),
  ('phoenix_central_needs_update_material_request_draft(uuid,integer,text,text,text,text,text,text,text,text)','3eb1d721edc185ffb9e2b4cb8bb53c6c'),
  ('phoenix_central_needs_update_material_request_with_code(uuid,integer,text,text,text,text,text,text,text,text,text)','208626de07de575d022ecaa9acc4d0cd'),
  ('phoenix_central_needs_void_manual_need_line(uuid,uuid,uuid,uuid,text,text,uuid,text)','d7d03c4118d0640fc48c8de9f57fc99d'),
  ('phoenix_central_needs_withdraw_draft_revision(uuid,uuid,text,text)','b6e71e1eb8c72fa41e05f2fae4c0e694'))expected(sig,body_md5) LOOP
  EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',to_regprocedure('public.'||r.sig));
 END LOOP;
END $revoke$;
DO $verify$
BEGIN
 IF EXISTS(SELECT 1 FROM (VALUES ('phoenix_central_needs_acknowledge_manual_coverage(uuid,text,text)','bf171c5b9ebf1e01ff26f0877f9ab33d'),
  ('phoenix_central_needs_add_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)','9bd3b60bb45b91c13ded442abe4294f4'),
  ('phoenix_central_needs_apply_dossier_workbook_batch(uuid,integer)','606b479f63c3a12f21b6e759e7707ce0'),
  ('phoenix_central_needs_approve_material_with_code(uuid,integer,uuid[],text,text)','a20b3dcda4b2c8992dae3aa42762e0fe'),
  ('phoenix_central_needs_approve_new_material(uuid,integer,uuid[],text)','e7253fd03ab578cd57c3ec96c70b9824'),
  ('phoenix_central_needs_begin_dossier_workbook(uuid,text,text,text,jsonb,jsonb,jsonb,uuid)','bf12f892ec397bda49b100a8dfdf4aa6'),
  ('phoenix_central_needs_cancel_material_request(uuid,integer,text)','2919c40c84dcabf347ec777e122c1598'),
  ('phoenix_central_needs_carry_forward_manual_lines(uuid,uuid)','565a5437c6f2d67ba8a956f850d4318d'),
  ('phoenix_central_needs_correct_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)','f371e6824c114e983df0a9b2c7736456'),
  ('phoenix_central_needs_create_material_request_draft(uuid,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)','86e8652d08d32b3ea3ff415c1b5fc66b'),
  ('phoenix_central_needs_create_material_request_with_code(uuid,text,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)','c84425b838b9f2323943180a957f8524'),
  ('phoenix_central_needs_import_dossier_workbook(uuid,text,text,text,jsonb)','809055bb346596d99efaf9674c1c4c93'),
  ('phoenix_central_needs_link_material_request_to_draft(uuid,uuid)','462c08dd2c7a7f4abc93d56cd955b659'),
  ('phoenix_central_needs_open_dossier(uuid,integer,text,text)','0568d4753aaf543f8555e86836c60e1d'),
  ('phoenix_central_needs_open_dossier_correction(uuid,integer,uuid,text)','a3809a94b8a8369e62e43c6e7abea53e'),
  ('phoenix_central_needs_open_manual_correction_revision(uuid,integer,uuid,text)','04a904bbea12f65b6e9088d15dc59cce'),
  ('phoenix_central_needs_open_manual_plan_revision(uuid,integer)','f5e6ba008262bfd6a8c9282687d4ca57'),
  ('phoenix_central_needs_reject_material_request(uuid,integer,text)','09bbf9719d01f879e844e14ddb904373'),
  ('phoenix_central_needs_request_material_info(uuid,integer,text)','b5afb8df3eb384f76360ba0a1c77d55e'),
  ('phoenix_central_needs_resolve_material_existing(uuid,integer,uuid,text)','f650fa911062c8a9a9210a42614b0365'),
  ('phoenix_central_needs_resolve_material_existing_with_code(uuid,integer,uuid,text,text,boolean)','d66dbfc322bf0d5a49982187b9a3eb61'),
  ('phoenix_central_needs_start_material_review(uuid,integer)','46d827a06e161f24e3f03e1a533b151b'),
  ('phoenix_central_needs_submit_material_request(uuid,integer)','30e3ea73087b1a976cabbe1f5970832d'),
  ('phoenix_central_needs_update_material_request_draft(uuid,integer,text,text,text,text,text,text,text,text)','3eb1d721edc185ffb9e2b4cb8bb53c6c'),
  ('phoenix_central_needs_update_material_request_with_code(uuid,integer,text,text,text,text,text,text,text,text,text)','208626de07de575d022ecaa9acc4d0cd'),
  ('phoenix_central_needs_void_manual_need_line(uuid,uuid,uuid,uuid,text,text,uuid,text)','d7d03c4118d0640fc48c8de9f57fc99d'),
  ('phoenix_central_needs_withdraw_draft_revision(uuid,uuid,text,text)','b6e71e1eb8c72fa41e05f2fae4c0e694'))expected(sig,body_md5) CROSS JOIN (VALUES('anon'),('authenticated'),('service_role'))roles(who)
  WHERE has_function_privilege(roles.who,to_regprocedure('public.'||expected.sig),'EXECUTE')) THEN RAISE EXCEPTION 'FF2_verify_failed: writer callable'; END IF;
 IF md5(pg_get_functiondef('phoenix_cn_policy.actor_scope_org(text)'::regprocedure)) IS DISTINCT FROM current_setting('ff2.actor_scope_md5',true) THEN RAISE EXCEPTION 'FF2_verify_failed: authority drift'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%\_r1\_05\_excel\_freeze')<>4
 OR (SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%\_r1\_06\_manual\_activation%')<5 THEN RAISE EXCEPTION 'FF2_verify_failed: freeze/activation drift'; END IF;
 IF EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN RAISE EXCEPTION 'FF2_verify_failed: capability seal'; END IF;
END $verify$;
COMMIT;
