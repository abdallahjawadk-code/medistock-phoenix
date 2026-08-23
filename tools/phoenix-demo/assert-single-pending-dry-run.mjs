#!/usr/bin/env node
// ===========================================================================
// PINNED PRODUCTION MIGRATION EXECUTOR — dry-run transcript proof (READ-ONLY).
//
// PROOF B of two. Proof A is the Phoenix canonical reconciliation in
// production-migration-preflight.mjs, which derives the pending set from
// Production's reconciled history. This proves the SAME conclusion from the
// Supabase CLI's own mouth, against the shadow workspace the CLI will actually
// push from. Neither proof is trusted alone; if they disagree, the run refuses.
//
// The CLI reasons in Production's version namespace, so the name it prints is
// the SHADOW ALIAS (e.g. 20260823181015_197_phoenix_public_execute_convergence.sql),
// not the canonical filename. The alias is supplied by the preflight, which
// built it — this file never guesses it.
//
// Usage:
//   PHOENIX_TARGET_ALIAS=20260823181015_197_....sql \
//   PHOENIX_DRY_RUN_TRANSCRIPT=/tmp/db-push-dry-run.txt \
//   [PHOENIX_EXPECT_PENDING=1|0] \
//     node tools/phoenix-demo/assert-single-pending-dry-run.mjs
// ===========================================================================
import { readFileSync } from 'node:fs';
import { parseDryRunPending } from './build-shadow-migration-workspace.mjs';

function main() {
  const transcriptPath = process.env.PHOENIX_DRY_RUN_TRANSCRIPT;
  const targetAlias = process.env.PHOENIX_TARGET_ALIAS;
  const expectPending = process.env.PHOENIX_EXPECT_PENDING === undefined
    ? 1 : parseInt(process.env.PHOENIX_EXPECT_PENDING, 10);
  if (!transcriptPath) throw new Error('PHOENIX_DRY_RUN_TRANSCRIPT must point at the captured dry-run output.');
  if (expectPending === 1 && !targetAlias) throw new Error('PHOENIX_TARGET_ALIAS must name the exact shadow alias.');
  if (![0, 1].includes(expectPending)) throw new Error('PHOENIX_EXPECT_PENDING must be 0 or 1.');

  const transcript = readFileSync(transcriptPath, 'utf8');
  const pending = parseDryRunPending(transcript);

  if (pending.length !== expectPending) {
    throw new Error(
      `The CLI reports ${pending.length} pending migration(s) [${pending.join(', ')}], expected exactly ${expectPending}. ` +
        '`supabase db push` applies every pending migration, so it may only run when exactly one is pending.',
    );
  }

  if (expectPending === 1) {
    if (pending[0] !== targetAlias) {
      throw new Error(`The CLI would push ${JSON.stringify(pending[0])}, but the preflight built ${JSON.stringify(targetAlias)}.`);
    }
    console.log(`Dry-run transcript proof PASS: the CLI would apply exactly ${targetAlias}.`);
  } else {
    console.log('Dry-run transcript proof PASS: the CLI reports nothing pending.');
  }
}

try {
  main();
} catch (e) {
  console.error(`::error::${e?.code ? `[${e.code}] ` : ''}${e?.message ?? e}`);
  process.exitCode = 1;
}
