#!/usr/bin/env node
// ===========================================================================
// PINNED PRODUCTION MIGRATION EXECUTOR — preflight (READ-ONLY).
//
// Gathers the three sources of truth — the operator's pinned inputs, this
// checkout's supabase/migrations directory, and Production's applied
// supabase_migrations.schema_migrations — and hands them to the pure contract
// in production-migration-contract.mjs. It makes no decision itself and it
// NEVER writes to Production.
//
// Emits `decision=APPLY|ALREADY_APPLIED` to $GITHUB_OUTPUT so the workflow can
// gate its apply step on a value this script produced from measured reality
// rather than from an operator's claim.
//
// Usage (every variable is required):
//   PHOENIX_PRODUCTION_DATABASE_URL=...   \
//   PHOENIX_BRANCH=master                 \
//   PHOENIX_HEAD_SHA=<40 hex>             \
//   PHOENIX_CONFIRM_SHA=<40 hex>          \
//   PHOENIX_CONFIRMATION=APPLY_PRODUCTION_MIGRATION \
//   PHOENIX_MIGRATION_FILENAME=196_....sql \
//   PHOENIX_MIGRATION_SHA256=<64 hex>     \
//   PHOENIX_EXPECTED_CURRENT_CEILING=195  \
//   PHOENIX_EXPECTED_NEXT_CEILING=196     \
//     node tools/phoenix-demo/production-migration-preflight.mjs
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

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

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

async function readRemoteVersions(connectionString) {
  const io = await buildRemoteIo({ connectionString });
  try {
    let versions;
    await io.asAdmin(async (c) => {
      const r = await c.query(
        `SELECT version::int v FROM supabase_migrations.schema_migrations ORDER BY version::int`);
      versions = r.rows.map((row) => row.v);
    });
    return versions;
  } finally {
    await io.end();
  }
}

async function main() {
  const connectionString = process.env.PHOENIX_PRODUCTION_DATABASE_URL;
  // Proves we are addressing the one pinned project before we connect at all.
  assertProjectRefPinned(connectionString, PINNED_PROJECT_REF);

  const localMigrations = readLocalMigrations();
  const remoteVersions = await readRemoteVersions(connectionString);

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
    remoteVersions,
  });

  console.log(
    `Preflight PASS: local ceiling ${outcome.localCeiling}, Production ceiling ${outcome.remoteCeiling}, ` +
      `pending [${outcome.pendingVersions.join(', ')}], decision ${outcome.decision} for migration ` +
      `${process.env.PHOENIX_MIGRATION_FILENAME}.`,
  );

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `decision=${outcome.decision}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `target_version=${outcome.targetVersion}\n`);
  }
}

main().catch((e) => {
  // remote-io.mjs already redacts the connection string out of connection
  // errors, and nothing in this file interpolates it into a message.
  console.error(`::error::${e?.code ? `[${e.code}] ` : ''}${e?.message ?? e}`);
  process.exitCode = 1;
});
