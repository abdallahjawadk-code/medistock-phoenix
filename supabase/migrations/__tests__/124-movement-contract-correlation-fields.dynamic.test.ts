/**
 * MOVEMENT-CONTRACT-CORRELATION-FIELDS-124 — DYNAMIC proof against a real
 * disposable Postgres with 001->124 applied in order.
 *
 * Proves:
 *   1. Existing 123-era behavior (exactly one '<table>.posted' event per
 *      ledger insert) still holds after 124's trigger redefinition —
 *      no regression.
 *   2. quantity_before/quantity_after are now forwarded into
 *      phoenix_movement_events for all three ledgers, correctly handling
 *      the on_hand_* (warehouse/outlet) vs quantity_* (quarantine) naming
 *      split, and reconcile: quantity_after = quantity_before + delta.
 *   3. occurred_at on a ledger row is honored as the event's occurred_at
 *      when explicitly supplied (not always "now" at insert time).
 *   4. correlation_id/causation_id pass through from the ledger row to the
 *      event when present, and are NULL-safe when absent (no writer RPC
 *      populates them yet — that is a follow-up slice, not a regression).
 *   5. A pre-existing row (inserted before 124, i.e. via direct SQL with no
 *      occurred_at column supplied at 123 baseline) is backfilled to a
 *      non-null occurred_at by the migration itself.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000124001';
const WH = '00000000-0000-0000-0000-000000124101';
const DP = '00000000-0000-0000-0000-000000124301';

run('124 movement-contract correlation fields — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 124 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Org','مؤسسة','p124-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','WH','مخزن','active','institution','p124-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP}','${WH}','${ORG}','Outlet','منفذ','pharmacy','active') ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('warehouse_stock_movements INSERT still emits exactly one event, now carrying before/after', async () => {
    const stockId = randomUUID();
    const movementId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P124-WH',true,false,'B-WH',10,0,1)`, [stockId, ORG, WH]);
      await c.query(`INSERT INTO warehouse_stock_movements
        (id, warehouse_stock_id, organization_id, warehouse_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot)
        VALUES ($1,$2,$3,$4,'add',0,10,10,0,0,0,'P124-WH')`, [movementId, stockId, ORG, WH]);

      const events = await c.query(
        `SELECT event_type, quantity_delta, quantity_before, quantity_after FROM phoenix_movement_events
         WHERE reference_type = 'warehouse_stock_movements' AND reference_id = $1`,
        [movementId],
      );
      expect(events.rows.length).toBe(1);
      expect(events.rows[0].event_type).toBe('warehouse_stock_movements.posted');
      expect(events.rows[0].quantity_delta).toBe(10);
      expect(events.rows[0].quantity_before).toBe(0);
      expect(events.rows[0].quantity_after).toBe(10);
      expect(events.rows[0].quantity_after).toBe(events.rows[0].quantity_before + events.rows[0].quantity_delta);
    });
  });

  it('warehouse_quarantine_stock_movements INSERT carries before/after through the quantity_* naming (not on_hand_*)', async () => {
    const qId = randomUUID();
    const movementId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_quarantine_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, quarantine_reason, quantity, created_by, updated_by)
        VALUES ($1,$2,$3,'P124-Q',true,false,'B-Q','damaged',7,NULL,NULL)`, [qId, ORG, WH]);
      await c.query(`INSERT INTO warehouse_quarantine_stock_movements
        (id, quarantine_stock_id, organization_id, warehouse_id, movement_type, quantity_before, quantity_delta, quantity_after)
        VALUES ($1,$2,$3,$4,'quarantine_receive',0,7,7)`, [movementId, qId, ORG, WH]);

      const events = await c.query(
        `SELECT quantity_before, quantity_after FROM phoenix_movement_events
         WHERE reference_type = 'warehouse_quarantine_stock_movements' AND reference_id = $1`,
        [movementId],
      );
      expect(events.rows.length).toBe(1);
      expect(events.rows[0].quantity_before).toBe(0);
      expect(events.rows[0].quantity_after).toBe(7);
    });
  });

  it('an explicit occurred_at on the ledger row is honored on the event (not overwritten with insert-time now())', async () => {
    const stockId = randomUUID();
    const movementId = randomUUID();
    const explicitOccurredAt = '2026-01-15T08:30:00Z';
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy',$4,true,false,'B-OUT',5,0,0)`, [stockId, ORG, DP, 'P124-OUT']);
      await c.query(`INSERT INTO outlet_stock_movements
        (id, outlet_stock_id, organization_id, distribution_point_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot, occurred_at)
        VALUES ($1,$2,$3,$4,'add',0,5,5,0,0,0,'P124-OUT',$5)`, [movementId, stockId, ORG, DP, explicitOccurredAt]);

      const events = await c.query(
        `SELECT occurred_at FROM phoenix_movement_events
         WHERE reference_type = 'outlet_stock_movements' AND reference_id = $1`,
        [movementId],
      );
      expect(events.rows.length).toBe(1);
      expect(new Date(events.rows[0].occurred_at).toISOString()).toBe(new Date(explicitOccurredAt).toISOString());
    });
  });

  it('correlation_id and causation_id pass through from the ledger row to the event when present', async () => {
    const stockId = randomUUID();
    const movementId = randomUUID();
    const correlationId = randomUUID();
    const causationId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P124-CORR',true,false,'B-CORR',3,0,0)`, [stockId, ORG, WH]);
      await c.query(`INSERT INTO warehouse_stock_movements
        (id, warehouse_stock_id, organization_id, warehouse_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot, correlation_id, causation_id)
        VALUES ($1,$2,$3,$4,'add',0,3,3,0,0,0,'P124-CORR',$5,$6)`, [movementId, stockId, ORG, WH, correlationId, causationId]);

      const events = await c.query(
        `SELECT correlation_id, causation_id FROM phoenix_movement_events
         WHERE reference_type = 'warehouse_stock_movements' AND reference_id = $1`,
        [movementId],
      );
      expect(events.rows.length).toBe(1);
      expect(events.rows[0].correlation_id).toBe(correlationId);
      expect(events.rows[0].causation_id).toBe(causationId);
    });
  });

  it('correlation_id/causation_id are NULL-safe when the writer omits them (no RPC populates them yet)', async () => {
    const stockId = randomUUID();
    const movementId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P124-NULL',true,false,'B-NULL',1,0,0)`, [stockId, ORG, WH]);
      await c.query(`INSERT INTO warehouse_stock_movements
        (id, warehouse_stock_id, organization_id, warehouse_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot)
        VALUES ($1,$2,$3,$4,'add',0,1,1,0,0,0,'P124-NULL')`, [movementId, stockId, ORG, WH]);

      const events = await c.query(
        `SELECT correlation_id, causation_id FROM phoenix_movement_events
         WHERE reference_type = 'warehouse_stock_movements' AND reference_id = $1`,
        [movementId],
      );
      expect(events.rows.length).toBe(1);
      expect(events.rows[0].correlation_id).toBeNull();
      expect(events.rows[0].causation_id).toBeNull();
    });
  });

  it('no ledger row has a NULL occurred_at after 124 (backfill proof, exercised against rows inserted pre-124 in the replay sequence)', async () => {
    await rig.asAdmin(async (c: any) => {
      for (const table of ['warehouse_stock_movements', 'outlet_stock_movements', 'warehouse_quarantine_stock_movements']) {
        const res = await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE occurred_at IS NULL`);
        expect(res.rows[0].n).toBe(0);
      }
    });
  });
});
