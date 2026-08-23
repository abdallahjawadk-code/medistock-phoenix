// ===========================================================================
// Disposable Postgres rig for the canonical migration chain.
//
// Applies tools/pg-rig/bootstrap.sql then supabase/migrations/*.sql in filename
// order to a THROWAWAY database, so the real RPCs can be exercised dynamically.
// NOTHING here ever touches production — it drops and recreates a local rig DB.
//
// The in-memory replay normalizations are narrowly pinned historical facts:
//
//   * migration 023 asserts on pg_policies.qual for an INSERT policy
//     (dp_insert_perm), whose predicate actually lives in with_check. qual is
//     NULL there, so a fresh replay aborts. We read coalesce(qual,with_check).
//   * Production's recorded migration-182 payload contains compact bodies for
//     get_effective_permissions and phoenix_profile_has_permission, while the
//     later repository representation of 182 contains expanded, comment-rich
//     forms with identical behavior. M196 fingerprints the bodies Production
//     actually has, so disposable replay must reproduce those two recorded
//     representations before it reaches M196.
//
// Both corrections happen IN MEMORY ONLY — historical repository migrations
// are never modified. The M182 correction is fail-closed on the exact source
// file hash and exact before/after body hashes.
//
// The one session-scoped attestation: migration 085 is a fail-closed CUTOVER
// file that Production HAS applied (verified live). The rig supplies its
// attestation GUC around that single apply and resets it immediately — see
// ATTESTED_CUTOVER_MIGRATIONS below. The file itself is never modified or
// weakened.
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
import { createHash } from 'node:crypto';
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

// ---------------------------------------------------------------------------
// ATTESTED CUTOVER MIGRATIONS
//
// These are historical migrations whose own SOURCE is fail-closed behind an
// explicit in-session attestation GUC: run the file as-is and it RAISES rather
// than applying. Their headers still read "PREPARED / DO NOT APPLY", and that
// text is historical source state which is NOT rewritten.
//
// This rig USED to skip 085 entirely, on the belief that it had never been
// applied anywhere. A live read-only inspection of Production's
// `supabase_migrations.schema_migrations` disproved that:
//
//     version 085, name phoenix_revoke_manual_availability_writers, count 1
//
// Production applied it, its stored payload carries both writer REVOKEs, and
// the live functions carry 085's comments with authenticated EXECUTE = NO and
// service_role EXECUTE = YES. Skipping it therefore made the canonical replay
// diverge from ACTUAL Production history — the rig reintroduced two
// `authenticated` EXECUTE grants that Production does not have. That is a rig
// REPLAY-POLICY FIDELITY defect, not Production drift.
//
// So the canonical chain now includes them, and the attestation is supplied
// HERE — in the same session, immediately around the apply, and RESET straight
// afterwards, so it never leaks to any later migration or to the test pool.
// Migration 085 itself is never weakened: applied without this it still aborts,
// which `085_RAW_FAIL_CLOSED` proves on every run.
//
// Map: migration filename -> the GUC its own precondition reads.
export const ATTESTED_CUTOVER_MIGRATIONS = new Map([
  ['085_phoenix_revoke_manual_availability_writers.sql', 'phoenix.availability_cutover_attested'],
]);

// Migration files 001..NNN in filename order. Skips non-.sql and the __tests__
// dir. Attested cutover migrations ARE included, because Production applied
// them — pass `excludeCutover: true` for the explicit, opt-in PRE-cutover
// replay a DR/parity rehearsal may want. Canonical builds must not pass it.
/** @param {number} [upTo] @param {{ excludeCutover?: boolean }} [opts] */
export function migrationFiles(upTo = Infinity, { excludeCutover = false } = {}) {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .filter((f) => !excludeCutover || !ATTESTED_CUTOVER_MIGRATIONS.has(f))
    .sort()
    .filter((f) => parseInt(f.slice(0, 3), 10) <= upTo);
}

// Apply ONE migration, supplying the historical cutover attestation only for
// the exact file that requires it and only for the duration of that apply.
// The GUC name comes from the hard-coded map above, never from caller input.
async function applyMigrationSql(client, file, sql) {
  const guc = ATTESTED_CUTOVER_MIGRATIONS.get(file);
  if (!guc) {
    await client.query(sql);
    return;
  }
  await client.query(`SET ${guc} = 'true'`);
  try {
    await client.query(sql);
  } finally {
    // RESET even if the migration threw, so a failed cutover apply cannot
    // leave a live attestation behind for anything that runs next.
    await client.query(`RESET ${guc}`);
  }
}

