/**
 * MOVEMENT-REASON-CODE-GROUP-F-OUTLET-131 — DYNAMIC proof against a real
 * disposable Postgres with 001->131 applied in order, driving the FULL real
 * RPC chain (warehouse receive -> dispatch create/add/send -> outlet
 * receive -> dispense -> count -> outlet return request/review/send)
 * exactly as the frontend would.
 *
 * Proves:
 *   1. Dispatch-receive: reason_code='received' on an exact-quantity match;
 *      correlation_id equals the send movement's own correlation_id and
 *      causation_id equals its own id (a real predecessor, resolved via the
 *      shared dispatch_line_id join). phoenix_send_warehouse_dispatch (070)
 *      was found to be a genuine gap while verifying this slice -- NOT one
 *      of the 20 originally audited writers -- and is fixed in this same
 *      migration (reason_code='transferred', a fresh correlation_id per
 *      dispatch line) so this chain is real, not a COALESCE fallback.
 *   2. Dispense: reason_code='dispensed', fresh correlation_id, NULL
 *      causation_id.
 *   3. Count: reason_code is mandatory and validated; a valid call lands
 *      with fresh correlation_id, NULL causation_id.
 *   4. Return-send: reason_code equals the return request line's own
 *      reason_code, correlation_id equals the dispatch-receive movement's
 *      correlation_id, causation_id equals that receive movement's own id.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_CENTRAL = '00000000-0000-0000-0000-000000131001';
const ORG_INST = '00000000-0000-0000-0000-000000131002';
const WH_CENTRAL = '00000000-0000-0000-0000-000000131101';
const WH_INST = '00000000-0000-0000-0000-000000131102';
const DP_OUTLET = '00000000-0000-0000-0000-000000131301';
const ROUTE = '00000000-0000-0000-0000-000000131501';

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

run('131 Group F outlet reason_code/correlation chain — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 131 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_CENTRAL}','C','مركز','p131-c'),('${ORG_INST}','I','مؤسسة','p131-i')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG_CENTRAL}','CWH','مخزنC','active','central','p131-wc'),
        ('${WH_INST}','${ORG_INST}','IWH','مخزنI','active','institution','p131-wi')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP_OUTLET}','${WH_INST}','${ORG_INST}','Outlet','منفذ','pharmacy','active') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes
        (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution', true) ON CONFLICT (id) DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('dispatch-receive/dispense/count/return-send: reason_code and correlation/causation chain correctly through the full real RPC chain', async () => {
    let sendMovementId = '';
    let receiveMovementId = '';
    let dispenseMovementId = '';
    let countMovementId = '';
    let returnSendMovementId = '';
    let outletStockId = '';

    await rig.asUser(rig.superAdminId, async (c: any) => {
      // 103 forbids receiving stock directly into an institution warehouse --
      // route it in via a transfer first, exactly as Groups B-D's own dynamic
      // tests do.
      const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_CENTRAL, 'P131-A', 60, true, true, 0,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null,
      ]);
      const centralStock = rc.warehouse_stock_id;

      const transferSend = await call(c, 'phoenix_send_warehouse_transfer_line', [
        randomUUID(), ROUTE, centralStock, 60, uniq('WT'), null, null, null,
      ]);
      const transferReceived = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), transferSend.transfer_line_id, 60, null, null,
      ]);
      const instStock = transferReceived.warehouse_stock_id;

      const dsp = await call(c, 'phoenix_create_warehouse_dispatch', [WH_INST, DP_OUTLET, uniq('DSP'), null, null, null]);
      const dispatchId = dsp.dispatch_id ?? dsp.id;
      await call(c, 'phoenix_add_dispatch_line', [dispatchId, instStock, 40]);
      const sent = await call(c, 'phoenix_send_warehouse_dispatch', [randomUUID(), dispatchId]);
      const dls = await c.query(`SELECT id FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [dispatchId]);
      const dispatchLineId = dls.rows[0].id;

      const sendMv = await c.query(
        `SELECT id FROM warehouse_stock_movements WHERE reference_type='warehouse_dispatch_send' AND reference_id=$1`,
        [dispatchLineId],
      );
      sendMovementId = sendMv.rows[0].id;

      // 1. Dispatch-receive: exact match, no difference -> reason_code defaults to 'received'.
      const received = await call(c, 'phoenix_receive_outlet_dispatch_line', [randomUUID(), dispatchLineId, 40, null, null]);
      expect(received.ok).toBe(true);
      receiveMovementId = received.movement_id;
      outletStockId = received.outlet_stock_id;

      // 2. Dispense.
      const dispensed = await call(c, 'phoenix_dispense_outlet_stock', [randomUUID(), outletStockId, 5, 'patient dose', null]);
      expect(dispensed.ok).toBe(true);
      dispenseMovementId = dispensed.movement_id;

      // 3. Count, with a mandatory valid reason_code.
      const counted = await call(c, 'phoenix_count_outlet_stock', [randomUUID(), outletStockId, 33, 'physical count', null, 'corrected']);
      expect(counted.ok).toBe(true);
      countMovementId = counted.movement_id;

      // 4. Return-send: request -> add line (reason_code='excess') -> submit -> review -> send.
      const req = await call(c, 'phoenix_request_outlet_return', [DP_OUTLET, uniq('OR')]);
      const returnRequestId = req.return_request_id ?? req.id;
      const addLine = await call(c, 'phoenix_add_outlet_return_request_line',
        [returnRequestId, dispatchLineId, 10, 'excess', 'over-supplied']);
      const returnLineId = addLine.return_request_line_id;
      await call(c, 'phoenix_submit_outlet_return_request', [returnRequestId]);
      await call(c, 'phoenix_review_outlet_return_request',
        [returnRequestId, JSON.stringify([{ line_id: returnLineId, approved_quantity: 10 }])]);
      const returnSent = await call(c, 'phoenix_send_outlet_return_shipment_line',
        [randomUUID(), returnLineId, null, 10, uniq('ORS'), null, null]);
      expect(returnSent.ok).toBe(true);
      returnSendMovementId = returnSent.movement_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const sendMv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM warehouse_stock_movements WHERE id = $1`, [sendMovementId]);
      expect(sendMv.rows[0].reason_code).toBe('transferred');
      expect(sendMv.rows[0].correlation_id).not.toBeNull();
      expect(sendMv.rows[0].causation_id).toBeNull();

      const receiveMv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM outlet_stock_movements WHERE id = $1`, [receiveMovementId]);
      expect(receiveMv.rows[0].reason_code).toBe('received');
      expect(receiveMv.rows[0].correlation_id).toBe(sendMv.rows[0].correlation_id);
      expect(receiveMv.rows[0].causation_id).toBe(sendMovementId);

      const dispenseMv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM outlet_stock_movements WHERE id = $1`, [dispenseMovementId]);
      expect(dispenseMv.rows[0].reason_code).toBe('dispensed');
      expect(dispenseMv.rows[0].correlation_id).not.toBeNull();
      expect(dispenseMv.rows[0].correlation_id).not.toBe(receiveMv.rows[0].correlation_id);
      expect(dispenseMv.rows[0].causation_id).toBeNull();

      const countMv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM outlet_stock_movements WHERE id = $1`, [countMovementId]);
      expect(countMv.rows[0].reason_code).toBe('corrected');
      expect(countMv.rows[0].correlation_id).not.toBeNull();
      expect(countMv.rows[0].causation_id).toBeNull();

      const returnMv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM outlet_stock_movements WHERE id = $1`, [returnSendMovementId]);
      expect(returnMv.rows[0].reason_code).toBe('excess');
      expect(returnMv.rows[0].correlation_id).toBe(receiveMv.rows[0].correlation_id);
      expect(returnMv.rows[0].causation_id).toBe(receiveMovementId);
    });
  });

  it('phoenix_count_outlet_stock rejects an invalid reason_code and requires one at all', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy','P131-B',true,false,'B-B',10,0,0)`, [stockId, ORG_INST, DP_OUTLET]);
    });

    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_count_outlet_stock', [
        randomUUID(), stockId, 8, 'physical count', null, null,
      ])).rejects.toThrow(/outlet_count_reason_code_required/);
    });

    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_count_outlet_stock', [
        randomUUID(), stockId, 8, 'physical count', null, 'not_a_real_code',
      ])).rejects.toThrow(/invalid_outlet_count_reason_code/);
    });
  });
});
