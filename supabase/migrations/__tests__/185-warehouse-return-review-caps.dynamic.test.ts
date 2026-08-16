/**
 * 185 · R1.5-C WAREHOUSE-RETURN REVIEW CAPS — dynamic proof against a real
 * 001->185 chain, driving the genuine corridor.
 *
 * SEND already refused a physical over-return (it locks the original transfer
 * line and checks returned + send <= received). REVIEW had no such guard, so
 * several requests could each be APPROVED against one provenance and only
 * collide later, after operators had been told their returns were authorized.
 *
 * TWO resources are committed, with TWO DIFFERENT grouping keys:
 *
 *   PROVENANCE  keyed by warehouse_transfer_lines.id
 *   PHYSICAL    keyed by warehouse_transfer_lines.resulting_warehouse_stock_id
 *
 * The physical key is the whole point: two DISTINCT transfer lines carrying the
 * same material identity merge into ONE warehouse_stock row, so requests with
 * different provenance anchors still compete for one balance. C6 and C7 below
 * are the tests that fail if the physical check is grouped by transfer line.
 *
 * Every rejection asserts the EXPLICIT R1.5 token; a generic rejection would
 * pass on some unrelated guard and prove nothing.
 *
 * Gated on PHOENIX_RIG_PG; skipped where no rig is available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_CENTRAL = '00000000-0000-0000-0000-000000185c01';
const ORG_INST = '00000000-0000-0000-0000-000000185c02';
const WH_CENTRAL = '00000000-0000-0000-0000-000000185c11';
const WH_INST = '00000000-0000-0000-0000-000000185c12';
const ROUTE = '00000000-0000-0000-0000-000000185c21';

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

run('185 · R1.5-C warehouse-return review caps (001->185 rig)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  const asSuper = <T>(fn: (c: any) => Promise<T>) =>
    rig.asUser(rig.superAdminId, fn, { commit: true }) as Promise<T>;

  const admin = (sql: string, params: any[] = []) =>
    rig.asAdmin((c: any) => c.query(sql, params));

  const rejects = async (fn: () => Promise<unknown>): Promise<string> => {
    try { await fn(); } catch (e: any) { return String(e?.message ?? e); }
    throw new Error('expected a rejection but the call succeeded');
  };

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_CENTRAL}','C','مركز','p185c-c','pharmacy_department_authority',NULL),
        ('${ORG_INST}','I','مؤسسة','p185c-i','care_institution','hospital')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG_CENTRAL}','CWH','مخزنC','active','central','p185c-wc'),
        ('${WH_INST}','${ORG_INST}','IWH','مخزنI','active','institution','p185c-wi')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes
        (id,source_warehouse_id,target_warehouse_id,source_warehouse_kind,target_warehouse_kind,is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution',true)
        ON CONFLICT (id) DO NOTHING;`);
    });
  }, 300000);

  afterAll(async () => { if (rig) await rig.end(); });

  /**
   * Delivers `qty` of `material` to WH_INST and returns the resulting transfer
   * line. Calling it twice with the SAME material yields two DISTINCT transfer
   * lines whose resulting_warehouse_stock_id is the SAME row, because the
   * identity index merges them - which is exactly the shape C6/C7 need.
   */
  async function deliver(material: string, qty: number) {
    return asSuper(async (c: any) => {
      const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_CENTRAL, material, qty, true, true, 0,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null,
      ]);
      const send = await call(c, 'phoenix_send_warehouse_transfer_line', [
        randomUUID(), ROUTE, rc.warehouse_stock_id, qty, uniq('WT'), null, null, null]);
      const recv = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), send.transfer_line_id, qty, null, null]);
      return {
        transferLineId: send.transfer_line_id as string,
        stockId: recv.warehouse_stock_id as string,
      };
    });
  }

  /** Creates a submitted (still pending) return request line for a transfer line. */
  async function pendingReturn(transferLineId: string, qty: number) {
    return asSuper(async (c: any) => {
      const wr = await call(c, 'phoenix_request_warehouse_return', [ROUTE, WH_INST, uniq('WR')]);
      const wrId = wr.return_request_id ?? wr.id;
      const line = await call(c, 'phoenix_add_warehouse_return_request_line',
        [wrId, transferLineId, qty, 'excess', 'r15c']);
      await call(c, 'phoenix_submit_warehouse_return_request', [wrId]);
      return { requestId: wrId, lineId: line.return_request_line_id ?? line.id };
    });
  }

  const review = (requestId: string, decisions: Array<{ line_id: string; approved_quantity: number }>) =>
    asSuper((c: any) => call(c, 'phoenix_review_warehouse_return_request',
      [requestId, JSON.stringify(decisions)]));

  /** Shapes the provenance ledger directly. Legal fixture surgery, not a bypass. */
  const setLedger = (tlId: string, received: number, returned: number) =>
    admin(`UPDATE warehouse_transfer_lines SET received_quantity=$2, returned_quantity=$3 WHERE id=$1`,
      [tlId, received, returned]);

  const setAvailable = (stockId: string, onHand: number, reserved = 0) =>
    admin(`UPDATE warehouse_stock SET on_hand_quantity=$2, reserved_quantity=$3 WHERE id=$1`,
      [stockId, onHand, reserved]);

  const stockSnapshot = async (stockId: string) => {
    const r: any = await admin(`
      SELECT ws.on_hand_quantity, ws.reserved_quantity,
             (SELECT count(*) FROM warehouse_stock_movements m WHERE m.warehouse_stock_id=ws.id) AS movements
      FROM warehouse_stock ws WHERE ws.id=$1`, [stockId]);
    return r.rows[0];
  };

  const lineState = async (lineId: string) => {
    const r: any = await admin(
      `SELECT status, approved_quantity, fulfilled_quantity FROM warehouse_return_request_lines WHERE id=$1`,
      [lineId]);
    return r.rows[0];
  };

  // ==========================================================================
  // C2 · PROVENANCE, ACROSS SEPARATE REQUESTS
  // wrrl_request_original_line_uniq forbids two lines for one transfer line in
  // ONE request, so the real overcommit attack is necessarily cross-request.
  // ==========================================================================
  describe('C2 · provenance cap across separate requests', () => {
    it('P1 received=10 returned=0 other=4 proposed=6 → PASS', async () => {
      const { transferLineId, stockId } = await deliver('R15C-P1', 10);
      await setLedger(transferLineId, 10, 0);
      await setAvailable(stockId, 100);

      const a = await pendingReturn(transferLineId, 4);
      await review(a.requestId, [{ line_id: a.lineId, approved_quantity: 4 }]);

      const b = await pendingReturn(transferLineId, 6);
      const r = await review(b.requestId, [{ line_id: b.lineId, approved_quantity: 6 }]);
      expect(r.ok).toBe(true);
      expect((await lineState(b.lineId)).approved_quantity).toBe(6);
    });

    it('P2 same state, proposed=7 → REJECT aggregate cap', async () => {
      const { transferLineId, stockId } = await deliver('R15C-P2', 10);
      await setLedger(transferLineId, 10, 0);
      await setAvailable(stockId, 100);

      const a = await pendingReturn(transferLineId, 4);
      await review(a.requestId, [{ line_id: a.lineId, approved_quantity: 4 }]);

      const b = await pendingReturn(transferLineId, 7);
      expect(await rejects(() => review(b.requestId, [{ line_id: b.lineId, approved_quantity: 7 }])))
        .toMatch(/warehouse_return_aggregate_cap_exceeded/);
      expect((await lineState(b.lineId)).status).toBe('pending');
    });

    it('P3 received=10 returned=3 other=2 proposed=5 → PASS', async () => {
      const { transferLineId, stockId } = await deliver('R15C-P3', 10);
      await setAvailable(stockId, 100);

      const a = await pendingReturn(transferLineId, 2);
      await setLedger(transferLineId, 10, 3);
      await review(a.requestId, [{ line_id: a.lineId, approved_quantity: 2 }]);

      const b = await pendingReturn(transferLineId, 5);
      const r = await review(b.requestId, [{ line_id: b.lineId, approved_quantity: 5 }]);
      expect(r.ok).toBe(true);
    });

    it('P4 same state, proposed=6 → REJECT aggregate cap', async () => {
      const { transferLineId, stockId } = await deliver('R15C-P4', 10);
      await setAvailable(stockId, 100);

      const a = await pendingReturn(transferLineId, 2);
      await setLedger(transferLineId, 10, 3);
      await review(a.requestId, [{ line_id: a.lineId, approved_quantity: 2 }]);

      const b = await pendingReturn(transferLineId, 6);
      expect(await rejects(() => review(b.requestId, [{ line_id: b.lineId, approved_quantity: 6 }])))
        .toMatch(/warehouse_return_aggregate_cap_exceeded/);
    });
  });

  // ==========================================================================
  // C4 · DEAD STATUSES CONSUME NOTHING
  // ==========================================================================
  it('C4 · a CANCELLED approval consumes zero commitment even though it keeps approved_quantity', async () => {
    // wrrl_status_qty_consistency_chk only forces fulfilled_quantity = 0 on a
    // cancelled line - approved_quantity survives. Arithmetic alone would count
    // it; the helper filters by status, so it must not.
    const { transferLineId, stockId } = await deliver('R15C-DEAD', 10);
    await setLedger(transferLineId, 10, 0);
    await setAvailable(stockId, 100);

    const a = await pendingReturn(transferLineId, 8);
    await review(a.requestId, [{ line_id: a.lineId, approved_quantity: 8 }]);
    await admin(`UPDATE warehouse_return_request_lines SET status='cancelled' WHERE id=$1`, [a.lineId]);

    const dead = await lineState(a.lineId);
    expect(dead.status).toBe('cancelled');
    expect(dead.approved_quantity).toBe(8);   // the trap: still non-NULL

    // 10 would be impossible if the cancelled 8 were still counted.
    const b = await pendingReturn(transferLineId, 10);
    const r = await review(b.requestId, [{ line_id: b.lineId, approved_quantity: 10 }]);
    expect(r.ok).toBe(true);
  });

  it('C3 · a PARTIALLY FULFILLED line commits only its UNFULFILLED remainder', async () => {
    // approved 6 / fulfilled 4 -> outstanding 2, not 6. The fulfilled 4 is
    // already reflected in returned_quantity, so counting all 6 would both
    // double-count and refuse a legal review.
    const { transferLineId, stockId } = await deliver('R15C-PART', 10);
    await setAvailable(stockId, 100);

    const a = await pendingReturn(transferLineId, 6);
    await review(a.requestId, [{ line_id: a.lineId, approved_quantity: 6 }]);
    await admin(
      `UPDATE warehouse_return_request_lines
          SET fulfilled_quantity=4, status='partially_fulfilled' WHERE id=$1`, [a.lineId]);
    await setLedger(transferLineId, 10, 4);   // SEND already moved those 4

    // returned(4) + outstanding(2) + proposed(4) = 10 <= received(10)
    const b = await pendingReturn(transferLineId, 4);
    const r = await review(b.requestId, [{ line_id: b.lineId, approved_quantity: 4 }]);
    expect(r.ok).toBe(true);
  });

  // ==========================================================================
  // C5-C7 · PHYSICAL CAP
  // ==========================================================================
  it('C5 · physical cap fires with ample provenance headroom (same provenance)', async () => {
    const { transferLineId, stockId } = await deliver('R15C-PHYS1', 20);
    await setLedger(transferLineId, 20, 0);
    await setAvailable(stockId, 5);          // only 5 on the shelf

    // First commitment fits the 5 available.
    const a = await pendingReturn(transferLineId, 4);
    const ok = await review(a.requestId, [{ line_id: a.lineId, approved_quantity: 4 }]);
    expect(ok.ok).toBe(true);

    // Provenance still has 20-0-4 = 16 spare, so only the shelf can refuse the
    // next 4: outstanding(4) + proposed(4) > available(5).
    const b = await pendingReturn(transferLineId, 4);
    expect(await rejects(() => review(b.requestId, [{ line_id: b.lineId, approved_quantity: 4 }])))
      .toMatch(/warehouse_return_physical_cap_exceeded/);
  });

  it('C6 · CRITICAL: distinct provenance, SAME stock row → physical cap', async () => {
    // Two separate deliveries of the SAME material identity merge into one
    // warehouse_stock row. If the physical check were grouped by transfer line
    // this would pass and the shelf would be over-committed.
    const a = await deliver('R15C-SHARED', 10);
    const b = await deliver('R15C-SHARED', 10);
    // Two independent no-batch receipts get DISTINCT internal_batch_reference
    // by design (060 keeps separately received no-batch stock apart), so they
    // do not merge on their own. Re-anchor B onto A's row to build the exact
    // shape under test: DIFFERENT provenance, ONE physical balance.
    await admin(`UPDATE warehouse_transfer_lines SET resulting_warehouse_stock_id=$2 WHERE id=$1`,
      [b.transferLineId, a.stockId]);
    b.stockId = a.stockId;

    await setLedger(a.transferLineId, 10, 0);
    await setLedger(b.transferLineId, 10, 0);
    await setAvailable(a.stockId, 10);

    const first = await pendingReturn(a.transferLineId, 6);
    const ok = await review(first.requestId, [{ line_id: first.lineId, approved_quantity: 6 }]);
    expect(ok.ok).toBe(true);

    // Provenance for B is untouched (0 of 10 used), so ONLY the shared physical
    // balance can refuse this.
    const second = await pendingReturn(b.transferLineId, 5);
    expect(await rejects(() => review(second.requestId, [{ line_id: second.lineId, approved_quantity: 5 }])))
      .toMatch(/warehouse_return_physical_cap_exceeded/);
  });

  it('C7 · CRITICAL: two proposals in ONE review against the same stock are summed', async () => {
    const a = await deliver('R15C-ONEREVIEW', 10);
    const b = await deliver('R15C-ONEREVIEW', 10);
    await admin(`UPDATE warehouse_transfer_lines SET resulting_warehouse_stock_id=$2 WHERE id=$1`,
      [b.transferLineId, a.stockId]);
    b.stockId = a.stockId;

    await setLedger(a.transferLineId, 10, 0);
    await setLedger(b.transferLineId, 10, 0);
    await setAvailable(a.stockId, 7);

    // Both lines live in ONE request - legal, because they anchor to DIFFERENT
    // transfer lines, so wrrl_request_original_line_uniq permits it.
    const { requestId, lineA, lineB } = await asSuper(async (c: any) => {
      const wr = await call(c, 'phoenix_request_warehouse_return', [ROUTE, WH_INST, uniq('WR')]);
      const wrId = wr.return_request_id ?? wr.id;
      const la = await call(c, 'phoenix_add_warehouse_return_request_line',
        [wrId, a.transferLineId, 4, 'excess', 'r15c A']);
      const lb = await call(c, 'phoenix_add_warehouse_return_request_line',
        [wrId, b.transferLineId, 4, 'excess', 'r15c B']);
      await call(c, 'phoenix_submit_warehouse_return_request', [wrId]);
      return {
        requestId: wrId,
        lineA: la.return_request_line_id ?? la.id,
        lineB: lb.return_request_line_id ?? lb.id,
      };
    });

    // 4 and 4 are each individually under 7; only GROUPING them catches this.
    expect(await rejects(() => review(requestId, [
      { line_id: lineA, approved_quantity: 4 },
      { line_id: lineB, approved_quantity: 4 },
    ]))).toMatch(/warehouse_return_physical_cap_exceeded/);

    // C9 · nothing partially applied
    expect((await lineState(lineA)).status).toBe('pending');
    expect((await lineState(lineB)).status).toBe('pending');
  });

  // ==========================================================================
  // C8 / C9 · REVIEW MOVES NO STOCK, AND A REFUSAL WRITES NOTHING
  // ==========================================================================
  it('C8 · a SUCCESSFUL review moves no stock at all', async () => {
    const { transferLineId, stockId } = await deliver('R15C-NOMOVE', 10);
    await setLedger(transferLineId, 10, 0);
    await setAvailable(stockId, 50);

    const before = await stockSnapshot(stockId);
    const a = await pendingReturn(transferLineId, 5);
    const r = await review(a.requestId, [{ line_id: a.lineId, approved_quantity: 5 }]);
    expect(r.ok).toBe(true);

    const after = await stockSnapshot(stockId);
    expect(after.on_hand_quantity).toBe(before.on_hand_quantity);
    expect(after.reserved_quantity).toBe(before.reserved_quantity);
    expect(after.movements).toBe(before.movements);
  });

  it('C9 · a refused review leaves request, lines and stock untouched', async () => {
    const { transferLineId, stockId } = await deliver('R15C-ATOMIC', 10);
    await setAvailable(stockId, 50);

    // The line is added while it is still legal to request 5; the provenance is
    // narrowed AFTERWARDS so the refusal lands at REVIEW, which is the boundary
    // under test, rather than at add-time.
    const a = await pendingReturn(transferLineId, 5);
    await setLedger(transferLineId, 10, 9);
    const stockBefore = await stockSnapshot(stockId);
    const reqBefore: any = await admin(
      `SELECT status FROM warehouse_return_requests WHERE id=$1`, [a.requestId]);
    const auditBefore: any = await admin(`SELECT count(*)::int AS n FROM audit_logs`);

    expect(await rejects(() => review(a.requestId, [{ line_id: a.lineId, approved_quantity: 5 }])))
      .toMatch(/warehouse_return_aggregate_cap_exceeded/);

    expect(await stockSnapshot(stockId)).toEqual(stockBefore);
    const line = await lineState(a.lineId);
    expect(line.status).toBe('pending');
    expect(line.approved_quantity).toBeNull();
    expect(line.fulfilled_quantity).toBe(0);
    const reqAfter: any = await admin(
      `SELECT status FROM warehouse_return_requests WHERE id=$1`, [a.requestId]);
    expect(reqAfter.rows[0].status).toBe(reqBefore.rows[0].status);
    const auditAfter: any = await admin(`SELECT count(*)::int AS n FROM audit_logs`);
    expect(auditAfter.rows[0].n).toBe(auditBefore.rows[0].n);
  });

  // ==========================================================================
  // C12 · THE HELPER IS INTERNAL
  // ==========================================================================
  it('C12 · the cap helper is not a client-reachable surface', async () => {
    const r: any = await admin(`
      SELECT count(*)::int AS n FROM pg_roles r
      WHERE r.rolname IN ('anon','authenticated')
        AND has_function_privilege(
              r.oid,
              'public._phoenix_validate_warehouse_return_review_caps_v1(uuid,jsonb)'::regprocedure::oid,
              'EXECUTE')`);
    expect(r.rows[0].n).toBe(0);
  });

  it('C10 · the public review signature is unchanged and SEND still guards its own debit', async () => {
    const r: any = await admin(`
      SELECT pg_get_function_arguments(
               'public.phoenix_review_warehouse_return_request(uuid,jsonb)'::regprocedure) AS args,
             pg_get_functiondef(
               'public.phoenix_send_warehouse_return_shipment_line(uuid,uuid,uuid,integer,text,text,text)'::regprocedure)
               LIKE '%returned_quantity%' AS send_guard`);
    expect(r.rows[0].args).toBe('p_return_request_id uuid, p_decisions jsonb');
    expect(r.rows[0].send_guard).toBe(true);
  });
});
