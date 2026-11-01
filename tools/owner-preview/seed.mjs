import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

export function buildOwnerPreviewPolicy(context,reviewer,approvedAt=new Date().toISOString()) {
  const sha=value=>createHash('sha256').update(value).digest('hex');
  return {policyId:randomUUID(),version:1,fingerprint:'a'.repeat(64),status:'approved',context,
    unitStep:'0.25',eligibleMonths:[1,2,3,4,5,6,7,8,9,10,11,12],fixedMonths:[],basis:{beneficiaryOrganizationId:context.beneficiaryOrganizationId,
      documentReference:'Isolated test policy: quarter-box steps across all twelve test months',documentSha256:sha('r18 synthetic documented test policy'),
      periodReference:'Twelve explicitly eligible synthetic months',priorAllocationStatus:'none_verified',ledgerSnapshotSha256:sha('r18 verified empty synthetic allocation snapshot'),
      approvedById:reviewer,approvedByName:'ignored input; snapshot comes from the server',approvedAt}};
}

export function assertOwnerPreviewTarget(seed) {
  assert(process.env.CI==='true' && process.env.GITHUB_ACTIONS==='true');
  assert.equal(process.env.GITHUB_REPOSITORY,'abdallahjawadk-code/medistock-phoenix');
  const api=new URL(seed.supabaseUrl),database=new URL(seed.databaseUrl);
  assert.equal(api.href,'http://127.0.0.1:54321/');
  assert(['postgres:','postgresql:'].includes(database.protocol));assert.equal(database.hostname,'127.0.0.1');
  assert.equal(database.port,'54322');assert.equal(database.pathname,'/postgres');assert.equal(database.username,'postgres');
  assert.equal(database.search,'');assert.equal(database.hash,'');return {api,database};
}
/** Creates fresh synthetic data through real Auth and the unchanged employee RPCs. */
export async function seedOwnerPreview(seedPath,password) {
  assert(typeof password==='string' && password.length>=32 && password.length<=128);
  const seed=JSON.parse(readFileSync(seedPath,'utf8')), {api,database}=assertOwnerPreviewTarget(seed);
  const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();assert.equal(head,process.env.GITHUB_SHA);
  for(const [file,count] of [['monthly-ui/report.json',123],['c4-source-ui/report.json',139]]){
    const report=JSON.parse(readFileSync(`docs/phoenix/e2e-acceptance/${file}`,'utf8'));
    assert(report.passed && report.commit===head && report.checks.length===count && report.checks.every(row=>row.passed));
  }
  const anonKey=process.env.SUPABASE_ANON_KEY;assert(anonKey);
  assert.equal(JSON.parse(Buffer.from(anonKey.split('.')[1],'base64url').toString('utf8')).role,'anon');
  const serviceKey=readFileSync('/tmp/sb-service-role-key.txt','utf8').trim();
  const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
  const service=createClient(api.href,serviceKey,options),employee=createClient(api.href,anonKey,options);
  const db=new pg.Client({connectionString:database.href,connectionTimeoutMillis:5000});
  const owner=randomUUID(),beneficiary=randomUUID(),year=2026,email='r18-owner-preview@phoenix.invalid';
  try{
    await db.connect();const target=(await db.query('SELECT current_database() db,current_user actor,inet_server_port() port')).rows[0];
    assert.equal(target.db,'postgres');assert.equal(target.actor,'postgres');assert.equal(target.port,5432);
    await db.query(`INSERT INTO public.organizations(id,name,name_ar,code,organization_kind,institution_class,status) VALUES
      ($1,'Phoenix isolated preview PDA','جهة اختبار Phoenix المعزولة',$3,'pharmacy_department_authority',NULL,'active'),
      ($2,'Phoenix test hospital','مستشفى اختبار Phoenix',$4,'care_institution','hospital','active')`,[owner,beneficiary,`r18-owner-${owner}`,`r18-hospital-${beneficiary}`]);
    let actor, reviewer;
    for(const [mail,pass,name,keys] of [[email,password,'موظف اختبار Phoenix',['view','edit','manual_need.set','allocation.view']],
      [`r18-checker-${randomUUID()}@phoenix.invalid`,randomBytes(32).toString('base64url'),'مراجع اختبار Phoenix',['view','approve']]]){
      const result=await service.auth.admin.createUser({email:mail,password:pass,email_confirm:true});assert(!result.error && result.data.user?.id,'Isolated Auth account creation failed');
      const id=result.data.user.id;if(mail===email)actor=id;else reviewer=id;
      await db.query("UPDATE public.profiles SET organization_id=$2,role='warehouse_officer',status='active',full_name=$3 WHERE id=$1",[id,owner,name]);
      for(const key of keys)await db.query('INSERT INTO public.profile_permission_overrides(profile_id,permission_key,allowed) VALUES($1,$2,true)',[id,`central_needs.${key}`]);
    }
    const cutover=(await db.query('SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1) result',[owner])).rows[0].result;
    assert(cutover.ok===true,'Fresh isolated owner cutover refused');
    assert(!(await employee.auth.signInWithPassword({email,password})).error,'Actual isolated employee sign-in refused');
    const rpc=async(name,args)=>{const result=await employee.rpc(name,args);assert(!result.error,`Isolated employee RPC refused: ${name}`);return result.data;};
    const scope={p_organization_id:owner,p_planning_year:year};
    await rpc('phoenix_central_needs_open_catalog_year',{...scope,p_idempotency_key:`r18-open-${randomUUID()}`});
    const materials=[];
    for(const n of [1,2]){
      const nationalCode=`000-R18-${String(n).padStart(3,'0')}`,name=`Phoenix test material ${n}`;
      const canonical=(await db.query("INSERT INTO public.central_items(name,name_ar,unit,national_code,status) VALUES($1,$2,'box',$3,'active') RETURNING id",[name,`مادة اختبار Phoenix ${n}`,nationalCode])).rows[0].id;
      const preview=await rpc('phoenix_central_needs_preview_annual_canonical',{...scope,p_central_item_id:canonical});
      const result=await rpc('phoenix_central_needs_add_annual_catalog_item',{...scope,p_central_item_id:canonical,p_expected_canonical_fingerprint:preview.canonicalFingerprint,
        p_occurrences:[],p_reason:'Explicit synthetic identity for the isolated owner preview',p_idempotency_key:`r18-member-${randomUUID()}`});
      materials.push({canonical,name,nationalCode,annualItemId:result.membership.annualItemId,fieldVersionId:result.fieldVersion.fieldVersionId});
    }
    const first=materials[0];
    await db.query('SELECT phoenix_monthly.publish_reference_v1($1::jsonb,NULL,true)',[JSON.stringify(buildOwnerPreviewPolicy(
      {ownerOrgId:owner,planningYear:year,annualItemId:first.annualItemId,fieldVersionId:first.fieldVersionId,canonicalItemId:first.canonical,unit:'box',beneficiaryOrganizationId:beneficiary},reviewer))]);
    assert.equal((await db.query('SELECT count(*)::int n FROM public.central_needs_manual_need_events WHERE organization_id=$1',[owner])).rows[0].n,0);
    assert.equal((await db.query(`SELECT * FROM phoenix_private.central_needs_capability_breaches_v1() UNION ALL SELECT * FROM phoenix_c4.capability_breaches_v1()
      UNION ALL SELECT * FROM phoenix_r2.capability_breaches() UNION ALL SELECT * FROM phoenix_monthly.capability_breaches_v1()`)).rowCount,0);
    return {head,owner,beneficiary,year,email,userId:actor,materials,realAuth:true,syntheticDataOnly:true,productionSqlApplied:false};
  }finally{await employee.auth.signOut();await db.end();}
}
