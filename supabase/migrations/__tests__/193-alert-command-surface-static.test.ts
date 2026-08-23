/**
 * ALERT-COMMAND-SURFACE-193 — STATIC proof.
 *
 * H Unit 1's claim is that an `authenticated` client can no longer reach the
 * inter-org alert LIFECYCLE WRITER by any route, while the one sanctioned
 * command keeps working and the pure CQRS read chain is left completely alone.
 *
 * What is provable without a database:
 *
 *   1. the migration performs exactly THREE mutating statements — one ALTER
 *      FUNCTION and two REVOKEs — and grants nothing back, to anyone;
 *   2. the refresh command is ALTERed, never CREATE OR REPLACEd, which is what
 *      makes "body preserved" a property of the statement rather than a promise;
 *   3. STEP 1 textually precedes STEP 2, because the reverse order strands the
 *      command: refresh is SECURITY INVOKER today and therefore calls the hybrid
 *      AS THE CALLER;
 *   4. both revokes name their EXACT signature, so an overload cannot be hit by
 *      accident and the intended one cannot be missed;
 *   5. the pure base RPC and the two pure CQRS queries are never revoked;
 *   6. no relation GRANT, no RLS or policy statement, no permission key, and no
 *      edit to the identity helpers Unit 4 owns.
 *
 * The behavioural half — that the command still runs, that the hybrid and the
 * legacy paging wrapper are genuinely denied, that auth.uid() survives the extra
 * SECURITY DEFINER hop, and that the pure queries still write nothing — is
 * proven in the dynamic suite.
 *
 * WHY THE LEGACY PAGING WRAPPER MUST BE REVOKED TOO. It is itself SECURITY
 * DEFINER and calls the hybrid, so it reaches the writer AS THE OWNER and does
 * not need the caller to hold EXECUTE on the hybrid at all. Revoking only the
 * hybrid would leave a fully working replacement door. These scans exist so a
 * future edit cannot quietly re-open either one.
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

const NAME = '193_phoenix_inter_org_alert_command_surface_hardening.sql';
const MIGRATIONS_DIR = join(__dirname, '..');
const ROOT = join(__dirname, '..', '..', '..');
const sql = readFileSync(join(MIGRATIONS_DIR, NAME), 'utf8');

/** SQL with `--` comment lines removed, so a scan judges STATEMENTS, not prose. */
const statements = sql
  .split('\n')
  .filter(l => !l.trim().startsWith('--'))
  .join('\n');

const REFRESH = 'phoenix_refresh_inter_org_alert_lifecycle';
const HYBRID = 'phoenix_get_live_inter_institution_alerts_with_state';
const PAGE = 'phoenix_get_live_inter_institution_alerts_with_state_page';
const BASE = 'phoenix_get_live_inter_institution_alerts';

