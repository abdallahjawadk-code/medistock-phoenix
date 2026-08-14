/**
 * 181 · HEALTH-SECTOR TOPOLOGY RECONCILIATION + HARDENING (R1.1) — dynamic proof.
 *
 * Two rigs, because R1.1 has two distinct obligations:
 *
 *   1. a MIGRATION contract — given the legacy shape that exists in the field,
 *      Migration 181 must correct it, and given any shape whose meaning cannot
 *      be proven it must refuse. Proved on a chain frozen at 001->180, with the
 *      migration body applied inside the test's own transaction so many
 *      classifications can be exercised against one rig;
 *
 *   2. a RUNTIME contract — once applied, the database is the topology
 *      authority for every writer. Proved on the full 001->181 chain.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildRig, rigAvailable, MIGRATIONS_DIR } from '../../../tools/pg-rig/rig.mjs';

// PRE-EXISTING INFRASTRUCTURE FIX (surfaced by the R1.2C run, not caused by it).
// This suite REPLAYS THE MIGRATION CHAIN inside a beforeAll. vitest applies a
// separate 10s budget to HOOKS that testTimeout does not cover, so as the chain
// has grown the hook has crept toward that ceiling; past it, the hook is killed
// mid-replay and surfaces as ECONNRESET rather than as any assertion. An explicit
// hook budget removes that false signal. No assertion is changed or relaxed.
vi.setConfig({ testTimeout: 180000, hookTimeout: 240000 });

const run = rigAvailable() ? describe : describe.skip;

/**
 * Migration 181's body with its own transaction control removed, so a test can
 * run it inside its OWN transaction and roll back. Semantically identical — the
 * migration is a single transaction either way — and it is what makes the
 * AMBIGUOUS_STOP matrix affordable on one rig.
 */
const MIGRATION_181 = readFileSync(
  join(MIGRATIONS_DIR, '181_phoenix_health_sector_topology_reconciliation.sql'), 'utf8',
).replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');

const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e: any) { return String(e?.message ?? e); }
  throw new Error('expected a rejection but the call succeeded');
};

