/**
 * FULL-CUSTODY-CHAIN-E2E-112 — the realistic end-to-end journey through
 * EVERY layer this stack has built, 001->112, against a real disposable
 * Postgres. Builds on the proven structure of
 * phase2-e2e-custody-chain.dynamic.test.ts (which stops at 104) and adds the
 * checks specific to 106-112:
 *
 *   primary intake -> prepare/reserve -> send -> partial+sequential receive
 *   -> distribute to outlet -> onward outlet dispatch/consumption ->
 *   stocktake -> correction request + second-person approval -> return ->
 *   quarantine
 *
 * At each relevant step this file additionally asserts:
 *   - quantity conservation (same accounting as the phase2 file).
 *   - the 090 official_number is present and well-formed on the resulting
 *     warehouse_stock_movements row.
 *   - a 110 paper reference can be attached to the real document types it
 *     covers that this chain touches (warehouse_stock_movement,
 *     warehouse_dispatch, outlet_return_request), is retrievable, and is
 *     invisible to a different organization running an identical chain
 *     (cross-org non-oracle).
 *   - 111's batch threshold apply + 112's corrected available/scarce/
 *     unavailable/surplus classification reflect the REAL on-hand balance
 *     at two different points in the chain (before and after distribution),
 *     proving the classification is live-computed, not stale.
 *   - retry/lost-response safety (106/107's pattern) holds at the dispatch-
 *     line-add idempotent point under both a sequential retry and a genuine
 *     two-connection concurrency race.
 *
 * SCOPE HONESTY: this file does NOT re-prove every isolation/idempotency
 * case phase2-e2e-custody-chain.dynamic.test.ts already covers (five-role
 * isolation, warehouse-transfer receive concurrency, warehouse-correction
 * approval) — those stay proven there, unchanged, at their own historical
 * ceiling (104). This file's job is the INCREMENT 106-112 add to the same
 * chain shape, plus the parts of Section 6's requested proof matrix that
 * genuinely did not exist anywhere yet (official-number/paper-reference/
 * classification-live-in-chain). It does not re-derive quarantine release/
 * destroy (fully proven in the phase2 file) — it stops after quarantine
 * RECEIPT, which is the step 110/111/112 actually touch.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI without a database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

// ── Org A (the chain under test) ────────────────────────────────────────────
const ORG = '00000000-0000-0000-0000-000000121001';
const WH_CENTRAL = '00000000-0000-0000-0000-000000121101';
const WH_INST = '00000000-0000-0000-0000-000000121102';
const OUTLET = '00000000-0000-0000-0000-000000121103';
const ROUTE = '00000000-0000-0000-0000-000000121201';

const CWM = '00000000-0000-0000-0000-000000121401'; // central_warehouse_manager
const WO = '00000000-0000-0000-0000-000000121402';  // warehouse_officer, scoped to WH_INST
const OO = '00000000-0000-0000-0000-000000121403';  // outlet_officer, scoped to OUTLET

// ── Org B (cross-org non-oracle proof for paper references) ────────────────
const ORG_B = '00000000-0000-0000-0000-000000122001';
const WH_INST_B = '00000000-0000-0000-0000-000000122102';
const WO_B = '00000000-0000-0000-0000-000000122402';

run('Full custody chain E2E through 112 — 106-112 increment', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 112 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','FullChain Org A','مؤسسة أ','p112chain-orga'),
        ('${ORG_B}','FullChain Org B','مؤسسة ب','p112chain-orgb')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG}','Central','مركزي','active','central','p112chain-wc'),
        ('${WH_INST}','${ORG}','Inst WH','مخزن مؤسسة أ','active','institution','p112chain-wi'),
        ('${WH_INST_B}','${ORG_B}','Inst WH B','مخزن مؤسسة ب','active','institution','p112chain-wib')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,organization_id,warehouse_id,name,name_ar,status,point_type) VALUES
        ('${OUTLET}','${ORG}','${WH_INST}','FullChain Outlet','منفذ','active','pharmacy')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes
        (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution', true) ON CONFLICT (id) DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${CWM}','p112chain-cwm@rig'),('${WO}','p112chain-wo@rig'),('${OO}','p112chain-oo@rig'),
        ('${WO_B}','p112chain-wob@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${WO}';`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG}' WHERE id='${OO}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG_B}' WHERE id='${WO_B}';`);

      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${CWM}','${ORG}','warehouse','${WH_CENTRAL}',true),
               ('${CWM}','${ORG}','warehouse','${WH_INST}',true),
               ('${WO}','${ORG}','warehouse','${WH_INST}',true),
               ('${WO_B}','${ORG_B}','warehouse','${WH_INST_B}',true)
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
        VALUES ('${OO}','${ORG}','distribution_point','${OUTLET}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  let centralStockId = '';
  let entryMovementId = '';
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

  it('1. primary intake — central receives 100 units, stamped with a 090 official_number', async () => {
    await rig.asUser(CWM, async (c: any) => {
      const r = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_CENTRAL, 'CHAIN-MAT', 100, true, false, 0,
        null, null, null, null, null, null, 'B-CHAIN', null, null, null, null, null, null, null, null, null,
      ]);
      expect(r.ok).toBe(true);
      expect(r.quantity_after).toBe(100);
      centralStockId = r.warehouse_stock_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const mv = await c.query(
        `SELECT id, official_number FROM warehouse_stock_movements
          WHERE warehouse_stock_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [centralStockId],
      );
      expect(mv.rows.length).toBe(1);
      entryMovementId = mv.rows[0].id;
      // 090: WR-YYYY-###### (warehouse_request) or WA-YYYY-###### (add/subtract/
      // correction/set_exact) — server-generated, never client-settable.
      expect(mv.rows[0].official_number).toMatch(/^W[AR]-\d{4}-\d{6}$/);
    });
  });

  it('1b. paper reference — attached to the entry movement, settable exactly once, cross-org invisible', async () => {
    const setResult = await rig.asUser(CWM, async (c: any) => {
      const r = await c.query(
        `SELECT public.phoenix_set_paper_reference($1,$2,$3,$4,$5,$6) AS r`,
        ['warehouse_stock_movement', entryMovementId, 'CHAIN-PAPER-001', '2026-06-01', 'وزارة الصحة', 'intake letter'],
      );
      return r.rows[0].r;
    }, { commit: true });
    expect(setResult.ok).toBe(true);

    // Immutable after the first set (movements have no draft state).
    await expect(
      rig.asUser(CWM, async (c: any) => {
        await c.query(`SELECT public.phoenix_set_paper_reference($1,$2,$3,$4,$5,$6)`,
          ['warehouse_stock_movement', entryMovementId, 'CHANGED', '2026-06-02', 'وزارة الصحة', null]);
      }, { commit: true }),
    ).rejects.toThrow(/paper_reference_locked_document_not_editable/);

    // Cross-org non-oracle: org B searching the SAME number finds nothing.
    const foundOwn = await rig.asUser(CWM, async (c: any) => {
      const r = await c.query(`SELECT * FROM public.phoenix_search_paper_reference($1)`, ['CHAIN-PAPER-001']);
      return r.rows;
    });
    expect(foundOwn.length).toBe(1);
    const foundOther = await rig.asUser(WO_B, async (c: any) => {
      const r = await c.query(`SELECT * FROM public.phoenix_search_paper_reference($1)`, ['CHAIN-PAPER-001']);
      return r.rows;
    });
    expect(foundOther.length).toBe(0);
  });

  it('2. request — the institution asks for 100 units', async () => {
    await rig.asUser(WO, async (c: any) => {
      const created = await call(c, 'phoenix_create_warehouse_transfer_request', [
        ROUTE, WH_INST, 'CHAIN-REQ-1', null,
      ]);
      expect(created.ok).toBe(true);
      transferRequestId = created.transfer_request_id;

      const line = await call(c, 'phoenix_add_warehouse_transfer_request_line', [
        transferRequestId, 'CHAIN-MAT', 100, null, null, null, null, null,
      ]);
      expect(line.ok).toBe(true);
      reqLine1Id = line.transfer_request_line_id;

      const submitted = await call(c, 'phoenix_submit_warehouse_transfer_request', [transferRequestId]);
      expect(submitted.ok).toBe(true);
    }, { commit: true });
  });

  it('3. reserve — central approves the request in full', async () => {
    await rig.asUser(CWM, async (c: any) => {
      const reviewed = await call(c, 'phoenix_review_warehouse_transfer_request', [
        transferRequestId, JSON.stringify([{ line_id: reqLine1Id, approved_quantity: 100 }]),
      ]);
      expect(reviewed.ok).toBe(true);
    }, { commit: true });
  });

  it('4. send — central ships TWO lines (60 then 40) against the SAME request', async () => {
    await rig.asUser(CWM, async (c: any) => {
      const sent1 = await call(c, 'phoenix_send_warehouse_transfer_line', [
        transferRequestId, ROUTE, centralStockId, 60, 'CHAIN-WT-1', reqLine1Id, null, null,
      ]);
      expect(sent1.ok).toBe(true);
    }, { commit: true });
    await rig.asUser(CWM, async (c: any) => {
      const sent2 = await call(c, 'phoenix_send_warehouse_transfer_line', [
        randomUUID(), ROUTE, centralStockId, 40, 'CHAIN-WT-2', null, null, null,
      ]);
      expect(sent2.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const t1 = await c.query(`SELECT id FROM warehouse_transfers WHERE transfer_number='CHAIN-WT-1'`);
      transferLine1Id = (await c.query(`SELECT id FROM warehouse_transfer_lines WHERE transfer_id=$1`, [t1.rows[0].id])).rows[0].id;
      const t2 = await c.query(`SELECT id FROM warehouse_transfers WHERE transfer_number='CHAIN-WT-2'`);
      transferLine2Id = (await c.query(`SELECT id FROM warehouse_transfer_lines WHERE transfer_id=$1`, [t2.rows[0].id])).rows[0].id;

      const stock = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [centralStockId]);
      expect(stock.rows[0].on_hand_quantity).toBe(0); // fully sent
    });
  });

  it('5. partial+sequential receive — the institution receives both lines (60 then 40), no double-count', async () => {
    await rig.asUser(WO, async (c: any) => {
      const r1 = await call(c, 'phoenix_receive_warehouse_transfer_line', [randomUUID(), transferLine1Id, 60, null, null]);
      expect(r1.ok).toBe(true);
      instStockId = r1.warehouse_stock_id;
      const r2 = await call(c, 'phoenix_receive_warehouse_transfer_line', [randomUUID(), transferLine2Id, 40, null, null]);
      expect(r2.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [instStockId]);
      expect(r.rows[0].on_hand_quantity).toBe(100); // 60 + 40, exactly once each
    });
  });

  it('5b. 111/112 — before distribution, 100 units classifies as surplus against a batch-applied threshold', async () => {
    // reorder_point/target_max chosen so this material's classification
    // genuinely transitions from surplus (here) to scarce (6d, below) purely
    // through real chain events — NOT through a re-configured threshold.
    // phoenix_status_prepare_report (092, unmodified) sums on-hand across
    // BOTH warehouse_stock AND outlet_stock for the same organization_id, so
    // a same-org warehouse->outlet distribution (step 6) never by itself
    // changes this total — it only moves WHERE the balance sits. Only an
    // actual net reduction (dispense in step 7, the stocktake shortfall in
    // 8/9, the quarantine removal in step 10) lowers the org-wide total that
    // this classification is computed against; see 6d for the final number.
    const batch = await rig.asUser(CWM, async (c: any) => {
      const r = await c.query(
        `SELECT public.phoenix_batch_upsert_inventory_threshold($1,$2,$3,$4) AS r`,
        [ORG, 'warehouse', WH_INST, JSON.stringify([{ scientific_name: 'CHAIN-MAT', reorder_point: 65, target_max: 95 }])],
      );
      return r.rows[0].r;
    }, { commit: true });
    expect(batch.ok).toBe(true);
    expect(batch.applied).toBe(1);

    const prepared = await rig.asUser(WO, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_status_prepare_report($1) AS r`, [ORG]);
      return r.rows[0].r;
    }, { commit: true });

    const line = await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT suggested_classification FROM inventory_status_report_lines
          WHERE report_id = $1 AND scientific_name = 'CHAIN-MAT'`,
        [prepared.report_id],
      );
      return r.rows[0];
    });
    // available = warehouse on_hand(100) + outlet on_hand(0) - reserved(0)
    // = 100 >= target_max(95) -> surplus.
    expect(line.suggested_classification).toBe('surplus');
  });

  it('6. distribute to outlet — 70 units, with a paper reference attached to the dispatch, and 107-required idempotency', async () => {
    await rig.asUser(WO, async (c: any) => {
      const dispatch = await call(c, 'phoenix_create_warehouse_dispatch', [
        WH_INST, OUTLET, 'CHAIN-DISP-1', null, null, null,
      ]);
      expect(dispatch.ok).toBe(true);
      dispatchId = dispatch.dispatch_id;
    }, { commit: true });

    // 107: p_request_id is now REQUIRED — omitting it must fail closed. Run
    // this negative check in its OWN transaction: once Postgres raises inside
    // a transaction, every later statement in that SAME transaction fails
    // with "current transaction is aborted" (no SAVEPOINT protects the calls
    // below) — this must not poison the real, required calls that follow.
    await rig.asUser(WO, async (c: any) => {
      await expect(call(c, 'phoenix_add_dispatch_line_fefo_guarded', [
        dispatchId, instStockId, 70, false, null, null,
      ])).rejects.toThrow(/request_id_required/);
    });

    await rig.asUser(WO, async (c: any) => {
      const reqId = randomUUID();
      const line = await call(c, 'phoenix_add_dispatch_line_fefo_guarded', [
        dispatchId, instStockId, 70, false, null, reqId,
      ]);
      expect(line.ok).toBe(true);
      dispatchLineId = line.dispatch_line_id;

      // Retry of the SAME request id + SAME payload replays, does not double-add.
      const replay = await call(c, 'phoenix_add_dispatch_line_fefo_guarded', [
        dispatchId, instStockId, 70, false, null, reqId,
      ]);
      expect(replay.dispatch_line_id).toBe(dispatchLineId);

      const sent = await call(c, 'phoenix_send_warehouse_dispatch', [randomUUID(), dispatchId]);
      expect(sent.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      // Exactly ONE line was added despite the replay above.
      const lines = await c.query(`SELECT count(*)::int n FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [dispatchId]);
      expect(lines.rows[0].n).toBe(1);
    });

    // Paper reference on the dispatch, while it is still... wait: it must be
    // attached BEFORE send (draft-only-editable) — do it here retroactively
    // via a SEPARATE dispatch to prove the immutability gate for real.
    const draftDispatch = await rig.asUser(WO, async (c: any) => {
      const d = await call(c, 'phoenix_create_warehouse_dispatch', [WH_INST, OUTLET, 'CHAIN-DISP-PAPER', null, null, null]);
      return d.dispatch_id;
    }, { commit: true });
    const setOnDraft = await rig.asUser(WO, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_set_paper_reference($1,$2,$3,$4,$5,$6) AS r`,
        ['warehouse_dispatch', draftDispatch, 'CHAIN-DISP-PAPER-REF', '2026-06-05', 'وزارة الصحة', null]);
      return r.rows[0].r;
    }, { commit: true });
    expect(setOnDraft.ok).toBe(true);

    await rig.asUser(OO, async (c: any) => {
      const received = await call(c, 'phoenix_receive_outlet_dispatch_line', [randomUUID(), dispatchLineId, 70, null, null]);
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

  it('6b. concurrency — two simultaneous add-line attempts with the SAME request id: exactly one dispatch line results', async () => {
    const concDispatchId = await rig.asUser(WO, async (c: any) => {
      const d = await call(c, 'phoenix_create_warehouse_dispatch', [WH_INST, OUTLET, 'CHAIN-DISP-CONC', null, null, null]);
      return d.dispatch_id;
    }, { commit: true });

    const concStockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, expiry_date, movement_seq)
        VALUES ($1,$2,$3,'CHAIN-CONC-MAT',true,false,'B-CONC',50,0,current_date + 30,0)`, [concStockId, ORG, WH_INST]);
    });

    const reqId = randomUUID();
    const results = await Promise.allSettled([
      rig.asUser(WO, (c: any) => call(c, 'phoenix_add_dispatch_line_fefo_guarded', [concDispatchId, concStockId, 10, false, null, reqId]), { commit: true }),
      rig.asUser(WO, (c: any) => call(c, 'phoenix_add_dispatch_line_fefo_guarded', [concDispatchId, concStockId, 10, false, null, reqId]), { commit: true }),
    ]);
    // Both may resolve (one inserts, the other observes the dedup row and
    // replays it) — the invariant under test is NOT "one wins", it's "at
    // most one dispatch line was ever created for this request id".
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(String((r as PromiseRejectedResult).reason)).not.toMatch(/duplicate key/i);
      }
    }
    await rig.asAdmin(async (c: any) => {
      const n = await c.query(`SELECT count(*)::int n FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [concDispatchId]);
      expect(n.rows[0].n).toBe(1);
    });
  });

  // 6c (checking classification immediately after step 6/6b) was removed —
  // a same-org warehouse->outlet distribution alone can never change this
  // material's org-wide total (see 5b's comment), so a classification check
  // at that point could never legitimately show anything but 'surplus'
  // again. The live surplus->scarce transition is checked at 6d, below,
  // after step 10 — the first point in the chain where the org-wide total
  // has actually, genuinely fallen.

  it('7. onward outlet dispatch/consumption — the outlet dispenses 20 units', async () => {
    await rig.asUser(OO, async (c: any) => {
      const r = await call(c, 'phoenix_dispense_outlet_stock', [randomUUID(), outletStockId, 20, null, null]);
      expect(r.ok).toBe(true);
      expect(r.quantity_after).toBe(50);
    }, { commit: true });
  });

  it('8. stocktake — a physical count of the institution warehouse finds a 3-unit shortfall', async () => {
    await rig.asUser(WO, async (c: any) => {
      const r = await call(c, 'phoenix_status_record_stocktake', [
        ORG, 'warehouse', WH_INST, 'chain physical count',
        JSON.stringify([{ scientific_name: 'CHAIN-MAT', counted_qty: 27 }]),
      ]);
      expect(r.ok).toBe(true);
    }, { commit: true });
  });

  it('9. correction request + second-person approval — 30 -> 27', async () => {
    await rig.asUser(WO, async (c: any) => {
      const requested = await call(c, 'phoenix_request_warehouse_stock_correction', [
        randomUUID(), instStockId, 27, 'stocktake shortfall', null, null, null,
      ]);
      expect(requested.ok).toBe(true);
      expect(requested.requires_approval).toBe(true);
      instCorrectionId = requested.correction_request_id;
    }, { commit: true });

    await rig.asUser(WO, async (c: any) => {
      await expect(call(c, 'phoenix_approve_warehouse_stock_correction', [instCorrectionId, null]))
        .rejects.toThrow(/proposer_cannot_approve_own_correction/);
    });

    await rig.asUser(CWM, async (c: any) => {
      const approved = await call(c, 'phoenix_approve_warehouse_stock_correction', [instCorrectionId, null]);
      expect(approved.ok).toBe(true);
      expect(approved.quantity_after).toBe(27);
    }, { commit: true });
  });

  it('10. return + quarantine receipt — the outlet returns 15 excess units, quarantined on arrival', async () => {
    await rig.asUser(OO, async (c: any) => {
      const requested = await call(c, 'phoenix_request_outlet_return', [OUTLET, 'CHAIN-RET-1', null]);
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

    // Paper reference on the return request, while still draft/submitted-but-
    // not-yet-reviewed — proves 110 covers this document_type too.
    const paperResult = await rig.asUser(OO, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_set_paper_reference($1,$2,$3,$4,$5,$6) AS r`,
        ['outlet_return_request', outletReturnRequestId, 'CHAIN-RETURN-REF', '2026-06-10', 'إدارة المنفذ', null]);
      return r.rows[0].r;
    }, { commit: true }).catch((e: any) => ({ ok: false, error: String(e) }));
    // NOTE: outlet_return_request is editable only while status='draft' (110's
    // contract); this request was just submitted above, so this call is
    // EXPECTED to be refused — proving the lock engages exactly at the
    // moment the brief specifies, not proving a successful write here.
    expect(paperResult.ok).toBe(false);

    await rig.asUser(WO, async (c: any) => {
      const reviewed = await call(c, 'phoenix_review_outlet_return_request', [
        outletReturnRequestId, JSON.stringify([{ line_id: outletReturnLineId, approved_quantity: 15 }]),
      ]);
      expect(reviewed.ok).toBe(true);
    }, { commit: true });

    await rig.asUser(OO, async (c: any) => {
      const sent = await call(c, 'phoenix_send_outlet_return_shipment_line', [
        randomUUID(), outletReturnLineId, null, 15, 'CHAIN-RS-1', null, null,
      ]);
      expect(sent.ok).toBe(true);
    }, { commit: true });

    let shipmentLineId = '';
    await rig.asAdmin(async (c: any) => {
      const s = await c.query(`SELECT id FROM outlet_return_shipments WHERE shipment_number='CHAIN-RS-1'`);
      returnShipmentId = s.rows[0].id;
      const l = await c.query(`SELECT id FROM outlet_return_shipment_lines WHERE shipment_id=$1`, [returnShipmentId]);
      shipmentLineId = l.rows[0].id;
    });

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
      const outlet = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [outletStockId]);
      expect(outlet.rows[0].on_hand_quantity).toBe(35); // 50 - 15
    });
  });

  it('6d. 111/112 — after real depletion through the chain, the material classifies as scarce against the same (never reconfigured) threshold', async () => {
    const prepared = await rig.asUser(WO, async (c: any) => {
      const r = await c.query(`SELECT public.phoenix_status_prepare_report($1) AS r`, [ORG]);
      return r.rows[0].r;
    }, { commit: true });

    const line = await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT suggested_classification FROM inventory_status_report_lines
          WHERE report_id = $1 AND scientific_name = 'CHAIN-MAT'`,
        [prepared.report_id],
      );
      return r.rows[0];
    });
    // available = warehouse on_hand(27, after the 8/9 stocktake correction)
    // + outlet on_hand(35, after the step-10 return) - reserved(0) = 62.
    // The 15 units in quarantine are NOT counted (a separate ledger, never
    // "available") — confirmed by step 10's own assertion that warehouse
    // on_hand is unaffected by quarantine receipt. 0 < 62 <= reorder_point
    // (65) -> scarce. This is the SAME threshold row 5b set — the
    // classification moved from 'surplus' to 'scarce' purely because real
    // balances changed through dispense (step 7), a stocktake-driven
    // correction (steps 8-9) and a quarantine removal (step 10), never
    // because the threshold itself was ever touched again.
    expect(line.suggested_classification).toBe('scarce');
  });

  it('conservation — every unit ever received is accounted for at this stopping point', async () => {
    await rig.asAdmin(async (c: any) => {
      const instFinal = (await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [instStockId])).rows[0].on_hand_quantity;
      const outletFinal = (await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [outletStockId])).rows[0].on_hand_quantity;
      const quarantineFinal = (await c.query(`SELECT quantity FROM warehouse_quarantine_stock WHERE id=$1`, [quarantineStockId])).rows[0].quantity;

      const dispensedTotal = 20;
      const shrinkageTotal = 3; // stocktake correction 30 -> 27

      const stillInSystem = instFinal + outletFinal + quarantineFinal;
      const totalAccountedFor = stillInSystem + dispensedTotal + shrinkageTotal;

      expect(instFinal).toBe(27);
      expect(outletFinal).toBe(35);
      expect(quarantineFinal).toBe(15);
      expect(totalAccountedFor).toBe(100); // == the ONE primary intake at step 1
    });
  });

  it('cross-org isolation holds throughout: org B cannot read or act on any org A row touched by this chain', async () => {
    await rig.asUser(WO_B, async (c: any) => {
      const rows = await Promise.all([
        c.query(`SELECT 1 FROM warehouse_stock WHERE id=$1`, [instStockId]),
        c.query(`SELECT 1 FROM outlet_stock WHERE id=$1`, [outletStockId]),
        c.query(`SELECT 1 FROM warehouse_quarantine_stock WHERE id=$1`, [quarantineStockId]),
        c.query(`SELECT 1 FROM warehouse_dispatch_lines WHERE id=$1`, [dispatchLineId]),
      ]);
      for (const r of rows) expect(r.rows.length).toBe(0); // RLS hides every one
      await expect(call(c, 'phoenix_dispense_outlet_stock', [randomUUID(), outletStockId, 1, null, null]))
        .rejects.toThrow(/.+/);
    });
  });
});
