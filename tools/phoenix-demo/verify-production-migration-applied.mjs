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
// Fails closed unless Production's history is, exactly:
//   - non-empty, strictly increasing, no duplicates
//   - contiguous 1..expected
//   - highest == expected next ceiling
//   - the target version present exactly once
//   - nothing beyond the target version
//
// Usage:
//   PHOENIX_PRODUCTION_DATABASE_URL=... PHOENIX_EXPECTED_NEXT_CEILING=196 \
//     node tools/phoenix-demo/verify-production-migration-applied.mjs
// ===========================================================================
import { buildRemoteIo } from '../pg-rig/remote-io.mjs';
import { PINNED_PROJECT_REF, assertProjectRefPinned } from './production-migration-contract.mjs';

async function main() {
  const connectionString = process.env.PHOENIX_PRODUCTION_DATABASE_URL;
  assertProjectRefPinned(connectionString, PINNED_PROJECT_REF);

  const expected = parseInt(String(process.env.PHOENIX_EXPECTED_NEXT_CEILING ?? '').trim(), 10);
  if (!Number.isInteger(expected) || expected < 1) {
    throw new Error('PHOENIX_EXPECTED_NEXT_CEILING must be a positive integer.');
  }

  const io = await buildRemoteIo({ connectionString });
  let rows;
  try {
    await io.asAdmin(async (c) => {
      const r = await c.query(
        `SELECT version::int v, count(*)::int n
           FROM supabase_migrations.schema_migrations
          GROUP BY version::int
          ORDER BY version::int`);
      rows = r.rows;
    });
  } finally {
    await io.end();
  }

  if (!rows || rows.length === 0) throw new Error('Production migration history is empty after the apply.');

  const duplicated = rows.filter((r) => r.n !== 1);
  if (duplicated.length > 0) {
    throw new Error(`Production migration history has duplicated version(s): ${duplicated.map((r) => `${r.v} x${r.n}`).join(', ')}.`);
  }

  const versions = rows.map((r) => r.v);
  for (let i = 1; i < versions.length; i++) {
    if (versions[i] <= versions[i - 1]) {
      throw new Error(`Production migration history is not strictly increasing at index ${i} (${versions[i - 1]} -> ${versions[i]}).`);
    }
  }

  const highest = versions[versions.length - 1];
  const seen = new Set(versions);
  const gaps = [];
  for (let n = 1; n <= highest; n++) if (!seen.has(n)) gaps.push(n);
  if (gaps.length > 0) throw new Error(`Production migration history has gaps below ${highest}: ${gaps.join(', ')}.`);

  if (highest !== expected) {
    throw new Error(`Production migration ceiling is ${highest} after the apply, expected exactly ${expected}.`);
  }
  if (!seen.has(expected)) {
    throw new Error(`Production migration history does not contain version ${expected} at all after the apply.`);
  }

  console.log(
    `Post-apply history verification PASS: ${versions.length} applied, contiguous 1..${highest}, ` +
      `version ${expected} recorded exactly once, nothing beyond it.`,
  );
}

main().catch((e) => {
  console.error(`::error::${e?.message ?? e}`);
  process.exitCode = 1;
});
