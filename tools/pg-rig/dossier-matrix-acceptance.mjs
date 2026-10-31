/** Shared PostgreSQL behavior cases. WASM runs must not claim native concurrency parity. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ANNUAL_FIXTURE} from './annual-dossier-acceptance.mjs';
export function dossierMatrixCases(driver) {
 const {org,actor,outsider,hospital}=ANNUAL_FIXTURE;
 const hospital2='80000000-0000-4000-8000-000000000004';
 const rpc=async(user,name,args=[]) => (await driver.as(user,`SELECT public.phoenix_central_needs_${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS r`,args))[0].r;
 const val=async(sql,args=[]) => (await driver.admin(sql,args))[0].n;
 const s={}; const year=2029;
 const source=Buffer.from('Human-confirmed matrix fixture. Original bytes preserved, not independently parsed by SQL.');
 const hash=createHash('sha256').update(source).digest('hex');
 const confirmation={format:'matrix-v2',plan_year:year,year_confirmed:true,regions:[{sheet:0,quantity:9,beneficiaryId:hospital}]};
 const row=(item,i=0,overrides={})=>({sheet:0,row:i+4,quantity_column:9,name_column:1,code_column:0,unit_column:2,source_name:'Matrix reagent '+i,source_code:'MATRIX-'+i,source_unit:' TEST ',unit:'test',quantity_text:i===0?'11520':'0',item_id:item,beneficiary_id:hospital,...overrides});
 const begin=(rows,op,meta=confirmation,bytes=source) => rpc(actor,'begin_dossier_workbook',[s.revision,'matrix.csv',createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(rows),'[]',JSON.stringify(meta),op]);
 const snapshot=async()=>({events:await val('SELECT count(*)::int n FROM public.central_needs_manual_need_events WHERE plan_revision_id=$1',[s.revision]),receipts:await val('SELECT count(*)::int n FROM public.central_needs_dossier_receipts b JOIN public.central_needs_dossier_intakes i ON i.id=b.intake_id WHERE i.plan_revision_id=$1',[s.revision]),captures:await val('SELECT count(*)::int n FROM public.central_needs_dossier_intakes WHERE plan_revision_id=$1',[s.revision])});
 return [
  {name:'matrix: capture 105 cells without writing needs and block premature submission',run:async()=>{
   await driver.admin("INSERT INTO public.organizations(id,name,name_ar,code,organization_kind,institution_class) VALUES($1,'Matrix second hospital','مستشفى مصفوفة ثان','matrix-h2','care_institution','hospital') ON CONFLICT DO NOTHING",[hospital2]);
   s.items=await driver.admin("INSERT INTO public.central_items(name,name_ar,unit,status,national_code) SELECT 'Matrix cell '||n,'مادة مصفوفة '||n,'test','active','MATRIX-'||(n-1) FROM generate_series(1,105)n RETURNING id,national_code");
   s.items.sort((a,b)=>Number(a.national_code.slice(7))-Number(b.national_code.slice(7)));
   s.rows=s.items.map((item,i)=>row(item.id,i));
   const opened=await rpc(actor,'open_dossier',[org,year,'matrix','المصفوفة']); s.plan=opened.plan_id;s.revision=opened.plan_revision_id;
   s.capture=await begin(s.rows,'90000000-0000-4000-8000-000000000001');
   assert.equal(s.capture.rows,105); assert.deepEqual(await snapshot(),{events:0,receipts:0,captures:1});
   await assert.rejects(()=>driver.admin("UPDATE public.central_needs_plan_revisions SET status='submitted' WHERE id=$1",[s.revision]),/central_needs_submission_gate_missing/);
   await assert.rejects(()=>rpc(outsider,'begin_dossier_workbook',[s.revision,'other.csv',hash,source.toString('base64'),JSON.stringify(s.rows),'[]',JSON.stringify(confirmation),'90000000-0000-4000-8000-000000000099']),/forbidden_central_needs/);
  }},
  {name:'matrix: first 100-row receipt is atomic, replayable and still blocks submission',run:async()=>{
   const result=await rpc(actor,'apply_dossier_workbook_batch',[s.capture.intake_id,0]); assert.equal(result.rows,100);assert.equal(result.complete,false);
   assert.deepEqual(await snapshot(),{events:100,receipts:1,captures:1});
   assert.equal((await rpc(actor,'apply_dossier_workbook_batch',[s.capture.intake_id,0])).idempotent_replay,true);
   await assert.rejects(()=>rpc(actor,'submit_revision',[s.revision]),/dossier_intake_incomplete/);
   assert.deepEqual(await snapshot(),{events:100,receipts:1,captures:1});
   await assert.rejects(()=>rpc(actor,'apply_dossier_workbook_batch',[s.capture.intake_id,1]),/dossier_batch_offset_invalid/);
  }},
  {name:'matrix: final 5-row receipt completes exactly once and preserves source evidence',run:async()=>{
   const result=await rpc(actor,'apply_dossier_workbook_batch',[s.capture.intake_id,100]); assert.equal(result.rows,5);assert.equal(result.complete,true);
   assert.equal((await rpc(actor,'apply_dossier_workbook_batch',[s.capture.intake_id,100])).idempotent_replay,true);
   assert.deepEqual(await snapshot(),{events:105,receipts:2,captures:1});
   const src=await rpc(actor,'download_dossier_source',[s.capture.intake_id]);assert.equal(Buffer.from(src.base64,'base64').toString(),source.toString()); assert.deepEqual(src.write_plan,s.rows);assert.deepEqual(src.confirmation,confirmation);assert.equal(src.event_ids.length,105);
  }},
  {name:'matrix: one file can supply another institution column; the same physical cell cannot be rebound',run:async()=>{
   const r=row(s.items[0].id,0,{quantity_column:10,beneficiary_id:hospital2,quantity_text:'240'});
   const second=await begin([r],'90000000-0000-4000-8000-000000000002');
   await rpc(actor,'apply_dossier_workbook_batch',[second.intake_id,0]);
   assert.equal(await val('SELECT count(*)::int n FROM public.central_needs_dossier_documents WHERE plan_id=$1',[s.plan]),1);
   const before=await snapshot();
   await assert.rejects(()=>begin([row(s.items[0].id,0,{beneficiary_id:hospital2})],'90000000-0000-4000-8000-000000000003'),/dossier_duplicate_selection/);
   await assert.rejects(()=>begin([r],'90000000-0000-4000-8000-000000000004',confirmation,Buffer.from('different file')),/dossier_duplicate_selection/);
   assert.deepEqual(await snapshot(),before);
  }},
  {name:'matrix: operation ID replays only identical intent and refuses year, unit, code or quantity coercion',run:async()=>{
   assert.equal((await begin(s.rows,'90000000-0000-4000-8000-000000000001')).idempotent_replay,true);
   await assert.rejects(()=>begin([s.rows[0]],'90000000-0000-4000-8000-000000000001'),/dossier_intake_operation_conflict/);
   const tests=[{source_unit:'kit'},{source_code:123},{quantity_text:11520},{sheet:'00'}];
   for(const bad of tests) await assert.rejects(()=>begin([row(s.items[0].id,0,bad)],'90000000-0000-4000-8000-000000000005'),/unit_mismatch|requires_text|row_invalid/);
   await assert.rejects(()=>begin([s.rows[0]],'90000000-0000-4000-8000-000000000005',{...confirmation,plan_year:2025}),/dossier_intake_invalid/);
  }},
  {name:'matrix: complete capture can be submitted and approved by a separately authorized same actor',run:async()=>{
   await rpc(actor,'submit_revision',[s.revision]);await rpc(actor,'approve_revision',[s.revision]);
   const summary=await driver.as(actor,'SELECT * FROM public.phoenix_central_needs_annual_summary($1,$2)',[org,year]);
   assert.equal(summary.length,106); const amounts=summary.map((v)=>Object.values(v)[0]);
   assert.ok(amounts.some((v)=>v.quantity_text==='11520' && v.beneficiary_id===hospital));assert.ok(amounts.some((v)=>v.quantity_text==='240' && v.beneficiary_id===hospital2));
  }},
  {name:'matrix: an invalid second line rolls back the entire batch and leaves a truthful pending capture',run:async()=>{
   const opened=await rpc(actor,'open_dossier',[org,year+1,'matrix-atomic','ذرية المصفوفة']); const revision=opened.plan_revision_id;
   const items=await driver.admin("INSERT INTO public.central_items(name,name_ar,unit,status,national_code) VALUES('Matrix atomic A','ذرية أ','test','active','ATOMIC-A'),('Matrix atomic B','ذرية ب','test','active','ATOMIC-B') RETURNING id,national_code");
   const rows=items.map((v,i)=>row(v.id,i,{source_code:v.national_code}));
   const capture=await rpc(actor,'begin_dossier_workbook',[revision,'atomic.csv',hash,source.toString('base64'),JSON.stringify(rows),'[]',JSON.stringify({...confirmation,plan_year:year+1}),'90000000-0000-4000-8000-000000000010']);
   await driver.admin("UPDATE public.central_items SET status='inactive' WHERE id=$1",[items[1].id]);
   await assert.rejects(()=>rpc(actor,'apply_dossier_workbook_batch',[capture.intake_id,0]),/unit_or_code_mismatch/);
   assert.equal(await val('SELECT count(*)::int n FROM public.central_needs_manual_need_events WHERE plan_revision_id=$1',[revision]),0);
   assert.equal(await val('SELECT count(*)::int n FROM public.central_needs_dossier_receipts WHERE intake_id=$1',[capture.intake_id]),0);
   await driver.admin("UPDATE public.central_items SET status='active' WHERE id=$1",[items[1].id]);
   await driver.admin("UPDATE public.profile_permission_overrides SET allowed=false WHERE profile_id=$1 AND permission_key='central_needs.manual_need.set'",[actor]);
   await assert.rejects(()=>rpc(actor,'apply_dossier_workbook_batch',[capture.intake_id,0]),/forbidden_central_needs/);
   await driver.admin("UPDATE public.profile_permission_overrides SET allowed=true WHERE profile_id=$1 AND permission_key='central_needs.manual_need.set'",[actor]);
   await rpc(actor,'apply_dossier_workbook_batch',[capture.intake_id,0]);
   assert.equal(await val('SELECT count(*)::int n FROM public.central_needs_manual_need_events WHERE plan_revision_id=$1',[revision]),2);
   s.atomicCapture=capture.intake_id;
  }},
  {name:'matrix: typed or carried manual scopes are refused before a pending capture is created',run:async()=>{
   const opened=await rpc(actor,'open_dossier',[org,year+2,'typed-conflict','تعارض إدخال مباشر']);
   await rpc(actor,'add_manual_need_line',[opened.plan_revision_id,hospital,s.items[0].id,null,'1','Reviewed direct entry','matrix-direct-existing',null,null]);
   await assert.rejects(()=>rpc(actor,'begin_dossier_workbook',[opened.plan_revision_id,'typed.csv',hash,source.toString('base64'),JSON.stringify([row(s.items[0].id)]),'[]',JSON.stringify({...confirmation,plan_year:year+2}),'90000000-0000-4000-8000-000000000011']),/dossier_existing_manual_scope/);
   assert.equal(await val('SELECT count(*)::int n FROM public.central_needs_dossier_intakes WHERE plan_revision_id=$1',[opened.plan_revision_id]),0);
   assert.equal(await val('SELECT count(*)::int n FROM public.central_needs_dossier_documents WHERE plan_id=$1',[opened.plan_id]),0);
  }},
  {name:'matrix: restricted callers cannot mutate evidence directly or read another PDA capture',run:async()=>{
   for(const table of ['documents','intakes','receipts']) await assert.rejects(()=>driver.as(actor,`DELETE FROM public.central_needs_dossier_${table}`),/permission denied/);
   await assert.rejects(()=>rpc(outsider,'download_dossier_source',[s.atomicCapture]),/forbidden_central_needs/);
   for(const id of [s.atomicCapture,'90000000-0000-4000-8000-ffffffffffff']) await assert.rejects(()=>rpc(outsider,'apply_dossier_workbook_batch',[id,0]),/forbidden_central_needs/);
   assert.equal(await val('SELECT count(*)::int n FROM phoenix_private.central_needs_capability_breaches_v1()'),0);
  }},
 ];
}