export { applyMigrationSql };

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const M182_FILE = '182_phoenix_health_center_facility_scoped_rbac.sql';
const M182_SOURCE_SHA256 = '5915832037c6ca08c2d873a10eb4896884abe72667f4b7e71c27768572734fb0';
const M182_REPLAY_BODIES = [
  {
    signature: 'CREATE OR REPLACE FUNCTION public.get_effective_permissions(p_profile_id uuid)',
    sourceBodySha256: 'ffaee56895dcd70fca9c7235984b526b5c17cc6f4673c8c01223c23bf46f0510',
    productionBodySha256: 'c7c67a94feaef3e8dd7efe8b86db32e93ab949418f18dafc90bc91a3936f3406',
    productionBody: `
declare v_actor uuid;v_role text;v_org uuid;v_target_org uuid;v_result jsonb;
begin
 v_actor:=auth.uid(); if v_actor is null then return jsonb_build_object('ok',false,'error','NOT_AUTHENTICATED'); end if;
 select role,organization_id into v_role,v_org from profiles where id=v_actor;
 select organization_id into v_target_org from profiles where id=p_profile_id; if not found then return jsonb_build_object('ok',false,'error','TARGET_NOT_FOUND'); end if;
 if v_role<>'super_admin' and p_profile_id<>v_actor and v_target_org is distinct from v_org then return jsonb_build_object('ok',false,'error','OUT_OF_SCOPE'); end if;
 if v_role='health_center_manager' and p_profile_id<>v_actor then return jsonb_build_object('ok',false,'error','OUT_OF_SCOPE'); end if;
 select coalesce(jsonb_object_agg(k.key,phoenix_profile_has_permission(p_profile_id,k.key)),'{}'::jsonb) into v_result from permission_keys k;
 return jsonb_build_object('ok',true,'permissions',v_result);
end;`,
  },
  {
    signature: 'CREATE OR REPLACE FUNCTION public.phoenix_profile_has_permission(p_profile_id uuid, p_key text)',
    sourceBodySha256: '73f1faf21d3d6990237c65f4def57a45ecf9459e8952f5d395d334e8a71e0d64',
    productionBodySha256: '7fb2f8b311ab181b0189fb3ec6e13f2b068bc3ec588343a56be8c4df672f5188',
    productionBody: `
 SELECT CASE WHEN public.phoenix_my_role()='health_center_manager' AND p_profile_id IS DISTINCT FROM auth.uid() THEN false ELSE coalesce(
 (SELECT o.allowed FROM profile_permission_overrides o WHERE o.profile_id=p_profile_id AND o.permission_key=p_key AND o.allowed IS NOT NULL),
 (SELECT d.allowed FROM role_permission_defaults d JOIN profiles pr ON pr.id=p_profile_id WHERE d.role=pr.role AND d.permission_key=p_key),false) END;
`,
  },
];

function replaceM182ReplayBody(sql, contract) {
  const first = sql.indexOf(contract.signature);
  const second = sql.indexOf(contract.signature, first + contract.signature.length);
  if (first < 0 || second >= 0) {
    throw new Error(`M182 replay normalization: expected exactly one ${contract.signature}`);
  }

  const openToken = 'AS $function$';
  const bodyStart = sql.indexOf(openToken, first);
  const nextFunction = sql.indexOf('CREATE OR REPLACE FUNCTION', first + contract.signature.length);
  const bodyEnd = sql.indexOf('$function$;', bodyStart + openToken.length);
  if (bodyStart < 0 || bodyEnd < 0 || (nextFunction >= 0 && bodyEnd > nextFunction)) {
    throw new Error(`M182 replay normalization: could not isolate ${contract.signature}`);
  }

  const contentStart = bodyStart + openToken.length;
  const sourceBody = sql.slice(contentStart, bodyEnd);
  const sourceHash = sha256(sourceBody);
  if (sourceHash !== contract.sourceBodySha256) {
    throw new Error(
      `M182 replay normalization: source body drift for ${contract.signature}; ` +
      `expected ${contract.sourceBodySha256}, got ${sourceHash}`,
    );
  }
  const productionHash = sha256(contract.productionBody);
  if (productionHash !== contract.productionBodySha256) {
    throw new Error(
      `M182 replay normalization: embedded Production body drift for ${contract.signature}; ` +
      `expected ${contract.productionBodySha256}, got ${productionHash}`,
    );
  }
  return sql.slice(0, contentStart) + contract.productionBody + sql.slice(bodyEnd);
}

// Exported so DR acceptance and the disposable Supabase workflow can use the
// same fail-closed replay policy rather than maintaining a second SQL copy.
export function shimSql(file, text) {
  let out = text;
  if (file.startsWith('023_')) {
    out = out.replace(/SELECT\s+qual\s+INTO/gi, 'SELECT coalesce(qual, with_check) INTO');
  }
  if (file === M182_FILE) {
    const sourceHash = sha256(out);
    if (sourceHash !== M182_SOURCE_SHA256) {
      throw new Error(
        `M182 replay normalization: immutable source SHA-256 mismatch; ` +
        `expected ${M182_SOURCE_SHA256}, got ${sourceHash}`,
      );
    }
    for (const contract of M182_REPLAY_BODIES) {
      out = replaceM182ReplayBody(out, contract);
    }
  }
  return out;
}

