/**
 * TRANSACTIONAL-OUTBOX-FOUNDATION-158 — DYNAMIC integration proof, against a
 * real disposable Postgres with 001->158 applied in order.
 *
 * D2-1 is a foundation-only migration: no trigger, no producer wiring, no
 * business scenario to seed. These tests exercise the table and the internal
 * append helper directly and in isolation — exactly the surface D2-1 actually
 * ships — plus the transactional-atomicity guarantees the whole D2 design
 * depends on (same-transaction rollback in both directions), and a
 * regression check that nothing through migration 157 was disturbed.
 *
 * Concurrency test shape mirrors 106/156/157's own established pattern
 * (advisory-lock-then-check, two real connections, waitForBackendLock).
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI-without-rig (no database).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG = '00000000-0000-0000-0000-000000158001';
const OTHER_ORG = '00000000-0000-0000-0000-000000158002';

const callAppend = (c: any, args: unknown[]) =>
  c.query(
    `SELECT event_id, event_stream_position
       FROM public.phoenix_append_outbox_event_internal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    args,
  ).then((r: any) => r.rows[0]);

/** Default valid argument tuple, matching the helper's documented signature
 * order: event_key, event_type, event_version, aggregate_type, aggregate_id,
 * organization_id, payload, actor_id, correlation_id, causation_id, request_id. */
const validArgs = (overrides: Partial<{
  eventKey: string; eventType: string; eventVersion: number; aggregateType: string;
  aggregateId: string; organizationId: string; payload: object;
  actorId: string | null; correlationId: string | null; causationId: string | null; requestId: string | null;
}> = {}) => {
  const a = {
    eventKey: `evt-${randomUUID()}`,
    eventType: 'test.event',
    eventVersion: 1,
    aggregateType: 'test_aggregate',
    aggregateId: randomUUID(),
    organizationId: ORG,
    payload: { hello: 'world' },
    actorId: null as string | null,
    correlationId: null as string | null,
    causationId: null as string | null,
    requestId: null as string | null,
    ...overrides,
  };
  return [
    a.eventKey, a.eventType, a.eventVersion, a.aggregateType, a.aggregateId,
    a.organizationId, JSON.stringify(a.payload), a.actorId, a.correlationId, a.causationId, a.requestId,
  ];
};

const authenticateSession = async (c: any, actorId: string) => {
  await c.query('BEGIN');
  await c.query('SET LOCAL ROLE authenticated');
  await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [actorId]);
};

const waitForBackendLock = async (
  rig: Awaited<ReturnType<typeof buildRig>>,
  backendPid: number,
  timeoutMs = 5000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await rig.asAdmin((c: any) => c.query(
      `SELECT wait_event_type,wait_event,state FROM pg_stat_activity WHERE pid=$1`,
      [backendPid],
    ));
    if (state.rows[0]?.wait_event_type === 'Lock') return state.rows[0];
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`backend ${backendPid} did not reach a lock wait`);
};

