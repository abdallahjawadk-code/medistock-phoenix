import {createHash, randomUUID} from 'node:crypto';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
// @ts-expect-error — canonical JavaScript rig.
import {buildRig, rigAvailable} from '../../../tools/pg-rig/rig.mjs';
// @ts-expect-error — shared executable PostgreSQL cases.
import {annualDossierCases, ANNUAL_FIXTURE} from '../../../tools/pg-rig/annual-dossier-acceptance.mjs';
// @ts-expect-error — shared executable PostgreSQL cases.
import {dossierMatrixCases} from '../../../tools/pg-rig/dossier-matrix-acceptance.mjs';
// @ts-expect-error — shared executable PostgreSQL cases.
import {dossierForwardFixCases} from '../../../tools/pg-rig/dossier-ff2-acceptance.mjs';
const run=rigAvailable()?describe.sequential:describe.skip;
run('M235 matrix receipts and FF2 / native PostgreSQL',()=>{
 let rig: Awaited<ReturnType<typeof buildRig>>;
 type Client={query:(s:string,a:unknown[])=>Promise<{rows:unknown[]}>};
 const driver={
  script:async(sql:string)=>rig.asAdmin(async(c:Client)=>{try{return await c.query(sql,[]);}catch(e){await c.query('ROLLBACK',[]);throw e;}}),
  admin:async(sql:string,args:unknown[]=[])=>rig.asAdmin(async(c:Client)=>(await c.query(sql,args)).rows),
  as:async(user:string|null,sql:string,args:unknown[]=[])=>rig.asUser(user,async(c:Client)=>(await c.query(sql,args)).rows,{commit:true}),
  asRole:async(role:string,user:string|null,sql:string,args:unknown[]=[])=>rig.asUser(user,async(c:Client)=>(await c.query(sql,args)).rows,{role,commit:true}),
 };
 beforeAll(async()=>{rig=await buildRig({upTo:235});},900000);
 afterAll(async()=>{if(rig)await rig.end();},30000);
 for(const test of [...annualDossierCases(driver),...dossierMatrixCases(driver)])it(test.name,test.run,120000);

 async function nativeCapture(year:number,label:string){
  const {org,actor,hospital}=ANNUAL_FIXTURE;
  const call=async(name:string,args:unknown[])=>((await driver.as(actor,`SELECT public.phoenix_central_needs_${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args))[0] as {r:{plan_revision_id:string;intake_id:string}}).r;
  const [raw]=await driver.admin("INSERT INTO public.central_items(name,name_ar,unit,status) VALUES($1,'مادة تزامن','test','active') RETURNING id",[label]); const item=(raw as {id:string}).id;
  const plan=await call('open_dossier',[org,year,label,label]); const bytes=Buffer.from('Native independent-transaction fixture');
  const rows=[{sheet:0,row:4,quantity_column:9,name_column:1,code_column:null,unit_column:2,source_name:label,source_code:null,source_unit:'test',unit:'test',quantity_text:'11520',item_id:item,beneficiary_id:hospital}];
  const capture=await call('begin_dossier_workbook',[plan.plan_revision_id,'native.csv',createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(rows),'[]',JSON.stringify({format:'matrix-v2',plan_year:year,year_confirmed:true}),randomUUID()]);
  return {item,revision:plan.plan_revision_id,intake:capture.intake_id};
 }
 async function waitForBlock(blocker:number,waiter:number){
  const until=Date.now()+5000;
  while(Date.now()<until){const [r]=await driver.admin('SELECT $1::int=ANY(pg_blocking_pids($2::int)) blocked',[blocker,waiter]);if((r as {blocked:boolean}).blocked)return true;await new Promise(resolve=>setTimeout(resolve,10));}
  return false;
 }
 it('native: duplicate batch transactions serialize and only one receipt/event commits',async()=>{
  const f=await nativeCapture(2034,'native-batch-replay');const a=await rig.pool.connect();const b=await rig.pool.connect();
  let pending:Promise<{result?:{rows:{r:{idempotent_replay:boolean}}[]};error?:Error}>|undefined;
  try{
   for(const c of [a,b]){await c.query('BEGIN');await c.query('SET LOCAL ROLE authenticated');await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[ANNUAL_FIXTURE.actor]);}
   const aid=(await a.query('SELECT pg_backend_pid() id')).rows[0].id;const bid=(await b.query('SELECT pg_backend_pid() id')).rows[0].id;
   await a.query('SELECT public.phoenix_central_needs_apply_dossier_workbook_batch($1,0)',[f.intake]);
   pending=b.query('SELECT public.phoenix_central_needs_apply_dossier_workbook_batch($1,0) r',[f.intake]).then((result:{rows:{r:{idempotent_replay:boolean}}[]})=>({result}),(error:Error)=>({error}));
   expect(await waitForBlock(aid,bid)).toBe(true);await a.query('COMMIT');const second=await pending;expect(second.error).toBeUndefined();expect(second.result?.rows[0].r.idempotent_replay).toBe(true);await b.query('COMMIT');
   const [events]=await driver.admin('SELECT count(*)::int n FROM public.central_needs_manual_need_events WHERE plan_revision_id=$1',[f.revision]);
   const [receipts]=await driver.admin('SELECT count(*)::int n FROM public.central_needs_dossier_receipts WHERE intake_id=$1',[f.intake]);expect(events).toEqual({n:1});expect(receipts).toEqual({n:1});
  }finally{await a.query('ROLLBACK');if(pending)await pending;await b.query('ROLLBACK');a.release();b.release();}
 },30000);
 it('native: catalog suspension winning the SHARE lock refuses the complete batch with no event or receipt',async()=>{
  const f=await nativeCapture(2035,'native-batch-suspension');const owner=await rig.pool.connect();const caller=await rig.pool.connect();let pending:Promise<{error?:Error}>|undefined;
  try{
   await owner.query('BEGIN');await owner.query("UPDATE public.central_items SET status='inactive' WHERE id=$1",[f.item]);
   await caller.query('BEGIN');await caller.query('SET LOCAL ROLE authenticated');await caller.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[ANNUAL_FIXTURE.actor]);
   const oid=(await owner.query('SELECT pg_backend_pid() id')).rows[0].id;const cid=(await caller.query('SELECT pg_backend_pid() id')).rows[0].id;
   pending=caller.query('SELECT public.phoenix_central_needs_apply_dossier_workbook_batch($1,0)',[f.intake]).then(()=>({}),(error:Error)=>({error}));
   expect(await waitForBlock(oid,cid)).toBe(true);await owner.query('COMMIT');expect((await pending).error?.message).toContain('manual_line_unit_or_code_mismatch');await caller.query('ROLLBACK');
   const [events]=await driver.admin('SELECT count(*)::int n FROM public.central_needs_manual_need_events WHERE plan_revision_id=$1',[f.revision]);
   const [receipts]=await driver.admin('SELECT count(*)::int n FROM public.central_needs_dossier_receipts WHERE intake_id=$1',[f.intake]);expect(events).toEqual({n:0});expect(receipts).toEqual({n:0});
  }finally{await owner.query('ROLLBACK');if(pending)await pending;await caller.query('ROLLBACK');owner.release();caller.release();}
 },30000);
 for(const test of dossierForwardFixCases(driver))it(test.name,test.run,120000);
});
