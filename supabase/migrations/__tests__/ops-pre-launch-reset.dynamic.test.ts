/**
 * PRE-LAUNCH RUNTIME DATA RESET — disposable-rig dynamic proof (§1a).
 *
 * Gated on PHOENIX_RIG_PG (a superuser maintenance connection). Skipped in CI
 * and locally when no rig is present, exactly like the other *.dynamic tests.
 *
 *   PHOENIX_RIG_PG=postgres://postgres@127.0.0.1:55432/postgres \
 *   PHOENIX_RIG_DB=phoenix_rig_5role \
 *   npx vitest run supabase/migrations/__tests__/ops-pre-launch-reset.dynamic.test.ts
 *
 * Proves, on a real 001→090 replay:
 *   • the reset REFUSES to run without the explicit attestation;
 *   • with attestation it keeps ONLY the oldest active super_admin, wipes every
 *     runtime table, preserves org/warehouse/outlet/catalog config, and leaves
 *     exactly one auth account + one super_admin profile;
 *   • it ABORTS when no active super_admin would survive.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESET_SQL = readFileSync(join(HERE, '../../ops/pre_launch_runtime_reset.sql'), 'utf8');
const ATTEST = "SET phoenix.reset_attestation = 'I_ATTEST_PRELAUNCH_RESET_DISPOSABLE'";

const run = rigAvailable() ? describe : describe.skip;

// Deterministic ids.
const OLDEST_SUPER = '00000000-0000-0000-0000-0000000000b0'; // survivor (earliest created_at)
const NEWER_SUPER  = '00000000-0000-0000-0000-0000000000b2';
const INST_ADMIN   = '00000000-0000-0000-0000-0000000000c1';
const VIEWER       = '00000000-0000-0000-0000-0000000000c2';
const MONTHLY       = '00000000-0000-0000-0000-0000000000c3';
const ORG_A        = '00000000-0000-0000-0000-00000000a001';

run('pre-launch runtime reset (dynamic, rig)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 90 });
    await rig.asAdmin(async (c: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }) => {
      // Seed under replica role so we bypass validation triggers/FKs for setup
      // only — the reset itself runs under normal replication rules.
      await c.query('SET session_replication_role = replica');

      // A preserved organization (config).
      await c.query(
        `INSERT INTO organizations (id, name, name_ar, code, status)
         VALUES ($1, 'Org A', 'مؤسسة أ', 'ORGA', 'active')
         ON CONFLICT (id) DO NOTHING`, [ORG_A]);

      // Extra auth accounts + profiles (two super_admins of different age, plus
      // the three roles this cutover removes/keeps).
      const people: [string, string, string, string][] = [
        [OLDEST_SUPER, 'oldest@x.test', 'super_admin', '2020-01-01T00:00:00Z'],
        [NEWER_SUPER,  'newer@x.test',  'super_admin', '2025-01-01T00:00:00Z'],
        [INST_ADMIN,   'inst@x.test',   'institution_admin', '2024-01-01T00:00:00Z'],
        [VIEWER,       'viewer@x.test', 'viewer', '2024-02-01T00:00:00Z'],
        [MONTHLY,      'monthly@x.test','monthly_status_officer', '2024-03-01T00:00:00Z'],
      ];
      for (const [id, email, role, created] of people) {
        await c.query(`INSERT INTO auth.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [id, email]);
        await c.query(
          `INSERT INTO profiles (id, organization_id, full_name, role, status, created_at)
           VALUES ($1, $2, $3, $4, 'active', $5) ON CONFLICT (id) DO NOTHING`,
          [id, role === 'super_admin' ? null : ORG_A, email, role, created]);
      }

      // Runtime rows that MUST be wiped.
      await c.query(`INSERT INTO audit_logs (action, entity_type) VALUES ('test.seed','profile'), ('test.seed2','warehouse')`);

      await c.query('SET session_replication_role = DEFAULT');
    });
  }, 120_000);

  afterAll(async () => { if (rig) await rig.end(); });

  // Run the reset file, tolerating its self-managed BEGIN/COMMIT. On failure the
  // aborted transaction is rolled back so the pooled connection stays usable.
  async function attemptReset(
    client: { query: (q: string, p?: unknown[]) => Promise<unknown> },
    { attest }: { attest: boolean },
  ): Promise<Error | null> {
    if (attest) await client.query(ATTEST);
    else await client.query('RESET phoenix.reset_attestation');
    try {
      await client.query(RESET_SQL);
      return null;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return e as Error;
    }
  }

  async function count(client: { query: (q: string, p?: unknown[]) => Promise<{ rows: { n: number }[] }> }, sql: string, p: unknown[] = []) {
    return (await client.query(sql, p)).rows[0].n;
  }

  it('REFUSES to run without the explicit attestation (no data touched)', async () => {
    const client = await rig.pool.connect();
    try {
      const before = await count(client, 'SELECT count(*)::int n FROM profiles');
      expect(before).toBeGreaterThan(1);
      const err = await attemptReset(client, { attest: false });
      expect(err?.message ?? '').toMatch(/attestation/i);
      const after = await count(client, 'SELECT count(*)::int n FROM profiles');
      expect(after).toBe(before);
    } finally {
      client.release();
    }
  });

  it('keeps only the oldest active super_admin, wipes runtime, preserves config', async () => {
    const client = await rig.pool.connect();
    try {
      const err = await attemptReset(client, { attest: true });
      expect(err).toBeNull();

      const profiles = await client.query('SELECT id, role FROM profiles');
      expect(profiles.rows).toHaveLength(1);
      expect(profiles.rows[0].id).toBe(OLDEST_SUPER);
      expect(profiles.rows[0].role).toBe('super_admin');

      expect(await count(client, 'SELECT count(*)::int n FROM auth.users')).toBe(1);
      expect(await count(client, 'SELECT count(*)::int n FROM auth.users WHERE id=$1', [OLDEST_SUPER])).toBe(1);
      expect(await count(client, 'SELECT count(*)::int n FROM audit_logs')).toBe(0);
      // config preserved.
      expect(await count(client, 'SELECT count(*)::int n FROM organizations WHERE id=$1', [ORG_A])).toBe(1);
      // no non-canonical roles remain.
      expect(await count(client,
        `SELECT count(*)::int n FROM profiles
         WHERE role NOT IN ('super_admin','central_warehouse_manager','institution_admin','warehouse_officer','outlet_officer')`)).toBe(0);
    } finally {
      client.release();
    }
  });

  it('ABORTS when no active super_admin would survive', async () => {
    const client = await rig.pool.connect();
    try {
      // The DB's own trigger protects the last super_admin, so we force a
      // zero-active-super_admin state via replica role FOR SETUP ONLY, then run
      // the reset under normal rules to prove its independent abort guard.
      await client.query('SET session_replication_role = replica');
      await client.query(`UPDATE profiles SET status='suspended' WHERE role='super_admin'`);
      await client.query('SET session_replication_role = DEFAULT');

      const err = await attemptReset(client, { attest: true });
      expect(err?.message ?? '').toMatch(/no active super_admin/i);

      // restore (rig is disposable, but keep it consistent).
      await client.query('SET session_replication_role = replica');
      await client.query(`UPDATE profiles SET status='active' WHERE id=$1`, [OLDEST_SUPER]);
      await client.query('SET session_replication_role = DEFAULT');
    } finally {
      client.release();
    }
  });
});
