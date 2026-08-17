import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
const run = rigAvailable() ? describe : describe.skip;

const ORG_HS   = '00000000-0000-0000-0000-000000188001';
const ORG_HOSP = '00000000-0000-0000-0000-000000188002';
const ORG_SPEC = '00000000-0000-0000-0000-000000188003';
const ORG_HS2  = '00000000-0000-0000-0000-000000188004';

const FAC_HS   = '00000000-0000-0000-0000-000000188101';
const FAC_SIB  = '00000000-0000-0000-0000-000000188102';
const FAC_HS2  = '00000000-0000-0000-0000-000000188103';

const WH_HS          = '00000000-0000-0000-0000-000000188201';
const WH_SIB         = '00000000-0000-0000-0000-000000188202';
const WH_HOSP        = '00000000-0000-0000-0000-000000188203';
const WH_SPEC        = '00000000-0000-0000-0000-000000188204';
const WH_HS2         = '00000000-0000-0000-0000-000000188205';
const WH_HS_MAIN     = '00000000-0000-0000-0000-000000188206';
const WH_HS2_MAIN    = '00000000-0000-0000-0000-000000188207';
const WH_HS_INACT_DEP= '00000000-0000-0000-0000-000000188208';

const DP_HS       = '00000000-0000-0000-0000-000000188301';
const DP_SIB      = '00000000-0000-0000-0000-000000188302';
const DP_HOSP     = '00000000-0000-0000-0000-000000188303';
const DP_SPEC     = '00000000-0000-0000-0000-000000188304';
const DP_HS2      = '00000000-0000-0000-0000-000000188305';
const DP_HS_INACT = '00000000-0000-0000-0000-000000188306';

const CI_A     = '00000000-0000-0000-0000-000000188401';
const LI_A     = '00000000-0000-0000-0000-000000188402';

const QRT_DP      = '00000000-0000-0000-0000-000000188501';
const QRT_SIB     = '00000000-0000-0000-0000-000000188502';
const QRT_WH      = '00000000-0000-0000-0000-000000188503';
const QRT_HOSP    = '00000000-0000-0000-0000-000000188504';
const QRT_SPEC    = '00000000-0000-0000-0000-000000188505';
const QRT_LI      = '00000000-0000-0000-0000-000000188506';
const QRT_HS2     = '00000000-0000-0000-0000-000000188507';
const QRT_INACT   = '00000000-0000-0000-0000-000000188508';
const QRT_DIS     = '00000000-0000-0000-0000-000000188509';
const QRT_WH_MAIN = '00000000-0000-0000-0000-000000188510';

const QTK_DP      = '00000000-0000-0000-0000-000000188601';
const QTK_SIB     = '00000000-0000-0000-0000-000000188602';
const QTK_WH      = '00000000-0000-0000-0000-000000188603';
const QTK_HOSP    = '00000000-0000-0000-0000-000000188604';
const QTK_SPEC    = '00000000-0000-0000-0000-000000188605';
const QTK_LI      = '00000000-0000-0000-0000-000000188606';
const QTK_HS2     = '00000000-0000-0000-0000-000000188607';
const QTK_INACT   = '00000000-0000-0000-0000-000000188608';
const QTK_DIS     = '00000000-0000-0000-0000-000000188609';
const QTK_WH_MAIN = '00000000-0000-0000-0000-000000188610';

const PUB_DP       = '188-public-dp';
const PUB_SIB      = '188-public-sib';
const PUB_WH       = '188-public-wh';
const PUB_HOSP     = '188-public-hosp';
const PUB_SPEC     = '188-public-spec';
const PUB_LI       = '188-public-li';
const PUB_HS2      = '188-public-hs2';
const PUB_INACT    = '188-public-inactive';
const PUB_DIS      = '188-public-disabled';
const PUB_WH_MAIN  = '188-public-wh-main';

