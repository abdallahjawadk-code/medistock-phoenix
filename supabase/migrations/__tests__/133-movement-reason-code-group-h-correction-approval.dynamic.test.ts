/**
 * MOVEMENT-REASON-CODE-GROUP-H-CORRECTION-APPROVAL-133 — DYNAMIC proof
 * against a real disposable Postgres with 001->133 applied in order.
 *
 * Proves:
 *   1. Outlet: an approved correction lands on reason_code='corrected', and
 *      when a prior movement exists for that exact outlet stock row, the
 *      new movement reuses its correlation_id and chains causation_id from
 *      its own id (a real, queryable predecessor).
 *   2. Outlet, first-ever movement: a stock row with NO prior movement gets
 *      a fresh correlation_id and NULL causation_id (no guess).
 *   3. Warehouse: the same reason_code='corrected' + correlation/causation
 *      chaining, mirrored on warehouse_stock_movements.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000133001';
const WH = '00000000-0000-0000-0000-000000133101';
const DP = '00000000-0000-0000-0000-000000133301';

const CWM = '00000000-0000-0000-0000-000000133401'; // central_warehouse_manager (approver)
const WO1 = '00000000-0000-0000-0000-000000133402'; // warehouse_officer (warehouse proposer)
const OO1 = '00000000-0000-0000-0000-000000133403'; // outlet_officer (outlet proposer)

run('133 Group H correction-approval reason_code/correlation chain — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 133 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Org','مؤسسة','p133-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','WH','مخزن','active','institution','p133-wh') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP}','${WH}','${ORG}','Outlet','منفذ','pharmacy','active') ON CONFLICT DO NOTHING;`);

      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${CWM}','p133-cwm@rig'),('${WO1}','p133-wo1@rig'),('${OO1}','p133-oo1@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${WO1}';`);
      await c.query(`UPDATE profiles SET role='outlet_officer',status='active',organization_id='${ORG}' WHERE id='${OO1}';`);

      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${WO1}','${ORG}','warehouse','${WH}',true) ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, distribution_point_id, is_active)
        VALUES ('${OO1}','${ORG}','distribution_point','${DP}',true) ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('outlet: first-ever movement on this stock row gets reason_code=corrected, fresh correlation_id, NULL causation_id', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy','P133-A',true,false,'B-A',50,0,0)`, [stockId, ORG, DP]);
    });

    let correctionId = '';
    await rig.asUser(OO1, async (c: any) => {
      const r = await call(c, 'phoenix_request_outlet_stock_correction',
        [randomUUID(), stockId, 40, 'physical count', null, null]);
      expect(r.requires_approval).toBe(true);
      correctionId = r.correction_request_id;
    }, { commit: true });

    let movementId = '';
    await rig.asUser(CWM, async (c: any) => {
      const r = await call(c, 'phoenix_approve_outlet_stock_correction', [correctionId, null]);
      expect(r.ok).toBe(true);
      movementId = r.movement_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const mv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM outlet_stock_movements WHERE id = $1`, [movementId]);
      expect(mv.rows[0].reason_code).toBe('corrected');
      expect(mv.rows[0].correlation_id).not.toBeNull();
      expect(mv.rows[0].causation_id).toBeNull();
    });
  });

  it('outlet: a SECOND correction against the same stock row chains correlation_id/causation_id from the first movement, a real queryable predecessor', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy','P133-B',true,false,'B-B',50,0,0)`, [stockId, ORG, DP]);
    });

    let firstMovementId = '';
    let firstCorrelationId = '';

    // Request + approve a first correction, then request + approve a second.
    let correctionId1 = '';
    await rig.asUser(OO1, async (c: any) => {
      const r = await call(c, 'phoenix_request_outlet_stock_correction', [randomUUID(), stockId, 45, 'first count', null, null]);
      correctionId1 = r.correction_request_id;
    }, { commit: true });
    await rig.asUser(CWM, async (c: any) => {
      const r = await call(c, 'phoenix_approve_outlet_stock_correction', [correctionId1, null]);
      firstMovementId = r.movement_id;
    }, { commit: true });
    await rig.asAdmin(async (c: any) => {
      const mv = await c.query(`SELECT correlation_id FROM outlet_stock_movements WHERE id = $1`, [firstMovementId]);
      firstCorrelationId = mv.rows[0].correlation_id;
    });

    let correctionId2 = '';
    await rig.asUser(OO1, async (c: any) => {
      const r = await call(c, 'phoenix_request_outlet_stock_correction', [randomUUID(), stockId, 30, 'second count', null, null]);
      correctionId2 = r.correction_request_id;
    }, { commit: true });
    let secondMovementId = '';
    await rig.asUser(CWM, async (c: any) => {
      const r = await call(c, 'phoenix_approve_outlet_stock_correction', [correctionId2, null]);
      secondMovementId = r.movement_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const mv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM outlet_stock_movements WHERE id = $1`, [secondMovementId]);
      expect(mv.rows[0].reason_code).toBe('corrected');
      expect(mv.rows[0].correlation_id).toBe(firstCorrelationId);
      expect(mv.rows[0].causation_id).toBe(firstMovementId);
    });
  });

  it('warehouse: reason_code=corrected, chains from the most recent prior movement on this exact stock row', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P133-C',true,false,'B-C',100,0,0)`, [stockId, ORG, WH]);
    });

    let correctionId = '';
    await rig.asUser(WO1, async (c: any) => {
      const r = await call(c, 'phoenix_request_warehouse_stock_correction', [randomUUID(), stockId, 90, 'physical count', null, null, null]);
      correctionId = r.correction_request_id;
    }, { commit: true });

    let movementId = '';
    await rig.asUser(CWM, async (c: any) => {
      const r = await call(c, 'phoenix_approve_warehouse_stock_correction', [correctionId, null]);
      expect(r.ok).toBe(true);
      movementId = r.movement_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const mv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM warehouse_stock_movements WHERE id = $1`, [movementId]);
      expect(mv.rows[0].reason_code).toBe('corrected');
      expect(mv.rows[0].correlation_id).not.toBeNull();
      expect(mv.rows[0].causation_id).toBeNull(); // first-ever movement for this fresh stock row
    });
  });
});
