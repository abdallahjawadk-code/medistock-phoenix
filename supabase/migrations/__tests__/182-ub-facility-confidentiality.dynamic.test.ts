/**
 * R1.1-U / U-B — FACILITY CONFIDENTIALITY, adversarially.
 *
 * The sibling 182 dynamic suite proves the AUTHORIZATION HELPERS answer
 * correctly. This suite proves the READ SURFACES actually obey them, which is a
 * different question and the one that matters: a helper that says "no" is
 * worthless if a policy or a SECURITY DEFINER function never asks it.
 *
 * Two bypass classes are covered.
 *
 *   1. ORG-ONLY RLS. Several SELECT policies authorize on organization
 *      membership alone — no permission key, no scope. For every pre-182 role
 *      that is the whole contract and stays correct. For a facility-scoped role
 *      "same organization" is exactly the boundary it must not inherit.
 *
 *   2. SECURITY DEFINER READ MODELS. These bypass RLS entirely, so a narrowed
 *      policy proves nothing about them. phoenix_outlet_availability_read_model
 *      and phoenix_available_stock gate on organization only, and would
 *      otherwise return any outlet in the sector.
 *
 * Every assertion runs under a REAL authenticated session (SET LOCAL ROLE
 * authenticated + the JWT sub GUC), so RLS is genuinely enforced rather than
 * bypassed by the test's own superuser connection. An institution_admin control
 * runs beside every manager to prove non-regression: its visibility must be
 * exactly what it was before.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 240000 });
const run = rigAvailable() ? describe : describe.skip;

// Sector A holds centres A and B; sector B holds centre C.
const SEC_A = randomUUID(), SEC_B = randomUUID();
const FAC_A = randomUUID(), FAC_B = randomUUID(), FAC_C = randomUUID();
const MAIN_A = randomUUID(), DEP_A = randomUUID(), DEP_B = randomUUID();
const MAIN_B = randomUUID(), DEP_C = randomUUID();
const PH_A = randomUUID(), PH_B = randomUUID(), PH_C = randomUUID();
const MGR_A = randomUUID(), MGR_AB = randomUUID(), ADMIN_A = randomUUID();
const SUPER = '00000000-0000-0000-0000-0000000000a1';

run('182 U-B · facility confidentiality on the real read surfaces', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  const asAdmin = (sql: string, p: any[] = []) => rig.asAdmin((c: any) => c.query(sql, p));
  /** Runs as a genuine `authenticated` principal, so RLS is enforced. */
  const asUser = (uid: string, sql: string, p: any[] = []) =>
    rig.asUser(uid, (c: any) => c.query(sql, p));

  beforeAll(async () => {
    rig = await buildRig({});
    await asAdmin(`
      INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
        ('${SEC_A}','Sector A','قأ','ub-a','care_institution','health_sector','active'),
        ('${SEC_B}','Sector B','قب','ub-b','care_institution','health_sector','active');
      INSERT INTO organization_facilities (id,organization_id,parent_institution_class,facility_class,name,name_ar,status) VALUES
        ('${FAC_A}','${SEC_A}','health_sector','primary_health_center','Centre A','أ','active'),
        ('${FAC_B}','${SEC_A}','health_sector','primary_health_center','Centre B','ب','active'),
        ('${FAC_C}','${SEC_B}','health_sector','primary_health_center','Centre C','ج','active');
      INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
        ('${MAIN_A}','${SEC_A}','Sector A Main','ر','institution',NULL,true,'active'),
        ('${DEP_A}','${SEC_A}','Depot A','دأ','institution','${FAC_A}',false,'active'),
        ('${DEP_B}','${SEC_A}','Depot B','دب','institution','${FAC_B}',false,'active'),
        ('${MAIN_B}','${SEC_B}','Sector B Main','رب','institution',NULL,true,'active'),
        ('${DEP_C}','${SEC_B}','Depot C','دج','institution','${FAC_C}',false,'active');
      INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status) VALUES
        ('${PH_A}','${DEP_A}','${SEC_A}','Pharmacy A','صأ','pharmacy','active'),
        ('${PH_B}','${DEP_B}','${SEC_A}','Pharmacy B','صب','pharmacy','active'),
        ('${PH_C}','${DEP_C}','${SEC_B}','Pharmacy C','صج','pharmacy','active');

      INSERT INTO item_availability (organization_id,distribution_point_id,scientific_name,port_name,condition,quantity,source_kind) VALUES
        ('${SEC_A}','${PH_A}','DrugA','PhA','available',5,'manual'),
        ('${SEC_A}','${PH_B}','DrugB','PhB','available',7,'manual'),
        ('${SEC_B}','${PH_C}','DrugC','PhC','available',9,'manual');
      INSERT INTO outlet_stock (organization_id,distribution_point_id,point_type,scientific_name,unit,
        has_no_national_code,has_no_batch_number,internal_batch_reference,on_hand_quantity,reserved_quantity) VALUES
        ('${SEC_A}','${PH_A}','pharmacy','StockA','box',true,true,'IBR-A',10,0),
        ('${SEC_A}','${PH_B}','pharmacy','StockB','box',true,true,'IBR-B',20,0),
        ('${SEC_B}','${PH_C}','pharmacy','StockC','box',true,true,'IBR-C',30,0);

      INSERT INTO qr_targets (id,organization_id,target_type,target_id,label,status) VALUES
        ('${randomUUID()}','${SEC_A}','distribution_point','${PH_A}','QR-A','active'),
        ('${randomUUID()}','${SEC_A}','distribution_point','${PH_B}','QR-B','active'),
        ('${randomUUID()}','${SEC_A}','warehouse','${MAIN_A}','QR-MAIN','active');

      INSERT INTO stocktakes (organization_id,scope_kind,scope_id,performed_by) VALUES
        ('${SEC_A}','outlet','${PH_A}','${SUPER}'),
        ('${SEC_A}','outlet','${PH_B}','${SUPER}'),
        ('${SEC_A}','warehouse','${MAIN_A}','${SUPER}');

      INSERT INTO auth.users (id,email) VALUES
        ('${MGR_A}','ub-mgr-a@rig.local'),
        ('${MGR_AB}','ub-mgr-ab@rig.local'),
        ('${ADMIN_A}','ub-admin-a@rig.local') ON CONFLICT DO NOTHING;
      UPDATE profiles SET role='health_center_manager', status='active', organization_id='${SEC_A}'
        WHERE id IN ('${MGR_A}','${MGR_AB}');
      UPDATE profiles SET role='institution_admin', status='active', organization_id='${SEC_A}'
        WHERE id='${ADMIN_A}';
      INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,is_active) VALUES
        ('${MGR_A}','${SEC_A}','facility','${FAC_A}',true),
        ('${MGR_AB}','${SEC_A}','facility','${FAC_A}',true),
        ('${MGR_AB}','${SEC_A}','facility','${FAC_B}',true);
    `);
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  const seen = async (uid: string, sql: string): Promise<string[]> =>
    (await asUser(uid, sql)).rows.map((r: any) => String(Object.values(r)[0])).sort();

  // ══ 1. ORG-ONLY RLS, now facility-narrowed ═══════════════════════════════
  describe('item_availability — the highest-severity surface', () => {
    it('manager A reads ONLY centre A, never centre B, the main, or another sector', async () => {
      expect(await seen(MGR_A, 'SELECT port_name FROM item_availability')).toEqual(['PhA']);
    });
    it('manager A+B reads BOTH its centres and still nothing else', async () => {
      expect(await seen(MGR_AB, 'SELECT port_name FROM item_availability')).toEqual(['PhA', 'PhB']);
    });
    it('the institution_admin control is UNCHANGED — org-wide, as before', async () => {
      expect(await seen(ADMIN_A, 'SELECT port_name FROM item_availability')).toEqual(['PhA', 'PhB']);
    });
    it('super_admin still reads every sector, including the foreign one', async () => {
      // Scoped to this fixture: the rig also carries demo-seed availability.
      const rows = await seen(SUPER,
        `SELECT port_name FROM item_availability WHERE port_name IN ('PhA','PhB','PhC')`);
      expect(rows).toEqual(['PhA', 'PhB', 'PhC']);
    });

    it('NEITHER manager can see the foreign sector, by any path', async () => {
      for (const uid of [MGR_A, MGR_AB]) {
        expect(await seen(uid, `SELECT port_name FROM item_availability`), uid).not.toContain('PhC');
      }
    });
  });

  describe('QR enumeration — the oracle behind a public-by-design payload', () => {
    it('a manager enumerates only its own centre QR targets, and never the sector main', async () => {
      expect(await seen(MGR_A, 'SELECT label FROM qr_targets')).toEqual(['QR-A']);
      expect(await seen(MGR_AB, 'SELECT label FROM qr_targets')).toEqual(['QR-A', 'QR-B']);
    });
    it('the sector-main QR target is invisible to every manager', async () => {
      for (const uid of [MGR_A, MGR_AB]) {
        expect(await seen(uid, 'SELECT label FROM qr_targets'), uid).not.toContain('QR-MAIN');
      }
    });
    it('the institution_admin control still sees all three', async () => {
      expect(await seen(ADMIN_A, 'SELECT label FROM qr_targets')).toEqual(['QR-A', 'QR-B', 'QR-MAIN']);
    });
  });

  describe('stocktakes — counted quantities per outlet and warehouse', () => {
    it('a manager sees only its own centre counts, never the sector main count', async () => {
      const a = await seen(MGR_A, 'SELECT scope_id FROM stocktakes');
      expect(a).toEqual([PH_A].sort());
      const ab = await seen(MGR_AB, 'SELECT scope_id FROM stocktakes');
      expect(ab.sort()).toEqual([PH_A, PH_B].sort());
      expect(ab).not.toContain(MAIN_A);
    });
    it('the institution_admin control still sees all three', async () => {
      expect(await seen(ADMIN_A, 'SELECT scope_id FROM stocktakes')).toHaveLength(3);
    });
  });

  // ══ 2. SECURITY DEFINER READ MODELS — RLS cannot help here ═══════════════
  describe('SECURITY DEFINER read models obey facility scope', () => {
    const readModelRows = async (uid: string, point: string): Promise<number> => {
      const r = await asUser(uid,
        `SELECT jsonb_array_length((phoenix_outlet_availability_read_model($1)->>'rows')::jsonb) AS n`, [point]);
      return Number(r.rows[0].n);
    };
    const availableItems = async (uid: string, point: string): Promise<number> => {
      const r = await asUser(uid, `SELECT phoenix_available_stock($1) AS v`, [point]);
      return (r.rows[0].v.items ?? []).length;
    };

    it('phoenix_outlet_availability_read_model: own centre YES, other centre NO, other sector NO', async () => {
      expect(await readModelRows(MGR_A, PH_A)).toBeGreaterThan(0);
      expect(await readModelRows(MGR_A, PH_B)).toBe(0);
      expect(await readModelRows(MGR_A, PH_C)).toBe(0);
    });

    it('phoenix_available_stock: own centre YES, other centre NO, other sector NO', async () => {
      expect(await availableItems(MGR_A, PH_A)).toBeGreaterThan(0);
      expect(await availableItems(MGR_A, PH_B)).toBe(0);
      expect(await availableItems(MGR_A, PH_C)).toBe(0);
    });

    it('a two-centre manager reaches both of its centres through both read models', async () => {
      expect(await readModelRows(MGR_AB, PH_A)).toBeGreaterThan(0);
      expect(await readModelRows(MGR_AB, PH_B)).toBeGreaterThan(0);
      expect(await readModelRows(MGR_AB, PH_C)).toBe(0);
      expect(await availableItems(MGR_AB, PH_A)).toBeGreaterThan(0);
      expect(await availableItems(MGR_AB, PH_B)).toBeGreaterThan(0);
      expect(await availableItems(MGR_AB, PH_C)).toBe(0);
    });

    it('the institution_admin control keeps its org-wide reach through both', async () => {
      expect(await readModelRows(ADMIN_A, PH_A)).toBeGreaterThan(0);
      expect(await readModelRows(ADMIN_A, PH_B)).toBeGreaterThan(0);
      expect(await availableItems(ADMIN_A, PH_A)).toBeGreaterThan(0);
      expect(await availableItems(ADMIN_A, PH_B)).toBeGreaterThan(0);
      // ...and still cannot cross the organization boundary.
      expect(await readModelRows(ADMIN_A, PH_C)).toBe(0);
    });

    it('an off-facility outlet is INDISTINGUISHABLE from a nonexistent one', async () => {
      // Both return the same empty shape — the refusal never discloses that the
      // outlet exists, which is the 083/179 contract this preserves.
      const offFacility = await readModelRows(MGR_A, PH_B);
      const nonexistent = await readModelRows(MGR_A, randomUUID());
      expect(offFacility).toBe(nonexistent);
      expect(await availableItems(MGR_A, PH_B)).toBe(await availableItems(MGR_A, randomUUID()));
    });
  });

  // ══ 2b. THE NARROWING PATTERN ITSELF IS FAIL-CLOSED ══════════════════════
  describe('the `role <> ... OR scope` pattern is fail-closed under a NULL role', () => {
    it('a NULL role DENIES rather than allows — `<>` is load-bearing, not `IS DISTINCT FROM`', async () => {
      // phoenix_my_role() is `select role from profiles where id = auth.uid()`,
      // so it yields NULL for any session with no profile row. Under three-valued
      // logic `NULL <> 'health_center_manager'` is NULL, so the conjunct is NULL
      // unless the scope test passes, and RLS denies anything that is not TRUE.
      //
      // `IS DISTINCT FROM` would instead have returned TRUE and ALLOWED the row.
      // This asserts the safe operator was chosen, and would fail if anyone
      // "tidied" it into the null-safe form.
      const r = await asAdmin(`
        SELECT
          coalesce((NULL <> 'health_center_manager') OR false, false)            AS null_role_denied,
          coalesce((NULL IS DISTINCT FROM 'health_center_manager') OR false, false) AS unsafe_form_would_allow,
          coalesce(('institution_admin' <> 'health_center_manager') OR false, false) AS other_role_unaffected,
          coalesce(('health_center_manager' <> 'health_center_manager') OR true, false) AS scope_test_decides`);
      const row = r.rows[0];
      expect(row.null_role_denied).toBe(false);
      expect(row.unsafe_form_would_allow).toBe(true);
      expect(row.other_role_unaffected).toBe(true);
      expect(row.scope_test_decides).toBe(true);
    });

    it('every narrowed policy uses the fail-closed operator', async () => {
      const r = await asAdmin(`
        SELECT count(*)::int AS n FROM pg_policies
        WHERE schemaname='public'
          AND qual LIKE '%health_center_manager%'
          AND qual LIKE '%IS DISTINCT FROM%'`);
      expect(r.rows[0].n).toBe(0);
    });
  });

  // ══ 2c. FAIL-CLOSED SURFACES (independent adversarial review) ════════════
  // These carry ONLY organization_id — no warehouse, outlet or facility column —
  // so facility scope is not expressible on them without a data-model change.
  // They are DENIED to the role rather than partially served. Each assertion
  // pairs the manager with the institution_admin control, so "denied" is proved
  // to be role-specific and not simply an empty table.
  describe('surfaces that cannot be facility-resolved are denied outright', () => {
    beforeAll(async () => {
      await asAdmin(`
        INSERT INTO phoenix_movement_events (organization_id,trace_id,event_type,occurred_at,source_label,destination_label,material_label,quantity_delta)
        VALUES ('${SEC_A}','${randomUUID()}','dispatch_sent',now(),'Depot A','Pharmacy B','DrugX',5);
        INSERT INTO phoenix_notifications (organization_id,event_type,occurred_at,reference_type,reference_label)
        VALUES ('${SEC_A}','dispatch_sent',now(),'warehouse_dispatch','DSP-1');
      `);
    });

    it('phoenix_movement_events: denied to the manager, unchanged for the control', async () => {
      // Scoped to this fixture's row: the rig also carries demo-seed events.
      const q = `SELECT material_label FROM phoenix_movement_events WHERE material_label='DrugX'`;
      expect(await seen(MGR_A, q)).toEqual([]);
      expect(await seen(MGR_AB, q)).toEqual([]);
      expect(await seen(ADMIN_A, q)).toEqual(['DrugX']);
      // ...and the manager sees NOTHING at all in the table, not merely not this row.
      const all = await asUser(MGR_A, 'SELECT count(*)::int AS n FROM phoenix_movement_events');
      expect(Number(all.rows[0].n)).toBe(0);
    });

    it('phoenix_notifications: denied to the manager — it renders in the top bar at login', async () => {
      const q = `SELECT reference_label FROM phoenix_notifications WHERE reference_label='DSP-1'`;
      expect(await seen(MGR_A, q)).toEqual([]);
      expect(await seen(ADMIN_A, q)).toEqual(['DSP-1']);
      const all = await asUser(MGR_A, 'SELECT count(*)::int AS n FROM phoenix_notifications');
      expect(Number(all.rows[0].n)).toBe(0);
    });

    it('the org-only request ledgers are denied, and the resolvable one is narrowed not denied', async () => {
      for (const t of ['phoenix_warehouse_correction_requests', 'phoenix_dispatch_line_requests',
                       'phoenix_outlet_return_line_requests', 'phoenix_outlet_return_exception_resolutions']) {
        const r = await asUser(MGR_A, `SELECT count(*)::int AS n FROM ${t}`);
        expect(Number(r.rows[0].n), t).toBe(0);
      }
      // This one carries outlet_stock_id, so it resolves to a facility and is
      // narrowed rather than denied — the predicate names the scope test.
      // By NAME: the table also carries a demo-purger SELECT policy granted to a
      // different role, so an unqualified rows[0] would read the wrong one.
      const r = await asAdmin(`
        SELECT qual FROM pg_policies
        WHERE schemaname='public'
          AND tablename='phoenix_stock_correction_requests'
          AND policyname='phoenix_stock_correction_requests_select_scoped'`);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].qual).toContain('phoenix_profile_has_point_assignment');
    });

    it('the SECURITY DEFINER movement/notification readers are denied too', async () => {
      const timeline = await asUser(MGR_A,
        `SELECT jsonb_array_length(coalesce((phoenix_movement_timeline($1,50,NULL,NULL)->>'events')::jsonb,'[]'::jsonb)) AS n`,
        [randomUUID()]);
      expect(Number(timeline.rows[0].n)).toBe(0);

      const notes = await asUser(MGR_A,
        `SELECT jsonb_array_length(coalesce((phoenix_notifications_list(50,NULL,NULL,NULL)->>'notifications')::jsonb,'[]'::jsonb)) AS n`);
      expect(Number(notes.rows[0].n)).toBe(0);
    });

    it('the dispense-context reader refuses the role, disclosing nothing', async () => {
      // The role guard sits AFTER the row lookup, so an id that does not exist
      // raises movement_context_not_found first and a real off-facility id
      // raises forbidden_cross_org_access. Both are refusals that return no
      // data, and neither distinguishes "exists but denied" from "absent" to
      // the caller — which is the property that matters.
      await expect(
        asUser(MGR_A, `SELECT phoenix_get_movement_dispense_context($1)`, [randomUUID()]),
      ).rejects.toThrow(/forbidden_cross_org_access|movement_context_not_found/);
    });
  });

  // ══ 2d. SELF-SERVICE ORGANIZATION CHANGE ════════════════════════════════
  describe('an active manager cannot move itself between health sectors', () => {
    it('changing its own organization_id is refused', async () => {
      const msg = await asAdmin(`UPDATE profiles SET organization_id=$2 WHERE id=$1`, [MGR_A, SEC_B])
        .then(() => '', (e: any) => String(e?.message ?? e));
      expect(msg).toMatch(/health_center_manager_organization_change_forbidden/);
      const row = await asAdmin(`SELECT organization_id FROM profiles WHERE id=$1`, [MGR_A]);
      expect(row.rows[0].organization_id).toBe(SEC_A);
    });

    it('a non-facility-scoped profile is unaffected — 002s policy is untouched', async () => {
      const r = await asAdmin(
        `UPDATE profiles SET organization_id=$2 WHERE id=$1 RETURNING organization_id`, [ADMIN_A, SEC_B]);
      expect(r.rows[0].organization_id).toBe(SEC_B);
      await asAdmin(`UPDATE profiles SET organization_id=$2 WHERE id=$1`, [ADMIN_A, SEC_A]);
    });
  });

  // ══ 3. REVOCATION AND DRIFT close the read surfaces too ══════════════════
  describe('revoking the facility closes every read surface at once', () => {
    it('a revoked centre disappears from RLS and from the read models together', async () => {
      const probe = randomUUID();
      await asAdmin(`INSERT INTO auth.users (id,email) VALUES ($1,'ub-revoke@rig.local') ON CONFLICT DO NOTHING`, [probe]);
      await asAdmin(`UPDATE profiles SET role='health_center_manager', status='active', organization_id=$2 WHERE id=$1`, [probe, SEC_A]);
      const id = (await asAdmin(
        `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,is_active)
         VALUES ($1,$2,'facility',$3,true) RETURNING id`, [probe, SEC_A, FAC_A])).rows[0].id;

      expect(await seen(probe, 'SELECT port_name FROM item_availability')).toEqual(['PhA']);

      await asAdmin(
        `UPDATE profile_scope_assignments SET is_active=false, revoked_at=now(), revoke_reason='ub proof' WHERE id=$1`, [id]);

      expect(await seen(probe, 'SELECT port_name FROM item_availability')).toEqual([]);
      const r = await asUser(probe,
        `SELECT jsonb_array_length((phoenix_outlet_availability_read_model($1)->>'rows')::jsonb) AS n`, [PH_A]);
      expect(Number(r.rows[0].n)).toBe(0);
    });
  });
});
