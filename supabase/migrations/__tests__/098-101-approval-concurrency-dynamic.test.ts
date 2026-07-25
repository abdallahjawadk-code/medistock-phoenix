/**
 * 098/101 APPROVAL CONCURRENCY — DYNAMIC proof against a real disposable
 * Postgres with 001->107 applied in order.
 *
 * Closes Phase 2 gap 2: 106's idempotency was proven under real concurrent
 * connections, but phoenix_approve_outlet_stock_correction (098) /
 * phoenix_approve_warehouse_stock_correction (101) — and their reject
 * counterparts — had only ever been proven "exactly once" via SEQUENTIAL
 * double-calls (097-098-101-live-gaps-dynamic.test.ts: the second call runs
 * strictly after the first already committed). This file fires TWO genuinely
 * concurrent connections at the SAME still-pending request via
 * Promise.allSettled (never sequential awaits), for both scopes:
 *
 *   - approve vs approve, same pending request: exactly one succeeds, the
 *     other fails cleanly with correction_request_not_pending (never both
 *     succeeding, never both failing, never a deadlock/hang); the request's
 *     status advances exactly once; exactly one stock movement is recorded.
 *   - approve vs reject, same pending request: exactly one final outcome
 *     wins (approved-with-movement XOR rejected-with-no-movement), never
 *     both, never neither.
 *
 * The serialization mechanism under test is 098/101's own
 * `SELECT ... FOR UPDATE` on the phoenix_*_correction_requests row inside
 * each RPC: the second concurrent transaction blocks on that row lock until
 * the first commits, then observes the row already decided and raises
 * 'correction_request_not_pending' — no new locking is added by this test,
 * it only proves the existing mechanism actually holds under real
 * concurrency instead of sequential ordering.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000100001';
const WH = '00000000-0000-0000-0000-000000100101';
const DP = '00000000-0000-0000-0000-000000100301';

const OO = '00000000-0000-0000-0000-000000100401';  // outlet_officer — proposer, outlet-side
const WO = '00000000-0000-0000-0000-000000100402';  // warehouse_officer — proposer, warehouse-side
const CWM1 = '00000000-0000-0000-0000-000000100403'; // central_warehouse_manager — approver #1
const CWM2 = '00000000-0000-0000-0000-000000100404'; // central_warehouse_manager — approver #2 (DIFFERENT profile, same permission)

run('098/101 approval concurrency — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 107 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Org','مؤسسة','p98race-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','WH','مخزن','active','institution','p98race-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP}','${WH}','${ORG}','Outlet','منفذ','pharmacy','active') ON CONFLICT DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${OO}','p98race-oo@rig'),('${WO}','p98race-wo@rig'),
        ('${CWM1}','p98race-cwm1@rig'),('${CWM2}','p98race-cwm2@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG}' WHERE id='${OO}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${WO}';`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM1}';`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM2}';`);

      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${OO}','${ORG}','warehouse','${WH}',true),
               ('${WO}','${ORG}','warehouse','${WH}',true),
               ('${CWM1}','${ORG}','warehouse','${WH}',true),
               ('${CWM2}','${ORG}','warehouse','${WH}',true)
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
        VALUES ('${OO}','${ORG}','distribution_point','${DP}',true),
               ('${CWM1}','${ORG}','distribution_point','${DP}',true),
               ('${CWM2}','${ORG}','distribution_point','${DP}',true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ── Outlet (098) ─────────────────────────────────────────────────────────

  async function seedOutletCorrection(tag: string, onHand: number, counted: number) {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy',$4,true,false,$5,$6,0,0)`, [stockId, ORG, DP, `P98R-${tag}`, `B-${tag}`, onHand]);
    });
    let correctionId = '';
    await rig.asUser(OO, async (c: any) => {
      const r = await call(c, 'phoenix_request_outlet_stock_correction',
        [randomUUID(), stockId, counted, 'physical count', null, null]);
      expect(r.requires_approval).toBe(true);
      correctionId = r.correction_request_id;
    }, { commit: true });
    return { stockId, correctionId };
  }

  it('098 — approve vs approve on the SAME pending request: exactly one wins, one movement recorded', async () => {
    const { stockId, correctionId } = await seedOutletCorrection('AVA', 40, 33);

    const results = await Promise.allSettled([
      rig.asUser(CWM1, (c: any) => call(c, 'phoenix_approve_outlet_stock_correction', [correctionId, null]), { commit: true }),
      rig.asUser(CWM2, (c: any) => call(c, 'phoenix_approve_outlet_stock_correction', [correctionId, null]), { commit: true }),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBe(1); // exactly one succeeds
    expect(rejected.length).toBe(1); // the other fails cleanly
    expect(String(rejected[0].reason)).toMatch(/correction_request_not_pending/);
    expect(fulfilled[0].value.ok).toBe(true);

    await rig.asAdmin(async (c: any) => {
      const req = await c.query(`SELECT status, decided_by FROM phoenix_stock_correction_requests WHERE id=$1`, [correctionId]);
      expect(req.rows[0].status).toBe('approved'); // advanced exactly once
      expect([CWM1, CWM2]).toContain(req.rows[0].decided_by);

      const stock = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [stockId]);
      expect(stock.rows[0].on_hand_quantity).toBe(33); // the winning outcome's value
      expect(stock.rows[0].on_hand_quantity).toBeGreaterThanOrEqual(0);

      const movements = await c.query(
        `SELECT count(*)::int n FROM outlet_stock_movements WHERE outlet_stock_id=$1 AND movement_type='correction'`, [stockId]);
      expect(movements.rows[0].n).toBe(1); // exactly one movement, not zero, not two
    });
  });

  it('098 — approve vs reject on the SAME pending request: exactly one final outcome wins, never both, never neither', async () => {
    const { stockId, correctionId } = await seedOutletCorrection('AVR', 50, 20);

    const results = await Promise.allSettled([
      rig.asUser(CWM1, (c: any) => call(c, 'phoenix_approve_outlet_stock_correction', [correctionId, null]), { commit: true }),
      rig.asUser(CWM2, (c: any) => call(c, 'phoenix_reject_outlet_stock_correction', [correctionId, 'not credible']), { commit: true }),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBe(1); // exactly one of {approve, reject} wins
    expect(rejected.length).toBe(1);
    expect(String(rejected[0].reason)).toMatch(/correction_request_not_pending/);

    await rig.asAdmin(async (c: any) => {
      const req = await c.query(`SELECT status FROM phoenix_stock_correction_requests WHERE id=$1`, [correctionId]);
      const finalStatus = req.rows[0].status;
      expect(['approved', 'rejected']).toContain(finalStatus); // one decisive outcome, never 'pending'

      const stock = await c.query(`SELECT on_hand_quantity FROM outlet_stock WHERE id=$1`, [stockId]);
      const movements = await c.query(
        `SELECT count(*)::int n FROM outlet_stock_movements WHERE outlet_stock_id=$1 AND movement_type='correction'`, [stockId]);

      if (finalStatus === 'approved') {
        expect(stock.rows[0].on_hand_quantity).toBe(20); // approve won: quantity changed
        expect(movements.rows[0].n).toBe(1); // approved-with-movement
      } else {
        expect(stock.rows[0].on_hand_quantity).toBe(50); // reject won: quantity untouched
        expect(movements.rows[0].n).toBe(0); // rejected-with-no-movement
      }
      expect(stock.rows[0].on_hand_quantity).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Warehouse (101) ──────────────────────────────────────────────────────

  async function seedWarehouseCorrection(tag: string, onHand: number, newQty: number) {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,$4,true,false,$5,$6,0,0)`, [stockId, ORG, WH, `P101R-${tag}`, `B-${tag}`, onHand]);
    });
    let correctionId = '';
    await rig.asUser(WO, async (c: any) => {
      const r = await call(c, 'phoenix_request_warehouse_stock_correction',
        [randomUUID(), stockId, newQty, 'physical count', null, null, null]);
      expect(r.requires_approval).toBe(true);
      correctionId = r.correction_request_id;
    }, { commit: true });
    return { stockId, correctionId };
  }

  it('101 — approve vs approve on the SAME pending request: exactly one wins, one movement recorded', async () => {
    const { stockId, correctionId } = await seedWarehouseCorrection('AVA', 60, 45);

    const results = await Promise.allSettled([
      rig.asUser(CWM1, (c: any) => call(c, 'phoenix_approve_warehouse_stock_correction', [correctionId, null]), { commit: true }),
      rig.asUser(CWM2, (c: any) => call(c, 'phoenix_approve_warehouse_stock_correction', [correctionId, null]), { commit: true }),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(String(rejected[0].reason)).toMatch(/correction_request_not_pending/);

    await rig.asAdmin(async (c: any) => {
      const req = await c.query(`SELECT status, decided_by FROM phoenix_warehouse_correction_requests WHERE id=$1`, [correctionId]);
      expect(req.rows[0].status).toBe('approved');
      expect([CWM1, CWM2]).toContain(req.rows[0].decided_by);

      const stock = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [stockId]);
      expect(stock.rows[0].on_hand_quantity).toBe(45);
      expect(stock.rows[0].on_hand_quantity).toBeGreaterThanOrEqual(0);

      const movements = await c.query(
        `SELECT count(*)::int n FROM warehouse_stock_movements WHERE warehouse_stock_id=$1 AND movement_type='correction'`, [stockId]);
      expect(movements.rows[0].n).toBe(1);
    });
  });

  it('101 — approve vs reject on the SAME pending request: exactly one final outcome wins, never both, never neither', async () => {
    const { stockId, correctionId } = await seedWarehouseCorrection('AVR', 70, 55);

    const results = await Promise.allSettled([
      rig.asUser(CWM1, (c: any) => call(c, 'phoenix_reject_warehouse_stock_correction', [correctionId, 'not credible']), { commit: true }),
      rig.asUser(CWM2, (c: any) => call(c, 'phoenix_approve_warehouse_stock_correction', [correctionId, null]), { commit: true }),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(String(rejected[0].reason)).toMatch(/correction_request_not_pending/);

    await rig.asAdmin(async (c: any) => {
      const req = await c.query(`SELECT status FROM phoenix_warehouse_correction_requests WHERE id=$1`, [correctionId]);
      const finalStatus = req.rows[0].status;
      expect(['approved', 'rejected']).toContain(finalStatus);

      const stock = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [stockId]);
      const movements = await c.query(
        `SELECT count(*)::int n FROM warehouse_stock_movements WHERE warehouse_stock_id=$1 AND movement_type='correction'`, [stockId]);

      if (finalStatus === 'approved') {
        expect(stock.rows[0].on_hand_quantity).toBe(55);
        expect(movements.rows[0].n).toBe(1);
      } else {
        expect(stock.rows[0].on_hand_quantity).toBe(70);
        expect(movements.rows[0].n).toBe(0);
      }
      expect(stock.rows[0].on_hand_quantity).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Final reconciliation ─────────────────────────────────────────────────

  it('final invariant: no negative on_hand/reserved anywhere in ORG touched by this file, decision rows are singular', async () => {
    await rig.asAdmin(async (c: any) => {
      const negOutlet = await c.query(
        `SELECT count(*)::int n FROM outlet_stock WHERE organization_id=$1 AND (on_hand_quantity < 0 OR reserved_quantity < 0)`, [ORG]);
      expect(negOutlet.rows[0].n).toBe(0);

      const negWh = await c.query(
        `SELECT count(*)::int n FROM warehouse_stock WHERE organization_id=$1 AND (on_hand_quantity < 0 OR reserved_quantity < 0)`, [ORG]);
      expect(negWh.rows[0].n).toBe(0);

      // Every correction request touched by this file has exactly one decision:
      // decided_at IS NOT NULL and status is a terminal state, never re-decided.
      const outletDecisions = await c.query(
        `SELECT count(*)::int n FROM phoenix_stock_correction_requests
           WHERE organization_id=$1 AND status <> 'pending' AND decided_at IS NOT NULL`, [ORG]);
      expect(outletDecisions.rows[0].n).toBe(2); // the two outlet races above

      const warehouseDecisions = await c.query(
        `SELECT count(*)::int n FROM phoenix_warehouse_correction_requests
           WHERE organization_id=$1 AND status <> 'pending' AND decided_at IS NOT NULL`, [ORG]);
      expect(warehouseDecisions.rows[0].n).toBe(2); // the two warehouse races above
    });
  });
});
