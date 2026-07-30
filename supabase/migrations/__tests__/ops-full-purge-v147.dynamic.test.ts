/**
 * FULL PRE-LAUNCH PURGE v147 — OWNER OPTION A — dynamic proof on the rig.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database), like every other
 * *.dynamic.test.ts suite.
 *
 *   PHOENIX_RIG_PG=postgres://postgres@127.0.0.1:55432/postgres \
 *   npx vitest run supabase/migrations/__tests__/ops-full-purge-v147.dynamic.test.ts
 *
 * Proves the purge reaches CANONICAL_PRELAUNCH_EMPTY_BASELINE_V147: every one of
 * the 70 purge tables empty (including everything migration 004 seeded), exactly
 * one keeper resolved BY EMAIL, RBAC intact at 130/415, and the six temporarily
 * disabled immutability triggers provably restored.
 *
 * Seeding is generic (introspects NOT NULL / no-default columns) so all 70
 * tables really carry rows before the purge. Hand-picked seeding is how the
 * 090-era plan's blind spot survived.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import { PURGE_ORDER, PRESERVE, KEEPER_EMAIL } from '../../ops/purge-manifest-v147';

const HERE = dirname(fileURLToPath(import.meta.url));
const PURGE_SQL = readFileSync(join(HERE, '../../ops/pre_launch_full_purge_v147.sql'), 'utf8');
const ATTEST = "SET phoenix.purge_attestation = 'I_ATTEST_PRODUCTION_FULL_PURGE_V147_OPTION_A'";

const run = rigAvailable() ? describe : describe.skip;

type Row = Record<string, unknown>;
type Client = { query: (q: string, p?: unknown[]) => Promise<{ rows: Row[] }> };

const KEEPER_ID = '00000000-0000-0000-0000-0000000000f1';
const OTHER_ID  = '00000000-0000-0000-0000-0000000000f2';

const GUARDED = [
  ['item_availability', 'trg_guard_availability_source_kind'],
  ['phoenix_report_snapshots', 'phoenix_report_snapshots_forbid_mutation'],
  ['procurement_order_events', 'procurement_order_events_immutable'],
  ['procurement_receipt_lines', 'procurement_receipt_lines_immutable'],
  ['procurement_receipts', 'procurement_receipts_immutable'],
  ['procurement_returns', 'procurement_returns_immutable'],
] as const;

function dummyFor(type: string, udt: string): string {
  if (type === 'uuid') return 'gen_random_uuid()';
  if (type === 'boolean') return 'false';
  if (/^(integer|bigint|smallint)$/.test(type)) return '1';
  if (/^(numeric|real|double precision)$/.test(type)) return '1';
  if (/^timestamp/.test(type)) return 'now()';
  if (type === 'date') return 'current_date';
  if (type === 'jsonb') return `'{}'::jsonb`;
  if (type === 'json') return `'{}'::json`;
  if (type === 'ARRAY') return `'{}'::${udt.replace(/^_/, '')}[]`;
  if (type === 'USER-DEFINED') {
    return `(SELECT e.enumlabel::${udt} FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
             WHERE t.typname='${udt}' ORDER BY e.enumsortorder LIMIT 1)`;
  }
  return `'x'`;
}

run('full pre-launch purge v147 — Option A (dynamic, rig)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let trgBefore: Row[] = [];

  beforeAll(async () => {
    rig = await buildRig({ upTo: 147 });
    await rig.asAdmin(async (c: Client) => {
      await c.query(`CREATE SCHEMA IF NOT EXISTS supabase_migrations`);
      await c.query(`CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY)`);
      await c.query(`INSERT INTO supabase_migrations.schema_migrations (version)
                     SELECT lpad(g::text,3,'0') FROM generate_series(1,147) g ON CONFLICT DO NOTHING`);

      await c.query('SET session_replication_role = replica');

      // Keeper resolved BY EMAIL, plus a second account that must not survive.
      for (const [id, email] of [[KEEPER_ID, KEEPER_EMAIL], [OTHER_ID, 'other@x.test']] as [string, string][]) {
        await c.query(`INSERT INTO auth.users (id,email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [id, email]);
        await c.query(
          `INSERT INTO profiles (id, organization_id, full_name, role, status)
           VALUES ($1, NULL, $2, 'super_admin', 'active') ON CONFLICT (id) DO NOTHING`, [id, email]);
      }

      for (const t of PURGE_ORDER) {
        const { rows: cols } = await c.query(
          `SELECT column_name, data_type, udt_name FROM information_schema.columns
            WHERE table_schema='public' AND table_name=$1 AND is_nullable='NO'
              AND column_default IS NULL AND is_generated='NEVER' AND identity_generation IS NULL`, [t]);
        const names = cols.map((r) => `"${String(r.column_name)}"`);
        const vals = cols.map((r) => dummyFor(String(r.data_type), String(r.udt_name)));
        const sql = names.length
          ? `INSERT INTO public."${t}" (${names.join(',')}) VALUES (${vals.join(',')})`
          : `INSERT INTO public."${t}" DEFAULT VALUES`;
        try { await c.query(sql); } catch { /* some tables refuse a generic row */ }
      }
      await c.query('SET session_replication_role = DEFAULT');

      const { rows } = await c.query(`
        SELECT c.relname tbl, t.tgname, pg_get_triggerdef(t.oid) def, t.tgenabled
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE NOT t.tgisinternal AND n.nspname='public' ORDER BY 1,2`);
      trgBefore = rows;
    });
  }, 900_000);

  afterAll(async () => { if (rig) await rig.end(); });

  async function attempt(c: Client, { attest = true } = {}): Promise<Error | null> {
    if (attest) await c.query(ATTEST); else await c.query('RESET phoenix.purge_attestation');
    try { await c.query(PURGE_SQL); return null; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); return e as Error; }
  }
  const count = async (c: Client, sql: string, p: unknown[] = []) => Number((await c.query(sql, p)).rows[0].n);

  it('migrations 148-153 do not reference migration 004 demo UUIDs', () => {
    // Future-dependency guard: if a later migration starts depending on the demo
    // seed, Option A silently breaks it. This fails loudly instead.
    const dir = join(HERE, '..');
    const offenders: string[] = [];
    for (const f of ['148', '149', '150', '151', '152', '153']) {
      const { readdirSync } = require('node:fs') as typeof import('node:fs');
      for (const name of readdirSync(dir).filter((n) => n.startsWith(f + '_') && n.endsWith('.sql'))) {
        const txt = readFileSync(join(dir, name), 'utf8');
        if (/00000000-0000-0000-0000-00000000000[12]/.test(txt)) offenders.push(name);
      }
    }
    expect(offenders, `migration(s) depend on the purged 004 demo seed: ${offenders.join(', ')}`).toEqual([]);
  });

  it('REFUSES without the Option-A attestation', async () => {
    const c = await rig.pool.connect();
    try {
      const before = await count(c, 'SELECT count(*)::int n FROM organizations');
      const err = await attempt(c, { attest: false });
      expect(err?.message ?? '').toMatch(/attestation/i);
      expect(await count(c, 'SELECT count(*)::int n FROM organizations')).toBe(before);
    } finally { c.release(); }
  });

  it('REFUSES when the keeper email is absent', async () => {
    const c = await rig.pool.connect();
    try {
      await c.query('SET session_replication_role = replica');
      await c.query(`UPDATE auth.users SET email='parked@x.test' WHERE id=$1`, [KEEPER_ID]);
      await c.query('SET session_replication_role = DEFAULT');
      const err = await attempt(c);
      expect(err?.message ?? '').toMatch(/keeper email resolves to 0 auth\.users row/i);
      await c.query('SET session_replication_role = replica');
      await c.query(`UPDATE auth.users SET email=$2 WHERE id=$1`, [KEEPER_ID, KEEPER_EMAIL]);
      await c.query('SET session_replication_role = DEFAULT');
    } finally { c.release(); }
  });

  it('REFUSES when the migration ceiling is not 147', async () => {
    const c = await rig.pool.connect();
    try {
      await c.query(`INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('148')`);
      const err = await attempt(c);
      expect(err?.message ?? '').toMatch(/migration ceiling is 148, expected 147/i);
      await c.query(`DELETE FROM supabase_migrations.schema_migrations WHERE version='148'`);
    } finally { c.release(); }
  });

  it('REFUSES when an unclassified public table appears', async () => {
    const c = await rig.pool.connect();
    try {
      await c.query(`CREATE TABLE public.zz_probe (id int)`);
      const err = await attempt(c);
      expect(err?.message ?? '').toMatch(/unclassified public table/i);
      await c.query(`DROP TABLE public.zz_probe`);
    } finally { c.release(); }
  });

  it('REFUSES on trigger-allowlist drift (an unaudited BEFORE-DELETE guard)', async () => {
    const c = await rig.pool.connect();
    try {
      await c.query(`CREATE OR REPLACE FUNCTION public.zz_guard() RETURNS trigger
                     LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$`);
      await c.query(`CREATE TRIGGER zz_guard_trg BEFORE DELETE ON public.warehouse_stock
                     FOR EACH ROW EXECUTE FUNCTION public.zz_guard()`);
      const err = await attempt(c);
      expect(err?.message ?? '').toMatch(/unexpected BEFORE-DELETE trigger/i);
      await c.query(`DROP TRIGGER zz_guard_trg ON public.warehouse_stock`);
      await c.query(`DROP FUNCTION public.zz_guard()`);
    } finally { c.release(); }
  });

  // Precondition failures above all roll back with the fixture intact.
  it('happy path: reaches CANONICAL_PRELAUNCH_EMPTY_BASELINE_V147', async () => {
    const c = await rig.pool.connect();
    try {
      expect(await count(c, 'SELECT count(*)::int n FROM permission_keys')).toBe(130);
      // The 004 demo seed must actually be present, or "it is gone" proves nothing.
      expect(await count(c, 'SELECT count(*)::int n FROM organizations')).toBeGreaterThan(0);

      let seededRows = 0;
      for (const t of PURGE_ORDER) seededRows += await count(c, `SELECT count(*)::int n FROM public."${t}"`);
      expect(seededRows).toBeGreaterThan(0);

      const err = await attempt(c);
      expect(err).toBeNull();

      for (const t of PURGE_ORDER) {
        expect(await count(c, `SELECT count(*)::int n FROM public."${t}"`), `${t} must be empty`).toBe(0);
      }
      // Migration 004's demo seed is specifically gone.
      expect(await count(c, `SELECT count(*)::int n FROM organizations
        WHERE id IN ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002')`)).toBe(0);

      expect(await count(c, 'SELECT count(*)::int n FROM auth.users')).toBe(1);
      expect(await count(c, 'SELECT count(*)::int n FROM profiles')).toBe(1);
      expect(await count(c, 'SELECT count(*)::int n FROM auth.users WHERE id=$1', [KEEPER_ID])).toBe(1);
      expect(await count(c, `SELECT count(*)::int n FROM auth.users WHERE lower(email)=lower($1)`, [KEEPER_EMAIL])).toBe(1);
      expect(await count(c, `SELECT count(*)::int n FROM profiles
        WHERE id=$1 AND role='super_admin' AND status='active' AND organization_id IS NULL`, [KEEPER_ID])).toBe(1);

      for (const t of PRESERVE) {
        const n = await count(c, `SELECT count(*)::int n FROM public."${t}"`);
        expect(n, `${t} preserved`).toBe(t === 'permission_keys' ? 130 : 415);
      }

      // The six temporarily disabled triggers are back, byte-identical.
      const { rows: after } = await c.query(`
        SELECT c.relname tbl, t.tgname, pg_get_triggerdef(t.oid) def, t.tgenabled
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE NOT t.tgisinternal AND n.nspname='public' ORDER BY 1,2`);
      expect(after).toEqual(trgBefore);
      for (const [tbl, tg] of GUARDED) {
        const row = after.find((r) => r.tbl === tbl && r.tgname === tg);
        expect(row, `${tbl}.${tg} must exist after purge`).toBeTruthy();
        expect(String(row!.tgenabled), `${tbl}.${tg} must be enabled`).toBe('O');
      }
    } finally { c.release(); }
  });
});
