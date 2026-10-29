/** Shared executable SQL cases. Native pg-rig is authoritative for transport /
 * independent-session concurrency. A WASM PostgreSQL adapter may run these same
 * cases locally, but must report that engine and must not claim native parity.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const ANNUAL_FIXTURE = {
  org:'80000000-0000-4000-8000-000000000001', otherOrg:'80000000-0000-4000-8000-000000000002',
  hospital:'80000000-0000-4000-8000-000000000003',
  actor:'80000000-0000-4000-8000-000000000011', editor:'80000000-0000-4000-8000-000000000012',
  outsider:'80000000-0000-4000-8000-000000000013', inactive:'80000000-0000-4000-8000-000000000014', year:2028,
};
export function annualDossierCases(driver) {
 const {org,otherOrg,hospital,actor,editor,outsider,inactive,year}=ANNUAL_FIXTURE;
 const admin=driver.admin, as=driver.as;
 const rpc=async(user,name,args=[]) => (await as(user,`SELECT public.phoenix_central_needs_${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) AS r`,args))[0].r;
 const value=async(sql,args=[]) => (await admin(sql,args))[0].n;
 const refused=async(fn,pattern) => { await assert.rejects(fn,pattern); };
 const state={};
 const add=(rev,item,qty,key) => rpc(actor,'add_manual_need_line',[rev,hospital,item,null,qty,'Explicit annual planning',key,null,null]);
 const submitApprove=async(rev) => { await rpc(actor,'submit_revision',[rev]); await rpc(actor,'approve_revision',[rev]); };
 const row=(item,unit='test',q='11520',n=2) => ({sheet:0,row:n,quantity_column:1,name_column:0,code_column:null,unit_column:2,source_name:'Fixture reagent',source_code:null,
   item_id:item,beneficiary_id:hospital,quantity_text:q,unit});
 const source=(content) => {const bytes=Buffer.from(content); return {hash:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')};};
 const intake=(rev,filename,content,rows) => {const s=source(content);return rpc(actor,'import_dossier_workbook',[rev,filename,s.hash,s.base64,JSON.stringify(rows)]);};
 return [
  {name:'fixture: ordinary members, explicit keys, one actor can staff the manual path',run:async()=>{
   await admin(`INSERT INTO public.organizations(id,name,name_ar,code,organization_kind,institution_class) VALUES
     ($1,'Dossier PDA','دائرة الحزم','dossier-pda','pharmacy_department_authority',NULL),
     ($2,'Other PDA','دائرة أخرى','dossier-other','pharmacy_department_authority',NULL),
     ($3,'Dossier hospital','مستشفى الحزم','dossier-hosp','care_institution','hospital') ON CONFLICT DO NOTHING`,[org,otherOrg,hospital]);
   for(const [id,scope,status] of [[actor,org,'active'],[editor,org,'active'],[outsider,otherOrg,'active'],[inactive,org,'suspended']]){
    await admin('INSERT INTO auth.users(id,email) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,`${id}@fixture.invalid`]);
    await admin("UPDATE public.profiles SET role='warehouse_officer',organization_id=$2,status=$3 WHERE id=$1",[id,scope,status]);
    const keys=id===editor?['view','edit','manual_need.set']:['view','edit','manual_need.set','approve','material_review'];
    for(const key of keys) await admin(`INSERT INTO public.profile_permission_overrides(profile_id,permission_key,allowed) VALUES($1,$2,true)
      ON CONFLICT(profile_id,permission_key) DO UPDATE SET allowed=true`,[id,`central_needs.${key}`]);
   }
   const ready=(await admin('SELECT phoenix_private.central_needs_staffing_readiness_v1($1) AS r',[org]))[0].r;
   assert.equal(ready.ready,true);
   const result=(await admin('SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1) AS r',[org]))[0].r;
   assert.equal(result.ok,true);
  }},
  {name:'same actor registers, submits, reviews and approves with independent effective keys; national code remains separate',run:async()=>{
   const request=await rpc(actor,'create_material_request_with_code',[org,'Dossier fixture reagent',null,null,null,null,'test','8400000000001','00043-A00-001',null,'manual_typed',{},null,'dossier-material-0001']);
   state.request=request.request_id;
   await rpc(actor,'submit_material_request',[request.request_id,1]);
   await rpc(actor,'start_material_review',[request.request_id,2]);
   await refused(()=>rpc(actor,'approve_new_material',[request.request_id,3,[],null]),/material_code_review_confirmation_required/);
   const result=await rpc(actor,'approve_material_with_code',[request.request_id,3,[],null,'00043-A00-001']);
   state.item=result.central_item_id;
   const item=(await admin('SELECT national_code,barcode,unit FROM public.central_items WHERE id=$1',[state.item]))[0];
   assert.deepEqual(item,{national_code:'00043-A00-001',barcode:'8400000000001',unit:'test'});
   assert.equal(await value('SELECT count(*)::int AS n FROM public.central_needs_material_request_events WHERE request_id=$1 AND actor_id=$2',[state.request,actor]),4);
   assert.equal(await value('SELECT count(*)::int AS n FROM public.central_items WHERE national_code=$1',['00043-A00-001']),1);
  }},
  {name:'existing material gains a distinct national code only after explicit reviewed confirmation; barcode is unchanged',run:async()=>{
   const item=(await admin("INSERT INTO public.central_items(name,name_ar,unit,status,barcode) VALUES('Dossier existing material','مادة موجودة','box','active','8410000000001') RETURNING id"))[0].id;
   const request=await rpc(actor,'create_material_request_with_code',[org,'Dossier existing material',null,null,null,null,'box',null,'00044-B00-001','Explicit code assignment','manual_typed',{},null,'dossier-existing-code-1']);
   await rpc(actor,'submit_material_request',[request.request_id,1]);
   await rpc(actor,'start_material_review',[request.request_id,2]);
   await refused(()=>rpc(actor,'resolve_material_existing',[request.request_id,3,item,'Legacy review']),/material_code_review_confirmation_required/);
   const candidates=await as(actor,'SELECT * FROM public.phoenix_central_needs_material_request_code_candidates($1)',[request.request_id]);
   assert.ok(candidates.some((r)=>Object.values(r)[0].central_item_id===item));
   await refused(()=>rpc(actor,'resolve_material_existing_with_code',[request.request_id,3,item,'Reviewed existing item',null,false]),/confirmation_required/);
   await refused(()=>rpc(actor,'resolve_material_existing_with_code',[request.request_id,3,item,'Reviewed existing item','STALE',true]),/assignment_stale/);
   await rpc(actor,'resolve_material_existing_with_code',[request.request_id,3,item,'Reviewed existing item',null,true]);
   assert.deepEqual((await admin('SELECT national_code,barcode FROM public.central_items WHERE id=$1',[item]))[0],{national_code:'00044-B00-001',barcode:'8410000000001'});
   assert.equal(await value("SELECT count(*)::int AS n FROM public.audit_logs WHERE action='central_needs.material.national_code_assigned' AND entity_id=$1",[item]),1);
  }},
  {name:'three dossiers coexist in the same year; a fourth legacy general plan remains unambiguous',run:async()=>{
   for(const [k,name] of [['medicines','الأدوية'],['laboratory','المختبرات'],['conflict','حزمة التعارض']]){
    state[k]=await rpc(actor,'open_dossier',[org,year,k,name]);
   }
   const same=await rpc(actor,'open_dossier',[org,year,'medicines','الأدوية']);
   assert.equal(same.plan_revision_id,state.medicines.plan_revision_id);
   assert.equal(same.idempotent_replay,true);
   const general=await rpc(actor,'open_manual_plan_revision',[org,year]);
   assert.notEqual(general.plan_id,state.medicines.plan_id);
   const list=await as(actor,'SELECT * FROM public.phoenix_central_needs_list_dossiers($1,$2)',[org,year]);
   assert.equal(list.length,4);
   const legacy=await as(actor,'SELECT id FROM public.central_needs_plans WHERE organization_id=$1 AND plan_year=$2',[org,year]);
   assert.deepEqual(legacy.map((r)=>r.id),[general.plan_id]);
   const oldRows=await as(actor,'SELECT id FROM public.central_needs_plan_revisions WHERE plan_id=$1',[state.medicines.plan_id]);
   assert.equal(oldRows.length,0);
   const modernRows=await as(actor,'SELECT * FROM public.phoenix_central_needs_dossier_revisions($1)',[state.medicines.plan_id]);
   assert.equal(modernRows[0].id,state.medicines.plan_revision_id);
  }},
  {name:'approved dossier stays effective while another classification is still a draft',run:async()=>{
   await add(state.medicines.plan_revision_id,state.item,'11520','dossier-add-medicine-1');
   await submitApprove(state.medicines.plan_revision_id);
   const list=await as(actor,'SELECT * FROM public.phoenix_central_needs_annual_summary($1,$2)',[org,year]);
   assert.equal(list.length,1);assert.equal(Object.values(list[0])[0].quantity_text,'11520');
   const r=(await admin('SELECT status,approved_by FROM public.central_needs_plan_revisions WHERE id=$1',[state.medicines.plan_revision_id]))[0];
   assert.deepEqual(r,{status:'approved',approved_by:actor});
  }},
  {name:'approval refuses duplicate annual beneficiary/material across dossiers without mutating earlier approval',run:async()=>{
   await add(state.conflict.plan_revision_id,state.item,'100','dossier-conflict-1');
   await rpc(actor,'submit_revision',[state.conflict.plan_revision_id]);
   await refused(()=>rpc(actor,'approve_revision',[state.conflict.plan_revision_id]),/annual_need_duplicate_dossier_scope/);
   assert.equal((await admin('SELECT status FROM public.central_needs_plan_revisions WHERE id=$1',[state.conflict.plan_revision_id]))[0].status,'submitted');
   assert.equal((await admin('SELECT status FROM public.central_needs_plan_revisions WHERE id=$1',[state.medicines.plan_revision_id]))[0].status,'approved');
  }},
  {name:'a correction replaces only its dossier; carry-forward retains canonical events and exact text',run:async()=>{
   const old=state.medicines;
   const next=await rpc(actor,'open_dossier_correction',[org,year,old.plan_revision_id,'Reviewed annual correction']);
   assert.equal(next.copied_approved_predecessor,old.plan_revision_id);
   const events=await as(actor,'SELECT * FROM public.phoenix_central_needs_list_manual_need_events($1)',[next.plan_revision_id]);
   const last=events[events.length-1];
   await rpc(actor,'correct_manual_need_line',[next.plan_revision_id,hospital,state.item,null,'9600','Updated annual quantity','dossier-correct-1',last.id,null]);
   await submitApprove(next.plan_revision_id);
   const summaries=await as(actor,'SELECT * FROM public.phoenix_central_needs_annual_summary($1,$2)',[org,year]);
   assert.equal(summaries.length,1); assert.equal(Object.values(summaries[0])[0].quantity_text,'9600');
   assert.equal((await admin('SELECT status FROM public.central_needs_plan_revisions WHERE id=$1',[old.plan_revision_id]))[0].status,'superseded');
   const history=await rpc(actor,'dossier_lifecycle',[org,year,next.plan_id]);
   assert.ok(history.events.some((e)=>e.action==='central_needs.plan_revision.open_correction' && e.reason==='Reviewed annual correction'));
   state.medicines=next;
  }},
  {name:'source intake commits one file atomically and retains original bytes and captured selections',run:async()=>{
   state.labItem=(await admin("INSERT INTO public.central_items(name,name_ar,unit,status,national_code) VALUES('Dossier second reagent','مادة ثانية','test','active','00043-A00-002') RETURNING id"))[0].id;
   const rows=[row(state.labItem)]; const content='name,quantity,unit\nFixture reagent,11520,test\n';
   state.intakeRows=rows;state.content=content;
   state.intake=await intake(state.laboratory.plan_revision_id,'laboratory.csv',content,rows);
   assert.equal(state.intake.rows,1);
   const src=await rpc(actor,'download_dossier_source',[state.intake.intake_id]);
   assert.equal(Buffer.from(src.base64,'base64').toString(),content);
   assert.deepEqual(src.write_plan,rows);
   assert.equal(src.source_authority,'human_confirmed');
  }},
  {name:'the same file and intent reconcile idempotently; changed intent never doubles quantities',run:async()=>{
   const repeat=await intake(state.laboratory.plan_revision_id,'laboratory.csv',state.content,state.intakeRows);
   assert.equal(repeat.idempotent_replay,true); assert.equal(repeat.intake_id,state.intake.intake_id);
   await refused(()=>intake(state.laboratory.plan_revision_id,'laboratory.csv',state.content,[row(state.labItem,'test','1')]),/dossier_duplicate_selection/);
   assert.equal(await value('SELECT count(*)::int AS n FROM public.central_needs_manual_need_events WHERE plan_revision_id=$1',[state.laboratory.plan_revision_id]),1);
  }},
  {name:'a failed second row rolls back the first row, intake record and its audit effects',run:async()=>{
   const temp=await rpc(actor,'open_dossier',[org,year,'atomic','اختبار الذرية']);
   await refused(()=>intake(temp.plan_revision_id,'atomic.csv','atomic fixture\n',[row(state.item),row(state.labItem,'carton','2',3)]),/manual_line_unit_mismatch/);
   assert.equal(await value('SELECT count(*)::int AS n FROM public.central_needs_manual_need_events WHERE plan_revision_id=$1',[temp.plan_revision_id]),0);
   assert.equal(await value('SELECT count(*)::int AS n FROM public.central_needs_dossier_intakes WHERE plan_revision_id=$1',[temp.plan_revision_id]),0);
   await refused(()=>intake(temp.plan_revision_id,'dup.csv','duplicate fixture\n',[row(state.item),row(state.item,'test','2',3)]),/dossier_duplicate_selection/);
  }},
  {name:'a second approved classification adds its own quantities while the first remains effective',run:async()=>{
   await submitApprove(state.laboratory.plan_revision_id);
   const list=await as(actor,'SELECT * FROM public.phoenix_central_needs_annual_summary($1,$2)',[org,year]);
   assert.equal(list.length,2);
   assert.deepEqual(list.map((v)=>Object.values(v)[0].quantity_text).sort(),['11520','9600']);
  }},
  {name:'view/edit membership does not imply approval or material review; inactive and cross-org callers are denied',run:async()=>{
   await refused(()=>rpc(editor,'approve_revision',[state.conflict.plan_revision_id]),/forbidden_central_needs/);
   await refused(()=>rpc(editor,'start_material_review',[state.request,4]),/forbidden_central_needs|material_request_not/);
   await refused(()=>rpc(outsider,'list_dossiers',[org,year]),/forbidden_central_needs/);
   await refused(()=>rpc(outsider,'dossier_sources',[state.laboratory.plan_id]),/forbidden_central_needs/);
   await refused(()=>rpc(outsider,'download_dossier_source',[state.intake.intake_id]),/forbidden_central_needs/);
   await refused(()=>rpc(inactive,'list_dossiers',[org,year]),/forbidden_central_needs|inactive/);
   await refused(()=>rpc(null,'list_dossiers',[org,year]),/not_authenticated/);
   await refused(()=>as(actor,"INSERT INTO public.central_needs_dossier_intakes(filename) VALUES('bypass')"),/permission denied/);
  }},
  {name:'Excel withdrawal SoD and old activated Excel freeze remain enforced; no permission defaults were added',run:async()=>{
   const d=await rpc(actor,'open_dossier',[org,year,'withdraw','حزمة السحب']);
   await refused(()=>rpc(actor,'withdraw_draft_revision',[d.plan_revision_id,d.plan_revision_id,'Test withdrawal','fixture-ref']),/separation_of_duties/);
   await refused(()=>rpc(actor,'open_plan_revision',[org,2029,false]),/excel_intake_closed_after_activation/);
   assert.equal(await value("SELECT count(*)::int AS n FROM public.role_permission_defaults WHERE permission_key IN('central_needs.manual_need.set','central_needs.material_review')"),0);
   assert.equal(await value('SELECT count(*)::int AS n FROM phoenix_private.central_needs_capability_breaches_v1()'),0);
  }},
 ];
}
