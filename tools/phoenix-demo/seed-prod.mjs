#!/usr/bin/env node
// ===========================================================================
// PHOENIX_DEMO_V1 — Production seed entry point.
//
// Runs the EXACT SAME, already adversarially-tested seedDemoDataset() from
// seed.mjs — no production-only branch, no shortcut, no direct row
// fabrication. The only thing specific to this script is discovering a REAL
// existing super_admin to act as the manifest-registering identity (the
// seeder itself never creates or modifies that account — "the real owner
// account is untouchable", seed.mjs's own header) and running it twice in
// one invocation to prove idempotency in the same breath as seeding.
//
// Usage:
//   PHOENIX_PRODUCTION_DATABASE_URL=... node tools/phoenix-demo/seed-prod.mjs
// ===========================================================================
import { buildRemoteIo } from '../pg-rig/remote-io.mjs';
import { seedDemoDataset } from './seed.mjs';
import { DATASET_KEY } from './dataset.mjs';

async function findRealSuperAdmin(io) {
  let id = null;
  await io.asAdmin(async (c) => {
    const r = await c.query(
      `SELECT id FROM profiles WHERE role = 'super_admin' AND status = 'active'
        ORDER BY created_at ASC LIMIT 1`);
    id = r.rows[0]?.id ?? null;
  });
  if (!id) {
    throw new Error('No active super_admin found in Production — refusing to seed without a real owner identity to register ownership under.');
  }
  return id;
}

async function manifestSummary(io, superAdminId) {
  let rows = [];
  await io.asUser(superAdminId, async (c) => {
    rows = await c.query(`SELECT * FROM public.phoenix_demo_manifest_summary($1)`, [DATASET_KEY])
      .then(r => r.rows);
  });
  return rows;
}

async function main() {
  const io = await buildRemoteIo({ connectionString: process.env.PHOENIX_PRODUCTION_DATABASE_URL });
  try {
    const superAdminId = await findRealSuperAdmin(io);
    console.log(`Seeding as real super_admin ${superAdminId} (never created/modified by this script).`);

    console.log('\n=== SEED RUN 1 ===');
    const out1 = await seedDemoDataset(io, superAdminId, {});
    console.log('COUNTS:', JSON.stringify(out1.counts, null, 2));
    console.log('WORKFLOW GROUPS:', JSON.stringify(out1.workflow, null, 2));

    const summary1 = await manifestSummary(io, superAdminId);
    console.log('MANIFEST SUMMARY (run 1):', JSON.stringify(summary1, null, 2));

    console.log('\n=== SEED RUN 2 (idempotency proof) ===');
    const out2 = await seedDemoDataset(io, superAdminId, {});
    console.log('COUNTS (run 2 — master-data counts must be ~0 new):', JSON.stringify(out2.counts, null, 2));

    const summary2 = await manifestSummary(io, superAdminId);
    console.log('MANIFEST SUMMARY (run 2):', JSON.stringify(summary2, null, 2));

    const nonIdempotent = ['organizations', 'warehouses', 'distribution_points', 'profiles']
      .filter(table => out2.counts[table] > 0);
    if (nonIdempotent.length > 0) {
      console.error(`::error::Master-data tables grew on the second run: ${nonIdempotent.join(', ')} — idempotency violated.`);
      process.exitCode = 1;
    } else {
      console.log('\nIDEMPOTENCY: PASSED — second run created zero new organizations/warehouses/distribution_points/profiles.');
    }

    // Manifest row counts must be identical (or grow only in genuinely
    // idempotent-replay-safe ways) between run 1 and run 2 for every table.
    const byTable1 = new Map(summary1.map(r => [r.table_name, Number(r.row_count)]));
    const drifted = summary2.filter(r => byTable1.has(r.table_name) && Number(r.row_count) !== byTable1.get(r.table_name));
    if (drifted.length > 0) {
      console.error('::error::Manifest row counts drifted between run 1 and run 2 (should be byte-identical for a converged reseed):',
        JSON.stringify(drifted, null, 2));
      process.exitCode = 1;
    }
  } finally {
    await io.end();
  }
}

main().catch((e) => {
  console.error(`::error::PRODUCTION SEED crashed: ${e?.message ?? e}`);
  process.exitCode = 1;
});
