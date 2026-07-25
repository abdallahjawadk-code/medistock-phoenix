/**
 * MOVEMENT-REASON-CODE-GROUP-B-WAREHOUSE-TRANSFER-127 — DYNAMIC proof
 * against a real disposable Postgres with 001->127 applied in order.
 *
 * Proves:
 *   1. The send movement lands on reason_code='transferred' with a fresh
 *      correlation_id and NULL causation_id.
 *   2. warehouse_transfer_lines.source_movement_id is populated with the
 *      send movement's own id immediately after send.
 *   3. The receive movement lands on reason_code='received', and its
 *      correlation_id EQUALS the send movement's correlation_id (the two
 *      halves of one shipment share one correlation chain), and its
 *      causation_id EQUALS the send movement's own id (a real, proven
 *      predecessor, not a guess).
 *   4. A rejected receive (received_quantity=0) still writes no movement
 *      row at all -- unaffected by this migration.
 *   5. A transfer_line with no source_movement_id (simulating a pre-127
 *      legacy row) falls back to a fresh correlation_id and NULL
 *      causation_id on receive, rather than fabricating a link.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000127001';
const WH_SRC = '00000000-0000-0000-0000-000000127101';
const WH_DST = '00000000-0000-0000-0000-000000127102';
const CWM_SRC = '00000000-0000-0000-0000-000000127401'; // scoped to WH_SRC, sends
const CWM_DST = '00000000-0000-0000-0000-000000127402'; // scoped to WH_DST, receives
const ROUTE = '00000000-0000-0000-0000-000000127501'; // one active route per (source,target) pair — reused across tests

run('127 Group B warehouse transfer reason_code/correlation chain — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 127 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Org','مؤسسة','p127-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_SRC}','${ORG}','Src','مصدر','active','central','p127-src'),
        ('${WH_DST}','${ORG}','Dst','هدف','active','institution','p127-dst')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${CWM_SRC}','p127-src@rig'),('${CWM_DST}','p127-dst@rig')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id='${ORG}' WHERE id='${CWM_SRC}';`);
      await c.query(`UPDATE profiles SET role='warehouse_officer',status='active',organization_id='${ORG}' WHERE id='${CWM_DST}';`);
      await c.query(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ('${CWM_SRC}','${ORG}','warehouse','${WH_SRC}',true),
               ('${CWM_DST}','${ORG}','warehouse','${WH_DST}',true)
        ON CONFLICT DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes
        (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ('${ROUTE}','${WH_SRC}','${WH_DST}','central','institution', true)
        ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('send lands on reason_code=transferred, fresh correlation_id, NULL causation_id; source_movement_id is populated on the line', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P127-A',true,false,'B-A',30,0,0)`, [stockId, ORG, WH_SRC]);
    });

    let movementId = '';
    let lineId = '';
    await rig.asUser(CWM_SRC, async (c: any) => {
      const sent = await call(c, 'phoenix_send_warehouse_transfer_line', [
        randomUUID(), ROUTE, stockId, 10, 'P127-WT-1', null, null, null,
      ]);
      expect(sent.ok).toBe(true);
      movementId = sent.movement_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const mv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM warehouse_stock_movements WHERE id = $1`, [movementId]);
      expect(mv.rows[0].reason_code).toBe('transferred');
      expect(mv.rows[0].correlation_id).not.toBeNull();
      expect(mv.rows[0].causation_id).toBeNull();

      const line = await c.query(`SELECT id, source_movement_id FROM warehouse_transfer_lines WHERE source_warehouse_stock_id = $1`, [stockId]);
      expect(line.rows[0].source_movement_id).toBe(movementId);
      lineId = line.rows[0].id;
    });

    let receiveMovementId = '';
    await rig.asUser(CWM_DST, async (c: any) => {
      const received = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), lineId, 10, null, null,
      ]);
      expect(received.ok).toBe(true);
      receiveMovementId = received.movement_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const sendMv = await c.query(`SELECT correlation_id FROM warehouse_stock_movements WHERE id = $1`, [movementId]);
      const receiveMv = await c.query(`SELECT reason_code, correlation_id, causation_id FROM warehouse_stock_movements WHERE id = $1`, [receiveMovementId]);
      expect(receiveMv.rows[0].reason_code).toBe('received');
      expect(receiveMv.rows[0].correlation_id).toBe(sendMv.rows[0].correlation_id);
      expect(receiveMv.rows[0].causation_id).toBe(movementId);
    });
  });

  it('a rejected receive (received_quantity=0) still writes no movement row at all', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P127-B',true,false,'B-B',10,0,0)`, [stockId, ORG, WH_SRC]);
    });

    let lineId = '';
    await rig.asUser(CWM_SRC, async (c: any) => {
      const sent = await call(c, 'phoenix_send_warehouse_transfer_line', [
        randomUUID(), ROUTE, stockId, 10, 'P127-WT-2', null, null, null,
      ]);
      expect(sent.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const line = await c.query(`SELECT id FROM warehouse_transfer_lines WHERE source_warehouse_stock_id = $1`, [stockId]);
      lineId = line.rows[0].id;
    });

    await rig.asUser(CWM_DST, async (c: any) => {
      const received = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), lineId, 0, 'shipment lost', null,
      ]);
      expect(received.ok).toBe(true);
      expect(received.line_status).toBe('rejected');
      expect(received.movement_id).toBeNull();
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const mv = await c.query(`SELECT count(*)::int AS n FROM warehouse_stock_movements WHERE reference_type = 'warehouse_transfer_receive' AND scientific_name_snapshot = 'P127-B'`);
      expect(mv.rows[0].n).toBe(0);
    });
  });

  it('a transfer line with no source_movement_id (simulating a pre-127 row) falls back to a fresh correlation_id and NULL causation_id on receive', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P127-C',true,false,'B-C',10,0,0)`, [stockId, ORG, WH_SRC]);
    });

    let lineId = '';
    await rig.asUser(CWM_SRC, async (c: any) => {
      const sent = await call(c, 'phoenix_send_warehouse_transfer_line', [
        randomUUID(), ROUTE, stockId, 10, 'P127-WT-3', null, null, null,
      ]);
      expect(sent.ok).toBe(true);
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const line = await c.query(`SELECT id FROM warehouse_transfer_lines WHERE source_warehouse_stock_id = $1`, [stockId]);
      lineId = line.rows[0].id;
      // Simulate a legacy pre-127 line: sever the link this migration would
      // normally have populated.
      await c.query(`UPDATE warehouse_transfer_lines SET source_movement_id = NULL WHERE id = $1`, [lineId]);
    });

    let receiveMovementId = '';
    await rig.asUser(CWM_DST, async (c: any) => {
      const received = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), lineId, 10, null, null,
      ]);
      expect(received.ok).toBe(true);
      receiveMovementId = received.movement_id;
    }, { commit: true });

    await rig.asAdmin(async (c: any) => {
      const mv = await c.query(`SELECT correlation_id, causation_id FROM warehouse_stock_movements WHERE id = $1`, [receiveMovementId]);
      expect(mv.rows[0].correlation_id).not.toBeNull();
      expect(mv.rows[0].causation_id).toBeNull();
    });
  });
});
