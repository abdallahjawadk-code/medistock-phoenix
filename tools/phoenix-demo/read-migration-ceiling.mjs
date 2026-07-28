#!/usr/bin/env node
// ===========================================================================
// READ-ONLY. Reads Production's currently applied migration history from
// supabase_migrations.schema_migrations and reports the highest applied
// version, WITHOUT asserting what that value should be — the caller (the
// deploy-admin-user-lifecycle workflow) branches its own next step on the
// result, so this script must never hardcode an expected ceiling.
//
// Fails closed (non-zero exit, no output written) if the history itself is
// unsound: empty, non-contiguous (a gap below the highest applied version),
// or duplicated. A deploy workflow must never build a decision on top of an
// already-inconsistent migration history.
//
// Writes `ceiling=<n>` to $GITHUB_OUTPUT when running inside GitHub Actions
// (silently skipped otherwise, so this remains a normal CLI tool too).
//
// Usage:
//   PHOENIX_PRODUCTION_DATABASE_URL=... node tools/phoenix-demo/read-migration-ceiling.mjs
// ===========================================================================
import { appendFileSync } from 'node:fs';
import { buildRemoteIo } from '../pg-rig/remote-io.mjs';

async function main() {
  const io = await buildRemoteIo({ connectionString: process.env.PHOENIX_PRODUCTION_DATABASE_URL });
  let versions;
  try {
    await io.asAdmin(async (c) => {
      const r = await c.query(
        `SELECT version::int v FROM supabase_migrations.schema_migrations ORDER BY version::int`);
      versions = r.rows.map((row) => row.v);
    });
  } finally {
    await io.end();
  }

  if (!versions || versions.length === 0) {
    throw new Error('No applied migrations found in Production at all — refusing to branch on an empty history.');
  }
  for (let i = 1; i < versions.length; i++) {
    if (versions[i] <= versions[i - 1]) {
      throw new Error(
        `Migration history is not strictly increasing at index ${i} (${versions[i - 1]} -> ${versions[i]}) — refusing to branch on an inconsistent history.`,
      );
    }
  }
  const seen = new Set(versions);
  const highest = versions[versions.length - 1];
  const gaps = [];
  for (let n = 1; n <= highest; n++) if (!seen.has(n)) gaps.push(n);
  if (gaps.length > 0) {
    throw new Error(`Migration history has gaps below its own highest applied version: ${gaps.join(', ')} — refusing to branch on a non-contiguous history.`);
  }

  console.log(`Production migration history: ${versions.length} applied, highest = ${highest}.`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `ceiling=${highest}\n`);
  }
}

main().catch((e) => {
  // e.message is already redacted by remote-io.mjs for connection errors;
  // nothing else here ever interpolates the connection string.
  console.error(`::error::${e?.message ?? e}`);
  process.exitCode = 1;
});
