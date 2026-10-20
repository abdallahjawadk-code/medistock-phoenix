// ===========================================================================
// HOSTED-ADAPTER (Phase P / P-HARDEN-01, LOCAL ONLY) - the Staging baseline runner, separate from the rig's freshRigDb().
//
// NOT EXECUTABLE AGAINST ANY HOSTED PROJECT IN THIS PHASE, BY DESIGN:
//   * `HostedExecutor` has no connection and every query throws STOP-PHASE-P;
//   * `HOSTED_APPLY_ENABLED` is false: even a perfectly formed S1 authorization is refused for a hosted target until a later change flips it;
//   * the default mode is dry-run (a plan, no statement executed); no CLI path opens a connection.
// It proves the METHOD on a disposable local PostgreSQL through `PgExecutor` (kind 'disposable-test').
//
// STOP codes: STOP-SOURCE (hash drift vs the frozen manifest, ALL files before the first statement), STOP-TARGET (pinned ref, Production refused,
// PG major), STOP-IDENTITY (the CONNECTION must prove it is the Staging cluster - descriptor + in-database identity), STOP-AUTH, STOP-BOOTSTRAP
// (no active super_admin linked to Auth before M062), STOP-EXTENSION (public.similarity(text,text) must exist after M001), STOP-P4, STOP-P5,
// STOP-PARTIAL (a previous run left ledger rows: NO implicit resume), STOP-RECOVERY (explicit recovery rules not met), STOP-PHASE-P.
//
// LEDGER (append-only events in its own schema `phoenix_staging_ledger`; `supabase_migrations.schema_migrations` is never written):
//   every step writes STARTED, then APPLIED | FAILED (SKIPPED for M004). The tail event classifies a stopped run:
//   P-HARDEN-01B: there is NO resume. Any non-empty ledger makes `apply` stop with STOP-PARTIAL; `mode:'recovery-plan'` is READ-ONLY and only
//   classifies the ledger (strict event grammar) for the Owner/Director, whose decision is a project reset or a forward-fix - never an automatic
//   continuation. `mode:'resume'` is refused (STOP-RECOVERY).
//   F1: a `disposable-test` executor must PROVE the live database is local and not Supabase-shaped before any write (verifyDisposableIdentity).
//   F3: the 182b overlay and the M085 precondition verifier are hash-pinned (LF-normalized) and the verified bytes are the executed bytes.
// ===========================================================================
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { frozenBytes, derive023, sha256, OVERLAY_182B, VERIFY_085 } from '../staging-baseline.mjs';

export const PINNED = Object.freeze({ stagingRef: 'knndhlczdlparjfmlxis', productionRef: 'eyrzxgfkvqybjdgyphap', pgMajor: 17, stagingPgPrefix: '17.11', stagingSystemIdentifier: '7692131729119822239' });
export const PINNED_AUX = Object.freeze({
  overlay182b: '71c6be004ae77fa5f8ffbb6d45ad294df0a7acfe5a5ee15438b04a28a35f60e0',
  verify085: '91f8c84d48b68827bcf82dd222f1bb316fb0a767587bafe90595ff0ab9955c4e',
});
/** Reads the two non-migration SQL files, LF-normalizes, and refuses any byte drift (STOP-SOURCE). `tamper` is a test seam: {overlay182b?, verify085?} byte transforms. */
export function bindAux({ auxTamper = {} } = {}) {
  const load = (path, key) => {
    let b = readFileSync(path);
    if (auxTamper[key]) b = auxTamper[key](b);
    const text = b.toString('utf8').replace(/\r\n/g, '\n');
    if (sha256(Buffer.from(text, 'utf8')) !== PINNED_AUX[key]) throw new AdapterStop('STOP-SOURCE', `${key} does not match its pinned SHA-256`, { file: key });
    return text;
  };
  return { overlay182b: load(OVERLAY_182B, 'overlay182b'), verify085: load(VERIFY_085, 'verify085') };
}
export const HOSTED_APPLY_ENABLED = false;

export class AdapterStop extends Error {
  constructor(code, message, detail) { super(`${code}: ${message}`); this.code = code; this.detail = detail; }
}

// ---------- executors ----------
export class PgExecutor {
  /** @param {{ query: Function }} client a connected pg client */
  constructor(client, { kind = 'disposable-test', ref = 'disposable-local', descriptor = null } = {}) { this.client = client; this.kind = kind; this.ref = ref; this.descriptor = descriptor; }
  async query(sql, params) { return this.client.query(sql, params); }
  identity() { return { kind: this.kind, ref: this.ref }; }
}
/** The only string that lets a hosted APPLY start. Pinned to the Staging project and its cluster identity; the CLI refuses to connect without it. */
export const HOSTED_CONFIRMATION = `S1-APPLY-${PINNED.stagingRef}-${PINNED.stagingSystemIdentifier}`;
/** S2 (R1-a candidates on top of a COMPLETE S1): a different phrase, so an S1 authorization can never start S2. */
export const HOSTED_CONFIRMATION_S2 = `S2-APPLY-R1a-${PINNED.stagingRef}-${PINNED.stagingSystemIdentifier}`;
/** The six R1-a candidates, un-numbered (D9), pinned by the SHA-256 of their LF form (= the committed git blob). Applied strictly in this order, one transaction per file (each file has its own BEGIN/COMMIT). */
export const CANDIDATE_PINS = Object.freeze([
  ['R1a_01_manual_source_schema_inert.sql', 'c53a7d1cd022373e90d5ff49a01f5e9f21afbf517ae2f26428d1c311cb1f5f1e'],
  ['R1a_02_authorization_closure.sql', '24d3a654007e98295bdf12a00c95fcb62208147e0633b6c0d8550578cf204462'],
  ['R1a_03_lifecycle_relations_and_sod.sql', '2a422c9d7654d37c54bfb14f21082537b202e68f2843c4d38cbeb02de43ef7c7'],
  ['R1a_04_manual_routines_inert.sql', '8020f5c6845246395a5fb32a50117c69ed3eff1c3c29a05e06b0e6c764f7bb97'],
  ['R1a_05_blockers_digest_d27.sql', 'fab489952b7405fe0f6902fdf0ef2b145f757cf9da111ae6fa395e55cfb65f69'],
  ['R1a_06_material_registration_inert.sql', '37ecc50769d00cbf153f828ff094a64088434f08d4e9e042aee404121b4d3fb1'],
].map(([file, sha256]) => Object.freeze({ file, sha256 })));
/** S3a (R1-b files) and S3b (one organization's activation) each have their OWN phrase; S3b's includes the organization id. */
export const HOSTED_CONFIRMATION_S3A = `S3A-APPLY-R1b-${PINNED.stagingRef}-${PINNED.stagingSystemIdentifier}`;
export const hostedConfirmationS3B = (orgId) => `S3B-ACTIVATE-${PINNED.stagingRef}-${PINNED.stagingSystemIdentifier}-${orgId}`;
/** S3p (isolated test organization + two accounts + minimal keys): its OWN phrase naming the organization. */
export const hostedConfirmationS3P = (orgId) => `S3P-PROVISION-${PINNED.stagingRef}-${PINNED.stagingSystemIdentifier}-${orgId}`;
/** The minimal D12 key sets: maker writes manual needs; checker approves and reviews material registrations (a different person: SoD; the reviewer role is super_admin by design). Nothing else is ever granted by this mode. */
export const PROVISION_KEYS = Object.freeze({
  maker: Object.freeze(['central_needs.view', 'central_needs.edit', 'central_needs.manual_need.set']),
  checker: Object.freeze(['central_needs.view', 'central_needs.approve', 'central_needs.material_review']),
});
/** Synthetic catalogue rows (clearly marked test data) so the maker has something to pick; the name is also the duplicate guard and the cleanup selector. */
export const PROVISION_ITEMS = Object.freeze([['R1-ACCEPTANCE TEST item A', 'مادة اختبار القبول أ'], ['R1-ACCEPTANCE TEST item B', 'مادة اختبار القبول ب'], ['R1-ACCEPTANCE TEST item C', 'مادة اختبار القبول ج']]);
export const R1B_PINS = Object.freeze([
  ['R1b_01_manual_activation_NOT_APPLIED.sql', 'bc251ee3fcc5a2d06eaef4b7671b135bb0f0385a5b86cfec6ef070117e0e4392'],
  ['R1b_02_material_registration_activation_NOT_APPLIED.sql', '71e87396f8a254c96980b26165520cc8054154fe1f43db5c43ccf91143315786'],
].map(([file, sha256]) => Object.freeze({ file, sha256 })));
const ACTIVATE_STEP_RE = /^(?:activate-manual-cutover|provision-test-org):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const R1B_PROBE_TRIGGERS = "tgname LIKE '%r1_05_excel_freeze' OR tgname LIKE '%r1_06_manual_activation%'";
const R1A_PROBE_TABLES = Object.freeze(['central_needs_manual_need_events', 'central_needs_material_requests', 'central_needs_material_request_events', 'central_needs_material_request_links', 'central_needs_revision_withdrawals', 'central_needs_manual_coverage_acknowledgements', 'central_needs_cutover_inventory']);

