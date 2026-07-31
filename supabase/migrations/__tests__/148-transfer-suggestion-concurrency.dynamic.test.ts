/**
 * 4B real-concurrency acceptance. Every blocking assertion observes
 * pg_stat_activity.wait_event_type='Lock'; delays are never used as a guess.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000148b01';
const WH = '00000000-0000-0000-0000-000000148b11';
const DP = '00000000-0000-0000-0000-000000148b21';
const TEST_TIMEOUT = 30_000;

run('148 / 4B transfer-suggestion concurrency', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 149 });
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO organizations (id,name,name_ar,code)
         VALUES ($1,'4B Org','مؤسسة 4B','p148-4b') ON CONFLICT (id) DO NOTHING`,
        [ORG],
      );
      await c.query(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code)
         VALUES ($1,$2,'4B WH','مخزن 4B','active','institution','p148-4b-wh')
         ON CONFLICT (id) DO NOTHING`,
        [WH, ORG],
      );
      await c.query(
        `INSERT INTO distribution_points
           (id,warehouse_id,organization_id,name,name_ar,point_type,status)
         VALUES ($1,$2,$3,'4B Outlet','منفذ 4B','pharmacy','active')
         ON CONFLICT (id) DO NOTHING`,
        [DP, WH, ORG],
      );
    });
  }, 120000);

  afterAll(async () => { if (rig) await rig.end(); }, TEST_TIMEOUT);

  async function openUserTx(lockTimeout = '5s') {
    const c = await rig.pool.connect();
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE authenticated`);
    await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [rig.superAdminId]);
    await c.query(`SET LOCAL statement_timeout='8s'`);
    await c.query(`SET LOCAL lock_timeout='${lockTimeout}'`);
    const pid = Number((await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
    return { c, pid };
  }

  async function openAdminTx(lockTimeout = '5s') {
    const c = await rig.pool.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [rig.superAdminId]);
    await c.query(`SET LOCAL statement_timeout='8s'`);
    await c.query(`SET LOCAL lock_timeout='${lockTimeout}'`);
    const pid = Number((await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
    return { c, pid };
  }

  async function finish(tx: { c: any }, commit = false) {
    try { await tx.c.query(commit ? 'COMMIT' : 'ROLLBACK'); } finally { tx.c.release(); }
  }

  async function waitForLock(pid: number) {
    for (let i = 0; i < 200; i += 1) {
      const waiting = await rig.asAdmin((c: any) => c.query(
        `SELECT wait_event_type, wait_event
           FROM pg_stat_activity
          WHERE pid=$1 AND wait_event_type='Lock'`,
        [pid],
      ));
      if (waiting.rowCount === 1) return waiting.rows[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`backend ${pid} never reached a deterministic lock wait`);
  }

  async function seedWarehouseToOutlet(
    suffix: string,
    opts: { targetRow?: boolean } = {},
  ) {
    const sci = `4B ${suffix}`;
    const sourceStockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO warehouse_stock
           (id,organization_id,warehouse_id,scientific_name,has_no_national_code,
            has_no_batch_number,batch_number,expiry_date,on_hand_quantity,reserved_quantity,movement_seq)
         VALUES ($1,$2,$3,$4,true,false,$5,current_date+365,100,0,1)`,
        [sourceStockId, ORG, WH, sci, `B-${suffix}-SRC`],
      );
      if (opts.targetRow) {
        await c.query(
          `INSERT INTO outlet_stock
             (organization_id,distribution_point_id,point_type,scientific_name,has_no_national_code,
              has_no_batch_number,batch_number,expiry_date,on_hand_quantity,reserved_quantity,movement_seq)
           VALUES ($1,$2,'pharmacy',$3,true,false,$4,current_date+365,5,0,1)`,
          [ORG, DP, sci, `B-${suffix}-OLD`],
        );
      }
      await c.query(
        `INSERT INTO inventory_signal_thresholds
           (organization_id,scope_kind,scope_id,scientific_name,target_max,is_active)
         VALUES ($1,'warehouse',$2,$3,10,true)`,
        [ORG, WH, sci],
      );
      await c.query(
         `INSERT INTO inventory_signal_thresholds
           (organization_id,scope_kind,scope_id,scientific_name,reorder_point,is_active)
         VALUES ($1,'outlet',$2,$3,50,true)`,
        [ORG, DP, sci],
      );
    });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [ORG]);
      await c.query(`SELECT public.phoenix_suggest_inventory_transfers($1)`, [ORG]);
    }, { commit: true });
    const row = await rig.asAdmin((c: any) => c.query(
      `SELECT id FROM inventory_transfer_suggestions
        WHERE source_stock_id=$1 AND route_kind='warehouse_to_outlet' AND status='open'
        ORDER BY created_at DESC LIMIT 1`,
      [sourceStockId],
    ));
    expect(row.rows[0]?.id).toBeTruthy();
    return { sci, sourceStockId, suggestionId: row.rows[0].id as string };
  }

  async function prepareInboundDispatch(sci: string, quantity = 20) {
    const inboundStockId = randomUUID();
    await rig.asAdmin((c: any) => c.query(
      `INSERT INTO warehouse_stock
         (id,organization_id,warehouse_id,scientific_name,has_no_national_code,
          has_no_batch_number,batch_number,expiry_date,on_hand_quantity,reserved_quantity,movement_seq)
       VALUES ($1,$2,$3,$4,true,false,$5,current_date+100,80,0,1)`,
      [inboundStockId, ORG, WH, sci, `B-IN-${inboundStockId.slice(0, 8)}`],
    ));
    let lineId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const d = await c.query(
        `SELECT public.phoenix_create_warehouse_dispatch($1,$2,$3,NULL,NULL,NULL) AS r`,
        [WH, DP, `IN-${randomUUID()}`],
      );
      const dispatchId = d.rows[0].r.dispatch_id;
      const line = await c.query(
        `SELECT public.phoenix_add_dispatch_line_fefo_guarded($1,$2,$3,false,NULL,$4) AS r`,
        [dispatchId, inboundStockId, quantity, randomUUID()],
      );
      lineId = line.rows[0].r.dispatch_line_id;
      await c.query(`SELECT public.phoenix_send_warehouse_dispatch($1,$2)`, [randomUUID(), dispatchId]);
    }, { commit: true });
    return lineId;
  }

  async function draft(c: any, suggestionId: string, doc: string) {
    return c.query(
      `SELECT public.phoenix_create_transfer_draft_from_suggestion($1,$2) AS r`,
      [suggestionId, doc],
    );
  }

  async function seedOutletToWarehouse(suffix: string) {
    const sci = `4B return ${suffix}`;
    const warehouseStockId = randomUUID();
    let dispatchLineId = '';
    let outletStockId = '';
    await rig.asAdmin((c: any) => c.query(
      `INSERT INTO warehouse_stock
         (id,organization_id,warehouse_id,scientific_name,has_no_national_code,
          has_no_batch_number,batch_number,expiry_date,on_hand_quantity,reserved_quantity,movement_seq)
       VALUES ($1,$2,$3,$4,true,false,$5,current_date+365,80,0,1)`,
      [warehouseStockId, ORG, WH, sci, `B-RET-${suffix}`],
    ));
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const created = await c.query(
        `SELECT public.phoenix_create_warehouse_dispatch($1,$2,$3,NULL,NULL,NULL) AS r`,
        [WH, DP, `PROV-${randomUUID()}`],
      );
      const line = await c.query(
        `SELECT public.phoenix_add_dispatch_line_fefo_guarded($1,$2,50,false,NULL,$3) AS r`,
        [created.rows[0].r.dispatch_id, warehouseStockId, randomUUID()],
      );
      dispatchLineId = line.rows[0].r.dispatch_line_id;
      await c.query(`SELECT public.phoenix_send_warehouse_dispatch($1,$2)`, [
        randomUUID(), created.rows[0].r.dispatch_id,
      ]);
    }, { commit: true });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const received = await c.query(
        `SELECT public.phoenix_receive_outlet_dispatch_line($1,$2,50,NULL,NULL) AS r`,
        [randomUUID(), dispatchLineId],
      );
      outletStockId = received.rows[0].r.outlet_stock_id;
    }, { commit: true });
    await rig.asAdmin(async (c: any) => {
      await c.query(
        `INSERT INTO inventory_signal_thresholds
           (organization_id,scope_kind,scope_id,scientific_name,target_max,is_active)
         VALUES ($1,'outlet',$2,$3,20,true)`,
        [ORG, DP, sci],
      );
      await c.query(
        `INSERT INTO inventory_signal_thresholds
           (organization_id,scope_kind,scope_id,scientific_name,reorder_point,is_active)
         VALUES ($1,'warehouse',$2,$3,60,true)`,
        [ORG, WH, sci],
      );
    });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await c.query(`SELECT public.phoenix_recompute_inventory_alerts($1)`, [ORG]);
      await c.query(`SELECT public.phoenix_suggest_inventory_transfers($1)`, [ORG]);
    }, { commit: true });
    const suggestion = await rig.asAdmin((c: any) => c.query(
      `SELECT id FROM inventory_transfer_suggestions
        WHERE route_kind='outlet_to_warehouse' AND source_stock_id=$1
          AND provenance_dispatch_line_id=$2 AND status='open'
        ORDER BY created_at DESC LIMIT 1`,
      [outletStockId, dispatchLineId],
    ));
    expect(suggestion.rows[0]?.id).toBeTruthy();
    return {
      dispatchLineId,
      suggestionId: suggestion.rows[0].id as string,
    };
  }

  it('1. reversed A/B resource sets serialize without deadlock', async () => {
    const a = await openAdminTx();
    const b = await openAdminTx();
    const keyA = `inv_position:${ORG}:warehouse:${WH}:4b-reverse:*`;
    const keyB = `inv_position:${ORG}:outlet:${DP}:4b-reverse:*`;
    await a.c.query(`SELECT public._phoenix_lock_inventory_resources($1::text[])`, [[keyA, keyB]]);
    const blocked = b.c.query(
      `SELECT public._phoenix_lock_inventory_resources($1::text[])`,
      [[keyB, keyA]],
    );
    await waitForLock(b.pid);
    await finish(a, true);
    await blocked;
    await finish(b, true);
  }, TEST_TIMEOUT);

  it('2. Draft serializes with a suggestion regeneration on the same source', async () => {
    const seeded = await seedWarehouseToOutlet('suggestion-writer');
    const blocker = await openAdminTx();
    await blocker.c.query(`SELECT public._phoenix_lock_inventory_resources($1::text[])`, [[`inv_suggest:${ORG}`]]);
    const contender = await openUserTx();
    const pending = draft(contender.c, seeded.suggestionId, `DOC-${randomUUID()}`);
    await waitForLock(contender.pid);
    await blocker.c.query(`SELECT public.phoenix_suggest_inventory_transfers($1)`, [ORG]);
    await finish(blocker, true);
    const result = await pending;
    expect(result.rows[0].r.ok).toBe(true);
    await finish(contender, true);
  }, TEST_TIMEOUT);

  for (const [label, targetRow] of [['first target row', false], ['new target batch', true]] as const) {
    it(`3/4. Draft serializes with receipt creating ${label}`, async () => {
      const seeded = await seedWarehouseToOutlet(`receipt-${targetRow}`, { targetRow });
      const lineId = await prepareInboundDispatch(seeded.sci, 20);
      const receipt = await openUserTx();
      await receipt.c.query(`SELECT 1 FROM distribution_points WHERE id=$1 FOR UPDATE`, [DP]);
      const drafting = await openUserTx();
      const doc = `DOC-${randomUUID()}`;
      const pendingDraft = draft(drafting.c, seeded.suggestionId, doc);
      await waitForLock(drafting.pid);
      await receipt.c.query(
        `SELECT public.phoenix_receive_outlet_dispatch_line($1,$2,20,NULL,NULL)`,
        [randomUUID(), lineId],
      );
      await finish(receipt, true);
      await expect(pendingDraft).rejects.toThrow(/fefo_override_required/);
      await finish(drafting);
      const docs = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int AS n FROM warehouse_dispatches WHERE dispatch_number=$1`,
        [doc],
      ));
      expect(docs.rows[0].n).toBe(0);
    }, TEST_TIMEOUT);
  }

  for (const [label, isDefault] of [['default', true], ['scope', false]] as const) {
    it(`6/7. Draft serializes with ${label}-threshold upsert`, async () => {
      const seeded = await seedWarehouseToOutlet(`threshold-${label}`);
      const threshold = await openAdminTx();
      const key = `inv_threshold:${ORG}:outlet:${seeded.sci.toLowerCase()}`;
      await threshold.c.query(`SELECT public._phoenix_lock_inventory_resources($1::text[])`, [[key]]);
      const drafting = await openUserTx();
      const pendingDraft = draft(drafting.c, seeded.suggestionId, `DOC-${randomUUID()}`);
      await waitForLock(drafting.pid);
      await threshold.c.query(
        `SELECT public.phoenix_upsert_inventory_threshold($1,'outlet',$2,$3,NULL,40,NULL,NULL,true)`,
        [ORG, isDefault ? null : DP, seeded.sci],
      );
      await finish(threshold, true);
      const result = await pendingDraft;
      expect(result.rows[0].r.ok).toBe(true);
      await finish(drafting, true);
    }, TEST_TIMEOUT);
  }

  it('5. Draft serializes with a real outlet-return line writer on shared provenance', async () => {
    const seeded = await seedOutletToWarehouse(randomUUID().slice(0, 8));
    let competingRequestId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const request = await c.query(
        `SELECT public.phoenix_request_outlet_return($1,$2,NULL) AS r`,
        [DP, `RET-COMPETE-${randomUUID()}`],
      );
      competingRequestId = request.rows[0].r.return_request_id;
    }, { commit: true });

    const returnWriter = await openAdminTx();
    await returnWriter.c.query(
      `SELECT public._phoenix_lock_inventory_resources($1::text[])`,
      [[`inv_provline:${seeded.dispatchLineId}`]],
    );
    const drafting = await openUserTx();
    const pendingDraft = draft(drafting.c, seeded.suggestionId, `DOC-${randomUUID()}`);
    await waitForLock(drafting.pid);
    await returnWriter.c.query(
      `SELECT public.phoenix_add_outlet_return_request_line($1,$2,5,'excess',$3)`,
      [competingRequestId, seeded.dispatchLineId, '4B concurrency writer'],
    );
    await finish(returnWriter, true);
    const result = await pendingDraft;
    expect(result.rows[0].r.ok).toBe(true);
    await finish(drafting, true);
    const lines = await rig.asAdmin((c: any) => c.query(
      `SELECT count(*)::int AS n FROM outlet_return_request_lines
        WHERE original_dispatch_line_id=$1`,
      [seeded.dispatchLineId],
    ));
    expect(lines.rows[0].n).toBe(2);
  }, TEST_TIMEOUT);

  it('8. Draft and inverse-order threshold batches serialize canonically', async () => {
    const seeded = await seedWarehouseToOutlet('batch-a');
    const other = '4B batch-b';
    const first = await openAdminTx();
    const key = `inv_threshold:${ORG}:outlet:${seeded.sci.toLowerCase()}`;
    await first.c.query(`SELECT public._phoenix_lock_inventory_resources($1::text[])`, [[key]]);
    const second = await openUserTx();
    const drafting = await openUserTx();
    const batch2 = second.c.query(
      `SELECT public.phoenix_batch_upsert_inventory_threshold($1,'outlet',$2,$3::jsonb)`,
      [ORG, DP, JSON.stringify([
        { scientific_name: other, reorder_point: 11 },
        { scientific_name: seeded.sci, reorder_point: 41 },
      ])],
    );
    const pendingDraft = draft(drafting.c, seeded.suggestionId, `DOC-${randomUUID()}`);
    await waitForLock(second.pid);
    await waitForLock(drafting.pid);
    await first.c.query(
      `SELECT public.phoenix_batch_upsert_inventory_threshold($1,'outlet',$2,$3::jsonb)`,
      [ORG, DP, JSON.stringify([
        { scientific_name: seeded.sci, reorder_point: 42 },
        { scientific_name: other, reorder_point: 12 },
      ])],
    );
    await finish(first, true);
    await batch2;
    await finish(second, true);
    const result = await pendingDraft;
    expect(result.rows[0].r.ok).toBe(true);
    await finish(drafting, true);
  }, TEST_TIMEOUT);

  it('9/10. timeout then retry creates one document and no Draft stock/custody movement', async () => {
    const seeded = await seedWarehouseToOutlet('retry');
    const blocker = await openAdminTx();
    await blocker.c.query(`SELECT public._phoenix_lock_inventory_resources($1::text[])`, [[`inv_suggest:${ORG}`]]);
    const losing = await openUserTx('150ms');
    const doc = `DOC-RETRY-${randomUUID()}`;
    await expect(draft(losing.c, seeded.suggestionId, doc)).rejects.toThrow(/lock timeout/i);
    await finish(losing);
    await finish(blocker, true);

    const before = await rig.asAdmin(async (c: any) => ({
      warehouse: Number((await c.query(`SELECT count(*) AS n FROM warehouse_stock_movements`)).rows[0].n),
      outlet: Number((await c.query(`SELECT count(*) AS n FROM outlet_stock_movements`)).rows[0].n),
    }));
    await rig.asUser(rig.superAdminId, (c: any) => draft(c, seeded.suggestionId, doc), { commit: true });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const replay = await draft(c, seeded.suggestionId, doc);
      expect(replay.rows[0].r.idempotent_replay).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const docs = await c.query(
        `SELECT count(*)::int AS n FROM warehouse_dispatches WHERE dispatch_number=$1`,
        [doc],
      );
      expect(docs.rows[0].n).toBe(1);
      expect(Number((await c.query(`SELECT count(*) AS n FROM warehouse_stock_movements`)).rows[0].n))
        .toBe(before.warehouse);
      expect(Number((await c.query(`SELECT count(*) AS n FROM outlet_stock_movements`)).rows[0].n))
        .toBe(before.outlet);
      const orphan = await c.query(
        `SELECT count(*)::int AS n
           FROM inventory_transfer_suggestions s
          WHERE s.id=$1 AND s.status='accepted' AND s.draft_warehouse_dispatch_id IS NULL`,
        [seeded.suggestionId],
      );
      expect(orphan.rows[0].n).toBe(0);
    });
  }, TEST_TIMEOUT);
});
