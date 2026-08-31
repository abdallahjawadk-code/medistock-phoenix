/**
 * ANON-READ-SURFACE-192 — STATIC proof.
 *
 * G5's claim is that the anonymous role holds NO direct read on any relation in
 * `public`, and that the one anonymous product surface — the public QR page —
 * keeps working because it goes through a SECURITY DEFINER RPC instead.
 *
 * What is provable without a database:
 *
 *   1. the migration only REVOKEs — it grants nothing back, to anyone;
 *   2. it creates and alters no object: no table, view, function or policy;
 *   3. its VERIFY block asserts an EMPTY allowlist rather than an allowlist
 *      with a documented exception, which is the whole point of the fix;
 *   4. `item_availability` is closed too, and 027's `using (false)` is asserted
 *      rather than assumed.
 *
 * The behavioural half — that anon genuinely cannot read, that the QR RPC still
 * answers, and that the effective anon read set really is empty on a live
 * database — is proven in the dynamic suite.
 *
 * WHY item_availability IS NOT AN EXCEPTION. It is the only relation whose
 * policy list mentions anon, so it reads like an intended public table. It is
 * not: migration 027 fixed `avail_select_anon` from `using (true)` to
 * `using (false)` as a CRITICAL defect (staff names, emails, prices), leaving
 * only the stale table GRANT behind. Re-granting it would restore half of a
 * two-lock pair. These scans exist so a future edit cannot quietly re-open it.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REVIEWED_MIGRATION_FILES,
  getMaximumReviewedMigrationNumber,
  getNextUnreviewedMigrationNumber,
  isReviewedMigrationFile,
} from './helpers/reviewed-migrations';

const NAME = '192_phoenix_anonymous_read_surface_convergence.sql';
const MIGRATIONS_DIR = join(__dirname, '..');
const sql = readFileSync(join(MIGRATIONS_DIR, NAME), 'utf8');

/** SQL with `--` comment lines removed, so a scan judges STATEMENTS, not prose. */
const statements = sql
  .split('\n')
  .filter(l => !l.trim().startsWith('--'))
  .join('\n');

describe('192 · registration and file hygiene', () => {
  it('exists exactly once on disk under its exact filename', () => {
    const onDisk = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('192') && f.endsWith('.sql'));
    expect(onDisk).toEqual([NAME]);
  });

  it('is registered in the reviewed-migration manifest by exact filename', () => {
    expect(isReviewedMigrationFile(NAME)).toBe(true);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('192_'))).toEqual([NAME]);
  });

  it('is immediately followed by 193 through 201, the current ceiling, and 202 stays absent', () => {
    const NEXT = '193_phoenix_inter_org_alert_command_surface_hardening.sql';
    const NEXT_2 = '194_phoenix_authorization_surface_reproducibility_convergence.sql';
    const NEXT_3 = '195_phoenix_auth_helper_profile_schema_qualification.sql';
    const NEXT_4 = '196_phoenix_secdef_relation_schema_qualification.sql';
    const NEXT_5 = '197_phoenix_public_execute_convergence.sql';
    const NEXT_6 = '198_phoenix_secdef_search_path_convergence.sql';
    const NEXT_7 = '199_phoenix_command_center_read_contract.sql';
    const NEXT_8 = '200_phoenix_demo_purge_auth_boundary_correction.sql';
    const NEXT_9 = '201_phoenix_organization_archive_dependency_guard.sql';
    const NEXT_10 = '202_phoenix_organization_archive_reciprocal_guard.sql';
    expect(getMaximumReviewedMigrationNumber()).toBe(202);
    expect(getNextUnreviewedMigrationNumber()).toBe(203);
    expect(REVIEWED_MIGRATION_FILES.slice(REVIEWED_MIGRATION_FILES.indexOf(NAME) + 1)).toEqual([NEXT, NEXT_2, NEXT_3, NEXT_4, NEXT_5, NEXT_6, NEXT_7, NEXT_8, NEXT_9, NEXT_10]);
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.length - 1]).toBe(NEXT_10);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^193_/.test(f))).toEqual([NEXT]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^194_/.test(f))).toEqual([NEXT_2]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^195_/.test(f))).toEqual([NEXT_3]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^196_/.test(f))).toEqual([NEXT_4]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^197_/.test(f))).toEqual([NEXT_5]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^198_/.test(f))).toEqual([NEXT_6]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^199_/.test(f))).toEqual([NEXT_7]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^200_/.test(f))).toEqual([NEXT_8]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^201_/.test(f))).toEqual([NEXT_9]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^202_/.test(f))).toEqual([NEXT_10]);
    // The ceiling is now 202; `[2-9]\d\d` would match the ceiling itself, so
    // this asserts numerically that nothing sits ABOVE it.
    expect(REVIEWED_MIGRATION_FILES.filter(f => Number(f.slice(0, 3)) > 202)).toHaveLength(0);
    expect(isReviewedMigrationFile('203_unreviewed_test_migration.sql')).toBe(false);
  });

  it('carries no CR bytes', () => {
    expect(sql.includes('\r')).toBe(false);
  });

  it('is a single transaction, manual-apply only', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).not.toMatch(/\bROLLBACK\b/);
    expect(sql).toContain('MANUAL APPLY ONLY');
  });

  it('edits no historical migration — it is self-contained', () => {
    // 202 (ISW2) is the newest reviewed chain member and does not edit
    // M192, so this count moves by exactly one.
    const others = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql') && f !== NAME);
    expect(others).toHaveLength(201);
  });
});

