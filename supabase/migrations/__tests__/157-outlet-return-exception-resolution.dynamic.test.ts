/**
 * OUTLET-RETURN-EXCEPTION-RESOLUTION-157 — DYNAMIC integration proof, against
 * a real disposable Postgres with 001->157 applied in order.
 *
 * driveCorridorToException reuses 135's own dynamic test's real-RPC-chain
 * pattern (warehouse receive -> transfer send/receive -> dispatch create/
 * add/send -> outlet dispatch-receive -> outlet return request/add/submit/
 * review/send), ending in a REAL zero-quantity
 * phoenix_receive_outlet_return_shipment_line call so the line reaches
 * genuine custody_state='exception_pending' exactly the way production
 * would reach it — not a hand-crafted row.
 *
 * Then proves: both owner-mandated resolution paths (corrected_receipt
 * restockable/quarantined, confirmed_no_stock), the original exception row
 * is never mutated, idempotent replay, request_id_conflict on a mismatched
 * payload, exception_already_resolved on a second distinct attempt,
 * line_not_exception_pending as a guard, and permission enforcement.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI-without-rig (no database).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_CENTRAL = '00000000-0000-0000-0000-000000157001';
const ORG_INST = '00000000-0000-0000-0000-000000157002';
const WH_CENTRAL = '00000000-0000-0000-0000-000000157101';
const WH_INST = '00000000-0000-0000-0000-000000157102';
const DP_OUTLET = '00000000-0000-0000-0000-000000157301';
const ROUTE = '00000000-0000-0000-0000-000000157501';

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

const call = (c: any, fn: string, args: any[]) =>
  c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
    .then((res: any) => res.rows[0].r);

run('157 outlet-return-exception-resolution — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 157 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_CENTRAL}','C','مركز','p157-c'),('${ORG_INST}','I','مؤسسة','p157-i')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG_CENTRAL}','CWH','مخزنC','active','central','p157-wc'),
        ('${WH_INST}','${ORG_INST}','IWH','مخزنI','active','institution','p157-wi')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP_OUTLET}','${WH_INST}','${ORG_INST}','Outlet','منفذ','pharmacy','active') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes
        (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution', true) ON CONFLICT (id) DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  /** Drives the whole real corridor and ends on a genuine zero-quantity
   * receive, reaching real custody_state='exception_pending'. */
  async function driveCorridorToException(material: string) {
    let shipmentLineId = '';

    await rig.asUser(rig.superAdminId, async (c: any) => {
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
      const dispatchLineId = dls.rows[0].id;

      await call(c, 'phoenix_receive_outlet_dispatch_line', [randomUUID(), dispatchLineId, 40, null, null]);

      const req = await call(c, 'phoenix_request_outlet_return', [DP_OUTLET, uniq('OR')]);
      const returnRequestId = req.return_request_id ?? req.id;
      const addLine = await call(c, 'phoenix_add_outlet_return_request_line',
        [returnRequestId, dispatchLineId, 10, 'shipment_error', 'p157 proof']);
      const returnLineId = addLine.return_request_line_id;
      await call(c, 'phoenix_submit_outlet_return_request', [returnRequestId]);
      await call(c, 'phoenix_review_outlet_return_request',
        [returnRequestId, JSON.stringify([{ line_id: returnLineId, approved_quantity: 10 }])]);

      const returnSent = await call(c, 'phoenix_send_outlet_return_shipment_line',
        [randomUUID(), returnLineId, null, 10, uniq('ORS'), null, null]);
      expect(returnSent.ok).toBe(true);
      shipmentLineId = returnSent.shipment_line_id;

      // THE exception-inducing call: a real zero-quantity receive.
      const receiveResult = await call(c, 'phoenix_receive_outlet_return_shipment_line',
        [randomUUID(), shipmentLineId, 0, 'nothing physically arrived', null, null]);
      expect(receiveResult.ok).toBe(true);
      expect(receiveResult.custody_state).toBe('exception_pending');
    }, { commit: true });

    return { shipmentLineId };
  }

  const resolve = (
    requestId: string, lineId: string, kind: string, reason: string,
    quantity: number | null = null, disposition: string | null = null,
  ) => rig.asUser(rig.superAdminId, (c: any) =>
    call(c, 'phoenix_resolve_outlet_return_exception', [
      requestId, lineId, kind, reason, quantity, disposition,
    ]), { commit: true });

  it('resolves to exactly one RPC overload with the expected identity arguments', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`
        SELECT pg_get_function_identity_arguments(oid) AS args
        FROM pg_proc WHERE proname = 'phoenix_resolve_outlet_return_exception'`);
      expect(r.rows.length).toBe(1);
      expect(r.rows[0].args).toBe(
        'p_request_id uuid, p_return_shipment_line_id uuid, p_resolution_kind text, ' +
        'p_reason text, p_corrected_quantity integer, p_disposition_decision text',
      );
    });
  });

  it('corrected_receipt/restockable: creates real compensating stock, never touches the original exception row', async () => {
    const { shipmentLineId } = await driveCorridorToException('P157-CORRECT-RESTOCK');
    const before = await rig.asAdmin((c: any) => c.query(
      `SELECT status, custody_state, received_quantity, disposition FROM outlet_return_shipment_lines WHERE id=$1`,
      [shipmentLineId]));
    expect(before.rows[0]).toEqual({
      status: 'rejected', custody_state: 'exception_pending', received_quantity: 0, disposition: null,
    });

    const result = await resolve(
      randomUUID(), shipmentLineId, 'corrected_receipt', 'operator miscounted, 10 actually arrived',
      10, 'restockable',
    );
    expect(result.ok).toBe(true);
    expect(result.resolution_kind).toBe('corrected_receipt');
    expect(result.warehouse_stock_id).toBeTruthy();
    expect(result.quantity_delta).toBe(10);

    // The ORIGINAL row is byte-for-byte unchanged — this is the owner's
    // explicit "never rewrite history" requirement.
    const after = await rig.asAdmin((c: any) => c.query(
      `SELECT status, custody_state, received_quantity, disposition FROM outlet_return_shipment_lines WHERE id=$1`,
      [shipmentLineId]));
    expect(after.rows[0]).toEqual(before.rows[0]);

    await rig.asAdmin(async (c: any) => {
      const mv = await c.query(
        `SELECT movement_type, reference_type FROM warehouse_stock_movements WHERE id=$1`,
        [result.movement_id]);
      expect(mv.rows[0]).toEqual({
        // 'correction' reuses the pre-existing warehouse_stock_movements_
        // type_chk value (this repo never widens that CHECK, per 070's own
        // header comment) — reference_type is the actual distinguishing
        // marker from an ordinary receive.
        movement_type: 'correction',
        reference_type: 'outlet_return_exception_resolve',
      });
      const ledger = await c.query(
        `SELECT resolution_kind, corrected_quantity, disposition FROM phoenix_outlet_return_exception_resolutions WHERE return_shipment_line_id=$1`,
        [shipmentLineId]);
      expect(ledger.rows[0]).toEqual({
        resolution_kind: 'corrected_receipt', corrected_quantity: 10, disposition: 'restockable',
      });
    });
  });

  it('corrected_receipt/quarantined: creates real compensating quarantine stock', async () => {
    const { shipmentLineId } = await driveCorridorToException('P157-CORRECT-QUAR');
    const result = await resolve(
      randomUUID(), shipmentLineId, 'corrected_receipt', 'arrived damaged, quarantine it',
      5, 'quarantined',
    );
    expect(result.ok).toBe(true);
    expect(result.quarantine_stock_id).toBeTruthy();
    expect(result.warehouse_stock_id).toBeFalsy();

    await rig.asAdmin(async (c: any) => {
      const mv = await c.query(
        `SELECT movement_type, reference_type FROM warehouse_quarantine_stock_movements WHERE id=$1`,
        [result.movement_id]);
      expect(mv.rows[0]).toEqual({
        // 'quarantine_correction' reuses the pre-existing wqsm_type_chk value.
        movement_type: 'quarantine_correction',
        reference_type: 'outlet_return_exception_resolve',
      });
    });
  });

  it('confirmed_no_stock: closes the exception with no stock/movement of any kind', async () => {
    const { shipmentLineId } = await driveCorridorToException('P157-CONFIRM-EMPTY');
    const result = await resolve(
      randomUUID(), shipmentLineId, 'confirmed_no_stock', 'physically verified, nothing arrived',
    );
    expect(result.ok).toBe(true);
    expect(result.resolution_kind).toBe('confirmed_no_stock');
    expect(result.warehouse_stock_id).toBeFalsy();
    expect(result.quarantine_stock_id).toBeFalsy();
    expect(result.movement_id).toBeFalsy();

    await rig.asAdmin(async (c: any) => {
      const ledger = await c.query(
        `SELECT resolution_kind, corrected_quantity, disposition FROM phoenix_outlet_return_exception_resolutions WHERE return_shipment_line_id=$1`,
        [shipmentLineId]);
      expect(ledger.rows[0]).toEqual({
        resolution_kind: 'confirmed_no_stock', corrected_quantity: null, disposition: null,
      });
    });
  });

  it('a same-request-id, same-payload replay returns the identical result, no second row', async () => {
    const { shipmentLineId } = await driveCorridorToException('P157-REPLAY');
    const requestId = randomUUID();
    const first = await resolve(requestId, shipmentLineId, 'confirmed_no_stock', 'verified empty');
    const second = await resolve(requestId, shipmentLineId, 'confirmed_no_stock', 'verified empty');
    expect(second).toEqual(first);

    await rig.asAdmin(async (c: any) => {
      const n = await c.query(
        `SELECT count(*)::int n FROM phoenix_outlet_return_exception_resolutions WHERE return_shipment_line_id=$1`,
        [shipmentLineId]);
      expect(n.rows[0].n).toBe(1);
    });
  });

  it('a same-request-id, different-payload retry raises request_id_conflict (23505)', async () => {
    const { shipmentLineId } = await driveCorridorToException('P157-CONFLICT');
    const requestId = randomUUID();
    await resolve(requestId, shipmentLineId, 'confirmed_no_stock', 'verified empty');
    await expect(resolve(requestId, shipmentLineId, 'confirmed_no_stock', 'a different reason'))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('a DIFFERENT request_id targeting an already-resolved line raises exception_already_resolved', async () => {
    const { shipmentLineId } = await driveCorridorToException('P157-DOUBLE');
    await resolve(randomUUID(), shipmentLineId, 'confirmed_no_stock', 'verified empty');
    await expect(resolve(randomUUID(), shipmentLineId, 'corrected_receipt', 'actually something arrived', 3, 'restockable'))
      .rejects.toMatchObject({ code: '23505', message: expect.stringContaining('exception_already_resolved') });
  });

  it('rejects a line that is not exception_pending (e.g. a normal in_transit line)', async () => {
    let inTransitLineId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_CENTRAL, 'P157-NOTPENDING', 60, true, true, 0,
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
      const dispatchLineId = dls.rows[0].id;
      await call(c, 'phoenix_receive_outlet_dispatch_line', [randomUUID(), dispatchLineId, 40, null, null]);
      const req = await call(c, 'phoenix_request_outlet_return', [DP_OUTLET, uniq('OR')]);
      const returnRequestId = req.return_request_id ?? req.id;
      const addLine = await call(c, 'phoenix_add_outlet_return_request_line',
        [returnRequestId, dispatchLineId, 10, 'shipment_error', 'not pending proof']);
      const returnLineId = addLine.return_request_line_id;
      await call(c, 'phoenix_submit_outlet_return_request', [returnRequestId]);
      await call(c, 'phoenix_review_outlet_return_request',
        [returnRequestId, JSON.stringify([{ line_id: returnLineId, approved_quantity: 10 }])]);
      const returnSent = await call(c, 'phoenix_send_outlet_return_shipment_line',
        [randomUUID(), returnLineId, null, 10, uniq('ORS'), null, null]);
      inTransitLineId = returnSent.shipment_line_id;
      // Deliberately NOT calling receive — this line stays 'in_transit'.
    }, { commit: true });

    await expect(resolve(randomUUID(), inTransitLineId, 'confirmed_no_stock', 'should be rejected'))
      .rejects.toMatchObject({ code: '23514', message: expect.stringContaining('line_not_exception_pending') });
  });

  it('outlet_officer (holds neither review_return nor resolve_return_exception) is forbidden', async () => {
    const { shipmentLineId } = await driveCorridorToException('P157-FORBIDDEN');
    const outletOfficerId = randomUUID();
    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO auth.users (id, email) VALUES ('${outletOfficerId}', 'p157-outlet-officer@example.com')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO profiles (id, organization_id, role, status, full_name)
      VALUES ('${outletOfficerId}', '${ORG_INST}', 'outlet_officer', 'active', 'P157 Outlet Officer')
      ON CONFLICT (id) DO NOTHING;
    `));

    await expect(rig.asUser(outletOfficerId, (c: any) =>
      call(c, 'phoenix_resolve_outlet_return_exception', [
        randomUUID(), shipmentLineId, 'confirmed_no_stock', 'should be forbidden', null, null,
      ]), { commit: true })).rejects.toMatchObject({ code: '42501' });
  });

  it('154s transfer-corridor privilege lockdown and 135s receive RPC are unaffected', async () => {
    await rig.asAdmin(async (c: any) => {
      for (const t of ['warehouse_transfer_requests', 'warehouse_transfer_request_lines', 'warehouse_transfers', 'warehouse_transfer_lines']) {
        const r = await c.query(`SELECT has_table_privilege('authenticated', 'public.' || $1, 'TRUNCATE') AS has`, [t]);
        expect(r.rows[0].has).toBe(false);
      }
      const r = await c.query(
        `SELECT pg_get_function_identity_arguments(oid) AS args FROM pg_proc WHERE proname = 'phoenix_receive_outlet_return_shipment_line'`);
      expect(r.rows.length).toBe(1);
    });
  });
});
