/**
 * D3-2B DISPATCH ORCHESTRATION — DYNAMIC integration proof, against a real
 * disposable Postgres with 001->163 applied in order.
 *
 * SCOPE. This file proves the ORCHESTRATION contract of
 * supabase/functions/phoenix-outbox-dispatcher/lib/dispatch.ts against the
 * real D3-1 consumer foundation: that runDispatchCycle claims once, routes
 * each claimed row's single outcome to exactly one real database
 * transition, propagates every real database rejection unchanged, and never
 * touches the D2 Outbox source rows.
 *
 * It deliberately does NOT re-prove the D3-1 state machine itself. The
 * database-level semantics — lease theft, idempotent replay, backoff curve,
 * dead-letter terminality, cross-consumer isolation, privilege lockdown,
 * caller-supplied-organization rejection, gap-safe discovery, bounded
 * diagnostics — are already proven exhaustively by
 * 163-outbox-consumer-foundation.dynamic.test.ts (593 lines, 20-point proof
 * list) and by 163-verification-hardening.dynamic.test.ts. Each
 * orchestration route is exercised here exactly once, end to end, and the
 * deeper state-machine proofs are cited rather than duplicated.
 *
 * ENVIRONMENT. Loopback-only, disposable-database-only, and gated behind an
 * explicit closure-run flag. See the guard block below and
 * docs/phoenix/D3-2B-DISPATCH-ORCHESTRATION-INTEGRATION.md.
 *
 *   PHOENIX_D3_2B_TEST_ONLY=1
 *   PHOENIX_RIG_DB=phoenix_rig_d3_2b
 *   PHOENIX_RIG_PG=postgres://postgres@127.0.0.1:55432/postgres
 *
 * Gated on PHOENIX_RIG_PG *and* PHOENIX_D3_2B_TEST_ONLY; skipped in
 * CI-without-rig and in generic full-suite runs, matching the established
 * repository skip behavior for every other *.dynamic.test.ts. A SKIP IS NOT
 * A PASS: the dedicated D3-2B closure command pre-checks both variables and
 * fails before Vitest starts if either is absent.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, migrationFiles, rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import { runDispatchCycle } from '../../functions/phoenix-outbox-dispatcher/lib/dispatch.ts';
import type { ProcessOutcome } from '../../functions/phoenix-outbox-dispatcher/lib/dispatch.ts';
import type {
  ClaimBatchInput,
  ClaimedOutboxEvent,
  MarkCompletedInput,
  MarkCompletedResult,
  MarkFailedInput,
  MarkFailedResult,
  OutboxRpcClient,
  ReleaseLeaseInput,
  ReleaseLeaseResult,
} from '../../functions/phoenix-outbox-dispatcher/lib/rpc-client.ts';

// ── Mandatory test-environment guards ───────────────────────────────────────

const REQUIRED_RIG_DB = 'phoenix_rig_d3_2b';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Negative controls. These two literals exist in this file ONLY so the guard
// below can REJECT a connection string containing either. No test, fixture,
// or query ever targets them.
const FORBIDDEN_CONNECTION_SUBSTRINGS = ['eyrzxgfkvqybjdgyphap', 'supabase.co'];

/**
 * Fail-closed inspection of PHOENIX_RIG_PG. Anything not provably a local,
 * disposable Postgres is rejected outright — a malformed URL, a non-loopback
 * host, a Production project reference, or a hosted Supabase domain.
 */
function assertLoopbackDisposableConnection(raw: string | undefined): URL {
  if (!raw) throw new Error('D3-2B guard: PHOENIX_RIG_PG is not set');

  for (const forbidden of FORBIDDEN_CONNECTION_SUBSTRINGS) {
    if (raw.includes(forbidden)) {
      throw new Error(`D3-2B guard: PHOENIX_RIG_PG must not reference "${forbidden}"`);
    }
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('D3-2B guard: PHOENIX_RIG_PG is not a parseable URL');
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`D3-2B guard: unsupported scheme "${url.protocol}"`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`D3-2B guard: host "${url.hostname}" is not loopback-only`);
  }

  // The maintenance database itself must not be an application database.
  const maintenanceDb = url.pathname.replace(/^\//, '');
  if (/^(prod|production|phoenix_prod|medistock)/i.test(maintenanceDb)) {
    throw new Error(`D3-2B guard: refusing a Production-shaped database "${maintenanceDb}"`);
  }
  return url;
}

function assertDisposableRigDbName(name: string | undefined): string {
  if (name !== REQUIRED_RIG_DB) {
    throw new Error(
      `D3-2B guard: PHOENIX_RIG_DB must be exactly "${REQUIRED_RIG_DB}" (got "${name ?? '<unset>'}")`,
    );
  }
  return name;
}

