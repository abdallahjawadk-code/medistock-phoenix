// ===========================================================================
// Remote (non-disposable) Postgres I/O adapter — SAME {asAdmin, asUser}
// shape as tools/pg-rig/rig.mjs's buildRig(), so tools/phoenix-demo/seed.mjs
// runs UNCHANGED against a real Supabase project. The one and only
// difference from buildRig(): this NEVER drops, creates, or resets any
// database. It connects to exactly the database named in the connection
// string and does nothing else structural.
//
// SECRET HANDLING: the connection string is read from an environment
// variable and passed straight to `pg` — it is never logged, never included
// in an error message, never written to a file. Every function in this
// module that can fail wraps its error message through redact() before it
// is allowed to propagate, so a thrown Postgres error can never leak the
// connection string even if the string itself somehow appears in it (e.g.
// a malformed-URL error from the driver).
//
// Usage:
//   import { buildRemoteIo } from './remote-io.mjs'
//   const io = await buildRemoteIo({ connectionString: process.env.X })
//   await io.asUser(userId, async (c) => c.query('select ...'))
//   await io.end()
// ===========================================================================
import pg from 'pg';

/** Strip any substring of `secret` out of a string, defense in depth. */
function redact(str, secret) {
  if (!secret || !str) return str;
  return String(str).split(secret).join('[REDACTED]');
}

export async function buildRemoteIo({ connectionString, maxConnections = 4 } = {}) {
  if (!connectionString) {
    throw new Error('buildRemoteIo: connectionString is required (read it from an env var, never a literal)');
  }

  // Recent pg-connection-string versions (matching this repo's pg@8.22)
  // treat a URL-embedded `sslmode=require`/`prefer`/`verify-ca` -- exactly
  // what Supabase's own copied connection strings carry -- as an ALIAS for
  // `verify-full` (full certificate chain + hostname verification), which
  // silently overrides the `ssl` object passed below and fails against
  // Supabase's pooler cert with "self-signed certificate in certificate
  // chain". Stripping any `ssl`-prefixed query params from the string
  // itself (never touching user/password/host) makes the explicit `ssl`
  // option below the only source of truth. Errors are still redacted
  // against the ORIGINAL connectionString everywhere below, since that is
  // what could actually leak.
  let sanitizedConnectionString = connectionString;
  try {
    const u = new URL(connectionString);
    for (const key of [...u.searchParams.keys()]) {
      if (/^ssl/i.test(key)) u.searchParams.delete(key);
    }
    sanitizedConnectionString = u.toString();
  } catch {
    // Not a parseable URL -- leave untouched, pg's own parser will surface
    // whatever error is appropriate, redacted as usual below.
  }

  const pool = new pg.Pool({
    connectionString: sanitizedConnectionString,
    max: maxConnections,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    // Supabase's direct (non-pooler) endpoint requires TLS. This matches the
    // setting Supabase's own node-postgres docs recommend.
    ssl: { rejectUnauthorized: false },
  });

  pool.on('error', (err) => {
    // An idle client terminated by the backend (network blip, Supabase-side
    // restart) must not crash the whole process — the next asUser/asAdmin
    // call gets a fresh client from the pool.
    const benign =
      err?.code === '57P01' ||
      err?.code === 'ECONNRESET' ||
      /terminating connection/i.test(err?.message ?? '') ||
      /Connection terminated unexpectedly/i.test(err?.message ?? '');
    if (!benign) {
      const e = new Error(redact(err?.message ?? String(err), connectionString));
      e.cause = undefined; // never chain the original (may embed the string)
      throw e;
    }
  });

  // Fail fast with a clear, secret-free error if the connection string is
  // simply wrong, rather than surfacing a raw pg error later.
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    throw new Error(`buildRemoteIo: initial connection failed: ${redact(e?.message ?? String(e), connectionString)}`);
  }

  /**
   * Run `fn` inside a transaction impersonating `userId` as `role`, exactly
   * like rig.mjs's asUser — SET LOCAL ROLE + a transaction-local JWT 'sub'
   * claim, so auth.uid()/RLS behave exactly as they do for a real
   * PostgREST-authenticated request. Rolls back by default; pass
   * commit:true to persist.
   */
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
      throw new Error(redact(e?.message ?? String(e), connectionString));
    } finally {
      client.release();
    }
  }

  /** Superuser-level read/write, no role switch — used for master-data
   *  inserts the product has no creation RPC for (organizations, etc.),
   *  exactly as in rig.mjs. */
  async function asAdmin(fn) {
    const client = await pool.connect();
    try {
      return await fn(client);
    } catch (e) {
      throw new Error(redact(e?.message ?? String(e), connectionString));
    } finally {
      client.release();
    }
  }

  return {
    pool, asUser, asAdmin,
    async end() { await pool.end(); },
  };
}