const redactSecret = (text, url) => {
  let out = String(text ?? '');
  if (!url) return out;
  out = out.split(url).join('[REDACTED]');
  try { const u = new URL(url); if (u.password) out = out.split(decodeURIComponent(u.password)).join('[REDACTED]').split(u.password).join('[REDACTED]'); } catch { /* not a URL */ }
  return out;
};
/** Strip `ssl*` query parameters: pg would otherwise let `sslmode=` override the explicit, pinned `ssl` object (same rule as tools/pg-rig/remote-io.mjs). */
const stripSslParams = (url) => { const u = new URL(url); for (const k of [...u.searchParams.keys()]) if (/^ssl/i.test(k)) u.searchParams.delete(k); return u.toString(); };

/**
 * The hosted executor: ONE pg session (never a pool - the M085 attestation GUC and the bootstrap transaction need a single session) to the pinned Staging project.
 * `HostedExecutor.connect` validates the descriptor (pinned host/user, never Production, TLS parameter) BEFORE any network activity, requires a CA file whose
 * SHA-256 equals the operator-pinned digest, and connects with rejectUnauthorized:true. The connection string comes from the caller (the CLI reads it from an
 * environment variable), is never logged, never part of an enumerable property, and is redacted from every error message.
 * Without a connection every query throws STOP-PHASE-P.
 */
export class HostedExecutor {
  constructor(ref, descriptor = null, client = null) {
    this.kind = 'hosted'; this.ref = ref; this.descriptor = descriptor; this.client = client;
    Object.defineProperty(this, 'client', { value: client, enumerable: false, writable: true });
  }
  static async connect({ url, caPath, caSha256, clientFactory } = {}) {
    const d = parseConnectionDescriptor(url, { ref: PINNED.stagingRef });                       // throws STOP-IDENTITY for Production / another project / weak TLS parameter
    if (!caPath || !caSha256) throw new AdapterStop('STOP-IDENTITY', 'TLS trust is not pinned: a CA file path and its operator-pinned SHA-256 are both required (no rejectUnauthorized:false fallback exists)');
    let ca;
    try { ca = readFileSync(caPath); } catch { throw new AdapterStop('STOP-IDENTITY', 'the pinned CA file cannot be read'); }
    if (sha256(ca) !== String(caSha256).toLowerCase()) throw new AdapterStop('STOP-IDENTITY', 'the CA file does not match the pinned SHA-256');
    const config = { connectionString: stripSslParams(url), ssl: { ca: ca.toString('utf8'), rejectUnauthorized: true }, connectionTimeoutMillis: 15000, application_name: 'phoenix-s1-baseline' };
    const client = clientFactory ? await clientFactory(config) : new (await import('pg')).default.Client(config);
    try { await client.connect(); } catch (e) { throw new AdapterStop('STOP-IDENTITY', `connection failed: ${redactSecret(e?.message, url)}`); }
    client.on?.('error', () => undefined);                                                       // a dropped session surfaces on the next query; never as an uncaught event
    const descriptor = { host: d.host, user: d.user, via: d.via };
    Object.defineProperty(descriptor, 'url', { value: url, enumerable: false });
    return new HostedExecutor(PINNED.stagingRef, descriptor, client);
  }
  async query(sql, params) {
    if (!this.client) throw new AdapterStop('STOP-PHASE-P', 'the hosted executor has no connection (use HostedExecutor.connect)');
    try { return await this.client.query(sql, params); }
    catch (e) { e.message = redactSecret(e.message, this.descriptor?.url); throw e; }
  }
  async close() { try { await this.client?.end(); } catch { /* ignore */ } }
  identity() { return { kind: 'hosted', ref: this.ref }; }
}

// ---------- target ----------
export function assertTarget(id, { expectedRef = PINNED.stagingRef } = {}) {
  if (!id || typeof id.ref !== 'string' || !id.ref) throw new AdapterStop('STOP-TARGET', 'the target project ref is missing');
  const blob = JSON.stringify(id).toLowerCase();
  if (blob.includes(PINNED.productionRef)) throw new AdapterStop('STOP-TARGET', 'the target mentions the PRODUCTION project - refused');
  if (id.kind === 'disposable-test') return { ok: true, disposable: true };
  if (id.kind !== 'hosted') throw new AdapterStop('STOP-TARGET', `unknown target kind ${id.kind}`);
  if (id.ref !== expectedRef) throw new AdapterStop('STOP-TARGET', `target ref ${id.ref} is not the pinned Staging ref`);
  return { ok: true, disposable: false };
}

// ---------- connection identity (the CONNECTION, not a label) ----------
/** Pure: validates a Postgres connection URL for the pinned Staging project. Never logs the password. */
export function parseConnectionDescriptor(url, { ref = PINNED.stagingRef } = {}) {
  let u; try { u = new URL(url); } catch { throw new AdapterStop('STOP-IDENTITY', 'the connection descriptor is not a valid URL'); }
  const raw = decodeURIComponent(`${u.hostname} ${u.username} ${u.pathname} ${u.search}`).toLowerCase();
  if (raw.includes(PINNED.productionRef)) throw new AdapterStop('STOP-IDENTITY', 'the connection descriptor names the PRODUCTION project - refused');
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new AdapterStop('STOP-IDENTITY', 'not a postgres connection');
  const host = u.hostname.toLowerCase(); const user = decodeURIComponent(u.username);
  const direct = host === `db.${ref}.supabase.co` && user === 'postgres';
  const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host) && user === `postgres.${ref}`;
  if (!direct && !pooler) throw new AdapterStop('STOP-IDENTITY', `host/user do not match the pinned Staging project (${ref})`);
  const ssl = (u.searchParams.get('sslmode') ?? '').toLowerCase();
  if (!['require', 'verify-ca', 'verify-full'].includes(ssl)) throw new AdapterStop('STOP-IDENTITY', 'sslmode must be require, verify-ca or verify-full');
  const db = u.pathname.replace(/^\//, '') || 'postgres';
  if (db !== 'postgres') throw new AdapterStop('STOP-IDENTITY', `unexpected database ${db}`);
  return { host, user, database: db, port: u.port || '5432', via: direct ? 'direct' : 'pooler', sslmode: ssl };
}
/**
 * Runs IN the connected database. `expected` comes from the S1 authorization (Owner-recorded from a read-only look at the project):
 *   { systemIdentifier, pgVersionPrefix } - the cluster's pg_control_system().system_identifier is unique per cluster, so a connection to ANY other
 *   project (Production included) fails even if every label is right. Also requires a Supabase platform shape and the empty-project state.
 */
export async function verifyConnectionIdentity(exec, expected) {
  if (!expected || !expected.systemIdentifier || !expected.pgVersionPrefix) throw new AdapterStop('STOP-IDENTITY', 'no recorded cluster identity (systemIdentifier + pgVersionPrefix) to compare against');
  const r = (await exec.query(`SELECT current_database() AS db, current_setting('server_version') AS v, (SELECT system_identifier::text FROM pg_control_system()) AS sysid,
      to_regnamespace('auth') IS NOT NULL AS has_auth, to_regnamespace('storage') IS NOT NULL AS has_storage, to_regnamespace('vault') IS NOT NULL AS has_vault`)).rows[0];
  if (r.sysid !== String(expected.systemIdentifier)) throw new AdapterStop('STOP-IDENTITY', 'the cluster system identifier differs from the recorded Staging identity - wrong project');
  if (!String(r.v).startsWith(expected.pgVersionPrefix)) throw new AdapterStop('STOP-IDENTITY', `server_version ${r.v} does not start with ${expected.pgVersionPrefix}`);
  if (exec.kind === 'hosted' && !(r.has_auth && r.has_storage && r.has_vault)) throw new AdapterStop('STOP-IDENTITY', 'the database does not have the Supabase platform schemas');
  return { database: r.db, server_version: r.v, system_identifier: r.sysid };
}

/**
 * F1. A `disposable-test` label is only a claim. Before any write the LIVE database must prove it is a local, non-Supabase cluster:
 * server address absent (unix socket) or loopback, the client's own host (when exposed) local, and none of the platform markers a hosted
 * Supabase project always has (storage/vault/realtime/graphql schemas, supabase_* roles, supabase_vault/pg_net extensions).
 */
export async function verifyDisposableIdentity(exec) {
  const r = (await exec.query(`SELECT inet_server_addr()::text AS addr,
      (SELECT array_agg(nspname ORDER BY nspname) FROM pg_namespace WHERE nspname IN ('storage','vault','realtime','graphql','graphql_public','supabase_functions','_realtime','pgsodium')) AS schemas,
      (SELECT array_agg(rolname ORDER BY rolname) FROM pg_roles WHERE rolname IN ('supabase_admin','supabase_auth_admin','supabase_storage_admin','supabase_read_only_user','dashboard_user','pgbouncer')) AS roles,
      (SELECT array_agg(extname ORDER BY extname) FROM pg_extension WHERE extname IN ('supabase_vault','pg_net','pg_graphql','pgsodium')) AS exts`)).rows[0];
  const loopback = (a) => a == null || /^127\./.test(a.replace(/\/\d+$/, '')) || a.replace(/\/\d+$/, '') === '::1';
  if (!loopback(r.addr)) throw new AdapterStop('STOP-IDENTITY', `the disposable-test target is not local (server address ${r.addr}) - a label cannot turn a remote database into a test database`);
  const host = exec.client?.connectionParameters?.host ?? exec.client?.host;
  if (host && !(host === 'localhost' || /^127\./.test(host) || host === '::1' || host.startsWith('/'))) throw new AdapterStop('STOP-IDENTITY', `the disposable-test client host ${host} is not local`);
  const marks = [...(r.schemas ?? []), ...(r.roles ?? []), ...(r.exts ?? [])];
  if (marks.length) throw new AdapterStop('STOP-IDENTITY', `the disposable-test target carries Supabase platform markers (${marks.join(', ')}) - refused`);
  return { addr: r.addr, markers: 0 };
}

