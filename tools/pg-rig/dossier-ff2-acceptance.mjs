/** Actual ACL refusals, not an asserted writer count. Shared native / WASM cases. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {ANNUAL_FIXTURE} from './annual-dossier-acceptance.mjs';
const candidate=(name)=>readFileSync(fileURLToPath(new URL('../../supabase/candidates/'+name,import.meta.url)),'utf8');
export function dossierForwardFixCases(driver) {
 const ff2=candidate('FF2_r1_dossiers_forward_fix_NOT_APPLIED.sql');
 const ff1=candidate('FF1_r1_forward_fix_NOT_APPLIED.sql');
 const privateWriter='phoenix_private.central_needs_add_manual_need_line_reserved_v1(boolean,uuid,uuid,uuid,uuid,text,text,text,uuid,text)';
 const signatures=[...new Set([...ff2.matchAll(/\('(phoenix_central_needs_[^']+)','[0-9a-f]{32}'\)/g)].map((m)=>m[1]))];
 assert.equal(signatures.length,27);
 const value=async(sql,args=[]) => (await driver.admin(sql,args))[0];
 const callable=async()=> (await value(`SELECT count(*)::int n FROM unnest($1::text[])sig WHERE has_function_privilege('authenticated',to_regprocedure('public.'||sig),'EXECUTE')`,[signatures])).n;
 const dataDigest=async()=>{
  const tables=await driver.admin("SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'central_needs_%' OR tablename IN('central_items','profiles','profile_permission_overrides','role_permission_defaults','audit_logs')) ORDER BY tablename");
  const result={};for(const {tablename}of tables) result[tablename]=(await value(`SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) d FROM public.${tablename} t`)).d;
  return result;
 };
 return [
  {name:'FF2: original FF1 is preserved and demonstrably misses six current definer entry points',run:async()=>{
   assert.equal(await callable(),27);
   const counterfactual=ff1.replace(/COMMIT;\s*$/,`DO $probe$ DECLARE n integer; BEGIN
    SELECT count(*) INTO n FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN(
     'phoenix_central_needs_approve_material_with_code','phoenix_central_needs_open_dossier',
     'phoenix_central_needs_open_dossier_correction','phoenix_central_needs_import_dossier_workbook',
     'phoenix_central_needs_begin_dossier_workbook','phoenix_central_needs_apply_dossier_workbook_batch')
    AND has_function_privilege('authenticated',oid,'EXECUTE');
    IF n<>6 THEN RAISE EXCEPTION 'FF1_counterfactual_expected_six_unrevoked'; END IF;
   END $probe$; ROLLBACK;`);
   assert.notEqual(counterfactual,ff1);await driver.script(counterfactual);assert.equal(await callable(),27);
  }},
  {name:'FF2: an unlisted RPC fails closed before any revoke',run:async()=>{
   await driver.admin('CREATE FUNCTION public.phoenix_central_needs_unlisted_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$');
   await assert.rejects(()=>driver.script(ff2),/FF2_precondition_failed: unexpected RPC census/);
   await driver.admin('DROP FUNCTION public.phoenix_central_needs_unlisted_probe()');assert.equal(await callable(),27);
  }},
  {name:'FF2: a same-signature body drift is refused without changing ACLs',run:async()=>{
   const sig='public.phoenix_central_needs_open_dossier(uuid,integer,text,text)';
   const original=(await value('SELECT pg_get_functiondef($1::regprocedure) d',[sig])).d;
   const altered=original.replace(/(AS \$function\$)/,'$1\n-- Rig-only counterexample: source drift\n');
   assert.notEqual(altered,original);await driver.admin(altered);
   await assert.rejects(()=>driver.script(ff2),/FF2_precondition_failed: body drift/);
   await driver.admin(original);assert.equal(await callable(),27);
  }},
  {name:'P1/FF2: the private writer cannot be called by API roles and body drift is refused before any revoke',run:async()=>{
   for(const role of ['anon','authenticated','service_role']){
    assert.equal((await value('SELECT has_function_privilege($1,$2::regprocedure,\'EXECUTE\') allowed',[role,privateWriter])).allowed,false);
    await assert.rejects(()=>driver.asRole(role,ANNUAL_FIXTURE.actor,'SELECT phoenix_private.central_needs_add_manual_need_line_reserved_v1(true,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)'),/permission denied/);
   }
   const original=(await value('SELECT pg_get_functiondef($1::regprocedure) d',[privateWriter])).d;
   const altered=original.replace(/(AS \$function\$)/,'$1\n-- Rig-only private writer body drift\n');
   assert.notEqual(altered,original);
   try{
    await driver.admin(altered);
    await assert.rejects(()=>driver.script(ff2),/FF2_precondition_failed: private reservation writer body drift/);
    assert.equal(await callable(),27);
   }finally{await driver.admin(original);}
  }},
  {name:'P1/FF2: an authenticated grant to the private writer is detected by both the seal and containment precondition',run:async()=>{
   try{
    await driver.admin(`GRANT EXECUTE ON FUNCTION ${privateWriter} TO authenticated`);
    const breaches=await driver.admin('SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()');
    assert.ok(breaches.some((row)=>Object.values(row).includes('private workbook reservation writer is executable by authenticated')));
    await assert.rejects(()=>driver.script(ff2),/FF2_precondition_failed: private reservation writer callable/);
    assert.equal(await callable(),27);
   }finally{await driver.admin(`REVOKE ALL ON FUNCTION ${privateWriter} FROM authenticated`);}
   assert.equal((await value('SELECT count(*)::int n FROM phoenix_private.central_needs_capability_breaches_v1()')).n,0);
  }},
  {name:'FF2: all 27 entry points reject actual calls from every API role, with evidence and staffing unchanged',run:async()=>{
   const before=await dataDigest();const scope=(await value("SELECT md5(pg_get_functiondef('phoenix_cn_policy.actor_scope_org(text)'::regprocedure)) d")).d;
   const summary=await driver.as(ANNUAL_FIXTURE.actor,'SELECT * FROM public.phoenix_central_needs_annual_summary($1,$2)',[ANNUAL_FIXTURE.org,2029]);
   await driver.script(ff2);assert.equal(await callable(),0);
   for(const signature of signatures){
    const name=signature.slice(0,signature.indexOf('(')); const types=signature.slice(signature.indexOf('(')+1,-1).split(',').filter(Boolean);
    const sql=`SELECT public.${name}(${types.map((type)=>'NULL::'+type).join(',')})`;
    for(const role of ['anon','authenticated','service_role']) await assert.rejects(()=>driver.asRole(role,ANNUAL_FIXTURE.actor,sql),/permission denied for function/);
   }
   assert.deepEqual(await dataDigest(),before);
   assert.equal((await value("SELECT md5(pg_get_functiondef('phoenix_cn_policy.actor_scope_org(text)'::regprocedure)) d")).d,scope);
   assert.deepEqual(await driver.as(ANNUAL_FIXTURE.actor,'SELECT * FROM public.phoenix_central_needs_annual_summary($1,$2)',[ANNUAL_FIXTURE.org,2029]),summary);
   assert.equal((await value('SELECT count(*)::int n FROM phoenix_private.central_needs_capability_breaches_v1()')).n,0);
   await assert.rejects(()=>driver.script(ff2),/FF2_precondition_failed: already locked/);
  }},
 ];
}