let seq = 0;
const uid = () => `00000000-0000-0000-0000-${String(700000000000 + (seq += 1))}`;

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — THE MIGRATION CONTRACT, on a 001->180 chain
// ════════════════════════════════════════════════════════════════════════════
run('181 · reconciliation contract (001->180 rig)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => { rig = await buildRig({ upTo: 180 }); }, 240000);
  afterAll(async () => { if (rig) await rig.end(); });

  /** Seeds one health sector, runs 181 in a rolled-back transaction, reports. */
  async function apply181(seed: string): Promise<{ ok: boolean; error?: string; rows?: any[] }> {
    const client = await rig.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(seed);
      await client.query(MIGRATION_181);
      const rows = (await client.query(`
        SELECT o.name AS org, w.name, w.facility_id, w.is_main, w.warehouse_kind, w.status, w.id
          FROM public.warehouses w
          JOIN public.organizations o ON o.id = w.organization_id
         WHERE o.institution_class='health_sector'
         ORDER BY w.is_main DESC, w.name`)).rows;
      await client.query('ROLLBACK');
      return { ok: true, rows };
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => {});
      return { ok: false, error: String(e?.message ?? e) };
    } finally {
      client.release();
    }
  }

  const ORG = uid(), FAC_A = uid(), FAC_B = uid(), DEP_A = uid(), DEP_B = uid(), DP = uid(), MAIN = uid();

  const sector = (extra = '') => `
    INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status)
      VALUES ('${ORG}','S181','ق','c181','care_institution','health_sector','active');
    INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,status) VALUES
      ('${FAC_A}','${ORG}','primary_health_center','A','أ','active'),
      ('${FAC_B}','${ORG}','subordinate_health_center','B','ب','active');
    ${extra}`;

  // ── A. SAFE LEGACY RECONCILIATION ─────────────────────────────────────────
  describe('A · legacy: the centre depot carries the organization main flag', () => {
    let out: Awaited<ReturnType<typeof apply181>>;

    beforeAll(async () => {
      out = await apply181(sector(`
        INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
          VALUES ('${DEP_A}','${ORG}','Centre Depot A','مذخر','institution','${FAC_A}',true,'active');
        INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
          VALUES ('${DP}','${DEP_A}','${ORG}','Centre Pharmacy','صيدلية','pharmacy','active');`));
    });

    it('the migration succeeds', () => {
      expect(out.error ?? null).toBeNull();
      expect(out.ok).toBe(true);
    });

    it('the SAME centre depot survives, same facility, demoted', () => {
      const depot = out.rows!.find(r => r.id === DEP_A);
      expect(depot).toBeTruthy();
      expect(depot.facility_id).toBe(FAC_A);
      expect(depot.is_main).toBe(false);
      expect(depot.warehouse_kind).toBe('institution');
      expect(depot.status).toBe('active');
    });

    it('exactly one NEW sector main is created', () => {
      const mains = out.rows!.filter(r => r.is_main);
      expect(mains).toHaveLength(1);
      expect(mains[0].facility_id).toBeNull();
      expect(mains[0].warehouse_kind).toBe('institution');
      expect(mains[0].id).not.toBe(DEP_A);
    });

    it('no outlet is reassigned and no stock row is created', async () => {
      // Re-run inside one transaction so the post-state can be read before the
      // rollback, this time asserting on the outlet and the ledgers.
      const client = await rig.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sector(`
          INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
            VALUES ('${DEP_A}','${ORG}','Centre Depot A','مذخر','institution','${FAC_A}',true,'active');
          INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
            VALUES ('${DP}','${DEP_A}','${ORG}','Centre Pharmacy','صيدلية','pharmacy','active');`));
        await client.query(MIGRATION_181);
        const dp = (await client.query('SELECT warehouse_id FROM distribution_points WHERE id=$1', [DP])).rows[0];
        expect(dp.warehouse_id).toBe(DEP_A);
        const ws = (await client.query('SELECT count(*)::int n FROM warehouse_stock')).rows[0].n;
        const os = (await client.query('SELECT count(*)::int n FROM outlet_stock')).rows[0].n;
        expect(ws).toBe(0);
        expect(os).toBe(0);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });
  });

  // ── B. ALREADY CORRECT ────────────────────────────────────────────────────
  it('B · an already-canonical sector is left untouched, with no duplicate main', async () => {
    const out = await apply181(sector(`
      INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
        ('${MAIN}','${ORG}','Sector Main','رئيسي','institution',NULL,true,'active'),
        ('${DEP_A}','${ORG}','Depot A','أ','institution','${FAC_A}',false,'active');`));
    expect(out.error ?? null).toBeNull();
    expect(out.rows).toHaveLength(2);
    expect(out.rows!.filter(r => r.is_main).map(r => r.id)).toEqual([MAIN]);
    expect(out.rows!.find(r => r.id === DEP_A).is_main).toBe(false);
  });

  // ── C. MULTI-CENTRE ───────────────────────────────────────────────────────
  it('C · a multi-centre sector reconciles to one main and one depot per centre', async () => {
    const out = await apply181(sector(`
      INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
        ('${DEP_A}','${ORG}','Depot A','أ','institution','${FAC_A}',true,'active'),
        ('${DEP_B}','${ORG}','Depot B','ب','institution','${FAC_B}',false,'active');`));
    expect(out.error ?? null).toBeNull();
    const mains = out.rows!.filter(r => r.is_main);
    expect(mains).toHaveLength(1);
    expect(mains[0].facility_id).toBeNull();
    const depots = out.rows!.filter(r => !r.is_main);
    expect(depots).toHaveLength(2);
    expect(depots.every(d => d.warehouse_kind === 'institution' && d.facility_id !== null)).toBe(true);
    expect(new Set(depots.map(d => d.facility_id))).toEqual(new Set([FAC_A, FAC_B]));
  });

  // ── AMBIGUOUS_STOP matrix ─────────────────────────────────────────────────
  describe('AMBIGUOUS_STOP · the migration refuses rather than guessing', () => {
    const cases: [string, string, RegExp][] = [
      ['a central warehouse inside the health sector',
       `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
          ('${DEP_A}','${ORG}','C','ج','central',NULL,true,'active');`,
       /active central warehouse/],
      ['two sector-level warehouses',
       `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
          ('${MAIN}','${ORG}','M1','م١','institution',NULL,true,'active'),
          ('${DEP_A}','${ORG}','M2','م٢','institution',NULL,false,'active');`,
       /active sector-level warehouses/],
      ['a depot on an INACTIVE facility',
       `UPDATE organization_facilities SET status='inactive' WHERE id='${FAC_A}';
        INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
          ('${DEP_A}','${ORG}','D','د','institution','${FAC_A}',true,'active');`,
       /invalid or inactive facility/],
      ['an active sector-level OUTLET',
       `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
          ('${MAIN}','${ORG}','M','م','institution',NULL,true,'active');
        INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
          VALUES ('${DP}','${MAIN}','${ORG}','P','ص','pharmacy','active');`,
       /active sector-level outlet/],
      ['a rescue cart inside the health sector',
       `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
          ('${DEP_A}','${ORG}','D','د','institution','${FAC_A}',true,'active');
        INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
          VALUES ('${DP}','${DEP_A}','${ORG}','RC','ع','rescue_cart','active','emergency');`,
       /active rescue cart/],
      ['a crash cabinet with no emergency context',
       `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
          ('${DEP_A}','${ORG}','D','د','institution','${FAC_A}',true,'active');
        INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
          VALUES ('${DP}','${DEP_A}','${ORG}','CC','خز','crash_cabinet','active');`,
        /without an emergency clinical context/],
      ['operational history on the legacy centre depot',
       `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
          ('${DEP_A}','${ORG}','D','د','institution','${FAC_A}',true,'active');
        INSERT INTO warehouse_stock
          (organization_id,warehouse_id,scientific_name,unit,has_no_national_code,
           has_no_batch_number,internal_batch_reference,on_hand_quantity,reserved_quantity)
        VALUES ('${ORG}','${DEP_A}','History','box',true,true,'R1-1-HISTORY',1,0);`,
       /operational-history row/],
      ['centre depots but NO main anywhere',
       `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
          ('${DEP_A}','${ORG}','D','د','institution','${FAC_A}',false,'active');`,
       /unrecognised topology/],
    ];

    for (const [label, extra, expected] of cases) {
      it(`refuses: ${label}`, async () => {
        const out = await apply181(sector(extra));
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(/181_ambiguous_stop/);
        expect(out.error).toMatch(expected);
      });
    }

    it('a refusal leaves the whole migration unapplied', async () => {
      // The failing case above rolled back; the rig must still be at 180.
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT to_regprocedure('public.phoenix_create_health_center_warehouse(uuid,uuid,text,text,text)') IS NULL AS clean`));
      expect(r.rows[0].clean).toBe(true);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — THE RUNTIME CONTRACT, on the full 001->181 chain
// ════════════════════════════════════════════════════════════════════════════
run('181 · topology invariants (001->181 rig)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const ORG = uid(), HOSP = uid(), FAC_A = uid(), FAC_B = uid(), FAC_OFF = uid();
  const MAIN = uid(), DEP_A = uid(), DEP_B = uid(), HOSP_WH = uid(), CENTRAL = uid();
  const DP_PH = uid(), DP_MOVE = uid();
  const SA = '00000000-0000-0000-0000-0000000000a1';

  const asAdmin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));
  const asSuper = (sql: string, params: any[] = []) =>
    rig.asUser(SA, (c: any) => c.query(sql, params), { commit: true });

  beforeAll(async () => {
    rig = await buildRig({});
    await asAdmin(`
      INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
        ('${ORG}','Sector','ق','r11-s','care_institution','health_sector','active'),
        ('${HOSP}','Hospital','مستشفى','r11-h','care_institution','hospital','active');
      INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,status) VALUES
        ('${FAC_A}','${ORG}','primary_health_center','A','أ','active'),
        ('${FAC_B}','${ORG}','subordinate_health_center','B','ب','active'),
        ('${FAC_OFF}','${ORG}','primary_health_center','Off','م','inactive');
      INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
        ('${MAIN}','${ORG}','Sector Main','رئيسي','institution',NULL,true,'active'),
        ('${DEP_A}','${ORG}','Depot A','أ','institution','${FAC_A}',false,'active'),
        ('${DEP_B}','${ORG}','Depot B','ب','institution','${FAC_B}',false,'active'),
        ('${HOSP_WH}','${HOSP}','Hosp WH','مخزن','institution',NULL,true,'active'),
        ('${CENTRAL}','${HOSP}','Central','مركزي','central',NULL,false,'active');
      INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status) VALUES
        ('${DP_PH}','${DEP_A}','${ORG}','Pharmacy A','صيدلية','pharmacy','active'),
        ('${DP_MOVE}','${DEP_A}','${ORG}','Movable','متنقل','pharmacy','active');`);
  }, 240000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ── D. MAIN INVALIDITY ────────────────────────────────────────────────────
  describe('D · sector-main invalidity', () => {
    it('a main may not carry a facility', async () => {
      expect(await rejects(() => asAdmin(
        `UPDATE warehouses SET facility_id=$1 WHERE id=$2`, [FAC_A, MAIN])))
        .toMatch(/health_center_depot_must_not_be_main|not_authenticated/);
    });
    it('a health-sector warehouse may not be central', async () => {
      expect(await rejects(() => asAdmin(`UPDATE warehouses SET warehouse_kind='central' WHERE id=$1`, [MAIN])))
        .toMatch(/health_sector_warehouse_must_be_institution/);
    });
    it('a second active facility-less warehouse may not be a non-main', async () => {
      expect(await rejects(() => asAdmin(
        `INSERT INTO warehouses (organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
         VALUES ($1,'X','خ','institution',NULL,false,'active')`, [ORG])))
        .toMatch(/health_sector_facility_less_warehouse_must_be_main/);
    });
    it('a second active main is impossible', async () => {
      expect(await rejects(() => asAdmin(
        `INSERT INTO warehouses (organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
         VALUES ($1,'X2','خ٢','institution',NULL,true,'active')`, [ORG])))
        .toMatch(/warehouses_one_active_main_per_org_uniq/);
    });
    it('the sole sector main cannot be deactivated or deleted', async () => {
      expect(await rejects(() => asAdmin(
        `UPDATE warehouses SET is_main=false, status='inactive' WHERE id=$1`, [MAIN])))
        .toMatch(/health_sector_must_retain_a_sector_main/);
      expect(await rejects(() => asAdmin(`DELETE FROM warehouses WHERE id=$1`, [MAIN])))
        .toMatch(/health_sector_must_retain_a_sector_main/);
    });
  });

  // ── E. CENTRE DEPOT INVALIDITY ────────────────────────────────────────────
  describe('E · centre-depot invalidity', () => {
    it('a centre depot may not be promoted to main', async () => {
      expect(await rejects(() => asAdmin(`UPDATE warehouses SET is_main=true WHERE id=$1`, [DEP_A])))
        .toMatch(/health_center_depot_must_not_be_main/);
    });
    it('a depot may not sit on an INACTIVE facility', async () => {
      expect(await rejects(() => asAdmin(
        `INSERT INTO warehouses (organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
         VALUES ($1,'D','د','institution',$2,false,'active')`, [ORG, FAC_OFF])))
        .toMatch(/health_center_facility_not_active/);
    });
    it('a second ACTIVE depot on one facility is impossible', async () => {
      expect(await rejects(() => asAdmin(
        `INSERT INTO warehouses (organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
         VALUES ($1,'D2','د٢','institution',$2,false,'active')`, [ORG, FAC_A])))
        .toMatch(/warehouses_one_active_depot_per_facility_uniq/);
    });
    it('a depot may not reference a facility owned by another organization', async () => {
      // The composite FK already forbids it structurally.
      expect(await rejects(() => asAdmin(
        `INSERT INTO warehouses (organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
         VALUES ($1,'D3','د٣','institution',$2,false,'active')`, [HOSP, FAC_A])))
        .toMatch(/warehouses_facility_org_fk|facility/i);
    });
    it('an active depot cannot be invalidated through its facility row', async () => {
      expect(await rejects(() => asAdmin(
        `UPDATE organization_facilities SET status='inactive' WHERE id=$1`, [FAC_A])))
        .toMatch(/health_center_facility_change_blocked_by_active_depot/);
      expect(await rejects(() => asAdmin(
        `UPDATE organization_facilities SET facility_class='administrative_office' WHERE id=$1`, [FAC_A])))
        .toMatch(/health_center_facility_change_blocked_by_active_depot|of_facility_class_chk/);
    });
  });

  // ── F/G. OUTLET INVALIDITY AND VALIDITY ───────────────────────────────────
  describe('F/G · outlet topology', () => {
    const outlet = (wh: string, type: string, clinical: string | null) => asAdmin(
      `INSERT INTO distribution_points (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
       VALUES ($1,$2,'O','ع',$3,'active',$4)`, [wh, ORG, type, clinical]);

    it('F · no pharmacy on the sector main', async () => {
      expect(await rejects(() => outlet(MAIN, 'pharmacy', null)))
        .toMatch(/health_sector_outlet_requires_health_center_depot/);
    });
    it('F · no crash cabinet on the sector main', async () => {
      expect(await rejects(() => outlet(MAIN, 'crash_cabinet', 'emergency')))
        .toMatch(/health_sector_outlet_requires_health_center_depot/);
    });
    it('F · no rescue cart on the sector main', async () => {
      expect(await rejects(() => outlet(MAIN, 'rescue_cart', 'emergency')))
        .toMatch(/health_sector_outlet_requires_health_center_depot/);
    });
    it('F · no rescue cart on a centre depot either', async () => {
      expect(await rejects(() => outlet(DEP_B, 'rescue_cart', 'emergency')))
        .toMatch(/health_center_rescue_cart_not_permitted/);
    });
    it('F · no crash cabinet without an emergency context', async () => {
      expect(await rejects(() => outlet(DEP_B, 'crash_cabinet', null)))
        .toMatch(/health_center_crash_cabinet_requires_emergency_context/);
      expect(await rejects(() => outlet(DEP_B, 'crash_cabinet', 'non_emergency')))
        .toMatch(/health_center_crash_cabinet_requires_emergency_context/);
    });
    it('F · an active outlet cannot hang off an inactive historical depot', async () => {
      const inactiveDepot = uid();
      await asAdmin(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
         VALUES ($1,$2,'Retired','متقاعد','institution',$3,false,'inactive')`,
        [inactiveDepot, ORG, FAC_B]);
      expect(await rejects(() => outlet(inactiveDepot, 'pharmacy', null)))
        .toMatch(/health_sector_outlet_requires_active_health_center_depot/);
    });
    it('G · a centre pharmacy is legal, with NO clinical context required', async () => {
      const r = await outlet(DEP_B, 'pharmacy', null);
      expect(r.rowCount).toBe(1);
    });
    it('G · a centre crash cabinet with an emergency context is legal', async () => {
      const r = await outlet(DEP_B, 'crash_cabinet', 'emergency');
      expect(r.rowCount).toBe(1);
    });
    it('an existing outlet cannot be retyped into a rescue cart', async () => {
      expect(await rejects(() => asAdmin(
        `UPDATE distribution_points SET point_type='rescue_cart' WHERE id=$1`, [DP_PH])))
        .toMatch(/health_center_rescue_cart_not_permitted/);
    });
    it('an existing outlet cannot be moved onto the sector main', async () => {
      expect(await rejects(() => asAdmin(
        `UPDATE distribution_points SET warehouse_id=$1 WHERE id=$2`, [MAIN, DP_PH])))
        .toMatch(/health_sector_outlet_requires_health_center_depot/);
    });
  });

  // ── H. CROSS-CENTRE MOVE ──────────────────────────────────────────────────
  describe('H · cross-centre reassignment is setup-time only', () => {
    it('a point with NO operational history may move between centres', async () => {
      const r = await asAdmin(`UPDATE distribution_points SET warehouse_id=$1 WHERE id=$2`, [DEP_B, DP_MOVE]);
      expect(r.rowCount).toBe(1);
    });

    it('a point WITH history may not — and the blocker is named', async () => {
      await asAdmin(
        `INSERT INTO outlet_stock (organization_id,distribution_point_id,point_type,scientific_name,unit,
           has_no_national_code,has_no_batch_number,internal_batch_reference,on_hand_quantity,reserved_quantity)
         VALUES ($1,$2,'pharmacy','M','box',true,true,'IBR-181',5,0)`, [ORG, DP_MOVE]);
      const msg = await rejects(() => asAdmin(
        `UPDATE distribution_points SET warehouse_id=$1 WHERE id=$2`, [DEP_A, DP_MOVE]));
      expect(msg).toMatch(/outlet_cross_center_reassignment_blocked_operational_dependency/);
    });

    it('a point_type change is blocked by the same history', async () => {
      expect(await rejects(() => asAdmin(
        `UPDATE distribution_points SET point_type='crash_cabinet', clinical_location_kind='emergency' WHERE id=$1`,
        [DP_MOVE]))).toMatch(/outlet_point_type_change_blocked_operational_dependency/);
    });

    it('a non-semantic edit is still allowed with history present', async () => {
      const r = await asAdmin(`UPDATE distribution_points SET name='Renamed' WHERE id=$1`, [DP_MOVE]);
      expect(r.rowCount).toBe(1);
    });
  });

  // ── I. DIRECT SAME-SECTOR SUPPLY REMAINS ROUTE-FREE ───────────────────────
  describe('I · Branch B same-sector supply', () => {
    it('sector main -> centre depot is legal with NO supply route', async () => {
      const r = await asAdmin(
        `SELECT * FROM public.phoenix_assert_direct_supply_endpoints($1,$2,$3)`, [MAIN, DEP_A, ORG]);
      expect(r.rows[0].o_source_organization_id).toBe(ORG);
      expect(r.rows[0].o_destination_organization_id).toBe(ORG);
      const routes = await asAdmin(
        `SELECT count(*)::int n FROM warehouse_supply_routes r
           JOIN warehouses w ON w.id=r.source_warehouse_id WHERE w.organization_id=$1`, [ORG]);
      expect(routes.rows[0].n).toBe(0);
    });

    it('the reverse direction is NOT a shortcut', async () => {
      expect(await rejects(() => asAdmin(
        `SELECT * FROM public.phoenix_assert_direct_supply_endpoints($1,$2,$3)`, [DEP_A, MAIN, ORG])))
        .toMatch(/source_must_be_active_central_warehouse/);
    });

    it('sector main -> a warehouse in a different organization is refused', async () => {
      expect(await rejects(() => asAdmin(
        `SELECT * FROM public.phoenix_assert_direct_supply_endpoints($1,$2,$3)`, [MAIN, HOSP_WH, HOSP])))
        .toMatch(/source_must_be_active_central_warehouse/);
    });
  });

  // ── J. LEGACY CENTRAL SUPPLY UNCHANGED ────────────────────────────────────
  it('J · legacy central -> institution supply is unchanged', async () => {
    const r = await asAdmin(
      `SELECT * FROM public.phoenix_assert_direct_supply_endpoints($1,$2,$3)`, [CENTRAL, HOSP_WH, HOSP]);
    expect(r.rows[0].o_source_organization_id).toBe(HOSP);
    expect(r.rows[0].o_destination_organization_id).toBe(HOSP);
  });

  // ── K. SECURITY ───────────────────────────────────────────────────────────
  describe('K · authority on the centre-depot writer', () => {
    const SIG = 'public.phoenix_create_health_center_warehouse(uuid,uuid,text,text,text)';

    it('anon cannot execute it', async () => {
      const msg = await rejects(() => rig.asUser(null, (c: any) => c.query(
        `SELECT ${SIG.replace(/\(.*/, '')}($1,$2,'X','خ')`, [ORG, FAC_A]), { role: 'anon' }));
      expect(msg).toMatch(/permission denied for function/i);
    });

    it('an unauthenticated caller is refused', async () => {
      const msg = await rejects(() => rig.asUser(null, (c: any) => c.query(
        `SELECT public.phoenix_create_health_center_warehouse($1,$2,'X','خ')`, [ORG, FAC_A])));
      expect(msg).toMatch(/not_authenticated/);
    });

    it('an authenticated NON-super_admin is refused', async () => {
      const nobody = uid();
      await asAdmin(
        `INSERT INTO auth.users (id,email) VALUES ($1,'r11-nobody@rig.local') ON CONFLICT DO NOTHING`, [nobody]);
      await asAdmin(
        `UPDATE profiles SET role='outlet_officer', status='active', organization_id=$2 WHERE id=$1`, [nobody, ORG]);
      const msg = await rejects(() => rig.asUser(nobody, (c: any) => c.query(
        `SELECT public.phoenix_create_health_center_warehouse($1,$2,'X','خ')`, [ORG, FAC_A])));
      expect(msg).toMatch(/NOT_AUTHORIZED_WAREHOUSE_MANAGE/);
    });

    it('super_admin creates a valid centre depot atomically', async () => {
      const fac = uid();
      await asAdmin(
        `INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,status)
         VALUES ($1,$2,'primary_health_center','C','ج','active')`, [fac, ORG]);
      const r = await asSuper(
        `SELECT public.phoenix_create_health_center_warehouse($1,$2,'Depot C','مذخر ج') AS r`, [ORG, fac]);
      const out = r.rows[0].r;
      expect(out.ok).toBe(true);
      expect(out.is_main).toBe(false);
      expect(out.facility_id).toBe(fac);
      expect(out.warehouse_kind).toBe('institution');

      const row = await asAdmin(`SELECT * FROM warehouses WHERE id=$1`, [out.warehouse_id]);
      expect(row.rows[0].status).toBe('active');
      expect(row.rows[0].is_main).toBe(false);
    });

    it('it refuses a second depot on the same centre', async () => {
      const msg = await rejects(() => asSuper(
        `SELECT public.phoenix_create_health_center_warehouse($1,$2,'Dup','مكرر') AS r`, [ORG, FAC_A]));
      expect(msg).toMatch(/health_center_already_has_an_active_depot/);
    });

    it('it refuses a non-health-sector organization', async () => {
      const msg = await rejects(() => asSuper(
        `SELECT public.phoenix_create_health_center_warehouse($1,$2,'X','خ') AS r`, [HOSP, FAC_A]));
      expect(msg).toMatch(/center_depot_requires_health_sector|facility_organization_mismatch/);
    });
  });

  // ── L. TWO STOCK TRUTHS ───────────────────────────────────────────────────
  it('L · exactly two stock truths remain, and no unit domain exists', async () => {
    const r = await asAdmin(`
      SELECT
        (SELECT count(*)::int FROM pg_class
          WHERE relname IN ('pharmacy_stock','rescue_cart_stock','crash_cabinet_stock','facility_stock','unit_stock')) AS extra_ledgers,
        (SELECT count(*)::int FROM pg_class
          WHERE relname IN ('health_center_units','units','unit_routes','unit_scopes')) AS unit_domain,
        (SELECT count(*)::int FROM pg_class WHERE relname IN ('warehouse_stock','outlet_stock')) AS truths`);
    expect(r.rows[0].extra_ledgers).toBe(0);
    expect(r.rows[0].unit_domain).toBe(0);
    expect(r.rows[0].truths).toBe(2);
  });

  // ── Non-health-sector organizations are untouched ─────────────────────────
  it('an active sector with only inactive warehouse history remains a valid not-yet-set-up topology', async () => {
    const org = uid();
    await asAdmin(
      `INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status)
       VALUES ($1,'Pending sector','قطاع معلق',$2,'care_institution','health_sector','active')`,
      [org, `pending-${org.slice(0, 8)}`]);
    const r = await asAdmin(
      `INSERT INTO warehouses (organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
       VALUES ($1,'Retired history','سجل متقاعد','institution',NULL,false,'inactive') RETURNING id`,
      [org]);
    expect(r.rows[0].id).toBeTruthy();
  });

  describe('other organization classes keep their existing freedom', () => {
    it('a hospital may still own a central warehouse and a facility-less non-main', async () => {
      const r = await asAdmin(
        `INSERT INTO warehouses (organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
         VALUES ($1,'Second','ثاني','institution',NULL,false,'active') RETURNING id`, [HOSP]);
      expect(r.rows[0].id).toBeTruthy();
    });
    it('a hospital may still own a rescue cart', async () => {
      const r = await asAdmin(
        `INSERT INTO distribution_points (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
         VALUES ($1,$2,'Cart','عربة','rescue_cart','active','emergency') RETURNING id`, [HOSP_WH, HOSP]);
      expect(r.rows[0].id).toBeTruthy();
    });
  });
});
