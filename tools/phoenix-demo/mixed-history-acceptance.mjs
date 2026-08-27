#!/usr/bin/env node
// ===========================================================================
// MIXED-HISTORY / SHADOW-WORKSPACE ACCEPTANCE — disposable, TLS-only.
//
// This is the proof that the corrected Production executor actually works
// against Production's real history shape, run entirely against a THROWAWAY
// PostgreSQL created for the CI job. It never touches Production, and the
// direct history seeding it performs is legitimate here for exactly that
// reason — it would never be permissible against Production.
//
// What it proves, in order:
//   1. the connection is genuinely TLS (asked of the server, not assumed);
//   2. the seeded history reproduces Production's shape: 172 three-digit rows
//      then 24 timestamp rows, 196 total;
//   3. the reconciler derives canonical ceiling 196 and pending [197];
//   4. the CLI, pointed at the shadow workspace, reports EXACTLY ONE pending
//      migration — the target alias — with NO --debug;
//   5. the same run WITH --debug agrees, proving the pinned binary does not
//      carry the 2.101.0-2.109.1 debug/TLS defect;
//   6. a REAL push applies exactly that one migration;
//   7. history grows by exactly one row, with the exact expected version/name;
//   8. a second dry-run reports nothing pending;
//   9. the reconciler then reports the resume-safe state.
//
// PRECONDITION: ACCEPTANCE_DB_URL must already carry the canonical chain
// 001->196. Migration 197 GRANTs/REVOKEs EXECUTE on named functions with no
// IF EXISTS guard, so pushing it at an empty database aborts on the first
// missing function. Stage 2 below proves that precondition rather than
// assuming it.
//
// Usage:
//   ACCEPTANCE_DB_URL=postgresql://user:pw@host:port/db?sslmode=require \
//   ACCEPTANCE_CLI_VERSION=2.115.0 \
//     node tools/phoenix-demo/mixed-history-acceptance.mjs
// ===========================================================================
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { reconcileMigrationHistory } from './production-migration-history.mjs';
import { buildShadowMigrationWorkspace, parseDryRunPending } from './build-shadow-migration-workspace.mjs';

const DB_URL = process.env.ACCEPTANCE_DB_URL;
const EXPECTED_CLI = process.env.ACCEPTANCE_CLI_VERSION ?? '2.115.0';
const REPO_ROOT = process.cwd();
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');

const NUMERIC_ERA = 172;
const TIMESTAMP_ERA = 24;
const TARGET_REMOTE_VERSION = '20260823181015';

// ---------------------------------------------------------------------------
// PRODUCTION'S REAL TIMESTAMP-ERA SHAPE.
//
// Versions and names below are the shape live Production actually carries, not
// a generated approximation. The earlier fixture wrote the full canonical stem
// for all 24 rows, which made the acceptance agree with the code by
// construction and let a real defect through: executor run 32667193982 refused
// against Production on canonical 173, whose recorded name has NO `173_`
// prefix, while this acceptance was green.
//
// 23 of the 24 rows DO carry the prefix. 173 is the single exception, and it is
// written out literally rather than derived from expectedRemoteName() -- a
// fixture that asks the code under test what to expect proves nothing.
// ---------------------------------------------------------------------------
const REAL_REMOTE_VERSIONS = new Map([
  [173, '20260810200846'],
  [174, '20260810220715'],
  [196, '20260823131150'],
]);
const REAL_REMOTE_NAMES = new Map([
  [173, 'phoenix_database_security_surface_hardening'],
]);

/** 175..195 are stepped 12h from 2026-08-11, strictly between 174 and 196. */
const remoteVersionFor = (canonical) => REAL_REMOTE_VERSIONS.get(canonical)
  ?? new Date(Date.UTC(2026, 7, 11, 0, 0, 0) + (canonical - 175) * 43_200_000)
    .toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

const remoteNameFor = (canonical, filename) => REAL_REMOTE_NAMES.get(canonical)
  ?? filename.replace(/\.sql$/, '');

