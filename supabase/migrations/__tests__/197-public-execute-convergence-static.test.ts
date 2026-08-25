/**
 * M197 — POSTGRESQL PUBLIC EXECUTE CONVERGENCE — static contract.
 *
 * Reads the migration as TEXT. The behavioural proof (real anon QR calls, real
 * RLS reads, real trigger firing) lives in the .dynamic suite; this file guards
 * the properties no runtime assertion can recover once the file is edited:
 * that M197 is ACL-only, and that every GRANT precedes its matching REVOKE.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..');
const FILENAME = '197_phoenix_public_execute_convergence.sql';
const SQL = readFileSync(join(MIGRATIONS, FILENAME), 'utf8');

/** Statement text with comments stripped, so prose can never satisfy a check. */
const CODE = SQL.replace(/--[^\n]*/g, ' ');

const SIX = [
  'public.get_public_qr_payload(text)',
  'public.phoenix_my_org()',
  'public.phoenix_my_role()',
  'public.phoenix_guard_dp_archive_update()',
  'public.phoenix_handle_new_user()',
  'public.phoenix_populate_actor_snapshot()',
];

describe('M197 static — identity and placement', () => {
  it('is registered at 197, below the 200 ceiling, with no 201+ present', () => {
    // I-5 landed 198 (SECDEF search_path convergence) directly after this
    // migration, so 197 is no longer the newest file. It must still exist
    // exactly once, still sit at index 196, and 198 must be the ONLY thing
    // above it — a second unreviewed migration would still fail this closed.
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    expect(files).toContain(FILENAME);
    expect(files.indexOf(FILENAME)).toBe(196);
    expect(files.slice(197)).toEqual([
      '198_phoenix_secdef_search_path_convergence.sql',
      '199_phoenix_command_center_read_contract.sql',
      '200_phoenix_demo_purge_auth_boundary_correction.sql',
    ]);
    expect(files.filter((f) => Number(f.slice(0, 3)) > 200)).toEqual([]);
    expect(files).toHaveLength(200);
  });

  it('carries no MANUAL APPLY ONLY banner, so the pinned executor will accept it', () => {
    // 143 of this repository's migrations forbid `supabase db push` in their own
    // header and the I-2 executor refuses any file that does. M197 is applied by
    // that executor, so it must not carry the banner — exactly like migration 147.
    expect(SQL).not.toMatch(/MANUAL APPLY ONLY/i);
  });

  it('is LF-only, matching every other migration blob in this repository', () => {
    expect(SQL).not.toContain('\r');
  });

  it('is wrapped in exactly one transaction', () => {
    expect((SQL.match(/^BEGIN;$/gm) ?? [])).toHaveLength(1);
    expect((SQL.match(/^COMMIT;$/gm) ?? [])).toHaveLength(1);
    expect(SQL.indexOf('BEGIN;')).toBeLessThan(SQL.indexOf('COMMIT;'));
    expect(SQL).not.toMatch(/^ROLLBACK;$/m);
  });
});

