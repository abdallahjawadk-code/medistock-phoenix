// =============================================================================
// 183 · WAREHOUSE LIFECYCLE BOUNDARY (B1) + CANONICAL PREFLIGHT (B2)
// =============================================================================
// Both halves of this suite exist because an independent adversarial review of
// R1.2C found two real defects in Migration 183 as first written. Neither was a
// missing rule — both were a rule that existed but could be walked around.
//
// B1. 'an active emergency outlet has an active owning warehouse' is a claim
//     about TWO rows. 183 originally enforced it only when the OUTLET row was
//     written, so the parent could be mutated out from under it:
//
//         create a legal hospital rescue cart on an active warehouse   -- ok
//         UPDATE warehouses SET status='inactive'                      -- ok (!)
//         => ACTIVE emergency outlet owned by an INACTIVE warehouse
//
//     Migration 181 had already closed this for the health sector, but behind
//     the very early return 183 exists to remove
//     (IF v_class IS DISTINCT FROM 'health_sector' THEN RETURN NEW), so it
//     never fired for a hospital or a specialized centre. PART 1 proves the
//     warehouse side is now closed for every class, and — just as important —
//     that it was NOT over-closed: a deactivation that strands nothing is still
//     as free as it was before.
//
// B2. 183's own preflight re-stated part of the matrix by hand and therefore
//     missed the two invariants 183 itself introduces, so 183 could install
//     cleanly over rows its own validator calls illegal. PART 2 proves the
//     preflight now routes every active row through THE canonical validator,
//     that it refuses every illegal pre-state, that a legal database passes,
//     and that a refusal takes the whole migration with it.
// =============================================================================
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable, MIGRATIONS_DIR } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 180000, hookTimeout: 240000 });

const run = rigAvailable() ? describe : describe.skip;

/** 183's body with its own transaction control removed, so a test can run it
 *  inside its OWN transaction and roll back. Semantically identical. */
const MIGRATION_183 = readFileSync(
  join(MIGRATIONS_DIR, '183_phoenix_emergency_outlet_integrity.sql'), 'utf8',
).replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');

