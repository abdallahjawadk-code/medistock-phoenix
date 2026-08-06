/**
 * D3-2C RPC RESULT-SHAPE PROOF — TIER B.
 *
 * ============================ WHAT THIS FILE IS =============================
 *
 * It uses DIRECT PostgreSQL WIRE ACCESS through a test-only `PgRpcInvoker`.
 *
 *   * It does NOT use supabase-js.
 *   * It does NOT use PostgREST or the Data API.
 *   * It does NOT use the Edge Function HTTP runtime.
 *   * It does NOT exercise API keys, headers, or JWT verification.
 *
 * What it DOES prove: that the result shapes real Migration 163 SQL actually
 * produces satisfy the SHARED validators in
 * supabase/functions/phoenix-outbox-dispatcher/lib/rpc-result-validation.ts —
 * the same validators the production adapter runs. A validator that agrees
 * with a hand-written fixture but disagrees with the database would be caught
 * here and nowhere else.
 *
 * HOSTED TRANSPORT PROOF IS DEFERRED. Proving the real
 * supabase-js -> PostgREST -> Edge Function path is TIER C, the D3-2E hosted
 * verification gate. Nothing in this file may be cited as evidence about that
 * path. Tier A (offline adapter unit tests) proves adapter logic only.
 *
 * ONE DELIBERATE TRANSPORT NORMALIZATION. The node-postgres driver returns
 * `timestamptz` columns as JavaScript Date objects, whereas a JSON transport
 * delivers ISO-8601 strings. The invoker below converts those Date values to
 * ISO strings — that is TRANSPORT work, exactly what PostgREST does natively,
 * and it is done in the invoker rather than in the validator so the validator
 * keeps its single JSON-shaped contract. Every other value is passed to the
 * validators exactly as the database produced it. Note that the jsonb-returning
 * routines (mark_completed / mark_failed / release_lease) need no such step:
 * `jsonb_build_object` already renders their timestamps as strings.
 *
 * ============================== ENVIRONMENT =================================
 *
 *   PHOENIX_D3_2C_TEST_ONLY=1
 *   PHOENIX_RIG_DB=phoenix_rig_d3_2c
 *   PHOENIX_RIG_PG=postgres://postgres@127.0.0.1:55432/postgres
 *
 * Loopback-only, dedicated disposable database, gated behind an explicit
 * closure flag. A SKIP IS NOT A PASS.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig, migrationFiles, rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import {
  CLAIM_ROW_FIELDS,
  validateClaimedEvents,
  validateMarkCompletedResult,
  validateMarkFailedResult,
  validateReleaseLeaseResult,
} from '../../functions/phoenix-outbox-dispatcher/lib/rpc-result-validation.ts';

// ── Mandatory test-environment guards (run before any pool or query) ─────────

const REQUIRED_RIG_DB = 'phoenix_rig_d3_2c';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Negative controls. Present ONLY so the guard below can reject them.
const FORBIDDEN_CONNECTION_SUBSTRINGS = ['eyrzxgfkvqybjdgyphap', 'supabase.co'];

function assertLoopbackDisposableConnection(raw: string | undefined): URL {
  if (!raw) throw new Error('D3-2C guard: PHOENIX_RIG_PG is not set');
  for (const forbidden of FORBIDDEN_CONNECTION_SUBSTRINGS) {
    if (raw.includes(forbidden)) {
      throw new Error(`D3-2C guard: PHOENIX_RIG_PG must not reference "${forbidden}"`);
    }
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('D3-2C guard: PHOENIX_RIG_PG is not a parseable URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`D3-2C guard: unsupported scheme "${url.protocol}"`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`D3-2C guard: host "${url.hostname}" is not loopback-only`);
  }
  const maintenanceDb = url.pathname.replace(/^\//, '');
  if (/^(prod|production|phoenix_prod|medistock)/i.test(maintenanceDb)) {
    throw new Error(`D3-2C guard: refusing a Production-shaped database "${maintenanceDb}"`);
  }
  return url;
}

const D3_2C_FLAG = process.env.PHOENIX_D3_2C_TEST_ONLY;
const D3_2C_ENABLED = D3_2C_FLAG === '1';
const run = rigAvailable() && D3_2C_ENABLED ? describe : describe.skip;

// ── Probe fixtures — non-production, always organization-scoped ─────────────

const PROBE_PREFIX = 'probe_nonprod_d3_2_v1';
const ORG_A = '00000000-0000-0000-0000-0000032c0001';
const WH = '00000000-0000-0000-0000-0000032c0101';
const PERFORMER = '00000000-0000-0000-0000-0000032c0501';

/**
 * The canonical chain seeds exactly these two organizations (migration 001,
 * re-asserted by 004), so a fresh rig is never literally empty of them. The
 * accepted substitute is an exact-identity match — stable UUID primary keys,
 * never display names.
 */
