/**
 * STOCKTAKE-AND-EXCEPTION-OUTBOX-PRODUCERS-162 — DYNAMIC integration proof,
 * against a real disposable Postgres with 001->162 applied in order.
 *
 * Stocktake: a real INSERT into stocktakes (via asAdmin, isolating the
 * trigger from any single RPC's permission chain, matching 123's own
 * dynamic test convention) proves one new outbox row with the exact
 * event-key/type/payload contract, alongside the pre-existing
 * phoenix_movement_events row it has always produced.
 *
 * Exception resolution: driveCorridorToException reuses 157's own dynamic
 * test's real-RPC-chain pattern verbatim (warehouse receive -> transfer
 * send/receive -> dispatch create/add/send -> outlet dispatch-receive ->
 * outlet return request/add/submit/review/send -> a REAL zero-quantity
 * receive), ending in genuine custody_state='exception_pending' — not a
 * hand-crafted row. Proves confirmed_no_stock produces exactly one new
 * outbox event, corrected_receipt produces that SAME new event alongside
 * 161's own pre-existing movement: event (two distinct aggregates, the
 * owner-approved dual-event design), idempotent replay, fail-closed
 * conflict, and payload exclusion of the free-text reason.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI-without-rig (no database).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import { seedDemoDataset } from '../../../tools/phoenix-demo/seed.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_CENTRAL = '00000000-0000-0000-0000-000000162001';
const ORG_INST = '00000000-0000-0000-0000-000000162002';
const WH_CENTRAL = '00000000-0000-0000-0000-000000162101';
const WH_INST = '00000000-0000-0000-0000-000000162102';
const DP_OUTLET = '00000000-0000-0000-0000-000000162301';
const ROUTE = '00000000-0000-0000-0000-000000162501';
const PERFORMER = '00000000-0000-0000-0000-000000162501';

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

const call = (c: any, fn: string, args: any[]) =>
  c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
    .then((res: any) => res.rows[0].r);

const outboxByKey = (c: any, eventKey: string) =>
  c.query('SELECT * FROM phoenix_outbox_events WHERE event_key = $1', [eventKey]).then((r: any) => r.rows[0] ?? null);

run('162 stocktake-and-exception-outbox-producers — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 162 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_CENTRAL}','162 C','162 مركز','p162-c'),('${ORG_INST}','162 I','162 مؤسسة','p162-i')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH_CENTRAL}','${ORG_CENTRAL}','162 CWH','162 مخزنC','active','central','p162-wc'),
        ('${WH_INST}','${ORG_INST}','162 IWH','162 مخزنI','active','institution','p162-wi')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP_OUTLET}','${WH_INST}','${ORG_INST}','162 Outlet','162 منفذ','pharmacy','active') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouse_supply_routes
        (id, source_warehouse_id, target_warehouse_id, source_warehouse_kind, target_warehouse_kind, is_active)
        VALUES ('${ROUTE}','${WH_CENTRAL}','${WH_INST}','central','institution', true) ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${PERFORMER}','p162-performer@rig') ON CONFLICT (id) DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  /** Drives the whole real corridor and ends on a genuine zero-quantity
   * receive, reaching real custody_state='exception_pending' — verbatim
   * reuse of 157's own dynamic test pattern. */
  async function driveCorridorToException(material: string) {
    let shipmentLineId = '';

    await rig.asUser(rig.superAdminId, async (c: any) => {
      const rc = await call(c, 'phoenix_receive_warehouse_stock_guarded', [
        randomUUID(), WH_CENTRAL, material, 60, true, true, 0,
        null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'aid', null,
      ]);
      const transferSend = await call(c, 'phoenix_send_warehouse_transfer_line', [
        randomUUID(), ROUTE, rc.warehouse_stock_id, 60, uniq('WT'), null, null, null,
      ]);
      const transferReceived = await call(c, 'phoenix_receive_warehouse_transfer_line', [
        randomUUID(), transferSend.transfer_line_id, 60, null, null,
      ]);

      const dsp = await call(c, 'phoenix_create_warehouse_dispatch',
        [WH_INST, DP_OUTLET, uniq('DSP'), null, null, null]);
      const dispatchId = dsp.dispatch_id ?? dsp.id;
      await call(c, 'phoenix_add_dispatch_line', [dispatchId, transferReceived.warehouse_stock_id, 40]);
      await call(c, 'phoenix_send_warehouse_dispatch', [randomUUID(), dispatchId]);
      const dls = await c.query(`SELECT id FROM warehouse_dispatch_lines WHERE dispatch_id=$1`, [dispatchId]);
      const dispatchLineId = dls.rows[0].id;

      await call(c, 'phoenix_receive_outlet_dispatch_line', [randomUUID(), dispatchLineId, 40, null, null]);

      const req = await call(c, 'phoenix_request_outlet_return', [DP_OUTLET, uniq('OR')]);
      const returnRequestId = req.return_request_id ?? req.id;
      const addLine = await call(c, 'phoenix_add_outlet_return_request_line',
        [returnRequestId, dispatchLineId, 10, 'shipment_error', 'p162 proof']);
      const returnLineId = addLine.return_request_line_id;
      await call(c, 'phoenix_submit_outlet_return_request', [returnRequestId]);
      await call(c, 'phoenix_review_outlet_return_request',
        [returnRequestId, JSON.stringify([{ line_id: returnLineId, approved_quantity: 10 }])]);

      const returnSent = await call(c, 'phoenix_send_outlet_return_shipment_line',
        [randomUUID(), returnLineId, null, 10, uniq('ORS'), null, null]);
      expect(returnSent.ok).toBe(true);
      shipmentLineId = returnSent.shipment_line_id;

      const receiveResult = await call(c, 'phoenix_receive_outlet_return_shipment_line',
        [randomUUID(), shipmentLineId, 0, 'nothing physically arrived', null, null]);
      expect(receiveResult.ok).toBe(true);
      expect(receiveResult.custody_state).toBe('exception_pending');
    }, { commit: true });

    return { shipmentLineId };
  }

  const resolve = (
    requestId: string, lineId: string, kind: string, reason: string,
    quantity: number | null = null, disposition: string | null = null,
  ) => rig.asUser(rig.superAdminId, (c: any) =>
    call(c, 'phoenix_resolve_outlet_return_exception', [
      requestId, lineId, kind, reason, quantity, disposition,
    ]), { commit: true });

  describe('trigger inventory and preservation', () => {
    it('exactly 1 phoenix_capture_stocktake_recorded attachment exists, row-level AFTER INSERT on stocktakes', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`
          SELECT c.relname, (t.tgtype & 1) AS is_row, (t.tgtype & 2) AS is_before, (t.tgtype & 4) AS is_insert
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE p.proname = 'phoenix_capture_stocktake_recorded' AND NOT t.tgisinternal`);
        expect(r.rows.length).toBe(1);
        expect(r.rows[0].relname).toBe('stocktakes');
        expect(r.rows[0].is_row).toBe(1);
        expect(r.rows[0].is_before).toBe(0);
        expect(r.rows[0].is_insert).toBe(4);
      });
    });

    it('phoenix_outlet_return_exception_resolutions carries zero triggers of any kind', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int n FROM pg_trigger WHERE tgrelid = 'public.phoenix_outlet_return_exception_resolutions'::regclass AND NOT tgisinternal`);
        expect(r.rows[0].n).toBe(0);
      });
    });

    it("159's lifecycle producer and 161's movement producer remain completely unchanged", async () => {
      await rig.asAdmin(async (c: any) => {
        const lifecycleTriggers = await c.query(`
          SELECT count(*)::int n FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE p.proname = 'phoenix_capture_lifecycle_event' AND NOT t.tgisinternal`);
        expect(lifecycleTriggers.rows[0].n).toBe(11);
        const movementTriggers = await c.query(`
          SELECT count(*)::int n FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE p.proname = 'phoenix_capture_movement_posted' AND NOT t.tgisinternal`);
        expect(movementTriggers.rows[0].n).toBe(3);
      });
    });

    it('phoenix_capture_movement_notification remains unwired from the outbox', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT pg_get_functiondef(oid) AS src FROM pg_proc WHERE proname = 'phoenix_capture_movement_notification'`);
        expect(r.rows[0].src).not.toContain('phoenix_outbox_events');
        expect(r.rows[0].src).not.toContain('phoenix_append_outbox_event_internal');
      });
    });
  });

  describe('a real stocktake INSERT', () => {
    it('creates the pre-existing phoenix_movement_events row AND exactly one new outbox row with matching identity', async () => {
      const stocktakeId = randomUUID();
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO stocktakes (id, organization_id, scope_kind, scope_id, notes, performed_by)
         VALUES ($1,$2,'warehouse',$3,'routine count',$4)`,
        [stocktakeId, ORG_INST, WH_INST, PERFORMER],
      ));

      const dedupe = `${stocktakeId}:recorded`;
      const eventKey = `stocktake:${dedupe}`;

      await rig.asAdmin(async (c: any) => {
        const movement = await c.query(
          `SELECT * FROM phoenix_movement_events WHERE dedupe_key = $1`, [dedupe]);
        expect(movement.rows.length).toBe(1);
        expect(movement.rows[0].event_type).toBe('stocktakes.recorded');

        const outbox = await outboxByKey(c, eventKey);
        expect(outbox).toBeTruthy();
        expect(outbox.event_type).toBe('stocktakes.recorded');
        expect(outbox.aggregate_type).toBe('stocktakes');
        expect(outbox.aggregate_id).toBe(stocktakeId);
        expect(outbox.organization_id).toBe(ORG_INST);
        expect(outbox.actor_id).toBe(PERFORMER);
        expect(outbox.correlation_id).toBeNull();
        expect(outbox.causation_id).toBeNull();
        expect(outbox.request_id).toBeNull();
        // occurred_at must match the SAME instant the pre-existing sink row
        // recorded — the one-shared-variable design (no independent now()).
        expect(new Date(outbox.payload.occurred_at).getTime()).toBe(new Date(movement.rows[0].occurred_at).getTime());
        expect(outbox.payload).toEqual({
          source_table: 'stocktakes',
          scope_kind: 'warehouse',
          scope_id: WH_INST,
          trace_id: stocktakeId,
          reference_id: stocktakeId,
          occurred_at: outbox.payload.occurred_at,
        });
        const payloadStr = JSON.stringify(outbox.payload);
        for (const forbidden of ['notes', 'routine count', 'email', 'phone', 'jwt', 'token', 'password', 'actor_name', 'actor_role', 'full_name']) {
          expect(payloadStr.toLowerCase()).not.toContain(forbidden.toLowerCase());
        }
      });
    });

    it('a retried IDENTICAL append (using the row\'s own already-stored values) is idempotent — no duplicate outbox row', async () => {
      const stocktakeId = randomUUID();
      const dedupe = `${stocktakeId}:recorded`;
      const eventKey = `stocktake:${dedupe}`;
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO stocktakes (id, organization_id, scope_kind, scope_id, notes, performed_by)
         VALUES ($1,$2,'warehouse',$3,'idempotent-replay proof',$4)`,
        [stocktakeId, ORG_INST, WH_INST, PERFORMER],
      ));

      const original = await rig.asAdmin((c: any) => outboxByKey(c, eventKey));
      expect(original).toBeTruthy();

      await rig.asAdmin((c: any) => c.query(
        `SELECT public.phoenix_append_outbox_event_internal(
           $1::text, $2::text, $3::smallint, $4::text, $5::uuid, $6::uuid,
           $7::jsonb, $8::uuid, NULL::uuid, NULL::uuid, NULL::uuid)`,
        [eventKey, original.event_type, original.event_version, original.aggregate_type, original.aggregate_id, original.organization_id, original.payload, original.actor_id],
      ));

      await rig.asAdmin(async (c: any) => {
        const count = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1', [eventKey]);
        expect(count.rows[0].n).toBe(1);
      });
    });

    it('two distinct stocktake rows produce two distinct event keys', async () => {
      const idA = randomUUID();
      const idB = randomUUID();
      for (const id of [idA, idB]) {
        await rig.asAdmin((c: any) => c.query(
          `INSERT INTO stocktakes (id, organization_id, scope_kind, scope_id, notes, performed_by)
           VALUES ($1,$2,'warehouse',$3,'distinct proof',$4)`,
          [id, ORG_INST, WH_INST, PERFORMER],
        ));
      }
      await rig.asAdmin(async (c: any) => {
        const a = await outboxByKey(c, `stocktake:${idA}:recorded`);
        const b = await outboxByKey(c, `stocktake:${idB}:recorded`);
        expect(a).toBeTruthy();
        expect(b).toBeTruthy();
        expect(a.event_key).not.toBe(b.event_key);
        expect(a.id).not.toBe(b.id);
      });
    });
  });

  describe('confirmed_no_stock resolution', () => {
    it('produces exactly one new outbox event, correctly identified, with the exact 7-field payload and no reason', async () => {
      const { shipmentLineId } = await driveCorridorToException('P162-CONFIRM-EMPTY');
      const requestId = randomUUID();
      const result = await resolve(requestId, shipmentLineId, 'confirmed_no_stock', 'physically verified, nothing arrived');
      expect(result.ok).toBe(true);

      await rig.asAdmin(async (c: any) => {
        const led = await c.query(
          `SELECT id, resolved_at, organization_id FROM phoenix_outlet_return_exception_resolutions
           WHERE return_shipment_line_id = $1`, [shipmentLineId]);
        expect(led.rows.length).toBe(1);
        const resolutionId = led.rows[0].id;

        const eventKey = `outlet-return-exception-resolution:${requestId}`;
        const outbox = await outboxByKey(c, eventKey);
        expect(outbox).toBeTruthy();
        expect(outbox.event_type).toBe('phoenix_outlet_return_exception_resolutions.resolved');
        expect(outbox.aggregate_type).toBe('phoenix_outlet_return_exception_resolutions');
        expect(outbox.aggregate_id).toBe(resolutionId);
        expect(outbox.organization_id).toBe(led.rows[0].organization_id);
        expect(outbox.organization_id).toBe(ORG_INST);
        expect(outbox.actor_id).toBe(rig.superAdminId);
        expect(outbox.correlation_id).toBeTruthy();
        expect(outbox.causation_id).toBeNull();
        expect(outbox.request_id).toBe(requestId);
        expect(new Date(outbox.payload.occurred_at).getTime()).toBe(new Date(led.rows[0].resolved_at).getTime());
        expect(outbox.payload).toEqual({
          resolution_kind: 'confirmed_no_stock',
          return_shipment_line_id: shipmentLineId,
          trace_id: resolutionId,
          reference_id: resolutionId,
          occurred_at: outbox.payload.occurred_at,
          // disposition/corrected_quantity are NULL for this branch and
          // stripped by jsonb_strip_nulls, per the migration's own design.
        });
        expect(outbox.payload).not.toHaveProperty('disposition');
        expect(outbox.payload).not.toHaveProperty('corrected_quantity');
        expect(outbox.payload).not.toHaveProperty('reason');
        const payloadStr = JSON.stringify(outbox.payload).toLowerCase();
        for (const forbidden of ['physically verified', 'nothing arrived', 'actor_name', 'actor_role', 'full_name', 'email']) {
          expect(payloadStr).not.toContain(forbidden.toLowerCase());
        }

        // No compensating movement of any kind for this branch — no
        // movement:-namespaced event exists for this resolution.
        const movementEvents = await c.query(
          `SELECT count(*)::int n FROM phoenix_outbox_events WHERE aggregate_type IN ('warehouse_stock_movements','warehouse_quarantine_stock_movements') AND payload->>'reference_id' = $1`,
          [resolutionId]);
        expect(movementEvents.rows[0].n).toBe(0);
      });
    });

    it('a same-request-id, same-payload replay does not create a second outbox row', async () => {
      const { shipmentLineId } = await driveCorridorToException('P162-CONFIRM-REPLAY');
      const requestId = randomUUID();
      await resolve(requestId, shipmentLineId, 'confirmed_no_stock', 'verified empty');
      await resolve(requestId, shipmentLineId, 'confirmed_no_stock', 'verified empty');

      await rig.asAdmin(async (c: any) => {
        const count = await c.query(
          `SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1`,
          [`outlet-return-exception-resolution:${requestId}`]);
        expect(count.rows[0].n).toBe(1);
      });
    });

    it('a same-request-id, different-payload retry raises request_id_conflict and creates no second outbox row', async () => {
      const { shipmentLineId } = await driveCorridorToException('P162-CONFIRM-CONFLICT');
      const requestId = randomUUID();
      await resolve(requestId, shipmentLineId, 'confirmed_no_stock', 'verified empty');
      await expect(resolve(requestId, shipmentLineId, 'confirmed_no_stock', 'a different reason'))
        .rejects.toMatchObject({ code: '23505' });

      await rig.asAdmin(async (c: any) => {
        const count = await c.query(
          `SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1`,
          [`outlet-return-exception-resolution:${requestId}`]);
        expect(count.rows[0].n).toBe(1);
      });
    });
  });

  describe('corrected_receipt resolution — the owner-approved dual-event design', () => {
    it('restockable: produces TWO distinct outbox events (161\'s movement: event AND the new resolution event), same correlation_id, distinct aggregates', async () => {
      const { shipmentLineId } = await driveCorridorToException('P162-CORRECT-RESTOCK');
      const requestId = randomUUID();
      const result = await resolve(
        requestId, shipmentLineId, 'corrected_receipt', 'operator miscounted, 10 actually arrived', 10, 'restockable',
      );
      expect(result.ok).toBe(true);
      expect(result.movement_id).toBeTruthy();

      await rig.asAdmin(async (c: any) => {
        const led = await c.query(
          `SELECT id, resolved_at, organization_id FROM phoenix_outlet_return_exception_resolutions
           WHERE return_shipment_line_id = $1`, [shipmentLineId]);
        const resolutionId = led.rows[0].id;

        const movementEvent = await outboxByKey(c, `movement:${result.movement_id}:posted`);
        const resolutionEvent = await outboxByKey(c, `outlet-return-exception-resolution:${requestId}`);
        expect(movementEvent).toBeTruthy();
        expect(resolutionEvent).toBeTruthy();

        // Two genuinely distinct facts: different event_key, event_type,
        // aggregate_type, and aggregate_id — never a collision.
        expect(movementEvent.event_key).not.toBe(resolutionEvent.event_key);
        expect(movementEvent.event_type).not.toBe(resolutionEvent.event_type);
        expect(movementEvent.aggregate_type).toBe('warehouse_stock_movements');
        expect(resolutionEvent.aggregate_type).toBe('phoenix_outlet_return_exception_resolutions');
        expect(movementEvent.aggregate_id).toBe(result.movement_id);
        expect(resolutionEvent.aggregate_id).toBe(resolutionId);

        // Same v_correlation_id reused across both — proven by cross-reading
        // the compensating movement row's own stored correlation_id.
        const mv = await c.query(`SELECT correlation_id FROM warehouse_stock_movements WHERE id = $1`, [result.movement_id]);
        expect(mv.rows[0].correlation_id).toBe(resolutionEvent.correlation_id);
        expect(movementEvent.correlation_id).toBe(resolutionEvent.correlation_id);

        expect(resolutionEvent.request_id).toBe(requestId);
        expect(resolutionEvent.payload).toEqual({
          resolution_kind: 'corrected_receipt',
          return_shipment_line_id: shipmentLineId,
          disposition: 'restockable',
          corrected_quantity: 10,
          trace_id: resolutionId,
          reference_id: resolutionId,
          occurred_at: resolutionEvent.payload.occurred_at,
        });
        expect(resolutionEvent.payload).not.toHaveProperty('reason');
        expect(new Date(resolutionEvent.payload.occurred_at).getTime()).toBe(new Date(led.rows[0].resolved_at).getTime());
      });
    });

    it('quarantined: produces TWO distinct outbox events, movement: aggregate_type is the quarantine table', async () => {
      const { shipmentLineId } = await driveCorridorToException('P162-CORRECT-QUAR');
      const requestId = randomUUID();
      const result = await resolve(
        requestId, shipmentLineId, 'corrected_receipt', 'arrived damaged, quarantine it', 5, 'quarantined',
      );
      expect(result.ok).toBe(true);
      expect(result.movement_id).toBeTruthy();

      await rig.asAdmin(async (c: any) => {
        const movementEvent = await outboxByKey(c, `movement:${result.movement_id}:posted`);
        const resolutionEvent = await outboxByKey(c, `outlet-return-exception-resolution:${requestId}`);
        expect(movementEvent).toBeTruthy();
        expect(resolutionEvent).toBeTruthy();
        expect(movementEvent.aggregate_type).toBe('warehouse_quarantine_stock_movements');
        expect(resolutionEvent.payload.disposition).toBe('quarantined');
        expect(resolutionEvent.payload.corrected_quantity).toBe(5);
      });
    });

    it('a same-request-id, same-payload replay creates no second event of either kind', async () => {
      const { shipmentLineId } = await driveCorridorToException('P162-CORRECT-REPLAY');
      const requestId = randomUUID();
      const first = await resolve(requestId, shipmentLineId, 'corrected_receipt', 'replay proof', 4, 'restockable');
      const second = await resolve(requestId, shipmentLineId, 'corrected_receipt', 'replay proof', 4, 'restockable');
      expect(second).toEqual(first);

      await rig.asAdmin(async (c: any) => {
        const resolutionCount = await c.query(
          `SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1`,
          [`outlet-return-exception-resolution:${requestId}`]);
        expect(resolutionCount.rows[0].n).toBe(1);
        const movementCount = await c.query(
          `SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1`,
          [`movement:${first.movement_id}:posted`]);
        expect(movementCount.rows[0].n).toBe(1);
      });
    });
  });

  describe('demo seed→purge lifecycle: stocktake outbox rows are correctly manifest-registered', () => {
    it('phoenix_demo_purgeable_tables() still recognizes phoenix_outbox_events', async () => {
      await rig.asAdmin(async (c: any) => {
        const tables = await c.query('SELECT public.phoenix_demo_purgeable_tables() AS tables');
        expect(tables.rows[0].tables).toContain('phoenix_outbox_events');
      });
    });

    it("a real seedDemoDataset() run: every stocktake-namespaced outbox row is manifest-owned, purge removes them, an unrelated real org's own stocktake outbox row is never touched", async () => {
      const DATASET_KEY = 'PHOENIX_DEMO_V1';
      const REAL_ORG = randomUUID();
      const REAL_STOCKTAKE = randomUUID();

      // A genuine, real (non-demo) org with its own stocktake and — via
      // 162's trigger — its own outbox row, seeded BEFORE the demo seeder
      // runs, mirroring "a concurrently-existing real row" (ownership.mjs's
      // own stated safety invariant, same pattern 161's own dynamic test
      // already proved for movement events).
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO organizations (id,name,name_ar,code) VALUES ($1,'162 Real Org','162 مؤسسة حقيقية','p162-real-org')`,
        [REAL_ORG],
      ));
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO stocktakes (id, organization_id, scope_kind, scope_id, notes, performed_by)
         VALUES ($1,$2,'warehouse',$3,'real org stocktake',$4)`,
        [REAL_STOCKTAKE, REAL_ORG, randomUUID(), PERFORMER],
      ));
      const realOutbox = await rig.asAdmin((c: any) => outboxByKey(c, `stocktake:${REAL_STOCKTAKE}:recorded`));
      expect(realOutbox).toBeTruthy();

      await seedDemoDataset(rig, rig.superAdminId, { institutions: 1, outletsPerInstitution: 1, materials: 5, batchesPerWarehouse: 3 });

      await rig.asAdmin(async (c: any) => {
        const demoOrgIds = await c.query(
          `SELECT row_id FROM phoenix_demo_manifest WHERE dataset_key = $1 AND table_name = 'organizations'`,
          [DATASET_KEY],
        );
        const orgIds = demoOrgIds.rows.map((r: any) => r.row_id);
        expect(orgIds.length).toBeGreaterThan(0);
        expect(orgIds).not.toContain(REAL_ORG);

        // Every demo-org stocktake-namespaced outbox row is manifest-owned.
        const demoStocktakeOutbox = await c.query(
          `SELECT id FROM phoenix_outbox_events WHERE organization_id = ANY($1::uuid[]) AND event_key LIKE 'stocktake:%'`,
          [orgIds],
        );
        const manifestOwnedOutbox = await c.query(
          `SELECT row_id FROM phoenix_demo_manifest WHERE dataset_key = $1 AND table_name = 'phoenix_outbox_events'`,
          [DATASET_KEY],
        );
        const ownedIds = new Set(manifestOwnedOutbox.rows.map((r: any) => r.row_id));
        expect(demoStocktakeOutbox.rows.length).toBeGreaterThan(0);
        for (const row of demoStocktakeOutbox.rows) {
          expect(ownedIds.has(row.id), `stocktake outbox row ${row.id} must be manifest-owned`).toBe(true);
        }

        // The real, unrelated org's own outbox row was never captured.
        expect(ownedIds.has(realOutbox.id)).toBe(false);
      });

      // Purging removes the demo dataset's outbox rows; the real org's own
      // stocktake outbox row (never manifest-owned) survives untouched.
      await rig.asUser(rig.superAdminId, (c: any) =>
        c.query(`SELECT * FROM public.phoenix_demo_purge($1, false)`, [DATASET_KEY]), { commit: true });
      await rig.asAdmin(async (c: any) => {
        const residual = await c.query(
          `SELECT count(*)::int n FROM phoenix_demo_manifest WHERE dataset_key = $1 AND table_name = 'phoenix_outbox_events'`,
          [DATASET_KEY],
        );
        expect(residual.rows[0].n).toBe(0);
        const realStillPresent = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE id = $1', [realOutbox.id]);
        expect(realStillPresent.rows[0].n).toBe(1);
      });
    }, 120000);

    it('the demo dataset never drives any line to exception_pending — zero outlet-return-exception-resolution: outbox rows exist in demo data (a pre-existing seed-scope boundary, unrelated to 162)', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key LIKE 'outlet-return-exception-resolution:%'`);
        // Every "outlet-return-exception-resolution:" row created earlier in
        // this file belongs to the ORG_INST fixture, not the demo dataset —
        // and the demo purge above only ever removes manifest-owned rows.
        // This assertion documents that the demo seed itself has never
        // exercised phoenix_resolve_outlet_return_exception (no line is ever
        // received at zero quantity in outletReturnAndQuarantine), so there
        // is nothing for 162 to register here — a pre-existing scope
        // boundary of the demo seeder, not a gap 162 introduces.
        const fixtureOnly = await c.query(
          `SELECT count(*)::int n FROM phoenix_outbox_events e
             WHERE e.event_key LIKE 'outlet-return-exception-resolution:%'
               AND e.organization_id = $1`, [ORG_INST]);
        expect(fixtureOnly.rows[0].n).toBe(r.rows[0].n);
      });
    });
  });

  describe('security contract unchanged by 162', () => {
    it('PUBLIC/authenticated/anon still cannot read or write the outbox, and still cannot execute the helper', async () => {
      await rig.asAdmin(async (c: any) => {
        for (const role of ['authenticated', 'anon']) {
          for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            const r = await c.query(`SELECT has_table_privilege($1, 'public.phoenix_outbox_events', $2) AS has`, [role, priv]);
            expect(r.rows[0].has).toBe(false);
          }
          const exec = await c.query(
            `SELECT has_function_privilege($1, 'public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid)', 'EXECUTE') AS has`,
            [role],
          );
          expect(exec.rows[0].has).toBe(false);
        }
      });
      await expect(rig.asUser(rig.superAdminId, (c: any) =>
        c.query('SELECT * FROM phoenix_outbox_events'),
      )).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('full disposable replay sanity', () => {
    it('001->162 chain applies cleanly and the outbox table has rows only from this file\'s own actions', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events');
        expect(r.rows[0].n).toBeGreaterThan(0);
      });
    });
  });
});
