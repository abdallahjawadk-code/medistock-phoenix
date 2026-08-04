/**
 * OUTLET-RETURN-LINE-IDEMPOTENCY-156 — DYNAMIC integration proof, against a
 * real disposable Postgres with 001->156 applied in order.
 *
 * Mirrors 106/107's own dynamic-test shape (this repo's established
 * precedent for this exact idempotency pattern): pg_proc overload identity,
 * NULL-request-id backward compatibility, same-fingerprint replay, mismatched
 * -fingerprint conflict, and two truly concurrent connections resolving to
 * exactly one mutation. Seed shape (warehouse_stock -> outlet_stock ->
 * dispatch -> accepted dispatch line -> dispatch_receive movement -> draft
 * return request) follows 150-outlet-return-aggregate-cap.dynamic.test.ts's
 * own seedIsolatedScenario, adapted to a 'draft' request (ADD-LINE requires
 * draft) with no pre-inserted lines — this file adds lines through the RPC
 * under test, not by direct INSERT.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI-without-rig (no database).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000156001';
const WAREHOUSE = '00000000-0000-0000-0000-000000156101';
const OUTLET = '00000000-0000-0000-0000-000000156201';
let sequence = 0;

const call = (c: any, fn: string, args: any[]) =>
  c.query(
    `SELECT public.${fn}(${args.map((_, index) => `$${index + 1}`).join(',')}) AS r`,
    args,
  ).then((result: any) => result.rows[0].r);

type Scenario = {
  returnRequestId: string;
  dispatchLineId: string;
  cap: number;
};

/** One isolated provenance chain: a fresh accepted dispatch line, its inbound
 * receive movement, and a fresh DRAFT return request ready for ADD-LINE. */
const seedScenario = async (
  rig: Awaited<ReturnType<typeof buildRig>>,
  receivedQuantity = 10,
): Promise<Scenario> => {
  const tag = `P156-${Date.now()}-${sequence++}`;
  const warehouseStockId = randomUUID();
  const outletStockId = randomUUID();
  const dispatchId = randomUUID();
  const dispatchLineId = randomUUID();
  const inboundMovementId = randomUUID();
  const returnRequestId = randomUUID();

  await rig.asAdmin((c: any) => c.query(`
    INSERT INTO warehouse_stock(
      id,organization_id,warehouse_id,scientific_name,concentration,
      dosage_form,unit,national_code,has_no_national_code,
      batch_number,has_no_batch_number,expiry_date,
      on_hand_quantity,reserved_quantity,movement_seq
    ) VALUES(
      '${warehouseStockId}','${ORG}','${WAREHOUSE}','${tag}','10 mg',
      'tablet','box',NULL,true,'${tag}',false,current_date+365,100,0,1
    );

    INSERT INTO outlet_stock(
      id,organization_id,distribution_point_id,point_type,
      scientific_name,concentration,dosage_form,unit,
      national_code,has_no_national_code,batch_number,has_no_batch_number,
      expiry_date,on_hand_quantity,reserved_quantity,movement_seq
    ) VALUES(
      '${outletStockId}','${ORG}','${OUTLET}','pharmacy',
      '${tag}','10 mg','tablet','box',
      NULL,true,'${tag}',false,current_date+365,
      ${receivedQuantity + 20},0,1
    );

    INSERT INTO warehouse_dispatches(
      id,organization_id,warehouse_id,destination_distribution_point_id,
      dispatch_number,status,sent_by,sent_at
    ) VALUES(
      '${dispatchId}','${ORG}','${WAREHOUSE}','${OUTLET}',
      '${tag}-DISPATCH','sent','${rig.superAdminId}',now()
    );

    INSERT INTO warehouse_dispatch_lines(
      id,organization_id,dispatch_id,warehouse_stock_id,
      scientific_name,concentration,dosage_form,unit,
      national_code,has_no_national_code,batch_number,has_no_batch_number,
      expiry_date,sent_quantity,status,received_quantity,
      accepted_by,accepted_at,resulting_outlet_stock_id
    ) VALUES(
      '${dispatchLineId}','${ORG}','${dispatchId}','${warehouseStockId}',
      '${tag}','10 mg','tablet','box',
      NULL,true,'${tag}',false,current_date+365,
      ${receivedQuantity},'accepted',${receivedQuantity},
      '${rig.superAdminId}',now(),'${outletStockId}'
    );

    INSERT INTO outlet_stock_movements(
      id,outlet_stock_id,organization_id,distribution_point_id,movement_type,
      on_hand_before,on_hand_delta,on_hand_after,
      reserved_before,reserved_delta,reserved_after,
      dispatch_line_id,scientific_name_snapshot,reason_code
    ) VALUES(
      '${inboundMovementId}','${outletStockId}','${ORG}','${OUTLET}',
      'dispatch_receive',0,${receivedQuantity},${receivedQuantity},0,0,0,
      '${dispatchLineId}','${tag}','received'
    );

    -- ADD-LINE requires status='draft' (148/156's own guard) — the
    -- created-header RPC (phoenix_recall_outlet_stock) is not exercised
    -- here; this test is about ADD-LINE itself, matching this suite's
    -- established convention of seeding prerequisite state directly.
    -- orr_requested_at_chk (071) requires requested_at IS NULL while
    -- status='draft'.
    INSERT INTO outlet_return_requests(
      id,distribution_point_id,source_organization_id,
      destination_warehouse_id,destination_organization_id,
      return_number,status,requested_by_side
    ) VALUES(
      '${returnRequestId}','${OUTLET}','${ORG}','${WAREHOUSE}','${ORG}',
      '${tag}-RETURN','draft','receiver'
    );
  `));

  return { returnRequestId, dispatchLineId, cap: receivedQuantity };
};

