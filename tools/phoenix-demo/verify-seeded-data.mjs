#!/usr/bin/env node
// ===========================================================================
// Independent, READ-ONLY verification that PHOENIX_DEMO_V1 rows genuinely
// exist in Production, for every table the demo engine ever tracks -- not
// just the manifest's own bookkeeping, but the ACTUAL underlying rows
// (manifest row_id -> a real row still present in that table). Never
// mutates anything. Never prints the connection string, any row content,
// or any personal data -- only table names and integer counts.
//
// Usage:
//   PHOENIX_PRODUCTION_DATABASE_URL=... node tools/phoenix-demo/verify-seeded-data.mjs
// ===========================================================================
import { buildRemoteIo } from '../pg-rig/remote-io.mjs';
import { DATASET_KEY } from './dataset.mjs';

async function main() {
  const io = await buildRemoteIo({ connectionString: process.env.PHOENIX_PRODUCTION_DATABASE_URL });
  try {
    console.log(`=== 1. phoenix_demo_manifest rows, by table (dataset_key='${DATASET_KEY}') ===`);
    let manifestRows;
    await io.asAdmin(async (c) => {
      const r = await c.query(
        `SELECT table_name, count(*)::int n FROM public.phoenix_demo_manifest
          WHERE dataset_key = $1 GROUP BY table_name ORDER BY table_name`, [DATASET_KEY]);
      manifestRows = r.rows;
    });
    if (manifestRows.length === 0) {
      console.log('(no manifest rows at all for this dataset key)');
    }
    for (const row of manifestRows) {
      console.log(`  ${row.table_name}: ${row.n}`);
    }

    console.log(`\n=== 2. Cross-check: how many of those manifest row_ids resolve to a REAL row still present in the actual table? ===`);
    let purgeableTables;
    await io.asAdmin(async (c) => {
      const r = await c.query('SELECT public.phoenix_demo_purgeable_tables() AS t');
      purgeableTables = r.rows[0].t;
    });

    const results = [];
    for (const table of purgeableTables) {
      let manifestCount = 0;
      let realCount = 0;
      await io.asAdmin(async (c) => {
        const exists = await c.query(`SELECT to_regclass('public.' || quote_ident($1)) IS NOT NULL AS ok`, [table]);
        if (!exists.rows[0].ok) return;
        const mc = await c.query(
          `SELECT count(*)::int n FROM public.phoenix_demo_manifest WHERE dataset_key = $1 AND table_name = $2`,
          [DATASET_KEY, table]);
        manifestCount = mc.rows[0].n;
        if (manifestCount === 0) return;
        const rc = await c.query(
          `SELECT count(*)::int n FROM public.${'"' + table.replace(/"/g, '') + '"'} t
            WHERE t.id IN (
              SELECT row_id FROM public.phoenix_demo_manifest
               WHERE dataset_key = $1 AND table_name = $2
            )`, [DATASET_KEY, table]);
        realCount = rc.rows[0].n;
      });
      if (manifestCount > 0 || realCount > 0) {
        results.push({ table, manifestCount, realCount, match: manifestCount === realCount });
      }
    }
    for (const r of results) {
      const flag = r.match ? 'OK' : 'MISMATCH';
      console.log(`  ${r.table}: manifest=${r.manifestCount} real=${r.realCount} [${flag}]`);
    }
    const mismatches = results.filter((r) => !r.match);

    console.log(`\n=== 3. Demo organizations: names/markers redacted, count only ===`);
    // Queries phoenix_demo_manifest directly rather than through
    // phoenix_is_demo_organization(), which requires auth.uid() and would
    // raise not_authenticated on this script's unauthenticated admin
    // connection (same fix already applied to prod-preflight.mjs).
    let orgCheck;
    await io.asAdmin(async (c) => {
      const r = await c.query(
        `SELECT count(*)::int n
           FROM public.organizations o
           JOIN public.phoenix_demo_manifest m
             ON m.dataset_key = $1 AND m.table_name = 'organizations' AND m.row_id = o.id`,
        [DATASET_KEY]);
      orgCheck = r.rows[0];
    });
    console.log(`  organizations present and registered as demo-owned: ${orgCheck.n}`);

    console.log(`\n=== SUMMARY ===`);
    if (mismatches.length > 0) {
      console.log(`MISMATCHES FOUND (manifest says owned but real row missing, or vice versa): ${JSON.stringify(mismatches.map((m) => m.table))}`);
      process.exitCode = 1;
    } else if (results.length === 0) {
      console.log('NO DEMO DATA FOUND AT ALL — dataset appears genuinely unseeded.');
      process.exitCode = 1;
    } else {
      console.log(`All ${results.length} tracked tables with demo rows: manifest count matches real row count exactly. Data genuinely exists in the database.`);
    }
  } finally {
    await io.end();
  }
}

main().catch((e) => {
  console.error(`::error::${e?.message ?? e}`);
  process.exitCode = 1;
});
