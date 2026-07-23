/**
 * DEFAULT-PRIVILEGES-FAIL-CLOSED-GUARD — durable regression guard for
 * migration 109, against a real disposable Postgres with 001->109 applied.
 *
 * 109 closed the root cause behind 108: `authenticated`/`anon`/`PUBLIC`
 * previously inherited broad default privileges (via
 * `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO authenticated,
 * service_role` in bootstrap.sql, mirroring real Supabase project
 * provisioning) on every FUTURE table/sequence/function `postgres` creates
 * in `public` — not just the 15 existing tables 108 fixed. This test is the
 * durable guard against that reopening: it queries the exact same
 * `pg_default_acl` / `aclexplode()` mechanism used to diagnose the bug and
 * asserts, after every replay, that NO default-ACL entry for role
 * `postgres` grants ANY privilege to `authenticated`, `anon`, or `PUBLIC` on
 * tables, sequences, or functions — for tables/sequences within schema
 * `public`, for functions at the global (role-only) scope Postgres actually
 * honors for that object type (see 109's own header comment for why
 * functions must be handled at global scope — schema-scoped
 * `ALTER DEFAULT PRIVILEGES ... ON FUNCTIONS` was verified live to be a
 * no-op against Postgres's built-in PUBLIC-EXECUTE default for functions).
 *
 * If a future migration reintroduces a broad
 * `ALTER DEFAULT PRIVILEGES ... GRANT ... TO authenticated` (or `anon` /
 * `PUBLIC`) — for any object type, at any scope — this test fails loudly,
 * by design: it is not scoped to any specific migration number, so it keeps
 * checking the FINAL state of default privileges after the full chain,
 * whatever the current ceiling is.
 *
 * The ONE narrow, deliberate exception: `service_role` legitimately keeps
 * broad default access (tables/sequences via bootstrap's original
 * schema-scoped grant, functions via 109's own explicit global grant) —
 * that is intentional (Supabase's service role bypasses RLS by design) and
 * is asserted separately, not treated as a violation.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

type DefaultAclRow = {
  owner_role: string;
  schema: string | null; // null => global (role-scoped, no namespace) entry
  object_type: string;
  grantee: string;
  privilege_type: string;
};

run('109 default-privileges fail-closed guard — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 109 });
  }, 120000);

  afterAll(async () => {
    await rig?.end();
  });

  async function explodedDefaultAcls(): Promise<DefaultAclRow[]> {
    return rig.asAdmin(async (c: any) => {
      const r = await c.query(`
        SELECT
          pg_get_userbyid(d.defaclrole) AS owner_role,
          n.nspname AS schema,
          CASE d.defaclobjtype
            WHEN 'r' THEN 'table' WHEN 'S' THEN 'sequence'
            WHEN 'f' THEN 'function' WHEN 'T' THEN 'type' ELSE d.defaclobjtype::text
          END AS object_type,
          a.grantee::regrole::text AS grantee,
          a.privilege_type
        FROM pg_default_acl d
        LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
        CROSS JOIN LATERAL aclexplode(d.defaclacl) AS a
        WHERE (n.nspname = 'public' OR n.nspname IS NULL)
        ORDER BY schema NULLS FIRST, object_type, grantee, privilege_type;
      `);
      return r.rows;
    });
  }

  it('no default-ACL entry for public (or global, for functions) grants anything to authenticated/anon/PUBLIC', async () => {
    const rows = await explodedDefaultAcls();
    const violations = rows.filter(r =>
      ['authenticated', 'anon', '-'].includes(r.grantee), // '-' = regrole rendering of PUBLIC/no owning role
    );
    if (violations.length > 0) {
      // Fail loudly with the exact offending entries, so a future regression
      // is immediately diagnosable from the test output alone.
      throw new Error(
        `default-privilege lockdown regressed — the following grantee/privilege ` +
        `pairs must not exist:\n${JSON.stringify(violations, null, 2)}`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('service_role keeps its default table/sequence privileges (the one deliberate exception)', async () => {
    const rows = await explodedDefaultAcls();
    const svcTable = rows.filter(r => r.schema === 'public' && r.object_type === 'table' && r.grantee === 'service_role');
    const svcSeq = rows.filter(r => r.schema === 'public' && r.object_type === 'sequence' && r.grantee === 'service_role');
    expect(svcTable.map(r => r.privilege_type).sort()).toEqual(
      ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'],
    );
    expect(svcSeq.map(r => r.privilege_type).sort()).toEqual(['SELECT', 'UPDATE', 'USAGE']);
  });

  it('service_role keeps its default EXECUTE on future functions (global-scope entry from 109)', async () => {
    const rows = await explodedDefaultAcls();
    const svcFn = rows.filter(r => r.schema === null && r.object_type === 'function' && r.grantee === 'service_role');
    expect(svcFn.map(r => r.privilege_type)).toEqual(['EXECUTE']);
  });

  it('a freshly created table/sequence/function is genuinely unreachable by authenticated/anon/PUBLIC', async () => {
    // Live behavioral proof, not just an ACL-catalog read: create real probe
    // objects and assert has_*_privilege() directly, matching 109's own
    // Task 3 acceptance proof. This is the guard that would actually catch a
    // regression that somehow satisfied the catalog check above but still
    // left a real object reachable (e.g. a role-membership or search_path
    // quirk the catalog query wouldn't reveal).
    await rig.asAdmin(async (c: any) => {
      await c.query(`CREATE TABLE public.__guard_probe_tbl (id int);`);
      await c.query(`CREATE SEQUENCE public.__guard_probe_seq;`);
      await c.query(`CREATE FUNCTION public.__guard_probe_fn() RETURNS void LANGUAGE sql AS 'SELECT 1';`);
      try {
        for (const role of ['authenticated', 'anon']) {
          for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']) {
            const r = await c.query(`SELECT has_table_privilege($1, 'public.__guard_probe_tbl', $2) AS has`, [role, priv]);
            expect(r.rows[0].has, `${role} must not have ${priv} on a fresh table`).toBe(false);
          }
          for (const priv of ['USAGE', 'SELECT', 'UPDATE']) {
            const r = await c.query(`SELECT has_sequence_privilege($1, 'public.__guard_probe_seq', $2) AS has`, [role, priv]);
            expect(r.rows[0].has, `${role} must not have ${priv} on a fresh sequence`).toBe(false);
          }
          const rf = await c.query(`SELECT has_function_privilege($1, 'public.__guard_probe_fn()', 'EXECUTE') AS has`, [role]);
          expect(rf.rows[0].has, `${role} must not have EXECUTE on a fresh function`).toBe(false);
        }
      } finally {
        await c.query('DROP TABLE public.__guard_probe_tbl;');
        await c.query('DROP SEQUENCE public.__guard_probe_seq;');
        await c.query('DROP FUNCTION public.__guard_probe_fn();');
      }
    });
  });
});
