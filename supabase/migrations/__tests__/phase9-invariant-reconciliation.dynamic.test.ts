import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

// PRE-EXISTING INFRASTRUCTURE FIX (surfaced by the R1.2C run, not caused by it).
// This suite REPLAYS THE MIGRATION CHAIN inside a beforeAll. vitest applies a
// separate 10s budget to HOOKS, which no testTimeout covers, so as the chain has
// grown the hook has crept toward that ceiling; past it, the hook is killed
// mid-replay and surfaces as ECONNRESET rather than as any assertion. An explicit
// hook budget removes that false signal. No assertion is changed or relaxed.
vi.setConfig({ hookTimeout: 240000 });

const run = rigAvailable() ? describe : describe.skip;
const reconciliationSql = readFileSync(
  join(__dirname, '../../../tools/pg-rig/phase9-reconciliation.sql'),
  'utf8',
);

const ORG = '00000000-0000-0000-0000-000000159001';
const ORG_OTHER = '00000000-0000-0000-0000-000000159002';
const CENTRAL = '00000000-0000-0000-0000-000000159101';
const INSTITUTION = '00000000-0000-0000-0000-000000159102';
const WRONG_WAREHOUSE = '00000000-0000-0000-0000-000000159103';
const FOREIGN_WAREHOUSE = '00000000-0000-0000-0000-000000159104';
const OUTLET = '00000000-0000-0000-0000-000000159201';
const WRONG_OUTLET = '00000000-0000-0000-0000-000000159202';
const ROUTE = '00000000-0000-0000-0000-000000159301';

const CWM = '00000000-0000-0000-0000-000000159401';
const WO = '00000000-0000-0000-0000-000000159402';
const OO = '00000000-0000-0000-0000-000000159403';
const WO_WRONG = '00000000-0000-0000-0000-000000159404';
const OO_WRONG = '00000000-0000-0000-0000-000000159405';
const FOREIGN = '00000000-0000-0000-0000-000000159406';
const SUSPENDED = '00000000-0000-0000-0000-000000159407';

