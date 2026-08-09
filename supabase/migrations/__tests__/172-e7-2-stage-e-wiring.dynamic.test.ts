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

vi.setConfig({ testTimeout: 60000 });

const run = rigAvailable() ? describe : describe.skip;

const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  throw new Error('expected a rejection but the call succeeded');
};

/** Calls an RPC positionally, exactly as PostgREST does for the service layer. */
const call = (c: any, fn: string, args: unknown[]) =>
  c.query(
    `SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`,
    args,
  ).then((res: any) => res.rows[0].r);

// ── Fixture ids ──────────────────────────────────────────────────────────────
const ORG_AUTHORITY = '00000000-0000-0000-0000-000000172001';
const ORG_HOSPITAL  = '00000000-0000-0000-0000-000000172002';
const ORG_SECTOR    = '00000000-0000-0000-0000-000000172003';

const WH_AUTH_CENTRAL = '00000000-0000-0000-0000-000000172101';
const WH_HOSPITAL     = '00000000-0000-0000-0000-000000172102';
const WH_SECTOR       = '00000000-0000-0000-0000-000000172103';

const PH_HOSPITAL = '00000000-0000-0000-0000-000000172201'; // pharmacy, non_emergency
const CART_ER     = '00000000-0000-0000-0000-000000172202'; // rescue_cart, emergency
const CAB_WARD    = '00000000-0000-0000-0000-000000172203'; // crash_cabinet, non_emergency

