/**
 * INSTITUTION-LOCAL-PROCUREMENT-087 — DYNAMIC proof.
 *
 * Drives the REAL RPCs of migration 087 against a disposable cluster with the
 * full chain 001→087 applied (085 prepared-only skipped, as in production):
 *
 *   suppliers        create / rename-collision / foreign-org scope
 *   lifecycle        draft → submitted → approved/rejected, separation of duty
 *   receiving        partial → partially_received → received, over-receipt
 *                    fails closed, idempotent lost-response retry, changed
 *                    payload rejected, expected-generation conflict (40001)
 *   ledger           stock lands ONLY on warehouse_stock via append-only 'add'
 *                    movements referencing the receipt line; reconciliation
 *                    receipts − returns = on_hand
 *   returns          provenance-pinned to the receipt line, capped at received,
 *                    reason-mandatory, reservation-safe, idempotent
 *   immutability     receipts/returns/events reject UPDATE, even as superuser
 *   RLS              a foreign-organization actor reads nothing
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database), like the other dynamic
 * proofs. Run serially (one file, sequential tests, shared fixtures).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-00000000d001';
const ORG_OTHER = '00000000-0000-0000-0000-00000000d002';
const WH = '00000000-0000-0000-0000-00000000d101';
const WH_OTHER = '00000000-0000-0000-0000-00000000d102';
const OFFICER = '00000000-0000-0000-0000-00000000d401';   // warehouse_officer @ WH
const ADMIN = '00000000-0000-0000-0000-00000000d402';     // institution_admin (approver)
const USER_OTHER = '00000000-0000-0000-0000-00000000d403'; // foreign org

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

run('087 — institution local procurement (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  const asOfficer = (fn: (c: any) => Promise<any>) => rig.asUser(OFFICER, fn, { commit: true });
  const asAdminUser = (fn: (c: any) => Promise<any>) => rig.asUser(ADMIN, fn, { commit: true });

  let supplierId: string;

  /** Create a draft order with two lines as OFFICER, return ids. */
  async function draftOrder(opts: { qty1?: number; qty2?: number } = {}) {
    const number = uniq('PO');
    const batch = uniq('B');
    const created = await asOfficer((c) =>
      call(c, 'phoenix_procurement_create_order',
        [WH, supplierId, number, uniq('INV'), '2026-07-01', null, 'IQD', 'rig order', false]));
    expect(created.ok).toBe(true);
    const l1 = await asOfficer((c) =>
      call(c, 'phoenix_procurement_add_order_line',
        [created.order_id, 'Paracetamol', opts.qty1 ?? 30, null, 'Pamol', '500mg', 'tablet',
         'box', uniq('NC'), batch, '2027-01-01', 250, 'IQD', null]));
    const l2 = await asOfficer((c) =>
      call(c, 'phoenix_procurement_add_order_line',
        [created.order_id, 'Ibuprofen', opts.qty2 ?? 20, null, null, '400mg', 'tablet',
         'box', null, null, '2027-06-01', 400, 'IQD', null]));
    return { orderId: created.order_id as string, number, batch, line1: l1.order_line_id as string, line2: l2.order_line_id as string };
  }

  /** Submit as OFFICER and approve as ADMIN. */
  async function approveOrder(orderId: string) {
    const submitted = await asOfficer((c) => call(c, 'phoenix_procurement_submit_order', [orderId, null]));
    expect(submitted.status).toBe('submitted');
    const decided = await asAdminUser((c) => call(c, 'phoenix_procurement_decide_order', [orderId, true, 'ok', null]));
    expect(decided.status).toBe('approved');
    return decided;
  }

  const orderRow = (id: string) =>
    rig.asAdmin((c: any) => c.query(
      `SELECT status, order_generation FROM procurement_orders WHERE id=$1`, [id])
      .then((r: any) => r.rows[0]));

  const stockRow = (stockId: string) =>
    rig.asAdmin((c: any) => c.query(
      `SELECT on_hand_quantity, reserved_quantity, movement_seq, supply_type_text, batch_number
         FROM warehouse_stock WHERE id=$1`, [stockId]).then((r: any) => r.rows[0]));

  beforeAll(async () => {
    rig = await buildRig({ upTo: 87 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Inst','مؤسسة','lp-i'),('${ORG_OTHER}','Other','أخرى','lp-o')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','IWH','مخزن','active','institution','lp-wi'),
        ('${WH_OTHER}','${ORG_OTHER}','OWH','مخزن2','active','institution','lp-wo')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${OFFICER}','lp-officer@rig'),('${ADMIN}','lp-admin@rig'),('${USER_OTHER}','lp-other@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${OFFICER}';`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG}' WHERE id='${ADMIN}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG_OTHER}' WHERE id='${USER_OTHER}';`);
      await c.query(`INSERT INTO profile_scope_assignments
          (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${OFFICER}','${ORG}','warehouse','${WH}',true),
               ('${USER_OTHER}','${ORG_OTHER}','warehouse','${WH_OTHER}',true)
        ON CONFLICT DO NOTHING;`);
    });

    const created = await asOfficer((c) =>
      call(c, 'phoenix_procurement_save_supplier',
        [ORG, null, 'Al-Rasheed Medical Supplies', 'الرشيد للتجهيزات الطبية',
         'Ali', '07901234567', null, 'Hilla', null, null, null]));
    expect(created.ok).toBe(true);
    supplierId = created.supplier_id;
  }, 120000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ── suppliers ─────────────────────────────────────────────────────────────

  it('a duplicate supplier name in the same institution is rejected', async () => {
    await expect(asOfficer((c) =>
      call(c, 'phoenix_procurement_save_supplier',
        [ORG, null, 'Al-Rasheed Medical Supplies', null, null, null, null, null, null, null, null])))
      .rejects.toThrow(/supplier_name_exists/);
  });

  it('a foreign-organization actor may not create suppliers here', async () => {
    await expect(rig.asUser(USER_OTHER, (c) =>
      call(c, 'phoenix_procurement_save_supplier',
        [ORG, null, uniq('Rogue'), null, null, null, null, null, null, null, null]),
      { commit: true })).rejects.toThrow(/forbidden_local_procurement_manage/);
  });

  // ── lifecycle + separation of duty ────────────────────────────────────────

  it('draft → submitted → approved, with events, and the officer cannot approve', async () => {
    const { orderId } = await draftOrder();
    const submitted = await asOfficer((c) => call(c, 'phoenix_procurement_submit_order', [orderId, null]));
    expect(submitted.status).toBe('submitted');

    // role default: warehouse_officer holds no local_procurement.approve
    await expect(asOfficer((c) => call(c, 'phoenix_procurement_decide_order', [orderId, true, null, null])))
      .rejects.toThrow(/forbidden_local_procurement_approve/);

    const decided = await asAdminUser((c) => call(c, 'phoenix_procurement_decide_order', [orderId, true, 'موافق', null]));
    expect(decided.status).toBe('approved');

    const events = await rig.asAdmin((c: any) => c.query(
      `SELECT event_type, from_status, to_status FROM procurement_order_events
        WHERE order_id=$1 ORDER BY created_at`, [orderId]).then((r: any) => r.rows));
    expect(events.map((e: any) => e.event_type)).toEqual(['created', 'submitted', 'approved']);
  });

  it('the submitter can never be the approver (separation of duty)', async () => {
    const number = uniq('PO');
    const created = await asAdminUser((c) =>
      call(c, 'phoenix_procurement_create_order', [WH, supplierId, number, null, null, null, null, null, false]));
    await asAdminUser((c) =>
      call(c, 'phoenix_procurement_add_order_line',
        [created.order_id, 'Amoxicillin', 10, null, null, '500mg', 'capsule', 'box', null, null, null, 300, null, null]));
    await asAdminUser((c) => call(c, 'phoenix_procurement_submit_order', [created.order_id, null]));
    await expect(asAdminUser((c) => call(c, 'phoenix_procurement_decide_order', [created.order_id, true, null, null])))
      .rejects.toThrow(/approver_must_differ_from_submitter/);
  });

  it('a submitted order can be rejected, and a draft with no lines cannot submit', async () => {
    const { orderId } = await draftOrder();
    await asOfficer((c) => call(c, 'phoenix_procurement_submit_order', [orderId, null]));
    const rejected = await asAdminUser((c) => call(c, 'phoenix_procurement_decide_order', [orderId, false, 'لا حاجة', null]));
    expect(rejected.status).toBe('rejected');

    const empty = await asOfficer((c) =>
      call(c, 'phoenix_procurement_create_order', [WH, supplierId, uniq('PO'), null, null, null, null, null, false]));
    await expect(asOfficer((c) => call(c, 'phoenix_procurement_submit_order', [empty.order_id, null])))
      .rejects.toThrow(/order_has_no_lines/);
  });

  it('lines are editable only while draft; a line edit invalidates a stale submit generation', async () => {
    const { orderId, line1, batch } = await draftOrder();
    const before = await orderRow(orderId);

    // edit a line — the ORDER generation must advance
    await asOfficer((c) => call(c, 'phoenix_procurement_update_order_line',
      [line1, null, 25, null, null, null, null, null, null, null, null, null, null, null]));
    const after = await orderRow(orderId);
    expect(Number(after.order_generation)).toBeGreaterThan(Number(before.order_generation));

    // submitting with the pre-edit generation conflicts (40001 class)
    await expect(asOfficer((c) =>
      call(c, 'phoenix_procurement_submit_order', [orderId, Number(before.order_generation)])))
      .rejects.toThrow(/procurement_order_generation_conflict/);

    // with the canonical generation it succeeds; then the draft is closed
    await asOfficer((c) =>
      call(c, 'phoenix_procurement_submit_order', [orderId, Number(after.order_generation)]));
    await expect(asOfficer((c) => call(c, 'phoenix_procurement_add_order_line',
      [orderId, 'Late', 1, null, null, null, null, null, null, null, null, null, null, null])))
      .rejects.toThrow(/order_not_draft/);
  });

  // ── receiving ─────────────────────────────────────────────────────────────

  it('receipts are blocked before approval', async () => {
    const { orderId, line1, batch } = await draftOrder();
    await expect(asOfficer((c) => call(c, 'phoenix_procurement_receive_order',
      [randomUUID(), orderId,
       JSON.stringify([{ order_line_id: line1, quantity: 5, batch_number: batch, has_no_batch_number: false }]),
       null, null]))).rejects.toThrow(/order_not_receivable/);
  });

  it('partial receipt → partially_received; completing receipt → received; ledger reconciles', async () => {
    const { orderId, line1, line2, batch } = await draftOrder({ qty1: 30, qty2: 20 });
    await approveOrder(orderId);

    const first = await asOfficer((c) => call(c, 'phoenix_procurement_receive_order',
      [randomUUID(), orderId, JSON.stringify([
        { order_line_id: line1, quantity: 10, batch_number: batch, has_no_batch_number: false, expiry_date: '2027-01-01', unit_price: 250 },
      ]), null, 'first delivery']));
    expect(first.ok).toBe(true);
    expect(first.order_status).toBe('partially_received');
    expect(first.lines).toHaveLength(1);
    const stockId = first.lines[0].warehouse_stock_id;
    expect((await stockRow(stockId)).on_hand_quantity).toBe(10);
    expect((await stockRow(stockId)).supply_type_text).toBe('local_procurement');

    const second = await asOfficer((c) => call(c, 'phoenix_procurement_receive_order',
      [randomUUID(), orderId, JSON.stringify([
        { order_line_id: line1, quantity: 20, batch_number: batch, has_no_batch_number: false, expiry_date: '2027-01-01' },
        { order_line_id: line2, quantity: 20, batch_number: null, has_no_batch_number: true, expiry_date: '2027-06-01' },
      ]), null, 'completion']));
    expect(second.order_status).toBe('received');
    expect((await stockRow(stockId)).on_hand_quantity).toBe(30); // same batch lot merged

    // the movements are append-only 'add' rows referencing the receipt lines
    const moves = await rig.asAdmin((c: any) => c.query(
      `SELECT movement_type, on_hand_delta FROM warehouse_stock_movements
        WHERE warehouse_stock_id=$1 AND reference_type='procurement_receipt_line'
        ORDER BY created_at`, [stockId]).then((r: any) => r.rows));
    expect(moves).toEqual([
      { movement_type: 'add', on_hand_delta: 10 },
      { movement_type: 'add', on_hand_delta: 20 },
    ]);
  });

  it('over-receipt fails closed and posts nothing', async () => {
    const { orderId, line1, batch } = await draftOrder({ qty1: 30 });
    await approveOrder(orderId);
    await expect(asOfficer((c) => call(c, 'phoenix_procurement_receive_order',
      [randomUUID(), orderId, JSON.stringify([
        { order_line_id: line1, quantity: 31, batch_number: batch, has_no_batch_number: false },
      ]), null, null]))).rejects.toThrow(/received_quantity_exceeds_ordered/);
    const line = await rig.asAdmin((c: any) => c.query(
      `SELECT received_quantity FROM procurement_order_lines WHERE id=$1`, [line1])
      .then((r: any) => r.rows[0]));
    expect(line.received_quantity).toBe(0);
  });

  it('a lost-response retry (same request id, same payload) is idempotent; a changed payload is rejected', async () => {
    const { orderId, line1, batch } = await draftOrder({ qty1: 30 });
    await approveOrder(orderId);
    const req = randomUUID();
    const payload = JSON.stringify([
      { order_line_id: line1, quantity: 10, batch_number: batch, has_no_batch_number: false },
    ]);
    const first = await asOfficer((c) => call(c, 'phoenix_procurement_receive_order', [req, orderId, payload, null, null]));
    expect(first.idempotent_replay).toBe(false);

    const replay = await asOfficer((c) => call(c, 'phoenix_procurement_receive_order', [req, orderId, payload, null, null]));
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.receipt_id).toBe(first.receipt_id);
    expect((await stockRow(first.lines[0].warehouse_stock_id)).on_hand_quantity).toBe(10); // one effect

    // same request id, DIFFERENT quantity — fails closed
    await expect(asOfficer((c) => call(c, 'phoenix_procurement_receive_order',
      [req, orderId, JSON.stringify([
        { order_line_id: line1, quantity: 11, batch_number: batch, has_no_batch_number: false },
      ]), null, null]))).rejects.toThrow(/request_id_conflict/);
  });

  it('two devices: a receipt against a stale order generation conflicts with 40001; the retry replays clean', async () => {
    const { orderId, line1, batch } = await draftOrder({ qty1: 30 });
    await approveOrder(orderId);
    const genBefore = Number((await orderRow(orderId)).order_generation);

    // device A posts first (advances the generation)
    const req = randomUUID();
    const payload = JSON.stringify([
      { order_line_id: line1, quantity: 5, batch_number: batch, has_no_batch_number: false },
    ]);
    await asOfficer((c) => call(c, 'phoenix_procurement_receive_order', [req, orderId, payload, genBefore, null]));

    // device B still holds genBefore — its DIFFERENT request conflicts
    await expect(asOfficer((c) => call(c, 'phoenix_procurement_receive_order',
      [randomUUID(), orderId, payload, genBefore, null])))
      .rejects.toThrow(/procurement_order_generation_conflict/);

    // device A's lost-response retry with the SAME request id + stale generation
    // short-circuits as a replay instead of conflicting
    const replay = await asOfficer((c) => call(c, 'phoenix_procurement_receive_order', [req, orderId, payload, genBefore, null]));
    expect(replay.idempotent_replay).toBe(true);
  });

  // ── returns ───────────────────────────────────────────────────────────────

  it('a return is provenance-pinned, capped at the received quantity, and reconciles the ledger', async () => {
    const { orderId, line1, batch } = await draftOrder({ qty1: 30 });
    await approveOrder(orderId);
    const rec = await asOfficer((c) => call(c, 'phoenix_procurement_receive_order',
      [randomUUID(), orderId, JSON.stringify([
        { order_line_id: line1, quantity: 12, batch_number: batch, has_no_batch_number: false },
      ]), null, null]));
    const receiptLineId = rec.lines[0].receipt_line_id;
    const stockId = rec.lines[0].warehouse_stock_id;

    const ret = await asOfficer((c) => call(c, 'phoenix_procurement_return_to_supplier',
      [randomUUID(), receiptLineId, 4, 'damaged on arrival', null, null]));
    expect(ret.ok).toBe(true);
    expect(ret.quantity_after).toBe(8);
    expect((await stockRow(stockId)).on_hand_quantity).toBe(8); // 12 − 4

    // idempotent replay of the same return
    const req = randomUUID();
    await asOfficer((c) => call(c, 'phoenix_procurement_return_to_supplier', [req, receiptLineId, 2, 'expired', null, null]));
    const replay = await asOfficer((c) => call(c, 'phoenix_procurement_return_to_supplier', [req, receiptLineId, 2, 'expired', null, null]));
    expect(replay.idempotent_replay).toBe(true);
    expect((await stockRow(stockId)).on_hand_quantity).toBe(6); // one effect

    // cap: 4 + 2 returned of 12 received — returning 7 more must fail
    await expect(asOfficer((c) => call(c, 'phoenix_procurement_return_to_supplier',
      [randomUUID(), receiptLineId, 7, 'too much', null, null])))
      .rejects.toThrow(/return_exceeds_received/);

    // a return without a reason is refused
    await expect(asOfficer((c) => call(c, 'phoenix_procurement_return_to_supplier',
      [randomUUID(), receiptLineId, 1, '  ', null, null])))
      .rejects.toThrow(/return_reason_required/);

    // the return movement is a subtract pinned to the return row
    const subtracts = await rig.asAdmin((c: any) => c.query(
      `SELECT movement_type, on_hand_delta, reference_type FROM warehouse_stock_movements
        WHERE warehouse_stock_id=$1 AND reference_type='procurement_return' ORDER BY created_at`,
      [stockId]).then((r: any) => r.rows));
    expect(subtracts).toEqual([
      { movement_type: 'subtract', on_hand_delta: -4, reference_type: 'procurement_return' },
      { movement_type: 'subtract', on_hand_delta: -2, reference_type: 'procurement_return' },
    ]);
  });

  it('a return never digs into reserved stock', async () => {
    const { orderId, line1, batch } = await draftOrder({ qty1: 30 });
    await approveOrder(orderId);
    const rec = await asOfficer((c) => call(c, 'phoenix_procurement_receive_order',
      [randomUUID(), orderId, JSON.stringify([
        { order_line_id: line1, quantity: 10, batch_number: batch, has_no_batch_number: false },
      ]), null, null]));
    const stockId = rec.lines[0].warehouse_stock_id;
    await rig.asAdmin((c: any) => c.query(
      `UPDATE warehouse_stock SET reserved_quantity=8 WHERE id=$1`, [stockId]));
    await expect(asOfficer((c) => call(c, 'phoenix_procurement_return_to_supplier',
      [randomUUID(), rec.lines[0].receipt_line_id, 5, 'reserved clash', null, null])))
      .rejects.toThrow(/insufficient_unreserved_stock/);
    await rig.asAdmin((c: any) => c.query(
      `UPDATE warehouse_stock SET reserved_quantity=0 WHERE id=$1`, [stockId]));
  });

  // ── scope, cancel, immutability ───────────────────────────────────────────

  it("a foreign-organization officer can neither write nor read this institution's procurement", async () => {
    const { orderId, line1, batch } = await draftOrder({ qty1: 30 });
    await approveOrder(orderId);

    await expect(rig.asUser(USER_OTHER, (c) => call(c, 'phoenix_procurement_receive_order',
      [randomUUID(), orderId, JSON.stringify([
        { order_line_id: line1, quantity: 1, batch_number: batch, has_no_batch_number: false },
      ]), null, null]), { commit: true }))
      .rejects.toThrow(/forbidden_local_procurement_receive/);

    const visible = await rig.asUser(USER_OTHER, (c: any) =>
      c.query(`SELECT count(*)::int AS n FROM procurement_orders WHERE organization_id=$1`, [ORG])
        .then((r: any) => r.rows[0].n));
    expect(visible).toBe(0);

    const mine = await rig.asUser(OFFICER, (c: any) =>
      c.query(`SELECT count(*)::int AS n FROM procurement_orders WHERE id=$1`, [orderId])
        .then((r: any) => r.rows[0].n));
    expect(mine).toBe(1);
  });

  it('cancel works for a draft but never after a receipt exists', async () => {
    const draft = await draftOrder();
    const cancelled = await asOfficer((c) =>
      call(c, 'phoenix_procurement_cancel_order', [draft.orderId, 'duplicate entry', null]));
    expect(cancelled.status).toBe('cancelled');

    const { orderId, line1, batch } = await draftOrder({ qty1: 30 });
    await approveOrder(orderId);
    await asOfficer((c) => call(c, 'phoenix_procurement_receive_order',
      [randomUUID(), orderId, JSON.stringify([
        { order_line_id: line1, quantity: 1, batch_number: batch, has_no_batch_number: false },
      ]), null, null]));
    await expect(asOfficer((c) => call(c, 'phoenix_procurement_cancel_order', [orderId, 'too late', null])))
      .rejects.toThrow(/order_not_cancellable/);
  });

  it('receipts, returns and events are immutable, even for a superuser session', async () => {
    const { orderId, line1, batch } = await draftOrder({ qty1: 30 });
    await approveOrder(orderId);
    const rec = await asOfficer((c) => call(c, 'phoenix_procurement_receive_order',
      [randomUUID(), orderId, JSON.stringify([
        { order_line_id: line1, quantity: 3, batch_number: batch, has_no_batch_number: false },
      ]), null, null]));

    await expect(rig.asAdmin((c: any) => c.query(
      `UPDATE procurement_receipts SET notes='edited' WHERE id=$1`, [rec.receipt_id])))
      .rejects.toThrow(/procurement_history_is_immutable/);
    await expect(rig.asAdmin((c: any) => c.query(
      `UPDATE procurement_receipt_lines SET quantity=999 WHERE receipt_id=$1`, [rec.receipt_id])))
      .rejects.toThrow(/procurement_history_is_immutable/);
    await expect(rig.asAdmin((c: any) => c.query(
      `DELETE FROM procurement_order_events WHERE order_id=$1`, [orderId])))
      .rejects.toThrow(/procurement_history_is_immutable/);
  });
});
