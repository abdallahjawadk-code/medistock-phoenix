/**
 * 194 · AUTHORIZATION SURFACE REPRODUCIBILITY CONVERGENCE — static contract.
 *
 * Reads the migration text and the coupled rig/registry sources. Runs anywhere,
 * no database required. The behavioural proof lives in the companion
 * `.dynamic.test.ts`; this file pins the properties that must be true of the
 * SOURCE regardless of whether a rig is available:
 *
 *   * exactly one BEGIN / one COMMIT — the migration is atomic;
 *   * the convergence is invariant-shaped (REVOKE ... ON ALL TABLES, then
 *     restore exactly the contracted pair) rather than an enumerated delta,
 *     so it is safe on an already-hardened Production;
 *   * no precondition requires the H-24/H-25 excess to be PRESENT;
 *   * SELECT is never revoked, and no role other than `authenticated` is ever
 *     revoked from;
 *   * migration 085 keeps its PREPARED cutover source header and is not
 *     edited, while the rig now APPLIES it (Production did) with a
 *     session-scoped attestation, and 194 explicitly forbids a future operator
 *     from re-applying 085 by hand;
 *   * historical migrations 001–193 are untouched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');
const M194_FILE = '194_phoenix_authorization_surface_reproducibility_convergence.sql';
const M194 = readFileSync(join(MIGRATIONS_DIR, M194_FILE), 'utf8');
const M085 = readFileSync(join(MIGRATIONS_DIR, '085_phoenix_revoke_manual_availability_writers.sql'), 'utf8');
const RIG = readFileSync(join(ROOT, 'tools/pg-rig/rig.mjs'), 'utf8');
const BOOTSTRAP = readFileSync(join(ROOT, 'tools/pg-rig/bootstrap.sql'), 'utf8');

/** Executable SQL only — comments carry prose that would false-positive. */
const executable = (sql: string): string =>
  sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const EXEC = executable(M194);