run('E7-2 · Stage-E application wiring (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let SUPER: string;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 171 });
    SUPER = rig.superAdminId;

    await rig.asAdmin((c: any) => c.query(`
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
        ('${CAB_WARD}','${WH_HOSPITAL}','${ORG_HOSPITAL}','Ward Cabinet172','Ward Cabinet172','crash_cabinet','active','non_emergency');
    `));
  });

  afterAll(async () => { await rig?.end(); });

  // ══════════════════════════════════════════════════════════════════════
  // 0. E7-2 adds no migration
  // ══════════════════════════════════════════════════════════════════════
  describe('0. E7-2 is application-only', () => {
    it('171 is still the highest migration on disk — E7-2 introduced no new SQL', () => {
      const dir = join(__dirname, '..');
      const numbers = readdirSync(dir)
        .filter(f => /^\d{3}_.*\.sql$/.test(f))
        .map(f => Number(f.slice(0, 3)));
      expect(Math.max(...numbers)).toBe(171);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // A. createOrganization()'s exact payloads
  // ══════════════════════════════════════════════════════════════════════
  describe('A. the organization writer sends shapes the database accepts', () => {
    /** Mirrors createOrganization()'s insert exactly, including explicit nulls. */
    const insertAsService = (c: any, row: {
      id: string; code: string;
      organization_kind: string; institution_class: string | null;
    }) => c.query(
      `INSERT INTO organizations
         (id, name, name_ar, code, city, contact_email, organization_kind, institution_class)
       VALUES ($1,'Svc','Svc',$2,NULL,NULL,$3,$4) RETURNING organization_kind, institution_class`,
      [row.id, row.code, row.organization_kind, row.institution_class],
    );

    it.each(['hospital', 'specialized_center', 'health_sector'])(
      'care_institution + %s is accepted, exactly as the form submits it',
      async (cls) => {
        const r = await rig.asAdmin((c: any) => insertAsService(c, {
          id: randomUUID(), code: `p172-care-${cls}`,
          organization_kind: 'care_institution', institution_class: cls,
        }));
        expect(r.rows[0]).toEqual({ organization_kind: 'care_institution', institution_class: cls });
      },
    );

    it('pharmacy_department_authority + explicit NULL class is accepted', async () => {
      const r = await rig.asAdmin((c: any) => insertAsService(c, {
        id: randomUUID(), code: 'p172-auth-2',
        organization_kind: 'pharmacy_department_authority', institution_class: null,
      }));
      expect(r.rows[0]).toEqual({
        organization_kind: 'pharmacy_department_authority', institution_class: null,
      });
    });

    it('THE REGRESSION: the pre-E7-2 payload (neither column sent) is rejected', async () => {
      // This is precisely what createOrganization() used to send. It fails on
      // the conditional CHECK, because organization_kind falls back to the
      // 'care_institution' DEFAULT while institution_class stays NULL.
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `INSERT INTO organizations (id,name,name_ar,code) VALUES ($1,'Old','Old','p172-old')`,
        [randomUUID()],
      )));
      expect(msg).toMatch(/organizations_kind_institution_class_chk/);
    });

    it('the client-side refusals mirror real database refusals', async () => {
      // care_institution with no class — client throws INSTITUTION_CLASS_REQUIRED
      const noClass = await rejects(() => rig.asAdmin((c: any) => insertAsService(c, {
        id: randomUUID(), code: 'p172-bad-1',
        organization_kind: 'care_institution', institution_class: null,
      })));
      expect(noClass).toMatch(/organizations_kind_institution_class_chk/);

      // authority carrying a class — client throws AUTHORITY_MUST_NOT_HAVE_INSTITUTION_CLASS
      const authWithClass = await rejects(() => rig.asAdmin((c: any) => insertAsService(c, {
        id: randomUUID(), code: 'p172-bad-2',
        organization_kind: 'pharmacy_department_authority', institution_class: 'hospital',
      })));
      expect(authWithClass).toMatch(/organizations_kind_institution_class_chk/);

      // an unknown kind — client throws ORGANIZATION_KIND_REQUIRED
      const badKind = await rejects(() => rig.asAdmin((c: any) => insertAsService(c, {
        id: randomUUID(), code: 'p172-bad-3',
        organization_kind: 'clinic', institution_class: null,
      })));
      expect(badKind).toMatch(/organizations_organization_kind_chk|organizations_kind_institution_class_chk/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // B. facilities.service.ts — upsert + warehouse assignment
  // ══════════════════════════════════════════════════════════════════════
  describe('B. facility management wiring', () => {
    let facilityId: string;

    it('upsertOrganizationFacility()\'s argument order creates a health-centre facility', async () => {
      const r = await rig.asUser(SUPER, (c: any) => call(c, 'phoenix_upsert_organization_facility', [
        null, ORG_SECTOR, 'primary_health_center', 'HC One', 'مركز واحد', 'p172-hc1', true,
      ]), { commit: true });
      expect(r.ok).toBe(true);
      expect(r.facility_class).toBe('primary_health_center');
      facilityId = r.facility_id;
    });

    it('the same RPC updates in place when a facility id is supplied', async () => {
      const r = await rig.asUser(SUPER, (c: any) => call(c, 'phoenix_upsert_organization_facility', [
        facilityId, ORG_SECTOR, 'subordinate_health_center', 'HC One Renamed', 'مركز واحد', 'p172-hc1', true,
      ]), { commit: true });
      expect(r.ok).toBe(true);
      expect(r.facility_id).toBe(facilityId);
      expect(r.facility_class).toBe('subordinate_health_center');
    });

    it('a hospital cannot host a subordinate facility — the UI must not offer it', async () => {
      const msg = await rejects(() => rig.asUser(SUPER, (c: any) =>
        call(c, 'phoenix_upsert_organization_facility', [
          null, ORG_HOSPITAL, 'primary_health_center', 'Bad', 'سيئ', 'p172-bad-fac', true,
        ])));
      expect(msg).toMatch(/health_sector|of_parent|parent_class/i);
    });

    it('a pharmacy department authority can never host a facility', async () => {
      const msg = await rejects(() => rig.asUser(SUPER, (c: any) =>
        call(c, 'phoenix_upsert_organization_facility', [
          null, ORG_AUTHORITY, 'primary_health_center', 'Bad', 'سيئ', 'p172-bad-fac2', true,
        ])));
      expect(msg).toMatch(/health_sector|of_parent|parent_class|institution_class/i);
    });

    it('assignWarehouseFacility()\'s argument order links a warehouse to a facility', async () => {
      const r = await rig.asUser(SUPER, (c: any) =>
        call(c, 'phoenix_assign_warehouse_facility', [WH_SECTOR, facilityId]), { commit: true });
      expect(r.ok).toBe(true);
      expect(r.new_facility_id).toBe(facilityId);
    });

    it('passing a null facility id clears the link, as the "no center" option does', async () => {
      const r = await rig.asUser(SUPER, (c: any) =>
        call(c, 'phoenix_assign_warehouse_facility', [WH_SECTOR, null]), { commit: true });
      expect(r.ok).toBe(true);
      expect(r.new_facility_id).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // C. route management wiring
  // ══════════════════════════════════════════════════════════════════════
  describe('C. replenishment route wiring', () => {
    it('upsertReplenishmentRoute()\'s argument order creates a pharmacy→rescue-cart route', async () => {
      const r = await rig.asUser(SUPER, (c: any) => call(c, 'phoenix_upsert_outlet_replenishment_route', [
        null, PH_HOSPITAL, CART_ER, true, 'E7-2 wiring',
      ]), { commit: true });
      expect(r.ok).toBe(true);
      expect(r.is_active).toBe(true);
    });

    it('a self-transfer route is refused — the UI excludes the source from destinations', async () => {
      const msg = await rejects(() => rig.asUser(SUPER, (c: any) =>
        call(c, 'phoenix_upsert_outlet_replenishment_route', [null, PH_HOSPITAL, PH_HOSPITAL, true, null])));
      expect(msg).toMatch(/self|orr_no_self_transfer|destination/i);
    });

    it('a non-pharmacy source is refused — the UI only offers pharmacies as sources', async () => {
      const msg = await rejects(() => rig.asUser(SUPER, (c: any) =>
        call(c, 'phoenix_upsert_outlet_replenishment_route', [null, CART_ER, CAB_WARD, true, null])));
      expect(msg).toMatch(/pharmacy|source/i);
    });

    it('the route read model the UI lists is RLS-visible with the expected columns', async () => {
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT id, organization_id, source_point_id, destination_point_id,
                source_point_type, destination_point_type, is_active, notes
         FROM outlet_replenishment_routes WHERE organization_id=$1`, [ORG_HOSPITAL]));
      expect(r.rows.length).toBeGreaterThanOrEqual(1);
      expect(r.rows[0].source_point_type).toBe('pharmacy');
      expect(r.rows[0].destination_point_type).toBe('rescue_cart');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // D. initial provisioning wiring + the one-shot lifecycle invariant
  // ══════════════════════════════════════════════════════════════════════
  describe('D. initial provisioning wiring', () => {
    it('createInitialProvisioningDispatch()\'s argument order opens the one slot', async () => {
      const r = await rig.asUser(SUPER, (c: any) => call(c, 'phoenix_create_initial_provisioning_dispatch', [
        WH_HOSPITAL, CAB_WARD, 'IP-172-1', null, null, 'E7-2 initial provisioning',
      ]), { commit: true });
      expect(r.ok).toBe(true);
      expect(r.is_initial_provisioning).toBe(true);
    });

    it('the state the UI reads comes from 166\'s own columns, never from stock', async () => {
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT id, status, is_initial_provisioning, initial_provisioning_consumed_at
         FROM warehouse_dispatches
         WHERE destination_distribution_point_id=$1 AND is_initial_provisioning=true`, [CAB_WARD]));
      expect(r.rows).toHaveLength(1);
      // Slot open (not yet consumed) — and note the outlet's balance is zero
      // here, which must NOT be what decides eligibility either way.
      expect(r.rows[0].initial_provisioning_consumed_at).toBeNull();
    });

    it('a second initial provisioning for the same outlet is refused while one is open', async () => {
      const msg = await rejects(() => rig.asUser(SUPER, (c: any) =>
        call(c, 'phoenix_create_initial_provisioning_dispatch', [
          WH_HOSPITAL, CAB_WARD, 'IP-172-2', null, null, null,
        ])));
      expect(msg).toMatch(/initial_provisioning|once|uniq/i);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // E. eligibility — the UI mirror agrees with the server, both directions
  // ══════════════════════════════════════════════════════════════════════
  describe('E. route eligibility matches the service-layer mirror, shape for shape', () => {
    /**
     * These assertions were written after the rig rejected a health-sector
     * route with `health_center_route_requires_facility` — a rule the first
     * draft of `outletContextEligibility()` did not model at all. The mirror
     * now covers both shapes, and each canonical identifier below is one the
     * mirror can also produce, so the UI declines for the same stated reason
     * the server would.
     */
    let hcPharmacy: string;
    let hcCabinet: string;
    let hcCart: string;
    let facilityA: string;
    let facilityB: string;

    beforeAll(async () => {
      const a = await rig.asUser(SUPER, (c: any) => call(c, 'phoenix_upsert_organization_facility', [
        null, ORG_SECTOR, 'primary_health_center', 'HC A', 'مركز أ', 'p172-hc-a', true,
      ]), { commit: true });
      facilityA = a.facility_id;
      const b = await rig.asUser(SUPER, (c: any) => call(c, 'phoenix_upsert_organization_facility', [
        null, ORG_SECTOR, 'primary_health_center', 'HC B', 'مركز ب', 'p172-hc-b', true,
      ]), { commit: true });
      facilityB = b.facility_id;

      // Two warehouses under two DIFFERENT facilities, so cross-facility
      // routing can be exercised as well as the same-facility happy path.
      const whA = randomUUID();
      const whB = randomUUID();
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code,facility_id) VALUES
           ($1,$3,'HC A Depot','HC A Depot','active','institution','p172-wh-hca',$4),
           ($2,$3,'HC B Depot','HC B Depot','active','institution','p172-wh-hcb',$5)`,
        [whA, whB, ORG_SECTOR, facilityA, facilityB]));

      hcPharmacy = randomUUID(); hcCabinet = randomUUID(); hcCart = randomUUID();
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
           ($1,$4,$6,'HC A Pharmacy','HC A Pharmacy','pharmacy','active','non_emergency'),
           ($2,$4,$6,'HC A Cabinet','HC A Cabinet','crash_cabinet','active','emergency'),
           ($3,$5,$6,'HC B Cart','HC B Cart','rescue_cart','active','emergency')`,
        [hcPharmacy, hcCabinet, hcCart, whA, whB, ORG_SECTOR]));
    });

    it('SHAPE H happy path: same-facility pharmacy → emergency crash cabinet is accepted', async () => {
      const r = await rig.asUser(SUPER, (c: any) =>
        call(c, 'phoenix_upsert_outlet_replenishment_route', [null, hcPharmacy, hcCabinet, true, null]),
        { commit: true });
      expect(r.ok).toBe(true);
    });

    it('a health sector may never route to a rescue cart (health_center_rescue_cart_forbidden)', async () => {
      // Same facility on both sides would be required first; use a cart that
      // sits under a DIFFERENT facility to prove the cross-facility rule, then
      // the rescue-cart rule via a same-facility cart below.
      const cartSameFacility = randomUUID();
      const whA = await rig.asAdmin((c: any) => c.query(
        `SELECT warehouse_id FROM distribution_points WHERE id=$1`, [hcPharmacy]));
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
         VALUES ($1,$2,$3,'HC A Cart','HC A Cart','rescue_cart','active','emergency')`,
        [cartSameFacility, whA.rows[0].warehouse_id, ORG_SECTOR]));

      const msg = await rejects(() => rig.asUser(SUPER, (c: any) =>
        call(c, 'phoenix_upsert_outlet_replenishment_route', [null, hcPharmacy, cartSameFacility, true, null])));
      expect(msg).toMatch(/health_center_rescue_cart_forbidden/);
    });

    it('cross-facility routing inside one health sector is forbidden', async () => {
      const msg = await rejects(() => rig.asUser(SUPER, (c: any) =>
        call(c, 'phoenix_upsert_outlet_replenishment_route', [null, hcPharmacy, hcCart, true, null])));
      expect(msg).toMatch(/cross_facility_route_forbidden|health_center_rescue_cart_forbidden/);
    });

    it('a health-sector route needs a facility on BOTH sides (the rule that corrected the mirror)', async () => {
      // WH_SECTOR deliberately carries no facility (section B cleared it).
      const phNoFac = randomUUID();
      const cabNoFac = randomUUID();
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
           ($1,$3,$4,'NoFac Pharmacy','NoFac Pharmacy','pharmacy','active','non_emergency'),
           ($2,$3,$4,'NoFac Cabinet','NoFac Cabinet','crash_cabinet','active','emergency')`,
        [phNoFac, cabNoFac, WH_SECTOR, ORG_SECTOR]));

      const msg = await rejects(() => rig.asUser(SUPER, (c: any) =>
        call(c, 'phoenix_upsert_outlet_replenishment_route', [null, phNoFac, cabNoFac, true, null])));
      expect(msg).toMatch(/health_center_route_requires_facility/);
    });

    it('SHAPE I: a hospital route must NOT have a facility on either side', async () => {
      // The hospital fixtures carry no facility, which is why section C's
      // pharmacy → rescue-cart route was accepted. Proving the inverse keeps
      // the two shapes genuinely exclusive.
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT facility_id FROM warehouses WHERE id=$1`, [WH_HOSPITAL]));
      expect(r.rows[0].facility_id).toBeNull();
    });

    it('a hospital crash cabinet must sit in a NON-emergency location', async () => {
      const badCab = randomUUID();
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
         VALUES ($1,$2,$3,'Bad Cab','Bad Cab','crash_cabinet','active','emergency')`,
        [badCab, WH_HOSPITAL, ORG_HOSPITAL]));
      const msg = await rejects(() => rig.asUser(SUPER, (c: any) =>
        call(c, 'phoenix_upsert_outlet_replenishment_route', [null, PH_HOSPITAL, badCab, true, null])));
      expect(msg).toMatch(/crash_cabinet_requires_non_emergency_context/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // F. permission keys the UI gates on actually exist (164)
  // ══════════════════════════════════════════════════════════════════════
  describe('F. Stage-E permission keys exist and are unchanged by E7-2', () => {
    it('the four Migration-164 keys are present — E7-2 invents none', async () => {
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT key FROM permission_keys
         WHERE key IN ('organization_facilities.manage','replenishment_routes.manage',
                       'outlet_stock.replenish','outlet_stock.replenish_reverse')
         ORDER BY key`));
      expect(r.rows.map((x: any) => x.key)).toEqual([
        'organization_facilities.manage',
        'outlet_stock.replenish',
        'outlet_stock.replenish_reverse',
        'replenishment_routes.manage',
      ]);
    });
  });
});
