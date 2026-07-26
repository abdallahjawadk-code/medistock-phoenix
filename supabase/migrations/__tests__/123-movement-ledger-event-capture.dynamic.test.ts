/**
 * MOVEMENT-LEDGER-EVENT-CAPTURE-123 — DYNAMIC proof against a real
 * disposable Postgres with 001->123 applied in order.
 *
 * Proves the two gaps 123 closes, and the no-duplicate-event claim in its
 * own header comment:
 *
 *   1. Inserting into each of the three live quantity ledgers
 *      (warehouse_stock_movements, outlet_stock_movements,
 *      warehouse_quarantine_stock_movements) produces exactly one
 *      '<table>.posted' phoenix_movement_events row, correctly org-scoped,
 *      with quantity_delta carried through from the ledger row.
 *   2. Inserting a stocktakes row produces a 'stocktakes.recorded' event.
 *   3. A header-transition event (122's correction-request coverage, or
 *      082's corridor headers) and a movement-posted event for a DIFFERENT
 *      underlying row never collide on dedupe_key — both persist as
 *      distinct, independently readable facts.
 *   4. item_availability_movements remains untouched by this migration (no
 *      trigger attached) — confirms the explicit scope-out.
 *
 * The trigger fires on INSERT regardless of caller — this file inserts
 * directly (asAdmin) to isolate the trigger's own behavior from any single
 * RPC's permission chain, which is proven independently elsewhere.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000123001';
const WH = '00000000-0000-0000-0000-000000123101';
const DP = '00000000-0000-0000-0000-000000123301';

run('123 movement-ledger event capture — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 123 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','Org','مؤسسة','p123-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','WH','مخزن','active','institution','p123-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP}','${WH}','${ORG}','Outlet','منفذ','pharmacy','active') ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  it('warehouse_stock_movements INSERT emits exactly one warehouse_stock_movements.posted event', async () => {
    const stockId = randomUUID();
    const movementId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'P123-WH',true,false,'B-WH',10,0,1)`, [stockId, ORG, WH]);
      await c.query(`INSERT INTO warehouse_stock_movements
        (id, warehouse_stock_id, organization_id, warehouse_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot)
        VALUES ($1,$2,$3,$4,'add',0,10,10,0,0,0,'P123-WH')`, [movementId, stockId, ORG, WH]);

      const events = await c.query(
        `SELECT event_type, quantity_delta, organization_id FROM phoenix_movement_events
         WHERE reference_type = 'warehouse_stock_movements' AND reference_id = $1`,
        [movementId],
      );
      expect(events.rows.length).toBe(1);
      expect(events.rows[0].event_type).toBe('warehouse_stock_movements.posted');
      expect(events.rows[0].quantity_delta).toBe(10);
      expect(events.rows[0].organization_id).toBe(ORG);
    });
  });

  it('outlet_stock_movements INSERT emits exactly one outlet_stock_movements.posted event', async () => {
    const stockId = randomUUID();
    const movementId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy',$4,true,false,'B-OUT',5,0,0)`, [stockId, ORG, DP, 'P123-OUT']);
      await c.query(`INSERT INTO outlet_stock_movements
        (id, outlet_stock_id, organization_id, distribution_point_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot)
        VALUES ($1,$2,$3,$4,'add',0,5,5,0,0,0,'P123-OUT')`, [movementId, stockId, ORG, DP]);

      const events = await c.query(
        `SELECT event_type, quantity_delta FROM phoenix_movement_events
         WHERE reference_type = 'outlet_stock_movements' AND reference_id = $1`,
        [movementId],
      );
      expect(events.rows.length).toBe(1);
      expect(events.rows[0].event_type).toBe('outlet_stock_movements.posted');
      expect(events.rows[0].quantity_delta).toBe(5);
    });
  });

  it('warehouse_quarantine_stock_movements INSERT emits exactly one .posted event (quantity_delta shape)', async () => {
    const qId = randomUUID();
    const movementId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO warehouse_quarantine_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, quarantine_reason, quantity, created_by, updated_by)
        VALUES ($1,$2,$3,'P123-Q',true,false,'B-Q','damaged',7,NULL,NULL)`, [qId, ORG, WH]);
      await c.query(`INSERT INTO warehouse_quarantine_stock_movements
        (id, quarantine_stock_id, organization_id, warehouse_id, movement_type, quantity_before, quantity_delta, quantity_after)
        VALUES ($1,$2,$3,$4,'quarantine_receive',0,7,7)`, [movementId, qId, ORG, WH]);

      const events = await c.query(
        `SELECT event_type, quantity_delta FROM phoenix_movement_events
         WHERE reference_type = 'warehouse_quarantine_stock_movements' AND reference_id = $1`,
        [movementId],
      );
      expect(events.rows.length).toBe(1);
      expect(events.rows[0].event_type).toBe('warehouse_quarantine_stock_movements.posted');
      expect(events.rows[0].quantity_delta).toBe(7);
    });
  });

  it('stocktakes INSERT emits a stocktakes.recorded event', async () => {
    const stocktakeId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${'00000000-0000-0000-0000-000000123501'}','p123-performer@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO stocktakes (id, organization_id, scope_kind, scope_id, notes, performed_by)
        VALUES ($1,$2,'warehouse',$3,'routine count','00000000-0000-0000-0000-000000123501')`,
        [stocktakeId, ORG, WH]);

      const events = await c.query(
        `SELECT event_type, reference_type FROM phoenix_movement_events WHERE reference_id = $1`,
        [stocktakeId],
      );
      expect(events.rows.length).toBe(1);
      expect(events.rows[0].event_type).toBe('stocktakes.recorded');
      expect(events.rows[0].reference_type).toBe('stocktakes');
    });
  });

  it('a header-transition event and a movement-posted event for a different row never collide (no dedupe_key overwrite)', async () => {
    // Reuses 122's correction-request coverage to produce a header event,
    // then a movement-ledger insert to produce a movement event, and proves
    // both persist independently even though both trigger paths write into
    // the same phoenix_movement_events table with the same ON CONFLICT
    // dedupe clause.
    const stockId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
        VALUES ($1,$2,$3,'pharmacy','P123-DUP',true,false,'B-DUP',10,0,0)`, [stockId, ORG, DP]);
    });

    const correctionId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('00000000-0000-0000-0000-000000123502','p123-proposer@rig') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO phoenix_stock_correction_requests
        (id, organization_id, outlet_stock_id, on_hand_before, counted_quantity, variance, reason, proposed_by, underlying_request_id)
        VALUES ($1,$2,$3,10,8,-2,'count',$4,$5)`,
        [correctionId, ORG, stockId, '00000000-0000-0000-0000-000000123502', randomUUID()]);
    });

    const movementId = randomUUID();
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO outlet_stock_movements
        (id, outlet_stock_id, organization_id, distribution_point_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot, reason)
        VALUES ($1,$2,$3,$4,'correction',10,-2,8,0,0,0,'P123-DUP','stock count correction')`, [movementId, stockId, ORG, DP]);
    });

    await rig.asAdmin(async (c: any) => {
      const headerEvent = await c.query(
        `SELECT dedupe_key FROM phoenix_movement_events WHERE reference_type = 'phoenix_stock_correction_requests' AND reference_id = $1`,
        [correctionId],
      );
      const movementEvent = await c.query(
        `SELECT dedupe_key FROM phoenix_movement_events WHERE reference_type = 'outlet_stock_movements' AND reference_id = $1`,
        [movementId],
      );
      expect(headerEvent.rows.length).toBe(1);
      expect(movementEvent.rows.length).toBe(1);
      expect(headerEvent.rows[0].dedupe_key).not.toBe(movementEvent.rows[0].dedupe_key);
    });
  });

  it('item_availability_movements has no capture trigger (explicitly out of scope — dead writer)', async () => {
    await rig.asAdmin(async (c: any) => {
      const triggers = await c.query(
        `SELECT t.tgname FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid
         WHERE cl.relname = 'item_availability_movements' AND NOT t.tgisinternal`,
      );
      expect(triggers.rows.map((r: any) => r.tgname)).toEqual([]);
    });
  });
});
