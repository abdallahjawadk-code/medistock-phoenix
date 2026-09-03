/**
 * DISPENSING-SUSPENSION-ENFORCEMENT-WAREHOUSE-SEND-207 — DYNAMIC proof
 * against a real disposable Postgres with 001->208 applied in order.
 *
 * 205 filters suspended batches out of the shared FEFO candidate list, but
 * every "send THIS specific warehouse_stock_id" function loads its row by id
 * and only consults that list to decide whether a FEFO override is needed —
 * so before 207 a holder of inventory.fefo_override could still push a
 * suspended batch through the override branch. 207 adds an explicit,
 * unconditional check to each of the four internal functions behind the six
 * public send entry points. This suite exercises all four, through their
 * real public wrappers.
 *
 * Proves, for every guarded warehouse-send path:
 *   1. _phoenix_150_send_routed_v1 (via
 *      phoenix_send_warehouse_transfer_line_fefo_guarded) refuses a suspended
 *      material EVEN WITH p_fefo_override = true and a valid reason, supplied
 *      by an actor who genuinely holds inventory.fefo_override — the exact
 *      bypass 207 exists to close — and moves no quantity.
 *   2. _phoenix_150_send_direct_v1 (via
 *      phoenix_send_direct_warehouse_transfer_line_fefo_guarded) refuses the
 *      same way on an APPROVED direct transfer request, and moves no quantity.
 *   3. _phoenix_150_add_dispatch_line_v1 (via
 *      phoenix_add_dispatch_line_fefo_guarded) refuses at DRAFT time, again
 *      unbypassable by override.
 *   4. phoenix_send_warehouse_dispatch — the authoritative send-time gate —
 *      refuses a dispatch whose line was added legally BEFORE the suspension
 *      existed (the real TOCTOU case), leaves the dispatch in 'draft' and
 *      debits nothing; and after the suspension is lifted the very same
 *      dispatch sends successfully and the stock moves exactly once.
 *
 * Every refusal is asserted together with the stock balance, so "refused" can
 * never silently mean "refused after a partial debit".
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000207001';
const ORG_DEST = '00000000-0000-0000-0000-000000207002';
const CENTRAL = '00000000-0000-0000-0000-000000207101';
const INST = '00000000-0000-0000-0000-000000207102';
const DIRECT_DEST = '00000000-0000-0000-0000-000000207103';
const OUTLET = '00000000-0000-0000-0000-000000207301';
const ROUTE = '00000000-0000-0000-0000-000000207201';
const ITEM = '00000000-0000-0000-0000-000000207501';

let sequence = 0;
const uniq = (prefix: string) => `${prefix}-${Date.now()}-${sequence++}`;

run('207 dispensing-suspension enforcement (guarded warehouse sends) — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  const onHand = (stockId: string): Promise<number> =>
    rig.asAdmin((c: any) =>
      c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [stockId])
        .then((r: any) => r.rows[0].on_hand_quantity));

  const suspend = async () => {
    let id = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const r = await call(c, 'phoenix_suspend_material_dispensing', [
        randomUUID(), ITEM, ORG, 'quality_investigation',
      ]);
      id = r.suspension_id;
    }, { commit: true });
    return id;
  };

  const lift = async (suspensionId: string) => {
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const r = await call(c, 'phoenix_lift_material_dispensing_suspension', [
        randomUUID(), suspensionId, 'quality investigation closed',
      ]);
      expect(r.ok).toBe(true);
    }, { commit: true });
  };

  /** One CENTRAL warehouse batch of the suspendable material. */
  const insertStock = async (name: string, batch: string, expiry: string, quantity = 50) => {
    const id = randomUUID();
    await rig.asAdmin((c: any) => c.query(
      `INSERT INTO warehouse_stock(
         id,organization_id,warehouse_id,central_item_id,scientific_name,concentration,
         dosage_form,unit,national_code,has_no_national_code,batch_number,has_no_batch_number,
         expiry_date,on_hand_quantity,reserved_quantity,movement_seq
       ) VALUES($1,'${ORG}','${CENTRAL}','${ITEM}',$2,'10 mg','tablet','box',NULL,true,$3,false,$4,$5,0,1)`,
      [id, name, batch, expiry, quantity],
    ));
    return id;
  };

  const createApprovedDirectRequest = async (materialName: string, quantity: number) => {
    let transferRequestId = '';
    let transferRequestLineId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const head = await call(c, 'phoenix_create_direct_warehouse_transfer_request', [
        CENTRAL, ORG_DEST, DIRECT_DEST, uniq('P207-DIRECT-REQ'), null,
      ]);
      const line = await call(c, 'phoenix_add_warehouse_transfer_request_line', [
        head.transfer_request_id, materialName, quantity,
        null, '10 mg', 'tablet', 'box', null,
      ]);
      await call(c, 'phoenix_submit_warehouse_transfer_request', [head.transfer_request_id]);
      await call(c, 'phoenix_review_warehouse_transfer_request', [
        head.transfer_request_id,
        JSON.stringify([{
          line_id: line.transfer_request_line_id,
          approved_quantity: quantity,
        }]),
      ]);
      transferRequestId = head.transfer_request_id;
      transferRequestLineId = line.transfer_request_line_id;
    }, { commit: true });
    return { transferRequestId, transferRequestLineId };
  };

  beforeAll(async () => {
    rig = await buildRig({ upTo: 208 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO organizations(id,name,name_ar,code) VALUES
          ('${ORG}','Send 207','إرسال ٢٠٧','p207-org'),
          ('${ORG_DEST}','Dest 207','وجهة ٢٠٧','p207-dest')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`
        INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
          ('${CENTRAL}','${ORG}','Central 207','مركزي ٢٠٧','active','central','p207-wc'),
          ('${INST}','${ORG}','Inst 207','مؤسسة ٢٠٧','active','institution','p207-wi'),
          ('${DIRECT_DEST}','${ORG_DEST}','Direct 207','مباشر ٢٠٧','active','institution','p207-wd')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`
        INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES('${OUTLET}','${CENTRAL}','${ORG}','Outlet 207','منفذ ٢٠٧','pharmacy','active')
        ON CONFLICT DO NOTHING;`);
      await c.query(`
        INSERT INTO warehouse_supply_routes(
          id,source_warehouse_id,target_warehouse_id,source_warehouse_kind,target_warehouse_kind,is_active
        ) VALUES('${ROUTE}','${CENTRAL}','${INST}','central','institution',true)
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`
        INSERT INTO central_items(id,name,name_ar,unit,status)
        VALUES('${ITEM}','P207 Material','مادة ٢٠٧','box','active')
        ON CONFLICT (id) DO NOTHING;`);
    });
  }, 90000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('ROUTED send refuses a suspended material even with a permitted, reasoned FEFO override, and debits nothing', async () => {
    const material = uniq('P207-ROUTED');
    // Two lots so that selecting the LATE one genuinely requires an override:
    // without 207's check this call would take the override branch and send.
    const early = await insertStock(material, uniq('P207-R-EARLY'), '2028-01-01');
    const late = await insertStock(material, uniq('P207-R-LATE'), '2029-01-01');
    const suspensionId = await suspend();

    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_send_warehouse_transfer_line_fefo_guarded', [
        randomUUID(), ROUTE, late, 10, uniq('P207-R-SEND'),
        null, null, null, true, 'documented FEFO exception',
      ])).rejects.toThrow(/material_dispensing_suspended/);
      // The earliest lot is no more sendable than the late one: suspension is
      // a material-level fact, not a FEFO-ordering question.
      await expect(call(c, 'phoenix_send_warehouse_transfer_line_fefo_guarded', [
        randomUUID(), ROUTE, early, 10, uniq('P207-R-SEND-EARLY'),
        null, null, null, false, null,
      ])).rejects.toThrow(/material_dispensing_suspended/);
    });

    expect(await onHand(early)).toBe(50);
    expect(await onHand(late)).toBe(50);
    await lift(suspensionId);
  });

  it('DIRECT send refuses a suspended material on an approved request, override included, and debits nothing', async () => {
    const material = uniq('P207-DIRECT');
    const early = await insertStock(material, uniq('P207-D-EARLY'), '2028-02-01');
    const late = await insertStock(material, uniq('P207-D-LATE'), '2029-02-01');
    const { transferRequestId, transferRequestLineId } =
      await createApprovedDirectRequest(material, 5);
    const suspensionId = await suspend();

    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_send_direct_warehouse_transfer_line_fefo_guarded', [
        randomUUID(), transferRequestId, late, 5, uniq('P207-D-SEND'),
        transferRequestLineId, null, null, true, 'documented FEFO exception',
      ])).rejects.toThrow(/material_dispensing_suspended/);
    });

    expect(await onHand(early)).toBe(50);
    expect(await onHand(late)).toBe(50);
    await lift(suspensionId);
  });

  it('DISPATCH draft-time add-line refuses a suspended material, override included', async () => {
    const material = uniq('P207-ADDLINE');
    const early = await insertStock(material, uniq('P207-A-EARLY'), '2028-03-01');
    const late = await insertStock(material, uniq('P207-A-LATE'), '2029-03-01');
    const suspensionId = await suspend();

    await rig.asUser(rig.superAdminId, async (c: any) => {
      const head = await call(c, 'phoenix_create_warehouse_dispatch', [
        CENTRAL, OUTLET, uniq('P207-A-DISPATCH'), null, null, null,
      ]);
      await expect(call(c, 'phoenix_add_dispatch_line_fefo_guarded', [
        head.dispatch_id, late, 10, true, 'documented FEFO exception', randomUUID(),
      ])).rejects.toThrow(/material_dispensing_suspended/);
    });

    expect(await onHand(early)).toBe(50);
    expect(await onHand(late)).toBe(50);
    await lift(suspensionId);
  });

  it('SEND-TIME gate: a dispatch whose line was added BEFORE the suspension is refused, stays draft and debits nothing — then sends normally once lifted', async () => {
    const material = uniq('P207-SENDTIME');
    const stockId = await insertStock(material, uniq('P207-S-ONLY'), '2028-04-01');

    // Line added while the material is perfectly dispensable.
    let dispatchId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const head = await call(c, 'phoenix_create_warehouse_dispatch', [
        CENTRAL, OUTLET, uniq('P207-S-DISPATCH'), null, null, null,
      ]);
      dispatchId = head.dispatch_id;
      const added = await call(c, 'phoenix_add_dispatch_line', [dispatchId, stockId, 10]);
      expect(added.dispatch_line_id).toBeTruthy();
    }, { commit: true });

    // …the material is suspended only afterwards.
    const suspensionId = await suspend();

    const sendRequestId = randomUUID();
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_send_warehouse_dispatch', [sendRequestId, dispatchId]))
        .rejects.toThrow(/material_dispensing_suspended/);
    });

    expect(await onHand(stockId)).toBe(50);
    await rig.asAdmin(async (c: any) => {
      const d = await c.query(`SELECT status FROM warehouse_dispatches WHERE id=$1`, [dispatchId]);
      expect(d.rows[0].status).toBe('draft');
      const moved = await c.query(
        `SELECT count(*)::int AS n FROM warehouse_stock_movements
          WHERE reference_type='warehouse_dispatch_send'
            AND reference_id IN (SELECT id FROM warehouse_dispatch_lines WHERE dispatch_id=$1)`,
        [dispatchId],
      );
      expect(moved.rows[0].n).toBe(0);
    });

    // Lifting restores the corridor for the very same, untouched dispatch.
    await lift(suspensionId);
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const sent = await call(c, 'phoenix_send_warehouse_dispatch', [sendRequestId, dispatchId]);
      expect(sent).toMatchObject({ ok: true, status: 'sent' });
    }, { commit: true });

    expect(await onHand(stockId)).toBe(40); // debited exactly once
  });
});
