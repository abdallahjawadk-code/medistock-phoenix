import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;
const ORG = '00000000-0000-0000-0000-000000152001';
const ORG_DEST = '00000000-0000-0000-0000-000000152002';
const CENTRAL = '00000000-0000-0000-0000-000000152101';
const INST = '00000000-0000-0000-0000-000000152102';
const DIRECT_DEST = '00000000-0000-0000-0000-000000152103';
const OUTLET = '00000000-0000-0000-0000-000000152201';
const ROUTE = '00000000-0000-0000-0000-000000152301';
const MANAGER = '00000000-0000-0000-0000-000000152401';

let sequence = 0;
const uniq = (prefix: string) => `${prefix}-${Date.now()}-${sequence++}`;

run('150 exact-material FEFO debit hardening — live contract', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(
      `SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS r`,
      args,
    ).then((r: any) => r.rows[0].r);

  const insertStock = async (
    id: string,
    name: string,
    batch: string,
    expiry: string,
    concentration = '10 mg',
    quantity = 50,
  ) => {
    await rig.asAdmin((c: any) => c.query(
      `INSERT INTO warehouse_stock(
         id,organization_id,warehouse_id,scientific_name,concentration,
         dosage_form,unit,national_code,has_no_national_code,
         batch_number,has_no_batch_number,expiry_date,
         on_hand_quantity,reserved_quantity,movement_seq
       ) VALUES($1,$2,$3,$4,$5,'tablet','box',NULL,true,$6,false,$7,$8,0,0)`,
      [id, ORG, CENTRAL, name, concentration, batch, expiry, quantity],
    ));
  };

  const createApprovedDirectRequest = async (
    materialName: string,
    quantity: number,
  ) => {
    let transferRequestId = '';
    let transferRequestLineId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const head = await call(c, 'phoenix_create_direct_warehouse_transfer_request', [
        CENTRAL, ORG_DEST, DIRECT_DEST, uniq('DIRECT-OVERRIDE-REQ'), null,
      ]);
      const line = await call(c, 'phoenix_add_warehouse_transfer_request_line', [
        head.transfer_request_id, materialName, quantity,
        null, '10 mg', 'tablet', 'box', null,
      ]);
      await call(c, 'phoenix_submit_warehouse_transfer_request', [
        head.transfer_request_id,
      ]);
      await call(c, 'phoenix_review_warehouse_transfer_request', [
        head.transfer_request_id,
        JSON.stringify([{
          line_id: line.transfer_request_line_id,
          approved_quantity: quantity,
        }]),
      ]);
      transferRequestId = head.transfer_request_id;
      transferRequestLineId = line.transfer_request_line_id;
    }, { commit: true });
    return { transferRequestId, transferRequestLineId };
  };

  const authenticateSession = async (c: any, actorId: string) => {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE authenticated');
    await c.query(
      `SELECT set_config('request.jwt.claim.sub',$1,true)`,
      [actorId],
    );
  };

  const receiveWarehouseStock = (
    c: any,
    requestId: string,
    materialName: string,
    batch: string,
    expiry: string,
    quantity = 7,
  ) => call(c, 'phoenix_receive_warehouse_stock_guarded', [
    requestId,
    CENTRAL,
    materialName,
    quantity,
    true,
    false,
    0,
    null,
    null,
    '10 mg',
    'tablet',
    'box',
    null,
    batch,
    expiry,
    null,
    null,
    null,
    null,
    uniq('RECEIPT-DOC'),
    null,
    'aid',
    null,
  ]);

  const waitForBackendLock = async (backendPid: number, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await rig.asAdmin((c: any) => c.query(`
        SELECT wait_event_type,wait_event,state
        FROM pg_stat_activity
        WHERE pid=$1
      `, [backendPid]));
      if (state.rows[0]?.wait_event_type === 'Lock') {
        return state.rows[0];
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`backend ${backendPid} did not reach a lock wait within ${timeoutMs}ms`);
  };

  beforeAll(async () => {
    rig = await buildRig({ upTo: 150 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`
        INSERT INTO organizations(id,name,name_ar,code) VALUES
          ('${ORG}','FEFO','FEFO','p150-fefo'),
          ('${ORG_DEST}','FEFO Dest','FEFO Dest','p150-fefo-d');
        INSERT INTO warehouses(
          id,organization_id,name,name_ar,status,warehouse_kind,code
        ) VALUES
          ('${CENTRAL}','${ORG}','Central','Central','active','central','p150-fc'),
          ('${INST}','${ORG}','Institution','Institution','active','institution','p150-fi'),
          ('${DIRECT_DEST}','${ORG_DEST}','Direct','Direct','active','institution','p150-fd');
      `);
      await c.query(`
        INSERT INTO distribution_points(
          id,warehouse_id,organization_id,name,name_ar,point_type,status
        ) VALUES(
          '${OUTLET}','${CENTRAL}','${ORG}','Outlet','Outlet','pharmacy','active'
        );
        INSERT INTO warehouse_supply_routes(
          id,source_warehouse_id,target_warehouse_id,
          source_warehouse_kind,target_warehouse_kind,is_active
        ) VALUES(
          '${ROUTE}','${CENTRAL}','${INST}','central','institution',true
        );
        INSERT INTO auth.users(id,email)
        VALUES('${MANAGER}','p150-fefo-manager@rig.local');
        UPDATE profiles SET role='central_warehouse_manager',status='active',
          organization_id='${ORG}' WHERE id='${MANAGER}';
        INSERT INTO profile_scope_assignments(
          profile_id,organization_id,scope_type,warehouse_id,is_active
        ) VALUES('${MANAGER}','${ORG}','warehouse','${CENTRAL}',true);
        INSERT INTO profile_permission_overrides(
          profile_id,permission_key,allowed
        ) VALUES('${MANAGER}','inventory.fefo_override',false);
      `);
    });
  }, 120000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  it('isolates variants and makes the legacy reader reject ambiguity', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await insertStock(a, 'Exact Variant', 'V10', '2028-01-01', '10 mg');
    await insertStock(b, 'Exact Variant', 'V20', '2027-01-01', '20 mg');

    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_inventory_fefo_batches', [
        ORG, 'warehouse', CENTRAL, 'Exact Variant', null,
      ])).rejects.toThrow(/material_identity_ambiguous/);
    });

    await rig.asAdmin(async (c: any) => {
      const rows = await c.query(`
        SELECT ws.material_identity_key,
               array_agg(x.stock_id ORDER BY x.expiry_date NULLS LAST,x.stock_id) ids
        FROM warehouse_stock ws
        CROSS JOIN LATERAL public._phoenix_inventory_fefo_batches_exact_v1(
          ws.organization_id,'warehouse',ws.warehouse_id,ws.material_identity_key
        ) x
        WHERE ws.id=ANY($1::uuid[])
        GROUP BY ws.material_identity_key
      `, [[a, b]]);
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.every((r: any) => r.ids.length === 1)).toBe(true);
    });
  });

  it('guards raw routed send and replays before a changed live FEFO set', async () => {
    const early = randomUUID();
    const late = randomUUID();
    const newerEarly = randomUUID();
    const requestId = randomUUID();
    await insertStock(early, 'Routed FEFO', 'EARLY', '2028-02-01');
    await insertStock(late, 'Routed FEFO', 'LATE', '2029-02-01');

    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_send_warehouse_transfer_line', [
        randomUUID(), ROUTE, late, 5, uniq('RAW-ROUTED-BLOCK'), null, null, null,
      ])).rejects.toThrow(/fefo_revalidation_required/);
    });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const sent = await call(c, 'phoenix_send_warehouse_transfer_line', [
        requestId, ROUTE, early, 5, 'RAW-ROUTED-REPLAY', null, null, null,
      ]);
      expect(sent.idempotent_replay).toBe(false);
    }, { commit: true });

    await insertStock(newerEarly, 'Routed FEFO', 'NEW-EARLIEST', '2027-02-01');
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const replay = await call(c, 'phoenix_send_warehouse_transfer_line', [
        requestId, ROUTE, early, 5, 'RAW-ROUTED-REPLAY', null, null, null,
      ]);
      expect(replay.idempotent_replay).toBe(true);
      await expect(call(c, 'phoenix_send_warehouse_transfer_line', [
        requestId, ROUTE, early, 6, 'RAW-ROUTED-REPLAY', null, null, null,
      ])).rejects.toThrow(/request_id_conflict/);
    });

    await rig.asAdmin(async (c: any) => {
      const proof = await c.query(`
        SELECT
          (SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1) qty,
          (SELECT count(*)::int FROM warehouse_stock_movements
            WHERE reference_type='warehouse_transfer_send'
              AND reference_id=$2) movements
      `, [early, requestId]);
      expect(proof.rows[0]).toEqual({ qty: 45, movements: 1 });
    });
  });

  it('guards raw direct send and rejects request-line material mismatch', async () => {
    const selected = randomUUID();
    const older = randomUUID();
    await insertStock(selected, 'Direct FEFO', 'DIRECT-LATE', '2029-03-01');
    await insertStock(older, 'Direct FEFO', 'DIRECT-EARLY', '2028-03-01');

    let transferRequestId = '';
    let transferRequestLineId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const head = await call(c, 'phoenix_create_direct_warehouse_transfer_request', [
        CENTRAL, ORG_DEST, DIRECT_DEST, uniq('DIRECT-REQ'), null,
      ]);
      const line = await call(c, 'phoenix_add_warehouse_transfer_request_line', [
        head.transfer_request_id, 'Direct FEFO', 10,
        null, '10 mg', 'tablet', 'box', null,
      ]);
      await call(c, 'phoenix_submit_warehouse_transfer_request', [
        head.transfer_request_id,
      ]);
      await call(c, 'phoenix_review_warehouse_transfer_request', [
        head.transfer_request_id,
        JSON.stringify([{ line_id: line.transfer_request_line_id, approved_quantity: 10 }]),
      ]);
      transferRequestId = head.transfer_request_id;
      transferRequestLineId = line.transfer_request_line_id;
    }, { commit: true });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_send_direct_warehouse_transfer_line', [
        randomUUID(), transferRequestId, selected, 10,
        uniq('DIRECT-RAW'), transferRequestLineId, null, null,
      ])).rejects.toThrow(/fefo_revalidation_required/);
    });
    const variant = randomUUID();
    await rig.asAdmin((c: any) => c.query(`
        INSERT INTO warehouse_stock(
          id,organization_id,warehouse_id,scientific_name,concentration,
          dosage_form,unit,national_code,has_no_national_code,batch_number,
          has_no_batch_number,expiry_date,on_hand_quantity,reserved_quantity,movement_seq
        ) VALUES($1,$2,$3,'Direct FEFO','20 mg','tablet','box',NULL,true,
                 'DIRECT-VARIANT',false,'2027-03-01',50,0,0)
      `, [variant, ORG, CENTRAL]),
    );
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_send_direct_warehouse_transfer_line', [
        randomUUID(), transferRequestId, variant, 10,
        uniq('DIRECT-MISMATCH'), transferRequestLineId, null, null,
      ])).rejects.toThrow(/direct_request_line_material_mismatch/);
    });
  });

  it('revalidates all dispatch lines atomically after an older lot arrives', async () => {
    const selected = randomUUID();
    const older = randomUUID();
    await insertStock(selected, 'Dispatch FEFO', 'DRAFTED', '2029-04-01');
    let dispatchId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const head = await call(c, 'phoenix_create_warehouse_dispatch', [
        CENTRAL, OUTLET, uniq('DISPATCH'), null, null, null,
      ]);
      dispatchId = head.dispatch_id;
      await call(c, 'phoenix_add_dispatch_line', [dispatchId, selected, 10]);
    }, { commit: true });
    await insertStock(older, 'Dispatch FEFO', 'ARRIVED-OLDER', '2028-04-01');

    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_send_warehouse_dispatch', [
        randomUUID(), dispatchId,
      ])).rejects.toThrow(/fefo_revalidation_required/);
    });
    await rig.asAdmin(async (c: any) => {
      const proof = await c.query(`
        SELECT d.status,ws.on_hand_quantity,
          (SELECT count(*)::int FROM warehouse_stock_movements m
           JOIN warehouse_dispatch_lines l ON l.id=m.reference_id
           WHERE l.dispatch_id=$1
             AND m.reference_type='warehouse_dispatch_send') movements,
          (SELECT count(*)::int FROM audit_logs a
           WHERE a.entity_id=$1 AND a.action='warehouse_dispatch.sent') audits
        FROM warehouse_dispatches d
        JOIN warehouse_stock ws ON ws.id=$2 WHERE d.id=$1
      `, [dispatchId, selected]);
      expect(proof.rows[0]).toEqual({
        status: 'draft', on_hand_quantity: 50, movements: 0, audits: 0,
      });
    });
  });

  it('blocks raw dispatch add on a newer lot without creating a line, movement, or override proof', async () => {
    const early = randomUUID();
    const late = randomUUID();
    const material = uniq('RAW-DISPATCH-FEFO');
    await insertStock(early, material, 'RAW-DISPATCH-EARLY', '2028-08-01');
    await insertStock(late, material, 'RAW-DISPATCH-LATE', '2029-08-01');

    let dispatchId = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const head = await call(c, 'phoenix_create_warehouse_dispatch', [
        CENTRAL, OUTLET, uniq('RAW-DISPATCH'), null, null, null,
      ]);
      dispatchId = head.dispatch_id;
    }, { commit: true });

    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_add_dispatch_line', [
        dispatchId, late, 10,
      ])).rejects.toThrow(/fefo_revalidation_required/);
    });

    await rig.asAdmin(async (c: any) => {
      const proof = await c.query(`
        SELECT
          (SELECT count(*)::int FROM warehouse_dispatch_lines
            WHERE dispatch_id=$1) lines,
          (SELECT count(*)::int FROM warehouse_stock_movements
            WHERE warehouse_stock_id=$2) movements,
          (SELECT count(*)::int FROM audit_logs
            WHERE action IN (
              'inventory.fefo_overridden',
              'inventory.fefo_override_revalidated'
            )
              AND payload->>'dispatch_id'=$1::text) override_audits
      `, [dispatchId, late]);
      expect(proof.rows[0]).toEqual({
        lines: 0,
        movements: 0,
        override_audits: 0,
      });
    });
  });

  it('enforces routed override reason and permission, then debits and audits exactly once across replay', async () => {
    const early = randomUUID();
    const late = randomUUID();
    const material = uniq('ROUTED-OVERRIDE');
    const requestId = randomUUID();
    const transferNumber = uniq('ROUTED-OVERRIDE-SEND');
    const reason = 'documented cold-chain exception';
    await insertStock(early, material, 'ROUTED-OVERRIDE-EARLY', '2028-09-01');
    await insertStock(late, material, 'ROUTED-OVERRIDE-LATE', '2029-09-01');

    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_send_warehouse_transfer_line_fefo_guarded', [
        randomUUID(), ROUTE, late, 5, uniq('ROUTED-NO-REASON'),
        null, null, null, true, null,
      ])).rejects.toThrow(/fefo_override_reason_required/);
    });
    await rig.asUser(MANAGER, async (c: any) => {
      await expect(call(c, 'phoenix_send_warehouse_transfer_line_fefo_guarded', [
        randomUUID(), ROUTE, late, 5, uniq('ROUTED-NO-PERMISSION'),
        null, null, null, true, reason,
      ])).rejects.toThrow(/forbidden_fefo_override/);
    });

    await rig.asUser(rig.superAdminId, async (c: any) => {
      const sent = await call(c, 'phoenix_send_warehouse_transfer_line_fefo_guarded', [
        requestId, ROUTE, late, 5, transferNumber,
        null, null, null, true, reason,
      ]);
      expect(sent).toMatchObject({
        ok: true,
        idempotent_replay: false,
        fefo_override_applied: true,
      });
    }, { commit: true });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const replay = await call(c, 'phoenix_send_warehouse_transfer_line_fefo_guarded', [
        requestId, ROUTE, late, 5, transferNumber,
        null, null, null, true, reason,
      ]);
      expect(replay.idempotent_replay).toBe(true);
    });

    await rig.asAdmin(async (c: any) => {
      const proof = await c.query(`
        SELECT
          (SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1) qty,
          (SELECT count(*)::int FROM warehouse_stock_movements
            WHERE reference_type='warehouse_transfer_send'
              AND reference_id=$2) movements,
          (SELECT count(*)::int FROM audit_logs
            WHERE action='inventory.fefo_overridden'
              AND payload->>'request_id'=$2::text) audits,
          (SELECT payload FROM audit_logs
            WHERE action='inventory.fefo_overridden'
              AND payload->>'request_id'=$2::text
            ORDER BY created_at,id LIMIT 1) payload
      `, [late, requestId]);
      expect(proof.rows[0].qty).toBe(45);
      expect(proof.rows[0].movements).toBe(1);
      expect(proof.rows[0].audits).toBe(1);
      expect(proof.rows[0].payload).toMatchObject({
        request_id: requestId,
        material_identity_key: expect.any(String),
        earliest_stock_id: early,
        earliest_batch: 'ROUTED-OVERRIDE-EARLY',
        selected_stock_id: late,
        selected_batch: 'ROUTED-OVERRIDE-LATE',
        candidate_fingerprint: expect.any(String),
        reason,
      });
    });
  });

  it('enforces direct guarded override on an approved matching line and replays without duplicate debit or audit', async () => {
    const early = randomUUID();
    const late = randomUUID();
    const material = uniq('DIRECT-GUARDED-OVERRIDE');
    const requestId = randomUUID();
    const transferNumber = uniq('DIRECT-GUARDED-SEND');
    const reason = 'approved direct FEFO exception';
    await insertStock(early, material, 'DIRECT-OVERRIDE-EARLY', '2028-10-01');
    await insertStock(late, material, 'DIRECT-OVERRIDE-LATE', '2029-10-01');
    const { transferRequestId, transferRequestLineId } =
      await createApprovedDirectRequest(material, 5);

    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_send_direct_warehouse_transfer_line_fefo_guarded', [
        randomUUID(), transferRequestId, late, 5, uniq('DIRECT-NO-REASON'),
        transferRequestLineId, null, null, true, null,
      ])).rejects.toThrow(/fefo_override_reason_required/);
    });
    await rig.asUser(MANAGER, async (c: any) => {
      await expect(call(c, 'phoenix_send_direct_warehouse_transfer_line_fefo_guarded', [
        randomUUID(), transferRequestId, late, 5, uniq('DIRECT-NO-PERMISSION'),
        transferRequestLineId, null, null, true, reason,
      ])).rejects.toThrow(/forbidden_fefo_override/);
    });

    await rig.asUser(rig.superAdminId, async (c: any) => {
      const sent = await call(c, 'phoenix_send_direct_warehouse_transfer_line_fefo_guarded', [
        requestId, transferRequestId, late, 5, transferNumber,
        transferRequestLineId, null, null, true, reason,
      ]);
      expect(sent).toMatchObject({
        ok: true,
        idempotent_replay: false,
        fefo_override_applied: true,
      });
    }, { commit: true });
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const replay = await call(c, 'phoenix_send_direct_warehouse_transfer_line_fefo_guarded', [
        requestId, transferRequestId, late, 5, transferNumber,
        transferRequestLineId, null, null, true, reason,
      ]);
      expect(replay.idempotent_replay).toBe(true);
    });

    await rig.asAdmin(async (c: any) => {
      const proof = await c.query(`
        SELECT
          (SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1) qty,
          (SELECT count(*)::int FROM warehouse_stock_movements
            WHERE reference_type='warehouse_transfer_send'
              AND reference_id=$2) movements,
          (SELECT count(*)::int FROM audit_logs
            WHERE action='inventory.fefo_overridden'
              AND payload->>'request_id'=$2::text) audits,
          (SELECT payload FROM audit_logs
            WHERE action='inventory.fefo_overridden'
              AND payload->>'request_id'=$2::text
            ORDER BY created_at,id LIMIT 1) payload
      `, [late, requestId]);
      expect(proof.rows[0].qty).toBe(45);
      expect(proof.rows[0].movements).toBe(1);
      expect(proof.rows[0].audits).toBe(1);
      expect(proof.rows[0].payload).toMatchObject({
        request_id: requestId,
        transfer_request_id: transferRequestId,
        transfer_request_line_id: transferRequestLineId,
        material_identity_key: expect.any(String),
        earliest_stock_id: early,
        selected_stock_id: late,
        candidate_fingerprint: expect.any(String),
        reason,
      });
    });
  });

  it('sends a stable dispatch override once and replays before a later FEFO change', async () => {
    const early = randomUUID();
    const late = randomUUID();
    const laterArrival = randomUUID();
    const material = uniq('DISPATCH-STABLE-OVERRIDE');
    const addRequestId = randomUUID();
    const sendRequestId = randomUUID();
    const reason = 'stable dispatch exception';
    await insertStock(early, material, 'DISPATCH-OVERRIDE-EARLY', '2028-11-01');
    await insertStock(late, material, 'DISPATCH-OVERRIDE-LATE', '2029-11-01');

    let dispatchId = '';
    let dispatchLineId = '';
    let fingerprint = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const head = await call(c, 'phoenix_create_warehouse_dispatch', [
        CENTRAL, OUTLET, uniq('DISPATCH-STABLE'), null, null, null,
      ]);
      dispatchId = head.dispatch_id;
      const added = await call(c, 'phoenix_add_dispatch_line_fefo_guarded', [
        dispatchId, late, 10, true, reason, addRequestId,
      ]);
      dispatchLineId = added.dispatch_line_id;
      expect(added.fefo_override_applied).toBe(true);
    }, { commit: true });
    await rig.asAdmin(async (c: any) => {
      const line = await c.query(`
        SELECT fefo_candidate_fingerprint
        FROM warehouse_dispatch_lines WHERE id=$1
      `, [dispatchLineId]);
      fingerprint = line.rows[0].fefo_candidate_fingerprint;
      expect(fingerprint).toEqual(expect.any(String));
    });

    await rig.asUser(rig.superAdminId, async (c: any) => {
      const sent = await call(c, 'phoenix_send_warehouse_dispatch', [
        sendRequestId, dispatchId,
      ]);
      expect(sent).toMatchObject({
        ok: true,
        idempotent_replay: false,
        dispatch_id: dispatchId,
        status: 'sent',
      });
    }, { commit: true });

    await insertStock(
      laterArrival,
      material,
      'DISPATCH-OVERRIDE-NEW-EARLIEST',
      '2027-11-01',
    );
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const replay = await call(c, 'phoenix_send_warehouse_dispatch', [
        sendRequestId, dispatchId,
      ]);
      expect(replay).toMatchObject({
        ok: true,
        idempotent_replay: true,
        dispatch_id: dispatchId,
      });
      await expect(call(c, 'phoenix_send_warehouse_dispatch', [
        sendRequestId, randomUUID(),
      ])).rejects.toThrow(/request_id_conflict/);
    });

    await rig.asAdmin(async (c: any) => {
      const proof = await c.query(`
        SELECT d.status,ws.on_hand_quantity,l.fefo_candidate_fingerprint,
          (SELECT count(*)::int FROM warehouse_stock_movements m
            WHERE m.reference_type='warehouse_dispatch_send'
              AND m.reference_id=l.id) movements,
          (SELECT count(*)::int FROM audit_logs a
            WHERE a.action='inventory.fefo_overridden'
              AND a.entity_type='warehouse_dispatch_lines'
              AND a.entity_id=l.id) add_override_audits,
          (SELECT count(*)::int FROM audit_logs a
            WHERE a.action='inventory.fefo_override_revalidated'
              AND a.entity_id=l.id
              AND a.payload->>'request_id'=$2::text) send_override_audits,
          (SELECT count(*)::int FROM audit_logs a
            WHERE a.action='warehouse_dispatch.sent'
              AND a.payload->>'request_id'=$2::text) send_audits
        FROM warehouse_dispatches d
        JOIN warehouse_dispatch_lines l ON l.dispatch_id=d.id
        JOIN warehouse_stock ws ON ws.id=l.warehouse_stock_id
        WHERE d.id=$1 AND l.id=$3
      `, [dispatchId, sendRequestId, dispatchLineId]);
      expect(proof.rows[0]).toEqual({
        status: 'sent',
        on_hand_quantity: 40,
        fefo_candidate_fingerprint: fingerprint,
        movements: 1,
        add_override_audits: 1,
        send_override_audits: 1,
        send_audits: 1,
      });
    });
  });

  it('invalidates changed override fingerprints and checks sender permission live', async () => {
    const early = randomUUID();
    const late = randomUUID();
    const earliest = randomUUID();
    await insertStock(early, 'Override FEFO', 'OVR-EARLY', '2028-06-01');
    await insertStock(late, 'Override FEFO', 'OVR-LATE', '2029-06-01');
    let changedDispatch = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const head = await call(c, 'phoenix_create_warehouse_dispatch', [
        CENTRAL, OUTLET, uniq('OVERRIDE-CHANGED'), null, null, null,
      ]);
      changedDispatch = head.dispatch_id;
      const added = await call(c, 'phoenix_add_dispatch_line_fefo_guarded', [
        changedDispatch, late, 10, true, 'documented exception', randomUUID(),
      ]);
      expect(added.fefo_override_applied).toBe(true);
    }, { commit: true });
    await insertStock(earliest, 'Override FEFO', 'OVR-NEW', '2027-06-01');
    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_send_warehouse_dispatch', [
        randomUUID(), changedDispatch,
      ])).rejects.toThrow(/fefo_revalidation_required/);
    });

    const early2 = randomUUID();
    const late2 = randomUUID();
    await insertStock(early2, 'Permission FEFO', 'PERM-EARLY', '2028-07-01');
    await insertStock(late2, 'Permission FEFO', 'PERM-LATE', '2029-07-01');
    let permissionDispatch = '';
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const head = await call(c, 'phoenix_create_warehouse_dispatch', [
        CENTRAL, OUTLET, uniq('OVERRIDE-PERMISSION'), null, null, null,
      ]);
      permissionDispatch = head.dispatch_id;
      await call(c, 'phoenix_add_dispatch_line_fefo_guarded', [
        permissionDispatch, late2, 10, true, 'documented exception', randomUUID(),
      ]);
    }, { commit: true });
    await rig.asUser(MANAGER, async (c: any) => {
      await expect(call(c, 'phoenix_send_warehouse_dispatch', [
        randomUUID(), permissionDispatch,
      ])).rejects.toThrow(/forbidden_fefo_override/);
    });
  });

  it('serializes send before a concurrent older-lot insert without deadlock', async () => {
    const selected = randomUUID();
    const arriving = randomUUID();
    const requestId = randomUUID();
    await insertStock(selected, 'Concurrent FEFO', 'CURRENT', '2029-05-01');
    const a = await rig.pool.connect();
    const b = await rig.pool.connect();
    try {
      await a.query('BEGIN');
      await a.query('SET LOCAL ROLE authenticated');
      await a.query(
        `SELECT set_config('request.jwt.claim.sub',$1,true)`,
        [rig.superAdminId],
      );
      const sent = await a.query(
        `SELECT public.phoenix_send_warehouse_transfer_line(
          $1,$2,$3,5,$4,NULL,NULL,NULL) AS r`,
        [requestId, ROUTE, selected, uniq('CONCURRENT-SEND')],
      );
      expect(sent.rows[0].r.ok).toBe(true);

      let inserted = false;
      const insertPromise = b.query(`
        INSERT INTO warehouse_stock(
          id,organization_id,warehouse_id,scientific_name,concentration,
          dosage_form,unit,national_code,has_no_national_code,batch_number,
          has_no_batch_number,expiry_date,on_hand_quantity,reserved_quantity,movement_seq
        ) VALUES($1,$2,$3,'Concurrent FEFO','10 mg','tablet','box',NULL,true,
                 'ARRIVING',false,'2028-05-01',50,0,0)
      `, [arriving, ORG, CENTRAL]).then(() => { inserted = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(inserted).toBe(false);
      await a.query('COMMIT');
      await insertPromise;
      expect(inserted).toBe(true);
    } finally {
      try { await a.query('ROLLBACK'); } catch { /* already committed */ }
      a.release();
      b.release();
    }
    await rig.asAdmin(async (c: any) => {
      const proof = await c.query(`
        SELECT
          (SELECT count(*)::int FROM warehouse_stock_movements
            WHERE reference_id=$1) movements,
          (SELECT on_hand_quantity FROM warehouse_stock WHERE id=$2) qty,
          (SELECT count(*)::int FROM warehouse_stock WHERE id=$3) arrived
      `, [requestId, selected, arriving]);
      expect(proof.rows[0]).toEqual({ movements: 1, qty: 45, arrived: 1 });
    });
  });

  it('serializes routed send against the real guarded receipt writer in both commit orders', async () => {
    const selectedFirst = randomUUID();
    const sendFirstRequest = randomUUID();
    const receiptSecondRequest = randomUUID();
    const sendFirstMaterial = uniq('RECEIPT-RACE-SEND-FIRST');
    const events: string[] = [];
    await insertStock(
      selectedFirst,
      sendFirstMaterial,
      'RACE-CURRENT',
      '2029-12-01',
    );

    const a = await rig.pool.connect();
    const b = await rig.pool.connect();
    try {
      await authenticateSession(a, rig.superAdminId);
      await authenticateSession(b, rig.superAdminId);
      const bPid = Number((await b.query('SELECT pg_backend_pid() pid')).rows[0].pid);

      const sent = await call(a, 'phoenix_send_warehouse_transfer_line', [
        sendFirstRequest,
        ROUTE,
        selectedFirst,
        5,
        uniq('RECEIPT-RACE-SEND-FIRST'),
        null,
        null,
        null,
      ]);
      expect(sent.ok).toBe(true);
      events.push('send_returned_with_locks');

      const receiptPromise = receiveWarehouseStock(
        b,
        receiptSecondRequest,
        sendFirstMaterial,
        'RACE-ARRIVING-OLDER',
        '2028-12-01',
      ).then((result) => {
        events.push('receipt_returned');
        return result;
      });
      events.push('receipt_started');
      const waitState = await waitForBackendLock(bPid);
      expect(waitState.wait_event_type).toBe('Lock');
      events.push('receipt_observed_waiting_on_lock');

      await a.query('COMMIT');
      events.push('send_committed');
      const receipt = await Promise.race([
        receiptPromise,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('receipt did not finish after send commit')),
          5000,
        )),
      ]) as any;
      expect(receipt).toMatchObject({ ok: true, idempotent_replay: false });
      await b.query('COMMIT');
      events.push('receipt_committed');
      expect(events).toEqual([
        'send_returned_with_locks',
        'receipt_started',
        'receipt_observed_waiting_on_lock',
        'send_committed',
        'receipt_returned',
        'receipt_committed',
      ]);
    } finally {
      try { await a.query('ROLLBACK'); } catch { /* already committed */ }
      try { await b.query('ROLLBACK'); } catch { /* already committed */ }
      a.release();
      b.release();
    }

    await rig.asAdmin(async (c: any) => {
      const proof = await c.query(`
        SELECT
          (SELECT count(*)::int FROM warehouse_stock_movements
            WHERE reference_type='warehouse_transfer_send'
              AND reference_id=$1) send_movements,
          (SELECT count(*)::int FROM warehouse_stock_movements
            WHERE reference_type='warehouse_request'
              AND reference_id=$2) receipt_movements,
          (SELECT on_hand_quantity FROM warehouse_stock WHERE id=$3) selected_qty
      `, [sendFirstRequest, receiptSecondRequest, selectedFirst]);
      expect(proof.rows[0]).toEqual({
        send_movements: 1,
        receipt_movements: 1,
        selected_qty: 45,
      });
    });

    const selectedSecond = randomUUID();
    const receiptFirstRequest = randomUUID();
    const rejectedSendRequest = randomUUID();
    const receiptFirstMaterial = uniq('RECEIPT-RACE-RECEIPT-FIRST');
    const rejectedTransferNumber = uniq('RECEIPT-FIRST-SEND');
    await insertStock(
      selectedSecond,
      receiptFirstMaterial,
      'RECEIPT-FIRST-CURRENT',
      '2029-12-15',
    );
    await rig.asUser(rig.superAdminId, async (c: any) => {
      const received = await receiveWarehouseStock(
        c,
        receiptFirstRequest,
        receiptFirstMaterial,
        'RECEIPT-FIRST-OLDER',
        '2028-12-15',
      );
      expect(received).toMatchObject({ ok: true, idempotent_replay: false });
    }, { commit: true });

    await rig.asUser(rig.superAdminId, async (c: any) => {
      await expect(call(c, 'phoenix_send_warehouse_transfer_line', [
        rejectedSendRequest,
        ROUTE,
        selectedSecond,
        5,
        rejectedTransferNumber,
        null,
        null,
        null,
      ])).rejects.toThrow(/fefo_revalidation_required/);
    });
    await rig.asAdmin(async (c: any) => {
      const proof = await c.query(`
        SELECT
          (SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1) selected_qty,
          (SELECT count(*)::int FROM warehouse_stock_movements
            WHERE reference_type='warehouse_transfer_send'
              AND reference_id=$2) send_movements,
          (SELECT count(*)::int FROM warehouse_transfers
            WHERE transfer_number=$3) transfers,
          (SELECT count(*)::int FROM audit_logs
            WHERE payload->>'request_id'=$2::text) send_audits,
          (SELECT count(*)::int FROM warehouse_stock_movements
            WHERE reference_type='warehouse_request'
              AND reference_id=$4) receipt_movements
      `, [
        selectedSecond,
        rejectedSendRequest,
        rejectedTransferNumber,
        receiptFirstRequest,
      ]);
      expect(proof.rows[0]).toEqual({
        selected_qty: 50,
        send_movements: 0,
        transfers: 0,
        send_audits: 0,
        receipt_movements: 1,
      });
    });
  }, 30000);

  it('keeps delegates inaccessible and provenance-bound return writers unchanged', async () => {
    await rig.asAdmin(async (c: any) => {
      for (const signature of [
        'public._phoenix_150_delegate_send_warehouse_transfer_line(uuid,uuid,uuid,integer,text,uuid,text,text)',
        'public._phoenix_150_delegate_add_dispatch_line(uuid,uuid,integer)',
        'public._phoenix_inventory_fefo_batches_exact_v1(uuid,text,uuid,text)',
      ]) {
        const acl = await c.query(
          `SELECT has_function_privilege('anon',$1,'EXECUTE') anon,
                  has_function_privilege('authenticated',$1,'EXECUTE') auth`,
          [signature],
        );
        expect(acl.rows[0]).toEqual({ anon: false, auth: false });
      }
      const returnBody = await c.query(`
        SELECT pg_get_functiondef(
          'public._phoenix_149_delegate_send_outlet_return_shipment_line(uuid,uuid,uuid,integer,text,text,text)'::regprocedure
        ) body
      `);
      expect(returnBody.rows[0].body).toContain('original_dispatch_line_id');
      expect(returnBody.rows[0].body).not.toContain(
        '_phoenix_inventory_fefo_batches_exact_v1',
      );
    });
  });
});
