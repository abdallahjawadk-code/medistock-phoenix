import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — canonical JavaScript rig; no new project-wide type relaxation.
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';
// @ts-expect-error — shared Node acceptance module.
import { annualDossierCases, ANNUAL_FIXTURE } from '../../../tools/pg-rig/annual-dossier-acceptance.mjs';

const run = rigAvailable() ? describe.sequential : describe.skip;
run('M232–235 annual dossiers / canonical PostgreSQL', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  const driver = {
    admin: async (sql: string, args: unknown[] = []) => rig.asAdmin(async (c: { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }) => (await c.query(sql,args)).rows),
    as: async (user: string | null, sql: string, args: unknown[] = []) => rig.asUser(user,async (c: { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }) => (await c.query(sql,args)).rows, { commit: true }),
  };
  beforeAll(async () => { rig = await buildRig({ upTo: 235 }); }, 900_000);
  afterAll(async () => { if (rig) await rig.end(); }, 30_000);
  for (const test of annualDossierCases(driver)) it(test.name, test.run, 30_000);

  it('refuses code assignment if a concurrent catalog suspension wins the item lock', async () => {
    const {org,actor}=ANNUAL_FIXTURE;
    const invoke=async(name:string,args:unknown[]) => (await driver.as(actor,
      `SELECT public.phoenix_central_needs_${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) AS r`,args))[0] as {r:Record<string,string>};
    const [item]=await driver.admin("INSERT INTO public.central_items(name,name_ar,unit,status) VALUES('Concurrent code suspension','مادة إيقاف متزامن','box','active') RETURNING id");
    const itemId=(item as {id:string}).id;
    const request=(await invoke('create_material_request_with_code',[org,'Concurrent code suspension',null,null,null,null,'box',null,'00045-RACE','Reviewed assignment','manual_typed',{},null,'dossier-code-suspension'])).r;
    await invoke('submit_material_request',[request.request_id,1]);
    await invoke('start_material_review',[request.request_id,2]);
    const writer=await rig.pool.connect();const reviewer=await rig.pool.connect();
    let pending:Promise<{error?:Error}>|undefined;
    try {
      await writer.query('BEGIN');
      const writerPid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await writer.query("UPDATE public.central_items SET status='inactive' WHERE id=$1",[itemId]);
      await reviewer.query('BEGIN');await reviewer.query('SET LOCAL ROLE authenticated');
      await reviewer.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[actor]);
      const reviewerPid=(await reviewer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending=reviewer.query('SELECT public.phoenix_central_needs_resolve_material_existing_with_code($1,3,$2,$3,NULL,true)',[request.request_id,itemId,'Explicit reviewed assignment'])
        .then(()=>({}),(error:Error)=>({error}));
      let blocked=false;const until=Date.now()+5000;
      while(!blocked&&Date.now()<until){
        const [r]=await driver.admin('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked',[writerPid,reviewerPid]);
        blocked=(r as {blocked:boolean}).blocked;
        if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);await writer.query('COMMIT');
      expect((await pending).error?.message).toContain('material_resolution_item_not_active');
      await reviewer.query('ROLLBACK');
      const [saved]=await driver.admin('SELECT national_code,status FROM public.central_items WHERE id=$1',[itemId]);
      expect(saved).toEqual({national_code:null,status:'inactive'});
      const [decision]=await driver.admin('SELECT status,version,resolved_item_id FROM public.central_needs_material_requests WHERE id=$1',[request.request_id]);
      expect(decision).toEqual({status:'under_review',version:3,resolved_item_id:null});
      const [audit]=await driver.admin("SELECT count(*)::int AS n FROM public.audit_logs WHERE action='central_needs.material.national_code_assigned' AND entity_id=$1",[itemId]);
      expect((audit as {n:number}).n).toBe(0);
    }finally{
      await writer.query('ROLLBACK');if(pending)await pending;await reviewer.query('ROLLBACK');writer.release();reviewer.release();
    }
  },30_000);

  it('serializes independent-session approvals: only one dossier can own the annual material scope', async () => {
    const { org, actor, hospital, year }=ANNUAL_FIXTURE;
    const invoke=async(name:string,args:unknown[]) => (await driver.as(actor,
      `SELECT public.phoenix_central_needs_${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) AS r`,args))[0] as {r:Record<string,string>};
    const [item]=await driver.admin("INSERT INTO public.central_items(name,name_ar,unit,status) VALUES('Race dossier item','مادة التزامن','box','active') RETURNING id");
    const a=(await invoke('open_dossier',[org,year,'race-a','حزمة تزامن أ'])).r;
    const b=(await invoke('open_dossier',[org,year,'race-b','حزمة تزامن ب'])).r;
    for (const [key,revision] of [['a',a.plan_revision_id],['b',b.plan_revision_id]]) {
      await invoke('add_manual_need_line',[revision,hospital,(item as {id:string}).id,null,'1','Concurrency fixture',`dossier-race-${key}`,null,null]);
      await invoke('submit_revision',[revision]);
    }
    const c1=await rig.pool.connect(); const c2=await rig.pool.connect();
    let second: Promise<{ok?:boolean;error?:Error}> | undefined;
    try {
      for (const c of [c1,c2]) {
        await c.query('BEGIN');await c.query('SET LOCAL ROLE authenticated');
        await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[actor]);
      }
      const pid1=(await c1.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pid2=(await c2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await c1.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text,210001))",[org,year]);
      second=c2.query('SELECT public.phoenix_central_needs_approve_revision($1)',[b.plan_revision_id])
        .then(()=>({ok:true}),(error:Error)=>({error}));
      let blocked=false;
      const until=Date.now()+5000;
      while (!blocked && Date.now()<until) {
        const [r]=await driver.admin('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked',[pid1,pid2]);
        blocked=(r as {blocked:boolean}).blocked;
        if(!blocked) await new Promise((resolve)=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
      await c1.query('SELECT public.phoenix_central_needs_approve_revision($1)',[a.plan_revision_id]);
      await c1.query('COMMIT');
      const result=await second;
      expect(result.error?.message).toContain('annual_need_duplicate_dossier_scope');
      await c2.query('ROLLBACK');
      const [count]=await driver.admin("SELECT count(*)::int AS n FROM public.central_needs_plan_revisions WHERE id=ANY($1::uuid[]) AND status='approved'",[[a.plan_revision_id,b.plan_revision_id]]);
      expect((count as {n:number}).n).toBe(1);
    } finally {
      await c1.query('ROLLBACK');
      if(second) await second;
      await c2.query('ROLLBACK');c1.release();c2.release();
    }
  },30_000);
});
