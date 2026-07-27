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

async function main() {
  const ceiling = parseInt(process.env.ACCEPTED_MIGRATION_CEILING, 10);
  if (!Number.isFinite(ceiling)) {
    throw new Error('ACCEPTED_MIGRATION_CEILING must be set to an integer');
  }

  const io = await buildRemoteIo({ connectionString: process.env.PHOENIX_PRODUCTION_DATABASE_URL });
  try {
    let versions;
    await io.asAdmin(async (c) => {
      const r = await c.query(
        `SELECT version::int v FROM supabase_migrations.schema_migrations ORDER BY version::int`);
      versions = r.rows.map((row) => row.v);
    });

    if (versions.length === 0) {
      throw new Error('No applied migrations found at all');
    }

    const highest = versions[versions.length - 1];
    if (highest !== ceiling) {
      throw new Error(`Migration history highest version is ${highest}, expected exactly ${ceiling}`);
    }

    for (let i = 1; i < versions.length; i++) {
      if (versions[i] <= versions[i - 1]) {
        throw new Error(`Migration history is not strictly increasing at index ${i} (${versions[i - 1]} -> ${versions[i]})`);
      }
    }

    console.log(`Migration history OK: ${versions.length} applied, highest = ${highest} (matches accepted ceiling ${ceiling}).`);
  } finally {
    await io.end();
  }
}

main().catch((e) => {
  console.error(`::error::${e?.message ?? e}`);
  process.exitCode = 1;
});