const CHAIN_SEEDED_ORGANIZATION_IDS = [
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
];

let seq = 0;
const probeKey = (suffix: string) => `${PROBE_PREFIX}-${suffix}-${Date.now()}-${seq++}`;

run('163 D3-2C rpc result shape — dynamic (direct PostgreSQL wire, no supabase-js)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let connection: URL;

  beforeAll(async () => {
    connection = assertLoopbackDisposableConnection(process.env.PHOENIX_RIG_PG);
    if (process.env.PHOENIX_RIG_DB !== REQUIRED_RIG_DB) {
      throw new Error(
        `D3-2C guard: PHOENIX_RIG_DB must be exactly "${REQUIRED_RIG_DB}" (got "${process.env.PHOENIX_RIG_DB ?? '<unset>'}")`,
      );
    }
    if (!D3_2C_ENABLED) {
      throw new Error('D3-2C guard: PHOENIX_D3_2C_TEST_ONLY=1 is required');
    }

    const files: string[] = migrationFiles(163);
    const versions = files.map((f: string) => parseInt(f.slice(0, 3), 10));
    const above = files.filter((f: string) => parseInt(f.slice(0, 3), 10) > 163);
    if (above.length > 0) {
      throw new Error(`D3-2C guard: migration set includes files above 163: ${above.join(', ')}`);
    }
    if (Math.max(...versions) !== 163) {
      throw new Error(`D3-2C guard: maximum migration version is ${Math.max(...versions)}, expected 163`);
    }
    if (files.filter((f: string) => f.startsWith('163_')).length !== 1) {
      throw new Error('D3-2C guard: expected exactly one Migration 163 file');
    }

    rig = await buildRig({ upTo: 163 });

    // Pristine-rig proof before any fixture is created.
    await rig.asAdmin(async (c: any) => {
      const orgs = await c.query('SELECT id FROM organizations ORDER BY id');
      const ids = orgs.rows.map((r: any) => r.id as string);
      const unexpected = ids.filter((id: string) => !CHAIN_SEEDED_ORGANIZATION_IDS.includes(id));
      if (unexpected.length > 0 || ids.length !== CHAIN_SEEDED_ORGANIZATION_IDS.length) {
        throw new Error(`D3-2C guard: rig is not pristine — organizations: ${ids.join(', ')}`);
      }
      for (const table of [
        'phoenix_outbox_events',
        'phoenix_outbox_consumers',
        'phoenix_outbox_delivery_state',
      ]) {
        const r = await c.query(`SELECT count(*)::int n FROM ${table}`);
        if (r.rows[0].n !== 0) {
          throw new Error(`D3-2C guard: rig is not empty — ${table} has ${r.rows[0].n} rows`);
        }
      }
    });

    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code)
        VALUES ('${ORG_A}','D3-2C Probe A','د3-2ج أ','probe-d32c-a') ON CONFLICT (id) DO NOTHING;`);
      await c.query(`INSERT INTO warehouses (id,organization_id,name,name_ar,status,warehouse_kind,code)
        VALUES ('${WH}','${ORG_A}','D3-2C WH','د3-2ج مخزن','active','institution','probe-d32c-wh')
        ON CONFLICT (id) DO NOTHING;`);
      await c.query(
        `INSERT INTO auth.users (id,email) VALUES ('${PERFORMER}','probe-d32c@rig.local') ON CONFLICT (id) DO NOTHING;`,
      );
    });
  }, 120000);

  afterAll(async () => {
    if (rig) await rig.end();
  });

  /** Real stocktake INSERT -> Migration 162 trigger -> one real Outbox event. */
  async function makeRealEvent(notes = 'd3-2c probe') {
    const stocktakeId = randomUUID();
    await rig.asAdmin((c: any) =>
      c.query(
        `INSERT INTO stocktakes (id, organization_id, scope_kind, scope_id, notes, performed_by)
         VALUES ($1,$2,'warehouse',$3,$4,$5)`,
        [stocktakeId, ORG_A, WH, notes, PERFORMER],
      ),
    );
    return stocktakeId;
  }

  async function registerProbeConsumer(
    key: string,
    opts: { maxAttempts?: number; leaseSeconds?: number; enabled?: boolean } = {},
  ) {
    expect(key.startsWith(PROBE_PREFIX)).toBe(true);
    await rig.asAdmin((c: any) =>
      c.query(
        `INSERT INTO phoenix_outbox_consumers (consumer_key, organization_id, max_attempts, lease_duration_seconds, is_enabled)
         VALUES ($1,$2,$3,$4,$5)`,
        [key, ORG_A, opts.maxAttempts ?? 5, opts.leaseSeconds ?? 300, opts.enabled ?? true],
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

  // ── Test-only PgRpcInvoker ────────────────────────────────────────────────
  //
  // Direct PostgreSQL wire access. It performs exactly the transport-level
  // normalization a JSON transport performs natively (Date -> ISO string) and
  // NOTHING else: the raw snake_case result then goes straight to the shared
  // validators. This is NOT the production adapter and proves nothing about
  // supabase-js or PostgREST.

  const toJsonScalar = (value: unknown): unknown =>
    value instanceof Date ? value.toISOString() : value;

  const normalizeRow = (row: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(row)) out[key] = toJsonScalar(row[key]);
    return out;
  };

  const pgRpcInvoker = {
    claimBatch: (consumerKey: string, leaseToken: string, batchSize: number) =>
      rig
        .asAdmin((c: any) =>
          c.query(`SELECT * FROM phoenix_outbox_claim_batch($1,$2,$3)`, [consumerKey, leaseToken, batchSize]),
        )
        .then((r: any) => r.rows.map(normalizeRow)),
    markCompleted: (consumerKey: string, dsId: string, leaseToken: string) =>
      rig
        .asAdmin((c: any) =>
          c.query(`SELECT phoenix_outbox_mark_completed($1,$2,$3) AS r`, [consumerKey, dsId, leaseToken]),
        )
        .then((r: any) => r.rows[0].r),
    markFailed: (
      consumerKey: string,
      dsId: string,
      leaseToken: string,
      code: string | null,
      summary: string | null,
    ) =>
      rig
        .asAdmin((c: any) =>
          c.query(`SELECT phoenix_outbox_mark_failed($1,$2,$3,$4,$5) AS r`, [
            consumerKey,
            dsId,
            leaseToken,
            code,
            summary,
          ]),
        )
        .then((r: any) => r.rows[0].r),
    releaseLease: (consumerKey: string, dsId: string, leaseToken: string) =>
      rig
        .asAdmin((c: any) =>
          c.query(`SELECT phoenix_outbox_release_lease($1,$2,$3) AS r`, [consumerKey, dsId, leaseToken]),
        )
        .then((r: any) => r.rows[0].r),
  };

  // ── Environment proofs ────────────────────────────────────────────────────

  describe('test-environment guards', () => {
    it('runs only against a loopback, dedicated, disposable, non-Production database', () => {
      expect(D3_2C_FLAG).toBe('1');
      expect(process.env.PHOENIX_RIG_DB).toBe(REQUIRED_RIG_DB);
      expect(['postgres:', 'postgresql:']).toContain(connection.protocol);
      expect(LOOPBACK_HOSTS.has(connection.hostname)).toBe(true);
      for (const forbidden of FORBIDDEN_CONNECTION_SUBSTRINGS) {
        expect(process.env.PHOENIX_RIG_PG).not.toContain(forbidden);
      }
    });

    it('applies exactly the 001->163 chain and no Migration 164', () => {
      const files: string[] = migrationFiles(163);
      const versions = files.map((f: string) => parseInt(f.slice(0, 3), 10));
      expect(Math.max(...versions)).toBe(163);
      expect(files.filter((f: string) => f.startsWith('164_'))).toEqual([]);
    });
  });

  // ── Required result-shape proofs ──────────────────────────────────────────

  describe('real Migration 163 results satisfy the shared validators', () => {
    it('a real claim result passes the shared claim validator and carries exactly the 12 declared columns', async () => {
      const key = probeKey('claim-shape');
      await registerProbeConsumer(key);
      await makeRealEvent('claim shape');

      const raw = await pgRpcInvoker.claimBatch(key, randomUUID(), 10);
      expect(raw).toHaveLength(1);
      // The database really did produce exactly the declared column set.
      expect(Object.keys(raw[0]).sort()).toEqual([...CLAIM_ROW_FIELDS].sort());

      const validated = validateClaimedEvents(raw);
      expect(validated).toHaveLength(1);
      expect(validated[0].eventType).toBe('stocktakes.recorded');
      expect(validated[0].organizationId).toBe(ORG_A);
      expect(validated[0].attemptCount).toBe(0);
      expect(typeof validated[0].occurredAt).toBe('string');
      for (const field of Object.keys(validated[0])) expect(field).not.toMatch(/_/);
    });

    it('an empty real claim result validates to an empty batch', async () => {
      const key = probeKey('claim-empty');
      await registerProbeConsumer(key);
      const raw = await pgRpcInvoker.claimBatch(key, randomUUID(), 10);
      expect(raw).toEqual([]);
      expect(validateClaimedEvents(raw)).toEqual([]);
    });

    it('a real markCompleted result passes its validator', async () => {
      const key = probeKey('completed-shape');
      await registerProbeConsumer(key);
      await makeRealEvent('completed shape');
      const token = randomUUID();
      const [row] = await pgRpcInvoker.claimBatch(key, token, 10);

      const raw = await pgRpcInvoker.markCompleted(key, row.delivery_state_id as string, token);
      const validated = validateMarkCompletedResult(raw);
      expect(validated.ok).toBe(true);
      expect(validated.alreadyCompleted).toBe(false);
      expect(validated.deliveryStateId).toBe(row.delivery_state_id);

      // The idempotent same-token replay shape validates too.
      const replay = validateMarkCompletedResult(
        await pgRpcInvoker.markCompleted(key, row.delivery_state_id as string, token),
      );
      expect(replay.alreadyCompleted).toBe(true);
    });

    it('a real markFailed PENDING result passes its validator with a null dead_letter_at', async () => {
      const key = probeKey('failed-pending-shape');
      await registerProbeConsumer(key, { maxAttempts: 5 });
      await makeRealEvent('failed pending shape');
      const token = randomUUID();
      const [row] = await pgRpcInvoker.claimBatch(key, token, 10);

      const raw = await pgRpcInvoker.markFailed(
        key,
        row.delivery_state_id as string,
        token,
        'probe_code',
        'probe summary',
      );
      const validated = validateMarkFailedResult(raw);
      expect(validated.status).toBe('pending');
      expect(validated.attemptCount).toBe(1);
      expect(validated.deadLetterAt).toBeNull();
      expect(typeof validated.availableAt).toBe('string');
    });

    it('a real markFailed DEAD-LETTER result passes its validator with a non-null dead_letter_at', async () => {
      const key = probeKey('failed-dead-shape');
      await registerProbeConsumer(key, { maxAttempts: 1 });
      await makeRealEvent('failed dead shape');
      const token = randomUUID();
      const [row] = await pgRpcInvoker.claimBatch(key, token, 10);

      const validated = validateMarkFailedResult(
        await pgRpcInvoker.markFailed(key, row.delivery_state_id as string, token, 'probe_fatal', 'one strike'),
      );
      expect(validated.status).toBe('dead_letter');
      expect(validated.attemptCount).toBe(1);
      expect(typeof validated.deadLetterAt).toBe('string');
    });

    it('a real releaseLease result passes its validator', async () => {
      const key = probeKey('release-shape');
      await registerProbeConsumer(key);
      await makeRealEvent('release shape');
      const token = randomUUID();
      const [row] = await pgRpcInvoker.claimBatch(key, token, 10);

      const validated = validateReleaseLeaseResult(
        await pgRpcInvoker.releaseLease(key, row.delivery_state_id as string, token),
      );
      expect(validated.ok).toBe(true);
      expect(validated.deliveryStateId).toBe(row.delivery_state_id);
      expect(typeof validated.availableAt).toBe('string');
    });
  });

  describe('rejection and preservation', () => {
    it('a real database rejection propagates and never becomes a validated value', async () => {
      const key = probeKey('disabled');
      await registerProbeConsumer(key, { enabled: false });
      await makeRealEvent('disabled probe');
      await expect(pgRpcInvoker.claimBatch(key, randomUUID(), 10)).rejects.toMatchObject({
        message: expect.stringContaining('consumer_disabled'),
      });

      const stale = probeKey('stale');
      await registerProbeConsumer(stale);
      await makeRealEvent('stale probe');
      const token = randomUUID();
      const [row] = await pgRpcInvoker.claimBatch(stale, token, 10);
      await expect(
        pgRpcInvoker.markCompleted(stale, row.delivery_state_id as string, randomUUID()),
      ).rejects.toMatchObject({ message: expect.stringContaining('stale_or_foreign_lease_token') });
    });

    it('the Outbox source event is never modified by any of the four routines', async () => {
      const key = probeKey('preserve');
      await registerProbeConsumer(key, { maxAttempts: 5 });
      await makeRealEvent('preserve shape');

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
      const token = randomUUID();
      const [row] = await pgRpcInvoker.claimBatch(key, token, 10);
      await pgRpcInvoker.markFailed(key, row.delivery_state_id as string, token, 'probe', 'probe');
      const after = await snapshot();
      expect(after).toBe(before);
    });
  });

  describe('scope honesty', () => {
    it('makes no claim about supabase-js, PostgREST, or the Edge Function runtime', async () => {
      // This suite reaches PostgreSQL over its own wire protocol via the rig.
      // It never constructs an HTTP request and never imports the production
      // adapter, so nothing here can be read as transport evidence. Tier C
      // (D3-2E hosted verification) is the only tier that can prove that path.
      const selfSource = await import('node:fs').then((fs) =>
        fs.readFileSync(new URL(import.meta.url), 'utf8'),
      );
      // Inspect this file's own IMPORT SPECIFIERS — not raw substrings, which
      // would match the assertions below and make the test self-defeating.
      const specifiers = [...selfSource.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(specifier).not.toMatch(/supabase-rpc-adapter/);
        expect(specifier).not.toMatch(/supabase-js/);
        expect(specifier).not.toMatch(/^https?:/);
      }
      // The only non-builtin imports are the rig harness and the pure validators.
      expect(specifiers.sort()).toEqual([
        '../../../tools/pg-rig/rig.mjs',
        '../../functions/phoenix-outbox-dispatcher/lib/rpc-result-validation.ts',
        'node:crypto',
        'vitest',
      ]);
    });

    it('every organization, consumer and event in this rig is test-local', async () => {
      await rig.asAdmin(async (c: any) => {
        const orgs = await c.query('SELECT id FROM organizations');
        expect(orgs.rows.map((r: any) => r.id).sort()).toEqual(
          [...CHAIN_SEEDED_ORGANIZATION_IDS, ORG_A].sort(),
        );
        const consumers = await c.query('SELECT consumer_key FROM phoenix_outbox_consumers');
        expect(consumers.rows.length).toBeGreaterThan(0);
        for (const r of consumers.rows) expect(r.consumer_key.startsWith(PROBE_PREFIX)).toBe(true);
        const events = await c.query('SELECT DISTINCT event_type, organization_id FROM phoenix_outbox_events');
        for (const r of events.rows) {
          expect(r.event_type).toBe('stocktakes.recorded');
          expect(r.organization_id).toBe(ORG_A);
        }
      });
    });
  });
});