const D3_2B_FLAG = process.env.PHOENIX_D3_2B_TEST_ONLY;
const D3_2B_ENABLED = D3_2B_FLAG === '1';
const run = rigAvailable() && D3_2B_ENABLED ? describe : describe.skip;

// ── Probe fixtures — clearly non-production, always organization-scoped ─────

const PROBE_PREFIX = 'probe_nonprod_d3_2_v1';
const ORG_A = '00000000-0000-0000-0000-0000032b0001';
const ORG_B = '00000000-0000-0000-0000-0000032b0002';
const WH = '00000000-0000-0000-0000-0000032b0101';
const PERFORMER = '00000000-0000-0000-0000-0000032b0501';

let seq = 0;
const probeKey = (suffix: string) => `${PROBE_PREFIX}-${suffix}-${Date.now()}-${seq++}`;

const EXPECTED_CLAIM_FIELDS = [
  'aggregateId',
  'aggregateType',
  'attemptCount',
  'deliveryStateId',
  'eventKey',
  'eventType',
  'eventVersion',
  'leaseExpiresAt',
  'occurredAt',
  'organizationId',
  'outboxEventId',
  'payload',
];

/**
 * The canonical migration chain itself seeds exactly these two baseline
 * organizations (migration 001, re-asserted by 004), so a freshly built rig
 * is NEVER literally empty of organizations and cannot be made so without
 * modifying a migration — which D3-2B forbids.
 *
 * The emptiness guard below therefore asserts the strictly stronger,
 * achievable property: the organization set is EXACTLY these two known
 * chain-seeded rows and nothing else. That proves this is a pristine
 * disposable rig (not a copy, restore, or clone of any real database) far
 * more precisely than a bare count would. The three D3 Outbox tables, which
 * are the ones this suite actually writes to, are still required to be
 * literally zero. No probe consumer or probe event ever references either
 * baseline organization — asserted at the end of this file.
 */
const CHAIN_SEEDED_ORGANIZATION_IDS = [
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
];

const REQUIRED_163_FUNCTIONS = [
  'public.phoenix_outbox_claim_batch(text,uuid,integer)',
  'public.phoenix_outbox_mark_completed(text,uuid,uuid)',
  'public.phoenix_outbox_mark_failed(text,uuid,uuid,text,text)',
  'public.phoenix_outbox_release_lease(text,uuid,uuid)',
];

interface Baseline {
  migrationFileCount: number;
  maxMigrationVersion: number;
  migration163FileCount: number;
  filesAbove163: string[];
  organizations: number;
  organizationIds: string[];
  outboxEvents: number;
  outboxConsumers: number;
  outboxDeliveryState: number;
  consumersTable: string | null;
  deliveryStateTable: string | null;
  functionsPresent: string[];
}

