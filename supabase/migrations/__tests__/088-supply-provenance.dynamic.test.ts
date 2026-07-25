/**
 * CANONICAL-SUPPLY-PROVENANCE-088 — DYNAMIC proof.
 *
 * Drives the REAL guarded RPCs against a disposable cluster with the full
 * chain 001→088 applied:
 *
 *   separation      the same material/batch/expiry received as 'aid' and as
 *                   'purchase' lands in TWO separate lots; physical total is
 *                   the sum of the per-source balances by construction
 *   central default a pharmacy-warehouse 'purchase' receipt defaults its
 *                   origin to 'central' server-side
 *   087 pinning     a sub-purchase receipt lands as purchase/supplementary,
 *                   separate from a central-purchase lot of the SAME identity
 *   no auto-draw    draining one source beyond its own balance fails closed
 *                   even while the other source still has stock
 *   validation      closed vocabulary + origin-only-with-purchase
 *   reconciliation  phoenix_provenance_reconciliation() returns zero rows;
 *                   phoenix_warehouse_source_balances() reports per source
 *   sealing         the re-issued legacy writer signature is NOT executable
 *                   by authenticated (080 discipline carried through 088)
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-00000000e001';
const WH = '00000000-0000-0000-0000-00000000e101';
const OFFICER = '00000000-0000-0000-0000-00000000e401';
const ADMIN = '00000000-0000-0000-0000-00000000e402';

run('088 — canonical supply provenance (dynamic)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  const asOfficer = (fn: (c: any) => Promise<any>) => rig.asUser(OFFICER, fn, { commit: true });
  const asAdminUser = (fn: (c: any) => Promise<any>) => rig.asUser(ADMIN, fn, { commit: true });

  /** Guarded receipt with canonical provenance (new 088 signature). */
  const receive = (c: any, over: Record<string, unknown> = {}) => {
    const a = {
      request_id: randomUUID(), warehouse_id: WH, scientific: 'Amoxicillin',
      qty: 30, no_nc: false, no_batch: false, expected_generation: 0,
      central_item: null, trade: 'Amoxil', conc: '500mg', dosage: 'capsule',
      unit: 'box', nc: 'NC-777', batch: 'B-1', expiry: '2027-03-01',
      price: 500, basis: null, currency: 'IQD', supply_text: null,
      source_doc: null, notes: null, supply_type: null, origin: null,
      ...over,
    } as any;
    return call(c, 'phoenix_receive_warehouse_stock_guarded', [
      a.request_id, a.warehouse_id, a.scientific, a.qty, a.no_nc, a.no_batch,
      a.expected_generation, a.central_item, a.trade, a.conc, a.dosage, a.unit,
      a.nc, a.batch, a.expiry, a.price, a.basis, a.currency, a.supply_text,
      a.source_doc, a.notes, a.supply_type, a.origin,
    ]);
  };

  const lots = () => rig.asAdmin((c: any) => c.query(
    `SELECT id, supply_type, purchase_origin, on_hand_quantity, movement_seq
       FROM warehouse_stock WHERE warehouse_id=$1 AND scientific_name='Amoxicillin'
      ORDER BY supply_type, purchase_origin NULLS FIRST`, [WH]).then((r: any) => r.rows));

  beforeAll(async () => {
    rig = await buildRig({ upTo: 88 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','ProvInst','مؤسسة المصدر','pv-i') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','PWH','مخزن المصدر','active','institution','pv-w')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${OFFICER}','pv-officer@rig'),('${ADMIN}','pv-admin@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${OFFICER}';`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG}' WHERE id='${ADMIN}';`);
      await c.query(`INSERT INTO profile_scope_assignments
          (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${OFFICER}','${ORG}','warehouse','${WH}',true) ON CONFLICT DO NOTHING;`);
    });
  }, 120000);

  afterAll(async () => { await rig?.end(); });

  it('receives the SAME identity as aid and as purchase into TWO separate lots', async () => {
    const aid = await asOfficer((c) => receive(c, { supply_type: 'aid' }));
    expect(aid.ok).toBe(true);

    // Same material/batch/expiry, different source, FIRST receipt of that
    // source → expected generation 0 for the new per-source lot.
    const purchase = await asOfficer((c) => receive(c, { supply_type: 'purchase', qty: 20 }));
    expect(purchase.ok).toBe(true);
    expect(purchase.warehouse_stock_id).not.toBe(aid.warehouse_stock_id);

    const rows = await lots();
    expect(rows).toHaveLength(2);
    const aidLot = rows.find((r: any) => r.supply_type === 'aid');
    const purchaseLot = rows.find((r: any) => r.supply_type === 'purchase');
    expect(aidLot.on_hand_quantity).toBe(30);
    expect(aidLot.purchase_origin).toBeNull();
    expect(purchaseLot.on_hand_quantity).toBe(20);
    // The physical total IS the sum of the source balances by construction.
    expect(aidLot.on_hand_quantity + purchaseLot.on_hand_quantity).toBe(50);
  });

  it('a pharmacy-warehouse purchase defaults its origin to CENTRAL server-side', async () => {
    const rows = await lots();
    expect(rows.find((r: any) => r.supply_type === 'purchase').purchase_origin).toBe('central');
  });

  it('kimadia is a valid third source; هبات/donations is NOT a canonical value', async () => {
    const kim = await asOfficer((c) => receive(c, { supply_type: 'kimadia', qty: 5 }));
    expect(kim.ok).toBe(true);
    await expect(asOfficer((c) => receive(c, { supply_type: 'donations' })))
      .rejects.toThrow(/invalid_supply_type/);
  });

  it('an origin without purchase fails closed', async () => {
    await expect(asOfficer((c) => receive(c, { supply_type: 'aid', origin: 'central' })))
      .rejects.toThrow(/purchase_origin_without_purchase/);
  });

  it('draining one source beyond its own balance fails even while the other has stock', async () => {
    const rows = await lots();
    const purchaseLot = rows.find((r: any) => r.supply_type === 'purchase');
    // purchase lot holds 20; aid holds 30. Subtract 25 from PURCHASE must fail:
    // the system never silently draws from the aid source.
    await expect(asOfficer((c) => call(c, 'phoenix_apply_warehouse_stock_movement_guarded', [
      randomUUID(), purchaseLot.id, 'subtract', 25, 'over-drain probe',
      purchaseLot.movement_seq, null, null,
    ]))).rejects.toThrow(/warehouse_quantity_cannot_go_negative/);
  });

  it('a lost-response retry replays the SAME per-source receipt exactly once', async () => {
    const requestId = randomUUID();
    const first = await asOfficer((c) => receive(c, { request_id: requestId, supply_type: 'aid', qty: 7, expected_generation: 1 }));
    expect(first.ok).toBe(true);
    const replay = await asOfficer((c) => receive(c, { request_id: requestId, supply_type: 'aid', qty: 7, expected_generation: 1 }));
    expect(replay.idempotent_replay).toBe(true);
    const rows = await lots();
    expect(rows.find((r: any) => r.supply_type === 'aid').on_hand_quantity).toBe(37);
  });

  it('087 sub-purchase receiving lands as purchase/SUPPLEMENTARY, separate from the central lot', async () => {
    const supplier = await asOfficer((c) => call(c, 'phoenix_procurement_save_supplier',
      [ORG, null, 'Prov Supplier', 'مورد', null, null, null, null, null, null, null]));
    const order = await asOfficer((c) => call(c, 'phoenix_procurement_create_order',
      [WH, supplier.supplier_id, 'PV-PO-1', 'PV-INV-1', '2026-07-01', null, 'IQD', null, false]));
    const line = await asOfficer((c) => call(c, 'phoenix_procurement_add_order_line',
      [order.order_id, 'Amoxicillin', 10, null, 'Amoxil', '500mg', 'capsule',
       'box', 'NC-777', 'B-1', '2027-03-01', 450, 'IQD', null]));
    await asOfficer((c) => call(c, 'phoenix_procurement_submit_order', [order.order_id, null]));
    await asAdminUser((c) => call(c, 'phoenix_procurement_decide_order', [order.order_id, true, 'ok', null]));
    const received = await asOfficer((c) => call(c, 'phoenix_procurement_receive_order', [
      randomUUID(), order.order_id,
      JSON.stringify([{ order_line_id: line.order_line_id, quantity: 10,
        batch_number: 'B-1', has_no_batch_number: false, expiry_date: '2027-03-01', unit_price: 450 }]),
      null, null,
    ]));
    expect(received.ok).toBe(true);

    const rows = await lots();
    const supplementary = rows.find((r: any) => r.purchase_origin === 'supplementary');
    const central = rows.find((r: any) => r.purchase_origin === 'central');
    expect(supplementary).toBeDefined();
    expect(supplementary.supply_type).toBe('purchase');
    expect(supplementary.on_hand_quantity).toBe(10);
    // The central-purchase lot of the SAME identity is untouched and separate.
    expect(central.on_hand_quantity).toBe(20);
    expect(supplementary.id).not.toBe(central.id);
  });

  it('reconciliation is clean and per-source balances report every source', async () => {
    const recon = await rig.asAdmin((c: any) =>
      c.query(`SELECT * FROM phoenix_provenance_reconciliation()`).then((r: any) => r.rows));
    expect(recon).toHaveLength(0);

    const balances = await asOfficer((c: any) =>
      c.query(`SELECT * FROM phoenix_warehouse_source_balances($1) ORDER BY supply_type, purchase_origin`, [WH])
        .then((r: any) => r.rows));
    const bySource = Object.fromEntries(balances.map((b: any) =>
      [`${b.supply_type ?? 'legacy'}:${b.purchase_origin ?? '-'}`, Number(b.on_hand)]));
    expect(bySource['aid:-']).toBe(37);
    expect(bySource['purchase:central']).toBe(20);
    expect(bySource['purchase:supplementary']).toBe(10);
    expect(bySource['kimadia:-']).toBe(5);
  });

  it('the re-issued legacy writer signature is NOT executable by authenticated (080 kept)', async () => {
    const { rows } = await rig.asAdmin((c: any) => c.query(`
      SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') AS ok
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='phoenix_receive_warehouse_stock'`));
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
  });
});
