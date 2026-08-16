/**
 * STAGE-E-E7-2 — APPLICATION WIRING, PROVED AGAINST A REAL DATABASE.
 *
 * This file adds NO migration. It proves that the exact payloads and argument
 * shapes the E7-2 service layer sends are the shapes migrations 164/166/168/
 * 169/170/171 actually accept — and that the shapes the client refuses are the
 * same ones the database refuses.
 *
 * Why it exists: the only test that previously covered organization creation
 * (features/institutions/__tests__/clean-db-first-organization.test.ts) is a
 * source-scan of InstitutionScreen.tsx. It could not, and did not, notice that
 * `createOrganization()` omitted `institution_class` — a column Migration 170
 * made mandatory. A string-matching test is not sufficient protection for a
 * database contract, so every claim below is executed, not read.
 *
 * The numeric prefix follows this directory's file-naming convention and does
 * NOT imply a Migration 172: `ceiling` below asserts 171 is still the highest
 * migration on disk.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

// PRE-EXISTING INFRASTRUCTURE FIX (surfaced by the R1.2C run, not caused by it).
// This suite REPLAYS THE MIGRATION CHAIN inside a beforeAll. vitest applies a
// separate 10s budget to HOOKS that testTimeout does not cover, so as the chain
// has grown the hook has crept toward that ceiling; past it, the hook is killed
// mid-replay and surfaces as ECONNRESET rather than as any assertion. An explicit
// hook budget removes that false signal. No assertion is changed or relaxed.
vi.setConfig({ testTimeout: 60000, hookTimeout: 240000 });

const run = rigAvailable() ? describe : describe.skip;

const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e: any) { return String(e?.message ?? e); }
  throw new Error('expected a rejection but the call succeeded');
};
const call = (c: any, fn: string, args: unknown[]) =>
  c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
    .then((res: any) => res.rows[0].r);

const ORG_AUTHORITY='00000000-0000-0000-0000-000000172001';
const ORG_HOSPITAL='00000000-0000-0000-0000-000000172002';
const ORG_SECTOR='00000000-0000-0000-0000-000000172003';
const WH_AUTH_CENTRAL='00000000-0000-0000-0000-000000172101';
const WH_HOSPITAL='00000000-0000-0000-0000-000000172102';
const WH_SECTOR='00000000-0000-0000-0000-000000172103';
const PH_HOSPITAL='00000000-0000-0000-0000-000000172201';
const CART_ER='00000000-0000-0000-0000-000000172202';
const CAB_WARD='00000000-0000-0000-0000-000000172203';

run('E7-2 · Stage-E application wiring (dynamic)',()=>{
  let rig:Awaited<ReturnType<typeof buildRig>>; let SUPER:string;
  beforeAll(async()=>{
    rig=await buildRig({upTo:171}); SUPER=rig.superAdminId;
    await rig.asAdmin((c:any)=>c.query(`
      INSERT INTO organizations(id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_AUTHORITY}','Authority172','Authority172','p172-auth','pharmacy_department_authority',NULL),
        ('${ORG_HOSPITAL}','Hospital172','Hospital172','p172-hosp','care_institution','hospital'),
        ('${ORG_SECTOR}','Sector172','Sector172','p172-sector','care_institution','health_sector');
      INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_AUTH_CENTRAL}','${ORG_AUTHORITY}','Auth Central172','Auth Central172','active','central','p172-wh-auth'),
        ('${WH_HOSPITAL}','${ORG_HOSPITAL}','Hosp Depot172','Hosp Depot172','active','institution','p172-wh-hosp'),
        ('${WH_SECTOR}','${ORG_SECTOR}','Sector Depot172','Sector Depot172','active','institution','p172-wh-sector');
      INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
        ('${PH_HOSPITAL}','${WH_HOSPITAL}','${ORG_HOSPITAL}','ER Pharmacy172','ER Pharmacy172','pharmacy','active','non_emergency'),
        ('${CART_ER}','${WH_HOSPITAL}','${ORG_HOSPITAL}','Rescue Cart172','Rescue Cart172','rescue_cart','active','emergency'),
        ('${CAB_WARD}','${WH_HOSPITAL}','${ORG_HOSPITAL}','Ward Cabinet172','Ward Cabinet172','crash_cabinet','active','non_emergency');`));
  });
  afterAll(async()=>{await rig?.end();});

  describe('0. E7-2 is application-only',()=>{
    const STAGE_F_MIGRATIONS=[
      '172_phoenix_patient_dispensing_contract.sql',
      '173_phoenix_database_security_surface_hardening.sql',
      '174_phoenix_authenticated_rpc_surface_hardening.sql',
      '175_phoenix_read_helper_anonymous_surface_hardening.sql',
      '176_phoenix_canonical_outlet_availability_read_model.sql',
      '177_phoenix_canonical_public_qr.sql',
      // P0 HOTFIX 178: SECURITY DEFINER on Migration 171's outlet owner-kind
      // guard so its FOR SHARE row lock stops failing with 42501. It replaces
      // one 171 function in place and adds no Stage-E SQL, so the "Stage E
      // still ends at 171" assertion above is unaffected. Listed here so this
      // guard stays exhaustive and still fails closed on any unlisted new file.
      '178_phoenix_distribution_point_owner_guard_privilege_fix.sql',
      // STAGE-G-G3.1: 179 replaces Migration 176's authenticated availability
      // read model so physical rows group on outlet_stock.material_identity_key
      // and carry a row-level unit. It replaces one 176 function in place and
      // adds no Stage-E SQL, so the "Stage E still ends at 171" assertion above
      // is unaffected. Listed here so this guard stays exhaustive and still
      // fails closed on any unlisted new file.
      '179_phoenix_canonical_authenticated_availability_hardening.sql',
      // R1.2 (180): separates ordinary from initial-provisioning warehouse-
      // dispatch authority. It moves Migration 070's creator body into one
      // trusted internal core and replaces the two public writers in place —
      // no new table, column, constraint, index, permission key or corridor,
      // and no Stage-E SQL — so the "Stage E still ends at 171" assertion above
      // is unaffected. Listed here so this guard stays exhaustive and still
      // fails closed on any unlisted new file.
      '180_phoenix_emergency_initial_provisioning_boundary.sql',
      // R1.1 (181): reconciles health-sector topology and installs the
      // warehouse/outlet shape guards. It adds no Stage-E SQL — Stage E's
      // corridors are untouched and Branch B is reused exactly as shipped — so
      // the "Stage E still ends at 171" assertion above is unaffected. Listed
      // here so this guard stays exhaustive and still fails closed.
      '181_phoenix_health_sector_topology_reconciliation.sql',
      // R1.1-U (182): adds the facility-scoped RBAC surface — a nullable
      // facility_id on profile_scope_assignments with its constraints and index,
      // the facility-derived authorization helpers, and two narrowed RLS
      // predicates. It is AUTHORIZATION only: Stage E's corridors, routes and
      // supply semantics are untouched, so the "Stage E still ends at 171"
      // assertion above is unaffected. Listed here so this guard stays
      // exhaustive and still fails closed on any unlisted new file.
      '182_phoenix_health_center_facility_scoped_rbac.sql',
      // R1.2C (183): states the active-outlet topology matrix once, in one
      // validator, and calls it from the distribution_points write boundary and
      // Migration 180's initial-provisioning entry point. It is a WRITE-TIME
      // BOUNDARY only: Stage E's corridors, routes and supply semantics are
      // untouched — 168's replenishment RPC is deliberately not rewritten — so
      // the "Stage E still ends at 171" assertion above is unaffected. Listed
      // here so this guard stays exhaustive and still fails closed on any
      // unlisted new file.
      '183_phoenix_emergency_outlet_integrity.sql',
      // R1.3 (184): unlike every entry above, this one DOES change Stage E's
      // supply semantics, and deliberately — it NARROWS Migration 165's Branch A
      // on both the direct-supply and direct-return validators so a facility-
      // bound Health Center depot is no longer a legal external-corridor
      // endpoint. Branch B (sector main -> own centre depot) is preserved
      // exactly as Stage E shipped it. What this guard actually asserts is
      // unaffected either way: 184 adds NO migration numbered <= 171, so
      // "Stage E still ends at 171" remains true. Listed here so the guard stays
      // exhaustive and still fails closed on any unlisted new file.
      '184_phoenix_canonical_supply_cycle.sql',
      // R1.5 (185): return/quarantine/recall parity. It forward-replaces the
      // return-review caps, the quarantine release path and the recall entry
      // points (071/095/150 lineage) and adds the provenance-anchored recall
      // selectors for warehouse transfer lines and outlet inbound receipts.
      // Stage E's corridors and routes are untouched, and — the only thing this
      // guard actually asserts — 185 adds NO migration numbered <= 171, so
      // "Stage E still ends at 171" remains true. Listed here so the guard stays
      // exhaustive and still fails closed on any unlisted new file.
      '185_phoenix_return_quarantine_recall_parity.sql',
    ];
    it('Stage E still ends at 171 — E7-2 introduced no new SQL',()=>{
      const files=readdirSync(join(__dirname,'..')).filter(f=>/^\d{3}_.*\.sql$/.test(f));
      const stageENumbers=files.map(f=>Number(f.slice(0,3))).filter(n=>n<=171);
      expect(Math.max(...stageENumbers)).toBe(171);
      const beyond=files.filter(f=>Number(f.slice(0,3))>171).sort();
      expect(beyond).toEqual(STAGE_F_MIGRATIONS);
    });
  });

  describe('A. the organization writer sends shapes the database accepts',()=>{
    const insertAsService=(c:any,row:{id:string;code:string;organization_kind:string;institution_class:string|null})=>c.query(
      `INSERT INTO organizations (id,name,name_ar,code,city,contact_email,organization_kind,institution_class)
       VALUES ($1,'Svc','Svc',$2,NULL,NULL,$3,$4) RETURNING organization_kind,institution_class`,
      [row.id,row.code,row.organization_kind,row.institution_class]);
    it.each(['hospital','specialized_center','health_sector'])('care_institution + %s is accepted',async(cls)=>{
      const r=await rig.asAdmin((c:any)=>insertAsService(c,{id:randomUUID(),code:`p172-care-${cls}`,organization_kind:'care_institution',institution_class:cls}));
      expect(r.rows[0]).toEqual({organization_kind:'care_institution',institution_class:cls});
    });
    it('pharmacy_department_authority + explicit NULL class is accepted',async()=>{
      const r=await rig.asAdmin((c:any)=>insertAsService(c,{id:randomUUID(),code:'p172-auth-2',organization_kind:'pharmacy_department_authority',institution_class:null}));
      expect(r.rows[0]).toEqual({organization_kind:'pharmacy_department_authority',institution_class:null});
    });
    it('THE REGRESSION: pre-E7-2 payload is rejected',async()=>{
      const msg=await rejects(()=>rig.asAdmin((c:any)=>c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES ($1,'Old','Old','p172-old')`,[randomUUID()])));
      expect(msg).toMatch(/organizations_kind_institution_class_chk/);
    });
    it('client-side refusals mirror database refusals',async()=>{
      expect(await rejects(()=>rig.asAdmin((c:any)=>insertAsService(c,{id:randomUUID(),code:'p172-bad-1',organization_kind:'care_institution',institution_class:null})))).toMatch(/organizations_kind_institution_class_chk/);
      expect(await rejects(()=>rig.asAdmin((c:any)=>insertAsService(c,{id:randomUUID(),code:'p172-bad-2',organization_kind:'pharmacy_department_authority',institution_class:'hospital'})))).toMatch(/organizations_kind_institution_class_chk/);
      expect(await rejects(()=>rig.asAdmin((c:any)=>insertAsService(c,{id:randomUUID(),code:'p172-bad-3',organization_kind:'clinic',institution_class:null})))).toMatch(/organizations_organization_kind_chk|organizations_kind_institution_class_chk/);
    });
  });

  describe('B. facility management wiring',()=>{
    let facilityId:string;
    it('upsert creates a health-centre facility',async()=>{const r=await rig.asUser(SUPER,(c:any)=>call(c,'phoenix_upsert_organization_facility',[null,ORG_SECTOR,'primary_health_center','HC One','مركز واحد','p172-hc1',true]),{commit:true});expect(r.ok).toBe(true);expect(r.facility_class).toBe('primary_health_center');facilityId=r.facility_id;});
    it('same RPC updates in place',async()=>{const r=await rig.asUser(SUPER,(c:any)=>call(c,'phoenix_upsert_organization_facility',[facilityId,ORG_SECTOR,'subordinate_health_center','HC One Renamed','مركز واحد','p172-hc1',true]),{commit:true});expect(r.ok).toBe(true);expect(r.facility_id).toBe(facilityId);expect(r.facility_class).toBe('subordinate_health_center');});
    it('hospital cannot host subordinate facility',async()=>{const msg=await rejects(()=>rig.asUser(SUPER,(c:any)=>call(c,'phoenix_upsert_organization_facility',[null,ORG_HOSPITAL,'primary_health_center','Bad','سيئ','p172-bad-fac',true])));expect(msg).toMatch(/health_sector|of_parent|parent_class/i);});
    it('authority can never host facility',async()=>{const msg=await rejects(()=>rig.asUser(SUPER,(c:any)=>call(c,'phoenix_upsert_organization_facility',[null,ORG_AUTHORITY,'primary_health_center','Bad','سيئ','p172-bad-fac2',true])));expect(msg).toMatch(/health_sector|of_parent|parent_class|institution_class/i);});
    it('assignWarehouseFacility links a warehouse',async()=>{const r=await rig.asUser(SUPER,(c:any)=>call(c,'phoenix_assign_warehouse_facility',[WH_SECTOR,facilityId]),{commit:true});expect(r.ok).toBe(true);expect(r.new_facility_id).toBe(facilityId);});
    it('null facility clears link',async()=>{const r=await rig.asUser(SUPER,(c:any)=>call(c,'phoenix_assign_warehouse_facility',[WH_SECTOR,null]),{commit:true});expect(r.ok).toBe(true);expect(r.new_facility_id).toBeNull();});
  });

  describe('C. replenishment route wiring',()=>{
    it('creates pharmacy→rescue-cart route',async()=>{const r=await rig.asUser(SUPER,(c:any)=>call(c,'phoenix_upsert_outlet_replenishment_route',[null,PH_HOSPITAL,CART_ER,true,'E7-2 wiring']),{commit:true});expect(r.ok).toBe(true);expect(r.is_active).toBe(true);});
    it('self-transfer refused',async()=>expect(await rejects(()=>rig.asUser(SUPER,(c:any)=>call(c,'phoenix_upsert_outlet_replenishment_route',[null,PH_HOSPITAL,PH_HOSPITAL,true,null])))).toMatch(/self|orr_no_self_transfer|destination/i));
    it('non-pharmacy source refused',async()=>expect(await rejects(()=>rig.asUser(SUPER,(c:any)=>call(c,'phoenix_upsert_outlet_replenishment_route',[null,CART_ER,CAB_WARD,true,null])))).toMatch(/pharmacy|source/i));
    it('route read model exposes expected columns',async()=>{const r=await rig.asAdmin((c:any)=>c.query(`SELECT id,organization_id,source_point_id,destination_point_id,source_point_type,destination_point_type,is_active,notes FROM outlet_replenishment_routes WHERE organization_id=$1`,[ORG_HOSPITAL]));expect(r.rows.length).toBeGreaterThanOrEqual(1);expect(r.rows[0].source_point_type).toBe('pharmacy');expect(r.rows[0].destination_point_type).toBe('rescue_cart');});
  });

  describe('D. initial provisioning wiring',()=>{
    it('opens one slot',async()=>{const r=await rig.asUser(SUPER,(c:any)=>call(c,'phoenix_create_initial_provisioning_dispatch',[WH_HOSPITAL,CAB_WARD,'IP-172-1',null,null,'E7-2 initial provisioning']),{commit:true});expect(r.ok).toBe(true);expect(r.is_initial_provisioning).toBe(true);});
    it('state comes from lifecycle columns, not stock',async()=>{const r=await rig.asAdmin((c:any)=>c.query(`SELECT id,status,is_initial_provisioning,initial_provisioning_consumed_at FROM warehouse_dispatches WHERE destination_distribution_point_id=$1 AND is_initial_provisioning=true`,[CAB_WARD]));expect(r.rows).toHaveLength(1);expect(r.rows[0].initial_provisioning_consumed_at).toBeNull();});
    it('second initial provisioning refused while open',async()=>expect(await rejects(()=>rig.asUser(SUPER,(c:any)=>call(c,'phoenix_create_initial_provisioning_dispatch',[WH_HOSPITAL,CAB_WARD,'IP-172-2',null,null,null])))).toMatch(/initial_provisioning|once|uniq/i));
  });

  describe('E. route eligibility matches service mirror',()=>{
    let hcPharmacy:string,hcCabinet:string,hcCart:string,facilityA:string,facilityB:string;
    beforeAll(async()=>{
      const a=await rig.asUser(SUPER,(c:any)=>call(c,'phoenix_upsert_organization_facility',[null,ORG_SECTOR,'primary_health_center','HC A','مركز أ','p172-hc-a',true]),{commit:true});facilityA=a.facility_id;
      const b=await rig.asUser(SUPER,(c:any)=>call(c,'phoenix_upsert_organization_facility',[null,ORG_SECTOR,'primary_health_center','HC B','مركز ب','p172-hc-b',true]),{commit:true});facilityB=b.facility_id;
      const whA=randomUUID(),whB=randomUUID();
      await rig.asAdmin((c:any)=>c.query(`INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code,facility_id) VALUES ($1,$3,'HC A Depot','HC A Depot','active','institution','p172-wh-hca',$4),($2,$3,'HC B Depot','HC B Depot','active','institution','p172-wh-hcb',$5)`,[whA,whB,ORG_SECTOR,facilityA,facilityB]));
      hcPharmacy=randomUUID();hcCabinet=randomUUID();hcCart=randomUUID();
      await rig.asAdmin((c:any)=>c.query(`INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES ($1,$4,$6,'HC A Pharmacy','HC A Pharmacy','pharmacy','active','non_emergency'),($2,$4,$6,'HC A Cabinet','HC A Cabinet','crash_cabinet','active','emergency'),($3,$5,$6,'HC B Cart','HC B Cart','rescue_cart','active','emergency')`,[hcPharmacy,hcCabinet,hcCart,whA,whB,ORG_SECTOR]));
    });
    it('SHAPE H happy path accepted',async()=>{const r=await rig.asUser(SUPER,(c:any)=>call(c,'phoenix_upsert_outlet_replenishment_route',[null,hcPharmacy,hcCabinet,true,null]),{commit:true});expect(r.ok).toBe(true);});
    it('health sector rescue cart forbidden',async()=>{const cart=randomUUID();const whA=await rig.asAdmin((c:any)=>c.query(`SELECT warehouse_id FROM distribution_points WHERE id=$1`,[hcPharmacy]));await rig.asAdmin((c:any)=>c.query(`INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES ($1,$2,$3,'HC A Cart','HC A Cart','rescue_cart','active','emergency')`,[cart,whA.rows[0].warehouse_id,ORG_SECTOR]));expect(await rejects(()=>rig.asUser(SUPER,(c:any)=>call(c,'phoenix_upsert_outlet_replenishment_route',[null,hcPharmacy,cart,true,null])))).toMatch(/health_center_rescue_cart_forbidden/);});
    it('cross-facility routing forbidden',async()=>expect(await rejects(()=>rig.asUser(SUPER,(c:any)=>call(c,'phoenix_upsert_outlet_replenishment_route',[null,hcPharmacy,hcCart,true,null])))).toMatch(/cross_facility_route_forbidden|health_center_rescue_cart_forbidden/));
    it('health-sector route requires facilities',async()=>{const ph=randomUUID(),cab=randomUUID();await rig.asAdmin((c:any)=>c.query(`INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES ($1,$3,$4,'NoFac Pharmacy','NoFac Pharmacy','pharmacy','active','non_emergency'),($2,$3,$4,'NoFac Cabinet','NoFac Cabinet','crash_cabinet','active','emergency')`,[ph,cab,WH_SECTOR,ORG_SECTOR]));expect(await rejects(()=>rig.asUser(SUPER,(c:any)=>call(c,'phoenix_upsert_outlet_replenishment_route',[null,ph,cab,true,null])))).toMatch(/health_center_route_requires_facility/);});
    it('SHAPE I hospital route has no facility',async()=>{const r=await rig.asAdmin((c:any)=>c.query(`SELECT facility_id FROM warehouses WHERE id=$1`,[WH_HOSPITAL]));expect(r.rows[0].facility_id).toBeNull();});
    it('hospital crash cabinet must be non-emergency',async()=>{const bad=randomUUID();await rig.asAdmin((c:any)=>c.query(`INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES ($1,$2,$3,'Bad Cab','Bad Cab','crash_cabinet','active','emergency')`,[bad,WH_HOSPITAL,ORG_HOSPITAL]));expect(await rejects(()=>rig.asUser(SUPER,(c:any)=>call(c,'phoenix_upsert_outlet_replenishment_route',[null,PH_HOSPITAL,bad,true,null])))).toMatch(/crash_cabinet_requires_non_emergency_context/);});
  });

  describe('F. Stage-E permission keys exist and are unchanged',()=>{
    it('four Migration-164 keys are present',async()=>{const r=await rig.asAdmin((c:any)=>c.query(`SELECT key FROM permission_keys WHERE key IN ('organization_facilities.manage','replenishment_routes.manage','outlet_stock.replenish','outlet_stock.replenish_reverse') ORDER BY key`));expect(r.rows.map((x:any)=>x.key)).toEqual(['organization_facilities.manage','outlet_stock.replenish','outlet_stock.replenish_reverse','replenishment_routes.manage']);});
  });
});