// ---------- extension gate: R1a_06 calls public.similarity(text,text) ----------
export async function assertSimilarityAvailable(exec) {
  const r = (await exec.query(`SELECT to_regprocedure('public.similarity(text,text)') IS NOT NULL AS ok,
      (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm') AS trgm_schema`)).rows[0];
  if (!r.ok) throw new AdapterStop('STOP-EXTENSION', `public.similarity(text,text) does not exist (pg_trgm schema: ${r.trgm_schema ?? 'not installed'}); R1a_06 would fail - stop`);
  return { ok: true, trgm_schema: r.trgm_schema };
}

// ---------- read-only preflight ----------
export async function preflight(exec, { expectedMajor = PINNED.pgMajor, allowNonEmpty = false } = {}) {
  const v = (await exec.query(`SELECT current_setting('server_version') AS v, current_setting('server_version_num')::int AS n`)).rows[0];
  const major = Math.floor(v.n / 10000);
  if (major !== expectedMajor) throw new AdapterStop('STOP-TARGET', `PostgreSQL major ${major}, expected ${expectedMajor}`);
  const t = (await exec.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`)).rows[0].n;
  const has = (await exec.query(`SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS x`)).rows[0].x;
  const m = has ? (await exec.query(`SELECT count(*)::int AS n FROM supabase_migrations.schema_migrations`)).rows[0].n : 0;
  if (t !== 0 && !allowNonEmpty) throw new AdapterStop('STOP-TARGET', `the target is not empty: ${t} public tables`);
  if (m !== 0) throw new AdapterStop('STOP-TARGET', `the target already has ${m} recorded migrations`);
  const ext = (await exec.query(`SELECT name FROM pg_available_extensions WHERE name IN ('pg_trgm','pgcrypto','btree_gist') ORDER BY 1`)).rows.map((r) => r.name);
  const installed = (await exec.query(`SELECT e.extname AS name, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname IN ('pgcrypto','pg_trgm') ORDER BY 1`)).rows;
  return { server_version: v.v, public_tables: t, recorded_migrations: m, extensions_available: ext, extensions_installed: installed };
}

// ---------- source binding ----------
export function bindSources({ freeze, migrationsDir, upTo = 221, tamper = {} }) {
  const frozen = new Map(freeze.map((x) => [x.path.split('/').pop(), x.sha256]));
  const files = readdirSync(migrationsDir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort().filter((f) => parseInt(f.slice(0, 3), 10) <= upTo);
  const plan = [];
  for (const f of files) {
    const want = frozen.get(f);
    if (!want) throw new AdapterStop('STOP-SOURCE', `${f} is not in the frozen manifest`);
    const disk = readFileSync(join(migrationsDir, f));
    const fb = frozenBytes(tamper[f] ? tamper[f](disk) : disk, want);
    if (!fb) throw new AdapterStop('STOP-SOURCE', `${f} does not match the frozen SHA-256`, { file: f });
    plan.push({ file: f, bytes: fb.bytes, form: fb.form, frozenSha: want });
  }
  const missing = [...frozen.keys()].filter((f) => parseInt(f.slice(0, 3), 10) <= upTo && !files.includes(f));
  if (missing.length) throw new AdapterStop('STOP-SOURCE', `frozen files absent: ${missing.join(', ')}`);
  return plan;
}

// The Owner-attested Auth->Profile link sits between M001 (which creates `profiles` and the auto-profile trigger) and M062 (which needs an active super_admin).
// The Auth user is created by the OWNER before the run, so the M001 trigger never fired for it: this step performs exactly what that trigger would have done
// (insert the profile for the EXISTING Auth user), then promotes that one profile. It never creates or edits an Auth user.
export const BOOTSTRAP_INSERT = `INSERT INTO public.profiles (id, full_name, role) SELECT u.id, coalesce(u.raw_user_meta_data->>'full_name', u.email, 'Unknown'), 'viewer' FROM auth.users u WHERE u.id = $1 ON CONFLICT (id) DO NOTHING`;
export const BOOTSTRAP_PROMOTE = `UPDATE public.profiles SET role = 'super_admin', status = 'active' WHERE id = $1 AND organization_id IS NULL`;
export const BOOTSTRAP_HASH = sha256(Buffer.from(`${BOOTSTRAP_INSERT};\n${BOOTSTRAP_PROMOTE}`, 'utf8'));
// A-ACL-1 (Owner-approved scope, 2026-10-20): Supabase grants anon/authenticated/service_role default privileges on every new object of role postgres in `public`.
// The frozen chain was written for a project whose pre-chain state had NO anon defaults and no authenticated default on functions (rig bootstrap.sql, M108/M109 headers):
// without this step M045 (anon assertion), M191 (anon table grants) and M196 (function ACL order) stop the run. EXACTLY these four statements, role postgres, schema public only:
// never global, never PUBLIC, never service_role, never existing objects. Ledgered as its own pinned step BEFORE M001. No frozen file is altered; this is not a derivation.
export const ACL_ALIGN_STATEMENTS = Object.freeze([
  'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon',
  'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon',
  'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon',
  'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM authenticated',
]);
const ACL_ALIGN_STEP = 'platform default-ACL alignment';
export const ACL_ALIGN_HASH = sha256(Buffer.from(ACL_ALIGN_STATEMENTS.join(';\n'), 'utf8'));
const DEFAULT_ACL_SQL = `SELECT d.defaclobjtype AS t, coalesce(r.rolname, 'PUBLIC') AS g
    FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
   WHERE n.nspname = 'public' AND d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'postgres') AND a.grantee <> d.defaclrole`;
/** Reads the six candidates from `candidatesDir`, LF-normalizes, refuses any drift from the pins (STOP-SOURCE) before anything runs. `candidateTamper` is a test seam. */
export function bindCandidates({ candidatesDir, candidateTamper = {}, set = 'R1a' } = {}) {
  if (!candidatesDir) throw new AdapterStop('STOP-SOURCE', 'no candidates directory given');
  return (set === 'R1b' ? R1B_PINS : CANDIDATE_PINS).map(({ file, sha256: want }) => {
    let b; try { b = readFileSync(join(candidatesDir, file)); } catch { throw new AdapterStop('STOP-SOURCE', `${file} cannot be read`, { file }); }
    if (candidateTamper[file]) b = candidateTamper[file](b);
    const text = b.toString('utf8').replace(/\r\n/g, '\n');
    if (sha256(Buffer.from(text, 'utf8')) !== want) throw new AdapterStop('STOP-SOURCE', `${file} does not match its pinned SHA-256`, { file });
    return { file, text, sha256: want };
  });
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

const stepNames = (bound, o = {}) => [...bound.flatMap((p) => (p.file.startsWith('182_') ? [p.file, '182b overlay'] : p.file.startsWith('001_') ? [ACL_ALIGN_STEP, p.file, 'bootstrap profile'] : [p.file])), ...(o.candidates ? CANDIDATE_PINS.map((c) => c.file) : []), ...(o.r1b ? R1B_PINS.map((c) => c.file) : [])];

/**
 * P-HARDEN-01C. Every mandatory INPUT is proven BEFORE the first write (before the ledger schema exists): the P5 attestation (when M085 is in the plan),
 * the Owner-attested bootstrap identity (named, dated, target-bound, an Auth user that already exists with that exact email), and pg_trgm availability/placement.
 * Reads only. A missing input is a refusal here, never a stop in the middle of the chain.
 */
export async function assertPreWriteInputs(exec, o, id, target, bound) {
  if (bound.some((p) => p.file.startsWith('085_'))) {
    const p5 = o.p5;
    const named = p5 && p5.ownerRef && DATE_RE.test(p5.attestedOn ?? '') && p5.projectRef === id.ref && p5.evidenceSha256 && p5.evidenceSha256 === o.evidenceSha256;
    if (!named) throw new AdapterStop('STOP-P5', 'no named, dated attestation bound to this target and to the current evidence hash - refused BEFORE the first write (nothing is inferred)');
    if (String(p5.ownerRef).startsWith('TEST-ONLY') && !target.disposable) throw new AdapterStop('STOP-P5', 'a TEST-ONLY attestation is never valid on a hosted target');
  }
  const b = o.bootstrap;
  const shaped = b && b.phase === 'S1-BOOTSTRAP' && b.projectRef === id.ref && UUID_RE.test(b.authUserId ?? '') && typeof b.email === 'string' && /^[^@\s]+@[^@\s]+$/.test(b.email)
    && b.ownerRef && DATE_RE.test(b.attestedOn ?? '');
  if (!shaped) throw new AdapterStop('STOP-BOOTSTRAP', 'no Owner-attested bootstrap input {phase:S1-BOOTSTRAP, projectRef, authUserId, email, ownerRef, attestedOn} bound to this target - refused BEFORE the first write (the adapter never creates an Auth user)');
  const testOnly = String(b.ownerRef).startsWith('TEST-ONLY');
  if (testOnly && !target.disposable) throw new AdapterStop('STOP-BOOTSTRAP', 'a TEST-ONLY bootstrap attestation is never valid on a hosted target');
  if (!testOnly && target.disposable) throw new AdapterStop('STOP-BOOTSTRAP', 'a disposable target accepts only a TEST-ONLY bootstrap attestation');
  const r = (await exec.query(`SELECT (SELECT email FROM auth.users WHERE id = $1) AS email, to_regclass('public.profiles') IS NOT NULL AS has_profiles`, [b.authUserId])).rows[0];
  if (r.email == null) throw new AdapterStop('STOP-BOOTSTRAP', 'the attested Auth user does not exist in the target: the Owner creates it first (the adapter never does)');
  if (String(r.email).toLowerCase() !== b.email.toLowerCase()) throw new AdapterStop('STOP-BOOTSTRAP', 'the Auth user exists but its email differs from the attested email');
  if (r.has_profiles) throw new AdapterStop('STOP-BOOTSTRAP', 'public.profiles already exists: the target is not the pre-M001 empty state');
  const ext = (await exec.query(`SELECT (SELECT count(*)::int FROM pg_available_extensions WHERE name = 'pg_trgm') AS avail,
      (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm') AS installed_schema`)).rows[0];
  if (!ext.avail) throw new AdapterStop('STOP-EXTENSION', 'pg_trgm is not available on the target - refused BEFORE the first write');
  if (ext.installed_schema && ext.installed_schema !== 'public') throw new AdapterStop('STOP-EXTENSION', `pg_trgm is already installed in schema ${ext.installed_schema}; M001 would leave public.similarity missing - refused BEFORE the first write`);
  // A-ACL-1 pre-check (read-only): the only grantees allowed in postgres/public default ACLs are the three platform roles; anything else (PUBLIC, an unknown role) is refused before the first write.
  const dacl = (await exec.query(DEFAULT_ACL_SQL)).rows;
  const odd = dacl.filter((x) => !['anon', 'authenticated', 'service_role'].includes(x.g));
  if (odd.length) throw new AdapterStop('STOP-TARGET', `unexpected default-ACL grantee(s) for role postgres in public: ${[...new Set(odd.map((x) => x.g))].join(', ')} - refused BEFORE the first write`);
  return { authUserId: b.authUserId, testOnly };
}

// ---------- plan (pure; no database) ----------
export function planBaseline(o) {
  const bound = bindSources(o);
  bindAux(o);                                                      // STOP-SOURCE for the 182b overlay and the M085 verifier too
  const steps = [];
  for (const p of bound) {
    if (p.file.startsWith('004_') && o.skip004 !== false) { steps.push({ file: p.file, action: 'NOT_APPLIED (B2: demo data skipped)', original_sha256: p.frozenSha }); continue; }
    if (p.file.startsWith('023_')) { const t = derive023(p.bytes.toString('utf8')); steps.push({ file: p.file, action: 'APPLIED derived (023-verify-read)', original_sha256: p.frozenSha, applied_sha256: sha256(Buffer.from(t)), derived: true }); continue; }
    if (p.file.startsWith('062_')) steps.push({ gate: 'STOP-BOOTSTRAP: an active super_admin linked to Auth must exist (owner-provided; B5)' });
    if (p.file.startsWith('085_')) steps.push({ gate: 'STOP-P4 (P1-P4 incl. real authenticated EXECUTE) then STOP-P5 (named, dated, evidence-bound owner attestation)' });
    if (p.file.startsWith('001_')) steps.push({ file: ACL_ALIGN_STEP, action: 'APPLIED A-ACL-1: revoke anon (tables, sequences, functions) and authenticated (functions) DEFAULT privileges of role postgres in schema public', applied_sha256: ACL_ALIGN_HASH });
    steps.push({ file: p.file, action: 'APPLIED original bytes', original_sha256: p.frozenSha, applied_sha256: p.frozenSha, form: p.form });
    if (p.file.startsWith('001_')) {
      steps.push({ gate: 'STOP-EXTENSION: public.similarity(text,text) must exist before R1a_06 (checked right after M001)' });
      steps.push({ file: 'bootstrap profile', action: 'APPLIED Owner-attested Auth->Profile link for an EXISTING Auth user (no Auth user is created)', applied_sha256: BOOTSTRAP_HASH });
    }
    if (p.file.startsWith('182_')) steps.push({ file: '182b overlay', action: 'APPLIED hash-pinned overlay (separate, not a migration)', applied_sha256: PINNED_AUX.overlay182b });
  }
  if (o.candidates) {
    for (const c of bindCandidates(o)) steps.push({ file: c.file, action: 'APPLIED R1-a candidate (hash-pinned, un-numbered; one transaction)', original_sha256: c.sha256, applied_sha256: c.sha256 });
  }
  if (o.r1b) {
    if (!o.candidates) throw new AdapterStop('STOP-SOURCE', 'the R1-b plan requires the R1-a candidates in the same plan');
    for (const c of bindCandidates({ ...o, set: 'R1b' })) steps.push({ file: c.file, action: 'APPLIED R1-b candidate (hash-pinned, un-numbered; one transaction)', original_sha256: c.sha256, applied_sha256: c.sha256 });
  }
  return steps;
}

export function rollbackReview() {
  return [
    'Phase S1 on an EMPTY Staging project: there is NO in-place down path. Recovery = project reset/re-creation by the Owner (separate authorization). The adapter never issues DROP SCHEMA/DROP TABLE/reset on a hosted target.',
    'A stopped run is NEVER resumed: there is no resume mode (STOP-RECOVERY) and any re-run is STOP-PARTIAL. recovery-plan only classifies the ledger (strict event grammar, read-only); every non-empty state needs an Owner/Director decision: project reset or forward-fix.',
    'Before ANY later phase that modifies existing grants (R1a_02): capture the ACL snapshot (captureAclSnapshot) and take a project backup/branch point first; no rollback is claimed without it (STOP-ROLLBACK).',
    'rollback_phase1_disposable.sql is rig-only (proved on a disposable database) and must never be pointed at a hosted project.',
  ];
}

export const LEDGER_SQL = `
CREATE SCHEMA IF NOT EXISTS phoenix_staging_ledger;
CREATE TABLE IF NOT EXISTS phoenix_staging_ledger.baseline_steps (
  seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, step text NOT NULL,
  status text NOT NULL CHECK (status IN ('STARTED','APPLIED','FAILED','SKIPPED')), action text, original_sha256 text, applied_sha256 text,
  byte_form text, derivation text, attestation_ref text, error text, target_ref text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON SCHEMA phoenix_staging_ledger FROM PUBLIC;
`;

export async function captureAclSnapshot(exec) {
  return (await exec.query(`SELECT 'proc' AS k, n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS obj, coalesce(p.proacl::text,'') AS acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')
    UNION ALL SELECT 'rel', n.nspname||'.'||c.relname, coalesce(c.relacl::text,'')||'|rls='||c.relrowsecurity||'|force='||c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','S') AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2`)).rows;
}

// ---------- ledger reading / recovery analysis (read-only) ----------
export async function readLedger(exec) {
  const has = (await exec.query(`SELECT to_regclass('phoenix_staging_ledger.baseline_steps') IS NOT NULL AS x`)).rows[0].x;
  if (!has) return [];
  return (await exec.query(`SELECT seq, step, status, original_sha256, applied_sha256, target_ref FROM phoenix_staging_ledger.baseline_steps ORDER BY seq`)).rows;
}
/**
 * Strict event grammar (F2). The ledger must be exactly a prefix of: per planned step `STARTED, (APPLIED|FAILED)` (M004: a lone `SKIPPED`),
 * seq strictly increasing, one target_ref throughout (and equal to `o.expectedTargetRef` when given), recorded hashes equal to the plan, nothing after
 * a FAILED, nothing after the last planned step. The only extra event allowed is the FAILED extension gate directly after M001 APPLIED.
 * Classification is advisory for the Owner/Director: EVERY non-EMPTY, non-COMPLETE state is `owner-decision (reset or forward-fix)`; there is no resume.
 */
export function analyzeLedger(rows, o) {
  const bound = bindSources(o); let names = stepNames(bound, o);
  // A ledger written by the executor BEFORE A-ACL-1 existed (the S1 attempt that stopped at M045) legitimately starts at M001. It is validated against the historical plan - the same plan minus the
  // alignment step - with every other rule (order, hashes, single target, grammar) unchanged. The alignment step may not appear anywhere in such a ledger; apply never accepts a non-empty ledger anyway.
  const legacy = rows.length > 0 && rows[0].step !== ACL_ALIGN_STEP && names[0] === ACL_ALIGN_STEP;
  if (legacy) names = names.filter((n) => n !== ACL_ALIGN_STEP);
  if (rows.length === 0) return { classification: 'EMPTY', next: names[0], allowed: 'fresh-apply' };
  const expected = new Map(planBaseline(o).filter((s) => s.file).map((s) => [s.file, s]));
  const tail = rows[rows.length - 1];
  const bad = (reason) => ({ classification: 'INTEGRITY-FAILURE', reason, tail, allowed: 'owner-decision (reset or forward-fix); no resume' });
  const target = rows[0].target_ref;
  let i = 0; let open = null; let prevSeq = -Infinity; let failedSeen = false;
  for (const r of rows) {
    if (failedSeen) return bad(`event ${r.step}/${r.status} follows a FAILED event`);
    if (!['STARTED', 'APPLIED', 'FAILED', 'SKIPPED'].includes(r.status)) return bad(`unknown status ${r.status}`);
    if (!(Number(r.seq) > prevSeq)) return bad('seq is not strictly increasing'); prevSeq = Number(r.seq);
    if (r.target_ref !== target || (o.expectedTargetRef && r.target_ref !== o.expectedTargetRef)) return bad(`target_ref ${r.target_ref} is not the single expected target`);
    if (open) {
      if (r.step !== open) return bad(`${r.step}/${r.status} appears while ${open} is open`);
      if (r.status === 'APPLIED') {
        const e = expected.get(open) ?? { applied_sha256: null };                                  // activation steps carry no file hash
        if (e.original_sha256 !== undefined && r.original_sha256 !== (e.original_sha256 ?? null)) return bad(`recorded original hash of ${open} differs from the plan`);
        if (expected.has(open) && r.applied_sha256 !== e.applied_sha256) return bad(`recorded applied hash of ${open} differs from the plan`);
        open = null; i += 1; continue;
      }
      if (r.status === 'FAILED') { open = null; failedSeen = true; continue; }
      return bad(`${open} has a second ${r.status}`);
    }
    if (r.status === 'FAILED' && r.step === '001_extension_gate' && i > 0 && names[i - 1].startsWith('001_')) { failedSeen = true; continue; }
    if (i >= names.length && o.r1b && ACTIVATE_STEP_RE.test(r.step)) names.push(r.step);                     // S3b: any number of per-organization activation steps may follow the plan
    if (i >= names.length) return bad(`event ${r.step}/${r.status} is beyond the last planned step`);
    if (r.step !== names[i]) return bad(`ledger step ${r.step} is not the planned step ${names[i]}`);
    if (r.status === 'STARTED') { open = r.step; continue; }
    if (r.status === 'SKIPPED' && expected.get(r.step)?.action?.startsWith('NOT_APPLIED') && r.original_sha256 === expected.get(r.step).original_sha256) { i += 1; continue; }
    return bad(`${r.step}/${r.status} is not allowed here (a step must be STARTED first)`);
  }
  const base = { tail, settled: i, contract: legacy ? 'pre-A-ACL-1 (historical plan)' : 'current' };
  const allowed = 'owner-decision (reset or forward-fix); there is NO resume';
  if (open) return { classification: 'AMBIGUOUS', ...base, allowed: `${allowed} - the file may be partly applied` };
  if (failedSeen) return { classification: 'FAILED', ...base, allowed };
  if (i === names.length) return { classification: 'COMPLETE', ...base, allowed: 'verify-only' };
  return { classification: 'CLEAN-BOUNDARY', ...base, next: names[i], allowed: `${allowed} - a clean boundary is informational only` };
}

// ---------- S2 / S3a: candidate files on top of a COMPLETE ledger ----------
// Same guards as S1 (pinned sources, identity, authorization bound to the target, ledger grammar, no resume, ROLLBACK before FAILED). Writes ONLY the pinned files of the set, in order,
// one transaction per file, each ledgered STARTED -> APPLIED|FAILED. First failure = stop; nothing is retried or repaired.
function checkAuth(a, id, target, phase, scope) {
  const ok = a && a.phase === phase && a.scope === scope && a.projectRef === id.ref && a.authorizedBy && /^\d{4}-\d{2}-\d{2}/.test(a.authorizedOn ?? '');
  if (!ok) throw new AdapterStop('STOP-AUTH', `no valid ${phase} authorization {phase:${phase}, scope:${scope}} bound to this target`);
  if (target.disposable && !String(a.authorizedBy).startsWith('TEST-ONLY')) throw new AdapterStop('STOP-AUTH', 'a disposable target accepts only a TEST-ONLY authorization');
  if (!target.disposable && String(a.authorizedBy).startsWith('TEST-ONLY')) throw new AdapterStop('STOP-AUTH', 'a TEST-ONLY authorization is never valid on a hosted target');
}
async function requireComplete(exec, o, id, planOpts, what) {
  const base = analyzeLedger(await readLedger(exec), { ...o, ...planOpts, expectedTargetRef: id.ref });
  if (base.classification !== 'COMPLETE' || base.contract !== 'current') throw new AdapterStop('STOP-LEDGER', `${what} is not COMPLETE under the current contract (${base.classification}${base.reason ? ': ' + base.reason : ''}); refused`);
}
const ledgerEv = (exec, id) => (step, status, extra = {}) => exec.query(
  `INSERT INTO phoenix_staging_ledger.baseline_steps (step, status, action, original_sha256, applied_sha256, attestation_ref, error, target_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [step, status, extra.action ?? null, extra.original ?? null, extra.applied ?? null, extra.attestation ?? null, extra.error ?? null, id.ref]);
async function applyFiles(exec, cands, o, id, target, label) {
  const ev = ledgerEv(exec, id);
  const snapshot = await captureAclSnapshot(exec);                              // read-only; the digest is returned so the operator can bind a rollback claim to it
  const aclSnapshotSha256 = sha256(Buffer.from(JSON.stringify(snapshot), 'utf8'));
  let applied = 0;
  for (const c of cands) {
    if (o.testHook && target.disposable) await o.testHook(c.file, exec);
    await ev(c.file, 'STARTED');
    try { if (o.testBreakStep === c.file && target.disposable) await exec.query('BEGIN; SELECT 1/0'); await exec.query(c.text); }
    catch (e) {
      try { await exec.query('ROLLBACK').catch(() => undefined); await ev(c.file, 'FAILED', { error: String(e.message).slice(0, 500) }); } catch { /* tail stays STARTED = ambiguous */ }
      throw new AdapterStop('STOP-APPLY', `${c.file}: ${e.message}`, { file: c.file });
    }
    await ev(c.file, 'APPLIED', { action: `APPLIED ${label} candidate`, original: c.sha256, applied: c.sha256 });
    o.log?.(`applied ${c.file}`); applied += 1;
  }
  return { applied, aclSnapshotSha256 };
}
async function applyCandidates(exec, o, id, target) {
  const cands = bindCandidates(o);                                              // STOP-SOURCE before any read-for-decision of the target
  checkAuth(o.authorization, id, target, 'S2', 'candidates-R1a_01-06');
  await requireComplete(exec, o, id, { candidates: false, r1b: false }, 'S1');  // the historical pre-A-ACL-1 ledger is never a base for S2
  const present = (await exec.query(`SELECT t FROM unnest($1::text[]) AS t WHERE to_regclass('public.' || t) IS NOT NULL`, [R1A_PROBE_TABLES])).rows.map((r) => r.t);
  if (present.length) throw new AdapterStop('STOP-TARGET', `R1-a objects already exist (${present.join(', ')}); S2 refused`);
  const r = await applyFiles(exec, cands, o, id, target, 'R1-a');
  return { mode: 'apply-candidates', applied: r.applied, executed: r.applied, aclSnapshotSha256: r.aclSnapshotSha256 };
}
// S3a: R1b_01 then R1b_02. They GRANT EXECUTE on the 18 writers to authenticated and install the guards; every writer stays refused until an organization carries its own activation marker
// (S3b) and the actor holds the key. No organization is activated, no key is granted, no user is created here.
async function applyR1b(exec, o, id, target) {
  const cands = bindCandidates({ ...o, set: 'R1b' });
  checkAuth(o.authorization, id, target, 'S3', 'candidates-R1b_01-02');
  await requireComplete(exec, o, id, { candidates: true, r1b: false }, 'S1+S2');
  const pre = (await exec.query(`SELECT to_regprocedure('phoenix_cn_policy.excel_read_restriction_state(uuid)') IS NOT NULL AS state_fn,
      to_regprocedure('phoenix_private.central_needs_activate_manual_cutover_v1(uuid)') IS NOT NULL AS routine, (SELECT count(*)::int FROM pg_trigger WHERE ${R1B_PROBE_TRIGGERS}) AS triggers,
      (SELECT count(*)::int FROM phoenix_private.central_needs_capability_breaches_v1()) AS breaches`)).rows[0];
  if (!pre.state_fn) throw new AdapterStop('STOP-TARGET', 'the R1-a state function is missing; S3a refused');
  if (pre.routine || pre.triggers) throw new AdapterStop('STOP-TARGET', 'R1-b objects already exist; S3a refused');
  if (pre.breaches) throw new AdapterStop('STOP-TARGET', `the capability seal already reports ${pre.breaches} breach(es); S3a refused`);
  const r = await applyFiles(exec, cands, o, id, target, 'R1-b');
  return { mode: 'apply-r1b', applied: r.applied, executed: r.applied, aclSnapshotSha256: r.aclSnapshotSha256 };
}
// S3b: activate ONE organization (irreversible: the append-only marker). Everything is proven read-only first; the owner-only routine is then called once.
async function activateOrg(exec, o, id, target) {
  const org = String(o.organizationId ?? '');
  if (!UUID_RE.test(org)) throw new AdapterStop('STOP-AUTH', 'organizationId (uuid) is required');
  const a = o.authorization;
  checkAuth(a, id, target, 'S3B', 'activate-manual-cutover');
  if (a.organizationId !== org) throw new AdapterStop('STOP-AUTH', 'the S3B authorization names a different organization');
  await requireComplete(exec, o, id, { candidates: true, r1b: true }, 'S1+S2+S3a');
  const r = (await exec.query(`SELECT (SELECT organization_kind FROM public.organizations WHERE id = $1 AND archived_at IS NULL) AS kind,
      phoenix_cn_policy.excel_read_restriction_state($1::uuid) AS state,
      (SELECT count(*)::int FROM public.central_needs_plan_revisions WHERE organization_id = $1 AND source_mode = 'excel' AND status IN ('draft','submitted')) AS pending_excel,
      (SELECT count(*)::int FROM phoenix_private.central_needs_capability_breaches_v1()) AS breaches`, [org])).rows[0];
  if (r.kind !== 'pharmacy_department_authority') throw new AdapterStop('STOP-TARGET', 'the organization does not exist, is archived, or is not a pharmacy department authority');
  if (r.state === 'active') throw new AdapterStop('STOP-TARGET', 'the organization already carries its activation marker; refused (no implicit replay)');
  if (r.pending_excel) throw new AdapterStop('STOP-TARGET', `${r.pending_excel} Excel draft/submitted revision(s) are pending; activation refused`);
  if (r.breaches) throw new AdapterStop('STOP-TARGET', `the capability seal reports ${r.breaches} breach(es); activation refused`);
  // D12 staffing: an eligible, active maker (view + edit + manual_need.set) and a DIFFERENT eligible, active checker (view + approve) must exist in this organization
  const holders = (await exec.query(`SELECT p.id, bool_or(k.permission_key = 'central_needs.manual_need.set') AS maker, bool_or(k.permission_key = 'central_needs.approve') AS checker,
        bool_or(k.permission_key = 'central_needs.view') AS viewer, bool_or(k.permission_key = 'central_needs.edit') AS editor
      FROM public.profiles p JOIN public.profile_permission_overrides k ON k.profile_id = p.id AND k.allowed
     WHERE p.organization_id = $1 AND p.status = 'active' AND p.role IN ('super_admin','central_warehouse_manager') GROUP BY p.id`, [org])).rows;
  const makers = holders.filter((h) => h.maker && h.viewer && h.editor).map((h) => h.id);
  const checkers = holders.filter((h) => h.checker && h.viewer).map((h) => h.id);
  if (!makers.some((m) => checkers.some((c) => c !== m))) throw new AdapterStop('STOP-STAFFING', 'activation needs an eligible maker (view+edit+manual_need.set) and a DIFFERENT eligible checker (view+approve) in this organization');
  const ev = ledgerEv(exec, id); const step = `activate-manual-cutover:${org}`;
  await ev(step, 'STARTED');
  let res;
  try { res = (await exec.query(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1::uuid) AS r`, [org])).rows[0].r;
    const after = (await exec.query(`SELECT phoenix_cn_policy.excel_read_restriction_state($1::uuid) AS state`, [org])).rows[0].state;
    if (!res || res.ok !== true || res.idempotent_replay === true || after !== 'active') throw new Error(`unexpected activation result (${JSON.stringify(res)}, state=${after})`);
  } catch (e) {
    try { await exec.query('ROLLBACK').catch(() => undefined); await ev(step, 'FAILED', { error: String(e.message).slice(0, 500) }); } catch { /* ambiguous tail */ }
    throw new AdapterStop('STOP-APPLY', `${step}: ${e.message}`);
  }
  await ev(step, 'APPLIED', { action: 'APPLIED owner-only activation (append-only marker)', attestation: `${a.authorizedBy}@${a.authorizedOn}#org:${org.slice(0, 8)}` });
  return { mode: 'activate-org', executed: 1, organizationId: org, inventoried_revisions: res.inventoried_revisions };
}

