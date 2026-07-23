/**
 * DISPATCH-LINE-REQUEST-ID-REQUIRED — DYNAMIC proof for migration 107, against
 * a real disposable Postgres with 001->107 applied in order.
 *
 * Closes Phase 2 gap 1 (NULL request_id was still a live bypass on 106's
 * otherwise-idempotent phoenix_add_dispatch_line_fefo_guarded). Proves:
 *   - p_request_id NULL/omitted now raises 'request_id_required' (23514)
 *     BEFORE any read or write — no row in warehouse_dispatch_lines,
 *     warehouse_stock_movements, or phoenix_dispatch_line_requests results
 *     from a rejected NULL call (a partial write on a rejected call would
 *     itself be a defect).
 *   - exactly ONE pg_proc row still exists for this function name (107 is a
 *     same-signature CREATE OR REPLACE over 106, not a new overload).
 *   - 106's own contract is NOT broken by 107: same request_id+payload
 *     replay, same request_id+different payload 23505 conflict, and
 *     concurrent-duplicate-request-id → exactly one mutation ALL still hold
 *     for every call that DOES supply a request id.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-0000000f0001';
const WH = '00000000-0000-0000-0000-0000000f0101';
const DP = '00000000-0000-0000-0000-0000000f0301';

const WO1 = '00000000-0000-0000-0000-0000000f0401'; // warehouse_officer — holds edit_draft + fefo_override

run('107 dispatch-line request_id required — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 107 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Inst','مؤسسة','p107-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','Inst WH','مخزن مؤسسة','active','institution','p107-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP}','${WH}','${ORG}','Outlet','منفذ','pharmacy','active') ON CONFLICT DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${WO1}','p107-wo1@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${WO1}';`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${WO1}','${ORG}','warehouse','${WH}',true) ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
        VALUES ('${WO1}','${ORG}','distribution_point','${DP}',true) ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('resolves to exactly ONE pg_proc row — 107 is a same-signature replace over 106, not a new overload', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT pg_get_function_identity_arguments(oid) args
           FROM pg_proc WHERE proname = 'phoenix_add_dispatch_line_fefo_guarded'`);
      expect(r.rows.length).toBe(1);
      expect(r.rows[0].args).toBe(
        'p_dispatch_id uuid, p_warehouse_stock_id uuid, p_quantity integer, p_fefo_override boolean, p_override_reason text, p_request_id uuid');
    });
  });

  async function seedDispatchAndStock(tag: string, onHand = 50) {
    const dispatchId = randomUUID();
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_dispatches (id, organization_id, warehouse_id, destination_distribution_point_id, dispatch_number, status, created_by)
        VALUES ($1,$2,$3,$4,$5,'draft',$6)`, [dispatchId, ORG, WH, DP, `P107-DSP-${tag}`, WO1]);
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, expiry_date, movement_seq)
        VALUES ($1,$2,$3,$4,true,false,$5,$6,0,current_date + 30,0)`,
        [stockId, ORG, WH, `P107-${tag}`, `B-${tag}`, onHand]);
    });
    return { dispatchId, stockId };
  }

  it('p_request_id NULL is now REJECTED with request_id_required — and writes NOTHING anywhere', async () => {
    const { dispatchId, stockId } = await seedDispatchAndStock('NULLREJ');

    await rig.asUser(WO1, async (c: any) => {
      await expect(call(c, 'phoenix_add_dispatch_line_fefo_guarded', [dispatchId, stockId, 5, false, null, null]))
        .rejects.toThrow(/request_id_required/);
    });

    // Explicitly OMITTING the 6th positional arg (not just passing NULL)
    // resolves to the same DEFAULT NULL and must be rejected identically.
    await rig.asUser(WO1, async (c: any) => {
      await expect(call(c, 'phoenix_add_dispatch_line_fefo_guarded', [dispatchId, stockId, 5, false, null]))
        .rejects.toThrow(/request_id_required/);
    });

    await rig.asAdmin(async (c: any) => {
      const lines = await c.query(`SELECT count(*)::int n FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [dispatchId]);
      expect(lines.rows[0].n).toBe(0); // no partial write on a rejected call
      const movements = await c.query(`SELECT count(*)::int n FROM warehouse_stock_movements WHERE warehouse_stock_id=$1`, [stockId]);
      expect(movements.rows[0].n).toBe(0);
      const dedup = await c.query(`SELECT count(*)::int n FROM phoenix_dispatch_line_requests WHERE dispatch_id=$1`, [dispatchId]);
      expect(dedup.rows[0].n).toBe(0);
      const stock = await c.query(`SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1`, [stockId]);
      expect(stock.rows[0].on_hand_quantity).toBe(50); // untouched
    });
  });

  it('REGRESSION of 106: same request_id + SAME payload still replays the original result — no second line', async () => {
    const { dispatchId, stockId } = await seedDispatchAndStock('REPLAY');
    const requestId = randomUUID();

    let firstLineId = '';
    await rig.asUser(WO1, async (c: any) => {
      const r1 = await call(c, 'phoenix_add_dispatch_line_fefo_guarded', [dispatchId, stockId, 7, false, null, requestId]);
      expect(r1.ok).toBe(true);
      firstLineId = r1.dispatch_line_id;

      const r2 = await call(c, 'phoenix_add_dispatch_line_fefo_guarded', [dispatchId, stockId, 7, false, null, requestId]);
      expect(r2.dispatch_line_id).toBe(firstLineId);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const lines = await c.query(`SELECT count(*)::int n, coalesce(sum(sent_quantity),0)::int total FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [dispatchId]);
      expect(lines.rows[0].n).toBe(1);
      expect(lines.rows[0].total).toBe(7);
    });
  });

  it('REGRESSION of 106: same request_id + DIFFERENT payload still conflicts with 23505', async () => {
    const { dispatchId, stockId } = await seedDispatchAndStock('CONFLICT');
    const requestId = randomUUID();

    await rig.asUser(WO1, async (c: any) => {
      const r1 = await call(c, 'phoenix_add_dispatch_line_fefo_guarded', [dispatchId, stockId, 6, false, null, requestId]);
      expect(r1.ok).toBe(true);
    }, { commit: true });

    await rig.asUser(WO1, async (c: any) => {
      await expect(call(c, 'phoenix_add_dispatch_line_fefo_guarded',
        [dispatchId, stockId, 9, false, null, requestId])).rejects.toThrow(/request_id_conflict/);
    });

    await rig.asAdmin(async (c: any) => {
      const lines = await c.query(`SELECT count(*)::int n, coalesce(sum(sent_quantity),0)::int total FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [dispatchId]);
      expect(lines.rows[0].n).toBe(1);
      expect(lines.rows[0].total).toBe(6);
    });
  });

  it('REGRESSION of 106: two truly concurrent connections issuing the SAME request_id+payload still produce exactly ONE mutation', async () => {
    const { dispatchId, stockId } = await seedDispatchAndStock('CONCURRENT');
    const requestId = randomUUID();

    const results = await Promise.allSettled([
      rig.asUser(WO1, (c: any) => call(c, 'phoenix_add_dispatch_line_fefo_guarded',
        [dispatchId, stockId, 11, false, null, requestId]), { commit: true }),
      rig.asUser(WO1, (c: any) => call(c, 'phoenix_add_dispatch_line_fefo_guarded',
        [dispatchId, stockId, 11, false, null, requestId]), { commit: true }),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(2);
    const lineIds = new Set(fulfilled.map((r) => r.value.dispatch_line_id));
    expect(lineIds.size).toBe(1);

    await rig.asAdmin(async (c: any) => {
      const lines = await c.query(`SELECT count(*)::int n, coalesce(sum(sent_quantity),0)::int total FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [dispatchId]);
      expect(lines.rows[0].n).toBe(1);
      expect(lines.rows[0].total).toBe(11);
    });
  });

  it('two truly concurrent connections BOTH omitting request_id are BOTH rejected — no race can smuggle a NULL mutation through', async () => {
    const { dispatchId, stockId } = await seedDispatchAndStock('CONCURRENT-NULL');

    const results = await Promise.allSettled([
      rig.asUser(WO1, (c: any) => call(c, 'phoenix_add_dispatch_line_fefo_guarded',
        [dispatchId, stockId, 4, false, null, null]), { commit: true }),
      rig.asUser(WO1, (c: any) => call(c, 'phoenix_add_dispatch_line_fefo_guarded',
        [dispatchId, stockId, 4, false, null, null]), { commit: true }),
    ]);

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(String((r as PromiseRejectedResult).reason)).toMatch(/request_id_required/);
      }
    }

    await rig.asAdmin(async (c: any) => {
      const lines = await c.query(`SELECT count(*)::int n FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [dispatchId]);
      expect(lines.rows[0].n).toBe(0);
    });
  });

  it('final invariant: no negative on_hand anywhere touched by this file', async () => {
    await rig.asAdmin(async (c: any) => {
      const neg = await c.query(
        `SELECT count(*)::int n FROM warehouse_stock WHERE organization_id = $1 AND on_hand_quantity < 0`, [ORG]);
      expect(neg.rows[0].n).toBe(0);
    });
  });
});