run('Phase 9 movement/custody invariants and reconciliation', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let centralStockId = '';
  let institutionStockId = '';
  let transferRequestId = '';
  let transferLineId = '';
  let dispatchLineId = '';
  let outletStockId = '';
  let returnShipmentLineId = '';

  const call = (c: any, functionName: string, args: unknown[]) =>
    c.query(
      `SELECT public.${functionName}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS r`,
      args,
    ).then((result: any) => result.rows[0].r);

  const ledgerCount = () => rig.asAdmin(async (c: any) => {
    const result = await c.query(`
      SELECT (
        (SELECT count(*) FROM warehouse_stock_movements WHERE organization_id=$1)
        + (SELECT count(*) FROM outlet_stock_movements WHERE organization_id=$1)
        + (SELECT count(*) FROM warehouse_quarantine_stock_movements WHERE organization_id=$1)
      )::integer AS count
    `, [ORG]);
    return result.rows[0].count as number;
  });

  beforeAll(async () => {
    rig = await buildRig({ upTo: 152 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO organizations(id,name,name_ar,code) VALUES
          ('${ORG}','Phase 9','Phase 9','p159-main'),
          ('${ORG_OTHER}','Phase 9 Other','Phase 9 Other','p159-other');

        INSERT INTO warehouses(
          id,organization_id,name,name_ar,status,warehouse_kind,code
        ) VALUES
          ('${CENTRAL}','${ORG}','Central','Central','active','central','p159-central'),
          ('${INSTITUTION}','${ORG}','Institution','Institution','active','institution','p159-inst'),
          ('${WRONG_WAREHOUSE}','${ORG}','Wrong warehouse','Wrong warehouse','active','institution','p159-wrong'),
          ('${FOREIGN_WAREHOUSE}','${ORG_OTHER}','Foreign warehouse','Foreign warehouse','active','institution','p159-foreign');

        INSERT INTO distribution_points(
          id,warehouse_id,organization_id,name,name_ar,point_type,status
        ) VALUES
          ('${OUTLET}','${INSTITUTION}','${ORG}','Outlet','Outlet','pharmacy','active'),
          ('${WRONG_OUTLET}','${WRONG_WAREHOUSE}','${ORG}','Wrong outlet','Wrong outlet','pharmacy','active');

        INSERT INTO warehouse_supply_routes(
          id,source_warehouse_id,target_warehouse_id,
          source_warehouse_kind,target_warehouse_kind,is_active
        ) VALUES(
          '${ROUTE}','${CENTRAL}','${INSTITUTION}','central','institution',true
        );

        INSERT INTO auth.users(id,email) VALUES
          ('${CWM}','p159-cwm@rig.local'),
          ('${WO}','p159-wo@rig.local'),
          ('${OO}','p159-oo@rig.local'),
          ('${WO_WRONG}','p159-wo-wrong@rig.local'),
          ('${OO_WRONG}','p159-oo-wrong@rig.local'),
          ('${FOREIGN}','p159-foreign@rig.local'),
          ('${SUSPENDED}','p159-suspended@rig.local');

        UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}'
         WHERE id='${CWM}';
        UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}'
         WHERE id IN ('${WO}','${WO_WRONG}');
        UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG}'
         WHERE id IN ('${OO}','${OO_WRONG}');
        UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG_OTHER}'
         WHERE id='${FOREIGN}';
        UPDATE profiles SET role='warehouse_officer',status='suspended',organization_id='${ORG}'
         WHERE id='${SUSPENDED}';

        INSERT INTO profile_scope_assignments(
          profile_id,organization_id,scope_type,warehouse_id,is_active
        ) VALUES
          ('${CWM}','${ORG}','warehouse','${CENTRAL}',true),
          ('${WO}','${ORG}','warehouse','${INSTITUTION}',true),
          ('${WO_WRONG}','${ORG}','warehouse','${WRONG_WAREHOUSE}',true),
          ('${FOREIGN}','${ORG_OTHER}','warehouse','${FOREIGN_WAREHOUSE}',true),
          ('${SUSPENDED}','${ORG}','warehouse','${INSTITUTION}',true);

        INSERT INTO profile_scope_assignments(
          profile_id,organization_id,scope_type,distribution_point_id,is_active
        ) VALUES
          ('${OO}','${ORG}','distribution_point','${OUTLET}',true),
          ('${OO_WRONG}','${ORG}','distribution_point','${WRONG_OUTLET}',true);

        INSERT INTO profile_permission_overrides(
          profile_id,permission_key,allowed
        ) VALUES
          ('${CWM}','status_center.view',true),
          ('${WO}','status_center.view',true),
          ('${OO}','status_center.view',true),
          ('${WO_WRONG}','status_center.view',true),
          ('${OO_WRONG}','status_center.view',true),
          ('${FOREIGN}','status_center.view',true),
          ('${SUSPENDED}','status_center.view',true)
        ON CONFLICT(profile_id,permission_key)
        DO UPDATE SET allowed=excluded.allowed;
      `);
    });
  }, 120_000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  it('keeps read-model, Draft, submit and review stages movement-free', async () => {
    const before = await ledgerCount();
    await rig.asUser(WO, async (c: any) => {
      const actions = await c.query(
        `SELECT * FROM public.phoenix_get_inventory_suggestion_actions($1::uuid[])`,
        [[]],
      );
      expect(actions.rows).toEqual([]);
      const request = await call(c, 'phoenix_create_warehouse_transfer_request', [
        ROUTE, INSTITUTION, 'P159-TRANSFER-REQUEST', null,
      ]);
      transferRequestId = request.transfer_request_id;
      const line = await call(c, 'phoenix_add_warehouse_transfer_request_line', [
        request.transfer_request_id,
        'PHASE-9-MATERIAL',
        40,
        null,
        '10 mg',
        'tablet',
        'box',
        null,
      ]);
      await call(c, 'phoenix_submit_warehouse_transfer_request', [
        request.transfer_request_id,
      ]);
      transferLineId = line.transfer_request_line_id;
    }, { commit: true });
    await rig.asUser(CWM, async (c: any) => {
      await call(c, 'phoenix_review_warehouse_transfer_request', [
        transferRequestId,
        JSON.stringify([{ line_id: transferLineId, approved_quantity: 40 }]),
      ]);
    }, { commit: true });
    expect(await ledgerCount()).toBe(before);
  });

  it('executes all three corridors once, preserves partial quantities and replays idempotently', async () => {
    await rig.asUser(CWM, async (c: any) => {
      const received = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), CENTRAL, 'PHASE-9-MATERIAL', 100, true, false, 0,
        null, null, '10 mg', 'tablet', 'box', null, 'P159-BATCH',
        new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
        null, null, null, null, 'P159-INTAKE', null, 'aid', null,
      ]);
      centralStockId = received.warehouse_stock_id;
    }, { commit: true });

    const sendRequestId = randomUUID();
    let transferId = '';
    await rig.asUser(CWM, async (c: any) => {
      const first = await call(c, 'phoenix_send_warehouse_transfer_line', [
        sendRequestId, ROUTE, centralStockId, 40, 'P159-TRANSFER',
        transferLineId, 'P159-TRANSFER-DOC', null,
      ]);
      const replay = await call(c, 'phoenix_send_warehouse_transfer_line', [
        sendRequestId, ROUTE, centralStockId, 40, 'P159-TRANSFER',
        transferLineId, 'P159-TRANSFER-DOC', null,
      ]);
      expect(first.ok).toBe(true);
      expect(replay.idempotent_replay).toBe(true);
      transferId = first.transfer_id;
    }, { commit: true });
    transferLineId = (await rig.asAdmin((c: any) => c.query(
      `SELECT id FROM warehouse_transfer_lines WHERE transfer_id=$1`,
      [transferId],
    ))).rows[0].id;

    const transferReceiveRequestId = randomUUID();
    await expect(rig.asUser(WO_WRONG, (c: any) => call(
      c,
      'phoenix_receive_warehouse_transfer_line',
      [randomUUID(), transferLineId, 40, null, null],
    ))).rejects.toThrow(/forbidden|not_authorized|scope|not_found/);
    await rig.asUser(WO, async (c: any) => {
      const first = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        transferReceiveRequestId, transferLineId, 40, null, null,
      ]);
      const replay = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        transferReceiveRequestId, transferLineId, 40, null, null,
      ]);
      expect(first.quantity_delta).toBe(40);
      expect(replay.idempotent_replay).toBe(true);
      institutionStockId = first.warehouse_stock_id;
    }, { commit: true });

    let dispatchId = '';
    await rig.asUser(WO, async (c: any) => {
      const dispatch = await call(c, 'phoenix_create_warehouse_dispatch', [
        INSTITUTION, OUTLET, 'P159-DISPATCH', 'P159-DISPATCH-DOC', null, null,
      ]);
      dispatchId = dispatch.dispatch_id;
      const line = await call(c, 'phoenix_add_dispatch_line_fefo_guarded', [
        dispatchId, institutionStockId, 25, false, null, randomUUID(),
      ]);
      dispatchLineId = line.dispatch_line_id;
      const requestId = randomUUID();
      const first = await call(c, 'phoenix_send_warehouse_dispatch', [
        requestId, dispatchId,
      ]);
      const replay = await call(c, 'phoenix_send_warehouse_dispatch', [
        requestId, dispatchId,
      ]);
      expect(first.ok).toBe(true);
      expect(replay.idempotent_replay).toBe(true);
    }, { commit: true });

    const dispatchReceiveRequestId = randomUUID();
    await expect(rig.asUser(OO_WRONG, (c: any) => call(
      c,
      'phoenix_receive_outlet_dispatch_line',
      [
        randomUUID(), dispatchLineId, 20,
        'five units short', null, 'shipment_error',
      ],
    ))).rejects.toThrow(/forbidden|not_authorized|scope|not_found/);
    await rig.asUser(OO, async (c: any) => {
      const first = await call(c, 'phoenix_receive_outlet_dispatch_line', [
        dispatchReceiveRequestId, dispatchLineId, 20,
        'five units short', null, 'shipment_error',
      ]);
      const replay = await call(c, 'phoenix_receive_outlet_dispatch_line', [
        dispatchReceiveRequestId, dispatchLineId, 20,
        'five units short', null, 'shipment_error',
      ]);
      expect(first.quantity_delta).toBe(20);
      expect(first.line_status).toBe('accepted_with_difference');
      expect(replay.idempotent_replay).toBe(true);
      outletStockId = first.outlet_stock_id;
    }, { commit: true });

    let returnRequestLineId = '';
    await rig.asUser(OO, async (c: any) => {
      const request = await call(c, 'phoenix_request_outlet_return', [
        OUTLET, 'P159-RETURN', null,
      ]);
      const line = await call(c, 'phoenix_add_outlet_return_request_line', [
        request.return_request_id, dispatchLineId, 10, 'excess', null,
      ]);
      returnRequestLineId = line.return_request_line_id;
      await call(c, 'phoenix_submit_outlet_return_request', [
        request.return_request_id,
      ]);
    }, { commit: true });
    const returnRequestId = (await rig.asAdmin((c: any) => c.query(
      `SELECT return_request_id FROM outlet_return_request_lines WHERE id=$1`,
      [returnRequestLineId],
    ))).rows[0].return_request_id;
    await rig.asUser(WO, (c: any) => call(
      c,
      'phoenix_review_outlet_return_request',
      [
        returnRequestId,
        JSON.stringify([{ line_id: returnRequestLineId, approved_quantity: 10 }]),
      ],
    ), { commit: true });

    const returnSendRequestId = randomUUID();
    let returnShipmentId = '';
    await rig.asUser(OO, async (c: any) => {
      const first = await call(c, 'phoenix_send_outlet_return_shipment_line', [
        returnSendRequestId, returnRequestLineId, null, 10,
        'P159-RETURN-SHIPMENT', 'P159-RETURN-DOC', null,
      ]);
      const replay = await call(c, 'phoenix_send_outlet_return_shipment_line', [
        returnSendRequestId, returnRequestLineId, null, 10,
        'P159-RETURN-SHIPMENT', 'P159-RETURN-DOC', null,
      ]);
      expect(first.quantity_delta).toBe(-10);
      expect(replay.idempotent_replay).toBe(true);
      returnShipmentId = first.shipment_id;
    }, { commit: true });
    returnShipmentLineId = (await rig.asAdmin((c: any) => c.query(
      `SELECT id FROM outlet_return_shipment_lines WHERE shipment_id=$1`,
      [returnShipmentId],
    ))).rows[0].id;

    const returnReceiveRequestId = randomUUID();
    await expect(rig.asUser(WO_WRONG, (c: any) => call(
      c,
      'phoenix_receive_outlet_return_shipment_line',
      [
        randomUUID(), returnShipmentLineId, 8,
        'two units short', null, 'quarantined',
      ],
    ))).rejects.toThrow(/forbidden|not_authorized|scope|not_found/);
    await rig.asUser(WO, async (c: any) => {
      const first = await call(c, 'phoenix_receive_outlet_return_shipment_line', [
        returnReceiveRequestId, returnShipmentLineId, 8,
        'two units short', null, 'quarantined',
      ]);
      const replay = await call(c, 'phoenix_receive_outlet_return_shipment_line', [
        returnReceiveRequestId, returnShipmentLineId, 8,
        'two units short', null, 'quarantined',
      ]);
      expect(first.quantity_delta).toBe(8);
      expect(first.line_status).toBe('received_with_difference');
      expect(first.custody_state).toBe('destination_quarantine');
      expect(replay.idempotent_replay).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const proof = await c.query(`
        SELECT
          (SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1)::integer AS central,
          (SELECT on_hand_quantity FROM warehouse_stock WHERE id=$2)::integer AS institution,
          (SELECT on_hand_quantity FROM outlet_stock WHERE id=$3)::integer AS outlet,
          (SELECT count(*)::integer FROM warehouse_stock_movements
            WHERE reference_type='warehouse_transfer_send'
              AND reference_id=$4) AS transfer_sends,
          (SELECT count(*)::integer FROM warehouse_stock_movements
            WHERE reference_type='warehouse_transfer_receive'
              AND reference_id=$5) AS transfer_receives,
          (SELECT count(*)::integer FROM warehouse_stock_movements
            WHERE reference_type='warehouse_dispatch_send'
              AND reference_id=$6) AS dispatch_sends,
          (SELECT count(*)::integer FROM outlet_stock_movements
            WHERE reference_type='outlet_request'
              AND reference_id=$7) AS dispatch_receives,
          (SELECT count(*)::integer FROM outlet_stock_movements
            WHERE reference_type='outlet_return_send'
              AND reference_id=$8) AS return_sends,
          (SELECT count(*)::integer FROM warehouse_quarantine_stock_movements
            WHERE reference_type='outlet_return_quarantine_receive'
              AND reference_id=$9) AS return_receives
      `, [
        centralStockId,
        institutionStockId,
        outletStockId,
        sendRequestId,
        transferReceiveRequestId,
        dispatchLineId,
        dispatchReceiveRequestId,
        returnSendRequestId,
        returnReceiveRequestId,
      ]);
      expect(proof.rows[0]).toEqual({
        central: 60,
        institution: 15,
        outlet: 10,
        transfer_sends: 1,
        transfer_receives: 1,
        dispatch_sends: 1,
        dispatch_receives: 1,
        return_sends: 1,
        return_receives: 1,
      });
    });
  }, 60_000);

  it('returns no reconciliation anomaly and gives the report exact canonical ledger parity', async () => {
    const anomalies = await rig.asAdmin((c: any) =>
      c.query(reconciliationSql, [ORG]));
    expect(anomalies.rows).toEqual([]);

    const canonicalIds = await rig.asAdmin(async (c: any) => {
      const result = await c.query(`
        SELECT id FROM warehouse_stock_movements WHERE organization_id=$1
        UNION ALL
        SELECT id FROM outlet_stock_movements WHERE organization_id=$1
        UNION ALL
        SELECT id FROM warehouse_quarantine_stock_movements WHERE organization_id=$1
        ORDER BY id
      `, [ORG]);
      return result.rows.map((row: any) => row.id);
    });

    for (const actor of [CWM, WO, OO]) {
      const reportedIds = await rig.asUser(actor, async (c: any) => {
        const result = await c.query(
          `SELECT movement_id
           FROM public.phoenix_movement_ledger_report(
             $1,NULL,NULL,NULL,NULL,NULL,NULL,NULL,200,0
           )
           ORDER BY movement_id`,
          [ORG],
        );
        return result.rows.map((row: any) => row.movement_id);
      });
      expect(reportedIds).toEqual(canonicalIds);
    }
  });

  it('fails closed for wrong warehouse/outlet, cross-org, suspended, anon and ID swaps', async () => {
    const before = await ledgerCount();
    await expect(rig.asUser(FOREIGN, (c: any) => c.query(
      `SELECT * FROM public.phoenix_movement_ledger_report(
        $1,NULL,NULL,NULL,NULL,NULL,NULL,NULL,200,0
      )`,
      [ORG],
    ))).rejects.toThrow(/forbidden|organization|scope/);
    await expect(rig.asUser(SUSPENDED, (c: any) => c.query(
      `SELECT * FROM public.phoenix_movement_ledger_report(
        $1,NULL,NULL,NULL,NULL,NULL,NULL,NULL,200,0
      )`,
      [ORG],
    ))).rejects.toThrow(/active_profile|required|forbidden/);
    await expect(rig.asUser(null, (c: any) => c.query(
      `SELECT * FROM public.phoenix_movement_ledger_report(
        $1,NULL,NULL,NULL,NULL,NULL,NULL,NULL,200,0
      )`,
      [ORG],
    ), { role: 'anon' })).rejects.toThrow(/permission denied|not_authenticated/);

    await rig.asUser(FOREIGN, async (c: any) => {
      for (const query of [
        ['SELECT 1 FROM warehouse_transfer_lines WHERE id=$1', transferLineId],
        ['SELECT 1 FROM warehouse_dispatch_lines WHERE id=$1', dispatchLineId],
        ['SELECT 1 FROM outlet_return_shipment_lines WHERE id=$1', returnShipmentLineId],
      ] as const) {
        const result = await c.query(query[0], [query[1]]);
        expect(result.rows).toEqual([]);
      }
    });
    expect(await ledgerCount()).toBe(before);
  });
});
