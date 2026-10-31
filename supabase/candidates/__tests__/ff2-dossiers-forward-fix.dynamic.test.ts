import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
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
run('M235 plus P1 reservations, matrix receipts and FF2 / native PostgreSQL',()=>{
 let rig: Awaited<ReturnType<typeof buildRig>>;
 type Client={query:(s:string,a:unknown[])=>Promise<{rows:unknown[]}>};
 const driver={
  script:async(sql:string)=>rig.asAdmin(async(c:Client)=>{try{return await c.query(sql,[]);}catch(e){await c.query('ROLLBACK',[]);throw e;}}),
  admin:async(sql:string,args:unknown[]=[])=>rig.asAdmin(async(c:Client)=>(await c.query(sql,args)).rows),
  as:async(user:string|null,sql:string,args:unknown[]=[])=>rig.asUser(user,async(c:Client)=>(await c.query(sql,args)).rows,{commit:true}),
  asRole:async(role:string,user:string|null,sql:string,args:unknown[]=[])=>rig.asUser(user,async(c:Client)=>(await c.query(sql,args)).rows,{role,commit:true}),
 };
 const reservationSql=readFileSync(new URL('../P1_dossier_workbook_reservation_NOT_APPLIED.sql',import.meta.url),'utf8');
 beforeAll(async()=>{rig=await buildRig({upTo:235});await driver.script(reservationSql);},900000);
 afterAll(async()=>{if(rig)await rig.end();},30000);
 for(const test of [...annualDossierCases(driver),...dossierMatrixCases(driver)])it(test.name,test.run,120000);

 async function nativeSelection(year:number,label:string){
  const {org,actor,hospital}=ANNUAL_FIXTURE;
  const call=async(name:string,args:unknown[])=>((await driver.as(actor,`SELECT public.phoenix_central_needs_${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args))[0] as {r:{plan_revision_id:string;intake_id:string}}).r;
  const [raw]=await driver.admin("INSERT INTO public.central_items(name,name_ar,unit,status) VALUES($1,'مادة تزامن','test','active') RETURNING id",[label]); const item=(raw as {id:string}).id;
  const plan=await call('open_dossier',[org,year,label,label]); const bytes=Buffer.from('Native independent-transaction fixture');
  const rows=[{sheet:0,row:4,quantity_column:9,name_column:1,code_column:null,unit_column:2,source_name:label,source_code:null,source_unit:'test',unit:'test',quantity_text:'11520',item_id:item,beneficiary_id:hospital}];
  const args=[plan.plan_revision_id,'native.csv',createHash('sha256').update(bytes).digest('hex'),bytes.toString('base64'),JSON.stringify(rows),'[]',JSON.stringify({format:'matrix-v2',plan_year:year,year_confirmed:true}),randomUUID()];
  return {item,revision:plan.plan_revision_id,args};
 }
 async function nativeCapture(year:number,label:string){
  const f=await nativeSelection(year,label);
  const [saved]=await driver.as(ANNUAL_FIXTURE.actor,'SELECT public.phoenix_central_needs_begin_dossier_workbook($1,$2,$3,$4,$5,$6,$7,$8) r',f.args);
  return {...f,intake:(saved as {r:{intake_id:string}}).r.intake_id};
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
 it.each([
  {first:'capture',commit:true,target:'institution',year:2040},
  {first:'writer',commit:true,target:'institution',year:2041},
  {first:'capture',commit:false,target:'institution',year:2042},
  {first:'writer',commit:false,target:'institution',year:2043},
  {first:'capture',commit:true,target:'warehouse',year:2044},
  {first:'writer',commit:true,target:'warehouse',year:2045},
  {first:'capture',commit:false,target:'warehouse',year:2046},
  {first:'writer',commit:false,target:'warehouse',year:2047},
 ].flatMap(c=>[{...c,writer:'manual'},{...c,year:c.year+8,writer:'carry'}]))('P1 native: $first first ($writer) with commit=$commit and $target scope serializes without orphaned reservations',async({first,commit,target,year,writer})=>{
  const f=await nativeSelection(year,`p1-${writer}-${first}-${commit}-${target}`);
  type Result={rows:{r:{intake_id?:string}}[]};
  let pending:Promise<{result?:Result;error?:Error}>|undefined;
  const captureSql='SELECT public.phoenix_central_needs_begin_dossier_workbook($1,$2,$3,$4,$5,$6,$7,$8) r';
  const manualSql='SELECT public.phoenix_central_needs_add_manual_need_line($1,$2,$3,$4,$5,$6,$7,NULL,NULL) r';
  let warehouse:string|null=null;
  if(target==='warehouse'){
   const [saved]=await driver.admin("INSERT INTO public.warehouses(organization_id,name,name_ar) VALUES($1,$2,'مخزن اختبار التزامن') RETURNING id",[ANNUAL_FIXTURE.hospital,`P1 native ${year}`]);
   warehouse=(saved as {id:string}).id;
  }
  const manualArgs=[f.revision,ANNUAL_FIXTURE.hospital,f.item,warehouse,'7','Native reservation overlap',`p1-native-${writer}-${first}-${commit}-${target}`];
  let writerSql=manualSql;let writerArgs:unknown[]=manualArgs;
  if(writer==='carry'){
   const sourceRevision=f.revision;
   await driver.as(ANNUAL_FIXTURE.actor,manualSql,manualArgs);
   await driver.as(ANNUAL_FIXTURE.actor,'SELECT public.phoenix_central_needs_submit_revision($1)',[sourceRevision]);
   await driver.as(ANNUAL_FIXTURE.actor,'SELECT public.phoenix_central_needs_approve_revision($1)',[sourceRevision]);
   const [opened]=await driver.as(ANNUAL_FIXTURE.actor,'SELECT public.phoenix_central_needs_open_manual_correction_revision($1,$2,$3,$4) r',[ANNUAL_FIXTURE.org,year,sourceRevision,'Native carry reservation correction']);
   f.revision=(opened as {r:{plan_revision_id:string}}).r.plan_revision_id;f.args[0]=f.revision;
   writerSql='SELECT public.phoenix_central_needs_carry_forward_manual_lines($1,$2) r';
   writerArgs=[f.revision,sourceRevision];
  }
  const a=await rig.pool.connect();const b=await rig.pool.connect();
  try{
   for(const c of [a,b]){
    await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='10s'");await c.query('SET LOCAL ROLE authenticated');
    await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[ANNUAL_FIXTURE.actor]);
   }
   const aid=(await a.query('SELECT pg_backend_pid() id')).rows[0].id;
   const bid=(await b.query('SELECT pg_backend_pid() id')).rows[0].id;
   expect(aid).not.toBe(bid);
   await a.query(first==='capture'?captureSql:writerSql,first==='capture'?f.args:writerArgs);
   pending=b.query(first==='capture'?writerSql:captureSql,first==='capture'?writerArgs:f.args)
    .then((result:Result)=>({result}),(error:Error)=>({error}));
   expect(await waitForBlock(aid,bid)).toBe(true);
   await a.query(commit?'COMMIT':'ROLLBACK');
   const second=await pending;
   if(commit){
    expect(second.error?.message).toBe(first==='capture'?'dossier_pending_workbook_scope':'dossier_existing_manual_scope');
    await b.query('ROLLBACK');
   }else{
    expect(second.error).toBeUndefined();expect(second.result).toBeDefined();await b.query('COMMIT');
   }
   const captures=await driver.admin('SELECT id FROM public.central_needs_dossier_intakes WHERE plan_revision_id=$1',[f.revision]);
   const workbookWon=(first==='capture')===commit;
   expect(captures.length).toBe(workbookWon?1:0);
   if(workbookWon){
    const intake=(captures[0] as {id:string}).id;
    await driver.as(ANNUAL_FIXTURE.actor,'SELECT public.phoenix_central_needs_apply_dossier_workbook_batch($1,0)',[intake]);
    const [receipt]=await driver.admin('SELECT count(*)::int n FROM public.central_needs_dossier_receipts WHERE intake_id=$1',[intake]);
    expect(receipt).toEqual({n:1});
   }
   const [saved]=await driver.admin('SELECT approved_quantity::text quantity FROM public.central_needs_need_lines WHERE plan_revision_id=$1',[f.revision]);
   expect(saved).toEqual({quantity:workbookWon?'11520':'7'});
   const [events]=await driver.admin('SELECT count(*)::int n FROM public.central_needs_manual_need_events WHERE plan_revision_id=$1',[f.revision]);
   expect(events).toEqual({n:1});
  }finally{
   await a.query('ROLLBACK');if(pending)await pending;await b.query('ROLLBACK');a.release();b.release();
  }
 },30000);
 it('P1 refuses reapplication without changing the protected writer',async()=>{
  await expect(driver.script(reservationSql)).rejects.toThrow('P1_precondition_failed: reservation implementation already exists');
  const [seal]=await driver.admin('SELECT count(*)::int n FROM phoenix_private.central_needs_capability_breaches_v1()');
  expect(seal).toEqual({n:0});
 });
 for(const test of dossierForwardFixCases(driver))it(test.name,test.run,120000);
});
