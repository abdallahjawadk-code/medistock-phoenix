/**
 * Migration 181 independent-closure correction round 2 — the NULL-warehouse
 * health-sector outlet bypass.
 *
 * THE SHAPE THIS PROVES CLOSED. distribution_points.warehouse_id is NULLABLE
 * (021 dropped its NOT NULL for "warehouse retirement"; 024 asserts the
 * nullability is still in force). The composite ownership FK added by 178,
 * distribution_points_wh_org_fk (warehouse_id, organization_id), is MATCH
 * SIMPLE and therefore does not constrain a NULL. dp_insert_perm (021/024)
 * gates INSERT on super_admin OR organization scope + ports.create and never
 * mentions warehouse_id. So the database itself permits an ACTIVE health-sector
 * outlet that hangs off NO warehouse — neither a centre depot nor even the
 * sector main — and the row-level guard is the only thing that can refuse it.
 *
 * Two obligations, two rigs:
 *
 *   1. the RUNTIME contract, on the full 001->181 chain — every mutation path
 *      that can produce the shape is refused, and the historical unassigned
 *      freedom of every OTHER organization class survives untouched;
 *
 *   2. the MIGRATION contract, on a chain frozen at 001->180 — 181 must refuse
 *      to certify a database that already holds the shape, and must reach the
 *      SAME verdict as the committed operator pre-apply artifact.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable, MIGRATIONS_DIR } from '../../../tools/pg-rig/rig.mjs';

// PRE-EXISTING INFRASTRUCTURE FIX (surfaced by the R1.2C run, not caused by it).
// This suite REPLAYS THE MIGRATION CHAIN inside a beforeAll. vitest applies a
// separate 10s budget to HOOKS that testTimeout does not cover, so as the chain
// has grown the hook has crept toward that ceiling; past it, the hook is killed
// mid-replay and surfaces as ECONNRESET rather than as any assertion. An explicit
// hook budget removes that false signal. No assertion is changed or relaxed.
vi.setConfig({ testTimeout: 180000, hookTimeout: 240000 });
const run = rigAvailable() ? describe : describe.skip;

/** 181's body with its own transaction control removed, so a test can run it
 *  inside its OWN transaction and roll back. Semantically identical. */
const MIGRATION_181 = readFileSync(
  join(MIGRATIONS_DIR, '181_phoenix_health_sector_topology_reconciliation.sql'), 'utf8',
).replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');

const PREAPPLY = readFileSync(
  join(process.cwd(), 'docs/phoenix/r1-1-181-production-preapply-readonly.sql'),
  'utf8',
);

