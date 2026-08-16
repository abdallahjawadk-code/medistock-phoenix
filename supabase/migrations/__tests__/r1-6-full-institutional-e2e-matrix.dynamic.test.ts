/**
 * R1.6 · FULL INSTITUTIONAL E2E MATRIX — the cross-slice reconciliation proof.
 *
 * Every other dynamic suite in this repository proves ONE migration's increment,
 * most of them frozen at the ceiling that migration introduced. This file is the
 * opposite: it builds the COMPLETE institution-class topology once, at the
 * CURRENT tip (`buildRig({})` = 001->186), and drives the real custody RPCs
 * end to end across it.
 *
 * Its job is the reconciliation none of the per-migration suites can perform:
 *
 *   - that the corridors 165/181/184 opened and narrowed still carry actual
 *     STOCK, not merely that their validators return the right row;
 *   - that 166/180/183's emergency lifecycle and 168's replenishment agree with
 *     183's topology matrix on the SAME fixture;
 *   - that 185's return/quarantine/recall parity holds along a chain whose
 *     provenance was created by real sends and receives rather than seeded;
 *   - that 182's facility-scoped RBAC refuses the same actor the corridors
 *     would otherwise admit;
 *   - and that every one of those steps conserves quantity.
 *
 * THREE RULES THIS FILE HOLDS ITSELF TO
 *
 *   1. REAL RPCs, NOT SEEDED ROWS. Stock enters through
 *      phoenix_receive_warehouse_stock_guarded and moves only through the
 *      canonical send/receive functions. The only direct INSERTs are the
 *      topology itself (organizations, facilities, warehouses, outlets,
 *      profiles, scopes) — the things the product has no RPC for at this tip.
 *      A test that seeds the row it then "proves" would prove its own fixture.
 *
 *   2. A REFUSAL IS PROVED BY A DELTA, NOT BY A STRING. Every negative case
 *      takes a full census before and after and requires stock, movement and
 *      audit deltas of exactly zero. The error identifier is asserted as well,
 *      never instead.
 *
 *   3. CANONICAL ROLES AND SCOPES ONLY. Zero rows are ever written to
 *      profile_permission_overrides; a test at the end asserts the table is
 *      empty, so no later edit can quietly buy itself an authorization.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

// The chain replay alone is ~60s at this ceiling, and this file drives a great
// many sequential RPCs on top of it. vitest budgets hooks separately from
// tests, so both need raising or the beforeAll is killed mid-replay and
// surfaces as ECONNRESET rather than as any assertion.
vi.setConfig({ testTimeout: 240000, hookTimeout: 420000 });

const run = rigAvailable() ? describe : describe.skip;

let seq = 0;
const uid = () => `00000000-0000-0000-0000-${String(160000000000 + (seq += 1))}`;

/** Runs `fn`, requires it to throw, and returns the message for matching. */
const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  throw new Error('expected a rejection but the call succeeded');
};

// ── Organizations ───────────────────────────────────────────────────────────
const ORG_PDA = uid();      // pharmacy_department_authority — central supply
const ORG_HOSP = uid();     // hospital
const ORG_SPEC = uid();     // specialized_center
const ORG_SECTOR = uid();   // health_sector (the chain under test)
const ORG_SECTOR2 = uid();  // a SECOND, unrelated health sector
const ORG_HOSP2 = uid();    // a SECOND, unrelated hospital

// ── Facilities (health sector only — no other class may own one) ────────────
const FAC_PRIMARY = uid();      // primary_health_center, ORG_SECTOR
const FAC_SUBORD = uid();       // subordinate_health_center, ORG_SECTOR
const FAC_FOREIGN = uid();      // primary_health_center, ORG_SECTOR2

// ── Warehouses ──────────────────────────────────────────────────────────────
const WH_CENTRAL = uid();       // ORG_PDA, kind=central, is_main
const WH_HOSP = uid();          // ORG_HOSP institution root, is_main
const WH_SPEC = uid();          // ORG_SPEC institution root, is_main
const SECTOR_MAIN = uid();      // ORG_SECTOR, facility NULL, is_main
const DEPOT_PRIMARY = uid();    // ORG_SECTOR, facility-bound, non-main
const DEPOT_SUBORD = uid();     // ORG_SECTOR, facility-bound, non-main
const SECTOR2_MAIN = uid();     // ORG_SECTOR2
const DEPOT_FOREIGN = uid();    // ORG_SECTOR2, facility-bound
const WH_HOSP2 = uid();         // ORG_HOSP2 institution root

// ── Outlets ─────────────────────────────────────────────────────────────────
// Hospital: a pharmacy, an emergency-department pharmacy, the ward crash
// cabinet (non_emergency by 183's matrix) and the ED rescue cart (emergency).
const PH_HOSP = uid();
const PH_HOSP_ER = uid();
const CC_HOSP = uid();
const RC_HOSP = uid();
// Specialized centre: a pharmacy and a crash cabinet. NO rescue cart exists —
// 183 forbids the shape outright, proved below rather than assumed.
const PH_SPEC = uid();
const CC_SPEC = uid();
// Health centres: a pharmacy per centre, and a crash cabinet at the primary
// centre (emergency context — the INVERSION of the hospital rule).
const PH_PRIMARY = uid();
const CC_PRIMARY = uid();
const PH_SUBORD = uid();
// A crash cabinet at the SUBORDINATE centre that is deliberately NEVER
// commissioned — it is the only way to prove the initial-provisioning-first
// gate on a destination that is otherwise perfectly legal.
const CC_SUBORD = uid();
// Foreign sector, for the cross-organization matrix.
const PH_FOREIGN = uid();

// ── Actors (canonical roles, canonical scopes, zero overrides) ──────────────
const CWM = uid();          // central_warehouse_manager @ WH_CENTRAL
// THE SECTOR'S OWN PUSH AUTHORITY. `warehouse_transfer.send` — the permission
// 077 demands from whoever builds a DIRECT request — is held by exactly two
// roles in role_permission_defaults: central_warehouse_manager and super_admin.
// warehouse_officer is explicitly FALSE. So the Branch-B corridor 165 opened and
// 184 preserved (sector main -> centre depot) has precisely one canonical
// non-super_admin driver: a central_warehouse_manager scoped to the Sector Main.
// Nothing binds that role to a pharmacy_department_authority organization, and
// within a health sector the Sector Main IS the store that pushes stock out.
const CWM_SECTOR = uid();   // central_warehouse_manager @ SECTOR_MAIN
const WO_HOSP = uid();      // warehouse_officer  @ WH_HOSP
const WO_SPEC = uid();      // warehouse_officer  @ WH_SPEC
const WO_SECTOR = uid();    // warehouse_officer  @ SECTOR_MAIN
const WO_PRIMARY = uid();   // warehouse_officer  @ DEPOT_PRIMARY
const WO_SUBORD = uid();    // warehouse_officer  @ DEPOT_SUBORD
const OO_PH_HOSP = uid();   // outlet_officer     @ PH_HOSP
const OO_PH_HOSP_ER = uid();// outlet_officer     @ PH_HOSP_ER
const OO_CC_HOSP = uid();   // outlet_officer     @ CC_HOSP
const OO_RC_HOSP = uid();   // outlet_officer     @ RC_HOSP
const OO_PH_SPEC = uid();   // outlet_officer     @ PH_SPEC
const OO_CC_SPEC = uid();   // outlet_officer     @ CC_SPEC
const OO_PH_PRIMARY = uid();// outlet_officer     @ PH_PRIMARY
const OO_CC_PRIMARY = uid();// outlet_officer     @ CC_PRIMARY
const OO_PH_SUBORD = uid(); // outlet_officer     @ PH_SUBORD
// `outlet_stock.replenish` and `replenishment_routes.manage` are held by
// exactly two roles in role_permission_defaults: super_admin and
// institution_admin. outlet_officer holds NEITHER. With zero permission
// overrides — which this file forbids itself — the institution admin is
// therefore the only canonical driver of emergency replenishment, so each
// operable organization needs one.
const IA_HOSP = uid();      // institution_admin  @ ORG_HOSP (org-wide)
const IA_SPEC = uid();      // institution_admin  @ ORG_SPEC
const IA_SECTOR = uid();    // institution_admin  @ ORG_SECTOR
const HCM_PRIMARY = uid();  // health_center_manager @ FAC_PRIMARY
const WO_FOREIGN = uid();   // warehouse_officer  @ SECTOR2_MAIN (foreign org)
const OO_FOREIGN = uid();   // outlet_officer     @ PH_FOREIGN  (foreign org)

/** The one material this matrix moves, so conservation is a single number. */
const MAT = 'R16-MATERIAL';

