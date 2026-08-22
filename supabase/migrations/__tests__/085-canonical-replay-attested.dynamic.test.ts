/**
 * 085 · CANONICAL REPLAY WITH HISTORICAL CUTOVER ATTESTATION — real rig proof.
 *
 * WHY THIS EXISTS. Migration 085 is a fail-closed CUTOVER file: its source says
 * "PREPARED, DO NOT APPLY" and it RAISES unless the applying session sets
 * `phoenix.availability_cutover_attested`. On that basis tools/pg-rig/rig.mjs
 * used to SKIP it entirely.
 *
 * A live read-only inspection of Production disproved the premise behind that
 * skip. Production's `supabase_migrations.schema_migrations` records:
 *
 *     version 085 · phoenix_revoke_manual_availability_writers · count 1
 *
 * with a stored payload containing both writer REVOKEs, and the live functions
 * carry 085's own COMMENT text with `authenticated` EXECUTE = NO and
 * `service_role` EXECUTE = YES. Production APPLIED it.
 *
 * Skipping it therefore made the canonical replay diverge from ACTUAL
 * Production history: the rig reintroduced two `authenticated` EXECUTE grants
 * that Production does not have. That was H-24 — a PG-RIG REPLAY-POLICY
 * FIDELITY defect, not unexplained Production drift.
 *
 * The fix is in the rig, never in 085: the canonical replay applies 085 and
 * supplies the historical attestation for that one apply only. This suite is
 * the regression proof for both halves — that the attested apply works, and
 * that the raw file is still fail-closed without it.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildRig, rigAvailable, migrationFiles, shimSql,
  ATTESTED_CUTOVER_MIGRATIONS, MIGRATIONS_DIR,
} from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 300000, hookTimeout: 300000 });

const ROOT = join(__dirname, '../../../');
const NAME = '085_phoenix_revoke_manual_availability_writers.sql';
const GUC = 'phoenix.availability_cutover_attested';

const UPSERT = 'public.phoenix_upsert_availability(uuid,text,text,text,text,integer,text,date,text,text,text,numeric,text)';
const MOVEMENT = 'public.phoenix_apply_availability_movement(uuid,text,integer,text,text)';

describe('085 replay policy · static wiring', () => {
  it('085 is in the canonical replay list — no longer filtered out', () => {
    expect(migrationFiles(193)).toContain(NAME);
    expect(migrationFiles()).toContain(NAME);
  });

  it('085 is registered as an attested cutover migration with its own GUC', () => {
    expect(ATTESTED_CUTOVER_MIGRATIONS.get(NAME)).toBe(GUC);
  });

  it('the PRE-cutover replay is explicit and opt-in, never the default', () => {
    expect(migrationFiles(193, { excludeCutover: true })).not.toContain(NAME);
    expect(migrationFiles(193)).toContain(NAME);
  });

  it('085 bytes are unchanged against the base commit', () => {
    const dirty = execFileSync(
      'git', ['-C', ROOT, 'status', '--porcelain=v1', '--', `supabase/migrations/${NAME}`],
      { encoding: 'utf8' },
    ).trim();
    expect(dirty, '085 is IMMUTABLE — the fix belongs in the rig').toBe('');
  });

  it('EVERY hand-rolled replay loop routes through applyMigrationSql', () => {
    // Several suites reimplement buildRig()'s inner loop so they can stop at a
    // specific ceiling. A bare `c.query(shimSql(...))` in one of those loops
    // silently bypasses the cutover attestation and makes that suite abort on
    // 085 — which is exactly what happened when the skip was first retired.
    // Catch the bypass in a cheap static scan instead of rediscovering it in a
    // 10-minute battery.
    const dir = join(__dirname);
    // Strip comments first — otherwise this guard matches the very sentence
    // above that describes the pattern it is looking for.
    const code = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((n) => /\.test\.ts$/.test(n))) {
      const src = code(readFileSync(join(dir, f), 'utf8'));
      if (!/\bmigrationFiles\s*\(/.test(src)) continue;      // not a replay loop
      if (/query\(\s*shimSql\s*\(/.test(src)) offenders.push(f);
    }
    expect(offenders, 'these replay loops bypass applyMigrationSql').toEqual([]);
  });
});

const run = rigAvailable() ? describe : describe.skip;

run('085 replay policy · real disposable rig', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    // Canonical build: 085 IS applied, by the rig, with its attestation.
    rig = await buildRig({ upTo: 193 });
  }, 300000);

  afterAll(async () => { await rig?.end(); });

  it('085_CANONICAL_RIG_ATTESTED_APPLY — authenticated EXECUTE is NO on both writers', async () => {
    const r = await rig.asAdmin((c: any) => c.query(`
      SELECT $1::text AS sig,
             has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role',  $1::regprocedure, 'EXECUTE') AS svc_exec
      UNION ALL
      SELECT $2::text,
             has_function_privilege('authenticated', $2::regprocedure, 'EXECUTE'),
             has_function_privilege('service_role',  $2::regprocedure, 'EXECUTE')
      ORDER BY 1`, [UPSERT, MOVEMENT]));

    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(row.auth_exec, `${row.sig} must NOT be executable by authenticated`).toBe(false);
      expect(row.svc_exec, `${row.sig} must remain executable by service_role`).toBe(true);
    }
  });

  it('085 installed its own COMMENTs — proof the real file ran, not a substitute', async () => {
    const r = await rig.asAdmin((c: any) => c.query(`
      SELECT obj_description($1::regprocedure, 'pg_proc') AS a,
             obj_description($2::regprocedure, 'pg_proc') AS b`, [UPSERT, MOVEMENT]));
    expect(r.rows[0].a).toMatch(/INTERNAL as of migration 085/);
    expect(r.rows[0].b).toMatch(/INTERNAL as of migration 085/);
  });

  it('the attestation does NOT leak past the 085 apply', async () => {
    // Requirement 7: the rig must not leave the cutover attestation live for
    // any later migration or for the test connection pool.
    const r = await rig.asAdmin((c: any) =>
      c.query(`SELECT current_setting($1, true) AS v`, [GUC]));
    expect(r.rows[0].v === null || r.rows[0].v === '').toBe(true);
  });

  it('the derived-availability replacement capability is present, as 085 required', async () => {
    const r = await rig.asAdmin((c: any) => c.query(`
      SELECT to_regprocedure('public.phoenix_available_stock(uuid)') IS NOT NULL AS m083,
             to_regprocedure('public.phoenix_set_availability_visibility(uuid, boolean, text)') IS NOT NULL AS m084`));
    expect(r.rows[0]).toEqual({ m083: true, m084: true });
  });

  it('085_RAW_FAIL_CLOSED — the raw file still aborts without the attestation', async () => {
    // The rig supplies the attestation; 085 itself is NOT weakened. Applying
    // the exact immutable bytes in a session with no attestation must still
    // refuse. Run inside a rolled-back transaction so nothing persists.
    const raw = shimSql(NAME, readFileSync(join(MIGRATIONS_DIR, NAME), 'utf8'));
    await rig.asAdmin(async (c: any) => {
      const before = await c.query(`SELECT current_setting($1, true) AS v`, [GUC]);
      expect(before.rows[0].v === null || before.rows[0].v === '').toBe(true);
      await expect(c.query(raw)).rejects.toThrow(/REFUSING TO APPLY 085/);
      // 085 opens its own transaction and the RAISE aborts it, so the session
      // is left clean; make sure we can still query.
      await c.query('ROLLBACK').catch(() => undefined);
      const still = await c.query(
        `SELECT has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS ok`, [UPSERT]);
      expect(still.rows[0].ok).toBe(true);
    });
  });

  it('an explicitly PRE-cutover replay still shows the pre-085 posture', async () => {
    // The opt-in escape hatch must genuinely differ, otherwise the canonical
    // build could silently be the pre-cutover one.
    const pre = await buildRig({ upTo: 193, excludeCutover: true });
    try {
      const r = await pre.asAdmin((c: any) => c.query(
        `SELECT has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS auth_exec`,
        [UPSERT]));
      expect(r.rows[0].auth_exec, 'without 085 the grant is still present').toBe(true);
    } finally { await pre.end(); }
  }, 300000);

  it('no historical migration bytes changed to achieve any of this', () => {
    const changed = execFileSync(
      'git', ['-C', ROOT, 'status', '--porcelain=v1', '--', 'supabase/migrations'],
      { encoding: 'utf8' },
    ).split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).trim());
    const historical = changed.filter((p) => {
      const m = /supabase\/migrations\/(\d{3})_/.exec(p);
      return m !== null && Number(m[1]) <= 193;
    });
    expect(historical, 'migrations 001–193 are IMMUTABLE').toEqual([]);
  });
});
