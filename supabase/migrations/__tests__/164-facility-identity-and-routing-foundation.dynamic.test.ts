/**
 * 164 · FACILITY IDENTITY + ROUTING FOUNDATION (Stage E · E-2) — dynamic proof.
 *
 * Builds a disposable Postgres through 001->164 and exercises the real objects.
 * Every rule this migration adds is asserted against the DATABASE, not against
 * the SQL text, and every rule is asserted in its REJECTING direction as well as
 * its accepting one — a guard that only ever sees the happy path proves nothing.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 60000 });

const run = rigAvailable() ? describe : describe.skip;

// ── Fixture ids ──────────────────────────────────────────────────────────────
const ORG_SECTOR = '00000000-0000-0000-0000-000000164001';
const ORG_HOSPITAL = '00000000-0000-0000-0000-000000164002';
const ORG_SPECIAL = '00000000-0000-0000-0000-000000164003';
const ORG_UNCLASSIFIED = '00000000-0000-0000-0000-000000164004';
const ORG_SECTOR_2 = '00000000-0000-0000-0000-000000164005';

const FAC_A = '00000000-0000-0000-0000-000000164101'; // primary health centre
const FAC_B = '00000000-0000-0000-0000-000000164102'; // subordinate health centre
const FAC_INACTIVE = '00000000-0000-0000-0000-000000164103';
const FAC_OTHER_SECTOR = '00000000-0000-0000-0000-000000164104';

const WH_SECTOR = '00000000-0000-0000-0000-000000164201'; // facility_id NULL
const WH_FAC_A = '00000000-0000-0000-0000-000000164202';
const WH_FAC_A2 = '00000000-0000-0000-0000-000000164203'; // 2nd depot, same facility
const WH_FAC_B = '00000000-0000-0000-0000-000000164204';
const WH_HOSPITAL = '00000000-0000-0000-0000-000000164205';
const WH_SPECIAL = '00000000-0000-0000-0000-000000164206';
const WH_UNCLASSIFIED = '00000000-0000-0000-0000-000000164207';

const PH_A = '00000000-0000-0000-0000-000000164301';
const CAB_A = '00000000-0000-0000-0000-000000164302';
const PH_A2 = '00000000-0000-0000-0000-000000164303'; // pharmacy on facility A's 2nd depot
const PH_B = '00000000-0000-0000-0000-000000164304';
const CAB_B = '00000000-0000-0000-0000-000000164305';
const PH_SECTOR = '00000000-0000-0000-0000-000000164306';
const CAB_SECTOR = '00000000-0000-0000-0000-000000164307'; // sector-level, emergency
const CART_A = '00000000-0000-0000-0000-000000164308'; // rescue cart at a health centre
const PH_HOSP = '00000000-0000-0000-0000-000000164309';
const CART_HOSP = '00000000-0000-0000-0000-000000164310'; // emergency
const CART_HOSP_NON = '00000000-0000-0000-0000-000000164311'; // non_emergency
const CAB_HOSP = '00000000-0000-0000-0000-000000164312'; // non_emergency
const CAB_HOSP_EM = '00000000-0000-0000-0000-000000164313'; // emergency
const PH_SPECIAL = '00000000-0000-0000-0000-000000164314';
const CART_SPECIAL = '00000000-0000-0000-0000-000000164315'; // emergency
const CAB_SPECIAL = '00000000-0000-0000-0000-000000164316'; // non_emergency
const PH_UNCL = '00000000-0000-0000-0000-000000164317';
const CAB_UNCL = '00000000-0000-0000-0000-000000164318';

const call = (c: any, fn: string, args: any[]) =>
  c.query(
    `SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS r`,
    args,
  ).then((r: any) => r.rows[0].r);

/** Run and return the error message, or throw if it unexpectedly succeeded. */
const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  throw new Error('expected a rejection but the call succeeded');
};