describe('194 · static · atomicity and shape', () => {
  it('is registered as a reviewed migration', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M194_FILE);
  });

  it('uses exactly one BEGIN and one COMMIT', () => {
    expect(EXEC.match(/\bBEGIN\s*;/gi) ?? []).toHaveLength(1);
    expect(EXEC.match(/\bCOMMIT\s*;/gi) ?? []).toHaveLength(1);
    expect(EXEC.indexOf('BEGIN')).toBeLessThan(EXEC.indexOf('COMMIT'));
    // No ROLLBACK, no savepoint games, no second transaction.
    expect(EXEC).not.toMatch(/\bROLLBACK\b/i);
    expect(EXEC).not.toMatch(/\bSAVEPOINT\b/i);
  });

  it('converges relations by invariant, not by an enumerated delta', () => {
    expect(EXEC).toMatch(
      /REVOKE\s+INSERT,\s*UPDATE,\s*DELETE,\s*TRUNCATE,\s*REFERENCES,\s*TRIGGER,\s*MAINTAIN\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+public\s+FROM\s+authenticated\s*;/i,
    );
  });

  it('revokes MAINTAIN — the PostgreSQL 17 privilege GRANT ALL also conferred', () => {
    // Live Production at ceiling 193: authenticated MAINTAIN relations = 0.
    // A clean replay carried 68, because MAINTAIN is part of GRANT ALL ON
    // TABLES and no historical REVOKE list ever named it. It is converged
    // here, not excluded, and it must never be re-added to an ignore list.
    expect(EXEC).toMatch(/\bMAINTAIN\b/);
    const revokeStmt = EXEC.match(
      /^[ \t]*REVOKE\s+([A-Z][A-Z, \t\r\n]*?)\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+public/m,
    );
    expect(revokeStmt, 'the ALL TABLES revoke must exist').not.toBeNull();
    expect(revokeStmt![1].replace(/\s+/g, ' ').trim())
      .toBe('INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN');
    // …and MAINTAIN is never granted back to a client principal.
    expect(EXEC).not.toMatch(/GRANT[^;]*MAINTAIN[^;]*TO\s+(authenticated|anon)/i);
  });

  // Statement-anchored and case-SENSITIVE on purpose. SQL keywords are written
  // uppercase throughout this chain, while the RAISE messages contain ordinary
  // prose ("the canonical grant chain did not run"). A case-insensitive scan
  // matches that prose and silently parses a comment as a statement.
  const GRANT_STMT = /^[ \t]*GRANT\s+([A-Z][A-Z, \t]*?)\s+ON\s+TABLE\s+public\.(\w+)\s+TO\s+(\w+)\s*;/gm;
  const REVOKE_STMT = /^[ \t]*REVOKE\s+([A-Z][A-Z, \t\r\n]*?)\s+ON\s+([\s\S]*?)\s+FROM\s+([\w,\s]+?);/gm;

  it('restores exactly the two contracted direct-write relations and nothing else', () => {
    const grants = [...EXEC.matchAll(GRANT_STMT)]
      .map((m) => `${m[3]}:${m[2]}:${m[1].replace(/\s+/g, ' ').trim()}`)
      .sort();
    expect(grants).toEqual([
      'authenticated:distribution_points:INSERT, UPDATE',
      'authenticated:organizations:INSERT, UPDATE',
    ]);
  });

  it('never revokes SELECT and never revokes from a role other than authenticated', () => {
    const revokes = [...EXEC.matchAll(REVOKE_STMT)];
    expect(revokes).toHaveLength(3); // ALL TABLES + the two writer functions
    for (const r of revokes) {
      const privileges = r[1].replace(/\s+/g, ' ').trim();
      const grantees = r[3].split(',').map((s) => s.trim().toLowerCase());
      expect(privileges, 'SELECT must never be revoked').not.toMatch(/\bSELECT\b/);
      expect(privileges, 'ALL PRIVILEGES is too blunt here').not.toMatch(/\bALL\b/);
      expect(grantees).toEqual(['authenticated']);
    }
    expect(revokes.map((r) => r[1].replace(/\s+/g, ' ').trim()).sort()).toEqual([
      'EXECUTE', 'EXECUTE', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN',
    ]);
  });

  it('revokes EXECUTE on both manual availability writers at their exact signatures', () => {
    expect(EXEC).toMatch(
      /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.phoenix_upsert_availability\(\s*uuid,\s*text,\s*text,\s*text,\s*text,\s*integer,\s*text,\s*date,\s*text,\s*text,\s*text,\s*numeric,\s*text\s*\)\s*FROM\s+authenticated\s*;/i,
    );
    expect(EXEC).toMatch(
      /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.phoenix_apply_availability_movement\(\s*uuid,\s*text,\s*integer,\s*text,\s*text\s*\)\s*FROM\s+authenticated\s*;/i,
    );
  });

  it('changes no function body, owner, or search_path', () => {
    expect(EXEC).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(EXEC).not.toMatch(/DROP\s+FUNCTION/i);
    expect(EXEC).not.toMatch(/ALTER\s+FUNCTION/i);
    expect(EXEC).not.toMatch(/\bOWNER\s+TO\b/i);
  });

  it('touches no RLS policy and writes no data', () => {
    expect(EXEC).not.toMatch(/CREATE\s+POLICY|ALTER\s+POLICY|DROP\s+POLICY/i);
    expect(EXEC).not.toMatch(/\bROW\s+LEVEL\s+SECURITY\b/i);
    // The only INSERT/UPDATE/DELETE tokens are privilege names inside
    // GRANT/REVOKE statements, never DML of their own.
    for (const kw of ['INSERT INTO', 'DELETE FROM', 'TRUNCATE TABLE']) {
      expect(EXEC.toUpperCase()).not.toContain(kw);
    }
    expect(EXEC).not.toMatch(/\bUPDATE\s+public\./i);
  });

  it('does not modify default privileges — 109 stays the only owner of that', () => {
    expect(EXEC).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
  });
});

