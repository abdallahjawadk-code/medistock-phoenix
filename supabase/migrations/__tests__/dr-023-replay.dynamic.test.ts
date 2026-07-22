/**
 * DR-023-REPLAY — dynamic acceptance evidence for the migration-023 replay gap.
 *
 * Backs docs/phoenix/proposals/dr-repair-migration-023-replay.md with runnable
 * proof (acceptance criteria 1, 3, 5). It does NOT modify migration 023 and does
 * NOT choose a fix — the owner decision (Option A vs B) stays open. It proves the
 * claims the proposal rests on, so the decision is made on evidence:
 *
 *   • 023 as written aborts on a fresh replay (the DR gap is real);
 *   • dp_insert_perm's predicate lives in pg_policies.with_check, not qual —
 *     which is why the qual-only assertion fails;
 *   • the with_check-aware assertion both replays cleanly AND still catches a
 *     genuinely missing policy (a guard that can no longer fail is worse).
 *
 * Gated on PHOENIX_RIG_PG. Skipped in CI (no database), like the 081/082 dynamic
 * proofs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { freshRigDb, MIGRATIONS_DIR, shimSql, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

function filesUpTo(n: number): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort()
    .filter((f) => parseInt(f.slice(0, 3), 10) <= n);
}

// Apply 001..022 (everything 023 depends on) to a fresh bootstrapped db.
async function replayThrough022(): Promise<pg.Client> {
  const c = await freshRigDb();
  for (const f of filesUpTo(22)) {
    await c.query(shimSql(f, readFileSync(join(MIGRATIONS_DIR as string, f), 'utf8')));
  }
  return c;
}

const RAW_023 = () => {
  const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('023_'))!;
  return readFileSync(join(MIGRATIONS_DIR as string, name), 'utf8');
};

run('DR: migration 023 replay gap', () => {
  it('dp_insert_perm stores its predicate in with_check, not qual', async () => {
    const c = await replayThrough022();
    try {
      const { rows } = await c.query(`
        SELECT policyname, cmd, qual IS NULL AS qual_null, with_check IS NULL AS wc_null
          FROM pg_policies
         WHERE schemaname='public' AND tablename='distribution_points'
         ORDER BY policyname`);
      const ins = rows.find((r: any) => r.policyname === 'dp_insert_perm');
      expect(ins).toBeTruthy();
      expect(ins.cmd).toBe('INSERT');
      expect(ins.qual_null).toBe(true);    // <- the column 023 reads: always NULL
      expect(ins.wc_null).toBe(false);     // <- where the predicate actually is
    } finally {
      await c.end();
    }
  });

  it('023 as written aborts on a fresh replay (the DR gap is real)', async () => {
    const c = await replayThrough022();
    try {
      // The unmodified file: qual-only assertion on an INSERT policy → fails.
      await expect(c.query(RAW_023())).rejects.toThrow(
        /dp_insert_perm policy missing from distribution_points|VERIFY FAILED/);
    } finally {
      await c.end();
    }
  });

  it('the with_check-aware assertion replays cleanly', async () => {
    const c = await replayThrough022();
    try {
      // shimSql applies exactly the proposal's minimal correction, in memory.
      await expect(c.query(shimSql('023_x.sql', RAW_023()))).resolves.toBeTruthy();
    } finally {
      await c.end();
    }
  });

  it('the corrected assertion still catches a genuinely missing policy', async () => {
    const c = await replayThrough022();
    try {
      // Remove the policy the assertion guards, then run the corrected 023.
      await c.query(`DROP POLICY IF EXISTS "dp_insert_perm" ON distribution_points`);
      await expect(c.query(shimSql('023_x.sql', RAW_023()))).rejects.toThrow(
        /dp_insert_perm policy missing|VERIFY FAILED/);
    } finally {
      await c.end();
    }
  });
});