run('163 D3-2B dispatch orchestration — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let baseline: Baseline;
  let connection: URL;

  beforeAll(async () => {
    // (1) Environment guards run BEFORE anything is built or inserted.
    connection = assertLoopbackDisposableConnection(process.env.PHOENIX_RIG_PG);
    assertDisposableRigDbName(process.env.PHOENIX_RIG_DB);
    if (!D3_2B_ENABLED) {
      throw new Error('D3-2B guard: PHOENIX_D3_2B_TEST_ONLY=1 is required');
    }

    // (2) Verify the migration set buildRig({upTo:163}) will actually apply,
    // before it applies it. Nothing above 163 may ever enter this rig.
    const files: string[] = migrationFiles(163);
    const versions = files.map((f: string) => parseInt(f.slice(0, 3), 10));
    const filesAbove163 = files.filter((f: string) => parseInt(f.slice(0, 3), 10) > 163);
    const migration163Files = files.filter((f: string) => f.startsWith('163_'));
    if (filesAbove163.length > 0) {
      throw new Error(`D3-2B guard: migration set includes files above 163: ${filesAbove163.join(', ')}`);
    }
    if (Math.max(...versions) !== 163) {
      throw new Error(`D3-2B guard: maximum migration version is ${Math.max(...versions)}, expected 163`);
    }
    if (migration163Files.length !== 1) {
      throw new Error(`D3-2B guard: expected exactly one Migration 163 file, found ${migration163Files.length}`);
    }

    rig = await buildRig({ upTo: 163 });

    // (3) Post-build, pre-fixture baseline. A rig that is not empty here is
    // not a disposable rig, and this suite refuses to seed into it.
    baseline = await rig.asAdmin(async (c: any) => {
      const count = async (table: string) =>
        (await c.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n as number;
      const reg = async (table: string) =>
        (await c.query(`SELECT to_regclass($1) AS r`, [table])).rows[0].r as string | null;

      const functionsPresent: string[] = [];
      for (const sig of REQUIRED_163_FUNCTIONS) {
        const r = await c.query(`SELECT to_regprocedure($1) AS r`, [sig]);
        if (r.rows[0].r) functionsPresent.push(sig);
      }

      return {
        migrationFileCount: files.length,
        maxMigrationVersion: Math.max(...versions),
        migration163FileCount: migration163Files.length,
        filesAbove163,
        organizations: await count('organizations'),
        organizationIds: (await c.query(`SELECT id FROM organizations ORDER BY id`)).rows.map(
          (r: any) => r.id as string,
        ),
        outboxEvents: await count('phoenix_outbox_events'),
        outboxConsumers: await count('phoenix_outbox_consumers'),
        outboxDeliveryState: await count('phoenix_outbox_delivery_state'),
        consumersTable: await reg('public.phoenix_outbox_consumers'),
        deliveryStateTable: await reg('public.phoenix_outbox_delivery_state'),
        functionsPresent,
      } satisfies Baseline;
    });

    // The organization set must be EXACTLY the chain-seeded baseline (see
    // CHAIN_SEEDED_ORGANIZATION_IDS) — any extra row means this is not a
    // pristine disposable rig, and this suite refuses to seed into it.
    const unexpectedOrgs = baseline.organizationIds.filter(
      (id) => !CHAIN_SEEDED_ORGANIZATION_IDS.includes(id),
    );
    if (unexpectedOrgs.length > 0) {
      throw new Error(`D3-2B guard: rig is not pristine — unexpected organizations: ${unexpectedOrgs.join(', ')}`);
    }
    if (baseline.organizations !== CHAIN_SEEDED_ORGANIZATION_IDS.length) {
      throw new Error(
        `D3-2B guard: expected exactly ${CHAIN_SEEDED_ORGANIZATION_IDS.length} chain-seeded organizations, found ${baseline.organizations}`,
      );
    }

    for (const [name, value] of Object.entries({
      phoenix_outbox_events: baseline.outboxEvents,
      phoenix_outbox_consumers: baseline.outboxConsumers,
      phoenix_outbox_delivery_state: baseline.outboxDeliveryState,
    })) {
      if (value !== 0) {
        throw new Error(`D3-2B guard: rig is not empty — ${name} has ${value} rows`);
      }
    }
    if (baseline.functionsPresent.length !== REQUIRED_163_FUNCTIONS.length) {
      throw new Error('D3-2B guard: one or more Migration 163 functions is missing');
    }

    // (4) Only now: test-local fixtures. Two throwaway organizations, one
    // warehouse, one performer. No real organization is ever referenced.
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code) VALUES
        ('${ORG_A}','D3-2B Probe A','د3-2ب أ','probe-d32b-a'),
        ('${ORG_B}','D3-2B Probe B','د3-2ب ب','probe-d32b-b')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code)
        VALUES ('${WH}','${ORG_A}','D3-2B WH','د3-2ب مخزن','active','institution','probe-d32b-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(
        `INSERT INTO auth.users (id,email) VALUES ('${PERFORMER}','probe-d32b@rig.local') ON CONFLICT (id) DO NOTHING;`,
      );
    });
  }, 120000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  // ── Synthetic events come ONLY from the real producer path ────────────────

  /**
   * A real stocktake INSERT fires 162's own trigger, which appends one real
   * Outbox event. No phoenix_outbox_events row is ever hand-inserted here —
   * every event this suite dispatches was produced exactly the way
   * Production would produce one.
   */
  async function makeRealEvent(orgId: string, notes = 'd3-2b probe') {
    const stocktakeId = randomUUID();
    await rig.asAdmin((c: any) =>
      c.query(
        `INSERT INTO stocktakes (id, organization_id, scope_kind, scope_id, notes, performed_by)
         VALUES ($1,$2,'warehouse',$3,$4,$5)`,
        [stocktakeId, orgId, WH, notes, PERFORMER],
      ),
    );
    return stocktakeId;
  }

  /**
   * Registers an ALWAYS organization-scoped probe consumer. organization_id
   * is never null (no global probe consumer is ever created) and the key is
   * always probe-prefixed, so nothing here can be mistaken for, or collide
   * with, a real registration. The discovery cursor is fast-forwarded so
   * each test sees only its own events (see the 163 suite for why).
   */
  async function registerProbeConsumer(
    key: string,
    opts: { orgId: string; maxAttempts?: number; leaseSeconds?: number; enabled?: boolean } = { orgId: ORG_A },
  ) {
    expect(key.startsWith(PROBE_PREFIX), 'probe consumer keys must be probe-prefixed').toBe(true);
    expect(opts.orgId, 'probe consumers must never be global').toBeTruthy();
    await rig.asAdmin((c: any) =>
      c.query(
        `INSERT INTO phoenix_outbox_consumers (consumer_key, organization_id, max_attempts, lease_duration_seconds, is_enabled)
         VALUES ($1,$2,$3,$4,$5)`,
        [key, opts.orgId, opts.maxAttempts ?? 5, opts.leaseSeconds ?? 300, opts.enabled ?? true],
      ),
    );
    await rig.asAdmin((c: any) =>
      c.query(
        `UPDATE phoenix_outbox_consumers
            SET last_discovered_stream_position = COALESCE((SELECT max(stream_position) FROM phoenix_outbox_events), 0)
          WHERE consumer_key = $1`,
        [key],
      ),
    );
  }

  // ── Inline, pg-rig-ONLY adapter ──────────────────────────────────────────
  //
  // This is a TEST adapter and nothing else. It is deliberately declared
  // inline in this file rather than in supabase/functions/**, because D3-2B
  // authorizes no reusable production database adapter: shipping one would
  // be a scope expansion, and a real adapter needs a client, credentials and
  // a deployment story that are all explicitly out of scope here.
  //
  // Its only job is the snake_case -> camelCase mapping that the portable
  // OutboxRpcClient contract declares.

  interface AdapterStats {
    claimCalls: number;
    tokensSeen: string[];
  }

  const newStats = (): AdapterStats => ({ claimCalls: 0, tokensSeen: [] });

  function toClaimedOutboxEvent(row: any): ClaimedOutboxEvent {
    return {
      deliveryStateId: row.delivery_state_id,
      outboxEventId: row.outbox_event_id,
      eventKey: row.event_key,
      eventType: row.event_type,
      eventVersion: row.event_version,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      organizationId: row.organization_id,
      payload: row.payload,
      occurredAt: new Date(row.occurred_at).toISOString(),
      attemptCount: row.attempt_count,
      leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
    };
  }

  function makeRigAdapter(stats: AdapterStats = newStats()): OutboxRpcClient & { stats: AdapterStats } {
    return {
      stats,
      async claimBatch(input: ClaimBatchInput): Promise<readonly ClaimedOutboxEvent[]> {
        stats.claimCalls += 1;
        stats.tokensSeen.push(input.leaseToken);
        const r = await rig.asAdmin((c: any) =>
          c.query(`SELECT * FROM phoenix_outbox_claim_batch($1,$2,$3)`, [
            input.consumerKey,
            input.leaseToken,
            input.batchSize,
          ]),
        );
        return r.rows.map(toClaimedOutboxEvent);
      },
      async markCompleted(input: MarkCompletedInput): Promise<MarkCompletedResult> {
        stats.tokensSeen.push(input.leaseToken);
        const r = await rig.asAdmin((c: any) =>
          c.query(`SELECT phoenix_outbox_mark_completed($1,$2,$3) AS r`, [
            input.consumerKey,
            input.deliveryStateId,
            input.leaseToken,
          ]),
        );
        const j = r.rows[0].r;
        return {
          ok: j.ok,
          alreadyCompleted: j.already_completed,
          deliveryStateId: j.delivery_state_id,
          completedAt: j.completed_at,
        };
      },
      async markFailed(input: MarkFailedInput): Promise<MarkFailedResult> {
        stats.tokensSeen.push(input.leaseToken);
        const r = await rig.asAdmin((c: any) =>
          c.query(`SELECT phoenix_outbox_mark_failed($1,$2,$3,$4,$5) AS r`, [
            input.consumerKey,
            input.deliveryStateId,
            input.leaseToken,
            input.errorCode,
            input.errorSummary,
          ]),
        );
        const j = r.rows[0].r;
        return {
          ok: j.ok,
          deliveryStateId: j.delivery_state_id,
          status: j.status,
          attemptCount: j.attempt_count,
          availableAt: j.available_at,
          deadLetterAt: j.dead_letter_at,
        };
      },
      async releaseLease(input: ReleaseLeaseInput): Promise<ReleaseLeaseResult> {
        stats.tokensSeen.push(input.leaseToken);
        const r = await rig.asAdmin((c: any) =>
          c.query(`SELECT phoenix_outbox_release_lease($1,$2,$3) AS r`, [
            input.consumerKey,
            input.deliveryStateId,
            input.leaseToken,
          ]),
        );
        const j = r.rows[0].r;
        return { ok: j.ok, deliveryStateId: j.delivery_state_id, availableAt: j.available_at };
      },
    };
  }

  const completedOutcome = (): Promise<ProcessOutcome> => Promise.resolve({ kind: 'completed' });
  const failedOutcome = (code: string, summary: string) => (): Promise<ProcessOutcome> =>
    Promise.resolve({ kind: 'failed', errorCode: code, errorSummary: summary });
  const releasedOutcome = (): Promise<ProcessOutcome> => Promise.resolve({ kind: 'released' });

  const deliveryRow = (dsId: string) =>
    rig
      .asAdmin((c: any) =>
        c.query(
          `SELECT status, attempt_count, available_at, dead_letter_at, lease_expires_at, completed_at
             FROM phoenix_outbox_delivery_state WHERE id = $1`,
          [dsId],
        ),
      )
      .then((r: any) => r.rows[0]);

  // ── Environment / baseline proofs ────────────────────────────────────────

  describe('test-environment guards (proved, not merely assumed)', () => {
    it('runs only against a loopback, disposable, non-Production database', () => {
      expect(D3_2B_FLAG).toBe('1');
      expect(process.env.PHOENIX_RIG_DB).toBe(REQUIRED_RIG_DB);
      expect(['postgres:', 'postgresql:']).toContain(connection.protocol);
      expect(LOOPBACK_HOSTS.has(connection.hostname)).toBe(true);
      for (const forbidden of FORBIDDEN_CONNECTION_SUBSTRINGS) {
        expect(process.env.PHOENIX_RIG_PG).not.toContain(forbidden);
      }
    });

    it('applied exactly the 001->163 migration set, with nothing above 163', () => {
      expect(baseline.maxMigrationVersion).toBe(163);
      expect(baseline.migration163FileCount).toBe(1);
      expect(baseline.filesAbove163).toEqual([]);
      expect(baseline.migrationFileCount).toBeGreaterThan(0);
    });

    it('the rig was pristine before any fixture was created', () => {
      // Organizations: exactly the chain-seeded baseline, nothing else.
      expect(baseline.organizationIds).toEqual(CHAIN_SEEDED_ORGANIZATION_IDS);
      expect(baseline.organizations).toBe(CHAIN_SEEDED_ORGANIZATION_IDS.length);
      // Everything D3 writes to: literally zero.
      expect(baseline.outboxEvents).toBe(0);
      expect(baseline.outboxConsumers).toBe(0);
      expect(baseline.outboxDeliveryState).toBe(0);
    });

    it('both D3-1 tables and all four Migration 163 functions exist', () => {
      expect(baseline.consumersTable).toBe('phoenix_outbox_consumers');
      expect(baseline.deliveryStateTable).toBe('phoenix_outbox_delivery_state');
      expect(baseline.functionsPresent).toEqual(REQUIRED_163_FUNCTIONS);
    });

    it('every consumer this suite ever registers is probe-named and organization-scoped', async () => {
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(`SELECT consumer_key, organization_id FROM phoenix_outbox_consumers`);
        for (const row of r.rows) {
          expect(row.consumer_key.startsWith(PROBE_PREFIX)).toBe(true);
          expect(row.organization_id).not.toBeNull();
          expect([ORG_A, ORG_B]).toContain(row.organization_id);
        }
      });
    });
  });

  // ── Orchestration routes ─────────────────────────────────────────────────

  describe('claim scoping and the single-claim contract', () => {
    it('an organization-scoped probe receives ONLY its own organization\'s event, via exactly one claim call', async () => {
      const key = probeKey('scoped');
      await registerProbeConsumer(key, { orgId: ORG_A });
      const mine = await makeRealEvent(ORG_A, 'scoped mine');
      await makeRealEvent(ORG_B, 'scoped theirs');

      const client = makeRigAdapter();
      const seen: ClaimedOutboxEvent[] = [];
      const summary = await runDispatchCycle({
        client,
        consumerKey: key,
        leaseToken: randomUUID(),
        batchSize: 10,
        processEvent: (e) => {
          seen.push(e);
          return completedOutcome();
        },
      });

      expect(summary).toEqual({ claimed: 1, completed: 1, failed: 0, released: 0 });
      expect(seen).toHaveLength(1);
      expect(seen[0].organizationId).toBe(ORG_A);
      expect(seen[0].aggregateId).toBe(mine);
      // One cycle performs exactly one claim call — never a poll loop.
      expect(client.stats.claimCalls).toBe(1);
    });

    it('the inline adapter maps every SQL snake_case column to the portable camelCase field exactly', async () => {
      const key = probeKey('mapping');
      await registerProbeConsumer(key, { orgId: ORG_A });
      const stocktakeId = await makeRealEvent(ORG_A, 'mapping probe');

      let captured: ClaimedOutboxEvent | undefined;
      await runDispatchCycle({
        client: makeRigAdapter(),
        consumerKey: key,
        leaseToken: randomUUID(),
        batchSize: 10,
        processEvent: (e) => {
          captured = e;
          return completedOutcome();
        },
      });

      expect(captured).toBeDefined();
      const event = captured!;
      expect(Object.keys(event).sort()).toEqual(EXPECTED_CLAIM_FIELDS);
      for (const field of Object.keys(event)) {
        expect(field, 'no snake_case field may leak through the adapter').not.toMatch(/_/);
      }

      // Values must equal the underlying SQL row, field for field.
      await rig.asAdmin(async (c: any) => {
        const r = await c.query(
          `SELECT e.id, e.event_key, e.event_type, e.event_version, e.aggregate_type,
                  e.aggregate_id, e.organization_id, e.payload, e.occurred_at
             FROM phoenix_outbox_events e WHERE e.aggregate_id = $1`,
          [stocktakeId],
        );
        const row = r.rows[0];
        expect(event.outboxEventId).toBe(row.id);
        expect(event.eventKey).toBe(row.event_key);
        expect(event.eventType).toBe(row.event_type);
        expect(event.eventVersion).toBe(row.event_version);
        expect(event.aggregateType).toBe(row.aggregate_type);
        expect(event.aggregateId).toBe(row.aggregate_id);
        expect(event.organizationId).toBe(row.organization_id);
        expect(event.payload).toEqual(row.payload);
        expect(event.occurredAt).toBe(new Date(row.occurred_at).toISOString());
        expect(typeof event.attemptCount).toBe('number');
        expect(typeof event.leaseExpiresAt).toBe('string');
      });
    });
  });

  describe('outcome routing against real delivery state', () => {
    it('a completed outcome leaves the delivery row completed', async () => {
      const key = probeKey('completed');
      await registerProbeConsumer(key, { orgId: ORG_A });
      await makeRealEvent(ORG_A, 'completed route');

      let dsId = '';
      const summary = await runDispatchCycle({
        client: makeRigAdapter(),
        consumerKey: key,
        leaseToken: randomUUID(),
        batchSize: 10,
        processEvent: (e) => {
          dsId = e.deliveryStateId;
          return completedOutcome();
        },
      });

      expect(summary).toEqual({ claimed: 1, completed: 1, failed: 0, released: 0 });
      const row = await deliveryRow(dsId);
      expect(row.status).toBe('completed');
      expect(row.completed_at).toBeTruthy();
      expect(row.attempt_count).toBe(0);
      // Terminality of 'completed' itself is proven by the 163 suite
      // ("a completed event can never return to pending or leased").
    });

    it('a failed outcome increments attempt_count and leaves a pending/backoff row', async () => {
      const key = probeKey('failed');
      await registerProbeConsumer(key, { orgId: ORG_A, maxAttempts: 5 });
      await makeRealEvent(ORG_A, 'failed route');

      let dsId = '';
      const before = Date.now();
      const summary = await runDispatchCycle({
        client: makeRigAdapter(),
        consumerKey: key,
        leaseToken: randomUUID(),
        batchSize: 10,
        processEvent: (e) => {
          dsId = e.deliveryStateId;
          return failedOutcome('probe_failure', 'd3-2b probe failure')();
        },
      });

      expect(summary).toEqual({ claimed: 1, completed: 0, failed: 1, released: 0 });
      const row = await deliveryRow(dsId);
      expect(row.status).toBe('pending');
      expect(row.attempt_count).toBe(1);
      expect(row.dead_letter_at).toBeNull();
      expect(new Date(row.available_at).getTime()).toBeGreaterThan(before);
      // The exact backoff curve (30s, 60s, 120s ... capped at 1h) is proven
      // by the 163 suite; here it only matters that a backoff was applied.
    });

    it('a max_attempts=1 consumer reaches dead_letter after ONE failed outcome', async () => {
      const key = probeKey('deadletter');
      await registerProbeConsumer(key, { orgId: ORG_A, maxAttempts: 1 });
      await makeRealEvent(ORG_A, 'dead letter route');

      let dsId = '';
      const summary = await runDispatchCycle({
        client: makeRigAdapter(),
        consumerKey: key,
        leaseToken: randomUUID(),
        batchSize: 10,
        processEvent: (e) => {
          dsId = e.deliveryStateId;
          return failedOutcome('probe_fatal', 'one strike')();
        },
      });

      expect(summary).toEqual({ claimed: 1, completed: 0, failed: 1, released: 0 });
      const row = await deliveryRow(dsId);
      expect(row.status).toBe('dead_letter');
      expect(row.attempt_count).toBe(1);
      expect(row.dead_letter_at).toBeTruthy();
    });

    it('a released outcome returns the row to pending WITHOUT incrementing attempt_count', async () => {
      const key = probeKey('released');
      await registerProbeConsumer(key, { orgId: ORG_A });
      await makeRealEvent(ORG_A, 'released route');

      let dsId = '';
      const summary = await runDispatchCycle({
        client: makeRigAdapter(),
        consumerKey: key,
        leaseToken: randomUUID(),
        batchSize: 10,
        processEvent: (e) => {
          dsId = e.deliveryStateId;
          return releasedOutcome();
        },
      });

      expect(summary).toEqual({ claimed: 1, completed: 0, failed: 0, released: 1 });
      const row = await deliveryRow(dsId);
      expect(row.status).toBe('pending');
      expect(row.attempt_count).toBe(0);
      expect(row.lease_expires_at).toBeNull();
    });
  });

  describe('fail-closed exception behavior against the real database', () => {
    it('a processor rejection leaves the row leased, and the expired lease is later reclaimed without burning an attempt', async () => {
      const key = probeKey('expiry');
      await registerProbeConsumer(key, { orgId: ORG_A, leaseSeconds: 300 });
      await makeRealEvent(ORG_A, 'expiry route');

      const boom = new Error('probe processor exploded');
      let dsId = '';
      const client = makeRigAdapter();

      await expect(
        runDispatchCycle({
          client,
          consumerKey: key,
          leaseToken: randomUUID(),
          batchSize: 10,
          processEvent: (e) => {
            dsId = e.deliveryStateId;
            return Promise.reject(boom);
          },
        }),
      ).rejects.toBe(boom);

      // Deliberately NOT finalized: still leased, attempt untouched.
      const afterThrow = await deliveryRow(dsId);
      expect(afterThrow.status).toBe('leased');
      expect(afterThrow.attempt_count).toBe(0);
      expect(client.stats.claimCalls).toBe(1);

      // Force the lease into the past — the worker that died never released.
      await rig.asAdmin((c: any) =>
        c.query(`UPDATE phoenix_outbox_delivery_state SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [
          dsId,
        ]),
      );

      const reclaimed: string[] = [];
      const summary = await runDispatchCycle({
        client: makeRigAdapter(),
        consumerKey: key,
        leaseToken: randomUUID(),
        batchSize: 10,
        processEvent: (e) => {
          reclaimed.push(e.deliveryStateId);
          return completedOutcome();
        },
      });

      expect(reclaimed).toEqual([dsId]);
      expect(summary).toEqual({ claimed: 1, completed: 1, failed: 0, released: 0 });
      const final = await deliveryRow(dsId);
      expect(final.status).toBe('completed');
      // Reclaim-by-expiry never increments attempt_count (163 design).
      expect(final.attempt_count).toBe(0);
    });

    it('a disabled consumer\'s rejection is propagated by runDispatchCycle, not swallowed', async () => {
      const key = probeKey('disabled');
      await registerProbeConsumer(key, { orgId: ORG_A, enabled: false });
      await makeRealEvent(ORG_A, 'disabled route');

      let processed = 0;
      await expect(
        runDispatchCycle({
          client: makeRigAdapter(),
          consumerKey: key,
          leaseToken: randomUUID(),
          batchSize: 10,
          processEvent: () => {
            processed += 1;
            return completedOutcome();
          },
        }),
      ).rejects.toMatchObject({ message: expect.stringContaining('consumer_disabled') });

      expect(processed).toBe(0);
    });

    it('a foreign/stale lease token rejection from a terminal call is propagated, not swallowed', async () => {
      const key = probeKey('stale');
      await registerProbeConsumer(key, { orgId: ORG_A, leaseSeconds: 300 });
      await makeRealEvent(ORG_A, 'stale token route');

      // Lease the row out-of-band under the OWNING token, then drive a cycle
      // with a DIFFERENT token over that already-leased row. The database
      // must reject the finalization, and runDispatchCycle must surface it.
      const owningToken = randomUUID();
      const leased = await rig
        .asAdmin((c: any) => c.query(`SELECT * FROM phoenix_outbox_claim_batch($1,$2,$3)`, [key, owningToken, 10]))
        .then((r: any) => r.rows.map(toClaimedOutboxEvent));
      expect(leased).toHaveLength(1);

      const base = makeRigAdapter();
      const staleClient: OutboxRpcClient = {
        claimBatch: () => Promise.resolve(leased),
        markCompleted: (i) => base.markCompleted(i),
        markFailed: (i) => base.markFailed(i),
        releaseLease: (i) => base.releaseLease(i),
      };

      await expect(
        runDispatchCycle({
          client: staleClient,
          consumerKey: key,
          leaseToken: randomUUID(), // foreign token
          batchSize: 10,
          processEvent: completedOutcome,
        }),
      ).rejects.toMatchObject({ message: expect.stringContaining('stale_or_foreign_lease_token') });

      // The row is untouched by the failed finalization: still leased to its
      // real owner, attempt untouched.
      const row = await deliveryRow(leased[0].deliveryStateId);
      expect(row.status).toBe('leased');
      expect(row.attempt_count).toBe(0);
    });
  });

  describe('two concurrent cycles', () => {
    it('use distinct lease tokens, receive disjoint events, and never over-complete', async () => {
      const key = probeKey('concurrent');
      await registerProbeConsumer(key, { orgId: ORG_A, leaseSeconds: 300 });
      const CREATED = 6;
      for (let i = 0; i < CREATED; i++) await makeRealEvent(ORG_A, `concurrent ${i}`);

      const tokenA = randomUUID();
      const tokenB = randomUUID();
      expect(tokenA).not.toBe(tokenB);

      const seenA: string[] = [];
      const seenB: string[] = [];
      const clientA = makeRigAdapter();
      const clientB = makeRigAdapter();

      const [summaryA, summaryB] = await Promise.all([
        runDispatchCycle({
          client: clientA,
          consumerKey: key,
          leaseToken: tokenA,
          batchSize: 3,
          processEvent: (e) => {
            seenA.push(e.deliveryStateId);
            return completedOutcome();
          },
        }),
        runDispatchCycle({
          client: clientB,
          consumerKey: key,
          leaseToken: tokenB,
          batchSize: 3,
          processEvent: (e) => {
            seenB.push(e.deliveryStateId);
            return completedOutcome();
          },
        }),
      ]);

      // Distinct tokens, and each cycle used only its own token throughout.
      expect(new Set(clientA.stats.tokensSeen)).toEqual(new Set([tokenA]));
      expect(new Set(clientB.stats.tokensSeen)).toEqual(new Set([tokenB]));
      expect(clientA.stats.claimCalls).toBe(1);
      expect(clientB.stats.claimCalls).toBe(1);

      // Disjoint event sets — SKIP LOCKED semantics proven by the 163 suite;
      // proven here to survive the orchestration layer unchanged.
      const overlap = seenA.filter((id) => seenB.includes(id));
      expect(overlap).toEqual([]);

      const totalCompleted = summaryA.completed + summaryB.completed;
      expect(totalCompleted).toBe(seenA.length + seenB.length);
      expect(totalCompleted).toBeLessThanOrEqual(CREATED);
      expect(totalCompleted).toBeGreaterThan(0);
    });
  });

  describe('D2 Outbox source preservation', () => {
    it('a full mixed cycle never mutates or deletes any phoenix_outbox_events row', async () => {
      const key = probeKey('preserve');
      await registerProbeConsumer(key, { orgId: ORG_A, maxAttempts: 5 });
      for (let i = 0; i < 3; i++) await makeRealEvent(ORG_A, `preserve ${i}`);

      const snapshot = async () =>
        rig
          .asAdmin((c: any) =>
            c.query(
              `SELECT id, stream_position, event_key, event_fingerprint, event_type, event_version,
                      aggregate_type, aggregate_id, organization_id, payload, occurred_at
                 FROM phoenix_outbox_events ORDER BY stream_position`,
            ),
          )
          .then((r: any) => JSON.stringify(r.rows));

      const before = await snapshot();

      let n = 0;
      const summary = await runDispatchCycle({
        client: makeRigAdapter(),
        consumerKey: key,
        leaseToken: randomUUID(),
        batchSize: 10,
        processEvent: () => {
          n += 1;
          if (n === 1) return completedOutcome();
          if (n === 2) return failedOutcome('probe_e', 'probe s')();
          return releasedOutcome();
        },
      });

      expect(summary.claimed).toBe(3);
      expect(summary).toEqual({ claimed: 3, completed: 1, failed: 1, released: 1 });

      const after = await snapshot();
      expect(after).toBe(before);
    });
  });

  describe('no Production access of any kind', () => {
    it('every organization, consumer and event in this rig is test-local and probe-named', async () => {
      await rig.asAdmin(async (c: any) => {
        // Exactly the two chain-seeded baseline organizations plus this
        // suite's own two probe organizations — nothing else ever existed.
        const orgs = await c.query(`SELECT id, code FROM organizations`);
        expect(orgs.rows.map((r: any) => r.id).sort()).toEqual(
          [...CHAIN_SEEDED_ORGANIZATION_IDS, ORG_A, ORG_B].sort(),
        );
        for (const row of orgs.rows) {
          if (CHAIN_SEEDED_ORGANIZATION_IDS.includes(row.id)) continue;
          expect(row.code.startsWith('probe-d32b-')).toBe(true);
        }

        const consumers = await c.query(`SELECT consumer_key FROM phoenix_outbox_consumers`);
        expect(consumers.rows.length).toBeGreaterThan(0);
        for (const row of consumers.rows) expect(row.consumer_key.startsWith(PROBE_PREFIX)).toBe(true);

        // Every event was produced by 162's real stocktake trigger, for a
        // test-local organization. Nothing was hand-inserted.
        const events = await c.query(`SELECT DISTINCT event_type, organization_id FROM phoenix_outbox_events`);
        expect(events.rows.length).toBeGreaterThan(0);
        for (const row of events.rows) {
          expect(row.event_type).toBe('stocktakes.recorded');
          expect([ORG_A, ORG_B]).toContain(row.organization_id);
        }
      });

      // And the connection itself never left loopback.
      expect(LOOPBACK_HOSTS.has(connection.hostname)).toBe(true);
      for (const forbidden of FORBIDDEN_CONNECTION_SUBSTRINGS) {
        expect(process.env.PHOENIX_RIG_PG).not.toContain(forbidden);
      }
    });
  });
});
