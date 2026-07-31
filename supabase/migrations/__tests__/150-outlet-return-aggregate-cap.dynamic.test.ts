import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000153001';
const WAREHOUSE = '00000000-0000-0000-0000-000000153101';
const OUTLET = '00000000-0000-0000-0000-000000153201';
const WAREHOUSE_STOCK = '00000000-0000-0000-0000-000000153301';
const OUTLET_STOCK = '00000000-0000-0000-0000-000000153302';
const DISPATCH = '00000000-0000-0000-0000-000000153401';
const DISPATCH_LINE = '00000000-0000-0000-0000-000000153402';
const INBOUND_MOVEMENT = '00000000-0000-0000-0000-000000153403';
const REQUEST_A = '00000000-0000-0000-0000-000000153501';
const REQUEST_B = '00000000-0000-0000-0000-000000153502';
const LINE_A = '00000000-0000-0000-0000-000000153601';
const LINE_B = '00000000-0000-0000-0000-000000153602';
let sequence = 0;

const call = (c: any, fn: string, args: any[]) =>
  c.query(
    `SELECT public.${fn}(${args.map((_, index) => `$${index + 1}`).join(',')}) AS r`,
    args,
  ).then((result: any) => result.rows[0].r);

const seedAggregateScenario = async (
  rig: Awaited<ReturnType<typeof buildRig>>,
) => {
  await rig.asAdmin((c: any) => c.query(`
    INSERT INTO organizations(id,name,name_ar,code)
    VALUES('${ORG}','Aggregate Return','Aggregate Return','p150-aggregate-return');

    INSERT INTO warehouses(
      id,organization_id,name,name_ar,status,warehouse_kind,code
    ) VALUES(
      '${WAREHOUSE}','${ORG}','Institution','Institution',
      'active','institution','p150-aggregate-wh'
    );

    INSERT INTO distribution_points(
      id,warehouse_id,organization_id,name,name_ar,point_type,status
    ) VALUES(
      '${OUTLET}','${WAREHOUSE}','${ORG}','Outlet','Outlet','pharmacy','active'
    );

    INSERT INTO warehouse_stock(
      id,organization_id,warehouse_id,scientific_name,concentration,
      dosage_form,unit,national_code,has_no_national_code,
      batch_number,has_no_batch_number,expiry_date,
      on_hand_quantity,reserved_quantity,movement_seq
    ) VALUES(
      '${WAREHOUSE_STOCK}','${ORG}','${WAREHOUSE}','Aggregate Drug','10 mg',
      'tablet','box','NDC-AGG',false,'AGG-1',false,current_date+365,100,0,1
    );

    INSERT INTO outlet_stock(
      id,organization_id,distribution_point_id,point_type,
      scientific_name,concentration,dosage_form,unit,
      national_code,has_no_national_code,batch_number,has_no_batch_number,
      expiry_date,on_hand_quantity,reserved_quantity,movement_seq
    ) VALUES(
      '${OUTLET_STOCK}','${ORG}','${OUTLET}','pharmacy',
      'Aggregate Drug','10 mg','tablet','box',
      'NDC-AGG',false,'AGG-1',false,current_date+365,20,0,1
    );

    INSERT INTO warehouse_dispatches(
      id,organization_id,warehouse_id,destination_distribution_point_id,
      dispatch_number,status,sent_by,sent_at
    ) VALUES(
      '${DISPATCH}','${ORG}','${WAREHOUSE}','${OUTLET}',
      'P150-AGG-DISPATCH','sent','${rig.superAdminId}',now()
    );

    INSERT INTO warehouse_dispatch_lines(
      id,organization_id,dispatch_id,warehouse_stock_id,
      scientific_name,concentration,dosage_form,unit,
      national_code,has_no_national_code,batch_number,has_no_batch_number,
      expiry_date,sent_quantity,status,received_quantity,
      accepted_by,accepted_at,resulting_outlet_stock_id
    ) VALUES(
      '${DISPATCH_LINE}','${ORG}','${DISPATCH}','${WAREHOUSE_STOCK}',
      'Aggregate Drug','10 mg','tablet','box',
      'NDC-AGG',false,'AGG-1',false,current_date+365,
      10,'accepted',10,'${rig.superAdminId}',now(),'${OUTLET_STOCK}'
    );

    INSERT INTO outlet_stock_movements(
      id,outlet_stock_id,organization_id,distribution_point_id,movement_type,
      on_hand_before,on_hand_delta,on_hand_after,
      reserved_before,reserved_delta,reserved_after,
      dispatch_line_id,scientific_name_snapshot,reason_code
    ) VALUES(
      '${INBOUND_MOVEMENT}','${OUTLET_STOCK}','${ORG}','${OUTLET}',
      'dispatch_receive',0,10,10,0,0,0,
      '${DISPATCH_LINE}','Aggregate Drug','received'
    );

    INSERT INTO outlet_return_requests(
      id,distribution_point_id,source_organization_id,
      destination_warehouse_id,destination_organization_id,
      return_number,status,requested_by_side,requested_by,requested_at
    ) VALUES
      ('${REQUEST_A}','${OUTLET}','${ORG}','${WAREHOUSE}','${ORG}',
       'P150-AGG-RETURN-A','submitted','receiver','${rig.superAdminId}',now()),
      ('${REQUEST_B}','${OUTLET}','${ORG}','${WAREHOUSE}','${ORG}',
       'P150-AGG-RETURN-B','submitted','receiver','${rig.superAdminId}',now());

    INSERT INTO outlet_return_request_lines(
      id,return_request_id,source_organization_id,
      original_dispatch_line_id,original_inbound_movement_id,
      source_outlet_stock_id,scientific_name,concentration,dosage_form,unit,
      national_code,batch_number,expiry_date,reason_code,requested_quantity
    ) VALUES
      ('${LINE_A}','${REQUEST_A}','${ORG}','${DISPATCH_LINE}',
       '${INBOUND_MOVEMENT}','${OUTLET_STOCK}','Aggregate Drug','10 mg',
       'tablet','box','NDC-AGG','AGG-1',current_date+365,'excess',6),
      ('${LINE_B}','${REQUEST_B}','${ORG}','${DISPATCH_LINE}',
       '${INBOUND_MOVEMENT}','${OUTLET_STOCK}','Aggregate Drug','10 mg',
       'tablet','box','NDC-AGG','AGG-1',current_date+365,'excess',6);
  `));
};

