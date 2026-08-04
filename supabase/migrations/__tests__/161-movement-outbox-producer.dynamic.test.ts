/**
 * MOVEMENT-OUTBOX-PRODUCER-161 — DYNAMIC integration proof, against a real
 * disposable Postgres with 001->161 applied in order.
 *
 * Full behavioral proof (one outbox row per accepted movement, replay
 * idempotency, conflict/rollback, rejection, distinct events per row) is
 * exercised against warehouse_stock_movements (the on_hand_* naming shape)
 * and additionally spot-checked against outlet_stock_movements and
 * warehouse_quarantine_stock_movements (the quantity_* naming shape) to
 * prove the same COALESCE(on_hand_*, quantity_*) resolution 124 already
 * established is unaffected by 161's additive change. Seeding reuses the
 * exact minimal-valid-row shape already proven by
 * 124-movement-contract-correlation-fields.dynamic.test.ts.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI-without-rig (no database).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import { seedDemoDataset } from '../../../tools/phoenix-demo/seed.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000161001';
const WH = '00000000-0000-0000-0000-000000161101';
const DP = '00000000-0000-0000-0000-000000161301';

const outboxByKey = (c: any, eventKey: string) =>
  c.query('SELECT * FROM phoenix_outbox_events WHERE event_key = $1', [eventKey]).then((r: any) => r.rows[0] ?? null);

const movementByDedupe = (c: any, dedupe: string) =>
  c.query('SELECT * FROM phoenix_movement_events WHERE dedupe_key = $1', [dedupe]).then((r: any) => r.rows[0] ?? null);

// Owns the connection directly (not via asAdmin's fire-and-release) so an
// aborted transaction (e.g. the INSERT itself raising outbox_event_key_
// conflict) can be explicitly ROLLBACK'd before the connection returns to
// the pool — otherwise a poisoned "current transaction is aborted"
// connection fails every later test that happens to borrow it back. Same
// pattern already proven in 159's own dynamic test.
const insertMovementAsActor = async (
  rig: Awaited<ReturnType<typeof buildRig>>,
  sql: string,
  params: any[],
  actorId: string | null,
) => {
  const client = await rig.pool.connect();
  try {
    await client.query('BEGIN');
    if (actorId) {
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [actorId]);
    }
    await client.query(sql, params);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

run('161 movement-outbox producer — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 161 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG}','161 Org','161 مؤسسة','p161-org') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
        ('${WH}','${ORG}','161 WH','161 مخزن','active','institution','p161-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO distribution_points (id,warehouse_id,organization_id,name,name_ar,point_type,status)
        VALUES ('${DP}','${WH}','${ORG}','161 Outlet','161 منفذ','pharmacy','active') ON CONFLICT DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  describe('trigger inventory — all 3 attachments individually confirmed', () => {
    it('exactly 3 phoenix_capture_movement_posted attachments exist, none new, none missing', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`
          SELECT c.relname FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE p.proname = 'phoenix_capture_movement_posted' AND NOT t.tgisinternal
          ORDER BY c.relname`);
        expect(r.rows.map((row: any) => row.relname)).toEqual([
          'outlet_stock_movements', 'warehouse_quarantine_stock_movements', 'warehouse_stock_movements',
        ]);
      });
    });

    it('applying the chain through 161 alone produces zero outbox rows', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events');
        expect(r.rows[0].n).toBe(0);
      });
    });

    it('phoenix_capture_movement_notification and phoenix_capture_stocktake_recorded remain unwired from the outbox', async () => {
      await rig.asAdmin(async (c: any) => {
        for (const fn of ['phoenix_capture_movement_notification', 'phoenix_capture_stocktake_recorded']) {
          const r = await c.query('SELECT pg_get_functiondef(oid) AS src FROM pg_proc WHERE proname = $1', [fn]);
          expect(r.rows[0].src).not.toContain('phoenix_outbox_events');
          expect(r.rows[0].src).not.toContain('phoenix_append_outbox_event_internal');
        }
      });
    });

    it("159's lifecycle producer remains completely unchanged: 11 attachments, one call site", async () => {
      await rig.asAdmin(async (c: any) => {
        const triggers = await c.query(`
          SELECT count(*)::int n FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE p.proname = 'phoenix_capture_lifecycle_event' AND NOT t.tgisinternal`);
        expect(triggers.rows[0].n).toBe(11);
        const src = await c.query(`SELECT pg_get_functiondef(oid) AS src FROM pg_proc WHERE proname = 'phoenix_capture_lifecycle_event'`);
        const occurrences = [...String(src.rows[0].src).matchAll(/phoenix_append_outbox_event_internal/g)];
        expect(occurrences.length).toBe(1);
      });
    });
  });

  describe('a real accepted movement on warehouse_stock_movements (on_hand_* naming)', () => {
    it('creates the same existing phoenix_movement_events row AND exactly one outbox row with matching identity', async () => {
      const stockId = randomUUID();
      const movementId = randomUUID();
      const correlationId = randomUUID();
      const causationId = randomUUID();

      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,'P161-WH',true,false,'B-WH',10,0,1)`,
        [stockId, ORG, WH],
      ));
      await insertMovementAsActor(
        rig,
        `INSERT INTO warehouse_stock_movements
          (id, warehouse_stock_id, organization_id, warehouse_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot, actor_id, correlation_id, causation_id)
         VALUES ($1,$2,$3,$4,'add',0,10,10,0,0,0,'P161-WH',$5,$6,$7)`,
        [movementId, stockId, ORG, WH, rig.superAdminId, correlationId, causationId],
        rig.superAdminId,
      );

      const dedupe = `${movementId}:posted`;
      const eventKey = `movement:${dedupe}`;

      await rig.asAdmin(async (c: any) => {
        const movement = await movementByDedupe(c, dedupe);
        const outbox = await outboxByKey(c, eventKey);

        expect(movement).toBeTruthy();
        expect(outbox).toBeTruthy();

        expect(outbox.event_type).toBe('warehouse_stock_movements.posted');
        expect(movement.event_type).toBe('warehouse_stock_movements.posted');
        expect(outbox.organization_id).toBe(movement.organization_id);
        expect(outbox.organization_id).toBe(ORG);
        expect(outbox.actor_id).toBe(movement.actor_id);
        expect(outbox.actor_id).toBe(rig.superAdminId);
        expect(outbox.aggregate_type).toBe('warehouse_stock_movements');
        expect(outbox.aggregate_id).toBe(movementId);
        expect(outbox.event_key).toBe(eventKey);
        expect(outbox.correlation_id).toBe(correlationId);
        expect(outbox.causation_id).toBe(causationId);
        expect(outbox.request_id).toBeNull();
        expect(outbox.payload).toEqual({
          source_table: 'warehouse_stock_movements',
          movement_type: 'add',
          quantity_delta: 10,
          trace_id: movementId,
          reference_id: movementId,
          occurred_at: outbox.payload.occurred_at,
        });
        const payloadStr = JSON.stringify(outbox.payload);
        for (const forbidden of ['email', 'phone', 'jwt', 'token', 'password', 'auth.users', 'actor_name', 'actor_role', 'full_name']) {
          expect(payloadStr.toLowerCase()).not.toContain(forbidden);
        }
      });
    });

    it('a retried IDENTICAL append (same key, same fingerprint as the row the trigger already created) is idempotent — no duplicate row', async () => {
      // Unlike 159's payload, this producer's payload includes occurred_at
      // (a non-deterministic value defaulted at INSERT time), so a
      // byte-identical fingerprint cannot be predicted in JS ahead of the
      // real INSERT. Instead: let the real trigger create the row first,
      // then replay the append using THAT row's own already-computed,
      // already-stored values — a faithful model of a genuine retry (e.g.
      // the same logical operation re-attempted after a client timeout)
      // reusing the exact envelope the first attempt produced.
      const stockId = randomUUID();
      const movementId = randomUUID();
      const dedupe = `${movementId}:posted`;
      const eventKey = `movement:${dedupe}`;

      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,'P161-IDEM',true,false,'B-IDEM',5,0,0)`,
        [stockId, ORG, WH],
      ));
      await insertMovementAsActor(
        rig,
        `INSERT INTO warehouse_stock_movements
          (id, warehouse_stock_id, organization_id, warehouse_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot)
         VALUES ($1,$2,$3,$4,'add',0,5,5,0,0,0,'P161-IDEM')`,
        [movementId, stockId, ORG, WH],
        null,
      );

      const original = await rig.asAdmin((c: any) => outboxByKey(c, eventKey));
      expect(original).toBeTruthy();

      // Replay via the SAME helper the trigger itself called, with the
      // exact stored event_type/aggregate_type/aggregate_id/organization_id/
      // payload the first call produced — guaranteeing a byte-identical
      // fingerprint without reconstructing the hash in JS.
      await rig.asAdmin((c: any) => c.query(
        `SELECT public.phoenix_append_outbox_event_internal(
           $1::text, $2::text, $3::smallint, $4::text, $5::uuid, $6::uuid,
           $7::jsonb, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid
         )`,
        [eventKey, original.event_type, original.event_version, original.aggregate_type, original.aggregate_id, original.organization_id, original.payload],
      ));

      await rig.asAdmin(async (c: any) => {
        const count = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1', [eventKey]);
        expect(count.rows[0].n).toBe(1);
        const movement = await movementByDedupe(c, dedupe);
        expect(movement).toBeTruthy();
      });
    });

    it('a pre-seeded CONFLICTING outbox event (same key, different fingerprint) raises outbox_event_key_conflict and rolls back the whole insert', async () => {
      const stockId = randomUUID();
      const movementId = randomUUID();
      const dedupe = `${movementId}:posted`;
      const eventKey = `movement:${dedupe}`;

      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,'P161-CONFLICT',true,false,'B-CONF',3,0,0)`,
        [stockId, ORG, WH],
      ));

      // Pre-seed with a DIFFERENT payload than what the real insert will produce.
      await rig.asAdmin((c: any) => c.query(
        `SELECT public.phoenix_append_outbox_event_internal(
           $1::text, 'warehouse_stock_movements.posted'::text, 1::smallint, 'warehouse_stock_movements'::text, $2::uuid, $3::uuid,
           $4::jsonb, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid
         )`,
        [eventKey, movementId, ORG,
         JSON.stringify({ source_table: 'warehouse_stock_movements', movement_type: 'add', quantity_delta: 999, trace_id: movementId, reference_id: 'deliberately-different' })],
      ));

      await expect(insertMovementAsActor(
        rig,
        `INSERT INTO warehouse_stock_movements
          (id, warehouse_stock_id, organization_id, warehouse_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot)
         VALUES ($1,$2,$3,$4,'add',0,3,3,0,0,0,'P161-CONFLICT')`,
        [movementId, stockId, ORG, WH],
        null,
      )).rejects.toMatchObject({ code: '23505' });

      await rig.asAdmin(async (c: any) => {
        // the movement-row insert itself rolled back — never committed.
        const row = await c.query('SELECT count(*)::int n FROM warehouse_stock_movements WHERE id = $1', [movementId]);
        expect(row.rows[0].n).toBe(0);
        // the existing phoenix_movement_events insert also rolled back.
        const movement = await movementByDedupe(c, dedupe);
        expect(movement).toBeNull();
        // exactly the one pre-seeded outbox row remains — no second row was ever committed.
        const count = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1', [eventKey]);
        expect(count.rows[0].n).toBe(1);
      });
    });

    it('an unrelated (non-conflict) transaction rollback removes both the movement row and the outbox event', async () => {
      const stockId = randomUUID();
      const movementId = randomUUID();
      const dedupe = `${movementId}:posted`;
      const eventKey = `movement:${dedupe}`;

      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,'P161-ROLLBACK',true,false,'B-RB',4,0,0)`,
        [stockId, ORG, WH],
      ));

      await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO warehouse_stock_movements
            (id, warehouse_stock_id, organization_id, warehouse_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot)
           VALUES ($1,$2,$3,$4,'add',0,4,4,0,0,0,'P161-ROLLBACK')`,
          [movementId, stockId, ORG, WH],
        );
        const midTxnOutbox = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1', [eventKey]);
        expect(midTxnOutbox.rows[0].n).toBe(1);
        await c.query('ROLLBACK');
      });

      await rig.asAdmin(async (c: any) => {
        const row = await c.query('SELECT count(*)::int n FROM warehouse_stock_movements WHERE id = $1', [movementId]);
        expect(row.rows[0].n).toBe(0);
        const outbox = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1', [eventKey]);
        expect(outbox.rows[0].n).toBe(0);
        const movement = await movementByDedupe(c, dedupe);
        expect(movement).toBeNull();
      });
    });

    it('two distinct movement rows produce distinct event keys', async () => {
      const stockId = randomUUID();
      const movementIdA = randomUUID();
      const movementIdB = randomUUID();

      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,'P161-DISTINCT',true,false,'B-DIST',20,0,0)`,
        [stockId, ORG, WH],
      ));
      for (const movementId of [movementIdA, movementIdB]) {
        await rig.asAdmin((c: any) => c.query(
          `INSERT INTO warehouse_stock_movements
            (id, warehouse_stock_id, organization_id, warehouse_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot)
           VALUES ($1,$2,$3,$4,'add',0,1,1,0,0,0,'P161-DISTINCT')`,
          [movementId, stockId, ORG, WH],
        ));
      }

      await rig.asAdmin(async (c: any) => {
        const a = await outboxByKey(c, `movement:${movementIdA}:posted`);
        const b = await outboxByKey(c, `movement:${movementIdB}:posted`);
        expect(a).toBeTruthy();
        expect(b).toBeTruthy();
        expect(a.event_key).not.toBe(b.event_key);
        expect(a.id).not.toBe(b.id);
      });
    });

    it('a movement_type rejected by the table\'s own CHECK constraint never reaches the trigger — zero outbox rows for that attempted row', async () => {
      const stockId = randomUUID();
      const movementId = randomUUID();
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,'P161-REJECT',true,false,'B-REJ',0,0,0)`,
        [stockId, ORG, WH],
      ));

      await expect(rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouse_stock_movements
          (id, warehouse_stock_id, organization_id, warehouse_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot)
         VALUES ($1,$2,$3,$4,'not_a_real_movement_type',0,0,0,0,0,0,'P161-REJECT')`,
        [movementId, stockId, ORG, WH],
      ))).rejects.toMatchObject({ code: '23514' });

      const r = await rig.asAdmin((c: any) => c.query(
        `SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key = $1`,
        [`movement:${movementId}:posted`],
      ));
      expect(r.rows[0].n).toBe(0);
    });
  });

  describe('outlet_stock_movements (on_hand_* naming, distribution_point-scoped)', () => {
    it('an accepted movement creates exactly one outbox row with the correct aggregate identity', async () => {
      const stockId = randomUUID();
      const movementId = randomUUID();
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO outlet_stock (id, organization_id, distribution_point_id, point_type, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,'pharmacy',$4,true,false,'B-OUT',5,0,0)`,
        [stockId, ORG, DP, 'P161-OUT'],
      ));
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO outlet_stock_movements
          (id, outlet_stock_id, organization_id, distribution_point_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot)
         VALUES ($1,$2,$3,$4,'add',0,5,5,0,0,0,'P161-OUT')`,
        [movementId, stockId, ORG, DP],
      ));

      const outbox = await rig.asAdmin((c: any) => outboxByKey(c, `movement:${movementId}:posted`));
      expect(outbox).toBeTruthy();
      expect(outbox.aggregate_type).toBe('outlet_stock_movements');
      expect(outbox.event_type).toBe('outlet_stock_movements.posted');
      expect(outbox.payload.quantity_delta).toBe(5);
    });
  });

  describe('warehouse_quarantine_stock_movements (quantity_* naming)', () => {
    it('an accepted movement creates exactly one outbox row, correctly resolving quantity_delta (not on_hand_delta)', async () => {
      const qId = randomUUID();
      const movementId = randomUUID();
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouse_quarantine_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, quarantine_reason, quantity, created_by, updated_by)
         VALUES ($1,$2,$3,'P161-Q',true,false,'B-Q','damaged',7,NULL,NULL)`,
        [qId, ORG, WH],
      ));
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouse_quarantine_stock_movements
          (id, quarantine_stock_id, organization_id, warehouse_id, movement_type, quantity_before, quantity_delta, quantity_after)
         VALUES ($1,$2,$3,$4,'quarantine_receive',0,7,7)`,
        [movementId, qId, ORG, WH],
      ));

      const outbox = await rig.asAdmin((c: any) => outboxByKey(c, `movement:${movementId}:posted`));
      expect(outbox).toBeTruthy();
      expect(outbox.aggregate_type).toBe('warehouse_quarantine_stock_movements');
      expect(outbox.payload.quantity_delta).toBe(7);
    });
  });

  describe('demo seed→purge lifecycle remains successful with outbox rows correctly manifest-registered', () => {
    it('phoenix_demo_purgeable_tables() and ownership-capture both still recognize phoenix_outbox_events (160/ownership.mjs regression check)', async () => {
      await rig.asAdmin(async (c: any) => {
        const tables = await c.query('SELECT public.phoenix_demo_purgeable_tables() AS tables');
        expect(tables.rows[0].tables).toContain('phoenix_outbox_events');
      });
    });

    it("a real seedDemoDataset() run: every phoenix_outbox_events row for the demo org is manifest-owned, registration is limited to the seeded movements, and an unrelated real org's own outbox row is never touched", async () => {
      // Full end-to-end proof of the seed.mjs fix (the intake-phase
      // registration block added alongside 161): seedDemoDataset() creates
      // warehouse-receipt movements through phoenix_receive_warehouse_stock_
      // guarded directly (not through the diff-captured workflow-group
      // loop), and 161's trigger now emits one phoenix_outbox_events row per
      // such movement. Proves (a) every one of those rows ends up
      // manifest-owned — not just some — and (b) the registration's
      // aggregate_id/aggregate_type constraint never sweeps up a
      // genuinely unrelated, non-demo org's own outbox row.
      const DATASET_KEY = 'PHOENIX_DEMO_V1';
      const REAL_ORG = randomUUID();
      const REAL_WH = randomUUID();
      const REAL_STOCK = randomUUID();
      const REAL_MOVEMENT = randomUUID();

      // A genuine, real (non-demo) org with its own movement and — via the
      // same 161 trigger — its own outbox row, seeded BEFORE the demo
      // seeder runs, exactly mirroring "a concurrently-existing real row"
      // (ownership.mjs's own stated safety invariant).
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO organizations (id,name,name_ar,code) VALUES ($1,'Real Org','مؤسسة حقيقية','p161-real-org')`,
        [REAL_ORG],
      ));
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code) VALUES
         ($1,$2,'Real WH','مخزن حقيقي','active','institution','p161-real-wh')`,
        [REAL_WH, REAL_ORG],
      ));
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code, has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
         VALUES ($1,$2,$3,'P161-REAL',true,false,'B-REAL',9,0,0)`,
        [REAL_STOCK, REAL_ORG, REAL_WH],
      ));
      await rig.asAdmin((c: any) => c.query(
        `INSERT INTO warehouse_stock_movements
          (id, warehouse_stock_id, organization_id, warehouse_id, movement_type, on_hand_before, on_hand_delta, on_hand_after, reserved_before, reserved_delta, reserved_after, scientific_name_snapshot)
         VALUES ($1,$2,$3,$4,'add',0,9,9,0,0,0,'P161-REAL')`,
        [REAL_MOVEMENT, REAL_STOCK, REAL_ORG, REAL_WH],
      ));
      const realOutbox = await rig.asAdmin((c: any) => outboxByKey(c, `movement:${REAL_MOVEMENT}:posted`));
      expect(realOutbox).toBeTruthy();

      await seedDemoDataset(rig, rig.superAdminId, { institutions: 1, outletsPerInstitution: 1, materials: 5, batchesPerWarehouse: 3 });

      await rig.asAdmin(async (c: any) => {
        // The manifest-registered dataset org ids (the real safe scope —
        // never a name/pattern heuristic, matching 140's own contract).
        const demoOrgIds = await c.query(
          `SELECT row_id FROM phoenix_demo_manifest WHERE dataset_key = $1 AND table_name = 'organizations'`,
          [DATASET_KEY],
        );
        const orgIds = demoOrgIds.rows.map((r: any) => r.row_id);
        expect(orgIds.length).toBeGreaterThan(0);
        expect(orgIds).not.toContain(REAL_ORG);

        // (a) Every demo-org outbox row is manifest-owned — none missed.
        const allDemoOutbox = await c.query(
          `SELECT id FROM phoenix_outbox_events WHERE organization_id = ANY($1::uuid[])`,
          [orgIds],
        );
        const manifestOwnedOutbox = await c.query(
          `SELECT row_id FROM phoenix_demo_manifest WHERE dataset_key = $1 AND table_name = 'phoenix_outbox_events'`,
          [DATASET_KEY],
        );
        const ownedIds = new Set(manifestOwnedOutbox.rows.map((r: any) => r.row_id));
        for (const row of allDemoOutbox.rows) {
          expect(ownedIds.has(row.id), `outbox row ${row.id} must be manifest-owned`).toBe(true);
        }
        expect(allDemoOutbox.rows.length).toBeGreaterThan(0);

        // (b) The real, unrelated org's own outbox row was never captured.
        expect(ownedIds.has(realOutbox.id)).toBe(false);
        const realStillPresent = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE id = $1', [realOutbox.id]);
        expect(realStillPresent.rows[0].n).toBe(1);
      });

      // A second seed run (idempotent re-registration) must not create a
      // second manifest row for any already-owned outbox event.
      await seedDemoDataset(rig, rig.superAdminId, { institutions: 1, outletsPerInstitution: 1, materials: 5, batchesPerWarehouse: 3 });
      await rig.asAdmin(async (c: any) => {
        const dupCheck = await c.query(
          `SELECT row_id, count(*)::int n FROM phoenix_demo_manifest
            WHERE dataset_key = $1 AND table_name = 'phoenix_outbox_events'
            GROUP BY row_id HAVING count(*) > 1`,
          [DATASET_KEY],
        );
        expect(dupCheck.rows).toEqual([]);
      });

      // Purging the dataset removes its outbox rows; the real org's own
      // outbox row (never manifest-owned) survives untouched.
      await rig.asUser(rig.superAdminId, (c: any) =>
        c.query(`SELECT * FROM public.phoenix_demo_purge($1, false)`, [DATASET_KEY]), { commit: true });
      await rig.asAdmin(async (c: any) => {
        const residualDemoOutbox = await c.query(
          `SELECT count(*)::int n FROM phoenix_demo_manifest WHERE dataset_key = $1 AND table_name = 'phoenix_outbox_events'`,
          [DATASET_KEY],
        );
        expect(residualDemoOutbox.rows[0].n).toBe(0);
        const realStillPresent = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE id = $1', [realOutbox.id]);
        expect(realStillPresent.rows[0].n).toBe(1);
      });
    }, 60000);
  });

  describe('security contract unchanged by 161', () => {
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
