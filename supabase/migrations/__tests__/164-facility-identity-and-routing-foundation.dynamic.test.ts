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
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 60000 });

const run = rigAvailable() ? describe : describe.skip;

// ── Fixture ids ──────────────────────────────────────────────────────────────
const ORG_SECTOR = '00000000-0000-0000-0000-000000164001';
const ORG_HOSPITAL = '00000000-0000-0000-0000-000000164002';
const ORG_SPECIAL = '00000000-0000-0000-0000-000000164003';
const ORG_SECTOR_2 = '00000000-0000-0000-0000-000000164005';
// Disposable single-purpose orgs for the CHECK-admits-all-three-values proof
// below. Pre-170 that proof mutated ORG_UNCLASSIFIED's institution_class
// through each value in turn; 170's immutability trigger (once set, never
// changes) makes that mutation-based approach impossible now, so each value
// gets its own throwaway org instead.
const ORG_ACCEPT_HOSPITAL = '00000000-0000-0000-0000-000000164006';
const ORG_ACCEPT_SPECIAL = '00000000-0000-0000-0000-000000164007';
const ORG_ACCEPT_SECTOR = '00000000-0000-0000-0000-000000164008';

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
        ('${ORG_SECTOR_2}','Sector2','Sector2','p164-sector2','health_sector');

      INSERT INTO organization_facilities(id,organization_id,facility_class,name,name_ar,status) VALUES
        ('${FAC_A}','${ORG_SECTOR}','primary_health_center','Centre A','Centre A','active'),
        ('${FAC_B}','${ORG_SECTOR}','subordinate_health_center','Centre B','Centre B','active'),
        ('${FAC_INACTIVE}','${ORG_SECTOR}','primary_health_center','Centre X','Centre X','inactive'),
        ('${FAC_OTHER_SECTOR}','${ORG_SECTOR_2}','primary_health_center','Centre Z','Centre Z','active');

      INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code,facility_id,is_main) VALUES
        -- R1.1/181: the facility-less sector warehouse IS the sector main; the
        -- flag simply had no meaning before 181 made the shape an invariant.
        ('${WH_SECTOR}','${ORG_SECTOR}','Sector Depot','Sector Depot','active','institution','p164-wh-sector',NULL,true),
        ('${WH_FAC_A}','${ORG_SECTOR}','A Depot','A Depot','active','institution','p164-wh-a','${FAC_A}',false),
        -- R1.1/181: a health centre runs ONE active depot
        -- (warehouses_one_active_depot_per_facility_uniq). The second depot of
        -- facility A therefore exists as a retired one. 164's point is unchanged
        -- and still proved below: facility identity is not warehouse identity.
        ('${WH_FAC_A2}','${ORG_SECTOR}','A Depot 2','A Depot 2','inactive','institution','p164-wh-a2','${FAC_A}',false),
        ('${WH_FAC_B}','${ORG_SECTOR}','B Depot','B Depot','active','institution','p164-wh-b','${FAC_B}',false),
        ('${WH_HOSPITAL}','${ORG_HOSPITAL}','Hosp Depot','Hosp Depot','active','institution','p164-wh-hosp',NULL,false),
        ('${WH_SPECIAL}','${ORG_SPECIAL}','Ctr Depot','Ctr Depot','active','institution','p164-wh-ctr',NULL,false);

      INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
        ('${PH_A}','${WH_FAC_A}','${ORG_SECTOR}','A Pharmacy','A Pharmacy','pharmacy','active','non_emergency'),
        ('${CAB_A}','${WH_FAC_A}','${ORG_SECTOR}','A Cabinet','A Cabinet','crash_cabinet','active','emergency'),
        ('${PH_B}','${WH_FAC_B}','${ORG_SECTOR}','B Pharmacy','B Pharmacy','pharmacy','active','non_emergency'),
        ('${CAB_B}','${WH_FAC_B}','${ORG_SECTOR}','B Cabinet','B Cabinet','crash_cabinet','active','emergency'),
        -- R1.1/181: PH_SECTOR, CAB_SECTOR and CART_A are deliberately NOT
        -- seeded. All three are shapes 181 refuses to create at all, and each
        -- is proved impossible in the rejection matrix below instead.
        ('${PH_HOSP}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Pharmacy','H Pharmacy','pharmacy','active','non_emergency'),
        ('${CART_HOSP}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Cart','H Cart','rescue_cart','active','emergency'),
        ('${CART_HOSP_NON}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Cart NE','H Cart NE','rescue_cart','active','non_emergency'),
        ('${CAB_HOSP}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Cabinet','H Cabinet','crash_cabinet','active','non_emergency'),
        ('${CAB_HOSP_EM}','${WH_HOSPITAL}','${ORG_HOSPITAL}','H Cabinet EM','H Cabinet EM','crash_cabinet','active','emergency'),
        ('${PH_SPECIAL}','${WH_SPECIAL}','${ORG_SPECIAL}','C Pharmacy','C Pharmacy','pharmacy','active','non_emergency'),
        ('${CART_SPECIAL}','${WH_SPECIAL}','${ORG_SPECIAL}','C Cart','C Cart','rescue_cart','active','emergency'),
        ('${CAB_SPECIAL}','${WH_SPECIAL}','${ORG_SPECIAL}','C Cabinet','C Cabinet','crash_cabinet','active','non_emergency');
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
        // Proved via a fresh INSERT, not an UPDATE of an already-classified
        // org: 170's immutability trigger (BEFORE UPDATE OF institution_class)
        // would now intercept an UPDATE on ORG_HOSPITAL before the CHECK is
        // ever reached. INSERT never fires that trigger, so this still proves
        // the CHECK constraint itself rejects a facility-class value.
        const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
          `INSERT INTO organizations(id,name,name_ar,code,institution_class)
           VALUES ($1,'Rejects','Rejects',$2,$3)`,
          [randomUUID(), `p164-rejects-${value}`, value])));
        expect(msg).toMatch(/organizations_institution_class_chk/);
      },
    );

    it.each([
      ['hospital', ORG_ACCEPT_HOSPITAL],
      ['specialized_center', ORG_ACCEPT_SPECIAL],
      ['health_sector', ORG_ACCEPT_SECTOR],
    ])('accepts %s', async (value, id) => {
      // 170 made institution_class immutable once set, so this can no longer
      // prove admission by mutating one row through all three values in turn
      // (the pre-170 approach) — a disposable single-purpose org per value
      // proves the same CHECK-constraint admission instead.
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO organizations(id,name,name_ar,code,institution_class)
         VALUES ($1,'Accepts','Accepts',$2,$3) ON CONFLICT (id) DO NOTHING`,
        [id, `p164-accepts-${value}`, value]));
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

    // "rejects a facility under an UNCLASSIFIED organization — NULL gains
    // nothing" removed: Migration 170 makes institution_class NOT NULL, so an
    // organization with NULL institution_class can no longer exist in the
    // database at all — this scenario is now structurally unreachable, not
    // merely untested.

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
      // Proved on facility B, whose single depot can be retired and restored.
      // Facility A's second depot is already retired under 181's one-active-
      // depot rule, so toggling that one would assert nothing.
      await rig.asAdmin((c: any) => c.query(
        `UPDATE distribution_points SET status='inactive' WHERE id IN ($1,$2)`, [PH_B, CAB_B]));
      await rig.asAdmin((c: any) => c.query(
        `UPDATE warehouses SET status='inactive' WHERE id=$1`, [WH_FAC_B]));
      const f = await rig.asAdmin((c: any) => c.query(
        `SELECT status FROM organization_facilities WHERE id=$1`, [FAC_B]));
      expect(f.rows[0].status).toBe('active');
      await rig.asAdmin((c: any) => c.query(
        `UPDATE warehouses SET status='active' WHERE id=$1`, [WH_FAC_B]));
      await rig.asAdmin((c: any) => c.query(
        `UPDATE distribution_points SET status='active' WHERE id IN ($1,$2)`, [PH_B, CAB_B]));
    });

    it('a facility may not run TWO active depots at once', async () => {
      // R1.1/181. The retired second depot cannot simply be switched back on.
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `UPDATE warehouses SET status='active' WHERE id=$1`, [WH_FAC_A2])));
      expect(msg).toMatch(/warehouses_one_active_depot_per_facility_uniq/);
    });

    it('a facility with warehouses cannot be deleted out from under them', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `DELETE FROM organization_facilities WHERE id=$1`, [FAC_A])));
      expect(msg).toMatch(/warehouses_facility_org_fk|violates foreign key/i);
    });

    it('rejects a warehouse linked to a facility in ANOTHER organization', async () => {
      // Routed through an authenticated super_admin, not rig.asAdmin: 170's
      // warehouse-facility guard trigger (BEFORE UPDATE OF facility_id) now
      // requires authentication for ANY facility_id change and runs before
      // the FK, so an unauthenticated raw UPDATE would fail on that boundary
      // instead of proving the cross-organization rejection this test is
      // actually about. The guard's own validation independently rejects the
      // cross-org target (target_facility_organization_mismatch) before ever
      // reaching the FK — both are the same invariant, just enforced earlier.
      const msg = await rejects(() => rig.asUser(rig.superAdminId, (c: any) => c.query(
        `UPDATE warehouses SET facility_id=$1 WHERE id=$2`, [FAC_OTHER_SECTOR, WH_FAC_B])));
      expect(msg).toMatch(/target_facility_organization_mismatch|warehouses_facility_org_fk|violates foreign key/i);
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

    it('health centre: the route contract still compares FACILITY identity', async () => {
      // 181 permits one active depot per centre, so a live second-depot route is
      // unreachable. Keep the underlying 164 contract pinned in the catalogue.
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
          JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname='phoenix_upsert_outlet_replenishment_route'`));
      expect(rows[0].def).toContain('v_src.o_facility_id IS DISTINCT FROM v_dst.o_facility_id');
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

    it('neither END of a sector-level route can exist after 181', async () => {
      // 164 refused to ROUTE to or from a sector-level outlet. 181 refuses to
      // CREATE one, so both endpoints of those two routes are now impossible.
      // Refusing the outlet is strictly stronger than refusing its route.
      for (const [id, type, kind] of [
        [PH_SECTOR, 'pharmacy', 'non_emergency'],
        [CAB_SECTOR, 'crash_cabinet', 'emergency'],
      ] as const) {
        const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
          `INSERT INTO distribution_points
             (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
           VALUES ($1,$2,$3,'Sector Outlet','Sector Outlet',$4,'active',$5)`,
          [id, WH_SECTOR, ORG_SECTOR, type, kind])));
        expect(msg, type).toMatch(/health_sector_outlet_requires_health_center_depot/);
      }
    });

    it('the 164 facility requirement is still installed underneath', async () => {
      // Its shape is unreachable now, so it cannot be exercised end to end. It
      // must still EXIST as defence in depth — asserted against the live
      // catalogue rather than the migration file, so a later redefinition of
      // the RPC cannot drop the rule without failing here.
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT pg_get_functiondef(p.oid) AS def
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname='phoenix_upsert_outlet_replenishment_route'`));
      expect(rows).toHaveLength(1);
      expect(rows[0].def).toContain('health_center_route_requires_facility');
    });
  });

  describe('emergency-outlet eligibility is enforced', () => {
    it('a health centre may NOT have a rescue cart — refused at CREATION now', async () => {
      // 164 refused to route to one; 181 refuses to let one exist.
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `INSERT INTO distribution_points
           (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
         VALUES ('${CART_A}','${WH_FAC_A}','${ORG_SECTOR}','A Cart','A Cart','rescue_cart','active','emergency')`)));
      expect(msg).toMatch(/health_center_rescue_cart_not_permitted/);
      // And 164's routing refusal is still installed beneath it.
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT pg_get_functiondef(p.oid) AS def
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname='phoenix_upsert_outlet_replenishment_route'`));
      expect(rows[0].def).toContain('health_center_rescue_cart_forbidden');
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
      // Pre-181 this was proved by routing between two sector-level outlets and
      // watching the route be refused. 181 removes the shape entirely, so the
      // stronger statement is asserted directly: inside a health sector there
      // is no active outlet anywhere that is not under a centre depot.
      const { rows } = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n
           FROM distribution_points dp
           JOIN warehouses w ON w.id = dp.warehouse_id
           JOIN organizations o ON o.id = w.organization_id
          WHERE o.institution_class='health_sector'
            AND dp.status='active' AND w.facility_id IS NULL`));
      expect(rows[0].n).toBe(0);
    });
  });

  describe('NULL classification grants no capability', () => {
    // "rejects a route when the organization is unclassified" removed:
    // Migration 170 makes institution_class NOT NULL, so an unclassified
    // organization can no longer exist in the database — this scenario is
    // now structurally unreachable, not merely untested.

    it('rejects a route when the destination clinical context is unclassified', async () => {
      await rig.asAdmin((c: any) => c.query(
        `UPDATE distribution_points SET clinical_location_kind=NULL WHERE id=$1`, [CAB_SPECIAL]));
      const msg = await rejects(() => route(PH_SPECIAL, CAB_SPECIAL));
      expect(msg).toMatch(/destination_clinical_location_kind_required/);
      await rig.asAdmin((c: any) => c.query(
        `UPDATE distribution_points SET clinical_location_kind='non_emergency' WHERE id=$1`, [CAB_SPECIAL]));
    });

    it('cannot make a routed centre facility inactive underneath its depot', async () => {
      const msg = await rejects(() => rig.asAdmin((c: any) => c.query(
        `UPDATE organization_facilities SET status='inactive' WHERE id=$1`, [FAC_B])));
      expect(msg).toMatch(/health_center_facility_change_blocked_by_active_depot/);
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

    // "refuses an UNCLASSIFIED parent" removed: Migration 170 makes
    // institution_class NOT NULL, so an unclassified organization can no
    // longer exist in the database — this scenario is now structurally
    // unreachable, not merely untested.

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

    it('the outlet movement vocabulary still carries the pre-E-2 core types', async () => {
      // E-2 itself never widens outlet_stock_movements_type_chk. The effective
      // chain tip may include Migration 168 (E-5), which adds replenish_*.
      // Assert the core pre-E-5 types remain rather than forbidding later
      // authorized widenings.
      const { rows } = await rig.asAdmin((c: any) => c.query(`
        SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conname='outlet_stock_movements_type_chk'`));
      for (const t of ['dispense', 'dispatch_receive', 'return_send', 'set_exact']) {
        expect(rows[0].d).toContain(t);
      }
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