describe('193 · registration and file hygiene', () => {
  it('exists exactly once on disk under its exact filename', () => {
    const onDisk = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('193') && f.endsWith('.sql'));
    expect(onDisk).toEqual([NAME]);
  });

  it('is registered in the reviewed-migration manifest by exact filename', () => {
    expect(isReviewedMigrationFile(NAME)).toBe(true);
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('193_'))).toEqual([NAME]);
  });

  it('is immediately followed by 194 through 197, the new ceiling, and 198 stays absent', () => {
    expect(getMaximumReviewedMigrationNumber()).toBe(197);
    expect(getNextUnreviewedMigrationNumber()).toBe(198);
    const NEXT = '194_phoenix_authorization_surface_reproducibility_convergence.sql';
    const NEXT_2 = '195_phoenix_auth_helper_profile_schema_qualification.sql';
    const NEXT_3 = '196_phoenix_secdef_relation_schema_qualification.sql';
    const NEXT_4 = '197_phoenix_public_execute_convergence.sql';
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.indexOf(NAME) + 1]).toBe(NEXT);
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.indexOf(NAME) + 2]).toBe(NEXT_2);
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.indexOf(NAME) + 3]).toBe(NEXT_3);
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.length - 1]).toBe(NEXT_4);
    expect(REVIEWED_MIGRATION_FILES.some(f => /^19[89]_|^[2-9]\d\d_/.test(f))).toBe(false);
    expect(readdirSync(MIGRATIONS_DIR).some(f => /^(19[89]|[2-9]\d\d)_.*\.sql$/.test(f))).toBe(false);
    expect(isReviewedMigrationFile('198_unreviewed_test_migration.sql')).toBe(false);
  });

  it('carries no CR bytes', () => {
    expect(sql.includes('\r')).toBe(false);
  });

  it('is a single transaction, manual-apply only, and never rolls itself back', () => {
    expect(statements).toContain('BEGIN;');
    expect(statements.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect((statements.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((statements.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    expect(statements).not.toMatch(/\bROLLBACK\b/);
    expect(sql).toContain('MANUAL APPLY ONLY');
  });

  it('edits no historical migration — it is self-contained', () => {
    // 197 (I-4, PUBLIC EXECUTE convergence) is the newest chain member; it is
    // ACL-only and edits nothing here, so this count moves by exactly one.
    const others = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql') && f !== NAME);
    expect(others).toHaveLength(196);
  });
});

describe('193 · STEP 1 — the command is ALTERed, never rewritten', () => {
  it('flips the refresh command to SECURITY DEFINER with ALTER FUNCTION', () => {
    expect(statements).toMatch(
      new RegExp(`ALTER\\s+FUNCTION\\s+public\\.${REFRESH}\\(integer\\)\\s+SECURITY\\s+DEFINER;`),
    );
  });

  it('never CREATE OR REPLACEs the refresh command — body preservation is structural', () => {
    expect(statements).not.toMatch(new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${REFRESH}`, 'i'));
    // Nothing in this migration may define ANY function: it is a privilege and
    // security-mode convergence only.
    expect(statements).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
  });

  it('does not restate the search_path — ALTER carries the pinned one across', () => {
    // The only place `search_path=public, pg_temp` may appear as a STATEMENT is
    // inside the precondition/VERIFY comparisons, never as a SET clause.
    expect(statements).not.toMatch(/SET\s+search_path\s*(=|TO)/i);
  });

  it('STEP 1 textually precedes both revokes — the reverse order strands the command', () => {
    const alterAt = statements.search(new RegExp(`ALTER\\s+FUNCTION\\s+public\\.${REFRESH}`));
    const revokeHybridAt = statements.search(
      new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s*\\n?\\s*public\\.${HYBRID}\\(integer\\)`),
    );
    const revokePageAt = statements.search(
      new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s*\\n?\\s*public\\.${PAGE}\\(integer, integer\\)`),
    );
    expect(alterAt).toBeGreaterThan(-1);
    expect(revokeHybridAt).toBeGreaterThan(-1);
    expect(revokePageAt).toBeGreaterThan(-1);
    expect(alterAt).toBeLessThan(revokeHybridAt);
    expect(alterAt).toBeLessThan(revokePageAt);
  });
});

describe('193 · STEPS 2 and 3 — both write-capable doors, by exact signature', () => {
  it('revokes authenticated EXECUTE on the hybrid at its exact signature', () => {
    expect(statements).toMatch(
      new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s*\\n?\\s*public\\.${HYBRID}\\(integer\\)\\s*\\n?\\s*FROM\\s+authenticated;`),
    );
  });

  it('revokes authenticated EXECUTE on the legacy paging wrapper at its exact signature', () => {
    expect(statements).toMatch(
      new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s*\\n?\\s*public\\.${PAGE}\\(integer, integer\\)\\s*\\n?\\s*FROM\\s+authenticated;`),
    );
  });

  it('revokes exactly TWO functions and nothing else', () => {
    const revokes = statements.match(/REVOKE[\s\S]*?;/g) ?? [];
    expect(revokes).toHaveLength(2);
    for (const r of revokes) {
      expect(r).toMatch(/REVOKE\s+EXECUTE\s+ON\s+FUNCTION/);
      expect(r).toMatch(/FROM\s+authenticated;/);
    }
  });
});

describe('193 · the pure read chain is never touched', () => {
  it('never revokes the load-bearing pure base RPC', () => {
    // `phoenix_get_live_inter_institution_alerts(integer)` backs
    // query_page -> read_projection -> base. Revoking it would break the CQRS
    // read path this stage exists to protect. The exact-signature form is what
    // matters: the two revoked names share this prefix.
    expect(statements).not.toMatch(
      new RegExp(`REVOKE[^;]*public\\.${BASE}\\(integer\\)[^;]*;`),
    );
  });

  it('never revokes or alters the two pure CQRS queries', () => {
    for (const fn of [
      'phoenix_query_live_inter_org_alerts_with_state_page',
      'phoenix_query_live_inter_org_alert_summary',
      '_phoenix_live_inter_org_alert_read_projection_v1',
    ]) {
      expect(statements, fn).not.toMatch(new RegExp(`REVOKE[^;]*${fn}[^;]*;`));
      expect(statements, fn).not.toMatch(new RegExp(`ALTER\\s+FUNCTION[^;]*${fn}[^;]*;`));
      expect(statements, fn).not.toMatch(new RegExp(`DROP\\s+FUNCTION[^;]*${fn}[^;]*;`));
    }
  });

  it('drops no function at all', () => {
    expect(statements).not.toMatch(/DROP\s+FUNCTION/i);
  });
});

describe('193 · stays inside its authorized blast radius', () => {
  it('grants nothing to anyone', () => {
    expect(statements).not.toMatch(/^\s*GRANT\b/mi);
  });

  it('contains no relation privilege statement', () => {
    expect(statements).not.toMatch(/\bON\s+TABLE\b/i);
    expect(statements).not.toMatch(/\bON\s+ALL\s+TABLES\b/i);
    expect(statements).not.toMatch(/\bALTER\s+DEFAULT\s+PRIVILEGES\b/i);
  });

  it('contains no RLS or policy statement', () => {
    expect(statements).not.toMatch(/\bROW\s+LEVEL\s+SECURITY\b/i);
    expect(statements).not.toMatch(/\bCREATE\s+POLICY\b/i);
    expect(statements).not.toMatch(/\bALTER\s+POLICY\b/i);
    expect(statements).not.toMatch(/\bDROP\s+POLICY\b/i);
  });

  it('adds no permission key and no schema object', () => {
    expect(statements).not.toMatch(/INSERT\s+INTO\s+(public\.)?permission_keys/i);
    expect(statements).not.toMatch(/INSERT\s+INTO\s+(public\.)?role_permission_defaults/i);
    expect(statements).not.toMatch(/CREATE\s+(VIEW|MATERIALIZED\s+VIEW|TYPE|INDEX|TRIGGER)\b/i);
    expect(statements).not.toMatch(/ALTER\s+TABLE\b/i);
    // The ONLY tables this migration may create are its own two before-image
    // tables, both dropped again before COMMIT (asserted separately below).
    const createdTables = [...statements.matchAll(/CREATE\s+TABLE\s+(\w+)/gi)].map(m => m[1]);
    expect(createdTables.every(t => /^phoenix_193_/.test(t))).toBe(true);
  });

  it('creates only its two bookkeeping tables and drops both again', () => {
    const created = [...statements.matchAll(/CREATE\s+TABLE\s+(phoenix_193_\w+)/gi)].map(m => m[1]).sort();
    const dropped = [...statements.matchAll(/DROP\s+TABLE\s+(phoenix_193_\w+)/gi)].map(m => m[1]).sort();
    expect(created).toEqual(['phoenix_193_relpriv_before', 'phoenix_193_routine_before']);
    expect(dropped).toEqual(created);
  });

  it('leaves the identity helpers Unit 4 owns completely alone', () => {
    for (const fn of ['phoenix_my_org', 'phoenix_my_role', '_phoenix_authorize_transfer_request_write']) {
      expect(statements, fn).not.toMatch(new RegExp(`(ALTER|CREATE|DROP|REVOKE|GRANT)[^;]*${fn}[^;]*;`, 'i'));
    }
  });

  it('leaves the pg-rig bootstrap untouched — its baseline drift is Unit 2 work', () => {
    // Unit 1 is authorized to change no rig privilege at all. The over-permissive
    // default-privilege grant must therefore still be exactly where the audit
    // found it; removing it here would silently move Unit 2's fix into Unit 1.
    const bootstrap = readFileSync(join(ROOT, 'tools', 'pg-rig', 'bootstrap.sql'), 'utf8');
    expect(bootstrap).toContain(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO authenticated, service_role;',
    );
  });
});

describe('193 · the VERIFY block proves the whole contract', () => {
  it('fails closed rather than notifying', () => {
    expect(statements).toMatch(/RAISE\s+EXCEPTION\s+'VERIFY FAILED \(193\)/);
    expect(statements).toMatch(/RAISE\s+EXCEPTION\s+'193_precondition_failed/);
  });

  it('refuses to install unless the refresh command is still INVOKER', () => {
    expect(statements).toMatch(/193_precondition_failed: the refresh command is already SECURITY DEFINER/);
  });

  it('refuses to install if either grant it removes is already absent', () => {
    expect(statements).toMatch(/193_precondition_failed: authenticated already lacks EXECUTE on the hybrid/);
    expect(statements).toMatch(/193_precondition_failed: authenticated already lacks EXECUTE on the legacy paging wrapper/);
  });

  it('proves body, search_path, volatility and owner preservation from a captured before-image', () => {
    expect(statements).toContain('md5(p.prosrc) IS DISTINCT FROM b.prosrc_md5');
    expect(statements).toMatch(/a routine body changed/);
    expect(statements).toMatch(/a routine search_path changed/);
    expect(statements).toMatch(/a routine volatility or owner changed/);
  });

  it('asserts the command still delegates and never grew its own lifecycle DML', () => {
    expect(statements).toMatch(/the refresh command no longer delegates to the hybrid/);
    expect(statements).toMatch(/the refresh command has acquired its own lifecycle DML/);
  });

  it('asserts the hybrid stays the SOLE read-named lifecycle writer', () => {
    expect(statements).toMatch(/expected exactly ONE read-named lifecycle writer/);
  });

  it('asserts both doors are closed to authenticated, anon and PUBLIC', () => {
    expect(statements).toMatch(/authenticated can still execute the hybrid/);
    expect(statements).toMatch(/authenticated can still execute the legacy paging wrapper/);
    expect(statements).toMatch(/PUBLIC holds EXECUTE on the hybrid/);
    expect(statements).toMatch(/PUBLIC holds EXECUTE on the legacy paging wrapper/);
  });

  it('asserts the sanctioned command survived', () => {
    expect(statements).toMatch(/authenticated lost EXECUTE on the refresh command/);
    expect(statements).toMatch(/the pure base RPC lost authenticated EXECUTE/);
  });

  it('asserts service_role as a DELTA, never as an absolute', () => {
    // Production carries service_role=X on the hybrid; a clean replay of the
    // chain does not. An absolute assertion would be false on the rig and would
    // quietly codify Production-only drift. "Unchanged" is true in both.
    expect(statements).toContain(
      "has_function_privilege('service_role', p.oid, 'EXECUTE') IS DISTINCT FROM b.svc_x",
    );
    expect(statements).not.toMatch(/service_role lost EXECUTE on the hybrid/);
  });

  it('asserts no relation privilege moved in either direction, for BOTH client roles', () => {
    expect(statements).toMatch(/relation privileges were REMOVED/);
    expect(statements).toMatch(/relation privileges were ADDED/);
    // Both directions must be compared, and both client roles must be in the
    // comparison — that pair is what proves "no table GRANT" as a fact.
    expect(statements).toContain("CROSS JOIN (VALUES ('anon'), ('authenticated')) AS g(grantee)");
  });

  it('states the anon contract as PRESERVATION, never as universal equality', () => {
    // An absolute "anon holds nothing" postcondition is a PRODUCTION fact, not
    // a portable one: a stock local Supabase project still carries the
    // platform's own anon TRUNCATE/REFERENCES/TRIGGER baseline. 192 settled the
    // correct contract — revoke SELECT, then assert the non-SELECT set is
    // UNCHANGED — and 193 must not re-encode one environment's shape.
    expect(statements).not.toMatch(/anon holds direct relation privileges/);
    expect(statements).not.toMatch(/has_table_privilege\('anon'/);
  });

  it('refuses to install under an already-recorded M194+', () => {
    expect(statements).toMatch(/a migration beyond 193 is already recorded/);
    expect(statements).toContain("'^(19[4-9]|[2-9][0-9][0-9])_'");
  });
});
