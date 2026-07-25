/**
 * MOVEMENT-REASON-CODE-GROUP-D-DIRECT-SUPPLY-129 — DYNAMIC proof against a
 * real disposable Postgres with 001->129 applied in order, driving the FULL
 * real RPC chain for the DIRECT (route-free) corridor.
 *
 * Proves:
 *   1. Direct transfer send lands on reason_code='transferred', fresh
 *      correlation_id, NULL causation_id; source_movement_id is populated
 *      on the SAME warehouse_transfer_lines table the routed corridor uses.
 *   2. The SHARED receive function (unchanged since 127) correctly chains
 *      correlation_id/causation_id from a direct send's source_movement_id
 *      -- proving Group D's fix genuinely interoperates with Group B's.
 *   3. Direct return send lands on reason_code equal to the request line's
 *      own reason_code, and the shared receive function (unchanged since
 *      128) chains correctly from it too.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_CENTRAL = '00000000-0000-0000-0000-000000129001';
const ORG_INST = '00000000-0000-0000-0000-000000129002';
const WH_CENTRAL = '00000000-0000-0000-0000-000000129101';
const WH_INST = '00000000-0000-0000-0000-000000129102';

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

run('129 Group D direct-supply reason_code/correlation chain — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 129 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_CENTRAL}','C','مركز','p129-c'),('${ORG_INST}','I','مؤسسة','p129-i')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG_CENTRAL}','CWH','مخزنC','active','central','p129-wc'),
        ('${WH_INST}','${ORG_INST}','IWH','مخزنI','active','institution','p129-wi')
        ON CONFLICT (id) DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('direct transfer send/receive: reason_code, correlation_id, causation_id chain correctly through the shared receive function', async () => {
    let sendMovementId = '';
    let receiveMovementId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_CENTRAL, 'P129-A', 50, true, true, 0,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null,
      ]);
      const centralStock = rc.warehouse_stock_id;

      const tr = await call(c, 'phoenix_create_direct_warehouse_transfer_request', [
        WH_CENTRAL, ORG_INST, WH_INST, uniq('DTR'), null,
      ]);
      const transferTrace = tr.transfer_request_id ?? tr.id;
      await call(c, 'phoenix_add_warehouse_transfer_request_line', [transferTrace, 'P129-A', 20, null, null, null, null, null]);
      await call(c, 'phoenix_submit_warehouse_transfer_request', [transferTrace]);
      const tls = await c.query(`SELECT id, requested_quantity FROM warehouse_transfer_request_lines WHERE transfer_request_id=$1`, [transferTrace]);
      await call(c, 'phoenix_review_warehouse_transfer_request', [transferTrace, JSON.stringify(tls.rows.map((r: any) => ({ line_id: r.id, approved_quantity: r.requested_quantity })))]);

      const send = await call(c, 'phoenix_send_direct_warehouse_transfer_line', [
        randomUUID(), transferTrace, centralStock, 20, uniq('DTS'), tls.rows[0].id, null, null,
      ]);
      expect(send.ok).toBe(true);
      sendMovementId = send.movement_id;

      const received = await call(c, 'phoenix_receive_warehouse_transfer_line', [randomUUID(), send.transfer_line_id, 20, null, null]);
      expect(received.ok).toBe(true);
      receiveMovementId = received.movement_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const sendMv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM warehouse_stock_movements WHERE id = $1`, [sendMovementId]);
      expect(sendMv.rows[0].reason_code).toBe('transferred');
      expect(sendMv.rows[0].correlation_id).not.toBeNull();
      expect(sendMv.rows[0].causation_id).toBeNull();

      const receiveMv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM warehouse_stock_movements WHERE id = $1`, [receiveMovementId]);
      expect(receiveMv.rows[0].reason_code).toBe('received');
      expect(receiveMv.rows[0].correlation_id).toBe(sendMv.rows[0].correlation_id);
      expect(receiveMv.rows[0].causation_id).toBe(sendMovementId);
    });
  });

  it('direct return send/receive: reason_code propagated, correlation/causation chain correctly through the shared receive function', async () => {
    let sendMovementId = '';
    let receiveMovementId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_CENTRAL, 'P129-B', 50, true, true, 0,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null,
      ]);
      const centralStock = rc.warehouse_stock_id;

      const tr = await call(c, 'phoenix_create_direct_warehouse_transfer_request', [
        WH_CENTRAL, ORG_INST, WH_INST, uniq('DTR'), null,
      ]);
      const transferTrace = tr.transfer_request_id ?? tr.id;
      await call(c, 'phoenix_add_warehouse_transfer_request_line', [transferTrace, 'P129-B', 20, null, null, null, null, null]);
      await call(c, 'phoenix_submit_warehouse_transfer_request', [transferTrace]);
      const tls = await c.query(`SELECT id, requested_quantity FROM warehouse_transfer_request_lines WHERE transfer_request_id=$1`, [transferTrace]);
      await call(c, 'phoenix_review_warehouse_transfer_request', [transferTrace, JSON.stringify(tls.rows.map((r: any) => ({ line_id: r.id, approved_quantity: r.requested_quantity })))]);
      const send = await call(c, 'phoenix_send_direct_warehouse_transfer_line', [
        randomUUID(), transferTrace, centralStock, 20, uniq('DTS'), tls.rows[0].id, null, null,
      ]);
      await call(c, 'phoenix_receive_warehouse_transfer_line', [randomUUID(), send.transfer_line_id, 20, null, null]);

      const wr = await call(c, 'phoenix_request_direct_warehouse_return', [WH_INST, WH_CENTRAL, uniq('DWR'), null]);
      const wrId = wr.return_request_id ?? wr.id;
      await call(c, 'phoenix_add_warehouse_return_request_line', [wrId, send.transfer_line_id, 10, 'excess', 'too much']);
      await call(c, 'phoenix_submit_warehouse_return_request', [wrId]);
      const wls = await c.query(`SELECT id, requested_quantity FROM warehouse_return_request_lines WHERE return_request_id=$1`, [wrId]);
      await call(c, 'phoenix_review_warehouse_return_request', [wrId, JSON.stringify(wls.rows.map((r: any) => ({ line_id: r.id, approved_quantity: r.requested_quantity })))]);

      const wsend = await call(c, 'phoenix_send_direct_warehouse_return_shipment_line', [
        randomUUID(), wls.rows[0].id, 10, uniq('DWS'), null, null,
      ]);
      expect(wsend.ok).toBe(true);
      sendMovementId = wsend.movement_id;

      const wreceived = await call(c, 'phoenix_receive_warehouse_return_shipment_line', [
        randomUUID(), wsend.shipment_line_id, 10, null, null, 'restockable',
      ]);
      expect(wreceived.ok).toBe(true);
      receiveMovementId = wreceived.movement_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const sendMv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM warehouse_stock_movements WHERE id = $1`, [sendMovementId]);
      expect(sendMv.rows[0].reason_code).toBe('excess');
      expect(sendMv.rows[0].correlation_id).not.toBeNull();
      expect(sendMv.rows[0].causation_id).toBeNull();

      const receiveMv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM warehouse_stock_movements WHERE id = $1`, [receiveMovementId]);
      expect(receiveMv.rows[0].reason_code).toBe('excess');
      expect(receiveMv.rows[0].correlation_id).toBe(sendMv.rows[0].correlation_id);
      expect(receiveMv.rows[0].causation_id).toBe(sendMovementId);
    });
  });
});
