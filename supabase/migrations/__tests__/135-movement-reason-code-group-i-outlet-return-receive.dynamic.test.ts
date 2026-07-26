/**
 * MOVEMENT-REASON-CODE-GROUP-I-OUTLET-RETURN-RECEIVE-135 — DYNAMIC proof
 * against a real disposable Postgres with 001->135 applied in order, driving
 * the FULL real RPC chain exactly as the frontend would:
 *
 *   warehouse receive -> transfer send/receive -> dispatch create/add/send
 *   -> outlet dispatch-receive -> outlet return request/add/submit/review
 *   -> outlet return SEND -> outlet return RECEIVE
 *
 * Proves the Group I fix end to end, on BOTH disposition branches:
 *   1. RESTOCKABLE ('excess', a human-decidable code): the receive-side
 *      warehouse_stock_movements row lands on reason_code='excess', shares
 *      the SEND movement's correlation_id, and its causation_id equals the
 *      send movement's own id -- resolved through the source_movement_id
 *      column this migration adds.
 *   2. QUARANTINE ('damaged', mandatory quarantine): the receive-side
 *      warehouse_quarantine_stock_movements row lands on reason_code equal
 *      to the quarantine lot's own disposition-classified quarantine_reason,
 *      and chains the same way.
 *   3. The SEND half populates outlet_return_shipment_lines.source_movement_id
 *      with its own movement id (the anchor that makes 1 and 2 real rather
 *      than a COALESCE fallback).
 *   4. Reconciliation holds on every row written by the chain:
 *      quantity_before + quantity_delta = quantity_after.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_CENTRAL = '00000000-0000-0000-0000-000000135001';
const ORG_INST = '00000000-0000-0000-0000-000000135002';
const WH_CENTRAL = '00000000-0000-0000-0000-000000135101';
const WH_INST = '00000000-0000-0000-0000-000000135102';
const DP_OUTLET = '00000000-0000-0000-0000-000000135301';
const ROUTE = '00000000-0000-0000-0000-000000135501';

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

run('135 Group I outlet-return-receive reason_code/correlation chain — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 135 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_CENTRAL}','C','مركز','p135-c'),('${ORG_INST}','I','مؤسسة','p135-i')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG_CENTRAL}','CWH','مخزنC','active','central','p135-wc'),
        ('${WH_INST}','${ORG_INST}','IWH','مخزنI','active','institution','p135-wi')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP_OUTLET}','${WH_INST}','${ORG_INST}','Outlet','منفذ','pharmacy','active') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes
        (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution', true) ON CONFLICT (id) DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  /**
   * Drives the whole corridor once and returns the ids needed to assert on
   * the return-receive row. `material` keeps each run's lots distinct.
   */
  async function driveCorridor(material: string, reasonCode: string, dispositionDecision: string | null) {
    let dispatchLineId = '';
    let returnSendMovementId = '';
    let shipmentLineId = '';
    let receiveResult: any = null;

    await rig.asUser(rig.superAdminId, async (c: any) => {
      // 103 forbids receiving directly into an institution warehouse — route
      // stock in via a transfer first, exactly as Groups B–F's own tests do.
      const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_CENTRAL, material, 60, true, true, 0,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null,
      ]);
      const transferSend = await call(c, 'phoenix_send_warehouse_transfer_line', [
        randomUUID(), ROUTE, rc.warehouse_stock_id, 60, uniq('WT'), null, null, null,
      ]);
      const transferReceived = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), transferSend.transfer_line_id, 60, null, null,
      ]);

      const dsp = await call(c, 'phoenix_create_warehouse_dispatch',
        [WH_INST, DP_OUTLET, uniq('DSP'), null, null, null]);
      const dispatchId = dsp.dispatch_id ?? dsp.id;
      await call(c, 'phoenix_add_dispatch_line', [dispatchId, transferReceived.warehouse_stock_id, 40]);
      await call(c, 'phoenix_send_warehouse_dispatch', [randomUUID(), dispatchId]);
      const dls = await c.query(`SELECT id FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [dispatchId]);
      dispatchLineId = dls.rows[0].id;

      await call(c, 'phoenix_receive_outlet_dispatch_line', [randomUUID(), dispatchLineId, 40, null, null]);

      // Return: request -> add line (with the reason_code under test) -> submit -> review -> send.
      const req = await call(c, 'phoenix_request_outlet_return', [DP_OUTLET, uniq('OR')]);
      const returnRequestId = req.return_request_id ?? req.id;
      const addLine = await call(c, 'phoenix_add_outlet_return_request_line',
        [returnRequestId, dispatchLineId, 10, reasonCode, 'group I proof']);
      const returnLineId = addLine.return_request_line_id;
      await call(c, 'phoenix_submit_outlet_return_request', [returnRequestId]);
      await call(c, 'phoenix_review_outlet_return_request',
        [returnRequestId, JSON.stringify([{ line_id: returnLineId, approved_quantity: 10 }])]);

      const returnSent = await call(c, 'phoenix_send_outlet_return_shipment_line',
        [randomUUID(), returnLineId, null, 10, uniq('ORS'), null, null]);
      expect(returnSent.ok).toBe(true);
      returnSendMovementId = returnSent.movement_id;
      shipmentLineId = returnSent.shipment_line_id;

      // THE call under test.
      receiveResult = await call(c, 'phoenix_receive_outlet_return_shipment_line',
        [randomUUID(), shipmentLineId, 10, null, null, dispositionDecision]);
      expect(receiveResult.ok).toBe(true);
    }, { commit: true });

    return { dispatchLineId, returnSendMovementId, shipmentLineId, receiveResult };
  }

  it('SEND populates outlet_return_shipment_lines.source_movement_id with its own movement id', async () => {
    const { returnSendMovementId, shipmentLineId } = await driveCorridor('P135-ANCHOR', 'excess', 'restockable');
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT source_movement_id FROM outlet_return_shipment_lines WHERE id = $1`,
        [shipmentLineId],
      );
      expect(r.rows[0].source_movement_id).toBe(returnSendMovementId);
    });
  });

  it('RESTOCKABLE branch: reason_code from the return line, correlation shared with SEND, causation = SEND movement id', async () => {
    const { returnSendMovementId, receiveResult } = await driveCorridor('P135-RESTOCK', 'excess', 'restockable');
    expect(receiveResult.disposition).toBe('restockable');

    await rig.asAdmin(async (c: any) => {
      const sendMv = await c.query(
        `SELECT reason_code, correlation_id FROM outlet_stock_movements WHERE id = $1`,
        [returnSendMovementId],
      );
      expect(sendMv.rows[0].reason_code).toBe('excess');

      const recvMv = await c.query(
        `SELECT reason_code, correlation_id, causation_id,
                on_hand_before, on_hand_delta, on_hand_after
           FROM warehouse_stock_movements WHERE id = $1`,
        [receiveResult.movement_id],
      );
      // The Group I fix: previously ALL THREE of these were unset.
      expect(recvMv.rows[0].reason_code).toBe('excess');
      expect(recvMv.rows[0].correlation_id).toBe(sendMv.rows[0].correlation_id);
      expect(recvMv.rows[0].causation_id).toBe(returnSendMovementId);
      // Reconciliation.
      expect(recvMv.rows[0].on_hand_before + recvMv.rows[0].on_hand_delta)
        .toBe(recvMv.rows[0].on_hand_after);
    });
  });

  it('QUARANTINE branch: reason_code equals the lot\'s own quarantine_reason, and chains identically', async () => {
    // 'damaged' forces mandatory quarantine — no disposition decision is accepted.
    const { returnSendMovementId, receiveResult } = await driveCorridor('P135-QUAR', 'damaged', null);
    expect(receiveResult.disposition).toBe('quarantined');

    await rig.asAdmin(async (c: any) => {
      const sendMv = await c.query(
        `SELECT reason_code, correlation_id FROM outlet_stock_movements WHERE id = $1`,
        [returnSendMovementId],
      );
      expect(sendMv.rows[0].reason_code).toBe('damaged');

      const recvMv = await c.query(
        `SELECT m.reason_code, m.correlation_id, m.causation_id,
                m.quantity_before, m.quantity_delta, m.quantity_after,
                q.quarantine_reason
           FROM warehouse_quarantine_stock_movements m
           JOIN warehouse_quarantine_stock q ON q.id = m.quarantine_stock_id
          WHERE m.id = $1`,
        [receiveResult.movement_id],
      );
      // The ledger and the quarantine lot can never disagree.
      expect(recvMv.rows[0].reason_code).toBe(recvMv.rows[0].quarantine_reason);
      expect(recvMv.rows[0].reason_code).toBe('damaged');
      expect(recvMv.rows[0].correlation_id).toBe(sendMv.rows[0].correlation_id);
      expect(recvMv.rows[0].causation_id).toBe(returnSendMovementId);
      expect(recvMv.rows[0].quantity_before + recvMv.rows[0].quantity_delta)
        .toBe(recvMv.rows[0].quantity_after);
    });
  });

  it('every movement row written by the corridor reconciles and carries a reason_code from the closed vocabulary', async () => {
    await driveCorridor('P135-RECON', 'excess', 'restockable');
    await rig.asAdmin(async (c: any) => {
      const bad = await c.query(`
        SELECT 'warehouse' AS ledger, id FROM warehouse_stock_movements
         WHERE on_hand_before + on_hand_delta <> on_hand_after
            OR reason_code = 'legacy_unclassified'
        UNION ALL
        SELECT 'outlet', id FROM outlet_stock_movements
         WHERE on_hand_before + on_hand_delta <> on_hand_after
            OR reason_code = 'legacy_unclassified'
        UNION ALL
        SELECT 'quarantine', id FROM warehouse_quarantine_stock_movements
         WHERE quantity_before + quantity_delta <> quantity_after
            OR reason_code = 'legacy_unclassified'
      `);
      expect(bad.rows).toEqual([]);
    });
  });
});