const addLine = (
  rig: Awaited<ReturnType<typeof buildRig>>,
  scenario: Scenario,
  quantity: number,
  requestId: string | null,
  reasonCode = 'excess',
) => rig.asUser(rig.superAdminId, (c: any) =>
  call(c, 'phoenix_add_outlet_return_request_line', [
    scenario.returnRequestId, scenario.dispatchLineId, quantity, reasonCode, null, requestId,
  ]), { commit: true });

const authenticateSession = async (c: any, actorId: string) => {
  await c.query('BEGIN');
  await c.query('SET LOCAL ROLE authenticated');
  await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [actorId]);
};

const waitForBackendLock = async (
  rig: Awaited<ReturnType<typeof buildRig>>,
  backendPid: number,
  timeoutMs = 5000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await rig.asAdmin((c: any) => c.query(
      `SELECT wait_event_type,wait_event,state FROM pg_stat_activity WHERE pid=$1`,
      [backendPid],
    ));
    if (state.rows[0]?.wait_event_type === 'Lock') return state.rows[0];
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`backend ${backendPid} did not reach a lock wait`);
};

run('156 outlet-return-line idempotency — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 156 });
    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO organizations(id,name,name_ar,code)
      VALUES('${ORG}','156 Return Idem','156 Return Idem','p156-org');
      INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code)
      VALUES('${WAREHOUSE}','${ORG}','Institution','Institution','active','institution','p156-wh');
      INSERT INTO distribution_points(id,warehouse_id,organization_id,name,name_ar,point_type,status)
      VALUES('${OUTLET}','${WAREHOUSE}','${ORG}','Outlet','Outlet','pharmacy','active');
    `));
  }, 120000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('phoenix_add_outlet_return_request_line resolves to exactly one 6-arg overload', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(`
        SELECT pg_get_function_identity_arguments(oid) AS args
        FROM pg_proc WHERE proname = 'phoenix_add_outlet_return_request_line'`);
      expect(r.rows.length).toBe(1);
      // pg_get_function_identity_arguments never includes DEFAULT clauses —
      // name + type only.
      expect(r.rows[0].args).toBe(
        'p_return_request_id uuid, p_original_dispatch_line_id uuid, ' +
        'p_requested_quantity integer, p_reason_code text, ' +
        'p_reason_text text, p_request_id uuid',
      );
    });
  });

  it('omitting p_request_id (NULL) behaves exactly as before 156 — a normal add, no dedup row', async () => {
    const scenario = await seedScenario(rig);
    const result = await addLine(rig, scenario, 4, null);
    expect(result.ok).toBe(true);
    expect(result.return_request_line_id).toBeTruthy();

    await rig.asAdmin(async (c: any) => {
      const lines = await c.query(
        `SELECT count(*)::int n FROM outlet_return_request_lines WHERE return_request_id=$1`,
        [scenario.returnRequestId]);
      expect(lines.rows[0].n).toBe(1);
      const dedup = await c.query(`SELECT count(*)::int n FROM phoenix_outlet_return_line_requests`);
      expect(dedup.rows[0].n).toBe(0);
    });
  });

  it('a same-request-id, same-payload replay returns the identical result and creates no second line or audit row', async () => {
    const scenario = await seedScenario(rig);
    const requestId = randomUUID();

    const first = await addLine(rig, scenario, 5, requestId);
    expect(first.ok).toBe(true);

    const second = await addLine(rig, scenario, 5, requestId);
    expect(second).toEqual(first);

    await rig.asAdmin(async (c: any) => {
      const lines = await c.query(
        `SELECT count(*)::int n FROM outlet_return_request_lines WHERE return_request_id=$1`,
        [scenario.returnRequestId]);
      expect(lines.rows[0].n).toBe(1);
      const audits = await c.query(
        `SELECT count(*)::int n FROM audit_logs WHERE action='outlet_stock.return_line_added' AND entity_id=$1`,
        [first.return_request_line_id]);
      expect(audits.rows[0].n).toBe(1);
      const dedup = await c.query(
        `SELECT count(*)::int n FROM phoenix_outlet_return_line_requests WHERE request_id=$1`,
        [requestId]);
      expect(dedup.rows[0].n).toBe(1);
    });
  });

  it('a same-request-id, different-payload retry raises request_id_conflict (23505), not a silent second mutation', async () => {
    const scenario = await seedScenario(rig);
    const requestId = randomUUID();

    const first = await addLine(rig, scenario, 5, requestId);
    expect(first.ok).toBe(true);

    await expect(addLine(rig, scenario, 6, requestId)).rejects.toMatchObject({
      code: '23505',
    });

    await rig.asAdmin(async (c: any) => {
      const lines = await c.query(
        `SELECT count(*)::int n FROM outlet_return_request_lines WHERE return_request_id=$1`,
        [scenario.returnRequestId]);
      expect(lines.rows[0].n).toBe(1);
    });
  });

  it('two truly concurrent connections submitting the SAME request_id serialize to exactly one line', async () => {
    const scenario = await seedScenario(rig);
    const requestId = randomUUID();
    const a = await rig.pool.connect();
    const b = await rig.pool.connect();
    try {
      await authenticateSession(a, rig.superAdminId);
      await authenticateSession(b, rig.superAdminId);
      const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

      const aPromise = call(a, 'phoenix_add_outlet_return_request_line', [
        scenario.returnRequestId, scenario.dispatchLineId, 3, 'excess', null, requestId,
      ]);

      const bOutcome = call(b, 'phoenix_add_outlet_return_request_line', [
        scenario.returnRequestId, scenario.dispatchLineId, 3, 'excess', null, requestId,
      ]).then(
        (r: any) => ({ ok: true as const, result: r }),
        (error: any) => ({ ok: false as const, error }),
      );

      const waitState = await waitForBackendLock(rig, bPid);
      expect(waitState.wait_event_type).toBe('Lock');

      const aResult = await aPromise;
      await a.query('COMMIT');

      const bFinal = await bOutcome;
      // b was blocked on the advisory lock until a committed, then observed
      // a's dedup row and replayed it — never a second mutation.
      expect(bFinal.ok).toBe(true);
      if (bFinal.ok) expect(bFinal.result).toEqual(aResult);
    } finally {
      await a.query('ROLLBACK').catch(() => {});
      await b.query('ROLLBACK').catch(() => {});
      a.release();
      b.release();
    }

    await rig.asAdmin(async (c: any) => {
      const lines = await c.query(
        `SELECT count(*)::int n FROM outlet_return_request_lines WHERE return_request_id=$1`,
        [scenario.returnRequestId]);
      expect(lines.rows[0].n).toBe(1);
    });
  });

  it("148's unique-index guarantee still stands for a genuinely duplicate NULL-request_id call (no idempotency opt-in)", async () => {
    const scenario = await seedScenario(rig);
    const first = await addLine(rig, scenario, 2, null);
    expect(first.ok).toBe(true);

    // Same return_request_id + same original_dispatch_line_id, no
    // p_request_id: the underlying orrl_request_dispatch_line_uniq index
    // still blocks a true duplicate — 156 never weakens that guarantee for
    // callers who don't opt into the idempotency token.
    await expect(addLine(rig, scenario, 2, null)).rejects.toMatchObject({
      code: '23505',
    });
  });

  it("154's transfer-corridor privilege lockdown and 148's other RPCs are unaffected", async () => {
    await rig.asAdmin(async (c: any) => {
      for (const t of ['warehouse_transfer_requests', 'warehouse_transfer_request_lines', 'warehouse_transfers', 'warehouse_transfer_lines']) {
        const r = await c.query(`SELECT has_table_privilege('authenticated', 'public.' || $1, 'TRUNCATE') AS has`, [t]);
        expect(r.rows[0].has).toBe(false);
      }
      const r = await c.query(
        `SELECT prosecdef FROM pg_proc WHERE proname = 'phoenix_add_outlet_return_request_line'`);
      expect(r.rows[0].prosecdef).toBe(true);
    });
  });
});