describe('194 · static · fail-closed preconditions', () => {
  it('has a single guarded precondition block that raises rather than continues', () => {
    expect(EXEC).toMatch(/DO\s+\$precond\$/);
    expect(EXEC).toMatch(/DO\s+\$verify\$/);
    expect((EXEC.match(/RAISE\s+EXCEPTION/gi) ?? []).length).toBeGreaterThanOrEqual(10);
  });

  it('pins the exact reviewed bodies of both manual availability writers', () => {
    expect(EXEC).toContain('cf66c61734c5d1ecc2f54822efbb56ed'); // phoenix_upsert_availability
    expect(EXEC).toContain('1229dfd36bebaac947f65c1852a9912d'); // phoenix_apply_availability_movement
  });

  it('pins the M193 security state it must run on top of', () => {
    expect(EXEC).toContain('a203286cb5c0075a4942b1307207076b'); // refresh_inter_org_alert_lifecycle
    expect(EXEC).toContain('69104e1646a2e0203de6e2789ba54c7e'); // ..._with_state
    expect(EXEC).toContain('bf2b2295c55b4bc0a5dae074353250a3'); // ..._with_state_page
    expect(EXEC).toMatch(/search_path=public, pg_temp/);
  });

  it('requires the 083/084 replacement capability before closing the manual writers', () => {
    expect(EXEC).toMatch(/to_regprocedure\(\s*'public\.phoenix_available_stock\(uuid\)'\s*\)\s+IS\s+NULL/i);
    expect(EXEC).toMatch(
      /to_regprocedure\(\s*'public\.phoenix_set_availability_visibility\(uuid, boolean, text\)'\s*\)\s+IS\s+NULL/i,
    );
  });

  it('requires exactly one overload of each writer, so no overload survives the revoke', () => {
    expect(EXEC).toMatch(/expected exactly 1 phoenix_upsert_availability overload/);
    expect(EXEC).toMatch(/expected exactly 1 phoenix_apply_availability_movement overload/);
  });

  it('NO precondition requires the H-24/H-25 excess privileges to be present', () => {
    // The Production-shaped no-op property depends on this. A precondition
    // asserting that authenticated HOLDS a write it should not have, or that it
    // HOLDS EXECUTE on a manual writer, would abort on real Production.
    const precond = EXEC.slice(EXEC.indexOf('$precond$'), EXEC.lastIndexOf('$precond$'));

    // No precondition may require `authenticated` to HOLD a relation write.
    expect(precond).not.toMatch(
      /IF\s+NOT\s+has_table_privilege\(\s*'authenticated'[^)]*'(INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)'/i,
    );

    // No precondition may require `authenticated` EXECUTE on either MANUAL
    // AVAILABILITY WRITER — Production has already revoked both, so such a
    // guard would abort there. (Requiring authenticated EXECUTE on M193's
    // `phoenix_refresh_inter_org_alert_lifecycle` IS legitimate and expected:
    // that grant is part of the verified Production M193 posture.)
    for (const writer of ['phoenix_upsert_availability', 'phoenix_apply_availability_movement']) {
      const requiresAuthExec = new RegExp(
        `IF\\s+NOT\\s+has_function_privilege\\(\\s*'authenticated'[^;]*${writer}`, 'i',
      );
      expect(precond, `${writer} EXECUTE must not be a precondition`).not.toMatch(requiresAuthExec);
    }
    // v_upsert_oid / v_movement_oid are the only handles to those two
    // functions inside the block; assert neither is gated on authenticated.
    expect(precond).not.toMatch(/has_function_privilege\(\s*'authenticated',\s*v_(upsert|movement)_oid/i);

    // service_role EXECUTE on the writers IS required — Production satisfies it.
    expect(precond).toMatch(/has_function_privilege\('service_role', v_upsert_oid, 'EXECUTE'\)/);
  });

  it('asserts the post-state as an exact set, not a count', () => {
    expect(EXEC).toMatch(/v_expected\s+text\[\]\s*:=\s*ARRAY\[/);
    expect(EXEC).toContain("'distribution_points|INSERT'");
    expect(EXEC).toContain("'distribution_points|UPDATE'");
    expect(EXEC).toContain("'organizations|INSERT'");
    expect(EXEC).toContain("'organizations|UPDATE'");
    expect(EXEC).toMatch(/v_actual\s*<>\s*v_expected/);
  });

  it('proves nothing else moved by comparing a live before-image with the after-image', () => {
    expect(EXEC).toMatch(/_m194_before_surface/);
    expect(EXEC).toMatch(/_m194_after_surface/);
    expect(EXEC).toMatch(/_m194_before_functions/);
    expect(EXEC).toMatch(/ON\s+COMMIT\s+DROP/i);
  });

  it('casts the surface columns to text so `name` truncation cannot corrupt the comparison', () => {
    // pg `name` is 63 chars; without the cast the UNION ALL would silently
    // truncate every function identity signature and compare truncated strings.
    expect(EXEC).toMatch(/'RELATION'::text\s+AS\s+kind/);
    expect(EXEC).toMatch(/fr\.relname::text\s+AS\s+object/);
  });
});

describe('194 · static · migration 085 status contract', () => {
  it('085 keeps its PREPARED cutover source header — history is not rewritten', () => {
    expect(M085).toMatch(/\*\*\*CUTOVER — PREPARED, DO NOT APPLY\*\*\*/);
    expect(M085).toMatch(/MANUAL APPLY ONLY/);
    expect(M085).toMatch(/phoenix\.availability_cutover_attested/);
    expect(M085).toMatch(/REFUSING TO APPLY 085/);
  });

  it('085 is APPLIED by the canonical rig, with its attestation — not skipped', () => {
    // Production applied 085 (live-verified: schema_migrations version 085,
    // count 1). The rig used to skip it, which is what produced the two
    // phantom `authenticated` EXECUTE grants classified as H-24.
    expect(RIG).not.toMatch(/PREPARED_ONLY_SKIP/);
    expect(RIG).toMatch(/ATTESTED_CUTOVER_MIGRATIONS\s*=\s*new Map\(\[/);
    expect(RIG).toContain(
      "['085_phoenix_revoke_manual_availability_writers.sql', 'phoenix.availability_cutover_attested']",
    );
  });

  it('194 records the CORRECTED 085 status contract', () => {
    expect(M194).toContain('085_SOURCE_HEADER');
    expect(M194).toContain('PREPARED_CUTOVER');
    expect(M194).toContain('085_PRODUCTION_HISTORY');
    expect(M194).toContain('APPLIED_ONCE');
    expect(M194).toContain('085_PRODUCTION_SECURITY_EFFECT');
    expect(M194).toContain('M194_WRITER_REVOKES');
    expect(M194).toContain('IDEMPOTENT_REASSERTION_OF_EXISTING_085_SECURITY_BOUNDARY');
    // The retracted tokens must never come back.
    expect(M194).not.toContain('PREPARED_ONLY_NOT_PRODUCTION_APPLIED');
    expect(M194).not.toContain('SUPERSEDED_BY_M194');
  });

  it('194 forbids re-applying 085 by hand', () => {
    const unwrapped = M194.replace(/^\s*--\s?/gm, ' ').replace(/\s+/g, ' ');
    expect(unwrapped).toMatch(/MUST NOT READ THIS MIGRATION AS PERMISSION TO APPLY 085/i);
  });

  it('194 reasserts the same two writer revokes 085 established', () => {
    const m085Exec = executable(M085);
    for (const fn of ['phoenix_upsert_availability', 'phoenix_apply_availability_movement']) {
      expect(m085Exec).toMatch(new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${fn}`, 'i'));
      expect(EXEC).toMatch(new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${fn}`, 'i'));
    }
  });
});

describe('194 · static · historical immutability and rig coupling', () => {
  it('adds exactly one migration file and leaves 001–193 byte-identical to the base commit', () => {
    const changed = execFileSync(
      'git',
      ['-C', ROOT, 'status', '--porcelain=v1', '--', 'supabase/migrations'],
      { encoding: 'utf8' },
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.slice(3).trim());

    const touchedHistorical = changed.filter((p) => {
      const m = /supabase\/migrations\/(\d{3})_/.exec(p);
      return m !== null && Number(m[1]) <= 193;
    });
    expect(touchedHistorical, 'migrations 001–193 are IMMUTABLE').toEqual([]);
  });

  it('migration 109 is untouched — it remains the sole owner of default privileges', () => {
    const dirty = execFileSync(
      'git',
      ['-C', ROOT, 'status', '--porcelain=v1', '--', 'supabase/migrations/109_phoenix_public_schema_default_privileges_lockdown.sql'],
      { encoding: 'utf8' },
    ).trim();
    expect(dirty).toBe('');
  });

  // I-3 advances this successor ceiling by exactly one: 196 (SECDEF relation
  // schema qualification) is now the reviewed successor to 195. This relaxes
  // ONLY which future migration numbers may exist; every M194 assertion in
  // this file is unchanged.
  it('no migration numbered 198 or higher exists', () => {
    const above = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .filter((f) => Number(f.slice(0, 3)) >= 198);
    expect(above).toEqual([]);
  });

  it('the rig replays 194 as part of the ordinary chain (it is NOT prepared-only)', () => {
    expect(RIG).not.toContain(M194_FILE);
    expect(readdirSync(MIGRATIONS_DIR)).toContain(M194_FILE);
  });

  it('bootstrap keeps the platform `authenticated` default and does not repair H-24/H-25', () => {
    // §17: the bootstrap models the PLATFORM. If a future change deletes the
    // authenticated default here, the rig would agree with Production for the
    // wrong reason and H-25 would stop being detectable.
    expect(BOOTSTRAP).toMatch(
      /ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES\s+TO authenticated, service_role;/,
    );
    expect(BOOTSTRAP).toMatch(
      /ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;/,
    );
    expect(BOOTSTRAP).toMatch(/GRANT CREATE ON SCHEMA public TO service_role;/);
    // Bootstrap must not contain Phoenix hardening.
    expect(BOOTSTRAP).not.toMatch(/REVOKE[\s\S]*FROM authenticated/i);
    expect(BOOTSTRAP).not.toMatch(/phoenix_upsert_availability|phoenix_apply_availability_movement/);
  });
});
