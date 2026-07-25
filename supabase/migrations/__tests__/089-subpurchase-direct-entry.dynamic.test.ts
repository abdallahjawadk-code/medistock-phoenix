/**
 * SUBPURCHASE-DIRECT-ENTRY-089 — DYNAMIC proof.
 *
 * Drives the real phoenix_subpurchase_direct_entry against a disposable
 * cluster (001→089):
 *   one act        order + line + receipt + stock in one call; official
 *                  server-generated SP- order number and PR- receipt number
 *   provenance     the lot lands as purchase/SUPPLEMENTARY (088 identity),
 *                  separate from any central lot of the same identity
 *   idempotency    lost-response retry replays the SAME receipt exactly once;
 *                  a changed payload with the same request id fails closed
 *   authority      both scoped keys are required — a foreign-org actor is
 *                  rejected; audit rows record the act
 *   upgrade path   088 → 089 applies incrementally (true upgrade, not only a
 *                  fresh replay)
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-00000000f001';
const ORG_OTHER = '00000000-0000-0000-0000-00000000f002';
const WH = '00000000-0000-0000-0000-00000000f101';
const OFFICER = '00000000-0000-0000-0000-00000000f401';
const OUTSIDER = '00000000-0000-0000-0000-00000000f402';

run('089 — sub-purchase direct entry (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  const asOfficer = (fn: (c: any) => Promise<any>) => rig.asUser(OFFICER, fn, { commit: true });

  const entry = (c: any, over: Record<string, unknown> = {}) => {
    const a = {
      request_id: randomUUID(), warehouse_id: WH, scientific: 'Cefixime',
      qty: 40, batch: 'SPB-1', no_batch: false, expiry: '2027-06-01', price: 750,
      purchase_date: '2026-07-01', invoice: 'INV-SP-1', supplier: 'صيدلية المصدر',
      notes: null, central_item: null, trade: 'Suprax', conc: '400mg',
      dosage: 'capsule', unit: 'box', expected_generation: null,
      ...over,
    } as any;
    return call(c, 'phoenix_subpurchase_direct_entry', [
      a.request_id, a.warehouse_id, a.scientific, a.qty, a.batch, a.no_batch,
      a.expiry, a.price, a.purchase_date, a.invoice, a.supplier, a.notes,
      a.central_item, a.trade, a.conc, a.dosage, a.unit, a.expected_generation,
    ]);
  };

  beforeAll(async () => {
    rig = await buildRig({ upTo: 88 });
    // TRUE UPGRADE PATH: 088 state, then apply 089 incrementally.
    const sql089 = readFileSync(
      join(__dirname, '..', '089_phoenix_subpurchase_direct_entry.sql'), 'utf8');
    await rig.asAdmin((c: any) => c.query(sql089));

    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','SubP','مؤسسة الفرعية','sp-i'),('${ORG_OTHER}','Other','أخرى','sp-o')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','SW','مذخر','active','institution','sp-w') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${OFFICER}','sp-officer@rig'),('${OUTSIDER}','sp-outsider@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${OFFICER}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG_OTHER}' WHERE id='${OUTSIDER}';`);
      await c.query(`INSERT INTO profile_scope_assignments
          (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${OFFICER}','${ORG}','warehouse','${WH}',true) ON CONFLICT DO NOTHING;`);
    });
  }, 120000);

  afterAll(async () => { await rig?.end(); });

  let firstOrderNumber: string;

  it('one act creates order + receipt + stock with SERVER-generated numbers', async () => {
    const r = await asOfficer((c) => entry(c));
    expect(r.ok).toBe(true);
    expect(r.order_status).toBe('received');
    expect(r.order_number).toMatch(/^SP-\d{4}-\d{6}$/);
    expect(r.receipt_number).toMatch(/^PR-\d{4}-\d{6}$/);
    expect(r.warehouse_stock_id).toBeTruthy();
    firstOrderNumber = r.order_number;

    const lot = await rig.asAdmin((c: any) => c.query(
      `SELECT supply_type, purchase_origin, on_hand_quantity
         FROM warehouse_stock WHERE id=$1`, [r.warehouse_stock_id])
      .then((x: any) => x.rows[0]));
    expect(lot.supply_type).toBe('purchase');
    expect(lot.purchase_origin).toBe('supplementary');
    expect(lot.on_hand_quantity).toBe(40);
  });

  it('a lost-response retry replays the SAME receipt exactly once', async () => {
    const requestId = randomUUID();
    const first = await asOfficer((c) => entry(c, { request_id: requestId, batch: 'SPB-2', qty: 5 }));
    const replay = await asOfficer((c) => entry(c, { request_id: requestId, batch: 'SPB-2', qty: 5 }));
    expect(first.ok).toBe(true);
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.receipt_id).toBe(first.receipt_id);
    const receipts = await rig.asAdmin((c: any) => c.query(
      `SELECT count(*)::int AS n FROM procurement_receipts WHERE request_id=$1`, [requestId])
      .then((x: any) => x.rows[0].n));
    expect(receipts).toBe(1);
  });

  it('the same request id with a CHANGED payload fails closed', async () => {
    const requestId = randomUUID();
    await asOfficer((c) => entry(c, { request_id: requestId, batch: 'SPB-3', qty: 5 }));
    await expect(asOfficer((c) => entry(c, { request_id: requestId, batch: 'SPB-3', qty: 9 })))
      .rejects.toThrow(/request_id_conflict/);
  });

  it('the supplementary lot stays SEPARATE from a central lot of the same identity', async () => {
    // Receive the SAME identity as a CENTRAL purchase through the guarded 088 receipt.
    const central = await asOfficer((c) => call(c, 'phoenix_receive_warehouse_stock_guarded', [
      randomUUID(), WH, 'Cefixime', 12, true, false, 0, null, 'Suprax', '400mg',
      'capsule', 'box', null, 'SPB-1', '2027-06-01', 750, null, null, null, null, null,
      'purchase', null,
    ]));
    expect(central.ok).toBe(true);
    const lots = await rig.asAdmin((c: any) => c.query(
      `SELECT purchase_origin, on_hand_quantity FROM warehouse_stock
        WHERE warehouse_id=$1 AND scientific_name='Cefixime' AND batch_number='SPB-1'
        ORDER BY purchase_origin`, [WH]).then((x: any) => x.rows));
    expect(lots).toHaveLength(2);
    expect(lots.map((l: any) => l.purchase_origin)).toEqual(['central', 'supplementary']);
  });

  it('a foreign-organization actor is rejected (both scoped keys required)', async () => {
    await expect(rig.asUser(OUTSIDER, (c: any) => entry(c), { commit: true }))
      .rejects.toThrow(/forbidden_local_procurement/);
  });

  it('the act is fully audited', async () => {
    const rows = await rig.asAdmin((c: any) => c.query(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE action='local_procurement.direct_entry' AND organization_id=$1`, [ORG])
      .then((x: any) => x.rows[0].n));
    expect(rows).toBeGreaterThanOrEqual(1);
  });

  it('order history records the direct-entry provenance, not a hidden approval bypass', async () => {
    const order = await rig.asAdmin((c: any) => c.query(
      `SELECT decision_notes, submitted_by, decided_by FROM procurement_orders
        WHERE order_number=$1`, [firstOrderNumber]).then((x: any) => x.rows[0]));
    expect(order.decision_notes).toContain('direct sub-purchase entry (089)');
    expect(order.submitted_by).toBe(order.decided_by);
  });
});
