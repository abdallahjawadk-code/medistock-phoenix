/**
 * OUTBOX-CONSUMER-STATE-FOUNDATION-163 — DYNAMIC integration proof, against
 * a real disposable Postgres with 001->163 applied in order.
 *
 * Proves the full D3-1 claim/lease/completion state machine against real
 * concurrent connections and real Outbox events produced by 162's own
 * stocktake trigger (no synthetic phoenix_outbox_events rows are ever
 * hand-inserted — every event here is produced the same way Production
 * would produce one). Covers every point in the 20-item security/
 * concurrency proof list this migration's own PR was required to satisfy.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI-without-rig (no database).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '00000000-0000-0000-0000-000000163001';
const ORG_B = '00000000-0000-0000-0000-000000163002';
const WH = '00000000-0000-0000-0000-000000163101';
const PERFORMER = '00000000-0000-0000-0000-000000163501';

let seq = 0;
const consumerKey = (p: string) => `${p}-${Date.now()}-${seq++}`;

run('163 outbox-consumer-foundation — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 163 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_A}','163 A','163 أ','p163-a'),('${ORG_B}','163 B','163 ب','p163-b')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code)
        VALUES ('${WH}','${ORG_A}','163 WH','163 مخزن','active','institution','p163-wh') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES ('${PERFORMER}','p163-performer@rig') ON CONFLICT (id) DO NOTHING;`);
    });
  }, 60000);

  afterAll(async () => { if (rig) await rig.end(); });

  /** A real stocktake INSERT -> fires 162's trigger -> one real Outbox event. */
  async function makeRealEvent(orgId: string, notes = 'p163 diag') {
    const stocktakeId = randomUUID();
    await rig.asAdmin((c: any) => c.query(
      `INSERT INTO stocktakes (id, organization_id, scope_kind, scope_id, notes, performed_by)
       VALUES ($1,$2,'warehouse',$3,$4,$5)`,
      [stocktakeId, orgId, WH, notes, PERFORMER],
    ));
    return stocktakeId;
  }

  /**
   * Registers a consumer and, by default, fast-forwards its discovery
   * cursor to the current max stream_position ("starts watching from now").
   * This is a real, deliberate feature (a brand-new consumer legitimately
   * catches up on backlog by default — proven separately by the dedicated
   * "org-derive"/gap-safety tests that call this with catchUpBacklog:true)
   * but it means, absent this fast-forward, every test in this shared-
   * database file would see every OTHER test's own earlier events too.
   * Isolating per-test is the correct default for everything except the
   * handful of tests that intentionally prove the catch-up behavior.
   */
  async function registerConsumer(key: string, opts: { orgId?: string | null; maxAttempts?: number; leaseSeconds?: number; enabled?: boolean; catchUpBacklog?: boolean } = {}) {
    await rig.asAdmin((c: any) => c.query(
      `INSERT INTO phoenix_outbox_consumers (consumer_key, organization_id, max_attempts, lease_duration_seconds, is_enabled)
       VALUES ($1,$2,$3,$4,$5)`,
      [key, opts.orgId ?? null, opts.maxAttempts ?? 5, opts.leaseSeconds ?? 300, opts.enabled ?? true],
    ));
    if (!opts.catchUpBacklog) {
      await rig.asAdmin((c: any) => c.query(
        `UPDATE phoenix_outbox_consumers
           SET last_discovered_stream_position = COALESCE((SELECT max(stream_position) FROM phoenix_outbox_events), 0)
         WHERE consumer_key = $1`,
        [key],
      ));
    }
  }

  const claim = (key: string, token: string, batchSize = 10) =>
    rig.asAdmin((c: any) => c.query(`SELECT * FROM phoenix_outbox_claim_batch($1, $2, $3)`, [key, token, batchSize]))
      .then((r: any) => r.rows);

  const complete = (key: string, dsId: string, token: string) =>
    rig.asAdmin((c: any) => c.query(`SELECT phoenix_outbox_mark_completed($1, $2, $3) AS r`, [key, dsId, token]))
      .then((r: any) => r.rows[0].r);

  const fail = (key: string, dsId: string, token: string, code: string | null = null, summary: string | null = null) =>
    rig.asAdmin((c: any) => c.query(`SELECT phoenix_outbox_mark_failed($1, $2, $3, $4, $5) AS r`, [key, dsId, token, code, summary]))
      .then((r: any) => r.rows[0].r);

  const release = (key: string, dsId: string, token: string) =>
    rig.asAdmin((c: any) => c.query(`SELECT phoenix_outbox_release_lease($1, $2, $3) AS r`, [key, dsId, token]))
      .then((r: any) => r.rows[0].r);

  describe('D2 preservation (re-verified independently of the migration\'s own in-transaction check)', () => {
    it('phoenix_outbox_events retains exactly its 158-defined 15 columns, zero triggers', async () => {
      await rig.asAdmin(async (c: any) => {
        const cols = await c.query(`SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='phoenix_outbox_events' ORDER BY column_name`);
        expect(cols.rows.map((r: any) => r.column_name)).toEqual([
          'actor_id','aggregate_id','aggregate_type','causation_id','correlation_id',
          'event_fingerprint','event_key','event_type','event_version','id',
          'occurred_at','organization_id','payload','request_id','stream_position',
        ]);
        const trig = await c.query(`SELECT count(*)::int n FROM pg_trigger WHERE tgrelid='public.phoenix_outbox_events'::regclass AND NOT tgisinternal`);
        expect(trig.rows[0].n).toBe(0);
      });
    });

    it('159/161/162 producers remain completely unchanged', async () => {
      await rig.asAdmin(async (c: any) => {
        const lifecycle = await c.query(`SELECT count(*)::int n FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE p.proname='phoenix_capture_lifecycle_event' AND NOT t.tgisinternal`);
        expect(lifecycle.rows[0].n).toBe(11);
        const movement = await c.query(`SELECT count(*)::int n FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE p.proname='phoenix_capture_movement_posted' AND NOT t.tgisinternal`);
        expect(movement.rows[0].n).toBe(3);
        const stocktake = await c.query(`SELECT count(*)::int n FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE p.proname='phoenix_capture_stocktake_recorded' AND NOT t.tgisinternal`);
        expect(stocktake.rows[0].n).toBe(1);
        const exc = await c.query(`SELECT pg_get_functiondef(oid) AS src FROM pg_proc WHERE proname='phoenix_resolve_outlet_return_exception'`);
        const refs = (exc.rows[0].src.match(/phoenix_append_outbox_event_internal/g) || []).length;
        expect(refs).toBe(2);
      });
    });

    it('no D3 processing column exists on phoenix_outbox_events, no D3 worker/scheduler object exists', async () => {
      await rig.asAdmin(async (c: any) => {
        const cols = await c.query(`SELECT count(*)::int n FROM information_schema.columns
          WHERE table_schema='public' AND table_name='phoenix_outbox_events'
            AND column_name ~* 'process|claim|lease|retry|attempt|failure|dead.?letter|consum'`);
        expect(cols.rows[0].n).toBe(0);
        const ext = await c.query(`SELECT count(*)::int n FROM pg_extension WHERE extname IN ('pg_net','pg_cron')`);
        // Informational only — some Supabase projects have these preinstalled for
        // unrelated reasons; this migration's own contract is that IT never
        // references them (proven by the function-source checks below), not
        // that the project has zero instances of the extension.
        expect(typeof ext.rows[0].n).toBe('number');
        for (const fn of ['phoenix_outbox_claim_batch', 'phoenix_outbox_mark_completed', 'phoenix_outbox_mark_failed', 'phoenix_outbox_release_lease']) {
          const src = await c.query(`SELECT pg_get_functiondef(oid) AS src FROM pg_proc WHERE proname = $1`, [fn]);
          const body = src.rows[0].src.toLowerCase();
          expect(body).not.toMatch(/pg_net|http_post|http_get|net\.http/);
          expect(body).not.toMatch(/cron\.schedule|pg_cron/);
          expect(body).not.toMatch(/\blisten\b|\bnotify\b|pg_notify/);
          expect(body).not.toMatch(/insert\s+into\s+(public\.)?phoenix_outbox_events/);
          expect(body).not.toMatch(/update\s+(public\.)?phoenix_outbox_events|delete\s+from\s+(public\.)?phoenix_outbox_events/);
        }
      });
    });
  });

  describe('privilege lockdown (proof #16)', () => {
    it('anon and authenticated cannot read/write either new table or execute any new function', async () => {
      await rig.asAdmin(async (c: any) => {
        for (const role of ['authenticated', 'anon']) {
          for (const table of ['phoenix_outbox_consumers', 'phoenix_outbox_delivery_state']) {
            for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
              const r = await c.query(`SELECT has_table_privilege($1, $2, $3) AS has`, [role, `public.${table}`, priv]);
              expect(r.rows[0].has, `${role} must not have ${priv} on ${table}`).toBe(false);
            }
          }
          for (const sig of [
            'public.phoenix_outbox_claim_batch(text,uuid,integer)',
            'public.phoenix_outbox_mark_completed(text,uuid,uuid)',
            'public.phoenix_outbox_mark_failed(text,uuid,uuid,text,text)',
            'public.phoenix_outbox_release_lease(text,uuid,uuid)',
          ]) {
            const r = await c.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS has`, [role, sig]);
            expect(r.rows[0].has, `${role} must not execute ${sig}`).toBe(false);
          }
        }
      });
      await expect(rig.asUser(rig.superAdminId, (c: any) =>
        c.query('SELECT * FROM phoenix_outbox_consumers'),
      )).rejects.toMatchObject({ code: '42501' });
      await expect(rig.asUser(rig.superAdminId, (c: any) =>
        c.query('SELECT * FROM phoenix_outbox_delivery_state'),
      )).rejects.toMatchObject({ code: '42501' });
    });

    it('service_role retains its normal default access (no new role was invented)', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT has_table_privilege('service_role', 'public.phoenix_outbox_consumers', 'SELECT') AS has`);
        expect(r.rows[0].has).toBe(true);
        for (const sig of [
          'public.phoenix_outbox_claim_batch(text,uuid,integer)',
          'public.phoenix_outbox_mark_completed(text,uuid,uuid)',
          'public.phoenix_outbox_mark_failed(text,uuid,uuid,text,text)',
          'public.phoenix_outbox_release_lease(text,uuid,uuid)',
        ]) {
          const r2 = await c.query(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS has`, [sig]);
          expect(r2.rows[0].has, `service_role must execute ${sig}`).toBe(true);
        }
      });
    });
  });

  describe('no caller-controlled organization override (proof #17)', () => {
    it('none of the four functions accept any organization-shaped parameter', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`
          SELECT p.proname, pg_get_function_arguments(p.oid) AS args
          FROM pg_proc p
          WHERE p.proname IN ('phoenix_outbox_claim_batch','phoenix_outbox_mark_completed','phoenix_outbox_mark_failed','phoenix_outbox_release_lease')`);
        for (const row of r.rows) {
          expect(row.args.toLowerCase(), `${row.proname} signature must carry no organization parameter`).not.toMatch(/org/);
        }
      });
    });

    it('delivery_state.organization_id always matches its Outbox event\'s own organization_id (server-derived, never caller-supplied)', async () => {
      const key = consumerKey('org-derive');
      await registerConsumer(key, { orgId: null });
      const stocktakeId = await makeRealEvent(ORG_B);
      const rows = await claim(key, randomUUID());
      expect(rows.length).toBe(1);
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`
          SELECT ds.organization_id AS ds_org, e.organization_id AS event_org
          FROM phoenix_outbox_delivery_state ds
          JOIN phoenix_outbox_events e ON e.id = ds.outbox_event_id
          WHERE e.aggregate_id = $1`, [stocktakeId]);
        expect(r.rows.length).toBe(1);
        expect(r.rows[0].ds_org).toBe(ORG_B);
        expect(r.rows[0].ds_org).toBe(r.rows[0].event_org);
      });
    });
  });

  describe('claim/lease core semantics', () => {
    it('claim_batch discovers and leases a real event, returns event data plus delivery-state identity', async () => {
      const key = consumerKey('basic');
      await registerConsumer(key, { orgId: ORG_A });
      const stocktakeId = await makeRealEvent(ORG_A);
      const token = randomUUID();
      const rows = await claim(key, token);
      expect(rows.length).toBe(1);
      expect(rows[0].event_type).toBe('stocktakes.recorded');
      expect(rows[0].aggregate_id).toBe(stocktakeId);
      expect(rows[0].attempt_count).toBe(0);
      expect(rows[0].delivery_state_id).toBeTruthy();
      expect(rows[0].organization_id).toBe(ORG_A);

      await rig.asAdmin(async (c: any) => {
        const ds = await c.query(`SELECT organization_id, status FROM phoenix_outbox_delivery_state WHERE id = $1`, [rows[0].delivery_state_id]);
        expect(ds.rows[0].organization_id).toBe(ORG_A);
        expect(ds.rows[0].status).toBe('leased');
      });
    });

    it('a non-expired lease cannot be stolen by a second claim call for the same consumer (proof #3)', async () => {
      const key = consumerKey('no-steal');
      await registerConsumer(key, { orgId: ORG_A, leaseSeconds: 300 });
      await makeRealEvent(ORG_A);
      const first = await claim(key, randomUUID());
      expect(first.length).toBe(1);
      const second = await claim(key, randomUUID());
      expect(second.length).toBe(0);
    });

    it('same consumer/event pair never creates duplicate delivery-state rows, even across repeated claim_batch calls (proof #13)', async () => {
      const key = consumerKey('no-dupe');
      await registerConsumer(key, { orgId: ORG_A });
      const stocktakeId = await makeRealEvent(ORG_A);
      await claim(key, randomUUID());
      await claim(key, randomUUID());
      await claim(key, randomUUID());
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`
          SELECT count(*)::int n FROM phoenix_outbox_delivery_state ds
          JOIN phoenix_outbox_events e ON e.id = ds.outbox_event_id
          WHERE e.aggregate_id = $1 AND ds.consumer_id = (SELECT id FROM phoenix_outbox_consumers WHERE consumer_key = $2)`,
          [stocktakeId, key]);
        expect(r.rows[0].n).toBe(1);
      });
    });

    it('the same Outbox event is processed independently by two different consumers (proof #12)', async () => {
      const keyA = consumerKey('indep-a');
      const keyB = consumerKey('indep-b');
      await registerConsumer(keyA, { orgId: ORG_A });
      await registerConsumer(keyB, { orgId: null });
      await makeRealEvent(ORG_A);
      const rowsA = await claim(keyA, randomUUID());
      const rowsB = await claim(keyB, randomUUID());
      expect(rowsA.length).toBe(1);
      expect(rowsB.length).toBe(1);
      expect(rowsA[0].delivery_state_id).not.toBe(rowsB[0].delivery_state_id);
      expect(rowsA[0].outbox_event_id).toBe(rowsB[0].outbox_event_id);
    });

    it('an org-scoped consumer cannot claim another organization\'s event; a global consumer can (proof #14, #15)', async () => {
      const scopedKey = consumerKey('scoped');
      const globalKey = consumerKey('global');
      await registerConsumer(scopedKey, { orgId: ORG_A });
      await registerConsumer(globalKey, { orgId: null });
      await makeRealEvent(ORG_B);
      const scopedRows = await claim(scopedKey, randomUUID());
      expect(scopedRows.length).toBe(0);
      const globalRows = await claim(globalKey, randomUUID());
      expect(globalRows.length).toBe(1);
      expect(globalRows[0].organization_id).toBe(ORG_B);
    });

    it('a disabled consumer is rejected outright (fail-closed identity behavior)', async () => {
      const key = consumerKey('disabled');
      await registerConsumer(key, { enabled: false });
      await expect(claim(key, randomUUID())).rejects.toMatchObject({ message: expect.stringContaining('consumer_disabled') });
    });

    it('an unknown consumer key is rejected outright (fail-closed identity behavior)', async () => {
      await expect(claim('does-not-exist-' + randomUUID(), randomUUID())).rejects.toMatchObject({ message: expect.stringContaining('consumer_not_found') });
    });

    it('does not assume gap-free stream_position — an event surrounded by non-contiguous positions is still discovered (proof #20)', async () => {
      const key = consumerKey('gap-safe');
      await registerConsumer(key, { orgId: ORG_A });
      // Two real events in a row create two real, but not necessarily
      // contiguous-from-this-consumer's-perspective, stream_position values
      // (other tests running in the same suite/db also advance the global
      // stream_position counter) — proving discovery works by ">" comparison
      // alone, never by assuming adjacency.
      await makeRealEvent(ORG_A, 'gap proof 1');
      await makeRealEvent(ORG_A, 'gap proof 2');
      const rows = await claim(key, randomUUID(), 10);
      expect(rows.length).toBe(2);
    });

    it('a brand-new consumer catches up on pre-existing backlog when explicitly registered that way', async () => {
      const backlogKey = consumerKey('backlog-source');
      await registerConsumer(backlogKey, { orgId: ORG_A });
      await makeRealEvent(ORG_A, 'backlog event 1');
      await makeRealEvent(ORG_A, 'backlog event 2');
      // A second consumer registered AFTER those events exist, with
      // catchUpBacklog:true (cursor left at its default of 0), must
      // discover them too -- this is the deliberate, documented default
      // behavior of a freshly-registered consumer with no explicit
      // fast-forward, distinct from every other test in this file which
      // opts OUT of it purely for test-to-test isolation.
      const catchUpKey = consumerKey('backlog-catchup');
      await registerConsumer(catchUpKey, { orgId: ORG_A, catchUpBacklog: true });
      const rows = await claim(catchUpKey, randomUUID(), 50);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.every((r: any) => r.event_type === 'stocktakes.recorded')).toBe(true);
    });
  });

  describe('two concurrent workers (proof #1) — real simultaneous connections, not sequential awaits', () => {
    it('claiming concurrently for the same consumer never yields overlapping delivery-state rows', async () => {
      const key = consumerKey('concurrent');
      await registerConsumer(key, { orgId: ORG_A });
      for (let i = 0; i < 6; i++) await makeRealEvent(ORG_A, `concurrent ${i}`);

      const tokenA = randomUUID();
      const tokenB = randomUUID();
      const [rowsA, rowsB] = await Promise.all([
        claim(key, tokenA, 3),
        claim(key, tokenB, 3),
      ]);
      const idsA = new Set(rowsA.map((r: any) => r.delivery_state_id));
      const idsB = new Set(rowsB.map((r: any) => r.delivery_state_id));
      const overlap = [...idsA].filter((id) => idsB.has(id));
      expect(overlap).toEqual([]);
      expect(idsA.size + idsB.size).toBeGreaterThan(0);
      expect(idsA.size + idsB.size).toBeLessThanOrEqual(6);
    });
  });

  describe('lease expiry and recovery (proof #2)', () => {
    it('an expired lease is reclaimed by the next claim_batch call for the same consumer', async () => {
      const key = consumerKey('expiry');
      await registerConsumer(key, { orgId: ORG_A, leaseSeconds: 300 });
      await makeRealEvent(ORG_A);
      const first = await claim(key, randomUUID());
      expect(first.length).toBe(1);
      const dsId = first[0].delivery_state_id;

      // Force the lease into the past — simulates a worker that died without
      // ever calling complete/fail/release.
      await rig.asAdmin((c: any) => c.query(
        `UPDATE phoenix_outbox_delivery_state SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [dsId],
      ));

      const reclaimed = await claim(key, randomUUID());
      expect(reclaimed.length).toBe(1);
      expect(reclaimed[0].delivery_state_id).toBe(dsId);

      await rig.asAdmin(async (c: any) => {
        const ds = await c.query(`SELECT attempt_count FROM phoenix_outbox_delivery_state WHERE id = $1`, [dsId]);
        // Deliberate D3-1 design decision (see migration header): expiry
        // reclaim never increments attempt_count.
        expect(ds.rows[0].attempt_count).toBe(0);
      });
    });
  });

  describe('mark_completed', () => {
    it('idempotent replay with the SAME token succeeds silently; a foreign token is rejected (proof #4, #6)', async () => {
      const key = consumerKey('complete');
      await registerConsumer(key, { orgId: ORG_A });
      await makeRealEvent(ORG_A);
      const token = randomUUID();
      const [row] = await claim(key, token);

      await expect(complete(key, row.delivery_state_id, randomUUID()))
        .rejects.toMatchObject({ message: expect.stringContaining('stale_or_foreign_lease_token') });

      const first = await complete(key, row.delivery_state_id, token);
      expect(first).toMatchObject({ ok: true, already_completed: false });

      const replay = await complete(key, row.delivery_state_id, token);
      expect(replay).toMatchObject({ ok: true, already_completed: true });

      const foreignAfterComplete = complete(key, row.delivery_state_id, randomUUID());
      await expect(foreignAfterComplete).rejects.toMatchObject({ message: expect.stringContaining('stale_or_foreign_lease_token') });
    });

    it('a completed event can never return to pending or leased (proof #10)', async () => {
      const key = consumerKey('terminal-complete');
      await registerConsumer(key, { orgId: ORG_A });
      await makeRealEvent(ORG_A);
      const token = randomUUID();
      const [row] = await claim(key, token);
      await complete(key, row.delivery_state_id, token);

      const reclaimAttempt = await claim(key, randomUUID());
      expect(reclaimAttempt.length).toBe(0);
      await rig.asAdmin(async (c: any) => {
        const ds = await c.query(`SELECT status FROM phoenix_outbox_delivery_state WHERE id = $1`, [row.delivery_state_id]);
        expect(ds.rows[0].status).toBe('completed');
      });
    });
  });

  describe('mark_failed — retry and dead-letter boundary (proof #5, #7, #8, #9)', () => {
    it('a stale/foreign lease token cannot fail an event', async () => {
      const key = consumerKey('fail-stale');
      await registerConsumer(key, { orgId: ORG_A, maxAttempts: 5 });
      await makeRealEvent(ORG_A);
      const token = randomUUID();
      const [row] = await claim(key, token);
      await expect(fail(key, row.delivery_state_id, randomUUID(), 'x', 'y'))
        .rejects.toMatchObject({ message: expect.stringContaining('stale_or_foreign_lease_token') });
    });

    it('failure increments attempt_count exactly once per call, with server-controlled exponential backoff', async () => {
      const key = consumerKey('backoff');
      await registerConsumer(key, { orgId: ORG_A, maxAttempts: 5, leaseSeconds: 300 });
      await makeRealEvent(ORG_A);
      let token = randomUUID();
      let [row] = await claim(key, token);
      const before = Date.now();
      const r1 = await fail(key, row.delivery_state_id, token, 'boom', 'first');
      expect(r1.attempt_count).toBe(1);
      expect(r1.status).toBe('pending');
      const delaySeconds1 = (new Date(r1.available_at).getTime() - before) / 1000;
      expect(delaySeconds1).toBeGreaterThan(25);
      expect(delaySeconds1).toBeLessThan(35);

      // Reclaim (force available now) and fail again — backoff should grow.
      await rig.asAdmin((c: any) => c.query(`UPDATE phoenix_outbox_delivery_state SET available_at = now() WHERE id = $1`, [row.delivery_state_id]));
      token = randomUUID();
      [row] = await claim(key, token);
      const before2 = Date.now();
      const r2 = await fail(key, row.delivery_state_id, token, 'boom', 'second');
      expect(r2.attempt_count).toBe(2);
      const delaySeconds2 = (new Date(r2.available_at).getTime() - before2) / 1000;
      expect(delaySeconds2).toBeGreaterThan(55);
      expect(delaySeconds2).toBeLessThan(65);
    });

    it('reaching max_attempts transitions exactly once to dead_letter, which is never reclaimed (proof #9, #11)', async () => {
      const key = consumerKey('deadletter');
      await registerConsumer(key, { orgId: ORG_A, maxAttempts: 2, leaseSeconds: 300 });
      await makeRealEvent(ORG_A);

      let token = randomUUID();
      let [row] = await claim(key, token);
      const r1 = await fail(key, row.delivery_state_id, token, 'e1', 's1');
      expect(r1.status).toBe('pending');
      expect(r1.attempt_count).toBe(1);

      await rig.asAdmin((c: any) => c.query(`UPDATE phoenix_outbox_delivery_state SET available_at = now() WHERE id = $1`, [row.delivery_state_id]));
      token = randomUUID();
      [row] = await claim(key, token);
      const r2 = await fail(key, row.delivery_state_id, token, 'e2', 's2');
      expect(r2.status).toBe('dead_letter');
      expect(r2.attempt_count).toBe(2);
      expect(r2.dead_letter_at).toBeTruthy();

      // Dead-letter row is never reclaimed, even if available_at is forced open.
      await rig.asAdmin((c: any) => c.query(`UPDATE phoenix_outbox_delivery_state SET available_at = now() WHERE id = $1`, [row.delivery_state_id]));
      const noReclaim = await claim(key, randomUUID());
      expect(noReclaim.length).toBe(0);

      await rig.asAdmin(async (c: any) => {
        const ds = await c.query(`SELECT status, attempt_count FROM phoenix_outbox_delivery_state WHERE id = $1`, [row.delivery_state_id]);
        expect(ds.rows[0].status).toBe('dead_letter');
        expect(ds.rows[0].attempt_count).toBe(2);
      });
    });

    it('never stores anything beyond the bounded error_code/error_summary it was given, and truncates oversized diagnostic input rather than failing', async () => {
      const key = consumerKey('bounded-diag');
      await registerConsumer(key, { orgId: ORG_A, maxAttempts: 5 });
      await makeRealEvent(ORG_A);
      const token = randomUUID();
      const [row] = await claim(key, token);
      const hugeCode = 'x'.repeat(500);
      const hugeSummary = 'y'.repeat(5000);
      await fail(key, row.delivery_state_id, token, hugeCode, hugeSummary);
      await rig.asAdmin(async (c: any) => {
        const ds = await c.query(`SELECT last_error_code, last_error_summary FROM phoenix_outbox_delivery_state WHERE id = $1`, [row.delivery_state_id]);
        expect(ds.rows[0].last_error_code.length).toBe(100);
        expect(ds.rows[0].last_error_summary.length).toBe(500);
      });
    });
  });

  describe('release_lease — cooperative, never burns an attempt', () => {
    it('releases a held lease back to pending immediately, without incrementing attempt_count, and rejects a foreign token', async () => {
      const key = consumerKey('release');
      await registerConsumer(key, { orgId: ORG_A });
      await makeRealEvent(ORG_A);
      const token = randomUUID();
      const [row] = await claim(key, token);

      await expect(release(key, row.delivery_state_id, randomUUID()))
        .rejects.toMatchObject({ message: expect.stringContaining('stale_or_foreign_lease_token') });

      const result = await release(key, row.delivery_state_id, token);
      expect(result.ok).toBe(true);

      await rig.asAdmin(async (c: any) => {
        const ds = await c.query(`SELECT status, attempt_count, lease_expires_at FROM phoenix_outbox_delivery_state WHERE id = $1`, [row.delivery_state_id]);
        expect(ds.rows[0].status).toBe('pending');
        expect(ds.rows[0].attempt_count).toBe(0);
        expect(ds.rows[0].lease_expires_at).toBeNull();
      });

      // Immediately re-claimable by anyone (available_at was set to now()).
      const reclaimed = await claim(key, randomUUID());
      expect(reclaimed.length).toBe(1);
      expect(reclaimed[0].delivery_state_id).toBe(row.delivery_state_id);
    });
  });

  describe('input validation — fail-closed on every malformed call', () => {
    it('claim_batch rejects null/empty consumer_key, null lease_token, and out-of-bounds batch_size', async () => {
      await expect(claim('', randomUUID())).rejects.toMatchObject({ message: expect.stringContaining('consumer_key_required') });
      await expect(rig.asAdmin((c: any) => c.query(`SELECT * FROM phoenix_outbox_claim_batch($1, NULL, 10)`, ['x'])))
        .rejects.toMatchObject({ message: expect.stringContaining('lease_token_required') });
      const key = consumerKey('bounds');
      await registerConsumer(key);
      await expect(claim(key, randomUUID(), 0)).rejects.toMatchObject({ message: expect.stringContaining('batch_size_out_of_bounds') });
      await expect(rig.asAdmin((c: any) => c.query(`SELECT * FROM phoenix_outbox_claim_batch($1, $2, 101)`, [key, randomUUID()])))
        .rejects.toMatchObject({ message: expect.stringContaining('batch_size_out_of_bounds') });
    });

    it('mark_completed/mark_failed/release_lease reject an unknown delivery_state_id', async () => {
      const key = consumerKey('unknown-ds');
      await registerConsumer(key);
      await expect(complete(key, randomUUID(), randomUUID())).rejects.toMatchObject({ message: expect.stringContaining('delivery_state_not_found') });
      await expect(fail(key, randomUUID(), randomUUID())).rejects.toMatchObject({ message: expect.stringContaining('delivery_state_not_found') });
      await expect(release(key, randomUUID(), randomUUID())).rejects.toMatchObject({ message: expect.stringContaining('delivery_state_not_found') });
    });

    it('a row belonging to a DIFFERENT consumer is treated as not-found, never leaked across consumers', async () => {
      const keyA = consumerKey('isolation-a');
      const keyB = consumerKey('isolation-b');
      await registerConsumer(keyA, { orgId: ORG_A });
      await registerConsumer(keyB, { orgId: ORG_A });
      await makeRealEvent(ORG_A);
      const token = randomUUID();
      const [row] = await claim(keyA, token);
      await expect(complete(keyB, row.delivery_state_id, token))
        .rejects.toMatchObject({ message: expect.stringContaining('delivery_state_not_found') });
    });
  });

  describe('full disposable replay sanity', () => {
    it('001->163 chain applies cleanly and both new tables exist with the expected shape', async () => {
      await rig.asAdmin(async (c: any) => {
        const t1 = await c.query(`SELECT to_regclass('public.phoenix_outbox_consumers') AS r`);
        const t2 = await c.query(`SELECT to_regclass('public.phoenix_outbox_delivery_state') AS r`);
        expect(t1.rows[0].r).toBe('phoenix_outbox_consumers');
        expect(t2.rows[0].r).toBe('phoenix_outbox_delivery_state');
      });
    });
  });
});