type IsolatedScenario = {
  dispatchLineId: string;
  inboundMovementId: string;
  outletStockId: string;
  requestIds: string[];
  lineIds: string[];
};

const seedIsolatedScenario = async (
  rig: Awaited<ReturnType<typeof buildRig>>,
  requestedQuantities: number[],
  receivedQuantity = 10,
): Promise<IsolatedScenario> => {
  const tag = `P150-AGG-${Date.now()}-${sequence++}`;
  const warehouseStockId = randomUUID();
  const outletStockId = randomUUID();
  const dispatchId = randomUUID();
  const dispatchLineId = randomUUID();
  const inboundMovementId = randomUUID();
  const requestIds = requestedQuantities.map(() => randomUUID());
  const lineIds = requestedQuantities.map(() => randomUUID());

  await rig.asAdmin(async (c: any) => {
    await c.query(`
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
    `);

    for (let index = 0; index < requestedQuantities.length; index += 1) {
      await c.query(`
        INSERT INTO outlet_return_requests(
          id,distribution_point_id,source_organization_id,
          destination_warehouse_id,destination_organization_id,
          return_number,status,requested_by_side,requested_by,requested_at
        ) VALUES(
          '${requestIds[index]}','${OUTLET}','${ORG}','${WAREHOUSE}','${ORG}',
          '${tag}-RETURN-${index}','submitted','receiver',
          '${rig.superAdminId}',now()
        );

        INSERT INTO outlet_return_request_lines(
          id,return_request_id,source_organization_id,
          original_dispatch_line_id,original_inbound_movement_id,
          source_outlet_stock_id,scientific_name,concentration,dosage_form,unit,
          national_code,batch_number,expiry_date,reason_code,requested_quantity
        ) VALUES(
          '${lineIds[index]}','${requestIds[index]}','${ORG}',
          '${dispatchLineId}','${inboundMovementId}','${outletStockId}',
          '${tag}','10 mg','tablet','box',NULL,'${tag}',current_date+365,
          'excess',${requestedQuantities[index]}
        );
      `);
    }
  });

  return {
    dispatchLineId,
    inboundMovementId,
    outletStockId,
    requestIds,
    lineIds,
  };
};