export { MIGRATIONS_DIR };

// Drop + recreate the throwaway db and apply only the Supabase bootstrap.
// Returns a connected pg.Client the caller drives directly (used by buildRig
// and by the DR acceptance test, which needs migration-by-migration control).
//
// `bootstrapSql` overrides the platform baseline for ONE build. It exists so a
// negative control can prove the authorization baseline contract is
// non-vacuous — e.g. building a deliberately deficient platform (one missing
// the initial service_role FUNCTION default) and requiring the contract test
// to FAIL with the affected signatures in MISSING_FROM_RIG. It defaults to the
// real tools/pg-rig/bootstrap.sql, so every existing caller is unaffected.
// Canonical builds must never pass it.
/** @param {{ bootstrapSql?: string }} [opts] */
export async function freshRigDb({ bootstrapSql } = {}) {
  const admin = new pg.Client({ connectionString: maintenanceUrl() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${RIG_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${RIG_DB}`);
  await admin.end();
  const c = new pg.Client({ connectionString: rigUrl() });
  await c.connect();
  await c.query(bootstrapSql ?? readFileSync(join(HERE, 'bootstrap.sql'), 'utf8'));
  return c;
}

/** The canonical platform baseline text, for tests that derive a variant. */
export function bootstrapSource() {
  return readFileSync(join(HERE, 'bootstrap.sql'), 'utf8');
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

/**
 * @param {{ upTo?: number, log?: (m: string) => void, bootstrapSql?: string,
 *           excludeCutover?: boolean }} [opts]
 */
export async function buildRig({
  upTo = Infinity, log = () => {}, bootstrapSql, excludeCutover = false,
} = {}) {
  // 1-2. Fresh db + Supabase bootstrap, then migrations.
  // `bootstrapSql` is the negative-control override documented on freshRigDb().
  // `excludeCutover` is the opt-in PRE-cutover replay; canonical builds omit it.
  const c = await freshRigDb({ bootstrapSql });

  const files = migrationFiles(upTo, { excludeCutover });
  for (const f of files) {
    const raw = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    try {
      await applyMigrationSql(c, f, shimSql(f, raw));
    } catch (e) {
      await c.end();
      throw new Error(`migration ${f} failed: ${e.message}`);
    }
    if (f.startsWith('001_')) await c.query(SEED_AFTER_001);
    log(`applied ${f}`);
  }
  // The migration-apply client is never needed again once the pool below
  // exists — leaving it open leaked one idle connection per buildRig() call
  // for that call's entire lifetime (the error path a few lines up already
  // closed it; the success path did not). A leaked idle client with no
  // 'error' listener gets forcibly terminated by the NEXT test file's own
  // freshRigDb() -> DROP DATABASE ... WITH (FORCE), which — with no listener
  // — surfaces as an uncaught exception in whatever suite happens to be
  // running when that async socket event lands, producing nondeterministic
  // cross-suite failures under a full serial *.dynamic.test.ts run.
  await c.end();

  const pool = new pg.Pool({ connectionString: rigUrl(), max: 8 });
  // node-postgres emits 'error' on the pool when an IDLE client is terminated
  // by the backend rather than by us — exactly what happens to a lingering
  // connection from a PRIOR suite's already-`rig.end()`-ed pool when the NEXT
  // suite's freshRigDb() runs `DROP DATABASE ... WITH (FORCE)` a few ms later
  // than the OS finishes tearing down that prior socket. Without a listener
  // here, that benign, already-irrelevant error surfaces as an uncaught
  // exception in whatever suite happens to be running at that moment (Node's
  // documented behavior for an EventEmitter's unhandled 'error' event) —
  // observed as nondeterministic cross-suite failures when running the full
  // *.dynamic.test.ts battery serially. This is not a bug in the rig chain or
  // in any individual suite; it is exactly the scenario node-postgres' own
  // docs warn every Pool consumer to guard against.
  //
  // Only that ONE specific, expected shutdown/teardown signature is ignored —
  // '57P01' (terminating connection due to administrator command, exactly
  // what DROP DATABASE ... WITH (FORCE) sends) and the ECONNRESET/"Connection
  // terminated unexpectedly" that immediately follows it on the same socket.
  // Anything else (a real query error surfaced at the wrong layer, a genuine
  // connectivity fault, an auth failure, ...) is NOT silently swallowed — it
  // is re-thrown so it still fails the run loudly, matching the "no
  // continue-on-error" requirement for this rig everywhere else.
  pool.on('error', (err) => {
    const benignTeardown =
      err?.code === '57P01' ||
      err?.code === 'ECONNRESET' ||
      /terminating connection due to administrator command/i.test(err?.message ?? '') ||
      /Connection terminated unexpectedly/i.test(err?.message ?? '');
    if (!benignTeardown) throw err;
  });

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
