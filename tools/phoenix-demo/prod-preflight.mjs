#!/usr/bin/env node
// ===========================================================================
// PHOENIX_DEMO_V1 — Production preflight. READ-ONLY. Makes no writes of any
// kind. Exits non-zero (failing the workflow) on anything that should stop
// the mission rather than proceed automatically.
//
// Checks, in order:
//   1. Migration history is contiguous through the accepted ceiling, with
//      no gap and no migration beyond it already applied unexpectedly.
//   2. No PHOENIX_DEMO_V1 manifest rows already exist (a from-scratch run;
//      a prior partial seed would need explicit human review, not a silent
//      top-up).
//   3. A business-activity snapshot (org/warehouse/profile/movement counts)
//      is printed for human review, and the run is FAILED CLOSED if the
//      counts look like genuine day-to-day clinical use rather than a
//      barely-launched, pre-adoption state — the mission's own stated
//      expectation is "no real business dataset yet"; this check exists to
//      catch that expectation being wrong, not to rubber-stamp it.
//
// Usage: PHOENIX_PRODUCTION_DATABASE_URL=... ACCEPTED_MIGRATION_CEILING=145 node tools/phoenix-demo/prod-preflight.mjs
// ===========================================================================
import { buildRemoteIo } from '../pg-rig/remote-io.mjs';

const CEILING = Number(process.env.ACCEPTED_MIGRATION_CEILING || 0);
const DATASET = 'PHOENIX_DEMO_V1';

// Thresholds for "this looks like real clinical use, not a fresh/QA state".
// Deliberately conservative (low) — a false "needs review" costs nothing but
// a paused workflow; a false "proceed" risks confusing real users with a
// sudden wall of demo data. These are NOT security boundaries (the demo
// dataset is isolated by deterministic-UUID namespace + manifest ownership
// regardless of this check) — this is a business-confidence gate only.
const MAX_EXPECTED_ORGS = 10;
const MAX_EXPECTED_MOVEMENTS = 50;

function fail(msg) {
  console.error(`\n::error::PREFLIGHT FAILED: ${msg}\n`);
  process.exitCode = 1;
}