const fail = (m) => { throw new Error(m); };
const ok = (m) => console.log(`  PASS  ${m}`);

const localManifest = () => readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .map((filename) => {
    const m = /^(\d{3})_/.exec(filename);
    return m ? { version: parseInt(m[1], 10), filename } : null;
  })
  .filter(Boolean)
  .sort((a, b) => a.version - b.version);

let client = null;
const connect = async () => {
  client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  return client;
};

const readHistory = async (c) => (await c.query(
  `SELECT version::text AS version, name::text AS name
     FROM supabase_migrations.schema_migrations ORDER BY version::text`)).rows;

/** A pending-set mismatch is unreadable without the bytes it was derived from. */
const showTranscript = (t) => `
--- CLI transcript ---
${t}
--- end CLI transcript ---`;

// The Supabase CLI writes its human-readable output -- the pending migration
// list, and "Remote database is up to date." -- to STDERR, not stdout. The
// Production executor already accounts for that: every db-push line in
// apply-production-migration.yml is `... 2>&1 | tee <transcript>`. Capturing
// stdout alone here produced an EMPTY transcript, so parseDryRunPending() saw
// zero pending and this acceptance could never pass. Both streams are merged so
// the acceptance parses exactly the bytes the executor parses.
function cli(args, { debug = false } = {}) {
  const argv = debug ? [...args, '--debug'] : args;
  const run = spawnSync('supabase', argv, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
  const transcript = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.error) fail(`supabase ${argv.join(' ')} could not be started: ${run.error.message}`);
  if (run.status !== 0) fail(`supabase ${argv.join(' ')} exited ${run.status}.${showTranscript(transcript)}`);
  return transcript;
}

// `supabase --version` prints the version alone on STDOUT, but the CLI's own
// update checker writes a two-line upgrade advisory to STDERR whenever a newer
// release exists upstream. cli() merges both streams -- deliberately, and that
// merge must stay, because the db-push transcript parsing below depends on it.
// The consequence is that the merged --version transcript stopped being a bare
// version string the moment v2.116.0 shipped upstream, and a whole-string
// equality against it began failing while the installed executable was still
// exactly 2.115.0 and the pin was genuinely satisfied.
//
// So read the version OUT of the transcript instead, with a FULL-LINE anchored
// match. The advisory lines are prose and never consist solely of a version, so
// they cannot match, and the first match is always stdout's own report because
// cli() concatenates stdout before stderr. This is deliberately NOT a substring
// or `includes()` test: an advisory naming the expected version while a
// DIFFERENT binary is installed would then pass, which is strictly worse than
// the bug it replaces. No match at all is a hard failure -- an unreadable
// version is never a pass.
function installedCliVersion(transcript) {
  const m = transcript.match(/^[ \t]*v?(\d+\.\d+\.\d+)[ \t]*$/m);
  return m ? m[1] : null;
}

