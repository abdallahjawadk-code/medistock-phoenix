import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
const run = rigAvailable() ? describe : describe.skip;

const ORG='00000000-0000-0000-0000-000000177001';
const WH='00000000-0000-0000-0000-000000177101';
const WH2='00000000-0000-0000-0000-000000177102';
const DP='00000000-0000-0000-0000-000000177201';
const DP2='00000000-0000-0000-0000-000000177202';
const CI_A='00000000-0000-0000-0000-000000177301';
const CI_B='00000000-0000-0000-0000-000000177302';
const CI_H='00000000-0000-0000-0000-000000177303';
const CI_E='00000000-0000-0000-0000-000000177304';
const CI_CV='00000000-0000-0000-0000-000000177305';
const CI_U='00000000-0000-0000-0000-000000177306';
const CI_UM='00000000-0000-0000-0000-000000177307';
const CI_F='00000000-0000-0000-0000-000000177308';
const CI_D='00000000-0000-0000-0000-000000177309';
const LI_A='00000000-0000-0000-0000-000000177401';
const LI_U='00000000-0000-0000-0000-000000177402';
const LI_F='00000000-0000-0000-0000-000000177403';
const QRT_DP='00000000-0000-0000-0000-000000177501';
const QRT_WH='00000000-0000-0000-0000-000000177502';
const QRT_LI='00000000-0000-0000-0000-000000177503';
const QRT_DP2='00000000-0000-0000-0000-000000177504';
const QRT_WH2='00000000-0000-0000-0000-000000177505';
const QRT_LI_U='00000000-0000-0000-0000-000000177506';
const QTK_DP='00000000-0000-0000-0000-000000177601';
const QTK_WH='00000000-0000-0000-0000-000000177602';
const QTK_LI='00000000-0000-0000-0000-000000177603';
const QTK_DP2='00000000-0000-0000-0000-000000177604';
const QTK_WH2='00000000-0000-0000-0000-000000177605';
const QTK_LI_U='00000000-0000-0000-0000-000000177606';
const PUB_DP='g2-public-dp';
const PUB_WH='g2-public-wh';
const PUB_LI='g2-public-li';
const PUB_DP2='g2-public-dp2';
const PUB_WH2='g2-public-wh2';
const PUB_LI_U='g2-public-li-u';
const FAR='2035-12-31';
const PAST='2020-01-01';

const qtys=(rows:any[],name:string)=>rows.filter(r=>r.name===name).map(r=>r.quantity).sort((a,b)=>a-b);

