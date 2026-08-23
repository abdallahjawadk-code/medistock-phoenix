#!/usr/bin/env node
// ===========================================================================
// PINNED PRODUCTION MIGRATION EXECUTOR — preflight (READ-ONLY).
//
// Gathers the three sources of truth — the operator's pinned inputs, this
// checkout's supabase/migrations directory, and Production's applied
// supabase_migrations.schema_migrations — reconciles the last of those into
// canonical numbering, and hands the result to the pure contract. It makes no
// decision itself and it NEVER writes to Production.
//
// TWO NAMESPACES, NOT ONE
// -----------------------
// Production's history is NOT this repository's canonical numbering. It holds
// 172 three-digit versions followed by 14-digit Supabase CLI timestamps. The
// previous version of this file ran `SELECT version::int`, which fails outright
// on a timestamp (`value "20260810200846" is out of range for type integer`)
// and would still have been wrong widened, because the single-pending proof
// depended on contiguous ordinals. Versions are now read as TEXT and
// reconciled by production-migration-history.mjs.
//
// It also builds the temporary shadow workspace the CLI will be pointed at, so
// that `supabase db push` sees Production's own version namespace rather than
// the canonical directory — where it would compute a pending set of every
// migration from 173 onward.
//
// Emits to $GITHUB_OUTPUT: decision, target_version, shadow_workspace,
// target_alias, remote_history_version.
// ===========================================================================
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { buildRemoteIo } from '../pg-rig/remote-io.mjs';
import {
  PINNED_PROJECT_REF,
  assertProjectRefPinned,
  declaresManualApplyOnly,
  decideProductionMigrationApply,
  parseMigrationVersion,
} from './production-migration-contract.mjs';
import {
  assertRemoteHistoryVersionUsable,
  reconcileMigrationHistory,
} from './production-migration-history.mjs';
import { buildShadowMigrationWorkspace } from './build-shadow-migration-workspace.mjs';

const REPO_ROOT = process.cwd();
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');

/** Every migration in this checkout, with its version and exact byte hash. */
function readLocalMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((filename) => {
      const version = parseMigrationVersion(filename);
      if (version === null) {
        throw new Error(
          `supabase/migrations contains ${JSON.stringify(filename)}, which is not a NNN_lower_snake_case.sql ` +
            'migration filename — refusing to reason about an unrecognized migration set.',
        );
      }
      const bytes = readFileSync(join(MIGRATIONS_DIR, filename));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      // Read from the migration's OWN bytes, so its stated apply policy travels
      // with the file rather than living in anyone's memory.
      const manualApplyOnly = declaresManualApplyOnly(bytes.toString('utf8'));
      return { version, filename, sha256, manualApplyOnly };
    })
    .sort((a, b) => a.version - b.version);
}

/**
 * Read applied history. version stays TEXT — never cast. `name` is read too,
 * because it is the second, order-independent proof of a timestamp row's
 * canonical identity.
 */
async function readRemoteHistory(connectionString) {
  const io = await buildRemoteIo({ connectionString });
  try {
    let rows;
    await io.asAdmin(async (c) => {
      const r = await c.query(
        `SELECT version::text AS version, name::text AS name
           FROM supabase_migrations.schema_migrations
          ORDER BY version::text`);
      rows = r.rows;
    });
    return rows;
  } finally {
    await io.end();
  }
}

async function main() {
  const connectionString = process.env.PHOENIX_PRODUCTION_DATABASE_URL;
  // Proves we are addressing the one pinned project before we connect at all.
  assertProjectRefPinned(connectionString, PINNED_PROJECT_REF);

  const localMigrations = readLocalMigrations();
  const remoteRows = await readRemoteHistory(connectionString);

  // ---- reconcile the two namespaces --------------------------------------
  const remoteCanonical = reconcileMigrationHistory(remoteRows, localMigrations);
  console.log(
    `History reconciled: ${remoteRows.length} remote rows ` +
      `(${remoteCanonical.numericRowCount} three-digit + ${remoteCanonical.timestampRowCount} timestamp) ` +
      `-> canonical ceiling ${remoteCanonical.canonicalCeiling}; ` +
      `era transition at ${remoteCanonical.transitionVersion ?? 'n/a'}.`,
  );

  // ---- PROOF A: the Phoenix canonical single-pending proof ----------------
  const outcome = decideProductionMigrationApply({
    branch: process.env.PHOENIX_BRANCH,
    headSha: process.env.PHOENIX_HEAD_SHA,
    confirmSha: process.env.PHOENIX_CONFIRM_SHA,
    confirmation: process.env.PHOENIX_CONFIRMATION,
    projectRef: PINNED_PROJECT_REF,
    expectedCurrentCeiling: process.env.PHOENIX_EXPECTED_CURRENT_CEILING,
    expectedNextCeiling: process.env.PHOENIX_EXPECTED_NEXT_CEILING,
    migrationFilename: process.env.PHOENIX_MIGRATION_FILENAME,
    migrationSha256: process.env.PHOENIX_MIGRATION_SHA256,
    localMigrations,
    remoteCanonical,
  });

  console.log(
    `Preflight PASS: local canonical ceiling ${outcome.localCeiling}, Production canonical ceiling ` +
      `${outcome.remoteCeiling}, canonical pending [${outcome.pendingVersions.join(', ')}], decision ` +
      `${outcome.decision} for ${process.env.PHOENIX_MIGRATION_FILENAME}.`,
  );

  // ---- the shadow workspace the CLI will actually be pointed at ------------
  // Built even on the resume-safe path, so the workflow can run its second
  // dry-run proof and confirm zero pending without special-casing.
  const remoteHistoryVersion = assertRemoteHistoryVersionUsable(
    process.env.PHOENIX_REMOTE_HISTORY_VERSION,
    outcome.decision === 'ALREADY_APPLIED'
      // On resume the target row already exists, so it must be excluded from
      // the "must be absent" check while still proving it is the newest.
      ? remoteRows.filter((r) => String(r.version) !== String(process.env.PHOENIX_REMOTE_HISTORY_VERSION))
      : remoteRows,
  );

  const shadow = buildShadowMigrationWorkspace({
    migrationsDir: MIGRATIONS_DIR,
    mapping: outcome.decision === 'ALREADY_APPLIED'
      ? remoteCanonical.mapping.filter((m) => m.canonical !== outcome.targetVersion)
      : remoteCanonical.mapping,
    localMigrations,
    repoRoot: REPO_ROOT,
    target: {
      canonicalVersion: outcome.targetVersion,
      filename: process.env.PHOENIX_MIGRATION_FILENAME,
      sha256: process.env.PHOENIX_MIGRATION_SHA256,
      remoteHistoryVersion,
    },
  });

  console.log(
    `Shadow workspace: ${shadow.aliasCount} applied aliases + 1 target = ${shadow.totalMigrations} migrations; ` +
      `target alias ${shadow.targetAliasFilename} (sha256 ${shadow.targetAliasSha256}).`,
  );

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `decision=${outcome.decision}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `target_version=${outcome.targetVersion}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `shadow_workspace=${shadow.workspaceDir}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `target_alias=${shadow.targetAliasFilename}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `remote_history_version=${remoteHistoryVersion}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `remote_row_count=${remoteRows.length}\n`);
  }
}

main().catch((e) => {
  // remote-io.mjs already redacts the connection string out of connection
  // errors, and nothing in this file interpolates it into a message.
  console.error(`::error::${e?.code ? `[${e.code}] ` : ''}${e?.message ?? e}`);
  process.exitCode = 1;
});
