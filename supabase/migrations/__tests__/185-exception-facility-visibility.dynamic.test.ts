/**
 * 185 · R1.5-D EXCEPTION-HISTORY FACILITY VISIBILITY — two FULLY LEGAL corridors,
 * built entirely through the public RPC surface, on a real 001->185 chain.
 *
 * Nothing here is seeded into exception history. Every row that matters is the
 * product of the canonical corridor:
 *
 *   central -> Sector Main            (routed transfer; 184 admits a health_sector
 *                                      MAIN as an external-corridor root)
 *   Sector Main -> facility Depot     (Branch B DIRECT: 103 refuses direct stock
 *                                      entry into a non-central warehouse, and 184
 *                                      forbids a supply ROUTE to a facility-bound
 *                                      depot, so this leg is the only legal way in)
 *   Depot -> Outlet                   (dispatch)
 *   Outlet -> Depot                   (outlet return, received at ZERO -> exception)
 *   phoenix_resolve_outlet_return_exception(corrected_receipt)
 *
 * Facility A and Facility B live in the SAME Health Sector organization, so what
 * is proven is FACILITY isolation, not organization isolation.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

let seq = 0;
const uid = () => `00000000-0000-0000-0000-${String(185700000000 + (seq += 1))}`;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

const ORG_PDA = uid(), ORG_SECTOR = uid();
const WH_CENTRAL = uid(), SECTOR_MAIN = uid();
const FAC_A = uid(), FAC_B = uid();
const DEPOT_A = uid(), DEPOT_B = uid();
const OUTLET_A = uid(), OUTLET_B = uid();
const ROUTE = uid();
const HCM_A = uid();

run('185 · R1.5-D exception history is facility-scoped for HCM', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  const admin = (sql: string, p: any[] = []) => rig.asAdmin((c: any) => c.query(sql, p));

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  // The caller for every business RPC. The accepted 185-B scaffold drives the
  // same corridor the same way; custody still moves only through the public RPC
  // surface, never by direct INSERT.
  const asOperator = <T>(fn: (c: any) => Promise<T>) =>
    rig.asUser(rig.superAdminId, fn, { commit: true }) as Promise<T>;

  /**
   * The missing leg. Moves `qty` of `material` from Sector Main into a
   * facility-bound depot through the canonical Branch-B DIRECT lifecycle, and
   * returns the REAL received stock row in that depot.
   */
  async function supplyFacilityDepotViaBranchB(depot: string, material: string, qty: number) {
    return asOperator(async (c: any) => {
      // Sector Main is stocked first, from central, over a legal route.
      const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_CENTRAL, material, qty, true, true, 0,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null,
      ]);
      const routed = await call(c, 'phoenix_send_warehouse_transfer_line', [
        randomUUID(), ROUTE, rc.warehouse_stock_id, qty, uniq('WT'), null, null, null]);
      const atMain = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), routed.transfer_line_id, qty, null, null]);

      // BRANCH B, the whole canonical lifecycle.
      const req = await call(c, 'phoenix_create_direct_warehouse_transfer_request',
        [SECTOR_MAIN, ORG_SECTOR, depot, uniq('DR'), 'r15d branch b']);
      const reqId = req.transfer_request_id ?? req.id;
      const line = await call(c, 'phoenix_add_warehouse_transfer_request_line',
        [reqId, material, qty, null, null, null, null, 'r15d']);
      const lineId = line.transfer_request_line_id ?? line.id;
      await call(c, 'phoenix_submit_warehouse_transfer_request', [reqId]);
      await call(c, 'phoenix_review_warehouse_transfer_request',
        [reqId, JSON.stringify([{ line_id: lineId, approved_quantity: qty }])]);
      const sent = await call(c, 'phoenix_send_direct_warehouse_transfer_line',
        [randomUUID(), reqId, atMain.warehouse_stock_id, qty, uniq('DT'), lineId, null, null]);
      const got = await call(c, 'phoenix_receive_warehouse_transfer_line',
        [randomUUID(), sent.transfer_line_id, qty, null, null]);
      return { transferLineId: sent.transfer_line_id, stockId: got.warehouse_stock_id as string };
    });
  }

  /** Depot -> Outlet -> return -> exception -> REAL resolution. */
  async function resolveExceptionAt(depot: string, outlet: string, material: string, qty: number) {
    const supplied = await supplyFacilityDepotViaBranchB(depot, material, qty);

    // The Branch-B leg really did deliver into the facility depot.
    const check: any = await admin(
      `SELECT warehouse_id, on_hand_quantity FROM warehouse_stock WHERE id=$1`, [supplied.stockId]);
    expect(check.rows[0].warehouse_id).toBe(depot);
    expect(check.rows[0].on_hand_quantity).toBeGreaterThan(0);
    const tl: any = await admin(
      `SELECT status, resulting_warehouse_stock_id FROM warehouse_transfer_lines WHERE id=$1`,
      [supplied.transferLineId]);
    expect(tl.rows[0].status).toBe('received');
    expect(tl.rows[0].resulting_warehouse_stock_id).not.toBeNull();

    return asOperator(async (c: any) => {
      const dsp = await call(c, 'phoenix_create_warehouse_dispatch',
        [depot, outlet, uniq('DSP'), null, null, null]);
      const dispatchId = dsp.dispatch_id ?? dsp.id;
      await call(c, 'phoenix_add_dispatch_line', [dispatchId, supplied.stockId, qty]);
      await call(c, 'phoenix_send_warehouse_dispatch', [randomUUID(), dispatchId]);
      const dls = await c.query(`SELECT id FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [dispatchId]);
      const dispatchLineId = dls.rows[0].id;
      await call(c, 'phoenix_receive_outlet_dispatch_line', [randomUUID(), dispatchLineId, qty, null, null]);

      const orq = await call(c, 'phoenix_request_outlet_return', [outlet, uniq('OR')]);
      const orqId = orq.return_request_id ?? orq.id;
      const add = await call(c, 'phoenix_add_outlet_return_request_line',
        [orqId, dispatchLineId, qty, 'shipment_error', 'r15d']);
      const orLineId = add.return_request_line_id;
      await call(c, 'phoenix_submit_outlet_return_request', [orqId]);
      await call(c, 'phoenix_review_outlet_return_request',
        [orqId, JSON.stringify([{ line_id: orLineId, approved_quantity: qty }])]);
      const sent = await call(c, 'phoenix_send_outlet_return_shipment_line',
        [randomUUID(), orLineId, null, qty, uniq('ORS'), null, null]);
      const shipmentLineId = sent.shipment_line_id;

      // The same exception-producing mechanism the corrected-receipt suite uses.
      const zero = await call(c, 'phoenix_receive_outlet_return_shipment_line',
        [randomUUID(), shipmentLineId, 0, 'nothing physically arrived', null, null]);
      expect(zero.custody_state).toBe('exception_pending');

      await call(c, 'phoenix_resolve_outlet_return_exception',
        [randomUUID(), shipmentLineId, 'corrected_receipt', 'r15d resolve', qty, 'restockable']);

      const res = await c.query(
        `SELECT id FROM phoenix_outlet_return_exception_resolutions WHERE return_shipment_line_id=$1`,
        [shipmentLineId]);
      const shp = await c.query(
        `SELECT shipment_id FROM outlet_return_shipment_lines WHERE id=$1`, [shipmentLineId]);
      return {
        resolutionId: res.rows[0].id as string,
        shipmentId: shp.rows[0].shipment_id as string,
        shipmentLineId: shipmentLineId as string,
      };
    });
  }

  let A: Awaited<ReturnType<typeof resolveExceptionAt>>;
  let B: Awaited<ReturnType<typeof resolveExceptionAt>>;

  beforeAll(async () => {
    rig = await buildRig({});
    await admin(`
      INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class,status) VALUES
        ('${ORG_PDA}','PDA','دائرة','r15e-p','pharmacy_department_authority',NULL,'active'),
        ('${ORG_SECTOR}','Sector','قطاع','r15e-q','care_institution','health_sector','active');

      INSERT INTO organization_facilities (id,organization_id,facility_class,name,name_ar,status) VALUES
        ('${FAC_A}','${ORG_SECTOR}','primary_health_center','A','أ','active'),
        ('${FAC_B}','${ORG_SECTOR}','primary_health_center','B','ب','active');

      INSERT INTO warehouses (id,organization_id,name,name_ar,warehouse_kind,facility_id,is_main,status) VALUES
        ('${WH_CENTRAL}','${ORG_PDA}','C','مركزي','central',NULL,true,'active'),
        ('${SECTOR_MAIN}','${ORG_SECTOR}','Main','رئيسي','institution',NULL,true,'active'),
        ('${DEPOT_A}','${ORG_SECTOR}','DepA','مذخرأ','institution','${FAC_A}',false,'active'),
        ('${DEPOT_B}','${ORG_SECTOR}','DepB','مذخرب','institution','${FAC_B}',false,'active');

      INSERT INTO distribution_points
        (id,organization_id,warehouse_id,name,name_ar,point_type,status,clinical_location_kind) VALUES
        ('${OUTLET_A}','${ORG_SECTOR}','${DEPOT_A}','OutA','منفذأ','pharmacy','active',NULL),
        ('${OUTLET_B}','${ORG_SECTOR}','${DEPOT_B}','OutB','منفذب','pharmacy','active',NULL);

      -- 184 admits a health_sector MAIN as an external-corridor root, so this
      -- route is legal. A route to a facility-bound DEPOT would not be.
      INSERT INTO warehouse_supply_routes
        (id,source_warehouse_id,target_warehouse_id,source_warehouse_kind,target_warehouse_kind,is_active)
      VALUES ('${ROUTE}','${WH_CENTRAL}','${SECTOR_MAIN}','central','institution',true);

      INSERT INTO auth.users (id,email) VALUES ('${HCM_A}','r15e-hcma@rig') ON CONFLICT (id) DO NOTHING;
      UPDATE profiles SET role='health_center_manager', status='active', organization_id='${ORG_SECTOR}'
       WHERE id='${HCM_A}';
      INSERT INTO profile_scope_assignments
        (profile_id, organization_id, scope_type, facility_id, is_active)
      VALUES ('${HCM_A}','${ORG_SECTOR}','facility','${FAC_A}',true)
      ON CONFLICT DO NOTHING;
    `);

    A = await resolveExceptionAt(DEPOT_A, OUTLET_A, 'R15E-MAT-A', 10);
    B = await resolveExceptionAt(DEPOT_B, OUTLET_B, 'R15E-MAT-B', 10);
  }, 900000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('both resolutions genuinely exist, produced by the real RPC', async () => {
    const r: any = await admin(
      `SELECT id, resolution_kind FROM phoenix_outlet_return_exception_resolutions
        WHERE id = ANY($1) ORDER BY id`, [[A.resolutionId, B.resolutionId]]);
    expect(r.rows.length).toBe(2);
    expect(r.rows.every((x: any) => x.resolution_kind === 'corrected_receipt')).toBe(true);
    expect(A.resolutionId).not.toBe(B.resolutionId);
  });

  it('D · HCM-A sees its OWN facility resolution and NOT the sibling facility one', async () => {
    const ids = await rig.asUser(HCM_A, (c: any) =>
      c.query(`SELECT id FROM phoenix_outlet_return_exception_resolutions ORDER BY id`)
        .then((r: any) => r.rows.map((x: any) => x.id)));
    expect(ids).toContain(A.resolutionId);
    expect(ids).not.toContain(B.resolutionId);
    // Both facilities share ONE organization, so this is facility isolation,
    // not organization isolation.
    expect(ids).toEqual([A.resolutionId]);
  });

  it('D · the ancestry surfaces cannot leak the sibling facility either', async () => {
    const shipments = await rig.asUser(HCM_A, (c: any) =>
      c.query(`SELECT id FROM outlet_return_shipments`).then((r: any) => r.rows.map((x: any) => x.id)));
    expect(shipments).toContain(A.shipmentId);
    expect(shipments).not.toContain(B.shipmentId);

    const lines = await rig.asUser(HCM_A, (c: any) =>
      c.query(`SELECT id FROM outlet_return_shipment_lines`).then((r: any) => r.rows.map((x: any) => x.id)));
    expect(lines).toContain(A.shipmentLineId);
    expect(lines).not.toContain(B.shipmentLineId);
  });

  it('D · a cross-paired outlet/depot shipment is refused by canonical topology', async () => {
    // The policy requires BOTH point AND destination-warehouse assignment, which
    // only matters if Outlet A + Depot B is constructible at all. Attempted ONLY
    // through the public API - no trigger disabled, no constraint dropped.
    let msg = '';
    try {
      await asOperator((c: any) => call(c, 'phoenix_create_warehouse_dispatch',
        [DEPOT_B, OUTLET_A, uniq('XDSP'), null, null, null]));
      msg = 'ALLOWED';
    } catch (e: any) { msg = String(e?.message ?? e); }
    expect(msg).not.toBe('ALLOWED');
  });
});