run('177 · canonical public QR (dynamic)',()=>{
  let rig: Awaited<ReturnType<typeof buildRig>>;
  const asAnon=(publicId:string)=>rig.asUser(null,(c:any)=>c.query(
    'SELECT public.get_public_qr_payload($1) AS payload',[publicId],
  ).then((r:any)=>r.rows[0].payload),{role:'anon'});

  beforeAll(async()=>{
    rig=await buildRig();
    await rig.asAdmin(async(c:any)=>{
      await c.query(`INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class)
        VALUES($1,'G2 Org','مؤسسة G2','g2-org','care_institution','hospital')
        ON CONFLICT(id) DO NOTHING`,[ORG]);
      await c.query(`INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ($1,$3,'G2 Warehouse','مذخر G2','active','institution','g2-wh'),
        ($2,$3,'G2 Warehouse Two','مذخر G2 الثاني','active','institution','g2-wh2')
        ON CONFLICT(id) DO NOTHING`,[WH,WH2,ORG]);
      await c.query(`INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
        ($1,$3,$5,'G2 Pharmacy','صيدلية G2','pharmacy','active','non_emergency'),
        ($2,$4,$5,'G2 Pharmacy Two','صيدلية G2 الثانية','pharmacy','active','non_emergency')
        ON CONFLICT(id) DO NOTHING`,[DP,DP2,WH,WH2,ORG]);
      await c.query(`INSERT INTO central_items(id,name,name_ar,unit,status) VALUES
        ($1,'Canonical A','دواء A','box','active'),
        ($2,'Canonical B','دواء B','box','active'),
        ($3,'Hidden H','دواء مخفي','box','active'),
        ($4,'Expired E','دواء منتهي','box','active'),
        ($5,'Casevar Drug','دواء تنويع','box','active'),
        ($6,'Unitvar Drug','دواء وحدات','box','active'),
        ($7,'Unitmark Drug','دواء وحدات محذوف','box','active'),
        ($8,'Fcentral Product','دواء مركزي','box','active'),
        ($9,'Driftmark Drug','دواء منسق','box','active')
        ON CONFLICT(id) DO NOTHING`,[CI_A,CI_B,CI_H,CI_E,CI_CV,CI_U,CI_UM,CI_F,CI_D]);
      await c.query(`INSERT INTO local_items(id,central_item_id,organization_id,local_name,local_code,status) VALUES
        ($1,$4,$7,'Local A','G2-LA','active'),
        ($2,$5,$7,'Local U','G2-LU','active'),
        ($3,$6,$7,'Local F','G2-LF','active')
        ON CONFLICT(id) DO NOTHING`,[LI_A,LI_U,LI_F,CI_A,CI_U,CI_F,ORG]);

      // Canonical A is split by provenance but one public batch identity: 10+15=25.
      await c.query(`INSERT INTO outlet_stock(
        id,organization_id,distribution_point_id,point_type,central_item_id,scientific_name,
        concentration,dosage_form,unit,national_code,has_no_national_code,
        batch_number,has_no_batch_number,expiry_date,on_hand_quantity,reserved_quantity,movement_seq,supply_type
      ) VALUES
        (gen_random_uuid(),$1,$2,'pharmacy',$3,'Canonical A','500 mg','tablet','box','G2-A',false,'A-BATCH',false,$7,10,0,1,'kimadia'),
        (gen_random_uuid(),$1,$2,'pharmacy',$3,'Canonical A','500 mg','tablet','box','G2-A',false,'A-BATCH',false,$7,15,0,1,'aid'),
        (gen_random_uuid(),$1,$2,'pharmacy',$4,'Canonical B','250 mg','capsule','box','G2-B',false,'B-BATCH',false,$7,7,0,1,'kimadia'),
        (gen_random_uuid(),$1,$2,'pharmacy',$5,'Hidden H','10 mg','tablet','box','G2-H',false,'H-BATCH',false,$7,9,0,1,'kimadia'),
        (gen_random_uuid(),$1,$2,'pharmacy',$6,'Expired E','20 mg','tablet','box','G2-E',false,'E-BATCH',false,$8,4,0,1,'kimadia')`,
        [ORG,DP,CI_A,CI_B,CI_H,CI_E,FAR,PAST]);

      // ---------------------------------------------------------------------
      // Adversarial canonical-identity fixtures, all at DP2 / WH2 so the
      // long-standing DP/WH expectations above stay untouched.
      //
      // Casevar  — ONE canonical identity written with different case and
      //            padding, separated only by supply provenance. Migration 150
      //            normalizes lower(btrim(...)), so 4+6 must aggregate to 10.
      // Unitvar  — TWO canonical identities differing ONLY by unit. 150 says
      //            unit is part of material identity, so 5 and 3 must stay
      //            apart and must never be summed to 8.
      // Unitmark — same unit-distinct shape, plus a removal marker. A marker
      //            cannot express unit, so it is ambiguous and must hide
      //            NEITHER identity.
      // Fcentral — TWO canonical identities under ONE central_item_id, apart
      //            only by scientific_name. A marker naming Alpha must hide
      //            Alpha alone and must never hide Beta on central match.
      // ---------------------------------------------------------------------
      await c.query(`INSERT INTO outlet_stock(
        id,organization_id,distribution_point_id,point_type,central_item_id,scientific_name,
        concentration,dosage_form,unit,national_code,has_no_national_code,
        batch_number,has_no_batch_number,expiry_date,on_hand_quantity,reserved_quantity,movement_seq,supply_type
      ) VALUES
        (gen_random_uuid(),$1,$2,'pharmacy',$3,'Casevar Drug','500 mg','tablet','box','G2-CV',false,'CV-BATCH',false,$8,4,0,1,'kimadia'),
        (gen_random_uuid(),$1,$2,'pharmacy',$3,'CASEVAR DRUG','500 MG','Tablet','BOX','g2-cv',false,'CV-BATCH',false,$8,6,0,1,'aid'),
        (gen_random_uuid(),$1,$2,'pharmacy',$4,'Unitvar Drug','250 mg','capsule','box','G2-U',false,'U-BATCH',false,$8,5,0,1,'kimadia'),
        (gen_random_uuid(),$1,$2,'pharmacy',$4,'Unitvar Drug','250 mg','capsule','strip','G2-U',false,'U-BATCH',false,$8,3,0,1,'kimadia'),
        (gen_random_uuid(),$1,$2,'pharmacy',$5,'Unitmark Drug','125 mg','syrup','box','G2-UM',false,'UM-BATCH',false,$8,6,0,1,'kimadia'),
        (gen_random_uuid(),$1,$2,'pharmacy',$5,'Unitmark Drug','125 mg','syrup','bottle','G2-UM',false,'UM-BATCH',false,$8,2,0,1,'kimadia'),
        (gen_random_uuid(),$1,$2,'pharmacy',$6,'Fcentral Alpha','10 mg','tablet','box','G2-F',false,'F-BATCH',false,$8,8,0,1,'kimadia'),
        (gen_random_uuid(),$1,$2,'pharmacy',$6,'Fcentral Beta','10 mg','tablet','box','G2-F',false,'F-BATCH',false,$8,11,0,1,'kimadia'),
        (gen_random_uuid(),$1,$2,'pharmacy',$7,'Driftmark Drug','75 mg','ampoule','box','G2-DM',false,'DM-BATCH',false,$8,13,0,1,'kimadia')`,
        [ORG,DP2,CI_CV,CI_U,CI_UM,CI_F,CI_D,FAR]);

      // Poison cache A: its quantity/condition must never affect the public result.
      await c.query(`INSERT INTO item_availability(
        id,local_item_id,distribution_point_id,organization_id,port_name,scientific_name,
        concentration,dosage_form,national_code,batch_number,expiry_date,quantity,condition,removed_at
      ) VALUES($1,$2,$3,$4,'G2 Pharmacy','Canonical A','500 mg','tablet','G2-A','A-BATCH',$5,999,'surplus',NULL)`,
        [randomUUID(),LI_A,DP,ORG,FAR]);
      // Hidden cache H: legacy marker with NO local_item_id — central item is
      // unprovable, so the four provable components must resolve it alone.
      await c.query(`INSERT INTO item_availability(
        id,distribution_point_id,organization_id,port_name,scientific_name,
        concentration,dosage_form,national_code,batch_number,expiry_date,quantity,condition,removed_at,removal_reason
      ) VALUES($1,$2,$3,'G2 Pharmacy','Hidden H','10 mg','tablet','G2-H','H-BATCH',$4,123,'available',now(),'removed_from_outlet')`,
        [randomUUID(),DP,ORG,FAR]);
      // Unitmark marker: matches BOTH unit-distinct identities → ambiguous.
      await c.query(`INSERT INTO item_availability(
        id,distribution_point_id,organization_id,port_name,scientific_name,
        concentration,dosage_form,national_code,batch_number,expiry_date,quantity,condition,removed_at,removal_reason
      ) VALUES($1,$2,$3,'G2 Pharmacy Two','Unitmark Drug','125 mg','syrup','G2-UM','UM-BATCH',$4,0,'available',now(),'removed_from_outlet')`,
        [randomUUID(),DP2,ORG,FAR]);
      // Fcentral marker: carries local_item_id (central PROVEN = CI_F) and
      // names Alpha exactly. Matching on the central item alone would hide
      // Beta too, so this must hide Alpha and only Alpha.
      await c.query(`INSERT INTO item_availability(
        id,local_item_id,distribution_point_id,organization_id,port_name,scientific_name,
        concentration,dosage_form,national_code,batch_number,expiry_date,quantity,condition,removed_at,removal_reason
      ) VALUES($1,$2,$3,$4,'G2 Pharmacy Two','Fcentral Alpha','10 mg','tablet','G2-F','F-BATCH',$5,0,'available',now(),'removed_from_outlet')`,
        [randomUUID(),LI_F,DP2,ORG,FAR]);
      // Driftmark marker: item_availability carries no btrim/case constraint,
      // so a real marker can differ from stock by case and padding. It must be
      // compared through 150's normalization, not as raw text.
      await c.query(`INSERT INTO item_availability(
        id,distribution_point_id,organization_id,port_name,scientific_name,
        concentration,dosage_form,national_code,batch_number,expiry_date,quantity,condition,removed_at,removal_reason
      ) VALUES($1,$2,$3,'G2 Pharmacy Two',' driftmark DRUG ','75 MG','AMPOULE',' g2-dm ','DM-BATCH',$4,0,'available',now(),'removed_from_outlet')`,
        [randomUUID(),DP2,ORG,FAR]);

      await c.query(`INSERT INTO qr_targets(id,organization_id,target_type,target_id,label,status) VALUES
        ($1,$7,'distribution_point',$8,'G2 Point','active'),
        ($2,$7,'warehouse',$9,'G2 Warehouse','active'),
        ($3,$7,'local_item',$10,'G2 Local A','active'),
        ($4,$7,'distribution_point',$11,'G2 Point Two','active'),
        ($5,$7,'warehouse',$12,'G2 Warehouse Two','active'),
        ($6,$7,'local_item',$13,'G2 Local U','active')`,
        [QRT_DP,QRT_WH,QRT_LI,QRT_DP2,QRT_WH2,QRT_LI_U,ORG,DP,WH,LI_A,DP2,WH2,LI_U]);
      await c.query(`INSERT INTO qr_tokens(id,qr_target_id,organization_id,public_id,token_hash,status) VALUES
        ($1,$7,$13,$14,'hash-dp','active'),
        ($2,$8,$13,$15,'hash-wh','active'),
        ($3,$9,$13,$16,'hash-li','active'),
        ($4,$10,$13,$17,'hash-dp2','active'),
        ($5,$11,$13,$18,'hash-wh2','active'),
        ($6,$12,$13,$19,'hash-li-u','active')`,
        [QTK_DP,QTK_WH,QTK_LI,QTK_DP2,QTK_WH2,QTK_LI_U,
         QRT_DP,QRT_WH,QRT_LI,QRT_DP2,QRT_WH2,QRT_LI_U,
         ORG,PUB_DP,PUB_WH,PUB_LI,PUB_DP2,PUB_WH2,PUB_LI_U]);
    });
  });

  afterAll(async()=>{await rig?.end?.();});

  it('keeps anon/authenticated/service_role EXECUTE',async()=>{
    const r=await rig.asAdmin((c:any)=>c.query(`SELECT
      has_function_privilege('anon','public.get_public_qr_payload(text)','EXECUTE') AS anon,
      has_function_privilege('authenticated','public.get_public_qr_payload(text)','EXECUTE') AS auth,
      has_function_privilege('service_role','public.get_public_qr_payload(text)','EXECUTE') AS service`));
    expect(r.rows[0]).toEqual({anon:true,auth:true,service:true});
  });

  it('does not widen the internal canonical identity helper to public roles',async()=>{
    // 177 calls _phoenix_material_identity_v1 from inside a SECURITY DEFINER
    // body. That must NOT translate into a direct grant for anonymous callers.
    const r=await rig.asAdmin((c:any)=>c.query(`SELECT
      has_function_privilege('anon','public._phoenix_material_identity_v1(uuid,text,text,text,text,text)','EXECUTE') AS anon,
      has_function_privilege('authenticated','public._phoenix_material_identity_v1(uuid,text,text,text,text,text)','EXECUTE') AS auth`));
    expect(r.rows[0]).toEqual({anon:false,auth:false});
  });

  it('distribution-point QR uses canonical quantity, includes canonical-only stock, hides removed metadata, and keeps privacy',async()=>{
    const p=await asAnon(PUB_DP);
    expect(p.ok).toBe(true);
    expect(p.target_type).toBe('distribution_point');
    const byName=new Map((p.items??[]).map((x:any)=>[x.name,x]));
    expect(byName.get('Canonical A')?.quantity).toBe(25);
    expect(byName.get('Canonical A')?.condition).toBe('available');
    expect(byName.get('Canonical B')?.quantity).toBe(7);
    expect(byName.has('Hidden H')).toBe(false);
    expect(byName.get('Expired E')?.condition).toBe('expired');
    expect(byName.get('Expired E')?.quantity).toBeNull();
    for(const item of p.items??[]){
      for(const key of ['batch_number','national_code','price','trade_name','notes','actor_name_snapshot','actor_email_snapshot']){
        expect(item).not.toHaveProperty(key);
      }
    }
  });

  it('G · aggregates permitted supply provenance for one canonical material+lot identity',async()=>{
    // 10 kimadia + 15 aid, identical in every material and lot dimension.
    const p=await asAnon(PUB_DP);
    expect(qtys(p.items??[],'Canonical A')).toEqual([25]);
  });

  it('H · poisoned cache quantity/condition cannot reach the public payload',async()=>{
    // item_availability says 999 / 'surplus'. outlet_stock says 25 / available.
    const p=await asAnon(PUB_DP);
    const a=(p.items??[]).find((x:any)=>x.name==='Canonical A');
    expect(a.quantity).toBe(25);
    expect(a.quantity).not.toBe(999);
    expect(a.condition).toBe('available');
    expect(a.condition).not.toBe('surplus');
  });

  it('I · canonical-only stock with no cache row stays visible',async()=>{
    const p=await asAnon(PUB_DP);
    expect(qtys(p.items??[],'Canonical B')).toEqual([7]);
  });

  it('A · case variants of ONE canonical identity aggregate, never duplicate',async()=>{
    // Migration 150 normalizes lower(btrim(...)) across every component, so
    // 'Casevar Drug'/'CASEVAR DRUG' is ONE material identity. Raw-tuple
    // grouping publishes two rows of 4 and 6 instead of one row of 10.
    //
    // Only CASE drift is exercised on the stock side: outlet_stock's
    // *_chk constraints enforce btrim(x)=x on scientific_name, concentration,
    // dosage_form, national_code and unit, so padded variants cannot exist
    // there at all. item_availability carries no such constraint, so the
    // padding half of this invariant is proven on the marker side below.
    const p=await asAnon(PUB_DP2);
    expect(p.ok).toBe(true);
    expect(qtys(p.items??[],'Casevar Drug')).toEqual([10]);
  });

  it('B · unit-distinct canonical identities stay distinct and are never summed',async()=>{
    // 150: unit is part of material identity, with no unit equivalence.
    // 5 box and 3 strip must remain two public rows, never one row of 8.
    //
    // NOTE: this is a REGRESSION GUARD, not a negative test. The distribution
    // point branch already carried unit in its grouping tuple before this
    // remediation, so it passes against the old body too. The QUANTITY defect
    // lived in the warehouse and local_item branches — C and D below are the
    // cases that genuinely fail against the pre-remediation function.
    //
    // Splitting the quantities is only half of THIS branch's contract: the two
    // rows must also be LABELLED with their own units. B2/B3 below cover that,
    // and B3 is the genuine negative proof for it.
    const p=await asAnon(PUB_DP2);
    const q=qtys(p.items??[],'Unitvar Drug');
    expect(q).toEqual([3,5]);
    expect(q).not.toContain(8);
    // Evidence that 150 really does hold these apart: the two rows carry two
    // different generated canonical keys, differing only by unit.
    const keys=await rig.asAdmin((c:any)=>c.query(
      `SELECT DISTINCT material_identity_key FROM outlet_stock
       WHERE distribution_point_id=$1 AND central_item_id=$2`,[DP2,CI_U]));
    expect(keys.rows).toHaveLength(2);
  });

  it('B2 · every distribution-point row carries the unit of its OWN canonical identity',async()=>{
    // The anonymous point payload is what a member of the public actually
    // scans. Physical truth at DP2 is 5 box and 3 strip. central_items.unit for
    // Unitvar Drug is 'box' for BOTH rows, so sourcing the row unit from the
    // catalogue publishes "3 box" for stock that is 3 strip — a public
    // data-semantics error, not a display nicety.
    const p=await asAnon(PUB_DP2);
    expect(p.ok).toBe(true);
    expect(p.target_type).toBe('distribution_point');

    const rows=(p.items??[]).filter((x:any)=>x.name==='Unitvar Drug');
    // Exactly two canonical rows — never merged, never duplicated.
    expect(rows).toHaveLength(2);

    const pairs=rows.map((x:any)=>[x.quantity,x.unit]).sort((a:any,b:any)=>a[0]-b[0]);
    expect(pairs).toEqual([[3,'strip'],[5,'box']]);
    // No summed quantity, and no borrowed label.
    expect(pairs.map(([q]:any)=>q)).not.toContain(8);
    expect(pairs).not.toEqual([[3,'box'],[5,'box']]);

    // Units are distinct, and every row really carries one.
    expect(new Set(rows.map((x:any)=>x.unit)).size).toBe(2);
    for(const row of rows){
      expect(typeof row.unit).toBe('string');
      expect(row.unit).not.toBe('');
    }

    // The catalogue unit that must NOT have relabelled the strip row.
    const ci=await rig.asAdmin((c:any)=>c.query(
      'SELECT unit FROM central_items WHERE id=$1',[CI_U]));
    expect(ci.rows[0].unit).toBe('box');

    // Two units published from two genuinely different canonical identities.
    const keys=await rig.asAdmin((c:any)=>c.query(
      `SELECT DISTINCT material_identity_key FROM outlet_stock
       WHERE distribution_point_id=$1 AND central_item_id=$2`,[DP2,CI_U]));
    expect(keys.rows).toHaveLength(2);

    // Splitting on canonical identity must not leak the identity itself, or any
    // other internal/sensitive field, into the anonymous payload.
    for(const row of rows){
      for(const key of ['material_identity_key','projection_key','central_item_id',
        'batch_number','internal_batch_reference','national_code','supply_type',
        'purchase_origin','price','trade_name','notes','distribution_point_id',
        'actor_name_snapshot','actor_email_snapshot','actor_role_snapshot']){
        expect(row,key).not.toHaveProperty(key);
      }
    }
  });

  it("B3 · NEGATIVE — the pre-fix body publishes the strip identity as 'box'",async()=>{
    // A genuine negative test, not a restatement of B2. It reinstalls EXACTLY
    // the pre-fix (a4d934b) distribution-point unit derivation — the two
    // expressions this remediation changed and nothing else — then runs B2's
    // assertion against it and proves it fails as 5 box + 3 box.
    //
    // The swap runs inside a transaction that is always rolled back. Postgres
    // DDL is transactional, so the fixed body is restored even on failure, and
    // the scan-counter side effect of the probe scan is discarded with it.
    const file=readFileSync(join(__dirname,'..','177_phoenix_canonical_public_qr.sql'),'utf8');
    const open=file.indexOf('CREATE OR REPLACE FUNCTION public.get_public_qr_payload(p_public_id text)');
    const close=file.indexOf('$function$;',open);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const fixedBody=file.slice(open,close+'$function$;'.length);

    // The exact pre-fix text of both changed expressions.
    const FIXED_ROW_UNIT="NULLIF(v.unit,'') AS row_unit";
    const PREFIX_ROW_UNIT="coalesce(v.central_unit,NULLIF(v.unit,'')) AS row_unit";
    const FIXED_VISIBLE='SELECT c.*,ci.name AS central_name,ci.name_ar AS central_name_ar,';
    const PREFIX_VISIBLE=FIXED_VISIBLE+'ci.unit AS central_unit,';

    // Each anchor must occur exactly once, so the reconstruction is unambiguous
    // and cannot silently no-op if the body is later restructured.
    expect(fixedBody.split(FIXED_ROW_UNIT)).toHaveLength(2);
    expect(fixedBody.split(FIXED_VISIBLE)).toHaveLength(2);

    const preFixBody=fixedBody
      .replace(FIXED_ROW_UNIT,PREFIX_ROW_UNIT)
      .replace(FIXED_VISIBLE,PREFIX_VISIBLE);
    expect(preFixBody).toContain(PREFIX_ROW_UNIT);
    expect(preFixBody).not.toContain(FIXED_ROW_UNIT);
    expect(preFixBody).not.toBe(fixedBody);

    const client=await rig.pool.connect();
    let observed:any;
    try{
      await client.query('BEGIN');
      await client.query(preFixBody);
      await client.query('SET LOCAL ROLE anon');
      const r=await client.query(
        'SELECT public.get_public_qr_payload($1) AS payload',[PUB_DP2]);
      observed=r.rows[0].payload;
    } finally {
      await client.query('ROLLBACK').catch(()=>{});
      client.release();
    }

    expect(observed.ok).toBe(true);
    const rows=(observed.items??[]).filter((x:any)=>x.name==='Unitvar Drug');
    const pairs=rows.map((x:any)=>[x.quantity,x.unit]).sort((a:any,b:any)=>a[0]-b[0]);

    // The defect, reproduced exactly: the quantities still split correctly (the
    // pre-fix body already grouped on canonical identity), but BOTH rows are
    // labelled from central_items.unit, so the strip identity is published as
    // box. This is the assertion B2 makes and this body cannot satisfy.
    expect(pairs).toEqual([[3,'box'],[5,'box']]);
    expect(pairs).not.toEqual([[3,'strip'],[5,'box']]);
    expect(new Set(rows.map((x:any)=>x.unit)).size).toBe(1);

    // And the fixed body is genuinely back in place afterwards.
    const restored=await asAnon(PUB_DP2);
    const restoredPairs=(restored.items??[])
      .filter((x:any)=>x.name==='Unitvar Drug')
      .map((x:any)=>[x.quantity,x.unit]).sort((a:any,b:any)=>a[0]-b[0]);
    expect(restoredPairs).toEqual([[3,'strip'],[5,'box']]);
  });

  it('E · an ambiguous removal marker hides no unit-distinct canonical identity',async()=>{
    // item_availability has no `unit` column, so this marker matches both the
    // box and bottle identities. It proves neither, so it hides neither and
    // physical truth stands.
    const p=await asAnon(PUB_DP2);
    expect(qtys(p.items??[],'Unitmark Drug')).toEqual([2,6]);
  });

  it('F · a removal marker naming one identity does not hide a sibling under the same central item',async()=>{
    // Alpha and Beta share central_item_id but are distinct canonical
    // identities. Matching on central item alone would hide both.
    const p=await asAnon(PUB_DP2);
    expect(qtys(p.items??[],'Fcentral Product')).toEqual([11]);
  });

  it('F2 · a removal marker is matched through canonical normalization, not raw text',async()=>{
    // The marker is written ' driftmark DRUG ' / '75 MG' / 'AMPOULE' / ' g2-dm '
    // against stock spelled 'Driftmark Drug' / '75 mg' / 'ampoule' / 'G2-DM'.
    // Raw equality would silently fail to hide a genuinely removed item.
    const p=await asAnon(PUB_DP2);
    expect(qtys(p.items??[],'Driftmark Drug')).toEqual([]);
  });

  it('preserves scan counter side effect for anonymous scans',async()=>{
    // qr_tokens.scan_count is `bigint not null default 0`, so it can never be
    // NULL and needs no COALESCE — the historical contract is intact, and 177
    // keeps the increment verbatim (its own VERIFY asserts the statement text).
    //
    // This case must run its OWN scan because of the harness: rig.asUser
    // defaults to commit:false and ROLLBACKs, so the `asAnon` helper above
    // discards this side effect along with the payload it read. Asserting a
    // counter accumulated by an earlier, rolled-back case tested nothing and
    // was order-dependent besides. So: read before, perform one COMMITTED
    // anonymous scan exactly as production does, read after, assert the delta.
    const before=await rig.asAdmin((c:any)=>c.query(
      'SELECT scan_count FROM qr_tokens WHERE id=$1',[QTK_DP]));
    const start=Number(before.rows[0].scan_count);

    const payload=await rig.asUser(null,(c:any)=>c.query(
      'SELECT public.get_public_qr_payload($1) AS payload',[PUB_DP],
    ).then((r:any)=>r.rows[0].payload),{role:'anon',commit:true});
    expect(payload.ok).toBe(true);

    const after=await rig.asAdmin((c:any)=>c.query(
      'SELECT scan_count,last_scanned_at FROM qr_tokens WHERE id=$1',[QTK_DP]));
    expect(Number(after.rows[0].scan_count)).toBe(start+1);
    expect(after.rows[0].last_scanned_at).toBeTruthy();
  });

  it('warehouse QR counts canonical publicly available identities, not cache rows',async()=>{
    const p=await asAnon(PUB_WH);
    expect(p.ok).toBe(true);
    expect(p.target_type).toBe('warehouse');
    expect(p.points).toHaveLength(1);
    // A + canonical-only B. Hidden H and expired E are not publicly available.
    expect(p.points[0].item_count).toBe(2);
  });

  it('C · warehouse item_count never collapses unit-distinct canonical identities',async()=>{
    // Casevar 1 + Unitvar 2 + Unitmark 2 + Fcentral Beta 1 = 6.
    // Raw-tuple grouping without unit would report 3.
    const p=await asAnon(PUB_WH2);
    expect(p.ok).toBe(true);
    expect(p.points).toHaveLength(1);
    expect(p.points[0].item_count).toBe(6);
  });

  it('local-item QR reads the same canonical central-item stock and remains point-scoped',async()=>{
    const p=await asAnon(PUB_LI);
    expect(p.ok).toBe(true);
    expect(p.target_type).toBe('local_item');
    expect(p.item_name).toBe('Canonical A');
    expect(p.availability).toHaveLength(1);
    expect(p.availability[0].point_name).toBe('G2 Pharmacy');
    expect(p.availability[0].quantity).toBe(25);
    expect(p.availability[0].condition).toBe('available');
    expect(p.availability[0]).not.toHaveProperty('batch_number');
  });

  it('D · local-item availability never sums unit-distinct canonical identities',async()=>{
    // Both entries are at the same point; only the unit differs. Summing them
    // would publish a physically meaningless 8.
    const p=await asAnon(PUB_LI_U);
    expect(p.ok).toBe(true);
    expect(p.availability).toHaveLength(2);
    const q=p.availability.map((x:any)=>x.quantity).sort((a:number,b:number)=>a-b);
    expect(q).toEqual([3,5]);
    expect(q).not.toContain(8);
    for(const row of p.availability) expect(row.point_name).toBe('G2 Pharmacy Two');
  });

  it('D2 · every local-item availability row carries the unit of its OWN canonical identity',async()=>{
    // Splitting the quantities is only half the contract. A public reader sees
    // "5" and "3"; without a per-row unit those numbers are unattributable and
    // the split is meaningless. central_items.unit for this local item is 'box'
    // for BOTH rows, so sourcing the row unit from it would label the strip row
    // 'box' and misstate physical stock.
    const p=await asAnon(PUB_LI_U);
    expect(p.unit).toBe('box'); // top-level central unit preserved, unchanged

    const pairs=p.availability
      .map((x:any)=>[x.quantity,x.unit])
      .sort((a:any,b:any)=>a[0]-b[0]);
    expect(pairs).toEqual([[3,'strip'],[5,'box']]);

    // Every row must actually carry a unit — not merely differ.
    for(const row of p.availability){
      expect(typeof row.unit).toBe('string');
      expect(row.unit).not.toBe('');
    }
    // And the two rows must not collapse to the central item's single label.
    expect(new Set(p.availability.map((x:any)=>x.unit)).size).toBe(2);
  });

  it('D3 · local-item availability rows expose no internal identity or provenance',async()=>{
    const p=await asAnon(PUB_LI_U);
    for(const row of p.availability){
      for(const key of ['material_identity_key','projection_key','central_item_id',
        'batch_number','internal_batch_reference','national_code','supply_type',
        'purchase_origin','price','trade_name','notes','distribution_point_id']){
        expect(row,key).not.toHaveProperty(key);
      }
    }
  });

  it('J · privacy fields stay absent from every target type',async()=>{
    const secret=['batch_number','national_code','price','trade_name','notes',
      'actor_name_snapshot','actor_email_snapshot','actor_role_snapshot','supply_type',
      'material_identity_key','internal_batch_reference'];
    for(const pub of [PUB_DP,PUB_DP2,PUB_LI,PUB_LI_U]){
      const p=await asAnon(pub);
      for(const row of (p.items??p.availability??[])){
        for(const key of secret) expect(row,`${pub}.${key}`).not.toHaveProperty(key);
      }
    }
  });

  it('disabled token is indistinguishable and does not expose payload data',async()=>{
    await rig.asAdmin((c:any)=>c.query("UPDATE qr_tokens SET status='disabled' WHERE id=$1",[QTK_LI]));
    const p=await asAnon(PUB_LI);
    expect(p).toEqual({ok:false,error:'QR_NOT_FOUND_OR_DISABLED'});
  });
});