// S3p: provision ONE isolated test pharmacy organization, ONE beneficiary institution, two EXISTING Auth users as maker/checker, minimal keys, synthetic catalogue rows.
// Never creates Auth users or secrets (the Owner creates them in the dashboard). Refuses anything but a pristine target: no organizations, no overrides, no markers, no prior synthetic rows.
async function provisionOrg(exec, o, id, target) {
  const a = o.authorization;
  checkAuth(a, id, target, 'S3P', 'provision-test-org');
  const org = String(o.organizationId ?? '');
  if (!UUID_RE.test(org) || a.organizationId !== org) throw new AdapterStop('STOP-AUTH', 'the S3P authorization must name the same organization uuid');
  const ben = String(a.beneficiaryOrganizationId ?? '');
  if (!UUID_RE.test(ben) || ben === org) throw new AdapterStop('STOP-AUTH', 'the S3P authorization needs a distinct beneficiary organization uuid');
  const mail = (v) => (typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v.toLowerCase() : null);
  const makerEmail = mail(a.makerEmail); const checkerEmail = mail(a.checkerEmail);
  if (!makerEmail || !checkerEmail || makerEmail === checkerEmail) throw new AdapterStop('STOP-AUTH', 'two DIFFERENT valid maker/checker emails are required (D12)');
  await requireComplete(exec, o, id, { candidates: true, r1b: true }, 'S1+S2+S3a');
  const st = (await exec.query(`SELECT (SELECT count(*)::int FROM public.organizations) AS orgs, (SELECT count(*)::int FROM public.profile_permission_overrides) AS overrides,
      (SELECT count(*)::int FROM public.central_needs_cutover_inventory WHERE entry_kind = 'activation_marker') AS markers,
      (SELECT count(*)::int FROM public.central_items WHERE name = ANY($1::text[])) AS items, (SELECT count(*)::int FROM phoenix_private.central_needs_capability_breaches_v1()) AS breaches,
      (SELECT count(*)::int FROM public.profiles WHERE role = 'super_admin' AND status = 'active') AS owners`, [PROVISION_ITEMS.map((x) => x[0])])).rows[0];
  if (st.orgs || st.overrides || st.markers || st.items) throw new AdapterStop('STOP-TARGET', `the target is not pristine (organizations=${st.orgs}, overrides=${st.overrides}, markers=${st.markers}, synthetic items=${st.items}); S3p refused`);
  if (st.breaches) throw new AdapterStop('STOP-TARGET', `the capability seal reports ${st.breaches} breach(es); S3p refused`);
  if (st.owners !== 1) throw new AdapterStop('STOP-TARGET', `expected exactly one active super_admin (the bootstrap Owner), found ${st.owners}`);
  const who = (await exec.query(`SELECT lower(u.email) AS email, u.id, p.id AS profile_id, p.role, p.organization_id FROM auth.users u LEFT JOIN public.profiles p ON p.id = u.id WHERE lower(u.email) = ANY($1::text[])`, [[makerEmail, checkerEmail]])).rows;
  const maker = who.filter((r) => r.email === makerEmail); const checker = who.filter((r) => r.email === checkerEmail);
  if (maker.length !== 1 || checker.length !== 1) throw new AdapterStop('STOP-STAFFING', 'each of the two Auth users must exist exactly once (the Owner creates them in the dashboard); refused');
  const m = maker[0]; const c = checker[0];
  if (m.id === c.id || !m.profile_id || !c.profile_id) throw new AdapterStop('STOP-STAFFING', 'maker and checker must be two different accounts that both already have a profile');
  if (m.role === 'super_admin' || c.role === 'super_admin' || m.organization_id || c.organization_id) throw new AdapterStop('STOP-STAFFING', 'maker/checker must be fresh non-owner profiles without an organization');
  const ev = ledgerEv(exec, id); const step = `provision-test-org:${org}`;
  await ev(step, 'STARTED');
  try {
    await exec.query('BEGIN');
    await exec.query(`INSERT INTO public.organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES ($1,'R1 ACCEPTANCE TEST Pharmacy Dept','دائرة صيدلة اختبار القبول',$2,'pharmacy_department_authority',NULL),
        ($3,'R1 ACCEPTANCE TEST Hospital','مستشفى اختبار القبول',$4,'care_institution','hospital')`, [org, `r1-acc-pda-${org.slice(0, 8)}`, ben, `r1-acc-hosp-${ben.slice(0, 8)}`]);
    // The material reviewer MUST be an active super_admin with a home pharmacy department and the explicit key (R1a_06 material_reviewer_org): the checker is that person; the maker is an ordinary warehouse manager.
    const up = await exec.query(`UPDATE public.profiles SET role = CASE WHEN id = $3::uuid THEN 'super_admin' ELSE 'central_warehouse_manager' END, status = 'active', organization_id = $1 WHERE id = ANY($2::uuid[])`, [org, [m.id, c.id], c.id]);
    if (up.rowCount !== 2) throw new Error(`expected 2 profiles to be assigned, got ${up.rowCount}`);
    await exec.query(`INSERT INTO public.profile_permission_overrides (profile_id, permission_key, allowed) SELECT $1, k, true FROM unnest($2::text[]) k`, [m.id, PROVISION_KEYS.maker]);
    await exec.query(`INSERT INTO public.profile_permission_overrides (profile_id, permission_key, allowed) SELECT $1, k, true FROM unnest($2::text[]) k`, [c.id, PROVISION_KEYS.checker]);
    await exec.query(`INSERT INTO public.central_items (name, name_ar, unit, status) SELECT n, ar, 'box', 'active' FROM unnest($1::text[], $2::text[]) AS t(n, ar)`, [PROVISION_ITEMS.map((x) => x[0]), PROVISION_ITEMS.map((x) => x[1])]);
    const chk = (await exec.query(`SELECT (SELECT count(*)::int FROM public.organizations) AS orgs, (SELECT count(*)::int FROM public.profile_permission_overrides) AS overrides,
        (SELECT count(*)::int FROM phoenix_private.central_needs_capability_breaches_v1()) AS breaches, phoenix_cn_policy.excel_read_restriction_state($1::uuid) AS state`, [org])).rows[0];
    if (chk.orgs !== 2 || chk.overrides !== PROVISION_KEYS.maker.length + PROVISION_KEYS.checker.length || chk.breaches !== 0 || chk.state === 'active') throw new Error(`post-check failed (${JSON.stringify(chk)})`);
    await exec.query('COMMIT');
  } catch (e) {
    try { await exec.query('ROLLBACK').catch(() => undefined); await ev(step, 'FAILED', { error: String(e.message).slice(0, 500) }); } catch { /* ambiguous tail */ }
    throw new AdapterStop('STOP-APPLY', `${step}: ${e.message}`);
  }
  await ev(step, 'APPLIED', { action: 'APPLIED isolated test organization + maker/checker + minimal keys (no activation)', attestation: `${a.authorizedBy}@${a.authorizedOn}#org:${org.slice(0, 8)}` });
  return { mode: 'provision-org', executed: 1, organizationId: org, beneficiaryOrganizationId: ben, keys: PROVISION_KEYS.maker.length + PROVISION_KEYS.checker.length, items: PROVISION_ITEMS.length };
}

