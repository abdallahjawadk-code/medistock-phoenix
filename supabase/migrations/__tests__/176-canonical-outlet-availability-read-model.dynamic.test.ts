import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

const run = rigAvailable() ? describe : describe.skip;
const ORG = '00000000-0000-0000-0000-000000176001';
const ORG_OTHER = '00000000-0000-0000-0000-000000176002';
const WH = '00000000-0000-0000-0000-000000176101';
const WH_OTHER = '00000000-0000-0000-0000-000000176102';
const DP = '00000000-0000-0000-0000-000000176201';
const DP_OTHER = '00000000-0000-0000-0000-000000176202';
const OTHER_USER = '00000000-0000-0000-0000-000000176301';
const FAR_FUTURE = new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

run('176 · canonical outlet availability read model (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const readModel = (uid: string, pointId: string) =>
    rig.asUser(uid, (c: any) => c.query(
      `SELECT public.phoenix_outlet_availability_read_model($1) AS r`, [pointId],
    ).then((r: any) => r.rows[0].r));

  beforeAll(async () => {
    rig = await buildRig();
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class)
        VALUES
          ($1,'G1 Org','G1','g1-org','care_institution','hospital'),
          ($2,'G1 Other','G1 Other','g1-other','care_institution','hospital')
        ON CONFLICT (id) DO NOTHING`, [ORG, ORG_OTHER]);
      await c.query(`
        INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code)
        VALUES
          ($1,$2,'G1 Warehouse','G1 Warehouse','active','institution','g1-wh'),
          ($3,$4,'G1 Other WH','G1 Other WH','active','institution','g1-wh-o')
        ON CONFLICT (id) DO NOTHING`, [WH, ORG, WH_OTHER, ORG_OTHER]);
      await c.query(`
        INSERT INTO distribution_points(
          id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind
        ) VALUES
          ($1,$2,$3,'G1 Pharmacy','G1 Pharmacy','pharmacy','active','non_emergency'),
          ($4,$5,$6,'G1 Other Pharmacy','G1 Other Pharmacy','pharmacy','active','non_emergency')
        ON CONFLICT (id) DO NOTHING`, [DP, WH, ORG, DP_OTHER, WH_OTHER, ORG_OTHER]);
      await c.query(`INSERT INTO auth.users(id,email) VALUES($1,'g1-other@rig.local') ON CONFLICT (id) DO NOTHING`, [OTHER_USER]);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id=$2 WHERE id=$1`, [OTHER_USER, ORG_OTHER]);
    });
  });

  afterAll(async () => { await rig?.end?.(); });

  it('is closed to anon and explicitly available to authenticated/service_role', async () => {
    const r = await rig.asAdmin((c: any) => c.query(`
      SELECT
        has_function_privilege('anon','public.phoenix_outlet_availability_read_model(uuid)','EXECUTE') AS anon,
        has_function_privilege('authenticated','public.phoenix_outlet_availability_read_model(uuid)','EXECUTE') AS auth,
        has_function_privilege('service_role','public.phoenix_outlet_availability_read_model(uuid)','EXECUTE') AS service`));
    expect(r.rows[0]).toEqual({ anon: false, auth: true, service: true });
  });

  it('uses canonical outlet_stock quantity/condition and ignores poisoned cache quantity/condition', async () => {
    const cacheId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO outlet_stock(
          id,organization_id,distribution_point_id,point_type,scientific_name,
          concentration,dosage_form,national_code,has_no_national_code,
          batch_number,has_no_batch_number,internal_batch_reference,expiry_date,
          on_hand_quantity,reserved_quantity,movement_seq,supply_type
        ) VALUES
          (gen_random_uuid(),$1,$2,'pharmacy','G1 Canonical Drug','500 mg','tablet','G1-NC',false,'G1-B',false,'G1-IBR',$3,10,0,1,'kimadia'),
          (gen_random_uuid(),$1,$2,'pharmacy','G1 Canonical Drug','500 mg','tablet','G1-NC',false,'G1-B',false,'G1-IBR',$3,15,0,1,'aid')`,
        [ORG, DP, FAR_FUTURE]);
      await c.query(`
        INSERT INTO item_availability(
          id,distribution_point_id,organization_id,port_name,scientific_name,
          concentration,dosage_form,national_code,batch_number,internal_batch_reference,
          expiry_date,quantity,condition,notes,supply_type,removed_at
        ) VALUES($1,$2,$3,'G1 Pharmacy','G1 Canonical Drug','500 mg','tablet','G1-NC','G1-B','G1-IBR',$4,999,'surplus','metadata-note','legacy-display',now())`,
        [cacheId, DP, ORG, FAR_FUTURE]);
    });

    const r = await readModel(rig.superAdminId, DP);
    expect(r.source).toBe('canonical_outlet_stock');
    const row = r.rows.find((x: any) => x.id === cacheId);
    expect(row).toBeTruthy();
    expect(row.quantity).toBe(25);
    expect(row.canonical_available_quantity).toBe(25);
    expect(row.canonical_on_hand_quantity).toBe(25);
    expect(row.condition).toBe('available');
    expect(row.notes).toBe('metadata-note');
    expect(row.supply_type).toBe('legacy-display');
    expect(row.removed_at).toBeTruthy();
  });

  it('keeps catalogue-only rows visible as zero/missing instead of trusting their stored quantity', async () => {
    const orphanCacheId = randomUUID();
    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO item_availability(
        id,distribution_point_id,organization_id,port_name,scientific_name,
        concentration,dosage_form,national_code,batch_number,expiry_date,quantity,condition
      ) VALUES($1,$2,$3,'G1 Pharmacy','G1 Cache Only','10 mg','tablet','G1-CACHE','CACHE-B',$4,777,'available')`,
      [orphanCacheId, DP, ORG, FAR_FUTURE]));

    const r = await readModel(rig.superAdminId, DP);
    const row = r.rows.find((x: any) => x.id === orphanCacheId);
    expect(row.quantity).toBe(0);
    expect(row.canonical_available_quantity).toBe(0);
    expect(row.condition).toBe('missing');
  });

  it('fails closed when real canonical stock has no matching compatibility-cache identity', async () => {
    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO outlet_stock(
        id,organization_id,distribution_point_id,point_type,scientific_name,
        has_no_national_code,has_no_batch_number,batch_number,expiry_date,
        on_hand_quantity,reserved_quantity,movement_seq
      ) VALUES(gen_random_uuid(),$1,$2,'pharmacy','G1 Unprojected',true,false,'G1-NOCACHE',$3,5,0,1)`,
      [ORG, DP, FAR_FUTURE]));

    await expect(readModel(rig.superAdminId, DP)).rejects.toThrow(/availability_projection_cache_mismatch/);
    await rig.asAdmin((c: any) => c.query(`DELETE FROM outlet_stock WHERE distribution_point_id=$1 AND scientific_name='G1 Unprojected'`, [DP]));
  });

  it('makes forbidden and nonexistent points indistinguishable', async () => {
    const foreign = await readModel(OTHER_USER, DP);
    const missing = await readModel(OTHER_USER, randomUUID());
    expect(foreign).toEqual(missing);
    expect(foreign.rows).toEqual([]);
    expect(foreign.distribution_point_id).toBeNull();
  });

  it('does not change public QR or the authenticated identity helpers', async () => {
    const r = await rig.asAdmin((c: any) => c.query(`
      SELECT
        has_function_privilege('anon','public.get_public_qr_payload(text)','EXECUTE') AS qr_anon,
        has_function_privilege('authenticated','public.phoenix_my_role()','EXECUTE') AS role_auth,
        has_function_privilege('authenticated','public.phoenix_my_org()','EXECUTE') AS org_auth`));
    expect(r.rows[0]).toEqual({ qr_anon: true, role_auth: true, org_auth: true });
  });
});