run('R1.6 · full institutional E2E matrix (001->186, current tip)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const asAdmin = (sql: string, params: any[] = []) =>
    rig.asAdmin((c: any) => c.query(sql, params));

  const call = (c: any, fn: string, args: any[]) =>
    c.query(
      `SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS r`,
      args,
    ).then((r: any) => r.rows[0].r);

  /**
   * A full system census. Every negative case brackets itself with one of
   * these and requires an identical result — that is what makes "the refusal
   * moved nothing" a measurement rather than a hope.
   */
  type Census = Record<string, number>;
  const census = async (): Promise<Census> => {
    const r: any = await asAdmin(`
      SELECT
        (SELECT coalesce(sum(on_hand_quantity),0) FROM warehouse_stock)            AS wh_qty,
        (SELECT coalesce(sum(on_hand_quantity),0) FROM outlet_stock)               AS ol_qty,
        (SELECT coalesce(sum(quantity),0)         FROM warehouse_quarantine_stock) AS q_qty,
        (SELECT count(*) FROM warehouse_stock_movements)      AS wh_mv,
        (SELECT count(*) FROM outlet_stock_movements)         AS ol_mv,
        (SELECT count(*) FROM audit_logs)                     AS audits,
        (SELECT count(*) FROM warehouse_transfers)            AS transfers,
        (SELECT count(*) FROM warehouse_transfer_lines)       AS transfer_lines,
        (SELECT count(*) FROM warehouse_dispatches)           AS dispatches,
        (SELECT count(*) FROM warehouse_dispatch_lines)       AS dispatch_lines,
        (SELECT count(*) FROM outlet_return_requests)         AS outlet_returns,
        (SELECT count(*) FROM warehouse_return_requests)      AS warehouse_returns,
        (SELECT count(*) FROM distribution_points)            AS outlets,
        (SELECT count(*) FROM warehouses)                     AS warehouses`);
    const row = r.rows[0];
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
  };

  /**
   * Runs a call that MUST be refused, and proves the refusal was total: the
   * expected identifier appeared AND not one row of stock, movement or audit
   * anywhere in the system changed.
   */
  const refusesWithNoDelta = async (
    label: string,
    pattern: RegExp,
    fn: () => Promise<unknown>,
  ): Promise<void> => {
    const before = await census();
    const msg = await rejects(fn);
    expect(msg, `${label}: wrong refusal identifier`).toMatch(pattern);
    const after = await census();
    expect(after, `${label}: a refusal changed system state`).toEqual(before);
  };

  /** on_hand for one warehouse_stock row. */
  const whQty = async (id: string): Promise<number> => {
    const r: any = await asAdmin(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [id]);
    return r.rows.length ? Number(r.rows[0].on_hand_quantity) : 0;
  };
  /** on_hand for one outlet_stock row. */
  const olQty = async (id: string): Promise<number> => {
    const r: any = await asAdmin(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [id]);
    return r.rows.length ? Number(r.rows[0].on_hand_quantity) : 0;
  };
  /** Total on_hand held in one warehouse, across every lot. */
  const whTotal = async (warehouseId: string): Promise<number> => {
    const r: any = await asAdmin(
      `SELECT coalesce(sum(on_hand_quantity),0) AS n FROM warehouse_stock WHERE warehouse_id=$1`,
      [warehouseId]);
    return Number(r.rows[0].n);
  };
  /** Total on_hand held at one outlet, across every lot. */
  const olTotal = async (pointId: string): Promise<number> => {
    const r: any = await asAdmin(
      `SELECT coalesce(sum(on_hand_quantity),0) AS n FROM outlet_stock WHERE distribution_point_id=$1`,
      [pointId]);
    return Number(r.rows[0].n);
  };

  /**
   * Quantity held in CONTROLLED custody at one warehouse. Quarantine is a
   * third holding place but never a third stock TRUTH — §15's ledger counts it
   * separately from warehouse_stock so returned units are never double-counted.
   */
  const quarantineTotal = async (warehouseId: string): Promise<number> => {
    const r: any = await asAdmin(
      `SELECT coalesce(sum(quantity),0) AS n FROM warehouse_quarantine_stock WHERE warehouse_id=$1`,
      [warehouseId]);
    return Number(r.rows[0].n);
  };

  /**
   * PHYSICAL custody only — quantities and movement counts, with no business
   * rows. A recall legitimately CREATES return-request rows while moving no
   * stock, so it is bracketed with this rather than with the full census.
   */
  const physicalLedger = async (): Promise<Census> => {
    const r: any = await asAdmin(`
      SELECT
        (SELECT coalesce(sum(on_hand_quantity),0) FROM warehouse_stock)            AS wh_qty,
        (SELECT coalesce(sum(on_hand_quantity),0) FROM outlet_stock)               AS ol_qty,
        (SELECT coalesce(sum(quantity),0)         FROM warehouse_quarantine_stock) AS q_qty,
        (SELECT count(*) FROM warehouse_stock_movements)                           AS wh_mv,
        (SELECT count(*) FROM outlet_stock_movements)                              AS ol_mv`);
    return Object.fromEntries(
      Object.entries(r.rows[0]).map(([k, v]) => [k, Number(v)]));
  };

  /** Movement rows written against one warehouse_stock row, newest first. */
  const whMovements = async (stockId: string): Promise<any[]> => {
    const r: any = await asAdmin(
      `SELECT movement_type, reason_code, on_hand_delta, on_hand_before, on_hand_after,
              reference_type, reference_id, organization_id, warehouse_id, official_number
         FROM warehouse_stock_movements WHERE warehouse_stock_id=$1
        ORDER BY created_at, id`, [stockId]);
    return r.rows;
  };
  /** Movement rows written against one outlet_stock row, oldest first. */
  const olMovements = async (stockId: string): Promise<any[]> => {
    const r: any = await asAdmin(
      `SELECT movement_type, reason_code, on_hand_delta, on_hand_before, on_hand_after,
              reference_type, reference_id, organization_id, distribution_point_id
         FROM outlet_stock_movements WHERE outlet_stock_id=$1
        ORDER BY created_at, id`, [stockId]);
    return r.rows;
  };
  /** Audit rows for one entity. */
  const audits = async (entityId: string): Promise<any[]> => {
    const r: any = await asAdmin(
      `SELECT action, entity_type, organization_id FROM audit_logs
        WHERE entity_id=$1 ORDER BY created_at, id`, [entityId]);
    return r.rows;
  };

  // ════════════════════════════════════════════════════════════════════════
  // FIXTURE — the institutional topology, built once at the current tip.
  // ════════════════════════════════════════════════════════════════════════
  beforeAll(async () => {
    rig = await buildRig({});

    await asAdmin(`
      INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
        ('${ORG_PDA}',    'R16 PDA',      'دائرة الصيدلة','r16-pda',  'pharmacy_department_authority',NULL,               'active'),
        ('${ORG_HOSP}',   'R16 Hospital', 'مستشفى',       'r16-hosp', 'care_institution',            'hospital',          'active'),
        ('${ORG_SPEC}',   'R16 Center',   'مركز تخصصي',   'r16-spec', 'care_institution',            'specialized_center','active'),
        ('${ORG_SECTOR}', 'R16 Sector',   'قطاع صحي',     'r16-sect', 'care_institution',            'health_sector',     'active'),
        ('${ORG_SECTOR2}','R16 Sector 2', 'قطاع صحي ٢',   'r16-sect2','care_institution',            'health_sector',     'active'),
        ('${ORG_HOSP2}',  'R16 Hospital 2','مستشفى ٢',    'r16-hosp2','care_institution',            'hospital',          'active');

      INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,status) VALUES
        ('${FAC_PRIMARY}','${ORG_SECTOR}', 'primary_health_center',    'Primary Centre',    'مركز أولي',  'active'),
        ('${FAC_SUBORD}', '${ORG_SECTOR}', 'subordinate_health_center','Subordinate Centre','مركز فرعي',  'active'),
        ('${FAC_FOREIGN}','${ORG_SECTOR2}','primary_health_center',    'Foreign Centre',    'مركز خارجي', 'active');

      INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status,code) VALUES
        ('${WH_CENTRAL}',   '${ORG_PDA}',    'Central Store','المخزن المركزي','central',    NULL,             true, 'active','r16-wh-central'),
        ('${WH_HOSP}',      '${ORG_HOSP}',   'Hospital Store','مخزن المستشفى','institution',NULL,             true, 'active','r16-wh-hosp'),
        ('${WH_SPEC}',      '${ORG_SPEC}',   'Center Store', 'مخزن المركز',   'institution',NULL,             true, 'active','r16-wh-spec'),
        ('${SECTOR_MAIN}',  '${ORG_SECTOR}', 'Sector Main',  'المخزن الرئيسي','institution',NULL,             true, 'active','r16-wh-sector'),
        ('${DEPOT_PRIMARY}','${ORG_SECTOR}', 'Primary Depot','مذخر أولي',     'institution','${FAC_PRIMARY}', false,'active','r16-wh-depot-p'),
        ('${DEPOT_SUBORD}', '${ORG_SECTOR}', 'Subord Depot', 'مذخر فرعي',     'institution','${FAC_SUBORD}',  false,'active','r16-wh-depot-s'),
        ('${SECTOR2_MAIN}', '${ORG_SECTOR2}','Sector2 Main', 'رئيسي ٢',       'institution',NULL,             true, 'active','r16-wh-sector2'),
        ('${DEPOT_FOREIGN}','${ORG_SECTOR2}','Foreign Depot','مذخر خارجي',    'institution','${FAC_FOREIGN}', false,'active','r16-wh-depot-f'),
        ('${WH_HOSP2}',     '${ORG_HOSP2}',  'Hospital2 Store','مخزن ٢',      'institution',NULL,             true, 'active','r16-wh-hosp2');

      -- Outlets. Every one of these INSERTs is judged by 183's canonical
      -- topology validator through 181's trigger, so the fixture existing at
      -- all is already the first half of the topology proof.
      INSERT INTO distribution_points
        (id,organization_id,warehouse_id,name,name_ar,point_type,clinical_location_kind,status) VALUES
        ('${PH_HOSP}',    '${ORG_HOSP}',   '${WH_HOSP}',      'Hospital Pharmacy','صيدلية المستشفى','pharmacy',     NULL,           'active'),
        ('${PH_HOSP_ER}', '${ORG_HOSP}',   '${WH_HOSP}',      'ER Pharmacy',      'صيدلية الطوارئ', 'pharmacy',     'emergency',    'active'),
        ('${CC_HOSP}',    '${ORG_HOSP}',   '${WH_HOSP}',      'Ward Crash Cabinet','خزانة إنعاش',   'crash_cabinet','non_emergency','active'),
        ('${RC_HOSP}',    '${ORG_HOSP}',   '${WH_HOSP}',      'ED Rescue Cart',   'عربة إنعاش',     'rescue_cart',  'emergency',    'active'),
        ('${PH_SPEC}',    '${ORG_SPEC}',   '${WH_SPEC}',      'Center Pharmacy',  'صيدلية المركز',  'pharmacy',     NULL,           'active'),
        ('${CC_SPEC}',    '${ORG_SPEC}',   '${WH_SPEC}',      'Center Crash Cabinet','خزانة المركز','crash_cabinet','non_emergency','active'),
        ('${PH_PRIMARY}', '${ORG_SECTOR}', '${DEPOT_PRIMARY}','Primary Pharmacy', 'صيدلية أولية',   'pharmacy',     NULL,           'active'),
        ('${CC_PRIMARY}', '${ORG_SECTOR}', '${DEPOT_PRIMARY}','Primary Crash Cabinet','خزانة أولية','crash_cabinet','emergency',    'active'),
        ('${PH_SUBORD}',  '${ORG_SECTOR}', '${DEPOT_SUBORD}', 'Subord Pharmacy',  'صيدلية فرعية',   'pharmacy',     NULL,           'active'),
        ('${CC_SUBORD}',  '${ORG_SECTOR}', '${DEPOT_SUBORD}', 'Subord Crash Cabinet','خزانة فرعية','crash_cabinet','emergency',    'active'),
        ('${PH_FOREIGN}', '${ORG_SECTOR2}','${DEPOT_FOREIGN}','Foreign Pharmacy', 'صيدلية خارجية',  'pharmacy',     NULL,           'active');`);

    // ── Actors ──────────────────────────────────────────────────────────────
    const users: Array<[string, string, string, string]> = [
      [CWM,           'central_warehouse_manager', ORG_PDA,     'r16-cwm'],
      [CWM_SECTOR,    'central_warehouse_manager', ORG_SECTOR,  'r16-cwm-sector'],
      [WO_HOSP,       'warehouse_officer',         ORG_HOSP,    'r16-wo-hosp'],
      [WO_SPEC,       'warehouse_officer',         ORG_SPEC,    'r16-wo-spec'],
      [WO_SECTOR,     'warehouse_officer',         ORG_SECTOR,  'r16-wo-sector'],
      [WO_PRIMARY,    'warehouse_officer',         ORG_SECTOR,  'r16-wo-primary'],
      [WO_SUBORD,     'warehouse_officer',         ORG_SECTOR,  'r16-wo-subord'],
      [OO_PH_HOSP,    'outlet_officer',            ORG_HOSP,    'r16-oo-ph-hosp'],
      [OO_PH_HOSP_ER, 'outlet_officer',            ORG_HOSP,    'r16-oo-ph-hosp-er'],
      [OO_CC_HOSP,    'outlet_officer',            ORG_HOSP,    'r16-oo-cc-hosp'],
      [OO_RC_HOSP,    'outlet_officer',            ORG_HOSP,    'r16-oo-rc-hosp'],
      [OO_PH_SPEC,    'outlet_officer',            ORG_SPEC,    'r16-oo-ph-spec'],
      [OO_CC_SPEC,    'outlet_officer',            ORG_SPEC,    'r16-oo-cc-spec'],
      [OO_PH_PRIMARY, 'outlet_officer',            ORG_SECTOR,  'r16-oo-ph-primary'],
      [OO_CC_PRIMARY, 'outlet_officer',            ORG_SECTOR,  'r16-oo-cc-primary'],
      [OO_PH_SUBORD,  'outlet_officer',            ORG_SECTOR,  'r16-oo-ph-subord'],
      [IA_HOSP,       'institution_admin',         ORG_HOSP,    'r16-ia-hosp'],
      [IA_SPEC,       'institution_admin',         ORG_SPEC,    'r16-ia-spec'],
      [IA_SECTOR,     'institution_admin',         ORG_SECTOR,  'r16-ia-sector'],
      [HCM_PRIMARY,   'health_center_manager',     ORG_SECTOR,  'r16-hcm-primary'],
      [WO_FOREIGN,    'warehouse_officer',         ORG_SECTOR2, 'r16-wo-foreign'],
      [OO_FOREIGN,    'outlet_officer',            ORG_SECTOR2, 'r16-oo-foreign'],
    ];
    for (const [id, role, org, email] of users) {
      await asAdmin(
        `INSERT INTO auth.users (id,email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`,
        [id, `${email}@rig.local`]);
      await asAdmin(
        `UPDATE profiles SET role=$2, status='active', organization_id=$3 WHERE id=$1`,
        [id, role, org]);
    }

    const whScopes: Array<[string, string, string]> = [
      [CWM, ORG_PDA, WH_CENTRAL],
      [CWM_SECTOR, ORG_SECTOR, SECTOR_MAIN],
      [WO_HOSP, ORG_HOSP, WH_HOSP],
      [WO_SPEC, ORG_SPEC, WH_SPEC],
      [WO_SECTOR, ORG_SECTOR, SECTOR_MAIN],
      [WO_PRIMARY, ORG_SECTOR, DEPOT_PRIMARY],
      [WO_SUBORD, ORG_SECTOR, DEPOT_SUBORD],
      [WO_FOREIGN, ORG_SECTOR2, SECTOR2_MAIN],
    ];
    for (const [profile, org, wh] of whScopes) {
      await asAdmin(
        `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,warehouse_id,is_active)
         VALUES ($1,$2,'warehouse',$3,true) ON CONFLICT DO NOTHING`, [profile, org, wh]);
    }

    const dpScopes: Array<[string, string, string]> = [
      [OO_PH_HOSP, ORG_HOSP, PH_HOSP],
      [OO_PH_HOSP_ER, ORG_HOSP, PH_HOSP_ER],
      [OO_CC_HOSP, ORG_HOSP, CC_HOSP],
      [OO_RC_HOSP, ORG_HOSP, RC_HOSP],
      [OO_PH_SPEC, ORG_SPEC, PH_SPEC],
      [OO_CC_SPEC, ORG_SPEC, CC_SPEC],
      [OO_PH_PRIMARY, ORG_SECTOR, PH_PRIMARY],
      [OO_CC_PRIMARY, ORG_SECTOR, CC_PRIMARY],
      [OO_PH_SUBORD, ORG_SECTOR, PH_SUBORD],
      [OO_FOREIGN, ORG_SECTOR2, PH_FOREIGN],
    ];
    for (const [profile, org, dp] of dpScopes) {
      await asAdmin(
        `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,distribution_point_id,is_active)
         VALUES ($1,$2,'distribution_point',$3,true) ON CONFLICT DO NOTHING`, [profile, org, dp]);
    }

    // 182's facility scope — the health_center_manager is bound to ONE centre.
    await asAdmin(
      `INSERT INTO profile_scope_assignments (profile_id,organization_id,scope_type,facility_id,is_active)
       VALUES ($1,$2,'facility',$3,true) ON CONFLICT DO NOTHING`,
      [HCM_PRIMARY, ORG_SECTOR, FAC_PRIMARY]);
  }, 400000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ════════════════════════════════════════════════════════════════════════
  // §2 · THE CANONICAL INSTITUTION MATRIX
  //
  // The fixture above only proves the LEGAL shapes are constructible. This
  // section proves the illegal ones are not — which is the half a fixture can
  // never demonstrate by existing.
  // ════════════════════════════════════════════════════════════════════════
  describe('§2 · institution matrix — legal shapes exist, illegal ones cannot be built', () => {
    it('every legal outlet in the fixture is active and correctly typed', async () => {
      const r: any = await asAdmin(`
        SELECT dp.id, dp.point_type, dp.clinical_location_kind, o.institution_class
          FROM distribution_points dp
          JOIN organizations o ON o.id = dp.organization_id
         WHERE dp.id = ANY($1) ORDER BY dp.id`,
        [[PH_HOSP, PH_HOSP_ER, CC_HOSP, RC_HOSP, PH_SPEC, CC_SPEC,
          PH_PRIMARY, CC_PRIMARY, PH_SUBORD, PH_FOREIGN]]);
      expect(r.rows).toHaveLength(10);

      const byId = Object.fromEntries(r.rows.map((x: any) => [x.id, x]));
      // The crash-cabinet context genuinely INVERTS between a hospital ward and
      // a health centre; asserting both directions is the point.
      expect(byId[CC_HOSP].clinical_location_kind).toBe('non_emergency');
      expect(byId[CC_SPEC].clinical_location_kind).toBe('non_emergency');
      expect(byId[CC_PRIMARY].clinical_location_kind).toBe('emergency');
      expect(byId[RC_HOSP].clinical_location_kind).toBe('emergency');
    });

    it('A · a pharmacy department authority may hold NO active outlet, warehouse or not', async () => {
      await refusesWithNoDelta(
        'PDA outlet on its central warehouse',
        /pharmacy_department_authority_outlet_not_permitted/,
        () => asAdmin(
          `INSERT INTO distribution_points (organization_id,warehouse_id,name,name_ar,point_type,status)
           VALUES ($1,$2,'PDA Pharmacy','صيدلية','pharmacy','active')`, [ORG_PDA, WH_CENTRAL]));

      // The NULL-warehouse shape is the one 171's warehouse-derived guard could
      // never see; 183 keys the denial on organization_kind so it is covered by
      // construction rather than by a second lookup.
      await refusesWithNoDelta(
        'PDA outlet with NO warehouse',
        /pharmacy_department_authority_outlet_not_permitted/,
        () => asAdmin(
          `INSERT INTO distribution_points (organization_id,warehouse_id,name,name_ar,point_type,status)
           VALUES ($1,NULL,'PDA Floating','صيدلية','pharmacy','active')`, [ORG_PDA]));
    });

    it('A · a pharmacy department authority may not own an institution warehouse either', async () => {
      await refusesWithNoDelta(
        'PDA institution warehouse',
        /pharmacy_department_authority_requires_central_warehouse/,
        () => asAdmin(
          `INSERT INTO warehouses (organization_id,name,name_ar,warehouse_kind,is_main,status)
           VALUES ($1,'PDA Inst','مخزن','institution',false,'active')`, [ORG_PDA]));
    });

    it('B · a hospital crash cabinet in EMERGENCY context is refused (ward, not ED)', async () => {
      await refusesWithNoDelta(
        'hospital crash cabinet / emergency',
        /crash_cabinet_requires_non_emergency_context/,
        () => asAdmin(
          `INSERT INTO distribution_points (organization_id,warehouse_id,name,name_ar,point_type,clinical_location_kind,status)
           VALUES ($1,$2,'Bad CC','خزانة','crash_cabinet','emergency','active')`, [ORG_HOSP, WH_HOSP]));
    });

    it('B · a hospital rescue cart in NON-EMERGENCY context is refused', async () => {
      await refusesWithNoDelta(
        'hospital rescue cart / non_emergency',
        /rescue_cart_requires_emergency_context/,
        () => asAdmin(
          `INSERT INTO distribution_points (organization_id,warehouse_id,name,name_ar,point_type,clinical_location_kind,status)
           VALUES ($1,$2,'Bad RC','عربة','rescue_cart','non_emergency','active')`, [ORG_HOSP, WH_HOSP]));
    });

    it('B · an emergency outlet naming NO warehouse is refused — it could never be provisioned', async () => {
      await refusesWithNoDelta(
        'hospital rescue cart with NULL warehouse',
        /emergency_outlet_requires_owning_warehouse/,
        () => asAdmin(
          `INSERT INTO distribution_points (organization_id,warehouse_id,name,name_ar,point_type,clinical_location_kind,status)
           VALUES ($1,NULL,'Floating RC','عربة','rescue_cart','emergency','active')`, [ORG_HOSP]));
    });

    it('C · a specialized centre may NEVER hold a rescue cart — it runs no emergency department', async () => {
      await refusesWithNoDelta(
        'specialized centre rescue cart',
        /specialized_center_rescue_cart_not_permitted/,
        () => asAdmin(
          `INSERT INTO distribution_points (organization_id,warehouse_id,name,name_ar,point_type,clinical_location_kind,status)
           VALUES ($1,$2,'Spec RC','عربة','rescue_cart','emergency','active')`, [ORG_SPEC, WH_SPEC]));
    });

    it('D · a health centre may NEVER hold a rescue cart', async () => {
      await refusesWithNoDelta(
        'health centre rescue cart',
        /health_center_rescue_cart_not_permitted/,
        () => asAdmin(
          `INSERT INTO distribution_points (organization_id,warehouse_id,name,name_ar,point_type,clinical_location_kind,status)
           VALUES ($1,$2,'HC RC','عربة','rescue_cart','emergency','active')`, [ORG_SECTOR, DEPOT_PRIMARY]));
    });

    it('D · a health-centre crash cabinet in NON-EMERGENCY context is refused (the inversion)', async () => {
      await refusesWithNoDelta(
        'health centre crash cabinet / non_emergency',
        /health_center_crash_cabinet_requires_emergency_context/,
        () => asAdmin(
          `INSERT INTO distribution_points (organization_id,warehouse_id,name,name_ar,point_type,clinical_location_kind,status)
           VALUES ($1,$2,'HC CC','خزانة','crash_cabinet','non_emergency','active')`, [ORG_SECTOR, DEPOT_PRIMARY]));
    });

    it('D · no outlet may hang off the SECTOR MAIN — only off a facility-bound centre depot', async () => {
      await refusesWithNoDelta(
        'outlet on sector main',
        /health_sector_outlet_requires_health_center_depot/,
        () => asAdmin(
          `INSERT INTO distribution_points (organization_id,warehouse_id,name,name_ar,point_type,status)
           VALUES ($1,$2,'Sector Pharmacy','صيدلية','pharmacy','active')`, [ORG_SECTOR, SECTOR_MAIN]));
    });

    it('D · a health-sector outlet with NO warehouse is refused (the R1.1 round-2 bypass)', async () => {
      await refusesWithNoDelta(
        'health sector outlet, NULL warehouse',
        /health_sector_outlet_requires_health_center_depot/,
        () => asAdmin(
          `INSERT INTO distribution_points (organization_id,warehouse_id,name,name_ar,point_type,status)
           VALUES ($1,NULL,'Floating HC Pharmacy','صيدلية','pharmacy','active')`, [ORG_SECTOR]));
    });

    it('D · a Health Centre is a FACILITY, never an organization — no other class may own one', async () => {
      for (const [label, org] of [['hospital', ORG_HOSP], ['specialized centre', ORG_SPEC], ['PDA', ORG_PDA]] as const) {
        await refusesWithNoDelta(
          `${label} owning a facility`,
          /of_parent_class_fk|violates foreign key|of_parent_is_health_sector_chk/i,
          () => asAdmin(
            `INSERT INTO organization_facilities (organization_id,facility_class,name,name_ar,status)
             VALUES ($1,'primary_health_center','X','خ','active')`, [org]));
      }
    });

    it('an organization class can never be laundered after the fact', async () => {
      await refusesWithNoDelta(
        'sector -> hospital reclassification',
        /organization_institution_class_immutable|of_parent_class_fk|violates foreign key/i,
        () => asAdmin(`UPDATE organizations SET institution_class='hospital' WHERE id=$1`, [ORG_SECTOR]));
    });

    it('a legacy-vocabulary outlet type cannot enter the modern regime by reclassification', async () => {
      // 004 seeds active point_type='dispensing' rows and the repo has twice
      // decided never to auto-reclassify them. The concession is bounded: the
      // moment such a row tries to BECOME a modern type it is judged by the
      // full matrix. Proved here on a health-sector row, whose depot is legal
      // but whose target type is not.
      const legacy = uid();
      await asAdmin(
        `INSERT INTO distribution_points (id,organization_id,warehouse_id,name,name_ar,point_type,status)
         VALUES ($1,$2,$3,'Legacy Point','قديم','dispensing','inactive')`,
        [legacy, ORG_SECTOR, DEPOT_PRIMARY]);

      await refusesWithNoDelta(
        'legacy row activating as a rescue cart',
        /health_center_rescue_cart_not_permitted/,
        () => asAdmin(
          `UPDATE distribution_points SET point_type='rescue_cart', clinical_location_kind='emergency', status='active' WHERE id=$1`,
          [legacy]));

      await asAdmin(`DELETE FROM distribution_points WHERE id=$1`, [legacy]);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // §3 · EXTERNAL CENTRAL SUPPLY — real stock, real RPCs, three corridors.
  // ════════════════════════════════════════════════════════════════════════
  const centralIntake = { stockId: '', movementId: '' };
  /** Stock that actually arrived at each institution root, by real receive. */
  const rootStock: Record<string, string> = {};
  /** The transfer LINE that carried it — the provenance a return must cite. */
  const rootLine: Record<string, string> = {};

  describe('§3 · external central supply', () => {
    it('intake — the central warehouse receives 600 units through the real RPC', async () => {
      await rig.asUser(CWM, async (c: any) => {
        // 079 made the expected generation FAIL CLOSED: omitting it raises
        // `expected_generation_required` rather than silently posting unguarded.
        // A lot that does not exist yet IS generation 0 — that is what a first
        // receipt legitimately reads and proves.
        const r = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
          randomUUID(), WH_CENTRAL, MAT, 600, true, false, 0,
          null, null, null, null, null, null, 'R16-LOT-1', '2030-01-01',
          // ...unit_price, price_basis, currency, supply_type_text,
          // source_document_number, notes, THEN the canonical supply_type and
          // purchase_origin. 088 made supply_type mandatory and pinned
          // purchase_origin to be present IFF supply_type = 'purchase', so an
          // aid receipt must leave the origin NULL.
          null, null, null, null, null, null, 'aid', null,
        ]);
        expect(r.ok).toBe(true);
        expect(Number(r.quantity_after)).toBe(600);
        centralIntake.stockId = r.warehouse_stock_id;
      }, { commit: true });

      const mv = await whMovements(centralIntake.stockId);
      expect(mv).toHaveLength(1);
      expect(mv[0].movement_type).toBe('add');
      expect(Number(mv[0].on_hand_delta)).toBe(600);
      expect(Number(mv[0].on_hand_after)).toBe(600);
      expect(mv[0].organization_id).toBe(ORG_PDA);
      expect(mv[0].warehouse_id).toBe(WH_CENTRAL);
      // 090's server-generated official number — never client-settable.
      expect(mv[0].official_number).toMatch(/^W[AR]-\d{4}-\d{6}$/);
      centralIntake.movementId = (await asAdmin(
        `SELECT id FROM warehouse_stock_movements WHERE warehouse_stock_id=$1`,
        [centralIntake.stockId])).rows[0].id;
    });

    /**
     * One complete direct corridor: request -> submit -> review -> send ->
     * receive, driven entirely through the canonical RPCs, with the exact
     * before/after arithmetic asserted at both ends.
     */
    const supplyToRoot = async (
      label: string, destWh: string, destOrg: string, receiver: string, qty: number,
    ) => {
      const reqNumber = `R16-SUP-${label}`;
      const beforeCentral = await whQty(centralIntake.stockId);
      const beforeDest = await whTotal(destWh);

      // THE SOURCE OWNS THE WHOLE BUILD. For a DIRECT request (route_id NULL)
      // 077 authorizes create/add-line/submit against the SOURCE warehouse via
      // `warehouse_transfer.send` — "the central push is accountable for what it
      // sends". Only the RECEIVE below is destination-scoped. Driving the build
      // from the destination officer earns `forbidden_direct_warehouse_transfer`
      // (42501), which is the inverse of the legacy routed request in 068.
      const created = await rig.asUser(CWM, (c: any) =>
        call(c, 'phoenix_create_direct_warehouse_transfer_request',
          [WH_CENTRAL, destOrg, destWh, reqNumber, null]), { commit: true });
      expect(created.ok, `${label}: request`).toBe(true);
      const requestId = created.transfer_request_id;

      const line = await rig.asUser(CWM, (c: any) =>
        call(c, 'phoenix_add_warehouse_transfer_request_line',
          [requestId, MAT, qty, null, null, null, null, null]), { commit: true });
      expect(line.ok, `${label}: request line`).toBe(true);
      const requestLineId = line.transfer_request_line_id;

      await rig.asUser(CWM, (c: any) =>
        call(c, 'phoenix_submit_warehouse_transfer_request', [requestId]), { commit: true });

      // The CENTRAL store reviews and then ships.
      await rig.asUser(CWM, (c: any) =>
        call(c, 'phoenix_review_warehouse_transfer_request',
          [requestId, JSON.stringify([{ line_id: requestLineId, approved_quantity: qty }])]),
        { commit: true });

      // A DIRECT corridor has no supply route, so it has its own sender whose
      // second argument is the TRANSFER REQUEST — passing NULL to the routed
      // `phoenix_send_warehouse_transfer_line` earns `supply_route_not_found`.
      const sent = await rig.asUser(CWM, (c: any) =>
        call(c, 'phoenix_send_direct_warehouse_transfer_line',
          [randomUUID(), requestId, centralIntake.stockId, qty, `${reqNumber}-X`, requestLineId, null, null]),
        { commit: true });
      expect(sent.ok, `${label}: send`).toBe(true);

      const transferLineId = (await asAdmin(
        `SELECT wtl.id FROM warehouse_transfer_lines wtl
           JOIN warehouse_transfers wt ON wt.id = wtl.transfer_id
          WHERE wt.transfer_number = $1`, [`${reqNumber}-X`])).rows[0].id;

      // The send has already debited the central store.
      expect(await whQty(centralIntake.stockId), `${label}: central debited`)
        .toBe(beforeCentral - qty);

      const received = await rig.asUser(receiver, (c: any) =>
        call(c, 'phoenix_receive_warehouse_transfer_line',
          [randomUUID(), transferLineId, qty, null, null]), { commit: true });
      expect(received.ok, `${label}: receive`).toBe(true);

      expect(await whTotal(destWh), `${label}: destination credited`).toBe(beforeDest + qty);
      rootStock[label] = received.warehouse_stock_id;
      rootLine[label] = transferLineId;
      return { requestId, transferLineId, resultingStockId: received.warehouse_stock_id };
    };

    it('PASS central -> hospital root, end to end, with exact conservation', async () => {
      await supplyToRoot('HOSP', WH_HOSP, ORG_HOSP, WO_HOSP, 200);
      expect(await whQty(rootStock.HOSP)).toBe(200);

      const mv = await whMovements(rootStock.HOSP);
      expect(mv).toHaveLength(1);
      expect(mv[0].movement_type).toBe('add');
      expect(Number(mv[0].on_hand_delta)).toBe(200);
      expect(mv[0].organization_id).toBe(ORG_HOSP);
      expect(mv[0].warehouse_id).toBe(WH_HOSP);
    });

    it('PASS central -> specialized centre root, end to end', async () => {
      await supplyToRoot('SPEC', WH_SPEC, ORG_SPEC, WO_SPEC, 120);
      expect(await whQty(rootStock.SPEC)).toBe(120);
    });

    it('PASS central -> health-sector MAIN, end to end', async () => {
      await supplyToRoot('SECTOR', SECTOR_MAIN, ORG_SECTOR, WO_SECTOR, 240);
      expect(await whQty(rootStock.SECTOR)).toBe(240);
    });

    it('conservation — the 600 intake units are exactly accounted for after three corridors', async () => {
      const remaining = await whQty(centralIntake.stockId);
      const delivered = (await whQty(rootStock.HOSP))
        + (await whQty(rootStock.SPEC))
        + (await whQty(rootStock.SECTOR));
      expect(remaining).toBe(40);          // 600 - 200 - 120 - 240
      expect(remaining + delivered).toBe(600);
    });

    it('REJECT central -> a health-centre depot, and it moves nothing', async () => {
      // Driven as CWM — the actor who IS scoped to send from the central store.
      // Refusing an unauthorized actor would prove nothing about the corridor;
      // 184 raises the endpoint verdict BEFORE 077's IDOR gate, so a properly
      // authorized source officer is exactly who must be turned away here.
      await refusesWithNoDelta(
        'central -> primary depot',
        /central_supply_destination_must_not_be_facility_bound/,
        () => rig.asUser(CWM, (c: any) =>
          call(c, 'phoenix_create_direct_warehouse_transfer_request',
            [WH_CENTRAL, ORG_SECTOR, DEPOT_PRIMARY, 'R16-BAD-DEPOT', null]), { commit: true }));

      await refusesWithNoDelta(
        'central -> subordinate depot',
        /central_supply_destination_must_not_be_facility_bound/,
        () => rig.asUser(CWM, (c: any) =>
          call(c, 'phoenix_create_direct_warehouse_transfer_request',
            [WH_CENTRAL, ORG_SECTOR, DEPOT_SUBORD, 'R16-BAD-DEPOT-2', null]), { commit: true }));
    });

    it('REJECT central -> an outlet: no corridor addresses a distribution point at all', async () => {
      // A warehouse corridor is warehouse-to-warehouse by SIGNATURE. Passing an
      // outlet id where a warehouse id belongs cannot resolve to a warehouse,
      // so the shape is unconstructible rather than merely refused.
      await refusesWithNoDelta(
        'central -> outlet id as warehouse',
        /destination_warehouse_not_found|source_and_destination_required|destination_must_be_active_institution_warehouse|central_supply_destination/,
        () => rig.asUser(CWM, (c: any) =>
          call(c, 'phoenix_create_direct_warehouse_transfer_request',
            [WH_CENTRAL, ORG_HOSP, PH_HOSP, 'R16-BAD-OUTLET', null]), { commit: true }));
    });

    it('REJECT a non-central source on the external corridor', async () => {
      await refusesWithNoDelta(
        'hospital -> hospital2 as external supply',
        /source_must_be_active_central_warehouse/,
        () => rig.asUser(WO_HOSP, (c: any) =>
          call(c, 'phoenix_create_direct_warehouse_transfer_request',
            [WH_HOSP, ORG_HOSP2, WH_HOSP2, 'R16-BAD-PEER', null]), { commit: true }));
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // §4 · HEALTH-SECTOR INTERNAL CHAIN — sector main down to both centres.
  // ════════════════════════════════════════════════════════════════════════
  const depotStock: Record<string, string> = {};
  const depotLine: Record<string, string> = {};

  describe('§4 · health-sector internal chain', () => {
    const supplyToDepot = async (label: string, depot: string, receiver: string, qty: number) => {
      const reqNumber = `R16-SEC-${label}`;
      const beforeMain = await whQty(rootStock.SECTOR);
      const beforeDepot = await whTotal(depot);

      // Branch B of 184's validator (checked BEFORE the central branch) makes
      // sector-main -> facility-bound depot a legal corridor through this very
      // same direct RPC. Authorization is still SOURCE-scoped, so the sector
      // officer — not the receiving centre — owns the build.
      const created = await rig.asUser(CWM_SECTOR, (c: any) =>
        call(c, 'phoenix_create_direct_warehouse_transfer_request',
          [SECTOR_MAIN, ORG_SECTOR, depot, reqNumber, null]), { commit: true });
      expect(created.ok, `${label}: request`).toBe(true);

      const line = await rig.asUser(CWM_SECTOR, (c: any) =>
        call(c, 'phoenix_add_warehouse_transfer_request_line',
          [created.transfer_request_id, MAT, qty, null, null, null, null, null]), { commit: true });
      await rig.asUser(CWM_SECTOR, (c: any) =>
        call(c, 'phoenix_submit_warehouse_transfer_request', [created.transfer_request_id]), { commit: true });
      await rig.asUser(CWM_SECTOR, (c: any) =>
        call(c, 'phoenix_review_warehouse_transfer_request',
          [created.transfer_request_id,
           JSON.stringify([{ line_id: line.transfer_request_line_id, approved_quantity: qty }])]),
        { commit: true });

      const sent = await rig.asUser(CWM_SECTOR, (c: any) =>
        call(c, 'phoenix_send_direct_warehouse_transfer_line',
          [randomUUID(), created.transfer_request_id, rootStock.SECTOR, qty, `${reqNumber}-X`,
           line.transfer_request_line_id, null, null]), { commit: true });
      expect(sent.ok, `${label}: send`).toBe(true);

      const transferLineId = (await asAdmin(
        `SELECT wtl.id FROM warehouse_transfer_lines wtl
           JOIN warehouse_transfers wt ON wt.id = wtl.transfer_id
          WHERE wt.transfer_number = $1`, [`${reqNumber}-X`])).rows[0].id;

      expect(await whQty(rootStock.SECTOR), `${label}: sector main debited`).toBe(beforeMain - qty);

      const received = await rig.asUser(receiver, (c: any) =>
        call(c, 'phoenix_receive_warehouse_transfer_line',
          [randomUUID(), transferLineId, qty, null, null]), { commit: true });
      expect(received.ok, `${label}: receive`).toBe(true);
      expect(await whTotal(depot), `${label}: depot credited`).toBe(beforeDepot + qty);

      depotStock[label] = received.warehouse_stock_id;
      depotLine[label] = transferLineId;
    };

    it('PASS sector main -> PRIMARY health-centre depot, end to end', async () => {
      await supplyToDepot('PRIMARY', DEPOT_PRIMARY, WO_PRIMARY, 90);
      expect(await whQty(depotStock.PRIMARY)).toBe(90);

      const mv = await whMovements(depotStock.PRIMARY);
      expect(mv).toHaveLength(1);
      expect(mv[0].movement_type).toBe('add');
      expect(Number(mv[0].on_hand_delta)).toBe(90);
      expect(mv[0].organization_id).toBe(ORG_SECTOR);
      expect(mv[0].warehouse_id).toBe(DEPOT_PRIMARY);
    });

    it('PASS sector main -> SUBORDINATE health-centre depot, end to end', async () => {
      await supplyToDepot('SUBORD', DEPOT_SUBORD, WO_SUBORD, 60);
      expect(await whQty(depotStock.SUBORD)).toBe(60);
    });

    it('conservation — the sector main balance equals what it received minus what it sent', async () => {
      expect(await whQty(rootStock.SECTOR)).toBe(90);  // 240 - 90 - 60
      const held = (await whQty(rootStock.SECTOR))
        + (await whQty(depotStock.PRIMARY))
        + (await whQty(depotStock.SUBORD));
      expect(held).toBe(240);
    });

    it('REJECT sector main -> a FOREIGN sector centre depot', async () => {
      await refusesWithNoDelta(
        'sector 1 main -> sector 2 depot',
        /source_must_be_active_central_warehouse/,
        () => rig.asUser(WO_SECTOR, (c: any) =>
          call(c, 'phoenix_create_direct_warehouse_transfer_request',
            [SECTOR_MAIN, ORG_SECTOR2, DEPOT_FOREIGN, 'R16-BAD-XSECT', null]), { commit: true }));
    });

    it('REJECT depot -> sibling depot as a forward supply', async () => {
      await refusesWithNoDelta(
        'primary depot -> subordinate depot',
        /source_must_be_active_central_warehouse/,
        () => rig.asUser(WO_PRIMARY, (c: any) =>
          call(c, 'phoenix_create_direct_warehouse_transfer_request',
            [DEPOT_PRIMARY, ORG_SECTOR, DEPOT_SUBORD, 'R16-BAD-SIB', null]), { commit: true }));
    });

    it('REJECT depot -> sector main as a FORWARD supply (that direction is a return)', async () => {
      await refusesWithNoDelta(
        'primary depot -> sector main forward',
        /source_must_be_active_central_warehouse/,
        () => rig.asUser(WO_PRIMARY, (c: any) =>
          call(c, 'phoenix_create_direct_warehouse_transfer_request',
            [DEPOT_PRIMARY, ORG_SECTOR, SECTOR_MAIN, 'R16-BAD-REV', null]), { commit: true }));
    });

    it('REJECT depot -> a foreign organization entirely', async () => {
      await refusesWithNoDelta(
        'primary depot -> foreign hospital',
        /source_must_be_active_central_warehouse/,
        () => rig.asUser(WO_PRIMARY, (c: any) =>
          call(c, 'phoenix_create_direct_warehouse_transfer_request',
            [DEPOT_PRIMARY, ORG_HOSP2, WH_HOSP2, 'R16-BAD-XORG', null]), { commit: true }));
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // §5 · ORDINARY OUTLET SUPPLY — warehouse -> pharmacy, every operable class.
  // ════════════════════════════════════════════════════════════════════════
  /** outlet_stock ids created by a REAL receive, keyed by outlet label. */
  const outletStock: Record<string, string> = {};
  /** the dispatch LINE that carried it — the provenance a return must cite. */
  const outletLine: Record<string, string> = {};

  /**
   * One complete warehouse -> outlet custody transition: header -> line ->
   * send -> receive, with the exact debit and credit asserted at both ends.
   * `initial` switches the header to the initial-provisioning authority, which
   * is the ONLY way stock ever reaches an emergency outlet from a warehouse.
   */
  const dispatchToOutlet = async (
    label: string, warehouseId: string, stockId: string, outletId: string,
    sender: string, receiver: string, qty: number,
    opts: { initial?: boolean } = {},
  ) => {
    const num = `R16-DSP-${label}`;
    const beforeWh = await whQty(stockId);
    const beforeOl = await olTotal(outletId);

    const created = await rig.asUser(sender, (c: any) =>
      call(c, opts.initial
        ? 'phoenix_create_initial_provisioning_dispatch'
        : 'phoenix_create_warehouse_dispatch',
        [warehouseId, outletId, num, null, null, null]), { commit: true });
    expect(created.ok, `${label}: dispatch header`).toBe(true);
    expect(created.status, `${label}: header starts draft`).toBe('draft');
    if (opts.initial) expect(created.is_initial_provisioning).toBe(true);

    // 150 made add-line FEFO-guarded and idempotent: p_request_id defaults to
    // NULL but is rejected as NULL, so it must be supplied explicitly.
    const line = await rig.asUser(sender, (c: any) =>
      call(c, 'phoenix_add_dispatch_line_fefo_guarded',
        [created.dispatch_id, stockId, qty, false, null, randomUUID()]), { commit: true });
    expect(line.ok, `${label}: dispatch line`).toBe(true);
    expect(line.fefo_override_applied, `${label}: no override needed`).toBe(false);

    const sent = await rig.asUser(sender, (c: any) =>
      call(c, 'phoenix_send_warehouse_dispatch',
        [randomUUID(), created.dispatch_id]), { commit: true });
    expect(sent.ok, `${label}: send`).toBe(true);
    expect(sent.status, `${label}: header sent`).toBe('sent');
    expect(await whQty(stockId), `${label}: warehouse debited`).toBe(beforeWh - qty);

    const received = await rig.asUser(receiver, (c: any) =>
      call(c, 'phoenix_receive_outlet_dispatch_line',
        [randomUUID(), line.dispatch_line_id, qty, null, null, null]), { commit: true });
    expect(received.ok, `${label}: receive`).toBe(true);
    expect(received.line_status, `${label}: accepted in full`).toBe('accepted');
    expect(await olTotal(outletId), `${label}: outlet credited`).toBe(beforeOl + qty);

    outletStock[label] = received.outlet_stock_id;
    outletLine[label] = line.dispatch_line_id;
    return { dispatchId: created.dispatch_id, lineId: line.dispatch_line_id,
             outletStockId: received.outlet_stock_id, receiveRequestId: received };
  };

  describe('§5 · ordinary outlet supply (warehouse -> pharmacy)', () => {
    it('PASS hospital warehouse -> hospital pharmacy, with exact movement accounting', async () => {
      const r = await dispatchToOutlet('PH_HOSP', WH_HOSP, rootStock.HOSP, PH_HOSP,
        WO_HOSP, OO_PH_HOSP, 50);

      // The SEND side debits the warehouse and keys its movement to the LINE.
      const whMv = await whMovements(rootStock.HOSP);
      const send = whMv[whMv.length - 1];
      expect(send.movement_type).toBe('dispatch_send');
      expect(Number(send.on_hand_delta)).toBe(-50);
      expect(send.reference_type).toBe('warehouse_dispatch_send');
      expect(send.reference_id).toBe(r.lineId);
      expect(send.organization_id).toBe(ORG_HOSP);
      expect(send.warehouse_id).toBe(WH_HOSP);

      // The RECEIVE side credits the outlet and carries the line link.
      const olMv = await olMovements(r.outletStockId);
      expect(olMv).toHaveLength(1);
      expect(olMv[0].movement_type).toBe('dispatch_receive');
      expect(Number(olMv[0].on_hand_delta)).toBe(50);
      expect(olMv[0].reason_code).toBe('received');
      expect(olMv[0].organization_id).toBe(ORG_HOSP);
      expect(olMv[0].distribution_point_id).toBe(PH_HOSP);
    });

    it('PASS hospital warehouse -> ER pharmacy (an emergency-context PHARMACY is ordinary)', async () => {
      await dispatchToOutlet('PH_HOSP_ER', WH_HOSP, rootStock.HOSP, PH_HOSP_ER,
        WO_HOSP, OO_PH_HOSP_ER, 40);
      expect(await olTotal(PH_HOSP_ER)).toBe(40);
    });

    it('PASS specialized centre warehouse -> centre pharmacy', async () => {
      await dispatchToOutlet('PH_SPEC', WH_SPEC, rootStock.SPEC, PH_SPEC,
        WO_SPEC, OO_PH_SPEC, 40);
      expect(await olTotal(PH_SPEC)).toBe(40);
    });

    it('PASS health-centre DEPOT -> centre pharmacy (the facility-bound corridor)', async () => {
      await dispatchToOutlet('PH_PRIMARY', DEPOT_PRIMARY, depotStock.PRIMARY, PH_PRIMARY,
        WO_PRIMARY, OO_PH_PRIMARY, 30);
      expect(await olTotal(PH_PRIMARY)).toBe(30);
    });

    it('PASS subordinate centre depot -> its pharmacy', async () => {
      await dispatchToOutlet('PH_SUBORD', DEPOT_SUBORD, depotStock.SUBORD, PH_SUBORD,
        WO_SUBORD, OO_PH_SUBORD, 20);
      expect(await olTotal(PH_SUBORD)).toBe(20);
    });

    it('conservation — every warehouse balance equals receipts minus dispatches', async () => {
      expect(await whQty(rootStock.HOSP)).toBe(110);      // 200 - 50 - 40
      expect(await whQty(rootStock.SPEC)).toBe(80);       // 120 - 40
      expect(await whQty(depotStock.PRIMARY)).toBe(60);   // 90 - 30
      expect(await whQty(depotStock.SUBORD)).toBe(40);    // 60 - 20
      const held = (await whQty(rootStock.HOSP)) + (await olTotal(PH_HOSP)) + (await olTotal(PH_HOSP_ER));
      expect(held, 'the hospital still holds all 200 it received').toBe(200);
    });

    it('REJECT an ordinary dispatch to an EMERGENCY outlet — before commissioning', async () => {
      // 180 made this permanent and unconditional: a crash cabinet or rescue
      // cart is reachable from a warehouse ONLY through initial provisioning,
      // never through the ordinary dispatch RPC. Proved here BEFORE §6 runs.
      await refusesWithNoDelta(
        'ordinary dispatch -> rescue cart',
        /emergency_outlet_requires_initial_provisioning/,
        () => rig.asUser(WO_HOSP, (c: any) =>
          call(c, 'phoenix_create_warehouse_dispatch',
            [WH_HOSP, RC_HOSP, 'R16-BAD-ORD-RC', null, null, null]), { commit: true }));

      await refusesWithNoDelta(
        'ordinary dispatch -> crash cabinet',
        /emergency_outlet_requires_initial_provisioning/,
        () => rig.asUser(WO_HOSP, (c: any) =>
          call(c, 'phoenix_create_warehouse_dispatch',
            [WH_HOSP, CC_HOSP, 'R16-BAD-ORD-CC', null, null, null]), { commit: true }));
    });

    it('REJECT a dispatch to an outlet paired with a DIFFERENT warehouse', async () => {
      await refusesWithNoDelta(
        'hospital warehouse -> specialized centre pharmacy',
        /destination_outlet_not_paired_with_this_warehouse|warehouse_and_destination_organization_mismatch/,
        () => rig.asUser(WO_HOSP, (c: any) =>
          call(c, 'phoenix_create_warehouse_dispatch',
            [WH_HOSP, PH_SPEC, 'R16-BAD-PAIR', null, null, null]), { commit: true }));
    });

    it('MODEL · an active NULL-warehouse pharmacy is DB-legal but structurally unservable', async () => {
      // 183 permits a hospital/specialized-centre PHARMACY with no owning
      // warehouse (it returns before the warehouse rules). This test does not
      // assume that shape is a defect — it MEASURES what the shape can do, so
      // the report can state the contract rather than guess it.
      const floating = uid();
      await asAdmin(
        `INSERT INTO distribution_points (id,organization_id,warehouse_id,name,name_ar,point_type,status)
         VALUES ($1,$2,NULL,'Floating Hospital Pharmacy','صيدلية عائمة','pharmacy','active')`,
        [floating, ORG_HOSP]);

      // It exists and is active — so the topology matrix really does allow it.
      const exists: any = await asAdmin(
        `SELECT status, warehouse_id FROM distribution_points WHERE id=$1`, [floating]);
      expect(exists.rows[0].status).toBe('active');
      expect(exists.rows[0].warehouse_id).toBeNull();

      // But no warehouse can dispatch to it: the pairing FK is warehouse-keyed,
      // so it can never receive custody from any warehouse in the system.
      await refusesWithNoDelta(
        'dispatch to a NULL-warehouse pharmacy',
        /destination_outlet_not_paired_with_this_warehouse|destination_outlet_not_found_or_inactive/,
        () => rig.asUser(WO_HOSP, (c: any) =>
          call(c, 'phoenix_create_warehouse_dispatch',
            [WH_HOSP, floating, 'R16-FLOAT', null, null, null]), { commit: true }));

      // And it can never be a replenishment source either: 164's context
      // resolver INNER JOINs through warehouses, so the row vanishes entirely.
      await refusesWithNoDelta(
        'replenishment route from a NULL-warehouse pharmacy',
        /source_outlet_not_found/,
        () => rig.asUser(IA_HOSP, (c: any) =>
          call(c, 'phoenix_upsert_outlet_replenishment_route',
            [null, floating, CC_HOSP, true, null]), { commit: true }));

      await asAdmin(`DELETE FROM distribution_points WHERE id=$1`, [floating]);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // §6 · EMERGENCY INITIAL PROVISIONING — the one-time commissioning lifecycle.
  // ════════════════════════════════════════════════════════════════════════
  describe('§6 · emergency initial provisioning', () => {
    it('PASS hospital warehouse -> RESCUE CART (emergency context)', async () => {
      const r = await dispatchToOutlet('RC_HOSP', WH_HOSP, rootStock.HOSP, RC_HOSP,
        WO_HOSP, OO_RC_HOSP, 20, { initial: true });
      expect(await olTotal(RC_HOSP)).toBe(20);

      // The receipt is what COMMISSIONS the outlet — the stamp is on the
      // dispatch header, not on the outlet, and only a POSITIVE receipt sets it.
      const d: any = await asAdmin(
        `SELECT is_initial_provisioning, initial_provisioning_consumed_at
           FROM warehouse_dispatches WHERE id=$1`, [r.dispatchId]);
      expect(d.rows[0].is_initial_provisioning).toBe(true);
      expect(d.rows[0].initial_provisioning_consumed_at).not.toBeNull();
    });

    it('PASS hospital warehouse -> ward CRASH CABINET (non-emergency context)', async () => {
      await dispatchToOutlet('CC_HOSP', WH_HOSP, rootStock.HOSP, CC_HOSP,
        WO_HOSP, OO_CC_HOSP, 15, { initial: true });
      expect(await olTotal(CC_HOSP)).toBe(15);
    });

    it('PASS specialized centre -> its crash cabinet', async () => {
      await dispatchToOutlet('CC_SPEC', WH_SPEC, rootStock.SPEC, CC_SPEC,
        WO_SPEC, OO_CC_SPEC, 15, { initial: true });
      expect(await olTotal(CC_SPEC)).toBe(15);
    });

    it('PASS health-centre depot -> its crash cabinet (emergency context — the inversion)', async () => {
      await dispatchToOutlet('CC_PRIMARY', DEPOT_PRIMARY, depotStock.PRIMARY, CC_PRIMARY,
        WO_PRIMARY, OO_CC_PRIMARY, 10, { initial: true });
      expect(await olTotal(CC_PRIMARY)).toBe(10);
    });

    it('REJECT a SECOND initial provisioning for an already-commissioned outlet', async () => {
      await refusesWithNoDelta(
        'second initial provisioning',
        /initial_provisioning_already_exists_for_outlet/,
        () => rig.asUser(WO_HOSP, (c: any) =>
          call(c, 'phoenix_create_initial_provisioning_dispatch',
            [WH_HOSP, RC_HOSP, 'R16-IP-AGAIN', null, null, null]), { commit: true }));
    });

    it('REJECT initial provisioning aimed at an ordinary PHARMACY', async () => {
      await refusesWithNoDelta(
        'initial provisioning -> pharmacy',
        /initial_provisioning_requires_emergency_outlet/,
        () => rig.asUser(WO_HOSP, (c: any) =>
          call(c, 'phoenix_create_initial_provisioning_dispatch',
            [WH_HOSP, PH_HOSP, 'R16-IP-PHARM', null, null, null]), { commit: true }));
    });

    it('REJECT an ordinary dispatch to an emergency outlet AFTER commissioning too', async () => {
      // The bar is permanent — commissioning does not open the ordinary door.
      await refusesWithNoDelta(
        'ordinary dispatch -> commissioned rescue cart',
        /emergency_outlet_requires_initial_provisioning/,
        () => rig.asUser(WO_HOSP, (c: any) =>
          call(c, 'phoenix_create_warehouse_dispatch',
            [WH_HOSP, RC_HOSP, 'R16-BAD-ORD-RC2', null, null, null]), { commit: true }));
    });

    it('REJECT provisioning an outlet from a FOREIGN warehouse', async () => {
      await refusesWithNoDelta(
        'specialized warehouse -> hospital crash cabinet',
        /destination_outlet_not_paired_with_this_warehouse|warehouse_and_destination_organization_mismatch/,
        () => rig.asUser(WO_SPEC, (c: any) =>
          call(c, 'phoenix_create_initial_provisioning_dispatch',
            [WH_SPEC, CC_HOSP, 'R16-BAD-IP-X', null, null, null]), { commit: true }));
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // §7 · EMERGENCY REPLENISHMENT — pharmacy OUTLET -> emergency OUTLET.
  //
  // The routine corridor is outlet-to-outlet and debits the SOURCE PHARMACY's
  // own custody. No warehouse participates: 180 forbids that permanently.
  // ════════════════════════════════════════════════════════════════════════
  const routes: Record<string, string> = {};

  describe('§7 · emergency replenishment', () => {
    const makeRoute = async (label: string, admin: string, src: string, dst: string) => {
      const r = await rig.asUser(admin, (c: any) =>
        call(c, 'phoenix_upsert_outlet_replenishment_route',
          [null, src, dst, true, null]), { commit: true });
      expect(r.ok, `${label}: route`).toBe(true);
      expect(r.is_active).toBe(true);
      routes[label] = r.route_id;
      return r.route_id;
    };

    /** One replenishment leg, with both outlet balances asserted either side. */
    const replenish = async (
      label: string, admin: string, routeId: string, srcStockId: string,
      srcPoint: string, dstPoint: string, qty: number,
    ) => {
      const beforeSrc = await olTotal(srcPoint);
      const beforeDst = await olTotal(dstPoint);
      const requestId = randomUUID();

      const r = await rig.asUser(admin, (c: any) =>
        call(c, 'phoenix_replenish_emergency_outlet',
          [requestId, routeId, srcStockId, qty, null, null]), { commit: true });
      expect(r.ok, `${label}: replenish`).toBe(true);
      expect(r.idempotent_replay, `${label}: first call is not a replay`).toBe(false);
      expect(Number(r.quantity)).toBe(qty);

      expect(await olTotal(srcPoint), `${label}: source pharmacy debited`).toBe(beforeSrc - qty);
      expect(await olTotal(dstPoint), `${label}: emergency outlet credited`).toBe(beforeDst + qty);
      return { requestId, result: r };
    };

    it('PASS hospital ER pharmacy -> RESCUE CART, with paired movements', async () => {
      const routeId = await makeRoute('ER_RC', IA_HOSP, PH_HOSP_ER, RC_HOSP);
      const { requestId, result } = await replenish(
        'ER->RC', IA_HOSP, routeId, outletStock.PH_HOSP_ER, PH_HOSP_ER, RC_HOSP, 10);

      // Two legs, one request, one correlation — the send and the receive.
      const legs: any = await asAdmin(
        `SELECT movement_type, on_hand_delta, reason_code, reference_type, correlation_id
           FROM outlet_stock_movements
          WHERE reference_type='outlet_replenishment' AND reference_id=$1
          ORDER BY movement_type`, [requestId]);
      expect(legs.rows).toHaveLength(2);
      expect(legs.rows.map((r: any) => r.movement_type))
        .toEqual(['replenish_receive', 'replenish_send']);
      expect(Number(legs.rows[0].on_hand_delta)).toBe(10);
      expect(Number(legs.rows[1].on_hand_delta)).toBe(-10);
      expect(legs.rows[0].reason_code).toBe('transferred');
      expect(legs.rows[0].correlation_id).toBe(legs.rows[1].correlation_id);
      expect(result.destination_outlet_stock_id).toBeTruthy();
    });

    it('replay of the same request_id is idempotent and moves nothing further', async () => {
      const routeId = routes.ER_RC;
      const requestId = randomUUID();
      await rig.asUser(IA_HOSP, (c: any) =>
        call(c, 'phoenix_replenish_emergency_outlet',
          [requestId, routeId, outletStock.PH_HOSP_ER, 4, null, null]), { commit: true });

      const afterFirst = await olTotal(RC_HOSP);
      const before = await census();
      const replay = await rig.asUser(IA_HOSP, (c: any) =>
        call(c, 'phoenix_replenish_emergency_outlet',
          [requestId, routeId, outletStock.PH_HOSP_ER, 4, null, null]), { commit: true });
      expect(replay.ok).toBe(true);
      expect(replay.idempotent_replay, 'the second call must be a replay').toBe(true);
      expect(await olTotal(RC_HOSP), 'a replay credits nothing further').toBe(afterFirst);
      expect(await census(), 'a replay changes no system state').toEqual(before);
    });

    it('REJECT the same request_id carrying a DIFFERENT payload', async () => {
      const requestId = randomUUID();
      await rig.asUser(IA_HOSP, (c: any) =>
        call(c, 'phoenix_replenish_emergency_outlet',
          [requestId, routes.ER_RC, outletStock.PH_HOSP_ER, 3, null, null]), { commit: true });

      await refusesWithNoDelta(
        'request_id reused with a different quantity',
        /request_id_conflict/,
        () => rig.asUser(IA_HOSP, (c: any) =>
          call(c, 'phoenix_replenish_emergency_outlet',
            [requestId, routes.ER_RC, outletStock.PH_HOSP_ER, 9, null, null]), { commit: true }));
    });

    it('PASS hospital ward pharmacy -> ward CRASH CABINET (non-emergency context)', async () => {
      const routeId = await makeRoute('PH_CC', IA_HOSP, PH_HOSP, CC_HOSP);
      await replenish('PH->CC', IA_HOSP, routeId, outletStock.PH_HOSP, PH_HOSP, CC_HOSP, 8);
    });

    it('PASS specialized centre pharmacy -> its crash cabinet', async () => {
      // The specialized-centre path is NOT assumed from the brief: 180's
      // ELSE arm imposes only the non_emergency context rule and never a class
      // test, so a specialized centre crash cabinet IS a legal destination.
      const routeId = await makeRoute('SPEC_CC', IA_SPEC, PH_SPEC, CC_SPEC);
      await replenish('SPEC->CC', IA_SPEC, routeId, outletStock.PH_SPEC, PH_SPEC, CC_SPEC, 8);
    });

    it('PASS health-centre pharmacy -> its own crash cabinet', async () => {
      const routeId = await makeRoute('HC_CC', IA_SECTOR, PH_PRIMARY, CC_PRIMARY);
      await replenish('HC->CC', IA_SECTOR, routeId, outletStock.PH_PRIMARY, PH_PRIMARY, CC_PRIMARY, 6);
    });

    it('REJECT a CROSS-FACILITY route inside one health sector', async () => {
      await refusesWithNoDelta(
        'primary centre pharmacy -> subordinate centre cabinet',
        /cross_facility_route_forbidden/,
        () => rig.asUser(IA_SECTOR, (c: any) =>
          call(c, 'phoenix_upsert_outlet_replenishment_route',
            [null, PH_PRIMARY, CC_SUBORD, true, null]), { commit: true }));
    });

    it('REJECT a CROSS-ORGANIZATION route', async () => {
      await refusesWithNoDelta(
        'hospital pharmacy -> specialized centre cabinet',
        /cross_organization_route_forbidden|source_outlet_not_found|destination_outlet_not_found/,
        () => rig.asUser(IA_HOSP, (c: any) =>
          call(c, 'phoenix_upsert_outlet_replenishment_route',
            [null, PH_HOSP, CC_SPEC, true, null]), { commit: true }));
    });

    it('REJECT a route whose SOURCE is not a pharmacy', async () => {
      await refusesWithNoDelta(
        'crash cabinet as a replenishment source',
        /source_must_be_pharmacy/,
        () => rig.asUser(IA_HOSP, (c: any) =>
          call(c, 'phoenix_upsert_outlet_replenishment_route',
            [null, CC_HOSP, RC_HOSP, true, null]), { commit: true }));
    });

    it('REJECT a route whose DESTINATION is an ordinary pharmacy', async () => {
      await refusesWithNoDelta(
        'pharmacy as a replenishment destination',
        /destination_must_be_emergency_outlet/,
        () => rig.asUser(IA_HOSP, (c: any) =>
          call(c, 'phoenix_upsert_outlet_replenishment_route',
            [null, PH_HOSP_ER, PH_HOSP, true, null]), { commit: true }));
    });

    it('REJECT replenishing an UNCOMMISSIONED emergency outlet', async () => {
      // CC_SUBORD is legal in every topological respect and has a legal route;
      // the ONLY thing missing is a consumed initial-provisioning lifecycle.
      const routeId = await rig.asUser(IA_SECTOR, (c: any) =>
        call(c, 'phoenix_upsert_outlet_replenishment_route',
          [null, PH_SUBORD, CC_SUBORD, true, null]), { commit: true });
      expect(routeId.ok).toBe(true);

      await refusesWithNoDelta(
        'replenish before commissioning',
        /initial_provisioning_required_before_replenishment/,
        () => rig.asUser(IA_SECTOR, (c: any) =>
          call(c, 'phoenix_replenish_emergency_outlet',
            [randomUUID(), routeId.route_id, outletStock.PH_SUBORD, 5, null, null]),
          { commit: true }));
    });

    it('REJECT an unauthorized role driving replenishment — the outlet officer cannot', async () => {
      // outlet_officer does NOT hold `outlet_stock.replenish` by default, and
      // this file writes zero permission overrides, so the refusal is canonical.
      await refusesWithNoDelta(
        'outlet officer replenishing',
        /forbidden_outlet_stock_replenish/,
        () => rig.asUser(OO_PH_HOSP_ER, (c: any) =>
          call(c, 'phoenix_replenish_emergency_outlet',
            [randomUUID(), routes.ER_RC, outletStock.PH_HOSP_ER, 2, null, null]),
          { commit: true }));
    });

    it('REJECT a FOREIGN organization admin driving another institution\'s route', async () => {
      await refusesWithNoDelta(
        'specialized admin on the hospital route',
        /forbidden_outlet_stock_replenish/,
        () => rig.asUser(IA_SPEC, (c: any) =>
          call(c, 'phoenix_replenish_emergency_outlet',
            [randomUUID(), routes.ER_RC, outletStock.PH_HOSP_ER, 2, null, null]),
          { commit: true }));
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // §8 · PATIENT / TERMINAL DISPENSING — custody leaves the system.
  // ════════════════════════════════════════════════════════════════════════
  describe('§8 · patient / terminal dispensing', () => {
    const dispense = async (
      label: string, officer: string, stockId: string, point: string, qty: number,
    ) => {
      const before = await olTotal(point);
      const requestId = randomUUID();
      const r = await rig.asUser(officer, (c: any) =>
        call(c, 'phoenix_dispense_outlet_stock',
          [requestId, stockId, qty, `R16 dispense ${label}`, null]), { commit: true });
      expect(r.ok, `${label}: dispense`).toBe(true);
      expect(Number(r.quantity_delta), `${label}: delta is negative`).toBe(-qty);
      expect(await olTotal(point), `${label}: outlet debited`).toBe(before - qty);
      return { requestId, result: r };
    };

    it('PASS dispensing from an ordinary hospital pharmacy', async () => {
      const { requestId } = await dispense('PH_HOSP', OO_PH_HOSP, outletStock.PH_HOSP, PH_HOSP, 12);

      const mv: any = await asAdmin(
        `SELECT movement_type, reason_code, on_hand_delta, reference_type, distribution_point_id
           FROM outlet_stock_movements
          WHERE reference_type='outlet_request' AND reference_id=$1`, [requestId]);
      expect(mv.rows).toHaveLength(1);
      expect(mv.rows[0].movement_type).toBe('dispense');
      expect(mv.rows[0].reason_code).toBe('dispensed');
      expect(Number(mv.rows[0].on_hand_delta)).toBe(-12);
      expect(mv.rows[0].distribution_point_id).toBe(PH_HOSP);
    });

    it('PASS dispensing from an ER pharmacy', async () => {
      await dispense('PH_HOSP_ER', OO_PH_HOSP_ER, outletStock.PH_HOSP_ER, PH_HOSP_ER, 5);
    });

    it('PASS dispensing from a RESCUE CART', async () => {
      await dispense('RC_HOSP', OO_RC_HOSP, outletStock.RC_HOSP, RC_HOSP, 5);
    });

    it('PASS dispensing from a CRASH CABINET', async () => {
      await dispense('CC_HOSP', OO_CC_HOSP, outletStock.CC_HOSP, CC_HOSP, 3);
    });

    it('PASS dispensing from a health-centre pharmacy', async () => {
      await dispense('PH_PRIMARY', OO_PH_PRIMARY, outletStock.PH_PRIMARY, PH_PRIMARY, 4);
    });

    it('a dispense is TERMINAL — it can never exceed what is actually held', async () => {
      const held = await olTotal(PH_SUBORD);
      await refusesWithNoDelta(
        'dispensing more than the outlet holds',
        /outlet_quantity_cannot_go_negative/,
        () => rig.asUser(OO_PH_SUBORD, (c: any) =>
          call(c, 'phoenix_dispense_outlet_stock',
            [randomUUID(), outletStock.PH_SUBORD, held + 1, 'over-dispense', null]),
          { commit: true }));
    });

    it('REJECT an outlet officer dispensing from ANOTHER outlet', async () => {
      await refusesWithNoDelta(
        'subordinate officer dispensing from the primary centre',
        /forbidden_outlet_stock_dispense/,
        () => rig.asUser(OO_PH_SUBORD, (c: any) =>
          call(c, 'phoenix_dispense_outlet_stock',
            [randomUUID(), outletStock.PH_PRIMARY, 1, 'cross-outlet', null]),
          { commit: true }));
    });

    it('REJECT a warehouse officer dispensing at all — the role holds no dispense key', async () => {
      await refusesWithNoDelta(
        'warehouse officer dispensing',
        /forbidden_outlet_stock_dispense/,
        () => rig.asUser(WO_HOSP, (c: any) =>
          call(c, 'phoenix_dispense_outlet_stock',
            [randomUUID(), outletStock.PH_HOSP, 1, 'wrong role', null]), { commit: true }));
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // §9 · OUTLET RETURN — outlet -> its own owning warehouse, full lifecycle.
  //
  // The four steps are deliberately split across TWO roles: the outlet officer
  // requests and physically sends; the warehouse officer reviews and receives.
  // That split is the canonical default, not a convenience.
  // ════════════════════════════════════════════════════════════════════════
  describe('§9 · outlet return', () => {
    /** request -> add line -> submit -> review -> send -> receive. */
    const outletReturn = async (
      label: string, point: string, officer: string, warehouseOfficer: string,
      dispatchLineId: string, qty: number, reasonCode: string,
      disposition: string | null,
    ) => {
      const num = `R16-ORET-${label}`;
      const beforeOutlet = await olTotal(point);

      const req = await rig.asUser(officer, (c: any) =>
        call(c, 'phoenix_request_outlet_return', [point, num, null]), { commit: true });
      expect(req.ok, `${label}: request`).toBe(true);

      const line = await rig.asUser(officer, (c: any) =>
        call(c, 'phoenix_add_outlet_return_request_line',
          [req.return_request_id, dispatchLineId, qty, reasonCode, `R16 ${label}`, randomUUID()]),
        { commit: true });
      expect(line.ok, `${label}: line`).toBe(true);

      await rig.asUser(officer, (c: any) =>
        call(c, 'phoenix_submit_outlet_return_request', [req.return_request_id]), { commit: true });

      // REVIEW is warehouse-side: `outlet_stock.review_return` is a
      // warehouse_officer default, and the outlet officer does not hold it.
      await rig.asUser(warehouseOfficer, (c: any) =>
        call(c, 'phoenix_review_outlet_return_request',
          [req.return_request_id,
           JSON.stringify([{ line_id: line.return_request_line_id, approved_quantity: qty }])]),
        { commit: true });

      // SEND is outlet-side again: `outlet_stock.return` belongs to the officer
      // who physically holds the stock.
      // p_shipment_id NULL means "open a new shipment under this number";
      // passing an unknown uuid instead looks one up and earns
      // `outlet_return_shipment_not_open`.
      const sent = await rig.asUser(officer, (c: any) =>
        call(c, 'phoenix_send_outlet_return_shipment_line',
          [randomUUID(), line.return_request_line_id, null, qty,
           `${num}-SHP`, null, null]), { commit: true });
      expect(sent.ok, `${label}: send`).toBe(true);
      expect(await olTotal(point), `${label}: outlet debited on send`).toBe(beforeOutlet - qty);

      const received = await rig.asUser(warehouseOfficer, (c: any) =>
        call(c, 'phoenix_receive_outlet_return_shipment_line',
          [randomUUID(), sent.shipment_line_id, qty, null, null, disposition]),
        { commit: true });
      expect(received.ok, `${label}: receive`).toBe(true);

      return { requestId: req.return_request_id, lineId: line.return_request_line_id,
               sent, received };
    };

    it('PASS a restockable EXCESS return lands back in warehouse custody', async () => {
      const beforeWh = await whQty(rootStock.HOSP);
      const r = await outletReturn('EXCESS', PH_HOSP, OO_PH_HOSP, WO_HOSP,
        outletLine.PH_HOSP, 6, 'excess', 'restockable');

      expect(r.received.disposition, 'excess + explicit decision = restockable').toBe('restockable');
      expect(r.received.warehouse_stock_id).toBeTruthy();
      expect(r.received.quarantine_stock_id).toBeNull();
      expect(await whQty(rootStock.HOSP), 'warehouse re-credited').toBe(beforeWh + 6);
    });

    it('the request line carries REAL provenance, not fabricated ids', async () => {
      const p: any = await asAdmin(
        `SELECT l.original_dispatch_line_id, l.original_inbound_movement_id,
                l.source_outlet_stock_id, l.original_inbound_movement_type, l.reason_code
           FROM outlet_return_request_lines l
           JOIN outlet_return_requests r ON r.id = l.return_request_id
          WHERE r.return_number = 'R16-ORET-EXCESS'`);
      expect(p.rows).toHaveLength(1);
      const row = p.rows[0];
      expect(row.original_dispatch_line_id, 'provenance is the real dispatch line')
        .toBe(outletLine.PH_HOSP);
      expect(row.source_outlet_stock_id, 'provenance is the real outlet lot')
        .toBe(outletStock.PH_HOSP);
      expect(row.original_inbound_movement_type).toBe('dispatch_receive');

      // The inbound movement must be the ACTUAL receive that created the stock.
      const mv: any = await asAdmin(
        `SELECT movement_type, outlet_stock_id FROM outlet_stock_movements WHERE id=$1`,
        [row.original_inbound_movement_id]);
      expect(mv.rows[0].movement_type).toBe('dispatch_receive');
      expect(mv.rows[0].outlet_stock_id).toBe(outletStock.PH_HOSP);
    });

    it('PASS a DAMAGED return is forced into quarantine, no decision offered', async () => {
      const beforeWh = await whQty(rootStock.HOSP);
      const beforeQ = await quarantineTotal(WH_HOSP);
      // Disposition is passed as 'restockable' ON PURPOSE: a mandatory-quarantine
      // reason must OVERRIDE the operator's decision, not defer to it.
      const r = await outletReturn('DAMAGED', PH_HOSP, OO_PH_HOSP, WO_HOSP,
        outletLine.PH_HOSP, 5, 'damaged', 'restockable');

      expect(r.received.disposition, 'damaged is mandatory quarantine').toBe('quarantined');
      expect(r.received.quarantine_stock_id).toBeTruthy();
      expect(r.received.warehouse_stock_id).toBeNull();
      expect(await whQty(rootStock.HOSP), 'ordinary custody untouched').toBe(beforeWh);
      expect(await quarantineTotal(WH_HOSP), 'quarantine custody credited').toBe(beforeQ + 5);

      const q: any = await asAdmin(
        `SELECT quarantine_reason, quantity FROM warehouse_quarantine_stock WHERE id=$1`,
        [r.received.quarantine_stock_id]);
      expect(q.rows[0].quarantine_reason).toBe('damaged');
    });

    it('REJECT returning MORE than the outlet actually received on that line', async () => {
      const req = await rig.asUser(OO_PH_SUBORD, (c: any) =>
        call(c, 'phoenix_request_outlet_return', [PH_SUBORD, 'R16-ORET-OVER', null]),
        { commit: true });
      await refusesWithNoDelta(
        'return exceeding the dispatch-line cap',
        /requested_quantity_exceeds_returnable_cap|requested_quantity_exceeds_current_availability/,
        () => rig.asUser(OO_PH_SUBORD, (c: any) =>
          call(c, 'phoenix_add_outlet_return_request_line',
            [req.return_request_id, outletLine.PH_SUBORD, 9999, 'excess', 'over', randomUUID()]),
          { commit: true }));
    });

    it('REJECT an outlet officer returning against ANOTHER outlet\'s dispatch line', async () => {
      const req = await rig.asUser(OO_PH_SUBORD, (c: any) =>
        call(c, 'phoenix_request_outlet_return', [PH_SUBORD, 'R16-ORET-XOUT', null]),
        { commit: true });
      await refusesWithNoDelta(
        'foreign dispatch line as provenance',
        /original_dispatch_line_not_at_this_outlet/,
        () => rig.asUser(OO_PH_SUBORD, (c: any) =>
          call(c, 'phoenix_add_outlet_return_request_line',
            [req.return_request_id, outletLine.PH_PRIMARY, 2, 'excess', 'x', randomUUID()]),
          { commit: true }));
    });

    it('REJECT a cross-organization actor opening a return at a foreign outlet', async () => {
      await refusesWithNoDelta(
        'foreign officer opening a return',
        /forbidden_outlet_return_request/,
        () => rig.asUser(OO_FOREIGN, (c: any) =>
          call(c, 'phoenix_request_outlet_return', [PH_HOSP, 'R16-ORET-FOREIGN', null]),
          { commit: true }));
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // §10 · WAREHOUSE RETURN — institution roots to central, depot to its sector.
  // ════════════════════════════════════════════════════════════════════════
  describe('§10 · warehouse return', () => {
    const warehouseReturn = async (
      label: string, srcWh: string, dstWh: string, sender: string, receiver: string,
      transferLineId: string, qty: number, reasonCode: string, disposition: string | null,
    ) => {
      const num = `R16-WRET-${label}`;
      const req = await rig.asUser(sender, (c: any) =>
        call(c, 'phoenix_request_direct_warehouse_return', [srcWh, dstWh, num, null]),
        { commit: true });
      expect(req.ok, `${label}: request`).toBe(true);

      const line = await rig.asUser(sender, (c: any) =>
        call(c, 'phoenix_add_direct_warehouse_return_request_line',
          [req.return_request_id, transferLineId, qty, reasonCode, `R16 ${label}`]),
        { commit: true });
      expect(line.ok, `${label}: line`).toBe(true);

      await rig.asUser(sender, (c: any) =>
        call(c, 'phoenix_submit_warehouse_return_request', [req.return_request_id]),
        { commit: true });

      await rig.asUser(receiver, (c: any) =>
        call(c, 'phoenix_review_warehouse_return_request',
          [req.return_request_id,
           JSON.stringify([{ line_id: line.return_request_line_id, approved_quantity: qty }])]),
        { commit: true });

      const sent = await rig.asUser(sender, (c: any) =>
        call(c, 'phoenix_send_direct_warehouse_return_shipment_line',
          [randomUUID(), line.return_request_line_id, qty, `${num}-SHP`, null, null]),
        { commit: true });
      expect(sent.ok, `${label}: send`).toBe(true);

      const received = await rig.asUser(receiver, (c: any) =>
        call(c, 'phoenix_receive_warehouse_return_shipment_line',
          [randomUUID(), sent.shipment_line_id, qty, null, null, disposition]),
        { commit: true });
      expect(received.ok, `${label}: receive`).toBe(true);
      return { requestId: req.return_request_id, sent, received };
    };

    it('PASS hospital root -> CENTRAL with real forward provenance', async () => {
      const beforeSrc = await whQty(rootStock.HOSP);
      const beforeDst = await whQty(centralIntake.stockId);
      const r = await warehouseReturn('HOSP', WH_HOSP, WH_CENTRAL, WO_HOSP, CWM,
        rootLine.HOSP, 10, 'excess', 'restockable');

      expect(r.received.disposition).toBe('restockable');
      expect(await whQty(rootStock.HOSP), 'source debited').toBe(beforeSrc - 10);
      expect(await whTotal(WH_CENTRAL), 'central re-credited').toBe(beforeDst + 10);
    });

    it('PASS specialized centre root -> CENTRAL', async () => {
      const before = await whQty(rootStock.SPEC);
      await warehouseReturn('SPEC', WH_SPEC, WH_CENTRAL, WO_SPEC, CWM,
        rootLine.SPEC, 8, 'excess', 'restockable');
      expect(await whQty(rootStock.SPEC)).toBe(before - 8);
    });

    it('PASS health-sector MAIN -> CENTRAL', async () => {
      const before = await whQty(rootStock.SECTOR);
      await warehouseReturn('SECTOR', SECTOR_MAIN, WH_CENTRAL, WO_SECTOR, CWM,
        rootLine.SECTOR, 5, 'excess', 'restockable');
      expect(await whQty(rootStock.SECTOR)).toBe(before - 5);
    });

    it('PASS health-centre DEPOT -> its own Sector Main (Branch B, not central)', async () => {
      const beforeDepot = await whQty(depotStock.PRIMARY);
      const beforeMain = await whQty(rootStock.SECTOR);
      // The RECEIVING side of a return needs `warehouse_transfer.review_return`
      // and `.return_receive` — both central_warehouse_manager defaults, both
      // FALSE for warehouse_officer. So the sector's own CWM closes the loop,
      // exactly as the central store does on the external corridor.
      await warehouseReturn('DEPOT', DEPOT_PRIMARY, SECTOR_MAIN, WO_PRIMARY, CWM_SECTOR,
        depotLine.PRIMARY, 7, 'excess', 'restockable');

      expect(await whQty(depotStock.PRIMARY), 'depot debited').toBe(beforeDepot - 7);
      expect(await whTotal(SECTOR_MAIN), 'sector main re-credited').toBe(beforeMain + 7);
    });

    it('PASS a RECALLED-reason warehouse return is forced into quarantine', async () => {
      const beforeQ = await quarantineTotal(WH_CENTRAL);
      const r = await warehouseReturn('QUAR', WH_HOSP, WH_CENTRAL, WO_HOSP, CWM,
        rootLine.HOSP, 4, 'damaged', 'restockable');
      expect(r.received.disposition, 'damaged overrides the operator').toBe('quarantined');
      expect(await quarantineTotal(WH_CENTRAL)).toBe(beforeQ + 4);
    });

    it('REJECT a health-centre depot returning DIRECTLY to central', async () => {
      await refusesWithNoDelta(
        'depot -> central return',
        /central_return_source_must_not_be_facility_bound/,
        () => rig.asUser(WO_PRIMARY, (c: any) =>
          call(c, 'phoenix_request_direct_warehouse_return',
            [DEPOT_PRIMARY, WH_CENTRAL, 'R16-WRET-BAD-DIRECT', null]), { commit: true }));
    });

    it('REJECT a depot returning to a SIBLING depot', async () => {
      await refusesWithNoDelta(
        'primary depot -> subordinate depot return',
        /no_direct_forward_provenance_between_warehouses|destination_must_be_active_central_warehouse|central_return_source_must_not_be_facility_bound/,
        () => rig.asUser(WO_PRIMARY, (c: any) =>
          call(c, 'phoenix_request_direct_warehouse_return',
            [DEPOT_PRIMARY, DEPOT_SUBORD, 'R16-WRET-BAD-SIB', null]), { commit: true }));
    });

    it('REJECT a return corridor with NO forward provenance at all', async () => {
      // ORG_HOSP2 never received anything from central, so no corridor exists.
      await refusesWithNoDelta(
        'return without a delivering transfer',
        /no_direct_forward_provenance_between_warehouses/,
        () => rig.asUser(WO_FOREIGN, (c: any) =>
          call(c, 'phoenix_request_direct_warehouse_return',
            [SECTOR2_MAIN, WH_CENTRAL, 'R16-WRET-NOPROV', null]), { commit: true }));
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // §11 · RECALL PROPAGATION — obligations follow CURRENT custody.
  //
  // A recall is authorized ONCE, at the origin, and then materializes return
  // obligations against every downstream holder. It must move zero stock.
  // ════════════════════════════════════════════════════════════════════════
  describe('§11 · recall propagation', () => {
    /** Stock + movement census only — a recall MAY create return rows. */
    const physical = physicalLedger;

    it('PASS a recall down the full chain creates obligations and moves NOTHING', async () => {
      const before = await physical();

      // The ORIGIN authorizes: central sent this line, so the central store's
      // manager is the one entitled to recall it. Downstream holders are never
      // re-checked — that is the whole point of an origin-anchored recall.
      const r = await rig.asUser(CWM, (c: any) =>
        call(c, 'phoenix_recall_warehouse_transfer_line',
          [rootLine.SECTOR, 'R16-RECALL-CHAIN', 'R1.6 chain recall']), { commit: true });
      expect(r.ok).toBe(true);
      expect(Number(r.obligations_created), 'the chain has live holders').toBeGreaterThan(0);

      expect(await physical(), 'a recall moves no physical custody whatsoever')
        .toEqual(before);

      // The response is deliberately non-revealing: counts only, no holder ids.
      expect(Object.keys(r).sort())
        .toEqual(['obligations_created', 'obligations_reused', 'ok', 'return_number']);
    });

    it('the obligations landed on the REAL current holders, sender-side and recalled', async () => {
      const w: any = await asAdmin(`
        SELECT r.source_warehouse_id, r.destination_warehouse_id, r.requested_by_side,
               r.status, l.reason_code, l.requested_quantity
          FROM warehouse_return_requests r
          JOIN warehouse_return_request_lines l ON l.return_request_id = r.id
         WHERE r.return_number = 'R16-RECALL-CHAIN'
         ORDER BY r.source_warehouse_id`);
      expect(w.rows.length, 'at least the sector main and its depot').toBeGreaterThan(0);
      for (const row of w.rows) {
        expect(row.requested_by_side, 'a recall is SENDER-initiated').toBe('sender');
        expect(row.status).toBe('draft');
        expect(row.reason_code, 'recall lines are always `recalled`').toBe('recalled');
        expect(Number(row.requested_quantity)).toBeGreaterThan(0);
      }
      // The corridor is the exact reverse of the delivering transfer.
      const sources = w.rows.map((x: any) => x.source_warehouse_id);
      expect(sources, 'the sector main is a holder').toContain(SECTOR_MAIN);

      // And the OUTLET holders at the end of the chain are obliged too. BOTH
      // the centre pharmacy and the centre crash cabinet were filled from the
      // same depot lot, so the recall must reach both — which is exactly why
      // this asserts a SET rather than a single row.
      const o: any = await asAdmin(`
        SELECT r.distribution_point_id, r.requested_by_side, l.reason_code,
               l.original_dispatch_line_id, l.source_outlet_stock_id
          FROM outlet_return_requests r
          JOIN outlet_return_request_lines l ON l.return_request_id = r.id
         WHERE r.return_number = 'R16-RECALL-CHAIN'`);
      expect(o.rows.length, 'the health-centre outlets hold recalled stock').toBeGreaterThan(0);
      for (const row of o.rows) {
        expect(row.requested_by_side).toBe('sender');
        expect(row.reason_code).toBe('recalled');
      }
      expect(o.rows.map((x: any) => x.distribution_point_id),
        'the centre pharmacy is obliged').toContain(PH_PRIMARY);

      // Provenance is REAL, not fabricated: for every obligation the cited
      // dispatch line must be the one that actually produced the cited lot.
      for (const row of o.rows) {
        const dl: any = await asAdmin(
          `SELECT resulting_outlet_stock_id FROM warehouse_dispatch_lines WHERE id=$1`,
          [row.original_dispatch_line_id]);
        expect(dl.rows, 'the cited dispatch line exists').toHaveLength(1);
        expect(dl.rows[0].resulting_outlet_stock_id,
          'the dispatch line really produced the lot being recalled')
          .toBe(row.source_outlet_stock_id);
      }
    });

    it('a recalled unit that is physically returned MUST land in quarantine', async () => {
      // Drive the real return lifecycle off the recall obligation the previous
      // test created at the health-centre pharmacy.
      const req: any = await asAdmin(`
        SELECT r.id AS request_id, l.id AS line_id, l.requested_quantity
          FROM outlet_return_requests r
          JOIN outlet_return_request_lines l ON l.return_request_id = r.id
         WHERE r.return_number = 'R16-RECALL-CHAIN'
           AND r.distribution_point_id = $1 LIMIT 1`, [PH_PRIMARY]);
      const { request_id, line_id } = req.rows[0];
      const qty = Math.min(Number(req.rows[0].requested_quantity), 3);

      // A sender-side recall is submitted under outlet_stock.recall at the
      // destination warehouse derived from this exact selected obligation.
      await rig.asUser(WO_PRIMARY, (c: any) =>
        call(c, 'phoenix_submit_outlet_return_request', [request_id]), { commit: true });
      await rig.asUser(WO_PRIMARY, (c: any) =>
        call(c, 'phoenix_review_outlet_return_request',
          [request_id, JSON.stringify([{ line_id, approved_quantity: qty }])]), { commit: true });

      const beforeQ = await quarantineTotal(DEPOT_PRIMARY);
      const sent = await rig.asUser(OO_PH_PRIMARY, (c: any) =>
        call(c, 'phoenix_send_outlet_return_shipment_line',
          [randomUUID(), line_id, null, qty, 'R16-RECALL-SHP', null, null]), { commit: true });
      expect(sent.ok).toBe(true);

      // 'restockable' is offered deliberately and must be ignored.
      const received = await rig.asUser(WO_PRIMARY, (c: any) =>
        call(c, 'phoenix_receive_outlet_return_shipment_line',
          [randomUUID(), sent.shipment_line_id, qty, null, null, 'restockable']),
        { commit: true });
      expect(received.disposition, 'recalled is mandatory quarantine').toBe('quarantined');
      expect(received.warehouse_stock_id).toBeNull();
      expect(await quarantineTotal(DEPOT_PRIMARY)).toBe(beforeQ + qty);

      const q: any = await asAdmin(
        `SELECT quarantine_reason FROM warehouse_quarantine_stock WHERE id=$1`,
        [received.quarantine_stock_id]);
      expect(q.rows[0].quarantine_reason).toBe('recalled');
    });

    it('PASS a HOSPITAL direct-holder recall — not only through health-sector topology', async () => {
      const before = await physical();
      const r = await rig.asUser(CWM, (c: any) =>
        call(c, 'phoenix_recall_warehouse_transfer_line',
          [rootLine.HOSP, 'R16-RECALL-HOSP', 'hospital recall']), { commit: true });
      expect(r.ok).toBe(true);
      expect(await physical(), 'still zero physical movement').toEqual(before);

      const holders: any = await asAdmin(`
        SELECT count(*)::int AS n FROM warehouse_return_requests
         WHERE return_number='R16-RECALL-HOSP' AND source_warehouse_id=$1`, [WH_HOSP]);
      expect(holders.rows[0].n, 'the hospital root is a direct holder').toBe(1);
    });

    it('PASS a SPECIALIZED-CENTRE direct-holder recall', async () => {
      const r = await rig.asUser(CWM, (c: any) =>
        call(c, 'phoenix_recall_warehouse_transfer_line',
          [rootLine.SPEC, 'R16-RECALL-SPEC', 'specialized recall']), { commit: true });
      expect(r.ok).toBe(true);
      const holders: any = await asAdmin(`
        SELECT count(*)::int AS n FROM warehouse_return_requests
         WHERE return_number='R16-RECALL-SPEC' AND source_warehouse_id=$1`, [WH_SPEC]);
      expect(holders.rows[0].n).toBe(1);
    });

    it('PASS an OUTLET-anchored recall of a real inbound receipt', async () => {
      const before = await physical();
      const mv: any = await asAdmin(
        `SELECT id FROM outlet_stock_movements
          WHERE outlet_stock_id=$1 AND movement_type='dispatch_receive' LIMIT 1`,
        [outletStock.PH_HOSP]);
      const r = await rig.asUser(WO_HOSP, (c: any) =>
        call(c, 'phoenix_recall_outlet_inbound_movement',
          [mv.rows[0].id, 'R16-RECALL-OUTLET', 'outlet recall']), { commit: true });
      expect(r.ok).toBe(true);
      expect(await physical(), 'outlet recall moves nothing either').toEqual(before);
    });

    it('REJECT a recall by anyone but the ORIGIN, and it is not an existence oracle', async () => {
      // A foreign actor and a nonexistent id must be indistinguishable.
      const foreign = await rejects(() => rig.asUser(WO_FOREIGN, (c: any) =>
        call(c, 'phoenix_recall_warehouse_transfer_line',
          [rootLine.HOSP, 'R16-RECALL-X1', null]), { commit: true }));
      const missing = await rejects(() => rig.asUser(WO_FOREIGN, (c: any) =>
        call(c, 'phoenix_recall_warehouse_transfer_line',
          [randomUUID(), 'R16-RECALL-X2', null]), { commit: true }));
      expect(foreign).toMatch(/forbidden_warehouse_recall/);
      expect(missing, 'a real-but-foreign id and a fake id look identical')
        .toMatch(/forbidden_warehouse_recall/);
    });

    it('REJECT the retired selector-free recall RPCs — they fail closed', async () => {
      await refusesWithNoDelta(
        'legacy blanket recall',
        /recall_selector_required/,
        () => rig.asUser(CWM, (c: any) =>
          call(c, 'phoenix_recall_direct_warehouse_transfer',
            [WH_CENTRAL, WH_HOSP, 'R16-RECALL-LEGACY', null]), { commit: true }));
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // §12 · STOCKTAKE / CORRECTION — scoping, exactness, second-person approval.
  // ════════════════════════════════════════════════════════════════════════
  describe('§12 · stocktake and correction', () => {
    it('a queued outlet correction is exact, scoped, and needs a SECOND person', async () => {
      const before = await olQty(outletStock.PH_SUBORD);
      const proposed = before - 4;

      const req = await rig.asUser(OO_PH_SUBORD, (c: any) =>
        call(c, 'phoenix_request_outlet_stock_correction',
          [randomUUID(), outletStock.PH_SUBORD, proposed, 'R16 count variance', null, null]),
        { commit: true });
      expect(req.ok).toBe(true);
      expect(req.requires_approval, 'variance 4 > threshold 0 must queue').toBe(true);
      expect(Number(req.variance)).toBe(4);
      expect(await olQty(outletStock.PH_SUBORD), 'queuing touches no stock').toBe(before);

      // THE separation gate — by identity, not by role, and ahead of the
      // permission check so a proposer who also holds approval is still refused.
      await refusesWithNoDelta(
        'proposer approving their own correction',
        /proposer_cannot_approve_own_correction/,
        () => rig.asUser(OO_PH_SUBORD, (c: any) =>
          call(c, 'phoenix_approve_outlet_stock_correction',
            [req.correction_request_id, null]), { commit: true }));

      // A FOREIGN organization's actor cannot approve it either.
      await refusesWithNoDelta(
        'foreign actor approving',
        /forbidden_correction_approval|proposer_cannot_approve_own_correction/,
        () => rig.asUser(OO_FOREIGN, (c: any) =>
          call(c, 'phoenix_approve_outlet_stock_correction',
            [req.correction_request_id, null]), { commit: true }));

      // A second, same-organization principal completes it.
      const approved = await rig.asUser(CWM_SECTOR, (c: any) =>
        call(c, 'phoenix_approve_outlet_stock_correction',
          [req.correction_request_id, null]), { commit: true });
      expect(approved.ok).toBe(true);
      expect(await olQty(outletStock.PH_SUBORD), 'now applied exactly').toBe(proposed);

      const mv: any = await asAdmin(
        `SELECT movement_type, reason_code, on_hand_delta, organization_id, distribution_point_id
           FROM outlet_stock_movements WHERE id=$1`, [approved.movement_id]);
      expect(mv.rows[0].movement_type).toBe('correction');
      expect(mv.rows[0].reason_code).toBe('corrected');
      expect(Number(mv.rows[0].on_hand_delta)).toBe(-4);
      expect(mv.rows[0].organization_id).toBe(ORG_SECTOR);
      expect(mv.rows[0].distribution_point_id).toBe(PH_SUBORD);
    });

    it('a stocktake records against the correct scoped resource and moves no stock', async () => {
      const before = await physicalLedger();
      const r = await rig.asUser(WO_HOSP, (c: any) =>
        call(c, 'phoenix_status_record_stocktake',
          [ORG_HOSP, 'warehouse', WH_HOSP, 'R16 stocktake',
           JSON.stringify([{ scientific_name: MAT, national_code: null, counted_qty: 5 }])]),
        { commit: true });
      expect(r.ok).toBe(true);

      const st: any = await asAdmin(
        `SELECT scope_kind, scope_id, organization_id FROM stocktakes WHERE id=$1`,
        [r.stocktake_id]);
      expect(st.rows[0].scope_kind).toBe('warehouse');
      expect(st.rows[0].scope_id).toBe(WH_HOSP);
      expect(st.rows[0].organization_id).toBe(ORG_HOSP);
      expect(await physicalLedger(), 'a stocktake is a record, not a movement').toEqual(before);
    });

    it('REJECT a warehouse officer recording a stocktake on a FOREIGN warehouse', async () => {
      await refusesWithNoDelta(
        'foreign-scope stocktake',
        /not_authorized_status_center_confirm_missing/,
        () => rig.asUser(WO_HOSP, (c: any) =>
          call(c, 'phoenix_status_record_stocktake',
            [ORG_SPEC, 'warehouse', WH_SPEC, 'x',
             JSON.stringify([{ scientific_name: MAT, national_code: null, counted_qty: 1 }])]),
          { commit: true }));
    });

    it('Migration 186 · a zero-variance outlet count applies immediately', async () => {
      const exact = await olQty(outletStock.PH_HOSP);
      const r = await rig.asUser(OO_PH_HOSP, (c: any) =>
        call(c, 'phoenix_request_outlet_stock_correction',
          [randomUUID(), outletStock.PH_HOSP, exact,
           'R16 exact count', null, null]), { commit: true });
      expect(r.ok).toBe(true);
      expect(r.requires_approval).toBe(false);
      expect(await olQty(outletStock.PH_HOSP)).toBe(exact);
      const mv: any = await asAdmin(
        `SELECT reason_code FROM outlet_stock_movements WHERE id=$1`, [r.movement_id]);
      expect(mv.rows[0].reason_code).toBe('corrected');
    });

    it('Migration 186 · a zero-variance warehouse correction applies immediately', async () => {
      const gen: any = await asAdmin(
        `SELECT movement_seq FROM warehouse_stock WHERE id=$1`, [rootStock.HOSP]);
      const exact = await whQty(rootStock.HOSP);
      const seq = Number(gen.rows[0].movement_seq);
      const r = await rig.asUser(WO_HOSP, (c: any) =>
        call(c, 'phoenix_request_warehouse_stock_correction',
          [randomUUID(), rootStock.HOSP, exact, 'R16 exact count',
           seq, null, null]), { commit: true });
      expect(r.ok).toBe(true);
      expect(r.requires_approval).toBe(false);
      expect(await whQty(rootStock.HOSP)).toBe(exact);
      const mv: any = await asAdmin(
        `SELECT reason_code FROM warehouse_stock_movements WHERE id=$1`, [r.movement_id]);
      expect(mv.rows[0].reason_code).toBe('corrected');
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // §13 · ROLE / SCOPE MATRIX — canonical defaults, zero overrides.
  // ════════════════════════════════════════════════════════════════════════
  describe('§13 · role and scope matrix', () => {
    it('a warehouse officer cannot mutate a SIBLING warehouse in its own organization', async () => {
      await refusesWithNoDelta(
        'primary depot officer dispatching from the subordinate depot',
        /forbidden_warehouse_dispatch_create/,
        () => rig.asUser(WO_PRIMARY, (c: any) =>
          call(c, 'phoenix_create_warehouse_dispatch',
            [DEPOT_SUBORD, PH_SUBORD, 'R16-RBAC-SIB', null, null, null]), { commit: true }));
    });

    it('a warehouse officer cannot mutate a FOREIGN organization\'s warehouse', async () => {
      await refusesWithNoDelta(
        'hospital officer dispatching from the specialized centre',
        /forbidden_warehouse_dispatch_create|warehouse_and_destination_organization_mismatch/,
        () => rig.asUser(WO_HOSP, (c: any) =>
          call(c, 'phoenix_create_warehouse_dispatch',
            [WH_SPEC, PH_SPEC, 'R16-RBAC-XORG', null, null, null]), { commit: true }));
    });

    it('an outlet officer cannot mutate another outlet, even next door', async () => {
      await refusesWithNoDelta(
        'primary-centre officer returning from the subordinate pharmacy',
        /forbidden_outlet_return_request/,
        () => rig.asUser(OO_PH_PRIMARY, (c: any) =>
          call(c, 'phoenix_request_outlet_return', [PH_SUBORD, 'R16-RBAC-XOUT', null]),
          { commit: true }));
    });

    it('the health-centre manager CAN read its own assigned facility resources', async () => {
      const seen = await rig.asUser(HCM_PRIMARY, async (c: any) => {
        const w = await c.query(`SELECT id FROM warehouses WHERE id = $1`, [DEPOT_PRIMARY]);
        const f = await c.query(
          `SELECT id FROM organization_facilities WHERE id = $1`, [FAC_PRIMARY]);
        return { warehouses: w.rows.length, facilities: f.rows.length };
      });
      expect(seen.warehouses, 'its own depot is visible').toBe(1);
      expect(seen.facilities, 'its own facility is visible').toBe(1);
    });

    it('the health-centre manager cannot see a SIBLING facility or the sector main', async () => {
      const seen = await rig.asUser(HCM_PRIMARY, async (c: any) => {
        const sib = await c.query(`SELECT id FROM warehouses WHERE id = $1`, [DEPOT_SUBORD]);
        const main = await c.query(`SELECT id FROM warehouses WHERE id = $1`, [SECTOR_MAIN]);
        const fac = await c.query(
          `SELECT id FROM organization_facilities WHERE id = $1`, [FAC_SUBORD]);
        return { sib: sib.rows.length, main: main.rows.length, fac: fac.rows.length };
      });
      // The sector main is excluded STRUCTURALLY: its facility_id is NULL and
      // NULL never equals the manager's assigned facility.
      expect(seen.sib, 'the sibling depot is invisible').toBe(0);
      expect(seen.main, 'the sector main is invisible').toBe(0);
      expect(seen.fac, 'the sibling facility is invisible').toBe(0);
    });

    it('the health-centre manager can mutate NOTHING on any protected path', async () => {
      const paths: Array<[string, string, any[]]> = [
        ['dispatch',  'phoenix_create_warehouse_dispatch',
          [DEPOT_PRIMARY, PH_PRIMARY, 'R16-HCM-DSP', null, null, null]],
        ['return',    'phoenix_request_outlet_return', [PH_PRIMARY, 'R16-HCM-RET', null]],
        ['dispense',  'phoenix_dispense_outlet_stock',
          [randomUUID(), outletStock.PH_PRIMARY, 1, 'hcm', null]],
        ['replenish', 'phoenix_replenish_emergency_outlet',
          [randomUUID(), routes.HC_CC, outletStock.PH_PRIMARY, 1, null, null]],
        ['recall',    'phoenix_recall_warehouse_transfer_line',
          [depotLine.PRIMARY, 'R16-HCM-RECALL', null]],
      ];
      for (const [label, fn, args] of paths) {
        await refusesWithNoDelta(
          `health_center_manager ${label}`,
          /forbidden_|not_authorized|active_profile_required/,
          () => rig.asUser(HCM_PRIMARY, (c: any) => call(c, fn, args), { commit: true }));
      }
    });

    it('ZERO permission overrides exist — every refusal above was canonical', async () => {
      // Asserted as admin: the RLS policy on this table would hide rows from a
      // user session, so a non-empty table could read as empty.
      const r: any = await asAdmin(
        `SELECT count(*)::int AS n FROM profile_permission_overrides`);
      expect(r.rows[0].n, 'no test may buy itself an authorization').toBe(0);
    });

    it('every actor in this matrix holds a CANONICAL role', async () => {
      const r: any = await asAdmin(
        `SELECT DISTINCT role FROM profiles WHERE id = ANY($1) ORDER BY role`,
        [[CWM, CWM_SECTOR, WO_HOSP, WO_SPEC, WO_SECTOR, WO_PRIMARY, WO_SUBORD,
          OO_PH_HOSP, OO_PH_HOSP_ER, OO_CC_HOSP, OO_RC_HOSP, OO_PH_SPEC, OO_CC_SPEC,
          OO_PH_PRIMARY, OO_CC_PRIMARY, OO_PH_SUBORD, IA_HOSP, IA_SPEC, IA_SECTOR,
          HCM_PRIMARY, WO_FOREIGN, OO_FOREIGN]]);
      expect(r.rows.map((x: any) => x.role)).toEqual([
        'central_warehouse_manager', 'health_center_manager',
        'institution_admin', 'outlet_officer', 'warehouse_officer',
      ]);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // §15/§16 · CONSERVATION AND CROSS-INSTITUTION ISOLATION.
  // ════════════════════════════════════════════════════════════════════════
  describe('§15/§16 · conservation and cross-institution isolation', () => {
    it('CONSERVATION · every unit intake ever created is still accounted for', async () => {
      // 600 entered the system through ONE guarded receipt and nothing else was
      // ever added. Every unit must now sit in exactly one of the four places
      // the current accounting model recognises, or have been terminally
      // dispensed. Quarantine is counted once and separately: it is controlled
      // custody, never a second copy of warehouse_stock.
      const t: any = await asAdmin(`
        SELECT
          (SELECT coalesce(sum(on_hand_quantity),0) FROM warehouse_stock)            AS wh,
          (SELECT coalesce(sum(on_hand_quantity),0) FROM outlet_stock)               AS ol,
          (SELECT coalesce(sum(quantity),0)         FROM warehouse_quarantine_stock) AS quar,
          (SELECT coalesce(-sum(on_hand_delta),0)   FROM outlet_stock_movements
             WHERE movement_type='dispense')                                         AS dispensed,
          (SELECT coalesce(-sum(on_hand_delta),0)   FROM outlet_stock_movements
             WHERE movement_type='correction' AND on_hand_delta < 0)                 AS corrected_down,
          (SELECT coalesce(sum(sent_quantity),0) FROM warehouse_return_shipment_lines srl
             JOIN warehouse_return_shipments s ON s.id = srl.shipment_id
            WHERE srl.received_quantity IS NULL)                                     AS wh_in_transit,
          (SELECT coalesce(sum(sent_quantity),0) FROM outlet_return_shipment_lines srl
            WHERE srl.received_quantity IS NULL)                                     AS ol_in_transit`);
      const v = Object.fromEntries(
        Object.entries(t.rows[0]).map(([k, x]) => [k, Number(x)]));

      const accounted = v.wh + v.ol + v.quar + v.dispensed + v.corrected_down
        + v.wh_in_transit + v.ol_in_transit;
      expect(accounted, 'the 600 intake units are fully conserved').toBe(600);
    });

    it('exactly TWO ordinary stock truths exist, and quarantine is not a third', async () => {
      // Nothing in this matrix ever wrote an ordinary on-hand quantity anywhere
      // but warehouse_stock and outlet_stock.
      const r: any = await asAdmin(`
        SELECT table_name FROM information_schema.columns
         WHERE table_schema='public' AND column_name='on_hand_quantity'
         ORDER BY table_name`);
      expect(r.rows.map((x: any) => x.table_name))
        .toEqual(['outlet_stock', 'warehouse_stock']);
    });

    it('CROSS-ORG · a foreign warehouse officer cannot touch this sector at all', async () => {
      const attempts: Array<[string, string, any[]]> = [
        ['dispatch', 'phoenix_create_warehouse_dispatch',
          [DEPOT_PRIMARY, PH_PRIMARY, 'R16-XORG-DSP', null, null, null]],
        ['return',   'phoenix_request_direct_warehouse_return',
          [DEPOT_PRIMARY, SECTOR_MAIN, 'R16-XORG-RET', null]],
        ['stocktake','phoenix_status_record_stocktake',
          [ORG_SECTOR, 'warehouse', DEPOT_PRIMARY, 'x',
           JSON.stringify([{ scientific_name: MAT, national_code: null, counted_qty: 1 }])]],
      ];
      for (const [label, fn, args] of attempts) {
        await refusesWithNoDelta(
          `foreign officer ${label}`,
          /forbidden_|not_authorized/,
          () => rig.asUser(WO_FOREIGN, (c: any) => call(c, fn, args), { commit: true }));
      }
    });

    it('CROSS-ORG · a foreign outlet officer cannot reach this organization\'s outlets', async () => {
      await refusesWithNoDelta(
        'foreign officer dispensing here',
        /forbidden_outlet_stock_dispense/,
        () => rig.asUser(OO_FOREIGN, (c: any) =>
          call(c, 'phoenix_dispense_outlet_stock',
            [randomUUID(), outletStock.PH_PRIMARY, 1, 'x', null]), { commit: true }));
    });

    it('SIBLING vs FOREIGN are DIFFERENT boundaries and must not be conflated', async () => {
      // Same organization, wrong facility — refused by SCOPE.
      const sibling = await rejects(() => rig.asUser(WO_PRIMARY, (c: any) =>
        call(c, 'phoenix_create_warehouse_dispatch',
          [DEPOT_SUBORD, PH_SUBORD, 'R16-BOUND-SIB', null, null, null]), { commit: true }));
      expect(sibling).toMatch(/forbidden_warehouse_dispatch_create/);

      // Different organization entirely — refused before scope is consulted,
      // because the org argument never matches the actor's own organization.
      const foreign = await rejects(() => rig.asUser(WO_FOREIGN, (c: any) =>
        call(c, 'phoenix_create_warehouse_dispatch',
          [DEPOT_SUBORD, PH_SUBORD, 'R16-BOUND-XORG', null, null, null]), { commit: true }));
      expect(foreign).toMatch(/forbidden_warehouse_dispatch_create/);

      // Both refuse, and neither reveals whether the target exists — that is
      // the property being asserted, not that the tokens happen to differ.
      const fake = await rejects(() => rig.asUser(WO_FOREIGN, (c: any) =>
        call(c, 'phoenix_create_warehouse_dispatch',
          [uid(), PH_SUBORD, 'R16-BOUND-FAKE', null, null, null]), { commit: true }));
      expect(fake).toMatch(/warehouse_not_found_or_inactive|forbidden_warehouse_dispatch_create/);
    });
  });
});
