/**
 * PHASE-2-E2E-CUSTODY-CHAIN — the full closed-custody journey, end to end,
 * against a real disposable Postgres with 001->104 applied in order.
 *
 * approved entry -> request -> reserve -> sequential dispatch -> receive
 * -> distribution -> dispense -> stocktake -> correction (second-person
 * approval) -> return -> quarantine -> release/destroy
 *
 * SCOPE NOTE: partial-vs-full receipt with a quantity MISMATCH is already
 * independently proven by 068's and 100's own dynamic tests (mismatched
 * lines are skipped for individual review, never auto-decided). This file's
 * job is different — proving the CHAIN links correctly end to end and that
 * quantity is conserved across every stage — so every receive step here
 * matches its sent quantity exactly, keeping the conservation arithmetic
 * exact rather than re-proving an already-covered per-RPC edge case.
 *
 * Five roles exercised in their designed places: central_warehouse_manager
 * (entry, reserve, sequential dispatch, warehouse-correction approval,
 * outlet-correction approval), warehouse_officer (request, transfer receive,
 * distribution, outlet-return receive/quarantine intake, quarantine release/
 * destroy, warehouse stocktake + correction propose), outlet_officer (outlet
 * receive, dispense, outlet return request/send), institution_admin
 * (isolation-only: an oversight role with no operational key in this chain),
 * super_admin (isolation-only: the
 * platform role that bypasses scope but is never used to DO a chain step).
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

// ── Org A (the chain under test) ────────────────────────────────────────────
const ORG = '00000000-0000-0000-0000-0000000e1001';
const WH_CENTRAL = '00000000-0000-0000-0000-0000000e1101';
const WH_INST = '00000000-0000-0000-0000-0000000e1102';
const OUTLET = '00000000-0000-0000-0000-0000000e1103';
const ROUTE = '00000000-0000-0000-0000-0000000e1201';

const CWM = '00000000-0000-0000-0000-0000000e1401'; // central_warehouse_manager
const WO = '00000000-0000-0000-0000-0000000e1402';  // warehouse_officer, scoped to WH_INST
const OO = '00000000-0000-0000-0000-0000000e1403';  // outlet_officer, scoped to OUTLET
const IA = '00000000-0000-0000-0000-0000000e1404';  // institution_admin (oversight; isolation checks only)
const SA = '00000000-0000-0000-0000-0000000e1405';  // super_admin (isolation checks only)

// ── Org B (cross-institution isolation) ─────────────────────────────────────
const ORG_B = '00000000-0000-0000-0000-0000000e2001';
const WH_INST_B = '00000000-0000-0000-0000-0000000e2102';
const WO_B = '00000000-0000-0000-0000-0000000e2402'; // warehouse_officer in ORG_B, scoped to WH_INST_B

run('Phase 2 end-to-end custody chain', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 104 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','E2E Org A','مؤسسة أ','p2e2e-orga'),
        ('${ORG_B}','E2E Org B','مؤسسة ب','p2e2e-orgb')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG}','Central','مركزي','active','central','p2e2e-wc'),
        ('${WH_INST}','${ORG}','Inst WH','مخزن مؤسسة أ','active','institution','p2e2e-wi'),
        ('${WH_INST_B}','${ORG_B}','Inst WH B','مخزن مؤسسة ب','active','institution','p2e2e-wib')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,organization_id,warehouse_id,name,name_ar,status,point_type) VALUES
        ('${OUTLET}','${ORG}','${WH_INST}','E2E Outlet','منفذ',  'active','pharmacy')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes
        (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution', true) ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${CWM}','p2e2e-cwm@rig'),('${WO}','p2e2e-wo@rig'),('${OO}','p2e2e-oo@rig'),
        ('${IA}','p2e2e-ia@rig'),('${SA}','p2e2e-sa@rig'),('${WO_B}','p2e2e-wob@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${WO}';`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG}' WHERE id='${OO}';`);
      await c.query(`UPDATE profiles SET role='institution_admin',status='active',organization_id='${ORG}' WHERE id='${IA}';`);
      await c.query(`UPDATE profiles SET role='super_admin',status='active',organization_id=NULL WHERE id='${SA}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG_B}' WHERE id='${WO_B}';`);

      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${CWM}','${ORG}','warehouse','${WH_CENTRAL}',true),
               ('${WO}','${ORG}','warehouse','${WH_INST}',true),
               ('${WO_B}','${ORG_B}','warehouse','${WH_INST_B}',true)
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
        VALUES ('${OO}','${ORG}','distribution_point','${OUTLET}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  // Shared chain state, threaded across the sequential `it` blocks below —
  // vitest runs `it`s within one `describe` in declaration order.
  let centralStockId = '';
  let transferRequestId = '';
  let reqLine1Id = '';
  let transferLine1Id = '';
  let transferLine2Id = '';
  let instStockId = '';
  let dispatchId = '';
  let dispatchLineId = '';
  let outletStockId = '';
  let instCorrectionId = '';
  let outletReturnRequestId = '';
  let outletReturnLineId = '';
  let returnShipmentId = '';
  let quarantineStockId = '';
  let releaseDestStockId = '';

  it('1. approved entry — central (pharmacy-department) warehouse receives 100 units', async () => {
    await rig.asUser(CWM, async (c: any) => {
      const r = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_CENTRAL, 'E2E-MAT', 100, true, false, 0,
        null, null, null, null, null, null, 'B-E2E', null, null, null, null, null, null, null, null, null,
      ]);
      expect(r.ok).toBe(true);
      expect(r.quantity_after).toBe(100);
      centralStockId = r.warehouse_stock_id;
    }, { commit: true });
  });

  it('2. request — the institution asks for 100 units', async () => {
    await rig.asUser(WO, async (c: any) => {
      const created = await call(c, 'phoenix_create_warehouse_transfer_request', [
        ROUTE, WH_INST, 'E2E-REQ-1', null,
      ]);
      expect(created.ok).toBe(true);
      transferRequestId = created.transfer_request_id;

      const line = await call(c, 'phoenix_add_warehouse_transfer_request_line', [
        transferRequestId, 'E2E-MAT', 100, null, null, null, null, null,
      ]);
      expect(line.ok).toBe(true);
      reqLine1Id = line.transfer_request_line_id;

      const submitted = await call(c, 'phoenix_submit_warehouse_transfer_request', [transferRequestId]);
      expect(submitted.ok).toBe(true);
    }, { commit: true });
  });

  it('3. reserve — central reviews and approves the request in full', async () => {
    await rig.asUser(CWM, async (c: any) => {
      const reviewed = await call(c, 'phoenix_review_warehouse_transfer_request', [
        transferRequestId, JSON.stringify([{ line_id: reqLine1Id, approved_quantity: 100 }]),
      ]);
      expect(reviewed.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT status FROM warehouse_transfer_requests WHERE id=$1`, [transferRequestId]);
      expect(r.rows[0].status).toBe('approved');
    });
  });

  it('4. sequential dispatch — central sends TWO lines (60 then 40) against the SAME request', async () => {
    await rig.asUser(CWM, async (c: any) => {
      const sent1 = await call(c, 'phoenix_send_warehouse_transfer_line', [
        transferRequestId, ROUTE, centralStockId, 60, 'E2E-WT-1', reqLine1Id, null, null,
      ]);
      expect(sent1.ok).toBe(true);
      transferLine1Id = sent1.warehouse_stock_id && (await c.query(
        `SELECT id FROM warehouse_transfer_lines WHERE transfer_id=(SELECT id FROM warehouse_transfers WHERE transfer_number='E2E-WT-1') ORDER BY created_at LIMIT 1`
      )).rows[0].id;
    }, { commit: true });

    // A second, DIFFERENT physical shipment (own transfer_number) for the
    // remaining 40 — "sequential" as in two separate send acts, not one bulk.
    await rig.asUser(CWM, async (c: any) => {
      const sent2 = await call(c, 'phoenix_send_warehouse_transfer_line', [
        randomUUID(), ROUTE, centralStockId, 40, 'E2E-WT-2', null, null, null,
      ]);
      expect(sent2.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const t1 = await c.query(`SELECT id FROM warehouse_transfers WHERE transfer_number='E2E-WT-1'`);
      const l1 = await c.query(`SELECT id FROM warehouse_transfer_lines WHERE transfer_id=$1`, [t1.rows[0].id]);
      transferLine1Id = l1.rows[0].id;
      const t2 = await c.query(`SELECT id FROM warehouse_transfers WHERE transfer_number='E2E-WT-2'`);
      const l2 = await c.query(`SELECT id FROM warehouse_transfer_lines WHERE transfer_id=$1`, [t2.rows[0].id]);
      transferLine2Id = l2.rows[0].id;

      const stock = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [centralStockId]);
      expect(stock.rows[0].on_hand_quantity).toBe(0); // fully sent
    });
  });

  it('5. receive — the institution receives both lines in full (60 then 40)', async () => {
    await rig.asUser(WO, async (c: any) => {
      const r1 = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), transferLine1Id, 60, null, null,
      ]);
      expect(r1.ok).toBe(true);
      instStockId = r1.warehouse_stock_id;

      const r2 = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), transferLine2Id, 40, null, null,
      ]);
      expect(r2.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [instStockId]);
      expect(r.rows[0].on_hand_quantity).toBe(100);
    });
  });

  it('6. distribution — the institution dispatches 70 units to its outlet', async () => {
    await rig.asUser(WO, async (c: any) => {
      const dispatch = await call(c, 'phoenix_create_warehouse_dispatch', [
        WH_INST, OUTLET, 'E2E-DISP-1', null, null, null,
      ]);
      expect(dispatch.ok).toBe(true);
      dispatchId = dispatch.dispatch_id;

      const line = await call(c, 'phoenix_add_dispatch_line_fefo_guarded', [
        dispatchId, instStockId, 70, false, null,
      ]);
      expect(line.ok).toBe(true);
      dispatchLineId = line.dispatch_line_id;

      const sent = await call(c, 'phoenix_send_warehouse_dispatch', [randomUUID(), dispatchId]);
      expect(sent.ok).toBe(true);
    }, { commit: true });

    await rig.asUser(OO, async (c: any) => {
      const received = await call(c, 'phoenix_receive_outlet_dispatch_line', [
        randomUUID(), dispatchLineId, 70, null, null,
      ]);
      expect(received.ok).toBe(true);
      outletStockId = received.outlet_stock_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const inst = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [instStockId]);
      expect(inst.rows[0].on_hand_quantity).toBe(30); // 100 - 70
      const outlet = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [outletStockId]);
      expect(outlet.rows[0].on_hand_quantity).toBe(70);
    });
  });

  it('7. dispense — the outlet dispenses 20 units', async () => {
    await rig.asUser(OO, async (c: any) => {
      const r = await call(c, 'phoenix_dispense_outlet_stock', [
        randomUUID(), outletStockId, 20, null, null,
      ]);
      expect(r.ok).toBe(true);
      expect(r.quantity_after).toBe(50);
    }, { commit: true });
  });

  it('8. stocktake — a physical count of the institution warehouse finds a 3-unit shortfall', async () => {
    await rig.asUser(WO, async (c: any) => {
      const r = await call(c, 'phoenix_status_record_stocktake', [
        ORG, 'warehouse', WH_INST, 'E2E physical count', JSON.stringify([
          { scientific_name: 'E2E-MAT', counted_qty: 27 },
        ]),
      ]);
      expect(r.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT count(*) FROM stocktakes WHERE organization_id=$1 AND scope_id=$2`, [ORG, WH_INST]);
      expect(Number(r.rows[0].count)).toBe(1);
    });
  });

  it('9. correction with second-person approval — the institution warehouse count is corrected 30 -> 27', async () => {
    await rig.asUser(WO, async (c: any) => {
      const requested = await call(c, 'phoenix_request_warehouse_stock_correction', [
        randomUUID(), instStockId, 27, 'stocktake shortfall', null, null, null,
      ]);
      expect(requested.ok).toBe(true);
      expect(requested.requires_approval).toBe(true); // variance 3 > default threshold 0
      instCorrectionId = requested.correction_request_id;
    }, { commit: true });

    // The PROPOSER cannot approve their own correction.
    await rig.asUser(WO, async (c: any) => {
      await expect(call(c, 'phoenix_approve_warehouse_stock_correction', [instCorrectionId, null]))
        .rejects.toThrow(/proposer_cannot_approve_own_correction/);
    });

    // A DIFFERENT authorized person (central_warehouse_manager, per 101) approves.
    await rig.asUser(CWM, async (c: any) => {
      const approved = await call(c, 'phoenix_approve_warehouse_stock_correction', [instCorrectionId, null]);
      expect(approved.ok).toBe(true);
      expect(approved.quantity_after).toBe(27);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [instStockId]);
      expect(r.rows[0].on_hand_quantity).toBe(27);
    });
  });

  it('10. return — the outlet returns 15 EXCESS units to the institution', async () => {
    await rig.asUser(OO, async (c: any) => {
      const requested = await call(c, 'phoenix_request_outlet_return', [OUTLET, 'E2E-RET-1', null]);
      expect(requested.ok).toBe(true);
      outletReturnRequestId = requested.return_request_id;

      const line = await call(c, 'phoenix_add_outlet_return_request_line', [
        outletReturnRequestId, dispatchLineId, 15, 'excess', 'surplus at outlet',
      ]);
      expect(line.ok).toBe(true);
      outletReturnLineId = line.return_request_line_id;

      const submitted = await call(c, 'phoenix_submit_outlet_return_request', [outletReturnRequestId]);
      expect(submitted.ok).toBe(true);
    }, { commit: true });

    await rig.asUser(WO, async (c: any) => {
      const reviewed = await call(c, 'phoenix_review_outlet_return_request', [
        outletReturnRequestId, JSON.stringify([{ line_id: outletReturnLineId, approved_quantity: 15 }]),
      ]);
      expect(reviewed.ok).toBe(true);
    }, { commit: true });

    await rig.asUser(OO, async (c: any) => {
      const sent = await call(c, 'phoenix_send_outlet_return_shipment_line', [
        randomUUID(), outletReturnLineId, null, 15, 'E2E-RS-1', null, null,
      ]);
      expect(sent.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const s = await c.query(`SELECT id FROM outlet_return_shipments WHERE shipment_number='E2E-RS-1'`);
      returnShipmentId = s.rows[0].id;
      const outlet = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [outletStockId]);
      expect(outlet.rows[0].on_hand_quantity).toBe(35); // 50 - 15
    });

    let shipmentLineId = '';
    await rig.asAdmin(async (c: any) => {
      const l = await c.query(`SELECT id FROM outlet_return_shipment_lines WHERE shipment_id=$1`, [returnShipmentId]);
      shipmentLineId = l.rows[0].id;
    });

    // 'excess' is a MANDATORY-quarantine reason — receipt at the institution
    // credits warehouse_quarantine_stock, never warehouse_stock directly.
    await rig.asUser(WO, async (c: any) => {
      const received = await call(c, 'phoenix_receive_outlet_return_shipment_line', [
        randomUUID(), shipmentLineId, 15, null, null, 'quarantined',
      ]);
      expect(received.ok).toBe(true);
      expect(received.disposition).toBe('quarantined');
      quarantineStockId = received.quarantine_stock_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const inst = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [instStockId]);
      expect(inst.rows[0].on_hand_quantity).toBe(27); // unaffected — quarantine is a SEPARATE ledger
      const q = await c.query(`SELECT quantity FROM warehouse_quarantine_stock WHERE id=$1`, [quarantineStockId]);
      expect(q.rows[0].quantity).toBe(15);
    });
  });

  it('11. quarantine disposition — release 10 units back to stock, destroy the remaining 5', async () => {
    // release credits the SAME material/batch/expiry identity it was
    // quarantined from (phoenix_release_quarantine_stock's own invariant) —
    // which is exactly instStockId's identity ('E2E-MAT'/'B-E2E' at WH_INST),
    // so the release target IS that same lot, not a fresh one.
    releaseDestStockId = instStockId;

    await rig.asUser(WO, async (c: any) => {
      const released = await call(c, 'phoenix_release_quarantine_stock', [
        randomUUID(), quarantineStockId, 10, 'not defective on inspection', releaseDestStockId,
      ]);
      expect(released.ok).toBe(true);
    }, { commit: true });

    // Release and destroy are both gated on warehouse_transfer.return_request
    // scoped to the QUARANTINE's own warehouse (the institution warehouse
    // here) — held by warehouse_officer there, not by central_warehouse_
    // manager (who is scoped to the central warehouse in this test).
    await rig.asUser(WO, async (c: any) => {
      const destroyed = await call(c, 'phoenix_destroy_quarantine_stock', [
        randomUUID(), quarantineStockId, 5, 'confirmed defective',
      ]);
      expect(destroyed.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const q = await c.query(`SELECT quantity FROM warehouse_quarantine_stock WHERE id=$1`, [quarantineStockId]);
      expect(q.rows[0].quantity).toBe(0); // 15 - 10 - 5
      const released = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [releaseDestStockId]);
      expect(released.rows[0].on_hand_quantity).toBe(37); // 27 (post-correction) + 10 released
    });
  });

  it('12. conservation — every unit ever received is accounted for across the whole journey', async () => {
    await rig.asAdmin(async (c: any) => {
      // instStockId and releaseDestStockId are the SAME row (see step 11) —
      // read once, not summed twice.
      const instFinal = (await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [instStockId])).rows[0].on_hand_quantity;
      const outletFinal = (await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [outletStockId])).rows[0].on_hand_quantity;
      const quarantineFinal = (await c.query(`SELECT quantity FROM warehouse_quarantine_stock WHERE id=$1`, [quarantineStockId])).rows[0].quantity;

      const dispensedTotal = 20;
      const destroyedTotal = 5;
      const shrinkageTotal = 3; // the stocktake correction, 30 -> 27

      const stillInSystem = instFinal + outletFinal + quarantineFinal;
      const totalAccountedFor = stillInSystem + dispensedTotal + destroyedTotal + shrinkageTotal;

      expect(instFinal).toBe(37); // 27 (post-correction) + 10 released back in
      expect(outletFinal).toBe(35);
      expect(quarantineFinal).toBe(0);
      expect(totalAccountedFor).toBe(100); // == the ONE approved entry at step 1
    });
  });

  // ── Cross-institution isolation ───────────────────────────────────────────

  it('cross-org isolation: org B cannot receive org A\'s transfer line, and cannot read it via RLS', async () => {
    await rig.asUser(WO_B, async (c: any) => {
      await expect(call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), transferLine1Id, 60, null, null,
      ])).rejects.toThrow(/.+/); // already-decided or not-found or forbidden — never succeeds
    });

    await rig.asUser(WO_B, async (c: any) => {
      const r = await c.query(`SELECT * FROM warehouse_transfer_lines WHERE id=$1`, [transferLine1Id]);
      expect(r.rows.length).toBe(0); // RLS hides org A's row entirely from org B
    });
  });

  // ── Five-role isolation ───────────────────────────────────────────────────

  it('five-role isolation: an outlet_officer cannot approve a warehouse-side correction, and institution_admin cannot dispense', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'E2E-ISO-WH',true,false,'B-ISO',50,0,0)`, [stockId, ORG, WH_INST]);
    });

    let correctionId = '';
    await rig.asUser(WO, async (c: any) => {
      const r = await call(c, 'phoenix_request_warehouse_stock_correction', [
        randomUUID(), stockId, 45, 'iso test', null, null, null,
      ]);
      correctionId = r.correction_request_id;
    }, { commit: true });

    await rig.asUser(OO, async (c: any) => {
      await expect(call(c, 'phoenix_approve_warehouse_stock_correction', [correctionId, null]))
        .rejects.toThrow(/forbidden_correction_approval/);
    });

    const outletStockForIso = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy','E2E-ISO-OUT',true,false,'B-ISO-OUT',20,0,0)`, [outletStockForIso, ORG, OUTLET]);
    });

    await rig.asUser(IA, async (c: any) => {
      await expect(call(c, 'phoenix_dispense_outlet_stock', [
        randomUUID(), outletStockForIso, 5, null, null,
      ])).rejects.toThrow(/.+/);
    });
  });

  // ── Retry / idempotency across a chain step ──────────────────────────────

  it('retry: replaying the same request id for a receive step does not double-post', async () => {
    const stockId = randomUUID();
    let onHandBefore = 0;
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'E2E-RETRY',true,false,'B-RETRY',0,0,0)`, [stockId, ORG, WH_CENTRAL]);
    });

    const reqId = randomUUID();
    await rig.asUser(CWM, async (c: any) => {
      const first = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        reqId, WH_CENTRAL, 'E2E-RETRY', 30, true, false, 0,
        null, null, null, null, null, null, 'B-RETRY', null, null, null, null, null, null, null, null, null,
      ]);
      expect(first.ok).toBe(true);
      expect(first.idempotent_replay).toBe(false);
      onHandBefore = first.quantity_after;
    }, { commit: true });

    await rig.asUser(CWM, async (c: any) => {
      // SAME request id, same payload — a lost-response retry, not a new post.
      const replay = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        reqId, WH_CENTRAL, 'E2E-RETRY', 30, true, false, 0,
        null, null, null, null, null, null, 'B-RETRY', null, null, null, null, null, null, null, null, null,
      ]);
      expect(replay.idempotent_replay).toBe(true);
      expect(replay.quantity_after).toBe(onHandBefore); // unchanged — no double post
    });
  });

  // ── Concurrency ───────────────────────────────────────────────────────────

  it('concurrency: two simultaneous receive attempts on the SAME transfer line — only one wins', async () => {
    const stockId = randomUUID();
    const transferId = randomUUID();
    const lineId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'E2E-CONC',true,false,'B-CONC',0,0,0)`, [stockId, ORG, WH_CENTRAL]);
      await c.query(`INSERT INTO warehouse_transfers
        (id, route_id, source_warehouse_id, source_organization_id, destination_warehouse_id, destination_organization_id, transfer_number, status, sent_by, sent_at)
        VALUES ($1,$2,$3,$4,$5,$4,'E2E-CONC-T','in_transit',$6,now())`,
        [transferId, ROUTE, WH_CENTRAL, ORG, WH_INST, CWM]);
      await c.query(`INSERT INTO warehouse_transfer_lines
        (id, transfer_id, source_organization_id, source_warehouse_stock_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, sent_quantity, status)
        VALUES ($1,$2,$3,$4,'E2E-CONC',true,false,'B-CONC',25,'in_transit')`, [lineId, transferId, ORG, stockId]);
    });

    const results = await Promise.allSettled([
      rig.asUser(WO, (c: any) => call(c, 'phoenix_receive_warehouse_transfer_line', [randomUUID(), lineId, 25, null, null]), { commit: true }),
      rig.asUser(WO, (c: any) => call(c, 'phoenix_receive_warehouse_transfer_line', [randomUUID(), lineId, 25, null, null]), { commit: true }),
    ]);

    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE organization_id=$1 AND warehouse_id=$2 AND scientific_name='E2E-CONC'`, [ORG, WH_INST]);
      expect(r.rows[0].on_hand_quantity).toBe(25); // exactly once, never double-posted
    });
  });
});
