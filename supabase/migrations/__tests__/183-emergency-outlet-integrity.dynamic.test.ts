/**
 * 183 · EMERGENCY OUTLET INTEGRITY (R1.2C) — dynamic proof.
 *
 * Migration 181's outlet guard opened with
 *
 *     IF v_class IS DISTINCT FROM 'health_sector' THEN RETURN NEW;
 *
 * so for a HOSPITAL, a SPECIALIZED CENTRE, or a PHARMACY DEPARTMENT AUTHORITY
 * the distribution_points write boundary enforced nothing. 183 states the whole
 * active-outlet matrix once, in one validator, and this file proves the matrix
 * against a real 001->183 chain — every reachable legal shape, every reachable
 * illegal one, and the three properties that make the boundary trustworthy
 * rather than merely present:
 *
 *   * HISTORY IS NOT REWRITTEN. An inactive legacy row that the matrix would
 *     refuse keeps existing and keeps its values; only the transition INTO an
 *     active state is judged.
 *   * A REFUSAL MOVES NOTHING. Not one warehouse_stock or outlet_stock row, not
 *     one dispatch, not one audit row — proved by measuring deltas, never by
 *     reading an exception string.
 *   * 181 IS UNDISTURBED. Its health-sector errors are byte-identical and its
 *     operational-dependency guards still fire.
 *
 * The 168/183 creation-vs-replenishment agreement is proved separately, in
 * 183-emergency-outlet-matrix-parity.dynamic.test.ts.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 240000 });

const run = rigAvailable() ? describe : describe.skip;

let seq = 0;
const uid = () => `00000000-0000-0000-0000-${String(183000000000 + (seq += 1))}`;

const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e: any) { return String(e?.message ?? e); }
  throw new Error('expected a rejection but the call succeeded');
};

// ── Organizations ───────────────────────────────────────────────────────────
const ORG_HOSP = uid(), ORG_SPEC = uid(), ORG_SECTOR = uid(), ORG_PDA = uid();
// ── Warehouses ──────────────────────────────────────────────────────────────
const WH_HOSP = uid(), WH_HOSP_OFF = uid(), WH_SPEC = uid(), WH_PDA = uid();
const SECTOR_MAIN = uid(), DEP_A = uid(), DEP_B = uid();
// ── Facilities ──────────────────────────────────────────────────────────────
const FAC_A = uid(), FAC_B = uid();

run('183 · active-outlet topology matrix (001->183 rig)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const asAdmin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));

  /** INSERT one distribution point. Every argument is explicit — no defaults. */
  const insertOutlet = (o: {
    id?: string; warehouse: string | null; org: string; type: string;
    clinical: string | null; status?: string;
  }) => asAdmin(
    `INSERT INTO distribution_points
       (id, warehouse_id, organization_id, name, name_ar, point_type, status, clinical_location_kind)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, 'O183', 'ع', $4, $5, $6)
     RETURNING id`,
    [o.id ?? null, o.warehouse, o.org, o.type, o.status ?? 'active', o.clinical],
  );

  beforeAll(async () => {
    rig = await buildRig({});
    await asAdmin(`
      INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
        ('${ORG_HOSP}',  'H183','مستشفى','r12c-h','care_institution','hospital','active'),
        ('${ORG_SPEC}',  'S183','تخصصي','r12c-s','care_institution','specialized_center','active'),
        ('${ORG_SECTOR}','Q183','قطاع',  'r12c-q','care_institution','health_sector','active'),
        ('${ORG_PDA}',   'P183','دائرة', 'r12c-p','pharmacy_department_authority',NULL,'active');

      INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,status) VALUES
        ('${FAC_A}','${ORG_SECTOR}','primary_health_center','A','أ','active'),
        ('${FAC_B}','${ORG_SECTOR}','subordinate_health_center','B','ب','active');

      INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
        ('${WH_HOSP}',    '${ORG_HOSP}',  'HWH','مخزن','institution',NULL,true, 'active'),
        ('${WH_HOSP_OFF}','${ORG_HOSP}',  'HOF','متقاعد','institution',NULL,false,'inactive'),
        ('${WH_SPEC}',    '${ORG_SPEC}',  'SWH','مخزن ت','institution',NULL,true, 'active'),
        ('${WH_PDA}',     '${ORG_PDA}',   'PWH','مخزن مركزي','central',NULL,true, 'active'),
        ('${SECTOR_MAIN}','${ORG_SECTOR}','Sector Main','رئيسي','institution',NULL,true,'active'),
        ('${DEP_A}',      '${ORG_SECTOR}','Depot A','مذخر أ','institution','${FAC_A}',false,'active'),
        ('${DEP_B}',      '${ORG_SECTOR}','Depot B','مذخر ب','institution','${FAC_B}',false,'active');`);
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ══════════════════════════════════════════════════════════════════════════
  // POSITIVE — every shape the matrix declares operable must be creatable.
  // ══════════════════════════════════════════════════════════════════════════
  describe('POSITIVE · the legal shapes', () => {
    const legal: [string, { warehouse: string | null; org: string; type: string; clinical: string | null }][] = [
      ['hospital · pharmacy',
       { warehouse: WH_HOSP, org: ORG_HOSP, type: 'pharmacy', clinical: null }],
      ['hospital · crash cabinet + non_emergency',
       { warehouse: WH_HOSP, org: ORG_HOSP, type: 'crash_cabinet', clinical: 'non_emergency' }],
      ['hospital · rescue cart + emergency',
       { warehouse: WH_HOSP, org: ORG_HOSP, type: 'rescue_cart', clinical: 'emergency' }],
      ['specialized centre · pharmacy',
       { warehouse: WH_SPEC, org: ORG_SPEC, type: 'pharmacy', clinical: null }],
      ['specialized centre · crash cabinet + non_emergency',
       { warehouse: WH_SPEC, org: ORG_SPEC, type: 'crash_cabinet', clinical: 'non_emergency' }],
      ['health centre · pharmacy on a legal centre depot',
       { warehouse: DEP_A, org: ORG_SECTOR, type: 'pharmacy', clinical: null }],
      ['health centre · crash cabinet + emergency on a legal centre depot',
       { warehouse: DEP_A, org: ORG_SECTOR, type: 'crash_cabinet', clinical: 'emergency' }],
    ];

    for (const [label, shape] of legal) {
      it(`admits: ${label}`, async () => {
        const r = await insertOutlet(shape);
        expect(r.rows[0].id).toBeTruthy();
      });
    }

    it('a hospital PHARMACY keeps 021s nullable-warehouse freedom', async () => {
      // 183 narrows warehouse_id for the two EMERGENCY types only. A pharmacy
      // that names no warehouse is still a legal, if unpaired, row.
      const r = await insertOutlet({ warehouse: null, org: ORG_HOSP, type: 'pharmacy', clinical: null });
      expect(r.rows[0].id).toBeTruthy();
    });

    it('an ER pharmacy (pharmacy + emergency context) is still legal', async () => {
      // The matrix keys on point_type: a pharmacy carries no context rule, and
      // the ER pharmacy is the SOURCE of rescue-cart replenishment.
      const r = await insertOutlet({ warehouse: WH_HOSP, org: ORG_HOSP, type: 'pharmacy', clinical: 'emergency' });
      expect(r.rows[0].id).toBeTruthy();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // NEGATIVE — every shape the rest of the system can never serve.
  // ══════════════════════════════════════════════════════════════════════════
  describe('NEGATIVE · the refused shapes', () => {
    const illegal: [string, { warehouse: string | null; org: string; type: string; clinical: string | null }, RegExp][] = [
      ['hospital · crash cabinet + emergency',
       { warehouse: WH_HOSP, org: ORG_HOSP, type: 'crash_cabinet', clinical: 'emergency' },
       /crash_cabinet_requires_non_emergency_context/],
      ['hospital · crash cabinet with NO context at all',
       { warehouse: WH_HOSP, org: ORG_HOSP, type: 'crash_cabinet', clinical: null },
       /crash_cabinet_requires_non_emergency_context/],
      ['hospital · rescue cart + non_emergency',
       { warehouse: WH_HOSP, org: ORG_HOSP, type: 'rescue_cart', clinical: 'non_emergency' },
       /rescue_cart_requires_emergency_context/],
      ['hospital · rescue cart with NO context at all',
       { warehouse: WH_HOSP, org: ORG_HOSP, type: 'rescue_cart', clinical: null },
       /rescue_cart_requires_emergency_context/],
      ['specialized centre · rescue cart + emergency',
       { warehouse: WH_SPEC, org: ORG_SPEC, type: 'rescue_cart', clinical: 'emergency' },
       /specialized_center_rescue_cart_not_permitted/],
      ['specialized centre · crash cabinet + emergency',
       { warehouse: WH_SPEC, org: ORG_SPEC, type: 'crash_cabinet', clinical: 'emergency' },
       /crash_cabinet_requires_non_emergency_context/],
      ['health centre · rescue cart',
       { warehouse: DEP_B, org: ORG_SECTOR, type: 'rescue_cart', clinical: 'emergency' },
       /health_center_rescue_cart_not_permitted/],
      ['health centre · crash cabinet + non_emergency',
       { warehouse: DEP_B, org: ORG_SECTOR, type: 'crash_cabinet', clinical: 'non_emergency' },
       /health_center_crash_cabinet_requires_emergency_context/],
      ['health sector · any outlet on the SECTOR MAIN',
       { warehouse: SECTOR_MAIN, org: ORG_SECTOR, type: 'pharmacy', clinical: null },
       /health_sector_outlet_requires_health_center_depot/],
      ['health sector · NULL warehouse, active emergency outlet',
       { warehouse: null, org: ORG_SECTOR, type: 'crash_cabinet', clinical: 'emergency' },
       /health_sector_outlet_requires_health_center_depot/],
      ['pharmacy department authority · on its central warehouse',
       { warehouse: WH_PDA, org: ORG_PDA, type: 'pharmacy', clinical: null },
       /pharmacy_department_authority_outlet_not_permitted/],
      ['pharmacy department authority · NULL warehouse (171s blind spot)',
       { warehouse: null, org: ORG_PDA, type: 'crash_cabinet', clinical: 'non_emergency' },
       /pharmacy_department_authority_outlet_not_permitted/],
      ['hospital · an emergency outlet naming NO warehouse',
       { warehouse: null, org: ORG_HOSP, type: 'crash_cabinet', clinical: 'non_emergency' },
       /emergency_outlet_requires_owning_warehouse/],
      ['hospital · an emergency outlet on an INACTIVE warehouse',
       { warehouse: WH_HOSP_OFF, org: ORG_HOSP, type: 'rescue_cart', clinical: 'emergency' },
       /emergency_outlet_requires_active_warehouse/],
    ];

    for (const [label, shape, expected] of illegal) {
      it(`refuses: ${label}`, async () => {
        expect(await rejects(() => insertOutlet(shape))).toMatch(expected);
      });
    }

    it('the owning organization is the WAREHOUSE s, not the one the caller names', async () => {
      // Setting organization_id to a friendlier class must not reach a
      // friendlier branch: the warehouse's organization decides.
      expect(await rejects(() => insertOutlet(
        { warehouse: DEP_B, org: ORG_HOSP, type: 'rescue_cart', clinical: 'emergency' })))
        .toMatch(/health_center_rescue_cart_not_permitted/);
      expect(await rejects(() => insertOutlet(
        { warehouse: WH_PDA, org: ORG_HOSP, type: 'pharmacy', clinical: null })))
        .toMatch(/pharmacy_department_authority_outlet_not_permitted/);
    });

    it('a warehouse that does not exist is refused, never assumed benign', async () => {
      expect(await rejects(() => insertOutlet(
        { warehouse: uid(), org: ORG_HOSP, type: 'pharmacy', clinical: null })))
        .toMatch(/outlet_warehouse_not_found|violates foreign key/i);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // FAIL CLOSED — a class added later, without revisiting this matrix.
  // ══════════════════════════════════════════════════════════════════════════
  it('D · an owner class the matrix does not recognise FAILS CLOSED', async () => {
    // 171's CHECK makes a fourth institution_class unreachable TODAY, which is
    // exactly why branch D cannot be proved without simulating the future that
    // branch exists for. Done inside one ROLLED-BACK transaction on the
    // disposable rig: the constraints are restored by the rollback, and the
    // rig's own schema is left byte-identical.
    const client = await rig.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        ALTER TABLE public.organizations DROP CONSTRAINT organizations_institution_class_chk;
        ALTER TABLE public.organizations DROP CONSTRAINT organizations_kind_institution_class_chk;`);
      const org = uid(), wh = uid();
      await client.query(
        `INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status)
         VALUES ($1,'Future','مستقبلي','r12c-f','care_institution','ambulatory_surgery_center','active')`,
        [org]);
      await client.query(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status)
         VALUES ($1,$2,'FWH','مخزن','institution',NULL,true,'active')`,
        [wh, org]);

      let message = '';
      try {
        await client.query(
          `INSERT INTO distribution_points
             (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
           VALUES ($1,$2,'F','ف','pharmacy','active',NULL)`, [wh, org]);
      } catch (e: any) { message = String(e?.message ?? e); }

      expect(message).toMatch(/outlet_owner_institution_class_unsupported/);
      expect(message).toContain('ambulatory_surgery_center');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }

    // The rollback restored both constraints — the rig is unchanged.
    const r = await asAdmin(
      `SELECT count(*)::int n FROM pg_constraint
        WHERE conname IN ('organizations_institution_class_chk','organizations_kind_institution_class_chk')`);
    expect(r.rows[0].n).toBe(2);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // HISTORY — an inactive legacy row is kept, and can never be reactivated.
  // ══════════════════════════════════════════════════════════════════════════
  describe('HISTORY · inactive rows are preserved, never repaired and never reactivated', () => {
    const LEGACY = uid();

    it('an ILLEGAL shape may be stored while INACTIVE', async () => {
      const r = await insertOutlet({
        id: LEGACY, warehouse: WH_HOSP, org: ORG_HOSP,
        type: 'rescue_cart', clinical: 'non_emergency', status: 'inactive',
      });
      expect(r.rows[0].id).toBe(LEGACY);
    });

    it('183 does NOT rewrite it — the stored values are exactly as written', async () => {
      const r = await asAdmin(
        `SELECT point_type, clinical_location_kind, warehouse_id, status
           FROM distribution_points WHERE id=$1`, [LEGACY]);
      expect(r.rows[0]).toEqual({
        point_type: 'rescue_cart',
        clinical_location_kind: 'non_emergency',
        warehouse_id: WH_HOSP,
        status: 'inactive',
      });
    });

    it('it can be renamed and otherwise administered while it stays inactive', async () => {
      const r = await asAdmin(`UPDATE distribution_points SET name='Legacy renamed' WHERE id=$1`, [LEGACY]);
      expect(r.rowCount).toBe(1);
    });

    it('but it can NEVER be activated', async () => {
      expect(await rejects(() => asAdmin(
        `UPDATE distribution_points SET status='active' WHERE id=$1`, [LEGACY])))
        .toMatch(/rescue_cart_requires_emergency_context/);
    });

    it('and the refused activation left it inactive, unchanged', async () => {
      const r = await asAdmin(
        `SELECT status, point_type, clinical_location_kind FROM distribution_points WHERE id=$1`, [LEGACY]);
      expect(r.rows[0].status).toBe('inactive');
      expect(r.rows[0].point_type).toBe('rescue_cart');
      expect(r.rows[0].clinical_location_kind).toBe('non_emergency');
    });

    it('activating it TOGETHER WITH a legal correction is accepted', async () => {
      // The boundary is not a trap: the operator's route out is to fix the
      // shape, which is judged in the same statement.
      const r = await asAdmin(
        `UPDATE distribution_points SET status='active', clinical_location_kind='emergency' WHERE id=$1`,
        [LEGACY]);
      expect(r.rowCount).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // MUTATION — a legal ACTIVE row cannot be moved into an illegal shape.
  // ══════════════════════════════════════════════════════════════════════════
  describe('MUTATION · an active row cannot be retyped, recontextualised or rehomed illegally', () => {
    const CAB = uid(), CART = uid(), SECTOR_PH = uid();

    beforeAll(async () => {
      await insertOutlet({ id: CAB,  warehouse: WH_HOSP, org: ORG_HOSP, type: 'crash_cabinet', clinical: 'non_emergency' });
      await insertOutlet({ id: CART, warehouse: WH_HOSP, org: ORG_HOSP, type: 'rescue_cart',   clinical: 'emergency' });
      await insertOutlet({ id: SECTOR_PH, warehouse: DEP_A, org: ORG_SECTOR, type: 'pharmacy', clinical: null });
    });

    it('point_type · a legal crash cabinet cannot become a rescue cart', async () => {
      expect(await rejects(() => asAdmin(
        `UPDATE distribution_points SET point_type='rescue_cart' WHERE id=$1`, [CAB])))
        .toMatch(/rescue_cart_requires_emergency_context/);
    });

    it('clinical context · a legal rescue cart cannot lose its emergency context', async () => {
      expect(await rejects(() => asAdmin(
        `UPDATE distribution_points SET clinical_location_kind='non_emergency' WHERE id=$1`, [CART])))
        .toMatch(/rescue_cart_requires_emergency_context/);
      expect(await rejects(() => asAdmin(
        `UPDATE distribution_points SET clinical_location_kind=NULL WHERE id=$1`, [CART])))
        .toMatch(/rescue_cart_requires_emergency_context/);
    });

    it('warehouse · an emergency outlet cannot be orphaned onto a NULL warehouse', async () => {
      expect(await rejects(() => asAdmin(
        `UPDATE distribution_points SET warehouse_id=NULL WHERE id=$1`, [CAB])))
        .toMatch(/emergency_outlet_requires_owning_warehouse/);
    });

    it('warehouse · an emergency outlet cannot be rehomed onto an inactive warehouse', async () => {
      expect(await rejects(() => asAdmin(
        `UPDATE distribution_points SET warehouse_id=$1 WHERE id=$2`, [WH_HOSP_OFF, CAB])))
        .toMatch(/emergency_outlet_requires_active_warehouse/);
    });

    it('organization · a sector outlet cannot be rehomed onto the sector main', async () => {
      expect(await rejects(() => asAdmin(
        `UPDATE distribution_points SET warehouse_id=$1 WHERE id=$2`, [SECTOR_MAIN, SECTOR_PH])))
        .toMatch(/health_sector_outlet_requires_health_center_depot/);
    });

    it('organization · reassigning organization_id alone cannot launder the owner', async () => {
      // organization_id is in the trigger's column list, so this re-runs the
      // matrix — and the warehouse still decides the owner.
      expect(await rejects(() => asAdmin(
        `UPDATE distribution_points SET organization_id=$1, warehouse_id=$2 WHERE id=$3`,
        [ORG_HOSP, WH_PDA, CAB])))
        .toMatch(/pharmacy_department_authority_outlet_not_permitted/);
    });

    it('ORDINARY safe updates remain possible on a legal active row', async () => {
      const r = await asAdmin(`UPDATE distribution_points SET name='Renamed 183', name_ar='مسمى' WHERE id=$1`, [CAB]);
      expect(r.rowCount).toBe(1);
      const after = await asAdmin(
        `SELECT status, point_type, clinical_location_kind FROM distribution_points WHERE id=$1`, [CAB]);
      expect(after.rows[0]).toEqual({
        status: 'active', point_type: 'crash_cabinet', clinical_location_kind: 'non_emergency',
      });
    });

    it('deactivating a legal active row is always allowed — history is a valid exit', async () => {
      const r = await asAdmin(`UPDATE distribution_points SET status='inactive' WHERE id=$1`, [CART]);
      expect(r.rowCount).toBe(1);
      await asAdmin(`UPDATE distribution_points SET status='active' WHERE id=$1`, [CART]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // NO STOCK EFFECT — validation is a boundary, never a movement.
  // ══════════════════════════════════════════════════════════════════════════
  it('a refused write moves NO stock on either ledger', async () => {
    const PH = uid();
    await insertOutlet({ id: PH, warehouse: WH_HOSP, org: ORG_HOSP, type: 'pharmacy', clinical: null });
    await asAdmin(
      `INSERT INTO outlet_stock (organization_id,distribution_point_id,point_type,scientific_name,unit,
         has_no_national_code,has_no_batch_number,internal_batch_reference,on_hand_quantity,reserved_quantity)
       VALUES ($1,$2,'pharmacy','M183','box',true,true,'IBR-183',7,0)`, [ORG_HOSP, PH]);
    await asAdmin(
      `INSERT INTO warehouse_stock (organization_id,warehouse_id,scientific_name,unit,
         has_no_national_code,has_no_batch_number,internal_batch_reference,on_hand_quantity,reserved_quantity)
       VALUES ($1,$2,'M183','box',true,true,'WBR-183',11,0)`, [ORG_HOSP, WH_HOSP]);

    const snapshot = () => asAdmin(`
      SELECT (SELECT COALESCE(SUM(on_hand_quantity),0)::int FROM outlet_stock)    AS outlet,
             (SELECT COALESCE(SUM(on_hand_quantity),0)::int FROM warehouse_stock) AS warehouse,
             (SELECT count(*)::int FROM outlet_stock_movements)                   AS movements`
    ).then((r: any) => r.rows[0]);

    const before = await snapshot();

    for (const shape of [
      { warehouse: WH_HOSP, org: ORG_HOSP,   type: 'rescue_cart',   clinical: 'non_emergency' },
      { warehouse: WH_SPEC, org: ORG_SPEC,   type: 'rescue_cart',   clinical: 'emergency' },
      { warehouse: DEP_B,   org: ORG_SECTOR, type: 'rescue_cart',   clinical: 'emergency' },
      { warehouse: WH_PDA,  org: ORG_PDA,    type: 'crash_cabinet', clinical: 'non_emergency' },
      { warehouse: null,    org: ORG_PDA,    type: 'pharmacy',      clinical: null },
    ]) await rejects(() => insertOutlet(shape));
    await rejects(() => asAdmin(`UPDATE distribution_points SET point_type='rescue_cart' WHERE id=$1`, [PH]));

    expect(await snapshot()).toEqual(before);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 181 IS UNDISTURBED
  // ══════════════════════════════════════════════════════════════════════════
  describe('181 · the guards R1.1 installed still fire', () => {
    const MOVER = uid();

    it('the cross-centre reassignment guard still blocks a point WITH history', async () => {
      await insertOutlet({ id: MOVER, warehouse: DEP_A, org: ORG_SECTOR, type: 'pharmacy', clinical: null });
      await asAdmin(
        `INSERT INTO outlet_stock (organization_id,distribution_point_id,point_type,scientific_name,unit,
           has_no_national_code,has_no_batch_number,internal_batch_reference,on_hand_quantity,reserved_quantity)
         VALUES ($1,$2,'pharmacy','M183b','box',true,true,'IBR-183B',3,0)`, [ORG_SECTOR, MOVER]);
      expect(await rejects(() => asAdmin(
        `UPDATE distribution_points SET warehouse_id=$1 WHERE id=$2`, [DEP_B, MOVER])))
        .toMatch(/outlet_cross_center_reassignment_blocked_operational_dependency/);
    });

    it('the point_type-change guard still blocks a point WITH history', async () => {
      expect(await rejects(() => asAdmin(
        `UPDATE distribution_points SET point_type='crash_cabinet', clinical_location_kind='emergency' WHERE id=$1`,
        [MOVER]))).toMatch(/outlet_point_type_change_blocked_operational_dependency/);
    });

    it('the centre-depot deactivation guard still blocks under an active outlet', async () => {
      expect(await rejects(() => asAdmin(
        `UPDATE warehouses SET status='inactive' WHERE id=$1`, [DEP_A])))
        .toMatch(/health_center_depot_deactivation_blocked_by_active_outlet/);
    });

    it('the sector main presence guard still holds', async () => {
      expect(await rejects(() => asAdmin(
        `UPDATE warehouses SET is_main=false, status='inactive' WHERE id=$1`, [SECTOR_MAIN])))
        .toMatch(/health_sector_must_retain_a_sector_main/);
    });

    it('exactly ONE topology trigger governs distribution_points', async () => {
      const r = await asAdmin(`
        SELECT t.tgname
          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname='distribution_points' AND NOT t.tgisinternal
           AND pg_get_triggerdef(t.oid) ILIKE '%topology%'
         ORDER BY 1`);
      expect(r.rows.map((x: any) => x.tgname))
        .toEqual(['distribution_points_health_sector_topology_trg']);
    });

    it('the canonical validator is unreachable from anon and authenticated', async () => {
      const r = await asAdmin(`
        SELECT
          has_function_privilege('authenticated','public.phoenix_assert_active_outlet_topology_v1(uuid,uuid,text,text)','EXECUTE') AS a1,
          has_function_privilege('anon','public.phoenix_assert_active_outlet_topology_v1(uuid,uuid,text,text)','EXECUTE')          AS a2,
          has_function_privilege('authenticated','public.phoenix_assert_outlet_topology_for_point_v1(uuid)','EXECUTE')             AS a3,
          has_function_privilege('anon','public.phoenix_assert_outlet_topology_for_point_v1(uuid)','EXECUTE')                      AS a4`);
      expect(r.rows[0]).toEqual({ a1: false, a2: false, a3: false, a4: false });
    });

    it('an AUTHENTICATED caller cannot execute the validator directly', async () => {
      const msg = await rejects(() => rig.asUser(rig.superAdminId, (c: any) => c.query(
        `SELECT public.phoenix_assert_active_outlet_topology_v1($1,$2,'rescue_cart','emergency')`,
        [ORG_SPEC, WH_SPEC])));
      expect(msg).toMatch(/permission denied for function/i);
    });

    it('the matrix lives in NO table', async () => {
      const r = await asAdmin(`
        SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind='r'
           AND c.relname IN ('outlet_topology_matrix','emergency_outlet_matrix',
                             'distribution_point_rules','outlet_stock_v2')`);
      expect(r.rows[0].n).toBe(0);
    });

    it('exactly two stock truths remain', async () => {
      const r = await asAdmin(`
        SELECT (SELECT count(*)::int FROM pg_class WHERE relname IN ('warehouse_stock','outlet_stock')) AS truths,
               (SELECT count(*)::int FROM pg_class
                 WHERE relname IN ('pharmacy_stock','rescue_cart_stock','crash_cabinet_stock','unit_stock')) AS extra`);
      expect(r.rows[0]).toEqual({ truths: 2, extra: 0 });
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INITIAL PROVISIONING — the second place an outlet becomes operational.
//
// The topology assertion is the FIRST statement of
// phoenix_create_initial_provisioning_dispatch, so a denied request must leave
// no dispatch, no dispatch line, no stock movement and no success audit row.
// Every case below measures those five deltas; none of them is satisfied by an
// exception string alone.
//
// The illegal destinations are stored INACTIVE, because 183's write boundary
// makes an ACTIVE one unreachable — which is itself the point: the provisioning
// gate judges the row's CURRENT topology regardless of its status, so it is a
// genuine second line of defence rather than a restatement of the first.
// ════════════════════════════════════════════════════════════════════════════
run('183 · initial provisioning refuses an illegal destination atomically', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const asAdmin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));

  let tag = 0;
  const createInitial = (wh: string, dp: string) =>
    rig.asUser(
      rig.superAdminId,
      (c: any) => c.query(
        `SELECT public.phoenix_create_initial_provisioning_dispatch($1,$2,$3,NULL,NULL,NULL) AS r`,
        [wh, dp, `IP183-${Date.now()}-${(tag += 1)}`],
      ).then((res: any) => res.rows[0].r),
      { commit: true },
    );

  const outlet = (o: { warehouse: string | null; org: string; type: string; clinical: string | null; status?: string }) =>
    asAdmin(
      `INSERT INTO distribution_points
         (warehouse_id,organization_id,name,name_ar,point_type,status,clinical_location_kind)
       VALUES ($1,$2,'IP183','ع',$3,$4,$5) RETURNING id`,
      [o.warehouse, o.org, o.type, o.status ?? 'active', o.clinical],
    ).then((r: any) => r.rows[0].id as string);

  /** The five things a refusal must not create. */
  const ledger = () => asAdmin(`
    SELECT (SELECT count(*)::int FROM warehouse_dispatches)                                   AS dispatches,
           (SELECT count(*)::int FROM warehouse_dispatch_lines)                               AS lines,
           (SELECT COALESCE(SUM(on_hand_quantity),0)::int FROM warehouse_stock)               AS warehouse_stock,
           (SELECT COALESCE(SUM(on_hand_quantity),0)::int FROM outlet_stock)                  AS outlet_stock,
           (SELECT count(*)::int FROM audit_logs
             WHERE action IN ('warehouse_dispatch.created',
                              'warehouse_dispatch.initial_provisioning_created'))             AS audit`
  ).then((r: any) => r.rows[0]);

  beforeAll(async () => {
    rig = await buildRig({});
    await asAdmin(`
      INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
        ('${ORG_HOSP}',  'H183i','مستشفى','r12ci-h','care_institution','hospital','active'),
        ('${ORG_SPEC}',  'S183i','تخصصي','r12ci-s','care_institution','specialized_center','active'),
        ('${ORG_SECTOR}','Q183i','قطاع',  'r12ci-q','care_institution','health_sector','active'),
        ('${ORG_PDA}',   'P183i','دائرة', 'r12ci-p','pharmacy_department_authority',NULL,'active');

      INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,status) VALUES
        ('${FAC_A}','${ORG_SECTOR}','primary_health_center','A','أ','active');

      INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
        ('${WH_HOSP}',    '${ORG_HOSP}',  'HWH','مخزن','institution',NULL,true,'active'),
        ('${WH_SPEC}',    '${ORG_SPEC}',  'SWH','مخزن ت','institution',NULL,true,'active'),
        ('${WH_PDA}',     '${ORG_PDA}',   'PWH','مخزن مركزي','central',NULL,true,'active'),
        ('${SECTOR_MAIN}','${ORG_SECTOR}','Sector Main','رئيسي','institution',NULL,true,'active'),
        ('${DEP_A}',      '${ORG_SECTOR}','Depot A','مذخر أ','institution','${FAC_A}',false,'active');`);
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ── ILLEGAL DESTINATIONS ──────────────────────────────────────────────────
  const illegal: [string, string, () => Promise<string>, RegExp][] = [
    ['specialized centre · rescue cart', 'SPEC',
     () => outlet({ warehouse: WH_SPEC, org: ORG_SPEC, type: 'rescue_cart', clinical: 'emergency', status: 'inactive' }),
     /specialized_center_rescue_cart_not_permitted/],
    ['hospital · rescue cart + non_emergency', 'HOSP',
     () => outlet({ warehouse: WH_HOSP, org: ORG_HOSP, type: 'rescue_cart', clinical: 'non_emergency', status: 'inactive' }),
     /rescue_cart_requires_emergency_context/],
    ['hospital · crash cabinet + emergency', 'HOSP',
     () => outlet({ warehouse: WH_HOSP, org: ORG_HOSP, type: 'crash_cabinet', clinical: 'emergency', status: 'inactive' }),
     /crash_cabinet_requires_non_emergency_context/],
    ['health sector · rescue cart', 'DEP_A',
     () => outlet({ warehouse: DEP_A, org: ORG_SECTOR, type: 'rescue_cart', clinical: 'emergency', status: 'inactive' }),
     /health_center_rescue_cart_not_permitted/],
    ['health sector · crash cabinet + non_emergency', 'DEP_A',
     () => outlet({ warehouse: DEP_A, org: ORG_SECTOR, type: 'crash_cabinet', clinical: 'non_emergency', status: 'inactive' }),
     /health_center_crash_cabinet_requires_emergency_context/],
    ['health sector · the SECTOR MAIN', 'MAIN',
     () => outlet({ warehouse: SECTOR_MAIN, org: ORG_SECTOR, type: 'crash_cabinet', clinical: 'emergency', status: 'inactive' }),
     /health_sector_outlet_requires_health_center_depot/],
    ['pharmacy department authority · NULL warehouse', 'PDA',
     () => outlet({ warehouse: null, org: ORG_PDA, type: 'crash_cabinet', clinical: 'non_emergency', status: 'inactive' }),
     /pharmacy_department_authority_outlet_not_permitted/],
  ];

  const SOURCE: Record<string, string> = {
    SPEC: WH_SPEC, HOSP: WH_HOSP, DEP_A: DEP_A, MAIN: SECTOR_MAIN, PDA: WH_PDA,
  };

  for (const [label, source, make, expected] of illegal) {
    describe(`refuses: ${label}`, () => {
      let dp: string;
      let before: Record<string, number>;
      let message: string;

      beforeAll(async () => {
        dp = await make();
        before = await ledger();
        message = await rejects(() => createInitial(SOURCE[source], dp));
      });

      it('raises the precise topology error', () => {
        expect(message).toMatch(expected);
      });

      it('creates NO dispatch and NO dispatch line', async () => {
        const after = await ledger();
        expect(after.dispatches).toBe(before.dispatches);
        expect(after.lines).toBe(before.lines);
      });

      it('moves NO warehouse stock and NO outlet stock', async () => {
        const after = await ledger();
        expect(after.warehouse_stock).toBe(before.warehouse_stock);
        expect(after.outlet_stock).toBe(before.outlet_stock);
      });

      it('writes NO successful audit event', async () => {
        const after = await ledger();
        expect(after.audit).toBe(before.audit);
      });

      it('leaves the destination outlet itself untouched', async () => {
        const r = await asAdmin(
          `SELECT count(*)::int n FROM warehouse_dispatches WHERE destination_distribution_point_id=$1`, [dp]);
        expect(r.rows[0].n).toBe(0);
      });
    });
  }

  // ── LEGAL DESTINATIONS ────────────────────────────────────────────────────
  describe('admits the legal destinations, and 180s one-shot rule survives', () => {
    const legal: [string, string, () => Promise<string>][] = [
      ['hospital · rescue cart + emergency', WH_HOSP,
       () => outlet({ warehouse: WH_HOSP, org: ORG_HOSP, type: 'rescue_cart', clinical: 'emergency' })],
      ['hospital · crash cabinet + non_emergency', WH_HOSP,
       () => outlet({ warehouse: WH_HOSP, org: ORG_HOSP, type: 'crash_cabinet', clinical: 'non_emergency' })],
      ['specialized centre · crash cabinet + non_emergency', WH_SPEC,
       () => outlet({ warehouse: WH_SPEC, org: ORG_SPEC, type: 'crash_cabinet', clinical: 'non_emergency' })],
      ['health centre · crash cabinet + emergency', DEP_A,
       () => outlet({ warehouse: DEP_A, org: ORG_SECTOR, type: 'crash_cabinet', clinical: 'emergency' })],
    ];

    for (const [label, source, make] of legal) {
      it(`admits: ${label}`, async () => {
        const dp = await make();
        const before = await ledger();
        const r = await createInitial(source, dp);
        expect(r.ok).toBe(true);
        expect(r.is_initial_provisioning).toBe(true);
        const after = await ledger();
        expect(after.dispatches).toBe(before.dispatches + 1);
        expect(after.audit).toBe(before.audit + 2); // 'created' + 'initial_provisioning_created'
        // Commissioning creates the authority, never stock.
        expect(after.warehouse_stock).toBe(before.warehouse_stock);
        expect(after.outlet_stock).toBe(before.outlet_stock);
      });
    }

    it('a SECOND initial provisioning on the same outlet is still refused (180 one-shot)', async () => {
      const dp = await outlet({ warehouse: WH_HOSP, org: ORG_HOSP, type: 'crash_cabinet', clinical: 'non_emergency' });
      expect((await createInitial(WH_HOSP, dp)).ok).toBe(true);
      const before = await ledger();
      expect(await rejects(() => createInitial(WH_HOSP, dp)))
        .toMatch(/initial_provisioning_already_exists_for_outlet|once_uniq/);
      expect(await ledger()).toEqual(before);
    });

    it('a PHARMACY is still refused by 180s own authority matrix, not by 183', async () => {
      // 183 admits a hospital pharmacy as a topology; 180 still refuses it as a
      // COMMISSIONING destination. Both refusals must survive, distinctly.
      const dp = await outlet({ warehouse: WH_HOSP, org: ORG_HOSP, type: 'pharmacy', clinical: null });
      const msg = await rejects(() => createInitial(WH_HOSP, dp));
      expect(msg).toMatch(/initial_provisioning_requires_emergency_outlet/);
      expect(msg).not.toMatch(/outlet_owner_institution_class_unsupported/);
    });

    it('the topology assert runs BEFORE 180s pairing and permission rules', async () => {
      // An illegal destination paired with the WRONG warehouse still reports the
      // topology problem: the assert is the first statement, so no caller can
      // use a pairing error to discover that the outlet is otherwise reachable.
      const dp = await outlet({
        warehouse: WH_SPEC, org: ORG_SPEC, type: 'rescue_cart', clinical: 'emergency', status: 'inactive',
      });
      expect(await rejects(() => createInitial(WH_HOSP, dp)))
        .toMatch(/specialized_center_rescue_cart_not_permitted/);
    });
  });
});