// ---------- the runner ----------
/**
 * @param {PgExecutor|HostedExecutor} exec
 * @param {{ freeze: any[], migrationsDir: string, mode?: 'dry-run'|'apply'|'recovery-plan'|'resume', skip004?: boolean, upTo?: number, authorization?: any, recovery?: any,
 *           p5?: any, evidenceSha256?: string, bootstrap?: any, testHook?: Function, testBreakStep?: string, tamper?: Record<string, Function>, expectedMajor?: number,
 *           expectedIdentity?: any, log?: Function }} o
 */
export async function runBaseline(exec, o) {
  const mode = o.mode ?? 'dry-run';
  const id = exec.identity();
  const target = assertTarget(id);
  const plan = planBaseline(o);                                    // STOP-SOURCE for every file, before anything else
  if (mode === 'dry-run') return { mode, plan, rollbackReview: rollbackReview(), executed: 0 };
  // ----- everything below needs a live connection: IDENTITY is verified before any hosted execution can even be considered -----
  if (!target.disposable) {
    if (exec.descriptor) parseConnectionDescriptor(exec.descriptor.url, { ref: id.ref });
    else throw new AdapterStop('STOP-IDENTITY', 'a hosted target needs a validated connection descriptor');
    await verifyConnectionIdentity(exec, { systemIdentifier: PINNED.stagingSystemIdentifier, pgVersionPrefix: PINNED.stagingPgPrefix });   // pinned: nothing the caller passes can change the expected cluster
    // HOSTED_APPLY_ENABLED stays false as the library default: a hosted APPLY starts only with the exact confirmation string (the CLI's --confirm), never implicitly.
    if (mode === 'apply' && o.hostedApplyConfirmation !== HOSTED_CONFIRMATION) throw new AdapterStop('STOP-PHASE-P', 'hosted apply needs the exact confirmation for the pinned Staging cluster; refused');
    if (mode === 'apply-r1b' && o.hostedApplyConfirmation !== HOSTED_CONFIRMATION_S3A) throw new AdapterStop('STOP-PHASE-P', 'hosted S3a apply needs its own exact confirmation for the pinned Staging cluster; refused');
    if (mode === 'activate-org' && o.hostedApplyConfirmation !== hostedConfirmationS3B(String(o.organizationId))) throw new AdapterStop('STOP-PHASE-P', 'hosted S3b activation needs its own exact confirmation naming the organization; refused');
    if (mode === 'provision-org' && o.hostedApplyConfirmation !== hostedConfirmationS3P(String(o.organizationId))) throw new AdapterStop('STOP-PHASE-P', 'hosted S3p provisioning needs its own exact confirmation naming the organization; refused');
    if (mode === 'apply-candidates' && o.hostedApplyConfirmation !== HOSTED_CONFIRMATION_S2) throw new AdapterStop('STOP-PHASE-P', 'hosted S2 apply needs its own exact confirmation for the pinned Staging cluster; refused');
  }
  else await verifyDisposableIdentity(exec);                       // F1: the live database must prove it is local and not Supabase-shaped BEFORE any read-for-decision or write
  if (mode === 'resume') throw new AdapterStop('STOP-RECOVERY', 'resume is disabled: a stopped run is never continued; use recovery-plan and obtain an Owner/Director decision (reset or forward-fix)');
  if (mode === 'recovery-plan') {
    const analysis = analyzeLedger(await readLedger(exec), { ...o, expectedTargetRef: id.ref });
    return { mode, analysis, executed: 0 };
  }
  if (mode === 'apply-candidates') return applyCandidates(exec, o, id, target);
  if (mode === 'apply-r1b') return applyR1b(exec, o, id, target);
  if (mode === 'activate-org') return activateOrg(exec, o, id, target);
  if (mode === 'provision-org') return provisionOrg(exec, o, id, target);
  const a = o.authorization;
  const validAuth = a && a.phase === 'S1' && a.scope === 'baseline-M001-M221' && a.projectRef === id.ref && a.authorizedBy && /^\d{4}-\d{2}-\d{2}/.test(a.authorizedOn ?? '');
  if (!validAuth) throw new AdapterStop('STOP-AUTH', 'no valid S1 authorization bound to this target');
  if (target.disposable && !String(a.authorizedBy).startsWith('TEST-ONLY')) throw new AdapterStop('STOP-AUTH', 'a disposable target accepts only a TEST-ONLY authorization');
  if (!target.disposable && String(a.authorizedBy).startsWith('TEST-ONLY')) throw new AdapterStop('STOP-AUTH', 'a TEST-ONLY authorization is never valid on a hosted target');

  const ledgerRows = await readLedger(exec);
  if (mode !== 'apply') throw new AdapterStop('STOP-AUTH', `unknown mode ${mode}`);
  if (ledgerRows.length) throw new AdapterStop('STOP-PARTIAL', `a previous run left ${ledgerRows.length} ledger rows; there is NO resume - run mode 'recovery-plan' and obtain an Owner/Director decision (reset or forward-fix)`);
  await preflight(exec, { expectedMajor: o.expectedMajor });
  const aux = bindAux(o);                                          // F3: the exact verified bytes below are the ones executed
  const bound = bindSources(o);
  const boot = await assertPreWriteInputs(exec, o, id, target, bound);   // P-HARDEN-01C: every mandatory input is proven before the first write
  await exec.query(LEDGER_SQL);

  const applied = [];
  const ev = (step, status, extra = {}) => exec.query(
    `INSERT INTO phoenix_staging_ledger.baseline_steps (step, status, action, original_sha256, applied_sha256, byte_form, derivation, attestation_ref, error, target_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [step, status, extra.action ?? null, extra.original ?? null, extra.applied ?? null, extra.form ?? null, extra.derivation ?? null, extra.attestation ?? null, extra.error ?? null, id.ref]);
  // A file that fails inside its own BEGIN leaves the session in an aborted transaction; roll it back first or the FAILED event itself cannot be written (tail would stay STARTED = ambiguous).
  const failStep = async (step, e) => { try { await exec.query('ROLLBACK').catch(() => undefined); await ev(step, 'FAILED', { error: String(e.message).slice(0, 500) }); } catch { /* the ledger write itself failed: the tail stays STARTED = ambiguous */ } };
  const applyAclAlignment = async () => {
    await ev(ACL_ALIGN_STEP, 'STARTED');
    try {
      for (const stmt of ACL_ALIGN_STATEMENTS) await exec.query(stmt);
      const after = (await exec.query(DEFAULT_ACL_SQL)).rows;
      const bad = after.filter((x) => x.g === 'anon' || (x.g === 'authenticated' && x.t === 'f') || x.g === 'PUBLIC');
      if (bad.length) throw new Error(`default ACL still grants: ${bad.map((x) => `${x.g}/${x.t}`).join(', ')}`);
    } catch (e) { await failStep(ACL_ALIGN_STEP, e); throw new AdapterStop('STOP-APPLY', `${ACL_ALIGN_STEP}: ${e.message}`); }
    await ev(ACL_ALIGN_STEP, 'APPLIED', { action: 'APPLIED A-ACL-1 (role postgres, schema public only)', applied: ACL_ALIGN_HASH });
  };

  const applyOverlay = async () => {
    const ov = aux.overlay182b;
    await ev('182b overlay', 'STARTED');
    try { await exec.query(ov); } catch (e) { await failStep('182b overlay', e); throw new AdapterStop('STOP-APPLY', `182b overlay: ${e.message}`); }
    await ev('182b overlay', 'APPLIED', { action: 'APPLIED hash-pinned overlay', applied: sha256(Buffer.from(ov, 'utf8')) });
  };
  for (const p of bound) {
    const f = p.file;
    if (o.testHook && target.disposable) await o.testHook(f, exec);          // negative-control hook: disposable targets only
    if (f.startsWith('001_')) await applyAclAlignment();                      // A-ACL-1: after the pre-write proofs, before the first frozen file
    if (f.startsWith('004_') && o.skip004 !== false) { await ev(f, 'SKIPPED', { action: 'NOT_APPLIED (B2)', original: p.frozenSha }); continue; }
    if (f.startsWith('062_')) {
      const n = (await exec.query(`SELECT count(*)::int AS n FROM public.profiles p JOIN auth.users u ON u.id = p.id WHERE p.role = 'super_admin' AND p.status = 'active'`)).rows[0].n;
      if (n < 1) throw new AdapterStop('STOP-BOOTSTRAP', 'no active super_admin profile linked to an Auth user exists before M062 (B5 is owner-provided; the adapter never creates users)');
    }
    let text = p.bytes.toString('utf8'); let derivation = null; let attestation = null;
    if (f.startsWith('023_')) { text = derive023(text); derivation = '023-verify-read'; }
    if (f.startsWith('085_')) {
      const rows = (await exec.query(aux.verify085)).rows;
      const failing = rows.filter((r) => !r.ok);
      if (failing.length) throw new AdapterStop('STOP-P4', `M085 preconditions not proven: ${failing.map((r) => r.check).join(' | ')}`, rows);
      const p5 = o.p5;
      const named = p5 && p5.ownerRef && /^\d{4}-\d{2}-\d{2}/.test(p5.attestedOn ?? '') && p5.projectRef === id.ref && p5.evidenceSha256 && p5.evidenceSha256 === o.evidenceSha256;
      if (!named) throw new AdapterStop('STOP-P5', 'no named, dated attestation bound to this target and to the current evidence hash - HARD STOP (nothing is inferred)');
      if (String(p5.ownerRef).startsWith('TEST-ONLY') && !target.disposable) throw new AdapterStop('STOP-P5', 'a TEST-ONLY attestation is never valid on a hosted target');
      attestation = `${p5.ownerRef}@${p5.attestedOn}#${p5.evidenceSha256.slice(0, 12)}`;
    }
    await ev(f, 'STARTED');
    try {
      if (o.testBreakStep === f && target.disposable) await exec.query(o.testBreakInTxn ? 'BEGIN; SELECT 1/0' : 'SELECT 1/0');   // test seam (disposable only); InTxn = the file died inside its own BEGIN
      if (f.startsWith('085_')) {
        await exec.query(`SET phoenix.availability_cutover_attested = 'true'`);
        try { await exec.query(text); } finally { await exec.query(`RESET phoenix.availability_cutover_attested`); }
      } else await exec.query(text);
    } catch (e) { await failStep(f, e); throw new AdapterStop('STOP-APPLY', `${f}: ${e.message}`, { file: f }); }
    await ev(f, 'APPLIED', { action: derivation ? 'APPLIED derived' : 'APPLIED original bytes', original: p.frozenSha, applied: sha256(Buffer.from(text, 'utf8')), form: p.form, derivation, attestation });
    if (f.startsWith('001_')) {
      try { await assertSimilarityAvailable(exec); } catch (e) { await failStep('001_extension_gate', e); throw e; }
      await ev('bootstrap profile', 'STARTED');
      try {
        await exec.query('BEGIN');
        await exec.query(BOOTSTRAP_INSERT, [boot.authUserId]);
        const up = await exec.query(BOOTSTRAP_PROMOTE, [boot.authUserId]);
        const cnt = (await exec.query(`SELECT count(*)::int AS n FROM public.profiles`)).rows[0].n;
        if (up.rowCount !== 1 || cnt !== 1) throw new Error(`bootstrap must touch exactly one profile (updated=${up.rowCount}, profiles=${cnt})`);
        await exec.query('COMMIT');
      } catch (e) {
        await exec.query('ROLLBACK').catch(() => undefined);
        await failStep('bootstrap profile', e); throw new AdapterStop('STOP-BOOTSTRAP', `bootstrap profile: ${e.message}`);
      }
      await ev('bootstrap profile', 'APPLIED', { action: 'APPLIED Owner-attested Auth->Profile link (no Auth user created)', applied: BOOTSTRAP_HASH, attestation: `${o.bootstrap.ownerRef}@${o.bootstrap.attestedOn}#auth:${boot.authUserId.slice(0, 8)}` });
    }
    if (f.startsWith('182_')) await applyOverlay();
    o.log?.(`applied ${f}`); applied.push(f);
  }
  return { mode, plan, applied: applied.length, executed: applied.length };
}

