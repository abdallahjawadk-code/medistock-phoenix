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
  const io = await buildRemoteIo({ connectionString: process.env.PHOENIX_PRODUCTION_DATABASE_URL });
  let reconciled;
  try {
    await io.asAdmin(async (c) => {
      reconciled = await readCanonicalHistory({ asAdmin: async (fn) => fn(c) });
    });
  } finally {
    await io.end();
  }

  // reconcileMigrationHistory has already refused an empty, duplicated,
  // gapped, mis-ordered or unmappable history. This re-asserts the one
  // property this script actually reports, at the boundary between the two
  // modules: a ceiling only means anything if every canonical version below
  // it is applied. A deploy workflow must never branch on a history with
  // gaps, so that stays checked here rather than assumed from upstream.
  const highest = reconciled.canonicalCeiling;
  const seen = new Set(reconciled.appliedCanonical);
  const gaps = [];
  for (let n = 1; n <= highest; n++) if (!seen.has(n)) gaps.push(n);
  if (gaps.length > 0) {
    throw new Error(`Migration history has gaps below its own canonical ceiling ${highest}: ${gaps.join(', ')} — refusing to branch on a non-contiguous history.`);
  }
  console.log(
    `Production migration history: ${reconciled.appliedCanonical.length} applied ` +
      `(${reconciled.numericRowCount} three-digit + ${reconciled.timestampRowCount} timestamp), ` +
      `canonical ceiling = ${highest}.`);
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