run('188 · public QR facility context (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  const asAnon = (publicId: string) => rig.asUser(null, (c: any) => c.query(
    'SELECT public.get_public_qr_payload($1) AS payload', [publicId],
  ).then((r: any) => r.rows[0].payload), { role: 'anon' });

  beforeAll(async () => {
    rig = await buildRig({ upTo: 188 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class) VALUES
          ('${ORG_HS}','Health Sector 188','قطاع 188','188-hs','care_institution','health_sector'),
          ('${ORG_HOSP}','Hospital 188','مستشفى 188','188-h','care_institution','hospital'),
          ('${ORG_SPEC}','Specialized 188','تخصصي 188','188-s','care_institution','specialized_center'),
          ('${ORG_HS2}','Health Sector 2 188','قطاع 2 188','188-hs2','care_institution','health_sector')
        ON CONFLICT(id) DO NOTHING
      `);

      await c.query(`
        INSERT INTO organization_facilities(id,organization_id,facility_class,name,name_ar,status) VALUES
          ('${FAC_HS}','${ORG_HS}','primary_health_center','Centre 188','مركز 188','active'),
          ('${FAC_SIB}','${ORG_HS}','subordinate_health_center','Sibling 188','مركز شقيق 188','active'),
          ('${FAC_HS2}','${ORG_HS2}','primary_health_center','Other Centre 188','مركز آخر 188','active')
        ON CONFLICT(id) DO NOTHING
      `);

      await c.query(`
        INSERT INTO warehouses(id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
          ('${WH_HS}','${ORG_HS}','HS Depot 188','مذخر قطاع 188','institution','${FAC_HS}',false,'active'),
          ('${WH_SIB}','${ORG_HS}','HS Sibling Depot 188','مذخر شقيق 188','institution','${FAC_SIB}',false,'active'),
          ('${WH_HOSP}','${ORG_HOSP}','Hospital Depot 188','مذخر مستشفى 188','institution',NULL,false,'active'),
          ('${WH_SPEC}','${ORG_SPEC}','Special Depot 188','مذخر تخصصي 188','institution',NULL,false,'active'),
          ('${WH_HS2}','${ORG_HS2}','HS2 Depot 188','مذخر قطاع 2 188','institution','${FAC_HS2}',false,'active'),
          ('${WH_HS_MAIN}','${ORG_HS}','HS Main 188','مذخر رئيسي 188','institution',NULL,true,'active'),
          ('${WH_HS2_MAIN}','${ORG_HS2}','HS2 Main 188','مذخر رئيسي 2 188','institution',NULL,true,'active')
        ON CONFLICT(id) DO NOTHING
      `);

      await c.query(`
        INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
          ('${DP_HS}','${WH_HS}','${ORG_HS}','HS Pharmacy 188','صيدلية قطاع 188','pharmacy','active','non_emergency'),
          ('${DP_SIB}','${WH_SIB}','${ORG_HS}','Sibling Pharmacy 188','صيدلية شقيق 188','pharmacy','active','non_emergency'),
          ('${DP_HS_INACT}','${WH_SIB}','${ORG_HS}','Inactive HS Pharmacy 188','صيدلية غير فعالة','pharmacy','active','non_emergency'),
          ('${DP_HOSP}','${WH_HOSP}','${ORG_HOSP}','Hospital Pharmacy 188','صيدلية مستشفى 188','pharmacy','active','non_emergency'),
          ('${DP_SPEC}','${WH_SPEC}','${ORG_SPEC}','Special Pharmacy 188','صيدلية تخصصي 188','pharmacy','active','non_emergency'),
          ('${DP_HS2}','${WH_HS2}','${ORG_HS2}','HS2 Pharmacy 188','صيدلية قطاع 2 188','pharmacy','active','non_emergency')
        ON CONFLICT(id) DO NOTHING
      `);

      await c.query(`
        INSERT INTO central_items(id,name,name_ar,unit,status) VALUES
          ('${CI_A}','Med 188','دواء 188','box','active')
        ON CONFLICT(id) DO NOTHING
      `);

      await c.query(`
        INSERT INTO local_items(id,central_item_id,organization_id,local_name,local_code,status) VALUES
          ('${LI_A}','${CI_A}','${ORG_HS}','Local Med 188','188-lm','active')
        ON CONFLICT(id) DO NOTHING
      `);

      await c.query(`
        INSERT INTO qr_targets(id,organization_id,target_type,target_id,label,status) VALUES
          ('${QRT_DP}','${ORG_HS}','distribution_point','${DP_HS}','HS Point 188','active'),
          ('${QRT_SIB}','${ORG_HS}','distribution_point','${DP_SIB}','Sibling Point 188','active'),
          ('${QRT_WH}','${ORG_HS}','warehouse','${WH_HS}','HS Depot Target 188','active'),
          ('${QRT_HOSP}','${ORG_HOSP}','distribution_point','${DP_HOSP}','Hospital Point 188','active'),
          ('${QRT_SPEC}','${ORG_SPEC}','distribution_point','${DP_SPEC}','Special Point 188','active'),
          ('${QRT_LI}','${ORG_HS}','local_item','${LI_A}','Local Med Target 188','active'),
          ('${QRT_HS2}','${ORG_HS2}','distribution_point','${DP_HS2}','HS2 Point 188','active'),
          ('${QRT_INACT}','${ORG_HS}','distribution_point','${DP_HS_INACT}','Inactive Point 188','inactive'),
          ('${QRT_WH_MAIN}','${ORG_HS}','warehouse','${WH_HS_MAIN}','HS Main Target 188','active')
        ON CONFLICT(id) DO NOTHING
      `);

      await c.query(`
        INSERT INTO qr_tokens(id,qr_target_id,organization_id,public_id,token_hash,status) VALUES
          ('${QTK_DP}','${QRT_DP}','${ORG_HS}','${PUB_DP}','hash-dp','active'),
          ('${QTK_SIB}','${QRT_SIB}','${ORG_HS}','${PUB_SIB}','hash-sib','active'),
          ('${QTK_WH}','${QRT_WH}','${ORG_HS}','${PUB_WH}','hash-wh','active'),
          ('${QTK_HOSP}','${QRT_HOSP}','${ORG_HOSP}','${PUB_HOSP}','hash-hosp','active'),
          ('${QTK_SPEC}','${QRT_SPEC}','${ORG_SPEC}','${PUB_SPEC}','hash-spec','active'),
          ('${QTK_LI}','${QRT_LI}','${ORG_HS}','${PUB_LI}','hash-li','active'),
          ('${QTK_HS2}','${QRT_HS2}','${ORG_HS2}','${PUB_HS2}','hash-hs2','active'),
          ('${QTK_INACT}','${QRT_INACT}','${ORG_HS}','${PUB_INACT}','hash-inact','active'),
          ('${QTK_DIS}','${QRT_DP}','${ORG_HS}','${PUB_DIS}','hash-dis','disabled'),
          ('${QTK_WH_MAIN}','${QRT_WH_MAIN}','${ORG_HS}','${PUB_WH_MAIN}','hash-wh-main','active')
        ON CONFLICT(id) DO NOTHING
      `);
    });
  });

  afterAll(async () => { await rig?.end?.(); });

  it('keeps anon EXECUTE on the public QR resolver', async () => {
    const r = await rig.asAdmin((c: any) => c.query(
      "SELECT has_function_privilege('anon','public.get_public_qr_payload(text)','EXECUTE') AS ok"));
    expect(r.rows[0].ok).toBe(true);
  });

  it('removes raw anonymous SELECT on qr_tokens entirely', async () => {
    const r = await rig.asAdmin((c: any) => c.query(
      "SELECT has_table_privilege('anon','public.qr_tokens','SELECT') AS sel, " +
      "has_table_privilege('anon','public.qr_tokens','INSERT') AS ins"));
    expect(r.rows[0]).toEqual({ sel: false, ins: false });
  });

  it('health-center distribution point: structural facility context is present', async () => {
    const p = await asAnon(PUB_DP);
    expect(p.ok).toBe(true);
    expect(p.target_type).toBe('distribution_point');
    expect(p.org_name).toBe('Health Sector 188');
    expect(p.facility_id).toBe(FAC_HS);
    expect(p.facility_name).toBe('Centre 188');
    expect(p.facility_name_ar).toBe('مركز 188');
    expect(p.point_label).toBe('HS Point 188');
  });

  it('sibling health-center point: its own facility, not a sibling or sector main', async () => {
    const p = await asAnon(PUB_SIB);
    expect(p.ok).toBe(true);
    expect(p.target_type).toBe('distribution_point');
    expect(p.facility_id).toBe(FAC_SIB);
    expect(p.facility_name).toBe('Sibling 188');
    expect(p.facility_id).not.toBe(FAC_HS);
  });

  it('health-center warehouse target: structural facility context is present', async () => {
    const p = await asAnon(PUB_WH);
    expect(p.ok).toBe(true);
    expect(p.target_type).toBe('warehouse');
    expect(p.org_name).toBe('Health Sector 188');
    expect(p.facility_id).toBe(FAC_HS);
    expect(p.warehouse_label).toBe('HS Depot Target 188');
    expect(p.points).toHaveLength(1);
    expect(p.points[0].point_name).toBe('HS Pharmacy 188');
  });

  it('hospital distribution point: no health-center facility is fabricated', async () => {
    const p = await asAnon(PUB_HOSP);
    expect(p.ok).toBe(true);
    expect(p.target_type).toBe('distribution_point');
    expect(p.org_name).toBe('Hospital 188');
    expect(p.facility_id).toBeNull();
    expect(p.facility_name).toBeNull();
    expect(p.facility_name_ar).toBeNull();
    expect(p.point_label).toBe('Hospital Point 188');
  });

  it('specialized-center distribution point: no health-center facility is fabricated', async () => {
    const p = await asAnon(PUB_SPEC);
    expect(p.ok).toBe(true);
    expect(p.target_type).toBe('distribution_point');
    expect(p.org_name).toBe('Specialized 188');
    expect(p.facility_id).toBeNull();
    expect(p.facility_name).toBeNull();
    expect(p.facility_name_ar).toBeNull();
  });

  it('local_item target: organization-scoped, no facility fields invented', async () => {
    const p = await asAnon(PUB_LI);
    expect(p.ok).toBe(true);
    expect(p.target_type).toBe('local_item');
    expect(p.org_name).toBe('Health Sector 188');
    expect(p).not.toHaveProperty('facility_id');
    expect(p).not.toHaveProperty('facility_name');
    expect(p).not.toHaveProperty('facility_name_ar');
    expect(p.item_name).toBe('Med 188');
  });

  it('cross-org token resolves only its own organization and facility', async () => {
    const p = await asAnon(PUB_HS2);
    expect(p.ok).toBe(true);
    expect(p.target_type).toBe('distribution_point');
    expect(p.org_name).toBe('Health Sector 2 188');
    expect(p.facility_id).toBe(FAC_HS2);
    expect(p.facility_name).toBe('Other Centre 188');
    expect(p.facility_id).not.toBe(FAC_HS);
  });

  it('inactive qr_target fails closed as TARGET_NOT_FOUND before scanning', async () => {
    const p = await asAnon(PUB_INACT);
    expect(p).toEqual({ ok: false, error: 'TARGET_NOT_FOUND' });
  });

  it('disabled token is indistinguishable from missing and reveals no payload', async () => {
    const p = await asAnon(PUB_DIS);
    expect(p).toEqual({ ok: false, error: 'QR_NOT_FOUND_OR_DISABLED' });
  });

  it('invalid / malformed token fails closed and reveals nothing', async () => {
    const p = await asAnon('definitely-not-a-real-public-id-188');
    expect(p).toEqual({ ok: false, error: 'QR_NOT_FOUND_OR_DISABLED' });
  });

  it('health-sector sector-main warehouse has no facility and still resolves', async () => {
    const p = await asAnon(PUB_WH_MAIN);
    expect(p.ok).toBe(true);
    expect(p.target_type).toBe('warehouse');
    expect(p.org_name).toBe('Health Sector 188');
    expect(p.facility_id).toBeNull();
    expect(p.facility_name).toBeNull();
    expect(p.facility_name_ar).toBeNull();
    expect(p.warehouse_label).toBe('HS Main Target 188');
    expect(p.points).toBeNull();
  });
});
