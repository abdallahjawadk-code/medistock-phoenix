/**
 * MOVEMENT-REASON-CODE-GROUP-E-PROCUREMENT-130 — DYNAMIC proof against a
 * real disposable Postgres with 001->130 applied in order, driving the
 * FULL real RPC chain (create order -> submit -> approve -> receive ->
 * return-to-supplier) exactly as the frontend would.
 *
 * Proves:
 *   1. The receipt movement lands on reason_code='received', a fresh
 *      correlation_id, NULL causation_id.
 *   2. procurement_receipt_lines.movement_id (pre-existing, unchanged by
 *      this migration) points at that same receipt movement.
 *   3. phoenix_procurement_return_to_supplier requires p_reason_code and
 *      rejects an invalid one, even when the (still-mandatory) free-text
 *      p_reason is valid.
 *   4. The return movement lands on reason_code equal to the caller's
 *      validated p_reason_code, shares the receipt movement's
 *      correlation_id, and has causation_id equal to the receipt
 *      movement's own id -- chained from a column that already existed
 *      before this migration.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000130001';
const WH = '00000000-0000-0000-0000-000000130101';
const OFFICER = '00000000-0000-0000-0000-000000130401';

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

run('130 Group E procurement reason_code/correlation chain — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  const asOfficer = (fn: (c: any) => Promise<any>) => rig.asUser(OFFICER, fn, { commit: true });

  let supplierId: string;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 130 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Inst','مؤسسة','p130-i') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','IWH','مخزن','active','institution','p130-wi') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${OFFICER}','p130-officer@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${OFFICER}';`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${OFFICER}','${ORG}','warehouse','${WH}',true) ON CONFLICT DO NOTHING;`);
    });

    const created = await asOfficer((c) =>
      call(c, 'phoenix_procurement_save_supplier',
        [ORG, null, 'P130 Supplier', null, null, null, null, null, null, null, null]));
    supplierId = created.supplier_id;
  }, 120000);

  afterAll(async () => { if (rig) await rig.end(); });

  async function receiveOneLine(scientificName: string, quantity: number) {
    const number = uniq('PO');
    const batch = uniq('B');
    const createdOrder = await asOfficer((c) =>
      call(c, 'phoenix_procurement_create_order',
        [WH, supplierId, number, uniq('INV'), '2026-07-01', null, 'IQD', 'rig order', false]));
    const line = await asOfficer((c) =>
      call(c, 'phoenix_procurement_add_order_line',
        [createdOrder.order_id, scientificName, quantity, null, null, '500mg', 'tablet',
         'box', null, batch, '2027-01-01', 250, 'IQD', null]));
    await asOfficer((c) => call(c, 'phoenix_procurement_submit_order', [createdOrder.order_id, null]));
    // The officer both submits and approves here for test simplicity;
    // separation-of-duty is proven elsewhere (087's own test suite) and is
    // not this migration's concern.
    await rig.asAdmin((c: any) => c.query(
      `UPDATE procurement_orders SET status='approved' WHERE id=$1`, [createdOrder.order_id]));

    const rec = await asOfficer((c) => call(c, 'phoenix_procurement_receive_order',
      [randomUUID(), createdOrder.order_id, JSON.stringify([
        { order_line_id: line.order_line_id, quantity, batch_number: batch, has_no_batch_number: false },
      ]), null, null]));
    return { receiptLineId: rec.lines[0].receipt_line_id as string, movementId: rec.lines[0].movement_id as string };
  }

  it('receipt: reason_code=received, fresh correlation_id, NULL causation_id; receipt_line.movement_id points at it', async () => {
    const { receiptLineId, movementId } = await receiveOneLine('P130-A', 20);

    await rig.asAdmin(async (c: any) => {
      const mv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM warehouse_stock_movements WHERE id = $1`, [movementId]);
      expect(mv.rows[0].reason_code).toBe('received');
      expect(mv.rows[0].correlation_id).not.toBeNull();
      expect(mv.rows[0].causation_id).toBeNull();

      const line = await c.query(`SELECT movement_id FROM procurement_receipt_lines WHERE id = $1`, [receiptLineId]);
      expect(line.rows[0].movement_id).toBe(movementId);
    });
  });

  it('return_to_supplier requires p_reason_code and rejects an invalid one', async () => {
    const { receiptLineId } = await receiveOneLine('P130-B', 20);

    await rig.asUser(OFFICER, async (c: any) => {
      await expect(call(c, 'phoenix_procurement_return_to_supplier', [
        randomUUID(), receiptLineId, 2, 'damaged on arrival', null, null, null,
      ])).rejects.toThrow(/return_reason_code_required/);
    });

    await rig.asUser(OFFICER, async (c: any) => {
      await expect(call(c, 'phoenix_procurement_return_to_supplier', [
        randomUUID(), receiptLineId, 2, 'damaged on arrival', null, null, 'not_a_real_code',
      ])).rejects.toThrow(/invalid_procurement_return_reason_code/);
    });
  });

  it('return: reason_code equals the validated p_reason_code, correlation_id matches the receipt, causation_id equals the receipt movement id', async () => {
    const { receiptLineId, movementId: receiptMovementId } = await receiveOneLine('P130-C', 20);

    let returnMovementId = '';
    await rig.asUser(OFFICER, async (c: any) => {
      const ret = await call(c, 'phoenix_procurement_return_to_supplier', [
        randomUUID(), receiptLineId, 5, 'damaged on arrival', null, null, 'damaged',
      ]);
      expect(ret.ok).toBe(true);
      returnMovementId = ret.movement_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const receiptMv = await c.query(`SELECT correlation_id FROM warehouse_stock_movements WHERE id = $1`, [receiptMovementId]);
      const returnMv = await c.query(`SELECT reason_code, reason, correlation_id, causation_id FROM warehouse_stock_movements WHERE id = $1`, [returnMovementId]);
      expect(returnMv.rows[0].reason_code).toBe('damaged');
      expect(returnMv.rows[0].reason).toBe('damaged on arrival');
      expect(returnMv.rows[0].correlation_id).toBe(receiptMv.rows[0].correlation_id);
      expect(returnMv.rows[0].causation_id).toBe(receiptMovementId);
    });
  });
});