// ---------- CLI: dry-run only; there is no path that opens a connection ----------
// Modes: (default) --dry-run: no connection. --recovery-plan: read-only ledger classification. --apply-hosted: S1 apply, needs --confirm <exact string>.
// Secrets come ONLY from the environment: PHOENIX_STAGING_DB_URL, PHOENIX_STAGING_DB_CA (path), PHOENIX_STAGING_DB_CA_SHA256. Nothing is printed except step counts and STOP codes.
export async function cliMain(arg, env, out = console) {
  const val = (flag) => { const i = arg.indexOf(flag); return i >= 0 ? arg[i + 1] : undefined; };
  if (arg.includes('--apply') || arg.includes('--resume')) { out.error('STOP-RECOVERY: --apply is not a mode and --resume is disabled; use --apply-hosted (S1) or --recovery-plan.'); return 2; }
  const dir = val('--migrations'); const frz = val('--freeze');
  if (!dir || !frz) { out.error('usage: node hosted-adapter.mjs [--dry-run | --recovery-plan | --apply-hosted --confirm <string> --authorization <f.json> --bootstrap <f.json> --p5 <f.json> --evidence-sha <hex>] --migrations <dir> --freeze <freeze.json>'); return 2; }
  const freeze = JSON.parse(readFileSync(frz, 'utf8'));
  const hosted = arg.includes('--apply-hosted'); const recovery = arg.includes('--recovery-plan'); const s2 = arg.includes('--apply-candidates'); const s3a = arg.includes('--apply-r1b'); const s3b = arg.includes('--activate-org'); const s3p = arg.includes('--provision-org'); const withR1b = s3a || s3b || s3p || arg.includes('--with-r1b'); const withC = s2 || withR1b || arg.includes('--with-candidates');
  if (!hosted && !recovery && !s2 && !s3a && !s3b && !s3p) {
    const dry = await runBaseline(new HostedExecutor(PINNED.stagingRef), { freeze, migrationsDir: dir, mode: 'dry-run' });
    out.log(JSON.stringify({ steps: dry.plan.length, first: dry.plan.slice(0, 3), rollbackReview: dry.rollbackReview }, null, 1));
    return 0;
  }
  let exec;
  try {
    if (s3a && val('--confirm') !== HOSTED_CONFIRMATION_S3A) throw new AdapterStop('STOP-PHASE-P', 'the exact S3a --confirm string for the pinned Staging cluster is required; refused before any connection');
    if (s3b && val('--confirm') !== hostedConfirmationS3B(String(val('--activate-org')))) throw new AdapterStop('STOP-PHASE-P', 'the exact S3b --confirm string naming the organization is required; refused before any connection');
    if (s3p && val('--confirm') !== hostedConfirmationS3P(String(val('--provision-org')))) throw new AdapterStop('STOP-PHASE-P', 'the exact S3p --confirm string naming the organization is required; refused before any connection');
    if (s2 && val('--confirm') !== HOSTED_CONFIRMATION_S2) throw new AdapterStop('STOP-PHASE-P', 'the exact S2 --confirm string for the pinned Staging cluster is required; refused before any connection');
    if (s2 && !val('--candidates-dir')) throw new AdapterStop('STOP-SOURCE', '--candidates-dir <dir> is required');
    if (hosted && val('--confirm') !== HOSTED_CONFIRMATION) throw new AdapterStop('STOP-PHASE-P', 'the exact --confirm string for the pinned Staging cluster is required; refused before any connection');
    if ((s3a || s3b || s3p || withC) && !val('--candidates-dir')) throw new AdapterStop('STOP-SOURCE', '--candidates-dir <dir> is required');
    const read = (flag) => { const f = val(flag); if (!f) throw new AdapterStop('STOP-AUTH', `${flag} <file.json> is required`); return JSON.parse(readFileSync(f, 'utf8')); };
    const inputs = (s2 || s3a || s3b || s3p) ? { authorization: read('--authorization') } : hosted ? { authorization: read('--authorization'), bootstrap: read('--bootstrap'), p5: read('--p5'), evidenceSha256: val('--evidence-sha') } : {};
    if (hosted && !inputs.evidenceSha256) throw new AdapterStop('STOP-P5', '--evidence-sha is required');
    for (const k of ['PHOENIX_STAGING_DB_URL', 'PHOENIX_STAGING_DB_CA', 'PHOENIX_STAGING_DB_CA_SHA256']) if (!env[k]) throw new AdapterStop('STOP-IDENTITY', `environment variable ${k} is not set`);
    exec = await HostedExecutor.connect({ url: env.PHOENIX_STAGING_DB_URL, caPath: env.PHOENIX_STAGING_DB_CA, caSha256: env.PHOENIX_STAGING_DB_CA_SHA256 });
    const res = await runBaseline(exec, { freeze, migrationsDir: dir, mode: s3p ? 'provision-org' : s3b ? 'activate-org' : s3a ? 'apply-r1b' : s2 ? 'apply-candidates' : hosted ? 'apply' : 'recovery-plan', ...inputs, candidates: withC, r1b: withR1b, organizationId: s3p ? val('--provision-org') : s3b ? val('--activate-org') : undefined, candidatesDir: val('--candidates-dir'), hostedApplyConfirmation: (hosted || s2 || s3a || s3b || s3p) ? val('--confirm') : undefined, log: (m) => out.log(m) });
    out.log(JSON.stringify((s2 || s3a) ? { applied: res.applied, executed: res.executed, aclSnapshotSha256: res.aclSnapshotSha256 } : hosted ? { applied: res.applied, executed: res.executed } : res.analysis));
    return 0;
  } catch (e) {
    out.error(`${e.code ?? 'ERROR'}: ${redactSecret(e.message, env.PHOENIX_STAGING_DB_URL)}`);
    return 1;
  } finally { await exec?.close(); }
}
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) process.exit(await cliMain(process.argv.slice(2), process.env));
