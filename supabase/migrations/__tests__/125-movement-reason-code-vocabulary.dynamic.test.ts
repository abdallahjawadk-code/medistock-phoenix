/**
 * MOVEMENT-REASON-CODE-VOCABULARY-125 — DYNAMIC proof against a real
 * disposable Postgres with 001->125 applied in order.
 *
 * Proves:
 *   1. An UNMODIFIED writer-style INSERT (explicit column list, omitting
 *      reason_code entirely — exactly what all 20 real RPCs still do until
 *      their own domain slice lands) succeeds and lands on
 *      'legacy_unclassified', not NULL and not a hard failure. This is the
 *      whole point of the DEFAULT: zero of the 20 writers break today.
 *   2. An explicit valid reason_code (e.g. 'received') is honored when a
 *      writer supplies it explicitly.
 *   3. An invalid reason_code is rejected by the CHECK constraint (closed
 *      vocabulary is genuinely enforced, not just documented).
 *   4. This holds across all three ledger tables.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000125001';
const WH = '00000000-0000-0000-0000-000000125101';
const DP = '00000000-0000-0000-0000-000000125301';

run('125 movement reason-code vocabulary — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 125 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Org','مؤسسة','p125-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','WH','مخزن','active','institution','p125-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP}','${WH}','${ORG}','Outlet','منفذ','pharmacy','active') ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('an unmodified-style warehouse_stock_movements INSERT (no reason_code column supplied) lands on legacy_unclassified', async () => {
    const stockId = randomUUID();
    const movementId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P125-WH',true,false,'B-WH',10,0,1)`, [stockId, ORG, WH]);
      await c.query(`INSERT INTO warehouse_stock_movements
        (id, warehouse_stock_id, organization_id, warehouse_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot)
        VALUES ($1,$2,$3,$4,'add',0,10,10,0,0,0,'P125-WH')`, [movementId, stockId, ORG, WH]);

      const row = await c.query(`SELECT reason_code FROM warehouse_stock_movements WHERE id = $1`, [movementId]);
      expect(row.rows[0].reason_code).toBe('legacy_unclassified');
    });
  });

  it('a writer that explicitly supplies reason_code has it honored', async () => {
    const stockId = randomUUID();
    const movementId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P125-EXPLICIT',true,false,'B-EXP',5,0,0)`, [stockId, ORG, WH]);
      await c.query(`INSERT INTO warehouse_stock_movements
        (id, warehouse_stock_id, organization_id, warehouse_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot, reason_code)
        VALUES ($1,$2,$3,$4,'add',0,5,5,0,0,0,'P125-EXPLICIT','received')`, [movementId, stockId, ORG, WH]);

      const row = await c.query(`SELECT reason_code FROM warehouse_stock_movements WHERE id = $1`, [movementId]);
      expect(row.rows[0].reason_code).toBe('received');
    });
  });

  it('an invalid reason_code is rejected by the CHECK constraint on all three ledgers', async () => {
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P125-BAD',true,false,'B-BAD',1,0,0)`, [stockId, ORG, WH]);
      await expect(
        c.query(`INSERT INTO warehouse_stock_movements
          (id, warehouse_stock_id, organization_id, warehouse_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot, reason_code)
          VALUES ($1,$2,$3,$4,'add',0,1,1,0,0,0,'P125-BAD','not_a_real_code')`, [randomUUID(), stockId, ORG, WH]),
      ).rejects.toThrow(/reason_code/);
    });

    const dpStockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy','P125-OUT-BAD',true,false,'B-OUT-BAD',1,0,0)`, [dpStockId, ORG, DP]);
      await expect(
        c.query(`INSERT INTO outlet_stock_movements
          (id, outlet_stock_id, organization_id, distribution_point_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot, reason_code)
          VALUES ($1,$2,$3,$4,'add',0,1,1,0,0,0,'P125-OUT-BAD','not_a_real_code')`, [randomUUID(), dpStockId, ORG, DP]),
      ).rejects.toThrow(/reason_code/);
    });

    const qId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_quarantine_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, quarantine_reason, quantity, created_by, updated_by)
        VALUES ($1,$2,$3,'P125-Q-BAD',true,false,'B-Q-BAD','damaged',1,NULL,NULL)`, [qId, ORG, WH]);
      await expect(
        c.query(`INSERT INTO warehouse_quarantine_stock_movements
          (id, quarantine_stock_id, organization_id, warehouse_id, movement_type, quantity_before, quantity_delta, quantity_after, reason_code)
          VALUES ($1,$2,$3,$4,'quarantine_receive',0,1,1,'not_a_real_code')`, [randomUUID(), qId, ORG, WH]),
      ).rejects.toThrow(/reason_code/);
    });
  });

  it('legacy_unclassified itself is a valid, insertable value (the documented backfill/default landing zone)', async () => {
    const qId = randomUUID();
    const movementId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_quarantine_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, quarantine_reason, quantity, created_by, updated_by)
        VALUES ($1,$2,$3,'P125-Q-LEGACY',true,false,'B-Q-LEGACY','damaged',3,NULL,NULL)`, [qId, ORG, WH]);
      await c.query(`INSERT INTO warehouse_quarantine_stock_movements
        (id, quarantine_stock_id, organization_id, warehouse_id, movement_type, quantity_before, quantity_delta, quantity_after)
        VALUES ($1,$2,$3,$4,'quarantine_receive',0,3,3)`, [movementId, qId, ORG, WH]);

      const row = await c.query(`SELECT reason_code FROM warehouse_quarantine_stock_movements WHERE id = $1`, [movementId]);
      expect(row.rows[0].reason_code).toBe('legacy_unclassified');
    });
  });
});
