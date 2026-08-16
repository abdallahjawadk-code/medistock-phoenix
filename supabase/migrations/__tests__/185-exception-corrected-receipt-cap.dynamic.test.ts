/**
 * 185 · R1.5-B CORRECTED-RECEIPT DUAL CAP — dynamic proof against a real
 * 001->185 chain, driving the whole genuine corridor exactly as 157 does.
 *
 * Before R1.5 the only bound on p_corrected_quantity was `> 0`. Two distinct
 * over-credits were expressible:
 *
 *   LINE-LOCAL   a correction larger than what THIS shipment line carried.
 *                Nothing caught it: several return lines can descend from one
 *                dispatch line, so a per-line excess can still sit under the
 *                aggregate ledger's ceiling.
 *   AGGREGATE    a correction pushing the dispatch line's credited returns past
 *                what was physically returned through it. This one was refused
 *                only by wdl_return_received_qty_chk firing on the UPDATE - an
 *                opaque raw CHECK violation, after the stock credit had already
 *                been attempted in the same transaction.
 *
 * These tests assert the EXPLICIT R1.5 identifiers. Asserting merely "it was
 * rejected" would pass on the historical CHECK constraint and prove nothing
 * about 185.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_CENTRAL = '00000000-0000-0000-0000-000000185001';
const ORG_INST = '00000000-0000-0000-0000-000000185002';
const WH_CENTRAL = '00000000-0000-0000-0000-000000185101';
const WH_INST = '00000000-0000-0000-0000-000000185102';
const DP_OUTLET = '00000000-0000-0000-0000-000000185301';
const ROUTE = '00000000-0000-0000-0000-000000185201';

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

run('185 · R1.5-B corrected-receipt dual cap (001->185 rig)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      // 171 requires care_institution => institution_class IS NOT NULL, and
      // confines a pharmacy_department_authority to CENTRAL warehouses. The
      // 128/157 fixtures predate that constraint because they build upTo:128;
      // this suite builds the whole chain, so both rules apply.
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_CENTRAL}','C','مركز','p185-c','pharmacy_department_authority',NULL),
        ('${ORG_INST}','I','مؤسسة','p185-i','care_institution','hospital')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG_CENTRAL}','CWH','مخزنC','active','central','p185-wc'),
        ('${WH_INST}','${ORG_INST}','IWH','مخزنI','active','institution','p185-wi')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes
        (id,source_warehouse_id,target_warehouse_id,source_warehouse_kind,target_warehouse_kind,is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution',true)
        ON CONFLICT (id) DO NOTHING;`);
      // 181/183's outlet topology guard requires an explicit point_type and,
      // for a hospital, a clinical_location_kind.
      await c.query(`INSERT INTO distribution_points
        (id,organization_id,warehouse_id,name,name_ar,point_type,status,clinical_location_kind)
        VALUES ('${DP_OUTLET}','${ORG_INST}','${WH_INST}','DP','منفذ','pharmacy','active','non_emergency')
        ON CONFLICT (id) DO NOTHING;`);
    });
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  /**
   * Drives the real corridor to a genuine exception_pending line.
   * `extraReturnQty` optionally sends a SECOND return line from the SAME
   * dispatch line, which raises the dispatch ledger's returned_quantity
   * without raising THIS line's sent_quantity - the only way to give the
   * aggregate cap headroom while the line-local cap is still binding.
   */
  async function driveToException(material: string, sendQty: number, extraReturnQty = 0,
                                  finalReceiveQty: number | null = 0) {
    let shipmentLineId = '';
    let dispatchLineId = '';

    await rig.asUser(rig.superAdminId, async (c: any) => {
      const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_CENTRAL, material, 200, true, true, 0,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null,
      ]);
      const send = await call(c, 'phoenix_send_warehouse_transfer_line', [
        randomUUID(), ROUTE, rc.warehouse_stock_id, 200, uniq('WT'), null, null, null]);
      const recv = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), send.transfer_line_id, 200, null, null]);

      const dsp = await call(c, 'phoenix_create_warehouse_dispatch',
        [WH_INST, DP_OUTLET, uniq('DSP'), null, null, null]);
      const dispatchId = dsp.dispatch_id ?? dsp.id;
      await call(c, 'phoenix_add_dispatch_line', [dispatchId, recv.warehouse_stock_id, 100]);
      await call(c, 'phoenix_send_warehouse_dispatch', [randomUUID(), dispatchId]);
      const dls = await c.query(`SELECT id FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [dispatchId]);
      dispatchLineId = dls.rows[0].id;
      await call(c, 'phoenix_receive_outlet_dispatch_line', [randomUUID(), dispatchLineId, 100, null, null]);

      const req = await call(c, 'phoenix_request_outlet_return', [DP_OUTLET, uniq('OR')]);
      const requestId = req.return_request_id ?? req.id;

      const addA = await call(c, 'phoenix_add_outlet_return_request_line',
        [requestId, dispatchLineId, sendQty, 'shipment_error', 'r15b line A']);
      const lineA = addA.return_request_line_id;
      const decisions: any[] = [{ line_id: lineA, approved_quantity: sendQty }];

      await call(c, 'phoenix_submit_outlet_return_request', [requestId]);
      await call(c, 'phoenix_review_outlet_return_request', [requestId, JSON.stringify(decisions)]);

      // orrl_request_dispatch_line_uniq allows only ONE line per dispatch line
      // per request, so the extra provenance return goes through its own
      // request. It still lands on the SAME warehouse_dispatch_line, which is
      // the point: returned_quantity rises without this line's sent_quantity.
      let lineB = '';
      if (extraReturnQty > 0) {
        const reqB = await call(c, 'phoenix_request_outlet_return', [DP_OUTLET, uniq('OR')]);
        const requestBId = reqB.return_request_id ?? reqB.id;
        const addB = await call(c, 'phoenix_add_outlet_return_request_line',
          [requestBId, dispatchLineId, extraReturnQty, 'shipment_error', 'r15b line B']);
        lineB = addB.return_request_line_id;
        await call(c, 'phoenix_submit_outlet_return_request', [requestBId]);
        await call(c, 'phoenix_review_outlet_return_request',
          [requestBId, JSON.stringify([{ line_id: lineB, approved_quantity: extraReturnQty }])]);
      }

      const sentA = await call(c, 'phoenix_send_outlet_return_shipment_line',
        [randomUUID(), lineA, null, sendQty, uniq('ORS'), null, null]);
      shipmentLineId = sentA.shipment_line_id;

      if (extraReturnQty > 0) {
        // Raises returned_quantity on the SAME dispatch line. Deliberately left
        // un-received so it consumes no return_received_quantity.
        await call(c, 'phoenix_send_outlet_return_shipment_line',
          [randomUUID(), lineB, null, extraReturnQty, uniq('ORS'), null, null]);
      }

      // finalReceiveQty=0 is the exception-inducing call (a real zero-quantity
      // receive); null leaves the line in_transit for a caller that wants to
      // drive the receive itself.
      if (finalReceiveQty !== null) {
        const got = await call(c, 'phoenix_receive_outlet_return_shipment_line',
          [randomUUID(), shipmentLineId, finalReceiveQty, 'r15 receive', null, null]);
        if (finalReceiveQty === 0) expect(got.custody_state).toBe('exception_pending');
      }
    }, { commit: true });

    return { shipmentLineId, dispatchLineId };
  }

  const resolve = (
    requestId: string, lineId: string, quantity: number | null,
    kind = 'corrected_receipt', disposition: string | null = 'restockable',
  ) => rig.asUser(rig.superAdminId, (c: any) =>
    call(c, 'phoenix_resolve_outlet_return_exception',
      [requestId, lineId, kind, 'r15b', quantity, disposition]), { commit: true });

  /** Every ledger a corrected receipt could touch. */
  const snapshot = async (dispatchLineId: string) => {
    const r: any = await rig.asAdmin((c: any) => c.query(`
      SELECT (SELECT count(*) FROM warehouse_stock)                        AS ws_rows,
             (SELECT COALESCE(sum(on_hand_quantity),0) FROM warehouse_stock) AS ws_qty,
             (SELECT count(*) FROM warehouse_quarantine_stock)             AS wq_rows,
             (SELECT COALESCE(sum(quantity),0) FROM warehouse_quarantine_stock) AS wq_qty,
             (SELECT count(*) FROM warehouse_stock_movements)              AS ws_mov,
             (SELECT count(*) FROM warehouse_quarantine_stock_movements)   AS wq_mov,
             (SELECT count(*) FROM phoenix_outlet_return_exception_resolutions) AS resolutions,
             (SELECT count(*) FROM audit_logs)                             AS audits,
             (SELECT count(*) FROM phoenix_outbox_events)                  AS outbox,
             (SELECT return_received_quantity FROM warehouse_dispatch_lines WHERE id=$1) AS rrq`,
      [dispatchLineId]));
    return r.rows[0];
  };

  const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
    try { await fn(); } catch (e: any) { return String(e?.message ?? e); }
    throw new Error('expected a rejection but the call succeeded');
  };

  it('B1 · line-local cap fires even when the aggregate ledger has headroom', async () => {
    // sent_quantity = 10 on this line, but a SECOND return line pushed the
    // dispatch ledger's returned_quantity to 30 - so 11 is comfortably under
    // the aggregate ceiling and can only be refused by the per-line guard.
    const { shipmentLineId, dispatchLineId } = await driveToException('R15B-LOCAL', 10, 20);

    const ledger: any = await rig.asAdmin((c: any) => c.query(
      `SELECT returned_quantity, return_received_quantity FROM warehouse_dispatch_lines WHERE id=$1`,
      [dispatchLineId]));
    expect(ledger.rows[0].returned_quantity).toBe(30);
    expect(ledger.rows[0].return_received_quantity).toBe(0);

    const before = await snapshot(dispatchLineId);
    expect(await rejects(() => resolve(randomUUID(), shipmentLineId, 11)))
      .toMatch(/corrected_quantity_exceeds_return_shipment_line/);
    expect(await snapshot(dispatchLineId)).toEqual(before);
  });

  it('B2 · aggregate cap fires when the correction fits the line but not the provenance', async () => {
    const { shipmentLineId, dispatchLineId } = await driveToException('R15B-AGG', 10);

    // Simulate a provenance ledger with less unresolved headroom than this
    // line's sent_quantity. Legal state: rrq(0) <= 5 <= received(100).
    await rig.asAdmin((c: any) => c.query(
      `UPDATE warehouse_dispatch_lines SET returned_quantity=5 WHERE id=$1`, [dispatchLineId]));

    const before = await snapshot(dispatchLineId);
    // 10 <= sent_quantity(10), so the line-local guard passes and only the
    // aggregate guard can refuse this.
    expect(await rejects(() => resolve(randomUUID(), shipmentLineId, 10)))
      .toMatch(/corrected_quantity_exceeds_returned_quantity/);
    expect(await snapshot(dispatchLineId)).toEqual(before);
  });

  it('B3 · a correction equal to sent_quantity, within provenance, is ACCEPTED', async () => {
    const { shipmentLineId, dispatchLineId } = await driveToException('R15B-OK', 10);
    const before = await snapshot(dispatchLineId);

    const r = await resolve(randomUUID(), shipmentLineId, 10);
    expect(r.ok).toBe(true);

    const after = await snapshot(dispatchLineId);
    expect(after.rrq).toBe(before.rrq + 10);
    expect(Number(after.ws_qty)).toBe(Number(before.ws_qty) + 10);
    expect(Number(after.resolutions)).toBe(Number(before.resolutions) + 1);
  });

  it('B4 · an absurd correction raises the explicit R1.5 error, never a raw CHECK violation', async () => {
    const { shipmentLineId, dispatchLineId } = await driveToException('R15B-HUGE', 10);
    const before = await snapshot(dispatchLineId);

    const msg = await rejects(() => resolve(randomUUID(), shipmentLineId, 5000));
    expect(msg).toMatch(/corrected_quantity_exceeds_return_shipment_line/);
    // The historical constraint stays as a backstop, but execution must never
    // reach it for a state R1.5 is supposed to name.
    expect(msg).not.toMatch(/wdl_return_received_qty_chk/);
    expect(await snapshot(dispatchLineId)).toEqual(before);
  });

  it('idempotency and conflict semantics are unchanged by the new caps', async () => {
    const { shipmentLineId, dispatchLineId } = await driveToException('R15B-IDEM', 10);
    const requestId = randomUUID();

    const first = await resolve(requestId, shipmentLineId, 10);
    expect(first.ok).toBe(true);
    const afterFirst = await snapshot(dispatchLineId);

    // same request_id + same payload -> idempotent replay, no second credit
    const replay = await resolve(requestId, shipmentLineId, 10);
    expect(replay.ok).toBe(true);
    expect(await snapshot(dispatchLineId)).toEqual(afterFirst);

    // same request_id + different payload -> conflict
    expect(await rejects(() => resolve(requestId, shipmentLineId, 9)))
      .toMatch(/request_id_conflict/);

    // different request_id + same already-resolved line -> already resolved
    expect(await rejects(() => resolve(randomUUID(), shipmentLineId, 10)))
      .toMatch(/exception_already_resolved/);

    expect(await snapshot(dispatchLineId)).toEqual(afterFirst);
  });

  // ==========================================================================
  // R1.5-A EXECUTION COVERAGE — the two paths this scaffold already reaches.
  //
  // The point is EXECUTION coverage of the hardened lookup, not repeating the
  // whole adversarial matrix: a single representative collision per path.
  // Each clones the canonical destination row and changes ONE material
  // component (unit), producing a row that the PRE-R1.5 predicate could not
  // tell apart from the canonical one.
  // ==========================================================================

  /** Clones the canonical WH_INST lot, changing only `unit`. Returns its id. */
  const cloneWithOtherUnit = async (material: string): Promise<string> => {
    const r: any = await rig.asAdmin((c: any) => c.query(`
      INSERT INTO warehouse_stock (
        organization_id, warehouse_id, central_item_id, scientific_name,
        trade_name, concentration, dosage_form, unit, national_code,
        has_no_national_code, batch_number, has_no_batch_number,
        internal_batch_reference, expiry_date, on_hand_quantity,
        reserved_quantity, movement_seq, supply_type, purchase_origin)
      SELECT organization_id, warehouse_id, central_item_id, scientific_name,
             trade_name, concentration, dosage_form,
             COALESCE(unit,'') || '-OTHER',        -- the ONLY divergence
             national_code, has_no_national_code, batch_number,
             has_no_batch_number, internal_batch_reference, expiry_date,
             0, 0, 0, supply_type, purchase_origin
      FROM warehouse_stock
      WHERE warehouse_id=$1 AND scientific_name=$2
      ORDER BY created_at LIMIT 1
      RETURNING id`, [WH_INST, material]));
    return r.rows[0].id;
  };

  const onHand = async (id: string): Promise<number> => {
    const r: any = await rig.asAdmin((c: any) => c.query(
      `SELECT on_hand_quantity AS q FROM warehouse_stock WHERE id=$1`, [id]));
    return r.rows[0].q;
  };

  it('A · OUTLET RETURN RECEIVE through the PUBLIC wrapper credits only the canonical lot', async () => {
    // Deliberately calls phoenix_receive_outlet_return_shipment_line - the
    // public 149 wrapper - so the delegate is reached the way production
    // reaches it, not by invoking the internal function directly.
    const material = 'R15A-OUTLET';
    const { shipmentLineId } = await driveToException(material, 10, 0, null);

    const decoy = await cloneWithOtherUnit(material);
    const canonical: any = await rig.asAdmin((c: any) => c.query(
      `SELECT id, on_hand_quantity FROM warehouse_stock
        WHERE warehouse_id=$1 AND scientific_name=$2 AND id<>$3
        ORDER BY created_at LIMIT 1`, [WH_INST, material, decoy]));
    const canonicalId = canonical.rows[0].id;
    const canonicalBefore = canonical.rows[0].on_hand_quantity;

    await rig.asUser(rig.superAdminId, (c: any) => call(
      c, 'phoenix_receive_outlet_return_shipment_line',
      [randomUUID(), shipmentLineId, 10, 'r15a outlet receive', null, 'restockable']), { commit: true });

    expect(await onHand(canonicalId)).toBe(canonicalBefore + 10);
    expect(await onHand(decoy)).toBe(0);

    // ...and the movement is anchored to the canonical row, not the decoy.
    const mov: any = await rig.asAdmin((c: any) => c.query(
      `SELECT warehouse_stock_id FROM warehouse_stock_movements
        WHERE warehouse_stock_id IN ($1,$2) ORDER BY created_at DESC LIMIT 1`,
      [canonicalId, decoy]));
    expect(mov.rows[0].warehouse_stock_id).toBe(canonicalId);
  });

  it('A · EXCEPTION CORRECTED RECEIPT credits only the canonical lot', async () => {
    const material = 'R15A-EXCEPTION';
    const { shipmentLineId } = await driveToException(material, 10);

    const decoy = await cloneWithOtherUnit(material);
    const canonical: any = await rig.asAdmin((c: any) => c.query(
      `SELECT id, on_hand_quantity FROM warehouse_stock
        WHERE warehouse_id=$1 AND scientific_name=$2 AND id<>$3
        ORDER BY created_at LIMIT 1`, [WH_INST, material, decoy]));
    const canonicalId = canonical.rows[0].id;
    const canonicalBefore = canonical.rows[0].on_hand_quantity;

    const r = await resolve(randomUUID(), shipmentLineId, 10);
    expect(r.ok).toBe(true);

    expect(await onHand(canonicalId)).toBe(canonicalBefore + 10);
    expect(await onHand(decoy)).toBe(0);

    // The resolution row itself must point at the canonical destination.
    const res: any = await rig.asAdmin((c: any) => c.query(
      `SELECT resulting_warehouse_stock_id FROM phoenix_outlet_return_exception_resolutions
        WHERE return_shipment_line_id=$1`, [shipmentLineId]));
    expect(res.rows[0].resulting_warehouse_stock_id).toBe(canonicalId);
  });

  it('A · WAREHOUSE RETURN RECEIVE credits only the canonical lot', async () => {
    // The fourth modified path, on the OTHER corridor: institution -> central,
    // through warehouse_return_* rather than outlet_return_*. Same principle,
    // same single representative collision (unit).
    const material = 'R15A-WHRETURN';
    let shipmentLineId = '';

    await rig.asUser(rig.superAdminId, async (c: any) => {
      const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_CENTRAL, material, 50, true, true, 0,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null,
      ]);
      const send = await call(c, 'phoenix_send_warehouse_transfer_line', [
        randomUUID(), ROUTE, rc.warehouse_stock_id, 50, uniq('WT'), null, null, null]);
      await call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), send.transfer_line_id, 50, null, null]);

      const wr = await call(c, 'phoenix_request_warehouse_return', [ROUTE, WH_INST, uniq('WR')]);
      const wrId = wr.return_request_id ?? wr.id;
      await call(c, 'phoenix_add_warehouse_return_request_line',
        [wrId, send.transfer_line_id, 10, 'excess', 'r15a wh return']);
      await call(c, 'phoenix_submit_warehouse_return_request', [wrId]);
      const wls = await c.query(
        `SELECT id, requested_quantity FROM warehouse_return_request_lines WHERE return_request_id=$1`, [wrId]);
      await call(c, 'phoenix_review_warehouse_return_request',
        [wrId, JSON.stringify(wls.rows.map((r: any) => ({ line_id: r.id, approved_quantity: r.requested_quantity })))]);
      const wsend = await call(c, 'phoenix_send_warehouse_return_shipment_line',
        [randomUUID(), ROUTE, wls.rows[0].id, 10, uniq('WRS'), null, null]);
      shipmentLineId = wsend.shipment_line_id;
    }, { commit: true });

    // The decoy lives at the RETURN DESTINATION (central), where this receive
    // credits - cloned from the canonical central lot, differing only in unit.
    const decoyRes: any = await rig.asAdmin((c: any) => c.query(`
      INSERT INTO warehouse_stock (
        organization_id, warehouse_id, central_item_id, scientific_name,
        trade_name, concentration, dosage_form, unit, national_code,
        has_no_national_code, batch_number, has_no_batch_number,
        internal_batch_reference, expiry_date, on_hand_quantity,
        reserved_quantity, movement_seq, supply_type, purchase_origin)
      SELECT organization_id, warehouse_id, central_item_id, scientific_name,
             trade_name, concentration, dosage_form,
             COALESCE(unit,'') || '-OTHER',
             national_code, has_no_national_code, batch_number,
             has_no_batch_number, internal_batch_reference, expiry_date,
             0, 0, 0, supply_type, purchase_origin
      FROM warehouse_stock
      WHERE warehouse_id=$1 AND scientific_name=$2
      ORDER BY created_at LIMIT 1
      RETURNING id`, [WH_CENTRAL, material]));
    const decoy = decoyRes.rows[0].id;

    const canonical: any = await rig.asAdmin((c: any) => c.query(
      `SELECT id, on_hand_quantity FROM warehouse_stock
        WHERE warehouse_id=$1 AND scientific_name=$2 AND id<>$3
        ORDER BY created_at LIMIT 1`, [WH_CENTRAL, material, decoy]));
    const canonicalId = canonical.rows[0].id;
    const canonicalBefore = canonical.rows[0].on_hand_quantity;

    await rig.asUser(rig.superAdminId, (c: any) => call(
      c, 'phoenix_receive_warehouse_return_shipment_line',
      [randomUUID(), shipmentLineId, 10, 'r15a wh receive', null, 'restockable']), { commit: true });

    expect(await onHand(canonicalId)).toBe(canonicalBefore + 10);
    expect(await onHand(decoy)).toBe(0);
  });
});