describe('M197 static — ACL-ONLY', () => {
  it('issues no DDL that could alter an object definition', () => {
    for (const forbidden of [
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i,
      /DROP\s+FUNCTION/i,
      /ALTER\s+FUNCTION/i,
      /CREATE\s+(OR\s+REPLACE\s+)?(VIEW|MATERIALIZED\s+VIEW)/i,
      /ALTER\s+TABLE/i,
      /CREATE\s+TABLE(?!\s+TEMP)/i,
      /DROP\s+TABLE/i,
      /CREATE\s+POLICY/i,
      /ALTER\s+POLICY/i,
      /DROP\s+POLICY/i,
      /CREATE\s+TRIGGER/i,
      /DROP\s+TRIGGER/i,
      /ALTER\s+DEFAULT\s+PRIVILEGES/i,
      /ALTER\s+SCHEMA/i,
      /ALTER\s+SEQUENCE/i,
      /CREATE\s+ROLE/i,
      /ALTER\s+ROLE/i,
      /SET\s+search_path\s*=/i,
    ]) {
      expect(CODE, `forbidden statement matched ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('mutates no business data', () => {
    // The only INSERT is into the ON COMMIT DROP temp target table.
    const inserts = CODE.match(/INSERT\s+INTO\s+([A-Za-z0-9_.]+)/gi) ?? [];
    expect(inserts.map((s) => s.replace(/\s+/g, ' ').trim())).toEqual(['INSERT INTO _m197_targets']);
    expect(CODE).not.toMatch(/\bUPDATE\s+(?!.*_m197)/i);
    expect(CODE).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(CODE).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('creates only ON COMMIT DROP temp tables for its own before/after images', () => {
    const temps = [...CODE.matchAll(/CREATE\s+TEMP\s+TABLE\s+(_m197_\w+)/gi)].map((m) => m[1]).sort();
    expect(temps).toEqual(['_m197_after', '_m197_before', '_m197_env_after', '_m197_env_before', '_m197_targets']);
    expect((CODE.match(/ON COMMIT DROP/g) ?? [])).toHaveLength(temps.length);
  });
});

describe('M197 static — the exact privilege delta', () => {
  const grants = (CODE.match(/GRANT\s+EXECUTE[^;]+;/gi) ?? []).map((s) => s.replace(/\s+/g, ' ').trim());
  const revokes = (CODE.match(/REVOKE\s+EXECUTE[^;]+;/gi) ?? []).map((s) => s.replace(/\s+/g, ' ').trim());

  it('issues exactly two GRANTs, both to authenticated, both on an identity helper', () => {
    expect(grants).toEqual([
      'GRANT EXECUTE ON FUNCTION public.phoenix_my_org() TO authenticated;',
      'GRANT EXECUTE ON FUNCTION public.phoenix_my_role() TO authenticated;',
    ]);
  });

  it('issues exactly six REVOKEs, all FROM PUBLIC, covering exactly the six routines', () => {
    expect(revokes).toHaveLength(6);
    for (const r of revokes) expect(r).toMatch(/FROM PUBLIC;$/);
    const targets = revokes.map((r) => /FUNCTION\s+(.+?)\s+FROM PUBLIC;/.exec(r)![1]).sort();
    expect(targets).toEqual([...SIX].sort());
  });

  it('grants nothing to anon, and nothing to authenticated on a trigger-only routine', () => {
    expect(CODE).not.toMatch(/GRANT[^;]*TO\s+anon/i);
    for (const trig of ['phoenix_guard_dp_archive_update', 'phoenix_handle_new_user', 'phoenix_populate_actor_snapshot']) {
      const g = new RegExp(`GRANT[^;]*${trig}[^;]*;`, 'i');
      expect(CODE, `${trig} must not be granted to a client role`).not.toMatch(g);
    }
  });

  it('never revokes from a role the product depends on', () => {
    for (const role of ['anon', 'authenticated', 'service_role', 'phoenix_demo_purger', 'postgres']) {
      const re = new RegExp(`REVOKE[^;]*FROM\\s+${role}\\b`, 'i');
      expect(CODE, `M197 must not revoke from ${role}`).not.toMatch(re);
    }
  });

  // The ordering contract. phoenix_my_org()/phoenix_my_role() are reached by 80
  // distinct RLS policies and authenticated currently reaches them only through
  // PUBLIC, so a REVOKE placed before its GRANT would strip the privilege those
  // policies depend on for the width of the transaction.
  it('places each identity-helper GRANT strictly BEFORE its matching REVOKE', () => {
    for (const fn of ['public.phoenix_my_org()', 'public.phoenix_my_role()']) {
      const g = CODE.indexOf(`GRANT EXECUTE ON FUNCTION ${fn} TO authenticated;`);
      const r = CODE.indexOf(`REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC;`);
      expect(g, `${fn} GRANT missing`).toBeGreaterThan(-1);
      expect(r, `${fn} REVOKE missing`).toBeGreaterThan(-1);
      expect(g, `${fn}: GRANT must precede REVOKE`).toBeLessThan(r);
    }
  });
});

describe('M197 static — fail-closed preconditions and VERIFY', () => {
  it('has both a precondition block and a VERIFY block, inside the transaction', () => {
    const pre = SQL.indexOf('$m197_pre$');
    const ver = SQL.indexOf('$m197_verify$');
    const commit = SQL.indexOf('COMMIT;');
    expect(pre).toBeGreaterThan(-1);
    expect(ver).toBeGreaterThan(pre);
    expect(ver).toBeLessThan(commit);
  });

  it('refuses to revoke PUBLIC from the QR resolver without proof of an explicit anon grant', () => {
    expect(SQL).toContain("position('anon=EXECUTE' in v_actual) = 0");
    const check = SQL.indexOf('would break the anonymous QR portal');
    const revoke = SQL.indexOf('REVOKE EXECUTE ON FUNCTION public.get_public_qr_payload(text) FROM PUBLIC;');
    expect(check).toBeGreaterThan(-1);
    expect(check, 'the anon proof must precede the QR revoke').toBeLessThan(revoke);
  });

  it('pins the reviewed scope: exactly six PUBLIC-executable SECURITY DEFINER routines', () => {
    expect(SQL).toMatch(/expected exactly 6/);
    expect(SQL).toMatch(/outside the reviewed six/);
    expect(SQL).toMatch(/expected 0/);
  });

  it('pins the RLS blast radius that makes the GRANT/REVOKE order necessary', () => {
    expect(SQL).toMatch(/expected 51/);
    expect(SQL).toMatch(/expected 76/);
  });

  it('pins the eight trigger bindings before and after', () => {
    expect((SQL.match(/expected 8/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('proves explicitness via aclexplode, not only effective privilege', () => {
    // has_function_privilege() reports EFFECTIVE privilege and would still be
    // true for a grant inherited through PUBLIC, so the ACL is read directly.
    expect(SQL).toContain('aclexplode');
    expect(SQL).toContain('has_function_privilege');
    expect(SQL).toMatch(/grantee = 0/);
  });

  it('compares out-of-scope catalog state in BOTH directions', () => {
    expect(SQL).toMatch(/EXCEPT ALL[\s\S]*UNION ALL[\s\S]*EXCEPT ALL/);
    expect(SQL).toMatch(/out-of-scope catalog delta/);
    for (const kind of ['fn_acl', 'rel_acl', 'schema_acl', 'default_acl', 'policy', 'trigger', 'role_attr']) {
      expect(SQL, `env snapshot must cover ${kind}`).toContain(`'${kind}'`);
    }
  });

  it('asserts every non-ACL function attribute is unchanged', () => {
    for (const attr of ['fn_oid', 'owner', 'ident_args', 'result_type', 'prosecdef', 'prokind',
                        'language', 'provolatile', 'proisstrict', 'proparallel', 'proleakproof',
                        'pronargs', 'cfg', 'body_md5']) {
      expect(SQL, `VERIFY must compare ${attr}`).toContain(attr);
    }
  });
});
