#!/usr/bin/env node
// ===========================================================================
// Confirms Production's applied migration history reaches exactly the
// accepted ceiling, with no gaps and no duplicates -- run immediately after
// `supabase db push` in the migrate_and_seed workflow, before seeding.
//
// Usage:
//   PHOENIX_PRODUCTION_DATABASE_URL=... ACCEPTED_MIGRATION_CEILING=145 \
//     node tools/phoenix-demo/verify-migration-ceiling.mjs
// ===========================================================================
import { buildRemoteIo } from '../pg-rig/remote-io.mjs';

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { reconcileMigrationHistory } from './production-migration-history.mjs';

// Production's history is NOT this repository's canonical numbering: it holds
// three-digit versions followed by 14-digit Supabase CLI timestamps. Casting
// `version::int` fails outright on a timestamp, so versions are read as TEXT
// and the canonical ceiling is RECONCILED. See production-migration-history.mjs.
function localManifest() {
  return readdirSync(join(process.cwd(), 'supabase', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((filename) => {
      const m = /^(\d{3})_/.exec(filename);
      return m ? { version: parseInt(m[1], 10), filename } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.version - b.version);
}

async function readCanonicalHistory(io) {
  let rows;
  await io.asAdmin(async (c) => {
    const r = await c.query(
      `SELECT version::text AS version, name::text AS name
         FROM supabase_migrations.schema_migrations
        ORDER BY version::text`);
    rows = r.rows;
  });
  return reconcileMigrationHistory(rows, localManifest());
}


async function main() {
  const ceiling = parseInt(process.env.ACCEPTED_MIGRATION_CEILING, 10);
  if (!Number.isFinite(ceiling)) {
    throw new Error('ACCEPTED_MIGRATION_CEILING must be set to an integer');
  }

  const io = await buildRemoteIo({ connectionString: process.env.PHOENIX_PRODUCTION_DATABASE_URL });
  try {
    let reconciled;
    await io.asAdmin(async (c) => {
      reconciled = await readCanonicalHistory({ asAdmin: async (fn) => fn(c) });
    });

    const highest = reconciled.canonicalCeiling;
    if (highest !== ceiling) {
      throw new Error(`Reconciled canonical migration ceiling is ${highest}, expected exactly ${ceiling}`);
    }

    console.log(
      `Migration history OK: ${reconciled.appliedCanonical.length} applied ` +
        `(${reconciled.numericRowCount} three-digit + ${reconciled.timestampRowCount} timestamp), ` +
        `canonical ceiling = ${highest} (matches accepted ceiling ${ceiling}).`);
  } finally {
    await io.end();
  }
}

main().catch((e) => {
  console.error(`::error::${e?.message ?? e}`);
  process.exitCode = 1;
});
