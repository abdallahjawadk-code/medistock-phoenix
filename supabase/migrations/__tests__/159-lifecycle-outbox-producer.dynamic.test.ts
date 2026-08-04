/**
 * LIFECYCLE-OUTBOX-PRODUCER-159 — DYNAMIC integration proof, against a real
 * disposable Postgres with 001->159 applied in order.
 *
 * Every one of the 11 phoenix_capture_lifecycle-attached tables is proven,
 * individually, to still carry the exact same trigger via a dynamic query
 * (this file) AND via the static test's exhaustive per-table VERIFY-block
 * assertions (159-lifecycle-outbox-producer-static.test.ts) — the "complete
 * static trigger/table contract" half of this migration's own coverage
 * requirement. Full behavioral proof (one outbox row per accepted
 * transition, conflict/rollback, concurrency-adjacent idempotency) is
 * exercised on two representative tables chosen to cover the two distinct
 * home-organization-resolution shapes that exist among the eleven:
 *   - procurement_orders (099-era): single organization_id, simplest schema.
 *   - warehouse_transfer_requests (082-era): dual source/destination org,
 *     the ONE exception keyed off destination_organization_id (155's own
 *     header comment) — also the table used to prove no counterparty
 *     exposure (item 23).
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI-without-rig (no database).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const CENTRAL_ORG = '00000000-0000-0000-0000-000000159001';
const INST_ORG = '00000000-0000-0000-0000-000000159002';
const CENTRAL_WH = '00000000-0000-0000-0000-000000159101';
const INST_WH = '00000000-0000-0000-0000-000000159102';
const ROUTE = '00000000-0000-0000-0000-000000159201';
const SUPPLIER = '00000000-0000-0000-0000-000000159301';
let seq = 0;

const outboxByKey = (c: any, eventKey: string) =>
  c.query('SELECT * FROM phoenix_outbox_events WHERE event_key = $1', [eventKey]).then((r: any) => r.rows[0] ?? null);

const movementByDedupe = (c: any, dedupe: string) =>
  c.query('SELECT * FROM phoenix_movement_events WHERE dedupe_key = $1', [dedupe]).then((r: any) => r.rows[0] ?? null);

const notificationByDedupe = (c: any, dedupe: string) =>
  c.query('SELECT * FROM phoenix_notifications WHERE dedupe_key = $1', [dedupe]).then((r: any) => r.rows[0] ?? null);

const seedProcurementOrder = async (rig: Awaited<ReturnType<typeof buildRig>>) => {
  const id = randomUUID();
  const tag = `P159PO-${Date.now()}-${seq++}`;
  await rig.asAdmin((c: any) => c.query(
    `INSERT INTO procurement_orders (id, organization_id, warehouse_id, supplier_id, order_number, status, created_by)
     VALUES ($1,$2,$3,$4,$5,'draft',$6)`,
    [id, CENTRAL_ORG, CENTRAL_WH, SUPPLIER, tag, rig.superAdminId],
  ));
  return id;
};

const seedTransferRequest = async (rig: Awaited<ReturnType<typeof buildRig>>) => {
  const id = randomUUID();
  const tag = `P159WTR-${Date.now()}-${seq++}`;
  await rig.asAdmin((c: any) => c.query(
    `INSERT INTO warehouse_transfer_requests
       (id, route_id, source_warehouse_id, source_organization_id, destination_warehouse_id, destination_organization_id, request_number, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'draft')`,
    [id, ROUTE, CENTRAL_WH, CENTRAL_ORG, INST_WH, INST_ORG, tag],
  ));
  return id;
};

// The lifecycle trigger fires regardless of which role performs the row
// mutation (it is SECURITY DEFINER and does its own auth.uid() resolution
// inside), but every one of these 11 tables is written only through RPCs in
// production — authenticated/anon have no direct table grant at all (that
// same lockdown, e.g. 154's, is exactly what this repository's RBAC model
// depends on). Driving the trigger directly therefore has to run as the
// admin/superuser connection (real table privileges) while still setting
// request.jwt.claim.sub so auth.uid() resolves to a real actor, matching
// how phoenix_capture_lifecycle_event() itself reads it — asUser's role
// switch to `authenticated` is the wrong tool for this, since that role was
// never granted UPDATE on any of these tables to begin with.
// Owns the connection directly (not via asAdmin's fire-and-release) so an
// aborted transaction (e.g. the UPDATE itself raising outbox_event_key_
// conflict) can be explicitly ROLLBACK'd before the connection returns to
// the pool — otherwise a poisoned "current transaction is aborted"
// connection fails every later test that happens to borrow it back.
const updateStatusAsActor = async (
  rig: Awaited<ReturnType<typeof buildRig>>,
  table: string,
  id: string,
  newStatus: string,
  actorId: string | null,
) => {
  const client = await rig.pool.connect();
  try {
    await client.query('BEGIN');
    if (actorId) {
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [actorId]);
    }
    await client.query(`UPDATE ${table} SET status = $1 WHERE id = $2`, [newStatus, id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

run('159 lifecycle-outbox producer — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 159 });
    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO organizations(id,name,name_ar,code) VALUES('${CENTRAL_ORG}','159 Central','159 Central','p159-central');
      INSERT INTO organizations(id,name,name_ar,code) VALUES('${INST_ORG}','159 Institution','159 Institution','p159-inst');
      INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code)
        VALUES('${CENTRAL_WH}','${CENTRAL_ORG}','Central WH','Central WH','active','central','p159-cwh');
      INSERT INTO warehouses(id,organization_id,name,name_ar,status,warehouse_kind,code)
        VALUES('${INST_WH}','${INST_ORG}','Institution WH','Institution WH','active','institution','p159-iwh');
      INSERT INTO warehouse_supply_routes(id,source_warehouse_id,target_warehouse_id)
        VALUES('${ROUTE}','${CENTRAL_WH}','${INST_WH}');
      INSERT INTO procurement_suppliers(id,organization_id,name)
        VALUES('${SUPPLIER}','${CENTRAL_ORG}','159 Test Supplier');
    `));
  }, 120000);

  afterAll(async () => { if (rig) await rig.end(); });

  describe('trigger inventory — all 11 attachments individually confirmed', () => {
    it('exactly 11 phoenix_capture_lifecycle attachments exist, none new, none missing', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`
          SELECT c.relname FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE p.proname = 'phoenix_capture_lifecycle_event' AND NOT t.tgisinternal
          ORDER BY c.relname`);
        expect(r.rows.map((row: any) => row.relname)).toEqual([
          'inventory_status_reports', 'outlet_return_requests', 'outlet_return_shipments',
          'phoenix_stock_correction_requests', 'phoenix_warehouse_correction_requests',
          'procurement_orders', 'warehouse_dispatches', 'warehouse_return_requests',
          'warehouse_return_shipments', 'warehouse_transfer_requests', 'warehouse_transfers',
        ]);
      });
    });

    it('applying the chain through 159 alone produces zero outbox rows', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events');
        expect(r.rows[0].n).toBe(0);
      });
    });

    it('the other three capture functions remain unwired from the outbox', async () => {
      await rig.asAdmin(async (c: any) => {
        for (const fn of ['phoenix_capture_movement_posted', 'phoenix_capture_movement_notification', 'phoenix_capture_stocktake_recorded']) {
          const r = await c.query('SELECT pg_get_functiondef(oid) AS src FROM pg_proc WHERE proname = $1', [fn]);
          expect(r.rows[0].src).not.toContain('phoenix_outbox_events');
          expect(r.rows[0].src).not.toContain('phoenix_append_outbox_event_internal');
        }
      });
    });
  });

  describe('a real accepted transition on procurement_orders (single-org, 099-era)', () => {
    it('creates the same existing movement/notification rows AND exactly one outbox row with matching identity', async () => {
      const id = await seedProcurementOrder(rig);
      await updateStatusAsActor(rig, 'procurement_orders', id, 'submitted', rig.superAdminId);

      const dedupe = `${id}:submitted`;
      const eventKey = `lifecycle:${dedupe}`;
      const eventType = 'procurement_orders.submitted';

      await rig.asAdmin(async (c: any) => {
        const movement = await movementByDedupe(c, dedupe);
        const notification = await notificationByDedupe(c, dedupe);
        const outbox = await outboxByKey(c, eventKey);

        expect(movement).toBeTruthy();
        expect(notification).toBeTruthy();
        expect(outbox).toBeTruthy();

        // item 7: outbox event_type == existing lifecycle event_type
        expect(outbox.event_type).toBe(eventType);
        expect(movement.event_type).toBe(eventType);
        // item 8: outbox organization_id == existing lifecycle organization_id
        expect(outbox.organization_id).toBe(movement.organization_id);
        expect(outbox.organization_id).toBe(CENTRAL_ORG);
        // item 9: outbox actor_id == existing lifecycle actor_id
        expect(outbox.actor_id).toBe(movement.actor_id);
        expect(outbox.actor_id).toBe(rig.superAdminId);
        // item 10/11: aggregate_type/aggregate_id
        expect(outbox.aggregate_type).toBe('procurement_orders');
        expect(outbox.aggregate_id).toBe(id);
        // item 12: event_key formula
        expect(outbox.event_key).toBe(eventKey);
        // item 13/14: payload — only approved fields, nothing prohibited
        expect(outbox.payload).toEqual({
          source_table: 'procurement_orders',
          old_status: 'draft',
          new_status: 'submitted',
          trace_id: id,
          reference_id: id,
        });
        const payloadStr = JSON.stringify(outbox.payload);
        for (const forbidden of ['email', 'phone', 'jwt', 'token', 'password', 'auth.users', 'actor_name', 'actor_role', 'full_name']) {
          expect(payloadStr.toLowerCase()).not.toContain(forbidden);
        }
      });
    });

    it('a status-preserving update (no real transition) creates zero new movement/notification/outbox rows', async () => {
      // NOTE: the trigger is AFTER INSERT OR UPDATE (082, unchanged by 159),
      // so seeding a row with status='draft' already fires its own genuine
      // "no-status -> draft" transition and its own outbox row
      // (lifecycle:{id}:draft) — that is pre-existing behavior, not
      // introduced by 159, and irrelevant to what this test is proving.
      // Assertions below are scoped to the SPECIFIC 'submitted' event_key,
      // not an aggregate-wide row count, so that pre-existing INSERT event
      // never contaminates this check.
      const id = await seedProcurementOrder(rig);
      const submittedKey = `lifecycle:${id}:submitted`;

      await updateStatusAsActor(rig, 'procurement_orders', id, 'submitted', rig.superAdminId);
      const before = await rig.asAdmin((c: any) => c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1', [submittedKey]));

      // Metadata-only edit that leaves status unchanged ('submitted' -> 'submitted').
      await updateStatusAsActor(rig, 'procurement_orders', id, 'submitted', rig.superAdminId);
      const after = await rig.asAdmin((c: any) => c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1', [submittedKey]));

      expect(after.rows[0].n).toBe(before.rows[0].n);
      expect(after.rows[0].n).toBe(1);
    });

    it('a transition rejected by the table\'s own CHECK constraint never reaches the trigger — zero outbox rows for that attempted status', async () => {
      const id = await seedProcurementOrder(rig);
      await expect(rig.asAdmin((c: any) =>
        c.query(`UPDATE procurement_orders SET status = 'not_a_real_status' WHERE id = $1`, [id]),
      )).rejects.toMatchObject({ code: '23514' });

      // Scoped to the specific rejected event_key, not an aggregate-wide
      // count — the seed INSERT's own genuine 'draft' event legitimately
      // exists for this id and is unrelated to this rejected attempt.
      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1`,
        [`lifecycle:${id}:not_a_real_status`],
      ));
      expect(r.rows[0].n).toBe(0);
    });

    it('a pre-seeded IDENTICAL outbox event (same key, same fingerprint) is idempotent — the transition still succeeds, no duplicate row', async () => {
      const id = await seedProcurementOrder(rig);
      const dedupe = `${id}:submitted`;
      const eventKey = `lifecycle:${dedupe}`;

      // Pre-seed via the SAME helper the trigger itself will call, with the
      // exact same arguments the trigger will construct, guaranteeing a
      // byte-identical fingerprint without replicating the hash in JS.
      await rig.asAdmin((c: any) => c.query(
        `SELECT public.phoenix_append_outbox_event_internal(
           $1::text, 'procurement_orders.submitted'::text, 1::smallint, 'procurement_orders'::text, $2::uuid, $3::uuid,
           $4::jsonb, $5::uuid, NULL::uuid, NULL::uuid, NULL::uuid
         )`,
        [eventKey, id, CENTRAL_ORG,
         JSON.stringify({ source_table: 'procurement_orders', old_status: 'draft', new_status: 'submitted', trace_id: id, reference_id: id }),
         rig.superAdminId],
      ));

      // Now the real transition — the trigger computes the identical
      // fingerprint and must replay, not duplicate or error.
      await updateStatusAsActor(rig, 'procurement_orders', id, 'submitted', rig.superAdminId);

      await rig.asAdmin(async (c: any) => {
        const count = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1', [eventKey]);
        expect(count.rows[0].n).toBe(1);
        // The transition itself still succeeded normally — movement/notification exist.
        const movement = await movementByDedupe(c, dedupe);
        expect(movement).toBeTruthy();
      });
    });

    it('a pre-seeded CONFLICTING outbox event (same key, different fingerprint) raises outbox_event_key_conflict and rolls back the whole transition', async () => {
      const id = await seedProcurementOrder(rig);
      const dedupe = `${id}:submitted`;
      const eventKey = `lifecycle:${dedupe}`;

      // Pre-seed with a DIFFERENT payload than what the real transition will produce.
      await rig.asAdmin((c: any) => c.query(
        `SELECT public.phoenix_append_outbox_event_internal(
           $1::text, 'procurement_orders.submitted'::text, 1::smallint, 'procurement_orders'::text, $2::uuid, $3::uuid,
           $4::jsonb, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid
         )`,
        [eventKey, id, CENTRAL_ORG,
         JSON.stringify({ source_table: 'procurement_orders', old_status: 'draft', new_status: 'submitted', trace_id: id, reference_id: 'deliberately-different' })],
      ));

      await expect(
        updateStatusAsActor(rig, 'procurement_orders', id, 'submitted', rig.superAdminId),
      ).rejects.toMatchObject({ code: '23505' });

      await rig.asAdmin(async (c: any) => {
        // item 20: the source status change itself rolled back.
        const order = await c.query('SELECT status FROM procurement_orders WHERE id = $1', [id]);
        expect(order.rows[0].status).toBe('draft');
        // the existing movement/notification inserts also rolled back — never committed.
        const movement = await movementByDedupe(c, dedupe);
        const notification = await notificationByDedupe(c, dedupe);
        expect(movement).toBeNull();
        expect(notification).toBeNull();
        // exactly the one pre-seeded outbox row remains — no second row was ever committed.
        const count = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1', [eventKey]);
        expect(count.rows[0].n).toBe(1);
      });
    });

    it('an unrelated (non-conflict) transaction rollback removes both the source mutation and the outbox event', async () => {
      // Scoped to the 'submitted' event_key throughout, not an
      // aggregate-wide count — the seed INSERT's own 'draft' event is a
      // separate, already-committed, unrelated row for this same
      // aggregate_id (see the comment on the status-preserving-update test
      // above).
      const id = await seedProcurementOrder(rig);
      const dedupe = `${id}:submitted`;
      const submittedKey = `lifecycle:${dedupe}`;

      await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        await c.query(`UPDATE procurement_orders SET status = 'submitted' WHERE id = $1`, [id]);
        const midTxnOutbox = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1', [submittedKey]);
        expect(midTxnOutbox.rows[0].n).toBe(1);
        await c.query('ROLLBACK');
      });

      await rig.asAdmin(async (c: any) => {
        const order = await c.query('SELECT status FROM procurement_orders WHERE id = $1', [id]);
        expect(order.rows[0].status).toBe('draft');
        const outbox = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1', [submittedKey]);
        expect(outbox.rows[0].n).toBe(0);
        const movement = await movementByDedupe(c, dedupe);
        expect(movement).toBeNull();
      });
    });

    it('two distinct transitions (different rows) produce distinct event keys', async () => {
      const idA = await seedProcurementOrder(rig);
      const idB = await seedProcurementOrder(rig);
      await updateStatusAsActor(rig, 'procurement_orders', idA, 'submitted', rig.superAdminId);
      await updateStatusAsActor(rig, 'procurement_orders', idB, 'submitted', rig.superAdminId);

      await rig.asAdmin(async (c: any) => {
        const a = await outboxByKey(c, `lifecycle:${idA}:submitted`);
        const b = await outboxByKey(c, `lifecycle:${idB}:submitted`);
        expect(a).toBeTruthy();
        expect(b).toBeTruthy();
        expect(a.event_key).not.toBe(b.event_key);
        expect(a.id).not.toBe(b.id);
      });
    });

    it('existing lifecycle deduplication behavior is unchanged: a retried identical UPDATE never re-fires (status already equals new value)', async () => {
      const id = await seedProcurementOrder(rig);
      await updateStatusAsActor(rig, 'procurement_orders', id, 'submitted', rig.superAdminId);
      // "Retry" modeled as a second UPDATE setting the SAME status again.
      await updateStatusAsActor(rig, 'procurement_orders', id, 'submitted', rig.superAdminId);

      await rig.asAdmin(async (c: any) => {
        const movement = await c.query('SELECT count(*)::int n FROM phoenix_movement_events WHERE dedupe_key = $1', [`${id}:submitted`]);
        const outbox = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1', [`lifecycle:${id}:submitted`]);
        expect(movement.rows[0].n).toBe(1);
        expect(outbox.rows[0].n).toBe(1);
      });
    });
  });

  describe('a real accepted transition on warehouse_transfer_requests (dual-org, 082-era, destination-keyed)', () => {
    it('scopes the outbox event to the destination organization only — no counterparty exposure', async () => {
      const id = await seedTransferRequest(rig);
      // wtr_requested_at_chk (068) requires requested_at IS NOT NULL once
      // status leaves 'draft' — set alongside status in one statement,
      // exactly as a real submit RPC would, rather than reusing the
      // generic single-column updateStatusAsActor helper for this one
      // table-specific constraint.
      await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [rig.superAdminId]);
        await c.query(`UPDATE warehouse_transfer_requests SET status = 'submitted', requested_at = now() WHERE id = $1`, [id]);
        await c.query('COMMIT');
      });

      const eventKey = `lifecycle:${id}:submitted`;
      await rig.asAdmin(async (c: any) => {
        const outbox = await outboxByKey(c, eventKey);
        expect(outbox).toBeTruthy();
        expect(outbox.aggregate_type).toBe('warehouse_transfer_requests');
        // 155's own documented exception: this table is destination-keyed, not source-keyed.
        expect(outbox.organization_id).toBe(INST_ORG);
        expect(outbox.organization_id).not.toBe(CENTRAL_ORG);
        // The source (counterparty) org id never appears anywhere in the payload.
        const payloadStr = JSON.stringify(outbox.payload);
        expect(payloadStr).not.toContain(CENTRAL_ORG);
      });
    });
  });

  describe('security contract unchanged by 159', () => {
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
});