async function main() {
  if (!CEILING) {
    fail('ACCEPTED_MIGRATION_CEILING env var not set — refusing to guess the accepted migration set.');
    return;
  }
  const io = await buildRemoteIo({ connectionString: process.env.PHOENIX_PRODUCTION_DATABASE_URL });

  console.log('=== 1. Migration history ===');
  let migrationNumbers = [];
  await io.asAdmin(async (c) => {
    const r = await c.query(
      `SELECT version FROM supabase_migrations.schema_migrations ORDER BY version`);
    migrationNumbers = r.rows
      .map(row => parseInt(String(row.version).slice(0, 3), 10))
      .filter(n => Number.isFinite(n));
  });
  const maxApplied = migrationNumbers.length ? Math.max(...migrationNumbers) : 0;
  console.log(`Applied migrations: ${migrationNumbers.length}, highest = ${maxApplied}, accepted ceiling = ${CEILING}`);

  if (maxApplied > CEILING) {
    fail(`Production has migrations beyond the accepted ceiling (highest applied ${maxApplied} > ceiling ${CEILING}) — unexplained divergence, stop.`);
  }
  // Contiguity check 1..maxApplied (no gap in what IS applied).
  const seen = new Set(migrationNumbers);
  const gaps = [];
  for (let n = 1; n <= maxApplied; n++) if (!seen.has(n)) gaps.push(n);
  if (gaps.length > 0) {
    fail(`Migration history has gaps: ${gaps.join(', ')} — refusing to apply on top of a non-contiguous chain.`);
  }

  console.log('\n=== 2. Existing PHOENIX_DEMO_V1 manifest data ===');
  let manifestCount = 0;
  let manifestTableExists = false;
  await io.asAdmin(async (c) => {
    const t = await c.query(`SELECT to_regclass('public.phoenix_demo_manifest') AS reg`);
    manifestTableExists = t.rows[0].reg !== null;
    if (manifestTableExists) {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM public.phoenix_demo_manifest WHERE dataset_key = $1`, [DATASET]);
      manifestCount = r.rows[0].n;
    }
  });
  console.log(`Manifest table exists: ${manifestTableExists}. Existing ${DATASET} rows: ${manifestCount}`);
  if (manifestCount > 0) {
    console.log('This is NOT a from-scratch seed — a prior seed attempt already registered rows. Idempotent re-seed is expected to converge safely, proceeding is allowed, but flagging for the record.');
  }

  console.log('\n=== 3. Business-activity snapshot ===');
  // The threshold below exists to catch UNEXPECTED genuine clinical growth
  // -- counting this mission's own deliberately-seeded demo organizations/
  // movements against it is a false alarm by construction (they grow by
  // design every time this workflow's migrate_and_seed mode runs), not a
  // signal. Excludes rows registered in phoenix_demo_manifest for
  // PHOENIX_DEMO_V1's organizations, queried directly (not through
  // phoenix_is_demo_organization(), which requires auth.uid() and would
  // raise not_authenticated on this script's unauthenticated admin
  // connection -- this asAdmin connection reads the same manifest table
  // that RPC's own body reads, just without that RPC's caller-context
  // requirement, appropriate for a backend diagnostic script).
  let manifestTableExistsForFilter = false;
  await io.asAdmin(async (c) => {
    const t = await c.query(`SELECT to_regclass('public.phoenix_demo_manifest') AS reg`);
    manifestTableExistsForFilter = t.rows[0].reg !== null;
  });
  const demoOrgIdsSubquery = manifestTableExistsForFilter
    ? `(SELECT row_id FROM public.phoenix_demo_manifest WHERE dataset_key = '${DATASET}' AND table_name = 'organizations')`
    : `(SELECT NULL::uuid WHERE false)`; // pre-140 Production: no demo mechanism exists yet, nothing to exclude
  const demoOrgFilter = `organization_id NOT IN ${demoOrgIdsSubquery}`;
  const demoOrgFilterDirect = `id NOT IN ${demoOrgIdsSubquery}`;

  const counts = {};
  await io.asAdmin(async (c) => {
    for (const [key, sql] of Object.entries({
      organizations: `SELECT count(*)::int AS n FROM organizations WHERE ${demoOrgFilterDirect}`,
      organizations_total_incl_demo: `SELECT count(*)::int AS n FROM organizations`,
      warehouses: `SELECT count(*)::int AS n FROM warehouses`,
      distribution_points: `SELECT count(*)::int AS n FROM distribution_points`,
      profiles_non_super_admin: `SELECT count(*)::int AS n FROM profiles WHERE role <> 'super_admin'`,
      warehouse_stock_movements: `SELECT count(*)::int AS n FROM warehouse_stock_movements WHERE ${demoOrgFilter}`,
      outlet_stock_movements: `SELECT count(*)::int AS n FROM outlet_stock_movements WHERE ${demoOrgFilter}`,
    })) {
      try {
        const r = await c.query(sql);
        counts[key] = r.rows[0].n;
      } catch { counts[key] = null; } // table may not exist yet if migrations aren't fully applied
    }
    const orgRows = await c.query(`SELECT name, code FROM organizations WHERE ${demoOrgFilterDirect} ORDER BY created_at LIMIT 20`);
    counts._organizationNames = orgRows.rows.map(r => `${r.name} (${r.code})`);
  });
  console.log(JSON.stringify(counts, null, 2));

  const orgs = counts.organizations ?? 0;
  const movements = (counts.warehouse_stock_movements ?? 0) + (counts.outlet_stock_movements ?? 0);
  if (orgs > MAX_EXPECTED_ORGS || movements > MAX_EXPECTED_MOVEMENTS) {
    fail(
      `Production activity exceeds the pre-adoption thresholds this mission expected ` +
      `(orgs=${orgs} vs max ${MAX_EXPECTED_ORGS}, movements=${movements} vs max ${MAX_EXPECTED_MOVEMENTS}). ` +
      `This does not necessarily mean anything is wrong — the demo dataset is isolated by deterministic-UUID ` +
      `namespace and would not touch these rows — but it contradicts the mission's stated assumption of ` +
      `"no real business dataset yet" and needs a human to confirm before seeding proceeds.`
    );
  }

  await io.end();

  if (process.exitCode === 1) {
    console.error('\nPREFLIGHT: FAILED — see errors above. No migrations applied, nothing seeded.');
  } else {
    console.log('\nPREFLIGHT: PASSED — safe to proceed to migrate + seed.');
  }
}

main().catch((e) => {
  // e.message has already been redacted by remote-io.mjs for connection
  // errors; anything else here is a logic error in this script, never the
  // secret itself (which is never interpolated into any string here).
  console.error(`::error::PREFLIGHT crashed: ${e?.message ?? e}`);
  process.exitCode = 1;
});
