#!/usr/bin/env node
// ===========================================================================
// PINNED PRODUCTION MIGRATION EXECUTOR — dry-run transcript proof (READ-ONLY).
//
// Reads the transcript the workflow captured from
// `supabase db push --db-url ... --dry-run` and proves the CLI itself agrees
// that exactly the pinned migration is pending. This is the SECOND, independent
// single-pending proof; the first is preflight's database-and-directory set
// difference. Neither is trusted alone.
//
// Usage:
//   PHOENIX_MIGRATION_FILENAME=196_....sql \
//   PHOENIX_DRY_RUN_TRANSCRIPT=/tmp/db-push-dry-run.txt \
//     node tools/phoenix-demo/assert-single-pending-dry-run.mjs
// ===========================================================================
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertDryRunNamesOnlyTarget } from './production-migration-contract.mjs';

function main() {
  const transcriptPath = process.env.PHOENIX_DRY_RUN_TRANSCRIPT;
  const expectedFilename = process.env.PHOENIX_MIGRATION_FILENAME;
  if (!transcriptPath) throw new Error('PHOENIX_DRY_RUN_TRANSCRIPT must point at the captured dry-run output.');
  if (!expectedFilename) throw new Error('PHOENIX_MIGRATION_FILENAME must name the exact pinned migration.');

  const transcript = readFileSync(transcriptPath, 'utf8');
  const allLocalFilenames = readdirSync(join(process.cwd(), 'supabase', 'migrations')).filter((f) => f.endsWith('.sql'));

  const { targetVersion } = assertDryRunNamesOnlyTarget(transcript, { expectedFilename, allLocalFilenames });
  console.log(`Dry-run transcript proof PASS: the CLI would apply exactly migration ${targetVersion} (${expectedFilename}).`);
}

try {
  main();
} catch (e) {
  console.error(`::error::${e?.code ? `[${e.code}] ` : ''}${e?.message ?? e}`);
  process.exitCode = 1;
}