describe('192 · privilege-only: it creates and alters nothing', () => {
  it('creates no table, view, materialized view, function, sequence or policy', () => {
    for (const forbidden of [
      /\bCREATE\s+TABLE\b/i, /\bCREATE\s+VIEW\b/i, /\bCREATE\s+MATERIALIZED\b/i,
      /\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i, /\bCREATE\s+SEQUENCE\b/i,
      /\bCREATE\s+POLICY\b/i, /\bCREATE\s+INDEX\b/i, /\bCREATE\s+TRIGGER\b/i,
    ]) {
      expect(statements, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('alters or drops no policy, table or function', () => {
    for (const forbidden of [
      /\bALTER\s+POLICY\b/i, /\bDROP\s+POLICY\b/i, /\bALTER\s+TABLE\b/i,
      /\bALTER\s+FUNCTION\b/i, /\bDROP\s+FUNCTION\b/i,
      /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i, /\bTRUNCATE\b/i,
    ]) {
      expect(statements, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('drops nothing but its OWN two scratch snapshots', () => {
    const drops = (statements.match(/DROP\s+TABLE[^;]*/gi) ?? []).map(d => d.replace(/\s+/g, ' ').trim());
    expect(drops).toEqual([
      'DROP TABLE phoenix_192_anon_nonselect_before',
      'DROP TABLE phoenix_192_anon_defacl_before',
    ]);
    // Both are TEMP, so the persistent schema is never touched.
    expect(statements).toMatch(/CREATE TEMP TABLE phoenix_192_anon_nonselect_before/);
    expect(statements).toMatch(/CREATE TEMP TABLE phoenix_192_anon_defacl_before/);
  });

  it('writes no business data', () => {
    for (const forbidden of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i, /\bMERGE\b/i]) {
      expect(statements, String(forbidden)).not.toMatch(forbidden);
    }
  });
});

describe('192 · it revokes, and grants nothing back', () => {
  it('contains no executable GRANT of any kind', () => {
    // Prose in the header legitimately discusses grants; statements must not.
    expect(statements).not.toMatch(/\bGRANT\b/i);
  });

  it('revokes SELECT from anon over an explicit relkind loop', () => {
    expect(statements).toContain("REVOKE SELECT ON %s FROM anon");
    expect(statements).toMatch(/relkind\s+IN\s*\(\s*'r','p','v','m','f'\s*\)/);
  });

  it('revokes from no role other than anon', () => {
    const revokes = statements.match(/REVOKE[^;]*/gi) ?? [];
    expect(revokes.length).toBeGreaterThan(0);
    for (const r of revokes) {
      expect(r, r).toMatch(/FROM\s+anon/i);
      expect(r, r).not.toMatch(/\b(authenticated|service_role|postgres|PUBLIC)\b/);
    }
  });
});

describe('192 · the VERIFY block asserts an EMPTY allowlist', () => {
  it('asserts no relation of any kind is anon-selectable', () => {
    expect(sql).toContain('anon still holds direct SELECT on');
    expect(sql).toMatch(/relkind\s+IN\s*\(\s*'r','p','v','m','f'\s*\)[\s\S]{0,200}has_table_privilege\('anon'/);
  });

  it('names item_availability explicitly as CLOSED, not excepted', () => {
    expect(sql).toContain("anon still holds direct SELECT on item_availability");
    // It must never assert the opposite.
    expect(sql).not.toContain('anon lost SELECT on item_availability');
  });

  it("pins 027's using(false) rather than assuming it", () => {
    expect(sql).toContain('avail_select_anon');
    expect(sql).toContain('is no longer USING(false)');
    expect(sql).toMatch(/btrim\(v_qual\)\s*<>\s*'false'/);
  });

  it('proves it changed no anon WRITE privilege, by identity and in both directions', () => {
    expect(sql).toContain('phoenix_192_anon_nonselect_before');
    expect(sql).toContain('the anon non-SELECT privilege set changed');
    // Bidirectional set difference, never a count comparison.
    // \b so this cannot match inside RAISE EXCEPTION: 2 per snapshot comparison.
    expect(sql.match(/\bEXCEPT\b/g) ?? []).toHaveLength(4);
    expect(sql).not.toMatch(/count\(\*\)[^;]*anon[^;]*<>\s*'SELECT'/i);
  });

  it('proves it changed no anon DEFAULT-ACL entry, matched on every identity column', () => {
    expect(sql).toContain('phoenix_192_anon_defacl_before');
    expect(sql).toContain('the anon default-ACL set changed');
    expect(sql).toContain('pg_default_acl');
    for (const col of ['defacl_owner', 'namespace', 'object_type', 'grantor', 'grantee', 'privilege', 'grantable']) {
      expect(sql, col).toContain(col);
    }
  });

  it('does NOT assert an absolute absence of anon default privileges', () => {
    // That is an ENVIRONMENT baseline: hosted Production has no anon entry, a
    // stock local Supabase does. 192 must not veto either.
    expect(sql).not.toContain('a default privilege grants anon SELECT on future relations');
  });

  it('does NOT precondition on anon holding no write privilege', () => {
    expect(sql).not.toContain('anon holds a non-SELECT relation privilege');
  });

  it('drops both snapshots before COMMIT', () => {
    expect(sql).toContain('DROP TABLE phoenix_192_anon_nonselect_before;');
    expect(sql).toContain('DROP TABLE phoenix_192_anon_defacl_before;');
  });

  it('asserts the public QR RPC survives and stays SECURITY DEFINER', () => {
    expect(sql).toContain('anon lost EXECUTE on get_public_qr_payload');
    expect(sql).toContain('get_public_qr_payload is no longer SECURITY DEFINER');
  });

  it('asserts no anon-reachable first-party INVOKER routine reads data', () => {
    expect(sql).toContain('anon can execute non-DEFINER first-party routines');
    // Extension functions are excluded structurally, never by name.
    expect(sql).toContain("d.deptype = 'e'");
    expect(sql).not.toMatch(/proname\s*(<>|!=|NOT\s+IN)\s*'(digest|gen_random_uuid|similarity)'/i);
  });

  it('asserts 191 is untouched and still closed to anon', () => {
    expect(sql).toContain('anon gained EXECUTE on the topology query');
  });

  it('asserts authenticated did not lose its reads', () => {
    expect(sql).toContain('authenticated holds no SELECT privileges at all');
    expect(sql).toContain('authenticated lost SELECT on item_availability');
  });

  it('asserts no migration beyond 192 is recorded', () => {
    expect(sql).toContain('a migration beyond 192 is already recorded');
    expect(sql).toMatch(/19\[3-9\]|\^\(19\[3-9\]/);
  });
});

describe('192 · it deliberately leaves the alert hybrid alone', () => {
  it('touches no routine privilege', () => {
    expect(statements).not.toMatch(/\bON\s+FUNCTION\b/i);
    expect(statements).not.toMatch(/phoenix_get_live_inter_institution_alerts_with_state/);
  });
});
