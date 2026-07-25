/**
 * SUBPURCHASE-NATIONAL-CODE-116 — DYNAMIC proof.
 *
 * Drives the real (116-redefined) phoenix_subpurchase_direct_entry against a
 * disposable cluster (001→116):
 *   optional field   national code is recorded on the order line/receipt
 *                    line when given, and left null when omitted
 *   fingerprint      changing ONLY the national code under the same
 *                    request_id fails closed (request_id_conflict) — it is
 *                    part of the idempotency contract, not a side channel
 *   upgrade path     089 → 116 applies incrementally (true upgrade)
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-00000000f601';
const WH = '00000000-0000-0000-0000-00000000f602';
const OFFICER = '00000000-0000-0000-0000-00000000f603';

run('116 — sub-purchase national code (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  const asOfficer = (fn: (c: any) => Promise<any>) => rig.asUser(OFFICER, fn, { commit: true });

  const entry = (c: any, over: Record<string, unknown> = {}) => {
    const a = {
      request_id: randomUUID(), warehouse_id: WH, scientific: 'Amoxicillin',
      qty: 20, batch: 'NCB-1', no_batch: false, expiry: '2027-06-01', price: 300,
      purchase_date: '2026-07-01', invoice: 'REF-116-1', supplier: 'مورد وطني',
      notes: null, central_item: null, trade: 'Amoxil', conc: '500mg',
      dosage: 'capsule', unit: 'box', national_code: null, expected_generation: null,
      ...over,
    } as any;
    return call(c, 'phoenix_subpurchase_direct_entry', [
      a.request_id, a.warehouse_id, a.scientific, a.qty, a.batch, a.no_batch,
      a.expiry, a.price, a.purchase_date, a.invoice, a.supplier, a.notes,
      a.central_item, a.trade, a.conc, a.dosage, a.unit, a.national_code,
      a.expected_generation,
    ]);
  };

  beforeAll(async () => {
    rig = await buildRig({ upTo: 89 });
    // TRUE UPGRADE PATH: 089 state, then apply 116 incrementally.
    const sql116 = readFileSync(
      join(__dirname, '..', '116_phoenix_subpurchase_national_code.sql'), 'utf8');
    await rig.asAdmin((c: any) => c.query(sql116));

    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','NatCode116','رمز وطني 116','nc-116') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','NC WH','مذخر','active','institution','nc-116-w') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${OFFICER}','nc116-officer@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${OFFICER}';`);
      await c.query(`INSERT INTO profile_scope_assignments
          (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${OFFICER}','${ORG}','warehouse','${WH}',true) ON CONFLICT DO NOTHING;`);
    });
  }, 120000);

  afterAll(async () => { await rig?.end(); });

  it('records the national code on the order line and receipt line when given', async () => {
    const r = await asOfficer((c) => entry(c, { national_code: 'NC-0001' }));
    expect(r.ok).toBe(true);
    const line = await rig.asAdmin((c: any) => c.query(
      `SELECT national_code FROM procurement_order_lines WHERE order_id=$1`, [r.order_id])
      .then((x: any) => x.rows[0]));
    expect(line.national_code).toBe('NC-0001');
    const rline = await rig.asAdmin((c: any) => c.query(
      `SELECT national_code, has_no_national_code FROM procurement_receipt_lines WHERE receipt_id=$1`, [r.receipt_id])
      .then((x: any) => x.rows[0]));
    expect(rline.national_code).toBe('NC-0001');
    expect(rline.has_no_national_code).toBe(false);
  });

  it('leaves the national code null when omitted', async () => {
    const r = await asOfficer((c) => entry(c, { batch: 'NCB-2' }));
    expect(r.ok).toBe(true);
    const line = await rig.asAdmin((c: any) => c.query(
      `SELECT national_code FROM procurement_order_lines WHERE order_id=$1`, [r.order_id])
      .then((x: any) => x.rows[0]));
    expect(line.national_code).toBeNull();
  });

  it('changing ONLY the national code under the same request id fails closed', async () => {
    const requestId = randomUUID();
    await asOfficer((c) => entry(c, { request_id: requestId, batch: 'NCB-3', national_code: 'NC-A' }));
    await expect(asOfficer((c) => entry(c, { request_id: requestId, batch: 'NCB-3', national_code: 'NC-B' })))
      .rejects.toThrow(/request_id_conflict/);
  });
});