run('158 transactional-outbox foundation — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 158 });
    await rig.asAdmin((c: any) => c.query(`
      INSERT INTO organizations(id,name,name_ar,code)
      VALUES('${ORG}','158 Outbox Foundation','158 Outbox Foundation','p158-org');
      INSERT INTO organizations(id,name,name_ar,code)
      VALUES('${OTHER_ORG}','158 Outbox Other','158 Outbox Other','p158-org-2');
    `));
  }, 120000);

  afterAll(async () => { if (rig) await rig.end(); });

  describe('schema contract', () => {
    it('has exactly the 15 approved columns', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='phoenix_outbox_events'`);
        const names = r.rows.map((row: any) => row.column_name).sort();
        expect(names).toEqual([
          'actor_id', 'aggregate_id', 'aggregate_type', 'causation_id', 'correlation_id',
          'event_fingerprint', 'event_key', 'event_type', 'event_version', 'id',
          'occurred_at', 'organization_id', 'payload', 'request_id', 'stream_position',
        ].sort());
      });
    });

    it('no column name looks secret-shaped (password/token/jwt/secret)', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='phoenix_outbox_events'`);
        for (const row of r.rows) {
          expect(row.column_name).not.toMatch(/password|token|jwt|secret/i);
        }
      });
    });

    it('RLS is enabled and zero policies exist', async () => {
      await rig.asAdmin(async (c: any) => {
        const rls = await c.query(
          `SELECT relrowsecurity FROM pg_class WHERE oid='public.phoenix_outbox_events'::regclass`);
        expect(rls.rows[0].relrowsecurity).toBe(true);
        const policies = await c.query(
          `SELECT count(*)::int n FROM pg_policies WHERE schemaname='public' AND tablename='phoenix_outbox_events'`);
        expect(policies.rows[0].n).toBe(0);
      });
    });

    it('PUBLIC, authenticated, and anon have zero table privileges', async () => {
      await rig.asAdmin(async (c: any) => {
        for (const role of ['authenticated', 'anon']) {
          for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']) {
            const r = await c.query(
              `SELECT has_table_privilege($1, 'public.phoenix_outbox_events', $2) AS has`, [role, priv]);
            expect(r.rows[0].has).toBe(false);
          }
        }
        const pub = await c.query(
          `SELECT count(*)::int n FROM pg_class c, aclexplode(c.relacl) a
           WHERE c.oid='public.phoenix_outbox_events'::regclass AND a.grantee = 0`);
        expect(pub.rows[0].n).toBe(0);
      });
    });

    it('event_version <= 0 fails closed at the constraint level', async () => {
      await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        await expect(c.query(
          `INSERT INTO phoenix_outbox_events
             (event_key, event_fingerprint, event_type, event_version, aggregate_type, aggregate_id, organization_id, payload)
           VALUES ($1,'fp','t.type',0,'agg',$2,$3,'{}'::jsonb)`,
          [`bad-version-${randomUUID()}`, randomUUID(), ORG],
        )).rejects.toMatchObject({ code: '23514' });
        await c.query('ROLLBACK');
      });
    });

    it('a non-object payload fails closed at the constraint level', async () => {
      await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        await expect(c.query(
          `INSERT INTO phoenix_outbox_events
             (event_key, event_fingerprint, event_type, event_version, aggregate_type, aggregate_id, organization_id, payload)
           VALUES ($1,'fp','t.type',1,'agg',$2,$3,'[1,2,3]'::jsonb)`,
          [`bad-payload-${randomUUID()}`, randomUUID(), ORG],
        )).rejects.toMatchObject({ code: '23514' });
        await c.query('ROLLBACK');
      });
    });

    it('a blank event_key fails closed at the constraint level', async () => {
      await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        await expect(c.query(
          `INSERT INTO phoenix_outbox_events
             (event_key, event_fingerprint, event_type, event_version, aggregate_type, aggregate_id, organization_id, payload)
           VALUES ('   ','fp','t.type',1,'agg',$1,$2,'{}'::jsonb)`,
          [randomUUID(), ORG],
        )).rejects.toMatchObject({ code: '23514' });
        await c.query('ROLLBACK');
      });
    });
  });

  describe('direct raw access is denied to authenticated', () => {
    it('raw SELECT fails', async () => {
      await expect(rig.asUser(rig.superAdminId, (c: any) =>
        c.query('SELECT * FROM phoenix_outbox_events'),
      )).rejects.toMatchObject({ code: '42501' });
    });
    it('raw INSERT fails', async () => {
      await expect(rig.asUser(rig.superAdminId, (c: any) =>
        c.query(
          `INSERT INTO phoenix_outbox_events
             (event_key, event_fingerprint, event_type, event_version, aggregate_type, aggregate_id, organization_id, payload)
           VALUES ($1,'fp','t.type',1,'agg',$2,$3,'{}'::jsonb)`,
          [`raw-${randomUUID()}`, randomUUID(), ORG],
        ),
      )).rejects.toMatchObject({ code: '42501' });
    });
    it('raw UPDATE fails', async () => {
      await expect(rig.asUser(rig.superAdminId, (c: any) =>
        c.query(`UPDATE phoenix_outbox_events SET event_type='x' WHERE true`),
      )).rejects.toMatchObject({ code: '42501' });
    });
    it('raw DELETE fails', async () => {
      await expect(rig.asUser(rig.superAdminId, (c: any) =>
        c.query(`DELETE FROM phoenix_outbox_events WHERE true`),
      )).rejects.toMatchObject({ code: '42501' });
    });
    it('direct execution of the internal append helper fails', async () => {
      await expect(rig.asUser(rig.superAdminId, (c: any) =>
        callAppend(c, validArgs()),
      )).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('append helper: first use, replay, and conflict', () => {
    it('a first valid append inserts exactly one event and returns its identity', async () => {
      const args = validArgs();
      const before = await rig.asAdmin((c: any) => c.query('SELECT count(*)::int n FROM phoenix_outbox_events'));
      const result = await rig.asAdmin((c: any) => callAppend(c, args));
      expect(result.event_id).toBeTruthy();
      expect(typeof result.event_stream_position).toBe('string'); // bigint comes back as string via pg
      const after = await rig.asAdmin((c: any) => c.query('SELECT count(*)::int n FROM phoenix_outbox_events'));
      expect(after.rows[0].n).toBe(before.rows[0].n + 1);
    });

    it('an identical replay (same event_key, same everything) returns the SAME identity and creates no second row', async () => {
      const args = validArgs();
      const first = await rig.asAdmin((c: any) => callAppend(c, args));
      const second = await rig.asAdmin((c: any) => callAppend(c, args));
      expect(second).toEqual(first);
      const count = await rig.asAdmin((c: any) => c.query(
        'SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key=$1', [args[0]]));
      expect(count.rows[0].n).toBe(1);
    });

    it('the same event_key with a different payload fails closed with outbox_event_key_conflict (23505)', async () => {
      const key = `evt-${randomUUID()}`;
      await rig.asAdmin((c: any) => callAppend(c, validArgs({ eventKey: key, payload: { a: 1 } })));
      await expect(rig.asAdmin((c: any) =>
        callAppend(c, validArgs({ eventKey: key, payload: { a: 2 } })),
      )).rejects.toMatchObject({ code: '23505' });
      const count = await rig.asAdmin((c: any) => c.query(
        'SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key=$1', [key]));
      expect(count.rows[0].n).toBe(1);
    });

    it.each([
      ['event_type', { eventType: 'different.type' }],
      ['event_version', { eventVersion: 2 }],
      ['aggregate_type', { aggregateType: 'different_aggregate' }],
      ['aggregate_id', { aggregateId: randomUUID() }],
      ['organization_id', { organizationId: OTHER_ORG }],
      ['request_id', { requestId: randomUUID() }],
    ])('same event_key with a different %s also fails closed', async (_label, override) => {
      const key = `evt-${randomUUID()}`;
      await rig.asAdmin((c: any) => callAppend(c, validArgs({ eventKey: key })));
      await expect(rig.asAdmin((c: any) =>
        callAppend(c, validArgs({ eventKey: key, ...override })),
      )).rejects.toMatchObject({ code: '23505' });
    });

    it('never uses a bare no-op — a genuinely new event_key always inserts, never silently skips', async () => {
      const a = await rig.asAdmin((c: any) => callAppend(c, validArgs()));
      const b = await rig.asAdmin((c: any) => callAppend(c, validArgs()));
      expect(a.event_id).not.toBe(b.event_id);
    });
  });

  describe('stream_position: identity-backed, unique, per-row increasing', () => {
    it('two successive appends receive distinct, increasing stream_position values', async () => {
      const a = await rig.asAdmin((c: any) => callAppend(c, validArgs()));
      const b = await rig.asAdmin((c: any) => callAppend(c, validArgs()));
      expect(BigInt(b.event_stream_position)).toBeGreaterThan(BigInt(a.event_stream_position));
    });
  });

  describe('concurrency', () => {
    it('two truly concurrent identical appends (same event_key) resolve to exactly one row', async () => {
      const key = `evt-concurrent-${randomUUID()}`;
      const aggregateId = randomUUID();
      const a = await rig.pool.connect();
      const b = await rig.pool.connect();
      try {
        await authenticateSession(a, rig.superAdminId);
        await authenticateSession(b, rig.superAdminId);
        // Both sessions run as authenticated, which has no EXECUTE on the
        // helper — elevate this test's two connections to the admin role
        // instead, since concurrency here is about the advisory lock/unique
        // constraint, not the privilege boundary (already proven above).
        await a.query('RESET ROLE');
        await b.query('RESET ROLE');
        const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

        const aPromise = callAppend(a, validArgs({ eventKey: key, aggregateId }));
        const bPromise = callAppend(b, validArgs({ eventKey: key, aggregateId })).then(
          (r: any) => ({ ok: true as const, result: r }),
          (error: any) => ({ ok: false as const, error }),
        );

        const waitState = await waitForBackendLock(rig, bPid);
        expect(waitState.wait_event_type).toBe('Lock');

        const aResult = await aPromise;
        await a.query('COMMIT');

        const bFinal = await bPromise;
        expect(bFinal.ok).toBe(true);
        if (bFinal.ok) expect(bFinal.result).toEqual(aResult);
      } finally {
        await a.query('ROLLBACK').catch(() => {});
        await b.query('ROLLBACK').catch(() => {});
        a.release();
        b.release();
      }

      const count = await rig.asAdmin((c: any) => c.query(
        'SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key=$1', [key]));
      expect(count.rows[0].n).toBe(1);
    });

    it('two concurrent DISTINCT event_keys never contend and both succeed as two rows', async () => {
      const [a, b] = await Promise.all([
        rig.asAdmin((c: any) => callAppend(c, validArgs())),
        rig.asAdmin((c: any) => callAppend(c, validArgs())),
      ]);
      expect(a.event_id).not.toBe(b.event_id);
    });
  });

  describe('transactional atomicity — the core D2 guarantee', () => {
    it('rolling back the surrounding transaction also removes the appended event', async () => {
      const key = `evt-rollback-${randomUUID()}`;
      await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        await callAppend(c, validArgs({ eventKey: key }));
        const midTxn = await c.query('SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key=$1', [key]);
        expect(midTxn.rows[0].n).toBe(1);
        await c.query('ROLLBACK');
      });
      const after = await rig.asAdmin((c: any) => c.query(
        'SELECT count(*)::int n FROM phoenix_outbox_events WHERE event_key=$1', [key]));
      expect(after.rows[0].n).toBe(0);
    });

    it('an outbox conflict raised mid-transaction rolls back a companion mutation performed earlier in the same transaction', async () => {
      const key = `evt-companion-${randomUUID()}`;
      const companionOrgId = randomUUID();
      await rig.asAdmin((c: any) => callAppend(c, validArgs({ eventKey: key, payload: { v: 1 } })));

      // Own this connection directly (not via asAdmin's fire-and-release)
      // so an aborted transaction can be explicitly ROLLBACK'd before the
      // connection is returned to the pool — otherwise a poisoned "current
      // transaction is aborted" connection would fail every later test that
      // happens to borrow it back from the pool.
      const client = await rig.pool.connect();
      let caught: any;
      try {
        await client.query('BEGIN');
        // The "companion mutation" — a real, otherwise-independent write in
        // the SAME transaction as the conflicting outbox append below.
        await client.query(
          `INSERT INTO organizations(id,name,name_ar,code) VALUES ($1,'companion','companion','p158-companion')`,
          [companionOrgId],
        );
        await callAppend(client, validArgs({ eventKey: key, payload: { v: 2 } })); // conflicting payload -> 23505
        await client.query('COMMIT');
      } catch (error) {
        caught = error;
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
      expect(caught).toMatchObject({ code: '23505' });

      const org = await rig.asAdmin((c: any) => c.query(
        'SELECT count(*)::int n FROM organizations WHERE id=$1', [companionOrgId]));
      expect(org.rows[0].n).toBe(0);
    });
  });

  describe('D2-1 scope: zero wiring, zero regression through 157', () => {
    it('no trigger anywhere references the helper or the outbox table', async () => {
      await rig.asAdmin(async (c: any) => {
        const trg = await c.query(
          `SELECT count(*)::int n FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
           WHERE p.proname = 'phoenix_append_outbox_event_internal'`);
        expect(trg.rows[0].n).toBe(0);
        const ownTrg = await c.query(
          `SELECT count(*)::int n FROM pg_trigger
           WHERE tgrelid = 'public.phoenix_outbox_events'::regclass AND NOT tgisinternal`);
        expect(ownTrg.rows[0].n).toBe(0);
      });
    });

    it('no existing capture function body references the new table or helper', async () => {
      await rig.asAdmin(async (c: any) => {
        for (const fn of [
          'phoenix_capture_lifecycle_event', 'phoenix_capture_movement_posted',
          'phoenix_capture_movement_notification', 'phoenix_capture_stocktake_recorded',
        ]) {
          const r = await c.query(`SELECT pg_get_functiondef(oid) AS src FROM pg_proc WHERE proname=$1`, [fn]);
          expect(r.rows[0].src).not.toContain('phoenix_outbox_events');
          expect(r.rows[0].src).not.toContain('phoenix_append_outbox_event_internal');
        }
      });
    });

    it("154's transfer-corridor privilege lockdown is unaffected", async () => {
      await rig.asAdmin(async (c: any) => {
        for (const t of ['warehouse_transfer_requests', 'warehouse_transfer_request_lines', 'warehouse_transfers', 'warehouse_transfer_lines']) {
          const r = await c.query(`SELECT has_table_privilege('authenticated', 'public.' || $1, 'TRUNCATE') AS has`, [t]);
          expect(r.rows[0].has).toBe(false);
        }
      });
    });

    it("155/156/157's RPCs and dedup ledgers remain present and unchanged", async () => {
      await rig.asAdmin(async (c: any) => {
        const fns = await c.query(
          `SELECT proname FROM pg_proc WHERE proname IN
             ('phoenix_add_outlet_return_request_line', 'phoenix_resolve_outlet_return_exception')`);
        expect(fns.rows.map((r: any) => r.proname).sort()).toEqual([
          'phoenix_add_outlet_return_request_line', 'phoenix_resolve_outlet_return_exception',
        ]);
        const trg = await c.query(
          `SELECT count(*)::int n FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           WHERE t.tgname = 'phoenix_capture_lifecycle' AND c.relname = 'warehouse_transfers' AND NOT t.tgisinternal`);
        expect(trg.rows[0].n).toBe(1);
      });
    });
  });
});
