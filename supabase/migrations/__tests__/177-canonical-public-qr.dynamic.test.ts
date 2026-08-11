import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
const run = rigAvailable() ? describe : describe.skip;

const ORG='00000000-0000-0000-0000-000000177001';
const WH='00000000-0000-0000-0000-000000177101';
const DP='00000000-0000-0000-0000-000000177201';
const CI_A='00000000-0000-0000-0000-000000177301';
const CI_B='00000000-0000-0000-0000-000000177302';
const CI_H='00000000-0000-0000-0000-000000177303';
const CI_E='00000000-0000-0000-0000-000000177304';
const LI_A='00000000-0000-0000-0000-000000177401';
const QRT_DP='00000000-0000-0000-0000-000000177501';
const QRT_WH='00000000-0000-0000-0000-000000177502';
const QRT_LI='00000000-0000-0000-0000-000000177503';
const QTK_DP='00000000-0000-0000-0000-000000177601';
const QTK_WH='00000000-0000-0000-0000-000000177602';
const QTK_LI='00000000-0000-0000-0000-000000177603';
const PUB_DP='g2-public-dp';
const PUB_WH='g2-public-wh';
const PUB_LI='g2-public-li';
const FAR='2035-12-31';
const PAST='2020-01-01';

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
      await c.query(`INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code)
        VALUES($1,$2,'G2 Warehouse','مذخر G2','active','institution','g2-wh')
        ON CONFLICT(id) DO NOTHING`,[WH,ORG]);
      await c.query(`INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
        VALUES($1,$2,$3,'G2 Pharmacy','صيدلية G2','pharmacy','active','non_emergency')
        ON CONFLICT(id) DO NOTHING`,[DP,WH,ORG]);
      await c.query(`INSERT INTO central_items(id,name,name_ar,unit,status) VALUES
        ($1,'Canonical A','دواء A','box','active'),
        ($2,'Canonical B','دواء B','box','active'),
        ($3,'Hidden H','دواء مخفي','box','active'),
        ($4,'Expired E','دواء منتهي','box','active')
        ON CONFLICT(id) DO NOTHING`,[CI_A,CI_B,CI_H,CI_E]);
      await c.query(`INSERT INTO local_items(id,central_item_id,organization_id,local_name,local_code,status)
        VALUES($1,$2,$3,'Local A','G2-LA','active') ON CONFLICT(id) DO NOTHING`,[LI_A,CI_A,ORG]);

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

      // Poison cache A: its quantity/condition must never affect the public result.
      await c.query(`INSERT INTO item_availability(
        id,local_item_id,distribution_point_id,organization_id,port_name,scientific_name,
        concentration,dosage_form,national_code,batch_number,expiry_date,quantity,condition,removed_at
      ) VALUES($1,$2,$3,$4,'G2 Pharmacy','Canonical A','500 mg','tablet','G2-A','A-BATCH',$5,999,'surplus',NULL)`,
        [randomUUID(),LI_A,DP,ORG,FAR]);
      // Hidden cache H: same canonical identity, removed marker only; stock remains 9.
      await c.query(`INSERT INTO item_availability(
        id,distribution_point_id,organization_id,port_name,scientific_name,
        concentration,dosage_form,national_code,batch_number,expiry_date,quantity,condition,removed_at,removal_reason
      ) VALUES($1,$2,$3,'G2 Pharmacy','Hidden H','10 mg','tablet','G2-H','H-BATCH',$4,123,'available',now(),'removed_from_outlet')`,
        [randomUUID(),DP,ORG,FAR]);

      await c.query(`INSERT INTO qr_targets(id,organization_id,target_type,target_id,label,status) VALUES
        ($1,$4,'distribution_point',$5,'G2 Point','active'),
        ($2,$4,'warehouse',$6,'G2 Warehouse','active'),
        ($3,$4,'local_item',$7,'G2 Local A','active')`,[QRT_DP,QRT_WH,QRT_LI,ORG,DP,WH,LI_A]);
      await c.query(`INSERT INTO qr_tokens(id,qr_target_id,organization_id,public_id,token_hash,status) VALUES
        ($1,$4,$7,$8,'hash-dp','active'),
        ($2,$5,$7,$9,'hash-wh','active'),
        ($3,$6,$7,$10,'hash-li','active')`,[QTK_DP,QTK_WH,QTK_LI,QRT_DP,QRT_WH,QRT_LI,ORG,PUB_DP,PUB_WH,PUB_LI]);
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

  it('preserves scan counter side effect for anonymous scans',async()=>{
    const r=await rig.asAdmin((c:any)=>c.query('SELECT scan_count,last_scanned_at FROM qr_tokens WHERE id=$1',[QTK_DP]));
    expect(Number(r.rows[0].scan_count)).toBe(1);
    expect(r.rows[0].last_scanned_at).toBeTruthy();
  });

  it('warehouse QR counts canonical publicly available identities, not cache rows',async()=>{
    const p=await asAnon(PUB_WH);
    expect(p.ok).toBe(true);
    expect(p.target_type).toBe('warehouse');
    expect(p.points).toHaveLength(1);
    // A + canonical-only B. Hidden H and expired E are not publicly available.
    expect(p.points[0].item_count).toBe(2);
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

  it('disabled token is indistinguishable and does not expose payload data',async()=>{
    await rig.asAdmin((c:any)=>c.query("UPDATE qr_tokens SET status='disabled' WHERE id=$1",[QTK_LI]));
    const p=await asAnon(PUB_LI);
    expect(p).toEqual({ok:false,error:'QR_NOT_FOUND_OR_DISABLED'});
  });
});