const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e: any) { return String(e?.message ?? e); }
  throw new Error('expected a rejection but the call succeeded');
};

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — THE RUNTIME CONTRACT, on the full 001->181 chain
// ════════════════════════════════════════════════════════════════════════════
run('181 · unassigned-outlet boundary (001->181 rig)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const SECTOR = randomUUID(), HOSP = randomUUID(), FAC = randomUUID();
  const MAIN = randomUUID(), DEPOT = randomUUID(), HOSP_WH = randomUUID();

  const asAdmin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));

  beforeAll(async () => {
    rig = await buildRig({});
    await asAdmin(`
      INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
        ('${SECTOR}','Sector','قطاع','nw-s','care_institution','health_sector','active'),
        ('${HOSP}','Hospital','مستشفى','nw-h','care_institution','hospital','active');
      INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,status) VALUES
        ('${FAC}','${SECTOR}','primary_health_center','Centre','مركز','active');
      INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
        ('${MAIN}','${SECTOR}','Sector Main','رئيسي','institution',NULL,true,'active'),
        ('${DEPOT}','${SECTOR}','Centre Depot','مذخر','institution','${FAC}',false,'active'),
        ('${HOSP_WH}','${HOSP}','Hosp WH','مخزن','institution',NULL,true,'active');`);
  }, 240000);

  afterAll(async () => { if (rig) await rig.end(); });

  /**
   * One INSERT/UPDATE attempt in its own rolled-back transaction, so no case
   * can leak state into the next. Returns null on success, or the refusal —
   * MESSAGE and DETAIL joined, because the two NULL/sector-main refusals share
   * one error contract and are told apart only by their DETAIL.
   */
  async function attempt(sql: string, params: any[] = []): Promise<string | null> {
    const client = await rig.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql, params);
      await client.query('ROLLBACK');
      return null;
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => {});
      return [e?.message, e?.detail].filter(Boolean).join(' | ') || String(e);
    } finally {
      client.release();
    }
  }

  const insertOutlet = (
    org: string, warehouse: string | null, type: string,
    clinical: string | null = null, status = 'active',
  ) => attempt(
    `INSERT INTO distribution_points
       (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
     VALUES ($1,$2,'Outlet','منفذ',$3,$4,$5)`,
    [warehouse, org, type, status, clinical],
  );

  const DEPOT_CONTRACT = /health_sector_outlet_requires_health_center_depot/;

  // ── 1-3. INSERT with NO warehouse ─────────────────────────────────────────
  describe('INSERT · an active health-sector outlet may not hang off nothing', () => {
    it('1 · a pharmacy with warehouse_id NULL is refused', async () => {
      expect(await insertOutlet(SECTOR, null, 'pharmacy')).toMatch(DEPOT_CONTRACT);
    });

    it('2 · an emergency crash cabinet with warehouse_id NULL is refused', async () => {
      expect(await insertOutlet(SECTOR, null, 'crash_cabinet', 'emergency')).toMatch(DEPOT_CONTRACT);
    });

    it('3 · a rescue cart with warehouse_id NULL is refused', async () => {
      // The missing-centre-depot boundary is reached BEFORE type-specific
      // validation, which is the preferred order: an outlet owned by no health
      // centre is refused whatever it claims to be.
      expect(await insertOutlet(SECTOR, null, 'rescue_cart')).toMatch(DEPOT_CONTRACT);
    });

    it('the refusal names the NULL warehouse, not the sector main', async () => {
      const nullOwner = await insertOutlet(SECTOR, null, 'pharmacy');
      const mainOwner = await insertOutlet(SECTOR, MAIN, 'pharmacy');
      // One error contract, two distinguishable diagnoses.
      expect(nullOwner).toMatch(DEPOT_CONTRACT);
      expect(mainOwner).toMatch(DEPOT_CONTRACT);
      expect(nullOwner).toMatch(/warehouse_id IS NULL leaves it owned by no health centre/);
      expect(mainOwner).toMatch(/never off the sector main/);
      expect(nullOwner).not.toBe(mainOwner);
    });
  });

  // ── 4. UPDATE an existing valid outlet onto NOTHING ───────────────────────
  it('4 · a valid centre pharmacy may not have its warehouse cleared', async () => {
    const point = randomUUID();
    await asAdmin(
      `INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
       VALUES ($1,$2,$3,'Movable','متنقل','pharmacy','active')`, [point, DEPOT, SECTOR]);
    expect(await attempt(
      `UPDATE distribution_points SET warehouse_id=NULL WHERE id=$1`, [point]))
      .toMatch(DEPOT_CONTRACT);
    // Still attached, unchanged.
    const after = await asAdmin(`SELECT warehouse_id FROM distribution_points WHERE id=$1`, [point]);
    expect(after.rows[0].warehouse_id).toBe(DEPOT);
  });

  // ── 5. REACTIVATION of dormant unassigned history ─────────────────────────
  it('5 · a dormant unassigned health-sector outlet may not be reactivated', async () => {
    const point = randomUUID();
    // Historical rows keep their shape and are NOT judged — that is the
    // dormant-history contract, and it is what makes this reactivation path
    // reachable in the first place.
    const insert = await asAdmin(
      `INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
       VALUES ($1,NULL,$2,'Retired','متقاعد','pharmacy','inactive') RETURNING id`, [point, SECTOR]);
    expect(insert.rows[0].id).toBe(point);

    expect(await attempt(`UPDATE distribution_points SET status='active' WHERE id=$1`, [point]))
      .toMatch(DEPOT_CONTRACT);
    const after = await asAdmin(`SELECT status FROM distribution_points WHERE id=$1`, [point]);
    expect(after.rows[0].status).toBe('inactive');
  });

  // ── 6. ORGANIZATION MOVE into a health sector ─────────────────────────────
  it('6 · an active unassigned outlet may not be moved INTO a health sector', async () => {
    const point = randomUUID();
    // The pre-state is legal: 021's warehouse retirement, in a hospital.
    await asAdmin(
      `INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
       VALUES ($1,NULL,$2,'Unassigned','غير مرتبط','pharmacy','active')`, [point, HOSP]);
    expect(await attempt(
      `UPDATE distribution_points SET organization_id=$1 WHERE id=$2`, [SECTOR, point]))
      .toMatch(DEPOT_CONTRACT);
    const after = await asAdmin(`SELECT organization_id FROM distribution_points WHERE id=$1`, [point]);
    expect(after.rows[0].organization_id).toBe(HOSP);
  });

  it('6b · moving it OUT of a health sector stays open as a repair path', async () => {
    const point = randomUUID();
    await asAdmin(
      `INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
       VALUES ($1,NULL,$2,'Legacy','قديم','pharmacy','inactive')`, [point, SECTOR]);
    // Reactivating it inside the sector is refused (case 5); rehoming it to an
    // organization class that permits the shape must remain possible, so a
    // legacy row is never trapped.
    expect(await attempt(
      `UPDATE distribution_points SET organization_id=$1, status='active' WHERE id=$2`, [HOSP, point]))
      .toBeNull();
  });

  // ── 7. POSITIVE NON-HEALTH-SECTOR CONTROL ─────────────────────────────────
  describe('7 · R1.1 does NOT globally forbid an unassigned outlet', () => {
    it('a hospital may still own an ACTIVE outlet with no warehouse', async () => {
      expect(await insertOutlet(HOSP, null, 'pharmacy')).toBeNull();
    });

    /**
     * R1.2C / Migration 183 SUPERSEDES this one case, deliberately and in
     * exactly one direction.
     *
     * R1.1 proved that 181 did not GLOBALLY forbid an unassigned outlet, and
     * used a hospital rescue cart to show it. That property still holds — the
     * pharmacy case above is unchanged and warehouse_id is still nullable
     * (asserted below) — but 183 narrows the freedom for the two EMERGENCY
     * point types only: a crash cabinet or rescue cart cannot become
     * operational without initial provisioning, and provisioning dispatches
     * FROM a warehouse, so an ACTIVE one that names no warehouse is a row the
     * rest of the system can never serve.
     *
     * The R1.1 claim is therefore re-expressed on the shape that still carries
     * it, and the narrowing is asserted outright so it can never regress
     * silently in either direction.
     */
    it('a hospital emergency outlet must now name a warehouse (183 narrows this)', async () => {
      expect(await insertOutlet(HOSP, null, 'rescue_cart', 'emergency'))
        .toMatch(/emergency_outlet_requires_owning_warehouse/);
      expect(await insertOutlet(HOSP, null, 'crash_cabinet', 'non_emergency'))
        .toMatch(/emergency_outlet_requires_owning_warehouse/);
    });

    it('…and the SAME rescue cart is legal the moment it names an active warehouse', async () => {
      // Proof the refusal is about the missing owner, not about the shape.
      expect(await insertOutlet(HOSP, HOSP_WH, 'rescue_cart', 'emergency')).toBeNull();
    });

    it('a health sector may still keep INACTIVE unassigned history', async () => {
      expect(await insertOutlet(SECTOR, null, 'pharmacy', null, 'inactive')).toBeNull();
    });

    it('warehouse_id is still nullable — no global NOT NULL was introduced', async () => {
      const r = await asAdmin(`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='distribution_points' AND column_name='warehouse_id'`);
      expect(r.rows[0].is_nullable).toBe('YES');
    });
  });

  // ── 8-10. THE ACCEPTED R1.1 BEHAVIOUR IS UNCHANGED ────────────────────────
  describe('8-10 · previously-proved outcomes are preserved', () => {
    it('8 · a valid centre pharmacy still succeeds', async () => {
      expect(await insertOutlet(SECTOR, DEPOT, 'pharmacy')).toBeNull();
    });

    it('9 · a valid centre emergency crash cabinet still succeeds', async () => {
      expect(await insertOutlet(SECTOR, DEPOT, 'crash_cabinet', 'emergency')).toBeNull();
    });

    it('10 · sector-main outlets remain rejected, in every type', async () => {
      expect(await insertOutlet(SECTOR, MAIN, 'pharmacy')).toMatch(DEPOT_CONTRACT);
      expect(await insertOutlet(SECTOR, MAIN, 'crash_cabinet', 'emergency')).toMatch(DEPOT_CONTRACT);
      expect(await insertOutlet(SECTOR, MAIN, 'rescue_cart', 'emergency')).toMatch(DEPOT_CONTRACT);
    });

    it('a centre rescue cart and a context-less cabinet remain rejected', async () => {
      expect(await insertOutlet(SECTOR, DEPOT, 'rescue_cart', 'emergency'))
        .toMatch(/health_center_rescue_cart_not_permitted/);
      expect(await insertOutlet(SECTOR, DEPOT, 'crash_cabinet'))
        .toMatch(/health_center_crash_cabinet_requires_emergency_context/);
    });
  });

  // ── LOCK ORDER ────────────────────────────────────────────────────────────
  // The non-null path takes warehouse FOR SHARE and THEN the organization
  // fence. The unassigned branch has no warehouse row, so it takes the
  // organization fence ALONE. These two tests prove exactly that split, which
  // is what makes a warehouse<->organization inversion impossible: the branch
  // that could invert the order never acquires the first lock at all.
  describe('lock order · the unassigned branch takes the organization fence and NO warehouse lock', () => {
    async function blockedBy(hold: { sql: string; params: any[] }, insertOrg: string): Promise<boolean> {
      const holder = await rig.pool.connect();
      const writer = await rig.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(hold.sql, hold.params);
        await writer.query('BEGIN');
        await writer.query(`SET LOCAL statement_timeout='750ms'`);
        try {
          await writer.query(
            `INSERT INTO distribution_points (warehouse_id,organization_id,name,name_ar,point_type,status)
             VALUES (NULL,$1,'Probe','فحص','pharmacy','active')`, [insertOrg]);
          return false;
        } catch (e: any) {
          const message = String(e?.message ?? e);
          if (/statement timeout|canceling statement/i.test(message)) return true;
          // A business refusal is not a lock wait.
          return false;
        }
      } finally {
        await writer.query('ROLLBACK').catch(() => {});
        await holder.query('ROLLBACK').catch(() => {});
        writer.release();
        holder.release();
      }
    }

    it('waits on the owning organization row, exactly as activation requires', async () => {
      expect(await blockedBy(
        { sql: `SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE`, params: [HOSP] }, HOSP)).toBe(true);
    });

    it('does NOT wait on any warehouse row', async () => {
      expect(await blockedBy(
        { sql: `SELECT 1 FROM warehouses WHERE organization_id=$1 FOR UPDATE`, params: [HOSP] }, HOSP)).toBe(false);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — THE MIGRATION CONTRACT, on a 001->180 chain
// ════════════════════════════════════════════════════════════════════════════
run('181 · the migration refuses to certify an unassigned active outlet (001->180 rig)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => { rig = await buildRig({ upTo: 180 }); }, 240000);
  afterAll(async () => { if (rig) await rig.end(); });

  /** A canonical, otherwise TARGET_READY health sector, plus whatever `extra`
   *  adds. Returns the seed SQL and the identifiers it used. */
  function seed(extra: (ids: Record<string, string>) => string) {
    const ids = { org: randomUUID(), facility: randomUUID(), main: randomUUID(), depot: randomUUID(), point: randomUUID() };
    return {
      ids,
      sql: `
        INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status)
        VALUES ('${ids.org}','Sector','قطاع','nw180-${ids.org.slice(0, 8)}','care_institution','health_sector','active');
        INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,status)
        VALUES ('${ids.facility}','${ids.org}','primary_health_center','Centre','مركز','active');
        INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
          ('${ids.main}','${ids.org}','Sector Main','رئيسي','institution',NULL,true,'active'),
          ('${ids.depot}','${ids.org}','Centre Depot','مذخر','institution','${ids.facility}',false,'active');
        ${extra(ids)}`,
    };
  }

  const unassignedOutlet = (ids: Record<string, string>, status = 'active', type = 'pharmacy') => `
    INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
    VALUES ('${ids.point}',NULL,'${ids.org}','Ghost','شبح','${type}','${status}');`;

  /** Seeds, then runs 181 in a rolled-back transaction. */
  async function apply181(seedSql: string): Promise<string | null> {
    const client = await rig.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(seedSql);
      await client.query(MIGRATION_181);
      await client.query('ROLLBACK');
      return null;
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => {});
      return String(e?.message ?? e);
    } finally {
      client.release();
    }
  }

  /** Seeds, then runs the exact committed operator artifact, read-only. */
  async function classify(seedSql: string): Promise<any> {
    const client = await rig.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(seedSql);
      const result = await client.query(PREAPPLY);
      await client.query('ROLLBACK');
      return result.rows[0];
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  it('an otherwise-canonical sector with an ACTIVE unassigned outlet is an AMBIGUOUS_STOP', async () => {
    const { sql } = seed(ids => unassignedOutlet(ids));
    const error = await apply181(sql);
    expect(error ?? '').toMatch(/181_ambiguous_stop/);
    expect(error ?? '').toMatch(/active sector-level outlet/);
  });

  it('the operator gate reaches the SAME verdict on the SAME fixture', async () => {
    // Blocker 1 was migration/artifact divergence. The classifier and the gate
    // must never disagree again: an outlet hanging off no warehouse is
    // sector-level evidence to both.
    const { sql } = seed(ids => unassignedOutlet(ids));
    const row = await classify(sql);
    expect(row.classification).toBe('AMBIGUOUS_STOP');
    expect(Number(row.sector_level_outlets)).toBe(1);
    expect(Number(row.operational_rows)).toBe(0);
  });

  it('every unassigned point type stops the migration, not just the pharmacy', async () => {
    for (const type of ['pharmacy', 'crash_cabinet', 'rescue_cart']) {
      const { sql } = seed(ids => unassignedOutlet(ids, 'active', type));
      expect(await apply181(sql), type).toMatch(/181_ambiguous_stop/);
    }
  });

  it('a DORMANT unassigned outlet is history and does NOT stop the migration', async () => {
    const { sql } = seed(ids => unassignedOutlet(ids, 'inactive'));
    expect(await apply181(sql)).toBeNull();
    expect((await classify(sql)).classification).toBe('TARGET_READY');
  });

  it('the same sector with no unassigned outlet still applies and still classifies TARGET_READY', async () => {
    const { sql } = seed(() => '');
    expect(await apply181(sql)).toBeNull();
    expect((await classify(sql)).classification).toBe('TARGET_READY');
  });
});
