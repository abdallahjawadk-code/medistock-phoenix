import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — the established disposable PostgreSQL rig is JavaScript.
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import { simpleInput } from '../../../src/features/central-needs/annual-catalog/__tests__/fixture-helpers';
import { extractAnnualIdentityBlock } from '../../../src/features/central-needs/annual-catalog/annual-catalog-source';

const run=rigAvailable()?describe.sequential:describe.skip;
const F={
  org:'f2100000-0000-4000-8000-000000000001',
  other:'f2100000-0000-4000-8000-000000000002',
  editor:'f2100000-0000-4000-8000-000000000011',
  checker:'f2100000-0000-4000-8000-000000000012',
  outsider:'f2100000-0000-4000-8000-000000000013',
};
const key=()=> 'r21-'+randomUUID();
const candidates=['P1_dossier_workbook_reservation_NOT_APPLIED.sql',
 'P3A1_annual_catalog_NOT_APPLIED.sql','P3B_annual_needs_audit_NOT_APPLIED.sql',
 'R21_year_identity_rollover_NOT_APPLIED.sql'];
type RolloverResult={
  scope:{ownerOrgId:string;planningYear:number};
  sourceYear:number;
  carried:{sourceAnnualItemId:string;targetAnnualItemId:string;canonicalItemId:string}[];
  held:{sourceAnnualItemId:string;canonicalItemId:string;reason:string}[];
  nextAfterCanonicalItemId:string|null;idempotentReplay:boolean;
};
async function guardDisposableTarget() {
  const url=new URL(process.env.PHOENIX_RIG_PG??'');
  expect(['postgres:','postgresql:']).toContain(url.protocol);
  expect(['127.0.0.1','localhost']).toContain(url.hostname);
  expect(url.port).toBe('55432');expect(url.username).toBe('postgres');
  expect(url.pathname).toBe('/postgres');expect(url.search).toBe('');expect(url.hash).toBe('');
  expect(process.env.CI).toBe('true');expect(process.env.GITHUB_ACTIONS).toBe('true');
  expect(process.env.PHOENIX_RIG_CANDIDATES||'').toBe('');
  expect(process.env.PHOENIX_RIG_DB||'phoenix_rig').toBe('phoenix_rig');
  const client=new pg.Client({connectionString:process.env.PHOENIX_RIG_PG,connectionTimeoutMillis:5000});
  await client.connect();
  try {
    const z=await client.query("SELECT current_database() db,current_user actor, current_setting('server_version_num')::int version,(SELECT system_identifier::text FROM pg_control_system()) sysid");
    const id=z.rows[0];
    expect(id.db).toBe('postgres');expect(id.actor).toBe('postgres');
    expect([17,18]).toContain(Math.trunc(id.version/10000));
    return id.sysid as string;
  } finally {await client.end();}
}
run('R21 year-to-year identity-only writer candidate — disposable PostgreSQL',()=>{
  let rig:Awaited<ReturnType<typeof buildRig>>;
  let material1:string,material2:string,source1:string,source2:string;
  const admin=async <T extends Record<string,unknown>=Record<string,unknown>>(sql:string,params:unknown[]=[]):Promise<T[]>=>
    rig.asAdmin(async(c:PoolClient)=>(await c.query(sql,params)).rows);
  const call=async <T=unknown>(suffix:string,args:unknown[],actor:string|null=F.editor,role='authenticated'):Promise<T>=>
    rig.asUser(actor,async(c:PoolClient)=>{
      const sql='SELECT public.phoenix_central_needs_'+suffix+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') r';
      return (await c.query(sql,args)).rows[0].r;
    },{role,commit:true});
  const open=(year:number)=>call('open_catalog_year',[F.org,year,key()]);
  const preview=(year:number,id:string)=>call<{canonicalFingerprint:string}>('preview_annual_canonical',[F.org,year,id]);
  const witness=(year:number)=>{
    const x=simpleInput();x.scope={ownerOrgId:F.org,planningYear:year};x.sourceScope={...x.scope};
    x.sourceId='source-'+randomUUID();
    x.parsed.input.sha256=randomUUID().replaceAll('-','').padEnd(64,'a');
    x.block.classification={label:'الأدوية الأساسية',origin:'source',reference:'approved-2026-file:sheet1:row2'};
    return extractAnnualIdentityBlock(x);
  };
  const add=async(year:number,canonical:string,reviewed:boolean)=>{
    const p=await preview(year,canonical);
    return call<{membership:{annualItemId:string}}>('add_annual_catalog_item',
      [F.org,year,canonical,p.canonicalFingerprint,
       JSON.stringify(reviewed?witness(year):[]),'Approved canonical identity evidence',key()]);
  };
  const approve=(actor=F.checker,token=key())=>call('approve_rollover_source',
    [F.org,2026,'Independent checker approves identity snapshot',token],actor);
  const carry=(token=key(),actor=F.editor)=>call<RolloverResult>('rollover_catalog_page',
    [F.org,2027,2026,null,100,'Identity only; no quantities',token],actor);

  beforeAll(async()=>{
    const id=await guardDisposableTarget();
    rig=await buildRig({upTo:235});
    const actual=(await admin<{sysid:string}>('SELECT system_identifier::text sysid FROM pg_control_system()'))[0].sysid;
    expect(actual).toBe(id);
    for(const filename of candidates){
      const sql=readFileSync(new URL('../'+filename,import.meta.url),'utf8');
      await rig.asAdmin(async(c:PoolClient)=>{try{await c.query(sql)}catch(err){await c.query('ROLLBACK');throw err;}});
    }
    await admin("INSERT INTO public.organizations(id,name,name_ar,code,organization_kind,status) VALUES ($1,'R21 owner','دائرة النقل','r21-owner','pharmacy_department_authority','active'),($2,'Other R21','دائرة أخرى','r21-other','pharmacy_department_authority','active')",[F.org,F.other]);
    for(const [id,owner] of [[F.editor,F.org],[F.checker,F.org],[F.outsider,F.other]]){
      await admin('INSERT INTO auth.users(id,email) VALUES($1,$2)',[id,id+'@fixture.invalid']);
      await admin("UPDATE public.profiles SET role='warehouse_officer',organization_id=$2,status='active' WHERE id=$1",[id,owner]);
      for(const right of ['view','edit','approve','manual_need.set','material_review']){
        await admin('INSERT INTO public.profile_permission_overrides(profile_id,permission_key,allowed) VALUES($1,$2,true) ON CONFLICT(profile_id,permission_key) DO UPDATE SET allowed=true',[id,'central_needs.'+right]);
      }
    }
    await open(2026);await open(2027);
    material1=(await admin<{id:string}>("INSERT INTO public.central_items(name,name_ar,unit,status,national_code,dosage_form,concentration) VALUES('R21 identity','مادة هُوية','box','active','00001234','tablet','500 mg') RETURNING id"))[0].id;
    material2=(await admin<{id:string}>("INSERT INTO public.central_items(name,name_ar,unit,status,national_code) VALUES('R21 unreviewed','مادة بلا تصنيف','box','active','00005678') RETURNING id"))[0].id;
    source1=(await add(2026,material1,true)).membership.annualItemId;
    source2=(await add(2026,material2,false)).membership.annualItemId;
  },900000);
  afterAll(async()=>{if(rig)await rig.end();},30000);

  it('rejects source actor self-approval, foreign owner and no approval at all',async()=>{
    await expect(approve(F.editor)).rejects.toThrow(/maker_checker_conflict/);
    await expect(approve(F.outsider)).rejects.toThrow();
    await expect(call('approve_rollover_source',[F.org,2026,'no auth',key()],null,'anon')).rejects.toThrow();
    await expect(carry()).rejects.toThrow(/source_unapproved/);
  });
  it('independent checker authorizes exact source hash and replay is idempotent',async()=>{
    const token=key();
    const a=await approve(F.checker,token) as {sourceDigest:string;approvalStatus:string;idempotentReplay:boolean};
    expect(a.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.approvalStatus).toBe('identity_source_approved');
    expect(a.idempotentReplay).toBe(false);
    expect((await approve(F.checker,token) as typeof a).idempotentReplay).toBe(true);
    await expect(approve()).rejects.toThrow(/already_approved/);
  });
  it('copies only eligible identities and keeps original 2026 data and 2027 provenance distinct',async()=>{
    const before=(await admin<{n:number}>('SELECT count(*)::int n FROM public.central_needs_manual_need_events'))[0].n;
    const out=await carry();
    expect(out.carried).toHaveLength(1);
    expect(out.held).toHaveLength(1);
    expect(out.held[0]).toMatchObject({sourceAnnualItemId:source2,reason:'source_classification_unreviewed'});
    expect(out.carried[0].sourceAnnualItemId).toBe(source1);
    const target=out.carried[0].targetAnnualItemId;
    expect(target).not.toBe(source1);
    const item=await call<{fieldVersion:{fields:{nationalCode:{value:string}}}}>('get_annual_catalog_item',[F.org,2027,target,null]);
    expect(item.fieldVersion.fields.nationalCode.value).toBe('00001234');
    const link=await admin<{source_field_version_id:string;original_classifications:unknown}>(
      'SELECT source_field_version_id,original_classifications FROM public.phoenix_year_rollover_links WHERE organization_id=$1 AND target_year=2027 AND target_annual_item_id=$2',[F.org,target]);
    expect(link).toHaveLength(1);
    expect(JSON.stringify(link[0].original_classifications)).toContain('الأدوية الأساسية');
    const old=await call<{membership:{annualItemId:string}}>('get_annual_catalog_item',[F.org,2026,source1,null]);
    expect(old.membership.annualItemId).toBe(source1);
    expect((await admin<{n:number}>('SELECT count(*)::int n FROM public.central_needs_manual_need_events'))[0].n).toBe(before);
  });
  it('replays receipts and does not duplicate identity transfer',async()=>{
    const token=key();
    const one=await carry(token),two=await carry(token),newTry=await carry();
    expect(one.carried).toHaveLength(0);
    expect(two.idempotentReplay).toBe(true);
    expect(newTry.held.map(row=>row.reason)).toContain('target_already_contains_material');
    expect((await admin<{n:number}>('SELECT count(*)::int n FROM public.phoenix_year_rollover_links'))[0].n).toBe(1);
  });
  it('rejects direct access by all API roles and refuses cross-owner copying',async()=>{
    for(const role of ['anon','authenticated','service_role']){
      for(const table of ['phoenix_year_rollover_links','phoenix_year_rollover_source_approvals']){
        for(const privilege of ['SELECT','INSERT']){
          const ok=await admin<{ok:boolean}>('SELECT has_table_privilege($1,$2,$3) ok',[role,'public.'+table,privilege]);
          expect(ok[0].ok).toBe(false);
        }
      }
    }
    await expect(carry(key(),F.outsider)).rejects.toThrow();
    await expect(call('rollover_catalog_page',[F.org,2027,2026,null,100,'blocked',key()],null,'anon')).rejects.toThrow();
  });
  it('a source change after approval fail-closes before writing more identities',async()=>{
    const material=(await admin<{id:string}>("INSERT INTO public.central_items(name,name_ar,unit,status,national_code) VALUES('new R21','مادة لاحقة','box','active','00009999') RETURNING id"))[0].id;
    await add(2026,material,true);
    await expect(carry()).rejects.toThrow(/source_approval_stale/);
    expect((await admin<{n:number}>('SELECT count(*)::int n FROM public.phoenix_year_rollover_links'))[0].n).toBe(1);
  });
});