const review = (
  rig: Awaited<ReturnType<typeof buildRig>>,
  requestId: string,
  decisions: Array<{ line_id: string; approved_quantity: number }>,
) => rig.asUser(rig.superAdminId, (c: any) =>
  call(c, 'phoenix_review_outlet_return_request', [
    requestId,
    JSON.stringify(decisions),
  ]), { commit: true });

const send = (
  rig: Awaited<ReturnType<typeof buildRig>>,
  lineId: string,
  quantity: number,
) => rig.asUser(rig.superAdminId, (c: any) =>
  call(c, 'phoenix_send_outlet_return_shipment_line', [
    randomUUID(), lineId, null, quantity,
    `P150-AGG-SHIP-${Date.now()}-${sequence++}`, null, null,
  ]), { commit: true });

const authenticateSession = async (c: any, actorId: string) => {
  await c.query('BEGIN');
  await c.query('SET LOCAL ROLE authenticated');
  await c.query(
    `SELECT set_config('request.jwt.claim.sub',$1,true)`,
    [actorId],
  );
};

const waitForBackendLock = async (
  rig: Awaited<ReturnType<typeof buildRig>>,
  backendPid: number,
  timeoutMs = 5000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await rig.asAdmin((c: any) => c.query(`
      SELECT wait_event_type,wait_event,state
      FROM pg_stat_activity
      WHERE pid=$1
    `, [backendPid]));
    if (state.rows[0]?.wait_event_type === 'Lock') return state.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`backend ${backendPid} did not reach a lock wait`);
};

const insertSuggestionCommitment = async (
  rig: Awaited<ReturnType<typeof buildRig>>,
  scenario: IsolatedScenario,
  mode: 'open' | 'linked' | 'legacy_unresolved',
  quantity: number,
  linkedLineIndex = 0,
) => {
  const suggestionId = randomUUID();
  await rig.asAdmin(async (c: any) => {
    const stock = await c.query(`
      SELECT scientific_name,concentration,dosage_form,unit,
             material_identity_key
      FROM outlet_stock WHERE id=$1
    `, [scenario.outletStockId]);
    const material = stock.rows[0];
    const accepted = mode !== 'open';
    const linked = mode === 'linked';

    await c.query(
      'ALTER TABLE inventory_transfer_suggestions DISABLE TRIGGER inventory_suggestion_guard',
    );
    try {
      await c.query(`
        INSERT INTO inventory_transfer_suggestions(
          id,source_organization_id,target_organization_id,
          scientific_name,concentration,dosage_form,unit,national_code,
          source_scope_kind,source_scope_id,target_scope_kind,target_scope_id,
          route_kind,source_stock_id,suggested_quantity,suggestion_key,status,
          last_validated_at,accepted_at,accepted_by,draft_document_number,
          draft_outlet_return_request_id,provenance_dispatch_line_id,
          provenance_inbound_movement_id,draft_outlet_return_request_line_id,
          lineage_version,lineage_state,
          material_identity_version,material_identity_key,material_identity_state
        ) VALUES(
          $1,$2,$2,$3,$4,$5,$6,NULL,
          'outlet',$7,'warehouse',$8,
          'outlet_to_warehouse',$9,$10,$11,$12,
          now(),$13,$14,$15,$16,$17,$18,$19,$20,$21,
          1,$22,'resolved'
        )
      `, [
        suggestionId,
        ORG,
        material.scientific_name,
        material.concentration,
        material.dosage_form,
        material.unit,
        OUTLET,
        WAREHOUSE,
        scenario.outletStockId,
        quantity,
        `aggregate-${mode}-${Date.now()}-${sequence++}`,
        accepted ? 'accepted' : 'open',
        accepted ? new Date() : null,
        accepted ? rig.superAdminId : null,
        accepted ? `P150-${mode}-${sequence}` : null,
        accepted ? scenario.requestIds[linkedLineIndex] : null,
        scenario.dispatchLineId,
        scenario.inboundMovementId,
        linked ? scenario.lineIds[linkedLineIndex] : null,
        linked ? 1 : 0,
        linked ? 'linked' : 'legacy_unresolved',
        material.material_identity_key,
      ]);
    } finally {
      await c.query(
        'ALTER TABLE inventory_transfer_suggestions ENABLE TRIGGER inventory_suggestion_guard',
      );
    }
  });
  return suggestionId;
};

