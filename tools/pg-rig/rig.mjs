// ===========================================================================
// Disposable Postgres rig for the canonical migration chain.
//
// Applies tools/pg-rig/bootstrap.sql then supabase/migrations/*.sql in filename
// order to a THROWAWAY database, so the real RPCs can be exercised dynamically.
// NOTHING here ever touches production — it drops and recreates a local rig DB.
//
// The one in-memory shim: migration 023 asserts on pg_policies.qual for an
// INSERT policy (dp_insert_perm), whose predicate actually lives in with_check.
// qual is NULL there, so a fresh replay aborts. We read coalesce(qual,with_check)
// IN MEMORY ONLY — the repository file 023 is never modified (repo policy), and
// this documents precisely the DR gap that Phase 3 must close in a baseline.
//
// Usage:
//   import { buildRig } from './rig.mjs'
//   const rig = await buildRig({ upTo: 82 })   // apply through migration 082
//   await rig.asUser(userId, async (c) => c.query('select ...'))
//   await rig.end()
//
// Requires env PHOENIX_RIG_PG = a superuser connection string to a running
// Postgres MAINTENANCE db, e.g. postgres://postgres@localhost:55432/postgres
// ===========================================================================
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'supabase', 'migrations');
const RIG_DB = process.env.PHOENIX_RIG_DB || 'phoenix_rig';

export const rigAvailable = () => Boolean(process.env.PHOENIX_RIG_PG);

function maintenanceUrl() {
  const u = process.env.PHOENIX_RIG_PG;
  if (!u) throw new Error('PHOENIX_RIG_PG not set — cannot build disposable rig');
  return u;
}

function rigUrl() {
  const u = new URL(maintenanceUrl());
  u.pathname = '/' + RIG_DB;
  return u.toString();
}

// Migration files 001..NNN in filename order. Skips non-.sql and the __tests__ dir.
export function migrationFiles(upTo = Infinity) {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort()
    .filter((f) => parseInt(f.slice(0, 3), 10) <= upTo);
}

// The 023 in-memory shim, applied ONLY to that one file's text at load time.
// Exported so the DR acceptance test can compare shimmed vs raw behaviour.
export function shimSql(file, text) {
  if (file.startsWith('023_')) {
    return text.replace(/SELECT\s+qual\s+INTO/gi, 'SELECT coalesce(qual, with_check) INTO');
  }
  return text;
}

export { MIGRATIONS_DIR };

// Drop + recreate the throwaway db and apply only the Supabase bootstrap.
// Returns a connected pg.Client the caller drives directly (used by buildRig
// and by the DR acceptance test, which needs migration-by-migration control).
export async function freshRigDb() {
  const admin = new pg.Client({ connectionString: maintenanceUrl() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${RIG_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${RIG_DB}`);
  await admin.end();
  const c = new pg.Client({ connectionString: rigUrl() });
  await c.connect();
  await c.query(readFileSync(join(HERE, 'bootstrap.sql'), 'utf8'));
  return c;
}

export const SEED_SUPER_ADMIN_ID = '00000000-0000-0000-0000-0000000000a1';

// A super_admin must exist before migration 062 (it aborts otherwise). Seed it
// right after 001 creates profiles. Uses fixed UUIDs so tests can reference it.
const SEED_AFTER_001 = `
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES ('${SEED_SUPER_ADMIN_ID}', 'root@rig.local',
          jsonb_build_object('full_name','Rig Root','role','super_admin'))
  ON CONFLICT (id) DO NOTHING;
  UPDATE public.profiles SET role='super_admin', status='active'
   WHERE id='${SEED_SUPER_ADMIN_ID}';
`;

export async function buildRig({ upTo = Infinity, log = () => {} } = {}) {
  // 1-2. Fresh db + Supabase bootstrap, then migrations.
  const c = await freshRigDb();

  const files = migrationFiles(upTo);
  for (const f of files) {
    const raw = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    try {
      await c.query(shimSql(f, raw));
    } catch (e) {
      await c.end();
      throw new Error(`migration ${f} failed: ${e.message}`);
    }
    if (f.startsWith('001_')) await c.query(SEED_AFTER_001);
    log(`applied ${f}`);
  }

  const pool = new pg.Pool({ connectionString: rigUrl(), max: 8 });

  // Run `fn` inside a txn impersonating `userId` as the authenticated role, so
  // in-function auth.uid() resolves and RLS is genuinely enforced (the role is
  // NOLOGIN/non-superuser). Rolls back by default to keep tests independent;
  // pass commit:true to persist.
  async function asUser(userId, fn, { role = 'authenticated', commit = false } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
      const out = await fn(client);
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  // Superuser escape hatch for seeding fixtures (bypasses RLS).
  async function asAdmin(fn) {
    const client = await pool.connect();
    try { return await fn(client); } finally { client.release(); }
  }

  return {
    pool, asUser, asAdmin,
    superAdminId: SEED_SUPER_ADMIN_ID,
    async end() { await pool.end(); },
  };
}