async function main() {
  if (!DB_URL) fail('ACCEPTANCE_DB_URL is required.');
  const local = localManifest();
  if (local.length < NUMERIC_ERA + TIMESTAMP_ERA + 1) {
    fail(`This checkout has only ${local.length} migrations; the acceptance shape needs at least ${NUMERIC_ERA + TIMESTAMP_ERA + 1}.`);
  }

  console.log('== 0. pinned CLI ==');
  const versionTranscript = cli(['--version']);
  const version = installedCliVersion(versionTranscript);
  if (version === null) fail(`could not determine the installed Supabase CLI version.${showTranscript(versionTranscript)}`);
  if (version !== EXPECTED_CLI) fail(`Supabase CLI is ${version}, expected exactly ${EXPECTED_CLI}.`);
  ok(`Supabase CLI ${version}`);

  const c = await connect();

  console.log('== 1. the connection is genuinely TLS ==');
  const sslOn = (await c.query('SHOW ssl')).rows[0].ssl;
  if (sslOn !== 'on') fail(`server reports ssl=${sslOn}, expected on.`);
  const mySsl = (await c.query('SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0];
  if (!mySsl || mySsl.ssl !== true) fail('this session is not using SSL — the acceptance must run over TLS.');
  ok(`server ssl=on and this session is TLS (${mySsl.version})`);

  console.log('== 1b. the acceptance database really carries the 001->196 chain ==');
  // Without this the failure would surface deep inside `supabase db push` as an
  // opaque SQL error. 197 touches these by name, so their absence is decisive.
  const need = ['public.phoenix_my_org()', 'public.phoenix_my_role()', 'public.phoenix_handle_new_user()'];
  for (const sig of need) {
    const { rows: r } = await c.query('SELECT to_regprocedure($1) IS NOT NULL AS ok', [sig]);
    if (!r[0].ok) fail(`${sig} is missing — the acceptance database has not received migrations 001->196.`);
  }
  ok(`canonical chain present (${need.length} of 197's target functions resolve)`);

  console.log('== 2. seed Production\'s history shape (disposable database only) ==');
  await c.query('CREATE SCHEMA IF NOT EXISTS supabase_migrations');
  await c.query('DROP TABLE IF EXISTS supabase_migrations.schema_migrations');
  await c.query('CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, name text, statements text[])');
  for (let i = 1; i <= NUMERIC_ERA; i++) {
    await c.query('INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES($1,$2)',
      [String(i).padStart(3, '0'), `legacy_${i}`]);
  }
  let unprefixedSeeded = 0;
  let previousVersion = '';
  for (let k = 0; k < TIMESTAMP_ERA; k++) {
    const canonical = NUMERIC_ERA + k + 1;
    const { filename } = local.find((m) => m.version === canonical);
    const version14 = remoteVersionFor(canonical);
    const name = remoteNameFor(canonical, filename);
    if (version14 <= previousVersion) fail(`fixture versions are not strictly increasing at canonical ${canonical} (${version14}).`);
    previousVersion = version14;
    if (!name.startsWith(`${String(canonical).padStart(3, '0')}_`)) unprefixedSeeded += 1;
    await c.query('INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES($1,$2)', [version14, name]);
  }
  // The fixture is only worth running if it really carries the mixed shape.
  if (unprefixedSeeded !== 1) {
    fail(`fixture seeded ${unprefixedSeeded} unprefixed timestamp names, expected exactly 1 (canonical 173).`);
  }
  let rows = await readHistory(c);
  if (rows.length !== NUMERIC_ERA + TIMESTAMP_ERA) fail(`seeded ${rows.length} rows, expected ${NUMERIC_ERA + TIMESTAMP_ERA}.`);
  ok(`${rows.length} rows seeded (${NUMERIC_ERA} three-digit + ${TIMESTAMP_ERA} timestamp, 23 prefixed + 1 historical unprefixed)`);

  console.log('== 3. PROOF A — canonical reconciliation ==');
  const targetCanonical = NUMERIC_ERA + TIMESTAMP_ERA + 1;
  let rec = reconcileMigrationHistory(rows, local.filter((m) => m.version <= targetCanonical));
  if (rec.canonicalCeiling !== NUMERIC_ERA + TIMESTAMP_ERA) fail(`canonical ceiling ${rec.canonicalCeiling}, expected ${NUMERIC_ERA + TIMESTAMP_ERA}.`);
  if (rec.pendingCanonical.length !== 1 || rec.pendingCanonical[0] !== targetCanonical) {
    fail(`canonical pending [${rec.pendingCanonical.join(', ')}], expected [${targetCanonical}].`);
  }
  ok(`canonical ceiling ${rec.canonicalCeiling}, pending [${targetCanonical}]`);

  const targetLocal = local.find((m) => m.version === targetCanonical);
  const shadow = buildShadowMigrationWorkspace({
    migrationsDir: MIGRATIONS_DIR, mapping: rec.mapping,
    localMigrations: local.filter((m) => m.version <= targetCanonical), repoRoot: REPO_ROOT,
    target: { canonicalVersion: targetCanonical, filename: targetLocal.filename, remoteHistoryVersion: TARGET_REMOTE_VERSION },
  });
  ok(`shadow workspace: ${shadow.totalMigrations} migrations, target ${shadow.targetAliasFilename}`);

  const pushArgs = ['db', 'push', '--yes', '--db-url', DB_URL, '--workdir', shadow.workspaceDir];

  console.log('== 4. PROOF B — CLI dry-run, NO --debug ==');
  const dry = cli([...pushArgs, '--dry-run']);
  const pending = parseDryRunPending(dry);
  if (pending.length !== 1) fail(`CLI reports ${pending.length} pending [${pending.join(', ')}], expected exactly 1.${showTranscript(dry)}`);
  if (pending[0] !== shadow.targetAliasFilename) fail(`CLI would push ${pending[0]}, expected ${shadow.targetAliasFilename}.${showTranscript(dry)}`);
  ok(`CLI pending = exactly [${pending[0]}]`);

  console.log('== 5. --debug regression: the pinned binary must agree ==');
  const dryDebug = cli([...pushArgs, '--dry-run'], { debug: true });
  const pendingDebug = parseDryRunPending(dryDebug);
  if (JSON.stringify(pendingDebug) !== JSON.stringify(pending)) {
    fail(`--debug pending set ${JSON.stringify(pendingDebug)} differs from no-debug ${JSON.stringify(pending)}.${showTranscript(dryDebug)}`);
  }
  ok('--debug and no-debug agree — the 2.101.0-2.109.1 TLS defect is absent');

  console.log('== 6. REAL push (disposable database) ==');
  cli(pushArgs);
  rows = await readHistory(c);
  if (rows.length !== NUMERIC_ERA + TIMESTAMP_ERA + 1) fail(`history has ${rows.length} rows after push, expected ${NUMERIC_ERA + TIMESTAMP_ERA + 1}.`);
  const added = rows.filter((r) => r.version === TARGET_REMOTE_VERSION);
  if (added.length !== 1) fail(`expected exactly one row with version ${TARGET_REMOTE_VERSION}, found ${added.length}.`);
  const expectedName = targetLocal.filename.replace(/\.sql$/, '');
  if (added[0].name !== expectedName) fail(`new row name ${JSON.stringify(added[0].name)}, expected ${JSON.stringify(expectedName)}.`);
  ok(`history 196 -> ${rows.length}; exactly one new row ${TARGET_REMOTE_VERSION} = ${expectedName}`);

  console.log('== 7. nothing pending afterwards ==');
  const dry2 = cli([...pushArgs, '--dry-run']);
  const pending2 = parseDryRunPending(dry2);
  if (pending2.length !== 0) fail(`CLI still reports ${pending2.length} pending [${pending2.join(', ')}], expected 0.${showTranscript(dry2)}`);
  ok('CLI reports nothing pending');

  console.log('== 8. resume-safe reconciliation ==');
  rec = reconcileMigrationHistory(rows, local.filter((m) => m.version <= targetCanonical));
  if (rec.canonicalCeiling !== targetCanonical) fail(`canonical ceiling ${rec.canonicalCeiling}, expected ${targetCanonical}.`);
  if (rec.pendingCanonical.length !== 0) fail(`pending [${rec.pendingCanonical.join(', ')}], expected empty.`);
  ok(`canonical ceiling ${rec.canonicalCeiling}, nothing pending — resume-safe`);

  await c.end();
  console.log('\nMIXED-HISTORY ACCEPTANCE: PASS');
}

main().catch(async (e) => {
  console.error(`::error::mixed-history acceptance FAILED: ${e?.message ?? e}`);
  // An open pg client keeps the Node event loop alive. Without this the script
  // printed its error and then sat idle until the job's 35-minute timeout
  // cancelled it, hiding a two-second failure behind a half-hour red run.
  try { await client?.end(); } catch { /* already closing */ }
  process.exit(1);
});