run('150 aggregate outlet-return cap — pre-fix reproduction', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 149 });
    await seedAggregateScenario(rig);
  }, 120000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  it('currently approves two individually-valid requests and fails only at physical send', async () => {
    for (const [requestId, lineId] of [
      [REQUEST_A, LINE_A],
      [REQUEST_B, LINE_B],
    ]) {
      await rig.asUser(rig.superAdminId, (c: any) =>
        call(c, 'phoenix_review_outlet_return_request', [
          requestId,
          JSON.stringify([{ line_id: lineId, approved_quantity: 6 }]),
        ]), { commit: true });
    }

    const approved = await rig.asAdmin((c: any) => c.query(`
      SELECT id::text,status,approved_quantity
      FROM outlet_return_request_lines
      WHERE id IN ('${LINE_A}','${LINE_B}')
      ORDER BY id
    `));
    expect(approved.rows).toEqual([
      { id: LINE_A, status: 'approved', approved_quantity: 6 },
      { id: LINE_B, status: 'approved', approved_quantity: 6 },
    ]);

    await rig.asUser(rig.superAdminId, (c: any) =>
      call(c, 'phoenix_send_outlet_return_shipment_line', [
        randomUUID(), LINE_A, null, 6, 'P150-AGG-SHIP-A', null, null,
      ]), { commit: true });

    await expect(rig.asUser(rig.superAdminId, (c: any) =>
      call(c, 'phoenix_send_outlet_return_shipment_line', [
        randomUUID(), LINE_B, null, 6, 'P150-AGG-SHIP-B', null, null,
      ]), { commit: true })).rejects.toMatchObject({ code: '23514' });
  });
});

