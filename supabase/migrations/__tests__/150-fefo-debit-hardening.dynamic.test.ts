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