const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e: any) {
    return [e?.message, e?.detail].filter(Boolean).join(' | ') || String(e);
  }
  throw new Error('expected a rejection but the call succeeded');
};

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — B1: the warehouse lifecycle boundary, on the full 001->183 chain
// ════════════════════════════════════════════════════════════════════════════
run('183 · warehouse deactivation cannot strand an active emergency outlet', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const SECTOR = randomUUID(), HOSP = randomUUID(), SPEC = randomUUID();
  const FAC = randomUUID();
  const SECTOR_MAIN = randomUUID(), DEPOT = randomUUID();
  // warehouses_main_requires_active_chk (060) forbids deactivating a MAIN
  // warehouse at all, so every deactivation case below runs on a non-main one.
  const HOSP_WH = randomUUID(), HOSP_WH2 = randomUUID();
  const SPEC_WH = randomUUID(), SPEC_WH2 = randomUUID();

  const asAdmin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));

  beforeAll(async () => {
    rig = await buildRig({});
    await asAdmin(`
      INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
        ('${SECTOR}','Sector183','قطاع','wl-s','care_institution','health_sector','active'),
        ('${HOSP}','Hospital183','مستشفى','wl-h','care_institution','hospital','active'),
        ('${SPEC}','Special183','تخصصي','wl-c','care_institution','specialized_center','active');
      INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,status) VALUES
        ('${FAC}','${SECTOR}','primary_health_center','Centre183','مركز','active');
      INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
        ('${SECTOR_MAIN}','${SECTOR}','Sector Main183','رئيسي','institution',NULL,true,'active'),
        ('${DEPOT}','${SECTOR}','Depot183','مذخر','institution','${FAC}',false,'active'),
        ('${HOSP_WH}','${HOSP}','Hosp WH183','مخزن','institution',NULL,true,'active'),
        ('${HOSP_WH2}','${HOSP}','Hosp WH183 B','مخزن ب','institution',NULL,false,'active'),
        ('${SPEC_WH}','${SPEC}','Spec WH183','مخزن','institution',NULL,true,'active'),
        ('${SPEC_WH2}','${SPEC}','Spec WH183 B','مخزن ب','institution',NULL,false,'active');`);
  }, 240000);

  afterAll(async () => { if (rig) await rig.end(); });

  /**
   * One scenario in its own rolled-back transaction: seed the outlet, attempt
   * the warehouse status change, report the refusal (or null on success). No
   * case can leak an outlet or a status into the next.
   */
  async function deactivateWith(
    outlets: Array<{ wh: string; org: string; type: string; clinical: string | null; status?: string }>,
    warehouse: string,
    newStatus = 'inactive',
  ): Promise<string | null> {
    const client = await rig.pool.connect();
    try {
      await client.query('BEGIN');
      for (const o of outlets) {
        await client.query(
          `INSERT INTO distribution_points
             (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
           VALUES ($1,$2,'WL Outlet','منفذ',$3,$4,$5)`,
          [o.wh, o.org, o.type, o.status ?? 'active', o.clinical]);
      }
      await client.query(`UPDATE warehouses SET status=$1 WHERE id=$2`, [newStatus, warehouse]);
      await client.query('ROLLBACK');
      return null;
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => {});
      // HINT is joined too: for a preflight refusal it carries the operator's
      // instruction, which is part of what the message has to deliver.
      return [e?.message, e?.detail, e?.hint].filter(Boolean).join(' | ') || String(e);
    } finally {
      client.release();
    }
  }

  // ── POSITIVE — historical lifecycle freedom is preserved ──────────────────
  describe('a deactivation that strands nothing is still free', () => {
    it('a hospital warehouse with no outlets at all may be deactivated', async () => {
      expect(await deactivateWith([], HOSP_WH2)).toBeNull();
    });

    it('a hospital warehouse carrying only an active PHARMACY may be deactivated', async () => {
      // A pharmacy is legal with NO owning warehouse at all (021/181), so
      // deactivating its warehouse strands nothing. This is the case that would
      // regress if B1 had been closed by blocking on any active outlet.
      expect(await deactivateWith(
        [{ wh: HOSP_WH2, org: HOSP, type: 'pharmacy', clinical: null }], HOSP_WH2)).toBeNull();
    });

    it('a specialized-centre warehouse carrying only an active pharmacy may be deactivated', async () => {
      expect(await deactivateWith(
        [{ wh: SPEC_WH2, org: SPEC, type: 'pharmacy', clinical: null }], SPEC_WH2)).toBeNull();
    });

    it('an INACTIVE emergency outlet does not block its warehouse', async () => {
      // Only live topology is defended; history is not.
      expect(await deactivateWith(
        [{ wh: HOSP_WH2, org: HOSP, type: 'crash_cabinet', clinical: 'non_emergency', status: 'inactive' }],
        HOSP_WH2)).toBeNull();
    });
  });

  // ── NEGATIVE — the stranding transitions are refused ──────────────────────
  describe('a deactivation that would strand an active emergency outlet is refused', () => {
    it('hospital + active rescue_cart', async () => {
      expect(await deactivateWith(
        [{ wh: HOSP_WH2, org: HOSP, type: 'rescue_cart', clinical: 'emergency' }], HOSP_WH2))
        .toMatch(/emergency_outlet_warehouse_deactivation_blocked_by_active_outlet/);
    });

    it('hospital + active crash_cabinet', async () => {
      expect(await deactivateWith(
        [{ wh: HOSP_WH2, org: HOSP, type: 'crash_cabinet', clinical: 'non_emergency' }], HOSP_WH2))
        .toMatch(/emergency_outlet_warehouse_deactivation_blocked_by_active_outlet/);
    });

    it('specialized centre + active crash_cabinet', async () => {
      expect(await deactivateWith(
        [{ wh: SPEC_WH2, org: SPEC, type: 'crash_cabinet', clinical: 'non_emergency' }], SPEC_WH2))
        .toMatch(/emergency_outlet_warehouse_deactivation_blocked_by_active_outlet/);
    });

    it('archiving is refused for the same reason deactivating is', async () => {
      // The guard keys on "leaving active", not on the literal 'inactive'.
      expect(await deactivateWith(
        [{ wh: HOSP_WH2, org: HOSP, type: 'rescue_cart', clinical: 'emergency' }], HOSP_WH2, 'archived'))
        .toMatch(/emergency_outlet_warehouse_deactivation_blocked_by_active_outlet/);
    });
  });

  // ── 181's health-sector contract is preserved, not narrowed ───────────────
  describe("Migration 181's health-sector contract is untouched", () => {
    it('health-sector depot + active PHARMACY still raises 181s error', async () => {
      // Deliberately NOT narrowed to emergency types: a centre depot is the
      // only supply node its outlets have, so losing it strands a pharmacy too.
      expect(await deactivateWith(
        [{ wh: DEPOT, org: SECTOR, type: 'pharmacy', clinical: null }], DEPOT))
        .toMatch(/health_center_depot_deactivation_blocked_by_active_outlet/);
    });

    it('health-sector depot + active crash_cabinet still raises 181s error', async () => {
      expect(await deactivateWith(
        [{ wh: DEPOT, org: SECTOR, type: 'crash_cabinet', clinical: 'emergency' }], DEPOT))
        .toMatch(/health_center_depot_deactivation_blocked_by_active_outlet/);
    });

    it('the health-sector branch does not leak the new 183 error name', async () => {
      const msg = await deactivateWith(
        [{ wh: DEPOT, org: SECTOR, type: 'pharmacy', clinical: null }], DEPOT);
      expect(msg).not.toMatch(/emergency_outlet_warehouse_deactivation_blocked/);
    });
  });

  // ── FAIL-CLOSED — a blocked deactivation changes nothing at all ───────────
  describe('a blocked deactivation leaves every row exactly as it was', () => {
    it('warehouse stays active, outlet unchanged, stock unchanged, no audit row', async () => {
      const dp = randomUUID();
      // Committed fixture: an active hospital rescue cart with real stock on it.
      await asAdmin(
        `INSERT INTO distribution_points
           (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
         VALUES ($1,$2,$3,'WL Cart','عربة','rescue_cart','active','emergency')`,
        [dp, HOSP_WH2, HOSP]);
      await asAdmin(
        `INSERT INTO outlet_stock
           (organization_id,distribution_point_id,point_type,scientific_name,
            batch_number,has_no_batch_number,national_code,has_no_national_code,on_hand_quantity)
         VALUES ($1,$2,'rescue_cart','Adrenaline','WL-B1',false,'WL-NC1',false,7)`,
        [HOSP, dp]);

      const snapshot = async () => (await asAdmin(`
        SELECT
          (SELECT status FROM warehouses WHERE id=$1)                              AS wh_status,
          (SELECT to_jsonb(d) FROM distribution_points d WHERE d.id=$2)            AS dp_row,
          (SELECT coalesce(sum(on_hand_quantity),0)::int FROM outlet_stock
             WHERE distribution_point_id=$2)                                       AS on_hand,
          (SELECT count(*)::int FROM audit_logs)                                   AS audit_rows`,
        [HOSP_WH2, dp])).rows[0];

      const before = await snapshot();
      expect(before.wh_status).toBe('active');
      expect(before.on_hand).toBe(7);

      const msg = await rejects(() =>
        asAdmin(`UPDATE warehouses SET status='inactive' WHERE id=$1`, [HOSP_WH2]));
      expect(msg).toMatch(/emergency_outlet_warehouse_deactivation_blocked_by_active_outlet/);

      const after = await snapshot();
      expect(after.wh_status).toBe('active');          // the warehouse never left active
      expect(after.dp_row).toEqual(before.dp_row);     // the outlet row is byte-identical
      expect(after.on_hand).toBe(7);                   // no stock moved
      expect(after.audit_rows).toBe(before.audit_rows); // no false success event

      await asAdmin(`DELETE FROM outlet_stock WHERE distribution_point_id=$1`, [dp]);
      await asAdmin(`DELETE FROM distribution_points WHERE id=$1`, [dp]);
    });

    it('the warehouse becomes free again once the outlet is deactivated', async () => {
      // Proof the refusal is about the DEPENDENCY, not about the warehouse.
      const client = await rig.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO distribution_points
             (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
           VALUES ($1,$2,'WL Cart2','عربة٢','rescue_cart','active','emergency')`,
          [HOSP_WH2, HOSP]);
        await client.query(
          `UPDATE distribution_points SET status='inactive' WHERE warehouse_id=$1`, [HOSP_WH2]);
        await client.query(`UPDATE warehouses SET status='inactive' WHERE id=$1`, [HOSP_WH2]);
        const { rows } = await client.query(`SELECT status FROM warehouses WHERE id=$1`, [HOSP_WH2]);
        expect(rows[0].status).toBe('inactive');
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });
  });

  // ── the guard is structurally what it claims to be ───────────────────────
  describe('one guard, one trigger, no second author', () => {
    it('183 adds no second warehouses trigger', async () => {
      const { rows } = await asAdmin(
        `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
          WHERE c.relname='warehouses' AND NOT t.tgisinternal
            AND pg_get_triggerdef(t.oid) ILIKE '%shape_guard%'`);
      expect(rows[0].n).toBe(1);
    });

    it("181's trigger object still watches status", async () => {
      const { rows } = await asAdmin(
        `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
          WHERE c.relname='warehouses' AND t.tgname='warehouses_health_sector_shape_guard_trg'`);
      expect(rows[0].def).toMatch(/status/);
      expect(rows[0].def).toMatch(/_phoenix_health_sector_warehouse_shape_guard_v1/);
    });

    it('the dependency check sits AHEAD of the health-sector early return', async () => {
      // If it ever slides back behind the early return, the hospital and
      // specialized branches become dead code and B1 silently reopens.
      const { rows } = await asAdmin(
        `SELECT pg_get_functiondef('public._phoenix_health_sector_warehouse_shape_guard_v1()'::regprocedure) AS def`);
      const def = rows[0].def as string;
      expect(def.indexOf('emergency_outlet_warehouse_deactivation_blocked_by_active_outlet'))
        .toBeLessThan(def.indexOf("IF v_class IS DISTINCT FROM 'health_sector' THEN"));
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — B2: the preflight is the canonical validator, applied to live rows
// ════════════════════════════════════════════════════════════════════════════
run('183 · preflight refuses to install over a state its own validator rejects', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const SECTOR = randomUUID(), HOSP = randomUUID(), SPEC = randomUUID();
  const PDA = randomUUID();
  const FAC = randomUUID();
  const SECTOR_MAIN = randomUUID(), DEPOT = randomUUID();
  const HOSP_WH = randomUUID(), HOSP_WH_DEAD = randomUUID();
  const SPEC_WH = randomUUID(), PDA_WH = randomUUID();

  beforeAll(async () => {
    // Ceiling 182 — the exact chain 183 is applied onto in Production.
    rig = await buildRig({ upTo: 182 });
    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
        ('${SECTOR}','PF Sector','قطاع','pf-s','care_institution','health_sector','active'),
        ('${HOSP}','PF Hospital','مستشفى','pf-h','care_institution','hospital','active'),
        ('${SPEC}','PF Special','تخصصي','pf-c','care_institution','specialized_center','active'),
        ('${PDA}','PF Authority','دائرة','pf-a','pharmacy_department_authority',NULL,'active');
      INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,status) VALUES
        ('${FAC}','${SECTOR}','primary_health_center','PF Centre','مركز','active');
      INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
        ('${SECTOR_MAIN}','${SECTOR}','PF Main','رئيسي','institution',NULL,true,'active'),
        ('${DEPOT}','${SECTOR}','PF Depot','مذخر','institution','${FAC}',false,'active'),
        ('${HOSP_WH}','${HOSP}','PF Hosp WH','مخزن','institution',NULL,true,'active'),
        ('${HOSP_WH_DEAD}','${HOSP}','PF Dead WH','مخزن ميت','institution',NULL,false,'inactive'),
        ('${SPEC_WH}','${SPEC}','PF Spec WH','مخزن','institution',NULL,true,'active'),
        ('${PDA_WH}','${PDA}','PF Auth WH','مخزن','central',NULL,true,'active');`));
  }, 240000);

  afterAll(async () => { if (rig) await rig.end(); });

  /**
   * Seed one pre-existing ACTIVE outlet, then run Migration 183 against it, all
   * inside a transaction that is always rolled back.
   *
   * The seed disables the USER triggers on distribution_points for the INSERT
   * only. That is not a way around the rule under test — it is how a row that
   * predates 181/183 is reproduced at all. Several of these shapes are exactly
   * what 181 already refuses to create at ceiling 182, and the whole question
   * B2 asks is what 183 does about rows that are ALREADY THERE.
   */
  async function applyOver(
    outlet: { wh: string | null; org: string; type: string; clinical: string | null } | null,
  ): Promise<string | null> {
    const client = await rig.pool.connect();
    try {
      await client.query('BEGIN');
      if (outlet) {
        await client.query('ALTER TABLE distribution_points DISABLE TRIGGER USER');
        await client.query(
          `INSERT INTO distribution_points
             (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
           VALUES ($1,$2,'PF Outlet','منفذ',$3,'active',$4)`,
          [outlet.wh, outlet.org, outlet.type, outlet.clinical]);
        await client.query('ALTER TABLE distribution_points ENABLE TRIGGER USER');
      }
      await client.query(MIGRATION_183);
      await client.query('ROLLBACK');
      return null;
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => {});
      // HINT is joined too: for a preflight refusal it carries the operator's
      // instruction, which is part of what the message has to deliver.
      return [e?.message, e?.detail, e?.hint].filter(Boolean).join(' | ') || String(e);
    } finally {
      client.release();
    }
  }

  const PREREQ = /PREREQUISITE FAILED \(183\): an ACTIVE outlet already violates/;

  it('a database with no violating row installs cleanly', async () => {
    expect(await applyOver(null)).toBeNull();
  });

  it('a fully LEGAL active fixture passes the preflight', async () => {
    // One legal outlet of each governed shape, all at once.
    const client = await rig.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO distribution_points
          (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
          ('${DEPOT}','${SECTOR}','L1','ل١','pharmacy','active','non_emergency'),
          ('${DEPOT}','${SECTOR}','L2','ل٢','crash_cabinet','active','emergency'),
          ('${HOSP_WH}','${HOSP}','L3','ل٣','pharmacy','active',NULL),
          ('${HOSP_WH}','${HOSP}','L4','ل٤','crash_cabinet','active','non_emergency'),
          ('${HOSP_WH}','${HOSP}','L5','ل٥','rescue_cart','active','emergency'),
          ('${SPEC_WH}','${SPEC}','L6','ل٦','pharmacy','active',NULL),
          ('${SPEC_WH}','${SPEC}','L7','ل٧','crash_cabinet','active','non_emergency')`);
      await client.query(MIGRATION_183);
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='phoenix_assert_active_outlet_topology_v1'`);
      expect(rows[0].n).toBe(1);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  // ── every rule of the canonical matrix, exercised through the preflight ───
  describe('every canonical rule blocks the install', () => {
    it('emergency outlet with warehouse_id NULL — the first rule 183 adds', async () => {
      const msg = await applyOver({ wh: null, org: HOSP, type: 'rescue_cart', clinical: 'emergency' });
      expect(msg).toMatch(PREREQ);
      expect(msg).toMatch(/emergency_outlet_requires_owning_warehouse/);
    });

    it('emergency outlet on an INACTIVE warehouse — the second rule 183 adds', async () => {
      const msg = await applyOver({ wh: HOSP_WH_DEAD, org: HOSP, type: 'crash_cabinet', clinical: 'non_emergency' });
      expect(msg).toMatch(PREREQ);
      expect(msg).toMatch(/emergency_outlet_requires_active_warehouse/);
    });

    it('pharmacy department authority holding any active outlet', async () => {
      const msg = await applyOver({ wh: PDA_WH, org: PDA, type: 'pharmacy', clinical: null });
      expect(msg).toMatch(PREREQ);
      expect(msg).toMatch(/pharmacy_department_authority_outlet_not_permitted/);
    });

    it('an outlet hanging off the SECTOR MAIN', async () => {
      const msg = await applyOver({ wh: SECTOR_MAIN, org: SECTOR, type: 'pharmacy', clinical: null });
      expect(msg).toMatch(PREREQ);
      expect(msg).toMatch(/health_sector_outlet_requires_health_center_depot/);
    });

    it('health-centre rescue_cart', async () => {
      const msg = await applyOver({ wh: DEPOT, org: SECTOR, type: 'rescue_cart', clinical: 'emergency' });
      expect(msg).toMatch(PREREQ);
      expect(msg).toMatch(/health_center_rescue_cart_not_permitted/);
    });

    it('health-centre crash_cabinet in a NON-emergency context', async () => {
      const msg = await applyOver({ wh: DEPOT, org: SECTOR, type: 'crash_cabinet', clinical: 'non_emergency' });
      expect(msg).toMatch(PREREQ);
      expect(msg).toMatch(/health_center_crash_cabinet_requires_emergency_context/);
    });

    it('hospital rescue_cart in a NON-emergency context', async () => {
      const msg = await applyOver({ wh: HOSP_WH, org: HOSP, type: 'rescue_cart', clinical: 'non_emergency' });
      expect(msg).toMatch(PREREQ);
      expect(msg).toMatch(/rescue_cart_requires_emergency_context/);
    });

    it('hospital crash_cabinet in an EMERGENCY context', async () => {
      const msg = await applyOver({ wh: HOSP_WH, org: HOSP, type: 'crash_cabinet', clinical: 'emergency' });
      expect(msg).toMatch(PREREQ);
      expect(msg).toMatch(/crash_cabinet_requires_non_emergency_context/);
    });

    it('specialized-centre rescue_cart', async () => {
      const msg = await applyOver({ wh: SPEC_WH, org: SPEC, type: 'rescue_cart', clinical: 'emergency' });
      expect(msg).toMatch(PREREQ);
      expect(msg).toMatch(/specialized_center_rescue_cart_not_permitted/);
    });

    it('specialized-centre crash_cabinet in an EMERGENCY context', async () => {
      const msg = await applyOver({ wh: SPEC_WH, org: SPEC, type: 'crash_cabinet', clinical: 'emergency' });
      expect(msg).toMatch(PREREQ);
      expect(msg).toMatch(/crash_cabinet_requires_non_emergency_context/);
    });

    it('an owner whose institution class the matrix does not recognise', async () => {
      // This is the branch that exists so a class ADDED LATER cannot slip
      // through unvalidated — 181's early return is exactly what happens when
      // that branch is missing. At ceiling 182 the shape is unconstructible by
      // design: 164's membership CHECK pins institution_class to three values
      // and 171's CHECK requires a care_institution to carry one of them. So
      // the future is simulated honestly — both constraints are dropped inside
      // the rolled-back transaction, a fourth class is introduced, and 183 is
      // asked what it makes of it. The answer must be: refuse.
      const client = await rig.pool.connect();
      const org = randomUUID(), wh = randomUUID();
      try {
        await client.query('BEGIN');
        await client.query(`ALTER TABLE organizations
          DROP CONSTRAINT organizations_institution_class_chk,
          DROP CONSTRAINT organizations_kind_institution_class_chk`);
        await client.query(
          `INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status)
           VALUES ($1,'PF Future','مستقبلي','pf-f','care_institution','field_clinic','active')`, [org]);
        await client.query(
          `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
           VALUES ($1,$2,'PF Future WH','مخزن','institution',NULL,true,'active')`, [wh, org]);
        await client.query('ALTER TABLE distribution_points DISABLE TRIGGER USER');
        await client.query(
          `INSERT INTO distribution_points
             (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
           VALUES ($1,$2,'PF Future Outlet','منفذ','pharmacy','active',NULL)`, [wh, org]);
        await client.query('ALTER TABLE distribution_points ENABLE TRIGGER USER');

        const msg = await rejects(() => client.query(MIGRATION_183));
        expect(msg).toMatch(PREREQ);
        expect(msg).toMatch(/outlet_owner_institution_class_unsupported/);
        expect(msg).toMatch(/field_clinic/);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });
  });

  // ── the boundaries of the scan ───────────────────────────────────────────
  describe('the scan judges exactly the rows the matrix governs', () => {
    it('an INACTIVE illegal row does not block the install', async () => {
      const client = await rig.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE distribution_points DISABLE TRIGGER USER');
        await client.query(
          `INSERT INTO distribution_points
             (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
           VALUES ($1,$2,'PF Dead','ميت','rescue_cart','inactive','non_emergency')`,
          [SPEC_WH, SPEC]);
        await client.query('ALTER TABLE distribution_points ENABLE TRIGGER USER');
        await expect(client.query(MIGRATION_183)).resolves.toBeTruthy();
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });

    it('a LEGACY-vocabulary active row does not block the install', async () => {
      // 067:169-177 and 164:62-66 both refuse to guess what a legacy
      // 'dispensing' point really is, and the canonical chain's own seed (004)
      // ships four active ones. They hold no outlet_stock and sit outside the
      // emergency corridor; a reclassification is a write to point_type, so
      // they are judged by the full matrix the moment they try to enter it.
      const msg = await applyOver({ wh: HOSP_WH, org: HOSP, type: 'dispensing', clinical: null });
      expect(msg).toBeNull();
    });

    it('but a legacy row cannot be RECLASSIFIED into an illegal shape afterwards', async () => {
      // The concession above costs nothing, because this is the door it must
      // come through — and 183's write boundary is standing in it.
      const client = await rig.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE distribution_points DISABLE TRIGGER USER');
        const { rows } = await client.query(
          `INSERT INTO distribution_points
             (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
           VALUES ($1,$2,'PF Legacy','قديم','dispensing','active',NULL) RETURNING id`,
          [HOSP_WH, HOSP]);
        await client.query('ALTER TABLE distribution_points ENABLE TRIGGER USER');
        await client.query(MIGRATION_183);
        const msg = await rejects(() => client.query(
          `UPDATE distribution_points SET point_type='rescue_cart' WHERE id=$1`, [rows[0].id]));
        expect(msg).toMatch(/rescue_cart_requires_emergency_context/);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });
  });

  // ── the refusal is transactional ─────────────────────────────────────────
  describe('a prerequisite failure takes the whole migration with it', () => {
    it('no 183 function survives a refused apply', async () => {
      const client = await rig.pool.connect();
      const objects = async () => (await client.query(
        `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname IN (
            'phoenix_assert_active_outlet_topology_v1',
            'phoenix_assert_outlet_topology_for_point_v1')`)).rows[0].n;
      try {
        await client.query('BEGIN');
        expect(await objects()).toBe(0);
        await client.query('ALTER TABLE distribution_points DISABLE TRIGGER USER');
        await client.query(
          `INSERT INTO distribution_points
             (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
           VALUES (NULL,$1,'PF Bad','سيئ','rescue_cart','active','emergency')`,
          [HOSP]);
        await client.query('ALTER TABLE distribution_points ENABLE TRIGGER USER');
        await expect(client.query(MIGRATION_183)).rejects.toThrow(/PREREQUISITE FAILED \(183\)/);
        await client.query('ROLLBACK');
        // Outside the aborted transaction: nothing 183 creates is left behind.
        expect(await objects()).toBe(0);
        const { rows } = await client.query(
          `SELECT pg_get_functiondef('public._phoenix_health_sector_warehouse_shape_guard_v1()'::regprocedure) AS def`);
        expect(rows[0].def).not.toMatch(/emergency_outlet_warehouse_deactivation_blocked_by_active_outlet/);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });

    it('the refused apply leaves the offending row exactly as it found it', async () => {
      // The illegal row is COMMITTED first, so it genuinely outlives the failed
      // apply — otherwise the rollback would be erasing the evidence rather
      // than proving 183 never touched it. 183 repairs nothing, by design.
      const dp = randomUUID();
      const asAdmin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));
      await asAdmin('ALTER TABLE distribution_points DISABLE TRIGGER USER');
      await asAdmin(
        `INSERT INTO distribution_points
           (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
         VALUES ($1,$2,$3,'PF Keep','يبقى','rescue_cart','active','non_emergency')`,
        [dp, HOSP_WH, HOSP]);
      await asAdmin('ALTER TABLE distribution_points ENABLE TRIGGER USER');
      try {
        const before = (await asAdmin(
          `SELECT to_jsonb(d) AS row FROM distribution_points d WHERE d.id=$1`, [dp])).rows[0].row;

        const client = await rig.pool.connect();
        try {
          await client.query('BEGIN');
          await expect(client.query(MIGRATION_183)).rejects.toThrow(/PREREQUISITE FAILED \(183\)/);
        } finally {
          await client.query('ROLLBACK').catch(() => {});
          client.release();
        }

        const after = (await asAdmin(
          `SELECT to_jsonb(d) AS row FROM distribution_points d WHERE d.id=$1`, [dp])).rows[0].row;
        expect(after).toEqual(before);
      } finally {
        await asAdmin('ALTER TABLE distribution_points DISABLE TRIGGER USER');
        await asAdmin(`DELETE FROM distribution_points WHERE id=$1`, [dp]);
        await asAdmin('ALTER TABLE distribution_points ENABLE TRIGGER USER');
      }
    });
  });

  it('the preflight names the offending row so an operator can act on it', async () => {
    const msg = await applyOver({ wh: null, org: HOSP, type: 'crash_cabinet', clinical: 'non_emergency' });
    expect(msg).toMatch(/distribution_point [0-9a-f-]{36}/);
    expect(msg).toMatch(/type=crash_cabinet/);
    expect(msg).toMatch(/warehouse=NULL/);
    expect(msg).toMatch(/resolve the row operationally before applying 183/);
  });

  it('the preflight states no matrix rule of its own', async () => {
    // The whole point of B2's fix: one authority, not two. If a rule name
    // reappears in the migration's own preflight section, the second copy is
    // back and will drift again.
    const raw = readFileSync(
      join(MIGRATIONS_DIR, '183_phoenix_emergency_outlet_integrity.sql'), 'utf8');
    const section = raw.slice(
      raw.indexOf('DO $preexisting$'), raw.indexOf('$preexisting$;') + 20);
    expect(section).toContain('phoenix_assert_active_outlet_topology_v1');
    for (const vocab of ['institution_class', 'organization_kind', 'is_main', 'facility_id']) {
      expect(section, `preflight must not restate ${vocab}`).not.toContain(vocab);
    }
  });
});