run('150 aggregate outlet-return cap — live contract', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 150 });
    await seedAggregateScenario(rig);
  }, 120000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  it('rejects the second sequential approval atomically at review time', async () => {
    await rig.asUser(rig.superAdminId, (c: any) =>
      call(c, 'phoenix_review_outlet_return_request', [
        REQUEST_A,
        JSON.stringify([{ line_id: LINE_A, approved_quantity: 6 }]),
      ]), { commit: true });

    const before = await rig.asAdmin((c: any) => c.query(`
      SELECT
        (SELECT count(*)::int FROM outlet_stock_movements) AS movements,
        (SELECT count(*)::int FROM audit_logs
          WHERE entity_id='${REQUEST_B}'
            AND action='outlet_stock.return_reviewed') AS success_audits
    `));

    await expect(rig.asUser(rig.superAdminId, (c: any) =>
      call(c, 'phoenix_review_outlet_return_request', [
        REQUEST_B,
        JSON.stringify([{ line_id: LINE_B, approved_quantity: 6 }]),
      ]), { commit: true })).rejects.toMatchObject({
      code: '23514',
      message: 'outlet_return_aggregate_cap_exceeded',
    });

    const after = await rig.asAdmin((c: any) => c.query(`
      SELECT
        (SELECT status FROM outlet_return_requests
          WHERE id='${REQUEST_B}') AS request_status,
        (SELECT status FROM outlet_return_request_lines
          WHERE id='${LINE_B}') AS line_status,
        (SELECT approved_quantity FROM outlet_return_request_lines
          WHERE id='${LINE_B}') AS approved_quantity,
        (SELECT count(*)::int FROM outlet_stock_movements) AS movements,
        (SELECT count(*)::int FROM audit_logs
          WHERE entity_id='${REQUEST_B}'
            AND action='outlet_stock.return_reviewed') AS success_audits
    `));
    expect(after.rows[0]).toEqual({
      request_status: 'submitted',
      line_status: 'pending',
      approved_quantity: null,
      movements: before.rows[0].movements,
      success_audits: before.rows[0].success_audits,
    });
  });

  it('serializes concurrent reviews on one provenance without deadlock or write skew', async () => {
    const scenario = await seedIsolatedScenario(rig, [6, 6]);
    const a = await rig.pool.connect();
    const b = await rig.pool.connect();
    try {
      await authenticateSession(a, rig.superAdminId);
      await authenticateSession(b, rig.superAdminId);
      const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

      await call(a, 'phoenix_review_outlet_return_request', [
        scenario.requestIds[0],
        JSON.stringify([{
          line_id: scenario.lineIds[0],
          approved_quantity: 6,
        }]),
      ]);

      const bOutcome = call(b, 'phoenix_review_outlet_return_request', [
        scenario.requestIds[1],
        JSON.stringify([{
          line_id: scenario.lineIds[1],
          approved_quantity: 6,
        }]),
      ]).then(
        () => ({ ok: true as const, error: null }),
        (error: any) => ({ ok: false as const, error }),
      );

      const waitState = await waitForBackendLock(rig, bPid);
      expect(waitState.wait_event_type).toBe('Lock');
      await a.query('COMMIT');

      const outcome = await bOutcome;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatchObject({
        code: '23514',
        message: 'outlet_return_aggregate_cap_exceeded',
      });
      await b.query('ROLLBACK');
    } finally {
      await a.query('ROLLBACK').catch(() => {});
      await b.query('ROLLBACK').catch(() => {});
      a.release();
      b.release();
    }

    const state = await rig.asAdmin((c: any) => c.query(`
      SELECT status,approved_quantity
      FROM outlet_return_request_lines
      WHERE id=ANY($1::uuid[])
      ORDER BY id
    `, [scenario.lineIds]));
    expect(state.rows.filter((row: any) => row.status === 'approved')).toHaveLength(1);
    expect(state.rows.filter((row: any) => row.status === 'pending')).toHaveLength(1);
  });

  it('accepts the exact remainder and rejects one additional unit', async () => {
    const scenario = await seedIsolatedScenario(rig, [10, 6, 1]);
    await review(rig, scenario.requestIds[0], [{
      line_id: scenario.lineIds[0],
      approved_quantity: 4,
    }]);
    await review(rig, scenario.requestIds[1], [{
      line_id: scenario.lineIds[1],
      approved_quantity: 6,
    }]);
    await expect(review(rig, scenario.requestIds[2], [{
      line_id: scenario.lineIds[2],
      approved_quantity: 1,
    }])).rejects.toMatchObject({
      code: '23514',
      message: 'outlet_return_aggregate_cap_exceeded',
    });

    const approved = await rig.asAdmin((c: any) => c.query(`
      SELECT sum(approved_quantity-fulfilled_quantity)::int AS remainder
      FROM outlet_return_request_lines
      WHERE original_dispatch_line_id=$1 AND status='approved'
    `, [scenario.dispatchLineId]));
    expect(approved.rows[0].remainder).toBe(10);
  });

  it('moves a partial send from approved remainder to returned quantity exactly once', async () => {
    const scenario = await seedIsolatedScenario(rig, [8, 2, 3]);
    await review(rig, scenario.requestIds[0], [{
      line_id: scenario.lineIds[0],
      approved_quantity: 8,
    }]);
    const sent = await send(rig, scenario.lineIds[0], 3);

    await review(rig, scenario.requestIds[1], [{
      line_id: scenario.lineIds[1],
      approved_quantity: 2,
    }]);
    await expect(review(rig, scenario.requestIds[2], [{
      line_id: scenario.lineIds[2],
      approved_quantity: 3,
    }])).rejects.toMatchObject({
      code: '23514',
      message: 'outlet_return_aggregate_cap_exceeded',
    });

    const state = await rig.asAdmin((c: any) => c.query(`
      SELECT
        d.returned_quantity,
        l.fulfilled_quantity,
        l.approved_quantity-l.fulfilled_quantity AS approved_remainder,
        l.status,
        sl.original_dispatch_line_id::text,
        sl.original_inbound_movement_id::text,
        sl.custody_state,
        m.on_hand_delta
      FROM warehouse_dispatch_lines d
      JOIN outlet_return_request_lines l ON l.id=$2
      JOIN outlet_return_shipment_lines sl ON sl.id=$3
      JOIN outlet_stock_movements m ON m.id=$4
      WHERE d.id=$1
    `, [
      scenario.dispatchLineId,
      scenario.lineIds[0],
      sent.shipment_line_id,
      sent.movement_id,
    ]));
    expect(state.rows[0]).toEqual({
      returned_quantity: 3,
      fulfilled_quantity: 3,
      approved_remainder: 5,
      status: 'partially_fulfilled',
      original_dispatch_line_id: scenario.dispatchLineId,
      original_inbound_movement_id: scenario.inboundMovementId,
      custody_state: 'in_transit',
      on_hand_delta: -3,
    });
  });

  it('releases rejected and cancelled commitments while fulfilled stays physical', async () => {
    const rejected = await seedIsolatedScenario(rig, [10, 10]);
    await review(rig, rejected.requestIds[0], [{
      line_id: rejected.lineIds[0],
      approved_quantity: 0,
    }]);
    await review(rig, rejected.requestIds[1], [{
      line_id: rejected.lineIds[1],
      approved_quantity: 10,
    }]);

    const cancelled = await seedIsolatedScenario(rig, [6, 10]);
    const cancelledSuggestion = await insertSuggestionCommitment(
      rig, cancelled, 'linked', 6,
    );
    const beforeCancel = await rig.asAdmin((c: any) => c.query(`
      SELECT provenance_commitment,is_active
      FROM phoenix_inventory_suggestion_commitments($1)
    `, [cancelledSuggestion]));
    expect(beforeCancel.rows[0]).toEqual({
      provenance_commitment: 6,
      is_active: true,
    });
    await rig.asUser(rig.superAdminId, (c: any) =>
      call(c, 'phoenix_cancel_outlet_return_request', [
        cancelled.requestIds[0], 'aggregate-cap-release',
      ]), { commit: true });
    const afterCancel = await rig.asAdmin((c: any) => c.query(`
      SELECT provenance_commitment,is_active
      FROM phoenix_inventory_suggestion_commitments($1)
    `, [cancelledSuggestion]));
    expect(afterCancel.rows[0]).toEqual({
      provenance_commitment: 0,
      is_active: false,
    });
    await review(rig, cancelled.requestIds[1], [{
      line_id: cancelled.lineIds[1],
      approved_quantity: 10,
    }]);

    const fulfilled = await seedIsolatedScenario(rig, [10, 1]);
    await review(rig, fulfilled.requestIds[0], [{
      line_id: fulfilled.lineIds[0],
      approved_quantity: 10,
    }]);
    await send(rig, fulfilled.lineIds[0], 10);
    await expect(review(rig, fulfilled.requestIds[1], [{
      line_id: fulfilled.lineIds[1],
      approved_quantity: 1,
    }])).rejects.toMatchObject({
      code: '23514',
      message: 'outlet_return_aggregate_cap_exceeded',
    });

    const states = await rig.asAdmin((c: any) => c.query(`
      SELECT id::text,status,approved_quantity,fulfilled_quantity
      FROM outlet_return_request_lines
      WHERE id=ANY($1::uuid[])
      ORDER BY id
    `, [[
      rejected.lineIds[0],
      cancelled.lineIds[0],
      fulfilled.lineIds[0],
    ]]));
    expect(states.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: rejected.lineIds[0],
        status: 'rejected',
        approved_quantity: 0,
        fulfilled_quantity: 0,
      }),
      expect.objectContaining({
        id: cancelled.lineIds[0],
        status: 'cancelled',
        fulfilled_quantity: 0,
      }),
      expect.objectContaining({
        id: fulfilled.lineIds[0],
        status: 'fulfilled',
        approved_quantity: 10,
        fulfilled_quantity: 10,
      }),
    ]));
  });

  it('closes a linked commitment when its editable draft line is deleted', async () => {
    const scenario = await seedIsolatedScenario(rig, [6, 10]);
    await rig.asAdmin((c: any) => c.query(`
      UPDATE outlet_return_requests
      SET status='draft',requested_at=NULL
      WHERE id=$1
    `, [scenario.requestIds[0]]));
    const suggestionId = await insertSuggestionCommitment(
      rig, scenario, 'linked', 6,
    );

    await rig.asUser(rig.superAdminId, (c: any) =>
      call(c, 'phoenix_delete_outlet_return_request_line', [
        scenario.lineIds[0],
      ]), { commit: true });

    const closed = await rig.asAdmin((c: any) => c.query(`
      SELECT provenance_commitment,is_active,commitment_state
      FROM phoenix_inventory_suggestion_commitments($1)
    `, [suggestionId]));
    expect(closed.rows[0]).toEqual({
      provenance_commitment: 0,
      is_active: false,
      commitment_state: 'line_deleted',
    });

    await review(rig, scenario.requestIds[1], [{
      line_id: scenario.lineIds[1],
      approved_quantity: 10,
    }]);
  });

  it('deduplicates linked suggestions and retains open and legacy commitments', async () => {
    const linked = await seedIsolatedScenario(rig, [6, 4]);
    const linkedSuggestion = await insertSuggestionCommitment(
      rig, linked, 'linked', 6,
    );
    await review(rig, linked.requestIds[0], [{
      line_id: linked.lineIds[0],
      approved_quantity: 6,
    }]);
    await review(rig, linked.requestIds[1], [{
      line_id: linked.lineIds[1],
      approved_quantity: 4,
    }]);

    const linkedCommitment = await rig.asAdmin((c: any) => c.query(`
      SELECT provenance_commitment,is_active
      FROM phoenix_inventory_suggestion_commitments($1)
    `, [linkedSuggestion]));
    expect(linkedCommitment.rows[0]).toEqual({
      provenance_commitment: 6,
      is_active: true,
    });

    for (const mode of ['open', 'legacy_unresolved'] as const) {
      const scenario = await seedIsolatedScenario(rig, [5]);
      const suggestionId = await insertSuggestionCommitment(
        rig, scenario, mode, 6,
      );
      const commitment = await rig.asAdmin((c: any) => c.query(`
        SELECT provenance_commitment,is_active,commitment_state
        FROM phoenix_inventory_suggestion_commitments($1)
      `, [suggestionId]));
      expect(commitment.rows[0]).toEqual(expect.objectContaining({
        provenance_commitment: 6,
        is_active: true,
      }));
      await expect(review(rig, scenario.requestIds[0], [{
        line_id: scenario.lineIds[0],
        approved_quantity: 5,
      }])).rejects.toMatchObject({
        code: '23514',
        message: 'outlet_return_aggregate_cap_exceeded',
      });
    }

    const manual = await seedIsolatedScenario(rig, [10, 10]);
    await review(rig, manual.requestIds[1], [{
      line_id: manual.lineIds[1],
      approved_quantity: 10,
    }]);
    const pending = await rig.asAdmin((c: any) => c.query(`
      SELECT status,approved_quantity
      FROM outlet_return_request_lines WHERE id=$1
    `, [manual.lineIds[0]]));
    expect(pending.rows[0]).toEqual({
      status: 'pending',
      approved_quantity: null,
    });
  });

  it('validates every provenance before atomically applying multi-line decisions', async () => {
    const valid = await seedIsolatedScenario(rig, [2]);
    const capped = await seedIsolatedScenario(rig, [3, 8]);
    await review(rig, capped.requestIds[1], [{
      line_id: capped.lineIds[1],
      approved_quantity: 8,
    }]);

    await rig.asAdmin((c: any) => c.query(`
      UPDATE outlet_return_request_lines
      SET return_request_id=$1
      WHERE id=$2
    `, [valid.requestIds[0], capped.lineIds[0]]));

    await expect(review(rig, valid.requestIds[0], [
      { line_id: valid.lineIds[0], approved_quantity: 2 },
      { line_id: capped.lineIds[0], approved_quantity: 3 },
    ])).rejects.toMatchObject({
      code: '23514',
      message: 'outlet_return_aggregate_cap_exceeded',
    });

    const state = await rig.asAdmin((c: any) => c.query(`
      SELECT
        (SELECT status FROM outlet_return_requests WHERE id=$1) AS request_status,
        (SELECT count(*)::int FROM outlet_return_request_lines
          WHERE id=ANY($2::uuid[]) AND status='pending'
            AND approved_quantity IS NULL) AS untouched_lines,
        (SELECT count(*)::int FROM audit_logs
          WHERE entity_id=$1 AND action='outlet_stock.return_reviewed') AS success_audits
    `, [valid.requestIds[0], [valid.lineIds[0], capped.lineIds[0]]]));
    expect(state.rows[0]).toEqual({
      request_status: 'submitted',
      untouched_lines: 2,
      success_audits: 0,
    });
  });

  it('preserves the public signature, RBAC, reports and internal helper boundary', async () => {
    const contract = await rig.asAdmin((c: any) => c.query(`
      SELECT
        to_regprocedure(
          'public.phoenix_review_outlet_return_request(uuid,jsonb)'
        ) IS NOT NULL AS signature_exists,
        has_function_privilege(
          'authenticated',
          'public.phoenix_review_outlet_return_request(uuid,jsonb)',
          'EXECUTE'
        ) AS authenticated_execute,
        has_function_privilege(
          'anon',
          'public.phoenix_review_outlet_return_request(uuid,jsonb)',
          'EXECUTE'
        ) AS anon_execute,
        has_function_privilege(
          'authenticated',
          'public._phoenix_validate_outlet_return_review_cap_v1(uuid,jsonb)',
          'EXECUTE'
        ) AS helper_authenticated,
        has_function_privilege(
          'anon',
          'public._phoenix_validate_outlet_return_review_cap_v1(uuid,jsonb)',
          'EXECUTE'
        ) AS helper_anon,
        pg_get_functiondef(
          'public.phoenix_movement_timeline(uuid,integer,timestamptz,uuid)'::regprocedure
        ) AS timeline_def,
        pg_get_functiondef(
          'public.phoenix_movement_ledger_report(uuid,timestamptz,timestamptz,text,text,uuid,text,text,integer,integer)'::regprocedure
        ) AS ledger_def
    `));
    const row = contract.rows[0];
    expect({
      signature_exists: row.signature_exists,
      authenticated_execute: row.authenticated_execute,
      anon_execute: row.anon_execute,
      helper_authenticated: row.helper_authenticated,
      helper_anon: row.helper_anon,
    }).toEqual({
      signature_exists: true,
      authenticated_execute: true,
      anon_execute: false,
      helper_authenticated: false,
      helper_anon: false,
    });
    for (const definition of [row.timeline_def, row.ledger_def]) {
      expect(definition).not.toContain('inventory_transfer_suggestions');
      expect(definition).not.toContain(
        'phoenix_inventory_suggestion_commitments',
      );
    }
  });
});
