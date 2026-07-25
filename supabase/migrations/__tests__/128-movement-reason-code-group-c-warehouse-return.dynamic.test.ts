/**
 * MOVEMENT-REASON-CODE-GROUP-C-WAREHOUSE-RETURN-128 — DYNAMIC proof against
 * a real disposable Postgres with 001->128 applied in order, driving the
 * FULL real RPC chain (receive -> transfer send/receive -> return request
 * -> review -> return send/receive) exactly as the frontend would.
 *
 * Proves:
 *   1. The return-send movement lands on reason_code equal to the return
 *      request line's own reason_code (propagated verbatim, not
 *      hardcoded), with a fresh correlation_id and NULL causation_id.
 *   2. warehouse_return_shipment_lines.source_movement_id is populated
 *      with the send movement's own id.
 *   3. RESTOCKABLE branch (reason_code='excess', a human-decidable code):
 *      the receive-side warehouse_stock_movements row lands on
 *      reason_code='excess', shares the send movement's correlation_id,
 *      and has causation_id equal to the send movement's own id.
 *   4. QUARANTINE branch (reason_code='damaged', mandatory quarantine): the
 *      receive-side warehouse_quarantine_stock_movements row lands on
 *      reason_code='damaged' (the disposition-classified value), and also
 *      shares the send correlation_id / has the same causation_id.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_CENTRAL = '00000000-0000-0000-0000-000000128001';
const ORG_INST = '00000000-0000-0000-0000-000000128002';
const WH_CENTRAL = '00000000-0000-0000-0000-000000128101';
const WH_INST = '00000000-0000-0000-0000-000000128102';
const ROUTE = '00000000-0000-0000-0000-000000128201';

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

run('128 Group C warehouse return reason_code/correlation chain — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 128 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_CENTRAL}','C','مركز','p128-c'),('${ORG_INST}','I','مؤسسة','p128-i')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG_CENTRAL}','CWH','مخزنC','active','central','p128-wc'),
        ('${WH_INST}','${ORG_INST}','IWH','مخزنI','active','institution','p128-wi')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes (id,source_warehouse_id,target_warehouse_id,source_warehouse_kind,target_warehouse_kind,is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution',true) ON CONFLICT (id) DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  // Drives one full receive->transfer->return-request->send chain, returning
  // the send movement's id/reason_code/correlation_id and the shipment line
  // id, so each disposition branch below can receive against a fresh line.
  async function sendOneReturnLine(scientificName: string, reasonCode: string, quantity: number) {
    let sendMovementId = '';
    let lineId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_CENTRAL, scientificName, 50, true, true, 0,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null,
      ]);
      const centralStock = rc.warehouse_stock_id;

      const tr = await call(c, 'phoenix_create_warehouse_transfer_request', [ROUTE, WH_INST, uniq('TR'), null]);
      const transferTrace = tr.transfer_request_id;
      await call(c, 'phoenix_add_warehouse_transfer_request_line', [transferTrace, scientificName, quantity, null, null, null, null, null]);
      await call(c, 'phoenix_submit_warehouse_transfer_request', [transferTrace]);
      const tls = await c.query(`SELECT id, requested_quantity FROM warehouse_transfer_request_lines WHERE transfer_request_id=$1`, [transferTrace]);
      await call(c, 'phoenix_review_warehouse_transfer_request', [transferTrace, JSON.stringify(tls.rows.map((r: any) => ({ line_id: r.id, approved_quantity: r.requested_quantity })))]);
      const send = await call(c, 'phoenix_send_warehouse_transfer_line', [randomUUID(), ROUTE, centralStock, quantity, uniq('TS'), tls.rows[0].id, null, null]);
      await call(c, 'phoenix_receive_warehouse_transfer_line', [randomUUID(), send.transfer_line_id, quantity, null, null]);

      const wr = await call(c, 'phoenix_request_warehouse_return', [ROUTE, WH_INST, uniq('WR')]);
      const wrId = wr.return_request_id ?? wr.id;
      await call(c, 'phoenix_add_warehouse_return_request_line', [wrId, send.transfer_line_id, quantity, reasonCode, 'test return']);
      await call(c, 'phoenix_submit_warehouse_return_request', [wrId]);
      const wls = await c.query(`SELECT id, requested_quantity FROM warehouse_return_request_lines WHERE return_request_id=$1`, [wrId]);
      await call(c, 'phoenix_review_warehouse_return_request', [wrId, JSON.stringify(wls.rows.map((r: any) => ({ line_id: r.id, approved_quantity: r.requested_quantity })))]);
      const wsend = await call(c, 'phoenix_send_warehouse_return_shipment_line', [randomUUID(), ROUTE, wls.rows[0].id, quantity, uniq('WRS'), null, null]);
      sendMovementId = wsend.movement_id;
      lineId = wsend.shipment_line_id;
    }, { commit: true });
    return { sendMovementId, lineId };
  }

  it('send: reason_code equals the request line\'s reason_code, fresh correlation_id, NULL causation_id; source_movement_id populated', async () => {
    const { sendMovementId, lineId } = await sendOneReturnLine('P128-A', 'excess', 10);

    await rig.asAdmin(async (c: any) => {
      const mv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM warehouse_stock_movements WHERE id = $1`, [sendMovementId]);
      expect(mv.rows[0].reason_code).toBe('excess');
      expect(mv.rows[0].correlation_id).not.toBeNull();
      expect(mv.rows[0].causation_id).toBeNull();

      const line = await c.query(`SELECT source_movement_id FROM warehouse_return_shipment_lines WHERE id = $1`, [lineId]);
      expect(line.rows[0].source_movement_id).toBe(sendMovementId);
    });
  });

  it('restockable receive branch: reason_code=excess propagated, correlation_id matches send, causation_id equals send movement id', async () => {
    const { sendMovementId, lineId } = await sendOneReturnLine('P128-B', 'excess', 10);

    let receiveMovementId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const received = await call(c, 'phoenix_receive_warehouse_return_shipment_line', [
        randomUUID(), lineId, 10, null, null, 'restockable',
      ]);
      expect(received.ok).toBe(true);
      expect(received.disposition).toBe('restockable');
      receiveMovementId = received.movement_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const sendMv = await c.query(`SELECT correlation_id FROM warehouse_stock_movements WHERE id = $1`, [sendMovementId]);
      const receiveMv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM warehouse_stock_movements WHERE id = $1`, [receiveMovementId]);
      expect(receiveMv.rows[0].reason_code).toBe('excess');
      expect(receiveMv.rows[0].correlation_id).toBe(sendMv.rows[0].correlation_id);
      expect(receiveMv.rows[0].causation_id).toBe(sendMovementId);
    });
  });

  it('quarantine receive branch: reason_code=damaged (disposition-classified), correlation_id matches send, causation_id equals send movement id', async () => {
    const { sendMovementId, lineId } = await sendOneReturnLine('P128-C', 'damaged', 10);

    let receiveMovementId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const received = await call(c, 'phoenix_receive_warehouse_return_shipment_line', [
        randomUUID(), lineId, 10, null, null, null,
      ]);
      expect(received.ok).toBe(true);
      expect(received.disposition).toBe('quarantined');
      receiveMovementId = received.movement_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const sendMv = await c.query(`SELECT correlation_id FROM warehouse_stock_movements WHERE id = $1`, [sendMovementId]);
      const receiveMv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM warehouse_quarantine_stock_movements WHERE id = $1`, [receiveMovementId]);
      expect(receiveMv.rows[0].reason_code).toBe('damaged');
      expect(receiveMv.rows[0].correlation_id).toBe(sendMv.rows[0].correlation_id);
      expect(receiveMv.rows[0].causation_id).toBe(sendMovementId);
    });
  });
});