run('164 · facility identity + routing foundation (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig();

    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO organizations(id,name,name_ar,code,institution_class) VALUES
        ('${ORG_SECTOR}','Sector','Sector','p164-sector','health_sector'),
        ('${ORG_HOSPITAL}','Hospital','Hospital','p164-hospital','hospital'),
        ('${ORG_SPECIAL}','Center','Center','p164-special','specialized_center'),
        ('${ORG_SECTOR_2}','Sector2','Sector2','p164-sector2','health_sector'),
        ('${ORG_UNCLASSIFIED}','Unclassified','Unclassified','p164-unclassified',NULL);

      INSERT INTO organization_facilities(id,organization_id,facility_class,name,name_ar,status) VALUES
        ('${FAC_A}','${ORG_SECTOR}','primary_health_center','Centre A','Centre A','active'),
        ('${FAC_B}','${ORG_SECTOR}','subordinate_health_center','Centre B','Centre B','active'),
        ('${FAC_INACTIVE}','${ORG_SECTOR}','primary_health_center','Centre X','Centre X','inactive'),
        ('${FAC_OTHER_SECTOR}','${ORG_SECTOR_2}','primary_health_center','Centre Z','Centre Z','active');

      INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code,facility_id) VALUES
        ('${WH_SECTOR}','${ORG_SECTOR}','Sector Depot','Sector Depot','active','institution','p164-wh-sector',NULL),
        ('${WH_FAC_A}','${ORG_SECTOR}','A Depot','A Depot','active','institution','p164-wh-a','${FAC_A}'),
        ('${WH_FAC_A2}','${ORG_SECTOR}','A Depot 2','A Depot 2','active','institution','p164-wh-a2','${FAC_A}'),
        ('${WH_FAC_B}','${ORG_SECTOR}','B Depot','B Depot','active','institution','p164-wh-b','${FAC_B}'),
        ('${WH_HOSPITAL}','${ORG_HOSPITAL}','Hosp Depot','Hosp Depot','active','institution','p164-wh-hosp',NULL),
        ('${WH_SPECIAL}','${ORG_SPECIAL}','Ctr Depot','Ctr Depot','active','institution','p164-wh-ctr',NULL),
        ('${WH_UNCLASSIFIED}','${ORG_UNCLASSIFIED}','U Depot','U Depot','active','institution','p164-wh-u',NULL);

      INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
        ('${PH_A}','${WH_FAC_A}','${ORG_SECTOR}','A Pharmacy','A Pharmacy','pharmacy','active','non_emergency'),
        ('${CAB_A}','${WH_FAC_A}','${ORG_SECTOR}','A Cabinet','A Cabinet','crash_cabinet','active','emergency'),
        ('${PH_A2}','${WH_FAC_A2}','${ORG_SECTOR}','A Pharmacy 2','A Pharmacy 2','pharmacy','active','non_emergency'),
        ('${PH_B}','${WH_FAC_B}','${ORG_SECTOR}','B Pharmacy','B Pharmacy','pharmacy','active','non_emergency'),
        ('${CAB_B}','${WH_FAC_B}','${ORG_SECTOR}','B Cabinet','B Cabinet','crash_cabinet','active','emergency'),
        ('${PH_SECTOR}','${WH_SECTOR}','${ORG_SECTOR}','Sector Pharmacy','Sector Pharmacy','pharmacy','active','non_emergency'),
        ('${CAB_SECTOR}','${WH_SECTOR}','${ORG_SECTOR}','Sector Cabinet','Sector Cabinet','crash_cabinet','active','emergency'),
        ('${CART_A}','${WH_FAC_A}','${ORG_SECTOR}','A Cart','A Cart','rescue_cart','active','emergency'),
        ('${PH_HOSP}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Pharmacy','H Pharmacy','pharmacy','active','non_emergency'),
        ('${CART_HOSP}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Cart','H Cart','rescue_cart','active','emergency'),
        ('${CART_HOSP_NON}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Cart NE','H Cart NE','rescue_cart','active','non_emergency'),
        ('${CAB_HOSP}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Cabinet','H Cabinet','crash_cabinet','active','non_emergency'),
        ('${CAB_HOSP_EM}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Cabinet EM','H Cabinet EM','crash_cabinet','active','emergency'),
        ('${PH_SPECIAL}','${WH_SPECIAL}','${ORG_SPECIAL}','C Pharmacy','C Pharmacy','pharmacy','active','non_emergency'),
        ('${CART_SPECIAL}','${WH_SPECIAL}','${ORG_SPECIAL}','C Cart','C Cart','rescue_cart','active','emergency'),
        ('${CAB_SPECIAL}','${WH_SPECIAL}','${ORG_SPECIAL}','C Cabinet','C Cabinet','crash_cabinet','active','non_emergency'),
        ('${PH_UNCL}','${WH_UNCLASSIFIED}','${ORG_UNCLASSIFIED}','U Pharmacy','U Pharmacy','pharmacy','active','non_emergency'),
        ('${CAB_UNCL}','${WH_UNCLASSIFIED}','${ORG_UNCLASSIFIED}','U Cabinet','U Cabinet','crash_cabinet','active','non_emergency');
    `));
  });

  afterAll(async () => { if (rig) await rig.end(); });

  const route = (src: string, dst: string) =>
    rig.asUser(rig.superAdminId, (c: any) =>
      call(c, 'phoenix_upsert_outlet_replenishment_route', [null, src, dst, true, null]));

  // ══ 1. institution_class vocabulary ════════════════════════════════════════
  describe('institution_class holds exactly the three top-level classes', () => {
    it.each(['primary_health_center', 'subordinate_health_center'])(
      'rejects %s — a health centre is a facility, never an institution class',
      async (value) => {
        const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
          `UPDATE organizations SET institution_class=$1 WHERE id=$2`, [value, ORG_HOSPITAL])));
        expect(msg).toMatch(/organizations_institution_class_chk/);
      },
    );

    it.each(['hospital', 'specialized_center', 'health_sector'])('accepts %s', async (value) => {
      await rig.asAdmin((c: any) => c.query(
        `UPDATE organizations SET institution_class=$1 WHERE id=$2`, [value, ORG_UNCLASSIFIED]));
      await rig.asAdmin((c: any) => c.query(
        `UPDATE organizations SET institution_class=NULL WHERE id=$1`, [ORG_UNCLASSIFIED]));
    });
  });

  // ══ 2. facility parent must be a health sector — structurally ══════════════
  describe('a facility may only exist under a health_sector organization', () => {
    it('rejects a facility under a hospital (composite FK, not convention)', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(`
        INSERT INTO organization_facilities(organization_id,facility_class,name,name_ar)
        VALUES('${ORG_HOSPITAL}','primary_health_center','X','X')`)));
      expect(msg).toMatch(/of_parent_class_fk/);
    });

    it('rejects a facility under a specialized centre', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(`
        INSERT INTO organization_facilities(organization_id,facility_class,name,name_ar)
        VALUES('${ORG_SPECIAL}','primary_health_center','X','X')`)));
      expect(msg).toMatch(/of_parent_class_fk/);
    });

    it('rejects a facility under an UNCLASSIFIED organization — NULL gains nothing', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(`
        INSERT INTO organization_facilities(organization_id,facility_class,name,name_ar)
        VALUES('${ORG_UNCLASSIFIED}','primary_health_center','X','X')`)));
      expect(msg).toMatch(/of_parent_class_fk/);
    });

    it('rejects an invalid facility_class', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(`
        INSERT INTO organization_facilities(organization_id,facility_class,name,name_ar)
        VALUES('${ORG_SECTOR}','hospital','X','X')`)));
      expect(msg).toMatch(/of_facility_class_chk/);
    });

    it('cannot be smuggled in by overriding the pinned parent discriminator', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(`
        INSERT INTO organization_facilities(organization_id,parent_institution_class,facility_class,name,name_ar)
        VALUES('${ORG_HOSPITAL}','hospital','primary_health_center','X','X')`)));
      expect(msg).toMatch(/of_parent_is_health_sector_chk/);
    });
  });

  // ══ 3. facility identity is independent of warehouse lifecycle ═════════════
  describe('facility identity is independent of warehouses', () => {
    it('a facility may exist with ZERO warehouses', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM warehouses WHERE facility_id=$1`, [FAC_INACTIVE]));
      expect(rows[0].n).toBe(0);
      const f = await rig.asAdmin((c: any) => c.query(
        `SELECT id FROM organization_facilities WHERE id=$1`, [FAC_INACTIVE]));
      expect(f.rows).toHaveLength(1);
    });

    it('a facility may own MORE THAN ONE warehouse', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM warehouses WHERE facility_id=$1`, [FAC_A]));
      expect(rows[0].n).toBe(2);
    });

    it('deactivating a warehouse does not destroy facility identity', async () => {
      await rig.asAdmin((c: any) => c.query(
        `UPDATE warehouses SET status='inactive' WHERE id=$1`, [WH_FAC_A2]));
      const f = await rig.asAdmin((c: any) => c.query(
        `SELECT status FROM organization_facilities WHERE id=$1`, [FAC_A]));
      expect(f.rows[0].status).toBe('active');
      await rig.asAdmin((c: any) => c.query(
        `UPDATE warehouses SET status='active' WHERE id=$1`, [WH_FAC_A2]));
    });

    it('a facility with warehouses cannot be deleted out from under them', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `DELETE FROM organization_facilities WHERE id=$1`, [FAC_A])));
      expect(msg).toMatch(/warehouses_facility_org_fk|violates foreign key/i);
    });

    it('rejects a warehouse linked to a facility in ANOTHER organization', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `UPDATE warehouses SET facility_id=$1 WHERE id=$2`, [FAC_OTHER_SECTOR, WH_FAC_B])));
      expect(msg).toMatch(/warehouses_facility_org_fk|violates foreign key/i);
    });
  });

  // ══ 4. route eligibility — LEGAL shapes ════════════════════════════════════
  describe('legal routes are accepted', () => {
    it('hospital: pharmacy -> rescue cart in an emergency context', async () => {
      const r: any = await route(PH_HOSP, CART_HOSP);
      expect(r.ok).toBe(true);
    });

    it('hospital: pharmacy -> crash cabinet in a non-emergency context', async () => {
      const r: any = await route(PH_HOSP, CAB_HOSP);
      expect(r.ok).toBe(true);
    });

    it('specialized centre: pharmacy -> crash cabinet in a non-emergency context', async () => {
      const r: any = await route(PH_SPECIAL, CAB_SPECIAL);
      expect(r.ok).toBe(true);
    });

    it('health centre: pharmacy -> crash cabinet in the SAME facility, emergency', async () => {
      const r: any = await route(PH_A, CAB_A);
      expect(r.ok).toBe(true);
    });

    it('health centre: a second depot of the SAME facility is still same-facility', async () => {
      // Facility containment is by FACILITY, not by warehouse: PH_A2 sits on
      // facility A's second depot and may still serve facility A's cabinet.
      const r: any = await route(PH_A2, CAB_A);
      expect(r.ok).toBe(true);
      await rig.asAdmin((c: any) => c.query(
        `DELETE FROM outlet_replenishment_routes WHERE source_point_id=$1`, [PH_A2]));
    });
  });

  // ══ 5. route eligibility — REJECTION matrix ════════════════════════════════
  describe('cross-facility replenishment is rejected inside one organization', () => {
    it('Centre A pharmacy -> Centre B crash cabinet', async () => {
      const msg = await rejects(() => route(PH_A, CAB_B));
      expect(msg).toMatch(/cross_facility_route_forbidden/);
    });

    it('Centre B pharmacy -> Centre A crash cabinet', async () => {
      const msg = await rejects(() => route(PH_B, CAB_A));
      expect(msg).toMatch(/cross_facility_route_forbidden/);
    });

    it('sector-level pharmacy -> health-centre crash cabinet', async () => {
      const msg = await rejects(() => route(PH_SECTOR, CAB_A));
      expect(msg).toMatch(/health_center_route_requires_facility/);
    });

    it('health-centre pharmacy -> sector-level crash cabinet', async () => {
      const msg = await rejects(() => route(PH_A, CAB_SECTOR));
      expect(msg).toMatch(/health_center_route_requires_facility/);
    });
  });

  describe('emergency-outlet eligibility is enforced', () => {
    it('a health centre may NOT have a rescue cart', async () => {
      const msg = await rejects(() => route(PH_A, CART_A));
      expect(msg).toMatch(/health_center_rescue_cart_forbidden/);
    });

    it('a specialized centre may NOT have a rescue cart', async () => {
      const msg = await rejects(() => route(PH_SPECIAL, CART_SPECIAL));
      expect(msg).toMatch(/rescue_cart_requires_hospital/);
    });

    it('a hospital rescue cart in a NON-emergency context is rejected', async () => {
      const msg = await rejects(() => route(PH_HOSP, CART_HOSP_NON));
      expect(msg).toMatch(/rescue_cart_requires_emergency_context/);
    });

    it('a hospital crash cabinet in an EMERGENCY context is rejected', async () => {
      const msg = await rejects(() => route(PH_HOSP, CAB_HOSP_EM));
      expect(msg).toMatch(/crash_cabinet_requires_non_emergency_context/);
    });

    it('a sector-level outlet does NOT inherit the health-centre emergency exception', async () => {
      // CAB_SECTOR is an emergency crash cabinet in a health_sector org, but has
      // no subordinate facility. It must not be routable.
      const msg = await rejects(() => route(PH_SECTOR, CAB_SECTOR));
      expect(msg).toMatch(/health_center_route_requires_facility/);
    });
  });

  describe('NULL classification grants no capability', () => {
    it('rejects a route when the organization is unclassified', async () => {
      const msg = await rejects(() => route(PH_UNCL, CAB_UNCL));
      expect(msg).toMatch(/organization_institution_class_required/);
    });

    it('rejects a route when the destination clinical context is unclassified', async () => {
      await rig.asAdmin((c: any) => c.query(
        `UPDATE distribution_points SET clinical_location_kind=NULL WHERE id=$1`, [CAB_SPECIAL]));
      const msg = await rejects(() => route(PH_SPECIAL, CAB_SPECIAL));
      expect(msg).toMatch(/destination_clinical_location_kind_required/);
      await rig.asAdmin((c: any) => c.query(
        `UPDATE distribution_points SET clinical_location_kind='non_emergency' WHERE id=$1`, [CAB_SPECIAL]));
    });

    it('rejects a facility route when the facility is inactive', async () => {
      await rig.asAdmin((c: any) => c.query(
        `UPDATE organization_facilities SET status='inactive' WHERE id=$1`, [FAC_B]));
      const msg = await rejects(() => route(PH_B, CAB_B));
      expect(msg).toMatch(/facility_not_active/);
      await rig.asAdmin((c: any) => c.query(
        `UPDATE organization_facilities SET status='active' WHERE id=$1`, [FAC_B]));
    });
  });

  describe('structural route guards', () => {
    it('rejects a non-pharmacy source', async () => {
      const msg = await rejects(() => route(CAB_HOSP, CART_HOSP));
      expect(msg).toMatch(/source_must_be_pharmacy/);
    });

    it('rejects a pharmacy destination', async () => {
      const msg = await rejects(() => route(PH_HOSP, PH_A));
      expect(msg).toMatch(/destination_must_be_emergency_outlet|cross_organization_route_forbidden/);
    });

    it('rejects a self-transfer', async () => {
      const msg = await rejects(() => route(PH_HOSP, PH_HOSP));
      expect(msg).toMatch(/source_and_destination_must_differ/);
    });

    it('rejects a cross-ORGANIZATION route', async () => {
      const msg = await rejects(() => route(PH_HOSP, CAB_SPECIAL));
      expect(msg).toMatch(/cross_organization_route_forbidden/);
    });

    it('rejects an inactive outlet', async () => {
      await rig.asAdmin((c: any) => c.query(
        `UPDATE distribution_points SET status='inactive' WHERE id=$1`, [CAB_SPECIAL]));
      const msg = await rejects(() => route(PH_SPECIAL, CAB_SPECIAL));
      expect(msg).toMatch(/outlet_not_active/);
      await rig.asAdmin((c: any) => c.query(
        `UPDATE distribution_points SET status='active' WHERE id=$1`, [CAB_SPECIAL]));
    });

    it('allows at most ONE active source per destination', async () => {
      // Every other route test rolls back, so nothing is persisted by default.
      // This one must COMMIT the first route to prove the second is refused.
      const PH2 = '00000000-0000-0000-0000-000000164399';
      await rig.asAdmin((c: any) => c.query(`
        INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
        VALUES('${PH2}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Pharmacy 2','H Pharmacy 2','pharmacy','active','non_emergency')
        ON CONFLICT (id) DO NOTHING`));

      const first: any = await rig.asUser(rig.superAdminId, (c: any) =>
        call(c, 'phoenix_upsert_outlet_replenishment_route',
          [null, PH_HOSP, CART_HOSP, true, null]), { commit: true });
      expect(first.ok).toBe(true);

      try {
        const msg = await rejects(() => route(PH2, CART_HOSP));
        expect(msg).toMatch(/one_source_per_destination|duplicate key/i);

        // Deactivating the first frees the destination — the index is partial.
        await rig.asAdmin((c: any) => c.query(
          `UPDATE outlet_replenishment_routes SET is_active=false WHERE id=$1`, [first.route_id]));
        const second: any = await route(PH2, CART_HOSP);
        expect(second.ok).toBe(true);
      } finally {
        await rig.asAdmin((c: any) => c.query(
          `DELETE FROM outlet_replenishment_routes WHERE destination_point_id=$1`, [CART_HOSP]));
      }
    });
  });

  // ══ 6. no name inference ═══════════════════════════════════════════════════
  describe('classification is never inferred from a name', () => {
    it('renaming an outlet to look like an emergency ward changes nothing', async () => {
      await rig.asAdmin((c: any) => c.query(
        `UPDATE distribution_points SET name='Emergency Ward Rescue Cart', name_ar='طوارئ'
         WHERE id=$1`, [CART_HOSP_NON]));
      const msg = await rejects(() => route(PH_HOSP, CART_HOSP_NON));
      expect(msg).toMatch(/rescue_cart_requires_emergency_context/);
    });

    it('the route RPC body never reads a name column', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT pg_get_functiondef('public.phoenix_upsert_outlet_replenishment_route(uuid,uuid,uuid,boolean,text)'::regprocedure) AS d`));
      expect(rows[0].d).not.toMatch(/\bname\b|\bname_ar\b|ILIKE|LIKE '/);
    });
  });

  // ══ 7. facility administration RPC ═════════════════════════════════════════
  describe('phoenix_upsert_organization_facility', () => {
    it('creates a facility under a health sector', async () => {
      const r: any = await rig.asUser(rig.superAdminId, (c: any) =>
        call(c, 'phoenix_upsert_organization_facility',
          [null, ORG_SECTOR, 'primary_health_center', 'New Centre', 'New Centre', null, true]),
        { commit: true });
      expect(r.ok).toBe(true);
      expect(r.facility_class).toBe('primary_health_center');
    });

    it('refuses a non-health-sector parent with a NAMED error', async () => {
      const msg = await rejects(() => rig.asUser(rig.superAdminId, (c: any) =>
        call(c, 'phoenix_upsert_organization_facility',
          [null, ORG_HOSPITAL, 'primary_health_center', 'X', 'X', null, true])));
      expect(msg).toMatch(/facility_parent_must_be_health_sector/);
    });

    it('refuses an UNCLASSIFIED parent', async () => {
      const msg = await rejects(() => rig.asUser(rig.superAdminId, (c: any) =>
        call(c, 'phoenix_upsert_organization_facility',
          [null, ORG_UNCLASSIFIED, 'primary_health_center', 'X', 'X', null, true])));
      expect(msg).toMatch(/organization_institution_class_required/);
    });

    it('refuses an invalid facility class', async () => {
      const msg = await rejects(() => rig.asUser(rig.superAdminId, (c: any) =>
        call(c, 'phoenix_upsert_organization_facility',
          [null, ORG_SECTOR, 'hospital', 'X', 'X', null, true])));
      expect(msg).toMatch(/invalid_facility_class/);
    });

    it('refuses to re-parent an existing facility', async () => {
      const msg = await rejects(() => rig.asUser(rig.superAdminId, (c: any) =>
        call(c, 'phoenix_upsert_organization_facility',
          [FAC_A, ORG_SECTOR_2, 'primary_health_center', 'A', 'A', null, true])));
      expect(msg).toMatch(/facility_organization_immutable/);
    });
  });

  // ══ 8. isolation, RLS and non-regression ═══════════════════════════════════
  describe('security posture', () => {
    it('anon may not read either new table', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT has_table_privilege('anon','public.organization_facilities','SELECT') AS f,
               has_table_privilege('anon','public.outlet_replenishment_routes','SELECT') AS r`));
      expect(rows[0].f).toBe(false);
      expect(rows[0].r).toBe(false);
    });

    it('authenticated has no direct DML on either new table', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT has_table_privilege('authenticated','public.organization_facilities','INSERT') AS fi,
               has_table_privilege('authenticated','public.outlet_replenishment_routes','INSERT') AS ri,
               has_table_privilege('authenticated','public.organization_facilities','UPDATE') AS fu,
               has_table_privilege('authenticated','public.outlet_replenishment_routes','DELETE') AS rd`));
      expect(Object.values(rows[0])).toEqual([false, false, false, false]);
    });

    it('RLS is enabled on both new tables', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT relname, relrowsecurity FROM pg_class
        WHERE oid IN ('public.organization_facilities'::regclass,
                      'public.outlet_replenishment_routes'::regclass)`));
      expect(rows.every((r: any) => r.relrowsecurity)).toBe(true);
    });

    it('the internal ownership resolver is not executable by authenticated', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT has_function_privilege('authenticated',
          'public._phoenix_outlet_facility_context_v1(uuid)','EXECUTE') AS e`));
      expect(rows[0].e).toBe(false);
    });

    it('warehouse_kind is still exactly central | institution', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conname='warehouses_warehouse_kind_chk'`));
      expect(rows[0].d).toContain('central');
      expect(rows[0].d).toContain('institution');
      expect(rows[0].d).not.toMatch(/health_center|depot/);
    });

    it('no second balance ledger exists', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT count(*)::int AS n FROM pg_class
        WHERE relname IN ('pharmacy_stock','rescue_cart_stock','crash_cabinet_stock','facility_stock')`));
      expect(rows[0].n).toBe(0);
    });

    it('the outlet movement vocabulary is untouched by E-2', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conname='outlet_stock_movements_type_chk'`));
      expect(rows[0].d).not.toMatch(/replenish/);
    });

    it('the Availability vocabulary is untouched', async () => {
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conrelid='public.item_availability'::regclass
          AND pg_get_constraintdef(oid) LIKE '%near_expiry%' LIMIT 1`));
      expect(rows[0].d).not.toMatch(/near_stockout/);
      for (const v of ['available', 'low_stock', 'missing', 'surplus', 'near_expiry', 'expired']) {
        expect(rows[0].d).toContain(v);
      }
    });
  });
});
