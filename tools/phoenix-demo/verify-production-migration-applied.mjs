#!/usr/bin/env node
// ===========================================================================
// PINNED PRODUCTION MIGRATION EXECUTOR — post-apply history verification
// (READ-ONLY).
//
// `supabase db push` runs each migration's SQL and then records the version in
// supabase_migrations.schema_migrations. Migrations in this repository open
// their OWN `BEGIN; ... COMMIT;`, so the SQL body and the history row are NOT
// provably one atomic unit from the outside — a body could commit while the
// history write did not, or vice versa. This verification therefore re-measures
// the history on a FRESH connection after the push instead of trusting the
// push's exit code.
//
// TWO NAMESPACES. Production's history is 172 three-digit versions followed by
// 14-digit Supabase CLI timestamps, so there is no `version::int` to read and
// MAX(version) is not the canonical ceiling. Both are proven here:
//
//   Supabase namespace — the exact expected remote row now exists, exactly once
//   Phoenix namespace  — reconciled canonical ceiling equals the pinned next
//
// Usage:
//   PHOENIX_PRODUCTION_DATABASE_URL=... \
//   PHOENIX_EXPECTED_NEXT_CEILING=197 \
//   PHOENIX_REMOTE_HISTORY_VERSION=20260823181015 \
//   PHOENIX_MIGRATION_FILENAME=197_phoenix_public_execute_convergence.sql \
//   PHOENIX_EXPECTED_REMOTE_ROW_COUNT=197 \
//     node tools/phoenix-demo/verify-production-migration-applied.mjs
// ===========================================================================
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildRemoteIo } from '../pg-rig/remote-io.mjs';
import { PINNED_PROJECT_REF, assertProjectRefPinned, parseMigrationVersion } from './production-migration-contract.mjs';
import { canonicalStem, reconcileMigrationHistory } from './production-migration-history.mjs';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

function localManifest() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((filename) => ({ version: parseMigrationVersion(filename), filename }))
    .filter((m) => m.version !== null)
    .sort((a, b) => a.version - b.version);
}

async function main() {
  const connectionString = process.env.PHOENIX_PRODUCTION_DATABASE_URL;
  assertProjectRefPinned(connectionString, PINNED_PROJECT_REF);

  const expected = parseInt(String(process.env.PHOENIX_EXPECTED_NEXT_CEILING ?? '').trim(), 10);
  if (!Number.isInteger(expected) || expected < 1) {
    throw new Error('PHOENIX_EXPECTED_NEXT_CEILING must be a positive integer.');
  }
  const expectedRemoteVersion = String(process.env.PHOENIX_REMOTE_HISTORY_VERSION ?? '').trim();
  if (!/^\d{14}$/.test(expectedRemoteVersion)) {
    throw new Error('PHOENIX_REMOTE_HISTORY_VERSION must be exactly 14 digits.');
  }
  const migrationFilename = String(process.env.PHOENIX_MIGRATION_FILENAME ?? '').trim();
  const expectedName = canonicalStem(migrationFilename);
  if (!expectedName) throw new Error('PHOENIX_MIGRATION_FILENAME is required.');

  const io = await buildRemoteIo({ connectionString });
  let rows;
  try {
    await io.asAdmin(async (c) => {
      const r = await c.query(
        `SELECT version::text AS version, name::text AS name
           FROM supabase_migrations.schema_migrations
          ORDER BY version::text`);
      rows = r.rows;
    });
  } finally {
    await io.end();
  }

  // ---- Supabase namespace: the exact row, exactly once --------------------
  const matches = rows.filter((r) => String(r.version) === expectedRemoteVersion);
  if (matches.length !== 1) {
    throw new Error(`Production history contains ${matches.length} rows with version ${expectedRemoteVersion}, expected exactly 1.`);
  }
  if (String(matches[0].name) !== expectedName) {
    throw new Error(`Production row ${expectedRemoteVersion} is named ${JSON.stringify(String(matches[0].name))}, expected ${JSON.stringify(expectedName)}.`);
  }

  const expectedRowCount = process.env.PHOENIX_EXPECTED_REMOTE_ROW_COUNT
    ? parseInt(process.env.PHOENIX_EXPECTED_REMOTE_ROW_COUNT, 10) : null;
  if (expectedRowCount !== null && rows.length !== expectedRowCount) {
    throw new Error(`Production history has ${rows.length} rows, expected exactly ${expectedRowCount}.`);
  }

  // ---- Phoenix namespace: reconciled canonical ceiling --------------------
  const reconciled = reconcileMigrationHistory(rows, localManifest());
  if (reconciled.canonicalCeiling !== expected) {
    throw new Error(`Reconciled Production canonical ceiling is ${reconciled.canonicalCeiling}, expected exactly ${expected}.`);
  }
  const target = reconciled.mapping.find((m) => m.remoteVersion === expectedRemoteVersion);
  if (!target || target.canonical !== expected) {
    throw new Error(`Remote row ${expectedRemoteVersion} reconciles to canonical ${target?.canonical ?? 'nothing'}, expected ${expected}.`);
  }
  if (reconciled.pendingCanonical.length !== 0) {
    throw new Error(`Canonical migrations still pending after the apply: [${reconciled.pendingCanonical.join(', ')}].`);
  }

  console.log(
    `Post-apply verification PASS: ${rows.length} remote rows ` +
      `(${reconciled.numericRowCount} three-digit + ${reconciled.timestampRowCount} timestamp), ` +
      `row ${expectedRemoteVersion} = ${expectedName} present exactly once, ` +
      `reconciled canonical ceiling ${reconciled.canonicalCeiling}, nothing pending.`,
  );
}

main().catch((e) => {
  console.error(`::error::${e?.message ?? e}`);
  process.exitCode = 1;
});
